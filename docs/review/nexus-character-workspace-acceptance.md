# Nexus character workspace acceptance

Status: implementation and verification complete; whole-change review and scoped fix review passed with no unresolved findings. No production deployment or capability activation was performed.

Baseline: `10825e9504d48c65afee8f2654903f580954fb7a`, retaining the prior three character/tracker conformance fixes. Scope follows the [design](../superpowers/specs/2026-11-14-nexus-character-authoring-workspace-design.md) and [implementation plan](../superpowers/plans/2026-11-14-nexus-character-authoring-workspace.md). The implementation was verified in the existing topic checkout before committing.

## Delivered behavior

Nexus World Library and campaign management now use quick-create for new world/manual supporting characters and a dedicated detailed editor for existing characters. Quick and detailed views share mounted controls and a draft; Continue makes no authoritative write. The workspace provides sections, local safe-text preview, destination/status, persistent actions and guarded exits. Story retains its panel default; Web-Next remains compatible.

World Apply modifies only the open world draft. Parent Save persists it. Campaign saves retain their existing controllers and revision/boundary/idempotency contracts. AI review/provenance, evidence fences, reset/clear/restore, generation locks and lifecycle gates remain in their existing workflows. No database, API, provider or prompt-protocol change was introduced.

Roster search/use filters preserve authored order and identity. Structured summaries are display-bounded. Filtered reordering is disabled. Mechanics support multiline notes/rules/values and one exact removal Undo; Supporting retains stored and unsaved mechanics. The 1,000-character limit retains a blocked new draft.

## Final verification

| Boundary | Result | Evidence |
|---|---|---|
| Repository/type/data checks | Passed | `pnpm check` |
| Client boundaries | Passed | `pnpm check:client-boundaries` |
| Both web builds | Passed | `pnpm build:web:legacy`; `pnpm build:web:next`. Web-Next retains its large-chunk warning. |
| Full unit suite | Passed | 437 files, 5,647 passed, 44 skipped. Windows skips existing Linux/secure-filesystem and POSIX-permission cases; no new character test skips. |
| Isolated PostgreSQL cast suites | Passed | 111 tests in six files: repository, lifecycle, merge, portability, generation and API. |
| Combined affected Chromium suites | Passed | 183 tests in nine suites, 2.5 minutes. An earlier helper race was fixed; the complete rerun passes. |
| Final review regression suites | Passed | 119 cases across workspace, roster/mechanics and campaign cast after the fixes, including four new regressions; 141 focused units and repository checks/build pass. Final strengthened assertions pass in a four-case rerun. These overlap the broad matrix above. |
| Composed PostgreSQL/browser flow | Passed | Full world-library file: 37 tests, no skips, 17.71s on the final source. Existing opt-in proof uses actual API/database writes and task-owned Vite. |
| Actual Chromium 200% zoom | Passed | One native-zoom case plus 16 workspace cases. Owned extension verifies tab zoom=2, CSS zoom=1, viewport scale=1; viewport 631×402, DPR2. |
| Physical mobile software keyboard | Skipped | No physical iOS/Android device available. `visualViewport` handling and narrow layouts are automated evidence, not hardware-keyboard proof. |
| Live-provider output quality | Skipped | Deterministic provider fixtures exercise preserved contracts; live-model quality is outside this presentation verification. |

Unit command: `node node_modules/vitest/vitest.mjs run tests/unit --exclude '**/.worktrees/**' --exclude '**/.codex/**' --exclude '**/.claude/**'`.

All PostgreSQL tests used `--config vitest.integration.config.ts`. The composed proof uses `NEXUS_CAST_BROWSER_PROOF=1` and a separately owned Vite port. Browser-only fixture saves are not counted as database evidence. Host permissions/cache were used where the sandbox could not access Docker, pnpm or browser executables; no package/configuration safeguards were weakened.

The final browser selection includes `nexus-character-workspace`, `nexus-protagonist-workspace`, `nexus-roster-mechanics`, `character-authoring-simplification`, `unified-character-editor`, `campaign-cast`, `legacy-ui-authoring-disclosures`, `legacy-ui-campaign-edits`, and `legacy-ui-campaign-creation`, using Chromium with two workers. Native zoom is run separately in its owned profile.

## Acceptance matrix

| ID | Evidence |
|---|---|
| U1 Context-appropriate entry | World quick/detail cases in [workspace](../../tests/e2e/nexus-character-workspace.e2e.test.ts); manual supporting quick/create and existing preset/supporting in [campaign cast](../../tests/e2e/campaign-cast.e2e.test.ts); [protagonist](../../tests/e2e/nexus-protagonist-workspace.e2e.test.ts). |
| U2 Lossless transitions | [Session units](../../tests/unit/character-world-form-session.test.ts) retain raw invalid values, extensions, hidden mechanics and selected Organize provenance; browser generation retains original ID/hidden appearance and one Apply. |
| U3 Dedicated workspace | Workspace browser assertions cover persistent name/destination/actions, section summaries, safe local preview, focus and original-control restoration. |
| U4 Mobile, zoom, keyboard | 320/390px and short-height cases, keyboard Tab/invalid focus, [actual native zoom](../../tests/e2e/nexus-character-native-zoom.e2e.test.ts). Physical software keyboard remains the explicit limitation above. |
| U5 Apply versus Save | Workspace parent409→503→retry preserves exact authored values; [authoring disclosures](../../tests/e2e/legacy-ui-authoring-disclosures.e2e.test.ts) cover local Apply, parent dirty guard and reviewed provenance. Composed proof inspects persisted world. |
| U6 Guarded exits | Back/Escape/Cancel, Keep editing, Apply-and-leave with invalid commit, campaign dirty lifecycle decisions, and [campaign navigation](../../tests/e2e/legacy-ui-campaign-edits.e2e.test.ts). Beforeunload warning does not promise draft recovery. |
| U7 Concurrency/evidence | [Unified editor](../../tests/e2e/unified-character-editor.e2e.test.ts) open/save locks and compare/reapply; campaign cast tests exact stale-evidence fences and late responses; PostgreSQL/API suites retain authority checks. |
| U8 AI/Suggest/Convert | Authoring disclosure cases retain Generate/Organize success/failure/retry and protocol provenance; simplification cases retain Suggest callback-only edits; entity-conversion units retain mapping and link behavior (no new Convert browser scenario). |
| U9 Reset/clear/restore | Pristine preset Reset/Clear/Restore and supporting Use discovered cases immediately enable visible Save and assert exactly one correct request. |
| U10 Roster usability | [Roster/mechanics browser](../../tests/e2e/nexus-roster-mechanics.e2e.test.ts) covers exact filters, alias search, authored order, duplicate independent IDs, no-matches/clear focus, filtered reorder and capacity retention. |
| U11 Mechanics preservation | Session units plus roster browser cases cover multiline values, exact row extensions/position, removal Undo and replacement by next removal. Prior Supporting edit/save/reopen regressions remain. |
| U12 Compatibility | Default Story panel assertions, Story conflict/live-lock tests, Web-Next authoring cases, both builds and unchanged API/prompt schemas. |
| U13 Lifecycle boundaries | Dirty merge/remove/promotion all stage decisions; cancellation retains draft. Discard loads a fresh sheet before preview. Existing capability/protagonist restrictions remain covered by campaign and PostgreSQL suites. |
| U14 Untrusted/large content | Safe-text preview assertions, 160-Unicode-code-point summary units, CJK/RTL/unbroken display, sparse imported profiles, 1,000-entry roster and unchanged stored content. |
| U15 Prior fixes/isolation | Full unit and cast PostgreSQL regressions, prior six conformance browser cases, composed world/campaign proof with another-campaign isolation. |

## Failures found and resolved

### PR CI follow-up

The full Chromium run on the PR found four stale expectations after the editor redesign: quick-create's Add label and new-row focus, plus Mechanics and History navigation in two existing journeys. It finished with 793 passed, four failed and three skipped. The three skips require, respectively, Chromium BFCache admission, the separate web-awesome Vite server, and the seeded loopback-TLS Compose Settings fixture. After updating those interactions, all 30 tests in the three affected browser files passed; parent draft cancellation, no-write, persistence and campaign-version pin assertions remain in place.

The historical Settings upgrade fixture now applies current migrations after replaying the frozen pre-baseline history. Its focused real-PostgreSQL run passed both scenarios, including migration 0134 and the roster request. The design's critique link now points to the immutable repository source; the documentation build passed. Two full-production-source architecture scans exceeded the default five-second unit-test timeout under CI concurrency, so their individual limits are 20 seconds; the focused graph tests passed. Remote CI must run again for the final branch before claiming it passes.

Task reviews caught unknown extension text satisfying guidance validation, mismatched presentation types, disabled-control restoration after AI, blocked-save focus timing, missing refresh after policy actions, and lost adjacent-section selection. Browser work also found production-host footer clipping, text-blur navigation refresh, hidden duplicate warnings and sparse profile access. Each received a regression and scoped rerun.

Final broad checks caught Vite-only literal test imports and a CSP source-scanner false positive on a local `onInput` variable. Runtime URL imports and a neutral local name resolved them without weakening checks. The native 200% test exposed only 53px of editing space; short-height selector/footer layout now provides 192px, keeping the focused aliases field above the footer with all actions reachable. Final visual inspection also caught a populated-section summary lag; capturing the form before presentation refresh fixes it, while ignoring the section selector preserves navigation. The regression passes with 17 native-zoom/workspace browser cases and 141 focused unit tests; repository checks and the affected web build pass again.

The whole-change review identified browser Back dismissing the parent before a dirty character, inaccessible invalid mechanics after switching to Supporting, lost roster focus after Apply, and a machine-specific screenshot path. All four were fixed with regressions: child-first dismissal, per-session error recovery that reveals retained mechanics through correction, stable-ID roster focus with a filtered-heading fallback, and configurable/Playwright-local evidence paths. Four new browser cases first failed at those defects and then passed.

## Screenshot evidence

Artifacts are in `C:/Users/chris/.codex/visualizations/2026/11/14/01a1db9c-7f55-7bb1-86e2-0339be08b829/`:

- `world-quick-{1280,390}.png`, `world-generated-detail-{1440,390}.png`, `world-applied-unsaved-{1280,390}.png`, `world-save-error-{1280,390}.png`.
- `protagonist-workspace-{1440,390}.png`, `campaign-supporting-detail-{1280,390}.png`.
- `task5-roster-{1440,390}.png`, `task5-empty-{1440,390}.png`, `task5-mechanics-undo-{1440,390}.png`, `task5-removal-{1440,390}.png`.
- `final-fix-history-kept.png`, `final-fix-focus-{false,true}.png`, and `final-fix-supporting-mechanics-error.png` cover final review recovery/focus fixes.
- `composed-world-detail-1440.png`, `composed-saved-reset-{1440,390}.png`, and `composed-persistence-receipts.json` record the actual API/PostgreSQL flow.
- `nexus-native-zoom-200-editor.png`, `nexus-native-zoom-200-applied.png`, and `nexus-native-zoom-200-metrics.json`.

Desktop/mobile screenshots were visually inspected during integration; geometry assertions supplement native-zoom capture. Physical mobile-keyboard verification remains required before claiming device-level coverage.

## Implementation decisions

Work remained in the existing topic checkout to preserve the authorized uncommitted conformance fixes; review used working-tree snapshots rather than commits. This kept the existing fixes together with their regression evidence. Initial isolated shell tests used fixture mounts until real entry-point and composed database coverage was added; the final evidence includes both. Detailed execution logs remain available in the local task workspace; this report records the verification outcome.

## Deliberate deferrals

Manual/discovered supporting profiles retain their existing smaller field set. Field-specific creative generation, persistent reload/crash draft recovery, templates, portraits, image conditioning, structured relationships and Web-Next editor parity remain deferred. This work does not activate lifecycle flags or alter production configuration.
