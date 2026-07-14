/**
 * Internal live-machine resource manifests and cleanup planning.
 *
 * A manifest is the single source for a machine's public paths, journal
 * record, listener ownership, and disposal steps. It is deliberately distinct
 * from the persisted {@linkcode JailRecord}: live listeners are handles, while
 * a record stores only their paths.
 *
 * @module
 */

import { isAbsolute, relative } from "@std/path";
import { type CleanupStep, removePathStep } from "../cleanup.ts";

/** A live listener whose socket must be closed before filesystem reclaim. */
export interface ResourceListener extends AsyncDisposable {
  readonly path: string;
}

/** Every filesystem resource owned by, or explicitly created for, a machine. */
export interface MachineResources {
  apiSocketPath: string;
  stateDir: string;
  ownsStateDir: boolean;
  vsockUdsPath?: string;
  vsockListeners: Set<string | ResourceListener>;
  pidfilePath?: string;
  chrootDir?: string;
  cgroupPath?: string;
}

/** The listener paths represented by a resource manifest. */
export function listenerPaths(resources: MachineResources): string[] {
  return [...resources.vsockListeners].map((listener) =>
    typeof listener === "string" ? listener : listener.path
  );
}

/**
 * Build cleanup in dependency order: close live listeners, remove owned
 * roots, unlink legacy resources outside those roots, and remove cgroups last.
 */
export function cleanupStepsForResources(
  resources: MachineResources,
): CleanupStep[] {
  const steps: CleanupStep[] = [];
  for (const listener of resources.vsockListeners) {
    if (typeof listener === "string") continue;
    steps.push({
      step: "close-vsock-listener",
      path: listener.path,
      async run() {
        await listener[Symbol.asyncDispose]();
      },
    });
  }

  const roots: string[] = [];
  const addPath = (
    step: string,
    path: string | undefined,
    recursive = false,
  ) => {
    if (path === undefined || roots.some((root) => containsPath(root, path))) {
      return;
    }
    if (recursive) roots.push(path);
    steps.push(removePathStep(step, path, { recursive }));
  };
  addPath("remove-chroot", resources.chrootDir, true);
  if (resources.ownsStateDir) {
    addPath("remove-state-dir", resources.stateDir, true);
  }
  addPath("unlink-api-socket", resources.apiSocketPath);
  addPath("unlink-vsock-uds", resources.vsockUdsPath);
  for (const path of listenerPaths(resources)) {
    addPath("unlink-vsock-listener", path);
  }
  addPath("unlink-pidfile", resources.pidfilePath);
  if (resources.cgroupPath !== undefined) {
    steps.push(removePathStep("remove-cgroup", resources.cgroupPath));
  }
  return steps;
}

function containsPath(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" ||
    (child !== ".." && !child.startsWith("../") && !isAbsolute(child));
}
