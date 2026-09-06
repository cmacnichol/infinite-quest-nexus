# AI Assist Patch 1 verification record

Patch 1 is implemented and verified in `codex/ai-assist-patch-1` at `C:\Git\InfiniteQuest\.worktrees\ai-assist-patch-1`. All seven task reviews and the independent whole-patch review/fix re-review passed. Both final P1 integrity findings are resolved with no residual finding. The controller completed the final requirement/scope audit and refreshed all four live checks after the integrity fixes. Changes remain uncommitted and undeployed; main integration and Patches 2/3 have not started.

## API, provider and persistence evidence

`tests/integration/authoring-reliability.integration.test.ts` replaces the earlier two adapter-only substitutes with eight real Fastify/API cases. It uses production world/campaign and provider compositions, `app.inject`, actual HTTP requests to a loopback synthetic compatible provider, and isolated PostgreSQL. The JSON fixture contains synthetic material only.

- Standalone malformed output followed by valid repair returns 200 after two HTTP calls. Database snapshots match before/after preview. Explicit PUT then advances the stored draft revision from 1 to 2.
- Malformed world output followed by valid repair preserves `{ title, content }` with three validated seeded characters. Five HTTP calls mean two world-stage calls plus one per child; the four-call cap is per stage. Stored snapshots remain unchanged.
- Exhausted world, standalone character, and campaign organizer repair each returns safe 502 after exactly two HTTP calls. Before/after queries compare actual world metadata, draft content/revision, campaign profile/revision, and immutable world versions. Draft and campaign-profile rows are explicitly required to exist.
- A synthetic secret-shaped sentinel in both rejected replies is absent from the public response and captured runtime/Fastify request-error logs. The test requires an actual authoring API log, preventing an empty-log false positive.
- A mechanics violation retains its specific code-owned reason through the actual provider/API response and browser parser.
- Both real world and standalone no-enabled/default-provider paths retain 409 and `details.code = default_text_provider_unavailable`, with zero provider calls. These schemas select the server default and accept no provider-profile ID. A concurrent deletion between resolution and execution is not simulated; that race is not claimed verified.

Manual incomplete drafts remain valid. Creative completion applies to generated candidates. Human save remains a separate revision-checked action. World-library integration additionally checks foreign-owner 404 and unchanged owner-scoped draft/profile values after organization failures; its injected collaborators are distinct from the new actual HTTP provider coverage.

## P1.7 review fix: successful organization and explicit save

The task review found the required world-library file had no P1.7-specific extension. A new real PostgreSQL regression now covers both owner-scoped world and campaign organization using a minimal evidence-backed appearance-only candidate. Each proposal returns the exact sourced clothing fact and leaves draft/profile revisions, immutable world content, campaign snapshot, and profile audit rows unchanged. Explicit world save increments only the draft revision; explicit campaign save increments its profile revision and adds one `ai_organized` audit row. Published world content and the original campaign snapshot stay unchanged. Stale world and campaign saves both reject with 409, and the complete post-save snapshot remains unchanged. Exactly two provider collaborator executions occur; saving never calls the provider.

This complements P1.5 failure/no-write coverage and the separate real API standalone explicit-save test. The collaborator in this world-library test is synthetic; actual HTTP provider behavior remains covered by the eight API tests. No production code changed. The new regression passed on its first run; no product-defect RED is claimed for this test-only coverage addition.

```powershell
node node_modules/vitest/vitest.mjs run --config .superpowers/sdd/2026-09-06-ai-assist-patch-1-reliability/vitest.integration.config.ts tests/integration/world-library.integration.test.ts
pnpm --filter @infinite-quest/docs build
git diff --check
```

Fix-round results: world-library 30/30 passed (`task-7-fix-1-db.log`); docs build and diff check passed (`task-7-fix-1-docs.log`, `task-7-fix-1-diff.log`). Unchanged units, browser and application build were not repeated. The 46-case current total combines the unaffected 16 cases from the previous combined run with the freshly rerun 30 world-library cases; it is not described as a new combined 46-test invocation. That P1.7 scoped task re-review was subsequently accepted; the separate final integrity-fix re-review subsequently passed.

## Whole-patch review: final integrity fixes

The independent whole-patch review confirmed that evidence-backed organizer metadata could pass the proposal gate and that generated world fiction bypassed mechanics validation. Both are now covered by production-boundary regressions and a consolidated fix, with scoped independent re-review passed.

- Organizer integrity uses the same recursive prohibited-key and fiction guard as generated characters, independently of creative minimum. The exact `privateReasoning: "never save"` candidate with a valid `legacyGuidance: "Blue coat"` evidence quote rejects. Nested, array, boolean, numeric, and null metadata values also reject with the controlled metadata reason. One valid appearance-only replacement succeeds; an invalid replacement ends with a safe organizer-stage error after two calls. Manual storage schemas remain unchanged.
- A shared generated-world fiction guard validates title, genre, tone, premise, background and opening during the outer world-stage parse, for both initial and repair responses, before child generation. Final generated-world completion uses that same guard. The exact background `Roll d20 with modifier +3 to enter the harbor.` rejects; modifier-only and private-reasoning prose also reject with controlled `world.*` paths and mechanics reasons. Diegetic numbers, rules, and separately typed RPG statistics remain accepted.
- Runtime regressions prove initial world contamination consumes the existing single world repair and children receive the validated replacement. A contaminated replacement fails at the world stage after two calls, with no child calls or child progress and no rejected sentinel in public failure details. No retry loop, migration, save behavior, prompt, UI, or storage-schema change was added.

Strict RED: 14 new regressions failed and 63 existing/compatibility cases passed across three files (`final-fix-red.log`). GREEN: 77/77 passed (`final-fix-green.log`). The current full focused rerun passes 398 units in 16 files, and a single fresh isolated PostgreSQL invocation passes all 46 cases in the three affected suites. Check/build initially found a TypeScript-only Zod issue-forwarding incompatibility; object spread preserves issue fields and runtime behavior, and the corrected gates pass. Logs retain the initial errors separately. The final unit rerun includes that correction and the explicit typed-mechanics compatibility assertion.

Browser checks were not repeated because this fix changes no rendering or interaction; the prior two rendered flows remain the browser evidence. The four earlier live successes predate these integrity fixes; all four were subsequently refreshed successfully on the reviewed guard behavior, as recorded below. A runtime-equivalent Zod issue-object spread correction occurred during the refresh and did not require duplicate provider calls. The final fix report and scoped diff are retained in the ignored task evidence directory.

## Error-policy consolidation and RED/GREEN

The browser-safe contracts module now owns the path/code/message policy. Domain validators delegate to it while retaining Zod adaptation. The public message allowlist is derived from the same message function. Known mechanics, evidence, seed identity, completion and schema reasons survive; unknown character/organizer paths fall back to `generatedCharacter`/`profile`.

Five focused new regressions initially failed: three specific reasons were replaced and two stages used a world fallback. `projection-consolidation-red.log` records 5 failed/2 passed; `projection-consolidation-green.log` records the focused domain/server/browser suite passing after consolidation. Earlier inside-issue sentinel RED/GREEN evidence remains in scratch.

The API suite ran before any integration-driven production fix. Initial failures exposed test-harness mistakes: publish returns `worldVersionId`, typed API details are nested under `details`, and Fastify request logging differs from the runtime logger. Those fixtures/assertions/hooks were corrected to actual contracts; these runs are not called product-defect RED evidence. No integration production fix was needed. The final eight cases pass. TypeScript then caught the fixture's missing NodeNext JSON import attribute; the attribute was added and checks passed.

## Exact verification commands

Working directory: `C:\Git\InfiniteQuest\.worktrees\ai-assist-patch-1`. The private task database configuration is intentionally omitted. The inherited integration config replaces only default provisioning and retains per-file database isolation.

```powershell
$D = ".superpowers/sdd/2026-09-06-ai-assist-patch-1-reliability"
node node_modules/vitest/vitest.mjs run tests/unit/authoring-output.test.ts tests/unit/authoring-prompts.test.ts tests/unit/authoring-response-adapter.test.ts tests/unit/character-generator-service.test.ts tests/unit/world-generator-service.test.ts tests/unit/generated-world.test.ts tests/unit/world-library.test.ts tests/unit/character-profiles.test.ts tests/unit/prompt-library.test.ts tests/unit/web-next-authoring-errors.test.ts tests/unit/web-next-world-creation-api.test.ts tests/unit/web-next-world-creation-page.test.ts tests/unit/web-next-character-workspace-api.test.ts tests/unit/web-next-character-workspace-page.test.ts tests/unit/server-security.test.ts tests/unit/providers.test.ts --exclude "**/.worktrees/**" --exclude "**/.codex/**"
node node_modules/vitest/vitest.mjs run --config "$D/vitest.integration.config.ts" tests/integration/authoring-reliability.integration.test.ts tests/integration/world-generation.integration.test.ts tests/integration/world-library.integration.test.ts
$env:PLAYWRIGHT_BROWSERS_PATH = (Resolve-Path "$D/browsers").Path
node node_modules/@playwright/test/cli.js test --config "$D/playwright.config.ts" tests/e2e/ai-assist-errors.e2e.test.ts
pnpm check
pnpm build
pnpm --filter @infinite-quest/docs build
git diff --check
```

| Gate | Result | Scratch evidence |
| --- | --- | --- |
| Focused units including provider HTTP compatibility | Passed: 398 tests, 16 files after integrity fixes | `final-fix-units.log` |
| Real PostgreSQL integration | Passed: 46 tests across 3 files in one fresh post-fix invocation | `final-fix-db.log` |
| Rendered Chromium flows | Passed previously: 2 tests; unchanged rendering not rerun | `final-browser.log` |
| Repository boundaries/data safety, TypeScript, clients and legacy syntax | Passed | `final-fix-check.log` |
| Application build | Passed | `final-fix-build.log` |
| Docs build and internal links | Passed | `final-fix-docs.log` |
| Diff check | Passed | `final-fix-diff.log` |
| Shared default provisioning | Not used: existing persistent-volume password mismatch; shared data untouched | Prior preflight evidence |
| Live provider | Passed: all four refreshed exercises after integrity fixes | `live-final-results.json`, `live-final.log` |
| Task and whole-patch review | Passed: all seven task gates, both final findings addressed, no residual finding | `task-1-review.md` through `task-7-review.md`, `whole-patch-review.md`, `final-re-review.md` |

Direct installed Node entrypoints replace Windows `pnpm exec` forms that could not locate CLI shims. Chromium required established Windows process-launch escalation. The browser's NO_COLOR/FORCE_COLOR warning and the production build's greater-than-500kB chunk warning did not fail their commands. No baseline comparison establishes whether the chunk warning is new; bundle optimization is outside this patch. Git warns about an inaccessible global ignore file and line-ending normalization; checks still exit zero.

VitePress initially failed on unfenced generic types in the copied Patch 2 plan. Only Markdown rendering/link validation was corrected; Patch 2 executable work was not started. This is distinct from application behavior and is recorded as a corrected documentation build failure.

## Intentional assertion and compatibility changes

Existing world-generation integration tests use `toContain` for catalog prompts because mandatory code-owned contracts are appended. Incomplete children now produce common `invalid_authoring_output` character-stage details with safe profile paths instead of seed-name-bearing legacy details. Authoring HTTP 500 and blocked destinations normalize to safe 502 `authoring_provider_rejected`; oversized output becomes 502 `authoring_output_limit`. These are intentional authoring-boundary changes, not general provider API changes. Import/world progress retains a generic safe status message while the POST carries actionable details; UI tests protect that POST error from later polling.

The exact world preview `{ title, content }` and standalone `{ character }` shapes remain unchanged. Strict evidence, own-key, alias/conflict, creative minimum, revision, original-context repair, and actual retry-timing coverage remain in the focused suites.

## Rendered evidence

All four refreshed screenshots were visually inspected. Prompts and controls remain visible; error and correlation text wrap at 390px. Provider Setup appears for the character availability failure and is absent for world validation failure. These routed browser fixtures establish rendering/interaction; the separate integration suite establishes actual API/database behavior.

| Flow | Desktop | 390px |
| --- | --- | --- |
| World validation | [World desktop](assets/ai-assist-patch-1/world-authoring-error.png) | [World narrow](assets/ai-assist-patch-1/world-authoring-error-narrow.png) |
| Character availability | [Character desktop](assets/ai-assist-patch-1/character-authoring-error.png) | [Character narrow](assets/ai-assist-patch-1/character-authoring-error-narrow.png) |

## Selected live provider

All four exercises were refreshed after the final integrity fixes against Local LM Studio model `qwen3.5-27b-uncensored-hauhaucs-aggressive` using synthetic disposable world/campaign data in the task PostgreSQL instance. Production provider defaults and existing user content were unchanged.

| Exercise | Outcome | Duration | Actual generation HTTP calls |
| --- | --- | --- | --- |
| World and three characters | Passed | 588.255 s | 4 |
| Standalone character | Passed | 113.513 s | 1 |
| World character organization | Passed | 218.924 s | 1 |
| Campaign character organization | Passed | 192.380 s | 1 |

All requests were stateless with response-format fallback forbidden. World requests used `world-authoring-v2-validated-profile`; standalone and seeded characters used `character-authoring-v3-validated-profile`; organizers used `character-profile-organizer-v3`. The four world calls are one outer world plus three child characters; each other exercise used one call. No repair was needed in this refresh. Deterministic regressions, not these live successes, establish malformed-output repair and transport-failure behavior.

Evidence: ignored `live-final-results.json` and `live-final.log`. Earlier complementary pre-fix records remain in `live-world-character-results.json` and `live-organizer-results.json` for history, not as current-guard proof. Only safe metadata is retained; raw provider responses are not stored. One selected model does not establish universal provider compliance or production reverse-proxy/browser timeout behavior. Generation remains synchronous; durable resume is Patch 2.

The controller verified that all 37 reviewed non-document files still match their recorded SHA-256 hashes after the final re-review. The main checkout retains only the original four untracked plan documents; no implementation changes were made there. The ignored evidence workspace and dedicated test environment are retained for follow-up verification.

## Controller rulings and tradeoffs

Every ruling from the execution ledger follows, including the rejected port and its replacement:

- Ruling: Use a PowerShell/Python adaptation of sdd-workspace/task-brief because the supplied bash extractor only recognizes Task N headings, while the accepted plan uses P1.N. Same ignored workspace and full task text are preserved.

- Ruling: Plans are copied from the main checkout into the isolated worktree; no main-checkout files will be changed. Local commits are not requested by the plan; use scoped snapshots and review packages until publication is requested.

- Ruling: Source completion mode is a pure validator option only; no Patch 3 routes, storage, or UI. Shared repair helper must have exactly one loop, not nested repair wrappers. Stored incomplete drafts stay valid.

- Ruling: Preflight findings accepted: preserve saved override snapshot hashes, capture a separate effective authoring prompt identity; add typed Retry-After carrier at existing HTTP boundary; project authoring errors through a closed allowlist and do not leak generic 5xx issues. See preflight-report.md.

- Ruling: Shared default integration provisioning failed with stored-volume credentials, including after using main test config. Use a separate ephemeral PostgreSQL at 127.0.0.1:55439 and an ignored config inheriting vitest.integration.config.ts with only provisioning replaced; original setup-isolated-database.ts still creates/drops an isolated database per test file. Do not change production or shared DB credentials.

- Test-container port ruling: Windows rejected 55439; use verified available loopback port 15439. The first container never started and is removed before retry.

- Windows runner ruling: pnpm exec cannot locate vite/playwright despite installed CMD shims; direct node CLI and pnpm package scripts work. Browser config inherits repository Playwright settings and only supplies direct-node Vite commands and a task-local output directory. No application config change.

- Ruling: World child prompts must not conflict with standalone prompts. Add a world_character prompt kind (or equivalently a typed seeded-character option) sharing the exact profile schema but retaining seed identity/name echo validation and adapting existing snake_case fields. Standalone still forbids application id/source from the model. Seed echo is correlation only; final IDs remain application-owned. Do not require duplicate character_text when a valid structured profile supplies guidance; project compatible text in code if an old response shape needs it. Preserve mismatched seed/name rejection. Tests must inspect actual initial and repair provider prompts for both contexts.

- Ruling: Four-call authoring cap counts actual generation HTTP requests; hidden compatible-provider format fallback must be disabled or charged to same explicit budget for authoring only. Existing model loading/discovery calls are control operations, not generation attempts. Otherwise wrapper tests would undercount live retries. Cost if wrong: possible provider compatibility regression, covered at HTTP seam.

- Ruling: Authoring repair requests resend full task context statelessly from outset, avoiding stale response-chain dependencies and extra fallback calls. Story Engine chains untouched. Cost: repeated repair input tokens; lower fragility and clear attempt bounds.

- Task 2: initial review rejected missing creative-minimum instructions, child character protocol identity mismatch, and missing custom-override execute-seam coverage. Ruling: generated-world child characters use character-authoring-v3-validated-profile in effective identity and character source metadata; outer world remains world-authoring-v2-validated-profile. Kind keeps seeded contract distinct. Cost if wrong: protocol identity ambiguity; explicit per-kind tests and stateless repairs bound impact.

- Ruling: Organizer applies fiction-content integrity checks independently of creative completion minimum. Evidence presence alone must not admit mechanics/private metadata into fictional profile fields; valid appearance-only organization remains allowed. Cost if wrong: reject overly broad legacy profile extensions; regression coverage preserves incomplete factual profiles.

- Ruling: For revisions, validate newly model-authored name/profile/mechanics through the shared generated-character validator before restoring unchanged application-owned legacy guidance/metadata. The model contract cannot repair preserved characterText, and manual legacy content remains storage-valid. New/world-generated characterText remains fully validated. Cost if wrong: preserved legacy prose may still conflict with the revised profile, as existing behavior permits; human preview/save remains explicit and Story Engine sanitization is unchanged.

## Review fixes, rollback and limits

Earlier task reviews fixed creative-minimum instructions, duplicate legacy-text requirements, unsafe passthrough fiction/paths, converted-world compatibility, child protocol identity, custom-override execute-seam coverage, HTTP compatibility discrimination, real retry delays, legacy provider availability classification, and original-context preservation in repair prompts. P1.7 fixed value-level issue sanitization, duplicated policy drift, lost reasons and stage fallback, and replaced adapter-only substitute coverage with actual API/provider/database tests.

The changed-file inventory was checked for scope: no migrations, deployment manifests, lockfile, runtime topology, legacy index maintenance, source upload, durable jobs, or Patch 2/3 executable work is included. The four preexisting plan documents were copied into this worktree. This task did not edit main. Final integrity-fix scoped re-review and the controller's final requirements review passed. All repository tests and all providers are not claimed covered.

Rollback reverts Patch 1 code and shipped templates together. No database rollback is needed. Preserve historical prompt snapshots, saved worlds/campaigns, and the ignored evidence workspace. Commits, publication, main integration, and cleanup remain subject to explicit authorization. Stop after Patch 1; Patches 2/3 remain proposed.
