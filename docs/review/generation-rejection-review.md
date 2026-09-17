# Generation rejection review: release verification

## Scope and result

This review validates the durable decision gate for a completed narration that
cannot be automatically accepted. It uses the disposable PostgreSQL integration
database and deterministic synthetic text/image providers; no live provider or
private campaign data was used.

The release scenario starts with a complete SSE primary response, saves it
before review, then exercises a continuity conflict or reviewer unavailability.
For each eligible **Keep** outcome it asserts the saved candidate's canonical
hash and narration are unchanged, exactly one `story_generation` request ran,
no `story_continuity_repair` runs in the direct-Keep cases, and one accepted turn
is committed. The failed-authorized-retry case separately proves its one
authorized repair leaves the original candidate available, then Keep makes no
further repair or primary text call. The matrix covers append and `replace_latest`, Action and scene
control modes, and Story-only scene control. It also covers an authorized repair
failure followed by Keep, restart after persisted `primaryResult`, restart after
the saved decision, next-turn retrieval, and an independent illustration enqueue
failure.

The restart/retrieval case proves the next primary request contains the accepted
fiction, excludes the private reviewer canary, and excludes an accepted-fiction
canary belonging to another campaign. It also queries Chronicle to prove the
review canary did not become campaign memory.

## TDD and regression finding

The streamed failed-structure-repair test was RED: a failed authorized repair
overwrote the public partial preview with its hidden draft. This hard structural
candidate is not keepable; the distinct eligible continuity test covers retry
failure followed by Keep. The worker now flushes a partial narration only for
the initial primary response; an authorized replacement remains private until it
validates and commits.

The first full integration attempt also exposed a deterministic false positive:
a valid typed canonical-fact UUID containing `ac12` was scanned as serialized
fiction and treated as an armor-class reference. The new parser test was RED,
then GREEN after narrowing that scan to the update's fiction content while
retaining mechanics validation for that content. The historic failed job was
already discarded by the isolated harness, so this confirms the defect and its
fix without claiming its UUID was the prior run's exact hidden value.

Two existing static Story Player assertions were updated to describe the
implemented review lock: normal turn input remains locked while a saved review
is pending, while the recovery area stays available for its explicit decision.
No player production code changed in this task.

## Verification

| Check | Outcome |
| --- | --- |
| Focused capture/restart composition | Passed: 1 test; 46 tests skipped by its name filter |
| Focused streamed conflict/unavailable/retry-then-Keep subset | Passed: 4 tests; 43 tests skipped by its name filter |
| `corepack pnpm exec vitest run tests/integration/generation.integration.test.ts --config vitest.integration.config.ts --silent` | Passed: 50 tests |
| `corepack pnpm exec vitest run tests/integration/story-continuity-review.integration.test.ts --config vitest.integration.config.ts --silent` | Passed: 47 tests |
| Combined generation and continuity PostgreSQL suites after the UUID fix | Passed: 97 tests |
| Parser regression for typed fact identifiers | RED then GREEN: 28 tests |
| Existing payload, continuity-evaluator, and Story-only choice-review regressions | Passed after explicit-decision expectation updates: 40 tests, 6 existing skips |
| `corepack pnpm exec vitest run tests/unit/story-player-ui.test.ts --silent` | Passed: 87 tests |
| `corepack pnpm test:unit` | Passed: 302 files, 3,697 tests; 44 skipped |
| `corepack pnpm check` | Passed |
| `corepack pnpm build` | Passed; existing runtime-font resolution and chunk-size warnings remain |
| Isolated integration coverage | Passed across all 103 files: 100 Windows files and three Linux-only portable-archive files. The Windows `corepack pnpm test:integration` run reached 56/103, then stopped at a Linux-only filesystem guard; its remaining 47 files were run with the same isolated config. The three Linux-only files passed in a fresh disposable Linux Node/PostgreSQL environment (4 tests). The original Windows coverage produced 967 passing tests and 120 skips; replacing the three stale review-expectation failures and the three Linux-only results gives 976 passing tests and 120 skips. This is segmented cross-platform coverage, not a claim that one Windows command passed end-to-end. |

The 44 unit skips are existing platform-gated secure archive and asset-staging
cases, POSIX credential-permission cases, and optional secure-filesystem runtime
cases. They were skipped, not counted as passing coverage. The unit command
uses a temporary workspace-local `pnpm.cmd` shim only because the web-build
contract invokes bare `pnpm`, which otherwise resolves to the Codex fallback
11.x instead of the repository-pinned Corepack 12.4.1. The shim is removed
after the command and is not part of this change.

Task 7's rendered browser evidence remains applicable because this task changes
only worker-side preview/validation behavior and no player production code. Task 7 passed 24
default-browser tests with one conditional skip, three alternate web-awesome
browser tests, 39 diagnostics, and 51 focused units. Its committed screenshots
cover offered retry, decision-save failure, eligible, blocked, and accepted
states at both required viewport sizes: [web-next retry 390](assets/generation-rejection-review/web-next-retry-reoffered-390.png),
[web-next retry 1440](assets/generation-rejection-review/web-next-retry-reoffered-1440.png),
[legacy retry 390](assets/generation-rejection-review/legacy-retry-reoffered-390.png),
[legacy retry 1440](assets/generation-rejection-review/legacy-retry-reoffered-1440.png),
[web-next accepted 390](assets/generation-rejection-review/web-next-accepted-390.png), and
[legacy accepted 1440](assets/generation-rejection-review/legacy-accepted-1440.png).
This task did not rerun browser tests or live providers.

## Release decisions carried into verification

- A new primary dispatch uses its persisted reservation/start marker; lease
  reclaim cannot become silent consent. An explicit review retry is the only
  later dispatch authority. If this is wrong, recovery must be redesigned before
  release rather than accepting a silent regeneration.
- Keep preserves a main-scene prefix only within that authorization; a later
  explicit replacement retry may supersede it while retaining the journal. If
  this is wrong, a legitimate replacement would be blocked indefinitely.
- Old jobs without a review checkpoint retain the legacy recovery route. If this
  is wrong, the compatible worker must resolve them before rollout; it must not
  fabricate an eligible draft from a partial preview.

## Implementation decisions retained from the delivery ledger

- The worktree used its own configurable browser ports because the default
  ports were occupied by another checkout. If this isolation is wrong, browser
  evidence could describe a different build.
- A static safe reason projector was added before richer review detail so public
  consumers cannot expose private findings. If this boundary is wrong, a later
  detail feature could leak reviewer text.
- The transactional acceptance guard was delivered before worker wiring because
  final Keep needs its durable waiver. If the order is wrong, a worker could
  claim acceptance before the commit path enforces it.
- The new primary reservation marker distinguishes recovery from user consent.
  If it is wrong, the workflow must be redesigned rather than silently issuing
  another provider request.

## Rollout and rollback

Stop intake and old workers, let in-flight work finish or explicitly resolve
pending reviews using compatible code, deploy the API, worker, and both players,
then resume intake. Jobs without a review checkpoint retain their old recovery
path; do not manufacture a keepable candidate from a partial preview.

To roll back, stop intake and workers, resolve pending or queued review jobs
with compatible code, then return old workers. Retain accepted turns and private
audit records; no destructive down migration is required.
