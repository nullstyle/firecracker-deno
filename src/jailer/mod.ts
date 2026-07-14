/**
 * Jailer primitives: options + validation, argv building, host↔chroot path
 * math, and chroot staging. The `Machine` layer composes these; they are
 * exported for platforms that need to drive the jailer differently.
 *
 * @module
 */

export { buildJailerArgv } from "./argv.ts";
export { stagedJailPath, validateJailerOptions } from "./options.ts";
export type { JailerOptions, StageEntry } from "./options.ts";
export {
  assertNoTraversal,
  computeJailPaths,
  DEFAULT_CHROOT_BASE,
  hostPathOf,
} from "./paths.ts";
export type { JailPaths } from "./paths.ts";
export { planStaging, stageChroot } from "./stage.ts";
export type { StagingAction } from "./stage.ts";
