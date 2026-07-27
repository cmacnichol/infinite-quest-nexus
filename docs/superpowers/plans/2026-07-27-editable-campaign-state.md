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
- Use `linkedom` version `0.18.13` only as a development dependency for executable DOM behavior tests.

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
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/web/public/story.html:298-312`
- Modify: `apps/web/public/story.js:1-5, 1913-1964, 2179-2199, 2546-2565`
- Modify: `apps/web/public/story-state-editor.js`
- Modify: `apps/web/public/story.css`
- Modify: `tests/unit/story-player-ui.test.ts`
- Modify: `tests/unit/story-state-editor.test.ts`

**Interfaces:**
- Consumes: `canonicalFactContent()` from Task 1 and `state.runtimeState` loaded by `openEditState()`.
- Produces:
  - `createEditableStateRow(document, kind, value): HTMLElement`
  - `renderEditableStateCollection(document, container, values, kind): void`
  - `addEditableStateRow(document, container, kind, value?): void`
  - `collectOpenThreadEditorValues(container): string[]`
  - `collectCanonicalFactEditorValues(container): Array<{ id: string | null; content: string }>`

- [ ] **Step 1: Install the DOM test dependency**

Run:

```powershell
$env:Path = 'C:\Program Files\nodejs;' + $env:Path
pnpm add --save-dev --save-exact linkedom@0.18.13
```

Expected: `package.json` and `pnpm-lock.yaml` record exactly `linkedom` version `0.18.13`.

- [ ] **Step 2: Add a failing semantic dialog-structure test**

Import `parseHTML` from `linkedom` in `tests/unit/story-player-ui.test.ts`, parse the real Story Player document, and test its semantic controls:

```ts
it("provides editable continuity controls while keeping mechanics read-only", () => {
  const { document } = parseHTML(storyHtml);
  const dialog = document.querySelector("#editStateDialog");

  expect(dialog?.querySelector("textarea#editStateContinuitySummary")).not.toBeNull();
  expect(dialog?.querySelector("button#btnAddOpenThread")?.textContent).toContain("Add thread");
  expect(dialog?.querySelector("#editStateOpenThreads")).not.toBeNull();
  expect(dialog?.querySelector("button#btnAddCanonicalFact")?.textContent).toContain("Add fact");
  expect(dialog?.querySelector("#editStateCanonicalFacts")).not.toBeNull();
  expect(dialog?.querySelector("#editStateRpgStatsEditor")).toBeNull();
  expect(dialog?.querySelector("#tab-mechanics")?.textContent).toContain(
    "Generated mechanics are static for this campaign."
  );
});
```

- [ ] **Step 3: Run the UI test and verify RED**

Run:

```powershell
$env:Path = 'C:\Program Files\nodejs;' + $env:Path
& '.\node_modules\.bin\vitest.CMD' run tests/unit/story-player-ui.test.ts
```

Expected: FAIL because the summary is a paragraph and collection Add buttons do not exist.

- [ ] **Step 4: Replace read-only continuity markup with editors**

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

- [ ] **Step 5: Run the UI test and verify GREEN**

Run the Step 3 command.

Expected: PASS.

- [ ] **Step 6: Add failing executable editor behavior tests**

Add imports for `parseHTML` and the planned DOM helpers to `tests/unit/story-state-editor.test.ts`, then add:

```ts
it("renders, adds, removes, and collects editable continuity rows", () => {
  const { document } = parseHTML('<div id="threads"></div><div id="facts"></div>');
  const threads = document.querySelector("#threads");
  const facts = document.querySelector("#facts");
  if (!threads || !facts) throw new Error("Test containers are required.");

  renderEditableStateCollection(document, threads, ["First thread"], "thread");
  renderEditableStateCollection(document, facts, [{
    id: "00000000-0000-4000-8000-000000000001",
    content: "The lens is moon glass."
  }], "fact");

  expect(threads.querySelector("textarea")?.value).toBe("First thread");
  expect(facts.querySelector("textarea")?.value).toBe("The lens is moon glass.");
  expect(facts.querySelector(".state-editor-row")?.getAttribute("data-item-id"))
    .toBe("00000000-0000-4000-8000-000000000001");

  addEditableStateRow(document, threads, "thread", "Second thread");
  expect(collectOpenThreadEditorValues(threads)).toEqual(["First thread", "Second thread"]);

  facts.querySelector("button")?.click();
  expect(collectCanonicalFactEditorValues(facts)).toEqual([]);
});
```

- [ ] **Step 7: Run the editor test and verify RED**

Run:

```powershell
$env:Path = 'C:\Program Files\nodejs;' + $env:Path
& '.\node_modules\.bin\vitest.CMD' run tests/unit/story-state-editor.test.ts
```

Expected: FAIL because the DOM editor functions are not exported.

- [ ] **Step 8: Implement repeatable editor rows in the focused module**

Add the following exports to `apps/web/public/story-state-editor.js`:

```js
export function createEditableStateRow(document, kind, value) {
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

export function addEditableStateRow(
  document,
  container,
  kind,
  value = kind === "fact" ? { id: null, content: "" } : ""
) {
  if (container) container.appendChild(createEditableStateRow(document, kind, value));
}

export function renderEditableStateCollection(document, container, values, kind) {
  if (!container) return;
  container.replaceChildren();
  (Array.isArray(values) ? values : []).forEach(value => {
    container.appendChild(createEditableStateRow(document, kind, value));
  });
}

export function collectOpenThreadEditorValues(container) {
  return [...container.querySelectorAll(".state-editor-row textarea")]
    .map(editor => editor.value);
}

export function collectCanonicalFactEditorValues(container) {
  return [...container.querySelectorAll(".state-editor-row")]
    .map(row => ({
      id: row.dataset.itemId || null,
      content: row.querySelector("textarea")?.value || ""
    }));
}
```

- [ ] **Step 9: Run the editor tests and verify GREEN**

Run the Step 7 command.

Expected: PASS.

- [ ] **Step 10: Integrate the tested helpers with the Story Player**

In `apps/web/public/story.js`:

1. Import `addEditableStateRow`, `canonicalFactContent`, `collectCanonicalFactEditorValues`, `collectOpenThreadEditorValues`, and `renderEditableStateCollection` from `./story-state-editor.js`.
2. Set the summary textarea's `.value` from `runtime.continuitySummary`.
3. Hydrate the thread and fact containers with `renderEditableStateCollection(document, container, values, kind)`.
4. Bind `btnAddOpenThread` and `btnAddCanonicalFact` with `addEditableStateRow(document, container, kind)`.
5. In `inspectTurnState()`, pass `(runtime.canonicalFacts || []).map(canonicalFactContent)` to the existing read-only list renderer.

- [ ] **Step 11: Add focused editor layout styles**

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

- [ ] **Step 12: Run Task 1 and Task 2 tests and verify GREEN**

Run:

```powershell
$env:Path = 'C:\Program Files\nodejs;' + $env:Path
& '.\node_modules\.bin\vitest.CMD' run tests/unit/story-state-editor.test.ts tests/unit/story-player-ui.test.ts
```

Expected: PASS.

- [ ] **Step 13: Commit Task 2**

```powershell
git add -- package.json pnpm-lock.yaml apps/web/public/story-state-editor.js apps/web/public/story.html apps/web/public/story.js apps/web/public/story.css tests/unit/story-state-editor.test.ts tests/unit/story-player-ui.test.ts
git commit -m "Make campaign continuity state editable"
```

---

### Task 3: Complete Save Wiring and Failure Preservation

**Files:**
- Modify: `apps/web/public/story.js:2206-2228`
- Modify: `apps/web/public/story-state-editor.js`
- Test: `tests/unit/story-state-editor.test.ts`
- Test: `tests/integration/campaign-state-corrections.integration.test.ts`

**Interfaces:**
- Consumes: `buildCampaignStateUpdate()` from Task 1 and all collection functions from Task 2.
- Produces: `submitCampaignState(request, campaignId, runtimeState, editorValues, onSaved)` and a complete `PATCH /campaigns/:campaignId/state` request that matches `campaignRuntimeStateUpdateSchema`.

- [ ] **Step 1: Add failing executable save behavior tests**

Add to `tests/unit/story-state-editor.test.ts`:

```ts
const completeRuntimeState = {
  campaignId: "campaign-id",
  activeTurnNumber: 4,
  viewedTurnNumber: 4,
  isCurrent: true,
  revision: 7,
  updatedAt: "2026-07-27T12:00:00.000Z",
  continuitySummary: "Earlier summary.",
  openThreads: ["Earlier thread."],
  canonicalFacts: [],
  scratchpad: "Earlier scratchpad.",
  trackers: [],
  rpgStats: [{ id: "resolve", name: "Resolve", value: 61, note: "" }],
  eventTriggers: [],
  pendingEventTriggers: []
};

const completeEditorValues = {
  continuitySummary: "Corrected summary.",
  openThreads: ["Find the keeper."],
  canonicalFacts: [{
    id: "00000000-0000-4000-8000-000000000001",
    content: "The lens is moon glass."
  }],
  scratchpad: "Private continuity.",
  trackers: [{ id: "trust", name: "Trust", value: "wary", rules: "" }]
};

const expectedCompletePayload = {
  expectedTurnNumber: 4,
  expectedRevision: 7,
  ...completeEditorValues,
  rpgStats: completeRuntimeState.rpgStats,
  eventTriggers: completeRuntimeState.eventTriggers,
  pendingEventTriggers: completeRuntimeState.pendingEventTriggers
};

it("submits the complete payload and applies the saved state only after success", async () => {
  const requests: Array<{ path: string; options: { method: string; body: string } }> = [];
  const savedStates: unknown[] = [];
  const response = { ...completeRuntimeState, ...completeEditorValues, revision: 8 };
  const request = async (path: string, options: { method: string; body: string }) => {
    requests.push({ path, options });
    return response;
  };

  await submitCampaignState(
    request,
    "campaign-id",
    completeRuntimeState,
    completeEditorValues,
    value => savedStates.push(value)
  );

  expect(requests).toEqual([{
    path: "/campaigns/campaign-id/state",
    options: {
      method: "PATCH",
      body: JSON.stringify(expectedCompletePayload)
    }
  }]);
  expect(savedStates).toEqual([response]);
});

it("does not apply or close state after a rejected save", async () => {
  let applied = false;
  const request = async () => {
    throw new Error("Campaign state changed.");
  };

  await expect(submitCampaignState(
    request,
    "campaign-id",
    completeRuntimeState,
    completeEditorValues,
    () => { applied = true; }
  )).rejects.toThrow("Campaign state changed.");

  expect(applied).toBe(false);
});
```

- [ ] **Step 2: Run the save tests and verify RED**

Run:

```powershell
$env:Path = 'C:\Program Files\nodejs;' + $env:Path
& '.\node_modules\.bin\vitest.CMD' run tests/unit/story-state-editor.test.ts
```

Expected: FAIL because `submitCampaignState` is not exported.

- [ ] **Step 3: Implement the tested save orchestration**

Add to `apps/web/public/story-state-editor.js`:

```js
export async function submitCampaignState(
  request,
  campaignId,
  runtimeState,
  editorValues,
  onSaved
) {
  const savedState = await request(`/campaigns/${campaignId}/state`, {
    method: "PATCH",
    body: JSON.stringify(buildCampaignStateUpdate(runtimeState, editorValues))
  });
  onSaved(savedState);
  return savedState;
}
```

- [ ] **Step 4: Run the save tests and verify GREEN**

Run the Step 2 command.

Expected: PASS, including success and rejected-save behavior.

- [ ] **Step 5: Integrate complete save collection**

Update `saveEditState()` to call `submitCampaignState()` with editor values:

```js
await submitCampaignState(api, state.campaignId, state.runtimeState, {
  continuitySummary: $("editStateContinuitySummary")?.value || "",
  openThreads: collectOpenThreadEditorValues($("editStateOpenThreads")),
  canonicalFacts: collectCanonicalFactEditorValues($("editStateCanonicalFacts")),
  scratchpad: scratchpadEl?.value || "",
  trackers: collectTrackerEditorValues()
}, savedState => {
  state.runtimeState = savedState;
  const dlg = $("editStateDialog");
  if (dlg && dlg.close) dlg.close();
});
```

Import `submitCampaignState` from the focused module. Remove the old inline PATCH body, runtime-state assignment, and success-path dialog close. The callback runs only after the request resolves, so rejected saves leave runtime state, the open dialog, and entered controls unchanged.

- [ ] **Step 6: Run focused unit tests and verify GREEN**

Run:

```powershell
$env:Path = 'C:\Program Files\nodejs;' + $env:Path
& '.\node_modules\.bin\vitest.CMD' run tests/unit/story-state-editor.test.ts tests/unit/story-player-ui.test.ts tests/unit/campaign-state-contract.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run the existing PostgreSQL correction test when available**

Check:

```powershell
if ($env:TEST_DATABASE_URL) {
  & '.\node_modules\.bin\vitest.CMD' run --config vitest.integration.config.ts tests/integration/campaign-state-corrections.integration.test.ts
} else {
  Write-Output 'SKIPPED: TEST_DATABASE_URL is not configured; PostgreSQL persistence is not runtime-verified.'
}
```

Expected with `TEST_DATABASE_URL`: PASS. Expected without it: the explicit SKIPPED message; do not describe persistence as runtime-verified.

- [ ] **Step 8: Commit Task 3**

```powershell
git add -- apps/web/public/story-state-editor.js apps/web/public/story.js tests/unit/story-state-editor.test.ts
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
