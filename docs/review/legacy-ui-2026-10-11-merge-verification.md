# PR 187 merge verification — 2026-10-11

This review resolves the nine conflicts between the legacy UI usability branch and current `main`. It preserves both the desktop-first reading/setup work and main's persistent Activity history, access verification, and provider diagnostics. The original implementation evidence remains historical; this document records renewed checks of the combined revision.

## Revision and scope

- PR: https://github.com/cmacnichol/infinite-quest-nexus/pull/187
- First parent: `5d8d06ec5cf015d3e42ff0ed241d9339960de648` (`codex/legacy-ui-usability`).
- Merged main parent: `ac4760c95b3091e931c999ff4e92b4bcf917a226`.
- Resolution uses an ordinary two-parent merge, without rewriting branch history.
- Work occurred in the existing isolated legacy UI implementation worktree. The primary checkout and its unrelated untracked campaign-cast plan were left untouched.
- Database migrations and provider/runtime changes brought in by main are existing base changes, not new PR-owned migrations or provider changes.

## Conflict decisions and reasoning

| Files | Resolution | Reason |
| --- | --- | --- |
| `apps/web/public/story.html` | Keep the reader/recovery controls and main's accessible Activity title and 30-day persistence explanation. | Reading should remain simple while Activity accurately describes its durable server history. |
| `apps/web/src/composition.ts` | Compose draft/history/preferences adapters together with main's Activity API, controller, cache and platform. | Neither independent feature should disappear through import or factory conflict resolution. |
| `apps/web/src/story.js` | Preserve bounded turn/history loading, draft/submission provenance, stream batching, independent image loading and coalesced polling. Integrate persistent Activity observations, session/access verification, lifecycle cleanup and restoration. Remove obsolete in-memory activity calls. | Unbounded eager reads and stale callbacks would regress usability or campaign isolation. Main's privacy checks must remain independent of the reader's data load. |
| `packages/client-core/src/index.ts` | Export UI policies/storage together with all three Activity exports: types, cache and controller. | Both feature sets must remain available through the public package boundary. Independent review caught and corrected an initially omitted Activity export set. |
| `packages/client-web/src/index.ts`, `packages/contracts/src/index.ts` | Retain both parents' additive exports. | Consumers need the new reader interfaces and main's Activity/provider contracts. |
| `tests/unit/story-player-composition.test.ts`, `tests/unit/story-player-ui.test.ts` | Combine both parents' expectations and add deferred finalization race coverage. | Textual conflict resolution alone does not prove async callbacks remain scoped to their current campaign/load. |
| `docs/workflows/testing.md` | Retain both parents' documented test guidance. | Both supported feature areas require discoverable verification instructions. |

Activity activation, reader-window changes and campaign-load sequences remain separate identities. Illustration, submission, monitor and completion callbacks check their captured scopes before writing current state. Finalization now rechecks scope after awaited draft cleanup, reconciliation and draft restoration. Its missing-preview fallback also checks the scope of the reload it started before restoring the viewport. Two VM regressions execute the actual extracted finalizer against deferred operations, including same-campaign supersession; the old finalizer reproduced stale mutations in a separate sensitivity probe.

Two browser fixture files also required compatibility updates. Undo now opens `More story actions`; a mocked 404 expects the persistent `Campaign not found` recovery panel. The bounded-reader fixture returns a schema-valid empty Activity page and expects two sync-status reads: one reader hydration and one independent Activity access proof. It still asserts bounded startup/paging, no eager full history, and no campaign writes. Access verification was preserved rather than removed to satisfy an obsolete one-read expectation.

## Renewed verification

Environment: Windows, Node `25.8.0`, pinned pnpm `12.4.1`. Commands ran against the combined source. Ignored worktree/archive copies were excluded from unit discovery.

| Check | Result and boundary |
| --- | --- |
| Frozen-lockfile install | Passed, exit 0; no lockfile change introduced by resolution. |
| `corepack pnpm check` | Passed, exit 0 after the final source/test edits; repository safety, TypeScript and JavaScript checks included. |
| `corepack pnpm build` | Passed, exit 0 after final source edits; both clients and precompression built. Existing large-chunk warning remains. |
| Full unit suite | Passed, exit 0: 398 files, 5,257 passed and 44 platform skips. Ran with `--maxWorkers=4`, with no competing browser or integration run. |
| Story UI regressions | 130 passed in the focused file, including both finalization races. |
| Six selected rendered browser suites | 62 distinct cases passed across the combined run and final Activity rerun; one conditional native BFCache case skipped because Chromium did not admit the document. The six-suite run recorded 61 passes/one failure/one skip; the corrected Activity rerun recorded 26 passes/one skip. This is a reviewed union, not one all-green six-file process. |
| Real PostgreSQL | 2 files, 10 tests passed, exit 0: reader-history and Activity API integration. Used a new disposable loopback pgvector PostgreSQL container; exact owned container removed after ID verification. No shared database/container was modified. |
| Conflict and PR diff checks | No unmerged index entries or conflict markers in the nine resolved files; `git diff origin/main --check` passed. The merge's first-parent cached diff contains two pre-existing main documentation EOF-blank warnings, so this PR's whitespace check is against current main. |
| Independent review | Sol reviewed combined lifecycle/reader/Activity logic, package exports, finalization guards and browser fixture adaptations; no unresolved finding. |

The first full unit run failed: 397 files passed, one failed; 5,254 tests passed, two failed and 44 skipped. Both failures were in the unchanged runtime CLI shutdown file: a five-second timeout followed by an extra cleanup-call count. That file passed all four tests in isolation. The exact timeout cause remains unconfirmed; neither its timeout nor assertions were weakened. Initial failed browser runs and logs remain failed diagnostic evidence. No live-provider call, deployment, real-user campaign mutation, full PostgreSQL suite replay, new performance benchmark, or manual assistive-technology certification is claimed by this merge verification. Native BFCache admission remains unverified; simulated persisted-page lifecycle coverage passed.

Raw process logs, numeric exits, browser metadata/source hashes and traces are retained locally under `.superpowers/sdd/legacy-ui-2026-10-03/evidence/PR187-merge-*`. The original [implementation verification](legacy-ui-2026-10-03/verification.md) and its performance exceptions are not superseded as historical records.

## Rendered captures

These sanitized test-fixture captures were inspected after the merge. Existing main Activity screenshots were restored byte-for-byte instead of being overwritten by test output.

- [Activity diagnostics, desktop](assets/legacy-ui-2026-10-11-merge/activity-desktop.png)
- [Activity diagnostics, narrow viewport](assets/legacy-ui-2026-10-11-merge/activity-narrow.png)
- [Older accepted turn with preserved unsent draft](assets/legacy-ui-2026-10-11-merge/history-older.png)
- [Latest accepted turn and reading controls](assets/legacy-ui-2026-10-11-merge/accepted-reader.png)

The reader screenshots capture the journey's scrolled position, including the sticky navigation; they are functional merge evidence, not a new visual redesign or certification of every layout.
