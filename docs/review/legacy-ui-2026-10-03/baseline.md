# Legacy UI deterministic baseline

Recorded: 2026-10-03. Source commit: `a25bc128fb07905ada7d8e2503b3d95190ea10db`. The benchmark reported a dirty worktree because T01's fixtures and harness were present; the application source remained at the baseline commit. Build mode was the legacy Vite development server with deterministic mocked API routes.

## Fixture and safety

`legacyUiFixture({ turnCount, worldCount, campaignCount })` provides repeatable synthetic records. The baseline cases cover 0, 1, 50, 317, and 2,000 turns. The measured profile uses 317 turns, 3 worlds, and 2 campaigns. The helper mocks dashboard startup, session, campaign sync and state, turns/history, world details and playable characters, illustration configuration/segments/jobs, providers, dashboard statistics, and context preview. Delays and failures are configurable by method/path. API request method/path and request/response bytes are recorded; non-read requests are exposed as fixture writes.

The fixture builder and browser assertions found no private-data canaries. The measured browser run recorded zero writes, zero external requests, and zero runtime errors. No database, provider, or live campaign was accessed.

## Focused verification

The six pre-existing UI suites passed before and after instrumentation: 6 test files and 111 tests each run. The new Playwright baseline passed 2 tests, including exact fixture cardinalities, canary checks, zero initial writes, full 317-card history loading, and navigation to Turn 1.

Rendered screenshots were captured for dashboard, Story reader, history, world author, character editor, and campaign creation at 1280×800 and 390×844. Playwright retained the 12 synthetic captures under `test-results/legacy-ui-baseline.e2e-leg-0cd26--timing-and-rendered-counts/` in the worktree. They are test artifacts and are not committed.

## Browser benchmark

Command: `corepack pnpm exec tsx scripts/benchmark-legacy-ui.mjs`. Configuration: 5 warmups, 30 measured samples, Chromium headless, 1280×800 viewport, Vite development server, synthetic 20 ms delay on the campaign turns route, and the fixture cardinalities above. The harness waits for campaign hydration and all 317 history cards, then records history open/navigation timings. Timings are observations, not pass/fail thresholds.

| Measure | p50 | p95 | Range / additional evidence |
| --- | ---: | ---: | --- |
| Open complete history | 340.58 ms | 357.11 ms | 294.43–359.16 ms; CV 5.35% |
| Navigate from history to Turn 1 | 87.63 ms | 96.40 ms | 80.20–108.92 ms; CV 6.84% |
| Mock API requests per sample | 27 | 27 | 27 every sample; includes dashboard, Story, and history flow |
| Mock API response bytes | 201,321 | 201,321 | 201,321 every sample; excludes static assets |
| Cold static response bytes | 6,820,893 | 6,820,893 | Dashboard plus first Story load in a new browser context |
| Warm reload static response bytes | 2,869,339 | 3,369,182 | p50–p95; mean 2,952,692 bytes, CV 12.63% |
| Dashboard DOM nodes | 1,487 | 1,487 | Stable across samples |
| Story DOM nodes | 462 | 462 | Stable across samples |
| History DOM nodes | 6,190 | 6,190 | 317 rendered history cards |

One long task was observed at 50 ms across the 30 measured samples. Cold and warm byte counts are uncompressed local Vite response-body sizes, including HTML, scripts, styles, and assets. API JSON bytes are reported separately. The browser measurement does not include PostgreSQL, production compression/caching, real providers, or network latency; do not use it as a production latency claim.

The benchmark records commit, dirty flag, fixture, build mode, warmup/sample counts, percentiles, coefficient of variation, request/DOM counts, long tasks, and safety guard results in its JSON output. Repeat the default command when comparing a later build. The history timing's 5.35% CV is recorded as the local baseline variance; timing changes close to that range need a repeat before attribution.

## Skipped checks

PostgreSQL, integration, deployment, production browser, and live-provider checks were not applicable to this fixture-only task. They were not run and are not passes. Dependency repair used `corepack pnpm install --frozen-lockfile`; the lockfile was unchanged.
