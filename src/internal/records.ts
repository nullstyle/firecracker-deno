/**
 * Internal: shared record classification and reclaim logic for
 * `reconcile()` and `Machine.adopt()` — one implementation so the two
 * paths cannot drift on what "this record's VMM is alive" means.
 *
 * @module
 */

import { cleanupError, runCleanupSteps } from "../cleanup.ts";
import { tryReadPidfile } from "../process/pidfile.ts";
import { type JailRecord, resourcesFromRecord } from "../registry/record.ts";
import { delay } from "./async.ts";
import {
  findVmmPidByCmdline,
  idCmdlineToken,
  pidAlive,
  pidIdentity,
  readPidStartTime,
} from "./liveness.ts";
import { cleanupStepsForResources } from "./resources.ts";

/** A record's live VMM, and how strongly its identity was established. */
export interface LiveVmm {
  pid: number;
  /**
   * `"match"`: the cmdline positively names this VMM. `"unverifiable"`:
   * the cmdline could not be read (non-Linux, hidepid, permissions) —
   * the pid is alive and nothing disproves it, but identity is unproven.
   */
  identity: "match" | "unverifiable";
}

/**
 * Locate the live VMM for `record`, if any. Candidate sources in order:
 * the jailer pidfile (authoritative — it is what Firecracker wrote; the
 * recorded pid is a copy of an earlier read), the recorded pid, then a
 * `/proc` cmdline scan (the journal-gap rescue: the record may predate
 * the pid update, or the pid may have been recycled).
 *
 * A candidate counts only when it is alive and nothing positively
 * disproves its identity: a cmdline mismatch or a `pidStartTime`
 * disagreement means "recycled pid", never "our VMM".
 */
export async function findLiveVmm(record: JailRecord): Promise<LiveVmm | null> {
  // Identity tokens: the --id argv token works inside and outside a
  // chroot; the host-view socket path additionally matches direct VMMs.
  const tokens = [idCmdlineToken(record.vmId), record.apiSocketPath];
  const candidates: number[] = [];
  if (record.pidfilePath !== undefined) {
    const pid = await tryReadPidfile(record.pidfilePath);
    if (pid !== null) candidates.push(pid);
  }
  if (record.pid !== null && !candidates.includes(record.pid)) {
    candidates.push(record.pid);
  }
  // Pids POSITIVELY disproven (cmdline or start-time mismatch): the
  // cmdline scan must not hand the very same pid back.
  const rejected = new Set<number>();
  for (const pid of candidates) {
    if (!pidAlive(pid)) continue;
    const identity = await pidIdentity(pid, tokens);
    if (identity === "mismatch") {
      rejected.add(pid);
      continue;
    }
    if (identity === "unverifiable" && !pidAlive(pid)) continue; // died mid-probe
    if (record.pidStartTime !== undefined && pid === record.pid) {
      const startTime = await readPidStartTime(pid);
      if (startTime !== null && startTime !== record.pidStartTime) {
        rejected.add(pid);
        continue;
      }
    }
    return { pid, identity };
  }
  const scanned = await findVmmPidByCmdline(tokens, rejected);
  // A scan hit matched the cmdline by construction.
  return scanned === null ? null : { pid: scanned, identity: "match" };
}

/** SIGKILL `pid` and poll until it is gone, or throw after `timeoutMs`. */
export async function killAndWait(
  pid: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  // Never deliver the kill on behalf of an already-cancelled sweep.
  signal?.throwIfAborted();
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

/**
 * Remove everything a dead machine's record names on disk. Only call
 * after its VMM is confirmed dead — the recursive steps would destroy a
 * live VM's backing files. Throws {@linkcode CleanupError} naming what
 * leaked when any step fails.
 */
export async function reclaimRecordFiles(record: JailRecord): Promise<void> {
  const failures = await runCleanupSteps(
    cleanupStepsForResources(resourcesFromRecord(record)),
  );
  if (failures.length > 0) {
    throw await cleanupError(failures);
  }
}
