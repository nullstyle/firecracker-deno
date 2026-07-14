/**
 * Vendor the Firecracker API swagger spec at a release tag into `spec/`.
 *
 * Usage: deno run --allow-net --allow-write=spec tools/fetch-spec.ts <tag>
 *
 * @module
 */

import { Command, ValidationError } from "@cliffy/command";

const { args: [tag] } = await new Command()
  .name("fetch-spec")
  .description("Vendor a Firecracker API swagger spec.")
  .type("release-tag", ({ value }) => {
    if (!/^v\d+\.\d+\.\d+$/.test(value)) {
      throw new ValidationError(
        `Release tag must look like "v1.16.1", but got "${value}".`,
      );
    }
    return value;
  })
  .arguments("<tag:release-tag>")
  .parse(Deno.args);

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
