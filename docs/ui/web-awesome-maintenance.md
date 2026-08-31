# Quiet Leaf Web Awesome maintenance

Quiet Leaf applies only to the replacement `/app/` Story interface and shared shell/preferences. It does not replace `/nexus/`, legacy `/story/:campaignId`, explicit replacement Story URLs, or `/app/story` campaign selection. Core is currently opt-in: an explicit `VITE_UI_COMPONENTS=web-awesome` is required by the present feature policy, while native remains the default and rollback renderer. Do not describe a build, browser, PostgreSQL, provider, visual, or release gate as passed unless its actual evidence is recorded in [the acceptance record](web-awesome-quiet-leaf-acceptance.md).

The user has deferred further visual changes until after module integration. The present Story layout is frozen, not visually approved; footer/mobile layout findings remain in the acceptance record. Do not treat the provisional layout as new durable design guidance or enable Core by default. The token/control architecture below can be maintained independently of that later design pass.

## Change map

The module foundation consists of the pinned loader and same-origin icon adapter in `src/ui/`, the semantic token/vendor-theme boundary in `src/theme/` and `src/ui/web-awesome-theme.css`, small typed Story controls in `src/story/ui/`, and browser/profile preference modules in `src/preferences/`. Story orchestration stays in the existing page/model. A future design pass can change tokens and component/layout styles without replacing generation workflows or adopting another framework.

| Future change | Primary edit | Required proof |
| --- | --- | --- |
| Palette, typography, spacing, shape | `apps/web-next/src/theme/tokens.css` | Contrast plus light/dark catalogue |
| Vendor mapping/state appearance | `apps/web-next/src/ui/web-awesome-theme.css` | Core states plus CSP browser suite |
| Story layout | `apps/web-next/src/story/ui/reader.css`, `apps/web-next/src/story/ui/composer.css` | Responsive screenshots, widths, auto-grow |
| One control's behavior | Its `apps/web-next/src/story/ui/` module | Focused RED/GREEN plus actual browser interaction |
| Global preference | Existing `apps/web-next/src/preferences/` modules | Local/server separation, storage failure, lifecycle |
| Core upgrade | Exact package pin plus icon plugin/declarations | Lockfile review, G1, browser matrix, bundle delta, rollback |

## Working rules

Application semantic tokens are the design authority. Change `tokens.css` first; map any necessary Core token in the single `web-awesome-theme.css` adapter. Use only documented public CSS parts (for example, the existing `wa-button::part(button)` and form-control parts). Do not target a Core shadow tree, copy vendor CSS into a page, or add duplicate per-page overrides for a component state.

Import an individual Core component in `apps/web-next/src/ui/web-awesome.ts` only when an owned feature uses it. Retain typed event/callback interfaces at the owning module boundary rather than passing untyped DOM detail through Story or preference code. A mount function owns every listener, subscription, and child surface it creates, and its `dispose()` must remove or unsubscribe them. In particular, callers of `mountDialog()` append the element, populate its supplied body/footer, and dispose it when their view unmounts; the wrapper owns native dialog behavior and connected-opener restoration.

Runtime strings are data: set text with DOM text APIs or route them through existing safe renderers. Never use a change as an excuse to embed mock stories, campaigns, user content, or unsafe HTML. Theme, reading width, artwork visibility, and last-visited navigation belong to browser display/navigation preferences. Display name and the existing automatic-choice, continuous-reading, and default turn-control settings remain on their server-profile API paths.

## Build and catalogue workflow

For local Core work, build a static bundle with the implementation selected before compilation:

```powershell
$env:VITE_UI_COMPONENTS = "web-awesome"
pnpm build:web:next
```

For native comparison or rollback, select native before rebuilding. This is an alternative build, not a prerequisite for the Core test run below:

```powershell
$env:VITE_UI_COMPONENTS = "native"
pnpm build:web:next
```

Changing a server runtime environment after a Vite build does not change the already-built static bundle. From the repository root, strictly check and build the separate browser fixture (Vite is installed in the replacement app package):

```powershell
pnpm exec tsc -p tsconfig.browser-fixtures.json --noEmit
Push-Location apps/web-next
try {
  pnpm exec vite build --config ../../tests/ui/vite.config.ts
  if ($LASTEXITCODE -ne 0) { throw "UI fixture build failed" }
} finally {
  Pop-Location
}
```

For Core verification, keep `VITE_UI_COMPONENTS=web-awesome` and build both the Core app and fixture before running the focused Core/CSP fixture or complete mocked browser set:

```powershell
pnpm exec playwright test --config playwright.web-awesome.config.ts tests/e2e/web-awesome-core.e2e.test.ts
pnpm exec playwright test --config playwright.web-awesome.config.ts
```

For a native-built app with `VITE_UI_COMPONENTS=native`, run only `pnpm exec playwright test --config playwright.web-awesome.config.ts tests/e2e/quiet-leaf-navigation.e2e.test.ts`. That file includes native composer geometry. Its native-only case is intentionally skipped in the full Core run. Rebuild Core plus the fixture when returning to the Core preview; do not run Core-only Story selectors against native markup.

The test configuration starts and stops its own loopback-only helper at port 43175. For interactive catalogue inspection, run `pnpm exec tsx scripts/serve-ui-test-build.ts` in a dedicated terminal and open [the catalogue](http://127.0.0.1:43175/ui-test/?catalogue=1). Add `&panel=automatic`, `comfortable`, `wide`, or `full` to inspect one panel. Stop that helper before running Playwright; the configuration deliberately refuses to reuse an unknown server. Do not start another helper or rebuild bundles while tests are running. Restore any previous `VITE_UI_COMPONENTS` value when finished.

The catalogue uses fictional test-only content. It is not a live campaign, and its mocked API tests do not prove durable generation or provider parity. Record exact commands, candidate SHA, browser versions, and results in the acceptance record; these commands collect evidence, not release approval. The separate runtime configuration and [Story smoke checklist](../workflows/story-interface-smoke-test.md) remain required before default-on.

## Docker and release boundary

Container selection is a Docker build argument, never a runtime service setting: the build stage declares `ARG VITE_UI_COMPONENTS` before `RUN pnpm build` and does not export it as runtime `ENV`. Build a native rollback image without starting a service:

```powershell
docker build --build-arg VITE_UI_COMPONENTS=native -t infinitequest-nexus:ui-native .
```

Or create the Compose image only:

```powershell
docker compose build --build-arg VITE_UI_COMPONENTS=native infinitequest-app
```

A rollback builds a new native image only; it does not alter a database or remove existing preference keys. Deploying any image, including a Swarm prebuilt image, remains separate authorization. The build-argument contract is not a substitute for the outstanding browser, runtime, visual, bundle, and release gates.

## Core upgrades

Before proposing an upgrade, inspect the installed TypeScript declarations and the vendor release notes; recheck package and emitted icon license notices, icon-manifest confinement to the application origin, public CSS parts, and CSP. Then run the focused behavior tests, CSP browser suite, relevant Story browser matrix, native/Core bundle comparison, and native rollback build. Review the lockfile and bundle delta explicitly. Never auto-merge an upgrade merely because unit tests pass, and never weaken CSP or replace the native fallback to make a result appear green.
