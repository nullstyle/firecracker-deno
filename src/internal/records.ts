/**
 * Internal: shared record classification and reclaim logic for
 * `reconcile()` and `Machine.adopt()` — one implementation so the two
 * paths cannot drift on what "this record's VMM is alive" means.
 *
 * @module
 */

import { isAbsolute, relative } from "@std/path";
import {
  cleanupError,
  type CleanupStep,
  removePathStep,
  runCleanupSteps,
} from "../cleanup.ts";
import { tryReadPidfile } from "../process/pidfile.ts";
import type { JailRecord } from "../registry/registry.ts";
import { delay } from "./async.ts";
import {
  findVmmPidByCmdline,
  idCmdlineToken,
  pidAlive,
  pidIdentity,
  readPidStartTime,
} from "./liveness.ts";

/** A live listener whose socket must be closed before filesystem reclaim. */
export interface ResourceListener extends AsyncDisposable {
  readonly path: string;
}

/**
 * Every filesystem resource owned by, or explicitly created for, a machine.
 * This is the shared source for live-machine cleanup and record reclamation.
 */
export interface MachineResources {
  apiSocketPath: string;
  stateDir: string;
  ownsStateDir: boolean;
  vsockUdsPath?: string;
  vsockListeners: Set<string | ResourceListener>;
  pidfilePath?: string;
  chrootDir?: string;
  cgroupPath?: string;
}

/** Rehydrate the resource manifest persisted in a v1 record. */
export function resourcesFromRecord(
  record: JailRecord,
  listenerPaths: readonly string[] = record.vsockListenerPaths,
): MachineResources {
  return {
    apiSocketPath: record.apiSocketPath,
    stateDir: record.stateDir,
    ownsStateDir: record.ownsStateDir,
    vsockUdsPath: record.vsockUdsPath,
    vsockListeners: new Set<string | ResourceListener>(listenerPaths),
    pidfilePath: record.pidfilePath,
    chrootDir: record.chrootDir,
    cgroupPath: record.cgroupPath,
  };
}

/** The listener paths represented by a resource manifest. */
export function listenerPaths(resources: MachineResources): string[] {
  return [...resources.vsockListeners].map((listener) =>
    typeof listener === "string" ? listener : listener.path
  );
}

/** Build the unchanged v1 pre-spawn journal shape from machine resources. */
export function recordFromResources(
  vmId: string,
  resources: MachineResources,
  metadata?: Record<string, string>,
): JailRecord {
  const record: JailRecord = {
    version: 1,
    vmId,
    pid: null,
    apiSocketPath: resources.apiSocketPath,
    stateDir: resources.stateDir,
    ownsStateDir: resources.ownsStateDir,
    vsockListenerPaths: listenerPaths(resources),
    createdAt: new Date().toISOString(),
  };
  if (resources.vsockUdsPath !== undefined) {
    record.vsockUdsPath = resources.vsockUdsPath;
  }
  if (resources.pidfilePath !== undefined) {
    record.pidfilePath = resources.pidfilePath;
  }
  if (resources.chrootDir !== undefined) record.chrootDir = resources.chrootDir;
  if (resources.cgroupPath !== undefined) {
    record.cgroupPath = resources.cgroupPath;
  }
  if (metadata !== undefined) record.metadata = metadata;
  return record;
}

/**
 * Build cleanup in dependency order: close live listeners, remove owned
 * roots, unlink legacy resources outside those roots, and remove cgroups last.
 */
export function cleanupStepsForResources(
  resources: MachineResources,
): CleanupStep[] {
  const steps: CleanupStep[] = [];
  for (const listener of resources.vsockListeners) {
    if (typeof listener === "string") continue;
    steps.push({
      step: "close-vsock-listener",
      path: listener.path,
      async run() {
        await listener[Symbol.asyncDispose]();
      },
    });
  }

  const roots: string[] = [];
  const addPath = (
    step: string,
    path: string | undefined,
    recursive = false,
  ) => {
    if (path === undefined || roots.some((root) => containsPath(root, path))) {
      return;
    }
    if (recursive) roots.push(path);
    steps.push(removePathStep(step, path, { recursive }));
  };
  addPath("remove-chroot", resources.chrootDir, true);
  if (resources.ownsStateDir) {
    addPath("remove-state-dir", resources.stateDir, true);
  }
  addPath("unlink-api-socket", resources.apiSocketPath);
  addPath("unlink-vsock-uds", resources.vsockUdsPath);
  for (const path of listenerPaths(resources)) {
    addPath("unlink-vsock-listener", path);
  }
  addPath("unlink-pidfile", resources.pidfilePath);
  if (resources.cgroupPath !== undefined) {
    steps.push(removePathStep("remove-cgroup", resources.cgroupPath));
  }
  return steps;
}

function containsPath(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" ||
    (child !== ".." && !child.startsWith("../") && !isAbsolute(child));
}

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
