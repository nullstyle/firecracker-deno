/**
 * One-command real-KVM smoke test for macOS via Lima.
 *
 * Creates (or reuses) a Lima VM with nested virtualization, provisions
 * Deno and squashfs-tools inside it, fetches Firecracker test assets, and
 * runs the full integration suite — tiers 3 *and* 4 (jailer) — under sudo
 * in the guest. The repo is mounted writable at the same path, so assets
 * cache across runs; the first run downloads an Ubuntu image and takes a
 * few minutes, subsequent runs start in seconds.
 *
 * Requirements: Apple Silicon M3 or newer, macOS 15+, `limactl` (Lima ≥ 1.0).
 *
 * Usage:
 *   deno task smoke:lima              # create/reuse the VM and run the suite
 *   deno task smoke:lima --recreate   # rebuild the VM from scratch first
 *   deno task smoke:lima --delete     # tear the VM down and exit
 *   deno task smoke:lima --name my-vm # use a different instance name
 *
 * @module
 */

import { Command } from "@cliffy/command";

const { options } = await new Command()
  .name("smoke:lima")
  .description("Run the real-KVM integration suite in a Lima VM.")
  .option("--name <name:string>", "Lima instance name.", {
    default: "fc-smoke",
  })
  .option("--recreate", "Rebuild the Lima instance before running.")
  .option("--delete", "Delete the Lima instance and exit.")
  .parse(Deno.args);

const { name, recreate, delete: deleteInstance } = options;
const repo = Deno.cwd();

function fail(message: string): never {
  console.error(`✗ ${message}`);
  Deno.exit(1);
}

async function host(
  cmd: string[],
  opts: { check?: boolean } = {},
): Promise<number> {
  console.log(`$ ${cmd.join(" ")}`);
  const status = await new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (opts.check !== false && !status.success) {
    fail(`command failed (${status.code}): ${cmd.join(" ")}`);
  }
  return status.code;
}

/** Run a bash script inside the guest, with deno on PATH and cwd = repo. */
function guest(
  script: string,
  opts: { check?: boolean } = {},
): Promise<number> {
  const wrapped = `export PATH="$HOME/.deno/bin:$PATH"; cd ${
    JSON.stringify(repo)
  } && ${script}`;
  return host(["limactl", "shell", name, "--", "bash", "-lc", wrapped], opts);
}

if (Deno.build.os !== "darwin") {
  fail(
    "smoke:lima is the macOS path; on Linux run `deno task test:integration` directly",
  );
}
try {
  await new Deno.Command("limactl", { args: ["--version"], stdout: "null" })
    .output();
} catch {
  fail("limactl not found — install Lima (`brew install lima`)");
}

const listed = new TextDecoder().decode(
  (await new Deno.Command("limactl", { args: ["list", "-q"] }).output())
    .stdout,
);
const exists = listed.split("\n").includes(name);

if (deleteInstance) {
  if (exists) await host(["limactl", "delete", "-f", name]);
  console.log(`✓ instance ${name} deleted`);
  Deno.exit(0);
}
if (recreate && exists) {
  await host(["limactl", "delete", "-f", name]);
}

if (!exists || recreate) {
  console.log(`creating Lima instance ${name} (first run downloads an image)…`);
  await host([
    "limactl",
    "start",
    `--name=${name}`,
    "--vm-type=vz",
    "--nested-virt",
    "--tty=false",
    "--set",
    `.mounts = [{"location": ${JSON.stringify(repo)}, "writable": true}]`,
    "template:ubuntu-24.04",
  ]);
} else {
  // Reuse: start is a no-op when already running.
  await host(["limactl", "start", name]);
}

// Nested virtualization is the whole point — verify before anything else.
if (
  await guest("test -e /dev/kvm", { check: false }) !== 0
) {
  fail(
    "/dev/kvm missing in the guest: nested virtualization requires an M3+ " +
      "Mac on macOS 15+ with vmType vz. The instance is kept for inspection " +
      `(limactl shell ${name}); delete with: deno task smoke:lima --delete`,
  );
}
console.log("✓ /dev/kvm present in guest");

// Provision (idempotent): apt packages first — Deno's installer needs unzip.
await guest(
  `(command -v unsquashfs >/dev/null && command -v unzip >/dev/null) || ` +
    `(sudo apt-get update -q && sudo apt-get install -y -q unzip squashfs-tools)`,
);
await guest(
  `command -v deno >/dev/null || (curl -fsSL https://deno.land/install.sh | sh -s -- -y)`,
);

// Assets (cached in tests/assets via the shared writable mount).
await guest(`deno run -A tools/fetch-firecracker.ts`);
await guest(
  `cd tests/assets && if [ ! -f rootfs.ext4 ]; then
     sudo unsquashfs -d squashfs-root rootfs.squashfs &&
     sudo chown -R root:root squashfs-root &&
     truncate -s 1G rootfs.ext4 &&
     sudo mkfs.ext4 -q -d squashfs-root -F rootfs.ext4 &&
     sudo rm -rf squashfs-root;
   fi`,
);

// The suite: tiers 3 + 4 in one pass (root satisfies both gates).
console.log("running the real-KVM integration suite in the guest…");
const code = await guest(
  `FC_TEST_BIN=${JSON.stringify(repo)}/tests/assets/firecracker \
   FC_TEST_KERNEL=${JSON.stringify(repo)}/tests/assets/vmlinux \
   FC_TEST_ROOTFS=${JSON.stringify(repo)}/tests/assets/rootfs.ext4 \
   FC_TEST_JAILER=${JSON.stringify(repo)}/tests/assets/jailer \
   sudo -E "$(command -v deno)" test -A tests/integration/`,
  { check: false },
);

if (code === 0) {
  console.log(
    `\n✓ SMOKE OK — real Firecracker (incl. jailer tier) passed inside Lima.` +
      `\n  Instance ${name} kept for fast re-runs; remove with: deno task smoke:lima --delete`,
  );
} else {
  fail(`integration suite failed inside the guest (exit ${code})`);
}
