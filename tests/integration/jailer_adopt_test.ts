/**
 * Adoption of a real jailed (daemonized) microVM (tier 4): requires
 * Linux, /dev/kvm, the FC_TEST_* assets incl. FC_TEST_JAILER, and root.
 * This is the one test that proves the journaled `cgroupPath` carries
 * real cleanup authority end-to-end: the jailer creates the cgroup, the
 * crashed supervisor never removes it, and the adopted machine's
 * disposal does.
 */

import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { envPath } from "./env.ts";
import { DirRegistry, Machine } from "../../mod.ts";
import { pidAlive } from "../../src/internal/liveness.ts";

const HERE = dirname(fromFileUrl(import.meta.url));

const bin = envPath("FC_TEST_BIN");
const jailerBin = envPath("FC_TEST_JAILER");
const kernel = envPath("FC_TEST_KERNEL");
const rootfs = envPath("FC_TEST_ROOTFS");
const kvm = await Deno.stat("/dev/kvm").then(() => true).catch(() => false);
const isRoot = Deno.build.os === "linux" && Deno.uid() === 0;
const enabled = Deno.build.os === "linux" && kvm && isRoot &&
  bin !== undefined && jailerBin !== undefined &&
  kernel !== undefined && rootfs !== undefined;

Deno.test({
  name:
    "real jailer (daemonize): adopt after supervisor SIGKILL, dispose reclaims chroot + cgroup",
  ignore: !enabled,
  fn: async () => {
    const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "fcja-" });
    let vmmPid = 0;
    try {
      const supervisor = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          join(HERE, "crash_supervisor.ts"),
          dir,
          "--jailed",
          "--cgroups",
        ],
        stdout: "piped",
        stderr: "inherit",
      }).spawn();
      const reader = supervisor.stdout.getReader();
      let buffer = "";
      while (vmmPid === 0) {
        const { value, done } = await reader.read();
        if (done) throw new Error("supervisor exited before LAUNCHED");
        buffer += new TextDecoder().decode(value);
        const match = /LAUNCHED (\d+)/.exec(buffer);
        if (match !== null) vmmPid = Number(match[1]);
      }
      supervisor.kill("SIGKILL");
      await supervisor.status;
      await reader.cancel();
      assert(pidAlive(vmmPid), "the VMM must have been orphaned, not killed");

      const jailRoot = join(dir, "jail", "firecracker", "crash-victim");
      const cgroupDir = "/sys/fs/cgroup/firecracker/crash-victim";
      const registry = new DirRegistry(join(dir, "registry"));
      const [rec] = await registry.list();
      assertEquals(rec.chrootDir, jailRoot);
      assertEquals(rec.cgroupPath, cgroupDir);
      assert(
        (await Deno.stat(cgroupDir)).isDirectory,
        "the jailer must have created the real cgroup subtree",
      );

      const vm = await Machine.adopt({ record: rec, registry });
      try {
        // Pid authority is the pidfile the real Firecracker wrote.
        const pidfile = await Deno.readTextFile(
          join(jailRoot, "root", "firecracker.pid"),
        );
        assertEquals(vm.pid, Number(pidfile.trim()));
        assertEquals(vm.pid, vmmPid);
        assertEquals(vm.state, "running");
        assertEquals((await vm.client.getInstanceInfo()).state, "Running");
        assertEquals(vm.paths.chrootRoot, join(jailRoot, "root"));

        const exit = await vm.shutdown({ ctrlAltDelTimeoutMs: 0 });
        assertEquals(exit.observedVia, "pidfile-poll");
        assertEquals(exit.code, null);
      } finally {
        await vm[Symbol.asyncDispose]();
      }
      assert(!pidAlive(vmmPid));
      assertEquals(
        await Deno.stat(jailRoot).catch(() => null),
        null,
        "dispose must remove the whole jail root",
      );
      assertEquals(
        await Deno.stat(cgroupDir).catch(() => null),
        null,
        "dispose must remove the journaled cgroup subtree",
      );
      assertEquals(await registry.list(), []);
    } finally {
      if (vmmPid !== 0) {
        try {
          Deno.kill(vmmPid, "SIGKILL");
        } catch {
          // already dead
        }
      }
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
