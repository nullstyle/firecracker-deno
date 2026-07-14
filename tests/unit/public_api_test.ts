import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

interface DocJson {
  nodes: Record<string, {
    symbols?: Array<{ name: string }>;
  }>;
}

const ENTRYPOINTS: Record<string, { url: URL; symbols: string[] }> = {
  root: {
    url: new URL("../../mod.ts", import.meta.url),
    symbols: [
      "AdoptError",
      "AdoptFailureReason",
      "AdoptOptions",
      "ApiError",
      "CleanupError",
      "CleanupFailure",
      "CommonMachineOptions",
      "CommonRestoreOptions",
      "DirRegistry",
      "DirectMachineOptions",
      "DirectRestoreOptions",
      "ExitObservation",
      "FIRECRACKER_COMPAT",
      "FirecrackerCompat",
      "FirecrackerError",
      "InvalidStateError",
      "JailRecord",
      "JailedMachineOptions",
      "JailedRestoreOptions",
      "JailerConfigError",
      "JailerOptions",
      "Machine",
      "MachineOptions",
      "ProcessExitedError",
      "ReadinessTimeoutError",
      "ReconcileOptions",
      "ReconcileResult",
      "RecoverOptions",
      "RecoverResult",
      "RestoreOptions",
      "ShutdownOptions",
      "ShutdownStage",
      "ShutdownTimeoutError",
      "StageEntry",
      "TransportError",
      "VmConfig",
      "VmRegistry",
      "VmState",
      "VmmExit",
      "VsockDialError",
      "VsockDialFailureReason",
      "reconcile",
      "recover",
    ],
  },
  client: {
    url: new URL("../../src/api/mod.ts", import.meta.url),
    symbols: [
      "ApiFault",
      "ApiTransport",
      "ArmRegisterModifier",
      "Balloon",
      "BalloonHintingStatus",
      "BalloonStartCmd",
      "BalloonStats",
      "BalloonStatsUpdate",
      "BalloonUpdate",
      "BootSource",
      "CpuConfig",
      "CpuTemplate",
      "CpuidLeafModifier",
      "CpuidRegisterModifier",
      "Drive",
      "EntropyDevice",
      "FirecrackerClient",
      "FirecrackerClientOptions",
      "FirecrackerVersion",
      "FullVmConfiguration",
      "InstanceActionInfo",
      "InstanceInfo",
      "Logger",
      "MachineConfiguration",
      "MemoryBackend",
      "MemoryHotplugConfig",
      "MemoryHotplugSizeUpdate",
      "MemoryHotplugStatus",
      "Metrics",
      "MmdsConfig",
      "MmdsContentsObject",
      "MsrModifier",
      "NetworkInterface",
      "NetworkOverride",
      "PartialDrive",
      "PartialNetworkInterface",
      "PartialPmem",
      "Pmem",
      "RateLimiter",
      "RequestOptions",
      "SerialDevice",
      "SnapshotCreateParams",
      "SnapshotLoadParams",
      "TokenBucket",
      "UnixHttpTransport",
      "VcpuFeatures",
      "Vm",
      "Vsock",
      "VsockOverride",
      "WaitReadyOptions",
      "components",
      "operations",
      "paths",
    ],
  },
  vsock: {
    url: new URL("../../src/vsock/mod.ts", import.meta.url),
    symbols: [
      "VsockConn",
      "VsockDialOptions",
      "VsockListener",
      "connectVsock",
      "listenVsock",
    ],
  },
  jailer: {
    url: new URL("../../src/jailer/mod.ts", import.meta.url),
    symbols: [
      "DEFAULT_CHROOT_BASE",
      "JailPaths",
      "JailerOptions",
      "StageEntry",
      "StagingAction",
      "assertNoTraversal",
      "buildJailerArgv",
      "computeJailPaths",
      "hostPathOf",
      "planStaging",
      "stageChroot",
      "stagedJailPath",
      "validateJailerOptions",
    ],
  },
  testing: {
    url: new URL("../../testing/mod.ts", import.meta.url),
    symbols: [
      "FakeFirecracker",
      "FakeFirecrackerOptions",
      "InjectedFailure",
      "RecordedRequest",
      "VsockPortHandler",
      "makeFakeJailerBin",
      "makeFakeVmmBin",
    ],
  },
};

async function documentedSymbols(url: URL): Promise<string[]> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["doc", "--json", fromFileUrl(url)],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(
    output.success,
    new TextDecoder().decode(output.stderr),
  );
  const doc = JSON.parse(new TextDecoder().decode(output.stdout)) as DocJson;
  const nodes = Object.values(doc.nodes);
  assertEquals(nodes.length, 1, "deno doc should report one entry module");
  return (nodes[0].symbols ?? []).map((symbol) => symbol.name).sort();
}

for (const [name, entrypoint] of Object.entries(ENTRYPOINTS)) {
  Deno.test(`public API: ${name} exports the exact allowlist`, async () => {
    assertEquals(
      await documentedSymbols(entrypoint.url),
      [...entrypoint.symbols].sort(),
    );
  });
}

Deno.test("package exports only canonical entrypoints", async () => {
  const config = JSON.parse(
    await Deno.readTextFile(new URL("../../deno.json", import.meta.url)),
  ) as { exports: Record<string, string> };
  assertEquals(Object.keys(config.exports).sort(), [
    ".",
    "./client",
    "./jailer",
    "./testing",
    "./vsock",
  ]);
});
