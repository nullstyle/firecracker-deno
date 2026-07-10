/**
 * {@linkcode VsockConn}: a host-to-guest vsock connection that is a
 * standard `Deno.Conn` — hand it to anything that speaks `Deno.Conn`.
 *
 * @module
 */

/**
 * A host-initiated vsock connection to a guest port. Structurally a
 * `Deno.Conn` (streams, `read`/`write`, `closeWrite`, `ref`/`unref`,
 * `using` support) over the hybrid-vsock Unix socket, plus the vsock
 * endpoints of the connection.
 */
export interface VsockConn extends Deno.Conn {
  /** The guest port this connection was dialed to. */
  readonly guestPort: number;
  /** The host-side ephemeral port Firecracker assigned (from `OK <port>`). */
  readonly assignedHostPort: number;
}

/** Wrap an established (post-handshake) Unix connection as a VsockConn. */
export function wrapVsockConn(
  inner: Deno.UnixConn,
  guestPort: number,
  assignedHostPort: number,
): VsockConn {
  return new VsockConnImpl(inner, guestPort, assignedHostPort);
}

class VsockConnImpl implements VsockConn {
  readonly guestPort: number;
  readonly assignedHostPort: number;
  #inner: Deno.UnixConn;

  constructor(
    inner: Deno.UnixConn,
    guestPort: number,
    assignedHostPort: number,
  ) {
    this.#inner = inner;
    this.guestPort = guestPort;
    this.assignedHostPort = assignedHostPort;
  }

  get localAddr(): Deno.Addr {
    return this.#inner.localAddr;
  }
  get remoteAddr(): Deno.Addr {
    return this.#inner.remoteAddr;
  }
  get readable(): ReadableStream<Uint8Array<ArrayBuffer>> {
    return this.#inner.readable;
  }
  get writable(): WritableStream<Uint8Array<ArrayBufferLike>> {
    return this.#inner.writable;
  }
  read(p: Uint8Array): Promise<number | null> {
    return this.#inner.read(p);
  }
  write(p: Uint8Array): Promise<number> {
    return this.#inner.write(p);
  }
  closeWrite(): Promise<void> {
    return this.#inner.closeWrite();
  }
  close(): void {
    this.#inner.close();
  }
  ref(): void {
    this.#inner.ref();
  }
  unref(): void {
    this.#inner.unref();
  }
  [Symbol.dispose](): void {
    try {
      this.#inner.close();
    } catch {
      // already closed
    }
  }
}
