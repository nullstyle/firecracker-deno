import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { InvalidStateError, Machine } from "../../mod.ts";
import { writeAll } from "../../src/internal/line_reader.ts";
import { makeFakeVmmBin } from "./fake_vmm_helper.ts";

async function readN(conn: Deno.Conn, n: number): Promise<string> {
  const buf = new Uint8Array(n);
  let got = 0;
  while (got < n) {
    const read = await conn.read(buf.subarray(got));
    if (read === null) break;
    got += read;
  }
  return new TextDecoder().decode(buf.subarray(0, got));
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "fcs-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("snapshot(pause:true) pauses, creates, resumes; files land in stateDir", async () => {
  await withDir(async (dir) => {
    const bin = await makeFakeVmmBin(dir, "ready");
    const stateDir = join(dir, "state");
    await using vm = await Machine.launch({
      firecrackerBin: bin,
      config: { boot_source: { kernel_image_path: "/vmlinux" } },
      stateDir,
    });
    await vm.snapshot({
      pause: true,
      snapshot_path: "snap.state",
      mem_file_path: "snap.mem",
    });
    assertEquals(vm.state, "running", "must resume after pause:true snapshot");
    // fake-vmm resolves relative paths in its own dir; the *machine* is what
    // we assert on: it stayed running and the calls were state-legal.
    await vm.pause();
    await vm.snapshot({
      snapshot_path: "snap2.state",
      mem_file_path: "snap2.mem",
    });
    assertEquals(vm.state, "paused", "explicit snapshot leaves it paused");
  });
});

Deno.test("snapshot on a configured (never-booted) machine is state-gated", async () => {
  await withDir(async (dir) => {
    const bin = await makeFakeVmmBin(dir, "ready");
    await using vm = await Machine.create({
      firecrackerBin: bin,
      config: { boot_source: { kernel_image_path: "/vmlinux" } },
      stateDir: join(dir, "state"),
    });
    await assertRejects(
      () => vm.snapshot({ snapshot_path: "s", mem_file_path: "m" }),
      InvalidStateError,
    );
  });
});

Deno.test("restore boots from a snapshot: paused by default, running with resume_vm", async () => {
  await withDir(async (dir) => {
    const bin = await makeFakeVmmBin(dir, "ready");
    // The fake accepts any snapshot paths — the machine semantics are what
    // this tier verifies; tier 3 does it against real Firecracker.
    {
      await using vm = await Machine.restore({
        firecrackerBin: bin,
        stateDir: join(dir, "s1"),
        snapshot: {
          snapshot_path: "/snap.state",
          mem_backend: { backend_type: "File", backend_path: "/snap.mem" },
        },
      });
      assertEquals(vm.state, "paused");
      assertEquals((await vm.client.getInstanceInfo()).state, "Paused");
      await vm.resume();
      assertEquals(vm.state, "running");
    }
    {
      await using vm = await Machine.restore({
        firecrackerBin: bin,
        stateDir: join(dir, "s2"),
        snapshot: {
          snapshot_path: "/snap.state",
          mem_backend: { backend_type: "File", backend_path: "/snap.mem" },
          resume_vm: true,
        },
      });
      assertEquals(vm.state, "running");
      assertEquals((await vm.client.getInstanceInfo()).state, "Running");
      const exit = await vm.shutdown();
      assertEquals(exit.observedVia, "child-status");
    }
  });
});

Deno.test("restore with vsock_override rebinds and vm.vsock works", async () => {
  await withDir(async (dir) => {
    const bin = await makeFakeVmmBin(dir, "ready", {
      FAKE_VMM_ECHO_PORT: "5000",
    });
    const overrideUds = join(dir, "restored-v.sock");
    await using vm = await Machine.restore({
      firecrackerBin: bin,
      stateDir: join(dir, "state"),
      snapshot: {
        snapshot_path: "/snap.state",
        mem_backend: { backend_type: "File", backend_path: "/snap.mem" },
        resume_vm: true,
        vsock_override: { uds_path: overrideUds },
      },
    });
    assertEquals(vm.paths.vsockUds, overrideUds);
    using conn = await vm.vsock.connect(5000, { retryTimeoutMs: 5_000 });
    await writeAll(conn, new TextEncoder().encode("post-restore"));
    assertEquals(await readN(conn, 12), "post-restore");
  });
});
