/**
 * {@linkcode reconcile}: the startup sweep that reclaims machines a
 * previous (crashed) supervisor left behind, driven by the registry's
 * {@link JailRecord | records}. The other half of "reliable lifecycle
 * cleanup" — run it before launching new machines.
 *
 * To *re-attach* to still-running machines instead of reporting (or
 * killing) them, see `recover()` / `Machine.adopt()` — and never run
 * `reconcile({ killLive: true })` after adopting: adopted machines'
 * records are live records.
 *
 * @module
 */

import {
  findLiveVmm,
  killAndWait,
  reclaimRecordFiles,
} from "../internal/records.ts";
import type { VmRegistry } from "./registry.ts";

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
      const live = await findLiveVmm(record);
      if (live !== null && opts.killLive !== true) {
        result.stillRunning.push(record.vmId);
        continue;
      }
      if (live !== null) {
        await killAndWait(live.pid, opts.killTimeoutMs ?? 5_000, opts.signal);
      }
      await reclaimRecordFiles(record);
      await registry.remove(record.vmId);
      result.reclaimed.push(record.vmId);
    } catch (error) {
      result.failures.push({ vmId: record.vmId, error });
    }
  }
  return result;
}
