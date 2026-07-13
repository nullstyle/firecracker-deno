import { assert, assertEquals, assertThrows } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { DirRegistry, JailerConfigError, Machine } from "../../mod.ts";
import { pidAlive } from "../../src/internal/liveness.ts";
import { makeFakeJailerBin } from "./fake_jailer_helper.ts";
import { makeFakeVmmBin } from "./fake_vmm_helper.ts";

const HERE = dirname(fromFileUrl(import.meta.url));
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  // Short base dir: the chroot layout nests deep, and Unix socket paths
  // (host view of <root>/fc.sock) are limited to ~104 bytes on macOS.
  const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "fcja-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

async function orphanVmm(dir: string, flags: string[]): Promise<number> {
  const supervisor = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", join(HERE, "crash_supervisor.ts"), dir, ...flags],
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  let vmmPid = 0;
  const reader = supervisor.stdout.getReader();
  let buffer = "";
  while (vmmPid === 0) {
    const { value, done } = await reader.read();
    if (done) throw new Error("supervisor exited before LAUNCHED");
    buffer += decoder.decode(value);
    const match = /LAUNCHED (\d+)/.exec(buffer);
    if (match !== null) vmmPid = Number(match[1]);
  }
  supervisor.kill("SIGKILL");
  await supervisor.status;
  await reader.cancel();
  assert(pidAlive(vmmPid), "the VMM must have been orphaned, not killed");
  return vmmPid;
}

async function readN(conn: Deno.Conn, n: number): Promise<string> {
  const buf = new Uint8Array(n);
  let got = 0;
  while (got < n) {
    const read = await conn.read(buf.subarray(got));
    if (read === null) break;
    got += read;
  }
  return decoder.decode(buf.subarray(0, got));
}

Deno.test("adopts a daemonized jailed orphan via its pidfile; dispose removes the jail", async () => {
  await withDir(async (dir) => {
    const vmmPid = await orphanVmm(dir, [
      "--jailed",
      "--daemonize",
      "--echo-port",
      "5000",
    ]);
    const jailRoot = join(
      dir,
      "jails",
      "firecracker-fake-ready",
      "crash-victim",
    );
    try {
      const registry = new DirRegistry(join(dir, "registry"));
      const [rec] = await registry.list();
      assertEquals(rec.chrootDir, jailRoot);
      assertEquals(
        rec.pidfilePath,
        join(jailRoot, "root", "firecracker-fake-ready.pid"),
      );

      const vm = await Machine.adopt({ record: rec, registry });
      try {
        // Pid recovered through the pidfile, jail paths through the record.
        const pidfile = await Deno.readTextFile(rec.pidfilePath!);
        assertEquals(vm.pid, Number(pidfile.trim()));
        assertEquals(vm.pid, vmmPid);
        assertEquals(vm.paths.chrootRoot, join(jailRoot, "root"));
        assertEquals(vm.paths.apiSocket, join(jailRoot, "root", "fc.sock"));
        assertEquals(vm.state, "running");
        assertEquals((await vm.client.getInstanceInfo()).state, "Running");

        // vsock through the chroot still works on the adopted handle.
        assertEquals(vm.paths.vsockUds, join(jailRoot, "root", "v.sock"));
        using conn = await vm.vsock.connect(5000, { retryTimeoutMs: 5_000 });
        await conn.write(encoder.encode("jail-adopt"));
        assertEquals(await readN(conn, 10), "jail-adopt");

        // Chroot-prefix math survives adoption; the staged-file map does
        // not — host paths outside the chroot are no longer mappable.
        assertEquals(vm.jailPath(join(jailRoot, "root", "v.sock")), "/v.sock");
        assertThrows(
          () => vm.jailPath(join(dir, "unstaged-host-file")),
          JailerConfigError,
        );

        const exit = await vm.shutdown();
        assertEquals(exit.observedVia, "pidfile-poll");
        assertEquals(exit.code, null);
      } finally {
        await vm[Symbol.asyncDispose]();
      }
      assertEquals(
        await Deno.stat(jailRoot).catch(() => null),
        null,
        "dispose must remove the whole jail root",
      );
      assertEquals(await registry.list(), []);
      assert(!pidAlive(vmmPid));
    } finally {
      try {
        Deno.kill(vmmPid, "SIGKILL");
      } catch {
        // already dead
      }
    }
  });
});

Deno.test("jailed launch with cgroups journals cgroupPath; dispose tolerates its absence", async () => {
  await withDir(async (dir) => {
    const vmmBin = await makeFakeVmmBin(dir, "ready");
    const jailerBin = await makeFakeJailerBin(dir);
    const registry = new DirRegistry(join(dir, "registry"));
    {
      await using vm = await Machine.launch({
        jailer: {
          jailerBin,
          firecrackerBin: vmmBin,
          id: "cgroup-vm",
          uid: Deno.uid() ?? 0,
          gid: Deno.gid() ?? 0,
          chrootBaseDir: join(dir, "jails"),
          cgroups: { "cpu.weight": "100" },
        },
        config: { boot_source: { kernel_image_path: "/vmlinux" } },
        registry,
      });
      const [rec] = await registry.list();
      assertEquals(
        rec.cgroupPath,
        "/sys/fs/cgroup/firecracker-fake-ready/cgroup-vm",
      );
      assertEquals(rec.pid, vm.pid);
    }
    // The fake jailer created no real cgroup; dispose's remove-cgroup step
    // must treat NotFound as already-clean rather than failing cleanup.
    assertEquals(await registry.list(), []);
  });
});
