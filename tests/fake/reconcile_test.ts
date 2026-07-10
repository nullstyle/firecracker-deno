import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { DirRegistry, Machine, reconcile } from "../../mod.ts";
import { pidAlive } from "../../src/internal/liveness.ts";
import type { JailRecord } from "../../mod.ts";
import { makeFakeVmmBin } from "./fake_vmm_helper.ts";

const HERE = dirname(fromFileUrl(import.meta.url));

function record(vmId: string, patch: Partial<JailRecord>): JailRecord {
  return {
    version: 1,
    vmId,
    pid: null,
    apiSocketPath: "",
    stateDir: "",
    ownsStateDir: false,
    vsockListenerPaths: [],
    createdAt: "2026-07-10T00:00:00.000Z",
    ...patch,
  };
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "reconcile-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("reconcile reclaims a dead machine's files and record", async () => {
  await withDir(async (dir) => {
    const registry = new DirRegistry(join(dir, "registry"));
    const stateDir = join(dir, "vm-state");
    await Deno.mkdir(stateDir, { recursive: true });
    const apiSocketPath = join(stateDir, "fc.sock");
    const vsockUdsPath = join(dir, "v.sock");
    const listenerPath = `${vsockUdsPath}_7000`;
    for (const f of [apiSocketPath, vsockUdsPath, listenerPath]) {
      await Deno.writeTextFile(f, "stale");
    }
    await registry.put(record("stale-vm", {
      pid: null, // crashed before the pid was journaled
      apiSocketPath,
      stateDir,
      ownsStateDir: true,
      vsockUdsPath,
      vsockListenerPaths: [listenerPath],
    }));

    const result = await reconcile(registry);
    assertEquals(result.reclaimed, ["stale-vm"]);
    assertEquals(result.stillRunning, []);
    assertEquals(result.failures, []);
    for (const f of [apiSocketPath, vsockUdsPath, listenerPath, stateDir]) {
      assertEquals(await Deno.stat(f).catch(() => null), null, `${f} leaked`);
    }
    assertEquals(await registry.list(), []);
  });
});

Deno.test("reconcile leaves live machines alone unless killLive", async () => {
  await withDir(async (dir) => {
    const registry = new DirRegistry(join(dir, "registry"));
    const apiSocketPath = join(dir, "live.sock");
    const bin = await makeFakeVmmBin(dir, "never-bind");
    // Spawn directly with the api-sock in argv so the Linux pid-identity
    // guard (cmdline contains the socket path) recognizes it as ours.
    const child = new Deno.Command(bin, {
      args: ["--api-sock", apiSocketPath],
      stdout: "null",
      stderr: "null",
    }).spawn();
    try {
      await registry.put(record("live-vm", {
        pid: child.pid,
        apiSocketPath,
        stateDir: dir,
        ownsStateDir: false,
      }));

      const dry = await reconcile(registry);
      assertEquals(dry.stillRunning, ["live-vm"]);
      assertEquals(dry.reclaimed, []);
      assert(pidAlive(child.pid), "dry run must not kill");
      assertEquals((await registry.list()).length, 1);

      const wet = await reconcile(registry, { killLive: true });
      assertEquals(wet.reclaimed, ["live-vm"]);
      assertEquals(wet.failures, []);
      await child.status; // reap our own child so pidAlive reflects reality
      assert(!pidAlive(child.pid), "killLive must kill");
      assertEquals(await registry.list(), []);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
      await child.status.catch(() => {});
    }
  });
});

Deno.test("machine with a registry journals on create and clears on dispose", async () => {
  await withDir(async (dir) => {
    const registry = new DirRegistry(join(dir, "registry"));
    const bin = await makeFakeVmmBin(dir, "ready");
    {
      await using vm = await Machine.launch({
        firecrackerBin: bin,
        id: "journaled-vm",
        config: { boot_source: { kernel_image_path: "/vmlinux" } },
        stateDir: join(dir, "state"),
        registry,
      });
      const records = await registry.list();
      assertEquals(records.length, 1);
      assertEquals(records[0].vmId, "journaled-vm");
      assertEquals(records[0].pid, vm.pid);
      assertEquals(records[0].apiSocketPath, vm.paths.apiSocket);
    }
    assertEquals(await registry.list(), [], "record must clear after dispose");
  });
});

Deno.test("reconcile reaps machines orphaned by a SIGKILLed supervisor", async () => {
  await withDir(async (dir) => {
    const supervisor = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", join(HERE, "crash_supervisor.ts"), dir],
      stdout: "piped",
      stderr: "inherit",
    }).spawn();

    // Wait for the supervisor to announce its (about to be orphaned) VMM.
    let vmmPid = 0;
    const reader = supervisor.stdout.getReader();
    let buffer = "";
    while (vmmPid === 0) {
      const { value, done } = await reader.read();
      if (done) throw new Error("supervisor exited before LAUNCHED");
      buffer += new TextDecoder().decode(value);
      const match = /LAUNCHED (\d+)/.exec(buffer);
      if (match !== null) vmmPid = Number(match[1]);
    }

    // Crash the supervisor the way no dispose can handle.
    supervisor.kill("SIGKILL");
    await supervisor.status;
    await reader.cancel();
    assert(pidAlive(vmmPid), "the VMM must have been orphaned, not killed");

    const registry = new DirRegistry(join(dir, "registry"));

    // Safe default: report, don't murder.
    const dry = await reconcile(registry);
    assertEquals(dry.stillRunning, ["crash-victim"]);
    assert(pidAlive(vmmPid));

    // Fleet mode: kill and fully reclaim.
    const wet = await reconcile(registry, { killLive: true });
    assertEquals(wet.reclaimed, ["crash-victim"]);
    assertEquals(wet.failures, []);
    assert(!pidAlive(vmmPid), "orphan must be dead after killLive sweep");
    assertEquals(await registry.list(), []);
    assertEquals(
      await Deno.stat(join(dir, "state", "fc.sock")).catch(() => null),
      null,
      "api socket must be reclaimed",
    );
    assertEquals(
      await Deno.stat(join(dir, "v.sock")).catch(() => null),
      null,
      "vsock uds must be reclaimed",
    );
  });
});
