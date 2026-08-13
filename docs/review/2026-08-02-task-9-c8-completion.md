# Task 9 (C8) completion report

**Status:** Complete on 2026-08-02.

Task 9 now proves the current Story Player against the shared client boundary.
The original Gate 1 contract commit remains intact, a focused Gate 1 follow-up
closes the contract/route/client review gaps, and Gate 2 is one revertible client
rewire commit.

## Delivered boundary

- The Story Player uses the typed `NexusApiClient` surface for adopted routes;
  its legacy illustration adapter is named, private to the app, and validates all
  eight allowlisted success schemas plus the standard error envelope.
- `StoryPlayerComposition` is typed. One explicit bootstrap constructs and
  shares the session, clock, ID, API, source, pending-store, and workflow
  dependencies before invoking `startStoryPlayer` exactly once.
- The app-owned generation monitor delegates durable lifecycle policy to
  `GenerationRun`. The former EventSource/poll/timeout monitor and raw
  `partialNarration` path were deleted.
- `result_unavailable` remains complete-but-loading and retries only
  `GenerationRun.fetchResult()`. Cancel and discard target the active run.
- A structured `active_generation_exists` 409 resumes the authoritative job,
  displays exactly `a turn is already generating`, and never submits a second
  idempotency key.
- The compiled entry owns the relocated Story Player modules. Public static
  output no longer exposes a raw module with bare workspace imports.
- The five C8 UI documents describe progressive narration, preserved
  retry-latest turns, explicit cancel versus detach, incremental endpoint
  adoption, and the still-deferred generic non-generation watcher.

## Verification

| Check | Result |
|---|---|
| Focused Task 9 suite | 21 files, 309/309 tests passed |
| `pnpm check` | Passed, including repository and data-boundary checks |
| `pnpm build` | Passed; legacy and replacement web builds completed |
| Unit suite | 81 files, 935/935 tests passed |
| Integration suite | 17 files, 191 passed, 2 intentional skips |
| `git diff --check` and `pnpm pjm precheck` | Passed before commit reconstruction |

The integration suite includes a real route-to-workflow regression: a malformed
generation snapshot is rejected with the route correlation ID before the
workflow can consume it. Focused tests also cover every illustration method and
malformed response, correlation-preserving errors, caller identity-spoofing
guards, active-409 resume, result-fetch recovery, lifecycle rendering, bootstrap
sharing, CSP/static relocation, and source-boundary removal.

## Story Player behavior checklist

No interactive browser runtime or Playwright executable is installed in this
worktree, so this is a manual source/behavior review backed by focused executable
tests rather than a claim of browser E2E coverage. U6 remains the owner of that
future E2E layer.

| Behavior | Result and evidence |
|---|---|
| Submit and Auto classification | Pass — resolved mode is rendered; stale classification cannot submit |
| Streamed narration | Pass — only typed narration is rendered progressively with the app-owned live treatment |
| Recoverable retry | Pass — recoverable state offers the active run's retry path |
| Cancel | Pass — calls `activeGenerationRun.cancel()` and renders cancellation distinctly |
| Discard | Pass — calls `activeGenerationRun.discard()` and clears the active presentation |
| Completed result | Pass — validated accepted result replaces progressive narration atomically |
| Result fetch unavailable | Pass — stays complete-but-loading; retry calls only `fetchResult()` |
| Reload/resume | Pass — workflow resume and active-409 recovery attach to the authoritative job |
| Retry latest | Pass — accepted turn remains visible while replacement runs and is preserved on failure |

## Rollback rehearsal and signals

After history reconstruction, Gate 2 was reverted with `git revert --no-commit`
in a temporary worktree at the Gate 2 commit. The revert applied without
conflict, its resulting tree matched the Gate 1 parent, and the temporary
worktree and branch were removed.

Revert Gate 2 if telemetry shows any of these observable regressions:

- `turn_generation_stream_connected` without a corresponding
  `turn_generation_stream_closed`;
- a rise in generation jobs settling as `failed` or `recoverable`;
- duplicate submissions for one campaign.

Reverting Gate 2 restores the previous client while leaving shared contracts,
typed client methods, server projections, and the reconciled UI documentation in
place.

## Review-correction pass

A second review pass on 2026-08-02 closed the remaining runtime and evidence
gaps without changing the three-commit rollout shape:

- append submissions now preserve the pending submission's top-level
  `expectedTurnNumber` when calling `GenerationWorkflow.submit`; replacement
  submissions retain their separate request contract;
- reload resume and recoverable retry create a live `AbortController` when no
  submit-time controller exists, pass its signal to the selected run method,
  and release only the controller owned by that observation;
- the legacy illustration adapter reuses the shared illustration matching-scope
  schema, including `owner_library`, instead of maintaining a narrower local
  enum;
- route tests now execute successful session, profile, provider-list, campaign
  state, classification, rewind, branch, world-create, campaign-create, and
  playable-character requests and parse every response through its shared
  response schema. Existing `NexusApiClient` mapping tests already covered the
  matching methods and paths, so no client mapping change was required; and
- the feature matrix now reflects the resolved Q2 evidence: legacy single-turn
  illustration endpoints are backend-only surface with orphaned handlers, not a
  user-reachable second illustration model.

The correction pass used a failing-first focused run: the new append,
controller, matching-scope, and success-route tests initially failed before the
runtime fixes and fixtures were added. Final verification passed as follows:

| Check | Review-correction result |
|---|---|
| Focused correction suite | 4 files, 71/71 tests passed |
| `pnpm check` | Passed |
| `pnpm build` | Passed |
| Unit suite | 81 files, 939/939 tests passed (`--maxWorkers=2`) |
| Integration suite | 17 files, 191 passed, 2 intentional skips |

The final Gate 2 no-commit revert was rehearsed again after history
reconstruction; it applied without conflict and matched the reconstructed Gate
1 parent exactly.
