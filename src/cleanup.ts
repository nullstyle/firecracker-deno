/**
 * Idempotent resource reclamation. Every step tolerates "already gone";
 * failures are collected, never thrown mid-pass, and surfaced together as
 * a {@linkcode CleanupError}.
 *
 * @module
 */

import { CleanupError } from "./errors.ts";
import type { CleanupFailure } from "./types.ts";

export interface CleanupStep {
  step: string;
  path?: string;
  run(): Promise<void>;
}

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

export async function runCleanupSteps(
  steps: CleanupStep[],
): Promise<CleanupFailure[]> {
  const failures: CleanupFailure[] = [];
  for (const { step, path, run } of steps) {
    try {
      await run();
    } catch (cause) {
      failures.push({ step, path, cause });
    }
  }
  return failures;
}

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
