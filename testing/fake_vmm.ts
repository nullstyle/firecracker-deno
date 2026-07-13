/**
 * A spawnable Firecracker process double for supervision tests. Behaves
 * like the real binary from the supervisor's point of view: takes
 * `--api-sock`, serves the API (via FakeFirecracker), writes errors to
 * stderr, exits on signals.
 *
 * Modes via FAKE_VMM_MODE:
 * - "ready" (default): bind the API socket (after FAKE_VMM_BIND_DELAY_MS)
 *   and run until signaled. SendCtrlAltDel exits 0 (graceful guest stop).
 * - "exit-before-bind": write a fatal error to stderr and exit 7 without
 *   ever binding the socket.
 * - "never-bind": never bind the socket; hang until signaled.
 * - "ignore-sigterm": like "ready", but SIGTERM is caught and ignored —
 *   only SIGKILL works.
 */

import { FakeFirecracker } from "./mod.ts";

// Mirror real Firecracker's argv strictness: repeated flags are fatal.
// (The jailer injects --id itself; a supervisor that also forwards --id
// gets exactly this error from the real binary — exit code 153.)
for (const flag of ["--id", "--api-sock"]) {
  if (Deno.args.filter((arg) => arg === flag).length > 1) {
    console.error(
      `Error: ParseArguments(DuplicateArgument(${
        JSON.stringify(flag.replace(/^--/, ""))
      }))`,
    );
    Deno.exit(153);
  }
}

const sockIdx = Deno.args.indexOf("--api-sock");
const socketPath = sockIdx === -1 ? undefined : Deno.args[sockIdx + 1];
// Real Firecracker reports its --id in `GET /` InstanceInfo; mirror that
// so identity checks (e.g. Machine.adopt's api-mismatch guard) see the
// same behavior against the fake.
const idIdx = Deno.args.indexOf("--id");
const instanceId = idIdx === -1 ? undefined : Deno.args[idIdx + 1];
const mode = Deno.env.get("FAKE_VMM_MODE") ?? "ready";
const bindDelayMs = Number(Deno.env.get("FAKE_VMM_BIND_DELAY_MS") ?? "0");

function forever(): Promise<never> {
  // A pending promise alone does not keep Deno's event loop alive; without
  // a live timer the runtime exits with "top-level await never resolved".
  setInterval(() => {}, 1 << 30);
  return new Promise<never>(() => {});
}

switch (mode) {
  case "exit-before-bind": {
    console.error("fake-vmm: fatal: could not open /dev/kvm");
    Deno.exit(7);
    break;
  }
  case "never-bind": {
    console.error("fake-vmm: stalling before bind");
    await forever();
    break;
  }
  case "ready":
  case "ignore-sigterm": {
    if (socketPath === undefined) {
      console.error("fake-vmm: missing --api-sock");
      Deno.exit(2);
    }
    if (mode === "ignore-sigterm") {
      Deno.addSignalListener("SIGTERM", () => {
        console.error("fake-vmm: ignoring SIGTERM");
      });
    }
    if (bindDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, bindDelayMs));
    }
    const fake = await FakeFirecracker.start({
      dir: await Deno.makeTempDir({ prefix: "fake-vmm-" }),
      socketPath,
      ...(instanceId !== undefined ? { id: instanceId } : {}),
      onCtrlAltDel: () => setTimeout(() => Deno.exit(0), 5),
      vsockPathPrefix: Deno.env.get("FAKE_VMM_CHROOT"),
    });
    const echoPort = Deno.env.get("FAKE_VMM_ECHO_PORT");
    if (echoPort !== undefined) {
      fake.onVsockPort(Number(echoPort), async (conn) => {
        try {
          const buf = new Uint8Array(4096);
          while (true) {
            const n = await conn.read(buf);
            if (n === null) break;
            await conn.write(buf.subarray(0, n));
          }
        } catch {
          // peer closed
        } finally {
          try {
            conn.close();
          } catch {
            // already closed
          }
        }
      });
    }
    console.error("fake-vmm: api ready");
    await forever();
    break;
  }
  default: {
    console.error(`fake-vmm: unknown mode ${mode}`);
    Deno.exit(2);
  }
}
