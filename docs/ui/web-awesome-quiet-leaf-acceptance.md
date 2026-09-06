# Quiet Leaf implementation acceptance

Status: opt-in module code implemented, with scoped review limitations below; **not released or default-enabled**. The user explicitly deferred further visual work, keeping the current layout unchanged until after module implementation. This is not approval of the rendered design.

## Implementation checkpoint

### Main integration — 2026-08-31

PR #140's published checkpoint `7e2c26c` conflicted with the current-state
editor changes on main. Main through `ffd2e0d` is integrated with a merge
commit, preserving the published history. The two textual conflicts were
`campaign-editor-page.ts` and `story-player-page.ts`: the resolution retains
the shared Core shell lifecycle and the current-state editor's captured
revision, draft, save/reload, and generation guards.

Current-state editing remains available while reading an older turn, without
enabling Story submission from that historical view. A two-renderer regression
failed for that incorrect guard before its repair, then passed for native and
Core. The catalogue fixture now includes the expanded current-state view fields.

Fresh merged-tree evidence: 160 focused unit tests across 11 suites;
`pnpm check`; strict browser-fixture TypeScript; Core app and catalogue builds;
48 Core browser tests passed with 3 intentional native-only skips; and 12
native navigation/composer browser tests passed. A scoped Terra review found
no issues in the resolution. The browser plugin independently verified the
rebuilt compatibility page's named dialog open/close behavior and clean error
logs. These checks do not replace the live runtime or visual acceptance gates.

The first Core build attempt was blocked by sandbox filesystem permissions;
the same build passed with repository access. Existing runtime-font and chunk
size warnings remain. PostgreSQL/provider parity and final container parity
were not rerun; no database or deployment changed. The opt-in default and
deferred design remain unchanged. Earlier candidate evidence below is retained
as historical evidence, not silently attributed to the merged tree.

Code candidate: `839a994f585b6e17f12b7fb09ff186069db8e530` (linked worktree823c).
Final browser-test correction: `7737e17` (production code unchanged).
The frozen layout is checkpointed at `a961723`; subsequent changes repair
functional integration/native isolation, not the deferred design.
The independent Sol whole-branch review covered103 files. It found no critical
issue, but requested functional fixes before the opt-in module handoff:
preference-refresh command binding, native composer CSS isolation, menu focus
retention, retained-dialog opener restoration, and empty-choice visibility.
A smaller profile typing/acknowledgment defect was included in the same bounded
fix wave. One scoped re-review confirmed five findings addressed and verified
that preference refreshes now use the existing page render/binding lifecycle.
It kept that finding open for additional test breadth, not a remaining
identified command-binding defect. Final focused verification passes85 tests
across7 suites, plus `pnpm check`, strict browser-fixture TypeScript, and diff
checks. Release/runtime gates remain separate.

### Explicit review follow-ups

- Additional post-preference tests for narration, beginning/recovery, and
  illustration commands remain deferred. The new post-refresh test covers
  History; existing handler tests and centralized rebinding are not claimed
  as dedicated proof of every interaction combination.
- A minor focus issue remains: a prior Campaign Settings command can leave a
  stored tool-dialog opener; a later reader-opened tool such as Edit Response
  may return focus to Campaign Settings rather than its reader opener.
- The coordinator retained these as non-release follow-ups after the bounded
  fix wave. This is not an all-findings-resolved or ready-to-merge verdict.

## Retired vendor-dialog compatibility finding — 2026-08-30

The pinned `@awesome.me/webawesome` 3.12.0 dialog renders a visible title but
does not assign an accessible name to its internal native `<dialog>`. The
installed `dist/chunks/chunk.WNMOBTJK.js` render function supplies neither
`aria-label` nor `aria-labelledby` on that element. Adding `aria-label` to the
custom-element host did not label the internal dialog in Chromium.

The production-build fixture reproduced this with the unchanged application
CSP. The strict browser assertion is deliberately retained:

```ts
page.getByRole("dialog", { name: "Campaign Settings" })
```

Historically, it failed after opening the visible dialog. The in-app browser
independently showed an unnamed dialog containing the named heading. No vendor
shadow-tree mutation or weakened accessible-name assertion was accepted as a
fix.

The user accepted a bounded fallback: retain Core 3.12.0 for controls and use
the application-owned native `mountDialog()` wrapper for overlays. The wrapper
creates a labelled native `<dialog>`, uses `showModal()`/`close()`, provides an
explicit Close button, and restores a connected opener after native closure.
It does not manipulate the vendor shadow tree or implement a custom focus trap.
The incompatible `wa-dialog` import has been removed from the selected Core
stack. The upstream Core finding remains relevant if `wa-dialog` is considered
again.

An earlier fixture-only bootstrap deadlock was resolved: a top-level awaited
loader and Vite's shared-entry exports formed an evaluation cycle. Starting an
async `main()` without awaiting it at module top level allows initialization to
complete. This is separate from the retired vendor-dialog accessibility path.

## Current evidence

| Gate | Status | Evidence |
| --- | --- | --- |
| G1 Core/CSP | **Pass (scoped compatibility gate)** | Built production fixture passes in Chromium, Firefox, and WebKit (3/3): named native dialog, Close focus, Escape/opener restoration, unchanged CSP, no console/CSP errors or external requests, same-origin `regular/circle-question.svg`, input value, disabled behavior, and dropdown callback. |
| G2 theme/preferences | Partial | Theme suite:43 passed; display preferences:14 passed. Final Core matrix48 passed/3 intentional native-only skips across three engines, including local/server preference separation and390–3440px width checks. Visual approval remains deferred; screenshots still show footer layout defects. |
| G3 component behavior | Pass for scoped browser set; wider matrix partial | Final48 Core browser instances cover draft height/growth/shrink/clear, stable caret, radio keyboard sequence, choice identity, retry preparation, length dialog, preferences, navigation, retained-dialog focus, menu-update focus, and empty-choice CSS visibility. Full IME/200% zoom/state matrix and extra post-preference command combinations are not claimed. |
| G4 Story regression | Pass for unit/source checks; runtime pending | Full unit run:228 suites/2,687 tests passed,48 skipped; one sandbox-blocked build-contract suite then passed4/4 on an elevated focused rerun. `pnpm check`, client boundaries, root strict TypeScript, and strict browser-fixture TypeScript pass. Runtime/provider behavior remains a separate gate. |
| G5 runtime/visual approval | Runtime blocked; visual work deferred by user | No disposable runtime parity run or visual approval. Two independent full visual reviews returned rebuild; footer composition and mobile Turn Length findings are deferred by explicit user direction. All15 runtime smoke rows remain Blocked. |
| G6 bundle/rollback | Pass for local build/comparison scope; release pending | Native navigation/composer geometry12/12 passes across three engines on the current source. Native entry164,018bytes (160.174KiB) versus Core177,323bytes (173.167KiB), a12.993KiB increase. Core app/fixture restored. Earlier native image build succeeded; no deployment or final-candidate container parity claim. |

The scoped G1 evidence is the local Playwright executable running `test --config
playwright.web-awesome.config.ts tests/e2e/web-awesome-core.e2e.test.ts`, after
the production UI fixture build; it passed 3 tests on 2026-08-30. The wrapper's
focused LinkeDOM suite passed 4 tests. These are focused implementation
results, not an assertion that the entire repository, PostgreSQL integration
suite, provider workflow, or browser matrix has passed. Final candidate SHA,
browser/package versions, screenshots, full smoke evidence, and bundle deltas
remain required for later gates.

Reviewed local checkpoints include Core Story `21712a8`, shared shell
`8139ec5`, the first visual correction batch `d941faf`, responsive shell
`1226393`, Core legacy-status removal `fa55509`, and Task17 test slice
`2346498`, frozen preview `a961723`, functional fixes `839a994`, and the
test-only correction `7737e17`. These are not a release candidate.

The rebuilt Core app (312 modules) and fixture (259 modules) both build
successfully. On2026-08-31, the final command
`playwright test --config playwright.web-awesome.config.ts --reporter=json`
reports48 passed,3 skipped,0 unexpected failures,0 flaky tests. The skips are
exactly the native-only composer geometry case in Chromium, Firefox, and
WebKit. With a native build, the navigation file passes12/12, including that
geometry case. Live engine probes report Chromium151.0.7922.34, Firefox153.0,
and WebKit26.5; Playwright is1.62.1. Final focused unit verification passes
7 suites/85 tests; it is not added to the overlapping earlier full-suite
total. `pnpm check`, strict browser-fixture TypeScript, and `git diff --check`
also pass on the functional candidate.

An earlier new menu-focus test called textbox `fill()` after focusing a menu
item, then incorrectly expected the menu to retain focus; draft typing also
does not publish a Story update. WebKit exposed that test error. The corrected
case uses a programmatic turn-length change, asserts its value and retained
menu focus, and passes in all three engines. This did not require another
production change. JSON reporter output establishes the final skip counts;
scheduled test names in the line reporter were not treated as executed passes.

Toolchain: Node24.18.0, installed pnpm11.19.0 (repository/Docker pin11.24.0),
Vite7.3.6, Core3.12.0. Browser fixtures run under the application CSP with
synthetic data. The bundle reporter measures each manifest JavaScript chunk
individually, not total transferred application assets; its entry delta is
13,305bytes (about8.11%). Its budget remains report-only.

`pnpm check` passes, including both web package checks, root strict TypeScript,
repository/data safety and JavaScript syntax checks. The separate strict
Bundler-mode browser-fixture check also passes. Browser-only fixtures are
explicitly checked in their correct build environment rather than pulling
frontend Vite imports into the NodeNext server check. Generated fixture output
is narrowly ignored; the boundary scanner itself was not weakened.

The full unit command's sandbox-blocked build hook was rerun with
`VITE_UI_COMPONENTS=web-awesome` using the local Vitest binary outside the
sandbox; all four build-contract tests passed. The combined evidence is
2,691 passing tests across those two runs, with48 skipped; it is not a claim
that a single uninterrupted full-suite command passed.

The runtime harness requires `IQ_UI_RUNTIME_BASE_URL` and
`IQ_UI_TEST_CAMPAIGN_ID`. The missing-configuration invocation fails clearly
before running tests: **Blocked**, not Pass or a code-failure RED. The supplied
Compose UI-test overlay has fixed resource names, so a unique project name alone
does not prove isolation. All 15 real-runtime smoke rows remain Blocked.
The regular integration runner also uses a fixed-name shared test service.
This worktree lacks its `.env.test.local`, and generating new credentials could
reconcile that existing service incorrectly. The PostgreSQL suite was not run;
no existing service or volume was recreated.

## Container build and rollback

`docker build --build-arg VITE_UI_COMPONENTS=native -t infinitequest-nexus:823c-ui-native .`
completed successfully, including the in-container `pnpm build`.
Image: `sha256:58973a11d7472eae97e7c77bcff6a61407cdc1f0ebb710affd6f7e85786d0096`.
The argument is build-stage-only and absent from runtime `ENV`. This proves a
native image can be built; no container was started and no deployment,
database, or volume was changed. It does not substitute for browser or runtime
parity. Later Core-only visual changes require a refreshed final-candidate
record before release.

## Visual evidence

The coordinator inspected the built catalogue in light/dark at 1635×962,
dark mobile390×844 and ultrawide2560×1080, alongside the approved A revision3
comp. The first pass found duplicate Retry/turn headings, overly filled
two-column choices, and cropped portrait art. The reviewed correction keeps
Undo and native behavior, removes only redundant Core chrome, makes choices
full-width, and preserves portrait art. The second inspection used the actual
app with schema-checked fictional API fixtures, in all four views. The independent
review returned **rebuild**: compact the history/header framing, broaden the
narrative/art composition, bring the draft/footer into the approved1635×962
fixture viewport, and unify secondary controls. It also found a wrapped Clear
label and unreadable light-mode artwork caption. A coordinated rebuild has
been implemented and behaviorally checked. The fresh full visual review also
returned **rebuild**: the footer remains below the target first viewport,
with a large empty region, and mobile Turn Length controls wrap badly.
It recognizes improvements to styling, rail/art framing, and light caption
contrast, and requests visible Wide/Full ultrawide evidence beyond the current
Auto-width screenshot. The width behavior assertions pass, but are not visual
approval. After the second rebuild verdict, the user directed that the layout
remain unchanged while the module is finished. Those visual findings and the
durable Story DESIGN/sidecar update are therefore deferred, not resolved.
Native comparison has since passed. Whole-branch code review, the bounded
functional fix wave and its scoped re-review have completed, with the explicit
follow-ups listed above retained. No additional visual correction was made.

The code review also recorded presentation omissions: the Profile menu does
not yet show the display name, and the Story heading lacks explicit
world/version and historical-view context. These are deferred with the visual
work under the user's freeze, not silently considered implemented.

Current local evidence is under `.impeccable/review/`: `desktop.png`,
`mobile.png`, `user-2560.png`, and `light-desktop.png` are full-page captures
from the top; `hero-repro.png` is the1635×962 comparison viewport. They are
review captures, not accepted screenshot baselines. The rebuilt captures wait
for fonts and have dimensions1635×1650 desktop/light,390×2169 mobile, and
2560×1650 ultrawide; the comparison viewport is exactly1635×962.
The changed-target CSS detector returned an empty finding list;
that static result does not override the visual review.

Published synthetic review captures are retained with this implementation:

- [Desktop viewport, 1635 x 962](../review/assets/web-awesome-core/desktop-viewport.png)
- [Mobile full page, 390 x 2169](../review/assets/web-awesome-core/mobile.png)
- [Light desktop full page, 1635 x 1650](../review/assets/web-awesome-core/light-desktop.png)
- [Ultrawide Auto width, 2560 x 1650](../review/assets/web-awesome-core/ultrawide-auto.png)

These document the frozen layout, including known footer and Turn Length
defects. They predate the final functional-only fixes and are not final-candidate
visual approval, accepted baselines, or Wide/Full ultrawide evidence. The captures
contain only the synthetic Story fixture and generated test artwork; no private
campaign or Atlas reference capture is included.

The radio-keyboard test initially used unsupported Home/End keys and confused
internal accessibility nodes with public control hosts. Pinned Core3.12 handles
arrows/Space and uses roving focus. The corrected test focuses the current Auto
radio and presses ArrowRight to verify Action, Direction, then Auto by actual
checked state and host value. It passes in all three engines; no production
keyboard patch or weakened assertion was used.

The catalogue's synthetic doorway image is test-only:
`tests/ui/public/quiet-leaf-door.png`; its exact prompt and provenance are in
`tests/ui/public/quiet-leaf-door.prompt.txt`. No fixture story or image is
imported by the production application.

## Scope and safety

- Work is confined to linked worktree `823c`; main and deployed services are unchanged.
- Core is pinned; no CDN, Pro dependency, new backend API, or CSP exception added.
- Browser display preferences do not modify authoritative campaigns or profile APIs.
- Existing design artifacts and unrelated untracked files are preserved.
- Production Docker services were inspected read-only; no private campaign or volume was modified.
