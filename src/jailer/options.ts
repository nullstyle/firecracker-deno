/**
 * {@linkcode JailerOptions} and their validation. Everything here is
 * checked *before* any process spawns, so misconfiguration fails fast with
 * a {@linkcode JailerConfigError} naming the problem.
 *
 * @module
 */

import { basename } from "@std/path";
import { JailerConfigError } from "../errors.ts";
import { assertNoTraversal } from "./paths.ts";

/** One file to place into the chroot before the jailer starts. */
export interface StageEntry {
  /** The file on the host (kernel image, rootfs, …). */
  hostPath: string;
  /**
   * Where it appears inside the jail (absolute in-jail path).
   * @default "/" + basename(hostPath)
   */
  jailPath?: string;
  /**
   * `"hardlink"` (default; falls back to copy across filesystems) or
   * `"copy"`.
   */
  mode?: "hardlink" | "copy";
  /**
   * Whether the guest writes to it (e.g. a rootfs). Read-write files are
   * chmod `0600`, read-only `0400`; both are chowned to the jail uid/gid.
   */
  readWrite?: boolean;
}

/** Configuration for running Firecracker under the jailer. */
export interface JailerOptions {
  /** Path to the `jailer` binary. */
  jailerBin: string;
  /**
   * Path to the `firecracker` binary (`--exec-file`). The jailer requires
   * the file name to contain "firecracker".
   */
  firecrackerBin: string;
  /** Jail id (≤ 64 chars, alphanumeric + hyphen). Becomes the machine's vmId. */
  id: string;
  /** Uid Firecracker drops to inside the jail. */
  uid: number;
  /** Gid Firecracker drops to inside the jail. */
  gid: number;
  /**
   * `--chroot-base-dir`.
   * @default "/srv/jailer"
   */
  chrootBaseDir?: string;
  /** Network namespace path to join (`--netns`). Never created or destroyed. */
  netnsPath?: string;
  /**
   * Cgroup hierarchy version. This library defaults to `2` (modern hosts);
   * note the jailer's own default is `1`.
   * @default 2
   */
  cgroupVersion?: 1 | 2;
  /** Cgroup values, each passed as `--cgroup key=value`. */
  cgroups?: Record<string, string>;
  /** Parent cgroup path (`--parent-cgroup`). */
  parentCgroup?: string;
  /** Resource limits (`--resource-limit`). */
  resourceLimits?: {
    /** Maximum file size in bytes (`fsize=`). */
    fsize?: number;
    /** Maximum open file descriptors (`no-file=`). */
    noFile?: number;
  };
  /**
   * Daemonize the jailer (double fork + setsid). The VMM is reparented:
   * exit codes become unobservable and stderr goes to /dev/null — configure
   * the Firecracker `logger` instead. Exit detection switches to
   * pidfile-polling.
   */
  daemonize?: boolean;
  /**
   * Run Firecracker in a new PID namespace. Like `daemonize`, the VMM is
   * reparented and exit detection switches to pidfile-polling.
   */
  newPidNs?: boolean;
  /** Files to hardlink/copy into the chroot before start. */
  stage?: StageEntry[];
}

const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/** Validate `options`, throwing {@linkcode JailerConfigError} on the first problem. */
export function validateJailerOptions(options: JailerOptions): void {
  if (!ID_PATTERN.test(options.id)) {
    throw new JailerConfigError(
      `jailer id ${
        JSON.stringify(options.id)
      } is invalid: must be 1-64 alphanumeric/hyphen characters`,
    );
  }
  if (!basename(options.firecrackerBin).includes("firecracker")) {
    throw new JailerConfigError(
      `firecrackerBin file name ${
        JSON.stringify(basename(options.firecrackerBin))
      } must contain "firecracker" (jailer --exec-file requirement)`,
    );
  }
  for (const field of ["uid", "gid"] as const) {
    const value = options[field];
    if (!Number.isInteger(value) || value < 0) {
      throw new JailerConfigError(
        `jailer ${field} must be a non-negative integer, got ${value}`,
      );
    }
  }
  const seen = new Set<string>();
  for (const entry of options.stage ?? []) {
    const jailPath = stagedJailPath(entry);
    try {
      assertNoTraversal(jailPath);
    } catch (err) {
      throw new JailerConfigError((err as Error).message);
    }
    if (seen.has(jailPath)) {
      throw new JailerConfigError(
        `staging collision: two entries map to ${JSON.stringify(jailPath)}`,
      );
    }
    seen.add(jailPath);
  }
}

/** The in-jail path a stage entry lands at. */
export function stagedJailPath(entry: StageEntry): string {
  const raw = entry.jailPath ?? `/${basename(entry.hostPath)}`;
  return raw.startsWith("/") ? raw : `/${raw}`;
}
