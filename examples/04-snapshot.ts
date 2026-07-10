/**
 * Snapshot a running microVM and restore it into a fresh VMM.
 *
 *   deno run -A examples/04-snapshot.ts \
 *     [--firecracker tests/assets/firecracker] \
 *     [--kernel tests/assets/vmlinux] \
 *     [--rootfs tests/assets/rootfs.ext4]
 */

import { join } from "@std/path";
import { Machine } from "../mod.ts";

function flag(name: string, fallback: string): string {
  const idx = Deno.args.indexOf(`--${name}`);
  return idx === -1 ? fallback : Deno.args[idx + 1];
}

const work = await Deno.makeTempDir({ dir: "/tmp", prefix: "fc-snap-" });
const snapshotPath = join(work, "snap.state");
const memPath = join(work, "snap.mem");

// 1. Boot, let the guest do some work, snapshot it (pause → create → resume).
{
  await using vm = await Machine.launch({
    firecrackerBin: flag("firecracker", "tests/assets/firecracker"),
    config: {
      machine_config: { vcpu_count: 1, mem_size_mib: 256 },
      boot_source: {
        kernel_image_path: flag("kernel", "tests/assets/vmlinux"),
        boot_args: "console=ttyS0 reboot=k panic=1 pci=off",
      },
      drives: [{
        drive_id: "rootfs",
        path_on_host: flag("rootfs", "tests/assets/rootfs.ext4"),
        is_root_device: true,
        is_read_only: false,
      }],
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  await vm.snapshot({
    pause: true,
    snapshot_path: snapshotPath,
    mem_file_path: memPath,
  });
  console.log(`snapshotted to ${snapshotPath} (VM still ${vm.state})`);
  await vm.shutdown();
}

// 2. Restore into a brand-new VMM and resume where it left off.
{
  await using vm = await Machine.restore({
    firecrackerBin: flag("firecracker", "tests/assets/firecracker"),
    snapshot: {
      snapshot_path: snapshotPath,
      mem_backend: { backend_type: "File", backend_path: memPath },
      resume_vm: true,
    },
  });
  console.log(`restored: state ${vm.state}, pid ${vm.pid}`);
  console.log("instance:", await vm.client.getInstanceInfo());
  await vm.shutdown();
}
await Deno.remove(work, { recursive: true });
