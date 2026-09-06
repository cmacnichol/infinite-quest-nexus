# Story Context Budget Control Implementation Plan

> **Superseded:** The browser-owned design was replaced by [2026-08-27-campaign-owned-story-context-budget.md](2026-08-27-campaign-owned-story-context-budget.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users choose how much Story context to request from both active Story Player UIs while preserving the current 32K default and relying on the existing runtime provider-window clamp.

**Architecture:** Add one deep `@infinite-quest/client-core` module that owns supported token presets, normalization, and a safe same-origin storage key. Each Story UI keeps the selected value in its local page state and snapshots it into the existing `generationRequestSchema.context.budgetTokens` field when preparing append or replacement work. No server, database, worker, or provider interface changes are needed because those layers already validate, persist, and safely clamp this field.

**Tech Stack:** Node.js 22.13+, TypeScript 7, vanilla JavaScript, Linkedom, Vitest 4, Vite, `localStorage`, existing Fastify/Zod generation contracts

**Spec:** `docs/superpowers/specs/2026-08-26-story-context-budget-control-design.md`

## Global Constraints

- Keep this a client-only feature using the existing `context.budgetTokens` request field.
- Preserve the current 32,000-token behavior when storage is missing, invalid, or unavailable.
- Offer only 32K, 64K, 128K, 256K, and maximum-available/up-to-1M presets; do not add a free-form input.
- Keep `compression: "auto"` and `recentTurns: 8` unchanged.
- Treat the selection as a sticky same-origin browser preference shared by both UI versions, not campaign state and not a one-shot override.
- Let the runtime remain authoritative for the provider/model hard limit, output reserve, fixed prompt envelope, and Chronicle trimming.
- Preserve the chosen value through Auto classification, confirmation, generated choices, enqueue failures, and new retry-latest replacement submissions.
- Preserve snapshotted context for already-enqueued durable job retries.
- Update the active legacy Story surface only: `apps/web/public/story.html`, `apps/web/public/story.css`, and `apps/web/src/story.js`. Do not modify the historical root `index.html`.
- Keep controls compact, square within web-next's Constructed Atlas system, accessible by label and keyboard, and visually subordinate to the composer text and primary action.
- Every behavior change gets a failing test before implementation.
- Do not claim rendered/provider verification when only static or unit proof was available.
- Run the Impeccable detector once, after the UI implementation is complete.
- Run `git diff --check` and review the complete diff before each commit.

---

## File and interface map

### New files

- `packages/client-core/src/story-context-budget.ts` — supported presets, type, storage key, normalization, safe load, and safe save.
- `tests/unit/client-core/story-context-budget.test.ts` — pure preset and storage behavior.

### Modified production files

- `packages/client-core/src/index.ts` — exports the shared context-budget interface.
- `apps/web-next/src/story-player-model.ts` — loads, stores, and publishes the selected budget.
- `apps/web-next/src/story-player-generation.ts` — snapshots the selected budget into append and replacement requests.
- `apps/web-next/src/story-player-view.ts` — renders the compact Story context select.
- `apps/web-next/src/story-player-page.ts` — binds selection changes and includes the selected budget in prepared submissions.
- `apps/web-next/src/story-player.css` — aligns the control with the composer grid and compact layout.
- `apps/web-next/src/campaign-editor-page.ts` — uses the shared stored preference for its retry-latest request.
- `apps/web/public/story.html` — adds labelled main and retry Story context selects.
- `apps/web/public/story.css` — adds compact legacy selector styling and responsive placement.
- `apps/web/src/story.js` — loads, synchronizes, persists, disables, and submits the legacy preference.

### Modified tests and documentation

- `tests/unit/web-next-story-model.test.ts`
- `tests/unit/web-next-story-generation.test.ts`
- `tests/unit/web-next-story-composer.test.ts`
- `tests/unit/web-next-campaign-editor.test.ts`
- `tests/unit/story-player-ui.test.ts`
- `docs/player-guide/turn-input-modes.md`
- `docs/concepts/context-construction.md`

### Existing regression coverage to run without modification unless it exposes a gap

- `tests/unit/client-web/pending-submissions.test.ts`
- `tests/unit/generation.test.ts`

### Shared interface

```ts
export const DEFAULT_STORY_CONTEXT_BUDGET_TOKENS = 32_000;
export const STORY_CONTEXT_BUDGET_STORAGE_KEY =
  "infinite-quest.story.context-budget-tokens";
export const STORY_CONTEXT_BUDGET_PRESETS = [
  { value: 32_000, label: "Standard · 32K" },
  { value: 64_000, label: "Expanded · 64K" },
  { value: 128_000, label: "Large · 128K" },
  { value: 256_000, label: "Very large · 256K" },
  { value: 1_000_000, label: "Maximum available · up to 1M" }
] as const;

export type StoryContextBudgetTokens =
  (typeof STORY_CONTEXT_BUDGET_PRESETS)[number]["value"];

export type StoryContextBudgetStorage = Readonly<{
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}>;

export function normalizeStoryContextBudgetTokens(
  value: unknown
): StoryContextBudgetTokens;
export function loadStoryContextBudgetTokens(
  storage: Pick<StoryContextBudgetStorage, "getItem"> | null
): StoryContextBudgetTokens;
export function saveStoryContextBudgetTokens(
  storage: Pick<StoryContextBudgetStorage, "setItem"> | null,
  value: unknown
): StoryContextBudgetTokens;
```

---

### Task 1: Add the shared context-budget preference module

**Files:**
- Create: `packages/client-core/src/story-context-budget.ts`
- Create: `tests/unit/client-core/story-context-budget.test.ts`
- Modify: `packages/client-core/src/index.ts`

**Interfaces:**
- Produces: `StoryContextBudgetTokens`
- Produces: `STORY_CONTEXT_BUDGET_PRESETS`
- Produces: `STORY_CONTEXT_BUDGET_STORAGE_KEY`
- Produces: `normalizeStoryContextBudgetTokens`, `loadStoryContextBudgetTokens`, and `saveStoryContextBudgetTokens`
- Consumed by: Tasks 2–4.

- [ ] **Step 1: Write failing pure-module tests**

Create `tests/unit/client-core/story-context-budget.test.ts` covering:

```ts
import { describe, expect, it, vi } from "vitest";
import { MAX_MEMORY_CONTEXT_BUDGET_TOKENS } from "@infinite-quest/contracts";
import {
  DEFAULT_STORY_CONTEXT_BUDGET_TOKENS,
  STORY_CONTEXT_BUDGET_PRESETS,
  STORY_CONTEXT_BUDGET_STORAGE_KEY,
  loadStoryContextBudgetTokens,
  normalizeStoryContextBudgetTokens,
  saveStoryContextBudgetTokens
} from "../../../packages/client-core/src/index.js";

describe("story context budget preference", () => {
  it("exposes the supported presets and keeps the UI maximum aligned with the contract", () => {
    expect(STORY_CONTEXT_BUDGET_PRESETS.map(({ value }) => value)).toEqual([
      32_000, 64_000, 128_000, 256_000, 1_000_000
    ]);
    expect(STORY_CONTEXT_BUDGET_PRESETS.at(-1)?.value)
      .toBe(MAX_MEMORY_CONTEXT_BUDGET_TOKENS);
  });

  it.each([32_000, 64_000, 128_000, 256_000, 1_000_000])(
    "accepts preset %s",
    (value) => expect(normalizeStoryContextBudgetTokens(value)).toBe(value)
  );

  it.each([undefined, null, "", "64000x", 512, 48_000, 1_000_001])(
    "falls back for unsupported value %s",
    (value) => expect(normalizeStoryContextBudgetTokens(value))
      .toBe(DEFAULT_STORY_CONTEXT_BUDGET_TOKENS)
  );

  it("uses one stable storage key and tolerates denied storage", () => {
    const denied = {
      getItem: vi.fn(() => { throw new Error("denied"); }),
      setItem: vi.fn(() => { throw new Error("denied"); })
    };
    expect(STORY_CONTEXT_BUDGET_STORAGE_KEY)
      .toBe("infinite-quest.story.context-budget-tokens");
    expect(loadStoryContextBudgetTokens(denied)).toBe(32_000);
    expect(saveStoryContextBudgetTokens(denied, 128_000)).toBe(128_000);
  });
});
```

Also cover valid string values from storage, invalid stored values, `null` storage, and `setItem` receiving the normalized decimal string.

- [ ] **Step 2: Run the focused test and verify the export is missing**

Run:

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/client-core/story-context-budget.test.ts
```

Expected: FAIL because the module and exports do not exist.

- [ ] **Step 3: Implement the pure module**

Create `packages/client-core/src/story-context-budget.ts` with the interface above. Implement normalization with a preset membership check, parse stored decimal strings without accepting partial numbers, and wrap storage calls in `try/catch`.

Keep the module free of DOM types and UI imports. Export its values, functions, and types from `packages/client-core/src/index.ts`.

- [ ] **Step 4: Run the focused test and client-core typecheck**

Run:

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/client-core/story-context-budget.test.ts
pnpm --filter @infinite-quest/client-core check
```

Expected: PASS.

- [ ] **Step 5: Commit the shared interface**

```powershell
git add packages/client-core/src/story-context-budget.ts packages/client-core/src/index.ts tests/unit/client-core/story-context-budget.test.ts
git diff --cached --check
git commit -m "Add shared Story context preference"
```

---

### Task 2: Thread the selected budget through web-next state and generation requests

**Files:**
- Modify: `apps/web-next/src/story-player-model.ts`
- Modify: `apps/web-next/src/story-player-generation.ts`
- Modify: `apps/web-next/src/story-player-page.ts`
- Modify: `tests/unit/web-next-story-model.test.ts`
- Modify: `tests/unit/web-next-story-generation.test.ts`

**Interfaces:**
- `StoryUiState.contextBudgetTokens: StoryContextBudgetTokens`
- `StoryUiController.setContextBudgetTokens(value: unknown): void`
- `StoryGenerationSubmission.contextBudgetTokens: StoryContextBudgetTokens`

- [ ] **Step 1: Write failing web-next model tests**

In `tests/unit/web-next-story-model.test.ts`, add tests proving:

- initial state loads `128_000` from the shared storage key;
- missing, unsupported, or throwing storage produces `32_000`;
- `setContextBudgetTokens(256_000)` publishes the normalized state and stores `"256000"`;
- denied writes still update current in-memory state;
- unsupported setter input normalizes to `32_000`.

Update the model factory call as needed to inject the structural storage port without reaching global `localStorage` in unit tests.

- [ ] **Step 2: Write failing generation request tests**

In `tests/unit/web-next-story-generation.test.ts`, update submission fixtures with `contextBudgetTokens` and assert both request shapes:

```ts
expect(api.appendGeneration).toHaveBeenCalledWith(
  expect.objectContaining({
    context: {
      budgetTokens: 128_000,
      compression: "auto",
      recentTurns: 8
    }
  })
);

expect(api.retryLatestGeneration).toHaveBeenCalledWith(
  expect.objectContaining({
    context: {
      budgetTokens: 256_000,
      compression: "auto",
      recentTurns: 8
    }
  })
);
```

Add a failed-enqueue case proving the prepared submission retains its budget for a retry. Preserve existing assertions for `operationKind`, replacement identity, idempotency, and pending-submission attachment.

- [ ] **Step 3: Run the focused tests and confirm RED**

Run:

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/web-next-story-model.test.ts tests/unit/web-next-story-generation.test.ts
```

Expected: FAIL because state, controller, submission, and request construction do not yet carry the selected budget.

- [ ] **Step 4: Implement state and request propagation**

In `apps/web-next/src/story-player-model.ts`:

- import the shared type and load/save helpers;
- add `contextBudgetTokens` to `StoryUiState` and `setContextBudgetTokens` to the controller;
- initialize it through `loadStoryContextBudgetTokens(storage)`;
- normalize and publish before attempting storage writes so a denied write does not discard the current choice.

In `apps/web-next/src/story-player-generation.ts`:

- remove the hard-coded `GENERATION_CONTEXT.budgetTokens` constant;
- add `contextBudgetTokens` to `StoryGenerationSubmission`;
- create the request context from the prepared submission while retaining `compression: "auto"` and `recentTurns: 8`.

In `apps/web-next/src/story-player-page.ts`, include `ui.get().contextBudgetTokens` whenever it prepares direct, Auto-resolved, confirmed, generated-choice, begin-story, append, or replacement submissions. Capture the value in the submission object before asynchronous classification or confirmation work so it cannot change underneath that submission.

- [ ] **Step 5: Run focused tests and web-next typecheck**

Run:

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/web-next-story-model.test.ts tests/unit/web-next-story-generation.test.ts
pnpm --filter @infinite-quest/web-next check
```

Expected: PASS.

- [ ] **Step 6: Commit the web-next request seam**

```powershell
git add apps/web-next/src/story-player-model.ts apps/web-next/src/story-player-generation.ts apps/web-next/src/story-player-page.ts tests/unit/web-next-story-model.test.ts tests/unit/web-next-story-generation.test.ts
git diff --cached --check
git commit -m "Use selected Story context in web-next"
```

---

### Task 3: Render and bind the web-next selector, including Campaign editor retry

**Files:**
- Modify: `apps/web-next/src/story-player-view.ts`
- Modify: `apps/web-next/src/story-player-page.ts`
- Modify: `apps/web-next/src/story-player.css`
- Modify: `apps/web-next/src/campaign-editor-page.ts`
- Modify: `tests/unit/web-next-story-composer.test.ts`
- Modify: `tests/unit/web-next-campaign-editor.test.ts`

- [ ] **Step 1: Write failing composer DOM tests**

In `tests/unit/web-next-story-composer.test.ts`, assert that the active composer contains:

- one native `select` with `data-story-context-budget`;
- an accessible **Story context** label;
- the five shared preset values and labels;
- the current model value selected;
- help/title copy explaining provider-window and output/protocol clamping;
- a disabled state while generation is in flight;
- a change handler that updates model state and survives rerender;
- no duplicate selector in the empty-campaign Begin Story panel.

Exercise keyboard/native change behavior through Linkedom rather than asserting only source strings.

- [ ] **Step 2: Write a failing Campaign editor retry test**

In `tests/unit/web-next-campaign-editor.test.ts`, provide storage containing `128000`, trigger `data-action="retry-turn"`, and assert the POST body includes:

```ts
context: {
  budgetTokens: 128_000,
  compression: "auto",
  recentTurns: 8
}
```

Add the invalid/denied-storage fallback assertion only if the campaign-editor harness does not already exercise the shared helper directly; avoid duplicating Task 1's pure tests.

- [ ] **Step 3: Run the UI tests and confirm RED**

Run:

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/web-next-story-composer.test.ts tests/unit/web-next-campaign-editor.test.ts
```

Expected: FAIL because neither UI entrypoint renders or reads the preference.

- [ ] **Step 4: Implement the compact composer control**

In `apps/web-next/src/story-player-view.ts`, render a labelled native select from `STORY_CONTEXT_BUDGET_PRESETS`. Keep it outside the input-mode radiogroup and use the existing semantic tokens, square borders, operational label typography, and visible focus treatment.

In `apps/web-next/src/story-player-page.ts`, bind `change` to `ui.setContextBudgetTokens(select.value)` and let the model rerender select state. Include the selector in existing busy-state synchronization.

In `apps/web-next/src/story-player.css`, make the composer controls a complete, responsive row. At compact width, allow the selector to occupy its own complete grid cell with at least a 44px target; do not shrink the three input-mode choices or primary action.

- [ ] **Step 5: Replace the Campaign editor's hard-coded retry budget**

In `apps/web-next/src/campaign-editor-page.ts`, load the shared preference from `root.ownerDocument.defaultView?.localStorage ?? null` immediately before constructing a new retry-latest request. Keep this action independent from the Chronicle context-preview form, which is a different feature.

- [ ] **Step 6: Run focused tests and build web-next**

Run:

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/web-next-story-composer.test.ts tests/unit/web-next-campaign-editor.test.ts tests/unit/web-next-story-model.test.ts tests/unit/web-next-story-generation.test.ts
pnpm build:web:next
```

Expected: PASS.

- [ ] **Step 7: Commit the web-next UI**

```powershell
git add apps/web-next/src/story-player-view.ts apps/web-next/src/story-player-page.ts apps/web-next/src/story-player.css apps/web-next/src/campaign-editor-page.ts tests/unit/web-next-story-composer.test.ts tests/unit/web-next-campaign-editor.test.ts
git diff --cached --check
git commit -m "Add Story context control to web-next"
```

---

### Task 4: Add the synchronized legacy Story controls and request propagation

**Files:**
- Modify: `apps/web/public/story.html`
- Modify: `apps/web/public/story.css`
- Modify: `apps/web/src/story.js`
- Modify: `tests/unit/story-player-ui.test.ts`

- [ ] **Step 1: Write failing legacy DOM and workflow tests**

Extend `tests/unit/story-player-ui.test.ts` to prove:

- the main composer and retry dialog each contain a labelled native Story context select;
- both selectors render the shared preset values and the same explanatory title/help;
- startup restores `128000` from the shared storage key and invalid/denied reads fall back to 32K;
- changing either selector updates both controls, current state, and storage;
- direct Action, Auto-resolved/confirmed, and retry-latest request bodies carry the selected budget;
- failed append or replacement submission leaves the preference selected;
- successful generation does not reset the preference;
- both controls are disabled during their relevant busy state;
- the historical root `index.html` is not referenced or modified.

Use dispatched `change`/click/submit events where the existing Linkedom harness can prove behavior. Retain existing turn-input-mode and retry-dialog assertions.

- [ ] **Step 2: Run the focused legacy test and confirm RED**

Run:

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/story-player-ui.test.ts
```

Expected: FAIL because the controls and dynamic request value are absent.

- [ ] **Step 3: Add the legacy markup and styling**

In `apps/web/public/story.html`:

- add `turnStoryContextBudget` beside the turn input-mode field;
- add `retryStoryContextBudget` inside the retry dialog beside the replacement prompt controls;
- label both **Story context** and give both the same upper-target/provider-clamp explanation.

In `apps/web/public/story.css`, follow the incumbent navy/purple/gold Story styling with one compact field/select. Preserve the existing rounded legacy vocabulary rather than importing web-next's atlas styling. At narrow widths, move the complete field below the input-mode selector rather than compressing it.

- [ ] **Step 4: Implement legacy state, storage, synchronization, and submission**

In `apps/web/src/story.js`:

- import the shared presets/load/save helpers through the existing bundled client-core path;
- initialize `state.contextBudgetTokens` from safe storage;
- populate or validate both selectors from the shared presets;
- update both selectors and state from either control's `change` event;
- persist through `saveStoryContextBudgetTokens`;
- include both selectors in the existing control-disable synchronization;
- replace `budgetTokens: 32000` in `runGeneration()` with a value snapshotted from `options.contextBudgetTokens ?? state.contextBudgetTokens`;
- make every direct, Auto-confirmed, begin-story, generated-choice, and replacement call capture the current value when it prepares the request;
- keep the retry dialog open and the preference unchanged on failed replacement, and close it through the existing successful path without resetting the preference.

Do not change the campaign's saved `turnControlStyle` or the one-shot story-length override lifecycle.

- [ ] **Step 5: Run focused tests and build legacy Story**

Run:

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/story-player-ui.test.ts tests/unit/client-core/story-context-budget.test.ts tests/unit/client-web/pending-submissions.test.ts
pnpm build:web:legacy
```

Expected: PASS.

- [ ] **Step 6: Commit the legacy UI**

```powershell
git add apps/web/public/story.html apps/web/public/story.css apps/web/src/story.js tests/unit/story-player-ui.test.ts
git diff --cached --check
git commit -m "Add Story context control to legacy player"
```

---

### Task 5: Document the context target and API boundary

**Files:**
- Modify: `docs/player-guide/turn-input-modes.md`
- Modify: `docs/concepts/context-construction.md`

- [ ] **Step 1: Add player-facing guidance**

In `docs/player-guide/turn-input-modes.md`, add a short **Story context** section near the composer controls explaining:

- 32K remains the default;
- larger presets ask Chronicle and recent-history assembly to use a larger upper target;
- the maximum choice is capped at 1M by the current application contract;
- actual input may be lower because output/protocol space is reserved and the provider/model window is authoritative;
- the choice is a browser preference shared by both Story UI versions, not a campaign export setting.

- [ ] **Step 2: Document the architectural distinction**

In `docs/concepts/context-construction.md`, distinguish:

- requested context budget (`request.context.budgetTokens`);
- configured/discovered provider/model context window;
- output/protocol reserve and fixed authority;
- final effective Chronicle budget.

State that no provider payload knob is added: the application assembles and trims the prompt before dispatch.

- [ ] **Step 3: Review docs for promises the runtime cannot guarantee**

Search:

```powershell
rg -n "Story context|32K|64K|128K|256K|1M|provider window|budgetTokens" docs/player-guide/turn-input-modes.md docs/concepts/context-construction.md
```

Expected: no wording promises exact utilization or exceeding the provider window.

- [ ] **Step 4: Commit documentation**

```powershell
git add docs/player-guide/turn-input-modes.md docs/concepts/context-construction.md
git diff --cached --check
git commit -m "Document Story context selection"
```

---

### Task 6: Run focused regression, mechanical UI audit, and rendered smoke verification

**Files:**
- Verify only; modify prior task files only when a failure directly concerns this feature.

- [ ] **Step 1: Run the complete focused unit suite**

Run:

```powershell
.\node_modules\.bin\vitest.cmd run tests/unit/client-core/story-context-budget.test.ts tests/unit/web-next-story-model.test.ts tests/unit/web-next-story-composer.test.ts tests/unit/web-next-story-generation.test.ts tests/unit/web-next-campaign-editor.test.ts tests/unit/story-player-ui.test.ts tests/unit/client-web/pending-submissions.test.ts tests/unit/generation.test.ts
```

Expected: PASS. The pending-submission test proves arbitrary request context remains serialized; the generation-contract test proves the unchanged API accepts the intended budget range.

- [ ] **Step 2: Run repository checks and both production UI builds**

Run:

```powershell
pnpm check
pnpm build:web:legacy
pnpm build:web:next
```

Expected: PASS.

- [ ] **Step 3: Run the bounded Impeccable mechanical detector once**

Run after all UI edits:

```powershell
node "C:\Users\chris\.agents\skills\impeccable\scripts\detect.mjs" --json apps/web-next/src/story-player-view.ts apps/web-next/src/story-player.css apps/web/public/story.html apps/web/public/story.css
```

Expected: no applicable high-confidence accessibility, responsive, or visual-system violations. Fix only findings caused by this feature, rerun the affected focused tests/build once, and do not expand into unrelated cleanup.

- [ ] **Step 4: Perform rendered desktop and compact-width smoke tests on both active Story routes**

Use the application's actual campaign links rather than constructing an unverified route. On a disposable campaign, verify:

1. web-next Story renders the labelled control at desktop and compact widths without squeezing the input modes or Continue action;
2. selecting 128K survives rerender and reload;
3. a direct turn and an Auto-classified/confirmed turn send `context.budgetTokens: 128000` in the network request;
4. Retry latest sends the currently selected value;
5. navigating to legacy Story shows the same 128K preference;
6. changing legacy Story to 256K synchronizes its main and retry controls, survives reload, and appears in append/replacement request bodies;
7. returning to web-next shows 256K;
8. keyboard focus, label announcement, and disabled state remain usable; and
9. no console errors or horizontal overflow are introduced.

Capture one desktop and one compact screenshot for each UI version.

- [ ] **Step 5: Verify the provider clamp when safe runtime data exists**

If a disposable campaign and configured text provider are available, choose a requested budget larger than the provider/model window and complete one generation. Inspect safe generation diagnostics to confirm the effective input budget is clamped below the requested value.

If no safe provider-backed fixture is available, record this exact limitation in the handoff: request propagation and clamp logic are source/unit verified, but live provider clamping was not exercised.

- [ ] **Step 6: Review scope and final diff**

Run:

```powershell
git diff --check
git status --short
git diff --stat
git diff -- packages/client-core/src/story-context-budget.ts packages/client-core/src/index.ts apps/web-next/src/story-player-model.ts apps/web-next/src/story-player-generation.ts apps/web-next/src/story-player-view.ts apps/web-next/src/story-player-page.ts apps/web-next/src/story-player.css apps/web-next/src/campaign-editor-page.ts apps/web/public/story.html apps/web/public/story.css apps/web/src/story.js tests/unit/client-core/story-context-budget.test.ts tests/unit/web-next-story-model.test.ts tests/unit/web-next-story-generation.test.ts tests/unit/web-next-story-composer.test.ts tests/unit/web-next-campaign-editor.test.ts tests/unit/story-player-ui.test.ts docs/player-guide/turn-input-modes.md docs/concepts/context-construction.md
```

Expected: only the scoped feature, tests, and documentation are present; no API, database, runtime, provider, historical `index.html`, or unrelated UI files changed.

- [ ] **Step 7: Prepare the verification handoff**

Report:

- exact test/check/build commands and outcomes;
- both rendered routes and viewport sizes exercised;
- screenshot paths;
- outbound append and retry request budgets observed;
- whether live provider clamping was exercised;
- confirmation that no API/database/runtime/provider change or migration was made; and
- any unrelated pre-existing worktree changes left untouched.
