# Story memory release readiness — September 16, 2026

Core implementation T01–T20 and the T21 read-only repair proposal tool are scoped to this worktree, based on `60a4aabe4adc2759f14fd53370e31465daabb783`. Optional experiments T22–T26 are excluded. Nothing has been deployed or enabled in production. Operational enrollment defaults off; enforcement defaults false. Code readiness and permission to promote are separate decisions.

The subsequent review identified four integration gaps in fact remapping, profile-response validation, selected-world evidence binding and prompt-library readback. All four are fixed; the [targeted fix record](story-memory-review-fixes-2026-09-16.md) contains the regression results, screenshots and remaining verification limitation. The promotion decisions below remain unchanged.

## Release decisions

| Release | Local evidence | Missing promotion evidence | Promotion decision |
| --- | --- | --- | --- |
| R1 authority and retrieval | Actual executor requests cover complete fiction profile authority, selected world references, corrections, structured fact IDs, balanced query families and scoped historical candidates. Enrollment and frozen legacy paths have regression coverage. | Approved copied-campaign 32k and provider-supported larger-window canaries; production-representative latency and retrieval measurements. | **Blocked** pending live canaries; skipped in this implementation session. |
| R2 history and provenance | Recent accepted window, verified sentence spans, whole protected records and exact wire budgets have unit and PostgreSQL coverage. No new foreground model stage is added by R1/R2. | Same copied-campaign canaries and representative performance comparison as R1. | **Blocked** pending live canaries; skipped. |
| R3 observe | Durable review binding, private evidence, bounded dispatch, unavailable-review handling, safe public diagnostics and post-acceptance illustration gating have deterministic provider and PostgreSQL coverage. | Approved per-turn review call/cost ceiling and measured provider cost/latency on authorized copies. | **Blocked** pending approved live observe evidence; skipped. |
| R3 enforce | One bounded semantic repair, durable attempt counters, restart-safe event evaluation, guarded commit and rejected-output isolation have PostgreSQL coverage. | Independent human-held-out precision/recall, semantic false-block and writing-quality assessments, paired scenario-level quality/cost intervals, plus observe gates. | **Blocked**. Deterministic review tests cannot approve enforcement. |

## Verification evidence

### CI remediation follow-up

The initial PR checks stopped at pnpm setup because both workflows pinned 11.24.0 while `package.json` declared 12.4.1. Workflows now use the manifest's version, and both Dockerfiles derive the same version from that manifest. Regression tests cover both workflows and Dockerfiles.

The follow-up also fixes the review probe's logging boundary and the source-authoring panel's discriminated-union check. Source-authoring integration fixtures now use the current evidence-ID provider contract, parse worker results independently of structured logs, and prepare the full intended partial-progress state before testing recovery. Story-only fixtures use the runner's isolated `TEST_DATABASE_URL` with strict loopback/database-name checks instead of requiring an absent developer-local JSON file.

Current local verification supersedes the corresponding limitations in the historical run record below:

- Full unit suite: 3,622 passed, 44 intentionally skipped; the subsequently added second-Dockerfile regression passes in the 21-test deployment suite.
- Aggregate repository/type checks, documentation build, production application/image build, both image interface artifacts, Compose/Swarm configuration and bundle-budget report: passed.
- Real PostgreSQL source-authoring suites: 28 passed across source acceptance, security and durable jobs. Story-only generation: nine passed; eight opt-in runtime cases skipped.
- Compiled Linux System Archive end-to-end suite: three passed, including its rendered browser coverage, using writable container source and a dedicated test database.
- Whitespace check: passed. GitHub workflow results are recorded on [PR #157](https://github.com/cmacnichol/infinite-quest-nexus/pull/157); local checks are not represented as remote CI results.

No campaign migration, production repair, live-provider call, or rollout promotion is part of these CI fixes. The release decisions above remain unchanged.

### Historical implementation runs

- **Passed:** 227 Story and Quiet Leaf UI unit tests after the final native-composer and profile-recovery fixes.
- **Passed:** full production build using the repository-pinned Corepack pnpm; TypeScript check.
- **Passed:** final focused core PostgreSQL rerun: 73 passed, seven skipped (six opt-in pre-fix baseline fixtures and the opt-in scale benchmark, whose prior measurements are retained separately).
- **Passed:** T18 review/repair PostgreSQL suite, 46 tests including persisted attempt exhaustion and event restart behavior.
- **Passed:** deterministic evaluator, 20 scenarios × two repeat IDs × three modes = 120 cases. Sources cover world rules, campaign profiles, current corrections, canonical facts, recent history and current scenes. Teacher-forced and rollout trajectories are reported separately. Repeats are deterministic repeats, not independent random seeds.
- **Passed:** final full System Archive integration file, 53 tests. Archive compatibility now orders migration identifiers rather than timestamps, so clock skew cannot misidentify the schema version.
- **Passed:** System Archive and Campaign ZIP next-generation compatibility, reference-remapping and source-world portability regression paths in Linux PostgreSQL. Imported operational enrollment remains absent and archive tests exclude private generation data.
- **Passed:** T21 proposal and state-correction tests (unit and PostgreSQL). The tool is read-only, rejects apply mode, preserves intentional empty corrections and produces revision-bound private proposals. No production repair was performed.
- **Full unit run:** 3,607 passed, 44 skipped, one failed. The failure is the existing deployment test expecting pnpm 11.24 while the repository pins 12.4.1. It is not counted as passed.
- **Broad Linux PostgreSQL run:** 1,071 passed, eight skipped, 35 failed before final fixture repairs. Subsequent focused reruns address changed migration expectations and compatibility paths; this initial run is not represented as an all-green suite.
- **Original baseline failures:** source-authoring and source-authoring-security reproduced the same four failures against an immutable archive of the original HEAD. These fixture failures were subsequently addressed in the CI remediation above.
- **Environment-limited checks:** the story-only benchmark requires its separately provisioned `tmp/story-only-test/database.json`; compiled System Archive end-to-end tests attempt builds inside read-only source mounts. Those checks did not pass in this environment. Core ZIP/System Archive repository ingress and next-turn tests ran separately against real PostgreSQL.
- **Passed:** 44 additional Linux PostgreSQL tests covering resumable System Archive, story-only portability/policy, generation events and adapter migration compatibility.
- **Static check limitations:** the existing review probe violates the console boundary rule; existing web-next source-authoring-panel code reports a union-property type error in its application check. The root TypeScript command and production build are separate successful checks, not substitutes for the failing aggregate check.

Independent implementation review passed, including the final native-composer input-preservation fix.

**Browser verification passed:** 39/39 tests in the final paired-interface matrix (25.0 seconds), plus 5/5 concurrent repeats of the new-interface append recovery case. The matrix covers append/replacement retry and discard, state/profile editing after discard, revision conflicts, retained draft submission, stream-loss polling, interface handoff, safe diagnostics, historical/unknown diagnostic records and prompt acknowledgement. Initial reruns exposed draft-loss and stale-response bugs; these were repaired and verified before the final run. Browser plugin/skill was unavailable, so verification used repository Playwright and isolated Vite servers on ports 43173/43174 with mocked API fixtures. This is rendered browser evidence, not a live deployed API/provider canary.

Screenshots were regenerated and visually inspected at desktop and 390px mobile:

- [Legacy profile editor, desktop](assets/generation-integrity-diagnostics/legacy-profile-recovery-editor-1440.png) and [mobile](assets/generation-integrity-diagnostics/legacy-profile-recovery-editor-390.png).
- [New profile editor, desktop](assets/generation-integrity-diagnostics/web-next-profile-recovery-editor-1440.png) and [mobile](assets/generation-integrity-diagnostics/web-next-profile-recovery-editor-390.png).

The native composer retains its input element across same-campaign/turn background refreshes, including text awaiting its native input event. Explicit clears and new campaign/turn ownership still reset the draft. State/profile saves preserve unsent intent without replacing newer user edits. Deferred profile responses cannot overwrite a newer editor or another campaign.

## Operations and artifacts

Use the [rollout runbook](../runbooks/story-memory-rollout.md) for explicit per-campaign enrollment, frozen-job inventory, rollback and private artifact retention. Use the [evaluator runbook](../runbooks/story-continuity-evaluation.md) for reproducible deterministic runs and separately authorized live evaluation. The additive migration is `0095_story_memory_capability_enrollment.sql`; operational enrollment is excluded from portable archives.

Verification used a dedicated local PostgreSQL container and disposable fixture databases. No live provider was invoked, no paid calls were made, no production campaign was mutated, and no cleanup of user data was performed. Retain local test evidence until review; any private copied-campaign evidence created in future runs follows the runbook's recorded expiry and separately authorized cleanup.

## Deterministic aggregate

[The measured evaluator report](assets/story-memory-continuity/evaluation-2026-09-16.json) contains 20 corpus scenarios and 120 executions. The intentionally seeded source failures and bad candidate outputs remain visible as failed quality metrics even though the harness passes its assertions. The synthetic repaired mode receives a predetermined fixture repair; its score is evidence of workflow/scoring behavior, not evidence of live reviewer or writer quality. Independent labels remain skipped.
