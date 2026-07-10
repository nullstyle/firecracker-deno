/**
 * Error taxonomy for `@nullstyle/firecracker`.
 *
 * Every error thrown by this library extends {@linkcode FirecrackerError}
 * and carries a stable, machine-readable {@linkcode FirecrackerError.code}.
 * Branch on `code` or use `instanceof` — never parse messages, which may
 * change between versions.
 *
 * @example Distinguishing failure modes
 * ```ts
 * import { ApiError, FirecrackerError, ProcessExitedError } from "@nullstyle/firecracker";
 *
 * try {
 *   // await machine.start();
 * } catch (err) {
 *   if (err instanceof ApiError) {
 *     console.error(`Firecracker rejected the request: ${err.faultMessage}`);
 *   } else if (err instanceof ProcessExitedError) {
 *     console.error(`VMM died: ${err.exit.stderrTail}`);
 *   } else if (err instanceof FirecrackerError) {
 *     console.error(`${err.code}: ${err.message}`);
 *   } else {
 *     throw err;
 *   }
 * }
 * ```
 *
 * @module
 */

import type {
  ShutdownStage,
  VmmExit,
  VmState,
  VsockDialFailureReason,
} from "./types.ts";

/**
 * Base class for every error thrown by `@nullstyle/firecracker`.
 *
 * `catch (err) { if (err instanceof FirecrackerError) ... }` reliably
 * separates this library's failures from unrelated ones.
 */
export abstract class FirecrackerError extends Error {
  /** Stable machine-readable code identifying the error class, e.g. `"FC_API"`. */
  abstract readonly code: string;
}

/**
 * The Firecracker API answered with a non-2xx status.
 *
 * Carries the parsed `fault_message` from the error body, so the guest
 * kernel path typo or the pre-boot/post-boot violation Firecracker is
 * complaining about is directly visible.
 */
export class ApiError extends FirecrackerError {
  override readonly code: "FC_API" = "FC_API";
  /** HTTP status returned by the Firecracker API. */
  readonly status: number;
  /** The `fault_message` from the error body, or the raw body when unparsable. */
  readonly faultMessage: string;
  /** HTTP method of the failed request. */
  readonly method: string;
  /** Request path, e.g. `"/machine-config"`. */
  readonly path: string;

  constructor(
    opts: {
      status: number;
      faultMessage: string;
      method: string;
      path: string;
      cause?: unknown;
    },
  ) {
    super(
      `${opts.method} ${opts.path} failed with status ${opts.status}: ${opts.faultMessage}`,
      { cause: opts.cause },
    );
    this.name = "ApiError";
    this.status = opts.status;
    this.faultMessage = opts.faultMessage;
    this.method = opts.method;
    this.path = opts.path;
  }
}

/**
 * The Firecracker API socket could not be reached at the transport level —
 * the socket file is missing, nothing is accepting on it, or the connection
 * broke mid-request. Distinct from {@linkcode ApiError}, which means the API
 * itself answered with an error.
 */
export class TransportError extends FirecrackerError {
  override readonly code: "FC_TRANSPORT" = "FC_TRANSPORT";
  /** Path of the Unix socket that could not be reached. */
  readonly socketPath: string;

  constructor(opts: { socketPath: string; message?: string; cause?: unknown }) {
    super(
      opts.message ??
        `cannot reach the Firecracker API socket at ${opts.socketPath}`,
      { cause: opts.cause },
    );
    this.name = "TransportError";
    this.socketPath = opts.socketPath;
  }
}

/**
 * An operation was attempted on (or interrupted by) a Firecracker process
 * that has exited. Carries the {@linkcode VmmExit} — including the stderr
 * tail, which almost always names the actual cause of death.
 */
export class ProcessExitedError extends FirecrackerError {
  override readonly code: "FC_VMM_EXITED" = "FC_VMM_EXITED";
  /** How and why the VMM exited. */
  readonly exit: VmmExit;

  constructor(opts: { exit: VmmExit; operation?: string; cause?: unknown }) {
    const how = opts.exit.signal !== null
      ? `signal ${opts.exit.signal}`
      : `exit code ${opts.exit.code ?? "unknown"}`;
    const tail = opts.exit.stderrTail.trim();
    super(
      `${
        opts.operation ?? "operation"
      } failed: the Firecracker process has exited (${how}, observed via ${opts.exit.observedVia})` +
        (tail === "" ? "" : `; stderr tail: ${lastChars(tail, 512)}`),
      { cause: opts.cause },
    );
    this.name = "ProcessExitedError";
    this.exit = opts.exit;
  }
}

/**
 * The Firecracker API socket did not become ready within the deadline, while
 * the process was still alive. (If the process died first, the failure is a
 * {@linkcode ProcessExitedError} instead.)
 */
export class ReadinessTimeoutError extends FirecrackerError {
  override readonly code: "FC_TIMEOUT" = "FC_TIMEOUT";
  /** The API socket path that never became ready. */
  readonly socketPath: string;
  /** How long readiness was awaited, in milliseconds. */
  readonly waitedMs: number;
  /** Captured stderr so far — often explains the stall. */
  readonly stderrTail: string;

  constructor(
    opts: { socketPath: string; waitedMs: number; stderrTail: string },
  ) {
    const tail = opts.stderrTail.trim();
    super(
      `Firecracker API socket ${opts.socketPath} not ready after ${opts.waitedMs}ms` +
        (tail === "" ? "" : `; stderr tail: ${lastChars(tail, 512)}`),
    );
    this.name = "ReadinessTimeoutError";
    this.socketPath = opts.socketPath;
    this.waitedMs = opts.waitedMs;
    this.stderrTail = opts.stderrTail;
  }
}

/**
 * The escalating shutdown sequence ran out of stages: the process survived
 * every stage's deadline — including SIGKILL, which usually indicates an
 * unkillable (D-state) process and a host-level problem.
 */
export class ShutdownTimeoutError extends FirecrackerError {
  override readonly code: "FC_SHUTDOWN" = "FC_SHUTDOWN";
  /** The last stage that was attempted before giving up. */
  readonly stageReached: ShutdownStage;

  constructor(opts: { stageReached: ShutdownStage; message?: string }) {
    super(
      opts.message ??
        `Firecracker process survived the shutdown sequence (last stage: ${opts.stageReached})`,
    );
    this.name = "ShutdownTimeoutError";
    this.stageReached = opts.stageReached;
  }
}

/**
 * A host-to-guest vsock connection could not be established. The
 * {@linkcode VsockDialError.reason} distinguishes "the VM isn't there" from
 * "the guest isn't listening on that port" — see
 * {@linkcode VsockDialFailureReason}.
 */
export class VsockDialError extends FirecrackerError {
  override readonly code: "FC_VSOCK_DIAL" = "FC_VSOCK_DIAL";
  /** Why the dial failed. */
  readonly reason: VsockDialFailureReason;
  /** The host-side Unix socket path of the vsock device. */
  readonly udsPath: string;
  /** The guest port that was dialed. */
  readonly port: number;
  /** How many connection attempts were made before failing. */
  readonly attempts: number;

  constructor(
    opts: {
      reason: VsockDialFailureReason;
      udsPath: string;
      port: number;
      attempts: number;
      cause?: unknown;
    },
  ) {
    super(
      `vsock dial to guest port ${opts.port} via ${opts.udsPath} failed after ${opts.attempts} attempt(s): ${opts.reason}`,
      { cause: opts.cause },
    );
    this.name = "VsockDialError";
    this.reason = opts.reason;
    this.udsPath = opts.udsPath;
    this.port = opts.port;
    this.attempts = opts.attempts;
  }
}

/**
 * Jailer options failed validation, or staging files into the chroot failed.
 * Raised before any process is spawned.
 */
export class JailerConfigError extends FirecrackerError {
  override readonly code: "FC_JAILER" = "FC_JAILER";

  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts);
    this.name = "JailerConfigError";
  }
}

/**
 * The operation is not legal in the machine's current lifecycle state —
 * e.g. calling `start()` twice, or reconfiguring a booted VM through a
 * pre-boot-only endpoint.
 */
export class InvalidStateError extends FirecrackerError {
  override readonly code: "FC_STATE" = "FC_STATE";
  /** The machine state at the time of the call. */
  readonly state: VmState;
  /** The operation that was rejected. */
  readonly operation: string;

  constructor(opts: { state: VmState; operation: string }) {
    super(`cannot ${opts.operation} while the machine is "${opts.state}"`);
    this.name = "InvalidStateError";
    this.state = opts.state;
    this.operation = opts.operation;
  }
}

/** One failed step within a cleanup pass. */
export interface CleanupFailure {
  /** The reclaim step that failed, e.g. `"unlink-vsock-listener"`. */
  step: string;
  /** Filesystem path involved, when applicable. */
  path?: string;
  /** The underlying error. */
  cause: unknown;
}

/**
 * Cleanup could not fully reclaim the machine's resources. Disposal never
 * hides this: the error enumerates each failed step and every path known to
 * still exist on disk, so callers (or a later `reconcile()` run) can finish
 * the job.
 */
export class CleanupError extends FirecrackerError {
  override readonly code: "FC_CLEANUP" = "FC_CLEANUP";
  /** Each cleanup step that failed, with its underlying cause. */
  readonly failures: ReadonlyArray<CleanupFailure>;
  /** Paths believed to still exist on disk after cleanup. */
  readonly leaked: ReadonlyArray<string>;

  constructor(
    opts: {
      failures: ReadonlyArray<CleanupFailure>;
      leaked: ReadonlyArray<string>;
    },
  ) {
    const steps = opts.failures.map((f) => f.step).join(", ");
    super(
      `cleanup incomplete: ${opts.failures.length} step(s) failed (${steps}); ` +
        `${opts.leaked.length} path(s) leaked`,
    );
    this.name = "CleanupError";
    this.failures = opts.failures;
    this.leaked = opts.leaked;
  }
}

function lastChars(s: string, n: number): string {
  return s.length <= n ? s : `…${s.slice(s.length - n)}`;
}
