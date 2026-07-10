/**
 * The supervised machine façade: spawn Firecracker (directly or under the
 * jailer), wait for the API (racing process death), apply configuration,
 * run the lifecycle, and guarantee cleanup.
 *
 * @module
 */

import { isAbsolute, join, resolve } from "@std/path";
import { FirecrackerClient } from "../api/client.ts";
import type { SnapshotCreateParams, SnapshotLoadParams } from "../api/types.ts";
import {
  cleanupError,
  type CleanupStep,
  removePathStep,
  runCleanupSteps,
} from "../cleanup.ts";
import {
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
import { delay } from "../internal/async.ts";
import {
  findVmmPidByCmdline,
  idCmdlineToken,
  pidAlive,
} from "../internal/liveness.ts";
import { stageChroot } from "../jailer/stage.ts";
import {
  ReparentedVmm,
  tryReadPidfile,
  waitForPidfile,
} from "../process/pidfile.ts";
import { escalatingShutdown } from "../process/shutdown.ts";
import { type VmmHandle, VmmProcess } from "../process/supervisor.ts";
import type { VmRegistry } from "../registry/registry.ts";
import type { ShutdownOptions, VmmExit, VmState } from "../types.ts";
import type { VsockConn } from "../vsock/conn.ts";
import { connectVsock, type VsockDialOptions } from "../vsock/dial.ts";
import { listenVsock, type VsockListener } from "../vsock/listen.ts";
import { applyVmConfig, type VmConfig } from "./config.ts";
import { LifecycleState } from "./state.ts";

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
   * Opaque labels recorded on the machine's JailRecord (requires a
   * registry): lease ids, group names, tenant tags. Never interpreted.
   */
  metadata?: Record<string, string>;
  /** Aborts `create()` while it waits for readiness. */
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

/** Restore options shared by direct and jailed machines. */
export interface CommonRestoreOptions {
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
  /** See {@linkcode CommonMachineOptions.socketPath}. */
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
   * Opaque labels recorded on the machine's JailRecord (requires a
   * registry): lease ids, group names, tenant tags. Never interpreted.
   */
  metadata?: Record<string, string>;
  /** Aborts `restore()` while it waits for readiness. */
  signal?: AbortSignal;
}

/** Restore into a directly-spawned (unjailed) VMM. */
export interface DirectRestoreOptions extends CommonRestoreOptions {
  /** Path to the `firecracker` binary. */
  firecrackerBin: string;
  /** Discriminant: never set together with `firecrackerBin`. */
  jailer?: never;
  /** VM id (also passed as `--id`); generated when omitted. */
  id?: string;
  /** See {@linkcode DirectMachineOptions.stateDir}. */
  stateDir?: string;
  /** See {@linkcode DirectMachineOptions.registry}. */
  registry?: VmRegistry;
}

/** Restore into a jailed VMM (registry required, as always when jailed). */
export interface JailedRestoreOptions extends CommonRestoreOptions {
  /** Jailer configuration; `jailer.id` becomes the machine's vmId. */
  jailer: JailerOptions;
  /** Discriminant: never set together with `jailer`. */
  firecrackerBin?: never;
  /** The vmId is `jailer.id`; a separate id is not accepted. */
  id?: never;
  /** Jailed machines live in the chroot; no separate state dir. */
  stateDir?: never;
  /** See {@linkcode JailedMachineOptions.registry}. */
  registry: VmRegistry;
}

/** Options for {@linkcode Machine.restore}. */
export type RestoreOptions = DirectRestoreOptions | JailedRestoreOptions;

/** Cross-cutting settings a machine keeps for its whole life. */
interface MachineSettings {
  shutdown?: ShutdownOptions;
  registry?: VmRegistry;
  jailer?: JailerOptions;
}

/** Internal: what a direct spawn needs (config-independent). */
interface DirectSpawnSpec {
  firecrackerBin: string;
  id?: string;
  stateDir?: string;
  socketPath?: string;
  extraArgs?: string[];
  registry?: VmRegistry;
  shutdown?: ShutdownOptions;
  metadata?: Record<string, string>;
  /** vsock uds path as the VMM sees it (resolved against the state dir). */
  vsockPath?: string;
}

/** Internal: what a jailed spawn needs (config-independent). */
interface JailedSpawnSpec {
  jailer: JailerOptions;
  socketPath?: string;
  extraArgs?: string[];
  registry: VmRegistry | undefined;
  shutdown?: ShutdownOptions;
  readinessTimeoutMs?: number;
  signal?: AbortSignal;
  metadata?: Record<string, string>;
  /** vsock uds path as the VMM sees it (in-jail). */
  vsockPath?: string;
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
  #settings: MachineSettings;
  #ownsStateDir: boolean;
  #jail: JailPaths | null;
  #stagedPaths: ReadonlyMap<string, string>;
  #shutdownResult: Promise<VmmExit> | null = null;
  #disposed = false;
  #vsockListeners = new Set<VsockListener>();
  // Aborted (with a ProcessExitedError) the moment the VMM exit is
  // observed; composed into cancellable operations like vsock dials so
  // they reject promptly instead of burning their retry budgets.
  #exitAborter = new AbortController();

  private constructor(init: {
    vmm: VmmHandle;
    client: FirecrackerClient;
    settings: MachineSettings;
    paths: Machine["paths"];
    ownsStateDir: boolean;
    vmId: string;
    jail: JailPaths | null;
    stagedPaths: ReadonlyMap<string, string>;
  }) {
    this.#vmm = init.vmm;
    this.client = init.client;
    this.#settings = init.settings;
    this.paths = init.paths;
    this.#ownsStateDir = init.ownsStateDir;
    this.vmId = init.vmId;
    this.#jail = init.jail;
    this.#stagedPaths = init.stagedPaths;
    this.exited = init.vmm.exited;
    void init.vmm.exited.then((exit) => {
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

  static async #spawn(
    options: MachineOptions | RestoreOptions,
    vsockPath: string | undefined,
  ): Promise<Machine> {
    if (options.jailer !== undefined) {
      return await Machine.#spawnJailed({
        jailer: options.jailer,
        socketPath: options.socketPath,
        extraArgs: options.extraArgs,
        registry: options.registry,
        shutdown: options.shutdown,
        metadata: options.metadata,
        readinessTimeoutMs: options.readinessTimeoutMs,
        signal: options.signal,
        vsockPath,
      });
    }
    return await Machine.#spawnDirect({
      firecrackerBin: options.firecrackerBin,
      id: options.id,
      stateDir: options.stateDir,
      socketPath: options.socketPath,
      extraArgs: options.extraArgs,
      registry: options.registry,
      shutdown: options.shutdown,
      metadata: options.metadata,
      vsockPath,
    });
  }

  static async #spawnDirect(spec: DirectSpawnSpec): Promise<Machine> {
    const ownsStateDir = spec.stateDir === undefined;
    const stateDir = spec.stateDir ??
      await Deno.makeTempDir({ prefix: "fc-vm-" });
    if (!ownsStateDir) await Deno.mkdir(stateDir, { recursive: true });

    const vmId = spec.id ?? `fc-${crypto.randomUUID()}`;
    const apiSocket = resolveIn(stateDir, spec.socketPath ?? "fc.sock");
    const paths: Machine["paths"] = {
      apiSocket,
      stateDir,
      ...(spec.vsockPath !== undefined
        ? { vsockUds: resolveIn(stateDir, spec.vsockPath) }
        : {}),
    };
    let vmm: VmmProcess;
    let journaled = false;
    try {
      assertSocketPathLength(paths.apiSocket, "API socket path");
      if (paths.vsockUds !== undefined) {
        assertSocketPathLength(paths.vsockUds, "vsock UDS path");
      }

      // Journal-before-spawn: the record must exist before the process
      // does, so no crash window can leave an unrecorded VMM behind.
      if (spec.registry !== undefined) {
        await spec.registry.put({
          version: 1,
          vmId,
          pid: null,
          apiSocketPath: apiSocket,
          stateDir,
          ownsStateDir,
          ...(paths.vsockUds !== undefined
            ? { vsockUdsPath: paths.vsockUds }
            : {}),
          vsockListenerPaths: [],
          createdAt: new Date().toISOString(),
          ...(spec.metadata !== undefined ? { metadata: spec.metadata } : {}),
        });
        journaled = true;
      }

      vmm = VmmProcess.spawn({
        command: resolveBinaryPath(spec.firecrackerBin),
        args: [
          "--api-sock",
          apiSocket,
          "--id",
          vmId,
          ...(spec.extraArgs ?? []),
        ],
        cwd: stateDir,
      });
    } catch (err) {
      // Nothing is running (validation, journaling, or the spawn itself
      // failed) — undo what this call created: a failed create leaks
      // nothing, registry or not.
      if (journaled) await spec.registry!.remove(vmId).catch(() => {});
      if (ownsStateDir) {
        await Deno.remove(stateDir, { recursive: true }).catch(() => {});
      }
      throw err;
    }
    if (spec.registry !== undefined) {
      // Best-effort: a record with pid null still reconciles via its files
      // and reconcile()'s cmdline scan.
      await spec.registry.update(vmId, { pid: vmm.pid }).catch(() => {});
    }
    return new Machine({
      vmm,
      client: new FirecrackerClient({ socketPath: apiSocket }),
      settings: { shutdown: spec.shutdown, registry: spec.registry },
      paths,
      ownsStateDir,
      vmId,
      jail: null,
      stagedPaths: new Map(),
    });
  }

  static async #spawnJailed(spec: JailedSpawnSpec): Promise<Machine> {
    // Pin relative binary paths to our cwd before anything else consumes
    // them (spawn, --exec-file, chroot layout are all path-sensitive).
    const jailer: JailerOptions = {
      ...spec.jailer,
      jailerBin: resolveBinaryPath(spec.jailer.jailerBin),
      firecrackerBin: resolveBinaryPath(spec.jailer.firecrackerBin),
    };
    validateJailerOptions(jailer);
    if (spec.registry === undefined) {
      throw new JailerConfigError(
        "a registry is required for jailed machines: the jailer cleans up " +
          "nothing on exit, and only a pre-spawn journal makes chroots and " +
          "orphaned VMMs reclaimable after a supervisor crash (see reconcile())",
      );
    }
    const vmId = jailer.id;
    const jail = computeJailPaths(jailer);
    const socketJailPath = spec.socketPath ?? "/fc.sock";
    if (!socketJailPath.startsWith("/")) {
      throw new JailerConfigError(
        `jailed socketPath must be an absolute in-jail path, got ${
          JSON.stringify(socketJailPath)
        }`,
      );
    }
    const apiSocket = hostPathOf(jail, socketJailPath);
    const paths: Machine["paths"] = {
      apiSocket,
      stateDir: jail.jailRoot,
      chrootRoot: jail.chrootRoot,
      ...(spec.vsockPath !== undefined
        ? { vsockUds: hostPathOf(jail, spec.vsockPath) }
        : {}),
    };
    // Checked against the HOST view: the in-jail path is short, but tools
    // and tests reaching the socket from outside see the full chroot path.
    assertSocketPathLength(paths.apiSocket, "API socket path (host view)");
    if (paths.vsockUds !== undefined) {
      assertSocketPathLength(paths.vsockUds, "vsock UDS path (host view)");
    }

    // Journal-before-spawn (before staging, even: a crash mid-staging must
    // leave a reclaimable record for the half-built chroot).
    await spec.registry.put({
      version: 1,
      vmId,
      pid: null,
      apiSocketPath: apiSocket,
      stateDir: jail.jailRoot,
      ownsStateDir: false,
      chrootDir: jail.jailRoot,
      pidfilePath: jail.pidfileHost,
      ...(paths.vsockUds !== undefined ? { vsockUdsPath: paths.vsockUds } : {}),
      vsockListenerPaths: [],
      createdAt: new Date().toISOString(),
      ...(spec.metadata !== undefined ? { metadata: spec.metadata } : {}),
    });

    const plan = await stageChroot(jail, jailer);
    const stagedPaths = new Map(plan.map((a) => [a.hostPath, a.jailPath]));

    let jailerProc: VmmProcess;
    try {
      jailerProc = VmmProcess.spawn({
        command: jailer.jailerBin,
        args: buildJailerArgv(jailer, [
          "--api-sock",
          socketJailPath,
          "--id",
          vmId,
          ...(spec.extraArgs ?? []),
        ]),
      });
    } catch (err) {
      // The jailer never started: unwind the staged chroot and the record.
      const failures = await runCleanupSteps([
        removePathStep("remove-chroot", jail.jailRoot, { recursive: true }),
      ]);
      if (failures.length === 0) {
        await spec.registry.remove(vmId).catch(() => {});
      }
      throw err;
    }

    const reparented = jailer.daemonize === true || jailer.newPidNs === true;
    let vmm: VmmHandle = jailerProc;
    try {
      if (reparented) {
        const pid = await waitForPidfile(jail.pidfileHost, {
          jailer: jailerProc,
          timeoutMs: spec.readinessTimeoutMs ?? 5_000,
          signal: spec.signal,
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
      if (orphan !== null && pidAlive(orphan)) {
        try {
          Deno.kill(orphan, "SIGKILL");
        } catch {
          // gone between probe and kill
        }
        const deadline = performance.now() + 2_000;
        while (pidAlive(orphan) && performance.now() < deadline) {
          await delay(50);
        }
        if (pidAlive(orphan)) {
          // Unkillable: keep the record (now with the pid) for reconcile
          // and leave the chroot alone.
          await spec.registry.update(vmId, { pid: orphan }).catch(() => {});
          throw err;
        }
      }
      const failures = await runCleanupSteps([
        removePathStep("remove-chroot", jail.jailRoot, { recursive: true }),
      ]);
      if (failures.length === 0) {
        await spec.registry.remove(vmId).catch(() => {});
      }
      throw err;
    }
    await spec.registry.update(vmId, { pid: vmm.pid }).catch(() => {});

    return new Machine({
      vmm,
      client: new FirecrackerClient({ socketPath: apiSocket }),
      settings: {
        shutdown: spec.shutdown,
        registry: spec.registry,
        jailer,
      },
      paths,
      ownsStateDir: false,
      vmId,
      jail,
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
    if (this.#jail === null) return hostPath;
    const staged = this.#stagedPaths.get(hostPath);
    if (staged !== undefined) return staged;
    const root = this.#jail.chrootRoot;
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
      this.#vsockListeners.add(listener);
      if (this.#settings.registry !== undefined) {
        // Best-effort journal update; crash-window leak is one socket file.
        void this.#settings.registry.update(this.vmId, {
          vsockListenerPaths: [...this.#vsockListeners].map((l) => l.path),
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
    const merged: ShutdownOptions = { ...this.#settings.shutdown, ...opts };
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
      failures.push(...await runCleanupSteps(this.#fileCleanupSteps()));
    }
    if (
      this.#settings.registry !== undefined && confirmedDead &&
      failures.length === 0
    ) {
      try {
        await this.#settings.registry.remove(this.vmId);
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

  #fileCleanupSteps(): CleanupStep[] {
    const steps: CleanupStep[] = [];
    for (const listener of this.#vsockListeners) {
      steps.push({
        step: "close-vsock-listener",
        path: listener.path,
        run: async () => {
          await listener[Symbol.asyncDispose]();
        },
      });
    }
    if (this.#jail !== null) {
      // The whole jail root (chroot incl. sockets, pidfile, staged files,
      // mknod'd device nodes) belongs to this machine. Safe: we only get
      // here after confirmed death.
      steps.push(
        removePathStep("remove-chroot", this.#jail.jailRoot, {
          recursive: true,
        }),
      );
      const cgroupStep = this.#cgroupCleanupStep();
      if (cgroupStep !== null) steps.push(cgroupStep);
      return steps;
    }
    steps.push(removePathStep("unlink-api-socket", this.paths.apiSocket));
    if (this.paths.vsockUds !== undefined) {
      steps.push(removePathStep("unlink-vsock-uds", this.paths.vsockUds));
    }
    if (this.#ownsStateDir) {
      steps.push(
        removePathStep("remove-state-dir", this.paths.stateDir, {
          recursive: true,
        }),
      );
    }
    return steps;
  }

  /** Best-effort cgroup-v2 subtree removal (jailer creates, never removes). */
  #cgroupCleanupStep(): CleanupStep | null {
    const jailer = this.#settings.jailer;
    if (jailer === undefined || this.#jail === null) return null;
    const usesCgroups = jailer.parentCgroup !== undefined ||
      Object.keys(jailer.cgroups ?? {}).length > 0;
    if (!usesCgroups || (jailer.cgroupVersion ?? 2) === 1) return null;
    const parent = jailer.parentCgroup ?? this.#jail.execName;
    const path = join("/sys/fs/cgroup", parent, this.#jail.id);
    return removePathStep("remove-cgroup", path);
  }

  async #awaitApiReady(
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const ac = new AbortController();
    const onCallerAbort = () => ac.abort(signal!.reason);
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    void this.#vmm.exited.then((exit) =>
      ac.abort(
        new ProcessExitedError({ exit, operation: "wait for the API socket" }),
      )
    );
    try {
      await this.client.waitReady({ timeoutMs, signal: ac.signal });
    } catch (err) {
      if (
        ac.signal.aborted && ac.signal.reason instanceof ProcessExitedError
      ) {
        throw ac.signal.reason;
      }
      if (err instanceof ReadinessTimeoutError) {
        throw new ReadinessTimeoutError({
          socketPath: this.paths.apiSocket,
          waitedMs: timeoutMs,
          stderrTail: this.#vmm.stderrTail(),
          cause: err.cause,
        });
      }
      throw err;
    } finally {
      signal?.removeEventListener("abort", onCallerAbort);
    }
  }

  /** Kill, reap, and best-effort reclaim after a failed `create()`. */
  async #destroyAfterFailedCreate(): Promise<void> {
    this.#vmm.kill("SIGKILL");
    const exit = await this.#vmm.exited;
    this.client.close();
    this.#lifecycle.transition("exited", exit);
    this.#lifecycle.transition("cleaned");
    this.#disposed = true;
    // Best effort: the original create() error is what the caller needs.
    const failures = await runCleanupSteps(this.#fileCleanupSteps());
    if (this.#settings.registry !== undefined && failures.length === 0) {
      await this.#settings.registry.remove(this.vmId).catch(() => {});
    }
  }
}

function resolveIn(baseDir: string, path: string): string {
  return isAbsolute(path) ? path : join(baseDir, path);
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
