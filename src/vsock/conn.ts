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
  Object.defineProperties(inner, {
    guestPort: { value: guestPort, enumerable: true },
    assignedHostPort: { value: assignedHostPort, enumerable: true },
  });
  return inner as VsockConn;
}
