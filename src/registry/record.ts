/**
 * Versioned crash-recovery record schema and its live-resource conversion.
 *
 * A record is committed before its VMM is spawned and removed only after
 * every named resource is reclaimed. Its version-1 persisted fields are a
 * compatibility contract independent of any particular registry backend.
 *
 * @module
 */

import { basename, dirname, join } from "@std/path";
import { AdoptError } from "../errors.ts";
import {
  listenerPaths,
  type MachineResources,
  type ResourceListener,
} from "../internal/resources.ts";

/** Everything needed to find and reclaim one machine's leavings. */
export interface JailRecord {
  /** Record schema version (currently 1). */
  version: 1;
  /** Unique machine id; also the registry key. */
  vmId: string;
  /** VMM pid once known; `null` between journal-commit and spawn. */
  pid: number | null;
  /** Host path of the API socket. */
  apiSocketPath: string;
  /** The machine's state directory. */
  stateDir: string;
  /** Whether the library created (and may delete) `stateDir`. */
  ownsStateDir: boolean;
  /** Host path of the vsock device socket, when configured. */
  vsockUdsPath?: string;
  /** Host paths of guest-initiated listener sockets (`<uds>_<port>`). */
  vsockListenerPaths: string[];
  /** Pidfile written by the jailer (reparented modes); see jailer docs. */
  pidfilePath?: string;
  /** Chroot directory of a jailed machine (removed on reclaim). */
  chrootDir?: string;
  /**
   * Resolved cgroup-v2 directory the jailer created for this machine
   * (`/sys/fs/cgroup/<parent ?? execName>/<id>`), when cgroups are in use.
   * The jailer never removes it — reclaim and disposal do, via this path.
   */
  cgroupPath?: string;
  /**
   * Opaque `/proc/<pid>/stat` start-time token captured when `pid` was
   * journaled. Compared for equality only: a live process with the same
   * pid but a different start time is a recycled pid, not this VMM.
   * Absent on runtimes without `/proc`.
   */
  pidStartTime?: string;
  /** ISO 8601 creation time. */
  createdAt: string;
  /** ISO 8601 time of the most recent adoption (`Machine.adopt`), if any. */
  adoptedAt?: string;
  /** Pid of the supervisor that adopted this record (diagnostic, not a lease). */
  supervisorPid?: number;
  /**
   * Opaque caller labels (lease ids, group names, tenant tags, …).
   * Recorded verbatim and never interpreted by this library — downstream
   * supervisors use it to correlate records with their own state.
   */
  metadata?: Record<string, string>;
}

/** Rehydrate the live resource manifest persisted in a v1 record. */
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

/** Reject a jailed record whose persisted layout disagrees with its vmId. */
export function validateJailRecord(record: JailRecord): void {
  const jailRoot = record.chrootDir;
  if (jailRoot === undefined) return;
  const id = basename(jailRoot);
  const execName = basename(dirname(jailRoot));
  const chrootRoot = join(jailRoot, "root");
  const pidfileHost = record.pidfilePath ??
    join(chrootRoot, `${execName}.pid`);
  if (
    id !== record.vmId || execName === "" ||
    basename(pidfileHost) !== `${execName}.pid`
  ) {
    throw new AdoptError({ vmId: record.vmId, reason: "corrupt-record" });
  }
}
