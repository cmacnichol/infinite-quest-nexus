# ADR 0045 — Current-state edits yield to newer story evidence

## Status

Accepted 2026-11-15. Not yet implemented. Phase 0 of the [character editor usability plan](../superpowers/plans/2026-11-15-character-editor-usability.md).

## Context

A user field edit on a Supporting Character is stored as an override with `evidence: { kind: "user", effectiveTurnNumber }`. `projectCastProfile` applies every override after all Observations, and `resolveSeededCastProfile` does the same for Starting Cast Characters, so a user edit always wins. That suits stable facts. For current location, condition, clothing and goals it leaves sheets and narrator context stale: a location set on turn 12 still reads "the docks" after the story moves the character on turn 20. The planned sheet editing makes these edits common, so the staleness would become common too.

## Decision

User edits split into two kinds (see `CONTEXT.md`):

- A **Correction** edits a stable field. It stays in force until the user clears it. Precedence is unchanged.
- A **State Edit** edits `state.location`, `state.condition`, `state.clothing` or `story.goals`, the existing "updating" set (`isCastUpdatingPath`, `seededCastFieldPolicy`). It stays in force only until a fact Observation of that field exists from a turn **strictly later** than the edit's `effectiveTurnNumber`. A same-turn Observation never replaces it. After that, the latest valid Observation applies as for any updating field. Retracted, superseded and invalidated Observations do not count.

The rule applies to every Supporting Character type, both projections and all existing overrides. It is defined once, as a pure predicate in contracts that domain, repository and clients share. There is no lock option for State Edits; Retraction is the remedy for bad evidence. Wrong Observations are retracted, not out-voted.

V3 narrator capture applies the same rule whatever the tracking status. Tracking is `pending` after almost every accepted turn until it catches up (`current` requires `trackedThroughTurn` to equal the boundary turn), so holding State Edits during gaps would bring back the staleness this ADR removes. The rule is safe during gaps without extra filtering. An Observation can replace an edit only if it comes from a tracked turn strictly later than the edit, so it is always newer evidence. An edit made after the tracked range cannot be replaced by anything older. Current-state fields **without** an edit keep the existing gap behavior: they are omitted while tracking is incomplete. A field's narrator authority comes from the same replacement predicate. A replaced State Edit is sent with observation authority and evidence, never as user authority. Discovery off keeps its distinct last-known-state behavior. The capture produces a version-selected fiction snapshot, while the job persists its fingerprint rather than the snapshot itself. Recapture uses the frozen job protocol and must match that fingerprint. If cast authority changes, including tracking catching up, the job becomes recoverable and stale; start a fresh job rather than silently reprojecting it. Existing supported dispatched-request replay retains its exact saved request.

V2 capture and recapture keep the old "edit always wins" precedence, chosen by the frozen context version, so V2 jobs captured before the upgrade and resumed after it keep their fingerprints. Only the live sheet and V3 capture use the new rule.

The narrator-facing authority contract and cast notice are reworded to state both kinds. They ship as new versions: `CAST_V3_STORY_MEMORY_PROMPT_PROTOCOL_VERSION`, plus V3 cast and history context-policy versions. All compatibility validators, snapshot identities, mandatory contracts, context/history classifiers, preview and generation paths, and continuity review/repair consumers must understand V3 before new jobs use it. The frozen job policy selects the version explicitly. V2 values, wording and frozen fiction stay valid for jobs and turns already recorded under them. The live sheet projection itself is not versioned, because there is one current rule.

## Considered options

- **Keep every edit locked and show "Story differs".** Rejected: every moving character would need manual clearing, and a stale value would keep reaching the narrator in the meantime.
- **Ask "Lock this value?" on each save.** Rejected: it adds a write type and a storage flag, and puts a precedence decision in front of every edit.
- **Apply the rule only to edits made after release.** Rejected: it needs a per-edit flag (a storage-format change), and two campaigns would then behave differently for the same history.

## Consequences

- When this ships, existing State Edits with later Observations immediately resolve to those Observations. Nothing is deleted: the edit stays in history, and the sheet shows "Replaced your edit from turn N". Release notes must say so.
- The sheet and V3 narrator context resolve State Edit fields the same way in every tracking state. While tracking is incomplete they differ only for unedited current-state fields: the sheet shows them, and the narrator omits them, as V2 already does.
- While V2 jobs are still being created (V3 enqueue off, or before activation), their narrator context keeps "edit always wins" even though the sheet already uses the new rule. This gap is accepted, and it closes when V3 enqueue is enabled.
- Retraction is the only remedy for a wrong later Observation, so enabling this rule depends on the `observationDecisions` capability. Where that capability is off, the user's only recourse is to edit again (a newer State Edit wins until later evidence arrives). Release notes must say so.
- No migration and no portable-format change. An older binary replays the same cast events with "edit always wins", but a binary without V3 readers cannot resume V3 jobs. Ship compatible readers before enabling V3 enqueue; after activation, retain those readers for saved V3 jobs and turns. Cast-event portability does not remove the prompt-reader rollback boundary.
- Merge, unmerge, rewind and archive replay need no special handling: each recomputes the projection from retained events, and overrides keep their effective turns.
