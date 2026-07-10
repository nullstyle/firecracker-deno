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

  constructor(dir: string) {
    this.dir = dir;
  }

  async put(record: JailRecord): Promise<void> {
    await Deno.mkdir(this.dir, { recursive: true });
    await this.#writeAtomic(record.vmId, record);
  }

  async update(vmId: string, patch: Partial<JailRecord>): Promise<void> {
    const existing = JSON.parse(
      await Deno.readTextFile(this.#path(vmId)),
    ) as JailRecord;
    await this.#writeAtomic(vmId, { ...existing, ...patch, vmId });
  }

  async remove(vmId: string): Promise<void> {
    try {
      await Deno.remove(this.#path(vmId));
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }

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
    const tmp = `${path}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify(record, null, 2) + "\n");
    await Deno.rename(tmp, path);
  }
}
