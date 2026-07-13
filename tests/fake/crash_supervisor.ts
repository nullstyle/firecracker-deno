/**
 * Test fixture: a supervisor process destined to die badly. Launches a
 * fake-vmm machine journaled in a DirRegistry, announces the VMM pid on
 * stdout, then hangs until it is SIGKILLed by the test — leaving an
 * orphaned "VMM" for reconcile() or Machine.adopt() to find.
 *
 * Usage: deno run -A tests/fake/crash_supervisor.ts <workDir> [flags]
 *
 * Flags (default behavior with no flags is a plain direct-mode launch):
 * - `--echo-port <n>`  serve a vsock byte-echo handler on guest port n
 * - `--listen <port>`  vm.vsock.listen(port) before hanging (journals the
 *                      listener path — its socket file outlives the crash)
 * - `--pause`          pause the VM before hanging
 * - `--no-start`       Machine.create instead of launch ("Not started")
 * - `--jailed`         launch under the fake jailer
 * - `--daemonize`      with --jailed: reparented mode (pidfile authority)
 */

import { join } from "@std/path";
import { DirRegistry, Machine, type MachineOptions } from "../../mod.ts";
import { makeFakeJailerBin } from "./fake_jailer_helper.ts";
import { makeFakeVmmBin } from "./fake_vmm_helper.ts";

const [workDir, ...rest] = Deno.args;
if (!workDir) {
  console.error("usage: crash_supervisor.ts <workDir> [flags]");
  Deno.exit(2);
}
const flags = {
  echoPort: undefined as number | undefined,
  listenPort: undefined as number | undefined,
  pause: false,
  noStart: false,
  jailed: false,
  daemonize: false,
};
for (let i = 0; i < rest.length; i++) {
  switch (rest[i]) {
    case "--echo-port":
      flags.echoPort = Number(rest[++i]);
      break;
    case "--listen":
      flags.listenPort = Number(rest[++i]);
      break;
    case "--pause":
      flags.pause = true;
      break;
    case "--no-start":
      flags.noStart = true;
      break;
    case "--jailed":
      flags.jailed = true;
      break;
    case "--daemonize":
      flags.daemonize = true;
      break;
    default:
      console.error(`crash_supervisor: unknown flag ${rest[i]}`);
      Deno.exit(2);
  }
}

const registry = new DirRegistry(join(workDir, "registry"));
const vmmEnv: Record<string, string> = flags.echoPort !== undefined
  ? { FAKE_VMM_ECHO_PORT: String(flags.echoPort) }
  : {};
const bin = await makeFakeVmmBin(workDir, "ready", vmmEnv);

const options: MachineOptions = flags.jailed
  ? {
    jailer: {
      jailerBin: await makeFakeJailerBin(workDir),
      firecrackerBin: bin,
      id: "crash-victim",
      uid: Deno.uid() ?? 0,
      gid: Deno.gid() ?? 0,
      chrootBaseDir: join(workDir, "jails"),
      ...(flags.daemonize ? { daemonize: true } : {}),
    },
    config: {
      boot_source: { kernel_image_path: "/vmlinux" },
      vsock: { guest_cid: 3, uds_path: "/v.sock" },
    },
    registry,
  }
  : {
    firecrackerBin: bin,
    id: "crash-victim",
    config: {
      boot_source: { kernel_image_path: "/vmlinux" },
      vsock: { guest_cid: 3, uds_path: join(workDir, "v.sock") },
    },
    stateDir: join(workDir, "state"),
    registry,
  };

const vm = flags.noStart
  ? await Machine.create(options)
  : await Machine.launch(options);
if (flags.pause) await vm.pause();
if (flags.listenPort !== undefined) {
  vm.vsock.listen(flags.listenPort);
  // The listener's journal update is fire-and-forget; wait for it to land
  // so the test's crash happens strictly after the record names the path.
  while (true) {
    const [rec] = await registry.list();
    if (rec !== undefined && rec.vsockListenerPaths.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

console.log(`LAUNCHED ${vm.pid}`);
setInterval(() => {}, 1 << 30);
await new Promise(() => {});
