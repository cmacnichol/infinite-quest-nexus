# Story-only campaign verification

## Task 8 focused evidence

The fixture harness creates only uniquely owned
`infinitequest_storyonly_fixture_*` databases. It reads the ignored dedicated
test configuration, verifies `127.0.0.1:15439/infinitequest_storyonly_test`,
and applies the existing owned-database guard before creation and cleanup.
Fixture setup and migration time are recorded separately from generation
latency. Every sample starts with a fresh campaign and fixed fictional context.

The focused PostgreSQL fixture suite passed with 17 tests. It covers clean,
dormant-event preservation, choice repair, invalid narration, output-limited
output, and an actual lease reclaim: worker A saves the main draft then loses
its lease; worker B claims the same job and commits without a second main
generation dispatch. Invalid and output-limited samples are uncommitted with
zero failed provider transports; the fixture's `failures` count now means only
failed transports, while committed versus uncommitted samples are reported
separately. The comparison fixture also captures the actual committed legacy
sequences for Action, explicit Scene, and event-heavy requests.

| Composed worker requirement | Focused PostgreSQL evidence |
| --- | --- |
| Corrected continuity and canonical IDs through Story-only replacement | The replacement request contains the corrected continuity, canonical content, and exact canonical ID. The saved full Story-only policy survives acceptance; serialized RPG, events, and pending state are byte-identical before and after, and every non-replacement turn is unchanged. |
| Frozen policy after setting/enqueue race | A Story-only job is queued, the campaign is switched to Action before claim, and the worker makes only `story_generation`. Its separate system prompt contains the saved supplement and the accepted policy equals the complete queued snapshot. |
| Cross-owner and cross-campaign worker isolation | A selected campaign executes beside a distinct-owner campaign with state, Chronicle, and canonical canaries. Neither provider body nor system prompt contains a foreign canary, and the foreign rows are unchanged. |

The benchmark-summary unit suite passed with 1 test. It verifies p50/p95,
actual dispatch operation counts, distinct operation sequences, failed-attempt
counts, committed versus uncommitted samples, estimated tokens, and the
distinction between an unknown provider token total and zero usage.

## Synthetic benchmark

Command:

```powershell
node node_modules/tsx/dist/cli.mjs scripts/benchmark-story-only.ts --warmups 3 --samples 20 --seed story-only-v1 --output tmp/story-only-benchmark
```

The run used Node v24.18.0 and PostgreSQL 18.6. It uses a deterministic local
provider with fixed zero-delay and 100 ms-per-dispatch cases; the reported wall
time is harness timing, not model-speed evidence. All 20 measured samples in
each group committed; all groups recorded zero failed dispatches. Provider
reported token totals are unavailable from this synthetic collaborator and are
reported as `null`; request and output token figures are estimates.

The sanitized machine-readable result is
[benchmark-story-only-v1.json](benchmark-story-only-v1.json). Its SHA-256 is
`c4829c9a976ea5acc48fa0898882eb36250d5f9d981d0727c0da22dc17ea9ebb`.
The benchmark process did not capture a pre-run source revision, so this
artifact does not attribute results to an inferred Git commit.

| Baseline | Zero-delay p50/p95 ms | 100 ms p50/p95 ms | Observed operations per sample |
| --- | ---: | ---: | --- |
| Legacy Action, no stats/events | 71.04 / 73.90 | 182.19 / 188.46 | `story_generation` |
| Legacy flexible Action with explicit Scene | 72.28 / 75.56 | 287.43 / 295.78 | `story_generation`, `scene_coverage_validation` |
| Legacy event-heavy Action | 71.26 / 76.06 | 284.85 / 291.47 | `event_trigger_before`, `story_generation` |
| Story only | 65.88 / 68.28 | 179.36 / 184.41 | `story_generation` |

The benchmark confirms that Story-only has one dispatch in these fixed-context
fixtures. Legacy Action also has one dispatch, so this result does not claim a
saved request for that baseline.

“Event-heavy” here is the deterministic before-turn-event fixture, not a
claim about every legacy campaign with RPG or event configuration.

Fresh-database setup was excluded from generation latency and reported
separately: the per-group setup p50 range was 467.88–493.08 ms and the p95
range was 510.28–577.97 ms.

## Final recovery review and checks

Independent Terra review found and closed a recovery-path gap: a generic
full-response repair could bypass Story-only choice uniqueness validation.
Recovered output now passes that validation even when the provider marks a
complete response output-limited. If only choices remain invalid after the
automatic budget is consumed, a private pending checkpoint retains the valid
non-choice draft and its actual recovery-request body, hash, sent canonical
fact IDs, and provider response. Lease reclaim sends no extra request. An
explicit retry sends one choices-only request and preserves that provenance.
Malformed or tampered checkpoints fail closed. The PostgreSQL regression first
reproduced invalid-choice acceptance and a request-provenance overwrite, then
passed after both corrections.

The final frozen source passed these controller-run checks:

| Check | Result |
| --- | --- |
| Full Windows unit suite | 275 files; 3,384 passed, 44 platform skips, zero failures (21.26 s). The seven Linux filesystem unit files separately passed 181 tests with one intentional inverse-platform skip. |
| Repository/type/client checks (`pnpm check`) | Passed; repository boundaries and data-safety checks covered 1,463 candidate files. |
| Application build (`pnpm build`) | Passed (9.34 s). Existing font-resolution and large-chunk advisories remain; these are not a new browser-verification claim. |
| Final affected PostgreSQL aggregate | Eight files; 134 passed, 15 Windows filesystem skips, zero failures (127.61 s). |
| Final choice-repair regressions within that aggregate | 18 passed, including pending repair, explicit retry, reclaim, limited output, checkpoint tampering, and exact recovered-request provenance. |

The final PostgreSQL aggregate comprised `story-only-generation` (17),
`story-only-choice-repair` (18), `generation-execution-repository` (24),
`generation` (50), `generation-budget-growth` (5),
`story-continuity-remediation` (1), `gameplay` (7 passed/1 skipped), and
`image-pipeline` (12 passed/14 skipped). The filesystem cases have the separate
Linux coverage recorded in [the Linux and aggregate report](task-8-linux-verification.md).
That report preserves the original 92-file Windows run's six failures and
explains each corrected or platform-specific rerun. These are combined
coverage results, not a claim that one fresh 93-file run had no failures or
skips. The final affected generation checks ran after the recovery correction;
the unaffected archive/filesystem evidence predates that correction.

The final commands were run in the isolated worktree:

```powershell
$env:LOG_LEVEL='silent'
node node_modules/vitest/vitest.mjs run tests/unit --exclude '**/.worktrees/**' --exclude '**/.codex/**' --reporter=dot --reporter=json --outputFile=tmp/story-only-test/final-unit-results.json
pnpm check
pnpm build
node node_modules/vitest/vitest.mjs run --config tmp/story-only-test/vitest.config.ts tests/integration/story-only-generation.integration.test.ts tests/integration/story-only-choice-repair.integration.test.ts tests/integration/generation-execution-repository.integration.test.ts tests/integration/generation.integration.test.ts tests/integration/generation-budget-growth.integration.test.ts tests/integration/story-continuity-remediation.integration.test.ts tests/integration/gameplay.integration.test.ts tests/integration/image-pipeline.integration.test.ts --reporter=dot --reporter=json --outputFile=tmp/story-only-test/final-generation-results.json
```

The ignored JSON outputs record successful process results. The final seeded
canonical-fact regression was written before these runs started, and the
controller verified that no non-document source changed during the checks.

The synthetic timing table was collected before the final generic-recovery
correction. The clean path did not change, and its exact one-call sequences
passed again in the final PostgreSQL aggregate; the timing table does not
measure the exceptional pending-repair path.

## Release-only quality gate

The committed 12-case quality corpus was not evaluated against a live provider.
No disposable live provider and campaign were authorized for this task. The
live-quality gate remains open: score each case on the five 0/1/2 dimensions,
require at least 108/120 with no zero, no mechanics language, and no
fiction-authority violation.
