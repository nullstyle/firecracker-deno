/**
 * # @nullstyle/firecracker
 *
 * A Deno-native toolkit for controlling
 * {@link https://firecracker-microvm.github.io/ | Firecracker} microVMs: typed
 * machine configuration and API-socket access, supervised Firecracker and
 * jailer processes, host-to-guest vsock connections as standard `Deno.Conn`
 * streams, and reliable lifecycle cleanup — without prescribing images,
 * networking policy, or orchestration.
 *
 * It is the low-level foundation for building secure local sandboxes,
 * microVM runners, and higher-level platforms.
 *
 * Firecracker runs on Linux hosts with KVM; this library requires Deno 2.4+
 * and Firecracker within the window described by {@linkcode FIRECRACKER_COMPAT}.
 *
 * @example Boot a microVM, talk to it over vsock, clean up on scope exit
 * ```ts
 * import { Machine } from "@nullstyle/firecracker";
 *
 * await using vm = await Machine.launch({
 *   firecrackerBin: "/usr/local/bin/firecracker",
 *   config: {
 *     machine_config: { vcpu_count: 2, mem_size_mib: 512 },
 *     boot_source: {
 *       kernel_image_path: "/opt/images/vmlinux-6.1",
 *       boot_args: "console=ttyS0 reboot=k panic=1 pci=off",
 *     },
 *     drives: [{
 *       drive_id: "rootfs",
 *       path_on_host: "/opt/images/rootfs.ext4",
 *       is_root_device: true,
 *       is_read_only: false,
 *     }],
 *     vsock: { guest_cid: 3, uds_path: "/tmp/fc-vsock.sock" },
 *   },
 * });
 *
 * await using conn = await vm.vsock.connect(5000);
 * await conn.write(new TextEncoder().encode("ping\n"));
 * const exit = await vm.shutdown();
 * console.log("guest exited:", exit.code);
 * ```
 *
 * @module
 */

export * from "./src/errors.ts";
export * from "./src/types.ts";
export { FIRECRACKER_COMPAT, type FirecrackerCompat } from "./src/compat.ts";
export * from "./src/api/types.ts";
