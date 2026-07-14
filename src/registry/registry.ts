/**
 * The crash-recovery journal storage port. {@linkcode JailRecord} defines the
 * persisted schema; {@linkcode VmRegistry} defines where records live.
 *
 * Why this exists: `Symbol.asyncDispose`, `unload` hooks, and signal
 * listeners never run on SIGKILL, OOM, or a runtime crash. A machine's
 * record is committed **before** its VMM is spawned and removed only after
 * every resource is reclaimed — so at any instant, crash included, the
 * registry names everything a `reconcile()` sweep must deal with.
 *
 * @module
 */

import type { JailRecord } from "./record.ts";

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
