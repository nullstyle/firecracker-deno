import { assertEquals } from "@std/assert";
import {
  type ByteReader,
  readLineBytewise,
} from "../../src/internal/line_reader.ts";

/** Reader over a fixed byte string, tracking how much was consumed. */
class ScriptedReader implements ByteReader {
  #data: Uint8Array;
  consumed = 0;

  constructor(text: string) {
    this.#data = new TextEncoder().encode(text);
  }

  read(p: Uint8Array): Promise<number | null> {
    if (this.consumed >= this.#data.length) return Promise.resolve(null);
    const n = Math.min(p.length, this.#data.length - this.consumed);
    p.set(this.#data.subarray(this.consumed, this.consumed + n));
    this.consumed += n;
    return Promise.resolve(n);
  }

  remaining(): string {
    return new TextDecoder().decode(this.#data.subarray(this.consumed));
  }
}

Deno.test("reads a line and consumes exactly through the newline", async () => {
  const reader = new ScriptedReader("OK 1000000\npayload-right-behind");
  const result = await readLineBytewise(reader, 64);
  assertEquals(result, { kind: "line", line: "OK 1000000" });
  assertEquals(reader.remaining(), "payload-right-behind");
});

Deno.test("returns eof when the stream closes before a newline", async () => {
  const reader = new ScriptedReader("OK 10000");
  assertEquals(await readLineBytewise(reader, 64), { kind: "eof" });
});

Deno.test("returns eof immediately on an empty stream", async () => {
  const reader = new ScriptedReader("");
  assertEquals(await readLineBytewise(reader, 64), { kind: "eof" });
});

Deno.test("returns overflow when no newline appears within maxLen", async () => {
  const reader = new ScriptedReader("X".repeat(100) + "\n");
  assertEquals(await readLineBytewise(reader, 64), { kind: "overflow" });
});

Deno.test("empty line is valid", async () => {
  const reader = new ScriptedReader("\nrest");
  assertEquals(await readLineBytewise(reader, 64), { kind: "line", line: "" });
  assertEquals(reader.remaining(), "rest");
});
