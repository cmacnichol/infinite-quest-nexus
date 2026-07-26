# Split World and Character Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate the world structure once, then generate and recover each of three or four playable-character profiles in its own provider call before assembling the unchanged `WorldContent` preview.

**Architecture:** `generateTemplateWorld` remains the shared parent orchestration used by manual previews and CYOA conversion. Its first provider call returns validated world fields plus three or four compact character seeds; sequential child calls expand each seed into one complete profile using the same provider profile and prompt snapshot. The parent progress record reports each phase, no partial result is persisted, and provider-neutral recovery includes both the response ID and bounded rejected output.

**Tech Stack:** Node.js 22.13+, TypeScript 7, Zod 4, Fastify 5, PostgreSQL, Vitest 4, vanilla JavaScript, OpenAI-compatible text-provider APIs

## Global Constraints

- Use **Infinite Quest Nexus** for the platform and **Infinite Quest** for the player-facing story experience.
- Generated worlds require exactly three or four distinct playable characters.
- The world call returns complete top-level world fields plus exactly three or four compact `character_seeds`.
- Each seed receives one sequential provider call and at most one independent recovery call.
- Every generated playable character requires `id`, `name`, non-empty `character_text`, structured `profile`, `rpg_statistics`, and `default_triggers`.
- The existing `{ title, content }` API contract and final `WorldContent` shape must not change.
- Manual world preview and CYOA conversion must use the same `generateTemplateWorld` orchestration.
- Child calls are internal provider operations under the existing progress record; do not add database job rows or migrations.
- Do not return or persist partial world or character results after any failure.
- World recovery and character recovery must pass bounded `rejectedResponse` content for stateless OpenAI-compatible providers and `previousResponseId` when available.
- Never log or return raw provider output, prompt bodies, source lore, private reasoning, credentials, or unsanitized provider diagnostics.
- Retain `world_roster_supplement` in the prompt catalog for stored-override compatibility, but do not call it from the new orchestration.
- Use two-space indentation and TypeScript for service and contract changes.
- Every behavioral change requires a failing test before production code.
- Run `git diff --check` and review the complete staged diff before every commit.
- PostgreSQL integration checks count as verified only when `TEST_DATABASE_URL` is set and the tests execute rather than skip.

---

## File and interface map

### Modified files

- `packages/contracts/src/prompt-library.ts` — adds the generated-world character prompt keys and changes the world prompts to request compact seeds.
- `packages/domain/src/world-template.ts` — describes seed-based generation in the structured provider input.
- `services/api/src/world-generator-service.ts` — validates seeds, runs sequential child calls and per-child recovery, assembles the final world, and emits safe character-specific failures.
- `apps/web/public/nexus.js` — updates initial progress copy to match the split flow.
- `tests/unit/prompt-library.test.ts` — verifies prompt keys and output contracts.
- `tests/unit/world-generator-service.test.ts` — verifies orchestration, recovery isolation, progress, validation, and safe errors.
- `tests/integration/world-generation.integration.test.ts` — verifies manual preview and progress against an OpenAI-compatible mock provider and PostgreSQL.
- `tests/unit/management-ui.test.ts` — verifies updated progress copy.
- `docs/nexus-guide/worlds/create.md` — documents the split generation behavior and configured per-call output allowance.

### Core interfaces

```ts
type GeneratedCharacterSeed = {
  id: string;
  name: string;
  role: string;
  concept: string;
  narrative_hook: string;
};

type GeneratedWorldDraft = {
  title: string;
  genre: string;
  tone: string;
  backgroundStory: string;
  premise: string;
  firstAction: string;
  story_rules: string;
  default_triggers: unknown[];
  event_triggers: unknown[];
  rpg_statistics: unknown[];
  character_seeds: GeneratedCharacterSeed[];
};

export function incompleteGeneratedCharacterError(
  characterIndex: number,
  seedName: string,
  error?: unknown
): Error;
```

`generateTemplateWorld(...)` retains its current signature and return type.

The safe character error has this shape:

```ts
{
  statusCode: 502,
  expose: true,
  details: {
    code: "incomplete_generated_character",
    characterIndex: 1,
    seedName: "Mira Vale",
    issues: GeneratedWorldIssue[]
  }
}
```

---

### Task 1: Split prompt contracts into world seeds and one-character profiles

**Files:**
- Modify: `packages/contracts/src/prompt-library.ts:3-104`
- Modify: `packages/domain/src/world-template.ts:82-105`
- Test: `tests/unit/prompt-library.test.ts`

**Interfaces:**
- Produces prompt keys `world_character_generation` and `world_character_generation_recovery`.
- Produces `world_generation` and `world_generation_recovery` contracts whose character payload is `character_seeds`.
- Retains `world_roster_supplement` without making it part of the new flow.
- Consumed by Task 2 through `promptFromSnapshot(...)`.

- [ ] **Step 1: Write failing prompt-key and contract tests**

Replace the existing generated-world prompt assertions in
`tests/unit/prompt-library.test.ts` with tests equivalent to:

```ts
it("separates world seeds from complete generated character profiles", () => {
  const generation = PROMPT_TEMPLATE_CATALOG.world_generation.defaultContent;
  const recovery = PROMPT_TEMPLATE_CATALOG.world_generation_recovery.defaultContent;
  const character = PROMPT_TEMPLATE_CATALOG.world_character_generation.defaultContent;
  const characterRecovery = PROMPT_TEMPLATE_CATALOG.world_character_generation_recovery.defaultContent;

  for (const prompt of [generation, recovery]) {
    expect(prompt).toContain("character_seeds");
    expect(prompt).toContain("role");
    expect(prompt).toContain("concept");
    expect(prompt).toContain("narrative_hook");
    expect(prompt).not.toContain('"profile":{"identity"');
  }

  for (const prompt of [character, characterRecovery]) {
    expect(prompt).toContain("one complete playable character");
    expect(prompt).toContain("character_text");
    expect(prompt).toContain('"profile":{"identity"');
    expect(prompt).toContain("rpg_statistics");
    expect(prompt).toContain("default_triggers");
  }

  expect(recovery).toContain("complete replacement");
  expect(characterRecovery).toContain("complete replacement");
  expect(PROMPT_TEMPLATE_CATALOG.world_roster_supplement).toBeDefined();
});

it("builds seed-oriented input for prompt and CYOA sources", () => {
  const promptInput = JSON.parse(buildTemplateWorldPrompt({
    sourceName: "prompt",
    sourceKind: "prompt",
    title: "The Moving Roads",
    summary: "Roads move beneath moonlight.",
    keywords: [],
    excerpts: [],
    prompt: "Build a moving-road mystery."
  }).input);
  expect(promptInput.task).toContain("character seeds");
});
```

- [ ] **Step 2: Run the focused test and verify the new keys are missing**

Run:

```powershell
pnpm exec vitest run tests/unit/prompt-library.test.ts
```

Expected: FAIL because `world_character_generation` and
`world_character_generation_recovery` are not valid prompt keys and the world
prompt still requests complete profiles.

- [ ] **Step 3: Add the two prompt keys and focused prompt bodies**

Add both keys to `promptTemplateKeySchema` immediately after
`world_generation_recovery`.

Replace the world-generation character requirements with this exact logical
shape:

```text
"character_seeds":[
  {
    "id":"short unique seed id",
    "name":"character name",
    "role":"short story role",
    "concept":"compact identity and dramatic concept",
    "narrative_hook":"compact reason this character belongs in the world"
  }
]
```

The world prompt must require exactly three or four seeds, unique non-empty
`id` and `name` values, and complete top-level fields:

```text
title, genre, tone, backgroundStory, premise, firstAction, story_rules,
default_triggers, event_triggers, rpg_statistics, character_seeds
```

Add `world_character_generation` with a maximum length of `12000`,
`campaignOverrideAllowed: false`, no variables, and a default body that requests
one complete character with this exact shape:

```json
{
  "id": "seed id",
  "name": "character name",
  "character_text": "non-empty narrative guidance",
  "profile": {
    "identity": { "aliases": [], "pronouns": "" },
    "story": {
      "role": "",
      "background": "",
      "personality": "",
      "motivations": "",
      "goals": "",
      "fearsAndConflicts": "",
      "keyRelationships": "",
      "narrativeHooks": "",
      "voiceAndMannerisms": "",
      "otherGuidance": ""
    },
    "appearance": {
      "ancestryOrSpecies": "",
      "apparentAge": "",
      "genderPresentation": "",
      "build": "",
      "skinOrComplexion": "",
      "face": "",
      "eyes": "",
      "hair": "",
      "distinguishingFeatures": [],
      "clothing": "",
      "equipmentAndAccessories": "",
      "otherVisualDetails": ""
    },
    "unclassifiedNotes": ""
  },
  "rpg_statistics": [],
  "default_triggers": []
}
```

Add `world_character_generation_recovery` with a maximum length of `6000`.
It must request one complete compact replacement object for the same seed, not a
continuation or patch.

Keep `world_roster_supplement` unchanged in the catalog.

- [ ] **Step 4: Align the structured source task copy**

In `buildTemplateWorldPrompt`, change both task values to state that the first
call creates the world and three or four compact character seeds. Do not put the
full character schema into the input payload; it belongs in the system prompt.

- [ ] **Step 5: Run prompt tests and repository type checks**

Run:

```powershell
pnpm exec vitest run tests/unit/prompt-library.test.ts
pnpm check
```

Expected: PASS.

- [ ] **Step 6: Commit the prompt contract**

Run:

```powershell
git add packages/contracts/src/prompt-library.ts packages/domain/src/world-template.ts tests/unit/prompt-library.test.ts
git diff --cached --check
git diff --cached
git commit -m "Split world and character prompts"
```

---

### Task 2: Orchestrate one world call and one recoverable call per character

**Files:**
- Modify: `services/api/src/world-generator-service.ts:46-647`
- Test: `tests/unit/world-generator-service.test.ts`

**Interfaces:**
- Consumes Task 1 prompt keys through the existing prompt snapshot.
- Produces validated `GeneratedWorldDraft` and `GeneratedCharacterSeed` data internally.
- Produces `incompleteGeneratedCharacterError(characterIndex, seedName, error)`.
- Preserves the exported `generateTemplateWorld(...)` signature and final `{ title, content }` result.
- Removes the `world_roster_supplement` provider call from generated-world orchestration.

- [ ] **Step 1: Replace the orchestration fixtures with world seeds**

In `tests/unit/world-generator-service.test.ts`, add:

```ts
function seed(index: number) {
  return {
    id: `seed-${index}`,
    name: `Character ${index}`,
    role: `Role ${index}`,
    concept: `Concept ${index}`,
    narrative_hook: `Hook ${index}`
  };
}

function worldDraftResponse(seedCount = 3): string {
  return JSON.stringify({
    title: "The Moving Roads",
    genre: "Weird fantasy",
    tone: "Hopeful",
    backgroundStory: "Cartographers once governed the coast.",
    premise: "Roads rearrange beneath moonlight.",
    firstAction: "A forbidden road appears outside the city.",
    story_rules: "Every road remembers its maker.",
    character_seeds: Array.from({ length: seedCount }, (_, index) => seed(index + 1)),
    rpg_statistics: [],
    default_triggers: [],
    event_triggers: []
  });
}
```

Keep the existing complete `character(name)` fixture and return one character
object per child provider result.

- [ ] **Step 2: Write failing sequencing and context tests**

Add:

```ts
it("generates one world and one sequential profile for each seed", async () => {
  const harness = generationHarness([
    providerResult(worldDraftResponse(3), "world-response"),
    providerResult(JSON.stringify(character("Character 1")), "character-1"),
    providerResult(JSON.stringify(character("Character 2")), "character-2"),
    providerResult(JSON.stringify(character("Character 3")), "character-3")
  ]);

  const generated = await harness.run();

  expect(generated.content.playableCharacters).toHaveLength(3);
  expect(harness.requests).toHaveLength(4);
  expect(harness.requests[0]?.systemPrompt).toContain("character_seeds");
  for (const [index, request] of harness.requests.slice(1).entries()) {
    const input = JSON.parse(request.input);
    expect(input.seed.name).toBe(`Character ${index + 1}`);
    expect(input.world).toMatchObject({
      title: "The Moving Roads",
      premise: "Roads rearrange beneath moonlight."
    });
    expect(input.otherSeeds).toHaveLength(2);
    expect(input.acceptedCharacterNames).toEqual(
      Array.from({ length: index }, (_, accepted) => `Character ${accepted + 1}`)
    );
  }
});

it("generates four profiles when the world returns four seeds", async () => {
  const harness = generationHarness([
    providerResult(worldDraftResponse(4)),
    ...[1, 2, 3, 4].map((index) =>
      providerResult(JSON.stringify(character(`Character ${index}`)))
    )
  ]);
  await expect(harness.run()).resolves.toMatchObject({
    content: { playableCharacters: expect.arrayContaining([
      expect.objectContaining({ name: "Character 4" })
    ]) }
  });
  expect(harness.requests).toHaveLength(5);
});
```

- [ ] **Step 3: Write failing world and character recovery tests**

Add:

```ts
it("recovers an invalid world before starting character generation", async () => {
  const harness = generationHarness([
    providerResult('{"title":"partial"', "partial-world", {
      finishReason: "length",
      outputLimited: true
    }),
    providerResult(worldDraftResponse(3), "recovered-world"),
    ...[1, 2, 3].map((index) =>
      providerResult(JSON.stringify(character(`Character ${index}`)))
    )
  ]);

  await harness.run();

  expect(harness.requests[1]).toMatchObject({
    previousResponseId: "partial-world",
    rejectedResponse: '{"title":"partial"',
    recoveryInput: expect.stringContaining("complete replacement")
  });
});

it("recovers only the failed character seed", async () => {
  const harness = generationHarness([
    providerResult(worldDraftResponse(3)),
    providerResult(JSON.stringify(character("Character 1"))),
    providerResult('{"id":"seed-2","name":"Character 2"', "partial-character", {
      finishReason: "length",
      outputLimited: true
    }),
    providerResult(JSON.stringify(character("Character 2")), "recovered-character"),
    providerResult(JSON.stringify(character("Character 3")))
  ]);

  const generated = await harness.run();

  expect(generated.content.playableCharacters.map((item) => item.name)).toEqual([
    "Character 1",
    "Character 2",
    "Character 3"
  ]);
  expect(harness.requests[3]).toMatchObject({
    previousResponseId: "partial-character",
    rejectedResponse: '{"id":"seed-2","name":"Character 2"',
    recoveryInput: expect.stringContaining("complete replacement")
  });
  expect(harness.requests).toHaveLength(5);
});
```

Extend `providerResult` with an optional partial override:

```ts
function providerResult(
  content: string,
  responseId = "response-id",
  override: Partial<ProviderResult> = {}
): ProviderResult {
  return {
    content,
    responseId,
    finishReason: "stop",
    outputLimited: false,
    modelInstanceId: "model-instance",
    usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
    reportedCost: null,
    rawMetadata: {},
    ...override
  };
}
```

- [ ] **Step 4: Write failing seed-validation, typed-error, and progress tests**

Add tests that assert:

```ts
await expect(generationHarness([
  providerResult(JSON.stringify({
    ...JSON.parse(worldDraftResponse(3)),
    character_seeds: [seed(1), seed(1), seed(3)]
  })),
  providerResult(worldDraftResponse(3)),
  ...[1, 2, 3].map((index) =>
    providerResult(JSON.stringify(character(`Character ${index}`)))
  )
]).run()).resolves.toBeDefined();
```

This proves duplicate seeds trigger the one world recovery before any character
call.

Add a twice-invalid character case:

```ts
const harness = generationHarness([
  providerResult(worldDraftResponse(3)),
  providerResult(JSON.stringify(character("Character 1"))),
  providerResult('{"name":"Character 2"}', "invalid-2"),
  providerResult('{"name":"Character 2"}', "invalid-2-recovery")
]);
await expect(harness.run()).rejects.toMatchObject({
  statusCode: 502,
  expose: true,
  details: {
    code: "incomplete_generated_character",
    characterIndex: 1,
    seedName: "Character 2"
  }
});
expect(harness.requests).toHaveLength(4);
```

Capture `onProgress` updates in `generationHarness` and assert successful
generation includes:

```ts
const progressUpdates: Array<{
  phase: string;
  percent: number;
  message: string;
}> = [];

run: () => generateTemplateWorld(
  {} as never,
  "owner-id",
  "provider-id",
  "credential-secret",
  {
    sourceName: "test-prompt",
    sourceKind: "prompt",
    title: "The Moving Roads",
    summary: "Roads move beneath moonlight.",
    keywords: [],
    excerpts: [],
    prompt: "Build a moving-road mystery."
  },
  undefined,
  async (phase, percent, message) => {
    progressUpdates.push({ phase, percent, message });
  },
  dependencies
)
```

Then assert `progressUpdates` contains:

```ts
[
  expect.objectContaining({ phase: "generating_world" }),
  expect.objectContaining({ phase: "generating_character", message: expect.stringContaining("1 of 3") }),
  expect.objectContaining({ phase: "generating_character", message: expect.stringContaining("2 of 3") }),
  expect.objectContaining({ phase: "generating_character", message: expect.stringContaining("3 of 3") }),
  expect.objectContaining({ phase: "formatting" }),
  expect.objectContaining({ phase: "completed", percent: 100 })
]
```

Add a recovery-progress assertion for `recovering_character`.

- [ ] **Step 5: Run the focused test and verify the old supplement flow fails**

Run:

```powershell
pnpm exec vitest run tests/unit/world-generator-service.test.ts
```

Expected: FAIL because the service still parses `playable_characters` from the
world response and calls `world_roster_supplement`.

- [ ] **Step 6: Implement seed schemas and compatibility normalization**

Add internal schemas:

```ts
const generatedCharacterSeedSchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  role: z.string().trim().min(1).max(2000),
  concept: z.string().trim().min(1).max(10_000),
  narrative_hook: z.string().trim().min(1).max(10_000)
}).passthrough();

const convertedWorldSchema = z.object({
  title: z.string().trim().min(1).max(200),
  genre: flexibleShortText,
  tone: flexibleShortText,
  backgroundStory: flexibleLongText,
  premise: flexibleLongText,
  firstAction: flexibleLongText,
  story_rules: flexibleLongText,
  character_seeds: z.array(generatedCharacterSeedSchema).min(3).max(4),
  default_triggers: z.array(z.unknown()).max(10_000).default([]),
  event_triggers: z.array(z.unknown()).max(10_000).default([]),
  rpg_statistics: z.array(z.unknown()).max(10_000).default([])
}).passthrough();
```

Extend the world refinement to reject duplicate seed IDs and names using
trimmed lowercase comparison.

In `normalizeRawWorldJson`, normalize `character_seeds` and `characterSeeds`.
For explicit stored prompt overrides that still return `playable_characters`,
derive compact seeds only when no seed array exists:

```ts
const seedSource = getArr("character_seeds", "characterSeeds");
const legacyCharacters = getArr(
  "playable_characters",
  "playableCharacters",
  "playable_character_list",
  "characters"
);
const normalizedSeeds = (seedSource.length ? seedSource : legacyCharacters)
  .map((item, index) => normalizeGeneratedSeed(item, index));
```

`normalizeGeneratedSeed` must derive `role` from `role` or
`profile.story.role`, derive `concept` from `concept`, `character_text`,
`characterText`, `background`, or `description`, and derive
`narrative_hook` from `narrative_hook`, `narrativeHook`,
`profile.story.narrativeHooks`, or the derived concept. It must not retain or
trust a legacy nested profile as the final character profile.

- [ ] **Step 7: Implement one world recovery and sequential character generation**

For the world:

1. Call `world_generation`.
2. Parse and validate the complete world draft.
3. On `SyntaxError` or `z.ZodError`, report `recovering_world` at 35%.
4. Make one recovery call with:

```ts
{
  ...prompt,
  ...(result.responseId ? { previousResponseId: result.responseId } : {}),
  rejectedResponse: result.content,
  recoveryInput: promptFromSnapshot(promptSnapshot, "world_generation_recovery")
}
```

5. Parse recovery or throw `incompleteGeneratedWorldError`.

For each seed in order:

```ts
const characterRequest: ProviderRequest = {
  systemPrompt: promptFromSnapshot(promptSnapshot, "world_character_generation"),
  input: JSON.stringify({
    world: {
      title: converted.title,
      genre: converted.genre,
      tone: converted.tone,
      backgroundStory: converted.backgroundStory,
      premise: converted.premise,
      firstAction: converted.firstAction,
      storyRules: converted.story_rules
    },
    seed,
    otherSeeds: converted.character_seeds
      .filter((candidate) => candidate.id !== seed.id)
      .map(({ id, name, role }) => ({ id, name, role })),
    acceptedCharacterNames: rawCharacters.map((character) => character.name)
  })
};
```

Before each initial child call, emit `generating_character` with a percentage
between 40 and 85 and message:

```text
Generating character N of COUNT: SAFE_NAME…
```

Parse each result with `completeConvertedPlayableCharacterSchema`. On validation
failure, emit `recovering_character`, then make exactly one recovery call:

```ts
{
  ...characterRequest,
  ...(characterResult.responseId
    ? { previousResponseId: characterResult.responseId }
    : {}),
  rejectedResponse: characterResult.content,
  recoveryInput: promptFromSnapshot(
    promptSnapshot,
    "world_character_generation_recovery"
  )
}
```

If recovery fails validation, throw:

```ts
export function incompleteGeneratedCharacterError(
  characterIndex: number,
  seedName: string,
  error?: unknown
): Error {
  return Object.assign(
    new Error(`The text provider did not return a complete profile for character ${characterIndex + 1}.`),
    {
      statusCode: 502,
      expose: true,
      details: {
        code: "incomplete_generated_character",
        characterIndex,
        seedName: seedName.slice(0, 200),
        issues: generatedWorldIssues(error)
      }
    }
  );
}
```

Do not catch provider transport, HTTP, destination-policy, response-size, or
timeout errors as validation failures.

- [ ] **Step 8: Assemble and validate the unchanged final world**

Delete the supplement call and generic fallback-character path. Assemble
`rawCharacters` from the accepted child results, assign application-owned IDs,
normalize statistics and triggers, canonicalize, and keep the existing
`parseCompleteGeneratedWorld(...)` final gate.

The final result must still be:

```ts
return {
  title: content.world.title,
  content
};
```

- [ ] **Step 9: Run focused and adjacent unit tests**

Run:

```powershell
pnpm exec vitest run tests/unit/world-generator-service.test.ts tests/unit/generated-world.test.ts tests/unit/world-library.test.ts tests/unit/server-security.test.ts
pnpm check
```

Expected: PASS.

- [ ] **Step 10: Commit orchestration**

Run:

```powershell
git add services/api/src/world-generator-service.ts tests/unit/world-generator-service.test.ts
git diff --cached --check
git diff --cached
git commit -m "Generate world characters independently"
```

---

### Task 3: Update database-backed preview coverage, progress copy, and documentation

**Files:**
- Modify: `tests/integration/world-generation.integration.test.ts`
- Modify: `apps/web/public/nexus.js:1439-1468`
- Modify: `tests/unit/management-ui.test.ts`
- Modify: `docs/nexus-guide/worlds/create.md`

**Interfaces:**
- Consumes the Task 2 `generateTemplateWorld(...)` behavior.
- Verifies the existing `/api/v1/worlds/generate-preview` and progress API contracts.
- Produces no new API route, schema, or database migration.

- [ ] **Step 1: Rewrite mock-provider fixtures for the split flow**

Replace `worldResponse(...)` and `supplementResponse(...)` in
`tests/integration/world-generation.integration.test.ts` with:

```ts
function characterSeed(index: number) {
  return {
    id: `seed-${index}`,
    name: `Explorer ${index}`,
    role: `Explorer role ${index}`,
    concept: `Explorer concept ${index}`,
    narrative_hook: `Explorer hook ${index}`
  };
}

function worldResponse(seedCount = 3): string {
  return JSON.stringify({
    title: "The Sunken Citadel",
    genre: "Fantasy exploration",
    tone: "Mysterious and adventurous",
    backgroundStory: "An ancient citadel sank beneath the waves.",
    premise: "Three explorers descend to recover its lost archive.",
    firstAction: "Examine the glowing runes on the bronze archway.",
    story_rules: "Ancient enchantments distort sound and light underwater.",
    character_seeds: Array.from(
      { length: seedCount },
      (_, index) => characterSeed(index + 1)
    ),
    rpg_statistics: [],
    default_triggers: [],
    event_triggers: []
  });
}

function characterResponse(index: number, includeProfile = true): string {
  return JSON.stringify(
    character(`Explorer ${index}`, includeProfile)
  );
}
```

- [ ] **Step 2: Write failing manual-preview and progress assertions**

For a successful manual preview, queue:

```ts
replies.push(
  { content: worldResponse(3) },
  { content: characterResponse(1) },
  { content: characterResponse(2) },
  { content: characterResponse(3) }
);
```

Assert:

```ts
expect(providerRequestBodies).toHaveLength(4);
expect(providerRequestBodies[0]?.messages?.[0]?.content).toContain(
  "character_seeds"
);
for (const [index, body] of providerRequestBodies.slice(1).entries()) {
  const userMessage = body.messages?.find((message) => message.role === "user");
  expect(userMessage?.content).toContain(`Explorer ${index + 1}`);
}
expect(preview.content.playableCharacters).toHaveLength(3);
expect(preview.content.playableCharacters.every(
  (entry) => Boolean(entry.characterText.trim() && entry.profile)
)).toBe(true);
```

Read progress after each mock reply by recording progress updates or by waiting
for the terminal record, and assert the terminal record is unchanged:

```ts
{
  status: "completed",
  phase: "completed",
  progressPercent: 100,
  message: "World and character generation completed."
}
```

Add a failure sequence where character 2 and its recovery both omit `profile`.
Assert:

```ts
await expect(generateWorldPreview(/* existing arguments */)).rejects.toMatchObject({
  statusCode: 502,
  expose: true,
  details: {
    code: "incomplete_generated_character",
    characterIndex: 1,
    seedName: "Explorer 2"
  }
});
expect(await persistenceCounts()).toEqual(before);
expect(await getWorldGenerationProgress(
  pool,
  ownerUserId,
  progressKey
)).toMatchObject({
  status: "failed",
  phase: "failed",
  progressPercent: 100
});
```

- [ ] **Step 3: Run the database-backed test and verify old fixtures fail**

With `TEST_DATABASE_URL` set, run:

```powershell
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/world-generation.integration.test.ts
```

Expected: FAIL until the fixtures and expectations match the split provider
sequence. If `TEST_DATABASE_URL` is not available, record the suite as skipped
and continue with unit verification; do not report integration success.

- [ ] **Step 4: Update initial browser progress copy and its test**

Change the initial label in `generateWorldFromPrompt()` from:

```text
Synthesizing world overview and characters via LLM…
```

to:

```text
Generating world structure and character seeds…
```

Change the status from:

```text
Generating a complete world and playable-character roster…
```

to:

```text
Generating the world, then building each playable character…
```

In `tests/unit/management-ui.test.ts`, assert both new strings are present in
the extracted `generateWorldFromPrompt` function and the old combined-generation
string is absent.

- [ ] **Step 5: Document per-character output budgeting**

Add a short **Generate with the text provider** section to
`docs/nexus-guide/worlds/create.md` stating:

- the first call creates world fields and compact character seeds;
- each character profile is generated and recovered independently;
- each call uses the text provider profile's configured maximum output tokens;
- the completed preview is returned only after all profiles pass validation;
- a failed profile does not create or save a partial world.

- [ ] **Step 6: Run UI, syntax, integration, and documentation checks**

Run:

```powershell
pnpm exec vitest run tests/unit/management-ui.test.ts
node --check apps/web/public/nexus.js
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/world-generation.integration.test.ts
pnpm check
pnpm build
git diff --check
```

Expected: unit, syntax, check, build, and diff checks PASS. The integration test
must PASS when `TEST_DATABASE_URL` is configured; otherwise report it as
skipped.

- [ ] **Step 7: Run full unit coverage and inspect invariants**

Run:

```powershell
pnpm test:unit
rg -n "world_roster_supplement" services/api/src/world-generator-service.ts
rg -n "rejectedResponse" services/api/src/world-generator-service.ts
rg -n "result\\.content|request\\.prompt" services/api/src/world-generator-service.ts
```

Expected:

- all unit tests pass;
- `world-generator-service.ts` does not call `world_roster_supplement`;
- both world and character recovery requests set `rejectedResponse`;
- no new logger call contains provider result content or user prompt bodies.

- [ ] **Step 8: Commit integration, UI, and documentation**

Run:

```powershell
git add tests/integration/world-generation.integration.test.ts apps/web/public/nexus.js tests/unit/management-ui.test.ts docs/nexus-guide/worlds/create.md
git diff --cached --check
git diff --cached
git commit -m "Verify split world character generation"
```

---

### Task 4: Final verification and branch-wide review preparation

**Files:**
- Modify only files required to correct failures found by the commands below.

**Interfaces:**
- Consumes Tasks 1–3.
- Produces a clean, verified branch for the required whole-branch review.

- [ ] **Step 1: Run repository and full unit verification**

Run:

```powershell
pnpm check
pnpm test:unit
pnpm build
git diff --check
```

Expected: PASS.

- [ ] **Step 2: Run full PostgreSQL integration verification**

With `TEST_DATABASE_URL` set:

```powershell
pnpm test:integration
```

Expected: PASS with database-backed tests executed. If the environment lacks
`TEST_DATABASE_URL`, report the integration suite as skipped and do not describe
it as verified.

- [ ] **Step 3: Review complete branch scope**

Run:

```powershell
git status --short
git diff --stat origin/main...HEAD
git diff origin/main...HEAD
repowise distill pnpm test:unit
```

Confirm:

- only the approved spec, plan, prompt, world-generation service, focused tests,
  progress copy, and world-creation documentation changed;
- no database migration or new API route was introduced;
- no partial generated content is persisted;
- the final public `WorldContent` contract is unchanged.

- [ ] **Step 4: Run Repowise change-risk and health review**

Assess:

```text
packages/contracts/src/prompt-library.ts
packages/domain/src/world-template.ts
services/api/src/world-generator-service.ts
apps/web/public/nexus.js
tests/unit/prompt-library.test.ts
tests/unit/world-generator-service.test.ts
tests/unit/management-ui.test.ts
tests/integration/world-generation.integration.test.ts
```

Use the returned directive's `will_break`, `missing_cochanges`,
`missing_tests`, and `tests_to_run` fields. Run any newly identified focused
tests before completion. Check health for every production file changed.

- [ ] **Step 5: Commit only verification-owned regression fixes**

If verification finds a defect, return to the task owning that behavior, add a
failing regression test, implement the smallest fix, rerun that task's focused
checks, and commit with an imperative domain-specific summary. Do not create a
catch-all cleanup commit.

- [ ] **Step 6: Dispatch the final whole-branch reviewer**

Generate the SDD review package from `origin/main...HEAD` and dispatch the
`superpowers:requesting-code-review` reviewer on the most capable available
model. Resolve Critical and Important findings through the SDD final fix wave,
then rerun Steps 1–4.

- [ ] **Step 7: Finish the branch**

After the final review is clean, invoke
`superpowers:finishing-a-development-branch`. Do not merge, push, or open a pull
request unless the user asks for that publication action.
