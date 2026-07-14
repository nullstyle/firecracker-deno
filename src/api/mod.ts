/**
 * The Firecracker API client layer: {@linkcode FirecrackerClient} (one typed
 * method per endpoint), the {@linkcode ApiTransport} seam with its default
 * HTTP-over-UDS implementation, and the full typed API surface.
 *
 * This layer has zero opinions — no process management, no config
 * sequencing. See the package root for the supervised `Machine` layer.
 *
 * @module
 */

export {
  FirecrackerClient,
  type FirecrackerClientOptions,
  type RequestOptions,
  type WaitReadyOptions,
} from "./client.ts";
export { type ApiTransport, UnixHttpTransport } from "./transport.ts";
export type * from "./types.ts";
