/**
 * Talk to a guest over vsock as a standard Deno.Conn.
 *
 * Requires a guest image running a vsock echo server (e.g. `socat` bound
 * to VSOCK-LISTEN:5000 inside the guest). With the plain CI rootfs, the
 * dial below demonstrates the failure mode instead: a clean
 * VsockDialError("closed-before-ok") because nothing listens.
 *
 *   deno run -A examples/02-vsock-echo.ts \
 *     [--firecracker tests/assets/firecracker] \
 *     [--kernel tests/assets/vmlinux] \
 *     [--rootfs tests/assets/rootfs.ext4] \
 *     [--port 5000]
 */

import { parseFlags } from "@cliffy/flags";
import { Machine, VsockDialError } from "../mod.ts";

const { flags } = parseFlags(Deno.args, {
  flags: [
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
    { name: "port", type: "integer", default: 5000 },
  ],
});

const port = flags.port;

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
    vsock: { guest_cid: 3, uds_path: "v.sock" },
  },
});
console.log(`booted pid ${vm.pid}; dialing guest vsock port ${port}…`);

try {
  await using conn = await vm.vsock.connect(port, { retryTimeoutMs: 10_000 });
  console.log(`connected (host port ${conn.assignedHostPort})`);
  await conn.write(new TextEncoder().encode("ping\n"));
  const buf = new Uint8Array(1024);
  const n = await conn.read(buf);
  console.log("guest says:", new TextDecoder().decode(buf.subarray(0, n ?? 0)));
} catch (err) {
  if (err instanceof VsockDialError) {
    console.log(
      `no guest listener on port ${port} (${err.reason} after ${err.attempts} attempts) — run an echo server in the guest to complete the demo`,
    );
  } else {
    throw err;
  }
}

await vm.shutdown();
