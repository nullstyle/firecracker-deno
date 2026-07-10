# Firecracker compatibility

This library mirrors Firecracker's own support policy: the **current and
previous minor** versions. The window ships in code as `FIRECRACKER_COMPAT`:

| Library | Pinned (types & client surface) | Minimum supported |
| ------- | ------------------------------- | ----------------- |
| 0.1.x   | Firecracker v1.16.1             | v1.15.0           |

- **Pinned** — the vendored swagger spec the generated types and the
  `FirecrackerClient` surface come from (`spec/firecracker-<tag>.yaml`).
- **Minimum** — the oldest VMM the library is tested against. It never predates
  v1.14.1 (jailer symlink hardening).
- **Newer** Firecracker minors generally work: the API is semver-governed and
  additive within v1.x. You just won't have typed methods for endpoints newer
  than the pinned spec until the library updates.

Surface that exists only in the pinned minor (not the previous one) is tagged
`@since v1.16` in [`src/api/types.ts`](../src/api/types.ts) and enumerated in
[`spec/surface-diff.json`](../spec/surface-diff.json) — using it against a v1.15
VMM yields an API 400.

## How the pipeline stays honest

- `deno task spec:fetch <tag>` vendors a spec; `deno task codegen` regenerates
  `src/generated/types.gen.ts` (committed, never hand-edited) and the surface
  diff.
- `deno task spec:drift` (CI) fails if the committed artifacts don't match a
  fresh regeneration, or if any spec schema lacks a curated export.
- The weekly `spec-watch` workflow opens a PR when Firecracker releases move the
  window.
- Integration CI boots real Firecracker binaries fetched at the pinned tag; a
  contract-symmetry test subset asserts `FakeFirecracker` behaves like the real
  thing where it matters (boot-phase gating, fault shapes).
