/**
 * Supervised VMM process: spawn, output-tail capture, signal delivery, and
 * a single authoritative exit observation.
 *
 * @module
 */

import { RingBuffer } from "../internal/ring_buffer.ts";
import type { VmmExit } from "../types.ts";

interface VmmSpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  tailCapacity?: number;
  stdio?: "capture" | "null";
}

export class VmmProcess {
  readonly pid: number;
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

  get exit(): VmmExit | null {
    return this.#exit;
  }

  stderrTail(): string {
    return this.#exit?.stderrTail ?? this.#stderrRing.tail();
  }

  stdoutTail(): string {
    return this.#stdoutRing.tail();
  }

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
