import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  InvalidStateError,
  Machine,
  ProcessExitedError,
  ReadinessTimeoutError,
  type VmConfig,
} from "../../mod.ts";
import { makeFakeVmmBin } from "./fake_vmm_helper.ts";

const CONFIG: VmConfig = {
  machine_config: { vcpu_count: 1, mem_size_mib: 128 },
  boot_source: { kernel_image_path: "/vmlinux" },
};

/** Per-test sandbox dir with fake-vmm shims. */
async function withDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "machine-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("launch boots to running and shuts down cleanly", async () => {
  await withDir(async (dir) => {
    const bin = await makeFakeVmmBin(dir, "ready");
    await using vm = await Machine.launch({
      firecrackerBin: bin,
      config: CONFIG,
      stateDir: join(dir, "state"),
    });
    assertEquals(vm.state, "running");
    assert(vm.pid > 0);
    assertEquals((await vm.client.getInstanceInfo()).state, "Running");

    const exit = await vm.shutdown();
    assertEquals(vm.state, "exited");
    assertEquals(exit.observedVia, "child-status");
    // x86_64 CI exits 0 via CtrlAltDel; aarch64 skips stage 1 → SIGTERM.
    assert(
      exit.code === 0 || exit.signal === "SIGTERM",
      `unexpected exit: ${JSON.stringify(exit)}`,
    );
  });
});

Deno.test("create configures but does not boot; start() is state-gated", async () => {
  await withDir(async (dir) => {
    const bin = await makeFakeVmmBin(dir, "ready");
    await using vm = await Machine.create({
      firecrackerBin: bin,
      config: CONFIG,
      stateDir: join(dir, "state"),
    });
    assertEquals(vm.state, "configured");
    assertEquals((await vm.client.getInstanceInfo()).state, "Not started");
    // config was applied
    const applied = await vm.client.getVmConfig();
    assertEquals(applied["boot-source"]?.kernel_image_path, "/vmlinux");

    await vm.start();
    assertEquals(vm.state, "running");
    const err = await assertRejects(() => vm.start(), InvalidStateError);
    assertEquals(err.state, "running");
  });
});

Deno.test("readiness races death: a VMM that dies pre-bind fails fast with its stderr", async () => {
  await withDir(async (dir) => {
    const bin = await makeFakeVmmBin(dir, "exit-before-bind");
    const stateDir = join(dir, "state");
    const err = await assertRejects(
      () =>
        Machine.create({
          firecrackerBin: bin,
          config: CONFIG,
          stateDir,
          readinessTimeoutMs: 10_000,
        }),
      ProcessExitedError,
    );
    assertEquals(err.exit.code, 7);
    assert(
      err.exit.stderrTail.includes("could not open /dev/kvm"),
      `stderr tail missing: ${err.exit.stderrTail}`,
    );
    // nothing left behind
    assertEquals(
      await Deno.stat(join(stateDir, "fc.sock")).catch(() => null),
      null,
    );
  });
});

Deno.test("readiness timeout kills the stalled VMM and reports its stderr", async () => {
  await withDir(async (dir) => {
    const bin = await makeFakeVmmBin(dir, "never-bind");
    const err = await assertRejects(
      () =>
        Machine.create({
          firecrackerBin: bin,
          config: CONFIG,
          stateDir: join(dir, "state"),
          readinessTimeoutMs: 1_500,
        }),
      ReadinessTimeoutError,
    );
    assertEquals(err.waitedMs, 1_500);
    assert(
      err.stderrTail.includes("stalling before bind"),
      `stderr tail missing: ${err.stderrTail}`,
    );
  });
});

Deno.test("shutdown escalates to SIGKILL when SIGTERM is ignored", async () => {
  await withDir(async (dir) => {
    const bin = await makeFakeVmmBin(dir, "ignore-sigterm");
    await using vm = await Machine.launch({
      firecrackerBin: bin,
      config: CONFIG,
      stateDir: join(dir, "state"),
    });
    const started = performance.now();
    const exit = await vm.shutdown({
      ctrlAltDelTimeoutMs: 0,
      sigtermTimeoutMs: 200,
    });
    const elapsed = performance.now() - started;
    assertEquals(exit.signal, "SIGKILL");
    assert(elapsed >= 200, `escalated too early: ${elapsed}ms`);
  });
});

Deno.test("shutdown is idempotent: concurrent calls share one outcome", async () => {
  await withDir(async (dir) => {
    const bin = await makeFakeVmmBin(dir, "ready");
    await using vm = await Machine.launch({
      firecrackerBin: bin,
      config: CONFIG,
      stateDir: join(dir, "state"),
    });
    const [a, b] = await Promise.all([vm.shutdown(), vm.shutdown()]);
    assertEquals(a, b);
    assertEquals(await vm.shutdown(), a);
  });
});

Deno.test("kill() reaps immediately and dispose stays clean", async () => {
  await withDir(async (dir) => {
    const bin = await makeFakeVmmBin(dir, "ready");
    await using vm = await Machine.launch({
      firecrackerBin: bin,
      config: CONFIG,
      stateDir: join(dir, "state"),
    });
    const exit = await vm.kill();
    assertEquals(exit.signal, "SIGKILL");
    assertEquals(vm.state, "exited");
  });
});

Deno.test("pause and resume are state-gated round trips", async () => {
  await withDir(async (dir) => {
    const bin = await makeFakeVmmBin(dir, "ready");
    await using vm = await Machine.launch({
      firecrackerBin: bin,
      config: CONFIG,
      stateDir: join(dir, "state"),
    });
    await assertRejects(() => vm.resume(), InvalidStateError);
    await vm.pause();
    assertEquals(vm.state, "paused");
    assertEquals((await vm.client.getInstanceInfo()).state, "Paused");
    await vm.resume();
    assertEquals(vm.state, "running");
  });
});

Deno.test("dispose removes the api socket and unblocks waiters", async () => {
  await withDir(async (dir) => {
    const bin = await makeFakeVmmBin(dir, "ready");
    const stateDir = join(dir, "state");
    let socketPath: string;
    let exitedSeen = false;
    {
      await using vm = await Machine.launch({
        firecrackerBin: bin,
        config: CONFIG,
        stateDir,
      });
      socketPath = vm.paths.apiSocket;
      void vm.waitFor("exited").then(() => {
        exitedSeen = true;
      });
      assert((await Deno.stat(socketPath)).isSocket);
    }
    assertEquals(await Deno.stat(socketPath!).catch(() => null), null);
    assert(exitedSeen, "waitFor(exited) should have resolved during dispose");
  });
});

Deno.test("machine notices a VMM that dies on its own", async () => {
  await withDir(async (dir) => {
    const bin = await makeFakeVmmBin(dir, "ready");
    await using vm = await Machine.launch({
      firecrackerBin: bin,
      config: CONFIG,
      stateDir: join(dir, "state"),
    });
    // Simulate a crash from outside the library.
    Deno.kill(vm.pid, "SIGKILL");
    const exit = await vm.exited;
    assertEquals(exit.signal, "SIGKILL");
    await vm.waitFor("exited", { timeoutMs: 1_000 });
    await assertRejects(() => vm.pause(), InvalidStateError);
  });
});
