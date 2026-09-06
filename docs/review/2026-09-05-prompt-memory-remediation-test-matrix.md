# Prompt-memory remediation: finding-to-test matrix

This matrix records executable coverage for the 2026-09-05 prompt-memory
remediation.  It distinguishes a real PostgreSQL/deterministic-provider
workflow from focused unit and repository-contract cases.  A deterministic
provider proves what the application sends, validates, checkpoints, and
commits; it does not make a claim about live-model narrative quality.

## Composed acceptance path

`tests/integration/story-continuity-remediation.integration.test.ts` drives
the production enqueue, private-context load, provider transport, output
validation, checkpoint, commit, and next-turn path.  It imports a sanitized
legacy fixture, places a late password after 10,000 scratchpad characters,
sets a mandatory world rule, accepts two turns, applies a direct narration
correction, and accepts a third turn at a configured 1,000,000-token budget.
The captured final provider request contains the password, corrected death,
and world rule.  The test also checks one final accepted turn and one attempt.

## Finding coverage

| Finding | Executable evidence | What the assertion observes |
| --- | --- | --- |
| F1 complete authority rather than retrieval fragments | `story-continuity-remediation.integration.test.ts`; `chronicle-contract-matrix.integration.test.ts`; `campaign-continuity-repository.test.ts` | Late scratchpad password, mandatory rule, latest corrected narration, empty corrections, and replace cutoffs are loaded from authority; derived rebuilds do not change that source. |
| F2 replacement continuity | `generation.test.ts`; `chronicle-repository.integration.test.ts`; `campaign-state-corrections.integration.test.ts` | New output requires replacement fields; empty values clear rather than fall back; accepted and corrected state is replayed. |
| F3 complete event fiction | `event-finalization.test.ts`; `generation.integration.test.ts`; `image-pipeline.integration.test.ts` | Extension output preserves the main narration, validates every due event, applies counters once, and reconciles illustrations independently. |
| F4 bounded, scoped historical selection | `context-budget.test.ts`; `generation-executor-adapter.test.ts`; `import-memory.integration.test.ts` | Protected authority survives selection, omitted candidates have reasons, sent IDs exclude omitted records, and lexical/comparison behavior remains scoped. |
| F5 exact guarded provider payload | `provider-request-budget.test.ts`; `generation-executor-adapter.test.ts`; `generation.integration.test.ts` | The checked serialized body is the transported body; recovery and every workflow operation reject over-budget inputs before provider calls and persist private request metadata. |
| F6 strict new protocol and historical compatibility | `story-output.test.ts`; `generation.test.ts`; `prompt-library.integration.test.ts`; `import-memory.integration.test.ts` | New output rejects missing fields and text supersession; historic/import parsing remains a named compatibility path. |
| A1 operation-specific budgeting | `context-budget.test.ts`; `provider-request-budget.test.ts`; `generation-executor-adapter.test.ts` | Context and full-request ceilings are measured separately, output feasibility is checked before transport, and large ceilings do not pad small requests. |
| C1 safe public recovery contract | `generation-diagnostics.test.ts`; `client-api-routes.test.ts`; `generation-events.integration.test.ts` | Polling, SSE, recovery, and prompt previews expose only allowlisted diagnostics and reject private canaries. |
| R1 500-thread projections | `generation.test.ts`; `chronicle-repository.integration.test.ts`; `campaign-state-corrections.integration.test.ts` | 0/100/150/500 distinct threads survive accepted state, correction, authority load, and rebuild; 501 is rejected. |
| R2 exact draft checkpoint/resume | `generation-executor-adapter.test.ts`; `generation.integration.test.ts`; `generation-execution-repository.integration.test.ts` | Main-draft hash, producing payload hash, and sent-fact allowlist survive interruption, reclaim, stale-write fencing, and exactly-once commit. |
| R3 safe diagnostics | `generation-executor-adapter.test.ts`; `generation-diagnostics.test.ts`; `client-api-routes.test.ts`; `generation-events.integration.test.ts` | Each integrity error is recoverable without commit or fallback; public projections omit provider text, scratchpad, request payload, and rejected narration. |
| R4 fact authority | `generation-execution-repository.integration.test.ts`; `generation.integration.test.ts`; `import-memory.integration.test.ts` | Supersession requires an active fact that was sent in the producing request; omitted, foreign, future, expired, and same-text/different-ID facts fail. |
| R5 event coverage and occurrence accounting | `event-finalization.test.ts`; `generation.integration.test.ts` | Omission, contradiction, timeout, and exhausted repair do not commit; deferred and immediate events each require the final fiction they own. |
| R6 immutable protocol identity | `generation-authority.test.ts`; `generation-repository.integration.test.ts`; `generation-execution-repository.integration.test.ts` | Append, replace-latest, turn zero, duplicate idempotency, compatible reclaim, and old-protocol retry retain or reject the original snapshot without a hidden provider call. |
| R7 output feasibility | `context-budget.test.ts`; `event-finalization.test.ts`; `provider-request-budget.test.ts` | Input capacity, output reserve, 200K narration limit, exact-fit/one-over, and escaped output are distinct pre-transport outcomes. |

## Explicit matrix cases and limits

The matrix combines the composed case above with the focused contracts named
in the table.  The coverage is intentionally distributed because some cases
need direct control of a lease, exact serialized bytes, or a database
transaction that a three-turn workflow cannot safely force.

| Required case | Executable suite(s) |
| --- | --- |
| 4K, 32K, 64K, 128K, 256K, and 1M settings; 1M requested against a smaller provider; invalid limits/reserves; omitted recent counts | `generation.test.ts`, `client-core/story-context-budget.test.ts`, `context-budget.test.ts`, `provider-request-budget.test.ts`, `generation-executor-adapter.test.ts` |
| 0/100/150/500 threads, 501 rejection, empty values, direct correction, rebuild, legacy import | `generation.test.ts`, `chronicle-repository.integration.test.ts`, `campaign-state-corrections.integration.test.ts`, `import-memory.integration.test.ts` |
| append/replace/turn zero, duplicate submission, cancellation, two workers, lease takeover, interruptions, old protocol | `generation-authority.test.ts`, `generation-repository.integration.test.ts`, `generation-execution-repository.integration.test.ts`, `generation.integration.test.ts`, `generation-executor-adapter.test.ts` |
| owner/campaign/world, future/superseded aliases and facts, sent-source IDs, audit hash | `chronicle-contract-matrix.integration.test.ts`, `generation-execution-repository.integration.test.ts`, `generation.integration.test.ts`, `import-memory.integration.test.ts` |
| embeddings disabled/removed/rebuilt; lexical and comparison retrieval | `chronicle-contract-matrix.integration.test.ts`, `import-memory.integration.test.ts`, `generation.integration.test.ts` |
| safe private-data boundaries in logs, polling, SSE, recovery, and previews | `generation-executor-adapter.test.ts`, `generation-diagnostics.test.ts`, `client-api-routes.test.ts`, `generation-events.integration.test.ts` |
| event omission, contradiction, timeout, extension repair and text supersession | `event-finalization.test.ts`, `generation.integration.test.ts`, `generation-execution-repository.integration.test.ts` |

## Execution record

| Gate | Result | Evidence |
| --- | --- | --- |
| Focused composed workflow | Passed: 1 file, 1 test | 2026-09-05, isolated PostgreSQL plus deterministic provider; 4.37 s total. |
| `pnpm test:unit --exclude '**/.worktrees/**' --exclude '**/.codex/**'` | Passed: 237 files, 2,793 passed, 44 skipped | 2026-09-06 final exact-head release run. |
| `pnpm test:integration` | Passed: 72 of 72 isolated files | 2026-09-06 final exact-head release run against Docker PostgreSQL. It includes the Chronicle cache LRU tie regression and refreshed migration/archive ledgers. |
| `pnpm check` | Passed | 2026-09-06 final exact-head release run; repository/data boundaries and all TypeScript checks passed. |
| `pnpm build` | Passed | 2026-09-06 final exact-head release run; legacy and replacement web bundles completed. |
| `git diff --check` | Passed | 2026-09-06. |
| `pnpm test:e2e:data-transfer` | Passed: 27 tests | 2026-09-06 final exact-head release run; replacement and legacy Data Transfer flows rendered in Playwright. |

### Planner measurement

On 2026-09-05, `planContext` packed 1,000 optional 900-character records
into a 1,000,000-token configured/input budget.  All three runs selected 1,000
whole records, omitted none, and produced a 995,816-character serialized
request.  Wall times were 646.091 ms, 598.178 ms, and 597.143 ms; observed
heap deltas were 28,394,704, 74,068,888, and 6,438,880 bytes.  This is a local
synthetic measurement using the production planner and serializer callbacks,
not a constant-time claim or a live-provider measurement.  The second sample's
larger allocation merits repeat measurement if candidate counts or request
serialization change materially.

Every required automated gate above has a fresh successful result. Docker
PostgreSQL and Playwright were run locally; this record does not establish a
live-provider production canary.
