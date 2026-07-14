/**
 * Exit authority for reparented VMMs.
 *
 * With jailer `--daemonize` or `--new-pid-ns`, the process we spawned (the
 * jailer) exits immediately while the real Firecracker lives on as someone
 * else's child. `ChildProcess.status` is a lie in those modes; signal-0
 * liveness polling is authoritative. Exit *codes* are unobservable here — a
 * reparented VMM exit always has `code: null`.
 *
 * @module
 */

import { delay } from "../internal/async.ts";
import {
  pidAlive,
  pidMatchesVmm,
  pidMatchesVmmSync,
} from "../internal/liveness.ts";
import type { VmmExit } from "../types.ts";

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
