# Full Edit State Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Story view Edit State field editable and atomically persist an append-only correction that remains effective for future turns and latest-turn regeneration.

**Architecture:** Expand the runtime-state contract to one complete typed snapshot, persist each save as an immutable `campaign_state_edits` revision, and treat `campaign_state` plus Chronicle records as rebuildable materializations. Durable latest-turn replacements snapshot the active correction, use it as their private state override, preserve it on failure, and reapply it after successful replacement.

**Tech Stack:** Node.js 22.13+, TypeScript 7, Zod 4, Fastify 5, PostgreSQL with pgvector, Vitest 4, Happy DOM, vanilla JavaScript

## Global Constraints

- Use **Infinite Quest Nexus** for the platform and **Infinite Quest** for the player-facing story experience.
- Accepted turns and accepted-turn state snapshots remain unchanged by manual state edits.
- Every manual save is an append-only, owner-scoped `campaign_state_edits` revision.
- One modal save is atomic across continuity summary, open threads, canonical facts, scratchpad, trackers, RPG statistics, event triggers, and pending triggers.
- Corrected state applies to the next appended turn and to regeneration of the existing latest turn.
- A replacement failure preserves both the original accepted turn and the active correction.
- A replacement success preserves the correction as the effective overlay at the replacement turn.
- Chronicle memories, canonical-fact projections, embeddings, and `campaign_state` columns remain rebuildable.
- Historical state remains read-only until rewind or branch makes it current.
- Mechanics, rolls, diagnostics, private reasoning, and credentials must not enter fiction-only fields or Chronicle content.
- Keep owner, campaign, world-version, and historical turn-cutoff isolation on every query.
- Use two-space indentation.
- Every behavioral change requires a failing test first, observed for the expected reason.
- PostgreSQL tests skipped because `TEST_DATABASE_URL` is absent are unverified, not passed.
- Run `git diff --check` and review the complete diff before every commit.

---

## File and interface map

### New files

- `database/migrations/0045_full_campaign_state_corrections.sql` — permits canonical facts sourced from state edits and snapshots active corrections on replacement jobs.
- `apps/web/public/story-state-editor.js` — focused browser helpers for rendering and collecting all Edit State fields.
- `tests/unit/campaign-state-contract.test.ts` — typed runtime-state and canonical-fact editor contract tests.
- `tests/unit/story-state-editor.test.ts` — Happy DOM behavioral tests for enabled controls and complete save payloads.
- `tests/integration/campaign-state-corrections.integration.test.ts` — real-PostgreSQL state-edit, Chronicle, rewind, branch, and regeneration coverage.
- `docs/architecture/0028-append-only-runtime-state-corrections.md` — architecture decision covering full corrections and replacement behavior.

### Modified files

- `package.json`, `pnpm-lock.yaml` — add Happy DOM as a test-only dependency.
- `packages/contracts/src/generation.ts` — define the complete typed runtime-state content contract.
- `services/api/src/campaign-state-service.ts` — resolve effective state and save complete append-only corrections.
- `services/api/src/memory-service.ts` — project and rebuild corrected summaries, threads, and canonical facts.
- `services/api/src/generation-service.ts` — capture, consume, preserve, and reapply active corrections during replacement.
- `apps/web/public/story.html` — replace read-only projections with editable controls and load the focused editor helper.
- `apps/web/public/story.js` — populate, validate, collect, and submit every state field.
- `apps/web/public/story.css` — responsive structured editors and validation styling.
- `tests/unit/story-player-ui.test.ts` — static UI/CSP contracts for the new editor surface.
- `tests/unit/csp-ui.test.ts` — include the new active browser script.
- `tests/integration/generation.integration.test.ts` — retain existing replacement coverage while asserting correction snapshot metadata.
- `tests/integration/migrations.integration.test.ts` — verify the new constraints and indexes.
- `docs/architecture/0011-editable-campaign-runtime-state.md` — supersede the read-only projection limitation.
- `docs/architecture/0017-staged-latest-turn-replacement.md` — document correction-aware replacement.
- `docs/architecture/0018-structured-canonical-fact-projections.md` — document state-edit fact sources.
- `docs/architecture/index.md` — link the new ADR.

### Core interfaces

```ts
export const campaignCanonicalFactEditorSchema = z.object({
  id: z.uuid().nullable().default(null),
  content: z.string().trim().min(1).max(20_000)
});

export const campaignRuntimeStateContentSchema = z.object({
  continuitySummary: z.string().max(20_000),
  openThreads: z.array(z.string().trim().min(1).max(4000)).max(500),
  canonicalFacts: z.array(campaignCanonicalFactEditorSchema).max(2000),
  scratchpad: z.string().max(100_000),
  trackers: z.array(campaignTrackerSchema).max(200),
  rpgStats: z.array(playerRpgStatSchema).max(100),
  eventTriggers: z.array(playerEventTriggerSchema).max(200),
  pendingEventTriggers: z.array(pendingEventTriggerSchema).max(200)
});
```

```ts
export type EffectiveCampaignStateEdit = {
  id: string;
  revision: number;
  effectiveTurnNumber: number;
  snapshot: CampaignRuntimeStateContent;
};

export async function loadEffectiveCampaignStateEdit(
  client: DatabaseClient,
  ownerUserId: string,
  campaignId: string,
  throughTurnNumber: number
): Promise<EffectiveCampaignStateEdit | null>;

export async function projectCampaignStateCorrection(
  client: DatabaseClient,
  ownerUserId: string,
  campaignId: string,
  worldVersionId: string,
  edit: EffectiveCampaignStateEdit
): Promise<void>;
```

The browser helper exposes:

```js
globalThis.InfiniteQuestStateEditor = {
  render(root, runtimeState),
  collect(root),
  install(root, callbacks)
};
```

---

### Task 1: Complete typed runtime-state contract

**Files:**
- Create: `tests/unit/campaign-state-contract.test.ts`
- Modify: `packages/contracts/src/generation.ts:276-345`

**Interfaces:**
- Produces: `campaignCanonicalFactEditorSchema`
- Produces: `campaignRuntimeStateContentSchema`
- Produces: `CampaignRuntimeStateContent`
- Produces: complete `CampaignRuntimeStateUpdate` and `CampaignRuntimeState`
- Consumed by: Tasks 2–5.

- [ ] **Step 1: Write failing contract tests**

Create `tests/unit/campaign-state-contract.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  campaignRuntimeStateSchema,
  campaignRuntimeStateUpdateSchema
} from "../../packages/contracts/src/generation.js";

const fullState = {
  continuitySummary: "The lighthouse is open.",
  openThreads: ["Find the missing keeper."],
  canonicalFacts: [{ id: null, content: "The lens is made of moon glass." }],
  scratchpad: "The keeper is hiding below the western stair.",
  trackers: [{ id: "keeper-trust", name: "Keeper trust", value: "wary", rules: "Update after honest exchanges." }],
  rpgStats: [{ id: "resolve", name: "Resolve", value: 61, note: "Steady under pressure." }],
  eventTriggers: [{
    id: "lens-lit", label: "Lens lit", timing: "after", condition: "The lens is illuminated.",
    effect: "Reveal the sea road.", addTextAfter: true, triggeredCount: 0,
    lastTriggeredTurn: null, lastTriggeredAt: null
  }],
  pendingEventTriggers: [{
    id: "sea-road", sourceTriggerId: "lens-lit", name: "Sea road",
    timing: "after", condition: "", effect: "", instructions: "Reveal the road.",
    reason: "", sourceTurn: null
  }]
};

describe("complete campaign runtime state", () => {
  it("accepts every editable field in one update", () => {
    expect(campaignRuntimeStateUpdateSchema.parse({
      expectedTurnNumber: 4,
      expectedRevision: 7,
      ...fullState
    })).toMatchObject(fullState);
  });

  it("returns stable canonical fact IDs", () => {
    expect(campaignRuntimeStateSchema.parse({
      campaignId: "00000000-0000-4000-8000-000000000001",
      activeTurnNumber: 4,
      viewedTurnNumber: 4,
      isCurrent: true,
      revision: 7,
      updatedAt: new Date().toISOString(),
      ...fullState,
      canonicalFacts: [{
        id: "00000000-0000-4000-8000-000000000002",
        content: "The lens is made of moon glass."
      }]
    }).canonicalFacts[0]?.id).toBe("00000000-0000-4000-8000-000000000002");
  });

  it("rejects invalid nested mechanics and empty list entries", () => {
    expect(() => campaignRuntimeStateUpdateSchema.parse({
      expectedTurnNumber: 4,
      expectedRevision: 7,
      ...fullState,
      openThreads: [""],
      rpgStats: [{ id: "resolve", name: "Resolve", value: 100, note: "" }]
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

```powershell
pnpm exec vitest run tests/unit/campaign-state-contract.test.ts
```

Expected: FAIL because `campaignRuntimeStateUpdateSchema` does not accept continuity, Chronicle, or mechanics fields and canonical facts are strings.

- [ ] **Step 3: Implement the shared content schema**

In `packages/contracts/src/generation.ts`, define the two schemas from the Core interfaces section, then compose:

```ts
export const campaignRuntimeStateUpdateSchema = campaignRuntimeStateContentSchema.extend({
  expectedTurnNumber: z.coerce.number().int().min(0),
  expectedRevision: z.coerce.number().int().min(0)
});

export const campaignRuntimeStateSchema = campaignRuntimeStateContentSchema.extend({
  campaignId: z.uuid(),
  activeTurnNumber: z.coerce.number().int().min(0),
  viewedTurnNumber: z.coerce.number().int().min(0),
  isCurrent: z.boolean(),
  revision: z.coerce.number().int().min(0),
  updatedAt: z.union([z.string(), z.date()])
});

export type CampaignRuntimeStateContent = z.infer<typeof campaignRuntimeStateContentSchema>;
```

Replace the three `z.array(z.unknown())` runtime fields with their typed schemas. Do not loosen the existing tracker, statistic, or trigger limits.

- [ ] **Step 4: Run contract and dependent unit tests**

```powershell
pnpm exec vitest run tests/unit/campaign-state-contract.test.ts tests/unit/generation.test.ts tests/unit/story-player-ui.test.ts
pnpm check
```

Expected: PASS.

- [ ] **Step 5: Commit the contract**

```powershell
git add packages/contracts/src/generation.ts tests/unit/campaign-state-contract.test.ts
git diff --cached --check
git commit -m "Type complete campaign state corrections"
```

---

### Task 2: Add state-edit projection and replacement schema

**Files:**
- Create: `database/migrations/0045_full_campaign_state_corrections.sql`
- Modify: `tests/integration/migrations.integration.test.ts`

**Interfaces:**
- Produces: `generation_jobs.state_edit_id`
- Produces: `generation_jobs.state_edit_revision`
- Produces: `generation_jobs.state_edit_snapshot_private`
- Produces: `campaign_canonical_facts.source_state_edit_id`
- Consumed by: Tasks 3 and 4.

- [ ] **Step 1: Add failing migration assertions**

Extend `tests/integration/migrations.integration.test.ts`:

```ts
it("supports state-edit canonical facts and correction-aware replacement jobs", async () => {
  const columns = await pool.query(
    `SELECT table_name, column_name, is_nullable
       FROM information_schema.columns
      WHERE (table_name = 'generation_jobs' AND column_name IN (
        'state_edit_id', 'state_edit_revision', 'state_edit_snapshot_private'
      )) OR (table_name = 'campaign_canonical_facts' AND column_name IN (
        'source_turn_id', 'source_state_edit_id'
      ))
      ORDER BY table_name, column_name`
  );
  expect(columns.rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ table_name: "generation_jobs", column_name: "state_edit_id" }),
    expect.objectContaining({ table_name: "campaign_canonical_facts", column_name: "source_state_edit_id" }),
    expect.objectContaining({ table_name: "campaign_canonical_facts", column_name: "source_turn_id", is_nullable: "YES" })
  ]));
});
```

- [ ] **Step 2: Run the migration test and verify RED**

```powershell
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/migrations.integration.test.ts
```

Expected: FAIL because migration 0045 and its columns do not exist. If `TEST_DATABASE_URL` is absent, report RED as unverified and use the migration SQL review in Step 4 without claiming execution.

- [ ] **Step 3: Write the additive online migration**

Create `database/migrations/0045_full_campaign_state_corrections.sql` with:

```sql
ALTER TABLE campaign_state_edits
  ADD CONSTRAINT campaign_state_edits_owner_identity
  UNIQUE (id, campaign_id, owner_user_id);

ALTER TABLE generation_jobs
  ADD COLUMN state_edit_id uuid,
  ADD COLUMN state_edit_revision integer CHECK (state_edit_revision IS NULL OR state_edit_revision > 0),
  ADD COLUMN state_edit_snapshot_private jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT generation_jobs_state_edit_owner_fk
    FOREIGN KEY (state_edit_id, campaign_id, owner_user_id)
    REFERENCES campaign_state_edits(id, campaign_id, owner_user_id);

ALTER TABLE campaign_canonical_facts
  DROP CONSTRAINT campaign_canonical_facts_source_turn_id_campaign_id_owner_user_,
  DROP CONSTRAINT campaign_canonical_facts_campaign_id_source_turn_id_source_fact,
  DROP CONSTRAINT campaign_canonical_facts_source_turn_number_check,
  DROP CONSTRAINT campaign_canonical_facts_valid_from_turn_check,
  ALTER COLUMN source_turn_id DROP NOT NULL,
  ADD COLUMN source_state_edit_id uuid,
  ADD CONSTRAINT campaign_canonical_facts_source_turn_number_check
    CHECK (source_turn_number >= 0),
  ADD CONSTRAINT campaign_canonical_facts_valid_from_turn_check
    CHECK (valid_from_turn >= 0),
  ADD CONSTRAINT campaign_canonical_facts_source_turn_owner_fk
    FOREIGN KEY (source_turn_id, campaign_id, owner_user_id)
    REFERENCES turns(id, campaign_id, owner_user_id) ON DELETE CASCADE,
  ADD CONSTRAINT campaign_canonical_facts_source_edit_owner_fk
    FOREIGN KEY (source_state_edit_id, campaign_id, owner_user_id)
    REFERENCES campaign_state_edits(id, campaign_id, owner_user_id) ON DELETE CASCADE,
  ADD CONSTRAINT campaign_canonical_facts_exactly_one_source
    CHECK (num_nonnulls(source_turn_id, source_state_edit_id) = 1);

CREATE UNIQUE INDEX campaign_canonical_facts_turn_source_idx
  ON campaign_canonical_facts(campaign_id, source_turn_id, source_fact_index)
  WHERE source_turn_id IS NOT NULL;

CREATE UNIQUE INDEX campaign_canonical_facts_edit_source_idx
  ON campaign_canonical_facts(campaign_id, source_state_edit_id, source_fact_index)
  WHERE source_state_edit_id IS NOT NULL;
```

The first two dropped names are PostgreSQL's 63-character truncations of the
unnamed constraints created by migration 0024. Before running GREEN, prove
those names against the migrated test database:

```sql
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'campaign_canonical_facts'::regclass
ORDER BY conname;
```

If the query returns different names, replace only those two names in migration
0045 with the returned foreign-key and unique-constraint names. Do not use a
catch-all dynamic drop. The `>= 0` checks deliberately permit corrections
before the first accepted turn while preserving positive turn numbers for
accepted-turn-sourced rows through the source-turn foreign key.

- [ ] **Step 4: Verify migration syntax and schema**

```powershell
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/migrations.integration.test.ts
pnpm check
```

Expected: PASS with the PostgreSQL suite executed.

- [ ] **Step 5: Commit the migration**

```powershell
git add database/migrations/0045_full_campaign_state_corrections.sql tests/integration/migrations.integration.test.ts
git diff --cached --check
git commit -m "Add full state correction projections"
```

---

### Task 3: Persist and project complete append-only corrections

**Files:**
- Create: `tests/integration/campaign-state-corrections.integration.test.ts`
- Modify: `services/api/src/campaign-state-service.ts`
- Modify: `services/api/src/memory-service.ts`

**Interfaces:**
- Produces: `loadEffectiveCampaignStateEdit(...)`
- Produces: `projectCampaignStateCorrection(...)`
- Produces: complete `getCampaignRuntimeState(...)`
- Produces: atomic `updateCampaignRuntimeState(...)`
- Consumed by: Task 4.

- [ ] **Step 1: Write failing full-save and atomicity tests**

Create `tests/integration/campaign-state-corrections.integration.test.ts` using the repository's deterministic campaign fixture. The central test must:

```ts
const before = await getCampaignRuntimeState(pool, campaignId);
const corrected = await updateCampaignRuntimeState(pool, campaignId, {
  expectedTurnNumber: before.activeTurnNumber,
  expectedRevision: before.revision,
  continuitySummary: "The corrected lighthouse summary.",
  openThreads: ["Find the keeper."],
  canonicalFacts: [{ id: null, content: "The lens is moon glass." }],
  scratchpad: "The keeper waits below the stair.",
  trackers: [{ id: "trust", name: "Keeper trust", value: "wary", rules: "Update after honest exchanges." }],
  rpgStats: [{ id: "resolve", name: "Resolve", value: 61, note: "" }],
  eventTriggers: [],
  pendingEventTriggers: []
});

expect(corrected).toMatchObject({
  continuitySummary: "The corrected lighthouse summary.",
  openThreads: ["Find the keeper."],
  scratchpad: "The keeper waits below the stair.",
  rpgStats: [{ id: "resolve", value: 61 }]
});
expect(corrected.canonicalFacts[0]).toMatchObject({
  id: expect.any(String),
  content: "The lens is moon glass."
});
```

Also assert:

- exactly one `campaign_state_edits` row was added;
- its snapshot contains all eight content fields;
- `campaign_state` materializes scratchpad, trackers, stats, and triggers;
- the accepted turn's `state_snapshot_private` is byte-for-byte unchanged;
- an unsafe fiction field or invalid stat rejects the transaction without adding an edit;
- a no-op save does not advance revision;
- stale revision, active generation, and cross-owner access fail.

- [ ] **Step 2: Run the integration test and verify RED**

```powershell
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/campaign-state-corrections.integration.test.ts
```

Expected: FAIL because the update contract is accepted but the service still persists only scratchpad and trackers.

- [ ] **Step 3: Resolve effective state from accepted snapshots plus corrections**

In `campaign-state-service.ts`, implement:

```ts
export async function loadEffectiveCampaignStateEdit(
  client: DatabaseClient,
  ownerUserId: string,
  campaignId: string,
  throughTurnNumber: number
): Promise<EffectiveCampaignStateEdit | null> {
  const result = await client.query(
    `SELECT id, revision, effective_turn_number, state_snapshot_private
       FROM campaign_state_edits
      WHERE owner_user_id = $1 AND campaign_id = $2
        AND effective_turn_number <= $3
      ORDER BY effective_turn_number DESC, revision DESC
      LIMIT 1`,
    [ownerUserId, campaignId, throughTurnNumber]
  );
  const row = result.rows[0];
  return row ? {
    id: row.id,
    revision: row.revision,
    effectiveTurnNumber: row.effective_turn_number,
    snapshot: campaignRuntimeStateContentSchema.parse(row.state_snapshot_private)
  } : null;
}
```

For current and historical reads, start with the accepted snapshot at the requested turn. Overlay an edit only when its `effectiveTurnNumber` equals the requested turn; an edit from turn `N` must not override accepted state at `N + 1`.

Return active canonical facts from `campaign_canonical_facts` at the cutoff as `{ id, content }`, then apply the exact state-edit snapshot when one exists.

- [ ] **Step 4: Persist the complete correction transactionally**

Refactor `updateCampaignRuntimeState` to:

1. parse all content with `campaignRuntimeStateContentSchema`;
2. validate fiction-only fields with `containsMechanicsLanguage`;
3. compare against `getCampaignRuntimeState` under the same locks;
4. allocate an edit UUID before canonical-fact normalization;
5. preserve IDs for unchanged facts and derive IDs for new/edited facts;
6. insert the complete snapshot and `changed_fields`;
7. update all materialized `campaign_state` columns;
8. update turn-zero `initial_state_snapshot`;
9. call `rebuildCampaignMemories` followed by `projectCampaignStateCorrection`;
10. invalidate model chains, enqueue embedding reindex, and record a content-free event.

The fiction validation input is:

```ts
const fictionOnly = [
  request.continuitySummary,
  ...request.openThreads,
  ...request.canonicalFacts.map((fact) => fact.content),
  request.scratchpad,
  ...request.trackers.flatMap((tracker) => [tracker.name, tracker.value, tracker.rules])
];
if (fictionOnly.some(containsMechanicsLanguage)) {
  throw Object.assign(new Error(
    "Edited continuity fields must contain fiction only, without game mechanics or engine diagnostics."
  ), { statusCode: 400 });
}
```

Do not run trigger conditions, trigger effects, statistic names, or statistic notes through the fiction-only validator; their typed mechanics schemas are authoritative.

- [ ] **Step 5: Project corrected Chronicle content**

In `memory-service.ts`, export `projectCampaignStateCorrection`. It must:

- mark active accepted/manual canonical facts omitted by the corrected full set as no longer valid at the edit's turn;
- preserve unchanged active fact IDs;
- insert edited/new facts with `source_state_edit_id`, deterministic IDs, entity metadata, and manual-correction provenance;
- upsert corrected non-empty summary and open-thread memories with `turn_id IS NULL` and `metadata.stateEditId`;
- remove obsolete manual summary/thread rows when the corrected replacement is empty;
- make context construction read summary and open threads directly from the latest applicable edit so an empty correction suppresses older accepted values;
- enqueue embeddings only after relational projection succeeds.

Extend `rebuildCampaignMemories` so it projects accepted turns first and applies state edits in revision order afterward. Rebuild output must match the live correction path.

- [ ] **Step 6: Add Chronicle, rebuild, rewind, branch, and export assertions**

Extend the integration test to assert:

- corrected summary, facts, and threads appear in `buildContextPreview`;
- retired values do not appear;
- an empty summary/thread replacement does not fall back to the accepted value;
- `rebuildCampaignMemories` reproduces the same active facts;
- rewind removes corrections after the target and restores one at the target;
- branch copies applicable corrections and materializes corrected state;
- campaign export contains corrected current state without changing accepted turns.

- [ ] **Step 7: Run focused service tests**

```powershell
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/campaign-state-corrections.integration.test.ts tests/integration/generation.integration.test.ts tests/integration/import-memory.integration.test.ts
pnpm check
```

Expected: PASS with PostgreSQL tests executed.

- [ ] **Step 8: Commit complete correction persistence**

```powershell
git add services/api/src/campaign-state-service.ts services/api/src/memory-service.ts tests/integration/campaign-state-corrections.integration.test.ts
git diff --cached --check
git commit -m "Persist full campaign state corrections"
```

---

### Task 4: Preserve corrections across latest-turn regeneration

**Files:**
- Modify: `services/api/src/generation-service.ts`
- Modify: `tests/integration/generation.integration.test.ts`
- Modify: `tests/integration/campaign-state-corrections.integration.test.ts`

**Interfaces:**
- Consumes: `loadEffectiveCampaignStateEdit(...)` and `projectCampaignStateCorrection(...)` from Task 3.
- Produces: correction-aware durable `replace_latest` jobs.
- Guarantees: the selected correction affects replacement generation and remains effective after replacement commit.

- [ ] **Step 1: Write the failing successful-regeneration test**

Arrange turn `N`, save a full correction at `N`, enqueue replacement, and assert:

```ts
const durable = await pool.query(
  `SELECT state_edit_id, state_edit_revision, state_edit_snapshot_private
     FROM generation_jobs WHERE id = $1`,
  [job.id]
);
expect(durable.rows[0]).toMatchObject({
  state_edit_id: savedEditId,
  state_edit_revision: corrected.revision,
  state_edit_snapshot_private: expect.objectContaining({
    continuitySummary: "The corrected lighthouse summary.",
    scratchpad: "The keeper waits below the stair."
  })
});
```

After worker execution, inspect the provider request and final state:

```ts
expect(JSON.stringify(storyRequest)).toContain("The corrected lighthouse summary.");
expect(JSON.stringify(storyRequest)).toContain("The keeper waits below the stair.");
expect(await getCampaignRuntimeState(pool, campaignId)).toMatchObject({
  continuitySummary: "The corrected lighthouse summary.",
  scratchpad: "The keeper waits below the stair."
});
expect(await pool.query(
  "SELECT count(*)::int AS count FROM campaign_state_edits WHERE id = $1",
  [savedEditId]
)).toMatchObject({ rows: [{ count: 1 }] });
```

Also assert the replacement turn ID changed and its accepted state snapshot is the validated model result rather than a rewritten copy of the correction.

- [ ] **Step 2: Write the failing replacement-failure test**

Force the replacement provider call to fail. Assert the original turn ID,
accepted snapshot, state-edit row, materialized campaign state, and corrected
Chronicle projections are unchanged.

- [ ] **Step 3: Run both tests and verify RED**

```powershell
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/campaign-state-corrections.integration.test.ts -t "regeneration"
```

Expected: FAIL because enqueue snapshots only the pre-turn base state and commit deletes edits after `base_turn_number`.

- [ ] **Step 4: Snapshot the active correction during enqueue**

In `enqueueLatestReplacement`:

```ts
const activeEdit = await loadEffectiveCampaignStateEdit(
  client,
  ownerUserId,
  campaignId,
  campaign.active_turn_number
);
const replacementCorrection = activeEdit?.effectiveTurnNumber === campaign.active_turn_number
  ? activeEdit
  : null;
```

Insert `state_edit_id`, `state_edit_revision`, and
`state_edit_snapshot_private` with the durable job. Extend `ClaimedJob` and the
claim query to return those fields.

- [ ] **Step 5: Use the correction for replacement context and mechanics**

Keep `throughTurnNumber` at `base_turn_number` so old narration and derived
memories are excluded. Use the correction snapshot as the private override:

```ts
const replacementState = job.state_edit_id
  ? campaignRuntimeStateContentSchema.parse(job.state_edit_snapshot_private)
  : job.base_state_private;
```

Use `replacementState` for:

- `buildContextPreview(..., { throughTurnNumber, stateOverride })`;
- scratchpad safety;
- continuity summary and open-thread defaults;
- tracker merge base;
- RPG statistics;
- event triggers;
- pending triggers.

The world canon and accepted-history cutoff remain unchanged.

- [ ] **Step 6: Preserve and reapply the correction at commit**

Before replacing the turn, lock and verify that `state_edit_id` and
`state_edit_revision` still identify the latest edit at turn `N`. Replace:

```sql
DELETE FROM campaign_state_edits
 WHERE effective_turn_number > base_turn_number
```

with cleanup that deletes only corrections strictly after the replacement
turn and never deletes `job.state_edit_id`.

After inserting the validated replacement turn and materializing its generated
state:

1. rebuild accepted-turn memories;
2. if `job.state_edit_id` exists, rematerialize its captured complete snapshot
   into `campaign_state`;
3. call `projectCampaignStateCorrection` for the captured edit;
4. leave the accepted replacement snapshot unchanged;
5. include only edit ID and revision in the activity event metadata.

- [ ] **Step 7: Verify corrected regeneration and ordinary replacement**

```powershell
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/campaign-state-corrections.integration.test.ts tests/integration/generation.integration.test.ts
pnpm check
```

Expected: PASS for corrected replacement, failed replacement preservation,
idempotent replay, replacement without a correction, and existing staged
replacement coverage.

- [ ] **Step 8: Commit regeneration support**

```powershell
git add services/api/src/generation-service.ts tests/integration/generation.integration.test.ts tests/integration/campaign-state-corrections.integration.test.ts
git diff --cached --check
git commit -m "Preserve state corrections on regeneration"
```

---

### Task 5: Make every modal field editable

**Files:**
- Create: `apps/web/public/story-state-editor.js`
- Create: `tests/unit/story-state-editor.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/web/public/story.html:281-349`
- Modify: `apps/web/public/story.js:1911-2030,2204-2226,2544-2564`
- Modify: `apps/web/public/story.css`
- Modify: `tests/unit/story-player-ui.test.ts`
- Modify: `tests/unit/csp-ui.test.ts`

**Interfaces:**
- Produces: `globalThis.InfiniteQuestStateEditor`
- Consumes: complete runtime-state response from Task 3.
- Produces: one complete PATCH payload.

- [ ] **Step 1: Install the test-only DOM dependency**

```powershell
pnpm add -D happy-dom
```

Review `package.json` and `pnpm-lock.yaml`; no runtime dependency is permitted.

- [ ] **Step 2: Write failing enabled-control and payload tests**

Create `tests/unit/story-state-editor.test.ts`. Load `story.html` into a Happy
DOM `Window`, execute `story-state-editor.js`, render a full state fixture, and
assert:

```ts
const controls = document.querySelectorAll(
  "#editStateDialog input, #editStateDialog textarea, #editStateDialog select"
);
expect(controls.length).toBeGreaterThan(8);
for (const control of controls) {
  expect((control as HTMLInputElement).disabled).toBe(false);
  expect((control as HTMLInputElement).readOnly).toBe(false);
}

const payload = globalThis.InfiniteQuestStateEditor.collect(document);
expect(payload).toEqual(expect.objectContaining({
  continuitySummary: "The corrected lighthouse summary.",
  openThreads: ["Find the keeper."],
  canonicalFacts: [{
    id: "00000000-0000-4000-8000-000000000002",
    content: "The lens is moon glass."
  }],
  scratchpad: "The keeper waits below the stair.",
  trackers: expect.any(Array),
  rpgStats: expect.any(Array),
  eventTriggers: expect.any(Array),
  pendingEventTriggers: expect.any(Array)
}));
```

Simulate add/remove and editing for each list. Assert canonical fact IDs survive
unchanged rows, new facts return `id: null`, numeric values are numbers, and
every trigger property round-trips.

- [ ] **Step 3: Run the browser helper test and verify RED**

```powershell
pnpm exec vitest run tests/unit/story-state-editor.test.ts tests/unit/story-player-ui.test.ts
```

Expected: FAIL because most values are text nodes and
`story-state-editor.js` does not exist.

- [ ] **Step 4: Replace read-only markup with editor containers**

In `story.html`, add labeled controls/containers:

```html
<textarea id="editStateContinuitySummary" maxlength="20000"></textarea>
<div id="editStateOpenThreadsEditor" class="state-list-editor"></div>
<button id="btnAddOpenThread" type="button">＋ Add open thread</button>
<div id="editStateCanonicalFactsEditor" class="state-list-editor"></div>
<button id="btnAddCanonicalFact" type="button">＋ Add canonical fact</button>
<div id="editStateRpgStatsEditor" class="state-list-editor"></div>
<div id="editStateEventTriggersEditor" class="state-list-editor"></div>
<div id="editStatePendingTriggersEditor" class="state-list-editor"></div>
```

Retain `scratchpadEditor`, tracker add fields, Save, Cancel, history, and tab
controls. Add `/nexus/story-state-editor.js` before `/nexus/story.js`; both
remain external scripts for strict CSP.

- [ ] **Step 5: Implement focused render/collect helpers**

Create `story-state-editor.js` as a strict-mode IIFE. It must:

- escape values through DOM properties, never HTML interpolation;
- create every input with `document.createElement`;
- store canonical fact IDs in `data-fact-id`;
- provide add/remove handlers for all list types;
- validate required names, conditions, effects, instructions, and RPG range;
- return the complete content object from Task 1;
- never set `disabled` or `readOnly` on editable controls.

Expose only:

```js
globalThis.InfiniteQuestStateEditor = Object.freeze({
  render,
  collect,
  install
});
```

- [ ] **Step 6: Wire Story Player loading and saving**

In `renderCurrentRuntimeState`:

```js
globalThis.InfiniteQuestStateEditor.render(document, state.runtimeState);
```

In `saveEditState`:

```js
const content = globalThis.InfiniteQuestStateEditor.collect(document);
state.runtimeState = await api(`/campaigns/${state.campaignId}/state`, {
  method: "PATCH",
  body: JSON.stringify({
    expectedTurnNumber: state.runtimeState.activeTurnNumber,
    expectedRevision: state.runtimeState.revision,
    ...content
  })
});
```

If collection or API validation fails, keep the dialog open, retain entered
values, and focus the first invalid control. After success, rerender from the
response before closing so the new revision and application-owned fact IDs
become the modal baseline.

- [ ] **Step 7: Add responsive styling and static contracts**

Add responsive row/grid classes to `story.css` without inline styles. Update
`story-player-ui.test.ts` to assert every editor ID, helper script, complete
payload spread, and absence of `disabled`/`readonly` attributes inside the
modal. Add `story-state-editor.js` to the active-file list in `csp-ui.test.ts`.

- [ ] **Step 8: Run UI and CSP tests**

```powershell
pnpm exec vitest run tests/unit/story-state-editor.test.ts tests/unit/story-player-ui.test.ts tests/unit/csp-ui.test.ts
node --check apps/web/public/story-state-editor.js
node --check apps/web/public/story.js
pnpm check
```

Expected: PASS.

- [ ] **Step 9: Commit the full editor**

```powershell
git add package.json pnpm-lock.yaml apps/web/public/story.html apps/web/public/story.js apps/web/public/story.css apps/web/public/story-state-editor.js tests/unit/story-state-editor.test.ts tests/unit/story-player-ui.test.ts tests/unit/csp-ui.test.ts
git diff --cached --check
git commit -m "Make all campaign state fields editable"
```

---

### Task 6: Architecture records and complete verification

**Files:**
- Create: `docs/architecture/0028-append-only-runtime-state-corrections.md`
- Modify: `docs/architecture/0011-editable-campaign-runtime-state.md`
- Modify: `docs/architecture/0017-staged-latest-turn-replacement.md`
- Modify: `docs/architecture/0018-structured-canonical-fact-projections.md`
- Modify: `docs/architecture/index.md`

**Interfaces:**
- Consumes: completed Tasks 1–5.
- Produces: reviewed, documented, and verified behavior ready for branch completion.

- [ ] **Step 1: Record the architecture decision**

Document:

- all Edit State fields use one complete typed snapshot;
- `campaign_state_edits` is the append-only manual authority;
- accepted turn snapshots are never rewritten by a manual edit;
- Chronicle and `campaign_state` are rebuildable materializations;
- canonical facts may be sourced from a turn or a state edit, never both;
- corrected empty summaries and thread sets replace older values;
- latest-turn replacement snapshots the active correction, uses it despite the
  `N - 1` history cutoff, preserves it on failure, and reapplies it on success;
- the accepted replacement snapshot remains model-produced;
- the correction overlay naturally stops applying after a later accepted turn.

Update ADRs 0011, 0017, and 0018 to link ADR 0028 and remove contradictory
read-only/source-only statements.

- [ ] **Step 2: Run repository, unit, and build verification**

```powershell
pnpm check
pnpm test:unit
pnpm build
```

Expected: PASS with no skipped unit tests.

- [ ] **Step 3: Run focused PostgreSQL verification**

With `TEST_DATABASE_URL` pointing to a disposable compatible database:

```powershell
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/migrations.integration.test.ts tests/integration/campaign-state-corrections.integration.test.ts tests/integration/generation.integration.test.ts tests/integration/import-memory.integration.test.ts
```

Expected: PASS with all four files executed.

- [ ] **Step 4: Run the complete integration suite**

```powershell
pnpm test:integration
```

Expected: PASS with PostgreSQL tests executed. If database access is absent,
report integration status as unverified and do not call the implementation
complete.

- [ ] **Step 5: Manually verify the Story view**

Run the documented local stack, open a current campaign, and verify:

1. every Edit State field accepts typing;
2. adding/removing every structured row works;
3. one save updates the next reopened modal;
4. the next turn prompt uses the corrected state;
5. Retry/regenerate of the latest turn uses the correction;
6. successful regeneration retains the correction;
7. failed regeneration retains the original turn and correction;
8. Turn History remains read-only.

Capture a screenshot of the completed modal for the pull request.

- [ ] **Step 6: Review invariants and complete diff**

```powershell
rg -n "campaignRuntimeStateContentSchema|source_state_edit_id|state_edit_snapshot_private|InfiniteQuestStateEditor" packages services database apps tests docs
rg -n "DELETE FROM campaign_state_edits" services/api/src/generation-service.ts
git diff --check
git status --short
git diff --stat origin/main...HEAD
git diff origin/main...HEAD
```

Confirm:

- replacement cleanup cannot delete the snapshotted active correction;
- no accepted-turn update was introduced for manual edits;
- no owner/campaign predicate is missing;
- no fiction-only state enters logs;
- no unrelated legacy `index.html` changes exist.

- [ ] **Step 7: Run Repowise health and risk review**

Run targeted health checks for:

```text
apps/web/public/story.js
apps/web/public/story-state-editor.js
services/api/src/campaign-state-service.ts
services/api/src/generation-service.ts
services/api/src/memory-service.ts
packages/contracts/src/generation.ts
```

Run change-risk review for the complete `origin/main...HEAD` range. Address
missing co-changes, tests, or newly introduced critical findings before
completion.

- [ ] **Step 8: Commit architecture documentation**

```powershell
git add docs/architecture/0028-append-only-runtime-state-corrections.md docs/architecture/0011-editable-campaign-runtime-state.md docs/architecture/0017-staged-latest-turn-replacement.md docs/architecture/0018-structured-canonical-fact-projections.md docs/architecture/index.md
git diff --cached --check
git commit -m "Document append-only state corrections"
```

- [ ] **Step 9: Transition to branch completion**

Invoke `superpowers:requesting-code-review`, resolve actionable findings with
failing regressions first, rerun Task 6, and then invoke
`superpowers:finishing-a-development-branch`. Do not push or create a pull
request without explicit user direction.
