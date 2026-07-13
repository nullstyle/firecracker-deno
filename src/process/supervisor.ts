/**
 * Supervised VMM process: spawn, output-tail capture, signal delivery, and
 * a single authoritative exit observation.
 *
 * @module
 */

import { RingBuffer } from "../internal/ring_buffer.ts";
import type { VmmExit } from "../types.ts";

/**
 * What the machine layer needs from a VMM, regardless of how it is
 * observed: a direct child ({@linkcode VmmProcess}, child-status
 * authority) or a reparented process (`ReparentedVmm`, pidfile-poll
 * authority).
 */
export interface VmmHandle {
  /** Authoritative VMM pid. */
  readonly pid: number;
  /** Resolves exactly once with the observed exit. Never rejects. */
  readonly exited: Promise<VmmExit>;
  /** The exit, if already observed. */
  readonly exit: VmmExit | null;
  /** Deliver a signal; a process that already exited is not an error. */
  kill(signal: Deno.Signal): void;
  /** Captured stderr tail (empty when unobservable). */
  stderrTail(): string;
  /** Captured stdout tail (guest console; empty when unobservable). */
  stdoutTail(): string;
}

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
  /**
   * What to do with the child's stdout/stderr: `"capture"` (default)
   * pipes them into the in-memory tails; `"null"` discards them at spawn
   * time. Discarding is what lets the process survive this supervisor's
   * death — a pipe whose reader is gone wedges Firecracker on its next
   * write (see `Machine.adopt`).
   */
  stdio?: "capture" | "null";
}

/**
 * A spawned VMM process whose exit is observed exactly once.
 *
 * Both stdout (the guest serial console, when `console=ttyS0`) and stderr
 * (Firecracker's own errors) are continuously drained into bounded ring
 * buffers — an undrained pipe would eventually block the VMM.
 */
export class VmmProcess implements VmmHandle {
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

  private constructor(
    child: Deno.ChildProcess,
    tailCapacity: number,
    captured: boolean,
  ) {
    this.#child = child;
    this.pid = child.pid;
    const stderrRing = new RingBuffer(tailCapacity);
    const stdoutRing = new RingBuffer(tailCapacity);
    this.#stderrRing = stderrRing;
    this.#stdoutRing = stdoutRing;
    const stderrDone = captured ? drain(child.stderr, stderrRing) : undefined;
    const stdoutDone = captured ? drain(child.stdout, stdoutRing) : undefined;
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

  /** Spawn a process with drained-into-tails (or discarded) output. */
  static spawn(options: VmmSpawnOptions): VmmProcess {
    const captured = options.stdio !== "null";
    const child = new Deno.Command(options.command, {
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      stdin: "null",
      stdout: captured ? "piped" : "null",
      stderr: captured ? "piped" : "null",
    }).spawn();
    return new VmmProcess(child, options.tailCapacity ?? 8192, captured);
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
