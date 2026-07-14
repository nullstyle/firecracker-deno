/**
 * Vsock contract tests against real Firecracker. Same gating as
 * boot_test.ts. The CI ubuntu guest runs no vsock listener, so the
 * host→guest test asserts the *protocol truth* the library depends on:
 * a dial to an unlistened port is closed before `OK`.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { envPath } from "./env.ts";
import { Machine, type VmConfig, VsockDialError } from "../../mod.ts";
import { listenVsock } from "../../src/vsock/mod.ts";

const bin = envPath("FC_TEST_BIN");
const kernel = envPath("FC_TEST_KERNEL");
const rootfs = envPath("FC_TEST_ROOTFS");
const kvm = await Deno.stat("/dev/kvm").then(() => true).catch(() => false);
const enabled = Deno.build.os === "linux" && kvm &&
  bin !== undefined && kernel !== undefined && rootfs !== undefined;

async function vsockConfig(dir: string): Promise<VmConfig> {
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
    vsock: { guest_cid: 3, uds_path: join(dir, "v.sock") },
  };
}

Deno.test({
  name: "real vsock: dial to an unlistened guest port closes before OK",
  ignore: !enabled,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "fc-it-vsock-" });
    try {
      await using vm = await Machine.launch({
        firecrackerBin: bin!,
        config: await vsockConfig(dir),
        stateDir: join(dir, "state"),
      });
      const err = await assertRejects(
        () =>
          vm.vsock.connect(52001, {
            retryTimeoutMs: 3_000,
            retryIntervalMs: 100,
          }),
        VsockDialError,
      );
      assertEquals(err.reason, "closed-before-ok");
      assert(err.attempts >= 2);
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "real vsock: host listener socket lifecycle survives a boot",
  ignore: !enabled,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "fc-it-vsock-" });
    try {
      const config = await vsockConfig(dir);
      let listenerPath: string;
      {
        await using vm = await Machine.launch({
          firecrackerBin: bin!,
          config,
          stateDir: join(dir, "state"),
        });
        // Pre-creating the guest-initiated listener must not disturb the VM.
        const listener = listenVsock(vm.paths.vsockUds!, 52002);
        listenerPath = listener.path;
        assertEquals((await vm.client.getInstanceInfo()).state, "Running");
        await vm.shutdown({ ctrlAltDelTimeoutMs: 0 });
        await listener[Symbol.asyncDispose]();
      }
      assertEquals(await Deno.stat(listenerPath!).catch(() => null), null);
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
