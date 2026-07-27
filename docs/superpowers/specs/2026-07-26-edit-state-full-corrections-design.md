# Full Edit State Corrections Design

**Status:** Approved

**Date:** 2026-07-26

## Summary

Infinite Quest will make every field shown by the Story view's **Edit State**
modal editable. One save will atomically create an append-only correction to
the campaign's effective state. Accepted turns and their original private
snapshots remain unchanged.

The corrected state becomes authoritative for future generation, Chronicle
retrieval, rewind and branch restoration, export, and latest-turn
regeneration. When the latest accepted turn is regenerated, the durable
replacement job captures the active correction, uses it as generation
context, preserves it if replacement fails, and reapplies it after a
successful replacement commit.

## Goals

- Edit continuity summary, open threads, canonical facts, scratchpad,
  trackers, RPG statistics, event triggers, and pending triggers.
- Save all fields through one typed, transactional API operation.
- Keep accepted turn rows and accepted-turn state snapshots unchanged.
- Record every manual save as an immutable `campaign_state_edits` revision.
- Make corrected content immediately effective in Story Engine prompts and
  Chronicle retrieval.
- Preserve the active correction across durable latest-turn regeneration.
- Keep rewind and branch behavior deterministic from accepted snapshots plus
  append-only corrections.
- Retain optimistic concurrency and active-generation exclusion.

## Non-goals

- Editing narration, choices, actions, rolls, or other accepted-turn content.
- Editing historical state without first rewinding or branching it into the
  current campaign state.
- Rewriting immutable world-version content.
- Treating Chronicle embeddings, summaries, or canonical-fact projections as
  authoritative records.
- Allowing a partial save when one field fails validation.

## Editable state contract

The runtime-state response and update request use one typed content shape:

```ts
type CampaignRuntimeStateContent = {
  continuitySummary: string;
  openThreads: string[];
  canonicalFacts: Array<{
    id: string | null;
    content: string;
  }>;
  scratchpad: string;
  trackers: CampaignTracker[];
  rpgStats: PlayerRpgStat[];
  eventTriggers: PlayerEventTrigger[];
  pendingEventTriggers: PendingEventTrigger[];
};
```

Existing canonical facts return their stable projection ID. A new fact has a
null ID in the browser request; the API assigns an application-owned,
deterministic ID derived from the state-edit record. An edited fact creates a
new manual projection and supersedes the prior fact. Omitting an existing fact
retires it at the correction's effective turn.

The update request adds `expectedTurnNumber` and `expectedRevision`. The
response adds campaign identity, viewed/current turn metadata, revision, and
update timestamp.

## Modal behavior

The modal retains its Current State, Scratchpad, Trackers, and Mechanics tabs,
but every displayed value becomes a form control:

- Continuity summary: multiline text.
- Open threads: ordered add/remove text rows.
- Canonical facts: ordered add/remove text rows with hidden stable IDs.
- Scratchpad: multiline text with character count.
- Trackers: structured rows for name, value, and update rules.
- RPG statistics: structured rows for name, value, and note.
- Event triggers: structured rows for every persisted trigger property.
- Pending triggers: structured rows for every persisted pending-trigger
  property.

The browser gathers one complete payload and sends one PATCH request. Client
validation provides immediate missing-field and numeric-range feedback, but
the API remains authoritative. The existing unsaved-change dismissal guard
continues to cover all controls.

## Transaction and persistence

`updateCampaignRuntimeState` performs one owner-scoped transaction:

1. Lock the campaign and `campaign_state`.
2. Verify the current turn and state revision.
3. Reject the save if a generation job is active or recoverable.
4. Parse and validate the complete typed state.
5. Apply the fiction-boundary validator to continuity summary, open threads,
   canonical facts, scratchpad, and trackers. Mechanics and trigger
   configuration use their dedicated typed schemas rather than the
   fiction-only classifier.
6. Calculate the changed fields and return without creating a revision for a
   no-op save.
7. Allocate the next state revision and insert one complete snapshot into
   `campaign_state_edits`.
8. Materialize scratchpad, trackers, RPG statistics, event triggers, and
   pending triggers into `campaign_state`.
9. Update `initial_state_snapshot` for a turn-zero correction.
10. Rebuild derived Chronicle projections from accepted turns and overlay the
    latest applicable correction.
11. Invalidate model chains, enqueue embedding reindexing, and record a
    content-free activity event.

The correction snapshot is the authoritative manual source. Materialized
columns and Chronicle records are rebuildable projections.

## Chronicle correction projection

Canonical facts gain two valid source forms:

- accepted-turn source (`source_turn_id`);
- state-edit source (`source_state_edit_id`).

Exactly one source is present. Manual fact IDs are deterministic from campaign
ID, state-edit ID, fact index, and sanitized content. Rebuild first projects
accepted-turn facts, then applies state edits in revision order to add, edit,
retire, or retain facts.

Continuity summary and open threads remain complete replacement fields.
Context construction checks for the latest state edit at or before its turn
cutoff. When present, it uses the corrected summary and thread list directly,
including an explicitly empty value, instead of falling back to older derived
memories. Non-empty corrected values may also receive rebuildable memory rows
for lexical, entity, and semantic retrieval.

Every query remains owner-, campaign-, world-version-, and turn-cutoff scoped.

## Future turns

For a normal append generation at turn `N + 1`, the current correction at turn
`N` is part of the authoritative campaign state used to construct the prompt
and mechanics inputs. When turn `N + 1` commits, its accepted state becomes the
new base. The older correction remains in the audit history but no longer
overlays the newer turn.

## Latest-turn regeneration

A `replace_latest` job for turn `N` keeps the existing pre-turn snapshot at
`N - 1`, and additionally captures:

- active state-edit ID;
- active state-edit revision;
- complete correction snapshot.

The worker excludes the narration and derived memories of the turn being
replaced, preserving the existing historical cutoff. It nevertheless uses the
captured correction snapshot as the private state override and mechanics
configuration for regeneration, as explicitly required.

If generation or validation fails, the original turn and correction remain
effective. If replacement succeeds, the commit:

1. verifies the target turn and captured correction are still current;
2. replaces the accepted turn using the existing staged replacement flow;
3. does not delete the captured correction at effective turn `N`;
4. writes the model-produced state to the replacement turn snapshot;
5. rematerializes the captured correction over campaign state;
6. rebuilds accepted-turn Chronicle projections and reapplies the correction;
7. completes the job and records correction provenance without story content.

The replacement turn snapshot remains the validated model result. The
append-only correction remains the effective manual overlay until a later
accepted turn advances the campaign or the user saves another correction.

## Rewind, branch, and export

- Rewind deletes corrections effective after the target turn, then restores
  the latest correction at the target turn when one exists.
- Branch copies accepted turns and applicable correction history through the
  branch turn. The branch's materialized state is the effective corrected
  snapshot.
- Campaign export includes the current corrected materialized state and the
  existing state-edit history used by portable campaign transfer.
- Historical inspection remains read-only and resolves accepted state plus
  the latest correction visible at the requested turn.

## Error behavior

- `400`: malformed fields, invalid IDs, out-of-range RPG values, malformed
  triggers, or prohibited fiction-boundary content.
- `404`: campaign not found in the current owner scope.
- `409`: stale turn/revision, active generation, or replacement target/edit
  changed before commit.
- Any transaction failure leaves campaign state, correction history,
  Chronicle projections, and model chains unchanged.

The browser keeps the modal open after failure and shows the safe API message.

## Testing strategy

Strict TDD applies to every behavior change.

### Contract and unit tests

- Full runtime-state request and response schemas accept every typed field.
- Invalid values and unsafe fiction content are rejected.
- Canonical-fact add, edit, retain, and remove operations produce deterministic
  projection instructions.
- Empty corrected summary and thread lists override prior derived content.

### PostgreSQL integration tests

- One save writes one complete state edit and materializes every field.
- A failed field makes the entire save atomic.
- No-op, stale-revision, cross-owner, and active-generation cases behave
  correctly.
- Corrected values appear in the next append-generation prompt.
- Chronicle retrieval returns corrected facts, summary, and threads and does
  not return retired values.
- Rewind, branch, export, and rebuild reproduce the same effective state.
- Latest-turn regeneration captures the correction, uses it in the provider
  request, preserves it on failure, and reapplies it after success.
- PostgreSQL tests skipped because `TEST_DATABASE_URL` is absent remain
  explicitly unverified.

### Browser tests

- Every state value renders in an enabled control.
- Add/remove operations preserve stable IDs where required.
- Save sends every field in one request.
- A successful response refreshes the modal baseline and visible state.
- Validation or API failure leaves entered values available for correction.

## Acceptance criteria

- Every field displayed in Edit State is editable.
- Save updates the effective authoritative campaign content atomically.
- Accepted turns and their original snapshots are not modified by a state
  edit.
- Corrected Chronicle content is used by retrieval and future generation.
- A latest-turn regeneration uses and preserves the active correction.
- Rewind, branch, rebuild, and export produce consistent corrected state.
- Focused unit tests, executed PostgreSQL integration tests, browser behavior
  tests, `pnpm check`, `pnpm build`, and `git diff --check` pass.
