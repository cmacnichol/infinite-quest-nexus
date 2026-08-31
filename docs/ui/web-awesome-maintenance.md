# Quiet Leaf Web Awesome maintenance

Quiet Leaf applies only to the replacement `/app/` Story interface and shared shell/preferences. It does not replace `/nexus/`, legacy `/story/:campaignId`, explicit replacement Story URLs, or `/app/story` campaign selection. Core is currently opt-in: an explicit `VITE_UI_COMPONENTS=web-awesome` is required by the present feature policy, while native remains the default and rollback renderer. Do not describe a build, browser, PostgreSQL, provider, visual, or release gate as passed unless its actual evidence is recorded in [the acceptance record](web-awesome-quiet-leaf-acceptance.md).

## Change map

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

For native comparison or rollback, select native before rebuilding:

```powershell
$env:VITE_UI_COMPONENTS = "native"
pnpm build:web:next
```

Changing a server runtime environment after a Vite build does not change the already-built static bundle. Run the focused Core/CSP catalogue fixture with:

```powershell
pnpm exec playwright test --config playwright.web-awesome.config.ts tests/e2e/web-awesome-core.e2e.test.ts
```

Run the broader Story/browser catalogue only through the project’s configured test commands and record its exact command, candidate SHA, browser, and result in the acceptance record. These commands are evidence collection, not release approval.

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
