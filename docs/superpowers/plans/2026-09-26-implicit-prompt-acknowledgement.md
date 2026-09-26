# Implicit Prompt Override Acknowledgement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **The controller ticks each step here as it is verified; this file is the progress record.**

**Goal:** Stop blocking generation, and stop asking users to tick a box, for writer and event-extension prompt overrides. Saving an override acknowledges it implicitly. An override stays usable across prompt-protocol bumps until the local output schema it was saved against actually changes.

**Architecture:** Compatibility is currently keyed to three things: the local output-schema version (`requiredShapeVersion`, currently `story-output-v2`), the prompt-protocol identity (`…|current-continuity-v2|v3`), and the content hash.

The protocol identity changes on every prompt-protocol bump (v13 → v14 → v15 → v16). Each bump invalidated correct overrides. It also caused the 2026-09-25 production 409 and eight per-campaign override copies.

The model can no longer drift from the required shape through an override:

- Strict provider schemas enforce the shape.
- Application-owned contracts are appended after every override (fact-wire, Story Memory, output encoding).
- Local Zod validation rejects anything else.

So this plan changes three things:

- Compatibility keys on the shape version and the content hash only.
- The server writes the acknowledgement itself on save.
- The UI checkbox goes away.

Frozen job snapshots and their hash proofs are unchanged.

**Tech Stack:** TypeScript, Zod, Vitest, PostgreSQL, legacy web UI (`apps/web/public`).

**Spec / decision sources:**
- User decision, 2026-09-26: make the writer-prompt acknowledgement implicit.
- Prior decision being revised: `docs/superpowers/plans/2026-09-05-nexus-prompt-memory-subagent-remediation-spec.md:225` ("explicit compatibility acknowledgement … scoped to the exact content hash and protocol/policy") and `docs/runbooks/story-memory-rollout.md:157-158` ("never automatically acknowledge").
- Context: `docs/review/prompt-system-audit-2026-09-25.md` finding F3; `docs/architecture/0024-central-prompt-library.md`.

## Global Constraints

- Do not change `STORY_PROMPT_SCHEMA_VERSION` (`story-output-v2`), `promptSnapshotSchema`, `legacyPromptTemplateKeys`, or the frozen snapshot proofs (`storyMemoryCompatibility`, `storyPromptCompatibility`). Jobs already queued must behave exactly as before.
- No database migration. The `prompt_template_overrides` columns and their all-or-nothing check constraint stay as they are.
- An override whose `compatibility_required_shape_version` differs from the current `STORY_PROMPT_SCHEMA_VERSION`, or whose stored content hash does not match its content, remains blocked with 409 `prompt_override_incompatible`. So does a row with no acknowledgement metadata at all. The message must tell the user to re-save the override.
- The API request field `compatibilityAcknowledgement` stays optional and accepted for backward compatibility, but the server ignores it and derives the stored acknowledgement itself.
- Two-space indentation, existing naming conventions.
- Test command: `node node_modules/vitest/vitest.mjs run <files> --exclude '**/.worktrees/**' --exclude '**/.codex/**'`.
- Known baseline unit failures (not regressions): `prepared-text-executor` "48000 route reserve" (1), `story-player-ui` (2).
- Integration tests need a disposable PostgreSQL container, because the shared test DB rejects its credentials. Use the procedure in `.superpowers/sdd/2026-09-25-prompt-system-remediation/task-8-report.md`. Never touch the production containers.
- Commits: short imperative subject naming the domain, with a separate `Co-Authored-By` trailer line. Do not push. Run `git diff --check` first.

## File Map

| File | Responsibility | Task |
|---|---|---|
| `packages/database/src/prompt-repository.ts` | Compatibility rule; save-time implicit acknowledgement; library `acknowledged` flag | 1 |
| `tests/unit/prompt-library.test.ts`, `tests/integration/story-memory-enrollment.integration.test.ts`, `tests/integration/prompt-library.integration.test.ts` | Gate behavior tests | 1 |
| `apps/web/public/index.html`, `apps/web/public/nexus.js`, `tests/unit/management-ui.test.ts` | Remove the checkbox; keep the required-shape preview | 2 |
| `docs/architecture/0039-implicit-prompt-override-acknowledgement.md` (new), `docs/architecture/index.md`, `docs/runbooks/story-memory-rollout.md`, `docs/nexus-guide/campaigns/configure.md` | Decision record and user and operator docs | 3 |

---

### Task 1: Shape-keyed compatibility and server-derived acknowledgement

**Files:**
- Modify: `packages/database/src/prompt-repository.ts`: `acknowledgementMatches` / `overrideIsCompatible` (~102-124), both 409 throws in `resolveSnapshot` (~144-158), `listPromptLibrary` `acknowledged` (~431-435), `savePromptOverride` (~458-495)
- Test: `tests/unit/prompt-library.test.ts`, `tests/integration/story-memory-enrollment.integration.test.ts`, `tests/integration/prompt-library.integration.test.ts`

**Interfaces:**
- Produces: `overrideIsCompatible(row, mode)` returns true for keys without a requirement. Otherwise it returns true iff `row.compatibility_required_shape_version === STORY_PROMPT_SCHEMA_VERSION && row.compatibility_content_hash === hash(row.content)`. `mode` no longer affects the result; keep the parameter only if removing it churns callers.
- `savePromptOverride` always stores `{ requiredShapeVersion: STORY_PROMPT_SCHEMA_VERSION, protocolIdentity: storyMemoryPromptCompatibilityRequirement(key).protocolIdentity, contentHash: hash(content) }` for keys with a requirement, and nulls for other keys. It never throws `prompt_override_incompatible`.

- [ ] **Step 1: Write the failing unit tests.** Add to `tests/unit/prompt-library.test.ts`, reusing the file's fake-query style (see the tests near "shows the v14 acknowledgement requirement"):

```ts
describe("implicit prompt override acknowledgement", () => {
  const content = "Custom writer prompt.";
  const contentHash = createHash("sha256").update(content).digest("hex");
  const row = (overrides: Record<string, unknown> = {}) => ({ prompt_key: "story_system", content, campaign_id: null,
    compatibility_required_shape_version: "story-output-v2", compatibility_protocol_identity: "story-v13-current-state-corrections|story-output-v2|current-continuity-v2",
    compatibility_content_hash: contentHash, ...overrides });
  const db = (rows: unknown[], enrolled = true) => ({ query: vi.fn(async (sql: string) => {
    if (sql.includes("FROM campaigns")) return { rows: [{ exists: 1 }] };
    if (sql.includes("campaign_story_memory_enrollments")) return { rows: enrolled ? [{ exists: 1 }] : [] };
    if (sql.includes("prompt_template_overrides")) return { rows };
    return { rows: [] };
  }) });
  const scope = () => ({ ownerUserId: crypto.randomUUID(), scope: "campaign" as const, campaignId: crypto.randomUUID() });

  it("accepts an override acknowledged under an older prompt protocol when the output shape is unchanged", async () => {
    const snapshot = await resolveStoryMemoryPromptSnapshot(db([row()]) as never, scope());
    expect(snapshot.templates.story_system).toMatchObject({ content, source: "application" });
  });

  it("still blocks an override whose stored shape version is not current", async () => {
    await expect(resolveStoryMemoryPromptSnapshot(db([row({ compatibility_required_shape_version: "story-output-v1" })]) as never, scope()))
      .rejects.toMatchObject({ statusCode: 409, code: "prompt_override_incompatible", message: expect.stringMatching(/re-save/i) });
  });

  it("still blocks an override whose content changed after it was acknowledged", async () => {
    await expect(resolveStoryMemoryPromptSnapshot(db([row({ compatibility_content_hash: "0".repeat(64) })]) as never, scope()))
      .rejects.toMatchObject({ statusCode: 409, code: "prompt_override_incompatible" });
  });

  it("blocks an override with no acknowledgement metadata and asks for a re-save", async () => {
    await expect(resolveStoryPromptSnapshot(db([row({ compatibility_required_shape_version: null, compatibility_protocol_identity: null, compatibility_content_hash: null })], false) as never, scope()))
      .rejects.toMatchObject({ statusCode: 409, code: "prompt_override_incompatible", message: expect.stringMatching(/re-save/i) });
  });

  it("stores a server-derived acknowledgement on save without requiring one from the client", async () => {
    const database = db([]);
    const prompts = createPromptRepository(database as never);
    await prompts.savePromptOverride({ ownerUserId: crypto.randomUUID(), scope: "application", key: "story_system", content });
    const insert = database.query.mock.calls.find(([sql]) => String(sql).startsWith("INSERT INTO prompt_template_overrides"))!;
    expect(insert[1].slice(4, 7)).toEqual([STORY_PROMPT_SCHEMA_VERSION, storyMemoryPromptCompatibilityRequirement("story_system")!.protocolIdentity, contentHash]);
  });

  it("ignores a stale client-supplied acknowledgement instead of rejecting the save", async () => {
    const database = db([]);
    const prompts = createPromptRepository(database as never);
    await expect(prompts.savePromptOverride({ ownerUserId: crypto.randomUUID(), scope: "application", key: "story_system", content,
      compatibilityAcknowledgement: { requiredShapeVersion: "story-output-v2", protocolIdentity: "stale|identity", contentHash: "0".repeat(64) } })).resolves.toBeDefined();
  });

  it("stores no acknowledgement for keys without a shape requirement", async () => {
    const database = db([]);
    const prompts = createPromptRepository(database as never);
    await prompts.savePromptOverride({ ownerUserId: crypto.randomUUID(), scope: "application", key: "rpg_assessment", content });
    const insert = database.query.mock.calls.find(([sql]) => String(sql).startsWith("INSERT INTO prompt_template_overrides"))!;
    expect(insert[1].slice(4, 7)).toEqual([null, null, null]);
  });

  it("reports a legacy-identity override as compatible in the library", async () => {
    const prompts = createPromptRepository(db([row()]) as never);
    const library = await prompts.listPromptLibrary({ ownerUserId: crypto.randomUUID(), scope: "application" });
    expect(library.templates.find((template) => template.key === "story_system")?.compatibility?.acknowledged).toBe(true);
  });
});
```

Import `STORY_PROMPT_SCHEMA_VERSION` from `../../packages/contracts/src/story-prompt.js` if it is not already imported.

- [ ] **Step 2: Run to confirm failure.** Run `node node_modules/vitest/vitest.mjs run tests/unit/prompt-library.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'`. Expected: the new legacy-identity, save and message tests FAIL.

- [ ] **Step 3: Implement the rule.** In `prompt-repository.ts`, import `STORY_PROMPT_SCHEMA_VERSION`. Replace `acknowledgementMatches` and `overrideIsCompatible` with:

```ts
/** Compatibility follows the local output shape the override was saved
 * against, not the prompt protocol: strict provider schemas, appended
 * application contracts and local validation own the wire shape, so a
 * protocol bump alone never invalidates a saved creative prompt. */
function overrideIsCompatible(row: OverrideRow): boolean {
  if (!(legacyPromptTemplateKeys as readonly string[]).includes(row.prompt_key)) return true;
  if (!promptCompatibilityRequirement(row.prompt_key as PromptTemplateKey)) return true;
  return row.compatibility_required_shape_version === STORY_PROMPT_SCHEMA_VERSION
    && row.compatibility_content_hash === hash(row.content);
}
```

Update both call sites in `resolveSnapshot`, dropping the `mode` argument. Change both thrown messages to exactly:

```ts
"This saved prompt override was written for an earlier output shape or was edited outside the Prompt Library. Re-save it in the Prompt Library before generation can run."
```

Keep `statusCode: 409` and `code: "prompt_override_incompatible"`.

- [ ] **Step 4: Derive the acknowledgement on save.** In `savePromptOverride`:
  - Remove the `acknowledgementValid` block and its throw.
  - Compute `const requirement = storyMemoryPromptCompatibilityRequirement(value.key as PromptTemplateKey);`.
  - Pass `requirement ? STORY_PROMPT_SCHEMA_VERSION : null`, `requirement?.protocolIdentity ?? null`, and `requirement ? hash(value.content) : null` as the three compatibility parameters.
  - Keep parsing `compatibilityAcknowledgement` through `promptTemplateOverrideSchema` so malformed input still fails validation, but do not use its values.

- [ ] **Step 5: Library flag.** In `listPromptLibrary`, compute `acknowledged` as `frozen.source === "shipped" || (override !== undefined && overrideIsCompatible(override))`, where `override` is the row that supplied the effective content.

- [ ] **Step 6: Update existing tests that encode the old rule.** Find them with `grep -n "prompt_override_incompatible\|acknowledg" tests/unit/prompt-library.test.ts tests/integration/story-memory-enrollment.integration.test.ts tests/integration/prompt-library.integration.test.ts tests/helpers/provider-application-fixtures.ts`. For each one:
  - A test that expects a 409 for a protocol-identity mismatch now expects success.
  - A test that expects a 409 on save for a missing or stale client acknowledgement now expects success, and the stored values to be server-derived.
  - Keep, or add, one test for each remaining block: a shape-version mismatch, a content-hash mismatch, and missing metadata.
  - List every changed test and the reason in the report.

- [ ] **Step 7: Run the unit and integration suites.** Run `node node_modules/vitest/vitest.mjs run tests/unit/prompt-library.test.ts tests/unit/story-memory-settings.test.ts --exclude '**/.worktrees/**' --exclude '**/.codex/**'`. Expected: PASS. Then run the two integration files against a disposable container. Expected: PASS.

- [ ] **Step 8: Commit.** Commit with subject `Prompt library: acknowledge overrides implicitly by output shape`.

---

### Task 2: Remove the acknowledgement checkbox from the Prompt Library UI

**Files:**
- Modify: `apps/web/public/index.html:513` (the `promptLibraryCompatibility` label with the checkbox)
- Modify: `apps/web/public/nexus.js`: `syncPromptLibraryAcknowledgement` (~1352-1357) and its call (~1460), the compatibility copy (~1463-1469), the save path (~1505-1513), and `elements` registrations of `promptLibraryCompatibilityAcknowledgement`
- Test: `tests/unit/management-ui.test.ts`

**Interfaces:** The UI stops sending `compatibilityAcknowledgement`. The server ignores it (Task 1).

- [ ] **Step 1: Write the failing UI test.** In `tests/unit/management-ui.test.ts`, following the file's existing pattern of reading `index.html` and `nexus.js` as strings, add:

```ts
it("saves prompt overrides without a compatibility checkbox", () => {
  expect(managementHtml).not.toContain("promptLibraryCompatibilityAcknowledgement");
  expect(managementHtml).not.toContain("I acknowledge this exact prompt must produce the required shape.");
  expect(managementScript).not.toContain("Acknowledge the required output shape before saving this prompt.");
  expect(managementScript).not.toContain("compatibilityAcknowledgement");
  expect(managementHtml).toContain("promptLibraryRequiredShape");
});
```

Use the variable names the file already uses for the HTML and script sources.

- [ ] **Step 2: Run to confirm failure.**

- [ ] **Step 3: Implement.**
  - In `index.html`, keep the `promptLibraryCompatibility` element and its `promptLibraryCompatibilityCopy` span, but remove the checkbox `<span>`/`<input>` and its sentence.
  - In `nexus.js`, delete `syncPromptLibraryAcknowledgement` and its call, and remove the element from the elements list.
  - Replace the save path's `compatibilityAcknowledgement` construction and its spread in the PUT body with nothing.
  - Change the copy to ``Required output shape version ${compatibility.requiredShapeVersion}. Saving records this prompt against the current shape; the application adds the required output rules automatically.``
  - Keep the required-shape preview.
  - Minimal edits in the file's existing style. Do not rewrite line endings.

- [ ] **Step 4: Run the tests and checks.** Run `tests/unit/management-ui.test.ts` and `node --check apps/web/public/nexus.js`. Expected: PASS.

- [ ] **Step 5: Commit.** Commit with subject `Legacy admin UI: save prompt overrides without an acknowledgement checkbox`.

---

### Task 3: Record the decision and update operator and user docs

**Files:**
- Create: `docs/architecture/0039-implicit-prompt-override-acknowledgement.md`
- Modify: `docs/architecture/index.md` (list entry), `docs/runbooks/story-memory-rollout.md:157-158`, `docs/nexus-guide/campaigns/configure.md:60-66`

- [ ] **Step 1: Write the ADR,** in the same style as `0024-central-prompt-library.md`:

```markdown
# ADR 0039: Implicit Prompt Override Acknowledgement

## Status

Accepted 2026-09-26. Revises the explicit-acknowledgement rule in the 2026-09-05 prompt-memory remediation spec (§ overrides) and ADR 0024's override handling.

## Context

Writer (`story_system`) and event-extension overrides were gated by an operator acknowledgement bound to the exact content hash *and* the prompt-protocol identity. Every protocol bump (v13 → v16) invalidated correct overrides and blocked generation with HTTP 409, which led to per-campaign copies that froze old prompt text. Output shape is now enforced independently of creative text: strict provider JSON schemas, application-owned contracts appended after every override, and local schema validation.

## Decision

Saving an override records its acknowledgement automatically against the current local output schema (`STORY_PROMPT_SCHEMA_VERSION`). Compatibility at enqueue requires only that the stored shape version equals the current one and that the stored content hash matches the content. Prompt-protocol changes no longer invalidate saved overrides. Frozen job snapshots and their hash proofs are unchanged.

## Consequences

An override saved against an earlier output schema, edited outside the Prompt Library, or saved before acknowledgements existed still returns 409 until re-saved. Routes without strict provider schemas (for example LM Studio or JSON-object mode) rely on the appended contracts and local validation; a creative override that describes an obsolete shape there yields rejected turns rather than a pre-dispatch block.
```

- [ ] **Step 2: Update the runbook.** In `story-memory-rollout.md`, replace the sentence "Existing custom creative prompt overrides retain their bytes and still require v14 compatibility acknowledgement in the Prompt Library; never automatically acknowledge or rewrite them." with "Existing custom creative prompt overrides retain their bytes. They remain usable across prompt-protocol changes while the output shape version is unchanged (ADR 0039); never rewrite them automatically."

- [ ] **Step 3: Update the user guide.** In `configure.md`, replace the acknowledgement notes at lines ~60-66 with: "Saving a writer or event-extension prompt records it against the current output shape automatically. You only need to re-save a prompt if the Prompt Library marks it as written for an earlier output shape."

- [ ] **Step 4: Index entry.** Add ADR 0039 to `docs/architecture/index.md`, following its existing format.

- [ ] **Step 5: Check links and diff.** Run `git diff --check`, and verify that every relative link in the changed docs resolves.

- [ ] **Step 6: Commit.** Commit with subject `Docs: record implicit prompt override acknowledgement`.

---

### Task 4: Verify and record progress

- [ ] **Step 1: Full checks.** Run `pnpm check` and the full `tests/unit`. The only failures may be the known baseline.
- [ ] **Step 2: Whole-change review.** Run a whole-change review (controller-dispatched), and fix any findings.
- [ ] **Step 3: Update the remediation records.** Update `docs/review/prompt-system-audit-2026-09-25.md` recommendation R4/R5 status and the remediation plan's Task 11 note. The app-wide override no longer needs re-acknowledgement, so override consolidation is optional. Commit with subject `Docs: note implicit acknowledgement in the prompt audit follow-ups`.

## Rollout notes

- Deploy together with the remediation branch. The API and worker share one image.
- After deploy, the production application override (acknowledged under the legacy identity, shape `story-output-v2`, hash matching) becomes effective for every campaign without a campaign copy. No data changes are needed.
- Rollback: the previous image reinstates the protocol-keyed gate. Rows saved after deploy carry the Story Memory identity, which the old code accepts for enrolled campaigns. Rows saved before deploy are unchanged.

## Progress log

(The controller appends one line per completed task: date, commits, review outcome.)
