/**
 * Boot a jailed microVM: chroot, privilege drop, PID isolation, and a
 * crash-recovery registry. Linux + /dev/kvm + root required.
 *
 *   sudo deno run -A examples/03-jailed.ts \
 *     [--firecracker tests/assets/firecracker] \
 *     [--jailer tests/assets/jailer] \
 *     [--kernel tests/assets/vmlinux] \
 *     [--rootfs tests/assets/rootfs.ext4]
 */

import { DirRegistry, Machine, reconcile } from "../mod.ts";

function flag(name: string, fallback: string): string {
  const idx = Deno.args.indexOf(`--${name}`);
  return idx === -1 ? fallback : Deno.args[idx + 1];
}

const registry = new DirRegistry("/var/lib/fc-example/registry");
await reconcile(registry, { killLive: true });

await using vm = await Machine.launch({
  jailer: {
    jailerBin: flag("jailer", "tests/assets/jailer"),
    firecrackerBin: flag("firecracker", "tests/assets/firecracker"),
    id: "example-jail",
    uid: 65534,
    gid: 65534,
    newPidNs: true,
    stage: [
      {
        hostPath: flag("kernel", "tests/assets/vmlinux"),
        jailPath: "/vmlinux",
      },
      {
        hostPath: flag("rootfs", "tests/assets/rootfs.ext4"),
        jailPath: "/rootfs.ext4",
        readWrite: true,
      },
    ],
  },
  config: {
    machine_config: { vcpu_count: 1, mem_size_mib: 256 },
    boot_source: {
      kernel_image_path: "/vmlinux", // in-jail path
      boot_args: "console=ttyS0 reboot=k panic=1 pci=off",
    },
    drives: [{
      drive_id: "rootfs",
      path_on_host: "/rootfs.ext4", // in-jail path
      is_root_device: true,
      is_read_only: false,
    }],
    vsock: { guest_cid: 3, uds_path: "/v.sock" },
  },
  registry,
});

console.log(`jailed VM up: pid ${vm.pid} (exit authority differs by mode)`);
console.log(`chroot: ${vm.paths.chrootRoot}`);
console.log(`host view of vsock: ${vm.paths.vsockUds}`);
const exit = await vm.shutdown();
console.log(`exited: code=${exit.code} via=${exit.observedVia}`);
// scope exit reclaims the chroot and clears the registry record
