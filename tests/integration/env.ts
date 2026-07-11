/**
 * Shared integration-test env handling: FC_TEST_* paths are absolutized
 * because VM config paths (kernel, rootfs) are resolved by Firecracker in
 * its own working directory — the machine's state dir — by design.
 */

import { resolve } from "@std/path";

/** Read an env var as an absolute path (undefined when unset). */
export function envPath(name: string): string | undefined {
  const value = Deno.env.get(name);
  return value === undefined ? undefined : resolve(value);
}
