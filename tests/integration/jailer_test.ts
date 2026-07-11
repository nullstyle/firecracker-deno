/**
 * Real-jailer integration matrix (tier 4): requires Linux, /dev/kvm, the
 * FC_TEST_* assets incl. FC_TEST_JAILER, and root (the jailer chroots and
 * drops privileges). CI runs this step under sudo.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { envPath } from "./env.ts";
import { DirRegistry, Machine, type MachineOptions } from "../../mod.ts";

const bin = envPath("FC_TEST_BIN");
const jailerBin = envPath("FC_TEST_JAILER");
const kernel = envPath("FC_TEST_KERNEL");
const rootfs = envPath("FC_TEST_ROOTFS");
const kvm = await Deno.stat("/dev/kvm").then(() => true).catch(() => false);
const isRoot = Deno.build.os === "linux" && Deno.uid() === 0;
const enabled = Deno.build.os === "linux" && kvm && isRoot &&
  bin !== undefined && jailerBin !== undefined &&
  kernel !== undefined && rootfs !== undefined;

if (!enabled && Deno.build.os === "linux" && kvm) {
  console.warn(
    "⚠ jailer integration tests SKIPPED: need root (sudo) and FC_TEST_JAILER",
  );
}

const JAIL_UID = 65534; // nobody
const JAIL_GID = 65534;

async function jailedOptions(
  dir: string,
  id: string,
  mode: { daemonize?: boolean; newPidNs?: boolean },
): Promise<{ options: MachineOptions; registry: DirRegistry }> {
  const rootfsCopy = join(dir, "rootfs.ext4");
  await Deno.copyFile(rootfs!, rootfsCopy);
  const registry = new DirRegistry(join(dir, "registry"));
  const options: MachineOptions = {
    jailer: {
      jailerBin: jailerBin!,
      firecrackerBin: bin!,
      id,
      uid: JAIL_UID,
      gid: JAIL_GID,
      chrootBaseDir: join(dir, "jail"),
      ...mode,
      stage: [
        { hostPath: kernel!, jailPath: "/vmlinux" },
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
  };
  return { options, registry };
}

for (
  const [name, mode] of [
    ["plain", {}],
    ["new-pid-ns", { newPidNs: true }],
    ["daemonize", { daemonize: true }],
  ] as const
) {
  Deno.test({
    name:
      `real jailer (${name}): boots, correct exit authority, zero leftovers`,
    ignore: !enabled,
    fn: async () => {
      const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "fcj-" });
      try {
        const { options, registry } = await jailedOptions(
          dir,
          `it-${name}`,
          mode,
        );
        const jailRoot = join(dir, "jail", "firecracker", `it-${name}`);
        {
          await using vm = await Machine.launch(options);
          assertEquals((await vm.client.getInstanceInfo()).state, "Running");
          assert(vm.pid > 0);
          // pidfile agrees with the authoritative pid in every mode
          const pidfile = await Deno.readTextFile(
            join(jailRoot, "root", "firecracker.pid"),
          );
          assertEquals(Number(pidfile.trim()), vm.pid);

          const exit = await vm.shutdown({ ctrlAltDelTimeoutMs: 0 });
          const reparented = mode.daemonize === true || mode.newPidNs === true;
          assertEquals(
            exit.observedVia,
            reparented ? "pidfile-poll" : "child-status",
          );
        }
        // zero leftovers: the whole jail dir is gone, registry is empty
        assertEquals(await Deno.stat(jailRoot).catch(() => null), null);
        assertEquals(await registry.list(), []);
      } finally {
        await Deno.remove(dir, { recursive: true }).catch(() => {});
      }
    },
  });
}
