/**
 * Internal async utilities.
 *
 * @module
 */

/** Sleep `ms`, rejecting with the signal's reason if aborted first. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Await `promise` for at most `ms`. Resolves `{ done: value }` if it
 * settles in time, `null` otherwise. The underlying promise keeps running;
 * the timer is always cleared.
 */
export async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ done: T } | null> {
  let id: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    id = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise.then((done) => ({ done })), timeout]);
  } finally {
    clearTimeout(id);
  }
}
