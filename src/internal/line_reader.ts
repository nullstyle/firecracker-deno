/**
 * Internal: byte-exact line reading for the hybrid-vsock handshake.
 *
 * Reads one byte at a time so nothing past the terminating `\n` is ever
 * consumed — bytes the peer sends after the handshake line (e.g. payload
 * pipelined right behind `OK <port>\n`) stay in the socket buffer for the
 * caller.
 *
 * @module
 */

/** Minimal reader shape (satisfied by `Deno.Conn`). */
export interface ByteReader {
  read(p: Uint8Array): Promise<number | null>;
}

/** Outcome of {@linkcode readLineBytewise}. */
export type LineResult =
  | { kind: "line"; line: string }
  | { kind: "eof" }
  | { kind: "overflow" };

/**
 * Read a single `\n`-terminated line (the `\n` is consumed but not
 * returned), never consuming any byte past it.
 *
 * Returns `{ kind: "eof" }` if the stream ends before a newline, and
 * `{ kind: "overflow" }` if no newline appears within `maxLen` bytes.
 */
export async function readLineBytewise(
  reader: ByteReader,
  maxLen: number,
): Promise<LineResult> {
  const buf = new Uint8Array(maxLen);
  let len = 0;
  const one = new Uint8Array(1);
  while (len < maxLen) {
    const n = await reader.read(one);
    if (n === null) return { kind: "eof" };
    if (n === 0) continue;
    if (one[0] === 0x0a) {
      return {
        kind: "line",
        line: new TextDecoder().decode(buf.subarray(0, len)),
      };
    }
    buf[len++] = one[0];
  }
  return { kind: "overflow" };
}

/** Write all of `data` to `writer`, looping over short writes. */
export async function writeAll(
  writer: { write(p: Uint8Array): Promise<number> },
  data: Uint8Array,
): Promise<void> {
  let written = 0;
  while (written < data.length) {
    written += await writer.write(data.subarray(written));
  }
}
