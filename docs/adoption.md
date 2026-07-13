# Adoption: re-attaching to running VMs after a supervisor crash

`Symbol.asyncDispose` never runs on SIGKILL, OOM, or a runtime crash. When a
supervisor dies, its microVMs keep running — reparented to init, journaled in
the registry, and (until this feature) recoverable only by killing them:
`reconcile(registry, { killLive: true })`.

**Adoption** is the other path: a restarted supervisor re-attaches to each
still-running VMM and gets back a live `Machine` handle, as if it had launched
the VM itself. Sandbox sessions survive the supervisor crash.

```ts
import { DirRegistry, recover } from "@nullstyle/firecracker";

const registry = new DirRegistry("/var/lib/rootd/registry");
const sweep = await recover(registry);

for (const vm of sweep.adopted) attachSession(vm); // "running" or "paused"
for (const vmId of sweep.reclaimed) markDead(vmId); // died while we were down
for (const u of sweep.unadoptable) alert(u.vmId, u.reason); // live but stuck
for (const f of sweep.failures) alert(f.vmId, f.error); // retried next sweep
```

## `recover()` vs `reconcile()`

|              | `reconcile()`                                    | `recover()`                         |
| ------------ | ------------------------------------------------ | ----------------------------------- |
| Dead records | files reclaimed, record deleted                  | same                                |
| Live VMMs    | reported (`stillRunning`) or killed (`killLive`) | **re-attached as `Machine`s**       |
| Use when     | VMs must not outlive the supervisor              | VMs must survive a supervisor crash |

**The one-pass rule:** `recover()` is the single recovery entry point. Never run
`reconcile({ killLive: true })` after adopting — adopted machines' records are
live records, and a kill-sweep would destroy exactly what you just adopted. If
you need per-record policy (adopt the sessions you recognize, kill the strays),
use the `decide` hook:

```ts
const sweep = await recover(registry, {
  decide: (record) => sessions.has(record.vmId) ? "adopt" : "reclaim",
});
```

`decide` routes each record before anything is probed: `"adopt"` (default),
`"reclaim"` (kill a live VMM and reclaim — the stray policy), or `"keep"` (don't
touch, report in `kept`). Live-but-unadoptable VMMs (see below) are kept by
default; `onUnadoptable: "kill"` puts them down instead — except refusals that
must never kill (`"already-adopted"`, `"conflict"`).

Tip: mirror your session id into `JailRecord.metadata` at launch. It is recorded
verbatim, so a `decide` hook can recognize records even if your own session
store was lost with the crash.

## What adoption verifies

`Machine.adopt({ record, registry })` never spawns, and a refusal never kills a
process or touches a file — whatever cannot be adopted is left exactly as found,
for `reconcile()` (or `recover`'s kill modes) to deal with:

1. **Pid location and identity.** The jailer pidfile first (authoritative), then
   the recorded pid, then a `/proc` cmdline scan. A candidate counts only with
   positive identity: the cmdline must name the VM (`--id`), and when the record
   carries a `pidStartTime`, the process start time must match — same pid +
   different start time is a recycled pid, disproven and never signaled. A
   record whose pid is disproven reads as dead (`"vmm-not-found"`) unless the
   real VMM is rediscovered by the scan.
2. **The API socket answers as this VM.** `GET /` must return a valid
   `InstanceInfo` whose `id` matches — a foreign process bound to a stale socket
   path is refused (`"api-mismatch"`).
3. **The instance actually booted.** `"Not started"` records are refused
   (`"not-started"`): the boot configuration is not persisted, so a
   crashed-mid-`create()` machine's invariants cannot be re-established.

Adopted machines land directly in `"running"` or `"paused"`, matching the probed
instance state. A paused adoptee resumes with `vm.resume()`.

## What an adopted machine loses

The VMM is no longer our child process, so exit authority is pid liveness
polling — the same as jailer `--daemonize`/`--new-pid-ns` machines:

| Capability                           | Launched (direct / plain jailed)        | Adopted                                       |
| ------------------------------------ | --------------------------------------- | --------------------------------------------- |
| `exited` / exit codes                | real `code` + `signal` (`child-status`) | `code: null`, `signal: null` (`pidfile-poll`) |
| `consoleTail()`                      | guest serial output                     | empty — use the `logger`/`serial` devices     |
| `VmmExit.stderrTail`                 | Firecracker's stderr                    | empty                                         |
| `jailPath()`                         | staged map + chroot math                | chroot math only (staged map lost)            |
| API client, vsock, shutdown, dispose | full                                    | full                                          |
| cgroup cleanup at disposal           | yes                                     | yes, when the record has `cgroupPath`         |

Everything operational works: the typed client, vsock dials and listeners,
escalating shutdown (with the pid-reuse guard on signals), and disposal that
confirms death, reclaims files (chroot, sockets, cgroup), and clears the record.

## The record contract

Adoption is driven entirely by the `JailRecord` (schema `version: 1`,
unchanged). Records written by 0.2.0 adopt fine; records written by this version
additionally carry:

- `cgroupPath` — the resolved cgroup-v2 dir, journaled before spawn, so reclaim
  and adopted-disposal can remove what the jailer never does. (0.2.0 records
  adopt with this one degradation: no cgroup cleanup.)
- `pidStartTime` — hardens pid-reuse detection beyond the cmdline token.
- `adoptedAt` / `supervisorPid` — diagnostics stamped at adoption. Not a lease.

Stale **guest-listener sockets** (`vsockListenerPaths`) are unlinked during
adoption — their fds died with the old supervisor, and they would otherwise
`AddrInUse` any re-listen. Re-establish your listeners on the adopted machine
(`vm.vsock.listen(port)`); guest connect attempts in the window simply fail,
which is already the semantics of "the host isn't listening".

## Preconditions and platform notes

- **One live supervisor per registry directory.** Adoption is not a lease
  protocol: two supervisors adopting from one registry can both signal the same
  pids. `adoptedAt`/`supervisorPid` make post-mortems possible, but enforcement
  is the caller's deployment discipline.
- **Launch adoption-intended machines with `stdio: "null"`.** The default
  (`stdio: "capture"`) pipes Firecracker's stdout/stderr to the supervisor to
  feed `consoleTail()` / `stderrTail`. When the supervisor dies those pipes lose
  their reader, and the orphaned Firecracker **wedges on its next write to
  them** — observed on v1.16.1, the first post-crash API request never returns,
  and adoption fails with `"api-unreachable"`. Machines that must survive a
  supervisor crash trade console capture for survivability: `stdio: "null"` in
  direct and jailed modes alike (plain and `--new-pid-ns` jails inherit the
  supervisor's pipes too). Jailer `--daemonize` machines are unaffected — their
  stdio already goes to `/dev/null`.
- Identity verification is `/proc`-based, i.e. **Linux**. On Linux, an
  unreadable cmdline (hidepid, permissions) refuses adoption
  (`"identity-unverifiable"`). On runtimes without `/proc` (macOS testing
  against `FakeFirecracker`), adoption proceeds on pid liveness plus the API
  `id` check alone — fine for tests; real usage is Linux.
- Terminology: the jailer docs' "a pre-existing jail root is refused, never
  reused" is about _launching a new jail into leftover directories_ — a
  different hazard entirely. `Machine.adopt` re-attaches to a _live process_
  named by the journal.

See `examples/06-adopt.ts` for a self-demonstrating crash-and-recover loop, and
[Testing your app](testing-your-app.md) for testing your own supervisor's
recovery with `FakeFirecracker`.
