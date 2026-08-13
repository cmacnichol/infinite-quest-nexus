# Character Creation Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable Character Creation Workspace that returns one reviewed playable character to either New World or World Editor without directly persisting authoritative world data.

**Architecture:** Candidate transitions, validation, generation transport, and the opaque local handoff live in focused modules. One full-page workspace consumes those modules; each parent creates or consumes a handoff and applies an immutable roster update. Reuse the playable-character preview endpoint and existing progress records; do not add a character-save endpoint.

**Tech Stack:** TypeScript, DOM APIs, sessionStorage, Zod contracts, Vitest, Linkedom, Vite, existing provider/application adapters.

## Global Constraints

- Stages are exactly Method, Identity, Story, Appearance, Mechanics, Review.
- Controls are at least 44px; method controls are 48px; compact stage cells are 52px.
- The route contains only an opaque session key; handoffs expire after 30 minutes and are bounded to 512 KiB.
- The workspace has no authoritative save action. Final copy is **Add to world draft** (or **Update world draft** in edit mode).
- Minimum readiness requires non-empty `name` and `characterText`.
- Strip root `user_id`, `userId`, `owner_user_id`, and `ownerUserId` outbound.
- Generated IDs cannot replace the locally trusted character ID.
- Preserve safe unknown passthrough properties and shared collection limits.
- World generation itself never injects playable characters; only reviewed Character Workspace results enter the New World roster.
- Existing uncommitted live refinements in `apps/web-next/src/styles.css`, `world-creation-page.ts`, and `world-library-page.ts` must survive. Never stage `world-library-page.ts` for this feature; use patch staging for the other two.

---

### Task 1: Character candidate domain model and shared bounds

**Files:**
- Create: `apps/web-next/src/character-workspace-model.ts`
- Modify: `packages/contracts/src/world-library.ts`
- Test: `tests/unit/web-next-character-workspace-model.test.ts`
- Test: `tests/unit/world-library.test.ts`

**Interfaces:**
- Produces `CharacterMethod`, `CharacterStage`, `CharacterWorkspaceState`, `CharacterValidationIssue`.
- Produces `createCharacterWorkspaceState`, `editCharacterCandidate`, `applyGeneratedCharacter`, `setCharacterStage`, `validateCharacterStage`, `characterReview`, and `characterHandoffCandidate`.
- Exports shared playable-character and mechanics collection limits plus `playableCharacterGenerationPreviewResponseSchema`.

- [ ] **Step 1: Write failing contract tests**

Assert the strict preview response parses `{ character }`, rejects extra root fields, and exported constants drive the world roster, RPG statistics, and default-trigger limits.

```ts
expect(playableCharacterGenerationPreviewResponseSchema.parse({
  character: { id: "trusted-id", name: "Mara", characterText: "A patient observer." }
}).character.id).toBe("trusted-id");
expect(() => playableCharacterGenerationPreviewResponseSchema.parse({
  character: { id: "mara", name: "Mara", characterText: "Guidance" },
  ownerUserId: "spoofed"
})).toThrow();
```

- [ ] **Step 2: Run the contract test and verify RED**

Run: `pnpm vitest run tests/unit/world-library.test.ts`
Expected: missing exports/schema.

- [ ] **Step 3: Write failing model tests**

Cover canonical empty state, collision-safe trusted ID, immutable nested edits, exact name/characterText validation, duplicate-ID rejection, duplicate-name warning, generated-ID rejection, owner-key stripping, safe passthrough preservation, bounds, stage readiness, review counts, and duplicate-proof handoff.

```ts
const initial = createCharacterWorkspaceState({ roster: [], idFactory: () => "trusted-character" });
const generated = applyGeneratedCharacter(initial, {
  id: "model-id", name: "Mara", characterText: "A patient observer.",
  ownerUserId: "attacker", importedExtension: { keep: true }
});
expect(generated.candidate.id).toBe("trusted-character");
expect(generated.candidate).not.toHaveProperty("ownerUserId");
expect(generated.candidate.importedExtension).toEqual({ keep: true });
```

- [ ] **Step 4: Run the model test and verify RED**

Run: `pnpm vitest run tests/unit/web-next-character-workspace-model.test.ts`
Expected: module not found.

- [ ] **Step 5: Implement the contracts and pure model**

Use `playableCharacterSchema.safeParse` as the final canonical boundary. Clone before every transition. Remove only the four prohibited root keys. Generate IDs with `crypto.randomUUID()` by default, retry collisions, then use a deterministic suffix after a bounded retry count. Keep the trusted ID when applying AI output.

- [ ] **Step 6: Verify and commit**

```bash
pnpm vitest run tests/unit/world-library.test.ts tests/unit/web-next-character-workspace-model.test.ts
git add packages/contracts/src/world-library.ts apps/web-next/src/character-workspace-model.ts tests/unit/world-library.test.ts tests/unit/web-next-character-workspace-model.test.ts
git commit -m "Add character workspace model"
```

---

### Task 2: Opaque expiring single-consumer handoff

**Files:**
- Create: `apps/web-next/src/character-workspace-session.ts`
- Test: `tests/unit/web-next-character-workspace-session.test.ts`

**Interfaces:**

```ts
export type CharacterWorkspaceOrigin = "world-creation" | "world-editor";
export type CharacterWorkspaceMode = "create" | "edit";
export interface CharacterWorkspaceSession {
  version: 1; key: string; origin: CharacterWorkspaceOrigin;
  mode: CharacterWorkspaceMode; workflowId: string; parentRoute: string;
  expectedWorldRevision: number | null; parentDraft: EditableWorldDraft;
  worldContext: EditableWorldDraft; rosterSummaries: readonly CharacterSummary[];
  candidate: PlayableCharacter | null; expiresAt: number;
}
export type CharacterWorkspaceResult =
  | { status: "accepted"; candidate: PlayableCharacter }
  | { status: "cancelled" };
export function createCharacterWorkspaceSessionStore(storage: Storage, options?: SessionStoreOptions): CharacterWorkspaceSessionStore;
export function characterWorkspacePath(key: string): string;
export function characterSessionKeyFromPath(pathname: string): string | null;
```

- [ ] **Step 1: Write failing tests**

Cover encoded opaque routes, malformed storage, 30-minute expiry, 512 KiB rejection, safe return tombstones, owner-key stripping, origin/workflow isolation, cancellation, one result, and one consumption.

```ts
expect(characterWorkspacePath("opaque / key")).toBe("/app/characters/opaque%20%2F%20key");
expect(store.complete(session.key, "wrong-workflow", accepted)).toBe(false);
expect(store.complete(session.key, session.workflowId, accepted)).toBe(true);
expect(store.consume(session.key, "world-creation", session.workflowId)).not.toBeNull();
expect(store.consume(session.key, "world-creation", session.workflowId)).toBeNull();
```

- [ ] **Step 2: Run and verify RED**

Run: `pnpm vitest run tests/unit/web-next-character-workspace-session.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement the adapter**

Namespace session, return, and result keys under `iqn:character-workspace:*`. Validate every decoded record. `complete()` requires an existing matching workflow and refuses a second result. `consume()` checks origin and workflow before returning and deleting all records. Store no credentials or authoritative identity.

- [ ] **Step 4: Verify and commit**

```bash
pnpm vitest run tests/unit/web-next-character-workspace-session.test.ts
git add apps/web-next/src/character-workspace-session.ts tests/unit/web-next-character-workspace-session.test.ts
git commit -m "Add character workspace handoff"
```

---

### Task 3: Sanitized preview generation and bounded progress

**Files:**
- Create: `apps/web-next/src/character-workspace-api.ts`
- Modify: `packages/contracts/src/world-library.ts`
- Modify: `services/runtime/src/provider-world-generation-adapter.ts`
- Modify: `services/api/src/server.ts`
- Test: `tests/unit/web-next-character-workspace-api.test.ts`
- Test: `tests/unit/world-library.test.ts`
- Test: `tests/unit/client-api-routes.test.ts`

**Interfaces:**

```ts
export interface CharacterGenerationPreviewRequest {
  content: EditableWorldDraft; prompt: string; characterId?: string; progressKey: string;
}
export async function generateCharacterPreview(request: CharacterGenerationPreviewRequest, signal?: AbortSignal): Promise<{ character: PlayableCharacter }>;
export async function loadCharacterGenerationProgress(progressKey: string, signal?: AbortSignal): Promise<WorldGenerationProgressResponse>;
export function sanitizeCharacterGenerationContent(draft: EditableWorldDraft): EditableWorldDraft;
```

The shared preview request gains optional `progressKey` (1–512 chars).

- [ ] **Step 1: Write failing browser-boundary tests**

Prove the request uses only `/api/v1/worlds/playable-characters/generate-preview`; sends sanitized current content, prompt, trusted edit ID, and unique progress key; strips root owner keys from world and characters; retains safe lore; strictly parses success; classifies provider unavailability; propagates abort; and never calls create/update/publish/campaign/asset routes.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm vitest run tests/unit/web-next-character-workspace-api.test.ts`
Expected: module not found.

- [ ] **Step 3: Add failing server and contract tests**

Assert `progressKey` parses, spoofed identity is rejected/ignored, and the owner-scoped collaborator receives the server-resolved owner plus progress key.

- [ ] **Step 4: Run and verify RED**

Run: `pnpm vitest run tests/unit/world-library.test.ts tests/unit/client-api-routes.test.ts`
Expected: progress contract/composition missing.

- [ ] **Step 5: Implement preview progress and browser boundary**

Reuse world preview progress storage and read route. Record preparing 10%, generating 35%, validating 80%, completed 100%, or failed 100% with safe public copy. Parse the response with the strict schema and canonicalize again in the model. Do not add a persistence endpoint.

- [ ] **Step 6: Verify and commit**

```bash
pnpm vitest run tests/unit/world-library.test.ts tests/unit/client-api-routes.test.ts tests/unit/web-next-character-workspace-api.test.ts
git add packages/contracts/src/world-library.ts services/runtime/src/provider-world-generation-adapter.ts services/api/src/server.ts apps/web-next/src/character-workspace-api.ts tests/unit/world-library.test.ts tests/unit/client-api-routes.test.ts tests/unit/web-next-character-workspace-api.test.ts
git commit -m "Add character preview progress"
```

---

### Task 4: Full-page Character Workspace

**Files:**
- Create: `apps/web-next/src/character-workspace-page.ts`
- Create: `tests/unit/web-next-character-workspace-page.test.ts`
- Modify: `apps/web-next/src/bootstrap.ts`
- Modify intentionally: `apps/web-next/src/styles.css`
- Test: `tests/unit/web-next-theme.test.ts`

**Interfaces:**

```ts
export interface CharacterWorkspacePageDependencies {
  sessionStore?: CharacterWorkspaceSessionStore;
  generateCharacterPreview?: typeof generateCharacterPreview;
  loadGenerationProgress?: typeof loadCharacterGenerationProgress;
  readClipboardText?: () => Promise<string>;
  writeClipboardText?: (value: string) => Promise<void>;
  confirmGeneratedReplacement?: () => boolean;
  navigate?: (path: string) => void;
  generationPollIntervalMs?: number;
}
export function mountCharacterWorkspacePage(root: HTMLElement, sessionKey: string, dependencies?: CharacterWorkspacePageDependencies): MountedPage;
```

- [ ] **Step 1: Write failing page tests**

Cover unavailable/expired sessions, six semantic stages, compact Manual/AI controls, synchronized prompt/dialog, no request while typing, explicit generation, editable generated fields, replacement confirmation at apply time, exact validation focus, bounded progress/cancel/retry/stale isolation, terminal failed progress, clipboard focus/selection, dialog focus trap/Escape, mechanics master-detail, Review facts/links, duplicate-proof acceptance, cancellation, dirty navigation, disposal, and passthrough preservation.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm vitest run tests/unit/web-next-character-workspace-page.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement focused stage renderers and route**

Keep orchestration in the page and use small render functions for each stage. Reuse shared field adapters for mechanics. Keep ID read-only. Resolve `/app/characters/:sessionKey` before world detail routes in `bootstrap.ts`.

- [ ] **Step 4: Write failing design-contract tests**

Assert 48px method controls, 44px actions, 52px compact stages, horizontal compact switcher, stacked fields, two equal ledger actions, full-width bottom dialog, semantic tokens, visible focus, and reduced motion.

- [ ] **Step 5: Implement scoped `.character-*` styles**

Append semantic-token-only rules. No literal theme colors, rounded cards, portraits, ambient shadows, or oversized actions. Preserve current unrelated stylesheet edits.

- [ ] **Step 6: Verify and patch-stage**

```bash
pnpm vitest run tests/unit/web-next-character-workspace-page.test.ts tests/unit/web-next-theme.test.ts
pnpm --filter @infinite-quest/web-next check
git add apps/web-next/src/character-workspace-page.ts apps/web-next/src/bootstrap.ts tests/unit/web-next-character-workspace-page.test.ts tests/unit/web-next-theme.test.ts
git add -p apps/web-next/src/styles.css
git diff --cached --check
git commit -m "Add character creation workspace"
```

---

### Task 5: New World reviewed character roster

**Files:**
- Create: `apps/web-next/src/world-creation-character-roster.ts`
- Modify: `apps/web-next/src/world-creation-model.ts`
- Modify intentionally: `apps/web-next/src/world-creation-page.ts`
- Test: `tests/unit/web-next-world-creation-model.test.ts`
- Test: `tests/unit/web-next-world-creation-page.test.ts`
- Test: `tests/unit/web-next-world-creation-api.test.ts`

**Interfaces:**

```ts
export function appendCreationCharacter(state: WorldCreationState, candidate: unknown): WorldCreationState;
export function replaceCreationCharacter(state: WorldCreationState, characterId: string, candidate: unknown): WorldCreationState;
export function removeCreationCharacter(state: WorldCreationState, characterId: string): WorldCreationState;
export function restoreCreationCharacter(state: WorldCreationState, removalId: string): WorldCreationState;
export function renderWorldCreationCharacterRoster(input: WorldCreationCharacterRosterInput): HTMLElement;
```

- [ ] **Step 1: Replace the empty-roster invariant with failing model/API tests**

Prove only reviewed append/replace transitions add characters; world generation preserves an existing reviewed roster but injects none; duplicate IDs fail; remove/undo is immutable; safe unknown fields survive; owner keys are stripped; shared bounds apply; final create sends exactly the roster.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm vitest run tests/unit/web-next-world-creation-model.test.ts tests/unit/web-next-world-creation-api.test.ts`
Expected: canonicalization still clears characters.

- [ ] **Step 3: Modify canonicalization narrowly**

Preserve reviewed characters generally. In `applyGeneratedPreview`, save the reviewed roster, parse generated non-character fields, and restore that roster. Only append/replace transitions may introduce candidates.

- [ ] **Step 4: Write failing page tests**

Add Characters before Review. Cover optional empty state, Add/Edit handoff, accepted append/replace once, cancel/expiry unchanged, remove/undo, Add another, parent draft restoration, BFCache, and exact final roster submission.

- [ ] **Step 5: Run and verify RED**

Run: `pnpm vitest run tests/unit/web-next-world-creation-page.test.ts`
Expected: Characters stage absent.

- [ ] **Step 6: Implement a thin roster integration**

Delegate roster markup/session creation to the new module. Consume only matching origin/workflow results. Restore `session.parentDraft` before applying the accepted result.

- [ ] **Step 7: Verify and patch-stage**

```bash
pnpm vitest run tests/unit/web-next-world-creation-model.test.ts tests/unit/web-next-world-creation-api.test.ts tests/unit/web-next-world-creation-page.test.ts
git add apps/web-next/src/world-creation-character-roster.ts apps/web-next/src/world-creation-model.ts tests/unit/web-next-world-creation-model.test.ts tests/unit/web-next-world-creation-api.test.ts tests/unit/web-next-world-creation-page.test.ts
git add -p apps/web-next/src/world-creation-page.ts
git diff --cached -- apps/web-next/src/world-library-page.ts
git diff --cached --check
git commit -m "Add characters to new world drafts"
```

The cached World Library diff must be empty.

---

### Task 6: World Editor unsaved-draft integration and final verification

**Files:**
- Create: `apps/web-next/src/world-editor-character-workspace.ts`
- Modify: `apps/web-next/src/world-editor-page.ts`
- Test: `tests/unit/web-next-world-editor-page.test.ts`
- Test: `tests/unit/web-next-character-workspace-session.test.ts`
- Create: `apps/web-next/.impeccable/surfaces/src-character-workspace-page-ts.md`
- Modify: `apps/web-next/DESIGN.md`
- Modify: `apps/web-next/.impeccable/design.json`

**Interfaces:**

```ts
export function beginWorldEditorCharacterSession(input: {
  store: CharacterWorkspaceSessionStore; worldId: string; workflowId: string;
  revision: number; draft: EditableWorldDraft; characterId?: string;
}): CharacterWorkspaceSession;
export function applyWorldEditorCharacterResult(input: {
  draft: EditableWorldDraft; session: CharacterWorkspaceSession; result: CharacterWorkspaceResult;
}): EditableWorldDraft;
```

- [ ] **Step 1: Write failing editor integration tests**

Prove Add/Edit opens the shared route with a clone of current unsaved state; accepted create/replace changes local aggregate once; no save API runs; Save draft remains required and uses expected revision; cancellation, expiry, wrong origin/workflow, duplicate consumption, and disposal change nothing; safe unknown fields survive; existing save-conflict recovery remains intact.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm vitest run tests/unit/web-next-world-editor-page.test.ts`
Expected: no workspace handoff.

- [ ] **Step 3: Implement focused integration**

Snapshot and sanitize the whole current draft. Apply accepted create/replace immutably; cancellation returns the original clone. Wire only Characters Add/Edit actions. Existing collection editing and Save draft remain unchanged.

- [ ] **Step 4: Update durable design artifacts**

Add the Character Workspace component/state rules to DESIGN.md and its JSON sidecar, and create the Operate-mode surface brief. Record compact actions, six stages, local handoff boundary, responsive behavior, accessibility, and reduced motion.

- [ ] **Step 5: Run bounded visual verification**

Use request interception to inspect one desktop/mobile, light/dark batch; make at most one correction batch and one confirmation batch. Verify all six stages, Manual/AI, long fields, Mechanics, Review, expired session, and keyboard focus.

- [ ] **Step 6: Run detector once**

```bash
node C:/Git/InfiniteQuest/.agents/skills/impeccable/scripts/detect.mjs --json apps/web-next/src/character-workspace-page.ts apps/web-next/src/styles.css
```

Document intentional design-system warnings; fix errors introduced by this feature.

- [ ] **Step 7: Run final checks**

```bash
pnpm vitest run tests/unit/world-library.test.ts tests/unit/client-api-routes.test.ts tests/unit/web-next-character-workspace-model.test.ts tests/unit/web-next-character-workspace-session.test.ts tests/unit/web-next-character-workspace-api.test.ts tests/unit/web-next-character-workspace-page.test.ts tests/unit/web-next-world-creation-model.test.ts tests/unit/web-next-world-creation-api.test.ts tests/unit/web-next-world-creation-page.test.ts tests/unit/web-next-world-editor-page.test.ts tests/unit/web-next-theme.test.ts
pnpm --filter @infinite-quest/web-next check
pnpm --filter @infinite-quest/web-next build
node -e "JSON.parse(require('fs').readFileSync('apps/web-next/.impeccable/design.json','utf8'))"
pnpm test
git diff --check
git status --short
```

Report existing platform-specific full-suite failures separately; do not hide them.

- [ ] **Step 8: Commit**

```bash
git add apps/web-next/src/world-editor-character-workspace.ts apps/web-next/src/world-editor-page.ts tests/unit/web-next-world-editor-page.test.ts tests/unit/web-next-character-workspace-session.test.ts apps/web-next/DESIGN.md apps/web-next/.impeccable/design.json apps/web-next/.impeccable/surfaces/src-character-workspace-page-ts.md
git diff --cached --check
git commit -m "Connect character workspace to world drafts"
```
