/**
 * Pure translation of {@linkcode JailerOptions} into the jailer command
 * line. Everything after `--` is forwarded to Firecracker verbatim.
 *
 * @module
 */

import type { JailerOptions } from "./options.ts";

/** Build the jailer argv (excluding the jailer binary itself). */
export function buildJailerArgv(
  options: JailerOptions,
  firecrackerArgs: string[],
): string[] {
  const argv = [
    "--id",
    options.id,
    "--exec-file",
    options.firecrackerBin,
    "--uid",
    String(options.uid),
    "--gid",
    String(options.gid),
    "--cgroup-version",
    String(options.cgroupVersion ?? 2),
  ];
  if (options.chrootBaseDir !== undefined) {
    argv.push("--chroot-base-dir", options.chrootBaseDir);
  }
  if (options.netnsPath !== undefined) {
    argv.push("--netns", options.netnsPath);
  }
  if (options.parentCgroup !== undefined) {
    argv.push("--parent-cgroup", options.parentCgroup);
  }
  for (const [key, value] of Object.entries(options.cgroups ?? {})) {
    argv.push("--cgroup", `${key}=${value}`);
  }
  if (options.resourceLimits?.fsize !== undefined) {
    argv.push("--resource-limit", `fsize=${options.resourceLimits.fsize}`);
  }
  if (options.resourceLimits?.noFile !== undefined) {
    argv.push("--resource-limit", `no-file=${options.resourceLimits.noFile}`);
  }
  if (options.daemonize === true) argv.push("--daemonize");
  if (options.newPidNs === true) argv.push("--new-pid-ns");
  argv.push("--", ...firecrackerArgs);
  return argv;
}
