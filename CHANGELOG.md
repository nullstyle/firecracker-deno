# Changelog

## 0.1.0 (unreleased)

Initial release. Pinned to Firecracker v1.16.1 (minimum v1.15.0).

- Relative `firecrackerBin`/`jailerBin` paths resolve shell-style against the
  caller's cwd (bare names still use `$PATH`) — previously `Deno.Command`'s
  `cwd` option resolved them inside the machine's state dir.
- `vm.vsock.connect` races VMM death: a dial in flight when the machine dies
  rejects promptly with `ProcessExitedError` instead of running out its retry
  budget.
- `JailRecord.metadata` + `metadata` option on machine/restore options: opaque
  caller labels (lease ids, group names) recorded verbatim for downstream
  supervisors.
- Jailed machines no longer forward `--id` to Firecracker — the jailer injects
  it itself, and the duplicate was fatal
  (`ParseArguments(DuplicateArgument("id"))`). The fake jailer/VMM now mirror
  this contract so the class is caught without KVM.
- Deno floor raised to **2.5**: 2.4 gated the Unix-socket `fetch` proxy behind
  `--allow-all`, and its `Deno.kill(pid, 0)` rejected the liveness probe
  (hanging pidfile-authority exit detection). `pidAlive` now feature-detects and
  falls back to a `SIGCONT` probe on runtimes without signal-0 support (2.5
  included).

- **Typed API client** (`./client`): one method per endpoint of the pinned spec
  (38 operations), HTTP over the Unix API socket via native `fetch`,
  `fault_message`-aware errors, per-request timeouts/signals, `waitReady`. Types
  are generated from the vendored swagger spec and re-exported with curated docs
  (`./types`), with `@since` tags for v1.16-only surface.
- **Supervised machines**: `Machine.create/launch` with readiness-racing-death,
  ordered config apply, state-gated lifecycle
  (`start`/`pause`/`resume`/`waitFor`), escalating shutdown (`SendCtrlAltDel` →
  `SIGTERM` → `SIGKILL`, aarch64-aware), `kill()`, and disposal that confirms
  death before reclaiming every file it created.
- **Vsock as standard Deno networking** (`./vsock`): `connectVsock` with
  byte-exact `CONNECT`/`OK` handshake (pipelined payload never swallowed),
  bounded retries, typed failure reasons; `VsockConn` is a structural
  `Deno.Conn`; `listenVsock` owns guest-initiated listener sockets;
  `vm.vsock.{connect,listen}`.
- **Jailer support** (`./jailer`): validated options, chroot staging with
  hardening (0700 base dirs, pre-existing jail roots refused), host↔jail path
  math, per-mode exit authority (child-status vs pidfile-poll for
  `--daemonize`/`--new-pid-ns`), full jail-root reclaim. A crash-recovery
  registry is **required** for jailed machines.
- **Crash recovery**: `VmRegistry`/`DirRegistry` journal committed before spawn;
  `reconcile()` sweeps orphans (report-only by default, `killLive` fleet mode)
  and never touches a live VMM's files.
- **Snapshots**: `vm.snapshot({ pause: true, ... })` and `Machine.restore()`
  with `File` memory backend and `vsock_override` (`Uffd` is an external-handler
  contract).
- **`FakeFirecracker`** (`./testing`): a public test double speaking the API +
  hybrid-vsock protocols over real Unix sockets with the real boot-phase state
  machine, fault injection, and request recording — test your platform without
  KVM.
- **Process-level test doubles** (`./testing`): `makeFakeVmmBin` (spawnable
  fake-VMM shim with ready / exit-before-bind / never-bind / ignore-sigterm
  modes) and `makeFakeJailerBin` (fake jailer shim emulating chroot layout,
  `--api-sock` translation, pidfile, and reparenting) — unit-test process
  supervision without KVM.
- Verified `deno compile` support with a CI smoke test
  (`tests/smoke/compile_smoke.ts`) on Linux and macOS.
- `deno task smoke:lima`: one-command real-KVM smoke test on Apple Silicon —
  provisions a nested-virt Lima VM and runs the full integration suite
  (including the jailer tier) inside it.
