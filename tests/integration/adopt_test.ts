/**
 * Adoption against a real Firecracker (tier 3). Same gating as
 * boot_test.ts: Linux, /dev/kvm, FC_TEST_* assets. A subprocess
 * supervisor (crash_supervisor.ts) boots a journaled real microVM and is
 * SIGKILLed; the test then re-attaches through the registry — exercising
 * the real /proc identity checks that the fake tier can only degrade.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { envPath } from "./env.ts";
import {
  AdoptError,
  DirRegistry,
  Machine,
  reconcile,
  VsockDialError,
} from "../../mod.ts";
import { pidAlive } from "../../src/internal/liveness.ts";

const HERE = dirname(fromFileUrl(import.meta.url));

const bin = envPath("FC_TEST_BIN");
const kernel = envPath("FC_TEST_KERNEL");
const rootfs = envPath("FC_TEST_ROOTFS");
const kvm = await Deno.stat("/dev/kvm").then(() => true).catch(() => false);
const enabled = Deno.build.os === "linux" && kvm &&
  bin !== undefined && kernel !== undefined && rootfs !== undefined;

async function orphanRealVmm(dir: string, flags: string[]): Promise<number> {
  const supervisor = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", join(HERE, "crash_supervisor.ts"), dir, ...flags],
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  let vmmPid = 0;
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
  return vmmPid;
}

function killQuietly(pid: number): void {
  try {
    Deno.kill(pid, "SIGKILL");
  } catch {
    // already dead
  }
}

Deno.test({
  name: "real adoption: SIGKILLed supervisor, adopt, API + vsock + shutdown",
  ignore: !enabled,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "fc-it-adopt-" });
    let vmmPid = 0;
    try {
      vmmPid = await orphanRealVmm(dir, []);
      const registry = new DirRegistry(join(dir, "registry"));
      const [rec] = await registry.list();
      assertEquals(rec.vmId, "crash-victim");

      const vm = await Machine.adopt({ record: rec, registry });
      try {
        assertEquals(vm.pid, vmmPid);
        assertEquals(vm.state, "running");
        assertEquals((await vm.client.getInstanceInfo()).state, "Running");
        assertEquals(
          vm.consoleTail(),
          "",
          "adopted console is unobservable — the pipe died with the supervisor",
        );

        // The adopted vsock path reaches the real mux: a dial to an
        // unlistened port is accepted then closed before OK — the
        // protocol truth the library depends on (vsock_test.ts).
        const err = await assertRejects(
          () =>
            vm.vsock.connect(52001, {
              retryTimeoutMs: 3_000,
              retryIntervalMs: 100,
            }),
          VsockDialError,
        );
        assertEquals(err.reason, "closed-before-ok");

        const exit = await vm.shutdown({ ctrlAltDelTimeoutMs: 0 });
        assertEquals(exit.observedVia, "pidfile-poll");
        assertEquals(exit.code, null);
        assertEquals(exit.signal, null);
      } finally {
        await vm[Symbol.asyncDispose]();
      }
      assert(!pidAlive(vmmPid));
      assertEquals(await registry.list(), []);
      assertEquals(
        await Deno.stat(join(dir, "state", "fc.sock")).catch(() => null),
        null,
        "api socket must be reclaimed",
      );
      assertEquals(
        await Deno.stat(join(dir, "v.sock")).catch(() => null),
        null,
        "vsock uds must be reclaimed",
      );
    } finally {
      if (vmmPid !== 0) killQuietly(vmmPid);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "real adoption of a dead orphan refuses; reconcile reclaims it",
  ignore: !enabled,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "fc-it-adopt-" });
    let vmmPid = 0;
    try {
      vmmPid = await orphanRealVmm(dir, []);
      // Kill the orphan itself; init reaps it (it is nobody's child now).
      Deno.kill(vmmPid, "SIGKILL");
      const deadline = performance.now() + 5_000;
      while (pidAlive(vmmPid) && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert(!pidAlive(vmmPid), "init should have reaped the killed orphan");

      const registry = new DirRegistry(join(dir, "registry"));
      const [rec] = await registry.list();
      const err = await assertRejects(
        () => Machine.adopt({ record: rec, registry }),
        AdoptError,
      );
      assertEquals(err.reason, "vmm-not-found");
      assertEquals(
        (await registry.list()).length,
        1,
        "record kept for reconcile",
      );

      const swept = await reconcile(registry);
      assertEquals(swept.reclaimed, ["crash-victim"]);
      assertEquals(swept.failures, []);
      assertEquals(await registry.list(), []);
    } finally {
      if (vmmPid !== 0) killQuietly(vmmPid);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
