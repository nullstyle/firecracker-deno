# Testing your platform with FakeFirecracker

If you build on `@nullstyle/firecracker`, you can test your sandbox runner,
scheduler, or platform **without KVM, Linux, or root** — on laptops and in any
CI. Import the same test double this library uses:

```ts
import { Machine } from "@nullstyle/firecracker";
import { FirecrackerClient } from "@nullstyle/firecracker/client";
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

For code that supervises the _process_ (not just the API), the executable shims
this library uses are public too:

```ts
import {
  makeFakeJailerBin,
  makeFakeVmmBin,
} from "@nullstyle/firecracker/testing";
```

`makeFakeVmmBin(dir, mode)` writes a spawnable Firecracker double you hand to
`Machine` as `firecrackerBin`. Modes: `"ready"`, `"exit-before-bind"`,
`"never-bind"`, and `"ignore-sigterm"` (plus `FAKE_VMM_BIND_DELAY_MS` /
`FAKE_VMM_ECHO_PORT` via its `env` parameter). `makeFakeJailerBin(dir)` emulates
the jailer's process contract for `jailerBin`.

```ts
const dir = await Deno.makeTempDir();
const bin = await makeFakeVmmBin(dir, "ready");
await using vm = await Machine.launch({
  firecrackerBin: bin,
  config: { boot_source: { kernel_image_path: "/vmlinux" } },
  stateDir: `${dir}/state`,
});
// vm.state === "running" — spawn, readiness, and shutdown paths all real
```

## Testing your supervisor's crash recovery

To test that your supervisor `recover()`s correctly (see
[Adoption](adoption.md)), reproduce a real orphaning: launch a journaled machine
in a **subprocess**, SIGKILL that subprocess, and adopt from the registry in
your test. The fake VMM survives its supervisor's death exactly like real
Firecracker does — its API socket and vsock mux stay live.

The subprocess is ~20 lines (this repo's `tests/fake/crash_supervisor.ts` is the
reference): create a `DirRegistry`, `Machine.launch` against
`makeFakeVmmBin(dir, "ready")`, print `LAUNCHED ${vm.pid}`, and hang. The test
spawns it with `stdout: "piped"`, parses the pid, kills the supervisor with
SIGKILL, and then exercises your recovery path — `Machine.adopt` / `recover()` —
asserting live API and vsock traffic against the surviving socket. This repo's
`tests/fake/adopt_test.ts` shows the full pattern, including paused,
never-booted, and stale-listener scenarios.

## Trust, but verify

The fake's fidelity is enforced in this repo by contract-symmetry integration
tests that re-run key assertions against real Firecracker in CI. If you find a
divergence, that's a bug — please report it.
