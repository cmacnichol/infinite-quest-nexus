# Campaign cast phase 04 progress

Updated 2026-09-23 on `codex/campaign-cast`, after phase 03 commit `da74d713`. Phase 04 is **in progress**, not released. The active goal still includes phases 04–06. Legacy `/story` remains the requested UI surface.

## Evidence and provider-contract checkpoint

The discovery contract bounds candidates, observations, quotes, IDs, and allowed fields. Source preparation preserves accepted narration, assigns stable paragraph/subparagraph IDs, and reports source overflow rather than returning a partial completed source. Duplicate paragraph IDs and provider-local keys fail validation.

The domain validator rejects unknown character IDs and fabricated quotations. Ambiguous identities, unsupported fields, instructions, prospective identities, and uncertain subject attribution remain unresolved. It requires corroboration beyond a shared name; alias linkage, corroborating traits, and claims must describe the relevant subject or speaker. World identity hints can preserve world provenance. Consequential unnamed labels remain sparse records with no invented aliases. These conservative English lexical guards establish provenance and reject tested misattributions; they are not proof of arbitrary narrative meaning or a live-model quality evaluation.

`buildCastDiscoveryInput` explicitly projects source fiction and identity hints. It excludes owner/campaign IDs, source hashes, operational state, and raw generation context. The frozen discovery system prompt is separate from historical Story prompt snapshots and requires extractive, sparse, source-linked output.

`cast_discovery` has a distinct strict provider schema and nonstream invocation in the existing v2 contract registry. Story schemas and historical snapshot keys are unchanged. The structured-output qualification probe now includes a synthetic discovery fixture: 18 requests total, with a recomputed example ceiling and updated runbook. No live probe was executed.

## Verification

- RED/GREEN regressions cover fabricated evidence, unrelated character traits, clipped dialogue/intention/negation, unsupported aliases, ambiguous active-verb alias constructions, wrong speakers, duplicate references, and name-only matching.
- Focused discovery/contract/probe selection: **50 tests passed**.
- Full unit suite: **345 files passed; 4,351 tests passed; 44 existing skips**.
- `corepack pnpm check` passed, including repository boundaries, data safety, clients, and TypeScript. The unit suite also built both web surfaces through its build-contract test.
- First full run exposed missing probe coverage and the known nested pnpm shim mismatch. Probe coverage was fixed; the final run used `.tmp/campaign-cast/bin` on PATH to keep nested pnpm commands on Corepack's pinned version.
- Independent review produced concrete identity/attribution counterexamples; regressions reproduced them and fixes passed. The last reviewed issue, active `Mara called Iven` being mistaken for an alias, is now held for review.
- No PostgreSQL, browser, or live-provider verification applies to this unwired pure-contract checkpoint. Database jobs and runtime publication are not implemented yet. No deployment or production data changes occurred.

## Remaining implementation

1. Durable queue, receipts, unresolved candidates, leases, chunk checkpoints, retries, contiguous coverage, and capability handling. Next migration is 0104; read the deployment runbook before creating it.
2. Freeze routing at admission without a provider call inside acceptance. Use the existing prepared-request executor and physical-attempt cost ledger with a new lease-bound discovery reservation; do not disguise discovery as a direct authoring request.
3. Atomic accepted-turn enqueue and publication with campaign/timeline/source/character revision checks. Defer publication during active or recoverable generation. Add same-client cast persistence seams and allow protagonist observations without editing its authoritative profile; update portability validation accordingly.
4. Lifecycle cancellation/re-enqueue for corrections, replacement, rewind, branches, and transfer. Existing phase-02 approvals cover these source integrations.
5. Status/retry/candidate-resolution API and legacy UI, then actual PostgreSQL and browser acceptance gates.
6. Phase 05 bounded generation-context integration and phase 06 explicit history scanning, as separate plan slices.

Do not mark phase 04 complete or claim pin/ignore already affects generation. Existing plans remain authoritative; this checkpoint only completes an initial part of task 1 and registers the future provider operation.
