# Campaign memory defaults and selector implementation plan

> **For agentic workers:** Use test-driven development for each task, retain ownership of assigned files, and independently review the integrated result.

**Goal:** Enable Max memory for existing and newly created campaigns and provide a persistent memory-level dropdown in both active interfaces.

**Architecture:** Keep `campaign_story_memory_enrollments` as the single source of truth. An additive migration backfills all campaigns to R3/enforce and initializes new campaign rows with that default. Missing enrollment still means Off, so explicitly disabling a campaign remains durable. Shared API contracts expose readable levels and operator availability; enqueue continues to freeze policy under the campaign lock.

**Tech Stack:** TypeScript, PostgreSQL, Fastify, existing legacy and replacement browser interfaces, Vitest and Playwright.

**Spec:** User request in this task: enable all existing campaigns, default new campaigns to Max, add a campaign memory-level dropdown. The user explicitly selected enforce semantics for Max. This supersedes the earlier opt-in/default-off rollout decision for this implementation.

## Global constraints

- Levels: Off = absent enrollment; Standard = R1/off; Enhanced = R2/off; Max = R3/enforce.
- Default runtime capability is R3 and enforcement is enabled; explicit operator overrides remain supported and reported by the API.
- Migration changes only enrollment, not accepted turns, character content, prompt overrides, or world versions. Existing queued/recoverable jobs retain frozen policy.
- New campaign creation, branching and imports receive the destination installation's Max default. Enrollment remains excluded from exported private operational data.
- Preserve owner isolation, shared API schema validation and generation locking. Never auto-acknowledge existing custom prompt overrides.
- Implement in the current worktree. Test only disposable databases and mock-provider/browser fixtures. No live deployment is performed by the code implementation.

## Task 1: Persistence and API

Files: `database/migrations/0096_campaign_memory_defaults.sql`, `packages/contracts/src/story-memory-policy.ts`, `packages/database/src/story-memory-policy-repository.ts`, `services/api/src/server.ts`, focused unit/integration tests.

- [x] Add failing tests for backfill, defaults on insertion, explicit Off surviving rereads/restarts, owner isolation, invalid levels, operator restrictions and queued-job immutability.
- [x] Add transactional default enrollment migration and creation trigger without rewriting accepted data or old jobs.
- [x] Add shared `StoryMemoryLevel` and settings schemas. Expose GET/PUT `/api/v1/campaigns/:campaignId/story-memory` returning `{ level, reviewMode, availableLevels }`; PUT accepts `{ level }`.
- [x] Preserve existing enrollment endpoints and policy snapshot compatibility; test actual PostgreSQL/API paths.

## Task 2: Paired interfaces

Files: active legacy Story player and campaign settings, replacement Story/campaign settings, shared browser adapter where needed, related unit/browser tests.

- [x] Add failing tests for saved selection, reload, switching campaigns, unavailable levels, save failure and stale responses.
- [x] Display Off, Standard, Enhanced and Max using shared settings contracts and the server's returned selection.
- [x] Save per campaign; retain unsent story text and avoid changing an in-flight job's displayed policy.
- [x] Verify changes and reload persistence in both rendered interfaces at desktop and mobile widths; capture screenshots.

## Task 3: Configuration, compatibility and documentation

Files: `packages/database/src/config.ts`, Compose/Swarm configuration, environment examples, rollout/user documentation and affected compatibility fixtures.

- [x] Capture failing default-setting tests; enable R3/enforce by default and preserve explicit operator overrides.
- [x] Update creation/import/branch fixture expectations and explicitly label legacy-mode test fixtures instead of weakening assertions.
- [x] Update default/enrollment documentation and explain next-job behavior, custom-prompt compatibility and rollback controls.
- [x] Run unit, isolated PostgreSQL, type/build, deployment configuration and rendered-browser checks. Independently review the complete change.
- [ ] Publish a follow-up PR and follow CI to completion. PR #157 was merged while this follow-up was being implemented.

## Verification record

- Full unit suite: 3,636 passed, 44 intentionally skipped. Repository/type checks, application build and documentation build passed.
- Real PostgreSQL: enrollment/migration 12 passed; campaign routes eight passed and one platform-specific filesystem case skipped; default runtime review worker 27 passed; legacy generation 50 passed; affected generation/image/budget/Story-only suites 79 passed and 21 opt-in or platform-specific cases skipped.
- Linux PostgreSQL: migration/archive expectation suites 121 passed; archive compatibility and independent reruns of timing-sensitive preflight cases 21 passed. The initial broad preflight exposed stale migration/default fixtures; it is not represented as an all-green full integration run. Remote CI runs each integration file in isolation.
- Rendered Chromium: new interface four passed; legacy interface two passed. Coverage includes save/reload, failure/retry, retained drafts, stale responses, campaign switching and explicit observe-mode readback. Browser fixtures use mocked APIs; database tests separately verify live API persistence.
- Browser regressions found and fixed: legacy memory loads were invalidated by a later turn-window epoch increment; the new editor retained old review-mode guidance after saving; its first save bar overlapped the added memory heading.
- Independent review found no remaining correctness blockers. No production deployment or live-provider quality/cost canary was performed.

Sanitized screenshots: [new editor desktop](../../review/assets/campaign-memory-defaults/new-editor-desktop.png), [new editor mobile](../../review/assets/campaign-memory-defaults/new-editor-mobile.png), [new Story desktop](../../review/assets/campaign-memory-defaults/new-story-desktop.png), [new Story mobile](../../review/assets/campaign-memory-defaults/new-story-mobile.png), [legacy editor desktop](../../review/assets/campaign-memory-defaults/legacy-editor-desktop.png), and [legacy Story mobile](../../review/assets/campaign-memory-defaults/legacy-story-mobile.png).
