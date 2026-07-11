/**
 * Snapshot/restore against real Firecracker. Same gating as boot_test.ts.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { envPath } from "./env.ts";
import { Machine, type VmConfig } from "../../mod.ts";

const bin = Deno.env.get("FC_TEST_BIN");
const kernel = Deno.env.get("FC_TEST_KERNEL");
const rootfs = Deno.env.get("FC_TEST_ROOTFS");
const kvm = await Deno.stat("/dev/kvm").then(() => true).catch(() => false);
const enabled = Deno.build.os === "linux" && kvm &&
  bin !== undefined && kernel !== undefined && rootfs !== undefined;

async function config(dir: string): Promise<VmConfig> {
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

Deno.test({
  name: "snapshot a live VM, restore it into a fresh VMM, resume, and use it",
  ignore: !enabled,
  fn: async () => {
    const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "fc-snap-" });
    try {
      const snapshotPath = join(dir, "snap.state");
      const memPath = join(dir, "snap.mem");
      {
        await using vm = await Machine.launch({
          firecrackerBin: bin!,
          config: await config(dir),
          stateDir: join(dir, "s1"),
        });
        // Let the guest get going, then snapshot with auto pause/resume.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        await vm.snapshot({
          pause: true,
          snapshot_path: snapshotPath,
          mem_file_path: memPath,
        });
        assertEquals(vm.state, "running");
        await vm.shutdown({ ctrlAltDelTimeoutMs: 0 });
      }
      assertEquals((await Deno.stat(snapshotPath)).isFile, true);
      assertEquals((await Deno.stat(memPath)).isFile, true);

      {
        await using restored = await Machine.restore({
          firecrackerBin: bin!,
          stateDir: join(dir, "s2"),
          snapshot: {
            snapshot_path: snapshotPath,
            mem_backend: { backend_type: "File", backend_path: memPath },
            resume_vm: true,
          },
        });
        assertEquals(restored.state, "running");
        assertEquals(
          (await restored.client.getInstanceInfo()).state,
          "Running",
        );
        // The restored VM answers config reads from its snapshotted state.
        const mc = await restored.client.getMachineConfig();
        assertEquals(mc.vcpu_count, 1);
        const exit = await restored.shutdown({ ctrlAltDelTimeoutMs: 0 });
        assertEquals(exit.signal, "SIGTERM");
      }
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
