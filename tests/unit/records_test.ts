import { assert, assertEquals } from "@std/assert";
import {
  cleanupStepsForResources,
  type MachineResources,
  type ResourceListener,
} from "../../src/internal/resources.ts";
import {
  recordFromResources,
  resourcesFromRecord,
} from "../../src/registry/record.ts";

Deno.test("resource records retain the exact v1 persisted shape", () => {
  const resources: MachineResources = {
    apiSocketPath: "/jail/root/fc.sock",
    stateDir: "/jail",
    ownsStateDir: false,
    vsockUdsPath: "/jail/root/v.sock",
    vsockListeners: new Set(["/jail/root/v.sock_5000"]),
    pidfilePath: "/jail/root/firecracker.pid",
    chrootDir: "/jail",
    cgroupPath: "/sys/fs/cgroup/firecracker/vm",
  };

  const record = recordFromResources("vm", resources, { tenant: "one" });
  const { createdAt, ...persisted } = record;
  assert(!Number.isNaN(Date.parse(createdAt)));
  assertEquals(persisted, {
    version: 1,
    vmId: "vm",
    pid: null,
    apiSocketPath: "/jail/root/fc.sock",
    stateDir: "/jail",
    ownsStateDir: false,
    vsockUdsPath: "/jail/root/v.sock",
    vsockListenerPaths: ["/jail/root/v.sock_5000"],
    pidfilePath: "/jail/root/firecracker.pid",
    chrootDir: "/jail",
    cgroupPath: "/sys/fs/cgroup/firecracker/vm",
    metadata: { tenant: "one" },
  });
  assertEquals(resourcesFromRecord(record), resources);

  const minimal = recordFromResources("direct", {
    apiSocketPath: "/state/fc.sock",
    stateDir: "/state",
    ownsStateDir: false,
    vsockListeners: new Set(),
  });
  assertEquals(Object.keys(minimal).sort(), [
    "apiSocketPath",
    "createdAt",
    "ownsStateDir",
    "pid",
    "stateDir",
    "version",
    "vmId",
    "vsockListenerPaths",
  ]);
});

Deno.test("resource cleanup closes listeners, deduplicates roots, and leaves cgroup last", () => {
  const liveListener: ResourceListener = {
    path: "/jail/root/v.sock_5000",
    [Symbol.asyncDispose]: () => Promise.resolve(),
  };
  const resources: MachineResources = {
    apiSocketPath: "/jail/root/fc.sock",
    stateDir: "/jail",
    ownsStateDir: false,
    vsockUdsPath: "/jail/root/v.sock",
    vsockListeners: new Set([
      liveListener,
      "/legacy/outside/v.sock_6000",
    ]),
    pidfilePath: "/jail/root/firecracker.pid",
    chrootDir: "/jail",
    cgroupPath: "/sys/fs/cgroup/firecracker/vm",
  };

  const steps = cleanupStepsForResources(resources);
  assertEquals(steps.map((step) => step.step), [
    "close-vsock-listener",
    "remove-chroot",
    "unlink-vsock-listener",
    "remove-cgroup",
  ]);
  assertEquals(steps[2].path, "/legacy/outside/v.sock_6000");
});

Deno.test("caller-owned direct state keeps the directory but unlinks named files", () => {
  const resources: MachineResources = {
    apiSocketPath: "/state/fc.sock",
    stateDir: "/state",
    ownsStateDir: false,
    vsockUdsPath: "/outside/v.sock",
    vsockListeners: new Set(),
  };

  assertEquals(
    cleanupStepsForResources(resources).map((step) => step.step),
    ["unlink-api-socket", "unlink-vsock-uds"],
  );
  resources.ownsStateDir = true;
  assertEquals(
    cleanupStepsForResources(resources).map((step) => step.step),
    ["remove-state-dir", "unlink-vsock-uds"],
  );
});
