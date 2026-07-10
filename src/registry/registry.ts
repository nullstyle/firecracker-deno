/**
 * The crash-recovery journal: {@linkcode JailRecord} describes everything
 * needed to reclaim a machine after the supervising process is gone, and
 * {@linkcode VmRegistry} is where records live.
 *
 * Why this exists: `Symbol.asyncDispose`, `unload` hooks, and signal
 * listeners never run on SIGKILL, OOM, or a runtime crash. A machine's
 * record is committed **before** its VMM is spawned and removed only after
 * every resource is reclaimed — so at any instant, crash included, the
 * registry names everything a `reconcile()` sweep must deal with.
 *
 * @module
 */

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
  /** ISO 8601 creation time. */
  createdAt: string;
}

/**
 * Storage for {@linkcode JailRecord}s. Implementations must make `put`
 * atomic (a crash mid-write may lose the record, but must never corrupt
 * the store) — see {@linkcode DirRegistry} for the standard one.
 */
export interface VmRegistry {
  /** Commit a record. Called before the VMM is spawned. */
  put(record: JailRecord): Promise<void>;
  /** Merge `patch` into the record for `vmId` (e.g. the pid after spawn). */
  update(vmId: string, patch: Partial<JailRecord>): Promise<void>;
  /** Delete the record — only after full reclaim. */
  remove(vmId: string): Promise<void>;
  /** All current records. */
  list(): Promise<JailRecord[]>;
}
