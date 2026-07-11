/**
 * Integration tests against a real Firecracker. Gated: they run only on
 * Linux with /dev/kvm and the FC_TEST_* environment set (see
 * tools/fetch-firecracker.ts and .github/workflows/ci.yml):
 *
 *   FC_TEST_BIN=tests/assets/firecracker \
 *   FC_TEST_KERNEL=tests/assets/vmlinux \
 *   FC_TEST_ROOTFS=tests/assets/rootfs.ext4 \
 *   deno test -A tests/integration/
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { envPath } from "./env.ts";
import { ApiError, Machine, type VmConfig } from "../../mod.ts";

const bin = envPath("FC_TEST_BIN");
const kernel = envPath("FC_TEST_KERNEL");
const rootfs = envPath("FC_TEST_ROOTFS");
const kvm = await Deno.stat("/dev/kvm").then(() => true).catch(() => false);
const enabled = Deno.build.os === "linux" && kvm &&
  bin !== undefined && kernel !== undefined && rootfs !== undefined;

if (!enabled) {
  console.warn(
    "⚠ integration tests SKIPPED: they need Linux, /dev/kvm, and " +
      "FC_TEST_BIN / FC_TEST_KERNEL / FC_TEST_ROOTFS (run tools/fetch-firecracker.ts)",
  );
}

/** Fresh writable rootfs copy per test — guests mutate their disk. */
async function scratchConfig(dir: string): Promise<VmConfig> {
  const rootfsCopy = join(dir, "rootfs.ext4");
  await Deno.copyFile(rootfs!, rootfsCopy);
  return {
    machine_config: { vcpu_count: 1, mem_size_mib: 256 },
    boot_source: {
      kernel_image_path: kernel!,
      boot_args: "console=ttyS0 reboot=k panic=1 pci=off",
    },
    drives: [{
      drive_id: "rootfs",
      path_on_host: rootfsCopy,
      is_root_device: true,
      is_read_only: false,
    }],
  };
}

async function waitForConsole(
  vm: Machine,
  pattern: RegExp,
  timeoutMs: number,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (pattern.test(vm.consoleTail())) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `console never matched ${pattern}; tail:\n${vm.consoleTail()}`,
  );
}

Deno.test({
  name: "boots a real microVM to Running and SIGTERM-stops it",
  ignore: !enabled,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "fc-it-" });
    try {
      await using vm = await Machine.launch({
        firecrackerBin: bin!,
        config: await scratchConfig(dir),
        stateDir: join(dir, "state"),
      });
      assertEquals(vm.state, "running");
      assertEquals((await vm.client.getInstanceInfo()).state, "Running");
      const exit = await vm.shutdown({ ctrlAltDelTimeoutMs: 0 });
      assertEquals(exit.signal, "SIGTERM");
      assertEquals(exit.observedVia, "child-status");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "graceful CtrlAltDel shutdown exits 0 once the guest is up (x86_64)",
  ignore: !enabled || Deno.build.arch !== "x86_64",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "fc-it-" });
    try {
      await using vm = await Machine.launch({
        firecrackerBin: bin!,
        config: await scratchConfig(dir),
        stateDir: join(dir, "state"),
      });
      // Wait for userspace so init is around to handle Ctrl+Alt+Del.
      await waitForConsole(vm, /login:|Welcome to|systemd\[1\]/, 60_000);
      const exit = await vm.shutdown();
      assertEquals(exit.code, 0);
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "contract symmetry: real post-boot gating matches FakeFirecracker",
  ignore: !enabled,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "fc-it-" });
    try {
      await using vm = await Machine.launch({
        firecrackerBin: bin!,
        config: await scratchConfig(dir),
        stateDir: join(dir, "state"),
      });
      const err = await assertRejects(
        () => vm.client.putMachineConfig({ vcpu_count: 1, mem_size_mib: 128 }),
        ApiError,
      );
      assertEquals(err.status, 400);
      assert(
        /after starting/i.test(err.faultMessage),
        `unexpected fault message: ${err.faultMessage}`,
      );
      // Double InstanceStart is rejected too, like the fake.
      await assertRejects(() => vm.client.instanceStart(), ApiError);
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "kill() reaps and dispose reclaims the socket files",
  ignore: !enabled,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "fc-it-" });
    try {
      let apiSocket: string;
      {
        await using vm = await Machine.launch({
          firecrackerBin: bin!,
          config: await scratchConfig(dir),
          stateDir: join(dir, "state"),
        });
        apiSocket = vm.paths.apiSocket;
        const exit = await vm.kill();
        assertEquals(exit.signal, "SIGKILL");
      }
      assertEquals(await Deno.stat(apiSocket!).catch(() => null), null);
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
