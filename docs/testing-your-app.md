# Testing your platform with FakeFirecracker

If you build on `@nullstyle/firecracker`, you can test your sandbox runner,
scheduler, or platform **without KVM, Linux, or root** — on laptops and in any
CI. Import the same test double this library uses:

```ts
import { FirecrackerClient, Machine } from "@nullstyle/firecracker";
import { FakeFirecracker } from "@nullstyle/firecracker/testing";
```

## What the fake is (and isn't)

`FakeFirecracker` serves the Firecracker API on a real Unix socket and speaks
the hybrid-vsock `CONNECT`/`OK` protocol on another. It enforces the real
boot-phase state machine — pre-boot-only endpoints 400 after `InstanceStart`,
post-boot-only endpoints 400 before it, snapshot creation demands a paused VM —
and answers with the same shapes real Firecracker does. It boots nothing:
fault-message strings are approximations, and nothing executes guest code.

## Recipes

**Drive your API-level code:**

```ts
await using fake = await FakeFirecracker.start();
using client = new FirecrackerClient({ socketPath: fake.socketPath });
await client.putBootSource({ kernel_image_path: "/vmlinux" });
await client.instanceStart();
```

**Simulate a guest agent on a vsock port:**

```ts
fake.onVsockPort(5000, async (conn) => {
  // conn is a standard Deno.Conn — implement your agent protocol
});
// dials to other ports get the faithful close-before-OK rejection
```

**Inject failures:**

```ts
fake.failNext(
  { method: "PUT", path: "/snapshot/create" },
  { status: 503, faultMessage: "disk full" },
);
```

**Assert on traffic:** `fake.requests` records every request in order, with
parsed bodies.

**Guest-initiated connections:** `fake.connectFromGuest(port)` dials the host
listener socket (`listenVsock` / `vm.vsock.listen`) the way a guest would.

## Testing supervision paths

For code that supervises the _process_ (not just the API), spawn the fake behind
a tiny executable shim and hand that to `Machine` as `firecrackerBin` — see
[`tests/fake/fake_vmm.ts`](../tests/fake/fake_vmm.ts) and its helper for the
patterns this library uses (bind-delay, exit-before-bind, SIGTERM-ignoring
modes).

## Trust, but verify

The fake's fidelity is enforced in this repo by contract-symmetry integration
tests that re-run key assertions against real Firecracker in CI. If you find a
divergence, that's a bug — please report it.
