# @nullstyle/firecracker

> **Status: 0.2.0.** Everything below is implemented and tested (120+ tests
> across four tiers, including real-KVM CI).

**@nullstyle/firecracker** is a Deno-native toolkit for controlling
[Firecracker](https://firecracker-microvm.github.io/) microVMs. It provides
typed machine configuration and API-socket access, supervised Firecracker and
jailer processes, host-to-guest vsock connections as standard `Deno.Conn`
streams, and reliable lifecycle cleanup — without prescribing images, networking
policy, or orchestration. It is the low-level foundation for building secure
local sandboxes, microVM runners, and higher-level platforms.

## Quickstart

```ts
import { DirRegistry, Machine, reconcile } from "@nullstyle/firecracker";

// 1. Reclaim anything a previous crash left behind. (Fleet mode — kills
//    survivors. To RE-ATTACH to them instead, use recover(); see
//    docs/adoption.md.)
const registry = new DirRegistry("/var/lib/sandbox-host/state");
await reconcile(registry, { killLive: true });

// 2. Boot a jailed microVM; `await using` guarantees graceful teardown.
await using vm = await Machine.launch({
  jailer: {
    jailerBin: "/usr/local/bin/jailer",
    firecrackerBin: "/usr/local/bin/firecracker",
    id: "sandbox-42",
    uid: 10042,
    gid: 10042,
    newPidNs: true,
    stage: [
      { hostPath: "/opt/images/vmlinux-6.1" },
      { hostPath: "/opt/images/rootfs.ext4", readWrite: true },
    ],
  },
  config: {
    machine_config: { vcpu_count: 2, mem_size_mib: 512 },
    boot_source: {
      kernel_image_path: "/vmlinux-6.1", // in-chroot path
      boot_args: "console=ttyS0 reboot=k panic=1 pci=off",
    },
    drives: [{
      drive_id: "rootfs",
      path_on_host: "/rootfs.ext4",
      is_root_device: true,
      is_read_only: false,
    }],
    vsock: { guest_cid: 3, uds_path: "/v.sock" },
  },
  registry, // required whenever `jailer` is set
});

// 3. Talk to the guest agent over vsock — a standard Deno.Conn.
await using conn = await vm.vsock.connect(5000);
await conn.write(new TextEncoder().encode("ping\n"));

const exit = await vm.shutdown(); // CtrlAltDel → SIGTERM → SIGKILL, with deadlines
console.log("exit:", exit.code, "observed via", exit.observedVia);
// On scope exit, disposal confirms death, unlinks sockets, removes the chroot
// and cgroups, and clears the registry record.
```

## What it is (and is not)

Three strictly-layered pieces, each usable on its own:

| Layer   | Import                          | What you get                                                                                                     |
| ------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Client  | `@nullstyle/firecracker/client` | Typed `FirecrackerClient` — one method per API-socket endpoint, over HTTP-on-UDS                                 |
| Vsock   | `@nullstyle/firecracker/vsock`  | `connectVsock`/`listenVsock` for Firecracker's hybrid vsock, as `Deno.Conn`/listener                             |
| Machine | `@nullstyle/firecracker`        | Supervised lifecycle: spawn (direct or jailed), readiness, escalating shutdown, cleanup, crash-recovery registry |

Plus `@nullstyle/firecracker/testing`: a publishable `FakeFirecracker` that
speaks the API and vsock protocols over real Unix sockets — so you can test your
sandbox platform on any OS, without KVM.

**Non-goals** — this library does not manage kernel/rootfs images, configure
host networking (taps, bridges, iptables), or orchestrate fleets. It hands you
correct, well-typed primitives to build those on.

## Reliability contract

The `Machine` layer maintains these invariants:

1. **No silent orphans** — disposal resolves only after confirmed process death
   and resource reclaim, and throws `CleanupError` otherwise.
2. **Journal-before-spawn** — with a registry, the on-disk record is committed
   before the VMM is spawned, so a crashed supervisor can always `reconcile()`
   its way back to a clean host.
3. **Readiness races death** — waiting for the API socket always races process
   exit; a dead VMM fails fast with its stderr attached.
4. **Monotonic shutdown** — `CtrlAltDel → SIGTERM → SIGKILL` escalation never
   de-escalates; concurrent shutdown calls share one outcome.
5. **State-gated API** — operations illegal in the current lifecycle state fail
   with `InvalidStateError` instead of a cryptic API 400.
6. **Adoption preserves the contract** — after a supervisor crash,
   `recover()`/`Machine.adopt()` re-attach to still-running VMs (identity
   positively re-verified before any kill-capable handle exists) and keep
   invariants 1, 4, and 5. What an adopted machine loses is observability only:
   exit codes (`code: null`), console/stderr tails (empty), and the staged-path
   map. Precondition: one live supervisor per registry directory. See
   [Adoption](docs/adoption.md).

## Requirements

- **Runtime**: Linux with KVM (`/dev/kvm`) to actually run VMs. The client,
  vsock protocol code, and `FakeFirecracker` work on any Deno platform — develop
  and unit-test on macOS, run on Linux.
- **Deno** ≥ 2.5 (native HTTP-over-Unix-socket `fetch` usable with scoped
  permissions; 2.4 gated it behind `--allow-all`).
- **Firecracker** within the supported window (see `FIRECRACKER_COMPAT`): pinned
  against v1.16.x, minimum v1.15.0. Jailed mode requires root.

### Permissions

| Feature          | Flags                                                     |
| ---------------- | --------------------------------------------------------- |
| API client       | `--allow-read`/`--allow-write` on the socket path         |
| Machine (direct) | + `--allow-run=<firecracker>`, read/write on state dir    |
| Machine (jailed) | + `--allow-run=<jailer>`, root, read/write on chroot base |
| Vsock            | `--allow-read`/`--allow-write` on the vsock UDS paths     |

## Development

```sh
deno task check        # fmt --check, lint, typecheck
deno task test         # unit + fake-backed tiers (no KVM needed, runs on macOS)
deno task spec:drift   # generated types match the vendored Firecracker spec
deno run -A tools/fetch-firecracker.ts   # binaries + kernel + rootfs for integration
deno task test:integration               # real VMs; Linux + /dev/kvm (+ sudo for jailer)
deno task smoke:lima                     # the same from macOS, inside a nested-virt Lima VM
```

Integration tests boot real VMs and are gated behind Linux + `/dev/kvm`; CI runs
them on `ubuntu-24.04` (GitHub-hosted x86_64 runners expose KVM), including a
root-gated real-jailer matrix. Compiled-binary support (`deno compile`) is
verified by a CI smoke test (`tests/smoke/compile_smoke.ts`). Guides:

- [Permissions](docs/permissions.md) — exact flags per feature
- [Running jailed](docs/jailer.md) — threat model, path rules, exit authority
- [Adoption](docs/adoption.md) — re-attaching to running VMs after a supervisor
  crash
- [Compatibility](docs/compatibility.md) — the two-minor Firecracker window
- [macOS development](docs/macos-dev.md) — the no-VM loop, Lima recipe
- [Testing your app](docs/testing-your-app.md) — building on `FakeFirecracker`

## License

Apache-2.0
