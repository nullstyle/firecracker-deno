import { assert, assertEquals, assertRejects } from "@std/assert";
import { parse } from "@std/yaml";
import { join } from "@std/path";
import { FirecrackerClient, UnixHttpTransport } from "../../src/api/mod.ts";
import { ApiError, ReadinessTimeoutError } from "../../src/errors.ts";
import { FakeFirecracker } from "../../testing/mod.ts";

const HTTP_METHODS = ["get", "put", "patch", "post", "delete"];

function specOperations(): string[] {
  const doc = parse(
    Deno.readTextFileSync(
      `spec/firecracker-${
        (JSON.parse(Deno.readTextFileSync("spec/versions.json")) as {
          pinned: string;
        }).pinned
      }.yaml`,
    ),
  ) as { paths: Record<string, Record<string, unknown>> };
  const ops: string[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.includes(method)) {
        ops.push(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  return ops.sort();
}

/** Map a concrete request path back to its spec template. */
function templateOf(path: string): string {
  return path
    .replace(/^\/drives\/[^/]+$/, "/drives/{drive_id}")
    .replace(/^\/network-interfaces\/[^/]+$/, "/network-interfaces/{iface_id}")
    .replace(/^\/pmem\/[^/]+$/, "/pmem/{id}");
}

Deno.test("every spec operation round-trips over a real Unix socket", async () => {
  await using fake = await FakeFirecracker.start();
  using client = new FirecrackerClient({ socketPath: fake.socketPath });
  await client.waitReady();

  // --- pre-boot configuration ---
  await client.putMachineConfig({ vcpu_count: 2, mem_size_mib: 256 });
  await client.patchMachineConfig({ vcpu_count: 2, mem_size_mib: 512 });
  assertEquals((await client.getMachineConfig()).mem_size_mib, 512);
  await client.putBootSource({ kernel_image_path: "/vmlinux" });
  await client.putCpuConfig({});
  await client.putDrive({
    drive_id: "rootfs",
    is_root_device: true,
    is_read_only: false,
    path_on_host: "/rootfs.ext4",
  });
  await client.putNetworkInterface({ iface_id: "eth0", host_dev_name: "tap0" });
  await client.putPmem({ id: "pm0", path_on_host: "/pmem.img" });
  await client.putVsock({ guest_cid: 3, uds_path: fake.vsockUdsPath });
  await client.putEntropyDevice({});
  await client.putSerialDevice({ serial_out_path: join(fake.dir, "serial") });
  await client.putBalloon({
    amount_mib: 32,
    deflate_on_oom: false,
    stats_polling_interval_s: 1,
  });
  await client.putMemoryHotplug({ block_size_mib: 128, slot_size_mib: 128 });
  await client.putMmdsConfig({
    ipv4_address: "169.254.169.254",
    network_interfaces: ["eth0"],
    imds_compat: false,
  });
  await client.putMmds({ hostname: "vm-1", drop_me: "yes" });
  await client.patchMmds({ role: "worker", drop_me: null });
  assertEquals(await client.getMmds(), { hostname: "vm-1", role: "worker" });
  await client.putLogger({
    level: "Info",
    show_level: false,
    show_log_origin: false,
  });
  await client.putMetrics({ metrics_path: join(fake.dir, "metrics.json") });

  // --- boot ---
  await client.instanceStart();
  assertEquals((await client.getInstanceInfo()).state, "Running");

  // --- post-boot operations ---
  await client.patchDrive({ drive_id: "rootfs", path_on_host: "/other.ext4" });
  await client.patchNetworkInterface({ iface_id: "eth0" });
  await client.patchPmem({ id: "pm0" });
  await client.patchBalloon({ amount_mib: 64 });
  await client.patchBalloonStatsInterval({ stats_polling_interval_s: 2 });
  await client.startBalloonHinting({});
  assertEquals((await client.getBalloonHintingStatus()).host_cmd, 1);
  await client.stopBalloonHinting();
  assertEquals((await client.getBalloonStats()).actual_mib, 64);
  assertEquals((await client.getBalloon()).amount_mib, 64);
  await client.patchMemoryHotplug({ requested_size_mib: 512 });
  assertEquals((await client.getMemoryHotplug()).requested_size_mib, 512);
  await client.flushMetrics();
  assertEquals((await client.getVersion()).firecracker_version, "1.16.1");

  const full = await client.getVmConfig();
  assertEquals(full["machine-config"]?.mem_size_mib, 512);
  assertEquals(full.drives?.length, 1);
  assertEquals(full.vsock?.guest_cid, 3);

  // --- snapshot create (paused) + load (fresh fake) ---
  await client.pauseVm();
  await client.createSnapshot({
    snapshot_path: "snap.state",
    mem_file_path: "snap.mem",
  });
  assert((await Deno.stat(join(fake.dir, "snap.state"))).isFile);
  assert((await Deno.stat(join(fake.dir, "snap.mem"))).isFile);
  await client.resumeVm();
  await client.sendCtrlAltDel();

  await using restored = await FakeFirecracker.start();
  using client2 = new FirecrackerClient({ socketPath: restored.socketPath });
  await client2.loadSnapshot({
    snapshot_path: join(fake.dir, "snap.state"),
    mem_backend: {
      backend_type: "File",
      backend_path: join(fake.dir, "snap.mem"),
    },
    resume_vm: true,
  });
  assertEquals(restored.state, "Running");

  // --- coverage: every pinned-spec operation was actually exercised ---
  const exercised = new Set(
    [...fake.requests, ...restored.requests].map(
      (r) => `${r.method} ${templateOf(r.path)}`,
    ),
  );
  assertEquals(
    [...exercised].sort(),
    specOperations(),
    "exercised client operations and pinned spec disagree",
  );
});

Deno.test("boot-phase gating matches Firecracker semantics", async () => {
  await using fake = await FakeFirecracker.start();
  using client = new FirecrackerClient({ socketPath: fake.socketPath });

  // post-boot-only op before boot
  const before = await assertRejects(
    () => client.patchDrive({ drive_id: "x" }),
    ApiError,
    "not allowed before starting",
  );
  assertEquals(before.status, 400);

  await client.putBootSource({ kernel_image_path: "/vmlinux" });
  await client.instanceStart();

  // pre-boot-only op after boot
  const after = await assertRejects(
    () => client.putMachineConfig({ vcpu_count: 1, mem_size_mib: 128 }),
    ApiError,
    "not supported after starting",
  );
  assertEquals(after.status, 400);

  // double start
  await assertRejects(() => client.instanceStart(), ApiError);
});

Deno.test("starting without a boot source fails like the real thing", async () => {
  await using fake = await FakeFirecracker.start();
  using client = new FirecrackerClient({ socketPath: fake.socketPath });
  await assertRejects(
    () => client.instanceStart(),
    ApiError,
    "kernel",
  );
});

Deno.test("failNext injects one failure, then recovers", async () => {
  await using fake = await FakeFirecracker.start();
  using client = new FirecrackerClient({ socketPath: fake.socketPath });
  fake.failNext(
    { method: "PUT", path: "/machine-config" },
    { status: 503, faultMessage: "injected boom" },
  );
  const err = await assertRejects(
    () => client.putMachineConfig({ vcpu_count: 1, mem_size_mib: 128 }),
    ApiError,
    "injected boom",
  );
  assertEquals(err.status, 503);
  assertEquals(err.faultMessage, "injected boom");
  await client.putMachineConfig({ vcpu_count: 1, mem_size_mib: 128 });
});

Deno.test("device id in path must match the body (transport-level request)", async () => {
  await using fake = await FakeFirecracker.start();
  const transport = new UnixHttpTransport(fake.socketPath);
  try {
    const res = await transport.request("PUT", "/drives/a", {
      drive_id: "b",
      path_on_host: "/x",
      is_root_device: false,
      is_read_only: false,
    });
    assertEquals(res.status, 400);
    const body = await res.json() as { fault_message: string };
    assert(body.fault_message.includes("does not match"));
  } finally {
    transport.close();
  }
});

Deno.test("waitReady times out with ReadinessTimeoutError when nothing listens", async () => {
  const dir = await Deno.makeTempDir();
  try {
    using client = new FirecrackerClient({
      socketPath: join(dir, "absent.sock"),
    });
    const err = await assertRejects(
      () => client.waitReady({ timeoutMs: 200, intervalMs: 20 }),
      ReadinessTimeoutError,
    );
    assertEquals(err.waitedMs, 200);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("waitReady aborts during its retry delay", async () => {
  const dir = await Deno.makeTempDir();
  try {
    using client = new FirecrackerClient({
      socketPath: join(dir, "absent.sock"),
    });
    const aborter = new AbortController();
    const started = performance.now();
    const waiting = client.waitReady({
      timeoutMs: 5_000,
      intervalMs: 2_000,
      signal: aborter.signal,
    });
    setTimeout(() => aborter.abort(new Error("cancelled")), 20);
    await assertRejects(() => waiting, Error, "cancelled");
    assert(
      performance.now() - started < 1_000,
      "abort should interrupt the retry delay",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("requests are recorded in order with parsed bodies", async () => {
  await using fake = await FakeFirecracker.start();
  using client = new FirecrackerClient({ socketPath: fake.socketPath });
  await client.putBootSource({ kernel_image_path: "/vmlinux" });
  await client.getInstanceInfo();
  assertEquals(fake.requests[0], {
    method: "PUT",
    path: "/boot-source",
    body: { kernel_image_path: "/vmlinux" },
  });
  assertEquals(fake.requests[1], { method: "GET", path: "/" });
});
