/**
 * Supervisor-restart recovery: ADOPT still-running microVMs instead of
 * killing them — the counterpart to examples/05-reconcile.ts (fleet mode,
 * which kills survivors).
 *
 * Run it twice with the same --state-dir:
 *
 *   run 1: launches a journaled VM, then exits WITHOUT cleanup — a
 *          simulated supervisor crash. The VM keeps running.
 *   run 2: finds the record, re-attaches to the live VM via recover(),
 *          demonstrates the adopted handle, and shuts it down cleanly.
 *
 *   deno run -A examples/06-adopt.ts --state-dir /tmp/fc-adopt-demo
 */

import { DirRegistry, Machine, recover } from "../mod.ts";

function flag(name: string, fallback: string): string {
  const idx = Deno.args.indexOf(`--${name}`);
  return idx === -1 ? fallback : Deno.args[idx + 1];
}

const stateRoot = flag("state-dir", "/tmp/fc-adopt-demo");
const registry = new DirRegistry(`${stateRoot}/registry`);

// One pass: re-attach to the living, reclaim the dead, report the stuck.
const sweep = await recover(registry);
for (const vmId of sweep.reclaimed) {
  console.log(`${vmId}: died while the supervisor was down — reclaimed`);
}
for (const u of sweep.unadoptable) {
  console.log(`${u.vmId}: live but unadoptable (${u.reason}) — left alone`);
}

if (sweep.adopted.length > 0) {
  // Run 2: survivors found. The adopted handle is a full Machine.
  for (const vm of sweep.adopted) {
    console.log(`adopted ${vm.vmId} (pid ${vm.pid}): state=${vm.state}`);
    console.log("instance info:", await vm.client.getInstanceInfo());
    console.log(
      "degraded observability — consoleTail:",
      JSON.stringify(vm.consoleTail()),
      "(use the logger/serial devices instead)",
    );
    const exit = await vm.shutdown();
    console.log(
      `shutdown: code=${exit.code} (exit codes are unobservable for adopted`,
      `machines) via ${exit.observedVia}`,
    );
    await vm[Symbol.asyncDispose]();
  }
  console.log("records after dispose:", await registry.list());
} else {
  // Run 1: launch a journaled VM and "crash".
  const vm = await Machine.launch({
    firecrackerBin: flag("firecracker", "tests/assets/firecracker"),
    id: "adopt-demo",
    // Machines meant to survive a supervisor crash must not capture stdio:
    // an orphaned pipe wedges Firecracker's API. See docs/adoption.md.
    stdio: "null",
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
    stateDir: `${stateRoot}/state`,
    registry,
  });
  console.log(`launched ${vm.vmId} (pid ${vm.pid}); registry: ${stateRoot}`);
  console.log("exiting WITHOUT cleanup — the VM keeps running.");
  console.log("re-run this command to adopt it.");
  Deno.exit(0); // the simulated crash: no disposal runs
}
