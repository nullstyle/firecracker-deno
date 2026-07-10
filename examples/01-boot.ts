/**
 * Boot a Firecracker microVM, print its state, and shut it down cleanly.
 *
 * Linux + /dev/kvm required. Fetch assets first:
 *
 *   deno run -A tools/fetch-firecracker.ts
 *   deno run -A examples/01-boot.ts \
 *     [--firecracker tests/assets/firecracker] \
 *     [--kernel tests/assets/vmlinux] \
 *     [--rootfs tests/assets/rootfs.ext4]
 */

import { Machine } from "../mod.ts";

function flag(name: string, fallback: string): string {
  const idx = Deno.args.indexOf(`--${name}`);
  return idx === -1 ? fallback : Deno.args[idx + 1];
}

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

console.log(`booted: pid ${vm.pid}, state ${vm.state}`);
console.log("instance:", await vm.client.getInstanceInfo());

// Let the guest run briefly, then take it down gracefully.
await new Promise((resolve) => setTimeout(resolve, 3_000));
console.log(
  "guest console tail:\n" + vm.consoleTail().split("\n").slice(-8).join("\n"),
);

const exit = await vm.shutdown();
console.log(
  `guest exited: code=${exit.code} signal=${exit.signal} via=${exit.observedVia}`,
);
