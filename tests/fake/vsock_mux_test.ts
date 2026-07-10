import { assert, assertEquals } from "@std/assert";
import { FirecrackerClient } from "../../mod.ts";
import { readLineBytewise, writeAll } from "../../src/internal/line_reader.ts";
import { FakeFirecracker } from "../../testing/mod.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function readN(conn: Deno.Conn, n: number): Promise<string> {
  const buf = new Uint8Array(n);
  let got = 0;
  while (got < n) {
    const read = await conn.read(buf.subarray(got));
    if (read === null) break;
    got += read;
  }
  return decoder.decode(buf.subarray(0, got));
}

async function bootedFakeWithEcho(): Promise<FakeFirecracker> {
  const fake = await FakeFirecracker.start();
  using client = new FirecrackerClient({ socketPath: fake.socketPath });
  await client.putBootSource({ kernel_image_path: "/vmlinux" });
  await client.putVsock({ guest_cid: 3, uds_path: fake.vsockUdsPath });
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
  return fake;
}

Deno.test("handshake: OK <port> then payload echo, even when pipelined", async () => {
  await using fake = await bootedFakeWithEcho();
  const conn = await Deno.connect({
    transport: "unix",
    path: fake.vsockUdsPath,
  });
  try {
    // Pipelined: handshake line and payload in a single write.
    await writeAll(conn, encoder.encode("CONNECT 5000\nhello"));
    const ack = await readLineBytewise(conn, 64);
    assert(ack.kind === "line", `expected OK line, got ${ack.kind}`);
    assert(/^OK \d+$/.test(ack.line), `malformed ack: "${ack.line}"`);
    assertEquals(await readN(conn, 5), "hello");
  } finally {
    conn.close();
  }
});

Deno.test("dial before boot: connection closes without OK", async () => {
  await using fake = await FakeFirecracker.start();
  using client = new FirecrackerClient({ socketPath: fake.socketPath });
  await client.putVsock({ guest_cid: 3, uds_path: fake.vsockUdsPath });
  const conn = await Deno.connect({
    transport: "unix",
    path: fake.vsockUdsPath,
  });
  try {
    await writeAll(conn, encoder.encode("CONNECT 5000\n"));
    assertEquals(await conn.read(new Uint8Array(16)), null);
  } finally {
    conn.close();
  }
});

Deno.test("dial to a port nobody listens on: close-before-OK, no error frame", async () => {
  await using fake = await bootedFakeWithEcho();
  const conn = await Deno.connect({
    transport: "unix",
    path: fake.vsockUdsPath,
  });
  try {
    await writeAll(conn, encoder.encode("CONNECT 9999\n"));
    assertEquals(await conn.read(new Uint8Array(16)), null);
  } finally {
    conn.close();
  }
});

Deno.test("malformed handshake line: connection closes", async () => {
  await using fake = await bootedFakeWithEcho();
  const conn = await Deno.connect({
    transport: "unix",
    path: fake.vsockUdsPath,
  });
  try {
    await writeAll(conn, encoder.encode("JUNK 5000\n"));
    assertEquals(await conn.read(new Uint8Array(16)), null);
  } finally {
    conn.close();
  }
});

Deno.test("assigned host ports increase per accepted connection", async () => {
  await using fake = await bootedFakeWithEcho();
  const ports: number[] = [];
  for (let i = 0; i < 2; i++) {
    const conn = await Deno.connect({
      transport: "unix",
      path: fake.vsockUdsPath,
    });
    try {
      await writeAll(conn, encoder.encode("CONNECT 5000\nx"));
      const ack = await readLineBytewise(conn, 64);
      assert(ack.kind === "line");
      ports.push(Number(ack.line.split(" ")[1]));
      await readN(conn, 1);
    } finally {
      conn.close();
    }
  }
  assert(ports[1] > ports[0], `ports not increasing: ${ports}`);
});
