/**
 * Idempotent resource reclamation. Every step tolerates "already gone";
 * failures are collected, never thrown mid-pass, and surfaced together as
 * a {@linkcode CleanupError}.
 *
 * @module
 */

import { CleanupError, type CleanupFailure } from "./errors.ts";

/** One idempotent reclaim step. */
export interface CleanupStep {
  /** Step name for diagnostics, e.g. `"unlink-api-socket"`. */
  step: string;
  /** Filesystem path involved, when applicable. */
  path?: string;
  /** Perform the reclaim. Must tolerate the resource already being gone. */
  run(): Promise<void>;
}

/** A step that removes `path` (optionally recursively), tolerating absence. */
export function removePathStep(
  step: string,
  path: string,
  opts: { recursive?: boolean } = {},
): CleanupStep {
  return {
    step,
    path,
    async run() {
      try {
        await Deno.remove(path, { recursive: opts.recursive ?? false });
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
      }
    },
  };
}

/**
 * Run every step — later steps still run when earlier ones fail — and
 * return the failures (empty when fully clean).
 */
export async function runCleanupSteps(
  steps: CleanupStep[],
): Promise<CleanupFailure[]> {
  const failures: CleanupFailure[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (cause) {
      failures.push({ step: step.step, path: step.path, cause });
    }
  }
  return failures;
}

/**
 * Build the {@linkcode CleanupError} for `failures`, checking which of the
 * named paths (plus any `extraLeaked`) still exist on disk.
 */
export async function cleanupError(
  failures: CleanupFailure[],
  extraLeaked: string[] = [],
): Promise<CleanupError> {
  const leaked: string[] = [...extraLeaked];
  for (const failure of failures) {
    if (failure.path === undefined) continue;
    try {
      await Deno.stat(failure.path);
      leaked.push(failure.path);
    } catch {
      // it's gone after all
    }
  }
  return new CleanupError({ failures, leaked });
}
