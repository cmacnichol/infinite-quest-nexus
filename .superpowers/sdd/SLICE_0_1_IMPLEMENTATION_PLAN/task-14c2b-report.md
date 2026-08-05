# Task 14c2b implementation report

## Status

The first Task 14c2b sync slice is implemented and verified. The remaining
campaign-state, player-configuration, rewind, and branch adapters are not part
of this commit and Task 14c2b is not yet complete.

## Implemented scope

- Added the explicit-owner PostgreSQL `CampaignSyncRepositoryPort` adapter.
- Returns typed `campaign_not_found` for missing or foreign-owned campaigns.
- Preserves raw `Date` values in the adapter source projection.
- Projects pending and recovery generations through their discriminated public
  contracts without exposing raw provider failures.
- Added an adapter over the existing bounded turn-page reader; no cursor,
  history-version, or repeatable-read snapshot logic was duplicated.
- The bounded adapter now receives the established owner-scoped
  `turnReportedCosts` projection as a named typed collaborator, preserving
  non-null turn costs in sync windows without duplicating cost SQL.
- Requires that bounded reader as a named factory collaborator, so the existing
  application-owned `getCampaignSyncStatus` use case remains the only owner of
  unchanged-versus-replace window selection.
- Extracted the complete campaign sync source schema from the existing public
  response schema and validates the entire database-derived projection before
  returning it, including playable characters and all nested player state.
  Malformed persisted data becomes the safe typed
  `unavailable`/`invalid_transition` application error.
- Expected-turn and recovery numeric fields use explicit null checks. Invalid
  zero expected-turn values now reach contract validation instead of being
  silently treated as absent; zero recovery attempts remain valid.
- Added the database barrel export.
- No route, runtime, worker, legacy-service, state, rewind, or branch file was
  changed.

## RED / GREEN evidence

Initial RED:

```text
pnpm vitest run --config vitest.integration.config.ts \
  tests/integration/campaign-authority-repository.integration.test.ts
```

Failed because `campaign-state-repository.js` and
`createPostgresCampaignAuthorityAdapters` did not exist.

Review correction RED:

- Focused real-PostgreSQL adapter suite: 2/5 tests passed and 3 failed.
- The failures demonstrated a dropped non-null `reportedCost`, leaked malformed
  `world.playableCharacters`, and a raw nested-state `ZodError` escaping the
  database boundary.

Final GREEN:

- Focused real-PostgreSQL adapter suite: 1 file, 5/5 tests passed.
- `pnpm check`: passed, including repository/data boundary checks and all
  TypeScript workspace checks.
- `git diff --check`: passed.

## Contract note

Task 14c1 deliberately places `getCampaignSyncStatus` in the application use
case and exposes separate `CampaignSyncRepositoryPort` and
`BoundedCampaignTurnPagePort` dependencies. The PostgreSQL slice therefore
implements those two adapters and injects the bounded reader; adding another
database-level `getCampaignSyncStatus` method would duplicate the frozen 14c1
application orchestration.

## Deferred Task 14c2b scope

- effective/runtime campaign state reads and correction writes;
- expected-turn and state-revision fenced player configuration;
- rewind deletion and derived-state authority;
- branch append-only and replacement provenance;
- rollback and full combined Task 14c2b PostgreSQL coverage.
