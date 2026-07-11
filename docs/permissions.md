# Permissions

`@nullstyle/firecracker` follows Deno's permission model; grant only what the
features you use require. Everything below assumes the narrowest grant that
works in practice.

| Feature                             | Required flags                                                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FirecrackerClient` (HTTP over UDS) | `--allow-read=<socket>`, `--allow-write=<socket>`, `--allow-net`                                                                                     |
| `connectVsock` / `vm.vsock.connect` | `--allow-read=<uds>`, `--allow-write=<uds>`                                                                                                          |
| `listenVsock` / `vm.vsock.listen`   | `--allow-read=<uds>_<port>`, `--allow-write=<uds>_<port>`                                                                                            |
| `Machine` (direct)                  | client flags + `--allow-run=<firecracker>`, `--allow-read`/`--allow-write` on the state dir                                                          |
| `Machine` (jailed)                  | + `--allow-run=<jailer>`, read/write on the chroot base — **and root**, because the jailer chroots, mknods, and drops privileges                     |
| `DirRegistry` / `reconcile()`       | read/write on the registry dir; reconcile additionally signals pids (`--allow-run` is _not_ needed — it uses `Deno.kill`) and reads `/proc` on Linux |
| `tools/fetch-firecracker.ts`        | `-A` (network downloads + file writes; dev-time only)                                                                                                |
| `FakeFirecracker` (tests)           | read/write on its temp dir, `--allow-net`                                                                                                            |

Notes:

- `fetch` over a Unix socket uses `Deno.createHttpClient` (Deno ≥ 2.5; 2.4 gated
  it behind --allow-all) and needs `--allow-net` besides the socket read/write
  grants.
- `Deno.kill` (shutdown escalation, reconcile liveness probing) is covered by
  `--allow-run`.
- Reconcile's pid-identity check reads `/proc/<pid>/cmdline` on Linux; add
  `--allow-read=/proc` when narrowing reads.
- Nothing in this library ever asks for `--allow-env`; test helpers do.
