# Characters revamp verification

Status: implementation complete with local verification recorded below. Existing platform/opt-in skips and live rollout validation remain explicit limits. This is not deployment approval.

Worktree: `codex/characters-revamp`, based on `6cd29919`. The implementation is committed, followed by a separate review-fix commit (see [Review fix round](#review-fix-round)). The implementation follows the [master plan](../../superpowers/plans/2026-11-06-characters-revamp.md), including the amended October auto-match policy. Terra subagents implemented bounded tasks; the coordinator integrated persistence, review, compatibility and verification fixes.

## Delivered behavior

- Both Story clients have character browsing, desktop roster-and-sheet layout, mobile list/detail navigation, source evidence, lossless profile forms, filters, draft-safe refresh, manual corrections, pin/ignore and explicit historical scans. Protagonist and supporting-cast authorities remain separate.
- Identity review and withheld-detail review remain separate decisions. Confirming one detail creates one user override, including an intentional blank. Dismissal creates no fact.
- Optional unique-name matching captures the policy and trusted prompt at admission. Automatic attachments retain durable evidence and can be undone after branch, transfer, Campaign Archive or System Archive restore.
- Provider-free lexical mentions record textual recency separately from observation and presence. Optional failures cannot reject accepted story. Detach removes overlapping attributed mentions without deleting unrelated references.
- Explicit context estimates share generation selection and budget logic, with current authority, private-data exclusion, selection/omission reasons and freshness information. Preview makes no provider request or state mutation.

## Verification evidence

| Check | Result |
| --- | --- |
| `pnpm check` | Passed; includes repository data safety, contracts/services and both client type checks. |
| `pnpm build` | Passed after final UI changes; existing Vite large-bundle advisory remains. |
| `node scripts/check-client-boundaries.mjs` | Passed. |
| `pnpm test:unit --exclude '**/.worktrees/**' --exclude '**/.codex/**'` | 400 files passed; 5,305 tests passed and 44 existing skips. Subsequent focused changes have their own passing runs below. |
| Full isolated PostgreSQL integration runner | Completed all 132 files: 123 passed, nine entirely skipped; 1,608 tests passed, 199 skipped. |
| Existing campaign-cast Playwright suite | 26/26 passed after final desktop layout, conflict navigation, context-budget and undo-label changes. |
| Final diff, UTF-8 and local Markdown links | Passed; local document links resolve and changed text is valid UTF-8. |

Windows package-manager linking required normal host permissions. The initial restricted run's link failures are not counted as passing checks. The full integration run uses a dedicated pgvector/PostgreSQL container and per-file databases, without changing the existing shared test database. It first stopped at file 49 because existing tests enumerated migrations only through 0116. Expectations in three existing suites now include 0117-0120; the identical isolated runner resumed at the failed file. At file 100, the archive portability inventory exposed missing classification for attachment metadata and the operational workspace revision. The registry was corrected, the archive suite passed, and the runner resumed through file 132. Earlier passing files are retained as evidence, not claimed as rerun. The combined completed run has no failing test files. Existing skips include unsupported secure generated-asset staging on Windows/Linux-only workflows, opt-in historical benchmarks, and known-failure baselines; none is claimed as passing.

Additional focused evidence includes 107 discovery/backfill/API/portability PostgreSQL cases; 18 status/API/context-generation cases; 20 corrected-source lifecycle/portability cases; nine System Archive portability cases; and eleven lifecycle cases including attachment undo after cross-world transfer. Post-review context planner/executor/serializer suites passed 240 cases, affected Story suites passed 249, and recent-filter/old-server-fallback checks passed. These overlapping runs are not summed as distinct coverage.

The two-case checkpoint fixture compares strict and relaxed name-only identity matching: strict leaves one identity-review item and no automatic attachment; `unique_name` leaves zero identity-review items and one reversible attachment. Both recover from durable checkpoints with zero provider executions. Explicit ambiguity fixtures reject false joins. This small deterministic comparison is not a live quality benchmark.

## Browser evidence

Fixture-backed rendered checks cover both clients at 1440px and 390px, profile save, source expansion retained across refresh, context preview, match review, detail confirm/dismiss and attachment undo. Existing workflows cover scan preview/start/pause/resume/cancel, retry/conflict recovery, long lists and draft preservation. Sanitized screenshots are in [screenshots](../assets/characters-revamp/), including [replacement sheet](../assets/characters-revamp/sheet-next-390.png), [legacy profile](../assets/characters-revamp/profile-legacy-390.png), and [replacement context](../assets/characters-revamp/context-next-390.png).

A 720x500 reduced-motion viewport passes pointer Close and focus return. Actual native 200% Chromium zoom was then verified through the browser zoom API in an isolated temporary extension: zoom 2, CSS inner width 713, device pixel ratio 2.5 at a 1440 window. Both dialogs opened and pointer Close succeeded. [Legacy](../assets/characters-revamp/native-zoom-legacy.png) and [replacement](../assets/characters-revamp/native-zoom-next.png) captures are cropped at 891x566 because of an unresolved capture/zoom mismatch; they do not establish full-viewport fit. Geometry assertions and successful pointer clicks establish control reachability. Ordinary desktop/mobile screenshots remain the visual layout evidence. Synthetic CSS body zoom was not used as native-zoom evidence. Browser fixtures do not establish real database or live-provider behavior. The match target chooser loads all paginated targets but does not provide a separate target-search field.

## Review and minimal-test policy

Independent reviews led to fixes for source segment offsets, forged archive attachment membership, stale lexical-range round trips, null-recency fingerprint compatibility with old jobs, efficient status polling, stale campaign actions, pagination and retry-key reuse. Final review also fixed conflict navigation and source-scoped dismissal across repeated scans. The full 59-case discovery suite and eight-case API/status suite passed after those changes; ten application/session/API unit checks cover the separate conflict filter. Final UI panel/tools suites passed 33 tests.

Only two new behavioral suite files were added: workspace-session races and lexical mention matching. All other coverage extends existing suites for changed behavior or concrete regressions. No new benchmark harness, 100-turn corpus or duplicate renderer suite was introduced. The optional candidate-addressed undo adapter was unnecessary because no caller exists; the durable event-addressed operation is used by both clients.

## Rollout and verification limits

Apply additive migrations 0117 (attachment metadata), 0118 (detach review and scoped candidate ownership), 0119 (detail decisions), and 0120 (workspace invalidation revision). New matching remains off by default. Strict admissions use `cast-discovery-prompt-v1`; effective auto-match admissions capture `unique_name` with `cast-discovery-prompt-v2`. Output remains `cast-discovery-v1`. Disabling only auto-match stops new relaxed admissions while captured jobs can drain; disabling discovery stops claims/publication.

Cast archives export v2 and read v1/v2. Old v1-only binaries are not safe rollback targets after v2 writes. Deploy compatible readers before enabling writers; retain additive migrations. Operational dismissals/receipts/jobs are not portable, while confirmed overrides and undo authority are. See the [operations runbook](../../runbooks/campaign-cast.md).

Context preview uses compatible locally saved direct/preset wire settings and the shared serializer; continuity review uses the same estimator and separate reviewer cap. Missing compatible preset/custom-reviewer settings report unavailable. Direct models without saved settings disclose configured-limit estimates. Later action assessment, routing and state changes can alter actual generation selection.

Live text/image providers, paid scans, production enablement and copied-campaign rollout canaries were not run. No deployment or production database was changed. These remain operator validation, not passing local checks.

## Review fix round

A post-implementation review found the issues below; the [fix plan](../../superpowers/plans/2026-11-06-characters-revamp-fixes.md) records them. All are fixed in the follow-up commit:

- Lexical mention tracking now runs only while `CAST_AUTO_MATCH_ENABLED` is effective, on accepted turns and narration corrections. Before, it ran whatever the flags said.
- Migration `0120` uses statement-level triggers. Discovery-job lease and checkpoint writes, and turn updates other than narration changes, no longer bump the workspace revision. Migrations `0118` and `0119` refuse to roll back while they hold review data. Migration `0120` removes only its operational counter and invalidation triggers on rollback.
- The replacement client's roster shows provenance, Pinned/Ignored and server-reported Needs review / Conflicting details markers. Both clients label the Recent filter with the server's window.
- The replacement client edits the main character inside the Characters sheet through the revisioned `/character-profile` endpoint. A conflict keeps the draft.
- The roster filter predicate now lives in `client-core`. Sheet locks list manually corrected fields. A revision change during pagination restarts once immediately. The lexical matcher merges a name with a longer alias of the same character, and it skips sentence-initial common-word names.
- Screenshots moved to `docs/review/assets/characters-revamp/`. The e2e profile fixture now returns the strict update response shape. Before, a failed save went unnoticed because the test only checked that a request was sent.

Fix-round verification (2026-11-06): `pnpm check`, client-boundary check, `pnpm build` and the whitespace check passed. 16 affected unit files passed (521 tests). Eleven focused PostgreSQL files passed: cast lifecycle, discovery, API, generation, portability, migrations, generation execution, generation, narration corrections, generation events and the adapter matrix. That is 235 tests, with 6 existing Windows filesystem-staging skips not counted as passing. The cast Playwright suite passed 26/26. The full unit and full integration suites were not rerun in this round.

## Publication review

Reviewed the other agent's `c6466249...8c953a1a` update against the plans and repository rules before publishing. No additional trigger, lexical-gating or authority-boundary defect was found in that review. Three follow-up corrections are included:

- A server-rejected `cast_revision_conflict` during pagination now restarts once with fresh status. Repeated conflicts retain the last successful roster and enter the existing backoff. The new case in the existing session suite failed before the fix and passed afterward.
- Each character's attention response now includes optional review/conflict counts, which the replacement roster displays. Existing scoped caching and older-server boolean fallbacks remain intact.
- The new in-sheet protagonist editor blocks cancellation and further edits while saving/loading, guards responses by editor identity, resets on opening another campaign and clears the sheet grid when opening the form. Its existing browser journey now delays the save and verifies the stored value after completion.

Publication verification: `pnpm check`, `pnpm build`, client-boundary check and 19 focused application/API/session/matcher unit tests passed. The existing PostgreSQL discovery suite passed 59/59 after the count change. The full existing cast Playwright suite passed 26/26 after the follow-up, including delayed-save guards, persisted profile values and roster review counts. Desktop/mobile roster and in-sheet profile screenshots were refreshed. No new test suite or migration was added in this round. Earlier complete-suite results above remain baseline evidence; only affected checks were repeated for this publication review.
