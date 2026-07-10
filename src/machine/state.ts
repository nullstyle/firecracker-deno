/**
 * The machine lifecycle state machine: legal transitions, operation gating,
 * and awaitable state changes.
 *
 * @module
 */

import { InvalidStateError, ProcessExitedError } from "../errors.ts";
import { withDeadline } from "../internal/async.ts";
import type { VmmExit, VmState } from "../types.ts";

const TRANSITIONS: Record<VmState, readonly VmState[]> = {
  configured: ["starting", "shutting_down", "exited"],
  // starting → paused: a snapshot restore without resume lands paused.
  starting: ["running", "paused", "configured", "shutting_down", "exited"],
  running: ["paused", "shutting_down", "exited"],
  paused: ["running", "shutting_down", "exited"],
  shutting_down: ["exited"],
  exited: ["cleaned"],
  cleaned: [],
};

const TERMINAL: readonly VmState[] = ["exited", "cleaned"];

/** Tracks the current {@linkcode VmState} and notifies waiters. */
export class LifecycleState {
  #state: VmState = "configured";
  #listeners = new Set<(state: VmState) => void>();
  #lastExit: VmmExit | null = null;

  get state(): VmState {
    return this.#state;
  }

  /** The exit recorded when the state moved to `exited`, if any. */
  get lastExit(): VmmExit | null {
    return this.#lastExit;
  }

  /** Whether the machine has reached a terminal state. */
  get terminal(): boolean {
    return TERMINAL.includes(this.#state);
  }

  /**
   * Assert `operation` is legal now (i.e. the current state is one of
   * `allowed`), else throw {@linkcode InvalidStateError}.
   */
  assert(operation: string, ...allowed: VmState[]): void {
    if (!allowed.includes(this.#state)) {
      throw new InvalidStateError({ state: this.#state, operation });
    }
  }

  /**
   * Move to `to` if the transition table allows it; returns whether the
   * transition happened. Illegal transitions are ignored rather than thrown
   * so racy observers (e.g. the exit watcher after cleanup) stay safe —
   * callers gate user-facing operations with {@linkcode assert} first.
   */
  transition(to: VmState, exit?: VmmExit): boolean {
    if (!TRANSITIONS[this.#state].includes(to)) return false;
    this.#state = to;
    if (exit !== undefined) this.#lastExit = exit;
    for (const listener of [...this.#listeners]) listener(to);
    return true;
  }

  /**
   * Resolve when the machine reaches `target`. Rejects with
   * {@linkcode ProcessExitedError} (or {@linkcode InvalidStateError}) if a
   * terminal state makes `target` unreachable, and with a timeout error if
   * `timeoutMs` elapses first.
   */
  async waitFor(
    target: VmState,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    if (this.#state === target) return;
    const unreachable = () => {
      if (target === "cleaned" || this.#state === target) return null;
      if (this.#state === "exited" || this.#state === "cleaned") {
        return this.#lastExit !== null
          ? new ProcessExitedError({
            exit: this.#lastExit,
            operation: `wait for state "${target}"`,
          })
          : new InvalidStateError({
            state: this.#state,
            operation: `wait for state "${target}"`,
          });
      }
      return null;
    };
    {
      const dead = unreachable();
      if (dead !== null) throw dead;
    }
    const reached = new Promise<void>((resolve, reject) => {
      const listener = (state: VmState) => {
        if (state === target) {
          this.#listeners.delete(listener);
          signal?.removeEventListener("abort", onAbort);
          resolve();
          return;
        }
        const dead = unreachable();
        if (dead !== null) {
          this.#listeners.delete(listener);
          signal?.removeEventListener("abort", onAbort);
          reject(dead);
        }
      };
      const signal = opts.signal;
      const onAbort = () => {
        this.#listeners.delete(listener);
        reject(signal!.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#listeners.add(listener);
    });
    if (opts.timeoutMs === undefined) {
      await reached;
      return;
    }
    const result = await withDeadline(
      reached.then(() => true as const),
      opts.timeoutMs,
    );
    if (result === null) {
      throw new InvalidStateError({
        state: this.#state,
        operation:
          `wait for state "${target}" within ${opts.timeoutMs}ms (timed out)`,
      });
    }
  }
}
