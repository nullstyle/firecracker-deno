/**
 * {@linkcode reconcile}: the startup sweep that reclaims machines a
 * previous (crashed) supervisor left behind, driven by the registry's
 * {@link JailRecord | records}. The other half of "reliable lifecycle
 * cleanup" — run it before launching new machines.
 *
 * @module
 */

import { removePathStep, runCleanupSteps } from "../cleanup.ts";
import { CleanupError } from "../errors.ts";
import { delay } from "../internal/async.ts";
import { pidAlive, pidLooksLikeVmm } from "../internal/liveness.ts";
import type { JailRecord, VmRegistry } from "./registry.ts";

/** Options for {@linkcode reconcile}. */
export interface ReconcileOptions {
  /**
   * What to do with records whose VMM is still alive: `false` (default)
   * reports them in `stillRunning` and leaves them untouched — the safe
   * default for hosts where VMs may legitimately outlive a supervisor.
   * `true` SIGKILLs them first — the ephemeral-sandbox-fleet mode.
   */
  killLive?: boolean;
  /**
   * How long to wait for a SIGKILLed orphan to disappear.
   * @default 5_000
   */
  killTimeoutMs?: number;
  /** Abort the sweep between records. */
  signal?: AbortSignal;
}

/** Outcome of a {@linkcode reconcile} sweep. */
export interface ReconcileResult {
  /** vmIds fully reclaimed (files removed, record deleted). */
  reclaimed: string[];
  /** vmIds whose VMM is alive and was left alone (`killLive: false`). */
  stillRunning: string[];
  /** Records that could not be reclaimed; their records are kept. */
  failures: Array<{ vmId: string; error: unknown }>;
}

/**
 * Sweep every record in `registry`: confirm the VMM is dead (or kill it,
 * with `killLive`), reclaim its files, and delete the record. Records that
 * cannot be fully reclaimed are kept and reported in `failures`, so the
 * next sweep tries again. Never touches files of a live VMM.
 */
export async function reconcile(
  registry: VmRegistry,
  opts: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    reclaimed: [],
    stillRunning: [],
    failures: [],
  };
  for (const record of await registry.list()) {
    opts.signal?.throwIfAborted();
    try {
      const alive = record.pid !== null && pidAlive(record.pid) &&
        await pidLooksLikeVmm(record.pid, record.apiSocketPath);
      if (alive && opts.killLive !== true) {
        result.stillRunning.push(record.vmId);
        continue;
      }
      if (alive) {
        await killAndWait(
          record.pid!,
          opts.killTimeoutMs ?? 5_000,
          opts.signal,
        );
      }
      await reclaimFiles(record);
      await registry.remove(record.vmId);
      result.reclaimed.push(record.vmId);
    } catch (error) {
      result.failures.push({ vmId: record.vmId, error });
    }
  }
  return result;
}

async function killAndWait(
  pid: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  try {
    Deno.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
  const deadline = performance.now() + timeoutMs;
  while (pidAlive(pid)) {
    if (performance.now() >= deadline) {
      throw new Error(
        `pid ${pid} still exists ${timeoutMs}ms after SIGKILL (unkillable or unreaped zombie)`,
      );
    }
    await delay(50, signal);
  }
}

async function reclaimFiles(record: JailRecord): Promise<void> {
  const steps = [
    removePathStep("unlink-api-socket", record.apiSocketPath),
  ];
  if (record.vsockUdsPath !== undefined) {
    steps.push(removePathStep("unlink-vsock-uds", record.vsockUdsPath));
  }
  for (const path of record.vsockListenerPaths) {
    steps.push(removePathStep("unlink-vsock-listener", path));
  }
  if (record.pidfilePath !== undefined) {
    steps.push(removePathStep("unlink-pidfile", record.pidfilePath));
  }
  if (record.chrootDir !== undefined) {
    steps.push(
      removePathStep("remove-chroot", record.chrootDir, { recursive: true }),
    );
  }
  if (record.ownsStateDir) {
    steps.push(
      removePathStep("remove-state-dir", record.stateDir, { recursive: true }),
    );
  }
  const failures = await runCleanupSteps(steps);
  if (failures.length > 0) {
    throw new CleanupError({
      failures,
      leaked: failures.flatMap((f) => f.path === undefined ? [] : [f.path]),
    });
  }
}
