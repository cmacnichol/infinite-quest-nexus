import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createApiAssetComposition } from "../../services/runtime/src/api-asset-composition.js";
import { createPortableFamilyPreviewAdapter } from "../../services/runtime/src/portable-import-export-composition.js";
import { createApiPortableImportExportComposition } from "../../services/runtime/src/api-portable-import-export-composition.js";
import { importPortableLegacyStory, previewPortableLegacyStory } from "../../services/api/src/portable-legacy-story-import-route.js";
import { importPortableWorldJson, previewPortableWorldJson } from "../../services/api/src/portable-world-import-route.js";
import {
  importPortableInfiniteWorlds,
  previewPortableInfiniteWorlds,
} from "../../services/api/src/portable-infinite-worlds-import-route.js";
import { canonicalizeWorldContent } from "../../packages/contracts/src/world-library.js";
// @ts-expect-error The repository guard is intentionally executable ESM.
import * as maintenanceBoundaries from "../../scripts/check-private-asset-maintenance-boundaries.mjs";
// @ts-expect-error The source inventory is intentionally executable ESM.
import * as privateParityBoundaries from "../../scripts/check-private-composition-parity-boundaries.mjs";

const { checkPrivateAssetMaintenanceBoundaries } = maintenanceBoundaries as unknown as Readonly<{
  checkPrivateAssetMaintenanceBoundaries(
    sources: readonly Readonly<{ file: string; text: string }>[],
  ): readonly string[];
}>;
const { readPrivateCompositionParitySources } = privateParityBoundaries as unknown as Readonly<{
  readPrivateCompositionParitySources(root: string): readonly Readonly<{ file: string; text: string }>[];
}>;

describe("Task 14e3g production binding", () => {
  it("stages and commits a direct Legacy Story import through the create-world durable destination", async () => {
    const stagedInputs: number[][] = [];
    const stageInput = vi.fn(async (input: { source: AsyncIterable<Uint8Array> }) => {
      const bytes: number[] = [];
      for await (const chunk of input.source) bytes.push(...chunk);
      stagedInputs.push(bytes);
      return { stagedInput: "legacy-staged" as never };
    });
    const previewLegacyStory = vi.fn(async () => ({
      projection: { kind: "campaign", valid: true, title: "Canals of Lume", duplicate: false, existingCampaignId: null, counts: { turns: 0, completeHistoryCharacters: 0, estimatedHistoryTokens: 0 }, warnings: [] },
      previewHandle: { token: "legacy-preview" as never, destination: { kind: "create_world" as const } },
      destination: { kind: "create_world" as const },
      expiresAt: "2030-01-01T00:00:00.000Z",
    }));
    const commit = vi.fn(async () => ({
      duplicate: false,
      result: { importId: "import", worldId: "world", worldVersionId: "version", campaignId: "campaign", stats: {} },
    }));
    const portable = { stageInput, previewLegacyStory, commit } as never;
    const request = {
      sourceName: "canals-of-lume.story.json",
      story: { world: { title: "Canals of Lume", character: "Iria" }, turns: [] },
      selectedCharacterId: "iria",
    };
    const owner = { ownerUserId: "11111111-1111-4111-8111-111111111111" };

    const preview = await previewPortableLegacyStory({ portable, pool: { query: vi.fn() } as never, owner, request: request as never, leaseOwner: "api-legacy-test" });
    const imported = await importPortableLegacyStory({ portable, pool: { query: vi.fn() } as never, owner, request: request as never, leaseOwner: "api-legacy-test" });

    expect(preview).toMatchObject({ projection: { kind: "campaign" }, expiresAt: "2030-01-01T00:00:00.000Z" });
    expect(imported).toMatchObject({ duplicate: false, result: { campaignId: "campaign" } });
    expect(stagedInputs).toHaveLength(2);
    expect(stagedInputs.map((bytes) => JSON.parse(Buffer.from(bytes).toString("utf8")))).toEqual([request.story, request.story]);
    expect(previewLegacyStory).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: owner.ownerUserId,
      kind: "legacy_story",
      destination: { kind: "create_world" },
      sourceName: request.sourceName,
      selectedCharacterId: "iria",
    }));
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: owner.ownerUserId,
      kind: "legacy_story",
      destination: { kind: "create_world" },
      idempotencyKey: expect.stringContaining("legacy-story:"),
    }));
  });

  it("stages World JSON once per preview or direct import and commits only its durable preview", async () => {
    const stageInput = vi.fn(async () => ({ stagedInput: "staged-input" as never }));
    const previewWorldJson = vi.fn(async () => ({
      projection: { kind: "world_json", valid: true, duplicate: false, existingWorldId: null, characters: [], counts: { entities: 0, relationships: 0, triggers: 0 }, warnings: [] },
      previewHandle: { token: "preview-token" as never, destination: { kind: "create_world" as const } },
      expiresAt: "2030-01-01T00:00:00.000Z",
    }));
    const commit = vi.fn(async () => ({
      duplicate: false,
      result: { kind: "world", worldId: "world", worldVersionId: "version" },
    }));
    const portable = { stageInput, previewWorldJson, commit } as never;
    const request = {
      sourceName: "canals-of-lume.world.json",
      worldExport: {
        format: "infinite-quest-world",
        formatVersion: 1,
        title: "Canals of Lume",
        content: canonicalizeWorldContent({
          world: { title: "Canals of Lume" },
          playableCharacters: [{ id: "hero", name: "Hero", characterText: "A canal guide" }],
        }),
      },
    } as never;
    const owner = { ownerUserId: "11111111-1111-4111-8111-111111111111" };

    const preview = await previewPortableWorldJson({ portable, owner, request, leaseOwner: "api-world-test" });
    const imported = await importPortableWorldJson({ portable, owner, request, leaseOwner: "api-world-test" });

    expect(preview).toMatchObject({ projection: { kind: "world_json" }, expiresAt: "2030-01-01T00:00:00.000Z" });
    expect(imported).toMatchObject({ duplicate: false, result: { worldId: "world" } });
    expect(stageInput).toHaveBeenCalledTimes(2);
    expect(previewWorldJson).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: owner.ownerUserId,
      sourceName: "canals-of-lume.world.json",
      kind: "world_json",
      destination: { kind: "create_world" },
    }));
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: owner.ownerUserId,
      kind: "world_json",
      idempotencyKey: expect.stringContaining("world-json:"),
    }));
  });

  it("keeps CYOA preview provider-free and commits through durable progress authority", async () => {
    const owner = { ownerUserId: "11111111-1111-4111-8111-111111111111" };
    const request = {
      sourceName: "canals.cyoa.json",
      sourceText: JSON.stringify({
        info: { pretty_title: "Canals of Lume" },
        chapters: { opening: { title: "Opening", content: "Lanterns cross the canal.", choices: ["Follow them"] } },
      }),
      sourceKind: "cyoa_json" as const,
      selectedCharacterIndex: 0,
      providerProfileId: "44444444-4444-4444-8444-444444444444",
      model: "text-model",
      enrichFinalTurn: false,
    };
    const progress = {
      begin: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      complete: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
      read: vi.fn(),
    };
    const stageInput = vi.fn(async () => ({ stagedInput: "cyoa-staged" as never }));
    const previewCyoa = vi.fn(async () => ({
      projection: {
        kind: "cyoa_json", valid: true, requiresProvider: true, warnings: [],
        counts: { topLevelTitle: "Canals of Lume", layer1ChaptersCount: 1, characterTarget: "3-4 playable characters" },
      },
      previewHandle: { token: "cyoa-preview" as never, destination: { kind: "create_world" as const } },
      destination: { kind: "create_world" as const },
      expiresAt: "2030-01-01T00:00:00.000Z",
    }));
    const commit = vi.fn(async () => ({
      duplicate: false,
      result: {
        kind: "world", importId: "55555555-5555-4555-8555-555555555555",
        worldId: "22222222-2222-4222-8222-222222222222",
        worldVersionId: "33333333-3333-4333-8333-333333333333",
      },
    }));
    const portable = { stageInput, previewCyoa, commit } as never;

    const publicPreview = await previewPortableInfiniteWorlds({
      portable,
      pool: { query: vi.fn() } as never,
      owner,
      request,
      leaseOwner: "api-iw-preview",
    });
    const imported = await importPortableInfiniteWorlds({
      portable,
      progress,
      pool: { query: vi.fn() } as never,
      owner,
      request,
      leaseOwner: "api-iw-import",
      diagnoseWorldGenerationFailure: () => ({ message: "Generation failed." }),
    });

    expect(publicPreview).toMatchObject({ kind: "cyoa_json", valid: true });
    expect(stageInput).toHaveBeenCalledOnce();
    expect(previewCyoa).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: owner.ownerUserId,
      kind: "cyoa",
      sourceName: request.sourceName,
      progressKey: `${request.sourceName}:${request.sourceText.length}`,
      providerSelection: {
        providerProfileId: request.providerProfileId,
        model: request.model,
      },
    }));
    expect(progress.begin).toHaveBeenCalledWith(expect.objectContaining({ key: `${request.sourceName}:${request.sourceText.length}` }), {
      phase: "extracting",
      progressPercent: 5,
      message: "Parsing CYOA story description and branch choices…",
    });
    expect(progress.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      worldId: "22222222-2222-4222-8222-222222222222",
      worldVersionId: "33333333-3333-4333-8333-333333333333",
      duplicate: false,
    }));
    expect(imported).toMatchObject({ kind: "world", worldId: "22222222-2222-4222-8222-222222222222" });
  });

  it("retains the validated world-import source name in durable preview authority", async () => {
    const previews = createPortableFamilyPreviewAdapter(
      { convertTemplate: vi.fn() },
      { readTargetWorldVersion: vi.fn() },
    );
    const sourceName = "canals-of-lume.world.json";
    const preview = await previews.previewWorldJson(
      (async function* () {
        yield new TextEncoder().encode(JSON.stringify({
          format: "infinite-quest-world",
          formatVersion: 1,
          title: "Canals of Lume",
          content: canonicalizeWorldContent({
            world: { title: "Canals of Lume" },
            playableCharacters: [{ id: "hero", name: "Hero", characterText: "A canal guide" }],
          }),
        }));
      })(),
      {
        ownerUserId: "11111111-1111-4111-8111-111111111111",
        stagedInput: "staged-input" as never,
        kind: "world_json",
        destination: { kind: "create_world" },
        sourceName,
      } as never,
    );

    expect(preview.authority.normalizedPayload).toMatchObject({
      worldImportRequest: { sourceName },
    });
  });

  it("retains Legacy Story's create-world and selected-character contract in durable authority", async () => {
    const previews = createPortableFamilyPreviewAdapter(
      { convertTemplate: vi.fn() },
      { readTargetWorldVersion: vi.fn() },
    );
    const sourceName = "canals-of-lume.story.json";
    const preview = await previews.previewLegacyStory(
      (async function* () {
        yield new TextEncoder().encode(JSON.stringify({
          world: { title: "Canals of Lume", character: "Iria\nA canal guide" },
          turns: [],
        }));
      })(),
      {
        ownerUserId: "11111111-1111-4111-8111-111111111111",
        stagedInput: "staged-input" as never,
        kind: "legacy_story",
        destination: { kind: "create_world" },
        sourceName,
        selectedCharacterId: "iria",
      } as never,
    );

    expect(preview.authority.normalizedPayload).toMatchObject({
      sourceName,
      embeddedWorldImportRequest: {
        sourceName,
        worldExport: {
          title: "Canals of Lume",
          content: {
            playableCharacters: [{ id: "iria", name: "Iria" }],
          },
        },
      },
    });
    expect(preview.authority.selectedCharacterId).toBe("iria");
  });

  it("retains the Infinite Worlds story-text source name in durable authority", async () => {
    const content = canonicalizeWorldContent({
      world: { title: "Canals of Lume" },
      playableCharacters: [{ id: "iria", name: "Iria", characterText: "A canal guide" }],
    });
    const previews = createPortableFamilyPreviewAdapter(
      { convertTemplate: vi.fn() },
      {
        readTargetWorldVersion: vi.fn(async () => ({
          ownerUserId: "11111111-1111-4111-8111-111111111111",
          worldId: "22222222-2222-4222-8222-222222222222",
          worldVersionId: "33333333-3333-4333-8333-333333333333",
          content,
        })),
      },
    );
    const sourceName = "canals-of-lume.story.txt";
    const preview = await previews.previewStoryText(
      (async function* () {
        yield new TextEncoder().encode("-- Story Background --\nA canal mystery.\n-- Character --\nIria\n-- Turn 1 --\nListen\n-------\nWater whispers.");
      })(),
      {
        ownerUserId: "11111111-1111-4111-8111-111111111111",
        stagedInput: "staged-input" as never,
        kind: "story_text",
        destination: {
          kind: "existing_world_version",
          worldId: "22222222-2222-4222-8222-222222222222",
          worldVersionId: "33333333-3333-4333-8333-333333333333",
        },
        sourceName,
        selectedCharacterId: "iria",
      } as never,
    );

    expect(preview.authority.normalizedPayload).toMatchObject({ sourceName });
  });

  it("sanitizes requested final-turn enrichment into durable story-text authority", async () => {
    const content = canonicalizeWorldContent({
      world: { title: "Canals of Lume" },
      playableCharacters: [{ id: "iria", name: "Iria", characterText: "A canal guide" }],
    });
    const enrichStoryFinalTurn = vi.fn(async () => ({
      metadata: {
        choices: ["Follow the lanterns.", "Roll a d20 to search the quay."],
        custom_action_suggestion: "Listen to the water.",
        image_prompt: "Moonlit canals beneath brass lanterns.",
      },
      providerConfigurationFingerprint: "c".repeat(64),
    }));
    const previews = createPortableFamilyPreviewAdapter(
      { convertTemplate: vi.fn(), enrichStoryFinalTurn } as never,
      {
        readTargetWorldVersion: vi.fn(async () => ({
          ownerUserId: "11111111-1111-4111-8111-111111111111",
          worldId: "22222222-2222-4222-8222-222222222222",
          worldVersionId: "33333333-3333-4333-8333-333333333333",
          content,
        })),
      },
    );

    const preview = await previews.previewStoryText(
      (async function* () {
        yield new TextEncoder().encode("-- Story Background --\nA canal mystery.\n-- Character --\nIria\n-- Turn 1 --\nListen\n-------\nWater whispers.");
      })(),
      {
        ownerUserId: "11111111-1111-4111-8111-111111111111",
        stagedInput: "staged-input" as never,
        kind: "story_text",
        destination: {
          kind: "existing_world_version",
          worldId: "22222222-2222-4222-8222-222222222222",
          worldVersionId: "33333333-3333-4333-8333-333333333333",
        },
        sourceName: "canals-of-lume.story.txt",
        selectedCharacterId: "iria",
        enrichFinalTurn: true,
        providerSelection: {
          providerProfileId: "44444444-4444-4444-8444-444444444444",
          model: "text-model",
        },
      } as never,
    );

    expect(enrichStoryFinalTurn).toHaveBeenCalledOnce();
    expect(preview.authority.providerConfigurationFingerprint).toBe("c".repeat(64));
    expect(preview.authority.normalizedPayload).toMatchObject({
      story: {
        turns: [{
          choices: ["Follow the lanterns."],
          customActionSuggestion: "Listen to the water.",
          imagePrompt: "Moonlit canals beneath brass lanterns.",
        }],
      },
    });
  });

  it("assembles portable conversion with a server-owned provider selection and closeable durable composition", async () => {
    const portable = { close: vi.fn(async () => undefined) };
    let captured: Record<string, unknown> | undefined;
    const createComposition = vi.fn(async (options: Record<string, unknown>) => {
      captured = options;
      return portable;
    });
    const generateCyoaWorld = vi.fn(async (command: { onProgress?: (phase: string, percent: number, message: string) => Promise<void> }) => {
      await command.onProgress?.("building_world", 50, "Building world canon…");
      return { title: "Generated world", content: {} };
    });
    const worlds = {};
    const targets = { readTargetWorldVersion: vi.fn() };
    const exports = { buildCampaignArchive: vi.fn(), buildWorldJson: vi.fn() };
    const progress = {
      begin: vi.fn(),
      update: vi.fn(async () => undefined),
      complete: vi.fn(),
      fail: vi.fn(),
      read: vi.fn(),
    };

    const result = await createApiPortableImportExportComposition({
      pool: {} as never,
      config: { archiveStorageRoot: "/archive", assetStorageRoot: "/assets" } as never,
      memory: {} as never,
      providers: { generateCyoaWorld } as never,
      leaseOwner: "api-test-owner",
    }, {
      createWorlds: vi.fn(() => worlds) as never,
      createTargets: vi.fn(() => targets) as never,
      createExports: vi.fn(() => exports) as never,
      createProgress: vi.fn(() => progress) as never,
      createComposition: createComposition as never,
    });

    expect(captured).toMatchObject({ worlds, targets, exports, leaseOwner: "api-test-owner" });
    const conversion = (captured as { provider: { convertTemplate(input: unknown): Promise<unknown> } }).provider;
    const converted = await conversion.convertTemplate({
      ownerUserId: "22222222-2222-4222-8222-222222222222",
      providerSelection: { providerProfileId: "11111111-1111-4111-8111-111111111111", model: "text-model" },
      progress: {
        owner: { ownerUserId: "22222222-2222-4222-8222-222222222222" },
        key: "world.txt:11",
      },
      template: {
        sourceName: "world.txt",
        sourceKind: "prompt",
        title: "A port city",
        summary: "A port city",
        keywords: [],
        excerpts: [],
        prompt: "A port city",
      },
    });

    expect(generateCyoaWorld).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: "22222222-2222-4222-8222-222222222222",
      providerProfileId: "11111111-1111-4111-8111-111111111111",
      model: "text-model",
    }));
    expect(converted).toMatchObject({
      world: { format: "infinite-quest-world", formatVersion: 1, title: "Generated world" },
      providerConfigurationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(progress.update).toHaveBeenCalledWith(
      {
        owner: { ownerUserId: "22222222-2222-4222-8222-222222222222" },
        key: "world.txt:11",
      },
      {
        phase: "building_world",
        progressPercent: 50,
        message: "Building world canon…",
      },
    );
    expect(result.progress).toBe(progress);
    await result.close();
    expect(portable.close).toHaveBeenCalledOnce();
  });

  it("binds story-text enrichment to the selected text provider and prompt snapshot", async () => {
    let captured: Record<string, unknown> | undefined;
    const execute = vi.fn(async () => ({
      content: JSON.stringify({
        choices: ["Follow the lanterns."],
        custom_action_suggestion: "Listen to the water.",
        image_prompt: "Moonlit canals beneath brass lanterns.",
      }),
      outputLimited: false,
    }));
    const providers = {
      resolution: {
        resolveDirect: vi.fn(async () => ({
          status: "resolved",
          requestedRole: "text",
          resolvedRole: "text",
          providerProfileId: "44444444-4444-4444-8444-444444444444",
          providerType: "openai_compatible",
          routingSource: "models",
          model: "text-model",
          fallbackModels: ["portable-fallback"],
          preset: null,
          providerPolicy: {},
        })),
      },
      execution: { text: vi.fn(async () => ({ execute })) },
      prompts: {
        loadInfiniteWorldsPromptSnapshot: vi.fn(async () => ({
          snapshot: { infinite_worlds_final_turn: { content: "Generate safe final choices." } },
        })),
      },
      promptTools: {
        content: vi.fn((_snapshot: unknown, key: string) => (
          key === "infinite_worlds_final_turn" ? "Generate safe final choices." : ""
        )),
      },
      generateCyoaWorld: vi.fn(),
    };
    await createApiPortableImportExportComposition({
      pool: {} as never,
      config: { archiveStorageRoot: "/archive", assetStorageRoot: "/assets" } as never,
      memory: {} as never,
      providers: providers as never,
      leaseOwner: "api-story-enrichment",
    }, {
      createWorlds: vi.fn(() => ({})) as never,
      createTargets: vi.fn(() => ({ readTargetWorldVersion: vi.fn() })) as never,
      createExports: vi.fn(() => ({ buildCampaignArchive: vi.fn(), buildWorldJson: vi.fn() })) as never,
      createProgress: vi.fn(() => ({
        begin: vi.fn(), update: vi.fn(), complete: vi.fn(), fail: vi.fn(), read: vi.fn(),
      })) as never,
      createComposition: vi.fn(async (options: Record<string, unknown>) => {
        captured = options;
        return { close: vi.fn(async () => undefined) } as never;
      }) as never,
    });

    const provider = (captured as { provider: Record<string, unknown> }).provider;
    expect(provider.enrichStoryFinalTurn).toBeTypeOf("function");
    const result = await (provider.enrichStoryFinalTurn as (input: unknown) => Promise<unknown>)({
      ownerUserId: "11111111-1111-4111-8111-111111111111",
      sourceName: "canals.story.txt",
      story: { world: { title: "Canals" }, turns: [{ action: "Listen", narration: "Water whispers." }] },
      providerSelection: {
        providerProfileId: "44444444-4444-4444-8444-444444444444",
        model: "text-model",
      },
    });

    expect(result).toMatchObject({
      metadata: { choices: ["Follow the lanterns."] },
      providerConfigurationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(providers.resolution.resolveDirect).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: "11111111-1111-4111-8111-111111111111",
      providerRole: "text",
      selectedProviderProfileId: "44444444-4444-4444-8444-444444444444",
      model: "text-model",
    }));
    expect(providers.execution.text).toHaveBeenCalledWith(
      { ownerUserId: "11111111-1111-4111-8111-111111111111" },
      expect.objectContaining({ model: "text-model", fallbackModels: ["portable-fallback"] }),
    );
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: "Generate safe final choices.",
    }));
  });

  it("passes the validated provider selection to a world-text conversion", async () => {
    const convertTemplate = vi.fn(async () => ({
      world: {
        format: "infinite-quest-world" as const,
        formatVersion: 1 as const,
        title: "Converted world",
        content: canonicalizeWorldContent({
          world: { title: "Converted world" },
          playableCharacters: [{ id: "hero", name: "Hero", characterText: "A traveler" }],
        }),
      },
      providerConfigurationFingerprint: "a".repeat(64),
    }));
    const previews = createPortableFamilyPreviewAdapter(
      { convertTemplate },
      { readTargetWorldVersion: vi.fn() },
    );
    const providerSelection = { providerProfileId: "11111111-1111-4111-8111-111111111111", model: "text-model" };

    await previews.previewWorldText(
      (async function* () { yield new TextEncoder().encode("A world of quiet canals."); })(),
      {
        ownerUserId: "22222222-2222-4222-8222-222222222222",
        stagedInput: "staged-input" as never,
        kind: "world_text",
        destination: { kind: "create_world" },
        providerSelection,
        progressKey: "world.txt:24",
      } as never,
    );

    expect(convertTemplate).toHaveBeenCalledWith(expect.objectContaining({
      providerSelection,
      progress: {
        owner: { ownerUserId: "22222222-2222-4222-8222-222222222222" },
        key: "world.txt:24",
      },
    }));
  });

  it("composes owner-scoped asset ports with one closeable secure storage adapter", async () => {
    const assets = { listAssets: vi.fn() };
    const storage = { close: vi.fn(async () => undefined) };
    const createRepositories = vi.fn(() => ({ library: {} }));
    const createApplication = vi.fn(() => assets);
    const createStorage = vi.fn(async () => storage);

    const composition = await createApiAssetComposition(
      {} as never,
      { archiveRoot: "/archive", assetRoot: "/assets" },
      { createRepositories, createApplication, createStorage } as never,
    );

    expect(createRepositories).toHaveBeenCalledWith({});
    expect(createApplication).toHaveBeenCalledWith({ library: {} });
    expect(createStorage).toHaveBeenCalledWith({}, { archiveRoot: "/archive", assetRoot: "/assets" });
    expect(composition.assets).toBe(assets);
    expect(composition.storage).toBe(storage);
    await composition.close();
    await composition.close();
    expect(storage.close).toHaveBeenCalledOnce();
  });

  it("binds the worker asset lane to the private maintenance composition instead of API asset authority", async () => {
    const worker = await readFile("services/worker/src/worker.ts", "utf8");

    expect(worker).toContain('from "../../runtime/src/private-asset-maintenance-composition.js"');
    expect(worker).not.toContain('from "../../api/src/asset-service.js"');
    expect(worker).toContain("createPrivateAssetMaintenanceComposition(");
    expect(worker).toMatch(/maintenance\.scheduler\.tick\(\s*\{\s*workerId,\s*leaseSeconds: config\.workerLeaseSeconds,\s*signal\s*\}\s*\)/su);
  });

  it("binds Infinite Worlds routes and progress lookup to the named durable API composition", async () => {
    const server = await readFile("services/api/src/server.ts", "utf8");

    expect(server).toContain('from "./portable-infinite-worlds-import-route.js"');
    expect(server).toContain("previewPortableInfiniteWorlds({");
    expect(server).toContain("importPortableInfiniteWorlds({");
    expect(server).toContain("apiPortable.progress.read(");
    expect(server).not.toContain("previewInfiniteWorldsImport(");
    expect(server).not.toContain("importInfiniteWorlds(");
    expect(server).not.toContain("getImportProgress(");
  });

  it("binds the worker image lane to durable illustration publication while retaining prompt and resolution handlers", async () => {
    const worker = await readFile("services/worker/src/worker.ts", "utf8");

    expect(worker).toContain('from "../../runtime/src/illustration-asset-publication-composition.js"');
    expect(worker).toContain("createPrivateIllustrationAssetPublicationComposition(");
    expect(worker).toContain("illustration.runPromptHandler(request)");
    expect(worker).toContain("illustration.runResolutionHandler(request)");
    expect(worker).toContain("illustrationPublication.coordinator.recoverNextFinalization(request)");
    expect(worker).toContain("runImageJob(pool, workerId, config.workerLeaseSeconds");
    expect(worker).toContain("illustrationPublication.coordinator");
  });

  it("allows only the worker's e3g maintenance consumer in the private maintenance graph", () => {
    const violations = checkPrivateAssetMaintenanceBoundaries(
      readPrivateCompositionParitySources(process.cwd()),
    );

    expect(violations).not.toContain(
      "services/worker/src/worker.ts: private asset-maintenance composition must remain unbound until e3g",
    );
  });
});
