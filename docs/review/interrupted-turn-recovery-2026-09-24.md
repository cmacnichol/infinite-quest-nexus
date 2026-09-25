# Interrupted turn recovery

The primary provider stream could fail after returning a complete corrected story object. The worker marked the job failed before validating the saved content, and the player removed the live preview. The first object could be malformed even when a later correction was complete.

The focused fix preserves interrupted output and its diagnostic, selects only one unambiguous complete candidate, and runs the normal story, choice, authority, scene, event, and configured continuity checks. A candidate that reaches the final gate is offered for explicit Keep; it is never automatically committed. Keep reuses frozen commit inputs without another primary provider call. Incomplete or conflicting candidates remain reviewable but cannot be kept. Native response-contract recovery requires exact prepared-request failure evidence. Cancellation is not converted into recovery.

Prepared-route deadlines now project as provider timeouts instead of generic connection failures. Raw provider output remains private; the review message uses fixed public text. Existing failed production jobs are not automatically changed or retried by this patch.

## Verification

- RED: append and replacement regression tests initially returned `failed` instead of preserving a review; the ambiguity regression initially selected the first of two adjacent valid objects.
- GREEN: focused unit, real isolated PostgreSQL, and both rendered Story interfaces cover recovery, explicit Keep, unchanged state before acceptance, no repeated generation on Keep, malformed/ambiguous output, native deadline diagnostics, and missing native wire evidence.
- Final results: 178 focused unit tests passed; 94 PostgreSQL tests passed; two Playwright tests passed. No tests were skipped in the full selected suites. Live-provider behavior was not tested.
- Browser screenshots: [legacy](../../local-data/interrupted-qa/legacy-recovery.png), [replacement](../../local-data/interrupted-qa/web-next-recovery.png). Synthetic local QA artifacts are ignored by Git.
- TypeScript, both web builds, and diff whitespace checks were run. The replacement web build retains its existing large-chunk warning.
- Independent code review checked recovery/replay and request provenance; its recommended exact-wire-evidence guard was applied.

Applied in the main checkout alongside the earlier campaign review-settings/budget changes. No production deployment, live-provider generation, or mutation of the previously failed job was performed. Deploy the rebuilt server and clients together so both understand the new review reason.
