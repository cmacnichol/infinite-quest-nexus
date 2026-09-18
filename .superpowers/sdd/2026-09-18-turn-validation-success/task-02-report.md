# Task 02 report: fact wire prompt alignment

## Identity and scope

- Requested base: `9f5986ca` on `codex/turn-validation-success`.
- Inherited during implementation: unrelated coordinator documentation checkpoint `10076dd5`.
- Head: immutable Phase 02 commit supplied with this report.
- Scope: Phase 02 only. No parser relaxation, normalization, retry redesign, migration, deployment, provider call, push, or main integration.

## Implementation

The next unused protocol is `story-v16-fact-wire-distinction`. New Story Memory jobs freeze it with the five required fact wire rules. `STORY_FACT_DELTA_WIRE_CONTRACT` is the single shared source for the default system prompt and new Story Memory mandatory contract.

`story-v15-canonical-fact-format` remains explicitly decodable. The previous mandatory Story Memory contract is a literal, separately named constant, so a v15 frozen prompt keeps the original appended bytes rather than using a v16 label with changed bytes. The runtime selects that contract from the frozen `storyMemoryPolicy.promptProtocol`, including Story-only and choice-repair composition. Compatibility snapshots and policy snapshots accept v14/v15/v16; the existing v14 explicit incompatible-worker result remains intact.

The code changes are limited to prompt contract/version schemas, frozen prompt composition, and the focused tests listed in the Phase 02 handoff. `docs/review/turn-validation-success/verification-matrix.md` is coordinator-owned and intentionally excluded.

## RED evidence

Before implementation:

```text
corepack pnpm exec vitest run tests/unit/story-output.test.ts tests/unit/story-only-prompt.test.ts
```

Result: 4 failed / 36 passed. The assertions established that the source still emitted v15 and did not include the specified fact wire language in default or composed prompts.

## GREEN evidence

```text
corepack pnpm exec vitest run tests/unit/story-output.test.ts tests/unit/story-only-prompt.test.ts tests/unit/prompt-library.test.ts tests/unit/generation-executor-adapter.test.ts tests/unit/generation.test.ts
```

Result: 5 files, 168 tests passed.

```text
corepack pnpm check
```

Result: passed. It completed repository/data boundary, TypeScript, and web checks; only the existing Windows global Git-ignore accessibility warning was printed.

```text
corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/story-memory-enrollment.integration.test.ts tests/integration/story-context-payload.integration.test.ts
```

Result: passed against isolated Docker PostgreSQL after migrations: 2 files, 32 passed, 6 skipped existing known-failure probes. These are integration tests with an actual worker and serialized local-provider messages. Coverage includes v16 enqueue identity/rule freezing, v15 retry snapshot/context/protocol retention, default and acknowledged creative-override system messages, Action, Story Direction choice repair, and an old v15 creative-override request that equals the frozen override plus the exact prior mandatory contract and excludes v16 text.

The wider command also included `tests/integration/story-memory-compatibility.integration.test.ts`; its one `campaign_zip` case failed on Windows because the secure filesystem adapter is Linux-only (`filesystem_platform_unsupported`). That failure is unrelated to this patch and is not counted as a Phase 02 pass. The coordinator is running it on Linux separately.

## Test categories and limits

- Unit: prompt identity, required shape/default content, versioned compatibility, Story-only composition, and executor behavior.
- Isolated PostgreSQL integration: enrolled and non-enrolled supported paths, enqueue/retry/resume freeze behavior, provider serialization, and Story Direction repair.
- Browser: skipped; no UI changed.
- Live provider: skipped; only local deterministic provider transport was used.
- Historical prompt evidence: Phase 01 recorded 15 accepted / 34 rejected first passes among 49 classifiable jobs. A fresh bounded `READ ONLY` fixed-50 cutoff at `2026-09-18T05:05:13.987485Z` found Story Memory v14: 34 jobs, 5 valid / 29 invalid; Story Memory v15: 4 jobs, 2 valid / 1 invalid / 1 without a saved response; non-enrolled `prompt-library-v1-5d636b749d679ddc`: 11 jobs, 7 valid / 4 invalid; and non-enrolled `prompt-library-v1-dc1b588a0a37f571`: 1 job, 1 valid. The v15 cohort is tiny and confounded, not a forecast. These labels come from frozen Story Memory policy or prompt-library identity because `generation_jobs.prompt_protocol_version` is composite. No v16 cohort exists before this rollout. A read-only audit found exact primary request-body/hash for 10 jobs and source manifests for 38. This is not a quality result.

## Remaining risks

The prompt instructs correct shape but cannot establish live model compliance. It leaves strict rejection, existing malformed-output normalization behavior, retrieval, and repair policy untouched. Phase 07 needs a real canary comparison between frozen v15 and v16 cohorts before any success-rate claim. Reviewers should focus on the old-contract literal and the runtime propagation of the frozen protocol into every composition path.
