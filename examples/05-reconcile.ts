/**
 * Crash-safe supervision: journal machines in a registry, and sweep up
 * whatever a previous (crashed) supervisor left behind before launching
 * anything new.
 *
 *   deno run -A examples/05-reconcile.ts [--state-dir /var/lib/my-host]
 */

import { DirRegistry, Machine, reconcile } from "../mod.ts";

function flag(name: string, fallback: string): string {
  const idx = Deno.args.indexOf(`--${name}`);
  return idx === -1 ? fallback : Deno.args[idx + 1];
}

const stateRoot = flag("state-dir", await Deno.makeTempDir());
const registry = new DirRegistry(`${stateRoot}/registry`);

// 1. Reclaim orphans from a previous run. killLive:true is fleet mode —
//    ephemeral sandboxes have no business outliving their supervisor.
const swept = await reconcile(registry, { killLive: true });
console.log(
  `reconcile: reclaimed=${swept.reclaimed.length}`,
  `stillRunning=${swept.stillRunning.length}`,
  `failures=${swept.failures.length}`,
);

// 2. Every machine launched with `registry` is journaled before its VMM
//    spawns — kill -9 this process and rerun to watch step 1 clean up.
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
  registry,
});
console.log(`launched ${vm.vmId} (pid ${vm.pid}); registry:`, registry.dir);
await vm.shutdown();
console.log("clean shutdown — record removed:", await registry.list());
