# Task 2: Legacy campaign creation dialog

## Change

- Added a local, accessible alert inside `createCampaignDialog`. Creation and validation errors are assigned with `textContent`, so API text cannot become markup.
- A failed request leaves the dialog open and retains the title, character, and turn style for retry. Opening the dialog or starting another submission clears a stale alert.
- While creation is in flight, the submit button is disabled and another submit call is ignored. The button becomes available after a failure. Successful creation still refreshes the campaign list and closes the dialog.
- Existing quick creation and readiness issue rendering were reviewed; both already read `readiness.issues[].message`.

## TDD evidence

- **RED:** `node node_modules/vitest/vitest.mjs run tests/unit/legacy-campaign-creation-ui.test.ts` failed, 1 test, because `setCreateCampaignStatus` did not exist.
- **GREEN:** `node node_modules/vitest/vitest.mjs run tests/unit/legacy-campaign-creation-ui.test.ts tests/unit/management-ui.test.ts --reporter=dot` passed, 2 files and 85 tests. The regression exercises local API error visibility, safe text rendering, retained draft, duplicate suppression, retry, successful close, and clearing an old alert on open.
- `git diff --check` passed.

## Verification boundary

These are unit behavior tests. The controller owns rendered browser verification and screenshots on the isolated fixture runtime. No PostgreSQL, deployment, or live-provider check was part of this UI task.
