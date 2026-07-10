/**
 * {@linkcode DirRegistry}: the standard {@linkcode VmRegistry} — one JSON
 * file per machine in a directory, written atomically (temp file + rename).
 *
 * @module
 */

import { join } from "@std/path";
import type { JailRecord, VmRegistry } from "./registry.ts";

const VM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** File-per-record registry rooted at a directory. */
export class DirRegistry implements VmRegistry {
  /** The directory holding `<vmId>.json` records (created on first put). */
  readonly dir: string;

  // Serializes mutations per vmId within this process, so concurrent
  // read-modify-write updates (e.g. fire-and-forget listener journaling)
  // cannot lose each other's patches.
  #locks = new Map<string, Promise<unknown>>();

  /** Use (and create on first put) `dir` as the record directory. */
  constructor(dir: string) {
    this.dir = dir;
  }

  /** Commit `record` atomically (temp file + rename). */
  async put(record: JailRecord): Promise<void> {
    return await this.#locked(record.vmId, async () => {
      await Deno.mkdir(this.dir, { recursive: true });
      await this.#writeAtomic(record.vmId, record);
    });
  }

  /** Merge `patch` into the stored record (read + atomic rewrite). */
  async update(vmId: string, patch: Partial<JailRecord>): Promise<void> {
    return await this.#locked(vmId, async () => {
      const existing = JSON.parse(
        await Deno.readTextFile(this.#path(vmId)),
      ) as JailRecord;
      await this.#writeAtomic(vmId, { ...existing, ...patch, vmId });
    });
  }

  /** Delete the record; already-gone is not an error. */
  async remove(vmId: string): Promise<void> {
    return await this.#locked(vmId, async () => {
      try {
        await Deno.remove(this.#path(vmId));
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
      }
    });
  }

  #locked<T>(vmId: string, fn: () => Promise<T>): Promise<T> {
    this.#path(vmId); // validate before queueing
    const prev = this.#locks.get(vmId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    this.#locks.set(vmId, run.then(() => {}, () => {}));
    return run;
  }

  /** All parseable records (torn tmp files and corrupt JSON are skipped). */
  async list(): Promise<JailRecord[]> {
    const records: JailRecord[] = [];
    try {
      // NB: readDir throws lazily, during iteration — guard the whole loop.
      for await (const entry of Deno.readDir(this.dir)) {
        if (!entry.isFile || !entry.name.endsWith(".json")) continue;
        try {
          const record = JSON.parse(
            await Deno.readTextFile(join(this.dir, entry.name)),
          ) as JailRecord;
          if (record.version === 1 && typeof record.vmId === "string") {
            records.push(record);
          }
        } catch {
          // torn tmp leftovers or corrupt files are not records
        }
      }
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return [];
      throw err;
    }
    return records;
  }

  #path(vmId: string): string {
    if (!VM_ID_PATTERN.test(vmId)) {
      throw new TypeError(
        `invalid vmId ${JSON.stringify(vmId)}: must match ${VM_ID_PATTERN}`,
      );
    }
    return join(this.dir, `${vmId}.json`);
  }

  async #writeAtomic(vmId: string, record: JailRecord): Promise<void> {
    const path = this.#path(vmId);
    // Unique temp name: a fixed suffix would let two writers (or two
    // processes) truncate each other's in-flight temp file.
    const tmp = `${path}.${crypto.randomUUID()}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify(record, null, 2) + "\n");
    await Deno.rename(tmp, path);
  }
}
