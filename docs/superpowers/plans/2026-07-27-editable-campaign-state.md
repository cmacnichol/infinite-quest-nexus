# Editable Campaign State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make continuity summary, open threads, canonical facts, scratchpad, and trackers editable and atomically saveable from the Story Player while generated mechanics remain read-only and unchanged.

**Architecture:** Extract state normalization and complete PATCH-payload construction into a small browser-safe ES module that can be unit-tested without a DOM. Keep DOM rendering and event wiring in the existing Story Player module, using repeatable editor rows for threads and facts; retain canonical-fact IDs in row metadata and copy loaded mechanics into the complete update payload.

**Tech Stack:** Browser ES modules, vanilla HTML/CSS/JavaScript, TypeScript-based Vitest tests, Zod API contracts, Fastify API, PostgreSQL integration tests.

## Global Constraints

- Use two-space indentation and existing `camelCase` JavaScript naming.
- Do not modify legacy root `index.html`; only `apps/web` is authoritative.
- Mechanics (`rpgStats`, `eventTriggers`, and `pendingEventTriggers`) remain read-only after campaign generation.
- Preserve canonical-fact IDs when content is unchanged or edited; new facts use `id: null`.
- Omit blank open-thread and canonical-fact rows before submission.
- Send every field required by `campaignRuntimeStateUpdateSchema` in one atomic PATCH.
- Preserve optimistic concurrency through `expectedTurnNumber` and `expectedRevision`.
- Leave the dialog and entered values open after save failures.
- Do not alter the existing API, database schema, or accepted turns.
- Keep unrelated user changes in `.claude`, `.repowise`, `.vscode`, and `AGENTS.md` untouched.
- Never report PostgreSQL integration behavior as runtime-verified when `TEST_DATABASE_URL` is absent.

---

### Task 1: Testable State Normalization and Complete Update Payload

**Files:**
- Create: `apps/web/public/story-state-editor.js`
- Create: `tests/unit/story-state-editor.test.ts`

**Interfaces:**
- Consumes: Runtime state returned by `GET /api/v1/campaigns/:campaignId/state`.
- Produces:
  - `canonicalFactContent(value: unknown): string`
  - `normalizeTextItems(values: unknown): string[]`
  - `normalizeCanonicalFacts(values: unknown): Array<{ id: string | null; content: string }>`
  - `buildCampaignStateUpdate(runtimeState, editorValues): CampaignRuntimeStateUpdate` as a plain browser object.

- [ ] **Step 1: Write failing normalization tests**

Create `tests/unit/story-state-editor.test.ts` with direct imports from the browser module and tests that specify the required behavior:

```ts
import { describe, expect, it } from "vitest";
import {
  canonicalFactContent,
  normalizeCanonicalFacts,
  normalizeTextItems
} from "../../apps/web/public/story-state-editor.js";

describe("Story Player campaign state editor", () => {
  it("renders structured canonical facts by content", () => {
    expect(canonicalFactContent({
      id: "00000000-0000-4000-8000-000000000001",
      content: "The lens is moon glass."
    })).toBe("The lens is moon glass.");
    expect(canonicalFactContent("Legacy fact")).toBe("Legacy fact");
    expect(canonicalFactContent({ invalid: true })).toBe("");
  });

  it("trims text collections and omits blank rows", () => {
    expect(normalizeTextItems([" First thread ", "", "   ", "Second thread"])).toEqual([
      "First thread",
      "Second thread"
    ]);
  });

  it("preserves canonical IDs and assigns null to new facts", () => {
    expect(normalizeCanonicalFacts([
      { id: "00000000-0000-4000-8000-000000000001", content: " Existing fact " },
      { id: "", content: " New fact " },
      { id: null, content: " " }
    ])).toEqual([
      { id: "00000000-0000-4000-8000-000000000001", content: "Existing fact" },
      { id: null, content: "New fact" }
    ]);
  });
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```powershell
$env:Path = 'C:\Program Files\nodejs;' + $env:Path
& '.\node_modules\.bin\vitest.CMD' run tests/unit/story-state-editor.test.ts
```

Expected: FAIL because `apps/web/public/story-state-editor.js` does not exist.

- [ ] **Step 3: Implement the minimal normalization module**

Create `apps/web/public/story-state-editor.js`:

```js
export function canonicalFactContent(value) {
  if (typeof value === "string") return value;
  return value && typeof value === "object" && typeof value.content === "string"
    ? value.content
    : "";
}

export function normalizeTextItems(values) {
  return Array.isArray(values)
    ? values
      .filter(value => typeof value === "string")
      .map(value => value.trim())
      .filter(Boolean)
    : [];
}

export function normalizeCanonicalFacts(values) {
  return Array.isArray(values)
    ? values.flatMap(value => {
      const content = canonicalFactContent(value).trim();
      if (!content) return [];
      const id = value && typeof value === "object" && typeof value.id === "string" && value.id
        ? value.id
        : null;
      return [{ id, content }];
    })
    : [];
}
```

- [ ] **Step 4: Run the normalization tests and verify GREEN**

Run the Step 2 command.

Expected: PASS with 3 tests.

- [ ] **Step 5: Add a failing complete-payload test**

Add `buildCampaignStateUpdate` to the import list, then append:

```ts
it("builds a complete update while preserving loaded mechanics", () => {
  const payload = buildCampaignStateUpdate({
    activeTurnNumber: 4,
    revision: 7,
    rpgStats: [{ id: "resolve", name: "Resolve", value: 61, note: "" }],
    eventTriggers: [{ id: "lens-lit" }],
    pendingEventTriggers: [{ id: "sea-road" }]
  }, {
    continuitySummary: " Corrected summary. ",
    openThreads: [" Find the keeper. ", ""],
    canonicalFacts: [{
      id: "00000000-0000-4000-8000-000000000001",
      content: " The lens is moon glass. "
    }],
    scratchpad: "Private continuity.",
    trackers: [{ id: "trust", name: "Trust", value: "wary", rules: "" }]
  });

  expect(payload).toEqual({
    expectedTurnNumber: 4,
    expectedRevision: 7,
    continuitySummary: " Corrected summary. ",
    openThreads: ["Find the keeper."],
    canonicalFacts: [{
      id: "00000000-0000-4000-8000-000000000001",
      content: "The lens is moon glass."
    }],
    scratchpad: "Private continuity.",
    trackers: [{ id: "trust", name: "Trust", value: "wary", rules: "" }],
    rpgStats: [{ id: "resolve", name: "Resolve", value: 61, note: "" }],
    eventTriggers: [{ id: "lens-lit" }],
    pendingEventTriggers: [{ id: "sea-road" }]
  });
});
```

- [ ] **Step 6: Run the payload test and verify RED**

Run the Step 2 command.

Expected: FAIL because `buildCampaignStateUpdate` is not exported.

- [ ] **Step 7: Implement complete payload construction**

Add to `apps/web/public/story-state-editor.js`:

```js
export function buildCampaignStateUpdate(runtimeState, editorValues) {
  return {
    expectedTurnNumber: runtimeState.activeTurnNumber,
    expectedRevision: runtimeState.revision,
    continuitySummary: String(editorValues.continuitySummary ?? ""),
    openThreads: normalizeTextItems(editorValues.openThreads),
    canonicalFacts: normalizeCanonicalFacts(editorValues.canonicalFacts),
    scratchpad: String(editorValues.scratchpad ?? ""),
    trackers: Array.isArray(editorValues.trackers) ? editorValues.trackers : [],
    rpgStats: Array.isArray(runtimeState.rpgStats) ? runtimeState.rpgStats : [],
    eventTriggers: Array.isArray(runtimeState.eventTriggers) ? runtimeState.eventTriggers : [],
    pendingEventTriggers: Array.isArray(runtimeState.pendingEventTriggers)
      ? runtimeState.pendingEventTriggers
      : []
  };
}
```

- [ ] **Step 8: Run Task 1 tests and verify GREEN**

Run the Step 2 command.

Expected: PASS with 4 tests.

- [ ] **Step 9: Commit Task 1**

```powershell
git add -- apps/web/public/story-state-editor.js tests/unit/story-state-editor.test.ts
git commit -m "Add campaign state editor model"
```

---

### Task 2: Editable Continuity Controls and Structured Fact Rendering

**Files:**
- Modify: `apps/web/public/story.html:298-312`
- Modify: `apps/web/public/story.js:1-5, 1913-1964, 2179-2199, 2546-2565`
- Modify: `apps/web/public/story.css`
- Modify: `tests/unit/story-player-ui.test.ts`

**Interfaces:**
- Consumes: `canonicalFactContent()` from Task 1 and `state.runtimeState` loaded by `openEditState()`.
- Produces:
  - `renderEditableStateCollection(containerId, values, kind)`
  - `addEditableStateRow(containerId, kind, value?)`
  - `collectOpenThreadEditorValues(): string[]`
  - `collectCanonicalFactEditorValues(): Array<{ id: string | null; content: string }>`

- [ ] **Step 1: Add failing dialog-structure assertions**

Add a focused test to `tests/unit/story-player-ui.test.ts`:

```ts
it("provides editable continuity controls while keeping mechanics read-only", () => {
  expect(storyHtml).toContain('textarea id="editStateContinuitySummary"');
  expect(storyHtml).toContain('id="btnAddOpenThread"');
  expect(storyHtml).toContain('id="editStateOpenThreads"');
  expect(storyHtml).toContain('id="btnAddCanonicalFact"');
  expect(storyHtml).toContain('id="editStateCanonicalFacts"');
  expect(storyHtml).not.toContain('id="editStateRpgStatsEditor"');
  expect(storyHtml).toContain("Generated mechanics are static for this campaign.");
});
```

- [ ] **Step 2: Run the UI test and verify RED**

Run:

```powershell
$env:Path = 'C:\Program Files\nodejs;' + $env:Path
& '.\node_modules\.bin\vitest.CMD' run tests/unit/story-player-ui.test.ts
```

Expected: FAIL because the summary is a paragraph and collection Add buttons do not exist.

- [ ] **Step 3: Replace read-only continuity markup with editors**

In `apps/web/public/story.html`, replace the Current State cards with:

```html
<div class="track-card">
  <label for="editStateContinuitySummary"><strong>Continuity summary</strong></label>
  <textarea id="editStateContinuitySummary" rows="6" placeholder="Living summary used to continue the campaign."></textarea>
</div>
<div class="track-card">
  <div class="state-editor-heading">
    <h4>Open threads</h4>
    <button id="btnAddOpenThread" class="small" type="button">＋ Add thread</button>
  </div>
  <div id="editStateOpenThreads" class="stack mini"></div>
</div>
<div class="track-card">
  <div class="state-editor-heading">
    <h4>Canonical facts</h4>
    <button id="btnAddCanonicalFact" class="small" type="button">＋ Add fact</button>
  </div>
  <div id="editStateCanonicalFacts" class="stack mini"></div>
</div>
```

Change the Mechanics tab help text to:

```html
<p class="mini">Generated mechanics are static for this campaign and are shown for context.</p>
```

- [ ] **Step 4: Run the UI test and verify GREEN**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 5: Add failing rendering and collection integration assertions**

Add to the same UI test file:

```ts
it("hydrates editable state collections and renders canonical fact content", () => {
  expect(storyScript).toContain('import { canonicalFactContent } from "./story-state-editor.js";');
  expect(storyScript).toContain('function renderEditableStateCollection(containerId, values, kind)');
  expect(storyScript).toContain('function collectOpenThreadEditorValues()');
  expect(storyScript).toContain('function collectCanonicalFactEditorValues()');
  expect(storyScript).toContain('canonicalFactContent(value)');
  expect(storyScript).not.toContain('renderTextCollection("editStateCanonicalFacts"');
  expect(storyScript).toContain('(runtime.canonicalFacts || []).map(canonicalFactContent)');
});
```

- [ ] **Step 6: Run the UI test and verify RED**

Run the Step 2 command.

Expected: FAIL because the editor-row functions and state-editor import do not exist.

- [ ] **Step 7: Implement repeatable editor rows**

In `apps/web/public/story.js`:

1. Import the Task 1 display helper beside the routing import:

```js
import { canonicalFactContent } from "./story-state-editor.js";
```

2. Replace the read-only overview hydration with:

```js
const summary = $("editStateContinuitySummary");
if (summary) summary.value = runtime.continuitySummary || "";
renderEditableStateCollection("editStateOpenThreads", runtime.openThreads || [], "thread");
renderEditableStateCollection("editStateCanonicalFacts", runtime.canonicalFacts || [], "fact");
```

3. Implement DOM helpers that:
   - create one `.state-editor-row` containing a textarea and Remove button;
   - set `row.dataset.itemId` to the canonical fact ID or an empty string;
   - display `canonicalFactContent(value)` for fact rows;
   - remove only the selected row;
   - append a blank row from each Add button; and
   - return raw textarea values for threads and `{ id, content }` values for facts.

Use this implementation:

```js
function createEditableStateRow(kind, value) {
  const row = document.createElement("div");
  row.className = "state-editor-row";
  if (kind === "fact") {
    row.dataset.itemId = value && typeof value === "object" && typeof value.id === "string"
      ? value.id
      : "";
  }
  const editor = document.createElement("textarea");
  editor.value = kind === "fact" ? canonicalFactContent(value) : String(value ?? "");
  editor.setAttribute("aria-label", kind === "fact" ? "Canonical fact" : "Open thread");
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "small danger";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => row.remove());
  row.append(editor, remove);
  return row;
}

function addEditableStateRow(
  containerId,
  kind,
  value = kind === "fact" ? { id: null, content: "" } : ""
) {
  const container = $(containerId);
  if (container) container.appendChild(createEditableStateRow(kind, value));
}

function renderEditableStateCollection(containerId, values, kind) {
  const container = $(containerId);
  if (!container) return;
  container.replaceChildren();
  (Array.isArray(values) ? values : []).forEach(value => {
    container.appendChild(createEditableStateRow(kind, value));
  });
}

function collectOpenThreadEditorValues() {
  return [...document.querySelectorAll("#editStateOpenThreads .state-editor-row textarea")]
    .map(editor => editor.value);
}

function collectCanonicalFactEditorValues() {
  return [...document.querySelectorAll("#editStateCanonicalFacts .state-editor-row")]
    .map(row => ({
      id: row.dataset.itemId || null,
      content: row.querySelector("textarea")?.value || ""
    }));
}
```

4. Bind `btnAddOpenThread` and `btnAddCanonicalFact` in the Edit State event-binding block.

5. In `inspectTurnState()`, pass `(runtime.canonicalFacts || []).map(canonicalFactContent)` to the existing read-only list renderer.

- [ ] **Step 8: Add focused editor layout styles**

In `apps/web/public/story.css`, add:

```css
.state-editor-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.state-editor-heading h4 { margin: 0; }
.state-editor-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: start; }
.state-editor-row textarea { min-height: 72px; }
@media (max-width: 640px) {
  .state-editor-row { grid-template-columns: 1fr; }
  .state-editor-row button { justify-self: start; }
}
```

- [ ] **Step 9: Run Task 1 and Task 2 tests and verify GREEN**

Run:

```powershell
$env:Path = 'C:\Program Files\nodejs;' + $env:Path
& '.\node_modules\.bin\vitest.CMD' run tests/unit/story-state-editor.test.ts tests/unit/story-player-ui.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit Task 2**

```powershell
git add -- apps/web/public/story.html apps/web/public/story.js apps/web/public/story.css tests/unit/story-player-ui.test.ts
git commit -m "Make campaign continuity state editable"
```

---

### Task 3: Complete Save Wiring and Failure Preservation

**Files:**
- Modify: `apps/web/public/story.js:2206-2228`
- Modify: `tests/unit/story-player-ui.test.ts`
- Test: `tests/unit/story-state-editor.test.ts`
- Test: `tests/integration/campaign-state-corrections.integration.test.ts`

**Interfaces:**
- Consumes: `buildCampaignStateUpdate()` from Task 1 and all collection functions from Task 2.
- Produces: A complete `PATCH /campaigns/:campaignId/state` request that matches `campaignRuntimeStateUpdateSchema`.

- [ ] **Step 1: Add a failing save-wiring assertion**

Add to `tests/unit/story-player-ui.test.ts`:

```ts
it("submits a complete campaign state update from the editor", () => {
  expect(storyScript).toContain('import { buildCampaignStateUpdate, canonicalFactContent } from "./story-state-editor.js";');
  expect(storyScript).toContain("buildCampaignStateUpdate(state.runtimeState, {");
  expect(storyScript).toContain('continuitySummary: $("editStateContinuitySummary")?.value || ""');
  expect(storyScript).toContain("openThreads: collectOpenThreadEditorValues()");
  expect(storyScript).toContain("canonicalFacts: collectCanonicalFactEditorValues()");
  expect(storyScript).toContain("trackers: collectTrackerEditorValues()");
  expect(storyScript).toContain("body: JSON.stringify(payload)");
});
```

- [ ] **Step 2: Run the UI test and verify RED**

Run:

```powershell
$env:Path = 'C:\Program Files\nodejs;' + $env:Path
& '.\node_modules\.bin\vitest.CMD' run tests/unit/story-player-ui.test.ts
```

Expected: FAIL because `saveEditState()` still serializes only scratchpad and trackers.

- [ ] **Step 3: Construct and submit the complete payload**

Update `saveEditState()` to collect values before entering the request:

First extend the state-editor import:

```js
import { buildCampaignStateUpdate, canonicalFactContent } from "./story-state-editor.js";
```

```js
const payload = buildCampaignStateUpdate(state.runtimeState, {
  continuitySummary: $("editStateContinuitySummary")?.value || "",
  openThreads: collectOpenThreadEditorValues(),
  canonicalFacts: collectCanonicalFactEditorValues(),
  scratchpad: scratchpadEl?.value || "",
  trackers: collectTrackerEditorValues()
});
```

Then send:

```js
body: JSON.stringify(payload)
```

Do not mutate `state.runtimeState` until `api()` resolves. Keep the existing close operation only in the success path so rejected saves leave the dialog and entered controls intact.

- [ ] **Step 4: Run focused unit tests and verify GREEN**

Run:

```powershell
$env:Path = 'C:\Program Files\nodejs;' + $env:Path
& '.\node_modules\.bin\vitest.CMD' run tests/unit/story-state-editor.test.ts tests/unit/story-player-ui.test.ts tests/unit/campaign-state-contract.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the existing PostgreSQL correction test when available**

Check:

```powershell
if ($env:TEST_DATABASE_URL) {
  & '.\node_modules\.bin\vitest.CMD' run --config vitest.integration.config.ts tests/integration/campaign-state-corrections.integration.test.ts
} else {
  Write-Output 'SKIPPED: TEST_DATABASE_URL is not configured; PostgreSQL persistence is not runtime-verified.'
}
```

Expected with `TEST_DATABASE_URL`: PASS. Expected without it: the explicit SKIPPED message; do not describe persistence as runtime-verified.

- [ ] **Step 6: Commit Task 3**

```powershell
git add -- apps/web/public/story.js tests/unit/story-player-ui.test.ts
git commit -m "Save complete campaign continuity state"
```

---

### Task 4: Full Verification and Visible UI Evidence

**Files:**
- Verify: all files changed by Tasks 1-3
- Do not commit temporary browser fixtures or screenshots unless the user requests them in the repository.

**Interfaces:**
- Consumes: Completed state-editor implementation.
- Produces: Fresh test, static-check, build, diff, and visual evidence for completion.

- [ ] **Step 1: Run the complete unit suite**

```powershell
$env:Path = 'C:\Program Files\nodejs;' + $env:Path
& '.\node_modules\.bin\vitest.CMD' run tests/unit
```

Expected: all unit tests PASS.

- [ ] **Step 2: Run repository checks**

```powershell
$env:Path = 'C:\Program Files\nodejs;' + $env:Path
pnpm check
```

Expected: exit code 0, including TypeScript and browser JavaScript syntax checks.

- [ ] **Step 3: Run the production build**

```powershell
$env:Path = 'C:\Program Files\nodejs;' + $env:Path
pnpm build
```

Expected: exit code 0.

- [ ] **Step 4: Exercise the dialog visually**

Start the documented development service:

```powershell
$env:Path = 'C:\Program Files\nodejs;' + $env:Path
pnpm dev
```

Open the Story Player for a disposable test campaign in the in-app browser. If no disposable campaign is available, intercept only the browser's campaign-state GET/PATCH calls with a sanitized in-memory fixture; do not write fixture content into application source. Verify at desktop and 640-pixel widths:

1. summary is a populated textarea;
2. threads and facts show editable populated rows;
3. canonical facts show content rather than `[object Object]`;
4. Add and Remove actions work;
5. mechanics remain read-only;
6. Save sends the complete payload; and
7. a forced rejected save leaves the dialog and entered values open.

Capture a screenshot of the populated Edit State dialog for the final handoff.

- [ ] **Step 5: Review formatting and scope**

```powershell
git diff --check
git status --short
git diff origin/main...HEAD -- apps/web/public/story-state-editor.js apps/web/public/story.html apps/web/public/story.js apps/web/public/story.css tests/unit/story-state-editor.test.ts tests/unit/story-player-ui.test.ts docs/superpowers
```

Expected: no whitespace errors, no unrelated files staged or committed, and only the approved state-editor scope in the feature diff.

- [ ] **Step 6: Run RepoWise health and change-risk checks**

Use `get_health` for the changed browser and test files and `get_change_risk("origin/main...HEAD")`. Address findings that are caused by this change; record unrelated pre-existing findings without expanding scope.

- [ ] **Step 7: Commit any verification-only corrections**

If verification required scoped corrections, stage only the affected state-editor files and commit:

```powershell
git add -- apps/web/public/story-state-editor.js apps/web/public/story.html apps/web/public/story.js apps/web/public/story.css tests/unit/story-state-editor.test.ts tests/unit/story-player-ui.test.ts
git commit -m "Harden campaign state editor"
```

If no corrections were required, do not create an empty commit.
