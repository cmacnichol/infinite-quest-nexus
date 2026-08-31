# Quiet Leaf implementation acceptance

Status: opt-in module implementation under final code review; **not released or default-enabled**. The user explicitly deferred further visual work, keeping the current layout unchanged until after module implementation. This is not approval of the rendered design.

## Implementation checkpoint

Code candidate: `a9617230a84aec55d4683f8e2f91240239efedce` (linked worktree823c).
This checkpoint preserves the existing preview without another visual change.
Final whole-branch code review is pending; release/runtime gates below remain
separate from completing the opt-in module handoff.

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
| G2 theme/preferences | Partial | Theme suite:43 passed; display preferences:14 passed. Rebuilt Core browser set39/39 passes across three engines, including local/server preference separation and390–3440px width checks. Fresh visual review remains separate; screenshots still show footer layout defects. |
| G3 component behavior | Pass for scoped browser set; wider matrix partial | Rebuilt39/39 Core browser instances cover draft height/growth/shrink/clear, stable caret, valid radio keyboard sequence, choice identity, retry preparation, length dialog, preferences, and navigation. Full IME/200% zoom/state matrix is not claimed. Passing interaction checks do not certify layout quality. |
| G4 Story regression | Pass for unit/source checks; runtime pending | Full unit run:228 suites/2,687 tests passed,48 skipped; one sandbox-blocked build-contract suite then passed4/4 on an elevated focused rerun. `pnpm check`, client boundaries, root strict TypeScript, and strict browser-fixture TypeScript pass. Runtime/provider behavior remains a separate gate. |
| G5 runtime/visual approval | Runtime blocked; visual work deferred by user | No disposable runtime parity run or visual approval. Two independent full visual reviews returned rebuild; footer composition and mobile Turn Length findings are deferred by explicit user direction. All15 runtime smoke rows remain Blocked. |
| G6 bundle/rollback | Pass for local build/comparison scope; release pending | Native navigation9/9 passes across three engines on the current source. Native entry163,612bytes (159.77734375KiB) versus Core176,924bytes (172.77734375KiB), a13KiB increase. Core app/fixture restored. Earlier native image build succeeded; no deployment or final-candidate container parity claim. |

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
`2346498`, and the current frozen preview `a961723`. The latest39 Core cases
use the production/test source now checkpointed in `a961723`;9 native cases
were rerun on that same source and pass. These are not a release candidate.

The rebuilt Core app (312 modules) and fixture (259 modules) both build
successfully. `playwright test --config playwright.web-awesome.config.ts`
passes39/39. Live engine probes report Chromium151.0.7922.34, Firefox153.0,
and WebKit26.5; Playwright is1.62.1. The post-rebuild focused unit run passes
12 suites/105 tests, without counting those overlapping cases again in the
earlier full-suite total. Post-rebuild `pnpm check`, strict browser-fixture
TypeScript, and `git diff --check` also pass.

Toolchain: Node24.18.0, installed pnpm11.19.0 (repository/Docker pin11.24.0),
Vite7.3.6, Core3.12.0. Browser fixtures run under the application CSP with
synthetic data. The bundle reporter measures each manifest JavaScript chunk
individually, not total transferred application assets; its entry delta is
13,312bytes (about8.14%). Its budget remains report-only.

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
Native comparison has since passed; whole-branch code review is in progress.

Current local evidence is under `.impeccable/review/`: `desktop.png`,
`mobile.png`, `user-2560.png`, and `light-desktop.png` are full-page captures
from the top; `hero-repro.png` is the1635×962 comparison viewport. They are
review captures, not accepted screenshot baselines. The rebuilt captures wait
for fonts and have dimensions1635×1650 desktop/light,390×2169 mobile, and
2560×1650 ultrawide; the comparison viewport is exactly1635×962.
The changed-target CSS detector returned an empty finding list;
that static result does not override the visual review.

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
