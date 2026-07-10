/**
 * Firecracker version compatibility surface.
 *
 * @module
 */

/** The Firecracker version window this library release targets. */
export interface FirecrackerCompat {
  /**
   * The Firecracker release tag the vendored API spec — and therefore the
   * generated types and client surface — is pinned to.
   */
  readonly pinned: string;
  /**
   * The oldest Firecracker version this library supports at runtime. Mirrors
   * Firecracker's own two-minor support window, and never predates v1.14.1
   * (the jailer symlink-hardening fix).
   */
  readonly min: string;
}

/**
 * Compatibility window of this library version.
 *
 * The Firecracker API is semver-governed and changes within a major version
 * are additive, so newer v1.x releases than {@linkcode FirecrackerCompat.pinned}
 * generally work — they just may expose endpoints this client does not
 * cover yet.
 */
export const FIRECRACKER_COMPAT: FirecrackerCompat = {
  pinned: "v1.16.1",
  min: "v1.15.0",
};
