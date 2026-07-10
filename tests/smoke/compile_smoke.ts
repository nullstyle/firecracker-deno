/**
 * Compiled-binary smoke test: exercises the KVM-free surface end-to-end so
 * CI can prove the library works under `deno compile` (downstream consumers
 * ship compiled binaries).
 *
 * This is a self-contained program, not a `Deno.test` file:
 *
 * ```sh
 * deno compile -A --output smoke-bin tests/smoke/compile_smoke.ts && ./smoke-bin
 * ```
 *
 * Prints exactly `SMOKE OK` and exits 0 on success; prints the error and
 * exits 1 on failure.
 */

import { FirecrackerClient } from "../../src/api/mod.ts";
import { connectVsock } from "../../src/vsock/mod.ts";
import { FakeFirecracker } from "../../testing/mod.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function writeAll(conn: Deno.Conn, bytes: Uint8Array): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    written += await conn.write(bytes.subarray(written));
  }
}

async function readN(conn: Deno.Conn, n: number): Promise<string> {
  const buf = new Uint8Array(n);
  let got = 0;
  while (got < n) {
    const read = await conn.read(buf.subarray(got));
    if (read === null) break;
    got += read;
  }
  return new TextDecoder().decode(buf.subarray(0, got));
}

async function main(): Promise<void> {
  await using fake = await FakeFirecracker.start();
  using client = new FirecrackerClient({ socketPath: fake.socketPath });

  await client.waitReady();
  await client.putBootSource({ kernel_image_path: "/vmlinux" });
  await client.putVsock({ guest_cid: 3, uds_path: fake.vsockUdsPath });

  // Echo-once guest: read one chunk, write it back, hang up.
  fake.onVsockPort(5000, async (conn) => {
    try {
      const buf = new Uint8Array(256);
      const n = await conn.read(buf);
      if (n !== null) await writeAll(conn, buf.subarray(0, n));
    } finally {
      conn.close();
    }
  });

  await client.instanceStart();
  const info = await client.getInstanceInfo();
  assert(
    info.state === "Running",
    `expected instance state "Running", got "${info.state}"`,
  );

  using conn = await connectVsock(fake.vsockUdsPath, 5000);
  await writeAll(conn, new TextEncoder().encode("ping"));
  const echoed = await readN(conn, 4);
  assert(echoed === "ping", `expected echo "ping", got "${echoed}"`);
}

try {
  await main();
  console.log("SMOKE OK");
} catch (err) {
  console.error(err);
  Deno.exit(1);
}
