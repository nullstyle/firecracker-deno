/**
 * CI guard for the spec → types pipeline. Verifies that:
 *
 * 1. `src/generated/types.gen.ts`, `codegen-meta.json`, and
 *    `spec/surface-diff.json` exactly match a fresh regeneration from the
 *    vendored specs (so neither the specs nor the generated artifacts can
 *    drift independently), and
 * 2. the hand-curated `src/api/types.ts` re-exports every schema the pinned
 *    spec defines (so new upstream schemas cannot land silently uncurated).
 *
 * Usage: deno task spec:drift
 *
 * @module
 */

import { parse } from "@std/yaml";
import { generate } from "./codegen.ts";

let failed = false;
function fail(msg: string): void {
  console.error(`✗ ${msg}`);
  failed = true;
}
function ok(msg: string): void {
  console.log(`✓ ${msg}`);
}

const fresh = await generate();

// 1. Committed artifacts == fresh regeneration.
const artifacts: Array<{ path: string; expected: string }> = [
  { path: "src/generated/types.gen.ts", expected: fresh.typesSource },
  {
    path: "src/generated/codegen-meta.json",
    expected: JSON.stringify(fresh.meta, null, 2) + "\n",
  },
  {
    path: "spec/surface-diff.json",
    expected: JSON.stringify(fresh.surfaceDiff, null, 2) + "\n",
  },
];
for (const { path, expected } of artifacts) {
  let committed: string;
  try {
    committed = await Deno.readTextFile(path);
  } catch {
    fail(`${path} is missing — run \`deno task codegen\``);
    continue;
  }
  if (committed === expected) {
    ok(`${path} matches regeneration`);
  } else {
    fail(`${path} drifted from the vendored spec — run \`deno task codegen\``);
  }
}

// 2. Curated coverage: every schema in the pinned spec is re-exported.
const versions = JSON.parse(await Deno.readTextFile("spec/versions.json")) as {
  pinned: string;
};
const spec = parse(
  await Deno.readTextFile(`spec/firecracker-${versions.pinned}.yaml`),
) as { definitions?: Record<string, unknown> };
const curated = await Deno.readTextFile("src/api/types.ts");
const uncovered = Object.keys(spec.definitions ?? {}).filter(
  (name) => !curated.includes(`["schemas"]["${name}"]`),
);
if (uncovered.length === 0) {
  ok(
    `src/api/types.ts covers all ${
      Object.keys(spec.definitions ?? {}).length
    } schemas`,
  );
} else {
  fail(
    `src/api/types.ts is missing curated exports for: ${uncovered.join(", ")}`,
  );
}

Deno.exit(failed ? 1 : 0);
