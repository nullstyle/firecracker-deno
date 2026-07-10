/**
 * Test fixture: a supervisor process destined to die badly. Launches a
 * fake-vmm machine journaled in a DirRegistry, announces the VMM pid on
 * stdout, then hangs until it is SIGKILLed by the test — leaving an
 * orphaned "VMM" for reconcile() to find.
 *
 * Usage: deno run -A tests/fake/crash_supervisor.ts <workDir>
 */

import { join } from "@std/path";
import { DirRegistry, Machine } from "../../mod.ts";
import { makeFakeVmmBin } from "./fake_vmm_helper.ts";

const workDir = Deno.args[0];
if (!workDir) {
  console.error("usage: crash_supervisor.ts <workDir>");
  Deno.exit(2);
}

const registry = new DirRegistry(join(workDir, "registry"));
const bin = await makeFakeVmmBin(workDir, "ready");
const vm = await Machine.launch({
  firecrackerBin: bin,
  id: "crash-victim",
  config: {
    boot_source: { kernel_image_path: "/vmlinux" },
    vsock: { guest_cid: 3, uds_path: join(workDir, "v.sock") },
  },
  stateDir: join(workDir, "state"),
  registry,
});

console.log(`LAUNCHED ${vm.pid}`);
setInterval(() => {}, 1 << 30);
await new Promise(() => {});
