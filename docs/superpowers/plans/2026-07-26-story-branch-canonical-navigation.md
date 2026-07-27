# Story Branch Canonical Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a successful **Create separate campaign** action navigate to the new campaign's canonical `/story/:campaignId` route so refresh, reopen, and browser Back behavior remain consistent.

**Architecture:** Keep the existing branch API request and persistence transaction unchanged. Replace the Story Player's split in-memory/query-parameter transition with one full navigation to the URL-encoded canonical Story route, allowing the existing `init()` path to remain the only campaign-loading and navigation-link synchronization boundary.

**Tech Stack:** Browser JavaScript, native `window.location`, Vitest 4, TypeScript 7, Node.js 22+, PowerShell, PostgreSQL integration tests.

## Global Constraints

- Use strict test-driven development and capture exact RED and GREEN evidence.
- Preserve `POST /api/v1/campaigns/:campaignId/branch` and its one-based `targetTurnNumber`.
- Do not change rewind behavior.
- Do not add query-parameter campaign routing.
- Do not add SPA routing or a `popstate` synchronization path.
- Do not refactor unrelated modal, history-selection, campaign-loading, API, or persistence code.
- Do not add a browser-test dependency for this scoped correction.
- Report the PostgreSQL branch test as skipped, not passed or runtime-verified, when `TEST_DATABASE_URL` is unset.
- Follow the repository's two-space JavaScript and TypeScript indentation.

## File Structure

- Modify `tests/unit/story-player-ui.test.ts` to define the canonical branch-navigation regression contract.
- Modify `apps/web/public/story.js` to make canonical navigation the sole successful branch transition.
- Review `docs/player-guide/campaign-continuity.md`; no edit is expected because it already describes the intended independent-branch behavior.
- Do not modify the API route, branch transaction, contracts, database migrations, or integration fixtures.

---

### Task 1: Route successful previous-turn branches canonically

**Files:**
- Modify: `tests/unit/story-player-ui.test.ts:202-222`
- Modify: `apps/web/public/story.js:2648-2667`
- Review: `docs/player-guide/campaign-continuity.md:15-18`
- Existing integration verification: `tests/integration/generation.integration.test.ts:541-595`

**Interfaces:**
- Consumes: `POST /api/v1/campaigns/:campaignId/branch`, which accepts `{ targetTurnNumber: number }` and returns a campaign object containing `id: string`.
- Produces: browser navigation to `/story/${encodeURIComponent(newCampaign.id)}` after a successful branch response.
- Preserves: the existing failure toast and the selected one-based request boundary `branchDlg._turnIndex + 1`.

- [ ] **Step 1: Verify execution starts on a named topic branch with a clean worktree**

Run:

```powershell
git status -sb
git branch --show-current
```

Expected:

- The branch name is non-empty and uses the `codex/` prefix.
- The worktree has no unrelated changes.
- If the checkout is detached, use the Codex app's **Create branch** control before continuing; suggested name: `codex/fix-story-branch-navigation`.

- [ ] **Step 2: Add the focused failing regression test**

Add this test beside the existing history-navigation tests in `tests/unit/story-player-ui.test.ts`:

```ts
it("navigates a successful previous-turn branch to its canonical Story URL", () => {
  expect(storyScript).toContain(
    "window.location.assign(`/story/${encodeURIComponent(newCampaign.id)}`);"
  );
  expect(storyScript).not.toContain("state.campaignId = newCampaign.id;");
  expect(storyScript).not.toContain('newUrl.searchParams.set("campaignId", newCampaign.id);');
  expect(storyScript).not.toContain(
    'window.history.pushState({ campaignId: newCampaign.id }, "", newUrl.toString());'
  );
  expect(storyScript).not.toContain("await loadCampaign(newCampaign.id);");
});
```

Do not change `apps/web/public/story.js` in this step.

- [ ] **Step 3: Run the focused test and capture RED evidence**

Run:

```powershell
& '.\node_modules\.bin\vitest.CMD' run tests/unit/story-player-ui.test.ts -t "navigates a successful previous-turn branch to its canonical Story URL"
```

Expected: FAIL. The output must show that canonical `window.location.assign(...)` is absent and/or that one of the obsolete in-memory/query-parameter statements is still present.

Record the command, exit code, and decisive assertion text in the implementation report before editing production code.

- [ ] **Step 4: Implement the minimum canonical-navigation change**

In the `result === "copy"` success path in `apps/web/public/story.js`, preserve the API request:

```js
const newCampaign = await api(`/campaigns/${state.campaignId}/branch`, {
  method: "POST",
  body: JSON.stringify({ targetTurnNumber: branchDlg._turnIndex + 1 })
});
```

Replace the current state assignment, query-parameter mutation, `pushState`, `loadCampaign`, `navigateTo`, and success toast with:

```js
window.location.assign(`/story/${encodeURIComponent(newCampaign.id)}`);
```

The complete success path must be:

```js
if (result === "copy" && branchDlg._turnIndex !== undefined) {
  showBusy("Creating campaign branch…");
  try {
    const newCampaign = await api(`/campaigns/${state.campaignId}/branch`, {
      method: "POST",
      body: JSON.stringify({ targetTurnNumber: branchDlg._turnIndex + 1 })
    });
    window.location.assign(`/story/${encodeURIComponent(newCampaign.id)}`);
  } catch (err) {
    toast(`Branch failed: ${err.message}`);
  } finally {
    hideBusy();
  }
}
```

Do not change the reset branch or the API service.

- [ ] **Step 5: Run the focused test and capture GREEN evidence**

Run:

```powershell
& '.\node_modules\.bin\vitest.CMD' run tests/unit/story-player-ui.test.ts -t "navigates a successful previous-turn branch to its canonical Story URL"
```

Expected: PASS with one selected test passing.

Record the command and exit code in the implementation report.

- [ ] **Step 6: Run the complete Story Player unit test file**

Run:

```powershell
& '.\node_modules\.bin\vitest.CMD' run tests/unit/story-player-ui.test.ts
```

Expected: PASS with all tests in `tests/unit/story-player-ui.test.ts` passing.

- [ ] **Step 7: Run syntax, repository-boundary, and TypeScript validation**

Run:

```powershell
& 'C:\Users\chris\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check apps/web/public/story.js
& 'C:\Users\chris\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd' check
```

Expected:

- `node --check` exits 0 with no output.
- `pnpm check` exits 0 after repository-boundary checks, data checks, TypeScript validation, and browser-script syntax checks.

- [ ] **Step 8: Verify the existing PostgreSQL branch scenario when configured**

Run:

```powershell
if ($env:TEST_DATABASE_URL) {
  & '.\node_modules\.bin\vitest.CMD' run --config vitest.integration.config.ts tests/integration/generation.integration.test.ts -t "branches an existing campaign up to a specific turn"
} else {
  Write-Output "SKIP: TEST_DATABASE_URL is unset; PostgreSQL branch behavior was not runtime-verified."
}
```

Expected:

- With `TEST_DATABASE_URL`: PASS for the previous-turn branch integration scenario.
- Without `TEST_DATABASE_URL`: the exact SKIP message above. Do not report the backend integration scenario as passed.

- [ ] **Step 9: Confirm the player guide remains accurate**

Run:

```powershell
rg -n -A 3 -B 1 "Create a separate branch|Create separate campaign" docs/player-guide/campaign-continuity.md
```

Expected: the guide states that the original campaign is preserved and the new campaign is an independent story path. No documentation edit is required because the navigation correction restores that documented behavior without changing the workflow or copy.

- [ ] **Step 10: Review the complete scoped diff**

Run:

```powershell
git diff --check
git diff -- apps/web/public/story.js tests/unit/story-player-ui.test.ts
git status --short
```

Expected:

- `git diff --check` exits 0.
- Only the branch success transition and its focused regression test are changed.
- No API, persistence, migration, fixture, or player-guide files are modified.

- [ ] **Step 11: Commit the tested correction**

Run:

```powershell
git add -- apps/web/public/story.js tests/unit/story-player-ui.test.ts
git commit -m "fix: use canonical route for story branches"
```

Expected: one commit containing only the production correction and regression test.

After the commit, report:

- the exact RED and GREEN commands and outcomes;
- the focused and complete validation results;
- whether PostgreSQL verification passed or was skipped;
- confirmation that no API, migration, or documentation changes were required.
