/**
 * Regression tests for the defects found in the pre-release adversarial
 * review: failed-create leaks, registry update races, unbounded waitReady
 * attempts, and jailer failure classification.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  DirRegistry,
  JailerConfigError,
  Machine,
  ReadinessTimeoutError,
  VmmProcess,
  waitForPidfile,
} from "../../mod.ts";
import { FirecrackerClient } from "../../mod.ts";
import type { JailRecord } from "../../mod.ts";

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "fcr-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("failed spawn (bad binary) unwinds the journal record and state", async () => {
  await withDir(async (dir) => {
    const registry = new DirRegistry(join(dir, "registry"));
    await assertRejects(
      () =>
        Machine.create({
          firecrackerBin: join(dir, "no-such-firecracker"),
          config: { boot_source: { kernel_image_path: "/vmlinux" } },
          registry,
        }),
      Deno.errors.NotFound,
    );
    assertEquals(await registry.list(), [], "record must be unwound");
  });
});

Deno.test("over-long socket path fails fast without leaking a record", async () => {
  await withDir(async (dir) => {
    const registry = new DirRegistry(join(dir, "registry"));
    await assertRejects(
      () =>
        Machine.create({
          firecrackerBin: "/bin/echo",
          stateDir: join(dir, "x".repeat(120)),
          config: { boot_source: { kernel_image_path: "/vmlinux" } },
          registry,
        }),
      JailerConfigError,
      "socket paths are limited",
    );
    assertEquals(await registry.list(), []);
  });
});

Deno.test("concurrent DirRegistry updates serialize: no lost patches, no tmp litter", async () => {
  await withDir(async (dir) => {
    const registry = new DirRegistry(join(dir, "registry"));
    const record: JailRecord = {
      version: 1,
      vmId: "racy",
      pid: null,
      apiSocketPath: "/tmp/racy.sock",
      stateDir: "/tmp/racy",
      ownsStateDir: false,
      vsockListenerPaths: [],
      createdAt: "2026-07-10T00:00:00.000Z",
    };
    await registry.put(record);
    // Fire many read-modify-write updates concurrently; with the old
    // unserialized implementation these lose writes or hit rename races.
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) =>
        registry.update("racy", {
          vsockListenerPaths: [`/tmp/racy/v.sock_${i}`],
        })),
      ...Array.from(
        { length: 10 },
        (_, i) => registry.update("racy", { pid: i + 1 }),
      ),
    ]);
    const records = await registry.list();
    assertEquals(records.length, 1);
    assert(records[0].pid !== null, "a pid patch must have survived");
    assertEquals(records[0].vsockListenerPaths.length, 1);
    for await (const entry of Deno.readDir(join(dir, "registry"))) {
      assert(!entry.name.endsWith(".tmp"), `tmp litter: ${entry.name}`);
    }
  });
});

Deno.test("waitReady respects its budget against a socket that accepts but never answers", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "hang.sock");
    const listener = Deno.listen({ transport: "unix", path });
    const conns: Deno.Conn[] = [];
    const serving = (async () => {
      for await (const conn of listener) conns.push(conn); // never respond
    })();
    try {
      using client = new FirecrackerClient({ socketPath: path });
      const started = performance.now();
      await assertRejects(
        () => client.waitReady({ timeoutMs: 400, intervalMs: 50 }),
        ReadinessTimeoutError,
      );
      const elapsed = performance.now() - started;
      assert(elapsed < 5_000, `overshot the budget: ${elapsed}ms`);
    } finally {
      listener.close();
      for (const conn of conns) {
        try {
          conn.close();
        } catch {
          // closed by the aborted fetch
        }
      }
      await serving.catch(() => {});
    }
  });
});

Deno.test("waitForPidfile fails fast when the jailer dies by signal", async () => {
  await withDir(async (dir) => {
    const script = join(dir, "self-kill.sh");
    await Deno.writeTextFile(
      script,
      `#!/bin/sh\necho "dying" >&2\nkill -TERM $$\n`,
    );
    await Deno.chmod(script, 0o755);
    const jailer = VmmProcess.spawn({ command: script, args: [] });
    const started = performance.now();
    await assertRejects(
      () =>
        waitForPidfile(join(dir, "never.pid"), {
          jailer,
          timeoutMs: 5_000,
        }),
      JailerConfigError,
      "signal",
    );
    assert(
      performance.now() - started < 2_500,
      "must fail fast, not wait out the timeout",
    );
  });
});
