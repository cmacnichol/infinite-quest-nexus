# Character editor usability acceptance

Evidence recorded on 2026-11-15 in the implementation worktree. The automated character-editor acceptance checks passed with the platform and opt-in skips listed below. This record distinguishes fixture-browser tests, real PostgreSQL, composed browser/API/database tests, and deterministic-provider tests.

| Gate | Evidence |
| --- | --- |
| A0 — State Edit precedence and V3 | `campaign-cast-v2-context.integration.test.ts`, `campaign-cast-generation.integration.test.ts` (frozen V2/V3 retry), `story-continuity-review.integration.test.ts` (frozen V3 review, repair and resume), `campaign-cast-context.test.ts`, `cast-v3-readers.test.ts`. PostgreSQL and deterministic-provider evidence; the latter is not a live-model quality test. |
| A1 — rosters, status, search and provenance | `campaign-cast.e2e.test.ts`, `unified-character-editor.e2e.test.ts`, `web-next-characters-sheet.e2e.test.ts`: fixture browsers. [Nexus roster](assets/character-editor-usability/roster-legacy-1440.png), [narrow roster](assets/character-editor-usability/roster-legacy-390.png). |
| A2 — sheet editing and request boundaries | `character-sheet-changes.test.ts`, `character-sheet-view.test.ts`, `unified-character-editor.e2e.test.ts`, `web-next-characters-sheet.e2e.test.ts`; opt-in `world-library.integration.test.ts` saves, undoes, and reloads Main, Added, Starting Cast and Discovered sheet names through actual API and PostgreSQL in both clients. [Web-Next sheet 390 px](assets/character-editor-usability/web-next-web-next-sheet-390.png), [composed Web-Next retraction](assets/character-editor-usability/composed-web-next-retracted.png). |
| A3 — Undo, provenance, conflicts and retraction | `character-sheet-changes.test.ts`, `character-sheet-view.test.ts`, `campaign-cast.e2e.test.ts`; composed `world-library.integration.test.ts` checks both competing-write windows for an Added Character in each client and retracts a later location Observation to restore an earlier State Edit across reload. Other character-type race coverage is fixture/unit evidence; the composed test also checks an isolated campaign and pinned world. |
| A4 — Web-Next parity | `web-next-characters-sheet.e2e.test.ts`, `web-next-characters-lifecycle.e2e.test.ts`, `campaign-cast.e2e.test.ts`. Fixture-browser evidence and composed database/browser proof are distinct. |
| A5 — world workspaces | `nexus-character-workspace.e2e.test.ts`, `nexus-protagonist-workspace.e2e.test.ts`, `nexus-roster-mechanics.e2e.test.ts`, `web-next-character-edit-entry.e2e.test.ts`: desktop, 390 px and keyboard. [Nexus workspace](assets/character-editor-usability/workspace-1280.png), [390 px](assets/character-editor-usability/workspace-390.png), [Web-Next review 390 px](assets/character-editor-usability/web-next-review-390.png). |
| A6 — section refinement | `character-section-refine.test.ts`, `character-section-refine-panel.test.ts`, `nexus-character-workspace.e2e.test.ts`, `web-next-character-workspace.e2e.test.ts` exercise unsaved candidates, section-only changes, cancellation and stale results using deterministic fixtures. [Nexus 390 px](assets/character-editor-usability/nexus-refine-390.png), [Web-Next 390 px](assets/character-editor-usability/web-next-refine-390.png). |
| A7 — regression suites | Full static, unit, PostgreSQL and rendered-browser results are listed below; a skip is not a pass. |

## Review findings

1. V3 reader rollout: A0, `cast-v3-readers.test.ts`, the V2/V3 PostgreSQL capture/retry cases, and deterministic review/resume.
2. Tracking gaps and authority: A0, `campaign-cast-v2-context.integration.test.ts` and `campaign-cast-context.test.ts`.
3. Retracted provenance: A3, `character-sheet-view.test.ts`, `campaign-cast.e2e.test.ts` and composed retraction.
4. Saved/Undo across refresh: A3, `character-sheet-changes.test.ts`, `web-next-characters-sheet.e2e.test.ts` and composed save/Undo.
5. Inverse operations: A2–A3, `character-sheet-changes.test.ts` and fixture browser sheet tests.
6. Intervening writes: A3, `character-sheet-changes.test.ts` and sheet/browser fence cases.
7. Unsaved refine candidate: A6, `character-section-refine.test.ts` and both workspace browser suites.
8. Browser evidence: A4–A7, desktop and narrow cases, native-zoom metrics and composed proof below.

## Native 200% zoom

Chromium tab zoom was set and read back through a disposable extension; CSS zoom and reduced viewport are not treated as native zoom. [Nexus world editor](assets/character-editor-usability/nexus-native-zoom-200-editor.png) ([metrics](assets/character-editor-usability/nexus-native-zoom-200-metrics.json)); [Nexus sheet](assets/character-editor-usability/nexus-sheet-native-zoom-200-edited.png) ([metrics](assets/character-editor-usability/nexus-sheet-native-zoom-200.json)); [Web-Next world](assets/character-editor-usability/web-next-world-native-zoom-200-edited.png) ([metrics](assets/character-editor-usability/web-next-world-native-zoom-200.json)); [Web-Next sheet](assets/character-editor-usability/web-next-sheet-native-zoom-200.png) ([metrics](assets/character-editor-usability/web-next-sheet-native-zoom-200-metrics.json)). Screenshots use synthetic fixtures.

## Post-review corrections (2026-11-15)

A whole-branch review against the spec found that V3 capture omitted unedited current-state fields while tracking was `pending` or `failed`. `pending` is the normal status after each accepted turn, so the narrator would often have lost every unedited character's location, condition, clothing and goals. V2 sends them as dated last-known state. The spec wording caused this. V3 now matches V2 for unedited fields and keeps the new rule for State Edits. The incomplete-tracking notice and B2, B3, A0, ADR 0045 and the plan were corrected to match. Smaller fixes in the same pass:

- The V3 authority contract places "including intentional empty values" on corrections.
- Toggle feedback reads "Pinned.", "Unpinned.", "Ignored." or "No longer ignored.".
- The clear-edit action reads "Clear my edit" when no fact Observation exists.
- The retraction confirmation shows the current value before the resulting value.

Verification after these fixes: `pnpm check` passed. Twelve focused unit files passed, 307 tests (cast context, V3 readers, provider composition, sheet changes and view, both cast controllers, projection, provenance, continuity adapter, planner, prompt library). Real PostgreSQL suites passed: `campaign-cast-v2-context` (1), `campaign-cast-generation` (13), `story-continuity-review` (116; one assertion updated from omission to inclusion), `campaign-cast-repository` (35) and `story-memory-enrollment` (14). The fixture-browser suites `web-next-characters-sheet`, `unified-character-editor` and `campaign-cast` passed, 132 cases. The full `pnpm test:integration`, the native-zoom suites and the opt-in composed proof were not rerun.

## Second review corrections (2026-11-15)

A fresh spec review found, and this pass fixed:

- **B23:** Web-Next refine compared a trimmed captured candidate with the raw unsaved one. Any trailing whitespace made every proposal stale. Both sides now compare the validated form.
- **B7:** list fields put the per-entry limit on the whole textarea. Limits now apply per entry, with a maximum entry count, and are checked on Save.
- **B7:** Escape on a dirty inline editor now asks before discarding.
- **B7 and constraints:** sheet inputs use the limit of the character's write path. Campaign edits accept 2,000 characters (goals 20,000); authored Starting Cast fields keep their registry limit. The Web-Next editor uses the same limits.
- **B8:** in Nexus, Reload now clears "Could not refresh this character." even after Undo is gone.
- **B4:** roster summaries are at most 120 code points, including the ellipsis.
- **B14:** in the Web-Next editor, Name and Aliases sit inside the Identity group.
- **B21:** the Web-Next button reads "Organize notes with AI…". Story always offers it for a saved world, not only when retained guidance exists.
- **Constraints:** `seededCharacterFieldPolicy` uses the contracts `isCastStateField` instead of a second copy of the list.

New tests cover each item, plus an older-search-response race in Web-Next and the existing clear-on-empty behavior for current-state edits. Six of the new tests failed against the previous code; the race and the empty-state tests were coverage gaps only. Verification: `pnpm check` and `pnpm check:client-boundaries` passed. Sixteen unit files passed, 219 tests. The fixture-browser suites for both sheets, the Web-Next editor and workspaces, and the Nexus character workspace passed, 164 cases. PostgreSQL, native-zoom and composed suites were not rerun; this pass changed no server code.

## Results and release boundary

- **Passed before review fixes (`63cf1618`):** `pnpm check`, `pnpm check:client-boundaries`, `pnpm build:web:legacy`, `pnpm build:web:next`; the Next build retains unresolved-at-build-time font and large-chunk warnings.
- **Passed before review fixes (`63cf1618`):** `pnpm test:unit`: 451 files, 5,822 passed, 44 skipped, zero failed. On Windows, skipped cases are guarded by Linux/secure descriptor-anchored filesystem or POSIX permissions: archive-io 4, asset-archive-service 1, credential key 1, portable filesystem adapter 13, persisted filesystem 10, secure filesystem 13, preview session 2.
- **Passed before review fixes (`63cf1618`):** opt-in composed `world-library.integration.test.ts`: 37 passed, zero skipped. It uses actual API and isolated PostgreSQL with synthetic data. Both clients saved and undid all four character types, reloaded, fenced Added Character competing writes before and after refresh, and retracted later location evidence to restore an earlier State Edit.
- **Passed with skips before review fixes (`63cf1618`):** `pnpm test:integration` ran all 161 files against isolated PostgreSQL: 1,834 passed, 203 skipped, zero failed. Of the skips, 193 are Windows platform/secure-filesystem guards, one is an opt-in historical benchmark, two are optional old-reader rehearsals, six are opt-in known-failure baselines, and one is the composed browser case run separately above. These skipped cases are not passes. The cast, story-memory and world-library database suites executed; the Windows campaign ZIP placeholder in story-memory compatibility remains skipped.
- **Passed:** the complete required and affected fixture-browser suites were rerun against production source at `63cf1618`: 192 passed, zero skipped. This run predates subsequent whole-branch review fixes. The original run failed 34 cases and the next run failed one; their corrected selectors and the keyboard focus regression were rerun as recorded in the task report. The composed screenshot was recaptured after scrolling the retraction label into view.
- **Passed after review fixes (`6a8e88ca`):** 149 focused unit cases cover the Web-Next workspace and V3 prompt, policy, and context contracts; eight fixture-browser cases cover editor recovery, conflict and sheet interactions at desktop and 390 px. Real PostgreSQL cast context/generation suites passed 14/14; the deterministic-provider frozen V3 review/resume test passed both selected cases, with 114 unrelated cases filtered out. These are targeted checks, not a repeat of the earlier full browser or composed runs.
- **Skipped:** physical mobile keyboard and live text model/provider; fixture browsers, native desktop Chromium zoom and deterministic provider are not evidence of either.

Task 3b intentionally changed the initial retry design: the job stores a cast fingerprint, not its fiction snapshot. If cast authority changes, including tracking catching up, recapture fails stale and a fresh job is required; unchanged V2 keeps its frozen protocol. Operators must install V3-compatible API and worker readers throughout the fleet before enabling V3 enqueue and retain them while V3 jobs or turns remain. No fleet capability handshake guarantees that ordering. See [ADR 0045](../architecture/0045-current-state-edits-yield-to-newer-story-evidence.md) and [release notes](state-edit-precedence-release-notes.md).
