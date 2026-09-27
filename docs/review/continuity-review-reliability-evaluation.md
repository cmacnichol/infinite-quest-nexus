# Continuity review reliability evaluation

## Incident evidence

The read-only review covered generation job `250d57ec-7e00-4075-898d-3afa8904acec` and its provider attempt around 2026-09-26 23:45 UTC. Application logs reported a valid story candidate and a continuity reviewer response with finish reason `length`, `outputLimited: true`, 65,536 output tokens, and 380,348 ms duration. The candidate story and reviewer response are intentionally omitted.

The matching persisted physical-attempt usage row recorded 36,432 input tokens, 65,536 output tokens, and 101,968 total tokens. Its captured request used `@preset/nexus-nsfw`, temperature `0.8`, `max_tokens: 48000`, and strict JSON Schema response formatting (`json_schema`, strict). The database did not retain visible reviewer-output character length, finish reason, output-limited flag, reasoning-token counts, or a separate applied schema record beyond the request contract. The persisted output count exceeds the serialized `max_tokens` value; this discrepancy is recorded as observed and is not interpreted as a token breakdown or proof of a specific provider-side cap.

## Deterministic reproduction

`tests/fixtures/continuity-review-output-limit.ts` contains a synthetic complete story, synthetic required evidence, and a deterministic truncated response marked `outputLimited: true`. The regression test in `tests/unit/story-continuity-review-adapter.test.ts` expects a typed `continuity_review_output_limited` failure. Before Task 2, the focused suite has 20 existing tests passing and this new test failing because the adapter resolves with semantic `uncertain` after converting the limited response into an invalid/null review result. This is the intentional RED state for Task 2; it does not measure semantic reviewer quality.

## Candidate settings and evaluation status

No dedicated review preset was compared with the shared configuration. No isolated live-provider evaluation was run, and no paid provider calls were made. Consequently, completion rate, pass/conflict/uncertainty accuracy, conflict detection, truncation rate, comparative usage and latency, and provider-specific reasoning-control support are unavailable. The incident alone does not support a numeric output-budget recommendation. Keep automatic fallback disabled by default until an authorized, isolated evaluation compares the same evidence across known pass, real conflict, uncertainty, malformed response, and large-evidence cases. Record output-limit and schema outcomes separately from semantic quality in that evaluation.

## Task 6 release evidence (2026-09-26)

The deterministic continuity workflow has focused unit, dedicated-PostgreSQL, and browser evidence from Tasks 2–5. Task 6 ran all 118 integration files in separate Vitest processes against the dedicated isolated PostgreSQL database; 10 files failed and the sweep therefore is not a release pass. The complete aggregate test count was not captured by that process-per-file runner, so only the 118-file total and 10 failure count are recorded. The required unit command also failed: 4,592 passed, 49 skipped, and 2 failed. One failure is a pre-existing 48,000-token context-budget expectation, reproduced at baseline `900df97`; the other is a bare-`pnpm` child-process version mismatch. With the pinned fallback launcher first on `PATH`, its focused web-build contract passed 5/5. `corepack pnpm check`, `corepack pnpm build`, and `git diff --check` passed using that launcher path.

All reproducible integration failures except the transient campaign-cast-discovery result reproduced at baseline `900df97`: malformed snapshot handling, Story Direction payload assertions, story-memory review mode, oversized Story-only repair, migration-list assertions, System Archive, and resumable System Archive. The campaign-cast failure passed at baseline (54/54) and on a focused branch rerun (1/1), so it remains non-reproducible rather than a branch regression. Baseline evidence is stored in ignored task scratch logs and is not a release pass.

No copied-campaign canary, paid live-review request, provider-quality comparison, production policy enablement, or deployment was authorized or performed. Automatic fallback remains disabled by default. Unit, PostgreSQL, and browser evidence does not establish live reviewer quality, completion rate, cost, or latency.

The Task 6 integration run is a failed gate with incomplete aggregate per-test accounting: it captured 118 files and 10 failed files, but not aggregate passed/skipped test totals.
