# Editable Campaign State Design

## Goal

Make every continuity field in the Story Player's Edit State dialog editable and persist the complete corrected state through the existing campaign-state API. Generated mechanics remain read-only after campaign creation.

## Scope

The dialog will allow players to edit:

- continuity summary;
- open threads;
- canonical facts;
- private continuity scratchpad; and
- fictional trackers.

The Mechanics tab will continue to display RPG stats, event triggers, and pending event triggers without editing controls. Saving continuity changes must preserve those loaded mechanics values unchanged.

## User Experience

The Current State tab will replace its read-only continuity presentation with ordinary form controls:

- `Continuity summary` is a multiline textarea.
- `Open threads` is a repeatable list of textareas with Add and Remove actions.
- `Canonical facts` is a repeatable list of textareas with Add and Remove actions.

Canonical-fact rows retain the fact's stable database ID in browser state or row metadata. The visible editor operates on the fact's `content`; it never stringifies the whole `{ id, content }` object.

Scratchpad and tracker editing retain their existing interaction. The Mechanics tab retains its existing read-only presentation and explicitly states that generated mechanics are static.

All edits are saved atomically through the existing Save action. A successful save replaces the browser's runtime-state snapshot with the server response and closes the dialog. A validation, active-generation, or optimistic-concurrency failure leaves the dialog and current inputs open and displays the server error.

## Browser Components

`apps/web/public/story.html` owns the static dialog structure. It will provide:

- a textarea for the summary;
- containers and Add buttons for open-thread and canonical-fact editors;
- stable IDs for event binding; and
- unchanged read-only mechanics containers.

`apps/web/public/story.js` owns editor hydration, row management, collection, and submission:

- Summary hydration assigns `runtime.continuitySummary` to the textarea value.
- Open-thread hydration creates one editable row per string.
- Canonical-fact hydration creates one editable row per `{ id, content }` value and retains `id`.
- Add actions append blank rows; Remove actions delete the selected row.
- Collection trims list entries, excludes empty rows, and preserves canonical-fact IDs.
- Save constructs the complete `CampaignRuntimeStateUpdate` payload from editable controls plus unchanged mechanics values from `state.runtimeState`.

The historical Turn History inspector remains read-only. Its canonical-fact list will render `fact.content` so structured facts never appear as `[object Object]`.

## API and Persistence

No API or database schema change is required. `PATCH /api/v1/campaigns/:campaignId/state` already accepts the complete state contract and `updateCampaignRuntimeState` already:

- validates fiction-only editable fields;
- enforces the expected turn number and revision;
- stores append-only campaign-state corrections;
- reconciles stable canonical-fact IDs;
- rebuilds Chronicle memories; and
- invalidates model chains.

The browser must send all fields required by `campaignRuntimeStateUpdateSchema`:

```text
expectedTurnNumber
expectedRevision
continuitySummary
openThreads
canonicalFacts
scratchpad
trackers
rpgStats
eventTriggers
pendingEventTriggers
```

The first five state collections are collected from their editors. `rpgStats`, `eventTriggers`, and `pendingEventTriggers` are copied unchanged from the loaded runtime state.

## Validation and Error Handling

Blank open-thread and canonical-fact rows are omitted before submission because the shared contract rejects empty list entries. The summary and scratchpad may be empty because their contracts permit empty strings. Tracker collection retains its current rule that rows without names are omitted.

Backend validation remains authoritative. The browser does not duplicate mechanics-leakage or ownership validation. Save errors use the existing toast path without closing the dialog or replacing the loaded runtime-state snapshot.

## Testing

Story Player UI tests will exercise the behavior rather than only checking that the dialog shell exists. Tests will verify:

- the summary, open-thread, and canonical-fact editor controls exist;
- structured canonical facts render their `content`, not `[object Object]`;
- open threads and canonical facts can be added and removed;
- canonical-fact IDs survive editor collection;
- blank collection rows are omitted;
- the PATCH body contains every required state field;
- mechanics values in the PATCH body equal the values loaded from the server; and
- Turn History renders canonical-fact content.

Existing contract tests continue to define the complete payload shape. Existing PostgreSQL integration tests continue to verify append-only persistence, stable fact IDs, Chronicle rebuilding, and model-chain invalidation. Focused UI and contract tests will run during each TDD cycle, followed by the repository checks, build, and relevant integration test when `TEST_DATABASE_URL` is available.

## Non-Goals

- Editing RPG stats, event triggers, or pending event triggers after campaign generation.
- Changing the campaign-state API or database schema.
- Editing historical turn state directly.
- Adding per-field save operations or a raw JSON editor.
