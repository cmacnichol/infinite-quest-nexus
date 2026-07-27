# Turn Generation Input Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide the prior turn's input controls during generation and restore only the appropriate controls after the generation resolves.

**Architecture:** The existing `beginGenerationDisplay`, `restoreGenerationDisplay`, and accepted-result path already form a transactional UI lifecycle. Add a single input-panel visibility renderer to that lifecycle, deriving whether the panel is shown from `state.generationDisplayActive` and whether the viewed turn is current.

**Tech Stack:** Browser JavaScript, static Story Player UI regression tests, Vitest.

## Global Constraints

- Preserve the accepted prior turn and restore all of its controls after failed, cancelled, or discarded generation.
- Do not show new controls until the newly accepted turn and its choices are authoritative in the UI.
- Keep the production change limited to the Story Player and update its associated test.

---

### Task 1: Make turn input transactional with generation display

**Files:**
- Modify: `tests/unit/story-player-ui.test.ts`
- Modify: `apps/web/public/story.js`

**Interfaces:**
- Consumes: `state.generationDisplayActive`, `renderChoices(choices, customSuggestion)`, `beginGenerationDisplay(action)`, `restoreGenerationDisplay()`, and `finalizeCompletedGeneration(result)`.
- Produces: `renderTurnInput()` which makes `#choiceArea`, the Prompt-mode field, and the free-action controls visible only when the current viewed turn is accepted and no generation display is active.

- [x] **Step 1: Write the failing test**

Add an assertion to the transactional generation-display test that requires `renderTurnInput()` to be called from begin, restore, and accepted-completion flows. Name the test for the protected behavior: previous controls are hidden during generation and restored only after resolution.

- [x] **Step 2: Run the focused test to verify it fails**

Run: `pnpm vitest run tests/unit/story-player-ui.test.ts`

Expected: FAIL because the Story Player does not yet define or invoke `renderTurnInput()` for the transactional lifecycle.

- [x] **Step 3: Write the minimal implementation**

In `apps/web/public/story.js`, add `renderTurnInput()` adjacent to `renderChoices()`. It must derive visibility from `state.generationDisplayActive`, hide the choices area and the input controls while true, and otherwise render choices for the current accepted turn. Invoke it from `beginGenerationDisplay()`, `restoreGenerationDisplay()`, and after the authoritative accepted turn is loaded in `finalizeCompletedGeneration()`.

- [x] **Step 4: Run the focused test to verify it passes**

Run: `pnpm vitest run tests/unit/story-player-ui.test.ts`

Expected: PASS with no Story Player UI test failures.

- [x] **Step 5: Run focused quality checks**

Run: `pnpm check` and `git diff --check`

Expected: both commands exit 0.
