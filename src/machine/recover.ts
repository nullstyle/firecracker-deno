/**
 * {@linkcode recover}: the supervisor-restart sweep. Where `reconcile()`
 * reclaims the dead (and can kill the living), `recover()` **re-attaches**
 * to the living — every record whose VMM survived the previous supervisor
 * comes back as a live {@linkcode Machine} — and reclaims only what is
 * actually dead.
 *
 * This is the single recovery entry point for supervisors whose VMs must
 * survive a supervisor crash. Do not follow it with
 * `reconcile({ killLive: true })`: adopted machines' records are live
 * records, and a kill-sweep would destroy exactly what was just adopted.
 *
 * Use {@linkcode RecoverOptions.decide} to adopt only records this
 * supervisor recognizes (e.g. by session table or `metadata`) and reclaim
 * the strays.
 *
 * @example Supervisor startup
 * ```ts
 * import { DirRegistry, recover } from "@nullstyle/firecracker";
 *
 * const registry = new DirRegistry("/var/lib/rootd/registry");
 * const sweep = await recover(registry);
 * for (const vm of sweep.adopted) {
 *   console.log(`re-attached ${vm.vmId} (pid ${vm.pid}): ${vm.state}`);
 * }
 * for (const vmId of sweep.reclaimed) {
 *   console.log(`${vmId} died while the supervisor was down`);
 * }
 * for (const u of sweep.unadoptable) console.warn(u.vmId, u.reason);
 * ```
 *
 * @module
 */

import { AdoptError, ProcessExitedError } from "../errors.ts";
import {
  findLiveVmm,
  killAndWait,
  reclaimRecordFiles,
} from "../internal/records.ts";
import type { JailRecord } from "../registry/record.ts";
import type { VmRegistry } from "../registry/registry.ts";
import type { AdoptFailureReason, ShutdownOptions } from "../types.ts";
import { Machine } from "./machine.ts";

/** Options for {@linkcode recover}. */
export interface RecoverOptions {
  /**
   * Per-record routing, consulted before anything is probed: `"adopt"`
   * (default) re-attaches, `"reclaim"` kills a live VMM and reclaims its
   * record (the stray-session policy), `"keep"` leaves the record and its
   * VMM untouched and reports it in `kept`.
   */
  decide?: (record: JailRecord) => "adopt" | "reclaim" | "keep";
  /**
   * What to do with a *live* VMM that cannot be adopted (never booted,
   * API unreachable/mismatched, identity unverifiable): `"keep"`
   * (default) reports it and leaves it alone; `"kill"` SIGKILLs it and
   * reclaims — fleet mode. Refusals that must never kill (`"conflict"`,
   * `"already-adopted"`) are always kept.
   */
  onUnadoptable?: "keep" | "kill";
  /** Per-record API probe deadline, passed to `Machine.adopt`. @default 2_000 */
  readinessTimeoutMs?: number;
  /** Default shutdown deadlines for each adopted machine. */
  shutdown?: ShutdownOptions;
  /** How long to wait for a killed VMM to disappear. @default 5_000 */
  killTimeoutMs?: number;
  /**
   * Stop the sweep early. `recover` never rejects on abort — it stops
   * processing and RESOLVES with the partial result, because the machines
   * already adopted are live handles the caller must receive to dispose.
   * The record being processed when the abort lands is left untouched
   * for the next sweep.
   */
  signal?: AbortSignal;
}

/** Outcome of a {@linkcode recover} sweep. */
export interface RecoverResult {
  /** Live machines re-attached; the caller owns their disposal. */
  adopted: Machine[];
  /** vmIds whose VMM was dead (or was killed): files removed, record deleted. */
  reclaimed: string[];
  /** vmIds routed `"keep"` by `decide`; nothing was probed or touched. */
  kept: string[];
  /** Live but unadoptable VMMs, and what was done about each. */
  unadoptable: Array<{
    vmId: string;
    reason: AdoptFailureReason;
    error: AdoptError;
    disposition: "kept" | "killed";
  }>;
  /** Records that could not be processed; their records are kept. */
  failures: Array<{ vmId: string; error: unknown }>;
}

// Refusals where SIGKILLing the located pid is never acceptable:
// "already-adopted" names a machine THIS process holds live, and
// "conflict" means a concurrent sweep owns the record.
const NEVER_KILL: ReadonlySet<AdoptFailureReason> = new Set([
  "already-adopted",
  "conflict",
]);

/**
 * Sweep every record in `registry`, one pass per record: adopt the
 * living (→ `adopted`), reclaim the dead (→ `reclaimed`), report — or,
 * with `onUnadoptable: "kill"`, put down — the live-but-unadoptable
 * (→ `unadoptable`). Records that fail outright stay in the registry and
 * are reported in `failures`, so the next sweep retries them.
 *
 * A VMM that dies *during* its adoption (once past the API probe) is
 * reclaimed on the spot and counted in `reclaimed` — indistinguishable
 * from "was already dead". A death *during* the probe itself reads as
 * `"api-unreachable"` instead; the record is kept, and the next sweep
 * classifies it dead and reclaims it.
 */
export async function recover(
  registry: VmRegistry,
  opts: RecoverOptions = {},
): Promise<RecoverResult> {
  const result: RecoverResult = {
    adopted: [],
    reclaimed: [],
    kept: [],
    unadoptable: [],
    failures: [],
  };
  const killTimeoutMs = opts.killTimeoutMs ?? 5_000;
  for (const record of await registry.list()) {
    // On abort, resolve with what we have: the adopted machines are live
    // handles the caller must receive to dispose (rejecting would strand
    // them, uncancellable poll loops and all).
    if (opts.signal?.aborted) break;
    const vmId = record.vmId;
    try {
      const decision = opts.decide?.(record) ?? "adopt";
      if (decision === "keep") {
        result.kept.push(vmId);
        continue;
      }
      if (decision === "reclaim") {
        await killAndReclaim(registry, record, killTimeoutMs, opts.signal);
        result.reclaimed.push(vmId);
        continue;
      }
      try {
        result.adopted.push(
          await Machine.adopt({
            record,
            registry,
            readinessTimeoutMs: opts.readinessTimeoutMs,
            shutdown: opts.shutdown,
            signal: opts.signal,
          }),
        );
      } catch (err) {
        if (err instanceof ProcessExitedError) {
          // Died mid-adoption. adopt() already ran best-effort reclaim;
          // finish the job (both steps tolerate already-gone) so
          // `reclaimed` — "files removed, record deleted" — is the truth.
          await reclaimRecordFiles(record);
          await registry.remove(vmId);
          result.reclaimed.push(vmId);
        } else if (err instanceof AdoptError) {
          if (err.reason === "vmm-not-found") {
            // Nothing alive behind the record — plain reclaim.
            await reclaimRecordFiles(record);
            await registry.remove(vmId);
            result.reclaimed.push(vmId);
          } else if (
            opts.onUnadoptable === "kill" && !NEVER_KILL.has(err.reason)
          ) {
            await killAndReclaim(registry, record, killTimeoutMs, opts.signal);
            result.unadoptable.push({
              vmId,
              reason: err.reason,
              error: err,
              disposition: "killed",
            });
          } else {
            result.unadoptable.push({
              vmId,
              reason: err.reason,
              error: err,
              disposition: "kept",
            });
          }
        } else {
          throw err;
        }
      }
    } catch (error) {
      // An abort mid-record is not a per-record failure: stop the sweep
      // and resolve with the partial result. (Machine.adopt propagates
      // the caller's abort reason rather than misclassifying it.)
      if (opts.signal?.aborted) break;
      result.failures.push({ vmId, error });
    }
  }
  return result;
}

async function killAndReclaim(
  registry: VmRegistry,
  record: JailRecord,
  killTimeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const live = await findLiveVmm(record);
  if (live !== null) await killAndWait(live.pid, killTimeoutMs, signal);
  await reclaimRecordFiles(record);
  await registry.remove(record.vmId);
}
