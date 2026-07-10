/**
 * Chroot staging: create the jail directory tree with hardened
 * permissions and place resources (kernel, rootfs, …) inside it.
 *
 * Hardening (jailer symlink-attack class, fixed upstream in v1.13.2 /
 * v1.14.1): the chroot base and exec dirs are created `0700`, and a
 * **pre-existing jail root is refused** — a stale or attacker-planted
 * `<base>/<exec>/<id>` cannot be silently adopted. Reclaim stale jails
 * with `reconcile()` (or remove them) first.
 *
 * @module
 */

import { dirname } from "@std/path";
import { JailerConfigError } from "../errors.ts";
import {
  type JailerOptions,
  stagedJailPath,
  type StageEntry,
} from "./options.ts";
import { hostPathOf, type JailPaths } from "./paths.ts";

/** One planned staging action (pure output of {@linkcode planStaging}). */
export interface StagingAction {
  /** Source file on the host. */
  hostPath: string;
  /** In-jail path the file appears at. */
  jailPath: string;
  /** Host-side destination under the chroot root. */
  destPath: string;
  /** How the file is placed (hardlink falls back to copy across devices). */
  mode: "hardlink" | "copy";
  /** chmod applied to the staged file. */
  chmod: number;
}

/** Compute the staging actions for `entries` (validation already done). */
export function planStaging(
  paths: JailPaths,
  entries: StageEntry[],
): StagingAction[] {
  return entries.map((entry) => {
    const jailPath = stagedJailPath(entry);
    return {
      hostPath: entry.hostPath,
      jailPath,
      destPath: hostPathOf(paths, jailPath),
      mode: entry.mode ?? "hardlink",
      chmod: entry.readWrite === true ? 0o600 : 0o400,
    };
  });
}

/**
 * Create the hardened jail directory tree and execute the staging plan.
 * Requires root (chown to the jail uid/gid). Throws
 * {@linkcode JailerConfigError} if the jail root already exists.
 */
export async function stageChroot(
  paths: JailPaths,
  options: JailerOptions,
): Promise<StagingAction[]> {
  // Base dirs: 0700, created if missing (mkdir mode has no effect on
  // already-existing dirs, which is fine — we only harden what we create).
  await Deno.mkdir(paths.chrootBase, { recursive: true, mode: 0o700 })
    .catch(ignoreAlreadyExists);
  await Deno.mkdir(`${paths.chrootBase}/${paths.execName}`, { mode: 0o700 })
    .catch(ignoreAlreadyExists);

  // The per-machine jail root must be fresh.
  if (await exists(paths.jailRoot)) {
    throw new JailerConfigError(
      `jail root ${paths.jailRoot} already exists — a stale or foreign jail ` +
        `must be reclaimed (reconcile()) or removed before reusing id ${
          JSON.stringify(paths.id)
        }`,
    );
  }
  await Deno.mkdir(paths.jailRoot, { mode: 0o700 });
  await Deno.mkdir(paths.chrootRoot, { mode: 0o755 });

  const plan = planStaging(paths, options.stage ?? []);
  for (const action of plan) {
    await Deno.mkdir(dirname(action.destPath), { recursive: true })
      .catch(ignoreAlreadyExists);
    if (action.mode === "hardlink") {
      try {
        await Deno.link(action.hostPath, action.destPath);
      } catch {
        // cross-device or unsupported — fall back to a copy
        await Deno.copyFile(action.hostPath, action.destPath);
      }
    } else {
      await Deno.copyFile(action.hostPath, action.destPath);
    }
    await Deno.chmod(action.destPath, action.chmod);
    try {
      await Deno.chown(action.destPath, options.uid, options.gid);
    } catch (err) {
      throw new JailerConfigError(
        `cannot chown ${action.destPath} to ${options.uid}:${options.gid} ` +
          `(staging requires root): ${(err as Error).message}`,
        { cause: err },
      );
    }
  }
  return plan;
}

function ignoreAlreadyExists(err: unknown): void {
  if (!(err instanceof Deno.errors.AlreadyExists)) throw err;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}
