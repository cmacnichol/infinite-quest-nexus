# Five audit fixes: 2026-09-21

This follow-up implements all five requested audit fixes using Terra subagents. Executable review range: `972e8650a7d15b7dd6641ea5c2721ed7912e4a19..2e3248a1`. Scope is API, runtime, persistence, and legacy Settings/Story. New UI work and plain JSON fallback remain deferred. Native admission remains default-off; no deployment, activation, push, or live inference occurred.

## Delivered behavior

| Fix | Failure prevented | Implementation |
| --- | --- | --- |
| 1. Preserve prepared structured requests | A schema error could trigger a second request with the schema and frozen routing removed. | Prepared execution centrally forbids response-format fallback. A transport regression verifies one failed physical send and no stripped retry. Historical nonprepared behavior is unchanged. |
| 2. Coherent preset Save authority | Concurrent profile edits could validate one endpoint using another revision's credential or unnecessarily decrypt an obsolete key. | Capture the owner-scoped profile, encrypted credential and revision together. Lazily decrypt only when validation needs the saved credential; validate outside the transaction, then compare the locked revision before saving. |
| 3. Durable campaign charges | Deleting completed jobs or archiving a campaign could lose billed failed-attempt costs. | Materialize campaign-owned physical attempts into stable cost events atomically with completion. Use physical attempt identity, suppress duplicate legacy illustration costs, and retain unmatched legacy accounting. Migration 0101 backfills attributable attempts. Decimal precision is preserved; oversized untrusted cost strings remain in the raw ledger without aborting completion or inventing a price. |
| 4. Reject mutable preset candidates | Mutable aliases or router IDs could pass admission and resolve to a different identity after billing. | Before discovery or enqueue, reject trimmed OpenRouter `~` aliases and exact `openrouter/auto` and `openrouter/free`. Concrete IDs containing `latest`, other concrete IDs, and non-OpenRouter model names remain allowed. |
| 5. Actionable safe diagnostics | An unsupported public field was reduced to `config`, leaving users unable to identify the setting to remove. | Expose only the fixed field names `tools`, `stop`, and `transforms`. Unknown/private names and all values remain hidden. Both legacy entrypoints display the finite diagnostic. |

Model selection still requires the applicable structured-output capability evidence. Preset selection retains trusted structured-output admission; it does not claim a model capability check. These fixes do not introduce standard JSON fallback.

## Verification

The suites below overlap; counts are separate runs, not a unique combined total. Strict RED/GREEN evidence is retained locally in ignored task artifacts.

| Area | Evidence |
| --- | --- |
| Prepared execution | 73 affected unit tests passed; transport-backed failing regression preceded the fix. |
| Save authority | 19 unit and 25 real PostgreSQL tests passed, including the initial endpoint/credential race and lazy-credential corrective regression. |
| Cost accounting | Final Windows follow-up: 67 passed, 14 platform skips. Final Linux overlay: 81 passed with zero skips across the complete image pipeline, migration, and provider adapter files. |
| Archives | Both complete Linux archive files passed: 86 tests, zero skips. They verify precise parentless stable-event round trips; combined with materialization tests this is compositional evidence, not one end-to-end rejected-provider-to-restore scenario. |
| Admission and diagnostics | 36 affected units and 75 tests across both complete relevant PostgreSQL files passed. |
| Legacy browser | Both relevant Playwright suites passed 12/12 with intercepted API fixtures. Settings and Story diagnostic screenshots were visually reviewed. No live provider compatibility is implied. |
| Static checks | Final executable source passed pinned pnpm 12.4.1 `pnpm check` and `pnpm build`. Build retained existing font-resolution/chunk-size advisories. Final whitespace and local documentation links were checked. |

The Linux accounting run used image `sha256:3bcbb7ec296e9beaba1162308b5dda31b37f520959e33af3f6a1ad1f766d9dd9` with read-only source overlays through `de712844`; the archive suites ran on its matching earlier accounting source. Later admission/diagnostic edits do not modify those accounting paths. A first container attempt failed before tests because the normal integration bootstrap tried to launch Docker; the dedicated Linux harness produced the successful result above.

During the initial Save test setup, an agent reset the test-only volume `infinitequest-test_infinitequest-integration-postgres-data` after a credential mismatch. That was disclosed during execution. Remaining verification used the dedicated task-owned PostgreSQL harness. No production database was reset.

## Operational limits

Migration 0101 is required; see the [rollout](rollout.md) and [deployment runbook](../../runbooks/deployment.md). Historical orphaned attempts cannot be assigned to campaigns safely and are not backfilled. Already-rounded historical amounts cannot regain lost precision. Existing stale-claim behavior before completion is unchanged. Missing or malformed costs remain unknown, never zero by assumption.

See the [Settings diagnostic](../assets/native-openrouter-presets/audit-settings-unsupported-stop.png) and [Story diagnostic](../assets/native-openrouter-presets/audit-story-unsupported-stop.png) captures. Private verification logs are excluded from the final tree and preserved locally.

Final independent Terra review approved executable range `972e8650..2e3248a1` with no corrective findings. It reviewed Tasks 4/5 and their composition with the previously approved Tasks 1-3, the evidence, safe diagnostics, default-off behavior, and this report. It did not rerun tests or review the entire historical feature branch.
