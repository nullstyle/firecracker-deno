import { assert, assertEquals, assertRejects } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  AdoptError,
  CleanupError,
  DirRegistry,
  Machine,
  recover,
} from "../../mod.ts";
import type { JailRecord } from "../../mod.ts";
import { pidAlive } from "../../src/internal/liveness.ts";
import { listenVsock } from "../../src/vsock/mod.ts";
import { makeFakeVmmBin } from "./fake_vmm_helper.ts";

const HERE = dirname(fromFileUrl(import.meta.url));
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const isLinux = Deno.build.os === "linux";

function record(vmId: string, patch: Partial<JailRecord>): JailRecord {
  return {
    version: 1,
    vmId,
    pid: null,
    apiSocketPath: "",
    stateDir: "",
    ownsStateDir: false,
    vsockListenerPaths: [],
    createdAt: "2026-07-10T00:00:00.000Z",
    ...patch,
  };
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "adopt-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/**
 * Run crash_supervisor.ts with `flags`, wait for its `LAUNCHED <pid>`
 * announcement, SIGKILL it, and hand back the orphaned VMM's pid.
 */
async function orphanVmm(dir: string, flags: string[] = []): Promise<number> {
  const supervisor = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", join(HERE, "crash_supervisor.ts"), dir, ...flags],
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  let vmmPid = 0;
  const reader = supervisor.stdout.getReader();
  let buffer = "";
  while (vmmPid === 0) {
    const { value, done } = await reader.read();
    if (done) throw new Error("supervisor exited before LAUNCHED");
    buffer += decoder.decode(value);
    const match = /LAUNCHED (\d+)/.exec(buffer);
    if (match !== null) vmmPid = Number(match[1]);
  }
  supervisor.kill("SIGKILL");
  await supervisor.status;
  await reader.cancel();
  assert(pidAlive(vmmPid), "the VMM must have been orphaned, not killed");
  return vmmPid;
}

function killQuietly(pid: number): void {
  try {
    Deno.kill(pid, "SIGKILL");
  } catch {
    // already dead
  }
}

async function readN(conn: Deno.Conn, n: number): Promise<string> {
  const buf = new Uint8Array(n);
  let got = 0;
  while (got < n) {
    const read = await conn.read(buf.subarray(got));
    if (read === null) break;
    got += read;
  }
  return decoder.decode(buf.subarray(0, got));
}

Deno.test("adopt reattaches to a live orphan: API, vsock, listeners, shutdown, dispose", async () => {
  await withDir(async (dir) => {
    const vmmPid = await orphanVmm(dir, [
      "--echo-port",
      "5000",
      "--listen",
      "7000",
    ]);
    try {
      const registry = new DirRegistry(join(dir, "registry"));
      const [rec] = await registry.list();
      assertEquals(rec.vmId, "crash-victim");

      // The crashed supervisor's listener socket file survived it and
      // blocks a naive re-listen.
      const staleListener = `${join(dir, "v.sock")}_7000`;
      assert((await Deno.stat(staleListener)).isSocket);
      let denied = false;
      try {
        listenVsock(join(dir, "v.sock"), 7000);
      } catch (err) {
        denied = err instanceof Deno.errors.AddrInUse;
      }
      assert(denied, "stale listener socket must AddrInUse before adopt");

      const vm = await Machine.adopt({ record: rec, registry });
      try {
        assertEquals(vm.vmId, "crash-victim");
        assertEquals(vm.pid, vmmPid);
        assertEquals(vm.state, "running");
        assertEquals((await vm.client.getInstanceInfo()).state, "Running");
        assertEquals(vm.consoleTail(), "", "adopted stdout is unobservable");

        // Adoption journaled itself and cleared the stale listener paths.
        const [adoptedRec] = await registry.list();
        assertEquals(adoptedRec.pid, vmmPid);
        assertEquals(adoptedRec.vsockListenerPaths, []);
        assertEquals(adoptedRec.supervisorPid, Deno.pid);
        assert(typeof adoptedRec.adoptedAt === "string");

        // The stale listener file is gone; re-listening now works.
        assertEquals(await Deno.stat(staleListener).catch(() => null), null);
        const listener = vm.vsock.listen(7000);
        assertEquals(listener.path, staleListener);

        // Live vsock traffic against the surviving VMM.
        using conn = await vm.vsock.connect(5000, { retryTimeoutMs: 5_000 });
        await conn.write(encoder.encode("adopted-ping"));
        assertEquals(await readN(conn, 12), "adopted-ping");

        const exit = await vm.shutdown();
        assertEquals(exit.observedVia, "pidfile-poll");
        assertEquals(exit.code, null);
        assertEquals(exit.signal, null);
      } finally {
        await vm[Symbol.asyncDispose]();
      }
      assertEquals(await registry.list(), [], "dispose must clear the record");
      assertEquals(
        await Deno.stat(join(dir, "state", "fc.sock")).catch(() => null),
        null,
        "api socket must be reclaimed",
      );
      assertEquals(
        await Deno.stat(join(dir, "v.sock")).catch(() => null),
        null,
        "vsock uds must be reclaimed",
      );
      assert(!pidAlive(vmmPid), "the adopted VMM must be dead after dispose");
    } finally {
      killQuietly(vmmPid);
    }
  });
});

Deno.test("adopt retains a listener path when stale unlink fails", async () => {
  await withDir(async (dir) => {
    const vmmPid = await orphanVmm(dir);
    try {
      const registry = new DirRegistry(join(dir, "registry"));
      const [original] = await registry.list();
      const blockedListener = join(dir, "blocked-listener");
      await Deno.mkdir(blockedListener);
      await Deno.writeTextFile(join(blockedListener, "keep"), "not a socket");
      await registry.update(original.vmId, {
        vsockListenerPaths: [blockedListener],
      });
      const [record] = await registry.list();

      const vm = await Machine.adopt({ record, registry });
      assertEquals((await registry.list())[0].vsockListenerPaths, [
        blockedListener,
      ]);
      await vm.shutdown();
      const cleanup = await assertRejects(
        () => vm[Symbol.asyncDispose](),
        CleanupError,
      );
      assert(
        cleanup.failures.some((failure) =>
          failure.step === "unlink-vsock-listener" &&
          failure.path === blockedListener
        ),
      );
      assertEquals(
        (await registry.list())[0].vsockListenerPaths,
        [blockedListener],
        "failed cleanup must retain its registry authority",
      );
    } finally {
      killQuietly(vmmPid);
    }
  });
});

Deno.test("adopt of a dead record refuses and touches nothing", async () => {
  await withDir(async (dir) => {
    const registry = new DirRegistry(join(dir, "registry"));
    const apiSocketPath = join(dir, "dead.sock");
    await Deno.writeTextFile(apiSocketPath, "stale");
    // A pid that is certainly gone: our own immediately-reaped child.
    const gone = new Deno.Command(Deno.execPath(), {
      args: ["eval", "0"],
      stdout: "null",
      stderr: "null",
    }).spawn();
    await gone.status;
    const rec = record("dead-vm", {
      pid: gone.pid,
      apiSocketPath,
      stateDir: dir,
    });
    await registry.put(rec);

    const err = await assertRejects(
      () => Machine.adopt({ record: rec, registry }),
      AdoptError,
    );
    assertEquals(err.reason, "vmm-not-found");
    assertEquals((await registry.list()).length, 1, "record must be kept");
    assert(
      (await Deno.stat(apiSocketPath)).isFile,
      "a refusal must not unlink anything",
    );
  });
});

Deno.test({
  name: "adopt refuses a recycled pid and leaves the stranger unharmed",
  ignore: !isLinux,
  fn: async () => {
    await withDir(async (dir) => {
      const registry = new DirRegistry(join(dir, "registry"));
      const innocent = new Deno.Command(Deno.execPath(), {
        args: ["eval", "setInterval(() => {}, 1_000_000)"],
        stdout: "null",
        stderr: "null",
      }).spawn();
      try {
        const rec = record("recycled-vm", {
          pid: innocent.pid, // "our" pid, recycled by an unrelated process
          apiSocketPath: join(dir, "nope.sock"),
          stateDir: dir,
        });
        await registry.put(rec);

        const err = await assertRejects(
          () => Machine.adopt({ record: rec, registry }),
          AdoptError,
        );
        assertEquals(err.reason, "vmm-not-found");
        assert(pidAlive(innocent.pid), "the stranger must not be signaled");
        assertEquals((await registry.list()).length, 1);
      } finally {
        innocent.kill("SIGKILL");
        await innocent.status;
      }
    });
  },
});

Deno.test({
  name: "adopt rescues a journal-gap record by cmdline scan",
  ignore: !isLinux,
  fn: async () => {
    await withDir(async (dir) => {
      const registry = new DirRegistry(join(dir, "registry"));
      const bin = await makeFakeVmmBin(dir, "ready");
      const apiSocketPath = join(dir, "gap.sock");
      const child = new Deno.Command(bin, {
        args: ["--api-sock", apiSocketPath, "--id", "gap-vm"],
        stdout: "null",
        stderr: "null",
      }).spawn();
      try {
        // Boot it so it is adoptable, driving the API directly.
        const { FirecrackerClient } = await import("../../src/api/mod.ts");
        using client = new FirecrackerClient({ socketPath: apiSocketPath });
        await client.waitReady({ timeoutMs: 5_000 });
        await client.putBootSource({ kernel_image_path: "/vmlinux" });
        await client.instanceStart();

        // The journal gap: a record that never learned the pid.
        const rec = record("gap-vm", {
          pid: null,
          apiSocketPath,
          stateDir: dir,
        });
        await registry.put(rec);

        const vm = await Machine.adopt({ record: rec, registry });
        try {
          assertEquals(vm.pid, child.pid);
          assertEquals(vm.state, "running");
          assertEquals((await registry.list())[0].pid, child.pid);
          await vm.shutdown();
          await child.status; // reap so dispose's liveness view is exact
        } finally {
          await vm[Symbol.asyncDispose]();
        }
        assertEquals(await registry.list(), []);
      } finally {
        try {
          child.kill("SIGKILL");
        } catch {
          // already dead
        }
        await child.status.catch(() => {});
      }
    });
  },
});

Deno.test("adopted machine observes external death via pidfile-poll", async () => {
  await withDir(async (dir) => {
    const vmmPid = await orphanVmm(dir);
    try {
      const registry = new DirRegistry(join(dir, "registry"));
      const [rec] = await registry.list();
      const vm = await Machine.adopt({ record: rec, registry });
      try {
        Deno.kill(vmmPid, "SIGKILL");
        const exit = await vm.exited;
        assertEquals(exit.observedVia, "pidfile-poll");
        assertEquals(exit.code, null);
        assertEquals(vm.state, "exited");
      } finally {
        await vm[Symbol.asyncDispose]();
      }
      assertEquals(await registry.list(), [], "dispose still reclaims");
    } finally {
      killQuietly(vmmPid);
    }
  });
});

Deno.test("adopt refuses a machine that never booted", async () => {
  await withDir(async (dir) => {
    const vmmPid = await orphanVmm(dir, ["--no-start"]);
    try {
      const registry = new DirRegistry(join(dir, "registry"));
      const [rec] = await registry.list();
      const err = await assertRejects(
        () => Machine.adopt({ record: rec, registry }),
        AdoptError,
      );
      assertEquals(err.reason, "not-started");
      assert(pidAlive(vmmPid), "a refusal must not kill");
      assertEquals((await registry.list()).length, 1);
    } finally {
      killQuietly(vmmPid);
    }
  });
});

Deno.test("adopt lands a paused orphan in paused; resume works", async () => {
  await withDir(async (dir) => {
    const vmmPid = await orphanVmm(dir, ["--pause", "--echo-port", "5000"]);
    try {
      const registry = new DirRegistry(join(dir, "registry"));
      const [rec] = await registry.list();
      const vm = await Machine.adopt({ record: rec, registry });
      try {
        assertEquals(vm.state, "paused");
        assertEquals((await vm.client.getInstanceInfo()).state, "Paused");
        await vm.resume();
        assertEquals(vm.state, "running");
        using conn = await vm.vsock.connect(5000, { retryTimeoutMs: 5_000 });
        await conn.write(encoder.encode("woke"));
        assertEquals(await readN(conn, 4), "woke");
        await vm.shutdown();
      } finally {
        await vm[Symbol.asyncDispose]();
      }
      assertEquals(await registry.list(), []);
    } finally {
      killQuietly(vmmPid);
    }
  });
});

Deno.test("adopting the same record twice is refused while the first is live", async () => {
  await withDir(async (dir) => {
    const vmmPid = await orphanVmm(dir);
    try {
      const registry = new DirRegistry(join(dir, "registry"));
      const [rec] = await registry.list();
      const vm = await Machine.adopt({ record: rec, registry });
      try {
        const err = await assertRejects(
          () => Machine.adopt({ record: rec, registry }),
          AdoptError,
        );
        assertEquals(err.reason, "already-adopted");
        assertEquals(vm.state, "running", "the live handle is unaffected");
        await vm.shutdown();
      } finally {
        await vm[Symbol.asyncDispose]();
      }
    } finally {
      killQuietly(vmmPid);
    }
  });
});

Deno.test("adopt refuses a corrupt jailed record before probing the API", async () => {
  await withDir(async (dir) => {
    const registry = new DirRegistry(join(dir, "registry"));
    const bin = await makeFakeVmmBin(dir, "never-bind");
    const apiSocketPath = join(dir, "corrupt.sock");
    const child = new Deno.Command(bin, {
      args: ["--api-sock", apiSocketPath],
      stdout: "null",
      stderr: "null",
    }).spawn();
    try {
      const rec = record("corrupt-vm", {
        pid: child.pid,
        apiSocketPath,
        stateDir: dir,
        // Jailed layout whose id segment disagrees with the vmId.
        chrootDir: join(dir, "jails", "firecracker-fake", "someone-else"),
      });
      await registry.put(rec);
      const err = await assertRejects(
        () => Machine.adopt({ record: rec, registry }),
        AdoptError,
      );
      assertEquals(err.reason, "corrupt-record");
      assert(pidAlive(child.pid));
    } finally {
      child.kill("SIGKILL");
      await child.status;
    }
  });
});

Deno.test("recover partitions adopted / reclaimed / unadoptable without killing anyone", async () => {
  await withDir(async (dir) => {
    const vmmPid = await orphanVmm(dir, ["--echo-port", "5000"]);
    let stuck: Deno.ChildProcess | undefined;
    try {
      const registry = new DirRegistry(join(dir, "registry"));

      // A dead record with stale files, alongside the live orphan.
      const deadState = join(dir, "dead-state");
      await Deno.mkdir(deadState, { recursive: true });
      const deadSock = join(deadState, "fc.sock");
      await Deno.writeTextFile(deadSock, "stale");
      await registry.put(record("dead-vm", {
        apiSocketPath: deadSock,
        stateDir: deadState,
        ownsStateDir: true,
      }));

      // A live process whose API never answers: unadoptable, must survive.
      const stuckSock = join(dir, "stuck.sock");
      const stuckBin = await makeFakeVmmBin(dir, "never-bind");
      stuck = new Deno.Command(stuckBin, {
        args: ["--api-sock", stuckSock],
        stdout: "null",
        stderr: "null",
      }).spawn();
      await registry.put(record("stuck-vm", {
        pid: stuck.pid,
        apiSocketPath: stuckSock,
        stateDir: dir,
      }));

      const sweep = await recover(registry, { readinessTimeoutMs: 500 });
      try {
        assertEquals(sweep.reclaimed, ["dead-vm"]);
        assertEquals(sweep.failures, []);
        assertEquals(sweep.kept, []);
        assertEquals(sweep.adopted.length, 1);
        assertEquals(sweep.adopted[0].vmId, "crash-victim");
        assertEquals(sweep.adopted[0].pid, vmmPid);
        assertEquals(sweep.unadoptable.length, 1);
        assertEquals(sweep.unadoptable[0].vmId, "stuck-vm");
        assertEquals(sweep.unadoptable[0].reason, "api-unreachable");
        assertEquals(sweep.unadoptable[0].disposition, "kept");

        assert(pidAlive(vmmPid), "adopted VMM is alive by definition");
        assert(pidAlive(stuck.pid), "unadoptable must be left running");
        assertEquals(
          await Deno.stat(deadState).catch(() => null),
          null,
          "dead record's files reclaimed",
        );
        // Registry keeps exactly the live records.
        const remaining = (await registry.list()).map((r) => r.vmId).sort();
        assertEquals(remaining, ["crash-victim", "stuck-vm"]);

        const vm = sweep.adopted[0];
        using conn = await vm.vsock.connect(5000, { retryTimeoutMs: 5_000 });
        await conn.write(encoder.encode("swept"));
        assertEquals(await readN(conn, 5), "swept");
        await vm.shutdown();
      } finally {
        for (const vm of sweep.adopted) {
          await vm[Symbol.asyncDispose]().catch(() => {});
        }
      }
    } finally {
      killQuietly(vmmPid);
      if (stuck !== undefined) {
        try {
          stuck.kill("SIGKILL");
        } catch {
          // already dead
        }
        await stuck.status.catch(() => {});
      }
    }
  });
});

Deno.test("recover onUnadoptable kill puts down a stuck VMM and reclaims it", async () => {
  await withDir(async (dir) => {
    const registry = new DirRegistry(join(dir, "registry"));
    const stuckSock = join(dir, "stuck.sock");
    const stuckBin = await makeFakeVmmBin(dir, "never-bind");
    const stuck = new Deno.Command(stuckBin, {
      args: ["--api-sock", stuckSock],
      stdout: "null",
      stderr: "null",
    }).spawn();
    try {
      await registry.put(record("stuck-vm", {
        pid: stuck.pid,
        apiSocketPath: stuckSock,
        stateDir: dir,
      }));

      const sweep = await recover(registry, {
        readinessTimeoutMs: 500,
        onUnadoptable: "kill",
      });
      assertEquals(sweep.adopted, []);
      assertEquals(sweep.failures, []);
      assertEquals(sweep.unadoptable.length, 1);
      assertEquals(sweep.unadoptable[0].reason, "api-unreachable");
      assertEquals(sweep.unadoptable[0].disposition, "killed");
      await stuck.status; // reap
      assert(!pidAlive(stuck.pid), "fleet mode must kill the stuck VMM");
      assertEquals(await registry.list(), []);
    } finally {
      try {
        stuck.kill("SIGKILL");
      } catch {
        // already dead
      }
      await stuck.status.catch(() => {});
    }
  });
});

Deno.test("a refusal leaves journaled listener sockets untouched", async () => {
  await withDir(async (dir) => {
    const vmmPid = await orphanVmm(dir, ["--no-start", "--listen", "7000"]);
    try {
      const registry = new DirRegistry(join(dir, "registry"));
      const [rec] = await registry.list();
      const staleListener = `${join(dir, "v.sock")}_7000`;
      assert((await Deno.stat(staleListener)).isSocket);

      const err = await assertRejects(
        () => Machine.adopt({ record: rec, registry }),
        AdoptError,
      );
      assertEquals(err.reason, "not-started");
      // The stale-listener unlink must run only AFTER every refusal
      // check has passed — a refused record's files stay exactly as found.
      assert(
        (await Deno.stat(staleListener)).isSocket,
        "refusal must not unlink listener sockets",
      );
      assertEquals((await registry.list())[0].vsockListenerPaths, [
        staleListener,
      ]);
    } finally {
      killQuietly(vmmPid);
    }
  });
});

Deno.test("adopt aborts with the record vanished mid-adoption: conflict", async () => {
  await withDir(async (dir) => {
    const vmmPid = await orphanVmm(dir);
    try {
      const registry = new DirRegistry(join(dir, "registry"));
      const [rec] = await registry.list();
      // A concurrent sweep owns the vmId now: the record file is gone.
      await registry.remove(rec.vmId);
      const err = await assertRejects(
        () => Machine.adopt({ record: rec, registry }),
        AdoptError,
      );
      assertEquals(err.reason, "conflict");
      assert(pidAlive(vmmPid), "a conflict refusal must not kill");
    } finally {
      killQuietly(vmmPid);
    }
  });
});

Deno.test("recover kill mode never kills this process's own adopted machine", async () => {
  await withDir(async (dir) => {
    const vmmPid = await orphanVmm(dir, ["--echo-port", "5000"]);
    try {
      const registry = new DirRegistry(join(dir, "registry"));
      const [rec] = await registry.list();
      const vm = await Machine.adopt({ record: rec, registry });
      try {
        const sweep = await recover(registry, { onUnadoptable: "kill" });
        assertEquals(sweep.adopted, []);
        assertEquals(sweep.unadoptable.length, 1);
        assertEquals(sweep.unadoptable[0].reason, "already-adopted");
        assertEquals(sweep.unadoptable[0].disposition, "kept");
        assert(pidAlive(vmmPid), "kill mode must never target a live handle");
        // The live handle is untouched and still works.
        using conn = await vm.vsock.connect(5000, { retryTimeoutMs: 5_000 });
        await conn.write(encoder.encode("safe"));
        assertEquals(await readN(conn, 4), "safe");
        await vm.shutdown();
      } finally {
        await vm[Symbol.asyncDispose]();
      }
    } finally {
      killQuietly(vmmPid);
    }
  });
});

Deno.test("adopt refuses when the API answers as a different instance", async () => {
  await withDir(async (dir) => {
    const registry = new DirRegistry(join(dir, "registry"));
    const bin = await makeFakeVmmBin(dir, "ready");
    const apiSocketPath = join(dir, "other.sock");
    const child = new Deno.Command(bin, {
      args: ["--api-sock", apiSocketPath, "--id", "someone-else"],
      stdout: "null",
      stderr: "null",
    }).spawn();
    try {
      const rec = record("mismatch-vm", {
        pid: child.pid,
        apiSocketPath,
        stateDir: dir,
      });
      await registry.put(rec);
      const err = await assertRejects(
        () =>
          Machine.adopt({ record: rec, registry, readinessTimeoutMs: 5_000 }),
        AdoptError,
      );
      assertEquals(err.reason, "api-mismatch");
      assert(pidAlive(child.pid), "the foreign instance must not be touched");
      assertEquals((await registry.list()).length, 1);
    } finally {
      child.kill("SIGKILL");
      await child.status;
    }
  });
});

Deno.test("a caller abort mid-probe propagates as the abort, never a verdict", async () => {
  await withDir(async (dir) => {
    const registry = new DirRegistry(join(dir, "registry"));
    const stuckSock = join(dir, "stuck.sock");
    const stuckBin = await makeFakeVmmBin(dir, "never-bind");
    const stuck = new Deno.Command(stuckBin, {
      args: ["--api-sock", stuckSock],
      stdout: "null",
      stderr: "null",
    }).spawn();
    try {
      const rec = record("stuck-vm", {
        pid: stuck.pid,
        apiSocketPath: stuckSock,
        stateDir: dir,
      });
      await registry.put(rec);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 100);
      try {
        const err = await assertRejects(() =>
          Machine.adopt({
            record: rec,
            registry,
            readinessTimeoutMs: 10_000,
            signal: controller.signal,
          })
        );
        // Misclassifying an abort as "api-unreachable" would let a
        // cancelled kill-mode sweep destroy an adoptable VM.
        assert(!(err instanceof AdoptError), `got AdoptError: ${err}`);
      } finally {
        clearTimeout(timer);
      }
      assert(pidAlive(stuck.pid));
      assertEquals((await registry.list()).length, 1);

      // And through recover(): an abort RESOLVES with the partial result
      // instead of rejecting (which would strand adopted handles).
      const c2 = new AbortController();
      const t2 = setTimeout(() => c2.abort(), 100);
      try {
        const sweep = await recover(registry, {
          readinessTimeoutMs: 10_000,
          signal: c2.signal,
        });
        assertEquals(sweep.adopted, []);
        assertEquals(sweep.unadoptable, []);
        assertEquals(sweep.failures, []);
        assertEquals(sweep.reclaimed, []);
      } finally {
        clearTimeout(t2);
      }
      assert(pidAlive(stuck.pid), "an aborted sweep must not kill anything");
      assertEquals((await registry.list()).length, 1);
    } finally {
      stuck.kill("SIGKILL");
      await stuck.status;
    }
  });
});

Deno.test("stdio null: no capture pipes, tails empty, machine fully works", async () => {
  await withDir(async (dir) => {
    const registry = new DirRegistry(join(dir, "registry"));
    const bin = await makeFakeVmmBin(dir, "ready");
    {
      await using vm = await Machine.launch({
        firecrackerBin: bin,
        id: "quiet-vm",
        stdio: "null",
        config: { boot_source: { kernel_image_path: "/vmlinux" } },
        stateDir: join(dir, "state"),
        registry,
      });
      assertEquals(vm.state, "running");
      assertEquals(vm.consoleTail(), "");
      assertEquals((await vm.client.getInstanceInfo()).state, "Running");
      const exit = await vm.shutdown();
      assertEquals(exit.stderrTail, "", "nothing captured by design");
    }
    assertEquals(await registry.list(), []);
  });
});

Deno.test("recover decide routes records to keep and reclaim", async () => {
  await withDir(async (dir) => {
    const vmmPid = await orphanVmm(dir);
    try {
      const registry = new DirRegistry(join(dir, "registry"));

      const kept = await recover(registry, { decide: () => "keep" });
      assertEquals(kept.kept, ["crash-victim"]);
      assertEquals(kept.adopted, []);
      assertEquals(kept.reclaimed, []);
      assert(pidAlive(vmmPid), "keep must not touch the VMM");
      assertEquals((await registry.list()).length, 1);

      const reclaimed = await recover(registry, { decide: () => "reclaim" });
      assertEquals(reclaimed.reclaimed, ["crash-victim"]);
      assertEquals(reclaimed.failures, []);
      assert(!pidAlive(vmmPid), "reclaim is the stray-session kill policy");
      assertEquals(await registry.list(), []);
    } finally {
      killQuietly(vmmPid);
    }
  });
});
