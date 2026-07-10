import { assertEquals } from "@std/assert";
import { RingBuffer } from "../../src/internal/ring_buffer.ts";

const enc = new TextEncoder();

Deno.test("keeps everything under capacity", () => {
  const ring = new RingBuffer(16);
  ring.push(enc.encode("hello "));
  ring.push(enc.encode("world"));
  assertEquals(ring.tail(), "hello world");
});

Deno.test("keeps only the tail once capacity is exceeded", () => {
  const ring = new RingBuffer(8);
  ring.push(enc.encode("0123456789"));
  assertEquals(ring.tail(), "23456789");
  ring.push(enc.encode("AB"));
  assertEquals(ring.tail(), "456789AB");
});

Deno.test("single chunk larger than capacity keeps its tail", () => {
  const ring = new RingBuffer(4);
  ring.push(enc.encode("abcdefgh"));
  assertEquals(ring.tail(), "efgh");
});

Deno.test("empty buffer yields empty tail", () => {
  assertEquals(new RingBuffer(4).tail(), "");
});
