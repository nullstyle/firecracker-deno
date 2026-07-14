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
import type { VmmProcess } from "./supervisor.ts";

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

export async function tryReadPidfile(path: string): Promise<number | null> {
  try {
    const text = await Deno.readTextFile(path);
    const pid = Number.parseInt(text.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export class ReparentedVmm {
  readonly pid: number;
  readonly exited: Promise<VmmExit>;

  #exit: VmmExit | null = null;
  #jailerStderr: () => string;
  #identityTokens: string[];

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
