# Character authoring simplification implementation plan

**Goal:** Fix the reviewed creation/editing defects, then reduce manual entry through prominent AI drafts, concise forms, and readable review.
**Architecture:** Preserve existing provider APIs, authoritative structured profiles, world/campaign separation, and explicit acceptance. Simplify existing surfaces without adding automatic inference or saves.
**Spec:** User-approved character GUI review, `.impeccable/critique/2026-11-06T23-54-33Z__apps-web-src-campaign-cast-panel-ts.md`, plus the instruction to minimize manual work.
**Tech stack:** TypeScript/JavaScript, existing DOM components, Vitest, Playwright.

## Constraints and execution rulings
- Continue the current topic checkout because the preceding fixes are uncommitted here; preserve unrelated changes and do not deploy, commit, or mutate live campaign data.
- Implementation is authorized. No additional plan approval is required.
- AI remains user-triggered, drafts remain reviewable, and accepting world content remains distinct from saving the parent world.
- Never promote legacy text implicitly into authoritative profile fields. Make new authoring use structured fields; retain imported text as source material.
- Keep manual fallback, unknown fields, source evidence, revision checks, and generation locks.
- Parallel tasks own separate files; functional corrections precede simplification within each task.

## Tasks
- [x] Replacement character workspace: tests first for structured story validation, Paste availability, mechanics removal; fix these, move technical ID/source material out of primary fields, default new creation to AI-assisted with manual fallback, offer generated profile review without traversing optional stages, and render actual values with edit links. Own `apps/web-next/src/character-workspace-{page,model}.ts` and associated unit tests.
- [x] Legacy world/campaign profile modal: tests first for organizer-specific validation and error targets; fix these and empty Mechanics disclosure; surface generation before manual fields, group optional story detail, show imported source only when present, explain unavailable generation, preserve draft/save semantics and generation replacement protection. Own `apps/web/public/index.html`, `apps/web/public/nexus.css`, `apps/web/src/nexus.js`, relevant management tests.
- [x] Supporting-character editing: test new-draft conflict recovery, then implement it in replacement editor; reduce reset noise, group supporting fields, clarify pin/ignore, favor story fields for new creation. Own both `characters-workspace.ts` and `campaign-cast-panel.ts`, relevant cast unit/e2e tests.
- [x] Integration verification: run affected unit/type/build checks; browser-test creation/editing, AI draft review using fixtures, clipboard, mechanics removal, conflict recovery, desktop/mobile captures. Review changes independently and fix demonstrated regressions.

## Review focus
1. Empty pasted text and generation-in-progress must not enable invalid requests.
2. AI generation must not silently overwrite edited drafts or save authority.
3. Legacy-only imported material must remain preserved and clearly labeled.
4. New-character conflicts retain drafts and permit recovery.
5. Optional controls remain reachable on small screens and with keyboard focus.

## Preflight
| Task pair | Shared boundary | Ruling |
|---|---|---|
| Workspace / legacy modal | Same conceptual profile, no edited files shared | Keep structured profile authoritative; legacy source stays separate. |
| Workspace / cast | Different editor files, shared descriptors read-only | Do not change shared contracts. |
| Legacy / cast | Distinct modal owners and styles | Cast changes scoped to cast classes. |
| Each task | Tests reflect behavior before UI simplification | Run regressions before and after fixes; integrate screenshot evidence at end. |

## Progress
Implementation and independent review completed. Akane evidence confirmation, unfiltered match selection, draft conflict recovery, structured character validation, clipboard state, mechanics removal, and streamlined creation/editing are covered by regression checks.


## Verification results
- Passed: full unit suite, 5,323 tests with 44 skipped; after the final name-only mechanics correction, 43 affected workspace tests passed (including the added regression).
- Passed: 61 isolated PostgreSQL cast integration tests.
- Passed: 34 cast/new-workflow/error browser cases, 11 character/resume cases, 9 legacy disclosure cases, and 5 legacy AI/world-resume cases. Browser provider responses were mocked; live provider generation was not exercised.
- Passed: repository boundaries/data checks, package and root TypeScript checks, both web production builds, server compilation, JavaScript syntax, asset precompression, and diff whitespace checks.
- Build/check wrapper could not run because Corepack selected pnpm 11.15.1 while this checkout requests 12.4.1; underlying checks/build commands passed directly. Web-next retains runtime font-resolution and bundle-size build warnings.
- Design detector ran in degraded regex mode because optional parser dependencies are absent; its sole warning concerns the unrelated hidden world-cover preview. Desktop/mobile interaction and screenshot verification supplemented it.
- Screenshots: external task output directory contains legacy-ai-character-{1440,390}.png, character-concept-{1440,390}.png, character-review-{1440,390}.png, and legacy-character captures.
- No live campaign mutations, deployment, commit, or changes to provider contracts. Existing unrelated local changes preserved.
