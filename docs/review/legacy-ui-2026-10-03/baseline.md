# Legacy UI deterministic baseline

Recorded: 2026-10-03. The corrected 5/30 run recorded HEAD `550b9b9e980b3c1f89ebcd9adda420fae4e78e3d` with `dirty: true`; T01's fixture and harness edits were uncommitted at measurement time. Application behavior was measured with the legacy Vite development server and deterministic mocked API routes.

## Fixture and safety

`legacyUiFixture({ turnCount, worldCount, campaignCount })` provides repeatable synthetic records. The baseline cases cover 0, 1, 50, 317, and 2,000 turns. The measured profile uses 317 turns, 3 worlds, and 2 campaigns. The helper mocks dashboard startup, session, campaign sync and state, turns/history, world details and playable characters, illustration configuration/segments/jobs, providers, dashboard statistics, and context preview. Delays and failures are configurable by method/path. API request method/path and request/response bytes are recorded; non-read requests are exposed as fixture writes.

The fixture builder and browser assertions found no private-data canaries. The measured browser run recorded zero writes, zero external requests, and zero runtime errors. No database, provider, or live campaign was accessed.

## Focused verification

The six pre-existing UI suites passed before and after instrumentation: 6 test files and 111 tests each run. The corrected Playwright baseline passed 4 tests, including exact fixture cardinalities, canary checks, zero initial writes, route delay/failure/write instrumentation, per-document measurement collection, full 317-card history loading, and navigation to Turn 1.

Rendered screenshots were captured for dashboard, Story reader, history (while the dialog is open), world author, character editor, and campaign creation at 1280×800 and 390×844. The 12 synthetic captures are preserved under `.superpowers/sdd/legacy-ui-2026-10-03/evidence/screenshots/` and also remain in Playwright's `test-results/legacy-ui-baseline.e2e-leg-0cd26--timing-and-rendered-counts/` folder.

## Browser benchmark

Command: `corepack pnpm exec tsx scripts/benchmark-legacy-ui.mjs`. Configuration: 5 warmups, 30 measured samples, Chromium headless, 1280×800 viewport, Vite development server, synthetic 20 ms delay on the campaign turns route, and the fixture cardinalities above. The history timer stops when the open dialog renders all 317 cards, before waiting for outstanding requests or static response-body reads. Timings are observations, not pass/fail thresholds.

| Measure | p50 | p95 | Range / additional evidence |
| --- | ---: | ---: | --- |
| Open complete history | 113.45 ms | 168.13 ms | 99.37–171.59 ms; CV 18.21% |
| Navigate from history to Turn 1 | 90.47 ms | 99.85 ms | 77.99–120.66 ms; CV 9.63% |
| Mock API requests per sample | 27 | 27 | 27 every sample; includes dashboard, Story, and history flow |
| Mock API response bytes | 201,321 | 201,321 | 201,321 every sample; excludes static assets |
| Cold static response bytes | 6,820,893 | 6,820,893 | Dashboard plus first Story load in a new browser context |
| Warm reload static response bytes | 3,700,579 | 3,700,579 | Warm Story reload in the Vite development server |
| Dashboard DOM nodes | 1,487 | 1,487 | Stable across samples |
| Story DOM nodes | 462 | 462 | Stable across samples |
| History DOM nodes | 6,190 | 6,190 | p50–p95; observed range 6,169–6,190 with 317 cards |

The browser's native `PerformanceObserver` reported 30 dashboard, 4 Story, 0 history, and 4 warm-reload long tasks across the 30 measured samples. Dashboard task durations ranged from 62–87 ms. Cold and warm byte counts are uncompressed local Vite response-body sizes, including HTML, scripts, styles, and assets. Mock API JSON response bytes are reported separately. History-open timing variability was high (18.21% CV), so treat this series as descriptive and repeat before attributing smaller timing differences. The browser measurement does not include PostgreSQL, production compression/caching, real providers, or network latency; do not use it as a production latency claim.

The full corrected 5/30 JSON is preserved at `.superpowers/sdd/legacy-ui-2026-10-03/evidence/benchmark-legacy-ui-5warmup-30samples.json`; the successful command's stderr log is alongside it. The benchmark records commit, dirty flag, fixture, build mode, warmup/sample counts, percentiles, coefficient of variation, request/DOM counts, long tasks by document phase, and safety guard results. A first run was correctly rejected because a startup pagination delay had naturally timed out; its raw failure log is preserved as `benchmark-first-attempt-failure.log`. The guard now requires the measured history flow to include an explicitly held-and-released request while allowing unrelated startup pagination requests to time out.

## Skipped checks

PostgreSQL, integration, deployment, production browser, and live-provider checks were not applicable to this fixture-only task. They were not run and are not passes. Dependency repair used `corepack pnpm install --frozen-lockfile`; the lockfile was unchanged.
