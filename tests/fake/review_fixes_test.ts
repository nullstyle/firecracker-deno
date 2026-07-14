/**
 * Regression tests for the defects found in the pre-release adversarial
 * review: failed-create leaks, registry update races, unbounded waitReady
 * attempts, and jailer failure classification.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join, relative } from "@std/path";
import { makeFakeVmmBin } from "./fake_vmm_helper.ts";
import {
  DirRegistry,
  JailerConfigError,
  Machine,
  ProcessExitedError,
  ReadinessTimeoutError,
} from "../../mod.ts";
import type { JailRecord, VmRegistry } from "../../mod.ts";
import { FirecrackerClient } from "../../src/api/mod.ts";
import { waitForPidfile } from "../../src/process/pidfile.ts";
import { VmmProcess } from "../../src/process/supervisor.ts";

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "fcr-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("relative firecrackerBin resolves against our cwd, not the state dir", async () => {
  await withDir(async (dir) => {
    // Regression for the first real CI run: FC_TEST_BIN=tests/assets/…
    // (relative) was resolved inside the machine's stateDir because
    // Deno.Command applies its cwd option to relative binary paths.
    const absBin = await makeFakeVmmBin(dir, "ready");
    const relBin = relative(Deno.cwd(), absBin);
    assert(!relBin.startsWith("/"), `expected a relative path: ${relBin}`);
    await using vm = await Machine.launch({
      firecrackerBin: relBin,
      config: { boot_source: { kernel_image_path: "/vmlinux" } },
      stateDir: join(dir, "state"),
    });
    assertEquals(vm.state, "running");
    await vm.shutdown();
  });
});

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

Deno.test("pre-existing paths in a caller-owned state dir are refused", async () => {
  await withDir(async (dir) => {
    const registry = new DirRegistry(join(dir, "registry"));
    const stateDir = join(dir, "state");
    const socketPath = join(stateDir, "reserved.sock");
    const bin = await makeFakeVmmBin(dir, "ready");
    await Deno.mkdir(stateDir);
    await Deno.writeTextFile(socketPath, "caller-owned");
    await assertRejects(
      () =>
        Machine.create({
          firecrackerBin: bin,
          config: { boot_source: { kernel_image_path: "/vmlinux" } },
          stateDir,
          socketPath,
          registry,
        }),
      JailerConfigError,
      "refusing to claim",
    );
    assertEquals(await Deno.readTextFile(socketPath), "caller-owned");
    assertEquals(await registry.list(), []);
  });
});

Deno.test("pre-existing vsock paths in a caller-owned state dir are refused", async () => {
  await withDir(async (dir) => {
    const registry = new DirRegistry(join(dir, "registry"));
    const stateDir = join(dir, "state");
    const vsockPath = join(stateDir, "reserved-vsock.sock");
    const bin = await makeFakeVmmBin(dir, "ready");
    await Deno.mkdir(stateDir);
    await Deno.writeTextFile(vsockPath, "caller-owned");
    await assertRejects(
      () =>
        Machine.create({
          firecrackerBin: bin,
          config: {
            boot_source: { kernel_image_path: "/vmlinux" },
            vsock: { guest_cid: 3, uds_path: vsockPath },
          },
          stateDir,
          registry,
        }),
      JailerConfigError,
      "vsock UDS path",
    );
    assertEquals(await Deno.readTextFile(vsockPath), "caller-owned");
    assertEquals(await registry.list(), []);
  });
});

Deno.test("failed spawn retains its journal when resource cleanup fails", async () => {
  await withDir(async (dir) => {
    const records = new DirRegistry(join(dir, "registry"));
    let ownedStateDir: string | undefined;
    const registry: VmRegistry = {
      async put(record) {
        ownedStateDir = record.stateDir;
        await records.put(record);
        await Deno.writeTextFile(join(record.stateDir, "keep"), "blocked");
        await Deno.chmod(record.stateDir, 0o500);
      },
      update: (vmId, patch) => records.update(vmId, patch),
      remove: (vmId) => records.remove(vmId),
      list: () => records.list(),
    };
    try {
      await assertRejects(
        () =>
          Machine.create({
            firecrackerBin: join(dir, "no-such-firecracker"),
            config: { boot_source: { kernel_image_path: "/vmlinux" } },
            id: "cleanup-failed",
            registry,
          }),
        Deno.errors.NotFound,
      );
      assertEquals(
        (await records.list()).map((record) => record.vmId),
        ["cleanup-failed"],
        "the record is cleanup authority and must be removed last",
      );
    } finally {
      if (ownedStateDir !== undefined) {
        await Deno.chmod(ownedStateDir, 0o700).catch(() => {});
        await Deno.remove(ownedStateDir, { recursive: true }).catch(() => {});
      }
    }
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

Deno.test("a vsock dial in flight rejects promptly when the VMM dies", async () => {
  await withDir(async (dir) => {
    const bin = await makeFakeVmmBin(dir, "ready");
    const vsockUds = join(dir, "v.sock");
    await using vm = await Machine.launch({
      firecrackerBin: bin,
      config: {
        boot_source: { kernel_image_path: "/vmlinux" },
        vsock: { guest_cid: 3, uds_path: vsockUds },
      },
      stateDir: join(dir, "state"),
    });
    // Nothing listens on this port, so the dial retries — with a budget
    // far longer than the test. Killing the VMM must cut it short.
    const dialing = vm.vsock.connect(9999, {
      retryTimeoutMs: 60_000,
      retryIntervalMs: 50,
    });
    const started = performance.now();
    setTimeout(() => Deno.kill(vm.pid, "SIGKILL"), 150);
    await assertRejects(() => dialing, ProcessExitedError);
    assert(
      performance.now() - started < 5_000,
      "dial must reject promptly on VMM death, not run out its budget",
    );
  });
});

Deno.test("machine metadata is recorded verbatim on the JailRecord", async () => {
  await withDir(async (dir) => {
    const registry = new DirRegistry(join(dir, "registry"));
    const bin = await makeFakeVmmBin(dir, "ready");
    {
      await using vm = await Machine.launch({
        firecrackerBin: bin,
        id: "labeled-vm",
        config: { boot_source: { kernel_image_path: "/vmlinux" } },
        stateDir: join(dir, "state"),
        registry,
        metadata: { group: "batch-7", lease: "lease-42" },
      });
      const record = (await registry.list())[0];
      assertEquals(record.vmId, vm.vmId);
      assertEquals(record.metadata, { group: "batch-7", lease: "lease-42" });
    }
    assertEquals(await registry.list(), []);
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
