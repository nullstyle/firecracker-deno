/**
 * Supervised VMM process: spawn, output-tail capture, signal delivery, and
 * a single authoritative exit observation.
 *
 * @module
 */

import { RingBuffer } from "../internal/ring_buffer.ts";
import type { VmmExit } from "../types.ts";

/** Options for {@linkcode VmmProcess.spawn}. */
export interface VmmSpawnOptions {
  /** Executable to run (firecracker, jailer, or a test double). */
  command: string;
  /** Full argv (not including the command itself). */
  args: string[];
  /** Working directory for the child. */
  cwd?: string;
  /** Extra environment variables for the child. */
  env?: Record<string, string>;
  /** Ring-buffer capacity per stream, in bytes. @default 8192 */
  tailCapacity?: number;
}

/**
 * A spawned VMM process whose exit is observed exactly once.
 *
 * Both stdout (the guest serial console, when `console=ttyS0`) and stderr
 * (Firecracker's own errors) are continuously drained into bounded ring
 * buffers — an undrained pipe would eventually block the VMM.
 */
export class VmmProcess {
  /** PID of the direct child. */
  readonly pid: number;
  /**
   * Resolves exactly once with how the process exited. Never rejects.
   * The `stderrTail` snapshot is taken after both output streams close.
   */
  readonly exited: Promise<VmmExit>;

  #child: Deno.ChildProcess;
  #stderrRing: RingBuffer;
  #stdoutRing: RingBuffer;
  #exit: VmmExit | null = null;

  private constructor(child: Deno.ChildProcess, tailCapacity: number) {
    this.#child = child;
    this.pid = child.pid;
    const stderrRing = new RingBuffer(tailCapacity);
    const stdoutRing = new RingBuffer(tailCapacity);
    this.#stderrRing = stderrRing;
    this.#stdoutRing = stdoutRing;
    const stderrDone = drain(child.stderr, stderrRing);
    const stdoutDone = drain(child.stdout, stdoutRing);
    this.exited = (async () => {
      const status = await child.status;
      await Promise.allSettled([stderrDone, stdoutDone]);
      this.#exit = {
        code: status.signal === null ? status.code : null,
        signal: status.signal,
        observedVia: "child-status",
        stderrTail: stderrRing.tail(),
      };
      return this.#exit;
    })();
  }

  /** Spawn a process with piped, continuously-drained output. */
  static spawn(options: VmmSpawnOptions): VmmProcess {
    const child = new Deno.Command(options.command, {
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    return new VmmProcess(child, options.tailCapacity ?? 8192);
  }

  /** The exit, if the process has already been observed to exit. */
  get exit(): VmmExit | null {
    return this.#exit;
  }

  /** Current stderr tail (Firecracker's own errors). */
  stderrTail(): string {
    return this.#exit?.stderrTail ?? this.#stderrRing.tail();
  }

  /** Current stdout tail (guest serial console with `console=ttyS0`). */
  stdoutTail(): string {
    return this.#stdoutRing.tail();
  }

  /**
   * Deliver a signal. A process that already exited is not an error —
   * signaling races exit by nature, so that case is swallowed.
   */
  kill(signal: Deno.Signal): void {
    if (this.#exit !== null) return;
    try {
      this.#child.kill(signal);
    } catch {
      // exited between the check and the kill
    }
  }
}

async function drain(
  stream: ReadableStream<Uint8Array>,
  ring: RingBuffer,
): Promise<void> {
  try {
    for await (const chunk of stream) {
      ring.push(chunk);
    }
  } catch {
    // stream errored on process teardown — the tail so far still stands
  }
}
