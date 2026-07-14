/**
 * Fetch Firecracker test assets into `tests/assets/`:
 *
 * - `firecracker` + `jailer` release binaries (Linux binaries — downloadable
 *   anywhere, runnable only on Linux),
 * - `vmlinux` — the newest guest kernel from the Firecracker CI bucket,
 * - `rootfs.squashfs` — the newest Ubuntu CI rootfs (CI converts it to ext4;
 *   see .github/workflows/ci.yml).
 *
 * Downloads are recorded in `manifest.json` (url + sha256) and skipped when
 * the on-disk file already matches.
 *
 * Usage: deno run -A tools/fetch-firecracker.ts [--tag vX.Y.Z] [--dir tests/assets]
 *
 * @module
 */

import { Command } from "@cliffy/command";
import { join } from "@std/path";

const versions = JSON.parse(await Deno.readTextFile("spec/versions.json")) as {
  pinned: string;
};
const { options } = await new Command()
  .name("fetch-firecracker")
  .description("Fetch Firecracker binaries and guest test assets.")
  .option("--tag <tag:string>", "Firecracker release tag.", {
    default: versions.pinned,
  })
  .option("--dir <dir:file>", "Output directory.", {
    default: "tests/assets",
  })
  .parse(Deno.args);

const { tag, dir: outDir } = options;
const arch = Deno.build.arch === "aarch64" ? "aarch64" : "x86_64";
await Deno.mkdir(outDir, { recursive: true });

const manifestPath = join(outDir, "manifest.json");
let manifest: Record<string, { url: string; sha256: string }> = {};
try {
  manifest = JSON.parse(await Deno.readTextFile(manifestPath));
} catch {
  // first run
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function fileMatchesManifest(
  name: string,
  url: string,
): Promise<boolean> {
  const entry = manifest[name];
  if (entry === undefined || entry.url !== url) return false;
  try {
    const bytes = await Deno.readFile(join(outDir, name));
    return await sha256(bytes) === entry.sha256;
  } catch {
    return false;
  }
}

async function download(
  name: string,
  url: string,
  mode?: number,
): Promise<void> {
  if (await fileMatchesManifest(name, url)) {
    console.log(`✓ ${name} up to date`);
    return;
  }
  console.log(`↓ ${name} ← ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const dest = join(outDir, name);
  await Deno.writeFile(dest, bytes);
  if (mode !== undefined) await Deno.chmod(dest, mode);
  manifest[name] = { url, sha256: await sha256(bytes) };
  console.log(`  ${bytes.length} bytes, sha256 ${manifest[name].sha256}`);
}

async function listBucket(prefix: string): Promise<string[]> {
  const res = await fetch(
    `https://s3.amazonaws.com/spec.ccfc.min/?list-type=2&prefix=${prefix}`,
  );
  if (!res.ok) throw new Error(`bucket list failed: ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
}

function versionSort(a: string, b: string): number {
  const va = a.match(/(\d+)\.(\d+)\.?(\d*)/)!.slice(1).map((n) =>
    Number(n || 0)
  );
  const vb = b.match(/(\d+)\.(\d+)\.?(\d*)/)!.slice(1).map((n) =>
    Number(n || 0)
  );
  for (let i = 0; i < 3; i++) {
    if (va[i] !== vb[i]) return va[i] - vb[i];
  }
  return 0;
}

// --- 1. Release binaries ---------------------------------------------------
{
  const tgzUrl =
    `https://github.com/firecracker-microvm/firecracker/releases/download/${tag}/firecracker-${tag}-${arch}.tgz`;
  const binName = "firecracker";
  const jailerName = "jailer";
  const needBin = !(await fileMatchesManifest(binName, tgzUrl));
  const needJailer = !(await fileMatchesManifest(jailerName, tgzUrl));
  if (needBin || needJailer) {
    console.log(`↓ release tarball ← ${tgzUrl}`);
    const res = await fetch(tgzUrl);
    if (!res.ok) throw new Error(`${res.status} for ${tgzUrl}`);
    const tmp = await Deno.makeTempDir({ prefix: "fc-fetch-" });
    const tgzPath = join(tmp, "release.tgz");
    await Deno.writeFile(tgzPath, new Uint8Array(await res.arrayBuffer()));
    const untar = await new Deno.Command("tar", {
      args: ["-xzf", tgzPath, "-C", tmp],
    }).output();
    if (!untar.success) {
      throw new Error(
        `tar failed: ${new TextDecoder().decode(untar.stderr)}`,
      );
    }
    const releaseDir = join(tmp, `release-${tag}-${arch}`);
    for (
      const [src, dest] of [
        [`firecracker-${tag}-${arch}`, binName],
        [`jailer-${tag}-${arch}`, jailerName],
      ] as const
    ) {
      const bytes = await Deno.readFile(join(releaseDir, src));
      await Deno.writeFile(join(outDir, dest), bytes);
      await Deno.chmod(join(outDir, dest), 0o755);
      manifest[dest] = { url: tgzUrl, sha256: await sha256(bytes) };
      console.log(`  ${dest}: ${bytes.length} bytes`);
    }
    await Deno.remove(tmp, { recursive: true });
  } else {
    console.log("✓ firecracker + jailer up to date");
  }
}

// --- 2. Guest kernel + rootfs from the CI bucket ---------------------------
{
  // The CI artifact dir can lag the release (e.g. v1.16 releases still use
  // the v1.15 artifacts) — probe from the pinned minor downwards.
  const [major, minor] = tag.replace(/^v/, "").split(".").map(Number);
  let ciDir: string | null = null;
  let kernels: string[] = [];
  for (let m = minor; m >= minor - 4 && m >= 0; m--) {
    const candidate = `v${major}.${m}`;
    kernels = (await listBucket(
      `firecracker-ci/${candidate}/${arch}/vmlinux-`,
    )).filter((k) => /vmlinux-\d+\.\d+\.\d+$/.test(k));
    if (kernels.length > 0) {
      ciDir = candidate;
      break;
    }
  }
  if (ciDir === null) throw new Error(`no CI kernels found at or below ${tag}`);
  console.log(`using CI artifacts from firecracker-ci/${ciDir}`);
  const kernelKey = kernels.sort(versionSort).at(-1)!;
  await download(
    "vmlinux",
    `https://s3.amazonaws.com/spec.ccfc.min/${kernelKey}`,
  );

  const rootfsKeys = (await listBucket(
    `firecracker-ci/${ciDir}/${arch}/ubuntu-`,
  )).filter((k) => k.endsWith(".squashfs"));
  if (rootfsKeys.length === 0) throw new Error("no CI ubuntu squashfs found");
  const rootfsKey = rootfsKeys.sort(versionSort).at(-1)!;
  await download(
    "rootfs.squashfs",
    `https://s3.amazonaws.com/spec.ccfc.min/${rootfsKey}`,
  );
}

await Deno.writeTextFile(
  manifestPath,
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(`assets ready in ${outDir}/ (manifest.json updated)`);
