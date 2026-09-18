# Turn validation implementation and verification

Status: phases 01–04 implemented and verified. Deployment and live-provider evaluation remain separate, unperformed work.

## Scope and result

Phases 01–04 are implemented on `codex/turn-validation-success` in the isolated `turn-validation-success` worktree, based on `2ce5508872ba0588c0c0ea51769bb828194b3f46`. The final implementation commit is `d9ab9570db951f8d473d7ebcd24d4fc3529dfb34`. Final full unit, check/build and hash verification ran at that commit. Full PostgreSQL and browser verification ran at `b6210ed41368e9f02a0cfddf612b4482ece36f31`; the complete difference to the final commit is two explicit adapter-close calls in one unit test file. All production, integration, browser and configuration inputs are identical. The final documentation commit follows the tested implementation.

- Phase 01 separates initial validation outcomes from retries and final disposition, adds bounded read-only reporting, and preserves finite safe diagnostics through recovery.
- Phase 02 explicitly distinguishes supplied reference facts from output additions and updates. New work freezes the v16 fact-wire contract; existing jobs retain their recorded prompt identities and text.
- Phase 03 proposes only supported deterministic fact-format transformations. It preserves protected content and rejects missing or ambiguous authority, unsupported shapes, mechanics contamination, and incomplete output.
- Phase 04 offers explicit format repair with a plan-bound receipt, preserves the original response and request, records application history, and resumes normal strict validation, semantic review, and transactional acceptance. Both Story clients distinguish this action from Retry.

No deployment, push, main-checkout integration, production mutation, or live-provider experiment was performed. Phases 05–06 remain deferred. Context sizing and provider structured-output experiments require their own implementation and evaluation.

## What the evidence says about validation success

The fixed historical cohort contained 50 jobs: 40 ultimately completed, and 49 retained a first response. Historically 15/49 first responses were valid and 34/49 were invalid. Current parsing accepts 18/49 of those saved first responses before explicit repair. That difference includes parser compatibility already present and cannot be credited to the new prompt.

Only ten jobs retained an exact primary request/response pair suitable for request-hash verification. Eight had an unambiguous inventory matching the saved supplied fact IDs. Four of those responses were already parseable, and the other four became strict-valid through deterministic repair. Two of the four repairs correspond to historical first-response failures. Two retained requests contained conflicting versions of a fact and were correctly excluded; most historical first-response failures lack the retained request evidence needed for a safe replay.

This demonstrates recovery of observed fact-format failures. It does not establish a production recovery percentage, first-pass prompt improvement, or eventual acceptance of those historical candidates. The selected four-response repair sample is too small to extrapolate. See [historical replay](historical-replay.md) for the denominators and method.

The composed PostgreSQL tests separately establish that a supported repaired candidate can reach normal acceptance without another primary-generation call. An enforce-mode continuity conflict still stops for review. Success is not increased by accepting invalid output or suppressing continuity findings.

## Verification record

| Check | Result |
|---|---|
| Complete units at `d9ab9570` | 306 files; 3,860 passed, one platform-conditional skip; exit 0; no unhandled errors |
| Full isolated PostgreSQL at `b6210ed4` | 103 files; 1,244 passed, seven documented opt-in skips; exit 0 |
| `corepack pnpm check` at `d9ab9570` | Passed, including repository/data boundaries and TypeScript |
| `corepack pnpm build` at `d9ab9570` | Passed; existing bundle-size advisory remains |
| Both named Playwright suites at `b6210ed4` | 99 passed, one optional-build skip; exit 0 |
| Serializer/hash compatibility at `d9ab9570` | 144 synthetic cases matched historical serialization and SHA-256 |
| Independent source/specification reviews | Approved; all identified findings resolved and final fixture corrections reviewed |

The first final unit run had one five-second timeout in `task-14e3g-production-binding.test.ts` while unit workers, the build and PostgreSQL tests ran concurrently. A complete rerun with two unit workers passed without changing test timeouts or assertions. The one unit skip is the unsupported secure-filesystem-host branch on a host that supports the implementation. The browser skip requires the explicitly selected optional Web Awesome build; the native build scenarios ran. These skipped checks are not counted as passes.

The immutable Linux test runner uses a Git archive of the candidate, the installed dependency image, and the repository's per-file integration runner. It retains per-file database isolation, replaces only Docker provisioning with the already provisioned dedicated test database, and maps its dedicated loopback port inside that container network. Database safety guards are unchanged. Native check/build/browser sources matched the candidate; only report/checklist documentation changed while these ran.

Intermediate results, failed runs, environment corrections, and independently verified checkpoints are retained in the [verification matrix](verification-matrix.md). The [acceptance checklist](acceptance-checklist.md) records the completed requirement audit and its evidence index.

The PostgreSQL harness uses real isolated databases and deterministic providers. Browser fixtures validate both Story surfaces at desktop and 390×844, including all seven requested scenarios and revoked-Keep behavior. Neither harness establishes live model quality. Screenshot evidence is under `docs/review/assets/turn-validation-success/`.

The planned dedicated fact-format integration cases live in the existing `story-continuity-review.integration.test.ts` and `generation-review.integration.test.ts` suites, reusing their real PostgreSQL and provider harnesses. The matrix handoff maps these cases to the original requirements.

The runtime inventory extractor and shared repair hash implementation are unchanged from the independently replayed `fe37fe1a` checkpoint through `d9ab9570`, verified by an empty path-scoped Git diff. That checkpoint agreed with independent extraction for all ten retained producing requests. The final 144-case hash check also passed. No new live-provider request was made for this verification.

## Final-run failures and corrections

At `b6210ed4`, the complete unit selection reported 3,860 passed assertions and one platform skip but exited 1 with two unhandled Node 26 FileHandle garbage-collection errors in `task-14e2ar-persisted-filesystem.test.ts`. Two simulated-restart fixtures left their original adapters' anchored staging handles open. Commit `d9ab9570` explicitly closes those adapters before rehydration. Independent review confirmed that durable state, staged files, stale-identity rejection and cleanup/retry assertions remain intact. The final complete Linux suite passed without suppressed errors or changed assertions. This was a test-resource correction, not a production filesystem change.

The native final check initially stopped before compilation because nested bare `pnpm` resolved to the Codex fallback version while Corepack selected the repository-pinned 12.4.1. A temporary ignored local shim routed nested calls through Corepack. Check and build then passed; no package declaration or lockfile changed.

An earlier full PostgreSQL run at `5ce73866` exposed a scheduling race in the enrollment lock-ordering test. The test started clear and enqueue concurrently without proving which reached the database lock first. Commit `b6210ed4` waits for observable database lock queues before releasing the held campaign lock, preserves the original snapshot assertions, and cleans up held clients in `finally`. Independent review approved this test-only correction; two focused real-PostgreSQL runs passed. Production lock behavior was unchanged.

The first full PostgreSQL attempt also stopped at the Linux archive/browser test because the test image lacked Chromium. A test-only image with Chromium and its system dependencies corrected that environment limitation. A 33-file suffix preflight passed 403 tests, including the archive/browser round trip; it is not substituted for the complete 103-file final run.

## Review corrections

Independent reviews and coordinator reproduction corrected receipt selection, actual-job scope and actor binding, provider fingerprint checks, unavailable or ambiguous inventory handling, supported complete length-finished responses, Story Direction choice gating, applied provenance through later reviews, Retry replacement repair offers, and durable application history. UI review corrected a revoked Keep action falling through to Retry and expanded screenshot-only viewport coverage into independent interactions at each viewport.

The reachable Retry regression is first malformed primary → explicit Retry → replacement primary → format repair. It contains one repair application. Later retries after an applied repair belong to bounded scene/event/continuity stages; tests do not invent a second full-primary transition. Retained receipt selection and application-history append/idempotency are tested separately.

## Handoffs and operational limits

- [Phase 01](phase-01.md)
- [Phase 02](phase-02.md)
- [Phase 03](phase-03.md)
- [Phase 04 provenance](phase-04-provenance.md), [composed matrix](phase-04-matrix.md), and [UI](phase-04-ui.md)
- [Runtime audit](runtime-audit.md)
- [Rollout and rollback preparation](rollout.md)

The rollout handoff requires compatible API, worker, and clients for v2 jobs. Retain a compatible worker or stop dispatch before reverting to an older binary. Preserve raw attempts, receipts, application history, and newly accepted turns; a database restore over later accepted work is not an application rollback.

The PostgreSQL skips are one optional historical-fact scale benchmark and six pre-existing opt-in known-failure probes in story-context payload coverage. Their passing neighboring regressions do not turn those skips into verified behavior. Both clients ran all seven repair scenarios at desktop and mobile, plus revoked-Keep regressions; the coordinator inspected fresh screenshots and retained the reviewed synthetic screenshot set.

Live success-rate improvement remains unmeasured. A separately authorized canary must compare fixed prompt/model/policy cohorts and report first-pass validity, repair eligibility, explicit repair completion, final acceptance, latency, and provider calls separately.
