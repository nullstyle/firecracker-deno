/**
 * Guest-initiated vsock listening.
 *
 * For guest→host connections, Firecracker connects to a host Unix socket
 * named `<uds_path>_<port>` — the **host** must create and listen on it
 * before the guest dials `<port>`, and the host owns the socket file's
 * lifecycle (Firecracker never creates or removes it). Guest-initiated
 * streams carry no handshake: accepted connections are plain byte streams.
 *
 * @module
 */

/**
 * A listener for guest-initiated vsock connections to one port. Iterate it
 * (`for await`) or call {@linkcode VsockListener.accept}; dispose with
 * `await using` to close and unlink the socket file.
 */
export interface VsockListener
  extends AsyncIterable<Deno.Conn>, AsyncDisposable {
  /** The bound socket file: `` `${udsPath}_${port}` `` — created and unlinked by this listener. */
  readonly path: string;
  /** The guest-visible port this listener serves. */
  readonly port: number;
  /** Accept the next guest-initiated connection. */
  accept(): Promise<Deno.Conn>;
  /** Stop accepting. Idempotent. (The socket file is unlinked on dispose.) */
  close(): void;
}

/**
 * Bind the host-side listener for guest-initiated connections to `port`
 * on the vsock device rooted at `udsPath`.
 *
 * Must be called before the guest connects — Firecracker fails the guest's
 * connect if the socket file is missing. Requires `--allow-read` and
 * `--allow-write` on the socket path.
 */
export function listenVsock(udsPath: string, port: number): VsockListener {
  const path = `${udsPath}_${port}`;
  const inner = Deno.listen({ transport: "unix", path });
  const nativeClose = inner.close.bind(inner);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      nativeClose();
    } catch {
      // already closed
    }
  };
  const dispose = async () => {
    close();
    try {
      await Deno.remove(path);
    } catch {
      // already gone
    }
  };

  Object.defineProperties(inner, {
    path: { value: path, enumerable: true },
    port: { value: port, enumerable: true },
    close: { value: close },
    [Symbol.asyncDispose]: { value: dispose },
  });
  return inner as unknown as VsockListener;
}
