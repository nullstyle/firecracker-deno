/**
 * Test helper: wrap fake_vmm.ts in an executable shim so it can stand in
 * for the `firecracker` binary (which supervisors exec directly).
 */

import { dirname, fromFileUrl, join } from "@std/path";

const FAKE_VMM = join(dirname(fromFileUrl(import.meta.url)), "fake_vmm.ts");

/**
 * Create an executable shim that runs fake_vmm.ts in `mode`, forwarding
 * argv. Returns the shim path (inside `dir`, caller-owned).
 */
export async function makeFakeVmmBin(
  dir: string,
  mode: string,
  env: Record<string, string> = {},
): Promise<string> {
  const envLine = Object.entries({ FAKE_VMM_MODE: mode, ...env })
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");
  // Name contains "firecracker" so the shim passes jailer --exec-file
  // validation when used in jailed-machine tests.
  const path = join(dir, `firecracker-fake-${mode}`);
  await Deno.writeTextFile(
    path,
    `#!/bin/sh\n${envLine} exec ${JSON.stringify(Deno.execPath())} run -A ${
      JSON.stringify(FAKE_VMM)
    } "$@"\n`,
  );
  await Deno.chmod(path, 0o755);
  return path;
}
