/**
 * Core library-defined types shared across all layers of
 * `@nullstyle/firecracker`.
 *
 * Naming convention: anything Firecracker itself defines keeps its wire name
 * verbatim in `snake_case` (see the generated API types); anything this
 * library defines — including everything in this module — is `camelCase`.
 *
 * @module
 */

/**
 * Lifecycle state of a {@link https://jsr.io/@nullstyle/firecracker | Machine}.
 *
 * Transitions are strictly ordered and gate which operations are legal:
 *
 * ```
 * configured → starting → running ⇄ paused
 *     any of the above → shutting_down → exited → cleaned
 * ```
 *
 * Operations attempted in an incompatible state reject with
 * `InvalidStateError` rather than surfacing a confusing Firecracker API
 * error.
 */
export type VmState =
  | "configured"
  | "starting"
  | "running"
  | "paused"
  | "shutting_down"
  | "exited"
  | "cleaned";

/**
 * How a VMM process exit was observed.
 *
 * - `"child-status"` — the Firecracker process was a direct child and its
 *   exit status came from the process table (reliable exit code + signal).
 * - `"pidfile-poll"` — the VMM is not our child: it was reparented (jailer
 *   `--daemonize` or `--new-pid-ns`) or adopted after a supervisor restart
 *   (`Machine.adopt`), so death was detected by pid liveness polling. Exit
 *   codes are unobservable in this mode.
 */
export type ExitObservation = "child-status" | "pidfile-poll";

/**
 * Terminal description of a Firecracker VMM process exit.
 *
 * Resolved exactly once per machine via `Machine.exited`, and attached to
 * `ProcessExitedError` when an operation fails because the VMM died.
 */
export interface VmmExit {
  /**
   * Process exit code, or `null` when the exit code is unobservable — either
   * the process was killed by a signal, or it was reparented and only
   * pidfile-poll detection was possible (see {@linkcode ExitObservation}).
   */
  code: number | null;
  /** Signal that terminated the process, if any. */
  signal: Deno.Signal | null;
  /** How this exit was observed. */
  observedVia: ExitObservation;
  /**
   * The last ~8 KiB of the VMM's stderr, for crash diagnostics. Empty when
   * stderr was not capturable (e.g. under jailer `--daemonize`, which
   * redirects stderr to `/dev/null` — configure the Firecracker `logger`
   * device instead).
   */
  stderrTail: string;
}

/**
 * Stages of the escalating shutdown sequence, in order. Each stage runs only
 * if the previous one failed to end the process within its deadline.
 *
 * `"ctrl-alt-del"` is automatically skipped on aarch64 hosts, where
 * Firecracker has no i8042 device to deliver it.
 */
export type ShutdownStage = "ctrl-alt-del" | "sigterm" | "sigkill";

/** Per-stage deadlines for the escalating shutdown sequence. */
export interface ShutdownOptions {
  /**
   * Deadline for the guest to power off after `SendCtrlAltDel`.
   * @default 10_000
   */
  ctrlAltDelTimeoutMs?: number;
  /**
   * Deadline for the VMM to exit after SIGTERM.
   * @default 5_000
   */
  sigtermTimeoutMs?: number;
  /**
   * Deadline for the kernel to reap the VMM after SIGKILL. Exceeding this
   * throws `ShutdownTimeoutError` — it usually indicates an unkillable
   * (D-state) process.
   * @default 2_000
   */
  sigkillTimeoutMs?: number;
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
 * Why a host-to-guest vsock dial failed.
 *
 * - `"socket-missing"` — the vsock Unix socket path does not exist (VM not
 *   started, or no vsock device configured).
 * - `"connection-refused"` — the socket exists but Firecracker is not
 *   accepting on it.
 * - `"closed-before-ok"` — Firecracker accepted, but closed the connection
 *   before sending `OK` — the hybrid-vsock protocol's only signal that no
 *   guest listener is bound to that port.
 * - `"malformed-ack"` — the bytes received instead of `OK <port>\n` were not
 *   a valid acknowledgement.
 * - `"timeout"` — the retry budget was exhausted.
 */
export type VsockDialFailureReason =
  | "socket-missing"
  | "connection-refused"
  | "closed-before-ok"
  | "malformed-ack"
  | "timeout";

/**
 * Why `Machine.adopt` refused a record. Refusals never kill the process
 * or touch files — the record is left for `reconcile()` (or an explicit
 * `recover({ onUnadoptable: "kill" })`) to deal with.
 *
 * - `"vmm-not-found"` — no live process matches the record: the VMM is
 *   dead, or its pid was recycled by an unrelated process (reclaim the
 *   record via `reconcile()`).
 * - `"identity-unverifiable"` — the process's identity could not be read
 *   (`/proc` access denied). Refused on Linux; on runtimes without
 *   `/proc` adoption proceeds on pid liveness alone.
 * - `"not-started"` — the instance never booted. Its configuration is not
 *   persisted, so a pre-boot machine's invariants cannot be re-established.
 * - `"api-unreachable"` — the process is alive but its API socket did not
 *   answer within the deadline.
 * - `"api-mismatch"` — something answered on the API socket, but not this
 *   record's Firecracker (wrong instance id, or not Firecracker at all).
 * - `"already-adopted"` — this process already holds a live `Machine`
 *   (launched or adopted) for the record's vmId.
 * - `"corrupt-record"` — the record's fields are internally inconsistent
 *   (e.g. a jailed record whose paths don't agree with its vmId).
 * - `"conflict"` — the record vanished mid-adoption (a concurrent sweep
 *   removed it).
 */
export type AdoptFailureReason =
  | "vmm-not-found"
  | "identity-unverifiable"
  | "not-started"
  | "api-unreachable"
  | "api-mismatch"
  | "already-adopted"
  | "corrupt-record"
  | "conflict";
