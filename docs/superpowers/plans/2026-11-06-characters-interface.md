# Unified Characters Interface Implementation Plan

**Implementation record:** Work is implemented on `codex/characters-revamp` in the dedicated worktree. See the [acceptance report](../../review/campaign-cast/revamp-acceptance.md) for final evidence, reviewed deviations and verification limits. The original task checklists below are retained as the planning specification; they are not a deployment approval.

> **For agentic workers:** Implement in the dedicated worktree using `gpt-6.1-terra` subagents where practical. Follow the execution and minimal-test policy in the overview; it overrides broader test-addition instructions in earlier plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give both Story clients one approachable Characters workspace for browsing, normal field editing, evidence review, tracking progress, and context explanations.

**Architecture:** Pure sheet/draft/workspace models live in `client-core`; validated APIs, timers, and request cancellation live in `client-web`. Thin renderers in each application consume those shared models. Existing protagonist and supporting-cast endpoints remain authoritative; the UI selects the correct save command from the loaded record kind.

**Tech Stack:** Existing TypeScript, Zod, native/Web Awesome UI conventions, linkedom/Vitest, and Playwright. No new UI framework.

**Spec:** [Revamp overview](2026-11-06-characters-revamp.md) and [character review](../../review/2026-11-06-character-revamp-review.md). Automation interfaces come from [A1–A6](2026-11-06-characters-automation.md).

## Global constraints

- Carry forward every constraint in the overview. Do not import DOM rendering from one app into the other or put it into `client-web`.
- Preserve unknown structured-profile fields on ordinary edits. Do not flatten detailed protagonist appearance into the supporting-cast `appearance.description` field or manufacture empty values during reading.
- One explicitly labeled Save persists a profile edit. Refresh never overwrites unsaved inputs. Conflicts preserve drafts for reconciliation rather than silently retrying writes.
- Manual input remains available when a provider is unavailable. Protagonist editing follows its existing permission/lock contract independently of whether supporting-cast editing is enabled.
- Keep presentation of claims distinct from established facts. All names/quotes/values render as text, not trusted HTML.
- Pinned means preferred context, not guaranteed inclusion or physical presence. No In scene filter until presence has a defined authoritative model.

## Test scope

Follow the overview's minimal new-test policy. The scenarios below are a checklist against existing coverage, not a mandatory new-case list. Extend the owning existing suite only for a demonstrated gap; do not duplicate checks across tasks or layers. Red/green steps apply only to new or changed regression cases.

## Review focus

Unknown profile extensions lost on save (U1); stale requests after campaign switching (U2/U3); filters missing records beyond page one (U2); a review click silently approves other attributes (U4); a context estimate presented as the frozen next request (U5).

## File ownership

| Responsibility | Files |
| --- | --- |
| Shared pure field/sheet/draft models | New `packages/client-core/src/characters/{profile-fields,sheet,workspace}.ts`; existing `campaign-cast-editor.ts`; export through `packages/client-core/src/index.ts` |
| Status/filter contracts | New `packages/contracts/src/characters-workspace.ts`; existing `campaign-cast.ts`, `campaign-cast-discovery.ts`; export through contracts index |
| Browser session | New `packages/client-web/src/characters-workspace-session.ts`; existing `campaign-cast-api.ts` and package index |
| Legacy rendering | Existing `apps/web/src/campaign-cast-panel.ts`, `campaign-cast-scan-panel.ts`, `story.js`; new `apps/web/src/character-profile-form.ts`; existing `apps/web/public/story.css` |
| Replacement rendering | New `apps/web-next/src/characters-workspace.ts`, `characters-workspace.css`, `character-profile-form.ts`; existing `story-player-page.ts`, `story-player-tools.ts`, `story-player-view.ts`, `campaign-editor-page.ts` |
| Server reads | Existing application cast ports/use cases, `services/api/src/campaign-cast-routes.ts`, `services/runtime/src/campaign-cast-composition.ts`, `packages/database/src/campaign-cast-repository.ts`, `campaign-cast-status-repository.ts` |

### U1: Build shared character sheets and lossless profile forms

**Files:** Shared pure-model row; extend existing `tests/unit/campaign-cast-editor.test.ts` and `tests/unit/character-profiles.test.ts` only for coverage gaps.

**Interfaces:**

- `CharacterRecord` is a discriminated union: `{ kind: "protagonist", profile: CampaignCharacterProfile, revision: number }` or `{ kind: "supporting", detail: CastDetail }`. Include the campaign ID in the enclosing workspace state, not in browser-established owner authority.
- `CharacterSheet` has `name`, `kind`, `sections`, `sources`, `locks`, and `attention`. Sections are Identity, Personality and voice, Appearance, Current situation, and History; optional Mechanics is protagonist-only and outside fiction sections.
- `CharacterField` carries a validated path, label, value, and origin: `unknown | observed | claim | user | conflicted`. Conflicted static observations must not appear merely unknown; use observations plus projection to explain the conflict.
- `createProfileDraft(profile)`, `setProfileDraftField(draft, path, value)`, and `buildProfileUpdate(draft, expectedRevision)` preserve the loaded profile object, changing only allowlisted edited paths. Use existing contracts for final validation.
- `buildCharacterSheet(record): CharacterSheet` and the shared field descriptors are pure. IDs/clocks/network/DOM do not enter these functions.

- [ ] Extend existing coverage only where missing with a profile containing an unknown extension and a detailed appearance. After changing one known personality field, assert `update.profile.extension === original.extension` and all untouched appearance fields are equal. Assert blank explicit override differs from clearing an override, and a claim cannot become a fact through sheet conversion.
- [ ] Run `pnpm exec vitest run tests/unit/campaign-cast-editor.test.ts tests/unit/character-profiles.test.ts` and confirm any new regression fails for the intended reason before implementation; otherwise retain existing passing evidence.
- [ ] Implement descriptors from the actual profile schema, using plain text inputs, textareas, and list editors. Separate protagonist fields from the smaller supporting-cast schema. Reuse existing cast editor submission/conflict logic instead of duplicating it. Keep unknown fields in the saved object even when the standard form does not display them.
- [ ] Model sparse read-only sheets with compact Unknown indicators, evidence expandable on demand, and labeled manual corrections. Include existing automatic attachments only after A2; absence in older responses means none, not an error.
- [ ] Run the two owning suites and client-core/contracts type checks. Commit as `Model readable character sheets and lossless profile editing`.

### U2: Add complete filters and a draft-safe refresh session

**Files:** Contract, browser-session, and server-read rows; existing `tests/unit/campaign-cast-api.test.ts` and `tests/integration/campaign-cast-api.integration.test.ts`; provisionally new `tests/unit/characters-workspace-session.test.ts` only for timer/cancellation races not naturally covered elsewhere.

**Interfaces:**

- `CharacterFilter = "all" | "main" | "recent" | "pinned" | "needs_review" | "ignored"`; extend the cast list query with `filter`, default `all`. Use stable UUID cursor pagination with current limits (default/max 50). Existing `query` still searches names/aliases.
- `recent` means established observation or lexical mention in the last 10 accepted turns at the captured current boundary. Return that window in the response so the label can say “Recent · last 10 turns.” Before A4, use established observations only. Ignored characters appear only under Ignored unless directly selected by ID; they still count for identity ambiguity.
- Needs review lists known characters with current unresolved identity/field evidence or conflicted profile values. Unattached people remain in the identity inbox. Apply filters before pagination and derive counts over the complete scoped dataset.
- `GET /cast/workspace-status` returns `{ revision, boundary, capabilities: { editing, discovery, autoMatch, backfill, context }, contextDisabledReason, counts: { identities, details, conflicts }, tracking }`. `tracking` uses the existing discovery status schema. Derive effective context capability from operator configuration and campaign Story Memory policy, not a boolean inferred from roster contents. Missing new fields on an old server show Unknown capability, not enabled.
- `createCharactersWorkspaceSession({ api, schedule, onChange })` returns `open(campaignId)`, `select(characterId)`, `setQuery(query, filter)`, `refresh()`, `setDraft(draft)`, `close()`, and `dispose()`. Timer and abort adapters are injected/owned in `client-web`; every reply is associated with a campaign/session epoch.

- [ ] Extend existing coverage only where missing for a matching record after page 50, count/pagination consistency, foreign campaign IDs, conflicting fields, and all disabled capability combinations. Fake-timer session tests assert old-campaign results are ignored and refresh never replaces a dirty draft.
- [ ] Run the affected owning unit suites and `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/campaign-cast-api.integration.test.ts` to establish the baseline; require an intended failure only for a necessary new regression case.
- [ ] Implement scoped server queries and typed status route before the existing `/:characterId` handler. Use one captured boundary/revision per response; if a subsequent page belongs to a new revision, tell the client to restart pagination instead of appending inconsistent results.
- [ ] Implement 5-second refresh only while the workspace is open and visible. Poll bounded status first; reload roster/details when revision changes. Stop on close/dispose or hidden document, refresh on visibility return, avoid overlapping requests, and back off failures to 10/20/30 seconds. Keep Refresh available. A failed status request must not clear a successful roster.
- [ ] When selected authority changes during editing, preserve the draft and show “This character changed. Review the latest version before saving.” Saving uses the draft's loaded revision until reconciled; do not silently move it forward. Preserve read selection on ordinary refresh; do not navigate away if a filtered row disappears.
- [ ] Run the affected cast API/session suites, client-web/core checks, and the existing PostgreSQL suite. Commit as `Add scoped character filters and background refresh`.

### U3: Render the unified workspace on both Story surfaces

**Files:** Both rendering rows; U1/U2 modules; reuse existing `tests/unit/campaign-cast-panel.test.ts`, `tests/unit/web-next-story-tools.test.ts`, `tests/unit/web-next-campaign-editor.test.ts`, and `tests/e2e/campaign-cast.e2e.test.ts`; do not add separate renderer or browser suites.

**Interfaces:** Each app exposes its own `mountCharactersWorkspace(host, { session, profileApi, navigateToTurn, generationState }): { open, close, dispose }`. Both consume U1 sheets and U2 sessions; no shared DOM module. The profile API adapter continues to call existing protagonist get/update endpoints. Supporting records use `CampaignCastApi`.

- [ ] Extend the existing browser journey only where missing: click a protagonist and edit personality without seeing JSON; click an NPC and edit one field without modifying protagonist state; disabled cast editing does not falsely disable an otherwise editable protagonist. Assert malicious names/quotes remain text.
- [ ] Run the named unit suites and confirm any new regression fails for the intended reason before implementation; otherwise retain existing passing evidence.
- [ ] Implement a wide two-pane roster/sheet view and a narrow list/detail view with a clear Back action. Include search, filters, Main character label, short role, last observed/mentioned distinction, attention count, and pinned/ignored badges. Open sheets in reading mode; reveal editing with Edit. Empty states explain the available next action without requiring AI or portraits.
- [ ] Replace legacy main-character JSON dialog behavior and replacement Story/campaign-editor JSON fields with the app's new form renderer. Existing Edit character entry points open the same sheet directly. Keep world authoring intact; reuse the pure field descriptors where its structured editor already maps the same fields, without widening this task into a world-editor rewrite.
- [ ] Keep mechanics separate and private. Use existing generation/recovery lock signals and profile revisions; cancel/discard behavior retains focus and restores the invoking control. If unknown extension data exists, show that additional fields are preserved rather than offering a destructive reset.
- [ ] Extend the existing cast Playwright journey and parameterize it for both `/story/:campaignId` and `/app/story/:campaignId`: desktop/mobile list-detail transitions, keyboard traversal/Escape, focus return, 200% zoom, long names, sparse data, more than 50 characters, dirty-draft navigation, save conflict, rapid campaign change, and stale refresh response. Treat layout, long-text, zoom, and keyboard variants as rendered verification rather than separate automated cases unless a distinct regression is uncovered. Save screenshots under `docs/review/assets/characters-revamp/`.
- [ ] Run renderer tests, application checks, client-boundary check, build, and the existing cast browser suite. Commit as `Unify character browsing and form editing across Story clients`.

### U4: Add one review inbox with explicit identity, detail, and undo actions

**Dependencies:** A2/A3/A5 and U3. Can render existing identity review earlier, but completion requires the new operations.

**Files:** Both workspace renderers, existing legacy scan panel, shared workspace model/session; reuse existing `tests/unit/campaign-cast-panel.test.ts` and the shared journey in `tests/e2e/campaign-cast.e2e.test.ts`.

**Interfaces:** Review categories are `identities | details | conflicts`; conflict resolution uses the existing manual override editor. Identity actions reuse `resolveCandidate`; field decisions use A5 `resolveDetail`; undo uses A2 `detachAttachment`. Retry submission retains the same idempotency key until a definitive result or explicit draft change.

- [ ] Extend existing coverage only where missing: attaching an identity leaves withheld fields in Details; “Confirm as my correction” writes exactly one override; dismiss changes no profile; clicking “Not this character” removes the attachment and opens source review; a lost response retry reuses its key.
- [ ] Run `pnpm exec vitest run tests/unit/campaign-cast-panel.test.ts tests/unit/web-next-story-tools.test.ts` and verify intended failures only for necessary new regression cases.
- [ ] Render source-turn link, quotation, proposed identity/value, reason for review, and current character preview together. Use exact action labels: “Attach to character,” “Create separate character,” “Confirm as my correction,” “Dismiss suggestion,” and “Not this character.” No action approves other details implicitly. Do not add aliases silently or offer bulk approval in this release.
- [ ] Display automatic attachments with their basis and source, including attachments restored from archives. Preserve work when a conflict occurs and offer a deliberate refresh/reconcile action; do not blindly replay with new revisions. A successfully detached appearance is no longer represented as that character's confirmed appearance or lexical recency.
- [ ] Bring the existing scan preview/start/pause/resume/cancel/retry workflow into both clients using the existing API and shared session state. Opening Characters must never start a scan. Show request estimates before Start, tracking coverage separately from inbox counts, and retained results after cancellation.
- [ ] Reuse that same browser journey for partial identity resolution, withheld detail review, cleanup/import followed by undo, tracking failure/retry, preview without provider dispatch, explicit scan start, pause/resume/cancel, and correction invalidating an open review item. Verify both UI surfaces against deterministic fixtures, with PostgreSQL evidence supplied by A6.
- [ ] Run the unit/browser suites and commit as `Unify character review and correction workflows`.

### U5: Explain character context without exposing the private prompt

**Files:** `packages/domain/src/campaign-cast-context.ts`; `packages/contracts/src/memory.ts`; `packages/application/src/memory/{ports,use-cases}.ts`; `packages/database/src/chronicle-repository.ts`; `services/api/src/memory-application-adapter.ts`; `services/runtime/src/generation-context-planner.ts`; browser API/session and workspace renderers. Tests: existing `campaign-cast-context.test.ts`, `memory-application.test.ts`; existing `tests/integration/campaign-cast-generation.integration.test.ts`.

**Interfaces:** Extend the existing memory context-preview response with an allowlisted `castExplanation`: `{ boundary, castRevision, mode: "estimate", budgetTokens, usedTokens, coverage, selected, omitted, disabledReason }`. Selected entries contain only character ID/name and reason (`direct_reference | open_thread | pinned | recent_observation | recent_mention`). Omitted entries have bounded reason codes such as budget, ignored, ambiguous, stale dynamic fields, or not relevant. Return no raw private prompt, scratchpad, mechanics, endpoint, or provider response.

- [ ] Extend existing selector expectations only where missing asserting reason codes match the existing priority ordering, lexical mentions never claim presence, and omitted stale fields are identified. Reuse an existing API fixture with private-data canaries that must not appear anywhere in the response.
- [ ] Run the affected unit suites to establish the baseline; require an intended failure only for a necessary new regression case.
- [ ] Factor selection reason production into the same pure `selectCastContext` path used by generation. Extend the existing preview adapter rather than adding an independent ranking algorithm. Capture the same campaign/world/profile authority and effective budget policy for a given preview request; read-only preview must not enqueue generation, reindexing, or discovery or call a text model.
- [ ] In the sheet, show “Context preview” and “Likely included for this input,” with the captured boundary and selection reasons. Do not promise “Used in the next turn”: action, budget, cast, or history may change before generation freezes. Refresh on explicit request/input change with cancellation; ordinary 5-second tracking refresh must not repeatedly run expensive retrieval. After a turn exists, use stored generation audit evidence where available rather than relabeling a fresh estimate as historical fact.
- [ ] Extend existing PostgreSQL fixtures only where needed comparing preview and generation selection on identical captured inputs; change input/revision to prove the preview becomes stale. Cover zero budget, ignored identities, ambiguous aliases, tracking gaps, Story Memory Off, disabled cast context, wrong owner/campaign, and preserved original generation failure behavior.
- [ ] Run unit and focused PostgreSQL suites, then browser checks for disabled/estimated/stale display and absence of private canaries. Commit as `Explain character context selection and omissions`.

### U6: Verify usability, parity, and release documentation

**Files:** `docs/player-guide/characters-and-stats.md`, `docs/nexus-guide/worlds/characters.md`, `docs/runbooks/campaign-cast.md`, `docs/review/campaign-cast/revamp-acceptance.md`, screenshot assets; implementation files only if verification identifies defects.

**Interfaces:** One acceptance report combines A6 workflow/portability evidence and both-client browser results; it clearly distinguishes implemented, enabled in a test environment, and deployed.

- [ ] Reuse U3/U4's parameterized browser journey on each UI; do not author another acceptance test: open a populated campaign → find and edit protagonist → observe accepted-turn tracking → inspect an NPC's source → resolve an identity → confirm one withheld field → undo an automatic attachment → preview context → cancel a historical scan. Confirm navigation/drafts survive background updates.
- [ ] Verify keyboard-only operation, focus trapping/return, screen-reader labels and status announcements, reduced motion, 200% zoom, 1440px desktop, and 390px mobile. Use collapsed source history and bounded pagination for long campaigns; verify no repeated full-roster fetch during ordinary unchanged-status polling.
- [ ] Capture comparable screenshots for roster, protagonist edit, NPC sheet, identity/detail review, tracking error, and context explanation on both clients. Record any unresolved UI limitations; a screenshot alone is not interaction verification.
- [ ] Share the final release-candidate run with A6; run `pnpm check`, `pnpm build`, `pnpm check:client-boundaries`, the affected unit suites, `pnpm exec playwright test tests/e2e/campaign-cast.e2e.test.ts`, and A6's composed database checks. Complete the overview's release checks before submission.
- [ ] Update guides with the actual new labels and routes. Explain manual correction versus discovered evidence, lexical mention versus presence, default-off deployment gates, how to retry, how to scan older story, and the limits of estimated context. Remove stale claims that the replacement client lacks the cast UI only after parity passes.
- [ ] Commit as `Document and verify the unified Characters experience`. Mark the overall revamp complete only when A6 and U6 pass all required gates. Report failed/skipped gates and remaining work explicitly; a documented skip alone does not satisfy a release gate.
