/**
 * The supervised machine façade: spawn Firecracker, wait for the API
 * (racing process death), apply configuration, run the lifecycle, and
 * guarantee cleanup.
 *
 * @module
 */

import { isAbsolute, join } from "@std/path";
import { FirecrackerClient } from "../api/client.ts";
import {
  cleanupError,
  type CleanupStep,
  removePathStep,
  runCleanupSteps,
} from "../cleanup.ts";
import {
  type CleanupFailure,
  ProcessExitedError,
  ReadinessTimeoutError,
} from "../errors.ts";
import { escalatingShutdown } from "../process/shutdown.ts";
import { VmmProcess } from "../process/supervisor.ts";
import type { ShutdownOptions, VmmExit, VmState } from "../types.ts";
import { VsockDialError } from "../errors.ts";
import { connectVsock, type VsockDialOptions } from "../vsock/dial.ts";
import type { VsockConn } from "../vsock/conn.ts";
import { listenVsock, type VsockListener } from "../vsock/listen.ts";
import { applyVmConfig, type VmConfig } from "./config.ts";
import { LifecycleState } from "./state.ts";

/** Options for {@linkcode Machine.create} / {@linkcode Machine.launch}. */
export interface MachineOptions {
  /** Path to the `firecracker` binary. */
  firecrackerBin: string;
  /** Whole-VM configuration applied before boot. */
  config: VmConfig;
  /** VM id passed as `--id`; also useful for log correlation. */
  id?: string;
  /**
   * API socket path; relative paths resolve inside `stateDir`.
   * @default "fc.sock" (inside the state dir)
   */
  socketPath?: string;
  /**
   * Directory for the machine's runtime files (sockets, by default). When
   * omitted, a temp dir is created and removed again during disposal; a
   * caller-provided dir is never deleted, only the files this library made.
   */
  stateDir?: string;
  /**
   * Deadline for the API socket to answer after spawn.
   * @default 5_000
   */
  readinessTimeoutMs?: number;
  /** Default deadlines for {@linkcode Machine.shutdown}. */
  shutdown?: ShutdownOptions;
  /** Extra argv appended to the Firecracker command line. */
  extraArgs?: string[];
  /** Aborts `create()` while it waits for readiness. */
  signal?: AbortSignal;
}

/**
 * A supervised Firecracker microVM.
 *
 * Construct via {@linkcode Machine.create} (spawn + configure, no boot) or
 * {@linkcode Machine.launch} (create + `InstanceStart`). Dispose with
 * `await using` — disposal shuts the VMM down, confirms death, reclaims
 * every file this library created, and only then resolves.
 *
 * @example
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
 * console.log("booted, pid", vm.pid);
 * const exit = await vm.shutdown();
 * console.log("guest exited:", exit);
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

  #vmm: VmmProcess;
  #lifecycle = new LifecycleState();
  #options: MachineOptions;
  #ownsStateDir: boolean;
  #shutdownResult: Promise<VmmExit> | null = null;
  #disposed = false;
  #vsockListeners = new Set<VsockListener>();

  private constructor(
    vmm: VmmProcess,
    client: FirecrackerClient,
    options: MachineOptions,
    paths: Machine["paths"],
    ownsStateDir: boolean,
  ) {
    this.#vmm = vmm;
    this.client = client;
    this.#options = options;
    this.paths = paths;
    this.#ownsStateDir = ownsStateDir;
    this.exited = vmm.exited;
    void vmm.exited.then((exit) => {
      this.#lifecycle.transition("exited", exit);
    });
  }

  /**
   * Spawn the VMM, wait for its API socket (racing process death), and
   * apply `options.config`. The machine is fully configured but **not**
   * booted — call {@linkcode start}, or use {@linkcode launch}.
   *
   * On any failure the spawned process is killed and reaped and created
   * files are removed before the error propagates: a failed `create` leaks
   * nothing.
   */
  static async create(options: MachineOptions): Promise<Machine> {
    options.signal?.throwIfAborted();
    const ownsStateDir = options.stateDir === undefined;
    const stateDir = options.stateDir ??
      await Deno.makeTempDir({ prefix: "fc-vm-" });
    if (!ownsStateDir) await Deno.mkdir(stateDir, { recursive: true });

    const apiSocket = resolveIn(stateDir, options.socketPath ?? "fc.sock");
    const args = [
      "--api-sock",
      apiSocket,
      ...(options.id !== undefined ? ["--id", options.id] : []),
      ...(options.extraArgs ?? []),
    ];
    const vmm = VmmProcess.spawn({
      command: options.firecrackerBin,
      args,
      cwd: stateDir,
    });
    const client = new FirecrackerClient({ socketPath: apiSocket });
    const paths: Machine["paths"] = {
      apiSocket,
      stateDir,
      ...(options.config.vsock
        ? { vsockUds: resolveIn(stateDir, options.config.vsock.uds_path) }
        : {}),
    };
    const machine = new Machine(vmm, client, options, paths, ownsStateDir);
    try {
      await machine.#awaitApiReady(
        options.readinessTimeoutMs ?? 5_000,
        options.signal,
      );
      await applyVmConfig(client, options.config);
    } catch (err) {
      await machine.#destroyAfterFailedCreate();
      throw err;
    }
    return machine;
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

  /** Current lifecycle state. */
  get state(): VmState {
    return this.#lifecycle.state;
  }

  /** PID of the VMM process. */
  get pid(): number {
    return this.#vmm.pid;
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

  /** Resolve when the machine reaches `state`; see `LifecycleState.waitFor`. */
  waitFor(
    state: VmState,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<void> {
    return this.#lifecycle.waitFor(state, opts);
  }

  /** Guest serial console tail (with `console=ttyS0` in the boot args). */
  consoleTail(): string {
    return this.#vmm.stdoutTail();
  }

  /**
   * Vsock operations against this machine's vsock device (requires
   * `config.vsock`). Connections are standard `Deno.Conn`s; listeners
   * created here are closed and unlinked during disposal.
   */
  readonly vsock: {
    /** Dial a guest port; see `connectVsock`. Requires a running machine. */
    connect: (port: number, opts?: VsockDialOptions) => Promise<VsockConn>;
    /** Listen for guest-initiated connections; see `listenVsock`. */
    listen: (port: number) => VsockListener;
  } = {
    connect: async (port, opts) => {
      this.#lifecycle.assert("vsock.connect", "running");
      return await connectVsock(this.#requireVsockUds(port), port, opts);
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
    const merged: ShutdownOptions = { ...this.#options.shutdown, ...opts };
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
    const steps: CleanupStep[] = [
      removePathStep("unlink-api-socket", this.paths.apiSocket),
    ];
    for (const listener of this.#vsockListeners) {
      steps.push({
        step: "close-vsock-listener",
        path: listener.path,
        run: async () => {
          await listener[Symbol.asyncDispose]();
        },
      });
    }
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
    await runCleanupSteps(this.#fileCleanupSteps());
  }
}

function resolveIn(baseDir: string, path: string): string {
  return isAbsolute(path) ? path : join(baseDir, path);
}
