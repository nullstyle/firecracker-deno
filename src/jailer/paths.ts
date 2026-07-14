/**
 * Host ↔ chroot path math for jailed machines. Pure functions — the jailer
 * chroot layout is `<base>/<exec_file_name>/<id>/root`, and every path
 * Firecracker sees (API socket, drives, vsock UDS) is inside that root.
 *
 * @module
 */

import { basename, join } from "@std/path";

/** Computed jailer filesystem layout for one machine. */
export interface JailPaths {
  /** The `--chroot-base-dir` (default `/srv/jailer`). */
  chrootBase: string;
  /** Basename of the firecracker binary (`--exec-file`). */
  execName: string;
  /** The jail id. */
  id: string;
  /** `<base>/<execName>/<id>` — the per-machine dir this library reclaims. */
  jailRoot: string;
  /** `<base>/<execName>/<id>/root` — the chroot Firecracker lives in. */
  chrootRoot: string;
  /** Host path of the pidfile Firecracker writes: `<chrootRoot>/<execName>.pid`. */
  pidfileHost: string;
}

/** Default `--chroot-base-dir`, matching the jailer's own default. */
export const DEFAULT_CHROOT_BASE = "/srv/jailer";

/** Compute the jailer layout for a machine. */
export function computeJailPaths(opts: {
  firecrackerBin: string;
  id: string;
  chrootBaseDir?: string;
}): JailPaths {
  const chrootBase = opts.chrootBaseDir ?? DEFAULT_CHROOT_BASE;
  const execName = basename(opts.firecrackerBin);
  const jailRoot = join(chrootBase, execName, opts.id);
  const chrootRoot = join(jailRoot, "root");
  return {
    chrootBase,
    execName,
    id: opts.id,
    jailRoot,
    chrootRoot,
    pidfileHost: join(chrootRoot, `${execName}.pid`),
  };
}

/**
 * The cgroup-v2 subtree the jailer creates for a machine, when cgroups are
 * in use. Cgroup-v1 has per-controller layouts rather than one removable
 * subtree, so it has no corresponding manifest path.
 */
export function cgroupV2Path(
  options: {
    parentCgroup?: string;
    cgroups?: Record<string, string>;
    cgroupVersion?: 1 | 2;
  },
  paths: JailPaths,
): string | undefined {
  const usesCgroups = options.parentCgroup !== undefined ||
    Object.keys(options.cgroups ?? {}).length > 0;
  if (!usesCgroups || (options.cgroupVersion ?? 2) === 1) return undefined;
  return join(
    "/sys/fs/cgroup",
    options.parentCgroup ?? paths.execName,
    paths.id,
  );
}

/**
 * Map an in-jail path (as Firecracker sees it, e.g. `"/v.sock"`) to its
 * host-side location under the chroot.
 */
export function hostPathOf(paths: JailPaths, jailPath: string): string {
  const normalized = jailPath.startsWith("/") ? jailPath : `/${jailPath}`;
  assertNoTraversal(normalized);
  return join(paths.chrootRoot, normalized.slice(1));
}

/** Reject `..` segments — jail paths must not escape the chroot. */
export function assertNoTraversal(jailPath: string): void {
  if (jailPath.split("/").includes("..")) {
    throw new TypeError(
      `jail path ${JSON.stringify(jailPath)} must not contain ".." segments`,
    );
  }
}
