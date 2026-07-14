/**
 * Crash-safe supervision: journal machines in a registry, and sweep up
 * whatever a previous (crashed) supervisor left behind before launching
 * anything new.
 *
 *   deno run -A examples/05-reconcile.ts [--state-dir /var/lib/my-host]
 */

import { parseFlags } from "@cliffy/flags";
import { DirRegistry, Machine, reconcile } from "../mod.ts";

const { flags } = parseFlags(Deno.args, {
  flags: [
    { name: "state-dir", type: "string" },
    {
      name: "firecracker",
      type: "string",
      default: "tests/assets/firecracker",
    },
    { name: "kernel", type: "string", default: "tests/assets/vmlinux" },
    {
      name: "rootfs",
      type: "string",
      default: "tests/assets/rootfs.ext4",
    },
  ],
});

const stateRoot = flags.stateDir ?? await Deno.makeTempDir();
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
  firecrackerBin: flags.firecracker,
  config: {
    machine_config: { vcpu_count: 1, mem_size_mib: 256 },
    boot_source: {
      kernel_image_path: flags.kernel,
      boot_args: "console=ttyS0 reboot=k panic=1 pci=off",
    },
    drives: [{
      drive_id: "rootfs",
      path_on_host: flags.rootfs,
      is_root_device: true,
      is_read_only: false,
    }],
  },
  registry,
});
console.log(`launched ${vm.vmId} (pid ${vm.pid}); registry:`, registry.dir);
await vm.shutdown();
console.log("clean shutdown — record removed:", await registry.list());
