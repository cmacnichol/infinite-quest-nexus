# Character Editor Usability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make adding and changing characters fast in Nexus (`/nexus/`) and Web-Next (`/app/`). State Edits stop going stale, rosters are scannable, characters are edited on the sheet with Undo, wrong story evidence can be retracted in place, Web-Next reaches parity, and the world character workspace opens where the work is.

**Architecture:** Phase 0 changes one domain rule (ADR 0045) via a shared predicate in contracts, used by the projections, repository field sources and clients; V3 capture uses the new rule with correct narrator authority, V2 capture and recapture keep the old rule, and every protocol consumer is updated. Pure presentation and request-building policy goes in `packages/client-core/src/characters/`. Shared DOM roster/sheet views live in `apps/web/src/character-editor/`; each host controller owns saved notices and receipt-bound Undo across refreshes. World-workspace work reuses existing generation and organize endpoints with the current unsaved candidate.

**Tech Stack:** TypeScript, Zod contracts, native DOM + `<dialog>`, Vitest with `linkedom`, isolated PostgreSQL integration tests, Playwright Chromium. No new dependency.

**Spec:** [Character editor usability design](../specs/2026-11-15-character-editor-usability-design.md) (B1–B23, A0–A7). Decision: [ADR 0045](../../architecture/0045-current-state-edits-yield-to-newer-story-evidence.md). Vocabulary: `CONTEXT.md` › *Characters and cast*.

## Global Constraints

- Only Phase 0 changes domain projection, repository field sources, frozen narrator capture and protocol consumers, under V3 versions. Nothing adds a migration, API endpoint, provider operation, capability flag or storage-format change; the existing in-memory snapshot envelope carries version-selected fiction values; the job persists the fingerprint, not the snapshot.
- Every write keeps its existing revision, boundary, idempotency, generation-lock and capability fences. Request bodies are built only through `prepareCastSubmission`, `buildPresetRequest`, `buildProfileUpdate` and the observation-decision request shape.
- Untrusted text (names, values, quotes, prompts) is set with `textContent` only.
- Labels, input kinds and limits come from `CHARACTER_FIELD_DESCRIPTORS` and its views. The State Edit field set is defined once (`CAST_STATE_FIELDS`, Task 1).
- `packages/client-core` stays DOM-free: `pnpm check:client-boundaries`.
- Do not modify `apps/web/src/cast-review-queue.ts`, `packages/client-web/src/cast-review-queue.ts` or review-decision code.
- In `apps/web-next/src/story-player-page.ts` (bug magnet) touch only the `createCharactersWorkspace(...)` call (line 1514).
- User-facing copy uses `CONTEXT.md` terms, never "protagonist", "preset" or "override". Quoted copy in this plan is exact.
- Interactive targets ≥ 44×44 CSS px; no horizontal scroll at 390 px; usable at native 200% zoom.

## Review Focus

1. A newer Observation that is same-turn, retracted, superseded, invalidated or a claim must not replace a State Edit. Retracting the replacing Observation must bring the State Edit back. A replaced edit must never reach the narrator as user authority, and a V2 job resumed after the upgrade keeps its fingerprint. Owned by Tasks 1, 3a and 3b.
2. A 409 or network failure during a sheet save keeps the typed value open and offers Compare latest / Load latest. It never shows the old value as if saved. Owned by Task 9.
3. A sheet save, toggle or Undo makes exactly one semantic change on the character's own write path. Supporting Character requests are sparse; identity Undo never uses `resetIdentity`. Main Character requests use the existing full-profile contract and preserve untouched values. Owned by Task 6.
4. Undo uses only the fences returned by its own write. An intervening write before refresh withdraws Undo; one after refresh causes a conflict without side effects. Owned by Tasks 6, 11 and 15.
5. A same-character refresh preserves Saved/Undo, but switching character/campaign or closing invalidates late results. Owned by Tasks 9, 11 and 15.

The eight review findings and their task owners are mapped in the design's **Review finding coverage** table. Tasks 3–3c cover every V3 consumer, version-selected precedence and actual provider payloads. Tasks 5 and 6 cover retained retracted evidence, and Tasks 7, 24 and 25 cover unsaved refine context. Browser evidence is written in each owning task, and Task 26 runs and records it. These checks are required acceptance, not optional follow-up.

## Execution notes

- Branch `feat/character-editor-usability` from current `main` after `codex/character-review-decisions` merges. Use a worktree (`superpowers:using-git-worktrees`).
- One unit file: `pnpm exec vitest run tests/unit/<file>.test.ts` → `Test Files  1 passed`. Integration: `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/<file>.test.ts` (via `pnpm test:integration` for isolation).
- Type checks: `pnpm check:web`, `pnpm --filter @infinite-quest/contracts check`, `pnpm --filter @infinite-quest/client-core check`.
- Order: Phase 0 → 1 → 2 → 3 (Nexus) → 4 (Web-Next dialog) → 5 (Web-Next world workspace) → 6 (AI refine). Phase 0 and Phase 6 are separately releasable. Within Phase 0, Tasks 1–3b ship together (Task 1 alone would change V2 narrator context), and Task 3c alone switches enqueue to V3. Phase 0 activation requires `observationDecisions`.

---

## Phase 0 · State Edit precedence (ADR 0045)

### Task 1: Shared State Edit predicate and both projections

**Files:**
- Modify: `packages/contracts/src/campaign-cast.ts` (add predicate near `castOverrideSchema`)
- Modify: `packages/domain/src/campaign-cast.ts:37-111` (`projectCastProfile`, `resolveSeededCastProfile`, `isCastUpdatingPath` delegates)
- Test: `tests/unit/campaign-cast-projection.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const CAST_STATE_FIELDS = ["state.location", "state.condition", "state.clothing", "story.goals"] as const;
  export function isCastStateField(path: string): boolean;
  /** The fact Observation that replaces this State Edit, or null while the edit is in force. Corrections always return null. */
  export function stateEditReplacement(edit: CastOverride, observations: readonly CastObservation[], retracted?: ReadonlySet<string>): CastObservation | null;
  /** "yield" is the ADR 0045 rule; "locked" is the V2 rule (edit always wins), kept for V2 capture/recapture. */
  export type StateEditPrecedence = "yield" | "locked";
  ```
  `ProjectCastProfileInput` gains `stateEditPrecedence?: StateEditPrecedence` (default `"yield"`); `resolveSeededCastProfile` accepts the same option.

- [ ] **Step 1: Write failing tests**

```ts
it("a strictly later fact replaces a state edit", () => {
  const profile = projectCastProfile({ observations: [obs("state.location", "the palace", 20)], overrides: [edit("state.location", "the docks", 12)] });
  expect(profile["state.location"]).toBe("the palace");
});
it.each([
  ["same turn", obs("state.location", "the market", 12)],
  ["earlier turn", obs("state.location", "the market", 9)],
  ["claim", claim("state.location", "the palace", 20)],
  ["invalidated", invalidated("state.location", "the palace", 20)]
])("%s observation keeps the state edit", (_, o) => {
  expect(projectCastProfile({ observations: [o], overrides: [edit("state.location", "the docks", 12)] })["state.location"]).toBe("the docks");
});
it("a retracted replacement restores the state edit", () => {
  const later = obs("state.location", "the palace", 20);
  expect(projectCastProfile({ observations: [later], overrides: [edit("state.location", "the docks", 12)], retractedObservationIds: new Set([later.id]) })["state.location"]).toBe("the docks");
});
it("a superseded later fact does not count, its superseding fact does", () => { /* A@20 superseded by B@22 → B */ });
it("corrections still win over later facts", () => {
  expect(projectCastProfile({ observations: [obs("story.role", "Smith", 20)], overrides: [edit("story.role", "Guide", 12)] })["story.role"]).toBe("Guide");
});
it("story.goals follows the state edit rule", () => {});
it("seeded resolution applies the same rule and reports observation as source", () => {
  const r = resolveSeededCastProfile({ profile: seeded, observations: [obs("state.condition", "Wounded", 20)], overrides: [edit("state.condition", "Rested", 12)] });
  expect(r.profile["state.condition"]).toBe("Wounded"); expect(r.sources["state.condition"]).toBe("observation");
});
it("stateEditReplacement returns the latest replacing observation", () => {});
it("locked precedence keeps the V2 rule for both projections", () => {
  expect(projectCastProfile({ observations: [obs("state.location", "the palace", 20)], overrides: [edit("state.location", "the docks", 12)], stateEditPrecedence: "locked" })["state.location"]).toBe("the docks");
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
  - `stateEditReplacement`: returns null for non-state fields. Otherwise it takes fact Observations of the same field that are not invalidated, superseded or retracted and whose turn-evidence `turnNumber` is greater than `edit.evidence.effectiveTurnNumber` (non-turn evidence never counts), and returns the latest by `castEvidenceOrder`.
  - Move the evidence-order primitive into contracts and re-export it from domain if needed; contracts must not import domain. Preserve persisted input order as the final tie-breaker. Build supersession edges before excluding retracted facts, as required by the [character review dismissal and retraction design](../specs/2026-11-14-character-review-dismissal-and-retraction-design.md).
  - `projectCastProfile`: under `"yield"`, skip an override when `stateEditReplacement(...) !== null`, leaving the latest-fact value already projected for that field. `"locked"` keeps today's loop unchanged.
  - `resolveSeededCastProfile` (lines 98-103): skip the same overrides under `"yield"`, so `sources[field]` stays `"observation"`.
  - Every existing caller keeps the default (`"yield"`) except V2 capture, which Task 3a pins to `"locked"`. Until then Task 1 changes new V2 narrator context; Task 3a must land in the same release.
  - `isCastUpdatingPath` returns `isCastStateField(path)`.
- [ ] **Step 4: Run, expect PASS;** also run `tests/unit/campaign-cast-context.test.ts` and `tests/unit/campaign-cast-promotion.test.ts`. Update only cases that encode "edit always wins" for state fields, citing ADR 0045 in the test name.
- [ ] **Step 5: Commit** `feat(domain): state edits yield to strictly later story evidence (ADR 0045)`.

### Task 2: Repository field sources follow the rule

**Files:**
- Modify: `packages/database/src/campaign-cast-repository.ts:323-324` (non-seeded `fieldSources`)
- Test: `tests/integration/campaign-cast-repository.integration.test.ts` (or the existing cast repository integration file that asserts `fieldSources`; `grep -ln fieldSources tests/integration`)

**Interfaces:**
- Consumes: Task 1 `stateEditReplacement`.

- [ ] **Step 1: Write failing integration test** `"a replaced state edit reports observation source and the later value in list and detail"`. Record an edit at turn 12 and an observation at turn 20, then assert `character.profile["state.location"] === "the palace"`, `fieldSources["state.location"] === "observation"`, and that `detail.overrides` still contains the edit (history kept). Same for a Starting Cast Character.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** `"override"` only for overrides with `stateEditReplacement(...) === null`. Overrides are not deleted from detail.
- [ ] **Step 4: Run the cast integration suites, expect PASS.**
- [ ] **Step 5: Commit** `fix(database): report effective source for replaced state edits`.

### Task 3: V3 cast prompt and context versions with the new wording

**Files:**
- Modify: `packages/contracts/src/story-prompt.ts:47-55` (new constants and contract)
- Modify: `packages/contracts/src/story-memory-policy.ts:10-12, 124, 204-221` (accept and pair V3)
- Modify: `packages/contracts/src/prompt-library.ts` (accept V3 prompt-snapshot compatibility identity)
- Modify: `services/runtime/src/generation-api-composition.ts`, `services/runtime/src/campaign-cast-context-preview.ts` (explicit version selection)
- Modify: `services/runtime/src/story-continuity-review-adapter.ts` (review and repair authority contracts)
- Modify: `packages/domain/src/campaign-cast-context.ts`, `services/runtime/src/generation-context-planner.ts` (notice selected by frozen context version on both selection paths)
- Test: `tests/unit/story-memory-policy.test.ts`, `tests/unit/story-memory-policy-repository.test.ts`, `tests/unit/prompt-library.test.ts`, `tests/unit/story-continuity-review-adapter.test.ts`, `tests/unit/campaign-cast-context.test.ts`, `tests/unit/campaign-cast-generation-protocol.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const CAST_V3_STORY_MEMORY_PROMPT_PROTOCOL_VERSION = "story-v19-state-edit-precedence";
  export const CAST_V3_STORY_MEMORY_CONTEXT_POLICY_VERSION = "current-continuity-v8";
  export const HISTORY_V3_STORY_MEMORY_CONTEXT_POLICY_VERSION = "current-continuity-v9";
  export const CAST_V3_STORY_AUTHORITY_CONTRACT: string;
  export function castContextNotice(contextVersion: string, status: CastGenerationSnapshot["discoveryStatus"]): string;
  ```

- [ ] **Step 1: Write failing tests:**
  - V3 prompt is valid only with a V3 cast or history context, and V2 pairs remain valid.
  - New enqueue still chooses V2 (the switch is Task 3c).
  - `castContextNotice(V3, "current")` and `castContextNotice(V3, "pending" | "failed")` equal B3's complete/incomplete sentences exactly; `"off"` uses B3's discovery-off sentence. V2 retains its current three-way wording, including off.
  - `CAST_V3_STORY_AUTHORITY_CONTRACT` contains "User corrections govern current portrayal from their effective turn; user state edits govern until later story evidence" and does not contain "User field overrides".
  - V3 prompt snapshots parse and `storyMemoryMandatoryContract(V3)` includes V3 authority. Continuity review and repair both select it. Invalid V2/V3 pairings fail before dispatch.
  - Both V3 contexts use modern cast snapshots; history V3 enables history coverage. Explicit V2 selection returns V2 identities/contracts.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
  - `CAST_V3_STORY_AUTHORITY_CONTRACT` is `CAST_V2_STORY_AUTHORITY_CONTRACT` with its override sentence replaced by the sentence above.
  - Add `castV3StoryMemoryPromptCompatibilityIdentity`, mirroring the V2 identity.
  - Extend the prompt-library compatibility union and mandatory-contract dispatch. Add explicit `"v3"` support to `resolveStoryMemoryPromptSnapshot`; derive the argument from the policy in generation and preview callers instead of trusting its default. Update continuity review/repair identity selection.
  - Pairing accepts only matching V3 protocols; `isCastV2ContextProtocol` must also classify V3 as using the existing modern snapshot envelope, and `isHistoryCoverageContextProtocol` must include history V3. Keep prior values valid.
  - The context builder receives the job's frozen context version and calls `castContextNotice` on the modern path as well as the legacy path. Never change saved V2 wording through a live default.
  - This task adds readers only. No enqueue default changes, so the commit can ship by itself.
- [ ] **Step 4: Run all listed unit files, expect PASS.**
- [ ] **Step 5: Commit** `feat(story): V3 cast authority wording readers for state edits`.

### Task 3a: Version-selected capture precedence and narrator authority

**Files:**
- Modify: `packages/database/src/campaign-cast-repository.ts` (`captureCastGenerationSnapshotWithClient`)
- Modify: `packages/domain/src/campaign-cast-context.ts:84-95` (field authority and evidence)
- Test: `tests/unit/campaign-cast-context.test.ts`, `tests/integration/campaign-cast-v2-context.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 `stateEditReplacement`, `StateEditPrecedence`; Task 3 V3 constants.
- Extend capture options with `contextProtocol?: StoryMemoryPolicySnapshot["contextProtocol"]`. Absent or a V2 protocol → `stateEditPrecedence: "locked"`; V3 → `"yield"`. Extend `selectCastContext` input with the same optional discriminator, used for notice selection and for the authority rule below.
- Keep `cast-context-v2` storage and portable formats unchanged. V3 changes how fiction fields are resolved, not the envelope schema.

- [ ] **Step 1: Write failing tests:**
  - **Authority attribution (V3):** edit "the docks" at 12, fact "the palace" at 20. The selected field is `{ value: "the palace", authority: "observation", evidenceId: <fact id> }`. Today `campaign-cast-context.ts:87-93` would emit `authority: "user"` with the Observation's value.
  - **Gap, edited field (V3):** the same data with tracking `pending` through turn 20 and boundary turn 21 still sends "the palace" with observation authority. With an edit at 21 and no fact after 21, it sends "the docks" with user authority.
  - **Gap, unedited field (V3):** with no edit, a `pending` or `failed` state field is still sent as dated last-known state with observation authority, as in V2, and is not counted in `omittedFieldCount`.
  - Cover all four State Edit fields, Added/Discovered and Starting Cast Characters, a retracted replacing Observation (edit restored, user authority), and discovery `off` (last-known observations kept).
  - **V2 pinning:** a V2 capture of the same data sends "the docks" with user authority.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
  - Capture passes the precedence derived from `contextProtocol` into the projection.
  - In context selection, an override counts only when it is in force under that precedence. A replaced State Edit falls through to the supplying-Observation branch, which already gives observation authority and evidence. The legacy `cast-context-v1` path keeps its existing omission; V3 capture uses the `cast-context-v2` envelope, which keeps unedited dynamic fields as last-known state.
  - Do not add a separate gap filter.
- [ ] **Step 4: Run the listed files, expect PASS.**
- [ ] **Step 5: Commit** `feat(story): version-selected state edit precedence in narrator capture`.

### Task 3b: Frozen precedence through recapture and resume

**Files:**
- Modify: `packages/database/src/generation-authority.ts`, `packages/database/src/generation-repository.ts`, `packages/database/src/generation-execution-repository.ts`, `packages/database/src/chronicle-generation-context.ts` (pass the frozen context protocol into capture and base-identity recapture)
- Modify: `services/runtime/src/generation-context-planner.ts`, `services/runtime/src/campaign-cast-context-preview.ts` (selection and preview parity)
- Test: `tests/integration/campaign-cast-generation.integration.test.ts`, `tests/integration/story-memory-compatibility.integration.test.ts`

- [ ] **Step 1: Write failing integration tests:**
  - A V2 job captured with a State Edit and a later Observation resumes with an unchanged fingerprint when authority is unchanged; recapture uses `"locked"`.
  - A V3 job's recapture during resume uses `"yield"` and matches its frozen fingerprint.
  - If cast authority changes between attempts, including tracking catching up, the job fails stale and requires a fresh job. Preserve exact already-dispatched request replay where supported; never silently reproject.
  - Preview and generation select identical fields for the same frozen protocol.
- [ ] **Step 2: Run with `--config vitest.integration.config.ts`, expect FAIL in the new cases.**
- [ ] **Step 3: Implement.** Every capture and recapture call site passes the job's frozen `contextProtocol`, never the live default.
- [ ] **Step 4: Run, expect PASS with no skipped PostgreSQL cases.**
- [ ] **Step 5: Commit** `fix(story): recapture cast context with the job's frozen precedence`.

### Task 3c: End-to-end V3 proof and enqueue activation

**Files:**
- Modify: `packages/database/src/story-memory-policy-repository.ts:135-136`, `packages/database/src/prompt-repository.ts:24, 287` (enqueue V3)
- Test: `tests/integration/story-continuity-review.integration.test.ts`, `tests/integration/story-memory-compatibility.integration.test.ts`, `tests/unit/story-memory-policy-repository.test.ts`

- [ ] **Step 1: Write the end-to-end proof first**, against real PostgreSQL and a deterministic provider, with V3 selected explicitly: enqueue → capture/fingerprint snapshot → dispatch → continuity review/repair → restart/resume with unchanged authority → commit. Inspect the provider's captured request for the Task 3a cases. Incompatible pairs reject before dispatch. Failed or rejected output does not mutate accepted state, and another campaign's facts never appear. Then add the failing enqueue test: new enqueue chooses V3 (history V3 when `historyCoverageEnabled !== false`).
- [ ] **Step 2: Run, expect the proof to PASS and the enqueue test to FAIL.**
- [ ] **Step 3: Switch the enqueue default to V3.**
- [ ] **Step 4: Run the suites plus Task 3's protocol units, expect PASS.**
- [ ] **Step 5: Commit** `feat(story): enqueue V3 state edit precedence`. Release gate: `observationDecisions` is available wherever Phase 0 is enabled (ADR 0045). Release notes state the immediate effect on existing State Edits and the edit-again fallback.

---

## Phase 1 · Client-core policy

### Task 4: Roster rows, tracking summary and provenance labels

**Files:**
- Create: `packages/client-core/src/characters/roster-presentation.ts`
- Modify: `packages/client-core/src/characters/workspace.ts:36-38` (`characterProvenanceLabel`), `packages/client-core/src/index.ts`
- Test: `tests/unit/character-roster-presentation.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type RosterBadgeKind = "main" | "pinned" | "ignored" | "removed" | "review" | "conflict";
  export type RosterBadge = { kind: RosterBadgeKind; label: string };
  export type CastAttention = { review: boolean; conflict: boolean; reviewCount?: number; conflictCount?: number };
  export type CastRosterRow = { id: string; name: string; summary: string; provenance: string; badges: RosterBadge[]; lastSeen: string };
  export function castRosterRow(person: CastCharacter, attention?: CastAttention): CastRosterRow;
  export type TrackingTone = "ok" | "info" | "warning" | "error";
  export type TrackingSummary = { tone: TrackingTone; headline: string; details: string[] };
  export function trackingSummary(status: CastDiscoveryStatus | null): TrackingSummary;
  ```

- [ ] **Step 1: Write failing tests**

```ts
it("labels each origin", () => {
  expect(["protagonist", "world", "discovered", "manual"].map(kind => characterProvenanceLabel({ origin: origin(kind) })))
    .toEqual(["Main character", "From world", "Discovered", "Added by you"]);
});
it("orders badges with counts", () => {
  expect(castRosterRow(person({ origin: origin("protagonist"), pinned: true, ignored: true, removed: true }), { review: true, reviewCount: 3, conflict: true, conflictCount: 1 }).badges.map(b => b.label))
    .toEqual(["Main", "Pinned", "Ignored", "Removed", "Needs review (3)", "Conflict (1)"]);
});
it("summarises role to 120 code points plus ellipsis", () => { /* "🜂".repeat(130) → 121 code points ending "…" */ });
it("reports the later of observed and mentioned turns", () => { /* 4/9 → "Last seen turn 9"; 4/null → "Last seen turn 4" */ });
it("maps tracking states to tone and existing copy", () => {
  expect(trackingSummary(null)).toEqual({ tone: "warning", headline: "Character tracking status is unavailable. Saved characters are still available.", details: [] });
  expect(trackingSummary(status({ state: "complete", coverageStartTurn: 2, trackedThroughTurn: 8 }))).toEqual({ tone: "ok", headline: "Character tracking is up to date.", details: ["Tracked turns 2–8. Earlier turns are not included."] });
  expect(trackingSummary(status({ state: "failed" })).tone).toBe("error");
  expect(trackingSummary(status({ state: "catching_up", unresolvedCount: 1 })).details).toContain("1 character match needs review.");
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
  - `characterProvenanceLabel` gains `world → "From world"`.
  - Headlines reuse the map at `apps/web-next/src/characters-workspace.ts:74`, with these tones: disabled, not_enrolled and catching_up → info; failed → error; complete → ok.
  - The plural is "{n} character matches need review."
  - Update the existing tests that expected "Discovered" for world origin.
- [ ] **Step 4: Run, expect PASS** (also `tests/unit/campaign-cast-panel.test.ts`).
- [ ] **Step 5: Commit** `feat(client-core): roster presentation and From world provenance`.

### Task 5: Sheet provenance for every character type

**Files:**
- Modify: `packages/client-core/src/characters/sheet.ts`
- Test: `tests/unit/character-sheet-provenance.test.ts`

**Interfaces:**
- Consumes: Task 1 `stateEditReplacement`, `isCastStateField`; `presetField`, `presetFields` (`preset-editor.ts`).
- Produces (additive on `CharacterField`; existing properties unchanged):
  ```ts
  editTurn: number | null;          // turn of the user edit in force
  observedTurn: number | null;      // turn of the Observation supplying the value
  replacedEditTurn: number | null;  // State Edit replaced by newer evidence
  storyDiffers: { value: string; turn: number } | null; // newer disagreeing fact under a Correction
  retractable: CastObservation | null; // Observation supplying a From story value
  retractableObservationIds: string[]; // eligible actions, including conflict choices
  ```
  `buildCharacterSheet({ kind: "supporting", detail })` uses `presetFields` and `presetField` when `detail.character.originProfile` exists, otherwise `SUPPORTING_FIELDS`.
  Export `activeRetractedIds(detail: CastDetail): ReadonlySet<string>`, derived from `observationDecisionStatus` entries with `state === "retracted"`; absence means no known retractions. Supplying facts and conflict candidates must be filtered with this set, but supersession edges are collected from retained valid history first. A retraction action additionally requires that observation's status to be `eligible`.

- [ ] **Step 1: Write failing tests:**
  - A State Edit in force: origin `"user"`, `editTurn: 12`.
  - Replaced: origin `"observed"`, `observedTurn: 20`, `replacedEditTurn: 12`.
  - A Correction with a later different fact: `storyDiffers: { value: "Smith", turn: 20 }`.
  - A Starting Cast stable field with a campaign edit and a later different fact: `storyDiffers === null` (authored values outrank Observations; `isSeededFixedCandidateHidden`), origin `"user"`.
  - From story: `retractable.id` equals the supplying Observation.
  - Conflicted: `retractable === null`.
  - A Starting Cast Character with a campaign edit: origin `"user"`, `editTurn` taken from its authored-history edit, plus the full `presetFields` section list.
  - The Main Character sheet: all nullable provenance properties null, `retractableObservationIds: []`.
  - A retained retracted replacement does not replace the State Edit on reload; repeated equal values select the latest eligible supplying fact, never the retracted one.
  - Retracting a superseding fact does not revive its predecessor. Retracted facts do not appear in `storyDiffers`, conflict choices or `retractable`; read-only/unknown decision statuses never receive a retraction action.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** The edit is in force when `stateEditReplacement(override, observations, activeRetractedIds(detail)) === null`. The supplying Observation is the latest valid, non-retracted, non-superseded fact whose value equals the effective value. Use the same fact eligibility in conflict and differing-story projections, including the preset path; an absent decision status prevents a retraction action, not factual provenance. Populate `retractableObservationIds` only from valid facts with decision status `eligible`; set `retractable` only when the supplying fact is in that list. For Starting Cast campaign edits, take `editTurn` from `detail.authoredHistory`'s latest event touching the path (`effectiveTurnNumber`); identity changes use `detail.identityEvents`. Keep provenance separate from the inverse-write calculation in Task 6: missing provenance does not mean a Main Character or identity field has no prior value.
- [ ] **Step 4: Run, expect PASS** (and existing sheet users: `tests/unit/campaign-cast-panel.test.ts`).
- [ ] **Step 5: Commit** `feat(client-core): sheet provenance with turns, replacement and story differs`.

### Task 6: Sheet change requests, Undo and retraction requests

**Files:**
- Create: `packages/client-core/src/characters/sheet-changes.ts`
- Modify: `packages/client-core/src/index.ts`
- Test: `tests/unit/character-sheet-changes.test.ts`

**Interfaces:**
- Consumes: `createCastEditor`, `setCastEditorField`, `changeCastEditor`, `prepareCastSubmission`; `createPresetDraft`, `changePresetField`, `buildPresetRequest`; `createProfileDraft`, `setProfileDraftField`, `buildProfileUpdate`; Task 5 `CharacterField`.
- Produces:
  ```ts
  export type SheetChange = { kind: "field"; path: string; value: string | string[] | null } | { kind: "toggle"; key: "pinned" | "ignored"; value: boolean };
  export type SheetRequest =
    | { endpoint: "edit"; body: EditCastCharacter }
    | { endpoint: "editAuthoredProfile"; body: EditAuthoredCastProfile }
    | { endpoint: "profile"; body: CampaignCharacterProfileUpdate };
  export type SheetTarget = { kind: "cast"; detail: CastDetail } | { kind: "main"; profile: CampaignCharacterProfile & { revision: number } };
  export type SheetWriteFence = { kind: "cast"; revision: number; characterRevision: number; boundary: CastBoundary } | { kind: "main"; revision: number };
  export type SheetUndo =
    | { kind: "restoreValue"; path: string; value: string | string[] }
    | { kind: "restoreOverride"; path: CastField; value: string | null }
    | { kind: "restoreAuthored"; path: string; value: string | string[] | null }
    | { kind: "toggle"; key: "pinned" | "ignored"; value: boolean };
  export function sheetRequest(target: SheetTarget, change: SheetChange, idempotencyKey: string): SheetRequest;
  export function sheetUndoOperation(before: SheetTarget, change: SheetChange): SheetUndo;
  export function sheetMatchesFence(target: SheetTarget, fence: SheetWriteFence): boolean;
  /** Reject mismatched target/fence before building; never adopt target's newer revision. */
  export function sheetUndoRequest(target: SheetTarget, undo: SheetUndo, fence: SheetWriteFence, idempotencyKey: string): SheetRequest;
  export type ConflictChoice = { value: string; observationIds: string[]; latestTurn: number | null; quote: string | null; retractableObservationId: string | null };
  export function conflictChoices(field: CharacterField): ConflictChoice[];
  export function retractionRequest(detail: CastDetail, observationId: string, idempotencyKey: string): ObservationDecisionRequest;
  ```
  `value: null` means "clear my edit". The sheet labels it "Use story value", "Use discovered value", or "Reset to world" for a Starting Cast stable field, where it sends a one-path `reset` that restores the authored value. Export `clearEditLabel(field: CharacterField, kind: "plain" | "startingCast"): "Use story value" | "Use discovered value" | "Reset to world"`.

- [ ] **Step 1: Write failing tests**

```ts
it("Added/Discovered field: one setOverrides key on edit", () => {
  expect(sheetRequest(cast(detail), { kind: "field", path: "story.role", value: "Guide" }, "k")).toEqual({ endpoint: "edit",
    body: { expectedCastRevision: 4, expectedBoundary: detail.boundary, idempotencyKey: "k", expectedCharacterRevision: 3, setOverrides: { "story.role": "Guide" } } });
});
it("null clears exactly one edit", () => { /* body.clearOverrides === ["story.role"], no setOverrides */ });
it("name/aliases send only that key", () => {});
it("Starting Cast stable field uses editAuthoredProfile set", () => {
  const r = sheetRequest(cast(seededDetail), { kind: "field", path: "story.role", value: "Guide" }, "k");
  expect(r.endpoint).toBe("editAuthoredProfile"); expect(r.body).toMatchObject({ set: { "story.role": "Guide" } });
  expect(r.body).not.toHaveProperty("setOverrides"); expect(r.body).not.toHaveProperty("pinned");
});
it("Starting Cast state field uses editAuthoredProfile setOverrides; null uses clearOverrides", () => {});
it("Starting Cast stable null is Reset to world: one reset path", () => {
  expect(sheetRequest(cast(seededDetailWithEdit("story.role", "Guide")), { kind: "field", path: "story.role", value: null }, "k").body).toMatchObject({ reset: ["story.role"] });
  expect(clearEditLabel(seededField("story.role"), "startingCast")).toBe("Reset to world");
});
it("toggle sends only that key on the character's path", () => {
  expect(sheetRequest(cast(detail), { kind: "toggle", key: "pinned", value: true }, "k").body).toEqual(expect.objectContaining({ pinned: true }));
  expect(sheetRequest(cast(seededDetail), { kind: "toggle", key: "ignored", value: true }, "k")).toMatchObject({ endpoint: "editAuthoredProfile", body: { ignored: true } });
});
it("main character field uses profile update", () => { expect(sheetRequest(main(profile), { kind: "field", path: "story.goals", value: "Escape" }, "k")).toEqual({ endpoint: "profile", body: buildProfileUpdate(setProfileDraftField(createProfileDraft(profile), "story.goals", "Escape"), profile.revision) }); });
it("undo restores a previous override, or clears when there was none", () => {
  expect(sheetUndoOperation(cast(detailWithEdit("story.role", "Old")), { kind: "field", path: "story.role", value: "New" })).toEqual({ kind: "restoreOverride", path: "story.role", value: "Old" });
  expect(sheetUndoOperation(cast(detail), { kind: "field", path: "story.role", value: "New" })).toEqual({ kind: "restoreOverride", path: "story.role", value: null });
  expect(sheetUndoOperation(cast(detailWithEdit("story.role", "Old")), { kind: "field", path: "story.role", value: null })).toEqual({ kind: "restoreOverride", path: "story.role", value: "Old" });
  expect(sheetUndoOperation(cast(detail), { kind: "toggle", key: "pinned", value: true })).toEqual({ kind: "toggle", key: "pinned", value: false });
});
it("undo of a replaced state edit restores nothing stale", () => { /* before: edit replaced → undo of new edit is clear (null), not the replaced value */ });
it("conflict choices group eligible fact values newest first, excluding claims, invalidated, superseded and retracted", () => {});
it("retraction request carries all fences", () => {
  expect(retractionRequest(detail, "obs", "k")).toEqual({ action: "retract", expectedCastRevision: 4, expectedCharacterRevision: 3, expectedBoundary: detail.boundary, idempotencyKey: "k" });
});
```

Add exact-payload tests for Main Character text/list Undo (previous concrete value, untouched profile fields preserved); name-only and aliases-only Undo for plain and Starting Cast Characters (no `resetIdentity` or sibling identity key); Starting Cast stable inherited value (one `reset` path) versus prior campaign edit (one `set` path); state/observed override clear versus restore; toggles and both use-story/discovered actions. Assert mismatched cast revision, character revision, boundary or Main Character revision rejects Undo without an API call.

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
  - **Plain cast path:** `createCastEditor({ revision, boundary }, detail)`, then `changeCastEditor` for name, aliases and toggles, or `setCastEditorField` for fields, then `prepareCastSubmission(state, key).submission`.
  - **Starting Cast path** (`originProfile`): use `createPresetDraft` → `changePresetField` → `buildPresetRequest`. A null stable-field change resets only that authored path; a null updating/observed field uses `discover`. Identity fields always use explicit values, never `resetIdentity`; reject a null identity change. Toggles set only the changed draft boolean.
  - **Undo:** compute the inverse before dispatch from the authority appropriate to the path, not `editTurn`. Main Character and identity fields use `restoreValue`; stable Starting Cast fields inspect `fieldSources`/authored history for prior campaign edit versus inheritance; override fields use the prior active override and Task 1's predicate with retracted IDs. A replaced override maps to null. `restoreAuthored` null means a one-path `reset`; `restoreOverride` null means a one-path `clearOverrides`. Main Character inverse uses the revisioned full-profile builder and preserves all other values. Undo appends a compensating event at the current boundary; it does not recreate an old evidence timestamp.
  - **Fences:** controllers capture `SheetWriteFence` from the successful API write response. `sheetUndoRequest` requires a target matching that receipt and sends exactly those fences. A refresh is never permission to advance them. Use a new stable idempotency key for the inverse, retained for retries of that same request.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(client-core): single-change sheet requests, undo and retraction requests`.

### Task 7: Section refine merge and proposal label

**Files:**
- Create: `packages/client-core/src/characters/section-refine.ts`
- Modify: `packages/client-core/src/index.ts`
- Test: `tests/unit/character-section-refine.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type RefineSection = "identity" | "story" | "appearance";
  export function refineSectionPaths(section: RefineSection): string[];
  export function applyRefinedSection(current: PlayableCharacter, generated: PlayableCharacter, section: RefineSection): PlayableCharacter;
  export function refinedSectionDiff(current: PlayableCharacter, generated: PlayableCharacter, section: RefineSection): Array<{ path: string; label: string; current: string | string[]; proposed: string | string[] }>;
  export function sectionRefineRequest(content: WorldContent, current: PlayableCharacter, section: RefineSection, instruction: string, progressKey: string): PlayableCharacterGenerationPreviewRequest;
  export function authoringJobLabel(job: { status: string; target: { kind: "new_world" } | { kind: "world_draft"; characterId?: string }; expiresAt: string }, locale?: string): string;
  ```

- [ ] **Step 1: Write failing tests:**
  - `refineSectionPaths("identity")` equals `["profile.identity.aliases", "profile.identity.pronouns"]`.
  - Applying "story" from a generated character with a different `id`, `name`, `rpgStats` and appearance changes only story paths (including `unclassifiedNotes`); `id`, `name`, `source`, `campaignUse`, `startingCastDefault`, `alwaysInContext` and mechanics are unchanged.
  - The diff lists only changed paths with registry labels: `[{ path: "profile.appearance.eyes", label: "Eyes", current: "Silver", proposed: "Red" }]`.
  - `sectionRefineRequest` replaces an existing roster entry by ID with the current unsaved candidate, or appends a new candidate, and sends its `characterId` in both modes. Other roster entries and the caller's content/candidate remain unchanged. Invalid candidates, duplicate IDs or roster-capacity overflow return actionable validation errors before dispatch.
  - `authoringJobLabel({ status: "awaiting_review", target: { kind: "new_world" }, expiresAt: "2026-11-20T10:00:00.000Z" }, "en-US")` equals `"New character · awaiting review · expires 11/20/2026"`. A `world_draft` target with `characterId` starts with `"Edit existing character · "`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Paths come from `WORLD_EDITOR_FIELDS` by section (Identity minus `name`; story and notes groups → story; Appearance), prefixed `profile.`. Work on a `structuredClone` of `current`. Build refine content from a clone, upserting the captured candidate by ID; validate with the existing world-content and preview-request schemas. Include `campaignUse: "supporting"` only for that use, because the preview contract accepts only that optional value. Local section application preserves all original use flags.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(client-core): section refine merge and proposal labels`.

---

## Phase 2 · Shared DOM components (apps/web/src/character-editor)

### Task 8: Cast roster view

**Files:**
- Create: `apps/web/src/character-editor/cast-roster-view.ts`
- Modify: `apps/web/src/styles.css` (append `.cast-roster-view`)
- Test: `tests/unit/cast-roster-view.test.ts`

**Interfaces:**
- Consumes: Task 4.
- Produces:
  ```ts
  export type CastRosterViewOptions = {
    characters: CastCharacter[]; attention: Record<string, CastAttention | undefined>;
    tracking: CastDiscoveryStatus | null; attentionTotal: number | null;
    filters: Array<[CharacterFilter, string]>; filter: CharacterFilter; query: string;
    canAdd: boolean; addDisabledReason?: string;
    secondaryActions: HTMLElement[];   // e.g. "Add from world"
    tools: HTMLElement[];              // placed inside "Tracking and tools"
    onQuery(query: string, filter: CharacterFilter): void;
    onOpen(id: string): void; onAdd(): void; onAttention(): void;
    debounceMs?: number;               // default 250
    schedule?: (fn: () => void, ms: number) => () => void;
  };
  export function renderCastRoster(host: HTMLElement, options: CastRosterViewOptions): { focusSearch(): void; dispose(): void };
  ```

- [ ] **Step 1: Write failing tests:**
  - Child order is `.cast-roster-status`, `.cast-roster-toolbar`, `.cast-roster-list`; `details.cast-roster-tools` is closed; `data-tone` comes from `trackingSummary`.
  - A row is a name button, the provenance, the summary and `.cast-badge` texts.
  - Typing "m", "ma", "mar" calls `onQuery` once with `("mar", "all")` after 250 ms; filter change and submit call it immediately.
  - The toolbar holds "Needs attention (5)" (or "Needs attention" when null), then `secondaryActions`, then "Add character", which is disabled with the reason text when `!canAdd`.
  - Empty-list copy is `"No characters match this search."` or `"No supporting characters yet. Add someone from your story."`.
  - Hostile names render as text.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Dropping stale responses stays with callers' epochs.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(web): shared cast roster view`.

### Task 9: Character sheet view

**Files:**
- Create: `apps/web/src/character-editor/character-sheet-view.ts`
- Modify: `apps/web/src/styles.css` (append `.character-sheet-view`)
- Test: `tests/unit/character-sheet-view.test.ts`

**Interfaces:**
- Consumes: Task 5 `CharacterSheet`/`CharacterField`, Task 6 `conflictChoices`, registry descriptors.
- Produces:
  ```ts
  export type SheetResult = { ok: true } | { ok: false; conflict: boolean; message: string };
  export type SheetFeedback = { message: string; undo?: () => Promise<SheetResult> };
  export type RetractionPreview = { currentValue: string | null; projectedValue: string | null; quote: string; turn: number };
  export type CharacterSheetViewOptions = {
    sheet: CharacterSheet; kind: "main" | "supporting";
    editable(path: string): boolean; lockedReason: string | null;
    onChange(change: SheetChange): Promise<SheetResult>;
    feedback?: SheetFeedback;          // controller-owned, survives same-character refresh
    retraction?: { preview(observationId: string): Promise<RetractionPreview>; apply(observationId: string): Promise<SheetResult> }; // absent ⇒ no "This is wrong"
    toggles?: { pinned: boolean; ignored: boolean };
    onCompareLatest(): void; compareLabel: "Compare latest" | "Load latest version";
    showEmpty: boolean; onShowEmpty(value: boolean): void;
    confirmDiscard(): boolean;
    isCurrent(): boolean;              // false after switching character/campaign/close
  };
  export function renderCharacterSheetView(host: HTMLElement, options: CharacterSheetViewOptions): { revealField(path: string, mode?: "edit" | "conflict"): void; dirty(): boolean; dispose(): void };
  ```

- [ ] **Step 1: Write failing tests:**
  - **Badges and notes:** "Your edit · turn 12"; "From story · turn 20" plus the note "Replaced your edit from turn 12"; "Story differs: Smith · turn 20" plus a "Use story value" button that calls `onChange({ kind: "field", path, value: null })`; "Unverified claim"; "Conflict". No badges when `kind === "main"`.
  - **Edit:** opens an `input` for `input: "text"` and a `textarea` otherwise, with `label[for]`. Save calls `onChange` once with the trimmed value; list fields split lines and drop blanks.
  - **Clear-edit label:** a field in force from the user offers the `clearEditLabel` action. A Starting Cast stable field reads "Reset to world" and never shows "Story differs".
  - **Saved:** controller-supplied feedback renders "Saved Pronouns" with an Undo button. Undo calls `feedback.undo()`; updated controller feedback reads "Undone". Replacing the view with a refreshed view carrying the same feedback preserves the notice/action. The view does not own expiration or clear feedback on disposal.
  - **Stale view:** a disposed view never announces or mutates the replacement view after its promise settles. The controller supplies success feedback to the current sheet; there is no success-side DOM update in the old view.
  - **Conflict:** typed value kept; alert `"This character changed. Your edit is kept; compare the latest before saving."`; a `compareLabel` button calls `onCompareLatest`.
  - **One editor at a time:** switching from a dirty editor with `confirmDiscard() === false` keeps it open.
  - **"This is wrong":** shown only when `retraction` is present and `field.retractable` has eligible decision status from Task 5. It opens a confirm region reading `"After this, {label} will read: {projected or "Unknown"}"` with the quote and turn as text, plus Confirm and Cancel. Confirm calls `apply`. Retracted/read-only facts have no action and never return through conflict choices after refresh.
  - **Conflict picker:** with `retraction`, choices read `"Tinker · turn 7 · “q7”"`; "This is wrong" appears only when `retractableObservationId` identifies the displayed latest fact and belongs to the field's eligible action IDs. Read-only choices remain visible without that action, and there's a field-level "Write my own". Without `retraction`, each choice has "Use this", which calls `onChange({ kind: "field", path, value: "Tinker" })`.
  - **Toggles:** buttons with `aria-pressed`, calling `onChange({ kind: "toggle", ... })`. A failure rolls back; success offers Undo.
  - **Late result:** when `isCurrent()` is false, a result neither re-renders nor announces.
  - **Locking:** non-editable fields have no actions, and `lockedReason` renders once.
  - **Untrusted text:** hostile values and quotes render as text.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** One `section` + `h3` per sheet section, each field a `div.character-sheet-field[data-path]`. Render success status and Undo only from `feedback`; the host owns its lifetime. All field actions are disabled while a change is pending. Guard asynchronous error rendering by disposal and `isCurrent()`. Escape in an inline editor cancels it and stops propagation. Toggle hint: `"Pin prioritizes this character in story context. Ignore excludes this supporting character from story context."`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(web): shared character sheet view`.

---

## Phase 3 · Nexus (apps/web)

### Task 10: Nexus roster

**Files:**
- Modify: `apps/web/src/campaign-cast-panel.ts:269-366` (`renderRoster`)
- Test: `tests/unit/campaign-cast-panel.test.ts`, `tests/e2e/campaign-cast.e2e.test.ts`

- [ ] **Step 1: Write failing tests:**
  - `.cast-roster-status` precedes `#cast-search`.
  - The narrator notice, retry, recovery, Refresh characters, Likely included and Scan earlier story sit inside "Tracking and tools".
  - "Add from world" is a secondary action, gated by `castPresets` as today.
  - The Removed filter appears only when `castLifecycle !== undefined`.
  - Debounced typing: two out-of-order `api.list` responses leave the newer query's roster showing.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** with Task 8. Map `onQuery` to `workspace.setQuery` + `loadRoster()`, guarded by a fresh `epoch` token. Keep "Load more characters" and the Main Character first.
- [ ] **Step 4: Run unit + e2e, expect PASS** (update selectors only).
- [ ] **Step 5: Commit** `feat(nexus): scannable cast roster with live search`.

### Task 11: Nexus sheet for every character type

**Files:**
- Modify: `apps/web/src/campaign-cast-panel.ts:386-490` (`renderSheet`) and the options type at `:24`
- Modify: the `createLegacyCastPanel({...})` call sites (`grep -n createLegacyCastPanel apps/web/src/nexus.js apps/web/src/story.js`) to pass `saveProfile`
- Test: `tests/unit/campaign-cast-panel.test.ts`, `tests/e2e/unified-character-editor.e2e.test.ts`

**Interfaces:**
- Consumes: Tasks 5, 6, 9; `options.api.edit`, `options.api.editAuthoredProfile`, `options.api.previewObservationDecision`, `options.api.applyObservationDecision`.
- Produces: optional panel option `saveProfile?: (campaign: string, update: CampaignCharacterProfileUpdate) => Promise<CampaignCharacterProfile & { revision: number }>`.

- [ ] **Step 1: Write failing tests:**
  - **Request bodies:** an exact `api.edit` body for an Added Character, and an exact `api.editAuthoredProfile` body for a Starting Cast Character.
  - **Undo:** exact inverse payload uses the write receipt's fences, after refreshed detail matches them. Saved/Undo remain visible and clickable after refresh; Undo completes and shows "Undone". Expiry is 30 seconds from write success, not restarted by refresh; the next edit or navigation clears it.
  - **Intervening writes:** a second writer between save and refresh withdraws Undo and makes no inverse call; between refresh and Undo it produces a 409 and leaves the second writer's value intact. Cover both cast and Main Character revisions. No fresh fetch may silently rebase the inverse.
  - **Tracking bump:** a background tracking write that advances the cast revision before refresh withdraws Undo with "Saved {label}. Undo expired: the character was updated after your save." The notice is a status, not an alert, and offers no retry.
  - **Browser (`tests/e2e/unified-character-editor.e2e.test.ts`):** save → refresh → visible Undo → reload; conflict retention; retraction; stale navigation, at desktop and 390 px. Extend `tests/e2e/nexus-character-native-zoom.e2e.test.ts` with keyboard editing of a sheet field and Undo at verified native 2.0 zoom (44 px targets, no clipping).
  - **Composed proof:** extend the `NEXUS_CAST_BROWSER_PROOF=1` cases in `tests/integration/world-library.integration.test.ts` for Nexus. Cover save/reload/Undo for all four character types, both competing-write windows, retraction → reload → restored State Edit, and another campaign's isolation, through the real API and isolated PostgreSQL.
  - **Refresh failure:** a successful save followed by a failed detail read says "Saved {label}. Could not refresh this character." and offers Reload, without Undo or a misleading save-failure retry. A later matching reload may offer Undo only within the original expiry.
  - **Main Character:** sheet edit calls `saveProfile`, and a 409 shows "Load latest version". Without `saveProfile` it keeps only "Edit main character".
  - **This is wrong:** previews, then applies with `retractionRequest`, then the sheet refreshes.
  - **Without `observationDecisions`:** no "This is wrong", and the conflict picker shows "Use this".
  - **Locked:** generation active, removed or merged-away → no actions.
  - **Late result:** save, refresh and Undo resolving after `openDetail(other)`, campaign switch or close do not announce or re-render. Same-character refresh alone does not invalidate the saved feedback.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Replace only the `fieldGroups`/`renderFields` block (including the separate preset rows) with `renderCharacterSheetView`; store its handle as `sheetView`. Keep the switcher, Back, turn line, Open in Story, lifecycle actions, "Edit character", the protagonist opener, auto-match rows and `renderEvidence()`.
  - `editable(path)` = `enabled && !options.generationActive() && !lockedByServer && !removed && !mergedIntoCharacterId`.
  - `onChange` builds `sheetRequest` with `operationKey("sheet", [id, change, detail.revision])`, awaits `syncLock()` when `options.checkLock`, then dispatches on `endpoint`.
  - Before dispatch compute `sheetUndoOperation(beforeTarget, change)`. On success retain its write receipt, inverse, feedback, deadline and idempotency key in controller state scoped to campaign/character/navigation epoch. Refresh the current detail/profile without calling the navigation entry point `openDetail` or incrementing its epoch; re-render the sheet with controller feedback only if still current.
  - Offer Undo only when `sheetMatchesFence(refreshedTarget, receiptFence)` and before the original deadline. Use `sheetUndoRequest` with the retained receipt fence. An intervening revision before refresh withdraws Undo with the tracking-bump copy above; a conflict after refresh withdraws it with "Could not undo. The character changed; review the latest values." The controller owns the 30-second timer and clears it on next edit or navigation, not on view disposal.
  - If refresh fails after a successful write, retain the Saved notice and receipt, show the explicit refresh-failure copy and Reload, and withhold Undo. Never retry the already-successful write as if it failed. An inverse success updates feedback to "Undone" and follows the same current-sheet refresh guard.
  - On 409: `{ ok: false, conflict: true, message: "This character changed. Your edit is kept; compare the latest before saving." }`.
  - `retraction` is present only when `capabilities.observationDecisions === true`.
- [ ] **Step 4: Run unit + e2e, expect PASS.**
- [ ] **Step 5: Commit** `feat(nexus): edit, undo and retract directly on the character sheet`.

### Task 12: Nexus conflict links open the sheet picker

**Files:**
- Modify: `apps/web/src/campaign-cast-panel.ts:238-246` (`openConflict`)
- Test: `tests/unit/campaign-cast-panel.test.ts`

- [ ] **Step 1: Write failing test** `"conflict link opens that field's choices on the sheet with focus on the first action"`, covering an Added Character and a Starting Cast Character.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `openConflict` as `await openDetail(id)` followed by `sheetView?.revealField(field, "conflict")`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(nexus): resolve conflicts from Needs attention on the sheet`.

---

## Phase 4 · Web-Next in-story Characters dialog (apps/web-next)

### Task 13: Dependency seam, characterization tests and module split

**Files:**
- Modify: `apps/web-next/src/characters-workspace.ts` (trailing optional `dependencies?: { api?: CampaignCastApi; confirm?: (message: string) => boolean; schedule?: CastRosterViewOptions["schedule"] }`)
- Create: `apps/web-next/src/characters-workspace-editor.ts` (move `renderEditor` and compare/reapply unchanged)
- Create: `apps/web-next/src/characters-workspace-tools.ts` (move `scan`, `preview`, `review` unchanged)
- Test: `tests/unit/web-next-characters-workspace.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CastEditorContext = { document: Document; api: CampaignCastApi; session: ReturnType<typeof createCharactersWorkspaceSession<CastEditorState>>; getState(): CharactersWorkspaceState<CastEditorState>; getEditor(): CastEditorState | null; setEditor(next: CastEditorState | null): void; generationActive(): boolean; epoch(): number; confirm(message: string): boolean };
  export function renderCastEditor(dialog: HTMLDialogElement, context: CastEditorContext): void;
  export type CastToolContext = { api: CampaignCastApi; campaignId: string; dialog: HTMLDialogElement; generationActive(): boolean; current(): boolean; back(): void; navigateToTurn(turn: number): void; operationKey(operation: string, payload: unknown): string; clearKeys(): void; capabilities: CharactersWorkspaceState<CastEditorState>["status"] };
  export function openCastTool(kind: "scan" | "preview" | "review", context: CastToolContext, scanId?: string): Promise<void>;
  ```

- [ ] **Step 1: Write characterization tests** with a fake injected API covering the roster names, the sheet, Add → `api.create`, the dirty-close confirm and a stale-campaign response being ignored.
- [ ] **Step 2: Run, expect PASS** with the seam only.
- [ ] **Step 3: Split** with no behavior change.
- [ ] **Step 4: Run, expect PASS;** `pnpm check:web`.
- [ ] **Step 5: Commit** `refactor(web-next): inject cast API and split Characters dialog`.

### Task 14: Web-Next roster, Removed filter and Add from world

**Files:**
- Modify: `apps/web-next/src/characters-workspace.ts` (roster branch)
- Test: `tests/unit/web-next-characters-workspace.test.ts`

**Interfaces:**
- Consumes: Task 8; `renderWorldCastPicker(host, api, campaign, lock, onAdded)` (`apps/web/src/character-editor/world-cast-picker.ts:5`).

- [ ] **Step 1: Write failing tests:**
  - Status first, badge rows.
  - The Removed filter appears when `castLifecycle !== undefined`.
  - "Add from world" appears only with `castPresets`; it opens the picker and, once a character is added, opens that sheet.
  - Live search calls `session.setQuery` once after 250 ms.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** The tools are the existing retry, Open tracking recovery, Scan earlier story, Likely included for this input, Review character changes and Review conflicts, with their current gating. `onAttention` → `openCastTool("review", …)`. The picker's `lock` = `async () => !generationActive()`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(web-next): Characters roster with live search, Removed filter and Add from world`.

### Task 15: Web-Next sheet

**Files:**
- Modify: `apps/web-next/src/characters-workspace.ts` (selected-character branch); `apps/web-next/src/characters-workspace-editor.ts` (drop Pin/Ignore checkboxes)
- Test: `tests/unit/web-next-characters-workspace.test.ts`

- [ ] **Step 1: Write failing tests:**
  - Exact request bodies for the Added, Starting Cast and Main Character paths.
  - Saved/Undo survive same-character refresh; Undo uses only its write receipt's fences. Mirror Task 11's before/after-refresh competing writes, tracking bump, failed refresh, expiry and navigation tests for cast and Main Character paths.
  - **Browser:** create `tests/e2e/web-next-characters-sheet.e2e.test.ts` with the Task 11 sheet cases at desktop and 390 px. Create `tests/e2e/web-next-character-native-zoom.e2e.test.ts`, using the Nexus suite's owned Chromium profile and verified tab zoom of 2.0, with sheet edit and Undo by keyboard.
  - **Composed proof:** add the Web-Next client to the `NEXUS_CAST_BROWSER_PROOF=1` cases. Start a task-owned Web-Next Vite server, add `PLAYWRIGHT_WEB_NEXT_PORT` to the composed fixture following the existing convention, and mirror Task 11's persistence assertions.
  - "This is wrong" appears only with `capabilities.observationDecisions`.
  - A save resolving after `session.select(other)` does not announce or re-render.
  - With generation active there are no actions.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** as in Task 11, using `api.edit`, `api.editAuthoredProfile`, `saveProfile`/`getProfile` and the observation-decision API.
  - `isCurrent` = `epoch === openEpoch && state.selectedId === id && dialog.open`.
  - Keep feedback, inverse, receipt fence and expiry in controller state across `session.refresh()`. A session emission or view disposal does not reset that state; selection/campaign change and close do. After refresh compare its detail/profile to the retained write receipt before enabling Undo. Use Task 6's `sheetUndoRequest`, never a request rebuilt with an advanced revision.
  - Keep "Edit character" / "Edit main character", Sources and edit history and the auto-match rows.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(web-next): edit, undo and retract on the character sheet`.

### Task 16: Web-Next lifecycle actions

**Files:**
- Modify: `apps/web-next/src/characters-workspace.ts` (replace message-only lines for lifecycle)
- Test: `tests/unit/web-next-characters-workspace.test.ts`; create `tests/e2e/web-next-characters-lifecycle.e2e.test.ts` mirroring the Nexus remove/restore/merge cases in `tests/e2e/campaign-cast.e2e.test.ts`

**Interfaces:**
- Consumes: `showLifecycle(action, { api: api.lifecycle, list: api.list, campaign, detail, lock, finished, mergeEventId? })` (`apps/web/src/character-editor/cast-lifecycle.ts:16`).

- [ ] **Step 1: Write failing tests:**
  - **Available:** with `castLifecycle: true`, a non-removed Supporting Character gets "Merge with another character", "Remove from cast" and "Add to world draft".
  - **Removed:** only "Restore".
  - **Active merge:** "Merged from {name}" + "Undo merge", disabled when `!canUndo`.
  - **Disabled:** `castLifecycle: false` shows `"Removing and restoring characters is disabled on this server. Character merging is disabled on this server."`.
  - **Excluded:** no lifecycle actions for the Main Character or merged-away characters.
  - **Dirty editor:** confirms discard first.
  - **Navigation:** `finished("")` returns to the roster with the notice; `finished(id)` opens that sheet.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** `lock` = `async () => !generationActive()`. Disable the actions while generation is active.
- [ ] **Step 4: Run unit + e2e, expect PASS.**
- [ ] **Step 5: Commit** `feat(web-next): remove, restore, merge and promote characters`.

### Task 17: Web-Next editor form and Draft from story

**Files:**
- Create: `apps/web/src/character-editor/story-draft-panel.ts` (extract `renderStoryDraft` from `apps/web/src/campaign-cast-panel.ts:491-526`, parameterized)
- Modify: `apps/web/src/campaign-cast-panel.ts` (call the extracted panel), `apps/web-next/src/characters-workspace-editor.ts`, `apps/web-next/src/story-player.css:602-611`
- Test: `tests/unit/campaign-cast-panel.test.ts` (unchanged Nexus behavior), `tests/unit/web-next-characters-workspace.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function renderStoryDraftPanel(form: HTMLElement, options: {
    detail: CastDetail; readonly: boolean; draftPreview: CampaignCastApi["draftPreview"]; campaign: string;
    review: ReturnType<typeof createStoryDraftReview>;
    current(path: string): string | string[] | undefined; apply(path: string, value: string | string[]): void; changed(): void;
  }): void;
  ```

- [ ] **Step 1: Write failing tests:**
  - The existing Nexus Draft from story cases still pass after the extraction.
  - In Web-Next, the editor's group summaries equal the distinct `SUPPORTING_FIELDS` sections in registry order. `identity.pronouns` is an `input` and `story.role` a `textarea`. Every control has `label[for]`.
  - Draft from story fills only the reviewed fields and carries `draftEvidenceFences` in the save body.
  - A successful save opens the sheet and announces `"Saved {name}"`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Extract first and run the Nexus tests, then mirror `renderSupportingEditorFields` + `createCastTextField` in Web-Next (IDs `characters-${path.replace(".", "-")}`) and mount `renderStoryDraftPanel` for existing non-main characters when `api.draftPreview` exists.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(web-next): registry-grouped character editor with Draft from story`.

---

## Phase 5 · Web-Next world character workspace

Browser evidence belongs with each task. Task 18 creates `tests/e2e/web-next-character-workspace.e2e.test.ts`. Every Phase 5 task adds its own case there in Step 1 and commits it with the feature, at desktop and 390 px:
- Task 18: Review entry for an existing character.
- Task 19: use and context flags.
- Task 20: mechanics edit, remove and Undo with extension keys preserved. Also extend `tests/e2e/web-next-character-native-zoom.e2e.test.ts` with keyboard table editing at verified 2.0 zoom.
- Task 21: guidance hints.
- Task 22: Organize applies only the selected paths.
- Task 23: proposal labels.
Validation focus is covered in Task 18.

### Task 18: Existing characters open on Review

**Files:**
- Modify: `apps/web-next/src/character-workspace-model.ts:194-207`, `apps/web-next/src/character-workspace-page.ts:170-174, 371-377`
- Test: `tests/unit/web-next-character-workspace-model.test.ts`, `tests/unit/web-next-character-workspace-page.test.ts`

**Interfaces:**
- Produces: `CreateCharacterWorkspaceOptions.mode?: "create" | "edit"`. `"edit"` starts at `{ stage: "review", furthestStageIndex: 5 }`.

- [ ] **Step 1: Write failing tests:**
  - In edit mode the page renders `[data-character-review]` first, with every stage button enabled.
  - A candidate with no story fields shows the error summary; Accept moves to Story with the error focused.
  - Create mode is unchanged.
  - The edit-mode Method heading is `"Regenerate with AI"` with the description `"Describe changes and generate a replacement draft for review, or return to Review."`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Pass `mode: activeSession.mode`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(web-next): open existing characters on Review`.

### Task 19: Character use and context flags on Identity

**Files:**
- Modify: `apps/web-next/src/character-workspace-page.ts` (`renderMethod` :373, :378-396; `renderIdentity` :429-447)
- Test: `tests/unit/web-next-character-workspace-page.test.ts`

- [ ] **Step 1: Write failing tests:**
  - Identity holds "Character use".
  - For supporting/both it also holds "Select by default in starting cast" and "Always include in narrator context", bound to `startingCastDefault` / `alwaysInContext`.
  - Switching to supporting hides Mechanics and disposes a durable session with the current copy.
  - Method has no use select.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** by moving the existing handler body. Checkboxes call `fieldChanged([...], checked)`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(web-next): character use and context flags on Identity`.

### Task 20: Mechanics table

**Files:**
- Create: `apps/web-next/src/character-mechanics-table.ts`
- Modify: `apps/web-next/src/character-workspace-page.ts:486-522`, remove `mechanicsCollection`/`mechanicsIndex` and their click branches at `:937-940`; `apps/web-next/src/styles.css`
- Test: `tests/unit/web-next-character-mechanics-table.test.ts`

**Interfaces:**
- Produces: `renderMechanicsTable(host: HTMLElement, options: { kind: "stat" | "trigger"; items: readonly unknown[]; max: number; onChange(items: unknown[]): void }): { dispose(): void }`

- [ ] **Step 1: Write failing tests:**
  - Columns are Name/Value/Note and Name/Condition/Effect, each control labelled `"{column} for row {n}"`.
  - Edits go through `mergeStructuredFields` and keep extension keys and order.
  - Remove → "Undo remove" restores the exact row at its index, and a second removal replaces the undo.
  - Add is disabled at `MAX_CHARACTER_MECHANICS_ITEMS`.
  - Unnamed rows read "Unnamed statistic" / "Unnamed tracker" in the remove label.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Render "Statistics" and "Trackers" tables. Keep `#character-rpgStats-error` / `#character-defaultTriggers-error`, and point `showValidation`'s mechanic control at the table's first control.
- [ ] **Step 4: Run new + page tests, expect PASS.**
- [ ] **Step 5: Commit** `feat(web-next): table editor for character mechanics`.

### Task 21: Registry field guidance

**Files:**
- Modify: `apps/web-next/src/character-workspace-page.ts:106-124` (`textControl`) and callers
- Test: `tests/unit/web-next-character-workspace-page.test.ts`

- [ ] **Step 1: Write failing test:** each rendered registry field has `placeholder === world.placeholder` and a `small.character-field-hint` with `world.title`, and `aria-describedby` = `"{hintId} {errorId}"`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** via an optional `descriptorPath` looked up in `WORLD_EDITOR_FIELDS`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(web-next): field guidance from the character registry`.

### Task 22: Organize retained guidance

**Files:**
- Create: `apps/web-next/src/character-organize-panel.ts`
- Modify: `apps/web-next/src/character-workspace-page.ts:462-468`; `CharacterWorkspacePageDependencies` (add `organizeCharacter?`)
- Test: `tests/unit/web-next-character-organize-panel.test.ts`

**Interfaces:**
- Consumes: `organizeCharacter(worldId, { expectedRevision, character }, signal)` (`packages/client-web/src/api-client.ts:212`).
- Produces: `renderOrganizePanel(host: HTMLElement, options: { organize(signal: AbortSignal): Promise<CharacterProfileOrganizationResult>; current: PlayableCharacter; onApply(next: PlayableCharacter): void }): { dispose(): void }`

- [ ] **Step 1: Write failing tests:**
  - Proposals show label, current, proposed and evidence quotes as text, with checkboxes checked by default.
  - "Apply selected" changes only the checked paths.
  - `unassignedText`, `conflicts` and `warnings` render as lists.
  - A failure shows `authoringFailureText`, without applying.
  - Dispose aborts.
  - The page shows the panel for `world-editor`, and `"Organize is available after the world is saved."` for `world-creation`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Derive `worldId` as at `character-workspace-page.ts:815` and use `expectedWorldRevision`. `onApply` replaces the candidate, sets `candidateDirty`, calls `markDirty()` and re-renders.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(web-next): organize retained character guidance`.

### Task 23: Readable proposal labels

**Files:**
- Modify: `apps/web-next/src/character-workspace-page.ts:209, 1057`
- Test: `tests/unit/web-next-character-workspace-page.test.ts`

- [ ] **Step 1: Write failing test:** the proposal text equals `authoringJobLabel(job)`, does not contain the job ID, and the ID is in `title`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** with Task 7.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(web-next): readable saved proposal labels`.

---

## Phase 6 · Per-section AI refine (separately releasable)

### Task 24: Shared refine panel and Web-Next integration

**Files:**
- Create: `apps/web/src/character-editor/section-refine.ts`
- Modify: `apps/web-next/src/character-workspace-page.ts` (Identity, Story, Appearance headers)
- Test: `tests/unit/character-section-refine-panel.test.ts`, `tests/unit/web-next-character-workspace-page.test.ts`
- Test: `tests/unit/character-section-refine.test.ts`; extend the existing provider-preview coverage in `tests/integration/world-library.integration.test.ts` to inspect candidate context using a deterministic provider.

**Interfaces:**
- Consumes: Task 7.
- Produces: `mountSectionRefine(host: HTMLElement, options: { section: RefineSection; current(): PlayableCharacter; generate(current: PlayableCharacter, instruction: string, signal: AbortSignal): Promise<PlayableCharacter>; onApply(next: PlayableCharacter): void; available: boolean; unavailableText: string }): { dispose(): void }`

- [ ] **Step 1: Write failing tests:**
  - "Refine with AI" opens a textarea labelled `"What should change in {Section}?"`, and Generate stays disabled while it is empty.
  - Generating shows "Refining…" and Cancel.
  - The result shows Current/Proposed rows, or `"No changes proposed for this section."` when there are none.
  - Apply calls `onApply(applyRefinedSection(...))`.
  - Cancel or failure leaves the character unchanged.
  - With `available: false` the panel shows `unavailableText`.
  - Generating captures `current()` once and passes that clone to `generate`. Both unsaved edits to an existing character and a new unsaved character reach the preview adapter/provider as the selected current character, with the section instruction.
  - If the candidate changes before the response or between preview and Apply, discard the proposal and show "This character changed. Generate a new section proposal." Cancel, dispose and navigation abort and invalidate late responses even if the transport ignores abort.
  - Apply changes only the chosen section, preserving untouched fields, identity and mechanics from the captured candidate. Failure leaves both candidate and world roster unchanged.
  - Browser: add an unsaved-candidate Refine case to `tests/e2e/web-next-character-workspace.e2e.test.ts`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
  - Web-Next `generate(current, instruction, signal)` calls `generatePreview(sectionRefineRequest(activeSession.worldContext, current, section, instruction, progressKey), signal)` and returns `.character`. The request uses the captured candidate for both create and edit mode; never send the original roster unchanged or omit `characterId` for a new candidate.
  - It is available only without a `durableSession` and while no generation is running. Otherwise it shows `"Finish or cancel the current AI proposal to refine a section."`.
  - Capture a candidate fingerprint at Generate, compare the complete candidate again when the response arrives and immediately before Apply, and guard with a panel request epoch. Compare structured values, not object identity. Apply only after both checks succeed; invalidate proposals on disposal/cancel.
- [ ] **Step 4: Run the listed units and focused world-library integration with the integration config, expect PASS.** Verify the provider sees the latest unsaved values; a request-builder assertion alone is insufficient.
- [ ] **Step 5: Commit** `feat: refine one character section with AI in the Web-Next workspace`.

### Task 25: Nexus world character dialog integration

**Files:**
- Modify: `apps/web/src/nexus.js` (character dialog setup near `generateCharacterFromPrompt`, `:4315`, mounting into `#characterIdentityDetails`, `#characterStoryDetails`, `#characterAppearance`)
- Test: `tests/e2e/nexus-character-workspace.e2e.test.ts`

**Interfaces:**
- Consumes: Task 24; `characterApi.worlds.generateCharacterPreview`, `profileFromForm()`, `populateCharacterForm(character, false)`, `worldContentFromForm()`, `configuredDefaultTextProvider()`.

- [ ] **Step 1: Write failing e2e cases:**
  - Refining Appearance changes only the appearance inputs; name, story and mechanics rows are unchanged.
  - Without a provider the panel shows `"To refine with AI, choose a default text provider and model in Provider Setup."`.
  - Closing the dialog mid-refine discards the result.
  - Editing appearance before Refine sends that unsaved value; a newly created character also reaches generation as `currentCharacter`. Editing while a proposal is pending invalidates it, without replacing later local edits.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
  - Mount once per open dialog.
  - `current()` builds a validated complete candidate from `characterModalWorkingCharacter` and current form values, including name, profile, use flags and mechanics. It must not read a stale saved name/profile.
  - Use Task 7's `sectionRefineRequest(worldContentFromForm(), capturedCurrent, section, instruction, progressKey)` and Task 24's candidate fingerprint/epoch checks, including for new unsaved characters. Upsert only in the cloned request roster.
  - `onApply` → `populateCharacterForm(next, false)`, then `worldCharacterPresentation?.refresh?.()`.
  - Reuse the `isCurrentGeneration` epoch guard.
- [ ] **Step 4: Run e2e, expect PASS.**
- [ ] **Step 5: Commit** `feat(nexus): refine one character section with AI`.

### Task 26: Whole-change verification and documentation

Every browser, native-zoom and composed-proof case was written in its owning task (11, 15–23, 25). This task runs them together and records the evidence. It writes no new feature tests.

**Files:**
- Modify: user docs describing the Characters panel and character editor (`grep -ril "character" docs/getting-started docs/concepts`), plus release notes. The notes must state ADR 0045's immediate effect on existing State Edits, the `observationDecisions` release gate and the edit-again fallback, and that Undo is often withdrawn during play.
- Create: `docs/review/character-editor-usability-acceptance.md` (A0–A7 → evidence)
- Capture: `docs/review/assets/character-editor-usability/` (screenshots and native-zoom metrics)

- [ ] **Step 1: Run static/unit/build checks.** `pnpm check`, `pnpm check:client-boundaries`, `pnpm test:unit`, `pnpm build:web:legacy` and `pnpm build:web:next` must pass. Record any pre-existing build warning separately from failures.
- [ ] **Step 2: Run PostgreSQL verification.** `pnpm test:integration` must pass the cast, story-memory and world-library suites, including Tasks 3b–3c. A skipped database suite is not a pass.
- [ ] **Step 3: Run rendered-browser suites** with `CAST_SCREENSHOT_ROOT` set to the absolute evidence directory: `pnpm exec playwright test tests/e2e/campaign-cast.e2e.test.ts tests/e2e/unified-character-editor.e2e.test.ts tests/e2e/nexus-character-workspace.e2e.test.ts tests/e2e/nexus-protagonist-workspace.e2e.test.ts tests/e2e/nexus-roster-mechanics.e2e.test.ts tests/e2e/nexus-character-native-zoom.e2e.test.ts tests/e2e/web-next-characters-sheet.e2e.test.ts tests/e2e/web-next-characters-lifecycle.e2e.test.ts tests/e2e/web-next-character-workspace.e2e.test.ts tests/e2e/web-next-character-native-zoom.e2e.test.ts`. Also run the affected suites from the [test matrix](../../workflows/testing.md). All required cases must run.
- [ ] **Step 4: Run the composed proof.** `NEXUS_CAST_BROWSER_PROOF=1 pnpm exec vitest run --config vitest.integration.config.ts tests/integration/world-library.integration.test.ts`, and assert the opt-in cases actually executed for both clients. Stop only the servers this task started.
- [ ] **Step 5: Record acceptance.** Map A0–A7 and all eight findings to named tests and screenshot links, distinguishing unit, real PostgreSQL, fixture-browser, composed, native-zoom and deterministic-provider evidence. Report passed, failed and skipped cases with reasons. Do not claim physical mobile-keyboard or live-model verification.
- [ ] **Step 6: Run `git diff --check`, verify that linked files exist, and commit** `docs: character editor usability acceptance`.
