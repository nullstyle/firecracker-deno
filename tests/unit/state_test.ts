import { assertEquals, assertRejects } from "@std/assert";
import { InvalidStateError, ProcessExitedError } from "../../src/errors.ts";
import { LifecycleState } from "../../src/machine/state.ts";
import type { VmmExit } from "../../src/types.ts";

const EXIT: VmmExit = {
  code: 1,
  signal: null,
  observedVia: "child-status",
  stderrTail: "boom",
};

Deno.test("full legal lifecycle path", () => {
  const s = new LifecycleState();
  assertEquals(s.state, "configured");
  for (
    const next of [
      "starting",
      "running",
      "paused",
      "running",
      "shutting_down",
      "exited",
      "cleaned",
    ] as const
  ) {
    assertEquals(s.transition(next), true, `to ${next}`);
  }
  assertEquals(s.state, "cleaned");
});

Deno.test("illegal transitions are ignored, not applied", () => {
  const s = new LifecycleState();
  assertEquals(s.transition("paused"), false);
  assertEquals(s.state, "configured");
  s.transition("exited", EXIT);
  assertEquals(s.transition("running"), false);
  assertEquals(s.state, "exited");
});

Deno.test("assert throws InvalidStateError naming state and operation", () => {
  const s = new LifecycleState();
  try {
    s.assert("pause", "running");
    throw new Error("should have thrown");
  } catch (err) {
    if (!(err instanceof InvalidStateError)) throw err;
    assertEquals(err.state, "configured");
    assertEquals(err.operation, "pause");
  }
});

Deno.test("waitFor resolves when the state is reached", async () => {
  const s = new LifecycleState();
  const wait = s.waitFor("running");
  s.transition("starting");
  s.transition("running");
  await wait;
});

Deno.test("waitFor rejects with ProcessExitedError when the VMM dies first", async () => {
  const s = new LifecycleState();
  const wait = s.waitFor("running");
  s.transition("exited", EXIT);
  const err = await assertRejects(() => wait, ProcessExitedError);
  assertEquals(err.exit.code, 1);
});

Deno.test("waitFor times out", async () => {
  const s = new LifecycleState();
  await assertRejects(
    () => s.waitFor("running", { timeoutMs: 50 }),
    InvalidStateError,
    "timed out",
  );
});

Deno.test("waitFor on the current state resolves immediately", async () => {
  const s = new LifecycleState();
  await s.waitFor("configured");
});
