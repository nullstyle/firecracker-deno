/**
 * Vendor the Firecracker API swagger spec at a release tag into `spec/`.
 *
 * Usage: deno run --allow-net --allow-write=spec tools/fetch-spec.ts <tag>
 *
 * @module
 */

const tag = Deno.args[0];
if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  console.error("usage: fetch-spec.ts <tag>   (e.g. v1.16.1)");
  Deno.exit(1);
}

const url =
  `https://raw.githubusercontent.com/firecracker-microvm/firecracker/${tag}/src/firecracker/swagger/firecracker.yaml`;
const res = await fetch(url);
if (!res.ok) {
  console.error(`fetch failed: ${res.status} ${res.statusText} for ${url}`);
  Deno.exit(1);
}
const text = await res.text();
await Deno.mkdir("spec", { recursive: true });
const dest = `spec/firecracker-${tag}.yaml`;
await Deno.writeTextFile(dest, text);
console.log(`wrote ${dest} (${text.length} bytes)`);
