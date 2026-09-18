# Structured output 06: verification and rollout implementation plan

> **For agentic workers:** Use `superpowers:subagent-driven-development`; fresh gpt-5.6-terra verifier and independent Terra reviewers. Deployment and paid requests need their own authorization.

**Goal:** Prove workflow correctness, prepare an exact bounded provider experiment, and define rollout/rollback gates.

**Architecture:** Deterministic CI proves application behavior; separately approved synthetic probes establish route/schema compatibility. Post-merge v16 JSON-object cohorts provide the comparison for any live strict-output trial.

**Tech Stack:** Vitest, isolated PostgreSQL, Playwright, existing secure provider transport and read-only reporting.

**Spec:** [Index](2026-09-18-structured-output.md). Depends on patches 01–05. Read `docs/runbooks/deployment.md`, `docs/workflows/testing.md`, and the merged validation rollout before execution.

## Files and interfaces

- Create `scripts/probe-structured-output.ts`, `tests/unit/probe-structured-output.test.ts`, `docs/runbooks/structured-output.md`, `docs/review/structured-output/final.md`, `docs/review/structured-output/rollout.md` during implementation.
- Extend test suites from earlier patches only for concrete remaining gaps. No production campaign fixtures.
- Probe CLI inputs: provider profile ID, concrete model, schema operation/version, streaming mode, max calls, max output tokens and approved cost cap. Default is dry-run; network execution requires explicit `--execute`. Reuse configured secure credential transport; never print credentials or dump provider configuration.

## Task 1: offline probe preparation

- [ ] RED CLI tests: dry-run makes zero HTTP generation calls; missing limits reject execution; unresolved aliases/unsupported adapter reject; schema mismatch aborts; timeout/refusal stops the batch; unexpected response model/provider cannot create a verification record.
- [ ] Build a synthetic scenario set for story, choices and review with no user content. Story fixture includes empty arrays plus nested tracker objects and explicit string facts. Probe real schema and actual stream/nonstream shape; a minimal toy object alone cannot qualify the full story schema.
- [ ] Proposed single-route compatibility batch: two synthetic scenarios × three operations × streaming/nonstreaming = maximum 12 calls, maximum 2,048 output tokens each. Bound input via actual prepared body counting. Dry-run prints exact model, routing identifiers, schemas/digests, request count, input/output ceilings and maximum priced cost. If current prices or provider constraints are unavailable, do not run; prepare a smaller concretely priced batch instead.
- [ ] Verification record generation requires schema acceptance and full response validation on every scenario for that operation/mode, reported endpoint identity matching restrictions, and no data loss. Record SDK/provider caveats and schema-subset limits. Produce proposed records as an artifact; installing operator verification config is an explicit reviewed step, not something arbitrary browser discovery does.
- [ ] Include tests that a closed-object-only endpoint fails the native tracker schema and produces an unsupported disposition with no automatic downgrade or rewritten schema. A route may qualify for choices/review and remain unsupported for story; auto can use mixed operation modes, required cannot start a job needing an unverified operation.

## Task 2: integrated deterministic release verification

- [ ] Re-fetch/verify moving main before final integration; record immutable candidate SHA. Preserve patch commits and resolve changes through scoped review. Main integration is a separately authorized action.
- [ ] Run the complete documented checks serially or with bounded concurrency that does not starve DB/browser tests:

```sh
corepack pnpm test:unit --exclude '**/.worktrees/**' --exclude '**/.codex/**'
corepack pnpm test:integration
corepack pnpm check
corepack pnpm build
corepack pnpm exec playwright test tests/e2e/structured-output-settings.e2e.test.ts tests/e2e/generation-review.e2e.test.ts tests/e2e/generation-integrity-diagnostics.e2e.test.ts
git diff --check
```

- [ ] Confirm historical serializer/hash fixtures, all preflight crash points, no hidden redispatch, strict-budget overflow before dispatch, legacy v13/v15/v16 resume, v1/v2 review decisions, and unknown future-version rejection. Include scopes/authoritative-state invariants from the testing matrix.
- [ ] Confirm arbitrary nested tracker preservation through repaired acceptance and restart. Validate streaming provisional narration but never accept partial output. Optional image failures must not rerun primary text generation.
- [ ] Fresh Terra specification reviewer checks every index requirement against artifacts; fresh code reviewer checks immutable diff and actual call counts. Coordinator reproduces findings. Report genuine passed/failed/skipped counts, environment corrections and exact tested SHA; previous PR #162 tests are background evidence, not substitute checks for this change.

## Task 3: bounded live measurement and release handoff

- [ ] Prepare, but do not execute without authorization, the exact 12-call synthetic probe above. Include concrete maximum spend derived from current model pricing, not a placeholder budget. A budget approval applies only to that batch and route.
- [ ] Before a live comparison, run the read-only turn-validation report for a fixed post-deployment v16 baseline. Do not compare the old 15/49 historical prompt cohort directly with a different model/schema cohort. If production access is not available, record the command and leave baseline measurement explicitly unperformed.
- [ ] Prepare an A/B sample using matched disposable campaign copies: same model, pinned provider route, prompt, context, token limits and streaming; 20 turns per mode for smoke evaluation, then at least 50 eligible primary responses per mode if authorized and affordable. Randomize mode ordering, show uncertainty and all missing/cancelled/refused observations. Count continuity calls separately from primary calls.
- [ ] Compare first-pass structural validity, fact-shape errors, repair rate, accepted-turn rate, primary calls per accepted turn, refusal/route failures, p50/p95 latency and observed cost. Narrative continuity and mechanics remain separate acceptance gates. Claim directional benefit only for matched measured cohorts; do not extrapolate a small canary to all models.
- [ ] Stop on duplicate acceptance, cross-campaign leakage, lost trackers/supersession information, unauthorized provider calls, lost raw provenance or misleading repair consent. Preserve evidence and keep normal acceptance safeguards active.
- [ ] Rollout defaults remain legacy; enable auto for one verified profile only after the probe and workflow checks pass. Required is an explicit operator choice. Turning the profile back to legacy affects new jobs only, not frozen pending work.
- [ ] Rollback inventory distinguishes legacy jobs, preflight-only new jobs, dispatched strict jobs, pending v2 repairs and committed turns. Do not run old workers against new checkpoint envelopes. Use compatible workers or pause intake/dispatch under the deployment runbook; never rewrite saved contracts or restore a database over accepted turns merely to disable this feature.
- [ ] Final handoff includes verified/unsupported schema matrix, operation/streaming coverage, tracker limitations, exact image/SHA when a release is later authorized, operator verification record hashes, safe report examples, screenshots, rollback reader coverage and unperformed live steps.

## Exit gate

Deterministic implementation checks and review are complete. A live success claim requires the separately authorized evidence; lack of compatible full-story routes is a legitimate supported result, not permission to weaken the tracker contract or validation.

## Selected compatibility-probe target

The user selected OpenRouter preset `@preset/nexus-nsfw` and identified its model as **DeepSeek: DeepSeek V3.2 Exp** (`deepseek/deepseek-v3.2-exp`). Prepare the dry-run around that concrete model. Do not qualify a mutable preset alias from a concrete-model result: preset versions can change model and provider preferences. The actual preset configuration and selected provider profile have not been read.

Public endpoint metadata checked on 2026-09-18 advertised `response_format` and `structured_outputs` for SiliconFlow (`siliconflow/fp8`), AtlasCloud (`atlas-cloud/fp8`), and Novita (`novita/fp8`). The advertised price was $0.27 per million input tokens and $0.41 per million output tokens. This is capability advertisement, not verification of our full story schema or its open nested tracker objects. Propose one concrete route in the dry-run and clearly label it as proposed; do not claim it is the preset's configured route.

The final priced artifact must derive its input bound from the actual prepared requests, include the 12-call and 2,048-output-token-per-call limits, and record the price observation time. No live generation requests or spend are authorized by these model-selection answers. Keep execution and installation of a successful verification record as separate explicit steps.

Sources: [model page](https://openrouter.ai/deepseek/deepseek-v3.2-exp), [endpoint inventory](https://openrouter.ai/api/v1/models/deepseek/deepseek-v3.2-exp/endpoints), [presets](https://openrouter.ai/docs/guides/features/presets), and [structured-output requirements](https://openrouter.ai/docs/guides/features/structured-outputs).
