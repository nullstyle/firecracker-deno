/**
 * Test helper: a shell script that emulates the jailer's process contract
 * without needing Linux or root — chroot layout creation, `--api-sock`
 * path translation into the (emulated) chroot, the pidfile, exec-in-place
 * for plain mode, and reparenting for --daemonize/--new-pid-ns.
 *
 * It exports FAKE_VMM_CHROOT so fake_vmm.ts resolves its vsock UDS the
 * way a genuinely chrooted Firecracker would.
 */

import { join } from "@std/path";

/** Write the fake jailer shim into `dir` and return its path. */
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
  "$EXEC" "$@" >/dev/null 2>&1 &
  echo $! > "$PIDFILE"
  exit 0
else
  echo $$ > "$PIDFILE"
  exec "$EXEC" "$@"
fi
`,
  );
  await Deno.chmod(path, 0o755);
  return path;
}
