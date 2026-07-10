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

export * from "./client.ts";
export * from "./transport.ts";
export * from "./types.ts";
