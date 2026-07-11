# Developing on macOS

Firecracker itself runs only on Linux/KVM — but almost all of this library's
behavior is testable anywhere Deno runs. That's a design goal, not an accident.

## The everyday loop (no VM required)

```sh
deno task test    # unit + fake-backed tiers — runs natively on macOS
deno task check   # fmt + lint + typecheck
```

The fake tier exercises real protocol behavior over real Unix sockets:
`FakeFirecracker` speaks the API and hybrid-vsock protocols, a spawnable fake
VMM exercises supervision (readiness racing death, SIGTERM-ignoring escalation,
crash cleanup), and a fake jailer shell shim emulates the jailer's process
contract (chroot layout, pidfile, exec vs. reparent).

## Running real VMs locally (Apple Silicon)

One command, via [Lima](https://lima-vm.io) with nested virtualization (requires
an M3 or newer, macOS 15+, and `brew install lima`):

```sh
deno task smoke:lima
```

[`tools/lima-smoke.ts`](../tools/lima-smoke.ts) creates (or reuses) an
`fc-smoke` Ubuntu VM with `/dev/kvm`, provisions Deno and squashfs-tools,
fetches the aarch64 Firecracker assets, builds the ext4 rootfs, and runs the
**full integration suite — including the root/jailer tier** — inside the guest.
The repo is mounted writable at the same path, so assets and the VM are reused:
the first run downloads an Ubuntu image (a few minutes); re-runs start in
seconds.

```sh
deno task smoke:lima --recreate   # rebuild the VM from scratch
deno task smoke:lima --delete     # tear it down
```

On Intel or M1/M2 Macs (no nested virt): push and let CI's KVM job run — that's
a supported workflow, not a fallback. GitHub-hosted x86_64 Linux runners expose
`/dev/kvm`.
