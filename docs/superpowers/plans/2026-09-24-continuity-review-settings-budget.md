# Continuity review settings and budget implementation plan

**Goal:** Make continuity review an explicit campaign checkbox, disabled by default, and reserve its full input and output budget before generation.

**Architecture:** Reuse campaign Story Memory enrollment and its frozen job policy. Max memory can run with review off; the checkbox enables enforced review. Preserve existing explicit enrollments and in-flight jobs. Pack optional evidence against both the main request and the prospective review, using the actual review serializer and a draft allowance. Retain the exact post-generation budget guard.

**Scope:** User request in this task. Continue the existing output-limit patch in this checkout without modifying unrelated prompt edits. No production deployment or automatic retry.

## Tasks

- [x] Add a strict optional boolean `continuityReviewEnabled` to the settings update; omission defaults to off. Map enabled Max to enforce, reject enabled lower levels, retain owner/operator checks. Add a forward migration changing new-campaign enrollment to review off.
- [x] Add checkbox/save behavior to campaign overview and legacy campaign/Story settings, including load failure and save failure handling. Test default unchecked, explicit enable/disable, persisted state, and unavailable capability.
- [x] Extend context packing with an additional measured request constraint. Budget the actual continuity prompt/evidence framing plus candidate output allowance and the configured review output reserve. Prune optional records; fail protected overflow before provider dispatch. Keep review-off packing unchanged.
- [x] Run focused RED/GREEN tests, real isolated PostgreSQL settings/frozen-policy/continuity tests, TypeScript and diff checks. Render affected settings, exercise checkbox saves, and capture screenshots using synthetic test data.

## Review focus

- Existing accepted turns and pending review candidates must not be silently changed.
- New campaigns default off even when Max memory is the installed default.
- Disabled review does not reserve review headroom or dispatch review calls.
- Enabled review preserves all selected protected authority and campaign isolation.
- Budgets include frozen provider formatting, candidate input, safety allowance, and full configured output; exact post-generation checks remain authoritative.

## Verification completed

- Focused unit suite: 9 files, 125 tests passed. RED/GREEN coverage includes settings defaults, review reservation, optional pruning, and combined recent/world quotas.
- Isolated PostgreSQL integration suite: 3 files, 98 tests passed; one existing secure-filesystem archive test skipped on Windows. Settings persistence, frozen policy, review-off generation, and native-provider output limits passed.
- TypeScript, JavaScript syntax checks, both web builds, and `git diff --check` passed. The replacement web build retains its existing large-chunk warning.
- Playwright exercised enable/disable and reload persistence against a real isolated API/database on replacement campaign settings, legacy campaign settings, and Story settings. Desktop and mobile rendering inspected; no page errors.
- Screenshots: [replacement settings](../../../local-data/continuity-qa/campaign-disabled.png), [mobile](../../../local-data/continuity-qa/campaign-mobile.png), [Story settings](../../../local-data/continuity-qa/story-settings.png), [legacy settings](../../../local-data/continuity-qa/legacy-campaign-settings.png). These synthetic local QA artifacts are ignored by Git.
- Independent code review completed with no remaining blockers after correcting combined review-budget quota allocation.
- Disposable server and PostgreSQL container stopped. No production deployment, live-provider generation, or retry of the saved failed turn was performed. Deployment requires the new migration and rebuilt application; existing enrollments and pending jobs retain their saved policy.

