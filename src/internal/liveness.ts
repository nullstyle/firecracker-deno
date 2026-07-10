/**
 * Internal: process liveness probing for reconcile.
 *
 * @module
 */

/**
 * Signal-0 probe: true if `pid` exists (even if owned by another user).
 * A reaped process is gone; an unreaped zombie still counts as existing.
 */
export function pidAlive(pid: number): boolean {
  try {
    Deno.kill(pid, 0 as unknown as Deno.Signal);
    return true;
  } catch (err) {
    // EPERM means it exists but isn't ours; only ESRCH means gone.
    return !(err instanceof Deno.errors.NotFound);
  }
}

/**
 * Best-effort pid-reuse guard: on Linux, require the process cmdline to
 * mention the record's API socket path before treating the pid as "our"
 * VMM. Returns true when the check is impossible (non-Linux, no access) —
 * reconcile then relies on the caller's `killLive` intent.
 */
export async function pidLooksLikeVmm(
  pid: number,
  apiSocketPath: string,
): Promise<boolean> {
  try {
    const cmdline = await Deno.readTextFile(`/proc/${pid}/cmdline`);
    return cmdline.includes(apiSocketPath);
  } catch {
    return true;
  }
}
