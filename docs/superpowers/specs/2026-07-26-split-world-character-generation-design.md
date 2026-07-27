# Split World and Character Generation Design

**Status:** Proposed for written-spec review

**Date:** 2026-07-26

## Summary

Infinite Quest Nexus will split generated-world authoring into one provider call
for the world and one provider call for each playable character. The first call
will return the complete top-level world plus three or four compact character
seeds. The server will then expand each seed into one independently validated
character profile and assemble the final `WorldContent`.

This replaces the current request for one large JSON object containing the
world and every fully structured character. Each provider call receives the
configured text-provider output allowance, so a long world response cannot
consume the budget needed to close all character profiles.

The existing world-preview API and durable progress record remain the parent
operation. The child calls are bounded internal provider operations, not new
database job rows.

## Goals

- Generate the world and character profiles in separately bounded provider
  responses.
- Generate exactly three or four distinct playable characters.
- Give every character its own validation and recovery attempt.
- Preserve the existing final `WorldContent` API contract.
- Report clear progress for the world call and every character call.
- Return safe, character-specific failures when one profile cannot be
  completed.
- Apply the same orchestration to new-world previews and CYOA world conversion,
  which both use `generateTemplateWorld`.
- Keep world generation provider-neutral across LM Studio, OpenRouter, and
  other OpenAI-compatible text providers.

## Non-goals

- Adding durable database rows for the individual world and character calls.
- Resuming a partially completed world preview after an API or process restart.
- Returning or saving a partial world when one character fails.
- Running character calls concurrently.
- Changing the provider profile's configured context or maximum output tokens.
- Changing standalone character creation and editing outside generated-world
  orchestration.
- Removing existing prompt-template keys that may have stored overrides.

## Generation flow

### 1. Load shared configuration

`generateTemplateWorld` resolves the effective text-provider profile and one
prompt snapshot before making provider calls. Every child call uses the same
provider profile, selected model, prompt snapshot, and source input.

### 2. Generate the world and character seeds

The world call returns one JSON object with:

- `title`;
- `genre`;
- `tone`;
- `backgroundStory`;
- `premise`;
- `firstAction`;
- `story_rules`;
- `default_triggers`;
- `event_triggers`;
- `rpg_statistics`;
- `character_seeds`.

`character_seeds` contains exactly three or four compact objects with:

- `id`;
- `name`;
- `role`;
- `concept`;
- `narrative_hook`.

The seed fields are planning data for the child profile calls. They are not
persisted as a second authoritative character representation. The server
validates that seed IDs and names are non-empty and unique before starting
profile generation.

The `world_generation` prompt will no longer request complete nested character
profiles. It will request the top-level world and compact seeds. A dedicated
world-recovery prompt will request the same complete replacement shape.

### 3. Recover the world once when needed

If the initial world response is output-limited, malformed, or fails the
world-and-seed schema, the server makes one recovery call. The recovery request
includes:

- the original authoritative input;
- the provider response ID when available;
- the rejected response content within the existing bounded adapter allowance;
- a request for one complete compact replacement object.

Supplying the rejected content is required for stateless OpenAI-compatible
providers. Stateful providers may use the provider response ID without changing
the validation contract.

If recovery still fails, the parent operation returns
`incomplete_generated_world` with bounded safe issue paths. No character calls
are made.

### 4. Generate one character per seed

The server processes seeds sequentially in their returned order. Each character
call receives:

- a compact projection of the validated world;
- the current seed;
- the other seed names and roles for differentiation;
- the already accepted character names;
- a single-character output contract.

Each response must contain:

- `id`;
- `name`;
- non-empty `character_text`;
- `profile` with `identity`, `story`, `appearance`, and
  `unclassifiedNotes`;
- `rpg_statistics`;
- `default_triggers`.

The application continues to own final character IDs. Provider IDs are treated
as source-local hints and are normalized through the existing deterministic
application ID assignment before returning `WorldContent`.

### 5. Recover each character once when needed

If a character response is output-limited, malformed, incomplete, or fails the
complete-character schema, the server makes one recovery call for that seed.
The recovery request includes the rejected character response within the
existing bounded adapter allowance and asks for one complete replacement
character object.

If recovery fails, the parent operation returns
`incomplete_generated_character` with:

- the zero-based character index;
- the safe seed name;
- bounded safe validation issues.

Raw model output, prompts, private lore, credentials, and provider diagnostics
are not included in the API error or progress record.

### 6. Assemble and validate the final world

After all profiles pass validation, the server:

1. assigns application-owned character IDs;
2. normalizes character statistics and triggers;
3. normalizes world statistics, triggers, and event triggers;
4. constructs the existing `WorldContent`;
5. validates the complete generated-world schema;
6. returns the unchanged `{ title, content }` preview contract.

The operation does not persist a world draft until the existing caller performs
its explicit save or import step.

## Prompt contracts

The prompt catalog will retain existing keys for compatibility and add focused
generated-world character keys:

- `world_generation` — top-level world and compact seeds;
- `world_generation_recovery` — complete replacement world and seeds;
- `world_character_generation` — one complete character from one seed;
- `world_character_generation_recovery` — one compact replacement character.

`world_roster_supplement` remains in the catalog so existing prompt overrides
and administrative records are not invalidated, but the new orchestration does
not depend on the supplement path.

The generated-world character prompts are separate from the existing
`character_generation` prompt because standalone character authoring has a
different request and response contract.

## Progress model

The existing `progressKey` and `world_generation_progress` record remain the
single browser-visible operation. Suggested phases and percentages are:

- `extracting`, 10% — load provider and prompts;
- `generating_world`, 25% — generate world and seeds;
- `recovering_world`, 35% — optional world recovery;
- `generating_character`, 40–85% — generate character `n` of `count`;
- `recovering_character`, within the same character's progress interval;
- `formatting`, 90% — assemble and validate;
- `completed`, 100%.

Character progress messages identify only the ordinal and safe seed name, for
example: `Generating character 2 of 3: Mira Vale…`.

The browser continues polling the current progress endpoint. No new route or UI
state machine is required beyond updated labels and tests.

## Error behavior

- World provider transport, destination-policy, response-size, timeout, and
  HTTP failures retain the existing safe provider error categories.
- A world response that fails both validation attempts returns
  `incomplete_generated_world`.
- A character response that fails both validation attempts returns
  `incomplete_generated_character`.
- A failed character causes the complete preview to fail. Valid earlier
  character responses are not returned or persisted.
- Final assembly failure returns `incomplete_generated_world` because the
  assembled result did not satisfy the public world contract.
- Logs contain response IDs, finish reasons, output-limit flags, character
  ordinals, safe seed names, and projected validation issues. They do not
  contain provider response bodies or source prompts.

## Service boundaries

The first implementation may remain in `world-generator-service.ts` to avoid an
unrelated service extraction, but orchestration should use focused pure helpers:

- a world-and-seed schema and parser;
- a character-generation input projection;
- a reusable provider-call-plus-one-recovery helper;
- a safe character failure constructor;
- final assembly using existing normalization helpers.

If these helpers make `world-generator-service.ts` materially harder to review,
the implementation plan may place the generated-world orchestration in a
focused sibling module while preserving the exported service functions.

No database migration is required.

## Testing strategy

### Unit tests

- The initial provider call requests world fields and compact character seeds,
  not full nested profiles.
- Three seeds produce exactly one world call and three character calls.
- Four seeds produce exactly one world call and four character calls.
- Character calls are sequential and preserve seed order.
- Every character call receives world context, differentiation context, and
  only its assigned seed.
- World recovery includes the rejected world response and prevents character
  calls until recovery succeeds.
- Character recovery includes the rejected character response and retries only
  the failed seed.
- A recovered character is assembled with characters that succeeded on their
  first attempt.
- Duplicate or incomplete seeds fail before character generation.
- A twice-invalid profile returns `incomplete_generated_character` with safe
  index, seed name, and validation issues.
- Final assembly still enforces three or four distinct complete characters.
- Progress updates identify world generation, each character, recovery, final
  formatting, and completion.

### Provider adapter tests

- LM Studio and OpenAI-compatible requests keep using the provider profile's
  configured maximum output tokens for every world and character call.
- Stateless recovery receives the bounded rejected response.
- Stateful recovery may use the provider response ID.

### PostgreSQL integration tests

- New-world preview assembles a valid world from one world response and three
  character responses.
- CYOA conversion uses the same split flow and persists the assembled result
  only after every profile succeeds.
- A character failure leaves world, world-version, campaign, turn, memory, and
  asset counts unchanged.
- Durable progress reaches each character phase and the terminal completed or
  failed state.
- Cross-owner provider and progress isolation remain unchanged.

Integration verification requires `TEST_DATABASE_URL`; skipped PostgreSQL tests
must be reported as unverified rather than passed.

## Acceptance criteria

The change is complete when:

- generated-world requests no longer ask one response to contain both the
  complete world and all complete character profiles;
- every seed receives its own bounded provider call and one independent
  recovery attempt;
- the existing world-preview and CYOA callers receive the same final
  `WorldContent` shape;
- progress visibly advances through individual character generation;
- a missing top-level field such as `premise` is handled by world recovery,
  while a missing character field is handled by only that character's recovery;
- output exhaustion in one character cannot truncate the world or another
  character;
- no partial preview or authoritative data is persisted after failure;
- focused unit tests, real-PostgreSQL integration tests, `pnpm check`,
  `pnpm build`, and `git diff --check` pass.
