/**
 * The escalating shutdown sequencer: `SendCtrlAltDel` → `SIGTERM` →
 * `SIGKILL`, each stage bounded by a deadline, never de-escalating.
 *
 * @module
 */

import { ShutdownTimeoutError } from "../errors.ts";
import { withDeadline } from "../internal/async.ts";
import type { ShutdownOptions, VmmExit } from "../types.ts";

interface ShutdownTarget {
  sendCtrlAltDel(): Promise<void>;
  kill(signal: Deno.Signal): void;
  exited: Promise<VmmExit>;
}

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
  const {
    ctrlAltDelTimeoutMs: ctrlAltDelMs = 10_000,
    sigtermTimeoutMs: sigtermMs = 5_000,
    sigkillTimeoutMs: sigkillMs = 2_000,
  } = opts;

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

  for (
    const [signal, timeoutMs] of [
      ["SIGTERM", sigtermMs],
      ["SIGKILL", sigkillMs],
    ] as const
  ) {
    target.kill(signal);
    const result = await withDeadline(target.exited, timeoutMs);
    if (result !== null) return result.done;
  }

  throw new ShutdownTimeoutError({ stageReached: "sigkill" });
}
