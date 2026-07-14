/**
 * Firecracker hybrid-vsock as standard Deno networking: dial guest ports
 * with {@linkcode connectVsock} (a `Deno.Conn` comes back), accept
 * guest-initiated connections with {@linkcode listenVsock}.
 *
 * Usable standalone against any Firecracker vsock Unix socket — no
 * `Machine` required.
 *
 * @module
 */

export type { VsockConn } from "./conn.ts";
export { connectVsock, type VsockDialOptions } from "./dial.ts";
export { listenVsock, type VsockListener } from "./listen.ts";
