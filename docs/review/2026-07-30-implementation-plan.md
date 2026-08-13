# Implementation Plan: 2026-07-30 Codebase Review Remediation

**Source:** [`2026-07-30-codebase-review.md`](./2026-07-30-codebase-review.md)
**Scope:** every Critical/High/Medium/Low finding, missing-requirement item, test-coverage gap, and specification problem listed in that review.
**Status of this plan:** proposed — no code changes have been made yet except the documentation fixes marked **DONE** below.

All file:line references below were re-verified against the current `main` tip (`069da72`, same commit the review was run against) while drafting this plan, so they should still be accurate when work starts. Re-check before editing regardless, per standard practice.

## SDD task normalization

This plan is executed as the sequential tasks below so each task can be independently implemented, reviewed, and recorded. The original requirements are unchanged. Task 2 intentionally precedes Task 3: section 1.2 explicitly requires the section 3.1 transaction guard before its disabled illustration-independence tests are re-run.

---

## Sequencing rationale

Phase 1 must land first: the CORS default is the delivery mechanism that turns the SSRF findings in Phase 2 from "requires existing network access" into "reachable from any browser tab on the trusted network." Fixing SSRF before CORS is not wrong, but fixing CORS first shrinks the exploitable window fastest for the same total effort. Phases 3–6 have no ordering dependency on 1–2 and can proceed in parallel once resourced.

| Phase | Theme | Blocks release? |
|---|---|---|
| 1 | Immediate release blockers | Yes |
| 2 | Security / data-integrity corrections | Yes (per report) |
| 3 | Missing core requirements | No, but closes a real guarantee gap |
| 4 | Reliability & concurrency proof | No |
| 5 | Test coverage completeness | No |
| 6 | Architecture / maintainability | No |
| 7 | Documentation | Mostly **DONE** — see table at the end |

---

## Phase 1 — Immediate release blockers

### Task 1: 1.1 Fix the CORS default (unsafe wildcard + credentials)

**Finding:** [High] CORS ships an unsafe-by-default configuration (review §4)
**Files:** `packages/database/src/config.ts:67`, `services/api/src/server.ts:184-196`
**Effort:** S

**Change:**
- `config.ts:67` — change the default from `["*"]` to `[]` (empty allowlist) when `CORS_ALLOWED_ORIGINS` is unset.
- `server.ts:184-196` — the existing branch `config.corsAllowedOrigins.includes("*") || config.corsAllowedOrigins.length === 0` currently treats "empty" the same as "wildcard" (both reflect the origin). Split these: an **empty** allowlist must send no `Access-Control-Allow-Origin` header at all (same-origin only); a configured wildcard should only be reachable via an explicit, loudly-named opt-in flag (e.g. `CORS_ALLOW_ANY_ORIGIN_UNSAFE=true`), not by leaving the env var unset.
- Update `.env.example` / `docs/installation/network-access.md` to document the new default and the opt-in flag.

**Acceptance criteria / required tests** (extend `tests/unit/server-security.test.ts`):
- No `CORS_ALLOWED_ORIGINS` set → response to a request carrying an arbitrary `Origin` header does **not** include `Access-Control-Allow-Origin` or `Access-Control-Allow-Credentials`.
- `CORS_ALLOWED_ORIGINS=https://a.example` set → only that origin is reflected with credentials; a different `Origin` gets neither header.
- `CORS_ALLOW_ANY_ORIGIN_UNSAFE=true` set with no allowlist → wildcard-reflection behavior is preserved (regression coverage for the intentional escape hatch).

### Task 3: 1.2 Re-enable and fix the two disabled illustration-independence integration tests (including 5.1)

**Finding:** [High] The sole automated proof that illustration failure does not block story acceptance is disabled (review §4)
**Files:** `tests/integration/image-pipeline.integration.test.ts:526,587`; root cause candidate `services/api/src/generation-service.ts:1358-1374`
**Effort:** M
**Depends on:** nothing structurally, but do this alongside 3.1 below since 3.1 is the most likely root cause.

**Change:**
1. Remove `.skip` from both tests (`image-pipeline.integration.test.ts:526` and `:587`).
2. Run them against current `main` to see whether they now fail, and if so, capture the exact failure. The review's own analysis (§3, §6) points at the unguarded `enqueueAcceptedTurnIllustrationSegments`/`promoteProvisionalSet` calls inside the turn-commit transaction (`generation-service.ts:1358-1374`, confirmed still un-wrapped in a try/catch as of this plan) as the most plausible cause — implement fix 3.1 first, then re-run.
3. If a different root cause surfaces, diagnose and fix it before re-enabling; do not merge with either test skipped again.
4. Also re-enable `world-library.integration.test.ts:850` (disabled in the same commit `a4b661be`, covers campaign-before-world deletion ordering) — same commit, same investigation, low incremental cost. See item 5.1.

**Acceptance criteria:** both tests pass in CI, unskipped, for at least one full CI run before merge; `pnpm test:integration` reports 0 skipped tests in this file.

---

## Phase 2 — Security and data-integrity corrections

### Task 4: 2.1 SSRF: host/IP allowlist for provider `baseUrl`

**Finding:** [High] SSRF via unrestricted provider `baseUrl` (review §4)
**Files:** `packages/contracts/src/generation.ts:21,51` (`providerProfileInputSchema`/`providerProfileUpdateSchema`), `packages/story-engine/src/providers.ts` (`rootUrl`/`lmStudioRoot`/`openAiRoot`), `services/api/src/provider-service.ts` (profile create/update/discover call sites)
**Effort:** M

**Change:**
- Add a shared `assertSafeProviderHost(url: URL): Promise<void>` helper (new file, e.g. `packages/story-engine/src/provider-host-guard.ts`, reusable by both API and worker) that:
  - Resolves the hostname (async DNS lookup, not just literal-IP string matching).
  - Rejects loopback / link-local / RFC1918 / `100.64.0.0/10` CGNAT / cloud-metadata (`169.254.169.254`) ranges by default.
  - Is gated by an explicit operator override (e.g. `ALLOW_INTERNAL_PROVIDER_HOSTS=true`) for legitimate LAN-hosted LM Studio setups, matching the existing `docs/installation` guidance that LM Studio is often LAN-local.
- Call this guard in two places, not one:
  - At provider profile create/update time (`provider-service.ts`), for fast feedback.
  - At every actual request time in `packages/story-engine/src/providers.ts` (text generation, embedding, model discovery), to close the DNS-rebinding gap where a hostname resolves safely at registration time and unsafely at call time.
- `services/api/src/provider-service.ts` discovery endpoint (`POST /api/v1/providers/discover-models`) and `POST /api/v1/provider-text/generate` must call the same guard before dispatching.

**Acceptance criteria / required tests:**
- Registering or invoking a provider profile with `baseUrl` = `http://127.0.0.1/...`, `http://169.254.169.254/...`, or an RFC1918 address is rejected by default (`ForbiddenProviderTargetError`, HTTP 400/403).
- The same rejection applies when the guard is exercised at request time, not just at registration (test with a hostname that resolves to a private IP).
- With the operator override env var set, the same requests succeed (regression for legitimate LAN usage).

### Task 5: 2.2 SSRF: re-validate redirect targets when downloading provider artifacts

**Finding:** [High] SSRF via unvalidated redirect in artifact download (review §4)
**Files:** `services/api/src/image-service.ts:534-550` (`privateArtifactHost`), `:552-578` (`downloadArtifact`)
**Effort:** S–M
**Depends on:** reuse the DNS-resolution logic added in 2.1 if convenient, but this can also ship independently.

**Change:**
- Change `fetch(url, { signal, redirect: "follow" })` to `redirect: "manual"` and manually follow redirects in a loop (cap at, say, 5 hops), re-running `privateArtifactHost` (upgraded to resolve DNS, not just match the literal hostname string) against each hop's `Location` target before following it.
- Apply the same DNS-resolution upgrade to `privateArtifactHost` itself — currently it only inspects the literal hostname string via `isIP()`, which does not catch a hostname that *resolves* to a private address.

**Acceptance criteria / required tests:**
- An artifact URL that redirects from a public-looking host to a private/internal target is rejected mid-redirect-chain, not just on the initial URL.
- A hostname that resolves to a private IP at fetch time (DNS-rebinding simulation via a test DNS stub or mock) is rejected even though the string itself doesn't look private.
- Existing successful-download integration tests continue to pass unchanged.

### Task 6: 2.3 Redact the `configuration` field on provider profile reads

**Finding:** [Medium] `configuration` provider field stored/returned in plaintext (review §6)
**Files:** `services/api/src/provider-service.ts:44,265,297,336,416`; reusable pattern already exists at `services/api/src/world-service.ts:64-83` (`SENSITIVE_WORLD_KEYS`)
**Effort:** S

**Change:**
- Extract or duplicate the `SENSITIVE_WORLD_KEYS`-style filter from `world-service.ts` into a shared location (e.g. `packages/domain/src/redaction.ts`) and apply it to `configuration` before every read-path response in `provider-service.ts` (lines 44, 265, 297, 336, 416 all construct the response object — route them through one `sanitizeProviderConfiguration()` call instead of five ad hoc spreads).
- Do not redact on write (the value must round-trip for legitimate config like Sogni-typed fields) — only the outbound read/list responses.

**Acceptance criteria / required tests:** a provider profile created with a `configuration.apiKey`-shaped secondary secret is not present (or is masked, e.g. `"***"`) in any read/list response, while `apiKey` (the primary field) continues to work as today.

### Task 7: 2.4 Bound uncompressed size during zip import

**Finding:** [Medium] Zip decompression bomb in legacy-story import (review §6)
**Files:** `services/api/src/server.ts:333-369` (`JSZip.loadAsync` + per-entry `.async(...)`)
**Effort:** S

**Change:**
- Track a running uncompressed-byte counter across all `.async(...)` calls (JSZip supports iterating entries with a callback / can be driven with `onData` for streaming per-entry decompression) and abort with a 413/400-class error once the running total exceeds a bounded threshold (review suggests 500MB; pick a number comfortably above real story-export sizes but well under process memory limits).
- Keep the existing 50MB *compressed* upload cap as a first-pass cheap rejection; this is a second, uncompressed-size gate.

**Acceptance criteria / required tests:** a small (<1MB), highly-compressible zip built to decompress past the threshold is rejected before the process finishes decompressing it; a normal-sized story export zip imports unchanged.

---

## Phase 3 — Missing core requirements

### Task 2: 3.1 Guard the illustration-enqueue call inside the turn-commit transaction

**Finding:** [Medium] Unguarded illustration-enqueue call inside the turn-commit transaction (review §6); likely root cause for 1.2
**Files:** `services/api/src/generation-service.ts:1358-1374`
**Effort:** S
**Do this before re-running the tests in 1.2.**

**Change:**
- Wrap the three enqueue paths (`promoteProvisionalSet`, and both `enqueueAcceptedTurnIllustrationSegments` call sites at lines 1369 and 1372) in a try/catch inside `commitStory`. On failure: log the error with job/turn context and either (a) enqueue a lightweight follow-up "illustration reconciliation" job outside the main transaction, or (b) simply leave the turn illustration-less and let the existing lease/backfill reconciliation path pick it up later — confirm which mechanism `docs/operations/recovery/image-jobs.md` already describes and reuse it rather than inventing a new one.
- The accepted turn commit itself (`turns`/`campaign_state`/`chronicle_memories` writes) must not roll back because of an illustration-enqueue failure — that's the ADR 0008 guarantee this fixes.

**Acceptance criteria:** a simulated DB error during illustration enqueue (e.g. inject a constraint violation in a test) still results in a committed turn; the illustration is simply absent/pending rather than the whole turn being rolled back. This is exactly what the re-enabled test in 1.2 (`"preserves the accepted story when the independent image endpoint fails"`) should exercise once you extend it, or add a sibling test for the DB-level failure mode specifically (the existing skipped test covers provider-level failure, not DB-level enqueue failure — both should be covered).

### Task 8: 3.2 Extend world-version deletion tests to the remaining 3 blocker categories

**Finding:** review §5 item 2, §6 "World-version deletion: 3 of 5 blocker categories untested"
**Files:** `tests/integration/world-library.integration.test.ts` (existing pattern at lines 292 and 307); implementation already correct at `world-service.ts:795-925` (verified: the aggregate query at that range already selects all 5 categories — `current_campaigns`, `campaign_migrations`, `campaign_transfers`, `chronicle_memories`, `model_chains`)
**Effort:** S

**Change:** add three new test cases mirroring the existing `current_campaigns`/`campaign_migrations` tests, for:
- a world version referenced by `campaign_transfers` (create a transfer that used this version as source or target, then attempt deletion),
- a world version referenced by `chronicle_memories` (an accepted turn whose memory row still points at this `world_version_id`),
- a world version referenced by `model_chains` (seed a row the way the existing unused-table test fixtures already do, per review §3's note that only test fixtures write this table today).

**Acceptance criteria:** all 5 blocker categories have a dedicated integration test asserting `409` on delete attempt.

---

## Phase 4 — Reliability and concurrency proof

### Task 9: 4.1 Concurrency-race test for generation job claiming

**Finding:** review §5 item 4, §6 "No concurrency test for generation job claiming"
**Files:** new test in `tests/integration/generation.integration.test.ts`; primitives already in place (`generation_jobs_one_active_campaign_idx` partial unique index, `UNIQUE(campaign_id, turn_number)`, `FOR UPDATE SKIP LOCKED`)
**Effort:** M

**Change:** add an integration test that fires two concurrent `runGenerationJob`-equivalent calls (via `Promise.all`) against the same campaign/turn and asserts exactly one commits while the other observes a conflict (`active_generation_exists` or the equivalent error the unique index produces). This is proof-only — the review found the Postgres primitives correct by inspection; the goal is closing the "assumed, never exercised" gap on `generation-service.ts`, which the repo's own hotspot data flags as a 2-prior-fix file.

**Acceptance criteria:** test passes deterministically (not flaky) across repeated runs; exactly one of the two concurrent calls succeeds.

### Task 10: 4.2 Concurrent-replica test for migration advisory locking

**Finding:** review §5 item 5
**Files:** new test in `tests/integration/migrations.integration.test.ts`; primitives in `packages/database/src/migrate.ts:49-64` (`withMigrationLock`), `:102-126` (`waitForDatabaseMigrations`)
**Effort:** M

**Change:** simulate two concurrent processes racing for the advisory lock (two separate pool connections both calling the migration entrypoint) and assert only one actually applies migrations while the other blocks then observes a no-op/already-applied state.

**Acceptance criteria:** test demonstrates a worker-only replica never applies a migration concurrently with the migrator role.

### Task 11: 4.3 Bounded forced-exit path for worker shutdown

**Finding:** review §6 "Graceful shutdown drains in-flight work via AbortController — Partial"
**Files:** `services/worker/src/worker.ts:66-70` (generation jobs already drain correctly); illustration/Chronicle/backfill jobs currently awaited synchronously with no timeout
**Effort:** M

**Change:** add a bounded timeout (configurable, e.g. `WORKER_SHUTDOWN_TIMEOUT_MS`) around the illustration/Chronicle/backfill drain path during SIGTERM handling. If a provider call hangs past the timeout, abort it and let the existing lease/heartbeat reclaim mechanism (already correct per review) pick the job back up on the next worker start, rather than blocking process exit indefinitely.

**Acceptance criteria:** a simulated hung provider call during shutdown no longer blocks process exit past the configured timeout; the job is left in a reclaimable state, not corrupted.

---

## Phase 5 — Test coverage completeness

Task 3 includes item 5.1 because it is explicitly coupled to section 1.2's investigation.

### Task 12: 5.2 Identity-spoofing rejection

Add an identity-spoofing-rejection test: a caller-supplied `id`/`ownerUserId` field on a mutation payload is ignored, not silently dropped-and-trusted. Use a new unit or integration test against a mutation contract such as campaign or world creation.

**Effort:** S

### Task 13: 5.3 Initial-user bootstrap idempotency

Re-run the bootstrap migration/logic and assert no duplicate user or error. Cover the database bootstrap migration and the logic that re-invokes it.

**Effort:** S

### Task 14: 5.4 Real-Postgres semantic-memory auto-enable integration coverage

Add a real-Postgres integration counterpart for `semantic-memory-auto-enable.test.ts`, which is currently the only mocked-DB unit test without one. Place it alongside the other integration tests.

**Effort:** M

### Task 15: 5.5 Zip import/export path-traversal regression coverage

Add a test to the import/export integration suite proving that a zip import/export path-traversal attempt is rejected. The current implementation is safe by construction through the `rootPrefix` containment check at `asset-service.ts:210`, but no test proves it.

**Effort:** S

### Task 16: 5.6 Illustration provider prompt mechanics-leak coverage

Drive a mechanics-laden scene through the full `composeIllustrationProviderPrompt` pipeline and assert the actual outbound provider payload is clean, not merely the sanitizer in isolation. Cover the `packages/domain/src/illustrations.ts:107-114` composer.

**Effort:** S

---

## Phase 6 — Architecture and maintainability

### Task 17: 6.1 `asset-service.ts` characterization tests + `queryAssets` refactor

**Finding:** review §5 item 11, §6 "Magic-number parameter slicing in `queryAssets`", §9 (worst health score in the repo, 1.0/10)
**Files:** `services/api/src/asset-service.ts` (`queryAssets`, 118 lines, cyclomatic complexity 43; the `params.slice(0, params.length - (cursor ? 3 : 1))` pattern at line 589)
**Effort:** L

**Change (in order — characterize before refactoring):**
1. Write characterization tests against current `queryAssets` behavior first (paginated results and facet-count branches, across the filter combinations it supports) so the refactor has a safety net.
2. Extract the duplicated filter-building logic shared between the paginated-results and facet-count branches into one query-fragment builder.
3. Replace the positional `params.slice(...)` pattern with named parameter groups (e.g. build filter params and pagination params as separate arrays, concatenate explicitly) so a future edit to the WHERE-builder can't silently desync page results from facet counts.

**Acceptance criteria:** characterization tests pass before and after the refactor with no behavior change; `queryAssets`'s cyclomatic complexity drops materially; a follow-up `get_health()` check on this file shows improvement.

### Task 18: 6.2 Extract the duplicated "load-or-404" helper

**Finding:** review §6 Low
**Files:** `services/api/src/asset-service.ts`, `image-service.ts`, `generation-service.ts`, `campaign-state-service.ts` (pattern duplicated ~7 times)
**Effort:** S

**Change:** extract a shared `loadOrNotFound(pool, table/query, id, ownerUserId)`-style helper (exact shape depends on how much the 7 call sites actually have in common — read them together before designing the signature) into a shared services helper module.

### 6.3 `apps/web/public/nexus.js` refactor-first work

**Finding:** review §9 — the repo's #1 "fix first" target by its own churn/complexity tooling
**Effort:** L — **not scheduled now.** Flag for the next substantial frontend work item per the review's own recommendation ("if/when substantial frontend work is next planned"); do not do a standalone refactor of untested, hand-written JS without a concrete feature driving it.

---

## Phase 7 — Documentation

Everything in this phase was small enough to execute immediately rather than plan for later. All are **DONE** as of this plan being written.

| # | Item | Resolution | Status |
|---|---|---|---|
| 7.1 | AGENTS.md Story Memory Model section stale relative to ADR 0010 (review §5 item 6, §8 item 2) | Rewrote `AGENTS.md`'s response-chain paragraph to match ADR 0010: chains are not persisted cross-turn; `previous_response_id` is same-job recovery only | **DONE** |
| 7.2 | README/package.json/CI pnpm version mismatch (review §6 Low, §8 item 4) | `README.md` and `docs/installation/requirements.md` corrected to pnpm 11.16.0 (matching `package.json`'s pinned `packageManager` and CI) | **DONE** |
| 7.3 | Duplicate ADR numbers (review §6 Low, §8 item 3) | Renumbered the later ADR of each pair: `0011-editable-campaign-runtime-state.md` → `0026-...`, `0024-scoped-chronicle-entity-identity.md` → `0027-...`. Updated each file's own header, `docs/architecture/index.md`, and the inbound link in `docs/concepts/chronicle-memory.md` | **DONE** |
| 7.4 | capabilities.md vs. deferred-improvements.md narration-streaming ambiguity (review §8 item 1) | Verified in code (`generation-service.ts` `onChunk`/`StreamingSegmentTracker`, ADR 0025) that streamed text is consumed server-side only to drive progressive illustration segmentation — the browser never sees provisional narration text. Reworded the capabilities.md bullet to state this precisely and cross-reference ADR 0025 and the deferred-improvements entry | **INCORRECT — see correction below** |
| 7.5 | No documented SSRF/provider-trust policy (review §8 item 5) | Added a "Provider endpoint trust model" section to `docs/operations/security.md` stating provider `baseUrl` values must be treated as untrusted-by-design targets, cross-referencing this plan's §2.1/§2.2 | **DONE** |
| 7.6 | `docs/development-standards.md` §13 known-unknowns table | Removed the now-resolved "Toolchain version conflict" and "Duplicate ADR numbers" rows | **DONE** |
| 7.7 | Mechanics-leak detector is a fixed regex list, not a contextual classifier (review §6 Medium) | Not a doc defect — already correctly described. Track as a known heuristic limitation rather than a bug; revisit only if false negatives are observed in production | No action needed |
| 7.8 | Linter/formatter, coverage threshold, dependency scanning (review §6 Informational) | Already self-documented as open decisions in `docs/development-standards.md` §13 | No action needed |
| 7.9 | Single-maintainer bus factor (review §6 Informational) | Informational only, not a doc defect | No action needed |

**Correction (2026-07-31, via `docs/ui/OPEN_QUESTIONS.md` Q1):** Item 7.4's
verification was wrong, and its claimed rewording of `capabilities.md`
never actually landed (`git blame` shows that bullet unchanged since
2026-07-21, before this plan was written). The browser *does* receive and
render provisional narration text: `server.ts:741-780`'s SSE stream sends
`partialNarration` (populated in `generation-service.ts` via
`extractPartialNarration(accumulated)` from the same `onChunk` stream this
item cites), and `story.js:1009-1234`'s `renderStreamingPreview()` writes
it into a live `.streaming-narration` DOM node. The `onChunk`/
`StreamingSegmentTracker` path drives illustration segmentation *in
addition to*, not *instead of*, browser-visible narration streaming — the
mutual-exclusivity in the original claim was the error. `capabilities.md`
and `docs/operations/deferred-improvements.md` have since been corrected
to match; this row is left in place, marked incorrect, as a record of the
mistake rather than silently rewritten.

---

## Cross-reference: review section → plan section

| Review section | Plan section(s) |
|---|---|
| §4 Critical/High findings (4 items) | 1.1, 1.2, 2.1, 2.2 |
| §5 Missing/incomplete requirements (11 items) | 1.2/5.1 (#1), 3.2 (#2), 1.1/2.1/2.2 (#3), 4.1 (#4), 4.2 (#5), 7.1 (#6), 2.3 (#7), 2.4 (#8), 5.2/5.3 (#9), 5.4 (#10), 6.1 (#11) |
| §6 Medium/Low findings | 2.3, 2.4, 3.1, 3.2, 4.1, "mechanics-leak" → 7.7, 6.2, 6.1, 7.6, 7.3, 7.2, 7.3 |
| §7 Test coverage gaps | 1.2, 5.1–5.6, 4.1, 4.2 |
| §8 Specification problems (5 items) | 7.4, 7.1, 7.3, 7.2, 7.5 |
| §9 Architecture/future-plan risks | 6.1, 6.3, "no dep scanning" → 7.8 |
| §10 Recommended remediation order | Mirrored directly as Phases 1–7 above |

---

## What this plan does not do

- It does not implement the Phase 1–6 code changes — those are proposed work items with acceptance criteria, ready to pick up.
- It does not remove the `model_chains` table (the review offered a choice between updating docs or removing the dead table/columns; this plan took the lower-risk documentation path in 7.1 and leaves table removal as an optional future cleanup, not a tracked item, since it touches schema/migrations and test fixtures that are out of scope for a docs-driven pass).
- It does not touch the VitePress sidebar config (`docs/.vitepress/config.ts`), which was found during this pass to already be missing several existing ADRs (0017–0020, 0022–0025) independent of the renumbering done here. Not in the original review's findings; worth a separate, small follow-up.
