import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  ApiError,
  CleanupError,
  FirecrackerError,
  InvalidStateError,
  JailerConfigError,
  ProcessExitedError,
  ReadinessTimeoutError,
  ShutdownTimeoutError,
  TransportError,
  VsockDialError,
} from "../../src/errors.ts";
import type { VmmExit } from "../../src/types.ts";

const exit: VmmExit = {
  code: null,
  signal: "SIGKILL",
  observedVia: "child-status",
  stderrTail: "panic: no kvm",
};

const samples: Array<{ err: FirecrackerError; code: string; name: string }> = [
  {
    err: new ApiError({
      status: 400,
      faultMessage: "The kernel file cannot be opened",
      method: "PUT",
      path: "/boot-source",
    }),
    code: "FC_API",
    name: "ApiError",
  },
  {
    err: new TransportError({ socketPath: "/run/fc.sock" }),
    code: "FC_TRANSPORT",
    name: "TransportError",
  },
  {
    err: new ProcessExitedError({ exit, operation: "start" }),
    code: "FC_VMM_EXITED",
    name: "ProcessExitedError",
  },
  {
    err: new ReadinessTimeoutError({
      socketPath: "/run/fc.sock",
      waitedMs: 5000,
      stderrTail: "",
    }),
    code: "FC_TIMEOUT",
    name: "ReadinessTimeoutError",
  },
  {
    err: new ShutdownTimeoutError({ stageReached: "sigkill" }),
    code: "FC_SHUTDOWN",
    name: "ShutdownTimeoutError",
  },
  {
    err: new VsockDialError({
      reason: "closed-before-ok",
      udsPath: "/run/v.sock",
      port: 5000,
      attempts: 42,
    }),
    code: "FC_VSOCK_DIAL",
    name: "VsockDialError",
  },
  {
    err: new JailerConfigError("id must be alphanumeric"),
    code: "FC_JAILER",
    name: "JailerConfigError",
  },
  {
    err: new InvalidStateError({ state: "exited", operation: "pause" }),
    code: "FC_STATE",
    name: "InvalidStateError",
  },
  {
    err: new CleanupError({
      failures: [{ step: "remove-chroot", path: "/srv/jailer/fc/x", cause: 1 }],
      leaked: ["/srv/jailer/fc/x"],
    }),
    code: "FC_CLEANUP",
    name: "CleanupError",
  },
];

Deno.test("every error extends FirecrackerError and Error with a stable code and name", () => {
  for (const { err, code, name } of samples) {
    assert(err instanceof Error, `${name} instanceof Error`);
    assert(
      err instanceof FirecrackerError,
      `${name} instanceof FirecrackerError`,
    );
    assertEquals(err.code, code);
    assertEquals(err.name, name);
    assert(err.message.length > 0, `${name} has a message`);
  }
});

Deno.test("codes are unique across the taxonomy", () => {
  const codes = samples.map((s) => s.code);
  assertEquals(new Set(codes).size, codes.length);
});

Deno.test("ApiError message names the request and fault", () => {
  const err = new ApiError({
    status: 400,
    faultMessage: "The kernel file cannot be opened",
    method: "PUT",
    path: "/boot-source",
  });
  assertStringIncludes(err.message, "PUT /boot-source");
  assertStringIncludes(err.message, "400");
  assertStringIncludes(err.message, "kernel file");
});

Deno.test("ProcessExitedError surfaces the stderr tail and observation mode", () => {
  const err = new ProcessExitedError({ exit, operation: "waitReady" });
  assertStringIncludes(err.message, "SIGKILL");
  assertStringIncludes(err.message, "child-status");
  assertStringIncludes(err.message, "panic: no kvm");
  assertEquals(err.exit, exit);
});

Deno.test("InvalidStateError names the operation and state", () => {
  const err = new InvalidStateError({ state: "exited", operation: "pause" });
  assertStringIncludes(err.message, "pause");
  assertStringIncludes(err.message, "exited");
});

Deno.test("errors carry a cause when given one", () => {
  const cause = new Error("underlying");
  const err = new TransportError({ socketPath: "/run/fc.sock", cause });
  assertEquals(err.cause, cause);
});
