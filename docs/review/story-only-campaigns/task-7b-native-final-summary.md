# Native browser aggregate summary

This is a retrospective summary of terminal cell 213 / session 19178 (exit
code 0), not a saved raw stdout transcript. A fresh served-asset hash was not
captured before teardown. The subsequent Web Awesome run has its own raw
output and served-asset hash in the Task 7B handoff.

Command:
node node_modules/@playwright/test/cli.js test tests/e2e/story-only-campaigns.e2e.test.ts tests/e2e/story-only-new-ui.e2e.test.ts --config playwright.story-only-runtime.config.ts

Fresh runtime:
renderer=native
database=infinitequest_storyonly_26fa46c4651e4b29a39c1de6448a36ef
baseUrl=http://127.0.0.1:18081

Captured terminal result:
Running 42 tests using 1 worker
42 passed (1.4m)

This run used the E2E source state before the forthcoming Web Awesome turn-length geometry assertion. The Native runtime was then stopped through its owned harness.
