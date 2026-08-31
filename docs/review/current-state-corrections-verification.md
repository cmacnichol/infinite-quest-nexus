# Current State corrections verification

Date: 2026-08-30

Implemented and verified in the isolated worktree based on `972c5c767933caf8ca0de341b2e784e37e6620db`, before PR publication. No deployment or main-checkout change was performed. The user authorized Terra subagents and a reasonable focused test set; this report replaces the original plan's exhaustive test matrix as the executed evidence.

## Delivered behavior

- Legacy Story, replacement Story, and replacement Campaign State edit Continuity Summary, Private Scratchpad, Open Threads, and Canonical Facts through the existing API. Facts and threads use individual multiline rows, with fact IDs retained automatically.
- Saves target the locked current turn and captured state revision. Historical targets, stale writes, and active/recoverable generation are rejected. Dirty drafts survive failed saves; explicit reload/cancel protects unsaved work.
- Corrections affect future generation. Accepted turns and their original private snapshots remain unchanged. The complete correction at the exact generation base turn is mandatory prompt context, including deliberate empty fields; oversized correction context raises `context_budget_exceeded`. The prompt protocol is `story-v13-current-state-corrections`.
- Ordinary saves project only changed summary/thread documents and affected fact groups. Unchanged memories, chunks, vectors, accepted fiction, and historical checkpoints remain untouched. Scratchpad-only edits schedule no Chronicle work. Eligible indexing is durably queued in the save transaction, without provider calls there.
- Rebuilds interleave accepted turns and effective corrections in chronological order. Branches, cross-world transfers, and portable imports remap generated and manually assigned fact identities before remapping supersession references. Source snapshots remain unchanged.
- Migration `0082_turn_zero_state_correction_facts.sql` permits canonical facts sourced from manual corrections at turn zero. Accepted-turn facts still require positive source/validity turns, and negative values remain invalid. No new dependency, archive version change, secret, or provider role was added.

## Verification results

| Check | Result |
| --- | --- |
| Focused Vitest units, 16 files | 280 passed |
| Focused isolated PostgreSQL integration suites, 9 files | 92 passed; 19 existing Windows secure-filesystem cases skipped |
| Playwright browser smoke, all three editors | 3 passed; desktop and 390x844 screenshots captured |
| `pnpm check` | Passed repository boundary/data checks, TypeScript checks, and JavaScript syntax checks |
| `pnpm build` | Passed shared/backend and both production UI builds |
| `git diff --check` | Passed |

Unit coverage reuses the existing state, memory adapter, worker, prompt, generation executor, and legacy/replacement UI suites. Small new suites cover the shared continuity draft, complete correction reader, and replacement editor component. The generation executor test inspects the mocked provider request and verifies the full `currentContinuity` payload with explicit empties.

The existing PostgreSQL generation case now saves all four continuity fields (including deliberately empty open threads), runs the actual worker against a local HTTP mock text provider, and checks the complete provider request. It accepts a generated fact that supersedes the corrected fact, rebuilds Chronicle, verifies the same resulting state, compares the prior accepted turn rows unchanged, and rewinds to recover the saved correction.

PostgreSQL suites executed:

```text
campaign-state-corrections.integration.test.ts
campaign-state-incremental-memory.integration.test.ts
campaign-state-replay.integration.test.ts
chronicle-repository.integration.test.ts
chronicle-chunk-repository.integration.test.ts
campaign-transfer.integration.test.ts
campaign-transfer-character-repository.integration.test.ts
generation.integration.test.ts
task-14e3d-portable-composition.integration.test.ts
```

Run these using `vitest run --config vitest.integration.config.ts` and the repository's isolated test database setup, not against a production database.

The incremental integration cases compare persisted rows before and after correction. They verify scratchpad-only zero memory/job changes, unchanged parents on fact addition, explicit clears, repeated reordered-draft no-ops, imported historical-parent preservation, complete correction budget handling, and transaction rollback when durable indexing enqueue fails. Existing chunk/worker tests cover invalidation, work-version fencing, and skipping compatible embeddings; the added worker case embeds only the changed document across paginated retrieval.

## Review and browser findings resolved

- Preserved imported turn-bound summary/thread parents rather than deleting them with the current singleton projection.
- Preserved deterministic generated fact IDs and manually assigned fact IDs consistently across campaign copies, including later supersession and rebuild.
- Allowed opening the current editor while viewing an older turn without changing its target.
- Kept Campaign Tools open during focus transfer to its menu commands, preventing a browser pointer click from being swallowed.
- Fixed the legacy adapter displaying shared structured thread rows as `[object Object]`.
- Added save/generation locks, captured-session guards, draft-discard confirmation, distinct row-removal labels, and predictable removal focus.
- Derive the open Story editor's disabled state on every render, including incoming active/recoverable generation and an in-flight save. The draft and captured revision survive lock/unlock transitions. A completed save can close only the editor session that submitted it, preserving a separately reopened editor.
- Reconstruct imported structured canonical facts inside the rich import transaction. The regression immediately reads and saves imported current state without a test-only rebuild, verifies destination IDs and chronological supersession, and retains unrelated imported fiction, summaries, threads, and checkpoints. Reconstructed canonical groups replace matching legacy parents; legacy parents without a reconstructed group remain available.

The latest behavior review identified three further issues, all reproduced before fixing:

- Turn-zero fact saves failed the old positive-turn database checks. The new PostgreSQL regression saves a fact after rewinding to zero, verifies its source and validity boundaries, rejects negative boundaries, and confirms rebuild retains its identity.
- Legacy Scratchpad tab clicks could trigger the discard dialog after the modal resized. Backdrop detection now verifies the click originated on the dialog itself before comparing coordinates; interior clicks remain interior after reflow.
- The replacement Story and Campaign State editors retained conflicted drafts but allowed repeated stale PATCH requests. A 409 now locks Save until an explicit successful reload. Cancelled or failed reloads retain the draft and lock. Reload fetches complete before replacing the editor, and the Story reload refreshes its campaign projection to support a newly advanced turn.

Review also closed a Campaign State reload race: a pending reload now locks the form and Save, and its result can replace only the captured editor session. Failed reload restores that same draft and its previous lock state. The existing cancelled-reload test now covers deferred failure and later success.

Focused tests cover each regression. The expanded three browser cases exercise all four fields, retained fact IDs, both new conflict/reload flows, and the legacy tab switch at the viewport that reproduced the defect. PostgreSQL totals above come from one combined run of all nine suites. Units, browser tests, repository checks, and builds were rerun after the final reload fix. Independent Terra reviews found no actionable issue in the Story conflict fix, turn-zero migration, or legacy backdrop guard. The focused unit set includes migration-order checks; it is not the full repository test suite.

Local screenshots are generated by the three tests in `tests/e2e/current-state-corrections.e2e.test.ts`. Working outputs remain ignored; the six selected synthetic-data captures are included under `docs/review/assets/current-state-corrections/` for PR review:

```text
test-results/current-state-campaign.png
test-results/current-state-campaign-mobile.png
test-results/current-state-story-next.png
test-results/current-state-story-next-mobile.png
test-results/current-state-story-legacy.png
test-results/current-state-story-legacy-mobile.png
```

Screenshots were inspected. Browser tests use actual rendered interfaces and pointer clicks with synthetic API responses. The legacy fixture supplies a configured text provider so onboarding does not obstruct the editor. Mobile Story dialogs scroll to lower fields and save controls.

| Interface | Desktop | Mobile |
| --- | --- | --- |
| Legacy Story | [Screenshot](assets/current-state-corrections/current-state-story-legacy.png) | [Screenshot](assets/current-state-corrections/current-state-story-legacy-mobile.png) |
| New Story | [Screenshot](assets/current-state-corrections/current-state-story-next.png) | [Screenshot](assets/current-state-corrections/current-state-story-next-mobile.png) |
| New Campaign State | [Screenshot](assets/current-state-corrections/current-state-campaign.png) | [Screenshot](assets/current-state-corrections/current-state-campaign-mobile.png) |

An additional final pass reran 280 unit tests, 62 PostgreSQL tests across the state/replay/incremental-memory/generation suites, and the three checked-in browser cases. Three temporary browser probes additionally saved, reopened, and explicitly cleared all four fields at turn zero in each interface; all passed without page exceptions. The temporary probes were kept outside the repository. Independent standards/UI-lifecycle and backend/spec reviews found no actionable regressions. The in-app Browser had previously stalled on confirmation dialogs, so rendered validation used the repository's standalone Playwright workflow.

## Practical limits and rollout

- The full repository test suite and a combined UI-to-live-API-to-live-model smoke run were not run. Browser API responses and provider executions were mocked; PostgreSQL persistence tests used real isolated databases. No external LLM or embedding provider was contacted for feature validation.
- Nineteen platform-gated portable secure-filesystem tests remain skipped on Windows. The direct rich portable import and fact-remapping tests ran and passed.
- Builds retain runtime-font resolution and bundle-size warnings. These did not prevent either production build.
- This change avoids full history projection and unrelated embedding work on ordinary saves. Eligibility/signature queries may still scan campaign records, and a changed fact group can contain several facts. No constant-time or latency benchmark claim is made.
- Apply migration 0082 through the normal runner before serving turn-zero fact writes, and deploy matching API, worker, and both UI builds together. Replacing the checks briefly locks and validates `campaign_canonical_facts`; schedule that step appropriately for large installations. No global memory backfill is needed. Preserve the current-only guard and correction-aware prompt reader when rolling back; do not delete correction history. Retain the relaxed constraints: the former positive-only checks cannot be restored while turn-zero facts exist. Full Chronicle rebuild remains a maintenance/recovery operation.

Related: [specification](../superpowers/specs/2026-08-30-current-state-corrections-design.md), [implementation plan](../superpowers/plans/2026-08-30-current-state-corrections.md), [ADR 0011](../architecture/0011-editable-campaign-runtime-state.md).
