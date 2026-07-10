/**
 * The escalating shutdown sequencer: `SendCtrlAltDel` → `SIGTERM` →
 * `SIGKILL`, each stage bounded by a deadline, never de-escalating.
 *
 * @module
 */

import { ShutdownTimeoutError } from "../errors.ts";
import { withDeadline } from "../internal/async.ts";
import type { ShutdownOptions, VmmExit } from "../types.ts";

/** What the sequencer needs from a machine; injectable for tests. */
export interface ShutdownTarget {
  /** Ask the guest to power off (`SendCtrlAltDel`). May reject if the API is gone. */
  sendCtrlAltDel(): Promise<void>;
  /** Deliver a signal to the VMM process. */
  kill(signal: Deno.Signal): void;
  /** Resolves when the VMM process exits. */
  exited: Promise<VmmExit>;
}

/** Resolved default deadlines for {@linkcode escalatingShutdown}. */
export const SHUTDOWN_DEFAULTS = {
  ctrlAltDelTimeoutMs: 10_000,
  sigtermTimeoutMs: 5_000,
  sigkillTimeoutMs: 2_000,
} as const;

/**
 * Run the escalating shutdown sequence against `target` and return the
 * observed exit.
 *
 * Stage 1 (`SendCtrlAltDel`) is skipped on aarch64 — Firecracker has no
 * i8042 there — and treated as a no-op if the API call itself fails (a
 * dying VMM can't be asked nicely). Throws {@linkcode ShutdownTimeoutError}
 * only if the process survives even SIGKILL's deadline.
 */
export async function escalatingShutdown(
  target: ShutdownTarget,
  opts: ShutdownOptions = {},
  arch: string = Deno.build.arch,
): Promise<VmmExit> {
  const ctrlAltDelMs = opts.ctrlAltDelTimeoutMs ??
    SHUTDOWN_DEFAULTS.ctrlAltDelTimeoutMs;
  const sigtermMs = opts.sigtermTimeoutMs ?? SHUTDOWN_DEFAULTS.sigtermTimeoutMs;
  const sigkillMs = opts.sigkillTimeoutMs ?? SHUTDOWN_DEFAULTS.sigkillTimeoutMs;

  // Stage 1: ask the guest nicely (x86_64 only).
  if (arch === "x86_64" && ctrlAltDelMs > 0) {
    let sent = true;
    try {
      await target.sendCtrlAltDel();
    } catch {
      // API unreachable or rejected the action — the process may already be
      // on its way down; fall through to the harder stages.
      sent = false;
    }
    if (sent) {
      const result = await withDeadline(target.exited, ctrlAltDelMs);
      if (result !== null) return result.done;
    }
  }

  // Stage 2: SIGTERM.
  target.kill("SIGTERM");
  {
    const result = await withDeadline(target.exited, sigtermMs);
    if (result !== null) return result.done;
  }

  // Stage 3: SIGKILL.
  target.kill("SIGKILL");
  {
    const result = await withDeadline(target.exited, sigkillMs);
    if (result !== null) return result.done;
  }

  throw new ShutdownTimeoutError({ stageReached: "sigkill" });
}
