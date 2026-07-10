/**
 * HTTP-over-Unix-domain-socket transport for the Firecracker API.
 *
 * The default {@linkcode UnixHttpTransport} uses Deno's native `fetch` with
 * a Unix-socket proxy client (Deno ≥ 2.4). The {@linkcode ApiTransport}
 * interface is the injection seam for tests and exotic setups.
 *
 * @module
 */

import { TransportError } from "../errors.ts";

/**
 * Minimal transport seam used by `FirecrackerClient`. Implementations must
 * throw {@linkcode TransportError} for connection-level failures and return
 * the raw `Response` otherwise (status handling is the client's job).
 */
export interface ApiTransport {
  /** Perform one HTTP request against the Firecracker API socket. */
  request(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response>;
  /** Release any underlying connections. Idempotent. */
  close(): void;
}

/**
 * The default transport: native `fetch` over a Unix domain socket.
 *
 * Requires `--allow-read` and `--allow-write` on the socket path (and
 * `--allow-net` for the fetch itself).
 */
export class UnixHttpTransport implements ApiTransport {
  /** Path of the Firecracker API Unix socket. */
  readonly socketPath: string;
  #client: Deno.HttpClient;
  #closed = false;

  /** Create a transport whose requests go to `socketPath`. */
  constructor(socketPath: string) {
    this.socketPath = socketPath;
    this.#client = Deno.createHttpClient({
      proxy: { transport: "unix", path: socketPath },
    });
  }

  /** Perform one HTTP request over the Unix socket. */
  async request(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    if (this.#closed) {
      throw new TransportError({
        socketPath: this.socketPath,
        message: `transport is closed (${method} ${path})`,
      });
    }
    try {
      return await fetch(`http://localhost${path}`, {
        method,
        client: this.#client,
        signal: signal ?? null,
        headers: body === undefined
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      const aborted = cause instanceof DOMException &&
        (cause.name === "AbortError" || cause.name === "TimeoutError");
      throw new TransportError({
        socketPath: this.socketPath,
        message: aborted
          ? `${method} ${path} aborted (timeout or caller signal)`
          : `${method} ${path} failed against ${this.socketPath}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        cause,
      });
    }
  }

  /** Close the underlying HTTP client. Idempotent. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#client.close();
  }
}
