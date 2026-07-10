import { assertEquals, assertThrows } from "@std/assert";
import { JailerConfigError } from "../../src/errors.ts";
import { buildJailerArgv } from "../../src/jailer/argv.ts";
import {
  type JailerOptions,
  validateJailerOptions,
} from "../../src/jailer/options.ts";
import { computeJailPaths, hostPathOf } from "../../src/jailer/paths.ts";
import { planStaging } from "../../src/jailer/stage.ts";

const BASE: JailerOptions = {
  jailerBin: "/usr/bin/jailer",
  firecrackerBin: "/usr/bin/firecracker",
  id: "vm-1",
  uid: 1000,
  gid: 1000,
};

Deno.test("argv: minimal options produce the canonical command line", () => {
  assertEquals(buildJailerArgv(BASE, ["--api-sock", "/fc.sock"]), [
    "--id",
    "vm-1",
    "--exec-file",
    "/usr/bin/firecracker",
    "--uid",
    "1000",
    "--gid",
    "1000",
    "--cgroup-version",
    "2",
    "--",
    "--api-sock",
    "/fc.sock",
  ]);
});

Deno.test("argv: every option maps to its flag", () => {
  const argv = buildJailerArgv({
    ...BASE,
    chrootBaseDir: "/jails",
    netnsPath: "/var/run/netns/sandbox",
    cgroupVersion: 1,
    cgroups: { "cpu.weight": "50" },
    parentCgroup: "sandboxes",
    resourceLimits: { fsize: 1024, noFile: 256 },
    daemonize: true,
    newPidNs: true,
  }, []);
  const joined = argv.join(" ");
  for (
    const expected of [
      "--chroot-base-dir /jails",
      "--netns /var/run/netns/sandbox",
      "--cgroup-version 1",
      "--cgroup cpu.weight=50",
      "--parent-cgroup sandboxes",
      "--resource-limit fsize=1024",
      "--resource-limit no-file=256",
      "--daemonize",
      "--new-pid-ns",
    ]
  ) {
    assertEquals(joined.includes(expected), true, `missing: ${expected}`);
  }
  assertEquals(argv.at(-1), "--");
});

Deno.test("paths: chroot layout and host path mapping", () => {
  const paths = computeJailPaths({
    firecrackerBin: "/opt/bin/firecracker-v1.16",
    id: "abc",
    chrootBaseDir: "/jails",
  });
  assertEquals(paths.jailRoot, "/jails/firecracker-v1.16/abc");
  assertEquals(paths.chrootRoot, "/jails/firecracker-v1.16/abc/root");
  assertEquals(
    paths.pidfileHost,
    "/jails/firecracker-v1.16/abc/root/firecracker-v1.16.pid",
  );
  assertEquals(
    hostPathOf(paths, "/v.sock"),
    "/jails/firecracker-v1.16/abc/root/v.sock",
  );
  assertEquals(
    hostPathOf(paths, "run/fc.sock"),
    "/jails/firecracker-v1.16/abc/root/run/fc.sock",
  );
  assertThrows(() => hostPathOf(paths, "/../escape"), TypeError);
});

Deno.test("paths: default chroot base matches the jailer's", () => {
  const paths = computeJailPaths({ firecrackerBin: "firecracker", id: "x" });
  assertEquals(paths.jailRoot, "/srv/jailer/firecracker/x");
});

Deno.test("validation rejects bad ids, exec names, uids, and staging", () => {
  validateJailerOptions(BASE); // sane baseline passes
  assertThrows(
    () => validateJailerOptions({ ...BASE, id: "has_underscore" }),
    JailerConfigError,
    "invalid",
  );
  assertThrows(
    () => validateJailerOptions({ ...BASE, id: "x".repeat(65) }),
    JailerConfigError,
  );
  assertThrows(
    () => validateJailerOptions({ ...BASE, firecrackerBin: "/usr/bin/fc" }),
    JailerConfigError,
    "firecracker",
  );
  assertThrows(
    () => validateJailerOptions({ ...BASE, uid: -1 }),
    JailerConfigError,
    "uid",
  );
  assertThrows(
    () => validateJailerOptions({ ...BASE, gid: 1.5 }),
    JailerConfigError,
    "gid",
  );
  assertThrows(
    () =>
      validateJailerOptions({
        ...BASE,
        stage: [{ hostPath: "/a", jailPath: "/../out" }],
      }),
    JailerConfigError,
    '".."',
  );
  assertThrows(
    () =>
      validateJailerOptions({
        ...BASE,
        stage: [{ hostPath: "/a/vmlinux" }, { hostPath: "/b/vmlinux" }],
      }),
    JailerConfigError,
    "collision",
  );
});

Deno.test("staging plan: defaults, modes, and permissions", () => {
  const paths = computeJailPaths({
    firecrackerBin: "/usr/bin/firecracker",
    id: "vm-1",
    chrootBaseDir: "/jails",
  });
  const plan = planStaging(paths, [
    { hostPath: "/images/vmlinux-6.1" },
    { hostPath: "/images/rootfs.ext4", readWrite: true, mode: "copy" },
    { hostPath: "/images/data.img", jailPath: "/disks/data.img" },
  ]);
  assertEquals(plan, [
    {
      hostPath: "/images/vmlinux-6.1",
      jailPath: "/vmlinux-6.1",
      destPath: "/jails/firecracker/vm-1/root/vmlinux-6.1",
      mode: "hardlink",
      chmod: 0o400,
    },
    {
      hostPath: "/images/rootfs.ext4",
      jailPath: "/rootfs.ext4",
      destPath: "/jails/firecracker/vm-1/root/rootfs.ext4",
      mode: "copy",
      chmod: 0o600,
    },
    {
      hostPath: "/images/data.img",
      jailPath: "/disks/data.img",
      destPath: "/jails/firecracker/vm-1/root/disks/data.img",
      mode: "hardlink",
      chmod: 0o400,
    },
  ]);
});
