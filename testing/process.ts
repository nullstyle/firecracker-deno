/**
 * Process-level test doubles for supervision tests: executable shims that
 * stand in for the `firecracker` and `jailer` binaries. Pass their paths as
 * `firecrackerBin` / `jailerBin` when driving `Machine.launch`,
 * `Machine.create`, or your own supervisor, and exercise spawn, readiness,
 * shutdown escalation, and crash handling without KVM, Linux, or root.
 *
 * - {@linkcode makeFakeVmmBin} wraps `fake_vmm.ts` — a spawnable Firecracker
 *   double that serves the real API protocol via `FakeFirecracker` — in a
 *   `#!/bin/sh` shim with a selectable failure mode.
 * - {@linkcode makeFakeJailerBin} writes a shell script that emulates the
 *   jailer's process contract (chroot layout, `--api-sock` translation,
 *   pidfile, exec vs reparent).
 *
 * @example Booting a Machine against a fake VMM shim
 * ```ts
 * import { Machine } from "@nullstyle/firecracker";
 * import { makeFakeVmmBin } from "@nullstyle/firecracker/testing";
 *
 * const dir = await Deno.makeTempDir();
 * const bin = await makeFakeVmmBin(dir, "ready");
 * await using vm = await Machine.launch({
 *   firecrackerBin: bin,
 *   config: { boot_source: { kernel_image_path: "/vmlinux" } },
 *   stateDir: `${dir}/state`,
 * });
 * ```
 *
 * @module
 */

import { fromFileUrl, join } from "@std/path";

const FAKE_VMM_URL = import.meta.resolve("./fake_vmm.ts");
// Local checkouts resolve to a file: URL and get a plain path; when this
// module is loaded from a registry (e.g. JSR) the https: URL is embedded
// instead — `deno run -A <url>` handles both.
const FAKE_VMM = FAKE_VMM_URL.startsWith("file:")
  ? fromFileUrl(FAKE_VMM_URL)
  : FAKE_VMM_URL;

/**
 * Create an executable shim that runs the fake VMM (`fake_vmm.ts`) in
 * `mode`, forwarding argv. Returns the shim path (inside `dir`, which the
 * caller owns and cleans up).
 *
 * The shim behaves like the real `firecracker` binary from a supervisor's
 * point of view: it takes `--api-sock <path>`, serves the Firecracker API on
 * that socket (via `FakeFirecracker`), writes errors to stderr, and exits on
 * signals. The file is named `firecracker-fake-${mode}` so it passes jailer
 * `--exec-file` validation, which requires "firecracker" in the basename.
 *
 * Modes (set as `FAKE_VMM_MODE` in the shim):
 * - `"ready"`: bind the API socket (after the optional bind delay) and run
 *   until signaled. `SendCtrlAltDel` exits 0, like a graceful guest stop.
 * - `"exit-before-bind"`: write a fatal error to stderr and exit 7 without
 *   ever binding the socket — a VMM that dies during startup.
 * - `"never-bind"`: never bind the socket; hang until signaled — exercises
 *   readiness timeouts.
 * - `"ignore-sigterm"`: like `"ready"`, but SIGTERM is caught and ignored —
 *   only SIGKILL works, exercising shutdown escalation.
 *
 * Environment variables understood by the fake VMM (pass via `env`):
 * - `FAKE_VMM_BIND_DELAY_MS`: milliseconds to wait before binding the API
 *   socket in `"ready"` / `"ignore-sigterm"` modes.
 * - `FAKE_VMM_ECHO_PORT`: guest vsock port to serve a byte-echo handler on,
 *   for vsock round-trip tests.
 * - `FAKE_VMM_CHROOT`: chroot-emulation prefix for the vsock UDS path, the
 *   way a jailed Firecracker resolves in-jail paths (the fake jailer from
 *   {@linkcode makeFakeJailerBin} exports this automatically).
 *
 * @param dir Directory to write the shim into (caller-owned).
 * @param mode One of the modes above; becomes `FAKE_VMM_MODE`.
 * @param env Extra environment variables to bake into the shim.
 * @returns Absolute path of the executable shim.
 */
export async function makeFakeVmmBin(
  dir: string,
  mode: string,
  env: Record<string, string> = {},
): Promise<string> {
  const envLine = Object.entries({ FAKE_VMM_MODE: mode, ...env })
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");
  // Name contains "firecracker" so the shim passes jailer --exec-file
  // validation when used in jailed-machine tests.
  const path = join(dir, `firecracker-fake-${mode}`);
  await Deno.writeTextFile(
    path,
    `#!/bin/sh\n${envLine} exec ${JSON.stringify(Deno.execPath())} run -A ${
      JSON.stringify(FAKE_VMM)
    } "$@"\n`,
  );
  await Deno.chmod(path, 0o755);
  return path;
}

/**
 * Write a fake `jailer` shim into `dir` and return its path.
 *
 * The shim is a shell script that emulates the jailer's process contract
 * without needing Linux or root:
 *
 * - parses the jailer CLI (`--id`, `--exec-file`, `--chroot-base-dir`,
 *   `--daemonize`, `--new-pid-ns`, and the two-value options it ignores),
 * - creates the chroot layout
 *   `<chroot-base-dir>/<exec-file basename>/<id>/root`,
 * - translates the `--api-sock` value in the firecracker argv the way
 *   chroot resolution would (prefixes the jail root),
 * - writes the pidfile `<root>/<exec-file basename>.pid`,
 * - execs the VMM in place for plain mode, or backgrounds it (reparenting,
 *   pidfile holds the real PID) for `--daemonize` / `--new-pid-ns`.
 *
 * It exports `FAKE_VMM_CHROOT` so a fake VMM from
 * {@linkcode makeFakeVmmBin} resolves its vsock UDS the way a genuinely
 * chrooted Firecracker would.
 *
 * @param dir Directory to write the shim into (caller-owned).
 * @returns Absolute path of the executable shim.
 */
export async function makeFakeJailerBin(dir: string): Promise<string> {
  const path = join(dir, "fake-jailer");
  await Deno.writeTextFile(
    path,
    `#!/bin/sh
set -e
ID=""; EXEC=""; BASE="/srv/jailer"; REPARENT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --id) ID="$2"; shift 2 ;;
    --exec-file) EXEC="$2"; shift 2 ;;
    --chroot-base-dir) BASE="$2"; shift 2 ;;
    --daemonize|--new-pid-ns) REPARENT=1; shift ;;
    --uid|--gid|--cgroup-version|--netns|--parent-cgroup|--cgroup|--resource-limit) shift 2 ;;
    --) shift; break ;;
    *) shift ;;
  esac
done
ROOT="$BASE/$(basename "$EXEC")/$ID/root"
mkdir -p "$ROOT"
export FAKE_VMM_CHROOT="$ROOT"
# Rebuild the firecracker argv, translating the --api-sock value the way
# chroot resolution would.
n=$#
i=0
PREV=""
while [ $i -lt $n ]; do
  arg="$1"; shift
  new="$arg"
  if [ "$PREV" = "--api-sock" ]; then new="$ROOT$arg"; fi
  PREV="$arg"
  set -- "$@" "$new"
  i=$((i+1))
done
PIDFILE="$ROOT/$(basename "$EXEC").pid"
if [ "$REPARENT" = 1 ]; then
  "$EXEC" --id "$ID" "$@" >/dev/null 2>&1 &
  echo $! > "$PIDFILE"
  exit 0
else
  echo $$ > "$PIDFILE"
  exec "$EXEC" --id "$ID" "$@"
fi
`,
  );
  await Deno.chmod(path, 0o755);
  return path;
}
