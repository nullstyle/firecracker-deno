/**
 * Host-initiated vsock dialing over Firecracker's hybrid Unix-socket vsock.
 *
 * Protocol (see Firecracker's `docs/vsock.md`): connect to the device's
 * `uds_path`, send `CONNECT <guest_port>\n`, await `OK <host_port>\n`. The
 * protocol has **no error frame** — a connection closed before `OK` is the
 * only signal that nothing is listening on that guest port. Because a
 * booting guest commonly isn't listening *yet*, dialing retries with a
 * bounded budget (go-sdk-compatible defaults: 100 ms interval, 20 s total).
 *
 * The `OK` line is read one byte at a time, so payload the guest pipelines
 * right behind the acknowledgement is never swallowed.
 *
 * @module
 */

import { VsockDialError } from "../errors.ts";
import { delay, withDeadline } from "../internal/async.ts";
import { readLineBytewise, writeAll } from "../internal/line_reader.ts";
import type { VsockDialFailureReason } from "../types.ts";
import { type VsockConn, wrapVsockConn } from "./conn.ts";

/** Options for {@linkcode connectVsock}. */
export interface VsockDialOptions {
  /**
   * Total budget across all attempts.
   * @default 20_000
   */
  retryTimeoutMs?: number;
  /**
   * Delay between attempts.
   * @default 100
   */
  retryIntervalMs?: number;
  /**
   * Deadline for the `OK` acknowledgement within one attempt.
   * @default 1_000
   */
  handshakeTimeoutMs?: number;
  /** Abort dialing early (rejects with the signal's reason). */
  signal?: AbortSignal;
}

/**
 * Dial `guestPort` through the vsock device's `udsPath` and return the
 * established connection as a standard `Deno.Conn`.
 *
 * Retryable failures (socket missing, connection refused, guest not
 * listening yet, silent handshake) are retried until the budget runs out;
 * then a {@linkcode VsockDialError} reports the *last* failure reason and
 * the attempt count. A malformed acknowledgement fails immediately — that
 * is a protocol violation, not a timing problem.
 */
export async function connectVsock(
  udsPath: string,
  guestPort: number,
  opts: VsockDialOptions = {},
): Promise<VsockConn> {
  const retryTimeoutMs = opts.retryTimeoutMs ?? 20_000;
  const retryIntervalMs = opts.retryIntervalMs ?? 100;
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 1_000;
  const deadline = performance.now() + retryTimeoutMs;

  let attempts = 0;
  let lastReason: VsockDialFailureReason = "timeout";
  let lastCause: unknown;

  while (true) {
    opts.signal?.throwIfAborted();
    attempts++;

    let conn: Deno.UnixConn | null = null;
    try {
      conn = await Deno.connect({ transport: "unix", path: udsPath });
    } catch (cause) {
      lastCause = cause;
      lastReason = cause instanceof Deno.errors.NotFound
        ? "socket-missing"
        : "connection-refused";
    }

    if (conn !== null) {
      try {
        await writeAll(
          conn,
          new TextEncoder().encode(`CONNECT ${guestPort}\n`),
        );
        // Byte-exact ack read, bounded by the handshake deadline. `OK ` is
        // at most ~16 bytes; 64 is generous.
        const ackPromise = readLineBytewise(conn, 64);
        const raced = await withDeadline(ackPromise, handshakeTimeoutMs);
        if (raced === null) {
          lastReason = "timeout";
          lastCause = undefined;
          // Closing unblocks the pending bytewise read; silence its error.
          ackPromise.catch(() => {});
        } else {
          const ack = raced.done;
          if (ack.kind === "line") {
            const match = /^OK (\d+)$/.exec(ack.line);
            if (match !== null) {
              return wrapVsockConn(conn, guestPort, Number(match[1]));
            }
            conn.close();
            throw new VsockDialError({
              reason: "malformed-ack",
              udsPath,
              port: guestPort,
              attempts,
            });
          }
          if (ack.kind === "overflow") {
            conn.close();
            throw new VsockDialError({
              reason: "malformed-ack",
              udsPath,
              port: guestPort,
              attempts,
            });
          }
          // EOF before OK: the guest isn't listening (yet) — retryable.
          lastReason = "closed-before-ok";
          lastCause = undefined;
        }
      } catch (err) {
        if (err instanceof VsockDialError) throw err;
        lastReason = "connection-refused";
        lastCause = err;
      }
      try {
        conn.close();
      } catch {
        // already closed
      }
    }

    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await delay(Math.min(retryIntervalMs, remaining), opts.signal);
  }

  opts.signal?.throwIfAborted();
  throw new VsockDialError({
    reason: lastReason,
    udsPath,
    port: guestPort,
    attempts,
    cause: lastCause,
  });
}
