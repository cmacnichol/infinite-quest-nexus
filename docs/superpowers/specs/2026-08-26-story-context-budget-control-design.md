# Story Context Budget Control Design

## Decision

Add a persistent browser-side **Story context** preference to both active Story Player UIs. The preference selects an upper target for the context assembled for future story generations. It reuses the existing `generationRequestSchema.context.budgetTokens` field and therefore requires no API, database, migration, provider-adapter, or runtime change.

The active legacy surface is `apps/web/public/story.html` with `apps/web/src/story.js`. The replacement surface is `apps/web-next`. The historical root `index.html` remains out of scope.

## Why this is a client-only change

The complete request path already supports the feature:

- `packages/contracts/src/generation.ts` accepts `context.budgetTokens` from 512 through 1,000,000 tokens and defaults it to 32,000.
- `services/api/src/server.ts` validates that same request for append and retry-latest generation routes.
- `packages/database/src/generation-repository.ts` snapshots the request context in `generation_jobs.context_options`, so queued work and durable retries remain reproducible without a schema migration.
- `services/runtime/src/generation-executor-adapter.ts` caps the requested budget against the selected provider/model context window, reserves `maxOutputTokens`, preserves a fixed prompt envelope, and trims optional Chronicle entries when the assembled prompt is still too large.
- `packages/story-engine/src/providers.ts` receives the already-assembled prompt. Provider payloads do not need a new context-window parameter.

Both Story clients currently hard-code the same 32,000-token request value. The missing seam is client preference and propagation, not backend capability.

This conclusion is bounded by the existing 1,000,000-token contract maximum. Supporting a provider window above 1,000,000 tokens would be a separate contract/runtime review, not part of this focused change.

## User experience

### Control and values

Render a compact labelled select named **Story context** with these values:

| Stored value | Label |
| ---: | --- |
| 32,000 | Standard · 32K |
| 64,000 | Expanded · 64K |
| 128,000 | Large · 128K |
| 256,000 | Very large · 256K |
| 1,000,000 | Maximum available · up to 1M |

The help text or control title must state that this is an upper target: the Story Engine reserves output and protocol space and never exceeds the provider/model window. The UI must not promise that every selected token will be filled or sent.

The default remains 32,000, preserving current behavior for existing users and browsers without a stored preference.

### Persistence and sharing

Use one same-origin `localStorage` key owned by `@infinite-quest/client-core`:

```text
infinite-quest.story.context-budget-tokens
```

The choice is a sticky browser preference, not a campaign setting and not a one-shot turn override. A selection made in either UI is visible to the other UI after navigation or reload because both surfaces share the same origin and storage key.

Missing, malformed, unsupported, or inaccessible storage falls back to 32,000 without blocking Story Player startup or submission. Saving the preference must likewise tolerate storage denial while keeping the in-memory selection usable for the current page.

### Placement and behavior

This is an Operate-mode refinement, not a redesign:

- In web-next, place the select in the composer control row near the existing input-mode control, visually subordinate to the turn text area and **Continue** action.
- In legacy Story, place the select beside the existing input-mode field. Mirror the same value in the retry dialog so a user can adjust context while editing a replacement prompt.
- Use a native labelled `select`, preserve visible focus, provide at least a 44px compact-screen target, and recompose it as a complete control rather than squeezing it into the input-mode button group.
- Disable the control while the relevant generation submission is in flight, consistent with the surrounding composer controls.
- Do not show a separate selector in the empty-campaign **Begin Story** panel. Beginning a story still uses the stored preference, but there is no accepted history to retrieve and duplicating the control would add noise.

The replacement Story Player's **Retry latest** flow restores the prompt to the main composer, so the main control applies. The campaign editor also has a retry-latest action; it must read the same stored preference before constructing its request so that it does not silently fall back to the old hard-coded 32K value.

## Shared client interface

Add a small deep module at `packages/client-core/src/story-context-budget.ts` and export it from `packages/client-core/src/index.ts`:

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

Use a structural storage port rather than the DOM `Storage` type because `@infinite-quest/client-core` intentionally compiles against `ES2023` without DOM libraries. Derive the 1,000,000 limit from the contracts package's exported memory-context maximum if doing so keeps the preset tuple's literal type intact; otherwise guard equality with a unit test so the UI maximum cannot drift from the accepted contract.

Normalization accepts only the five supported preset values. It does not round arbitrary numbers or expose a free-form token field. The API continues to accept other valid values for non-UI callers.

## Submission lifecycle

The chosen budget is resolved at the client submission seam and included in every new generation request:

```text
browser preference
  -> Story UI state
  -> prepared append or replacement submission
  -> existing request.context.budgetTokens
  -> durable generation_jobs.context_options snapshot
  -> runtime provider-window and output-reserve clamp
```

Web-next adds `contextBudgetTokens` to `StoryUiState` and to the prepared `StoryGenerationSubmission`. `story-player-generation.ts` builds the request with the submitted value while leaving `compression: "auto"` and `recentTurns: 8` unchanged. Capturing the value in the prepared submission preserves it through Auto classification, ambiguous confirmation, generated-choice composition, an enqueue failure, and a replacement request.

Legacy Story keeps the same value in page state. `runGeneration()` uses an explicitly supplied value when present and otherwise snapshots `state.contextBudgetTokens` before constructing the request. The main and retry selectors update the same state and storage preference.

An already-enqueued durable job always retains its snapshotted budget. Retrying that job through the durable retry mechanism does not reread browser storage. Creating a new retry-latest replacement request uses the currently selected preference. This distinction preserves reproducibility while still allowing the user to change context for a new replacement.

The preference remains selected after success or failure. It is intentionally not reset after a turn because it describes the user's desired Story context policy, not transient turn content.

## Scope boundaries

Included:

- shared preset, normalization, and safe storage logic;
- web-next Story composer state, rendering, and append/replacement request propagation;
- web-next campaign editor retry-latest request propagation;
- legacy Story composer and retry-dialog rendering, synchronization, and request propagation;
- focused unit, DOM, request-shape, documentation, build, and rendered smoke verification.

Excluded:

- changes to API schemas, routes, generated clients, database migrations, repositories, worker execution, or provider adapters;
- changes to provider discovery or the configured model context-window value;
- campaign-owned persistence, export/import, or synchronization of the preference across browsers;
- a free-form token input, automatic provider-specific preset filtering, or a separate compression/recent-turn control;
- changes to Chronicle preview settings in Campaign Management;
- changes to the historical root `index.html` or unrelated UI styling.

## Failure and edge states

- No stored value: render 32K and submit 32,000.
- Unsupported or malformed stored value: render 32K; do not rewrite storage until the user chooses a value.
- Storage access throws: continue with 32K on load or the selected in-memory value on save.
- Provider/model window is smaller than the selected value: submit the selected budget; runtime clamps safely.
- Fixed authority plus output reserve cannot fit: preserve the existing generation error; do not mask it in the client.
- Provider/model window is larger than 1M: expose no unsupported value; 1M remains the existing application maximum.
- Auto input classification or confirmation intervenes: preserve the prepared budget through the eventual submission.
- Submission fails before durable attachment: keep the selection and allow retry.
- Page reload or navigation between UI versions: reload the shared preference.

## Verification and acceptance

Automated tests must prove:

1. the shared module accepts every preset, rejects unsupported/malformed values to 32K, safely loads/saves, and matches the contract maximum;
2. web-next restores and persists the preference, renders an accessible selector, and attaches the selected value to append and retry-latest requests without changing `compression` or `recentTurns`;
3. web-next preserves the selected value through direct, Auto/confirmation, generated-choice, and failed-submission lifecycles;
4. the campaign editor retry-latest action reads the shared preference;
5. legacy Story renders synchronized main/retry selectors, restores and persists the preference, disables it while busy, and forwards the value through direct, Auto, and replacement requests;
6. existing pending-submission serialization preserves the chosen request context; and
7. the unchanged generation schema still accepts 32K through 1M and rejects values above its maximum.

Rendered smoke verification must cover both active Story routes on desktop and compact widths, keyboard labeling/focus, switching the preference between surfaces, direct and Auto submission, retry latest, reload persistence, and inspection of the outbound request body's `context.budgetTokens`. If a disposable configured provider is available, select a budget larger than its window and confirm the completed generation diagnostics report a clamped effective budget. If no safe provider-backed campaign is available, record that runtime clamp behavior is source/unit verified rather than claiming live provider proof.

## Alternatives rejected

### Server-side campaign setting

This would require a new campaign contract, persistence field or metadata shape, import/export behavior, and both UI editors. The request already carries the budget durably, so server-owned preference persistence is disproportionate to the requested control.

### Provider-profile default

Context use is a Story composition preference, while provider profiles describe endpoint/model capability. Binding the two would make campaign behavior change indirectly when profiles are switched and would confuse a desired prompt budget with the provider's hard maximum.

### Fully dynamic “use entire provider window” only

The existing runtime already clamps dynamically. Users need control over how much retrieval and history the application attempts to assemble, including the ability to avoid the latency and prompt cost of always using the maximum. Explicit presets plus a maximum option provide both controls.
