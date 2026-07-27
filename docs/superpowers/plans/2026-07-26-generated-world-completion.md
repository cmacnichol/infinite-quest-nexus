# Generated World Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make provider-generated worlds satisfy one explicit completion contract before preview or persistence, recover incomplete character rosters predictably, and return safe diagnostics when generation cannot be repaired.

**Architecture:** Add a pure generated-world completion contract in the domain package and make `generateTemplateWorld` the single gate that returns complete generated content or a typed safe error. Keep provider conversion permissive enough to normalize common model output, but retain only complete characters and use one bounded roster-supplement request to replace missing or incomplete entries. Both manual generation preview and CYOA auto-import consume the same validated result; source-faithful portable and Infinite Worlds imports keep their existing import-specific rules.

**Tech Stack:** Node.js 22.13+, TypeScript 7, Zod 4, Fastify 5, PostgreSQL, Vitest 4, vanilla JavaScript, OpenAI-compatible text-provider APIs

## Global Constraints

- Use **Infinite Quest Nexus** for the platform and **Infinite Quest** for the player-facing story experience.
- Generated worlds require three or four distinct playable characters.
- Every generated playable character requires both non-empty `characterText` and a structured `profile`.
- Provider output is untrusted and becomes usable only after normalization, canonicalization, and the generated-world completion gate.
- The manual preview and CYOA auto-import paths must apply the same generated-world completion contract.
- Portable world and Infinite Worlds source imports retain their source-specific character-count and fidelity rules; do not force the generated-world three-to-four-character rule onto them.
- Do not persist a world, world version, draft, or import record when generated content fails the completion gate.
- Recovery is bounded to the existing full-world recovery plus at most one roster-supplement request.
- Never log or return raw provider output, prompt bodies, private reasoning, credentials, or story/lore bodies in validation diagnostics.
- Keep application-owned character IDs and source metadata; never trust provider-supplied ownership or identity data.
- Use two-space indentation and TypeScript for new shared logic.
- Every behavioral change requires a failing test before implementation.
- Run `git diff --check` and review the complete staged diff before every commit.

---

## File and interface map

### New files

- `packages/domain/src/generated-world.ts` — pure completion schema and safe issue projection for generated `WorldContent`.
- `tests/unit/generated-world.test.ts` — completion-contract, prompt-contract, normalization, and issue-redaction tests.
- `tests/integration/world-generation.integration.test.ts` — deterministic provider tests for preview recovery, CYOA persistence parity, and failed-generation rollback.
- `docs/architecture/0027-generated-world-completion-contract.md` — records why generated content has a stricter gate than source-faithful imports.

### Modified files

- `packages/contracts/src/prompt-library.ts` — aligns shipped world-generation, recovery, and roster-supplement prompts with the completion contract.
- `packages/domain/src/world-template.ts` — aligns the direct fallback prompt used outside the prompt-library service.
- `services/api/src/world-generator-service.ts` — applies staged roster repair, removes incomplete fallback characters, validates before returning, and emits typed safe errors.
- `services/api/src/infinite-worlds-import-service.ts` — preserves CYOA progress semantics while relying on the shared generation gate before import.
- `apps/web/public/nexus.js` — renders safe missing-field diagnostics for generation failures.
- `tests/unit/prompt-library.test.ts` — verifies the effective prompt contract and recovery requirements.
- `tests/unit/management-ui.test.ts` — verifies client rendering of generated-world issue details.
- `tests/integration/cyoa-import.integration.test.ts` — updates the successful mock response to include complete structured profiles.

### Core interfaces

```ts
export type GeneratedWorldIssue = {
  path: string;
  code: string;
  message: string;
};

export const generatedWorldContentSchema: z.ZodType<WorldContent>;

export function parseCompleteGeneratedWorld(content: unknown): WorldContent;

export function generatedWorldIssues(error: unknown): GeneratedWorldIssue[];
```

`generateTemplateWorld(...)` remains the shared asynchronous orchestration function. Its postcondition changes from “returns canonical `WorldContent`” to “returns `WorldContent` accepted by `parseCompleteGeneratedWorld`.”

The safe HTTP error shape is:

```ts
{
  statusCode: 502,
  expose: true,
  details: {
    code: "incomplete_generated_world",
    issues: GeneratedWorldIssue[]
  }
}
```

---

### Task 1: Generated-world completion contract

**Files:**
- Create: `packages/domain/src/generated-world.ts`
- Create: `tests/unit/generated-world.test.ts`
- Modify: `services/api/src/world-generator-service.ts`

**Interfaces:**
- Produces: `generatedWorldContentSchema`
- Produces: `parseCompleteGeneratedWorld(content: unknown): WorldContent`
- Produces: `generatedWorldIssues(error: unknown): GeneratedWorldIssue[]`
- Consumed by: Tasks 2–4.

- [ ] **Step 1: Write failing completion-contract tests**

Create `tests/unit/generated-world.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  generatedWorldIssues,
  parseCompleteGeneratedWorld
} from "../../packages/domain/src/generated-world.js";

function profile() {
  return {
    identity: { aliases: [], pronouns: "they/them" },
    story: {
      role: "Explorer",
      background: "Raised among moving roads.",
      personality: "Careful and curious.",
      motivations: "Map the impossible.",
      goals: "Find the vanished road.",
      fearsAndConflicts: "Fears becoming lost.",
      keyRelationships: "Trusts the lantern keeper.",
      narrativeHooks: "Carries an unfinished map.",
      voiceAndMannerisms: "Speaks precisely.",
      otherGuidance: ""
    },
    appearance: {
      ancestryOrSpecies: "Human",
      apparentAge: "Adult",
      genderPresentation: "",
      build: "Lean",
      skinOrComplexion: "",
      face: "",
      eyes: "Brown",
      hair: "Black",
      distinguishingFeatures: ["Ink-stained hands"],
      clothing: "Weathered blue coat",
      equipmentAndAccessories: "Brass compass",
      otherVisualDetails: ""
    },
    unclassifiedNotes: ""
  };
}

function completeWorld() {
  return {
    world: {
      title: "The Moving Roads",
      genre: "Weird fantasy",
      tone: "Hopeful",
      premise: "Roads rearrange beneath moonlight.",
      backgroundStory: "Cartographers once governed the coast.",
      firstAction: "A forbidden road appears outside the city.",
      rules: "Every road remembers its maker."
    },
    playableCharacters: [1, 2, 3].map((number) => ({
      id: `character-${number}`,
      name: `Character ${number}`,
      characterText: `Complete narrative guidance for character ${number}.`,
      profile: profile(),
      rpgStats: [],
      defaultTriggers: [],
      source: {}
    }))
  };
}

describe("generated world completion", () => {
  it("accepts a complete world with three structured characters", () => {
    expect(parseCompleteGeneratedWorld(completeWorld()).playableCharacters).toHaveLength(3);
  });

  it("rejects an empty characterText even when profile is complete", () => {
    const content = completeWorld();
    content.playableCharacters[1]!.characterText = "";
    expect(() => parseCompleteGeneratedWorld(content)).toThrow();
  });

  it("rejects a missing profile even when characterText is complete", () => {
    const content = completeWorld();
    delete (content.playableCharacters[1] as { profile?: unknown }).profile;
    expect(() => parseCompleteGeneratedWorld(content)).toThrow();
  });

  it("rejects missing world fields and character counts outside three to four", () => {
    const content = completeWorld();
    content.world.rules = "";
    content.playableCharacters = content.playableCharacters.slice(0, 2);
    expect(() => parseCompleteGeneratedWorld(content)).toThrow();
  });

  it("projects only safe issue paths, codes, and static messages", () => {
    const marker = "PRIVATE_LORE_MARKER";
    const content = completeWorld();
    content.playableCharacters[0]!.characterText = marker.repeat(100_000);
    let thrown: unknown;
    try {
      parseCompleteGeneratedWorld(content);
    } catch (error) {
      thrown = error;
    }
    const issues = generatedWorldIssues(thrown);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toEqual(expect.objectContaining({
      path: expect.any(String),
      code: expect.any(String),
      message: expect.any(String)
    }));
    expect(JSON.stringify(issues)).not.toContain(marker);
  });
});
```

- [ ] **Step 2: Run the focused test and verify the module is missing**

Run:

```powershell
pnpm exec vitest run tests/unit/generated-world.test.ts
```

Expected: FAIL because `packages/domain/src/generated-world.ts` does not exist.

- [ ] **Step 3: Implement the pure completion schema**

Create `packages/domain/src/generated-world.ts`:

```ts
import { z } from "zod";
import {
  worldContentSchema,
  type WorldContent
} from "../../contracts/src/world-library.js";

export type GeneratedWorldIssue = {
  path: string;
  code: string;
  message: string;
};

const generatedWorldBaseSchema = worldContentSchema.superRefine((content, context) => {
  const requiredWorldFields = [
    ["title", "Generated title is required."],
    ["genre", "Generated genre is required."],
    ["tone", "Generated tone is required."],
    ["premise", "Generated premise is required."],
    ["backgroundStory", "Generated background and canon are required."],
    ["firstAction", "Generated opening action is required."],
    ["rules", "Generated rules are required."]
  ] as const;

  for (const [field, message] of requiredWorldFields) {
    if (!String(content.world[field] || "").trim()) {
      context.addIssue({ code: "custom", path: ["world", field], message });
    }
  }

  if (content.playableCharacters.length < 3 || content.playableCharacters.length > 4) {
    context.addIssue({
      code: "custom",
      path: ["playableCharacters"],
      message: "Generated worlds require three or four playable characters."
    });
  }

  content.playableCharacters.forEach((character, index) => {
    if (!character.characterText.trim()) {
      context.addIssue({
        code: "custom",
        path: ["playableCharacters", index, "characterText"],
        message: "Generated character guidance is required."
      });
    }
    if (!character.profile) {
      context.addIssue({
        code: "custom",
        path: ["playableCharacters", index, "profile"],
        message: "Generated structured character profile is required."
      });
    }
  });
});

export const generatedWorldContentSchema: z.ZodType<WorldContent> = generatedWorldBaseSchema;

export function parseCompleteGeneratedWorld(content: unknown): WorldContent {
  return generatedWorldContentSchema.parse(content);
}

export function generatedWorldIssues(error: unknown): GeneratedWorldIssue[] {
  if (!(error instanceof z.ZodError)) return [];
  return error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.map(String).join("."),
    code: issue.code,
    message: issue.message
  }));
}
```

Move the existing `completeGeneratedWorldSchema` rules out of `world-generator-service.ts`; do not leave two competing completion schemas.

- [ ] **Step 4: Run the contract tests**

Run:

```powershell
pnpm exec vitest run tests/unit/generated-world.test.ts tests/unit/world-library.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the shared contract**

```powershell
git add packages/domain/src/generated-world.ts services/api/src/world-generator-service.ts tests/unit/generated-world.test.ts
git diff --cached --check
git commit -m "Define generated world completion contract"
```

---

### Task 2: Prompt alignment and bounded roster repair

**Files:**
- Modify: `packages/contracts/src/prompt-library.ts`
- Modify: `packages/domain/src/world-template.ts`
- Modify: `services/api/src/world-generator-service.ts`
- Modify: `tests/unit/generated-world.test.ts`
- Modify: `tests/unit/prompt-library.test.ts`

**Interfaces:**
- Consumes: `parseCompleteGeneratedWorld` and `generatedWorldIssues` from Task 1.
- Produces: `completeConvertedPlayableCharacterSchema` inside `world-generator-service.ts`.
- Produces: a strengthened `generateTemplateWorld(...)` postcondition: only complete generated worlds are returned.
- Consumed by: manual preview and CYOA import without separate validators.

- [ ] **Step 1: Add failing prompt and roster-classification tests**

Extend `tests/unit/prompt-library.test.ts`:

```ts
it("requires both narrative guidance and a structured profile for generated characters", () => {
  const generation = PROMPT_TEMPLATE_CATALOG.world_generation.defaultContent;
  const recovery = PROMPT_TEMPLATE_CATALOG.world_generation_recovery.defaultContent;
  const supplement = PROMPT_TEMPLATE_CATALOG.world_roster_supplement.defaultContent;

  for (const prompt of [generation, recovery, supplement]) {
    expect(prompt).toContain("character_text");
    expect(prompt).toContain("profile");
  }
  expect(generation).toContain("character_text must be non-empty");
  expect(generation).not.toContain("may be empty when profile is complete");
  expect(recovery).toContain("complete replacement");
});
```

Export a pure helper from `world-generator-service.ts` and test it in `tests/unit/generated-world.test.ts`:

```ts
import { selectCompleteGeneratedCharacters } from "../../services/api/src/world-generator-service.js";

it("retains complete characters and replaces incomplete entries", () => {
  const candidates = [
    { id: "complete", name: "Complete", character_text: "Guidance", profile: profile(), rpg_statistics: [], default_triggers: [] },
    { id: "no-profile", name: "No Profile", character_text: "Guidance", rpg_statistics: [], default_triggers: [] },
    { id: "no-guidance", name: "No Guidance", character_text: "", profile: profile(), rpg_statistics: [], default_triggers: [] }
  ];
  const selected = selectCompleteGeneratedCharacters(candidates);
  expect(selected.characters.map((character) => character.id)).toEqual(["complete"]);
  expect(selected.needed).toBe(2);
});
```

- [ ] **Step 2: Run the focused tests and verify the contradiction and missing helper**

Run:

```powershell
pnpm exec vitest run tests/unit/generated-world.test.ts tests/unit/prompt-library.test.ts
```

Expected: FAIL because the shipped prompt permits empty `character_text` and `selectCompleteGeneratedCharacters` does not exist.

- [ ] **Step 3: Align all three world-generation prompts**

Update `PROMPT_TEMPLATE_CATALOG` and the fallback prompt in `buildTemplateWorldPrompt` so they state:

```text
Return exactly 3 or 4 distinct playable characters.
Every playable character must include:
- id
- name
- character_text; it must be non-empty narrative guidance
- profile with identity, story, appearance, and unclassifiedNotes
- rpg_statistics
- default_triggers
Leave unknown profile subfields empty, but include the profile object.
Keep prose compact enough to close the JSON object.
```

The recovery prompt must request a full replacement, not a continuation or patch, and repeat the non-empty `character_text` plus required `profile` requirements.

The roster-supplement prompt must require exactly `{{needed}}` complete replacement characters. It must say that each entry needs non-empty `character_text` and `profile`, and that incomplete existing entries are not part of the retained roster.

- [ ] **Step 4: Implement complete-character selection**

In `world-generator-service.ts`, add:

```ts
const completeConvertedPlayableCharacterSchema = convertedPlayableCharacterSchema.superRefine((character, context) => {
  if (!character.character_text.trim()) {
    context.addIssue({ code: "custom", path: ["character_text"], message: "Generated character guidance is required." });
  }
  if (!character.profile) {
    context.addIssue({ code: "custom", path: ["profile"], message: "Generated structured character profile is required." });
  }
});

export function selectCompleteGeneratedCharacters(
  candidates: z.infer<typeof convertedPlayableCharacterSchema>[]
) {
  const characters = candidates.flatMap((candidate) => {
    const parsed = completeConvertedPlayableCharacterSchema.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  }).slice(0, 4);
  return {
    characters,
    needed: Math.max(0, 3 - characters.length)
  };
}
```

After the world-level JSON is parsed:

1. Build candidates from `playable_characters` or the legacy `player_character`.
2. Retain only complete candidates.
3. When fewer than three remain, request exactly the missing number from `world_roster_supplement`.
4. Parse the supplement with `completeConvertedPlayableCharacterSchema` and `z.array(...).length(needed)`.
5. Remove the `Character Option N` while-loop fallback. Generic characters without profiles must never be fabricated and returned as complete.
6. Limit the final roster to four entries.

- [ ] **Step 5: Put the completion gate inside `generateTemplateWorld`**

After canonicalization, run:

```ts
const content = parseCompleteGeneratedWorld(canonicalizeWorldContent({
  // existing generated world mapping
}));
```

Return that `content`. Remove the duplicate completion parse from `generateWorldPreview`; preview should trust the strengthened `generateTemplateWorld` postcondition.

If world recovery, roster supplementation, or final completion fails with a Zod or JSON syntax error, throw the typed safe error described in Task 4. Do not turn provider HTTP/transport errors into an incomplete-world error.

- [ ] **Step 6: Run focused generation and prompt tests**

Run:

```powershell
pnpm exec vitest run tests/unit/generated-world.test.ts tests/unit/prompt-library.test.ts tests/unit/world-library.test.ts
pnpm check
```

Expected: PASS.

- [ ] **Step 7: Commit prompt and generation orchestration**

```powershell
git add packages/contracts/src/prompt-library.ts packages/domain/src/world-template.ts services/api/src/world-generator-service.ts tests/unit/generated-world.test.ts tests/unit/prompt-library.test.ts
git diff --cached --check
git commit -m "Repair incomplete generated world rosters"
```

---

### Task 3: Preview and CYOA persistence parity

**Files:**
- Create: `tests/integration/world-generation.integration.test.ts`
- Modify: `tests/integration/cyoa-import.integration.test.ts`
- Modify: `services/api/src/infinite-worlds-import-service.ts`

**Interfaces:**
- Consumes: strengthened `generateTemplateWorld(...)` from Task 2.
- Produces: no new production API.
- Guarantees: CYOA import cannot call `importWorld` until generated content passes the same completion contract used by preview.

- [ ] **Step 1: Make the successful CYOA fixture complete**

Update each character returned by `validConvertedWorldJson()` in `tests/integration/cyoa-import.integration.test.ts` with a structured `profile`. Keep `character_text` non-empty. Add assertions after import:

```ts
const stored = await pool.query<{ content: { playableCharacters: Array<{ characterText: string; profile?: unknown }> } }>(
  "SELECT content FROM world_versions WHERE id = $1",
  [result.worldVersionId]
);
expect(stored.rows[0]?.content.playableCharacters).toHaveLength(3);
expect(stored.rows[0]?.content.playableCharacters.every(
  (character) => character.characterText.trim() && character.profile
)).toBe(true);
```

- [ ] **Step 2: Write a failing no-persistence integration test**

Create `tests/integration/world-generation.integration.test.ts` with a local mock compatible-provider server that returns:

1. A world object whose three characters omit `profile`.
2. A roster-supplement object whose entries also omit `profile`.

Call `importInfiniteWorlds(...)` with a CYOA fixture, then assert:

```ts
await expect(importInfiniteWorlds(
  pool,
  request,
  credentialSecret
)).rejects.toMatchObject({
  statusCode: 502,
  details: { code: "incomplete_generated_world" }
});

const worldsAfter = await pool.query<{ count: number }>(
  "SELECT count(*)::int AS count FROM worlds WHERE owner_user_id = $1",
  [ownerUserId]
);
const importsAfter = await pool.query<{ count: number }>(
  "SELECT count(*)::int AS count FROM imports WHERE owner_user_id = $1 AND source_name = $2",
  [ownerUserId, request.sourceName]
);
expect(worldsAfter.rows[0]?.count).toBe(worldsBefore);
expect(importsAfter.rows[0]?.count).toBe(0);
expect(getImportProgress(progressKey)).toMatchObject({
  status: "failed",
  phase: "failed"
});
```

Add a second provider response sequence where the initial world omits profiles but the supplement returns exactly three complete characters. Assert that preview/import succeeds and the stored version contains all three profiles.

- [ ] **Step 3: Run the integration tests and confirm incomplete CYOA content is currently persisted**

Run with `TEST_DATABASE_URL` set:

```powershell
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/world-generation.integration.test.ts tests/integration/cyoa-import.integration.test.ts
```

Expected before Task 2 integration: FAIL because CYOA import can persist the profile-less mock world.

- [ ] **Step 4: Keep the import boundary simple**

In `infinite-worlds-import-service.ts`, retain this order:

```ts
const generated = await generateTemplateWorld(/* existing arguments */);
const worldExport = portableWorldSchema.parse({
  format: "infinite-quest-world",
  formatVersion: 1,
  title: generated.title,
  content: generated.content
});
const result = await importWorld(pool, { sourceName: request.sourceName, worldExport });
```

Do not add another generated-world validator here. The test proves that `generateTemplateWorld` is the sole completion gate and that no persistence occurs before it returns.

Keep failed progress reporting, but use the safe public error message from Task 4 rather than serializing Zod internals or provider output.

- [ ] **Step 5: Run CYOA and World Library integration coverage**

Run with `TEST_DATABASE_URL` set:

```powershell
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/world-generation.integration.test.ts tests/integration/cyoa-import.integration.test.ts tests/integration/world-library.integration.test.ts
```

Expected: PASS with the database-backed tests executed, not skipped.

- [ ] **Step 6: Commit persistence parity**

```powershell
git add services/api/src/infinite-worlds-import-service.ts tests/integration/world-generation.integration.test.ts tests/integration/cyoa-import.integration.test.ts
git diff --cached --check
git commit -m "Gate generated worlds before import"
```

---

### Task 4: Safe diagnostics and actionable UI errors

**Files:**
- Modify: `services/api/src/world-generator-service.ts`
- Modify: `services/api/src/infinite-worlds-import-service.ts`
- Modify: `apps/web/public/nexus.js`
- Modify: `tests/unit/generated-world.test.ts`
- Modify: `tests/unit/management-ui.test.ts`
- Modify: `tests/unit/server-security.test.ts`

**Interfaces:**
- Consumes: `generatedWorldIssues(error)` from Task 1.
- Produces: `incompleteGeneratedWorldError(error?: unknown): Error`
- Produces: `worldGenerationFailureMessage(error): string` in the management client.

- [ ] **Step 1: Write failing typed-error and UI-formatting tests**

Add to `tests/unit/generated-world.test.ts`:

```ts
import { incompleteGeneratedWorldError } from "../../services/api/src/world-generator-service.js";

it("exposes safe structured issues without provider content", () => {
  let validationError: unknown;
  try {
    parseCompleteGeneratedWorld({
      world: { title: "PRIVATE_TITLE" },
      playableCharacters: []
    });
  } catch (error) {
    validationError = error;
  }
  const failure = incompleteGeneratedWorldError(validationError) as Error & {
    statusCode: number;
    expose: boolean;
    details: { code: string; issues: Array<{ path: string }> };
  };
  expect(failure).toMatchObject({
    statusCode: 502,
    expose: true,
    details: { code: "incomplete_generated_world" }
  });
  expect(failure.details.issues.some((issue) => issue.path === "world.genre")).toBe(true);
  expect(JSON.stringify(failure.details)).not.toContain("PRIVATE_TITLE");
});
```

Add static UI expectations to `tests/unit/management-ui.test.ts`:

```ts
expect(managementScript).toContain("function worldGenerationFailureMessage(error)");
expect(managementScript).toContain('error.details?.code === "incomplete_generated_world"');
expect(managementScript).toContain("error.details?.issues");
```

Extend the server error-envelope test to assert that an exposed generated-world error returns `details.code` and safe `details.issues`, while raw provider content does not appear.

- [ ] **Step 2: Run focused tests and verify diagnostics remain generic**

Run:

```powershell
pnpm exec vitest run tests/unit/generated-world.test.ts tests/unit/management-ui.test.ts tests/unit/server-security.test.ts
```

Expected: FAIL because the typed helper and UI formatter do not exist.

- [ ] **Step 3: Implement one safe error constructor**

In `world-generator-service.ts`:

```ts
export function incompleteGeneratedWorldError(error?: unknown): Error {
  const issues = generatedWorldIssues(error);
  return Object.assign(
    new Error("The text provider did not return a complete world. Review the missing fields and try again."),
    {
      statusCode: 502,
      expose: true,
      details: {
        code: "incomplete_generated_world",
        issues
      }
    }
  );
}
```

Use it for JSON syntax and generated-world Zod failures. Keep provider status, timeout, and network errors unchanged.

Log only:

```ts
logger.error({
  progressKey,
  responseId,
  finishReason,
  outputLimited,
  issues: generatedWorldIssues(error)
}, "Generated world validation failed");
```

Do not log `result.content`, the prompt, the request prompt body, parsed world objects, or character/world text.

- [ ] **Step 4: Render concise issue summaries in the management UI**

Add:

```js
function worldGenerationFailureMessage(error) {
  if (error?.details?.code !== "incomplete_generated_world") {
    return error?.message || String(error);
  }
  const issues = Array.isArray(error.details?.issues) ? error.details.issues : [];
  const missing = issues
    .slice(0, 4)
    .map((issue) => `${issue.path || "generated world"}: ${issue.message}`)
    .join(" ");
  return missing ? `${error.message} ${missing}` : error.message;
}
```

Use it in both `generateWorldFromPrompt()` and the CYOA import error display. Preserve the correlation ID already appended by the API envelope.

For durable progress records, store the same safe generic message and projected issue summary; never store provider output or lore bodies.

- [ ] **Step 5: Run diagnostics and UI tests**

Run:

```powershell
pnpm exec vitest run tests/unit/generated-world.test.ts tests/unit/management-ui.test.ts tests/unit/server-security.test.ts
node --check apps/web/public/nexus.js
```

Expected: PASS.

- [ ] **Step 6: Commit diagnostics**

```powershell
git add services/api/src/world-generator-service.ts services/api/src/infinite-worlds-import-service.ts apps/web/public/nexus.js tests/unit/generated-world.test.ts tests/unit/management-ui.test.ts tests/unit/server-security.test.ts
git diff --cached --check
git commit -m "Report generated world validation issues"
```

---

### Task 5: Architecture record and complete verification

**Files:**
- Create: `docs/architecture/0027-generated-world-completion-contract.md`
- Modify only files required to correct failures discovered by the verification commands.

**Interfaces:**
- Consumes: completed Tasks 1–4.
- Produces: documented and verified generated-world workflow ready for review.

- [ ] **Step 1: Write the architecture record**

Document these decisions:

- Generated world creation is stricter than source-faithful imports.
- Both `characterText` and `profile` are required for generated characters because current campaign readiness and structured profile consumers need them.
- Provider output is normalized permissively, but incomplete characters are discarded and replaced through one bounded supplement request.
- `generateTemplateWorld` is the sole completion gate shared by preview and CYOA auto-import.
- Generic placeholder characters are forbidden.
- Generated content is never persisted before the completion gate returns.
- Safe diagnostics contain paths, codes, and static messages only.
- Portable and Infinite Worlds imports retain every source character and are not forced to synthesize three or four characters.

- [ ] **Step 2: Run repository, unit, and build validation**

```powershell
pnpm check
pnpm test:unit
pnpm build
```

Expected: PASS with no skipped unit tests.

- [ ] **Step 3: Run PostgreSQL integration validation**

With `TEST_DATABASE_URL` pointing to a disposable compatible PostgreSQL database:

```powershell
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/world-generation.integration.test.ts tests/integration/cyoa-import.integration.test.ts tests/integration/world-library.integration.test.ts
pnpm test:integration
```

Expected: PASS with database-backed tests executed. A skipped suite because `TEST_DATABASE_URL` is absent is not successful integration validation.

- [ ] **Step 4: Review prompt and persistence invariants**

```powershell
rg -n "may be empty when profile is complete|Character Option [0-9]" packages services tests
rg -n "parseCompleteGeneratedWorld|incomplete_generated_world" services packages tests
rg -n "result\\.content|request\\.prompt|sourceText" services/api/src/world-generator-service.ts
git diff --check
git status --short
```

Expected:

- no prompt permits empty generated character guidance;
- no generic fallback character remains;
- the completion gate is called inside `generateTemplateWorld`;
- preview and CYOA import both flow through `generateTemplateWorld`;
- no new log statement includes provider content, user prompts, or source text;
- `git diff --check` is silent.

- [ ] **Step 5: Review the complete diff and architecture risk**

```powershell
git diff --stat origin/main...HEAD
git diff origin/main...HEAD
repowise distill pnpm test:unit
```

Run Repowise change-risk review for:

```text
packages/contracts/src/prompt-library.ts
packages/domain/src/generated-world.ts
packages/domain/src/world-template.ts
services/api/src/world-generator-service.ts
services/api/src/infinite-worlds-import-service.ts
apps/web/public/nexus.js
```

Confirm no unrelated import, provider, world-library, or UI behavior changed.

- [ ] **Step 6: Commit the architecture record and any verification-owned correction**

```powershell
git add docs/architecture/0027-generated-world-completion-contract.md
git diff --cached --check
git commit -m "Document generated world completion"
```

If verification finds a behavioral defect, return it to the task that owns that behavior, add a failing regression test there, fix it, rerun that task’s verification, and then restart Task 5. Do not create a catch-all cleanup commit.

- [ ] **Step 7: Transition to branch completion**

Invoke `superpowers:requesting-code-review`, resolve actionable findings, rerun Task 5, then invoke `superpowers:finishing-a-development-branch` before choosing merge, push, or pull-request actions.
