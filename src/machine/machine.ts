/**
 * The supervised machine façade: spawn Firecracker (directly or under the
 * jailer), wait for the API (racing process death), apply configuration,
 * run the lifecycle, and guarantee cleanup.
 *
 * @module
 */

import { basename, dirname, isAbsolute, join, resolve } from "@std/path";
import { FirecrackerClient } from "../api/client.ts";
import type {
  InstanceInfo,
  SnapshotCreateParams,
  SnapshotLoadParams,
} from "../api/types.ts";
import { cleanupError, removePathStep, runCleanupSteps } from "../cleanup.ts";
import {
  AdoptError,
  type CleanupFailure,
  JailerConfigError,
  ProcessExitedError,
  ReadinessTimeoutError,
  VsockDialError,
} from "../errors.ts";
import { buildJailerArgv } from "../jailer/argv.ts";
import {
  type JailerOptions,
  validateJailerOptions,
} from "../jailer/options.ts";
import {
  computeJailPaths,
  hostPathOf,
  type JailPaths,
} from "../jailer/paths.ts";
import { withDeadline } from "../internal/async.ts";
import {
  findVmmPidByCmdline,
  idCmdlineToken,
  readPidStartTime,
} from "../internal/liveness.ts";
import {
  cleanupStepsForResources,
  findLiveVmm,
  killAndWait,
  listenerPaths,
  type MachineResources,
  recordFromResources,
  resourcesFromRecord,
} from "../internal/records.ts";
import { stageChroot } from "../jailer/stage.ts";
import {
  ReparentedVmm,
  tryReadPidfile,
  waitForPidfile,
} from "../process/pidfile.ts";
import { escalatingShutdown } from "../process/shutdown.ts";
import { VmmProcess } from "../process/supervisor.ts";
import type { JailRecord, VmRegistry } from "../registry/registry.ts";
import type { ShutdownOptions, VmmExit, VmState } from "../types.ts";
import type { VsockConn } from "../vsock/conn.ts";
import { connectVsock, type VsockDialOptions } from "../vsock/dial.ts";
import { listenVsock, type VsockListener } from "../vsock/listen.ts";
import { applyVmConfig, type VmConfig } from "./config.ts";
import { LifecycleState } from "./state.ts";

type VmmHandle = VmmProcess | ReparentedVmm;

/** Options shared by direct and jailed machines. */
export interface CommonMachineOptions {
  /** Whole-VM configuration applied before boot. */
  config: VmConfig;
  /**
   * API socket path. Direct mode: host path, relative paths resolve inside
   * the state dir (default `"fc.sock"`). Jailed mode: an absolute in-jail
   * path (default `"/fc.sock"`).
   */
  socketPath?: string;
  /**
   * Deadline for the API socket to answer after spawn.
   * @default 5_000
   */
  readinessTimeoutMs?: number;
  /** Default deadlines for {@linkcode Machine.shutdown}. */
  shutdown?: ShutdownOptions;
  /** Extra argv appended to the Firecracker command line. */
  extraArgs?: string[];
  /**
   * What to do with the VMM's stdout/stderr: `"capture"` (default) pipes
   * them into {@linkcode Machine.consoleTail} and `VmmExit.stderrTail`;
   * `"null"` discards them at spawn time.
   *
   * Use `"null"` for machines that must survive a supervisor crash and be
   * re-attached with `Machine.adopt`: a captured pipe whose reader died
   * with the supervisor wedges Firecracker on its next write — the VMM
   * freezes and stops answering its API. Irrelevant under jailer
   * `--daemonize` (stdio already goes to `/dev/null`). See
   * docs/adoption.md.
   */
  stdio?: "capture" | "null";
  /**
   * Opaque labels recorded on the machine's JailRecord (requires a
   * registry): lease ids, group names, tenant tags. Never interpreted.
   */
  metadata?: Record<string, string>;
  /** Aborts while the spawned VMM waits for readiness. */
  signal?: AbortSignal;
}

/** Options for a machine spawned directly (no jailer). */
export interface DirectMachineOptions extends CommonMachineOptions {
  /** Path to the `firecracker` binary. */
  firecrackerBin: string;
  /** Discriminant: never set together with `firecrackerBin`. */
  jailer?: never;
  /** VM id (also passed as `--id`); generated when omitted. */
  id?: string;
  /**
   * Directory for the machine's runtime files. When omitted, a temp dir is
   * created and removed again during disposal; a caller-provided dir is
   * never deleted, only the files this library made.
   */
  stateDir?: string;
  /**
   * Crash-recovery journal (optional in direct mode, required when
   * jailed). When given, a record naming every reclaimable resource is
   * committed **before** the VMM spawns and removed only after disposal
   * fully reclaims it — so a supervisor crash (SIGKILL/OOM) can always be
   * repaired by running `reconcile(registry)` at next startup.
   */
  registry?: VmRegistry;
}

/** Options for a machine supervised through the jailer. */
export interface JailedMachineOptions extends CommonMachineOptions {
  /** Jailer configuration; `jailer.id` becomes the machine's vmId. */
  jailer: JailerOptions;
  /** Discriminant: never set together with `jailer`. */
  firecrackerBin?: never;
  /** The vmId is `jailer.id`; a separate id is not accepted. */
  id?: never;
  /** Jailed machines live in the chroot; no separate state dir. */
  stateDir?: never;
  /**
   * Crash-recovery journal — **required** for jailed machines: the jailer
   * cleans up nothing on exit, and only a journal committed before spawn
   * makes chroots, cgroups, and orphaned VMMs reclaimable after a
   * supervisor crash. See `reconcile()`.
   */
  registry: VmRegistry;
}

/** Options for {@linkcode Machine.create} / {@linkcode Machine.launch}. */
export type MachineOptions = DirectMachineOptions | JailedMachineOptions;

/** Internal spawn projections shared by create and restore. */
type CommonSpawnOptions = Omit<CommonMachineOptions, "config">;
type DirectModeOptions = Omit<DirectMachineOptions, keyof CommonMachineOptions>;
type JailedModeOptions = Omit<JailedMachineOptions, keyof CommonMachineOptions>;

/** Restore options shared by direct and jailed machines. */
export interface CommonRestoreOptions
  extends Omit<CommonMachineOptions, "config"> {
  /**
   * Wire-verbatim `PUT /snapshot/load` parameters. Snapshot/memory paths
   * are host paths for direct machines and in-jail paths when jailed
   * (stage the snapshot files into the chroot). `mem_backend.backend_type`
   * `"File"` is fully supported; `"Uffd"` requires an external page-fault
   * handler process listening on the backend path — Deno cannot receive
   * the userfaultfd over SCM_RIGHTS, so no in-process handler exists.
   *
   * Restored VMs resume with their snapshotted config; open vsock
   * connections are gone (guest listeners survive), and `vsock_override`
   * rebinds the host-side UDS path.
   */
  snapshot: SnapshotLoadParams;
}

/** Restore into a directly-spawned (unjailed) VMM. */
export interface DirectRestoreOptions
  extends
    CommonRestoreOptions,
    Omit<DirectMachineOptions, keyof CommonMachineOptions> {}

/** Restore into a jailed VMM (registry required, as always when jailed). */
export interface JailedRestoreOptions
  extends
    CommonRestoreOptions,
    Omit<JailedMachineOptions, keyof CommonMachineOptions> {}

/** Options for {@linkcode Machine.restore}. */
export type RestoreOptions = DirectRestoreOptions | JailedRestoreOptions;

/** Options for {@linkcode Machine.adopt}. */
export interface AdoptOptions {
  /**
   * The record to adopt, exactly as returned by `registry.list()`.
   * Adoption never spawns anything — it re-attaches to the still-running
   * VMM this record journals.
   */
  record: JailRecord;
  /**
   * The registry the record lives in. The adopted machine keeps updating
   * it (listener journaling) and removes the record when disposal fully
   * reclaims — exactly like a machine this process launched itself.
   */
  registry: VmRegistry;
  /**
   * Deadline for the (already-live) API socket to answer `GET /`. Kept
   * short by default: an adoptable socket answers immediately, and a
   * sweep over many unadoptable records should not stall on each one.
   * @default 2_000
   */
  readinessTimeoutMs?: number;
  /** Default deadlines for {@linkcode Machine.shutdown}. */
  shutdown?: ShutdownOptions;
  /** Aborts `adopt()` while it probes. */
  signal?: AbortSignal;
}

/**
 * A supervised Firecracker microVM.
 *
 * Construct via {@linkcode Machine.create} (spawn + configure, no boot),
 * {@linkcode Machine.launch} (create + `InstanceStart`), or
 * {@linkcode Machine.restore} (spawn + snapshot load). Dispose with
 * `await using` — disposal shuts the VMM down, confirms death, reclaims
 * every file this library created, and only then resolves.
 *
 * @example Direct (unjailed)
 * ```ts
 * await using vm = await Machine.launch({
 *   firecrackerBin: "/usr/local/bin/firecracker",
 *   config: {
 *     boot_source: {
 *       kernel_image_path: "/opt/images/vmlinux",
 *       boot_args: "console=ttyS0 reboot=k panic=1 pci=off",
 *     },
 *     drives: [{
 *       drive_id: "rootfs",
 *       path_on_host: "/opt/images/rootfs.ext4",
 *       is_root_device: true,
 *     }],
 *   },
 * });
 * const exit = await vm.shutdown();
 * ```
 *
 * @example Jailed (requires root and a registry)
 * ```ts
 * await using vm = await Machine.launch({
 *   jailer: {
 *     jailerBin: "/usr/local/bin/jailer",
 *     firecrackerBin: "/usr/local/bin/firecracker",
 *     id: "sandbox-42",
 *     uid: 10042,
 *     gid: 10042,
 *     newPidNs: true,
 *     stage: [
 *       { hostPath: "/opt/images/vmlinux" },
 *       { hostPath: "/opt/images/rootfs.ext4", readWrite: true },
 *     ],
 *   },
 *   config: {
 *     boot_source: { kernel_image_path: "/vmlinux" }, // in-jail path
 *     drives: [{
 *       drive_id: "rootfs",
 *       path_on_host: "/rootfs.ext4", // in-jail path
 *       is_root_device: true,
 *     }],
 *   },
 *   registry: new DirRegistry("/var/lib/sandboxes/registry"),
 * });
 * ```
 */
export class Machine implements AsyncDisposable {
  /** Host-side view of the machine's important paths. */
  readonly paths: {
    apiSocket: string;
    vsockUds?: string;
    stateDir: string;
    chrootRoot?: string;
  };
  /** The typed API client — the full escape hatch. */
  readonly client: FirecrackerClient;
  /**
   * Resolves exactly once with how the VMM process exited (however that
   * came to pass). Never rejects.
   */
  readonly exited: Promise<VmmExit>;
  /** This machine's unique id (`options.id` / `jailer.id`, or generated). */
  readonly vmId: string;

  #vmm: VmmHandle;
  #lifecycle = new LifecycleState();
  #shutdown?: ShutdownOptions;
  #registry?: VmRegistry;
  #resources: MachineResources;
  #stagedPaths: ReadonlyMap<string, string>;
  #shutdownResult: Promise<VmmExit> | null = null;
  #disposed = false;
  // Aborted (with a ProcessExitedError) the moment the VMM exit is
  // observed; composed into cancellable operations like vsock dials so
  // they reject promptly instead of burning their retry budgets.
  #exitAborter = new AbortController();

  private constructor(init: {
    vmm: VmmHandle;
    client: FirecrackerClient;
    shutdown?: ShutdownOptions;
    registry?: VmRegistry;
    resources: MachineResources;
    vmId: string;
    stagedPaths: ReadonlyMap<string, string>;
  }) {
    this.#vmm = init.vmm;
    this.client = init.client;
    this.#shutdown = init.shutdown;
    this.#registry = init.registry;
    this.#resources = init.resources;
    this.paths = pathsFromResources(init.resources);
    this.vmId = init.vmId;
    this.#stagedPaths = init.stagedPaths;
    this.exited = init.vmm.exited;
    liveVmIds.add(init.vmId);
    void init.vmm.exited.then((exit) => {
      liveVmIds.delete(init.vmId);
      this.#lifecycle.transition("exited", exit);
      this.#exitAborter.abort(
        new ProcessExitedError({ exit, operation: "use the machine" }),
      );
    });
  }

  /**
   * Spawn the VMM (directly or via the jailer), wait for its API socket
   * (racing process death), and apply `options.config`. The machine is
   * fully configured but **not** booted — call {@linkcode start}, or use
   * {@linkcode launch}.
   *
   * On any failure the spawned process is killed and reaped and created
   * files are removed before the error propagates: a failed `create` leaks
   * nothing.
   */
  static async create(options: MachineOptions): Promise<Machine> {
    options.signal?.throwIfAborted();
    const machine = await Machine.#spawn(
      options,
      options.config.vsock?.uds_path,
    );
    return await machine.#finishCreate(
      options.readinessTimeoutMs ?? 5_000,
      options.signal,
      () => applyVmConfig(machine.client, options.config),
    );
  }

  /** {@linkcode create} followed by `InstanceStart` — the one-shot happy path. */
  static async launch(options: MachineOptions): Promise<Machine> {
    const machine = await Machine.create(options);
    try {
      await machine.start();
    } catch (err) {
      await machine[Symbol.asyncDispose]().catch(() => {});
      throw err;
    }
    return machine;
  }

  /**
   * Spawn a fresh VMM and load a snapshot into it (`PUT /snapshot/load`).
   * The machine comes back `"paused"`, or `"running"` when
   * `snapshot.resume_vm` is set. No {@linkcode VmConfig} applies — the
   * snapshot carries the configuration.
   */
  static async restore(options: RestoreOptions): Promise<Machine> {
    options.signal?.throwIfAborted();
    const machine = await Machine.#spawn(
      options,
      options.snapshot.vsock_override?.uds_path,
    );
    await machine.#finishCreate(
      options.readinessTimeoutMs ?? 5_000,
      options.signal,
      () => machine.client.loadSnapshot(options.snapshot),
    );
    machine.#lifecycle.transition("starting");
    machine.#lifecycle.transition(
      options.snapshot.resume_vm === true ? "running" : "paused",
    );
    return machine;
  }

  /**
   * Re-attach to a still-running VMM that a previous — now dead —
   * supervisor launched, reconstructing a live `Machine` from its
   * {@linkcode JailRecord}. Nothing is spawned; the record's pid is
   * re-verified (cmdline identity plus start-time, where `/proc` allows),
   * the API socket is probed, and the machine lands directly in
   * `"running"` or `"paused"`. This is the alternative to
   * `reconcile({ killLive: true })` for supervisors whose VMs must
   * survive a supervisor crash — see `recover()` for the sweep that
   * combines both.
   *
   * A refusal (thrown {@linkcode AdoptError}) never kills the process and
   * never touches files or the record: whatever could not be adopted is
   * left exactly as found, for `reconcile()` or an explicit kill to deal
   * with. The one exception is a VMM that dies *mid-adoption*: that is
   * reclaimed like any other death and surfaces as `ProcessExitedError`.
   *
   * What an adopted machine loses (the process is no longer our child):
   * - `exited` reports `observedVia: "pidfile-poll"` with `code`/`signal`
   *   `null` — exit codes are unobservable.
   * - {@linkcode consoleTail} and `VmmExit.stderrTail` are empty; use the
   *   Firecracker `logger`/`serial` devices.
   * - {@linkcode jailPath} loses the staged-file map (chroot-prefix
   *   stripping still works) — pass in-jail paths to post-adoption calls.
   * - cgroup cleanup at disposal only for records journaled with
   *   `cgroupPath` (written by this version onward).
   *
   * Everything else — the API client, vsock, escalating shutdown with the
   * pid-reuse guard, disposal-with-reclaim — behaves exactly as if this
   * process had launched the machine. Precondition: one live supervisor
   * per registry directory; adoption is not a lease protocol.
   *
   * (Unrelated to the jailer's "a pre-existing jail root is refused,
   * never adopted" hardening, which is about *reusing stale chroot
   * directories at spawn time* — see docs/jailer.md.)
   *
   * @example Re-attaching after a supervisor restart
   * ```ts
   * import { DirRegistry, Machine } from "@nullstyle/firecracker";
   *
   * const registry = new DirRegistry("/var/lib/sandbox-host/state");
   * for (const record of await registry.list()) {
   *   const vm = await Machine.adopt({ record, registry });
   *   console.log(`adopted ${vm.vmId} (pid ${vm.pid}): ${vm.state}`);
   * }
   * ```
   */
  static async adopt(options: AdoptOptions): Promise<Machine> {
    options.signal?.throwIfAborted();
    const vmId = options.record.vmId;
    // Refuse while ANY live Machine in this process — launched or adopted
    // — holds this vmId: a second kill-capable handle on the same VMM
    // would mean two shutdown sequencers and racing file cleanup (and
    // adoption would unlink the live machine's listener sockets).
    if (liveVmIds.has(vmId)) {
      throw new AdoptError({ vmId, reason: "already-adopted" });
    }
    liveVmIds.add(vmId);
    try {
      // The constructor re-adds the vmId; it clears when exit is observed.
      return await Machine.#adopt(options);
    } catch (err) {
      liveVmIds.delete(vmId);
      throw err;
    }
  }

  static async #adopt(options: AdoptOptions): Promise<Machine> {
    const { record, registry, signal } = options;
    const vmId = record.vmId;

    // 1. Locate the live VMM and positively establish its identity —
    //    before anything kill-capable exists.
    const live = await findLiveVmm(record);
    if (live === null) {
      throw new AdoptError({ vmId, reason: "vmm-not-found" });
    }
    if (live.identity === "unverifiable" && Deno.build.os === "linux") {
      // /proc exists here but this pid's cmdline was unreadable (hidepid,
      // permissions): identity must be proven, not merely not-disproven.
      throw new AdoptError({ vmId, reason: "identity-unverifiable" });
    }

    // 2. Pure record math next: rebuild the jail layout (jailed records).
    validateJailRecord(record);
    // Stale listener sockets are unlinked below. Any path that cannot be
    // removed stays in both the live manifest and the journal for cleanup.
    const resources = resourcesFromRecord(record, []);

    // 3. Probe the API socket. Unlike create(), this is not raced against
    //    process death (no handle exists yet); a mid-probe death simply
    //    exhausts the short budget and reads as unreachable.
    const client = new FirecrackerClient({
      socketPath: record.apiSocketPath,
    });
    let info: InstanceInfo;
    try {
      info = await client.waitReady({
        timeoutMs: options.readinessTimeoutMs ?? 2_000,
        signal,
      });
    } catch (cause) {
      client.close();
      // A caller abort is not an adoption verdict: wrapping it as
      // "api-unreachable" would let a cancelled recover({onUnadoptable:
      // "kill"}) sweep destroy a healthy, adoptable VM.
      if (signal?.aborted) throw signal.reason;
      throw new AdoptError({ vmId, reason: "api-unreachable", cause });
    }
    try {
      // Whatever answered must be this record's Firecracker: a foreign
      // process bound to a stale socket path must not be adopted. The id
      // must be present AND match — real Firecracker always reports its
      // --id, so an answer without one is not this VM either.
      const stateOk = info.state === "Not started" ||
        info.state === "Running" || info.state === "Paused";
      if (!stateOk || info.id !== vmId) {
        throw new AdoptError({ vmId, reason: "api-mismatch" });
      }
      if (info.state === "Not started") {
        // VmConfig is not persisted: a crashed-mid-create() machine's
        // "fully configured" invariant is unknowable. Not adoptable.
        throw new AdoptError({ vmId, reason: "not-started" });
      }

      // 4. Unlink stale guest-listener sockets — their fds died with the
      //    old supervisor, and a re-listen would hit AddrInUse. (Unlink
      //    before clearing them from the record: a crash in between
      //    leaves paths that reclaim tolerates as already-gone, never
      //    files no record names.)
      for (const path of record.vsockListenerPaths) {
        try {
          await Deno.remove(path);
        } catch (err) {
          if (!(err instanceof Deno.errors.NotFound)) {
            resources.vsockListeners.add(path);
          }
        }
      }

      // 5. Journal the adoption before any handle exists: refreshed pid,
      //    start-time, and diagnostics. A vanished record means a
      //    concurrent sweep owns this vmId — abort.
      const pidStartTime = await readPidStartTime(live.pid);
      try {
        await registry.update(vmId, {
          pid: live.pid,
          ...(pidStartTime !== null ? { pidStartTime } : {}),
          vsockListenerPaths: listenerPaths(resources),
          adoptedAt: new Date().toISOString(),
          supervisorPid: Deno.pid,
        });
      } catch (cause) {
        throw new AdoptError({ vmId, reason: "conflict", cause });
      }
    } catch (err) {
      client.close();
      throw err;
    }

    // 6. Only now, with every refusal behind us, construct the handle —
    //    ReparentedVmm's liveness poll starts immediately and cannot be
    //    cancelled, so it must not exist on any refusal path.
    const vmm = new ReparentedVmm(live.pid, {
      jailerStderr: () => "",
      identityToken: idCmdlineToken(vmId),
    });
    const machine = new Machine({
      vmm,
      client,
      shutdown: options.shutdown,
      registry,
      resources,
      vmId,
      stagedPaths: new Map(),
    });

    // 7. Walk the lifecycle to the probed state (the restore() precedent).
    machine.#lifecycle.transition("starting");
    machine.#lifecycle.transition(
      info.state === "Paused" ? "paused" : "running",
    );
    // Died between the probe and here? Reclaim like any failed create —
    // "died during adoption" must equal "was dead", so a sweep needs no
    // second pass. (transition() ignores illegal edges silently, so the
    // walk above cannot be trusted to fail loudly — check the exit.)
    const exit = machine.#vmm.exit;
    if (exit !== null) {
      await machine.#destroyAfterFailedCreate();
      throw new ProcessExitedError({ exit, operation: "adopt" });
    }
    return machine;
  }

  static async #spawn(
    options: MachineOptions | RestoreOptions,
    vsockPath: string | undefined,
  ): Promise<Machine> {
    if (options.jailer !== undefined) {
      return await Machine.#spawnJailed(options, vsockPath);
    }
    return await Machine.#spawnDirect(options, vsockPath);
  }

  static async #spawnDirect(
    options: CommonSpawnOptions & DirectModeOptions,
    vsockPath: string | undefined,
  ): Promise<Machine> {
    const ownsStateDir = options.stateDir === undefined;
    const stateDir = options.stateDir ??
      await Deno.makeTempDir({ prefix: "fc-vm-" });
    if (!ownsStateDir) await Deno.mkdir(stateDir, { recursive: true });

    const vmId = options.id ?? `fc-${crypto.randomUUID()}`;
    const apiSocketPath = resolveIn(stateDir, options.socketPath ?? "fc.sock");
    const resources: MachineResources = {
      apiSocketPath,
      stateDir,
      ownsStateDir,
      vsockListeners: new Set(),
      ...(vsockPath !== undefined
        ? { vsockUdsPath: resolveIn(stateDir, vsockPath) }
        : {}),
    };
    let vmm: VmmProcess;
    let journaled = false;
    try {
      assertSocketPathLength(resources.apiSocketPath, "API socket path");
      await assertPathAbsent(resources.apiSocketPath, "API socket path");
      if (resources.vsockUdsPath !== undefined) {
        assertSocketPathLength(resources.vsockUdsPath, "vsock UDS path");
        await assertPathAbsent(resources.vsockUdsPath, "vsock UDS path");
      }

      // Journal-before-spawn: the record must exist before the process
      // does, so no crash window can leave an unrecorded VMM behind.
      if (options.registry !== undefined) {
        await options.registry.put(
          recordFromResources(vmId, resources, options.metadata),
        );
        journaled = true;
      }

      vmm = VmmProcess.spawn({
        command: resolveBinaryPath(options.firecrackerBin),
        args: [
          "--api-sock",
          apiSocketPath,
          "--id",
          vmId,
          ...(options.extraArgs ?? []),
        ],
        cwd: stateDir,
        stdio: options.stdio,
      });
    } catch (err) {
      // Nothing is running (validation, journaling, or the spawn itself
      // failed) — undo what this call created: a failed create leaks
      // nothing, registry or not.
      const failures = ownsStateDir
        ? await runCleanupSteps([
          removePathStep("remove-state-dir", stateDir, { recursive: true }),
        ])
        : [];
      if (journaled && failures.length === 0) {
        await options.registry!.remove(vmId).catch(() => {});
      }
      throw err;
    }
    if (options.registry !== undefined) {
      // Best-effort: a record with pid null still reconciles via its files
      // and reconcile()'s cmdline scan.
      const pidStartTime = await readPidStartTime(vmm.pid);
      await options.registry.update(vmId, {
        pid: vmm.pid,
        ...(pidStartTime !== null ? { pidStartTime } : {}),
      }).catch(() => {});
    }
    return new Machine({
      vmm,
      client: new FirecrackerClient({ socketPath: apiSocketPath }),
      shutdown: options.shutdown,
      registry: options.registry,
      resources,
      vmId,
      stagedPaths: new Map(),
    });
  }

  static async #spawnJailed(
    options: CommonSpawnOptions & JailedModeOptions,
    vsockPath: string | undefined,
  ): Promise<Machine> {
    // Pin relative binary paths to our cwd before anything else consumes
    // them (spawn, --exec-file, chroot layout are all path-sensitive).
    const jailer: JailerOptions = {
      ...options.jailer,
      jailerBin: resolveBinaryPath(options.jailer.jailerBin),
      firecrackerBin: resolveBinaryPath(options.jailer.firecrackerBin),
    };
    validateJailerOptions(jailer);
    if (options.registry === undefined) {
      throw new JailerConfigError(
        "a registry is required for jailed machines: the jailer cleans up " +
          "nothing on exit, and only a pre-spawn journal makes chroots and " +
          "orphaned VMMs reclaimable after a supervisor crash (see reconcile())",
      );
    }
    const vmId = jailer.id;
    const jail = computeJailPaths(jailer);
    const socketJailPath = options.socketPath ?? "/fc.sock";
    if (!socketJailPath.startsWith("/")) {
      throw new JailerConfigError(
        `jailed socketPath must be an absolute in-jail path, got ${
          JSON.stringify(socketJailPath)
        }`,
      );
    }
    const apiSocketPath = hostPathOf(jail, socketJailPath);
    const cgroupPath = cgroupV2Path(jailer, jail);
    const resources: MachineResources = {
      apiSocketPath,
      stateDir: jail.jailRoot,
      ownsStateDir: false,
      vsockListeners: new Set(),
      pidfilePath: jail.pidfileHost,
      chrootDir: jail.jailRoot,
      ...(cgroupPath !== undefined ? { cgroupPath } : {}),
      ...(vsockPath !== undefined
        ? { vsockUdsPath: hostPathOf(jail, vsockPath) }
        : {}),
    };
    // Checked against the HOST view: the in-jail path is short, but tools
    // and tests reaching the socket from outside see the full chroot path.
    assertSocketPathLength(
      resources.apiSocketPath,
      "API socket path (host view)",
    );
    if (resources.vsockUdsPath !== undefined) {
      assertSocketPathLength(
        resources.vsockUdsPath,
        "vsock UDS path (host view)",
      );
    }

    // Journal-before-spawn (before staging, even: a crash mid-staging must
    // leave a reclaimable record for the half-built chroot).
    await options.registry.put(
      recordFromResources(vmId, resources, options.metadata),
    );

    const plan = await stageChroot(jail, jailer);
    const stagedPaths = new Map(plan.map((a) => [a.hostPath, a.jailPath]));

    let jailerProc: VmmProcess;
    try {
      jailerProc = VmmProcess.spawn({
        command: jailer.jailerBin,
        // No --id here: the jailer injects `--id <jail id>` into
        // Firecracker's argv itself; passing it again is
        // ParseArguments(DuplicateArgument("id")).
        args: buildJailerArgv(jailer, [
          "--api-sock",
          socketJailPath,
          ...(options.extraArgs ?? []),
        ]),
        stdio: options.stdio,
      });
    } catch (err) {
      // The jailer never started: unwind the staged chroot and the record.
      await cleanupFailedJail(resources, options.registry, vmId);
      throw err;
    }

    const reparented = jailer.daemonize === true || jailer.newPidNs === true;
    let vmm: VmmHandle = jailerProc;
    try {
      if (reparented) {
        const pid = await waitForPidfile(jail.pidfileHost, {
          jailer: jailerProc,
          timeoutMs: options.readinessTimeoutMs ?? 5_000,
          signal: options.signal,
        });
        vmm = new ReparentedVmm(pid, {
          jailerStderr: () => jailerProc.stderrTail(),
          identityToken: idCmdlineToken(vmId),
        });
      }
    } catch (err) {
      jailerProc.kill("SIGKILL");
      await jailerProc.exited;
      // A reparented Firecracker may be alive even though the pidfile never
      // surfaced. Confirm death (pidfile re-read, then cmdline scan) before
      // touching any files — never rm a live VMM's chroot.
      let orphan = await tryReadPidfile(jail.pidfileHost);
      if (orphan === null) {
        orphan = await findVmmPidByCmdline([idCmdlineToken(vmId)]);
      }
      if (orphan !== null) {
        try {
          await killAndWait(orphan, 2_000);
        } catch {
          // Unkillable: keep the record (now with the pid) for reconcile
          // and leave the chroot alone.
          await options.registry.update(vmId, { pid: orphan }).catch(() => {});
          throw err;
        }
      }
      await cleanupFailedJail(resources, options.registry, vmId);
      throw err;
    }
    const pidStartTime = await readPidStartTime(vmm.pid);
    await options.registry.update(vmId, {
      pid: vmm.pid,
      ...(pidStartTime !== null ? { pidStartTime } : {}),
    }).catch(() => {});

    return new Machine({
      vmm,
      client: new FirecrackerClient({ socketPath: apiSocketPath }),
      shutdown: options.shutdown,
      registry: options.registry,
      resources,
      vmId,
      stagedPaths,
    });
  }

  /** Shared tail of create/restore: readiness (racing death) + configure. */
  async #finishCreate(
    readinessTimeoutMs: number,
    signal: AbortSignal | undefined,
    configure: () => Promise<void>,
  ): Promise<Machine> {
    try {
      await this.#awaitApiReady(readinessTimeoutMs, signal);
      await configure();
    } catch (err) {
      await this.#destroyAfterFailedCreate();
      throw err;
    }
    return this;
  }

  /** Current lifecycle state. */
  get state(): VmState {
    return this.#lifecycle.state;
  }

  /** Authoritative VMM pid (pidfile-derived for reparented jailed modes). */
  get pid(): number {
    return this.#vmm.pid;
  }

  /**
   * Map a host path to the in-jail path Firecracker sees. Staged files map
   * to their staged location; other paths under the chroot root are
   * stripped of the prefix; direct (unjailed) machines return the path
   * unchanged.
   */
  jailPath(hostPath: string): string {
    const root = this.paths.chrootRoot;
    if (root === undefined) return hostPath;
    const staged = this.#stagedPaths.get(hostPath);
    if (staged !== undefined) return staged;
    if (hostPath === root) return "/";
    if (hostPath.startsWith(`${root}/`)) {
      return hostPath.slice(root.length);
    }
    throw new JailerConfigError(
      `${hostPath} is neither staged nor under the chroot root ${root}`,
    );
  }

  /** Boot the configured microVM (`InstanceStart`). */
  async start(): Promise<void> {
    this.#lifecycle.assert("start", "configured");
    this.#lifecycle.transition("starting");
    try {
      await this.client.instanceStart();
    } catch (err) {
      const exit = this.#vmm.exit;
      if (exit !== null) {
        throw new ProcessExitedError({ exit, operation: "start", cause: err });
      }
      this.#lifecycle.transition("configured");
      throw err;
    }
    this.#lifecycle.transition("running");
  }

  /** Pause the running microVM's vCPUs. */
  async pause(): Promise<void> {
    this.#lifecycle.assert("pause", "running");
    await this.client.pauseVm();
    this.#lifecycle.transition("paused");
  }

  /** Resume the paused microVM's vCPUs. */
  async resume(): Promise<void> {
    this.#lifecycle.assert("resume", "paused");
    await this.client.resumeVm();
    this.#lifecycle.transition("running");
  }

  /**
   * Snapshot the microVM (`PUT /snapshot/create`). Firecracker requires a
   * paused VM: pass `pause: true` to pause–snapshot–resume in one call, or
   * call it on an already-paused machine. Relative paths land in the VMM's
   * working directory (the state dir) for direct machines; jailed machines
   * take in-jail paths.
   */
  async snapshot(
    params: SnapshotCreateParams & { pause?: boolean },
  ): Promise<void> {
    const { pause, ...createParams } = params;
    if (pause === true && this.#lifecycle.state === "running") {
      await this.pause();
      try {
        await this.client.createSnapshot(createParams);
      } finally {
        await this.resume();
      }
      return;
    }
    this.#lifecycle.assert("snapshot", "paused");
    await this.client.createSnapshot(createParams);
  }

  /** Resolve when the machine reaches `state`; see `LifecycleState.waitFor`. */
  waitFor(
    state: VmState,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<void> {
    return this.#lifecycle.waitFor(state, opts);
  }

  /**
   * Guest serial console tail (with `console=ttyS0` in the boot args).
   * Empty for daemonized/new-pid-ns jailed machines, whose output is
   * unobservable — configure the Firecracker `logger`/`serial` devices.
   */
  consoleTail(): string {
    return this.#vmm.stdoutTail();
  }

  /**
   * Vsock operations against this machine's vsock device (requires
   * `config.vsock`, or `vsock_override` for restored machines).
   * Connections are standard `Deno.Conn`s; listeners created here are
   * closed and unlinked during disposal.
   */
  readonly vsock: {
    /** Dial a guest port; see `connectVsock`. Requires a running machine. */
    connect: (port: number, opts?: VsockDialOptions) => Promise<VsockConn>;
    /** Listen for guest-initiated connections; see `listenVsock`. */
    listen: (port: number) => VsockListener;
  } = {
    connect: async (port, opts) => {
      this.#lifecycle.assert("vsock.connect", "running");
      // Race the dial against VMM death: a dial in flight when the VMM
      // dies rejects promptly with ProcessExitedError instead of retrying
      // out its budget against a vanished socket.
      const signal = opts?.signal === undefined
        ? this.#exitAborter.signal
        : AbortSignal.any([this.#exitAborter.signal, opts.signal]);
      return await connectVsock(this.#requireVsockUds(port), port, {
        ...opts,
        signal,
      });
    },
    listen: (port) => {
      this.#lifecycle.assert(
        "vsock.listen",
        "configured",
        "starting",
        "running",
        "paused",
      );
      const listener = listenVsock(this.#requireVsockUds(port), port);
      this.#resources.vsockListeners.add(listener);
      if (this.#registry !== undefined) {
        // Best-effort journal update; crash-window leak is one socket file.
        void this.#registry.update(this.vmId, {
          vsockListenerPaths: listenerPaths(this.#resources),
        }).catch(() => {});
      }
      return listener;
    },
  };

  #requireVsockUds(port: number): string {
    if (this.paths.vsockUds === undefined) {
      throw new VsockDialError({
        reason: "socket-missing",
        udsPath: "<no vsock device configured>",
        port,
        attempts: 0,
      });
    }
    return this.paths.vsockUds;
  }

  /**
   * Escalating shutdown: `SendCtrlAltDel` (when running, x86_64) →
   * `SIGTERM` → `SIGKILL`, each stage deadline-bounded. Idempotent —
   * concurrent and repeated calls share one outcome. Resolves with the
   * observed exit; file cleanup happens at disposal, not here.
   */
  shutdown(opts?: ShutdownOptions): Promise<VmmExit> {
    if (this.#shutdownResult !== null) return this.#shutdownResult;
    if (this.#lifecycle.terminal) return this.exited;
    const wasRunning = this.#lifecycle.state === "running";
    this.#lifecycle.transition("shutting_down");
    const merged: ShutdownOptions = { ...this.#shutdown, ...opts };
    if (!wasRunning) merged.ctrlAltDelTimeoutMs = 0;
    this.#shutdownResult = (async () => {
      const exit = await escalatingShutdown({
        sendCtrlAltDel: () => this.client.sendCtrlAltDel(),
        kill: (signal) => this.#vmm.kill(signal),
        exited: this.#vmm.exited,
      }, merged);
      this.#lifecycle.transition("exited", exit);
      return exit;
    })();
    return this.#shutdownResult;
  }

  /** Straight `SIGKILL`, still reaped and state-tracked. */
  async kill(): Promise<VmmExit> {
    this.#vmm.kill("SIGKILL");
    if (this.#shutdownResult !== null) {
      try {
        return await this.#shutdownResult;
      } catch {
        // the sequencer had given up; fall through to direct reaping
      }
    }
    this.#lifecycle.transition("shutting_down");
    const exit = await this.#vmm.exited;
    this.#lifecycle.transition("exited", exit);
    return exit;
  }

  /**
   * Shut down (if still needed), confirm death, reclaim files, release the
   * client. Throws {@linkcode CleanupError} listing failures and leaked
   * paths if full reclamation was impossible — never silently.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const failures: CleanupFailure[] = [];
    if (!this.#lifecycle.terminal || this.#shutdownResult !== null) {
      try {
        await this.shutdown();
      } catch (cause) {
        failures.push({ step: "shutdown", cause });
      }
    }
    this.client.close();
    const confirmedDead = this.#vmm.exit !== null;
    if (confirmedDead) {
      failures.push(
        ...await runCleanupSteps(cleanupStepsForResources(this.#resources)),
      );
    }
    if (
      this.#registry !== undefined && confirmedDead &&
      failures.length === 0
    ) {
      try {
        await this.#registry.remove(this.vmId);
      } catch (cause) {
        failures.push({ step: "registry-remove", cause });
      }
    }
    this.#lifecycle.transition("exited", this.#vmm.exit ?? undefined);
    this.#lifecycle.transition("cleaned");
    if (failures.length > 0) {
      throw await cleanupError(
        failures,
        // A live process means its files must not be touched — report them.
        confirmedDead ? [] : [this.paths.stateDir],
      );
    }
  }

  async #awaitApiReady(
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const readySignal = signal === undefined
      ? this.#exitAborter.signal
      : AbortSignal.any([signal, this.#exitAborter.signal]);
    try {
      await this.client.waitReady({ timeoutMs, signal: readySignal });
    } catch (err) {
      // AbortSignal.any retains whichever caller/death reason happened first.
      if (readySignal.aborted) throw readySignal.reason;
      if (err instanceof ReadinessTimeoutError) {
        throw new ReadinessTimeoutError({
          socketPath: this.paths.apiSocket,
          waitedMs: timeoutMs,
          stderrTail: this.#vmm.stderrTail(),
          cause: err.cause,
        });
      }
      throw err;
    }
  }

  /** Kill, reap, and best-effort reclaim after a failed `create()`. */
  async #destroyAfterFailedCreate(): Promise<void> {
    this.#vmm.kill("SIGKILL");
    this.client.close();
    const observed = await withDeadline(this.#vmm.exited, 2_000);
    // An unkillable reparented VMM keeps its journal and all resources so
    // reconcile can retry; cleanup must not mask the original create error.
    if (observed === null) return;
    const exit = observed.done;
    this.#lifecycle.transition("exited", exit);
    this.#lifecycle.transition("cleaned");
    this.#disposed = true;
    // Best effort: the original create() error is what the caller needs.
    const failures = await runCleanupSteps(
      cleanupStepsForResources(this.#resources),
    );
    if (this.#registry !== undefined && failures.length === 0) {
      await this.#registry.remove(this.vmId).catch(() => {});
    }
  }
}

function pathsFromResources(resources: MachineResources): Machine["paths"] {
  return {
    apiSocket: resources.apiSocketPath,
    stateDir: resources.stateDir,
    ...(resources.vsockUdsPath !== undefined
      ? { vsockUds: resources.vsockUdsPath }
      : {}),
    ...(resources.chrootDir !== undefined
      ? { chrootRoot: join(resources.chrootDir, "root") }
      : {}),
  };
}

/** Best-effort failed-spawn reclaim that never masks the spawn error. */
async function cleanupFailedJail(
  resources: MachineResources,
  registry: VmRegistry,
  vmId: string,
): Promise<void> {
  const failures = await runCleanupSteps(cleanupStepsForResources(resources));
  if (failures.length === 0) {
    await registry.remove(vmId).catch(() => {});
  }
}

function resolveIn(baseDir: string, path: string): string {
  return isAbsolute(path) ? path : join(baseDir, path);
}

// vmIds of every live Machine this process holds (launched, restored, or
// adopted). Machine.adopt refuses vmIds present here — two live handles
// on one pid would mean two shutdown sequencers and racing cleanup.
// Entries clear when the machine's exit is observed (after which a
// re-adopt correctly fails with "vmm-not-found").
const liveVmIds = new Set<string>();

/**
 * The cgroup-v2 subtree the jailer creates for a machine, when cgroups
 * are in use (`/sys/fs/cgroup/<parent ?? execName>/<id>`). Undefined for
 * cgroup-v1 (per-controller layout, not one removable subtree) and when
 * no cgroup options are set.
 */
function cgroupV2Path(
  jailer: JailerOptions,
  jail: JailPaths,
): string | undefined {
  const usesCgroups = jailer.parentCgroup !== undefined ||
    Object.keys(jailer.cgroups ?? {}).length > 0;
  if (!usesCgroups || (jailer.cgroupVersion ?? 2) === 1) return undefined;
  return join(
    "/sys/fs/cgroup",
    jailer.parentCgroup ?? jail.execName,
    jail.id,
  );
}

/** Reject a jailed record whose persisted layout disagrees with its vmId. */
function validateJailRecord(record: JailRecord): void {
  const jailRoot = record.chrootDir;
  if (jailRoot === undefined) return;
  const id = basename(jailRoot);
  const execName = basename(dirname(jailRoot));
  const chrootRoot = join(jailRoot, "root");
  const pidfileHost = record.pidfilePath ??
    join(chrootRoot, `${execName}.pid`);
  if (
    id !== record.vmId || execName === "" ||
    basename(pidfileHost) !== `${execName}.pid`
  ) {
    throw new AdoptError({ vmId: record.vmId, reason: "corrupt-record" });
  }
}

/**
 * Resolve a user-supplied binary path the way a shell would: bare names
 * (no separator) are left for $PATH lookup; anything with a separator is
 * resolved against the CALLER's cwd. Without this, `Deno.Command`'s `cwd`
 * option would resolve relative binaries against the machine's state dir.
 */
function resolveBinaryPath(bin: string): string {
  return bin.includes("/") && !isAbsolute(bin) ? resolve(bin) : bin;
}

// sun_path is 108 bytes on Linux and 104 on macOS; stay under both.
const MAX_UNIX_SOCKET_PATH = 103;

function assertSocketPathLength(path: string, what: string): void {
  if (new TextEncoder().encode(path).length > MAX_UNIX_SOCKET_PATH) {
    throw new JailerConfigError(
      `${what} ${JSON.stringify(path)} is ${path.length} bytes — Unix ` +
        `socket paths are limited to ~${MAX_UNIX_SOCKET_PATH} bytes; use a ` +
        `shorter stateDir/chrootBaseDir or socket path`,
    );
  }
}

async function assertPathAbsent(path: string, what: string): Promise<void> {
  try {
    await Deno.lstat(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }
  throw new JailerConfigError(
    `${what} ${JSON.stringify(path)} already exists; refusing to claim or ` +
      "remove a caller-owned path",
  );
}
