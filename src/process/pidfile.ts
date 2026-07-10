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
import { pidAlive } from "../internal/liveness.ts";
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
    if (exit !== null && (exit.code ?? 0) !== 0) {
      throw new JailerConfigError(
        `jailer exited with code ${exit.code} before writing a pidfile` +
          (exit.stderrTail.trim() === ""
            ? ""
            : `; stderr: ${exit.stderrTail.trim()}`),
      );
    }
    const pid = await readPidfile(path);
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

async function readPidfile(path: string): Promise<number | null> {
  try {
    const text = await Deno.readTextFile(path);
    const pid = Number.parseInt(text.trim(), 10);
    // Guard the write-then-exec race: an empty or partial file isn't ready.
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
  readonly pid: number;
  readonly exited: Promise<VmmExit>;

  #exit: VmmExit | null = null;
  #jailerStderr: () => string;

  constructor(
    pid: number,
    opts: { jailerStderr: () => string; pollIntervalMs?: number },
  ) {
    this.pid = pid;
    const jailerStderr = opts.jailerStderr;
    this.#jailerStderr = jailerStderr;
    const pollIntervalMs = opts.pollIntervalMs ?? 100;
    this.exited = (async () => {
      while (pidAlive(pid)) {
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

  get exit(): VmmExit | null {
    return this.#exit;
  }

  stderrTail(): string {
    return this.#jailerStderr();
  }

  stdoutTail(): string {
    return "";
  }

  kill(signal: Deno.Signal): void {
    if (this.#exit !== null) return;
    try {
      Deno.kill(this.pid, signal);
    } catch {
      // already gone
    }
  }
}
