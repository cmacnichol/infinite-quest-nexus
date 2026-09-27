# Continuity review reliability evaluation

## Incident evidence

The read-only review covered generation job `250d57ec-7e00-4075-898d-3afa8904acec` and its provider attempt around 2026-09-26 23:45 UTC. Application logs reported a valid story candidate and a continuity reviewer response with finish reason `length`, `outputLimited: true`, 65,536 output tokens, and 380,348 ms duration. The candidate story and reviewer response are intentionally omitted.

The matching persisted physical-attempt usage row recorded 36,432 input tokens, 65,536 output tokens, and 101,968 total tokens. Its captured request used `@preset/nexus-nsfw`, temperature `0.8`, `max_tokens: 48000`, and strict JSON Schema response formatting (`json_schema`, strict). The database did not retain visible reviewer-output character length, finish reason, output-limited flag, reasoning-token counts, or a separate applied schema record beyond the request contract. The persisted output count exceeds the serialized `max_tokens` value; this discrepancy is recorded as observed and is not interpreted as a token breakdown or proof of a specific provider-side cap.

## Deterministic reproduction

`tests/fixtures/continuity-review-output-limit.ts` contains a synthetic complete story, synthetic required evidence, and a deterministic truncated response marked `outputLimited: true`. The regression test in `tests/unit/story-continuity-review-adapter.test.ts` expects a typed `continuity_review_output_limited` failure. Before Task 2, the focused suite has 20 existing tests passing and this new test failing because the adapter resolves with semantic `uncertain` after converting the limited response into an invalid/null review result. This is the intentional RED state for Task 2; it does not measure semantic reviewer quality.

## Candidate settings and evaluation status

No dedicated review preset was compared with the shared configuration. No isolated live-provider evaluation was run, and no paid provider calls were made. Consequently, completion rate, pass/conflict/uncertainty accuracy, conflict detection, truncation rate, comparative usage and latency, and provider-specific reasoning-control support are unavailable. The incident alone does not support a numeric output-budget recommendation. Keep automatic fallback disabled by default until an authorized, isolated evaluation compares the same evidence across known pass, real conflict, uncertainty, malformed response, and large-evidence cases. Record output-limit and schema outcomes separately from semantic quality in that evaluation.
