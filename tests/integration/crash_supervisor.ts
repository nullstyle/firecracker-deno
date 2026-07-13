/**
 * Integration-test fixture: a supervisor destined to die badly, driving a
 * REAL Firecracker. Boots a journaled microVM, announces the VMM pid on
 * stdout as `LAUNCHED <pid>`, then hangs until SIGKILLed — leaving a real
 * orphaned VMM for Machine.adopt() / recover() / reconcile() to find.
 *
 * Usage (env: FC_TEST_BIN, FC_TEST_KERNEL, FC_TEST_ROOTFS, and
 * FC_TEST_JAILER for --jailed):
 *
 *   deno run -A tests/integration/crash_supervisor.ts <workDir> [flags]
 *
 * Flags:
 * - `--jailed`    launch under the real jailer (daemonized — the
 *                 rootd-realistic reparenting mode; requires root)
 * - `--cgroups`   with --jailed: constrain via cgroup v2 (cpu.weight), so
 *                 the journaled cgroupPath is real and reclaimable
 */

import { join } from "@std/path";
import { DirRegistry, Machine, type MachineOptions } from "../../mod.ts";
import { envPath } from "./env.ts";

const [workDir, ...rest] = Deno.args;
if (!workDir) {
  console.error("usage: crash_supervisor.ts <workDir> [--jailed] [--cgroups]");
  Deno.exit(2);
}
const jailed = rest.includes("--jailed");
const cgroups = rest.includes("--cgroups");

const bin = envPath("FC_TEST_BIN")!;
const kernel = envPath("FC_TEST_KERNEL")!;
const rootfs = envPath("FC_TEST_ROOTFS")!;

const registry = new DirRegistry(join(workDir, "registry"));
const rootfsCopy = join(workDir, "rootfs.ext4");
await Deno.copyFile(rootfs, rootfsCopy);

const options: MachineOptions = jailed
  ? {
    jailer: {
      jailerBin: envPath("FC_TEST_JAILER")!,
      firecrackerBin: bin,
      id: "crash-victim",
      uid: 65534, // nobody
      gid: 65534,
      chrootBaseDir: join(workDir, "jail"),
      daemonize: true,
      ...(cgroups ? { cgroups: { "cpu.weight": "100" } } : {}),
      stage: [
        { hostPath: kernel, jailPath: "/vmlinux" },
        { hostPath: rootfsCopy, jailPath: "/rootfs.ext4", readWrite: true },
      ],
    },
    config: {
      machine_config: { vcpu_count: 1, mem_size_mib: 256 },
      boot_source: {
        kernel_image_path: "/vmlinux",
        boot_args: "console=ttyS0 reboot=k panic=1 pci=off",
      },
      drives: [{
        drive_id: "rootfs",
        path_on_host: "/rootfs.ext4",
        is_root_device: true,
        is_read_only: false,
      }],
      vsock: { guest_cid: 3, uds_path: "/v.sock" },
    },
    registry,
  }
  : {
    firecrackerBin: bin,
    id: "crash-victim",
    // Adoption-intended machines must not capture stdio: a pipe whose
    // reader died with this supervisor wedges the orphaned Firecracker on
    // its next write, and its API stops answering. See docs/adoption.md.
    stdio: "null",
    config: {
      machine_config: { vcpu_count: 1, mem_size_mib: 256 },
      boot_source: {
        kernel_image_path: kernel,
        boot_args: "reboot=k panic=1 pci=off",
      },
      drives: [{
        drive_id: "rootfs",
        path_on_host: rootfsCopy,
        is_root_device: true,
        is_read_only: false,
      }],
      vsock: { guest_cid: 3, uds_path: join(workDir, "v.sock") },
    },
    stateDir: join(workDir, "state"),
    registry,
  };

const vm = await Machine.launch(options);
console.log(`LAUNCHED ${vm.pid}`);
setInterval(() => {}, 1 << 30);
await new Promise(() => {});
