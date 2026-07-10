/**
 * Internal: bounded byte ring buffer for capturing process output tails.
 *
 * @module
 */

/** Keeps the last `capacity` bytes pushed into it. */
export class RingBuffer {
  #buf: Uint8Array;
  #len = 0;
  #start = 0;

  constructor(readonly capacity: number) {
    this.#buf = new Uint8Array(capacity);
  }

  push(chunk: Uint8Array): void {
    if (chunk.length >= this.capacity) {
      this.#buf.set(chunk.subarray(chunk.length - this.capacity));
      this.#start = 0;
      this.#len = this.capacity;
      return;
    }
    for (const byte of chunk) {
      const idx = (this.#start + this.#len) % this.capacity;
      this.#buf[idx] = byte;
      if (this.#len < this.capacity) {
        this.#len++;
      } else {
        this.#start = (this.#start + 1) % this.capacity;
      }
    }
  }

  /** The buffered tail, decoded as UTF-8 (lossy at a truncated boundary). */
  tail(): string {
    const out = new Uint8Array(this.#len);
    for (let i = 0; i < this.#len; i++) {
      out[i] = this.#buf[(this.#start + i) % this.capacity];
    }
    return new TextDecoder().decode(out);
  }
}
