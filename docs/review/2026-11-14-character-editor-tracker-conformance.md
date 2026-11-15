# Character Editor and Tracker conformance review

All three findings from this review are **fixed and regression-tested**: merge-aware mention tracking, preservation of unsaved mechanics when changing character use, and display of authored roles in the world roster. This closes the identified defects; it is not an exhaustive certification of every requirement or deployment readiness.

Initially reviewed on November 14, 2026 against commit `6a1c09deae80ec059902854e20ede7eaa9bf9df9`. Before implementing the fixes, fetched origin and fast-forwarded the current branch to `origin/main` at `10825e95` (the merge of PR #211). The fixes and this report are local, uncommitted changes on that baseline.

## Agreed scope

The user confirmed repository conformance to the approved scope, with explicit deferrals listed separately. Production configuration, deployment readiness and live-model quality are separate assessments.

The governing sources are the [unified character design](../superpowers/specs/2026-11-08-unified-character-editor-and-starting-cast-design.md), including its overriding round-2 amendments; the [implementation plan](../superpowers/plans/2026-11-08-unified-character-editor-and-starting-cast.md), including remediation phases 7–9; and the [character revamp](../superpowers/plans/2026-11-06-characters-revamp.md), [automation](../superpowers/plans/2026-11-06-characters-automation.md) and [interface](../superpowers/plans/2026-11-06-characters-interface.md) plans.

Relevant architecture decisions are [reviewed authoring](../architecture/0016-reviewed-character-authoring.md), [structured profiles](../architecture/0023-structured-character-profiles.md), [identity matching](../architecture/0041-campaign-cast-unique-name-matching.md), [unified editing and starting cast](../architecture/0042-unified-character-editor-and-starting-cast.md), and [reference translation](../architecture/0043-shared-campaign-cast-reference-translation.md).

## Resolution

| Finding | Change | Regression evidence |
|---|---|---|
| F1 | The lexical matcher excludes merged-away records from both name ownership and mention targets. Ignored and protagonist identities still participate in ambiguity checks. | Four unit cases cover retained duplicate names, retained aliases, omitted names and reused names. Two PostgreSQL cases exercise actual merge projection, accepted-turn mention publication and replay, and resulting recency. |
| F2 | The editor captures the initial mechanics form values. Supporting saves preserve untouched original arrays exactly, but parse the current rows if the user changed them before switching use. | Four Chromium cases cover new and existing characters at 1440px and 390px: edit stat and tracker → Supporting → apply → reopen → Playable → verify values → Supporting → save world and verify payload. Existing hidden-mechanics generation tests also pass. |
| F3 | The roster reads `profile.story.role`. | Two Chromium cases assert the visible authored role at 1440px and 390px. |

The four new matcher cases and all six new browser cases failed against the original implementation before the fixes. The existing management unit harness was updated to load the extracted mechanics helper. Independent read-only code review found no actionable issues.

## Original findings and reproduction evidence

The following describes the pre-fix implementation. Original line numbers refer to the initial review baseline.

### F1 — Merge rules are not applied to lexical mention matching

**Priority: P2. Requirement: D17 and reviewed merge aliases.** An omitted merge name must stop resolving to the surviving character and become available for another character.

The accepted-turn hook passes the full projected cast to `findCastMentions` in [campaign-cast-mentions.ts](../../packages/database/src/campaign-cast-mentions.ts). The [matcher](../../packages/domain/src/campaign-cast-mentions.ts) builds term ownership from raw character IDs and excludes only protagonists and ignored characters from matching. Merged-away records therefore remain both collision candidates and match targets.

Executed the current matcher with three synthetic cases:

| Input | Actual result | Required result |
|---|---|---|
| One active Mara; narration says “Mara waved.” | Mention of Mara | Mention of Mara |
| Mara merged into another Mara; same narration | No mention, because two IDs own the name | Mention of the surviving Mara |
| Mary merged into Mara, with Mary omitted from reviewed aliases; narration says “Mary waved.” | Mention of the merged-away Mary | No mention of either existing identity |

The repository subsequently credits source-record lexical mentions to the merge target when projecting `lastMentionedTurn`. The third case can therefore refresh Mara's recency using a deliberately retired name. A newly created Mary can also lose mentions because the historical Mary manufactures an ambiguity. Recency affects character context selection.

The discovery publication path already excludes merged-away identities; lexical tracking needs the same effective identity semantics while retaining genuine ambiguity protections. Add regression coverage for retained duplicate names, omitted names and reuse of a retired name. The current eight-row mention test table has no merge case.

### F2 — Switching to Supporting discards mechanics edited in the same dialog

**Priority: P2. Requirement: 4.18 and the promise that switching use loses nothing.**

In [nexus.js](../../apps/web/src/nexus.js), `characterFromForm` lines 3191–3192 copies `base.rpgStats` and `base.defaultTriggers` whenever the current use is Supporting. It does not read the current form mechanics.

Reproduction: open a Playable character with Resolve 12 and a tracker value of “old”; edit those fields to 55 and “edited”; switch Use in campaigns to Supporting; apply the character. Executing the extracted current function returns Resolve 12 and “old”, with zero calls to read the mechanics form. A new character similarly loses mechanics entered before switching to Supporting because its base arrays are empty.

Persisted mechanics survive a simple use toggle; the missing case is changes made before the toggle in the same unsaved editing session. Preserve the current mechanics draft when hiding it, and test edit → Supporting → save → reopen → Playable.

### F3 — World roster rows ignore the authored role

**Priority: P3. Requirement: World roster rows show name, role, use and completeness.**

The roster renderer at [nexus.js](../../apps/web/src/nexus.js) line 3220 reads `character.profile?.role`; structured profiles store this value at `character.profile.story.role`.

Executing the current renderer with a DOM fixture containing `profile.story.role = "Guide"` produces “Playable · No role”. This misrepresents a populated field. Read the structured role and assert its visible value in the roster test.

The F2 and F3 reproductions execute functions extracted from the current source. They are not browser end-to-end evidence.

## Requirements and evidence

| Area | Assessment |
|---|---|
| Shared editing, structured fields, authoring | Implemented across the approved Nexus entry points; F2 and F3 are now covered by passing browser regressions. |
| Playable/Supporting/Both and starting cast | Contracts, selection readers, seeding and opt-in behavior are present. Historical plan evidence covers creation and browser interactions; this review did not rerun every numbered criterion. |
| Campaign authority and persistence | Fresh repository, lifecycle, merge and portability PostgreSQL suites passed. No additional defect confirmed in that focused review. |
| Fixed fields, observations, overrides and reset | Shared policies and associated unit coverage are present. Fresh character/cast unit tests passed; no claim of exhaustive real-provider verification. |
| Matching, review and recovery | Frozen matching policy, first-appearance publication checks, removed-target review exclusion and source revision checks are present. F1 is fixed with effective-identity regressions. |
| Context and recency | Unit and composed generation suites passed. New PostgreSQL regressions verify the corrected recency after retained, omitted and reused merge names. |
| Merge, remove, restore and portability | Initial lifecycle/portability evidence is supplemented by fresh lifecycle, merge and generation suites after the fix. |
| Bulk generation, conversion and Draft from story | Implementations and historical acceptance evidence exist. Live-provider quality remains unverified and separate. |

This is a targeted conformance audit with confirmed counterexamples, not a new exhaustive sign-off of every acceptance criterion. The plan's completed checkboxes and historical results should not be treated as proof of these newly identified cases.

## Verification after the fixes

| Check | Result |
|---|---|
| Full unit suite | **Passed:** 435 files, 5,634 tests; 44 existing skips are not counted as passes. |
| PostgreSQL lifecycle, merge and composed generation | **Passed:** 3 files, 42 tests, including two new merge/mention scenarios. |
| Chromium authoring, unified editor and campaign cast | **Passed:** 100 tests. The six new cases passed again after adding page checks and scrolled phone screenshots. These six overlap the 100 and are not additional coverage. |
| `pnpm check` | **Passed:** repository/data boundaries, TypeScript and client checks, JavaScript syntax. |
| `pnpm check:client-boundaries` | **Passed.** |
| Both web builds | **Passed.** Web-Next reports font URLs left for runtime resolution and a large-chunk warning; neither fails the build. |
| Review document links and `git diff --check` | **Passed.** |

Commands run from the repository root:

```powershell
node node_modules/vitest/vitest.mjs run tests/unit --exclude '**/.worktrees/**' --exclude '**/.codex/**' --exclude '**/.claude/**'
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/campaign-cast-lifecycle-merge.integration.test.ts tests/integration/campaign-cast-lifecycle.integration.test.ts tests/integration/campaign-cast-generation.integration.test.ts
node node_modules/@playwright/test/cli.js test tests/e2e/character-authoring-simplification.e2e.test.ts tests/e2e/unified-character-editor.e2e.test.ts tests/e2e/campaign-cast.e2e.test.ts --workers=2
pnpm check
pnpm check:client-boundaries
pnpm build:web:legacy
pnpm build:web:next
```

### Browser setup and interaction evidence

The initial `ENOENT` came from Corepack resolving pnpm inside a sandbox-specific cache. Running the existing Playwright command with approved host permissions uses the installed pnpm 12.4.1 cache and starts both Vite servers. No package version, lockfile or Playwright configuration change was needed. For repository scripts, invoke `pnpm` directly: `corepack pnpm check` exposed a nested global pnpm 11.15.1 conflict; direct pnpm resolves the pinned version correctly.

The Browser plugin is not available in this session, so verification used the repository's Playwright/Chromium workflow. Nexus runs at `http://127.0.0.1:43173/nexus/index.html#world-library`; Web-Next fixtures run on port 43174. New tests use 1440×900 and 390×900 viewports. They verify the Nexus title, meaningful editor/roster content, absence of a Vite error overlay, retained mechanics and the saved world payload. The mechanics flows report no uncaught page errors. Screenshot inspection confirms readable role and mechanics values; on phones, the tracker requires scrolling, and a second screenshot captures it.

Screenshots were saved outside the repository through `CAST_SCREENSHOT_ROOT` to the session visualization directory. Evidence files are `roster-role-1440.png`, `roster-role-390.png`, `mechanics-edited-1440.png`, `mechanics-edited-390.png`, `tracker-edited-390.png`, and corresponding new-character mechanics/tracker captures. These are local review artifacts, not deployed assets.

### Earlier runs and limits

The initial audit passed 2,103 focused unit tests and 80 PostgreSQL tests; those are pre-fix evidence. During remediation, an initial broad unit invocation included stale `.claude/worktrees` tests and was stopped. The corrected sandbox run found the management harness dependency and filesystem/junction permission failures in asset-archive and private-continuity tests. After updating the harness and running with host permissions, the full corrected suite passed as reported above. No failing or interrupted invocation is counted as passing.

**Not run:** every integration suite, production activation, recovery-set restore, or live-provider calls. Browser fixtures use controlled API responses; the separate PostgreSQL tests establish persistence behavior. The 44 unit skips remain unverified. This review does not certify deployment or model quality.

## Explicit deferrals

- Web-Next's shared-editor adoption, full starting-cast picker and related redesign remain outside the approved release scope. Its compatibility obligations remain in scope.
- NPC illustration consistency is a separate design follow-up.
- Physical-presence tracking, structured relationship edges and changing the auto-match default are explicit non-goals or separate decisions.
- Lifecycle implementation is reviewed here, but enabling its separately gated release requires the operational evidence specified by the runbook.

## Recommended disposition

F1–F3 are closed with targeted regressions, passing affected suites and current browser evidence. Keep the approved design and explicit deferrals. No new domain terminology or architecture decision was required, so the glossary and ADRs remain unchanged.
