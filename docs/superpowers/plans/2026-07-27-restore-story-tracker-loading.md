# Restore Story Tracker Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore story and campaign loading for persisted trackers that lack IDs while ensuring every newly persisted runtime tracker receives a stable, unique ID.

**Architecture:** Add one pure domain canonicalizer for legacy and current tracker shapes, use it at the runtime-state read boundary so existing current and historical snapshots remain readable, and apply the same canonicalizer before every in-scope campaign-state write. Keep the strict API contract requiring tracker IDs because the Story editor uses IDs for stable row identity and removal; compatibility belongs at persistence boundaries, not in the browser contract.

**Tech Stack:** Node.js 22.13+, TypeScript 7, Zod 4, Fastify 5, PostgreSQL, Vitest 4, vanilla JavaScript

## Global Constraints

- Use **Infinite Quest Nexus** for the platform and **Infinite Quest** for the player-facing story experience.
- Keep `campaignTrackerSchema.id` required and non-empty.
- Preserve valid existing tracker IDs exactly.
- Produce deterministic fallback IDs for ID-less persisted trackers so repeated current and historical reads return the same identity.
- Produce unique IDs when names or supplied IDs collide.
- Preserve the legacy field aliases `label`, `title`, `currentValue`, and `updateRules`.
- Do not rewrite accepted turns or historical snapshots merely to make them readable.
- Do not add a database migration; tolerant reads restore existing data, and subsequent writes persist canonical trackers.
- Keep owner, campaign, world-version, and turn-cutoff isolation unchanged.
- Keep the legacy `index.html` untouched.
- Use two-space indentation.
- Every behavioral change requires a failing test first, observed for the expected reason.
- PostgreSQL tests skipped because `TEST_DATABASE_URL` is absent are unverified, not passed.
- Run `git diff --check` and review the complete diff before every commit.

---

## File and interface map

### New files

- `packages/domain/src/campaign-trackers.ts` — pure normalization for tracker arrays and tracker-bearing campaign-state snapshots.
- `tests/unit/campaign-trackers.test.ts` — deterministic ID, alias, collision, malformed-input, and immutability tests.

### Modified files

- `packages/domain/src/index.ts` — exports the tracker canonicalization functions.
- `services/api/src/campaign-state-service.ts` — canonicalizes trackers before strict runtime-state parsing.
- `services/api/src/world-service.ts` — canonicalizes world and selected-character starting trackers before creating campaign state.
- `services/api/src/import-service.ts` — canonicalizes current and historical trackers during legacy and portable imports.
- `services/api/src/campaign-transfer-service.ts` — canonicalizes the transferred campaign's materialized tracker state.
- `services/api/src/generation-service.ts` — canonicalizes merged tracker output before storing a turn snapshot and materialized campaign state.
- `tests/integration/campaign-state-corrections.integration.test.ts` — proves current and historical ID-less tracker state loads.
- `tests/integration/world-library.integration.test.ts` — proves campaign creation persists canonical tracker IDs.
- `tests/integration/import-memory.integration.test.ts` — proves legacy import canonicalizes current and turn-snapshot trackers.
- `tests/integration/campaign-transfer.integration.test.ts` — proves transferring an old ID-less campaign produces loadable materialized state.
- `tests/integration/generation.integration.test.ts` — proves a generated turn canonicalizes an ID-less tracker base before persistence.
- `docs/architecture/0011-editable-campaign-runtime-state.md` — records strict external IDs and tolerant persistence compatibility.

### Core interfaces

```ts
import type { CampaignTracker } from "../../contracts/src/generation.js";

export function normalizeCampaignTrackers(value: unknown): CampaignTracker[];

export function normalizeCampaignStateSnapshot(
  value: unknown
): Record<string, unknown>;
```

`normalizeCampaignTrackers` has these exact semantics:

1. Non-arrays return `[]`.
2. Non-object array entries and entries without a usable `name`, `label`, or `title` are discarded.
3. `name`, `value`, and `rules` use the same maximum lengths as `campaignTrackerSchema`.
4. `value` falls back to `currentValue`; `rules` falls back to `updateRules`.
5. A non-empty supplied `id` is preserved after trimming and truncation.
6. A missing ID falls back to the original `name`, then to the normalized display name, then to `tracker-${index + 1}`.
7. A collision receives `-2`, `-3`, and so on while remaining within 200 characters.
8. Inputs are never mutated.

`normalizeCampaignStateSnapshot` shallow-copies an object snapshot and replaces only its `trackers` property with `normalizeCampaignTrackers(source.trackers)`. Non-object input becomes `{ trackers: [] }`.

---

### Task 1: Add the pure tracker canonicalizer

**Files:**
- Create: `packages/domain/src/campaign-trackers.ts`
- Create: `tests/unit/campaign-trackers.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Produces: `normalizeCampaignTrackers(value: unknown): CampaignTracker[]`
- Produces: `normalizeCampaignStateSnapshot(value: unknown): Record<string, unknown>`
- Consumed by: Tasks 2 and 3.

- [ ] **Step 1: Write failing canonicalization tests**

Create `tests/unit/campaign-trackers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  normalizeCampaignStateSnapshot,
  normalizeCampaignTrackers
} from "../../packages/domain/src/campaign-trackers.js";

describe("campaign tracker normalization", () => {
  it("assigns deterministic IDs to legacy trackers and preserves aliases", () => {
    const input = [
      { name: "Keeper trust", value: "wary", rules: "Update after honest exchanges." },
      { label: "Moon gate", currentValue: "sealed", updateRules: "Change when the lens is lit." }
    ];

    expect(normalizeCampaignTrackers(input)).toEqual([
      {
        id: "Keeper trust",
        name: "Keeper trust",
        value: "wary",
        rules: "Update after honest exchanges."
      },
      {
        id: "Moon gate",
        name: "Moon gate",
        value: "sealed",
        rules: "Change when the lens is lit."
      }
    ]);
    expect(normalizeCampaignTrackers(input)).toEqual(normalizeCampaignTrackers(input));
    expect(input).toEqual([
      { name: "Keeper trust", value: "wary", rules: "Update after honest exchanges." },
      { label: "Moon gate", currentValue: "sealed", updateRules: "Change when the lens is lit." }
    ]);
  });

  it("preserves valid IDs and resolves collisions deterministically", () => {
    expect(normalizeCampaignTrackers([
      { id: "trust", name: "First", value: "", rules: "" },
      { id: "trust", name: "Second", value: "", rules: "" },
      { name: "First", value: "", rules: "" },
      { name: "First", value: "", rules: "" }
    ]).map((tracker) => tracker.id)).toEqual([
      "trust",
      "trust-2",
      "First",
      "First-2"
    ]);
  });

  it("drops malformed rows and enforces contract lengths", () => {
    const trackers = normalizeCampaignTrackers([
      null,
      "not an object",
      { value: "missing a name" },
      {
        id: ` id ${"x".repeat(250)} `,
        title: ` title ${"y".repeat(350)} `,
        value: "v".repeat(10_050),
        rules: "r".repeat(4_050)
      }
    ]);

    expect(trackers).toHaveLength(1);
    expect(trackers[0]).toMatchObject({
      id: expect.any(String),
      name: expect.any(String),
      value: expect.any(String),
      rules: expect.any(String)
    });
    expect(trackers[0]?.id).toHaveLength(200);
    expect(trackers[0]?.name).toHaveLength(300);
    expect(trackers[0]?.value).toHaveLength(10_000);
    expect(trackers[0]?.rules).toHaveLength(4_000);
  });

  it("normalizes only the tracker field in a state snapshot", () => {
    const snapshot = normalizeCampaignStateSnapshot({
      scratchpad: "Keep this.",
      continuitySummary: "Keep this too.",
      trackers: [{ name: "Keeper trust" }]
    });

    expect(snapshot).toEqual({
      scratchpad: "Keep this.",
      continuitySummary: "Keep this too.",
      trackers: [{
        id: "Keeper trust",
        name: "Keeper trust",
        value: "",
        rules: ""
      }]
    });
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

```powershell
pnpm exec vitest run tests/unit/campaign-trackers.test.ts
```

Expected: FAIL because `packages/domain/src/campaign-trackers.ts` does not exist.

- [ ] **Step 3: Implement the minimal canonicalizer**

Create `packages/domain/src/campaign-trackers.ts`:

```ts
import type { CampaignTracker } from "../../contracts/src/generation.js";

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, maximumLength: number): string {
  return String(value ?? "").trim().slice(0, maximumLength);
}

function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const marker = `-${suffix}`;
    const candidate = `${base.slice(0, 200 - marker.length)}${marker}`;
    if (!used.has(candidate)) return candidate;
  }
}

export function normalizeCampaignTrackers(value: unknown): CampaignTracker[] {
  if (!Array.isArray(value)) return [];
  const used = new Set<string>();
  return value.flatMap((entry, index) => {
    const source = objectValue(entry);
    const name = text(source.name || source.label || source.title, 300);
    if (!name) return [];
    const baseId = text(source.id || source.name || name || `tracker-${index + 1}`, 200)
      || `tracker-${index + 1}`;
    const id = uniqueId(baseId, used);
    used.add(id);
    return [{
      id,
      name,
      value: String(source.value ?? source.currentValue ?? "").slice(0, 10_000),
      rules: String(source.rules ?? source.updateRules ?? "").slice(0, 4_000)
    }];
  });
}

export function normalizeCampaignStateSnapshot(value: unknown): Record<string, unknown> {
  const source = objectValue(value);
  return {
    ...source,
    trackers: normalizeCampaignTrackers(source.trackers)
  };
}
```

Add to `packages/domain/src/index.ts`:

```ts
export * from "./campaign-trackers.js";
```

- [ ] **Step 4: Run the focused tests and type check**

```powershell
pnpm exec vitest run tests/unit/campaign-trackers.test.ts tests/unit/campaign-state-contract.test.ts
pnpm check
```

Expected: PASS.

- [ ] **Step 5: Commit the canonicalizer**

```powershell
git add packages/domain/src/campaign-trackers.ts packages/domain/src/index.ts tests/unit/campaign-trackers.test.ts
git diff --cached --check
git commit -m "Normalize campaign tracker identities"
```

---

### Task 2: Restore tolerant current and historical state reads

**Files:**
- Modify: `services/api/src/campaign-state-service.ts:1-56`
- Modify: `tests/integration/campaign-state-corrections.integration.test.ts`

**Interfaces:**
- Consumes: `normalizeCampaignTrackers(...)` from Task 1.
- Produces: strict `CampaignRuntimeStateContent` from legacy or current persisted tracker JSON.
- Guarantees: `GET /api/v1/campaigns/:campaignId/state` remains compatible with ID-less current state, turn snapshots, and state-edit snapshots.

- [ ] **Step 1: Write the failing PostgreSQL regression**

Add this test to `tests/integration/campaign-state-corrections.integration.test.ts`:

```ts
it("loads current and historical state whose persisted trackers predate tracker IDs", async () => {
  const imported = await campaign();
  const legacyTrackers = [
    { name: "Keeper trust", value: "wary", rules: "Update after honest exchanges." },
    { label: "Moon gate", currentValue: "sealed", updateRules: "Change when the lens is lit." }
  ];
  await pool.query(
    `UPDATE campaign_state
        SET trackers = $2::jsonb,
            initial_state_snapshot = jsonb_set(initial_state_snapshot, '{trackers}', $2::jsonb)
      WHERE campaign_id = $1`,
    [imported.campaignId, JSON.stringify(legacyTrackers)]
  );
  await pool.query(
    `UPDATE turns
        SET state_snapshot_private = jsonb_set(state_snapshot_private, '{trackers}', $2::jsonb)
      WHERE campaign_id = $1 AND turn_number = 1`,
    [imported.campaignId, JSON.stringify(legacyTrackers)]
  );

  const current = await getCampaignRuntimeState(pool, imported.campaignId);
  const historical = await getCampaignRuntimeState(pool, imported.campaignId, 1);

  expect(current.trackers).toEqual([
    expect.objectContaining({ id: "Keeper trust", name: "Keeper trust" }),
    expect.objectContaining({ id: "Moon gate", name: "Moon gate" })
  ]);
  expect(historical.trackers).toEqual(current.trackers);
});
```

- [ ] **Step 2: Run the integration test and verify RED**

```powershell
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/campaign-state-corrections.integration.test.ts -t "predate tracker IDs"
```

Expected: FAIL with Zod issues at `trackers.0.id` and `trackers.1.id`, matching correlation ID `8829c098-2a46-40e6-8bad-d13d8e0d3de5`. If `TEST_DATABASE_URL` is absent, record RED as unverified and do not claim the failure executed.

- [ ] **Step 3: Restore compatibility before strict parsing**

In `services/api/src/campaign-state-service.ts`, import:

```ts
import { normalizeCampaignTrackers } from "../../../packages/domain/src/campaign-trackers.js";
```

Change only the tracker projection inside `runtimeStateContent`:

```ts
return campaignRuntimeStateContentSchema.parse({
  continuitySummary: typeof source.continuitySummary === "string" ? source.continuitySummary : "",
  openThreads: strings(source.openThreads),
  canonicalFacts: canonicalFacts.length ? canonicalFacts : legacyFacts,
  scratchpad: typeof source.scratchpad === "string" ? source.scratchpad : "",
  trackers: normalizeCampaignTrackers(source.trackers),
  rpgStats: Array.isArray(source.rpgStats) ? source.rpgStats : [],
  eventTriggers: Array.isArray(source.eventTriggers) ? source.eventTriggers : [],
  pendingEventTriggers: Array.isArray(source.pendingEventTriggers) ? source.pendingEventTriggers : []
});
```

Do not make `campaignTrackerSchema.id` optional and do not add browser-side fallback IDs.

- [ ] **Step 4: Run current, historical, contract, and Story UI tests**

```powershell
pnpm exec vitest run tests/unit/campaign-trackers.test.ts tests/unit/campaign-state-contract.test.ts tests/unit/story-player-ui.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/campaign-state-corrections.integration.test.ts
pnpm check
```

Expected: all unit tests PASS and the PostgreSQL file PASS with the test executed.

- [ ] **Step 5: Commit the read compatibility fix**

```powershell
git add services/api/src/campaign-state-service.ts tests/integration/campaign-state-corrections.integration.test.ts
git diff --cached --check
git commit -m "Restore legacy tracker state loading"
```

---

### Task 3: Canonicalize tracker IDs before persistence

**Files:**
- Modify: `services/api/src/world-service.ts:547-595`
- Modify: `services/api/src/import-service.ts:697-728,744-756,1015-1040`
- Modify: `services/api/src/campaign-transfer-service.ts:250-280`
- Modify: `services/api/src/generation-service.ts:1160-1168,1337-1406`
- Modify: `tests/integration/world-library.integration.test.ts`
- Modify: `tests/integration/import-memory.integration.test.ts`
- Modify: `tests/integration/campaign-transfer.integration.test.ts`
- Modify: `tests/integration/generation.integration.test.ts`

**Interfaces:**
- Consumes: both canonicalization functions from Task 1.
- Produces: canonical tracker arrays in new campaign state, imports, transfers, generated turns, and materialized state.
- Guarantees: new writes no longer depend on tolerant read repair.

- [ ] **Step 1: Add failing campaign-creation and import assertions**

In `tests/integration/world-library.integration.test.ts`, create a published world whose selected character has:

```ts
defaultTriggers: [
  { name: "Keeper trust", value: "wary", rules: "Update after honest exchanges." },
  { name: "Keeper trust", value: "unknown", rules: "A duplicate name must remain independently editable." }
]
```

After `createCampaign`, query `campaign_state.trackers` and assert:

```ts
expect(state.rows[0]?.trackers).toEqual([
  expect.objectContaining({ id: "Keeper trust", name: "Keeper trust" }),
  expect.objectContaining({ id: "Keeper trust-2", name: "Keeper trust" })
]);
```

In `tests/integration/import-memory.integration.test.ts`, set both top-level `trackers` and `turns[0].trackersSnapshot` to:

```ts
[{ name: "Imported clue", value: "hidden", rules: "Update when discovered." }]
```

Assert both `campaign_state.trackers` and turn 1 `state_snapshot_private.trackers` contain `id: "Imported clue"`.

- [ ] **Step 2: Add failing transfer and generation assertions**

In `tests/integration/campaign-transfer.integration.test.ts`, update the source campaign's materialized trackers to:

```ts
[{ name: "Transferred oath", value: "unbroken", rules: "Update when tested." }]
```

Transfer it and assert the target `campaign_state.trackers` contains `id: "Transferred oath"`.

In `tests/integration/generation.integration.test.ts`, seed the source campaign with:

```ts
[{ name: "Generated clue", value: "hidden", rules: "Update when revealed." }]
```

Commit a deterministic generated turn with no tracker update and assert both the inserted turn snapshot and `campaign_state.trackers` contain `id: "Generated clue"`.

- [ ] **Step 3: Run the four focused tests and verify RED**

```powershell
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/world-library.integration.test.ts tests/integration/import-memory.integration.test.ts tests/integration/campaign-transfer.integration.test.ts tests/integration/generation.integration.test.ts
```

Expected: the new assertions FAIL because these paths preserve ID-less tracker objects. If `TEST_DATABASE_URL` is absent, report RED as unverified.

- [ ] **Step 4: Canonicalize new World Library campaign state**

Import `normalizeCampaignTrackers` in `world-service.ts` and replace the starting tracker selection with:

```ts
const defaultTrackers = normalizeCampaignTrackers(seed.defaultTriggers);
const initialTrackers = normalizeCampaignTrackers(
  Array.isArray(content.defaults?.trackers) && content.defaults.trackers.length
    ? content.defaults.trackers
    : defaultTrackers
);
```

Persist `defaultTrackers` in `default_triggers`, `initialTrackers` in `trackers`, and `initialTrackers` in `initial_state_snapshot.trackers`.

- [ ] **Step 5: Canonicalize legacy and portable imports**

Import both helpers in `import-service.ts`.

For legacy imports, replace the raw assignments with:

```ts
const initialTrackers = normalizeCampaignTrackers(request.story.trackers ?? []);
const defaultTriggers = normalizeCampaignTrackers(
  request.story.defaultTriggers ?? request.story.baseTrackersAtStart ?? []
);
```

Normalize every imported turn snapshot:

```ts
const rawStateSnapshot = typeof turn.worldStateSnapshot === "object" && turn.worldStateSnapshot !== null
  ? turn.worldStateSnapshot
  : { scratchpad: turn.scratchpadSnapshot ?? "", trackers: turn.trackersSnapshot ?? [] };
const stateSnapshot = normalizeCampaignStateSnapshot(rawStateSnapshot);
```

For portable archives, calculate:

```ts
const importedTrackers = normalizeCampaignTrackers(archive.campaign.trackers);
const importedDefaultTriggers = normalizeCampaignTrackers(archive.campaign.defaultTriggers);
const importedInitialSnapshot = normalizeCampaignStateSnapshot({
  scratchpad: "",
  trackers: archive.campaign.baseTrackersAtStart ?? []
});
```

Use those three values in the `campaign_state` insert. Pass every `turn.worldStateSnapshot` through `normalizeCampaignStateSnapshot` before its turn insert. When importing `campaign_state_edits`, normalize each `state_snapshot_private` in application code before insertion rather than using an untransformed `INSERT ... SELECT`.

- [ ] **Step 6: Canonicalize transfers and generated turns**

In `campaign-transfer-service.ts`, canonicalize `source.trackers` and `source.initial_state_snapshot` before the target `campaign_state` insert:

```ts
const transferredTrackers = normalizeCampaignTrackers(source.trackers);
const transferredInitialSnapshot = normalizeCampaignStateSnapshot(source.initial_state_snapshot);
```

Keep copied accepted turns and edit rows append-only; Task 2's read boundary supplies compatibility for their historical snapshots.

In `generation-service.ts`, make `mergedTrackers` return the strict canonical type:

```ts
function mergedTrackers(current: unknown, updates: Array<Record<string, unknown>>): CampaignTracker[] {
  const existing = Array.isArray(current)
    ? current.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    : [];
  const map = new Map(existing.map((item, index) => [String(item.id || item.name || index), item]));
  for (const update of updates) {
    const key = String(update.id || update.name || crypto.randomUUID());
    map.set(key, { ...(map.get(key) || {}), ...update });
  }
  return normalizeCampaignTrackers([...map.values()]);
}
```

Import `CampaignTracker` from the contracts package and `normalizeCampaignTrackers` from the domain package. The existing turn snapshot and materialized-state writes then persist the same canonical `trackers` value.

- [ ] **Step 7: Run boundary and regression verification**

```powershell
pnpm exec vitest run tests/unit/campaign-trackers.test.ts tests/unit/campaign-state-contract.test.ts tests/unit/story-player-ui.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/campaign-state-corrections.integration.test.ts tests/integration/world-library.integration.test.ts tests/integration/import-memory.integration.test.ts tests/integration/campaign-transfer.integration.test.ts tests/integration/generation.integration.test.ts
pnpm check
```

Expected: PASS with all PostgreSQL files executed.

- [ ] **Step 8: Commit persistence-boundary canonicalization**

```powershell
git add services/api/src/world-service.ts services/api/src/import-service.ts services/api/src/campaign-transfer-service.ts services/api/src/generation-service.ts tests/integration/world-library.integration.test.ts tests/integration/import-memory.integration.test.ts tests/integration/campaign-transfer.integration.test.ts tests/integration/generation.integration.test.ts
git diff --cached --check
git commit -m "Persist canonical campaign tracker IDs"
```

---

### Task 4: Document and completely verify the compatibility contract

**Files:**
- Modify: `docs/architecture/0011-editable-campaign-runtime-state.md`

**Interfaces:**
- Consumes: completed Tasks 1–3.
- Produces: documented persistence compatibility and a fully reviewed change.

- [ ] **Step 1: Document the tracker identity boundary**

Add a “Tracker identity compatibility” section to `docs/architecture/0011-editable-campaign-runtime-state.md` containing these decisions:

```markdown
## Tracker identity compatibility

The browser/API runtime-state contract requires every tracker to have a
non-empty stable `id`; the Story editor uses that ID for row identity and
removal. Older worlds, character-generation output, portable imports, and
accepted snapshots may contain tracker-shaped objects without IDs.

The API canonicalizes those persisted shapes before strict runtime-state
validation. Valid IDs are preserved, missing IDs receive deterministic
fallbacks, and collisions receive deterministic suffixes. Campaign creation,
imports, transfers, and turn commits apply the same canonicalization before
new writes. Accepted turns are not rewritten solely for compatibility.
```

- [ ] **Step 2: Run repository, unit, and build verification**

```powershell
pnpm check
pnpm test:unit
pnpm build
```

Expected: PASS with no skipped unit tests.

- [ ] **Step 3: Run complete PostgreSQL verification**

With `TEST_DATABASE_URL` pointing to a disposable compatible database:

```powershell
pnpm test:integration
```

Expected: PASS with the integration tests executed. If database access is absent, report integration status as unverified and do not call the implementation complete.

- [ ] **Step 4: Manually verify the Story view**

Run the documented local stack and verify:

1. Open the campaign that produced correlation ID `8829c098-2a46-40e6-8bad-d13d8e0d3de5`.
2. Confirm the story, accepted turns, choices, and status bar render.
3. Open Edit State and confirm both formerly ID-less trackers render independently.
4. Remove one tracker, save, reopen Edit State, and confirm only the selected tracker was removed.
5. Navigate to an earlier turn containing ID-less tracker history and confirm its read-only state renders.
6. Generate one new turn and confirm reloading the page returns the same tracker IDs.

- [ ] **Step 5: Review the complete diff and repository risk**

```powershell
rg -n "normalizeCampaignTrackers|normalizeCampaignStateSnapshot|campaignTrackerSchema" packages services tests docs
git diff --check
git status --short
git diff --stat
git diff
```

Confirm:

- no API schema was loosened;
- no accepted-turn update or migration was introduced;
- every new tracker write uses the shared canonicalizer;
- no owner/campaign predicate changed;
- no unrelated `index.html` or provider change exists.

Run Repowise risk review with the complete changed-file list and health review for:

```text
packages/domain/src/campaign-trackers.ts
services/api/src/campaign-state-service.ts
services/api/src/world-service.ts
services/api/src/import-service.ts
services/api/src/campaign-transfer-service.ts
services/api/src/generation-service.ts
```

Address any reported missing co-change or missing-test requirement before completion.

- [ ] **Step 6: Commit the architecture note**

```powershell
git add docs/architecture/0011-editable-campaign-runtime-state.md
git diff --cached --check
git commit -m "Document tracker identity compatibility"
```

- [ ] **Step 7: Transition to branch completion**

Invoke `superpowers:requesting-code-review`, resolve actionable findings with failing regressions first, rerun Task 4 verification, and then invoke `superpowers:finishing-a-development-branch`. Do not push or create a pull request without explicit user direction.
