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

Use [Lima](https://lima-vm.io) with nested virtualization (requires an M3 or
newer and macOS 15+):

```sh
limactl start --name=fc --vm-type=vz --nestedVirtualization template://ubuntu-24.04
limactl shell fc
# inside the VM:
sudo apt-get install -y curl unzip squashfs-tools
curl -fsSL https://deno.land/install.sh | sh
cd /path/to/firecracker-deno       # your checkout is mounted
deno run -A tools/fetch-firecracker.ts
# build the ext4 rootfs from the CI squashfs (see .github/workflows/ci.yml)
FC_TEST_BIN=tests/assets/firecracker \
FC_TEST_KERNEL=tests/assets/vmlinux \
FC_TEST_ROOTFS=tests/assets/rootfs.ext4 \
deno task test:integration
```

On Intel or M1/M2 Macs (no nested virt): push and let CI's KVM job run — that's
a supported workflow, not a fallback. GitHub-hosted x86_64 Linux runners expose
`/dev/kvm`.
