import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  DirRegistry,
  JailerConfigError,
  Machine,
  type MachineOptions,
} from "../../mod.ts";
import { makeFakeJailerBin } from "./fake_jailer_helper.ts";
import { makeFakeVmmBin } from "./fake_vmm_helper.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  // Short base dir: the chroot layout nests deep, and Unix socket paths
  // (host view of <root>/fc.sock) are limited to ~104 bytes on macOS.
  const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "fcj-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

async function jailedOptions(
  dir: string,
  overrides: {
    daemonize?: boolean;
    newPidNs?: boolean;
    vmmEnv?: Record<string, string>;
    vsock?: boolean;
  } = {},
): Promise<{ options: MachineOptions; registry: DirRegistry }> {
  const vmmBin = await makeFakeVmmBin(dir, "ready", overrides.vmmEnv ?? {});
  const jailerBin = await makeFakeJailerBin(dir);
  const registry = new DirRegistry(join(dir, "registry"));
  const kernelHost = join(dir, "vmlinux-test");
  await Deno.writeTextFile(kernelHost, "not really a kernel");
  const options: MachineOptions = {
    jailer: {
      jailerBin,
      firecrackerBin: vmmBin,
      id: "jailed-vm",
      uid: Deno.uid() ?? 0,
      gid: Deno.gid() ?? 0,
      chrootBaseDir: join(dir, "jails"),
      daemonize: overrides.daemonize,
      newPidNs: overrides.newPidNs,
      stage: [{ hostPath: kernelHost }],
    },
    config: {
      boot_source: { kernel_image_path: "/vmlinux-test" },
      ...(overrides.vsock === true
        ? { vsock: { guest_cid: 3, uds_path: "/v.sock" } }
        : {}),
    },
    registry,
  };
  return { options, registry };
}

Deno.test("plain jailed machine: chroot layout, staging, pidfile, clean reclaim", async () => {
  await withDir(async (dir) => {
    const { options, registry } = await jailedOptions(dir);
    const jailRoot = join(dir, "jails", "firecracker-fake-ready", "jailed-vm");
    {
      await using vm = await Machine.launch(options);
      assertEquals(vm.vmId, "jailed-vm");
      assertEquals(vm.paths.chrootRoot, join(jailRoot, "root"));
      assertEquals(vm.paths.apiSocket, join(jailRoot, "root", "fc.sock"));

      // staged file landed in the chroot and maps back through jailPath()
      const stagedKernel = join(jailRoot, "root", "vmlinux-test");
      assert((await Deno.stat(stagedKernel)).isFile);
      assertEquals(vm.jailPath(join(dir, "vmlinux-test")), "/vmlinux-test");
      assertEquals(vm.jailPath(stagedKernel), "/vmlinux-test");

      // pidfile agrees with the supervised pid (plain mode: exec in place)
      const pidfile = await Deno.readTextFile(
        join(jailRoot, "root", "firecracker-fake-ready.pid"),
      );
      assertEquals(Number(pidfile.trim()), vm.pid);

      assertEquals((await vm.client.getInstanceInfo()).state, "Running");
      const record = (await registry.list())[0];
      assertEquals(record.chrootDir, jailRoot);
      assertEquals(record.pid, vm.pid);

      const exit = await vm.shutdown();
      assertEquals(exit.observedVia, "child-status");
    }
    // dispose removed the entire jail root and cleared the registry
    assertEquals(await Deno.stat(jailRoot).catch(() => null), null);
    assertEquals(await registry.list(), []);
  });
});

Deno.test("daemonized jailed machine: pidfile exit authority + vsock through the chroot", async () => {
  await withDir(async (dir) => {
    const { options, registry } = await jailedOptions(dir, {
      daemonize: true,
      vsock: true,
      vmmEnv: { FAKE_VMM_ECHO_PORT: "5000" },
    });
    const jailRoot = join(dir, "jails", "firecracker-fake-ready", "jailed-vm");
    {
      await using vm = await Machine.launch(options);
      // The vmm is not our child: its pid came from the pidfile.
      const pidfile = await Deno.readTextFile(
        join(jailRoot, "root", "firecracker-fake-ready.pid"),
      );
      assertEquals(Number(pidfile.trim()), vm.pid);
      assertEquals((await registry.list())[0].pid, vm.pid);

      // vsock UDS resolved through the chroot on both sides
      assertEquals(vm.paths.vsockUds, join(jailRoot, "root", "v.sock"));
      using conn = await vm.vsock.connect(5000, { retryTimeoutMs: 5_000 });
      await conn.write(encoder.encode("jail-ping"));
      assertEquals(await readN(conn, 9), "jail-ping");

      const exit = await vm.shutdown({ sigtermTimeoutMs: 3_000 });
      assertEquals(exit.observedVia, "pidfile-poll");
      assertEquals(exit.code, null);
    }
    assertEquals(await Deno.stat(jailRoot).catch(() => null), null);
    assertEquals(await registry.list(), []);
  });
});

Deno.test("new-pid-ns emulation also switches to pidfile authority", async () => {
  await withDir(async (dir) => {
    const { options } = await jailedOptions(dir, { newPidNs: true });
    await using vm = await Machine.launch(options);
    assertEquals((await vm.client.getInstanceInfo()).state, "Running");
    const exit = await vm.kill();
    assertEquals(exit.observedVia, "pidfile-poll");
  });
});

Deno.test("jailed machines require a registry at runtime too", async () => {
  await withDir(async (dir) => {
    const { options } = await jailedOptions(dir);
    const stripped = { ...options, registry: undefined };
    await assertRejects(
      // deno-lint-ignore no-explicit-any -- deliberately violating the type
      () => Machine.create(stripped as any),
      JailerConfigError,
      "registry is required",
    );
  });
});

Deno.test("a pre-existing jail root is refused, not adopted", async () => {
  await withDir(async (dir) => {
    const { options } = await jailedOptions(dir);
    const jailRoot = join(dir, "jails", "firecracker-fake-ready", "jailed-vm");
    await Deno.mkdir(jailRoot, { recursive: true });
    await assertRejects(
      () => Machine.create(options),
      JailerConfigError,
      "already exists",
    );
  });
});

Deno.test("jailer that dies before the pidfile surfaces its stderr", async () => {
  await withDir(async (dir) => {
    const { options, registry } = await jailedOptions(dir, {
      daemonize: true,
    });
    // Sabotage: a jailer that fails immediately.
    const badJailer = join(dir, "bad-jailer");
    await Deno.writeTextFile(
      badJailer,
      `#!/bin/sh\necho "jailer: chroot failed" >&2\nexit 9\n`,
    );
    await Deno.chmod(badJailer, 0o755);
    options.jailer!.jailerBin = badJailer;

    const err = await assertRejects(
      () => Machine.create(options),
      JailerConfigError,
    );
    assert(
      err.message.includes("chroot failed"),
      `stderr missing from: ${err.message}`,
    );
    // failed create left no jail root and no registry record
    assertEquals(
      await Deno.stat(join(dir, "jails", "firecracker-fake-ready", "jailed-vm"))
        .catch(() => null),
      null,
    );
    assertEquals(await registry.list(), []);
  });
});
