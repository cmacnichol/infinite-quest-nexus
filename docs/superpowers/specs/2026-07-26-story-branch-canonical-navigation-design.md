# Story Branch Canonical Navigation Design

## Problem

The Story Player opens campaigns through the canonical route `/story/:campaignId`. After **Create separate campaign** succeeds, however, the player keeps the parent campaign in the pathname and writes the new campaign ID only to `?campaignId=...`.

The client immediately loads the branch in memory, so the transition can appear successful. A refresh, reopen, or use of the Story navigation link resolves the campaign from the unchanged pathname and returns the player to the parent campaign.

## Goal

After branching from an earlier accepted turn, make the new campaign's canonical `/story/:campaignId` route authoritative immediately and across refresh, reopen, and browser Back navigation.

## Non-goals

- Change the `POST /api/v1/campaigns/:campaignId/branch` contract or branch persistence transaction.
- Change rewind behavior.
- Add query-parameter campaign routing.
- Convert the Story Player into a single-page router.
- Refactor unrelated modal, history-selection, or campaign-loading code.

## Design

When the branch API returns the new campaign, the Story Player will navigate to:

```text
/story/<URL-encoded new campaign ID>
```

The transition will use `window.location.assign(...)`, matching existing Nexus entry points into the Story Player.

The branch handler will no longer:

- assign `state.campaignId` before navigation;
- add a `campaignId` query parameter;
- call `window.history.pushState`;
- call `loadCampaign(newCampaign.id)` or `navigateTo(-1)` for the branch transition.

The full canonical navigation lets the existing `init()` path load the new campaign, synchronize the Story navigation link, and persist the last campaign ID. Browser Back returns to the parent campaign's canonical URL and reloads its corresponding state, avoiding a new `popstate` synchronization path.

## Data Flow

1. The player selects an earlier accepted turn in **Turn History & State**.
2. The player chooses **Create separate campaign**.
3. The client posts the selected one-based `targetTurnNumber` to the existing branch endpoint.
4. The API creates and returns the independent campaign branch.
5. The client navigates to `/story/<new campaign ID>`.
6. The existing Story Player initialization reads the ID from the pathname and loads the new campaign, its accepted turns, state, and illustration configuration.

## Error Handling

If branch creation fails, the current campaign and canonical URL remain unchanged and the existing `Branch failed: ...` toast remains visible.

After the API has successfully created a branch, canonical navigation is the completion boundary. No second in-memory campaign-loading path will run before navigation. This removes the current split state in which the displayed campaign and URL identify different campaigns.

## Testing

Use strict test-driven development:

1. Add a focused Story Player regression assertion that requires canonical navigation to the URL-encoded new campaign ID.
2. Assert that the obsolete `campaignId` query-parameter mutation is absent.
3. Run the focused UI test and capture the expected RED failure before changing production code.
4. Make the minimum branch-handler change and rerun the focused test for GREEN.
5. Run the complete Story Player unit test file, JavaScript syntax validation, TypeScript checking, and `git diff --check`.
6. Run the existing PostgreSQL integration test for branching at a previous turn when `TEST_DATABASE_URL` is configured. If it is unset, report the test as skipped and do not describe backend behavior as runtime-verified.

The repository currently tests the Story Player as a static source contract rather than in a browser DOM environment. This change will strengthen that established contract without introducing a new browser-test dependency for a single navigation correction.

## Documentation

The player guide already describes the intended user-visible behavior: creating a separate campaign preserves the parent and switches to an independent story path. No documentation change is required unless implementation reveals different behavior.

## Acceptance Criteria

- Creating a separate campaign from any earlier accepted turn sends the same one-based branch boundary as today.
- A successful branch navigates to `/story/<URL-encoded new campaign ID>`.
- Refreshing the new route reloads the branch rather than the parent campaign.
- Browser Back returns to the parent campaign route and state.
- Failed branch creation leaves the current route and campaign unchanged.
- The obsolete `?campaignId=` branch-routing path is removed.
- Focused Story Player tests pass.
- PostgreSQL verification status is reported honestly according to `TEST_DATABASE_URL`.
