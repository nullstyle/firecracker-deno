# Running jailed

The
[jailer](https://github.com/firecracker-microvm/firecracker/blob/main/docs/jailer.md)
is Firecracker's production hardening wrapper: chroot, privilege drop, cgroups,
optional PID namespace. This library treats jailed operation as a first-class
mode with one non-negotiable: **a registry is required** (enforced by the types
and at runtime).

## Why the registry is required

The jailer cleans up _nothing_ on exit: the chroot tree (including mknod'd
`/dev/kvm` and `/dev/net/tun`), cgroup subtrees, and socket files all outlive
the VMM. And no in-process cleanup — `await using`, `unload` hooks, signal
handlers — runs when your supervisor is SIGKILLed or OOMed. The only sound
design is a journal committed _before_ anything is created (this library writes
the record before even staging the chroot) plus a
[`reconcile()`](../src/registry/reconcile.ts) sweep at startup. Run:

```ts
const registry = new DirRegistry("/var/lib/my-host/registry");
await reconcile(registry, { killLive: true }); // fleet mode; default reports only
```

## Path model

Everything Firecracker sees is an **in-jail path**; the library computes
host-side views for you:

- chroot root: `<chrootBaseDir>/<exec-name>/<id>/root`
- `config` paths (kernel, drives, vsock `uds_path`) are in-jail paths
- `vm.paths.*` are host views; `vm.jailPath(hostPath)` maps staged files back to
  their in-jail location

Stage resources with `jailer.stage` — hardlinked when possible (same
filesystem), copied otherwise, chowned to the jail uid/gid, chmod `0400` (`0600`
with `readWrite: true`).

Watch total path length: the host view of the API socket
(`<base>/<exec>/<id>/root/fc.sock`) must stay under ~104 bytes (the `sun_path`
limit). The library fails fast with a clear error if it won't.

## Exit authority by mode

| Mode           | The VMM process is…                 | Exit observed via | Exit codes | stderr                                |
| -------------- | ----------------------------------- | ----------------- | ---------- | ------------------------------------- |
| plain          | our child (jailer `exec`s in place) | `child-status`    | real       | captured                              |
| `--new-pid-ns` | reparented grandchild               | `pidfile-poll`    | `null`     | jailer's only                         |
| `--daemonize`  | reparented daemon                   | `pidfile-poll`    | `null`     | `/dev/null` — use the `logger` device |

Firecracker always writes its pid to `<chroot>/root/<exec>.pid`; in reparented
modes the library polls for that file (racing jailer failure) and then watches
the pid with signal-0 liveness. `VmmExit.observedVia` tells you which authority
produced any given exit.

Machines re-attached after a supervisor crash (`Machine.adopt`, see
[Adoption](adoption.md)) are always `pidfile-poll`, regardless of the mode they
were originally launched in — the process is no longer our child.

## Hardening notes

- The chroot base and exec directories are created `0700`; a **pre-existing**
  `<base>/<exec>/<id>` is refused, never reused (upstream jailer symlink-attack
  class, fixed in v1.13.2/v1.14.1 — this library also enforces
  `FIRECRACKER_COMPAT.min` ≥ v1.15). This is about launching a _new_ jail into
  leftover directories — distinct from `Machine.adopt`, which re-attaches to a
  _still-running_ VMM through its registry record (see [Adoption](adoption.md)).
- The library never creates or destroys network namespaces; `netnsPath` joins an
  existing one.
- Cgroup: the library defaults `--cgroup-version 2` (the jailer's own default is
  1). Cgroup-v2 subtrees created for the jail are rmdir'd during disposal,
  best-effort; v1 hierarchies are yours to manage.
- Everything under `<base>/<exec>/<id>` is deleted on disposal — only after the
  VMM's death is confirmed.
