# Capability-gated structured output implementation plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` with fresh **gpt-5.6-terra** implementers and reviewers. Implement one numbered patch at a time; this document authorizes planning, not implementation or deployment.

**Goal:** Reduce first-response structural failures using verified provider JSON Schema support while retaining the validation, explicit repair, and durable recovery delivered by PR #162.

**Architecture:** Preserve provider capability metadata, select a response contract before dispatch, and durably bind that selection to each job and attempt. OpenRouter requests use endpoint-aware routing and an operation-specific schema. Existing application validation and acceptance transactions remain authoritative.

**Tech Stack:** TypeScript, Zod 4, JSON Schema, Vitest, isolated PostgreSQL, Playwright, the existing provider transport and both Story clients.

**Spec:** This index is the specification. Read it together with the selected numbered patch and `AGENTS.md`.

## Re-review baseline and corrected conclusions

Reviewed September 18, 2026 at main `2084ae53419388b2e9a3d60fd88cd16547da5acd`, verified equal to remote `refs/heads/main` using `git -c http.sslBackend=openssl ls-remote origin refs/heads/main`. The initial default Schannel query failed because its credential context was unavailable; the OpenSSL query succeeded. No branch update or production request was needed.

Two independent Terra source reviews covered provider capabilities and the merged validation workflow. This is source/documentation evidence; no fresh production failure-rate measurement or live schema probe was performed.

| Earlier conclusion | Current main | Consequence |
|---|---|---|
| JSON mode does not enforce our story schema | Still true: `provider-request.ts` lines 165 and 312 emit `json_object` | Implement schema mode rather than repeat prompt-only work |
| Discovery drops supported parameters | Still true: `providers.ts::inventoryItems/discoverModels`, runtime and API inventory projections omit them | Carry metadata across all three boundaries |
| Malformed fact objects commonly caused failures | Historical evidence remains relevant, but is not a post-merge rate | Establish a v16 baseline before claiming improvement |
| Rejected structures need explicit recovery | Now implemented by PR #162: deterministic fact-format repair, v2 receipts and provenance | Preserve and regression-test this workflow; do not rebuild it |
| Prompt distinction needs strengthening | Implemented: `story-v16-fact-wire-distinction` | Freeze existing v13/v15/v16 text and identities |
| Metrics should distinguish first-pass and final success | Implemented report and outcome reducer | Extend dimensions, not denominator semantics |
| Provider configuration is frozen | Correction: fingerprints and captured request evidence exist; runtime still reloads profile configuration | Add a durable response-contract selection; never infer old-job mode from current settings |
| Presets and ordered fallback need handling | No ordered text-model fallback or preset resolution implementation exists on this main | Treat aliases as unknown; do not add a fallback subsystem incidentally |

Evidence: [merged verification](../../review/turn-validation-success/final.md), [rollout limits](../../review/turn-validation-success/rollout.md), [report runbook](../../runbooks/turn-validation.md), and the [original deferred phase 06](2026-09-18-turn-validation-success-06-structured-output.md). The merged report explicitly defers phases 05–06. Its historical 15/49 and parser-replay 18/49 figures are not live results for the merged prompt or this proposal.

Source anchors to recheck before execution:

- `packages/story-engine/src/providers.ts`: model inventory, `callOpenAiCompatible`, and the existing error-triggered second call without response formatting.
- `packages/application/src/providers/types.ts` and `use-cases.ts`: closed safe configuration allowlist and inventory shape.
- `services/runtime/src/provider-credential-transport-adapter.ts`: inventory projection and execution-time profile resolution.
- `packages/contracts/src/story-prompt.ts`: v16 prompt and open-ended tracker object contract.
- `packages/contracts/src/story-memory-policy.ts::effectiveProviderConfigurationFingerprint`: stable historical fingerprint.
- `services/runtime/src/generation-executor-adapter.ts`: `repairResponseFormat`, captured primary, format-repair binding and operation dispatch.
- `packages/database/src/generation-repository.ts`: append/replacement enqueue; `generation-execution-repository.ts`: durable checkpoints and repair receipts.

## External requirements checked September 18, 2026

OpenRouter exposes `supported_parameters` in its [models inventory](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties). Preserve the distinction between an absent advertisement and an explicit negative.

Use `response_format.type = json_schema`, a named schema and `strict: true`. Support is endpoint-specific; set `provider.require_parameters = true`. Streaming is available, but schema subsets and strictness differ by endpoint. An advertisement alone does not prove the complete application schema works. [Structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs), [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection).

## Product and compatibility decisions

1. Add `textResponseFormatPolicy: "legacy" | "auto" | "required"`, defaulting to legacy when absent. Legacy retains existing serialization and historical behavior. Auto uses schema only for an eligible verified route; otherwise it selects JSON-object mode **before dispatch**. Required rejects unavailable/unknown support before any text-generation call. Neither new mode permits a format-error redispatch.
2. A route is eligible only when its advertised metadata, endpoint restrictions, and a server-trusted verification record cover the exact schema digest, operation, model, endpoint and streaming mode. Display **advertised**, **verified**, **unsupported**, or **unknown** accurately. Never accept browser capability claims as proof.
3. Cache inventory server-side for 24 hours, keyed by owner, profile, normalized endpoint identity, model and relevant configuration digest. Deduplicate concurrent refreshes. Refresh on explicit discovery and on an expired/missing preflight entry; never discover during resume of an already frozen contract. A failed refresh is unknown, not positive. Process-local cache loss after restart is acceptable for new jobs; frozen jobs must not depend on it.
4. Separate immutable schema verification records from transient inventory metadata. Store reviewed verification records as non-secret operator configuration loaded by the runtime; do not put trusted verification in browser-editable provider configuration. Expire records after 30 days and invalidate them on schema, endpoint or routing changes. A record establishes compatibility, not a guarantee of correct fiction.
5. OpenRouter is the first production adapter. Other OpenAI-compatible endpoints require an explicit verified adapter profile; never send OpenRouter routing keys to them. LM Studio native requests remain unchanged until a separately verified adapter is added.
6. Preserve native tracker objects. The current application accepts arbitrary JSON object fields in `tracker_updates`. A provider requiring closed nested objects cannot support that exact schema and must be marked ineligible for full-story schema mode. Do not drop trackers, make the array empty, stringify tracker values, or weaken application validation. This can exclude otherwise advertised structured-output models. Broadening those models requires a separate wire-contract migration; it is not hidden inside this plan.
7. Freeze a versioned response-contract envelope at enqueue, or complete a durable preflight before the first provider reservation if the enqueue composition cannot resolve metadata without holding a DB transaction. Patch 04 specifies the latter: enqueue freezes policy and route identity; preflight persists the complete selection exactly once before dispatch. Never perform network discovery while holding campaign locks.
8. Historical jobs without the new marker remain legacy. Preserve their serializer bytes, fingerprints, prompt text, review decisions and fallback semantics. New auto/required jobs use no format fallback even when auto selected JSON-object mode.
9. Store actual response-format/schema/route identity and safe diagnostic categories with attempts. Do not relabel raw provider output as normalized output or overwrite the original producing request. Schema mode does not authorize any extra primary call.
10. Preserve repair receipts, supplied-fact authority, protected-field hashes, semantic review, mechanics isolation, campaign/owner scope and transactional acceptance. A compliant schema does not establish semantic truth or authorize supersession.

## Ordered independent patches

| Patch | Deliverable | Depends on |
|---|---|---|
| [01 Capabilities](2026-09-18-structured-output-01-capabilities.md) | Validated discovery, cache, policy and eligibility resolver | Main baseline |
| [02 Schemas](2026-09-18-structured-output-02-schemas.md) | Versioned per-operation schemas and tracker conformance | 01 types |
| [03 Transport](2026-09-18-structured-output-03-transport.md) | Exact request serialization, routing, budget and bounded errors | 01–02 |
| [04 Durability](2026-09-18-structured-output-04-durability.md) | Frozen preflight, attempts, restart and repair compatibility | 01–03 |
| [05 Controls and reporting](2026-09-18-structured-output-05-controls-reporting.md) | Provider controls, safe diagnostics and cohort reporting | 01–04 |
| [06 Verification and rollout](2026-09-18-structured-output-06-verification.md) | Integrated verification, synthetic probe and canary handoff | 01–05 |

All six patches implement the earlier suggestions: metadata preservation (01); contract schemas (02); pre-dispatch selection and endpoint routing (01/03/04); request identity and budget (03/04); operation isolation and failure handling (02/03/04); discovery UX and measurement (05/06). Tracker compatibility is an explicit admission gate, not a promise of universal model support. No change to context limits, retrieval, model temperature or ordered model fallback is included.

## Terra execution protocol

- Start an isolated `codex/structured-output` worktree from freshly verified main using the worktree skill. Preserve the user's main checkout. Do not implement during this planning task.
- Dispatch a fresh `gpt-5.6-terra` implementer for each patch with `fork_turns: "none"`, the complete index and patch, repository instructions, exact base SHA, worktree path, previous handoff, and ownership list. Do not rely on inherited conversation.
- Use one implementer at a time. After its checkpoint, dispatch fresh Terra specification and code reviewers against that immutable SHA; they may run in parallel because they do not edit. The coordinator independently reproduces every actionable finding, sends scoped corrections, then reruns affected checks.
- Never allow concurrent implementers to edit the shared serializer, contract or executor. Discovery research and independent review may run concurrently only with explicit read-only ownership.
- Every code task follows RED → minimal implementation → GREEN, reviews tests for each changed file, and commits only its own scope. Failed environment setup is not RED behavior evidence.
- Each patch writes `docs/review/structured-output/phase-NN.md`: base/final SHA, changed interfaces, RED/GREEN evidence, passed/failed/skipped checks, production/DB/browser/live boundaries, compatibility results, remaining risks and next patch readiness.
- If an advertised provider rejects the native tracker schema, finish the fallback/ineligibility behavior and record the limitation. Do not redesign trackers or silently relax strictness to get a green probe.

Dispatch text:

```text
Implement only the assigned numbered structured-output patch in the isolated worktree.
Read AGENTS.md, the complete structured-output index and the assigned patch.
Use the supplied immutable base SHA and preceding phase handoff; verify both before edits.
Capture a behavioral RED result before production changes, then GREEN and relevant regressions.
Preserve legacy serializer/fingerprint bytes, v16 prompts, raw attempts, v2 repair receipts,
scope checks, mechanics separation and semantic acceptance. No production data changes,
paid provider calls, deployment, main integration or next-patch work.
Return final commit SHA, exact checks, handoff path, open limitations and reviewer-ready diff.
```

## Completion boundary

Plan review completed with an independent Terra reviewer. Incorporated corrections include the full cache identity, routing/protocol verification identity, operation-plus-streaming contract keys, a versioned job operation closure, API/worker registry consistency, explicit attempt provenance, and Chronicle non-mutation assertions. A proposed extra provider operation for deterministic fact repair was rejected after checking current source: that operation is local and must remain so.

Implementation is ready only when all numbered gates pass with no hidden redispatch or incompatible historical resume. Live performance improvement remains unproven until an approved bounded comparison. Deployment, paid experiments, publication and main integration require their own instruction; the plan is complete without performing those actions.
