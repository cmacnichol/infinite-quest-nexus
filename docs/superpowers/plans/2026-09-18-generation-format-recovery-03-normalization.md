# Conservative provider output normalization implementation plan

> **For agentic workers:** Implement task-by-task with RED/GREEN evidence and review between patches. Use superpowers:subagent-driven-development only when delegation is selected for execution.

**Goal:** Accept narrowly defined no-op omissions and lossless fact wrappers without weakening authoritative validation or issuing extra provider calls.

**Architecture:** Normalize extracted provider JSON at `parseStoryOutput`, then run the unchanged strict story schema, mechanics checks, and downstream authority checks. Keep current-provider and historical/import parsing separate. Align newly captured prompts and version their protocol explicitly.

**Tech Stack:** TypeScript, Zod, Vitest, real PostgreSQL with deterministic provider fixtures.

**Spec:** [Scope and gates](2026-09-18-generation-format-recovery.md).

## Exact acceptance policy

| Provider value | Planned behavior |
| --- | --- |
| Missing top-level `superseded_facts` | Supply `[]`; this deprecated field already must be empty for new output. |
| Missing top-level `canonical_fact_updates` | Supply `[]`, meaning no structured updates; do not infer any correction or supersession. |
| Either field is null, a string, or an object | Reject. Missing and malformed are different. |
| `canonical_facts` entry is exactly `{ "content": "nonempty text" }` | Unwrap to its text; strict string limits and mechanics checks still apply. |
| Fact object has any other key, including IDs or supersession metadata | Reject; never drop metadata or move it into another field automatically. |
| Missing `canonical_facts`, `scratchpad`, `continuity_summary`, or `open_threads` | Continue rejecting; no prior-state fallback. |
| Nonempty `superseded_facts` or an update missing `supersedes_fact_ids` | Continue rejecting. |
| Visible-ID/authority violation, contamination, truncation, or ambiguous structure | Existing review path; no bypass or automatic rewrite. |

This is a deliberate relaxation of two provider-input requirements, not a change to the strict domain representation. A missing update array cannot prove the model remembered every correction; continuity validation still applies. Do not claim this fixes every object-shaped fact from the incident: only the exact documented wrapper is covered.

## Files and tests

Modify `packages/story-engine/src/output.ts` and, only if needed for shared normalization, `packages/story-engine/src/story-only-output.ts`; `packages/contracts/src/story-prompt.ts`; `packages/story-engine/src/prompt.ts` for its owning protocol exports if required by the existing mechanism. Inspect `packages/story-engine/src/provider-request.ts` and `packages/story-engine/src/story-only-prompt.ts` to verify actual serialized schema/example consistency. Keep prompt and parser changes in separate commits within this patch.

Tests: `tests/unit/story-output.test.ts`, `tests/unit/story-only-output.test.ts`, `tests/unit/prompt.test.ts`, `tests/unit/story-only-prompt.test.ts`, `tests/unit/prompt-library.test.ts`, `tests/unit/worker-generation-adapter.test.ts`, `tests/integration/generation-review.integration.test.ts`, `tests/integration/story-continuity-remediation.integration.test.ts`.

## Task 1 — Normalize narrowly, then validate strictly

**Interface:** Preserve `parseStoryOutput(content: string, memoryDefaults?: StoryMemoryDefaults): StoryParseResult`. Add internal pure `normalizeProviderStoryOutput(parsed: unknown): unknown`. Do not reuse `normalizeHistoricalStoryOutput` or expose permissive domain schemas.

- [x] Using the existing synthetic `story()` fixture, add:

```ts
it("treats omitted top-level no-op arrays as empty", () => {
  const input = JSON.parse(story());
  delete input.superseded_facts;
  delete input.canonical_fact_updates;
  expect(parseStoryOutput(JSON.stringify(input))).toMatchObject({
    ok: true, story: { superseded_facts: [], canonical_fact_updates: [] }
  });
});
it("accepts only a lossless content-only fact wrapper", () => {
  expect(parseStoryOutput(story({
    canonical_facts: [{ content: "The beacon is lit." }]
  }))).toMatchObject({ ok: true, story: { canonical_facts: ["The beacon is lit."] } });
  expect(parseStoryOutput(story({
    canonical_facts: [{ content: "The beacon is lit.", supersedes_fact_ids: [] }]
  }))).toMatchObject({ ok: false, code: "invalid_schema" });
});
```

- [x] Update the existing test that explicitly requires `canonical_fact_updates` from current responses: retain its valid structured-update and missing nested supersession-ID assertions, change only the missing top-level-array expectation. Keep tests requiring full replacement fields unchanged.
- [x] Add every negative row in the policy table, mixed string/wrapper arrays, whitespace-only/overlong content, contamination within a wrapper, and an input immutability assertion. Test normalization through Story-only parsing and its invalid-choice/protected-base path too.
- [x] Run `corepack pnpm exec vitest run tests/unit/story-output.test.ts tests/unit/story-only-output.test.ts`; record RED.
- [x] Implement this algorithm: return non-record input unchanged; shallow-copy a record; add only the two absent arrays; map fact entries only when they are non-array records with exactly one own key `content` whose value is a string; leave all other entries unchanged so the strict schema rejects them. Then apply the existing schema and mechanics validation. Do not trim, concatenate, stringify, or deduplicate fact objects yourself.
- [x] Keep raw provider output and request hashes unchanged in durable attempts. Normalized typed stories get their normal downstream candidate hashes; never rewrite raw evidence. Do not backfill old jobs or normalize already accepted turns.
- [x] Run the same focused tests; record GREEN and commit `Normalize safe story output formatting`.

## Task 2 — Align prompts and preserve frozen jobs

- [x] Add tests that actual composed RPG and Story-only system prompts distinguish replacement fields from fact deltas, explicitly request `canonical_facts` as strings, and show empty top-level arrays. Test serialized request examples, not only a standalone constant.
- [x] Replace contradictory complete-replacement wording for fact delta arrays. Keep `scratchpad`, `continuity_summary`, and `open_threads` as explicit complete replacements. Tell models to always emit both arrays despite boundary tolerance; use `canonical_fact_updates` for structured content and exact visible supersession IDs.
- [x] Use this copy consistently in the mandatory contract and default examples:

```text
canonical_facts is an array of strings containing only facts established this turn; do not put objects in it. canonical_fact_updates is an array of structured updates with content and supersedes_fact_ids. Emit [] when there are no updates. superseded_facts must always be []. scratchpad, continuity_summary, and open_threads are explicit complete replacements and must not be omitted.
```

- [x] Advance the affected owning prompt-protocol version using the repository's existing mechanism and update exact protocol/hash expectations. Verify saved prompt snapshots/overrides are not silently rewritten, saved chains cannot be reused across changed identity, and old pending jobs are not relabeled. Existing compatible explicit retries keep their frozen request; incompatible jobs receive the supported discard/re-enqueue guidance.
- [x] Run the prompt suites and `corepack pnpm check`; commit `Clarify canonical fact output contract` separately from parser normalization.

## Task 3 — Composed integrity verification

- [x] Use real PostgreSQL and a deterministic mock provider to generate the missing-array fixture and content-only-wrapper fixture. Each must complete with one provider dispatch, persist the expected facts, preserve existing facts/threads unless explicitly replaced, and replay correct authority on the next turn.
- [x] Test structured supersession with an unsent UUID, ambiguous object metadata, omitted replacement fields, output limitation, and mechanics contamination: none may mutate accepted turns, campaign state, or Chronicle. Keep must remain unavailable for invalid structure.
- [x] Verify a pending review for invalid structure consumes no further provider calls until an explicit decision. One authorized stage retry is bounded; lease reclaim and duplicate decision delivery do not duplicate provider dispatch or accepted turns. Include cross-owner/campaign and latest-turn replacement coverage.
- [x] Run:

```powershell
corepack pnpm exec vitest run tests/unit/story-output.test.ts tests/unit/story-only-output.test.ts tests/unit/prompt.test.ts tests/unit/story-only-prompt.test.ts tests/unit/prompt-library.test.ts tests/unit/worker-generation-adapter.test.ts
corepack pnpm test:integration
corepack pnpm check
corepack pnpm build
git diff --check
```

- [x] Complete the combined release gates in the parent plan. Record focused and broad evidence separately, then commit the composed regressions. No live provider call or production recovery is part of this plan's implementation authorization.
