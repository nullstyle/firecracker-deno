import type {
  DirectMachineOptions,
  DirectRestoreOptions,
  JailedMachineOptions,
  JailedRestoreOptions,
  JailerOptions,
  VmRegistry,
} from "../../mod.ts";

Deno.test("all machine option modes retain their discriminated shapes", () => {
  const registry = {
    put: () => Promise.resolve(),
    update: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    list: () => Promise.resolve([]),
  } satisfies VmRegistry;
  const jailer = {
    jailerBin: "/bin/jailer",
    firecrackerBin: "/bin/firecracker",
    id: "vm",
    uid: 1_000,
    gid: 1_000,
  } satisfies JailerOptions;
  const config = {
    boot_source: { kernel_image_path: "/vmlinux" },
  } as const;
  const snapshot = {
    snapshot_path: "/vm.state",
    mem_backend: { backend_type: "File", backend_path: "/vm.mem" },
  } as const;

  const directCreate = {
    firecrackerBin: "/bin/firecracker",
    config,
    stateDir: "/tmp/vm",
  } satisfies DirectMachineOptions;
  const jailedCreate = {
    jailer,
    registry,
    config,
  } satisfies JailedMachineOptions;
  const directRestore = {
    firecrackerBin: "/bin/firecracker",
    snapshot,
  } satisfies DirectRestoreOptions;
  const jailedRestore = {
    jailer,
    registry,
    snapshot,
  } satisfies JailedRestoreOptions;

  const badDirectCreate = {
    ...directCreate,
    // @ts-expect-error -- direct create forbids jailer options.
    jailer,
  } satisfies DirectMachineOptions;
  const badJailedCreate = {
    ...jailedCreate,
    // @ts-expect-error -- jailed create forbids a separate binary.
    firecrackerBin: "/bin/firecracker",
  } satisfies JailedMachineOptions;
  const badDirectRestore = {
    ...directRestore,
    // @ts-expect-error -- direct restore forbids jailer options.
    jailer,
  } satisfies DirectRestoreOptions;
  const badJailedRestore = {
    ...jailedRestore,
    // @ts-expect-error -- jailed restore forbids a direct state directory.
    stateDir: "/tmp/vm",
  } satisfies JailedRestoreOptions;

  void [
    directCreate,
    jailedCreate,
    directRestore,
    jailedRestore,
    badDirectCreate,
    badJailedCreate,
    badDirectRestore,
    badJailedRestore,
  ];
});
