import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { DirRegistry } from "../../src/registry/dir_registry.ts";
import type { JailRecord } from "../../src/registry/registry.ts";

function record(vmId: string, patch: Partial<JailRecord> = {}): JailRecord {
  return {
    version: 1,
    vmId,
    pid: null,
    apiSocketPath: `/tmp/${vmId}/fc.sock`,
    stateDir: `/tmp/${vmId}`,
    ownsStateDir: false,
    vsockListenerPaths: [],
    createdAt: "2026-07-10T00:00:00.000Z",
    ...patch,
  };
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "registry-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("put / list / update / remove round trip", async () => {
  await withDir(async (dir) => {
    const registry = new DirRegistry(join(dir, "reg"));
    await registry.put(record("vm-a"));
    await registry.put(record("vm-b", { pid: 42 }));
    assertEquals(
      (await registry.list()).map((r) => r.vmId).sort(),
      ["vm-a", "vm-b"],
    );
    await registry.update("vm-a", { pid: 7, chrootDir: "/srv/jail/a" });
    const updated = (await registry.list()).find((r) => r.vmId === "vm-a")!;
    assertEquals(updated.pid, 7);
    assertEquals(updated.chrootDir, "/srv/jail/a");
    await registry.remove("vm-a");
    assertEquals((await registry.list()).map((r) => r.vmId), ["vm-b"]);
    await registry.remove("vm-a"); // idempotent
  });
});

Deno.test("writes are atomic: no tmp files linger, records parse whole", async () => {
  await withDir(async (dir) => {
    const registry = new DirRegistry(join(dir, "reg"));
    for (let i = 0; i < 20; i++) {
      await registry.put(record(`vm-${i}`));
    }
    const names: string[] = [];
    for await (const entry of Deno.readDir(join(dir, "reg"))) {
      names.push(entry.name);
    }
    assertEquals(names.filter((n) => n.endsWith(".tmp")), []);
    assertEquals((await registry.list()).length, 20);
  });
});

Deno.test("corrupt files and non-records are skipped by list", async () => {
  await withDir(async (dir) => {
    const registry = new DirRegistry(join(dir, "reg"));
    await registry.put(record("vm-good"));
    await Deno.writeTextFile(join(dir, "reg", "broken.json"), "{not json");
    await Deno.writeTextFile(join(dir, "reg", "other.json"), '{"foo": 1}');
    await Deno.writeTextFile(join(dir, "reg", "vm-x.json.tmp"), "torn");
    assertEquals((await registry.list()).map((r) => r.vmId), ["vm-good"]);
  });
});

Deno.test("list on a registry dir that does not exist yet is empty", async () => {
  await withDir(async (dir) => {
    assertEquals(await new DirRegistry(join(dir, "nope")).list(), []);
  });
});

Deno.test("hostile vmIds are rejected before touching the filesystem", async () => {
  await withDir(async (dir) => {
    const registry = new DirRegistry(join(dir, "reg"));
    await assertRejects(
      () => registry.put(record("../escape")),
      TypeError,
      "invalid vmId",
    );
    await assertRejects(() => registry.update("a/b", {}), TypeError);
    await assertRejects(() => registry.remove(".hidden"), TypeError);
  });
});
