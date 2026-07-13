/**
 * Internal: process liveness and identity probing for reconcile and
 * pidfile-based exit authority.
 *
 * @module
 */

// Deno < 2.5 rejects the numeric signal-0 probe with a TypeError
// ("Invalid signal") regardless of pid state; detected once, then the
// SIGCONT fallback is used — harmless to a running VMM, ESRCH on a dead
// pid, EPERM (=> exists) on someone else's.
let zeroProbeWorks: boolean | null = null;

/**
 * Liveness probe: true if `pid` exists (even if owned by another user).
 * A reaped process is gone; an unreaped zombie still counts as existing.
 * Uses signal 0 where the runtime supports it, SIGCONT otherwise.
 */
export function pidAlive(pid: number): boolean {
  if (zeroProbeWorks !== false) {
    try {
      Deno.kill(pid, 0 as unknown as Deno.Signal);
      zeroProbeWorks = true;
      return true;
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        zeroProbeWorks = true;
        return false;
      }
      if (!(err instanceof TypeError)) {
        // EPERM and friends: the pid exists.
        return true;
      }
      zeroProbeWorks = false; // unsupported runtime — fall through
    }
  }
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch (err) {
    return !(err instanceof Deno.errors.NotFound);
  }
}

/**
 * The NUL-delimited `--id <vmId>` sequence as it appears in
 * `/proc/<pid>/cmdline`. Both spawn paths pass `--id`, and unlike socket
 * paths it reads identically inside and outside a chroot — making it the
 * one identity token that works for jailed VMMs too.
 */
export function idCmdlineToken(vmId: string): string {
  return `\0--id\0${vmId}\0`;
}

function readCmdline(pid: number): Promise<string | null> {
  return Deno.readTextFile(`/proc/${pid}/cmdline`).catch(() => null);
}

function readCmdlineSync(pid: number): string | null {
  try {
    return Deno.readTextFileSync(`/proc/${pid}/cmdline`);
  } catch {
    return null;
  }
}

function matches(cmdline: string, tokens: string[]): boolean {
  return tokens.some((t) => t !== "" && cmdline.includes(t));
}

/**
 * Best-effort pid-reuse guard: on Linux, require the process cmdline to
 * mention one of `tokens` (an {@linkcode idCmdlineToken} or a socket path)
 * before treating the pid as "our" VMM. Returns true when the check is
 * impossible (non-Linux, no access) — callers then rely on plain liveness.
 */
export async function pidMatchesVmm(
  pid: number,
  tokens: string[],
): Promise<boolean> {
  const cmdline = await readCmdline(pid);
  return cmdline === null ? true : matches(cmdline, tokens);
}

/** Synchronous variant of {@linkcode pidMatchesVmm} (for signal paths). */
export function pidMatchesVmmSync(pid: number, tokens: string[]): boolean {
  const cmdline = readCmdlineSync(pid);
  return cmdline === null ? true : matches(cmdline, tokens);
}

/**
 * Strict identity probe for adoption. Unlike {@linkcode pidMatchesVmm},
 * an unreadable cmdline is reported as `"unverifiable"` rather than
 * treated as a match: before handing out a kill-capable handle to a pid
 * we did not spawn, identity must be *positively* established, not merely
 * not-disproven. `"unverifiable"` covers non-Linux (no `/proc`), hidepid
 * mounts, permission mismatches — and pids that died mid-probe.
 */
export async function pidIdentity(
  pid: number,
  tokens: string[],
): Promise<"match" | "mismatch" | "unverifiable"> {
  const cmdline = await readCmdline(pid);
  if (cmdline === null) return "unverifiable";
  return matches(cmdline, tokens) ? "match" : "mismatch";
}

/**
 * The process start time from `/proc/<pid>/stat` (field 22), as an opaque
 * token compared only for equality: same pid + different start time means
 * the pid was recycled by a different process. Null when unreadable
 * (non-Linux, process gone, no access).
 */
export async function readPidStartTime(pid: number): Promise<string | null> {
  try {
    const stat = await Deno.readTextFile(`/proc/${pid}/stat`);
    // comm (field 2) may contain spaces and parens; fields 3+ follow the
    // *last* ")", so starttime (field 22 overall) is index 19 after it.
    const token = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19];
    return token === undefined || token === "" ? null : token;
  } catch {
    return null;
  }
}

/**
 * Linux best-effort orphan finder: scan `/proc` for a live process (other
 * than ourselves, and not in `exclude`) whose cmdline mentions one of
 * `tokens`. Returns null when nothing matches or `/proc` is unavailable
 * (non-Linux).
 */
export async function findVmmPidByCmdline(
  tokens: string[],
  exclude: ReadonlySet<number> = new Set(),
): Promise<number | null> {
  try {
    for await (const entry of Deno.readDir("/proc")) {
      if (!/^\d+$/.test(entry.name)) continue;
      const pid = Number(entry.name);
      if (pid === Deno.pid || exclude.has(pid)) continue;
      const cmdline = await readCmdline(pid);
      if (cmdline !== null && matches(cmdline, tokens)) return pid;
    }
  } catch {
    // no /proc here
  }
  return null;
}
