import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { Machine, VsockDialError } from "../../mod.ts";
import { FirecrackerClient } from "../../src/api/mod.ts";
import { writeAll } from "../../src/internal/line_reader.ts";
import { wrapVsockConn } from "../../src/vsock/conn.ts";
import {
  connectVsock,
  listenVsock,
  type VsockListener,
} from "../../src/vsock/mod.ts";
import { FakeFirecracker } from "../../testing/mod.ts";
import { makeFakeVmmBin } from "./fake_vmm_helper.ts";

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

async function bootedFake(withEchoOn?: number): Promise<FakeFirecracker> {
  const fake = await FakeFirecracker.start();
  using client = new FirecrackerClient({ socketPath: fake.socketPath });
  await client.putBootSource({ kernel_image_path: "/vmlinux" });
  await client.putVsock({ guest_cid: 3, uds_path: fake.vsockUdsPath });
  if (withEchoOn !== undefined) {
    fake.onVsockPort(withEchoOn, async (conn) => {
      try {
        const buf = new Uint8Array(4096);
        const n = await conn.read(buf);
        if (n !== null) await writeAll(conn, buf.subarray(0, n));
      } finally {
        conn.close();
      }
    });
  }
  await client.instanceStart();
  return fake;
}

Deno.test("wrapVsockConn decorates the native Unix connection", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vsock-conn-" });
  const path = join(dir, "device.sock");
  const listener = Deno.listen({ transport: "unix", path });
  try {
    const accepting = listener.accept();
    const inner = await Deno.connect({ transport: "unix", path });
    const peer = await accepting;
    try {
      const conn = wrapVsockConn(inner, 5000, 42);
      assertStrictEquals(conn, inner);
      assertEquals(Object.getOwnPropertyDescriptor(conn, "guestPort"), {
        value: 5000,
        writable: false,
        enumerable: true,
        configurable: false,
      });
      assertEquals(
        Object.getOwnPropertyDescriptor(conn, "assignedHostPort"),
        {
          value: 42,
          writable: false,
          enumerable: true,
          configurable: false,
        },
      );
      assertThrows(() => {
        (conn as unknown as { guestPort: number }).guestPort = 1;
      }, TypeError);
      assertEquals(conn.localAddr.transport, "unix");
      assertEquals(conn.remoteAddr.transport, "unix");
      assert(conn.readable instanceof ReadableStream);
      assert(conn.writable instanceof WritableStream);
      conn.unref();
      conn.ref();

      conn[Symbol.dispose]();
      await assertRejects(
        () => conn.write(new Uint8Array([1])),
        Deno.errors.BadResource,
      );
    } finally {
      peer.close();
    }
  } finally {
    listener.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("connectVsock: handshake, echo, endpoints exposed", async () => {
  await using fake = await bootedFake(5000);
  using conn = await connectVsock(fake.vsockUdsPath, 5000);
  assertEquals(conn.guestPort, 5000);
  assert(conn.assignedHostPort >= 1_000_000);
  await conn.write(encoder.encode("hello vsock"));
  assertEquals(await readN(conn, 11), "hello vsock");
});

Deno.test("connectVsock retries until the guest starts listening", async () => {
  await using fake = await bootedFake();
  setTimeout(() => {
    fake.onVsockPort(6000, async (conn) => {
      await writeAll(conn, encoder.encode("late"));
      conn.close();
    });
  }, 300);
  using conn = await connectVsock(fake.vsockUdsPath, 6000, {
    retryTimeoutMs: 5_000,
    retryIntervalMs: 50,
  });
  assertEquals(await readN(conn, 4), "late");
});

Deno.test("dial to a silent port reports closed-before-ok after the budget", async () => {
  await using fake = await bootedFake();
  const err = await assertRejects(
    () =>
      connectVsock(fake.vsockUdsPath, 9999, {
        retryTimeoutMs: 400,
        retryIntervalMs: 50,
      }),
    VsockDialError,
  );
  assertEquals(err.reason, "closed-before-ok");
  assertEquals(err.port, 9999);
  assert(err.attempts >= 2, `expected retries, got ${err.attempts}`);
});

Deno.test("dial to a missing socket reports socket-missing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const err = await assertRejects(
      () =>
        connectVsock(join(dir, "absent.sock"), 5000, {
          retryTimeoutMs: 300,
          retryIntervalMs: 50,
        }),
      VsockDialError,
    );
    assertEquals(err.reason, "socket-missing");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("malformed ack fails immediately without retry", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "garbage.sock");
  const listener = Deno.listen({ transport: "unix", path });
  const serving = (async () => {
    for await (const conn of listener) {
      await writeAll(conn, encoder.encode("WAT 123\n"));
      conn.close();
    }
  })();
  try {
    const err = await assertRejects(
      () => connectVsock(path, 5000, { retryTimeoutMs: 5_000 }),
      VsockDialError,
    );
    assertEquals(err.reason, "malformed-ack");
    assertEquals(err.attempts, 1);
  } finally {
    listener.close();
    await serving.catch(() => {});
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("payload pipelined behind OK is never swallowed", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "pipelined.sock");
  const listener = Deno.listen({ transport: "unix", path });
  const served: Deno.Conn[] = [];
  const serving = (async () => {
    for await (const conn of listener) {
      served.push(conn);
      // OK line and payload in a single write.
      await writeAll(conn, encoder.encode("OK 77\nworld"));
    }
  })();
  try {
    using conn = await connectVsock(path, 5000, { retryTimeoutMs: 2_000 });
    assertEquals(conn.assignedHostPort, 77);
    assertEquals(await readN(conn, 5), "world");
  } finally {
    listener.close();
    for (const conn of served) {
      try {
        conn.close();
      } catch {
        // peer already closed it
      }
    }
    await serving.catch(() => {});
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("silent handshake reports timeout", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "silent.sock");
  const listener = Deno.listen({ transport: "unix", path });
  const conns: Deno.Conn[] = [];
  const serving = (async () => {
    for await (const conn of listener) {
      conns.push(conn); // accept and say nothing
    }
  })();
  try {
    const err = await assertRejects(
      () =>
        connectVsock(path, 5000, {
          retryTimeoutMs: 400,
          retryIntervalMs: 50,
          handshakeTimeoutMs: 100,
        }),
      VsockDialError,
    );
    assertEquals(err.reason, "timeout");
  } finally {
    listener.close();
    for (const conn of conns) {
      try {
        conn.close();
      } catch {
        // already closed by the dialer
      }
    }
    await serving.catch(() => {});
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("abort signal cancels dialing with the given reason", async () => {
  await using fake = await bootedFake();
  const ac = new AbortController();
  const dialing = connectVsock(fake.vsockUdsPath, 9999, {
    retryTimeoutMs: 30_000,
    retryIntervalMs: 50,
    signal: ac.signal,
  });
  setTimeout(() => ac.abort(new Error("caller gave up")), 150);
  await assertRejects(() => dialing, Error, "caller gave up");
});

Deno.test("listenVsock: accepts a guest-initiated stream and unlinks on dispose", async () => {
  await using fake = await bootedFake();
  const listenerPath = `${fake.vsockUdsPath}_7000`;
  {
    await using listener = listenVsock(fake.vsockUdsPath, 7000);
    assertEquals(listener.path, listenerPath);
    assertEquals(listener.port, 7000);
    const accepted = listener.accept();
    const guest = await fake.connectFromGuest(7000);
    using conn = await accepted;
    await guest.write(encoder.encode("from-guest"));
    assertEquals(await readN(conn, 10), "from-guest");
    await conn.write(encoder.encode("to-guest"));
    assertEquals(await readN(guest, 8), "to-guest");
    guest.close();
  }
  assertEquals(await Deno.stat(listenerPath).catch(() => null), null);
});

Deno.test("listenVsock decorates native listener and closes idempotently", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vsock-listener-" });
  const udsPath = join(dir, "device.sock");
  const listenerPath = `${udsPath}_7000`;
  const listener = listenVsock(udsPath, 7000);
  const native = listener as VsockListener & Deno.UnixListener;
  try {
    assertEquals(Object.getOwnPropertyDescriptor(listener, "path"), {
      value: listenerPath,
      writable: false,
      enumerable: true,
      configurable: false,
    });
    assertEquals(Object.getOwnPropertyDescriptor(listener, "port"), {
      value: 7000,
      writable: false,
      enumerable: true,
      configurable: false,
    });
    assertThrows(() => {
      (listener as unknown as { port: number }).port = 1;
    }, TypeError);
    assertEquals(native.addr.transport, "unix");
    assertEquals(native.addr.path, listenerPath);
    native.unref();
    native.ref();

    const pending = native[Symbol.asyncIterator]().next();
    listener.close();
    listener.close();
    assertEquals(await pending, { value: undefined, done: true });
  } finally {
    await listener[Symbol.asyncDispose]();
    assertEquals(await Deno.stat(listenerPath).catch(() => null), null);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("machine.vsock: end-to-end connect + listen with cleanup", async () => {
  const dir = await Deno.makeTempDir({ prefix: "machine-vsock-" });
  try {
    const vsockUds = join(dir, "v.sock");
    const bin = await makeFakeVmmBin(dir, "ready", {
      FAKE_VMM_ECHO_PORT: "5000",
    });
    const listenerPath = `${vsockUds}_7000`;
    {
      await using vm = await Machine.launch({
        firecrackerBin: bin,
        config: {
          boot_source: { kernel_image_path: "/vmlinux" },
          vsock: { guest_cid: 3, uds_path: vsockUds },
        },
        stateDir: join(dir, "state"),
      });
      assertEquals(vm.paths.vsockUds, vsockUds);

      using conn = await vm.vsock.connect(5000, { retryTimeoutMs: 5_000 });
      await conn.write(encoder.encode("ping"));
      assertEquals(await readN(conn, 4), "ping");

      const listener = vm.vsock.listen(7000);
      const accepted = listener.accept();
      const guest = await Deno.connect({
        transport: "unix",
        path: listenerPath,
      });
      using inbound = await accepted;
      await guest.write(encoder.encode("hi"));
      assertEquals(await readN(inbound, 2), "hi");
      guest.close();
    }
    // dispose reclaimed both the device socket and the listener socket
    assertEquals(await Deno.stat(vsockUds).catch(() => null), null);
    assertEquals(await Deno.stat(listenerPath).catch(() => null), null);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("machine.vsock.connect is state-gated and requires a vsock device", async () => {
  const dir = await Deno.makeTempDir({ prefix: "machine-vsock-" });
  try {
    const bin = await makeFakeVmmBin(dir, "ready");
    await using vm = await Machine.create({
      firecrackerBin: bin,
      config: { boot_source: { kernel_image_path: "/vmlinux" } },
      stateDir: join(dir, "state"),
    });
    // not running yet
    await assertRejects(() => vm.vsock.connect(5000), Error, "vsock.connect");
    await vm.start();
    // running, but no vsock device configured
    const err = await assertRejects(
      () => vm.vsock.connect(5000),
      VsockDialError,
    );
    assertEquals(err.reason, "socket-missing");
    assertEquals(err.attempts, 0);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
