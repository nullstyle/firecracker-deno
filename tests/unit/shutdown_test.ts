import { assert, assertEquals, assertRejects } from "@std/assert";
import { ShutdownTimeoutError } from "../../src/errors.ts";
import {
  escalatingShutdown,
  type ShutdownTarget,
} from "../../src/process/shutdown.ts";
import type { VmmExit } from "../../src/types.ts";

const EXIT: VmmExit = {
  code: 0,
  signal: null,
  observedVia: "child-status",
  stderrTail: "",
};

/** Scriptable target: choose which stage (if any) makes the process exit. */
function makeTarget(opts: {
  ctrlAltDelFails?: boolean;
  exitOn?: "ctrl-alt-del" | "SIGTERM" | "SIGKILL" | "never";
}): ShutdownTarget & { killed: Deno.Signal[]; ctrlAltDelCalls: number } {
  let resolveExit!: (exit: VmmExit) => void;
  const exited = new Promise<VmmExit>((resolve) => {
    resolveExit = resolve;
  });
  const target = {
    killed: [] as Deno.Signal[],
    ctrlAltDelCalls: 0,
    sendCtrlAltDel(): Promise<void> {
      target.ctrlAltDelCalls++;
      if (opts.ctrlAltDelFails) {
        return Promise.reject(new Error("API socket is gone"));
      }
      if (opts.exitOn === "ctrl-alt-del") {
        setTimeout(() => resolveExit({ ...EXIT }), 5);
      }
      return Promise.resolve();
    },
    kill(signal: Deno.Signal): void {
      target.killed.push(signal);
      if (signal === opts.exitOn) {
        setTimeout(
          () => resolveExit({ ...EXIT, code: null, signal }),
          5,
        );
      }
    },
    exited,
  };
  return target;
}

const FAST = {
  ctrlAltDelTimeoutMs: 80,
  sigtermTimeoutMs: 80,
  sigkillTimeoutMs: 80,
};

Deno.test("x86_64: guest exits during CtrlAltDel stage — no signals sent", async () => {
  const target = makeTarget({ exitOn: "ctrl-alt-del" });
  const exit = await escalatingShutdown(target, FAST, "x86_64");
  assertEquals(exit.code, 0);
  assertEquals(target.ctrlAltDelCalls, 1);
  assertEquals(target.killed, []);
});

Deno.test("x86_64: CtrlAltDel API failure falls through to SIGTERM immediately", async () => {
  const target = makeTarget({ ctrlAltDelFails: true, exitOn: "SIGTERM" });
  const exit = await escalatingShutdown(target, FAST, "x86_64");
  assertEquals(exit.signal, "SIGTERM");
  assertEquals(target.killed, ["SIGTERM"]);
});

Deno.test("escalates through every stage when the process ignores them", async () => {
  const target = makeTarget({ exitOn: "SIGKILL" });
  const started = performance.now();
  const exit = await escalatingShutdown(target, FAST, "x86_64");
  const elapsed = performance.now() - started;
  assertEquals(exit.signal, "SIGKILL");
  assertEquals(target.killed, ["SIGTERM", "SIGKILL"]);
  assert(elapsed >= 160, `should have waited two deadlines, took ${elapsed}ms`);
});

Deno.test("throws ShutdownTimeoutError when even SIGKILL is survived", async () => {
  const target = makeTarget({ exitOn: "never" });
  const err = await assertRejects(
    () => escalatingShutdown(target, FAST, "x86_64"),
    ShutdownTimeoutError,
  );
  assertEquals(err.stageReached, "sigkill");
  assertEquals(target.killed, ["SIGTERM", "SIGKILL"]);
});

Deno.test("aarch64 skips the CtrlAltDel stage entirely", async () => {
  const target = makeTarget({ exitOn: "SIGTERM" });
  const exit = await escalatingShutdown(target, FAST, "aarch64");
  assertEquals(exit.signal, "SIGTERM");
  assertEquals(target.ctrlAltDelCalls, 0);
});

Deno.test("ctrlAltDelTimeoutMs of 0 skips stage 1 on x86_64 too", async () => {
  const target = makeTarget({ exitOn: "SIGTERM" });
  await escalatingShutdown(
    target,
    { ...FAST, ctrlAltDelTimeoutMs: 0 },
    "x86_64",
  );
  assertEquals(target.ctrlAltDelCalls, 0);
});
