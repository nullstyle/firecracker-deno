/**
 * Pidfile-based exit authority for reparented VMMs.
 *
 * With jailer `--daemonize` or `--new-pid-ns`, the process we spawned (the
 * jailer) exits immediately while the real Firecracker lives on as someone
 * else's child. `ChildProcess.status` is a lie in those modes; the truth
 * is the pidfile Firecracker writes at `<chroot>/root/<exec>.pid`, plus
 * signal-0 liveness polling. Exit *codes* are unobservable here — a
 * pidfile-authority {@linkcode VmmExit} always has `code: null`.
 *
 * @module
 */

import { JailerConfigError } from "../errors.ts";
import { delay } from "../internal/async.ts";
import {
  pidAlive,
  pidMatchesVmm,
  pidMatchesVmmSync,
} from "../internal/liveness.ts";
import type { VmmExit } from "../types.ts";
import type { VmmHandle, VmmProcess } from "./supervisor.ts";

/**
 * Wait for the pidfile to appear and contain a pid.
 *
 * `jailer` is the spawned jailer process: if it exits non-zero before the
 * pidfile shows up, that failure (with its stderr) is the real error. A
 * zero exit is expected — that's the daemonize/new-pid-ns contract.
 */
export async function waitForPidfile(
  path: string,
  opts: {
    jailer: VmmProcess;
    timeoutMs?: number;
    intervalMs?: number;
    signal?: AbortSignal;
  },
): Promise<number> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const intervalMs = opts.intervalMs ?? 25;
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    opts.signal?.throwIfAborted();
    const exit = opts.jailer.exit;
    // Only a clean zero exit is the expected daemonize/new-pid-ns handoff;
    // a non-zero code OR a signal death means the jailer failed — fail fast.
    if (exit !== null && (exit.signal !== null || (exit.code ?? 0) !== 0)) {
      throw new JailerConfigError(
        `jailer exited (${
          exit.signal !== null ? `signal ${exit.signal}` : `code ${exit.code}`
        }) before writing a pidfile` +
          (exit.stderrTail.trim() === ""
            ? ""
            : `; stderr: ${exit.stderrTail.trim()}`),
      );
    }
    const pid = await tryReadPidfile(path);
    if (pid !== null) return pid;
    await delay(intervalMs, opts.signal);
  }
  throw new JailerConfigError(
    `pidfile ${path} did not appear within ${timeoutMs}ms` +
      (opts.jailer.stderrTail().trim() === ""
        ? ""
        : `; jailer stderr: ${opts.jailer.stderrTail().trim()}`),
  );
}

/**
 * Read a pid from `path`, or null when the file is missing, empty, or not
 * yet fully written (the write-then-exec race).
 */
export async function tryReadPidfile(path: string): Promise<number | null> {
  try {
    const text = await Deno.readTextFile(path);
    const pid = Number.parseInt(text.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Exit authority for a VMM that is not our child: polls signal-0 liveness.
 * `kill` goes straight to the pid; `stderrTail` reports what the *jailer*
 * printed before detaching (Firecracker's own stderr is unobservable in
 * these modes — use the `logger` device).
 */
export class ReparentedVmm implements VmmHandle {
  /** The reparented VMM's pid, read from the pidfile. */
  readonly pid: number;
  /** Resolves when liveness polling observes the pid gone. Never rejects. */
  readonly exited: Promise<VmmExit>;

  #exit: VmmExit | null = null;
  #jailerStderr: () => string;
  #identityTokens: string[];

  /**
   * Watch `pid`; `jailerStderr` supplies diagnostics captured pre-detach.
   * `identityToken` (e.g. the VMM's `--id` cmdline token) guards against
   * pid reuse: once the pid no longer looks like our VMM, it is treated as
   * exited, and `kill` refuses to signal the recycled pid. On systems
   * without `/proc` the guard degrades to plain liveness.
   */
  constructor(
    pid: number,
    opts: {
      jailerStderr: () => string;
      pollIntervalMs?: number;
      identityToken?: string;
    },
  ) {
    this.pid = pid;
    const jailerStderr = opts.jailerStderr;
    this.#jailerStderr = jailerStderr;
    const tokens = opts.identityToken === undefined ? [] : [opts.identityToken];
    this.#identityTokens = tokens;
    const pollIntervalMs = opts.pollIntervalMs ?? 100;
    this.exited = (async () => {
      while (
        pidAlive(pid) &&
        (tokens.length === 0 || await pidMatchesVmm(pid, tokens))
      ) {
        await delay(pollIntervalMs);
      }
      this.#exit = {
        code: null,
        signal: null,
        observedVia: "pidfile-poll",
        stderrTail: jailerStderr(),
      };
      return this.#exit;
    })();
  }

  /** The exit, if liveness polling has already observed it. */
  get exit(): VmmExit | null {
    return this.#exit;
  }

  /** What the jailer printed before detaching (the VMM's own stderr is unobservable). */
  stderrTail(): string {
    return this.#jailerStderr();
  }

  /** Always empty: a reparented VMM's stdout is unobservable. */
  stdoutTail(): string {
    return "";
  }

  /**
   * Signal the pid directly; already-gone processes are not an error, and
   * a pid that no longer looks like our VMM (pid reuse) is left alone.
   */
  kill(signal: Deno.Signal): void {
    if (this.#exit !== null) return;
    if (
      this.#identityTokens.length > 0 &&
      !pidMatchesVmmSync(this.pid, this.#identityTokens)
    ) {
      return;
    }
    try {
      Deno.kill(this.pid, signal);
    } catch {
      // already gone
    }
  }
}
