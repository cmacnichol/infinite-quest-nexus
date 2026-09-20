import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { buildSourceExtractionPrompt, buildSourceWorldPrompt, CHARACTER_AUTHORING_PROMPT_PROTOCOL_VERSION, SOURCE_EXTRACTION_PROMPT_PROTOCOL_VERSION, SOURCE_WORLD_PROMPT_PROTOCOL_VERSION, WORLD_AUTHORING_PROMPT_PROTOCOL_VERSION } from "../../packages/domain/src/authoring-prompts.js";
import { normalizeSourceDocument } from "../../packages/domain/src/source-authoring.js";
import { planSourceChunks } from "../../packages/domain/src/source-authoring-budget.js";
import type { AuthoringClaim, AuthoringExecutionRepository } from "../../packages/application/src/authoring/ports.js";
import type { AuthoringExecutionSnapshot } from "../../packages/application/src/authoring/types.js";
import { authoringExecutionSnapshotSchema } from "../../packages/contracts/src/authoring.js";
import { normalizeTextSelection } from "../../packages/contracts/src/provider-selection.js";
import { getProviderOutputSchemaV2 } from "../../packages/contracts/src/provider-output-schema.js";
import type { SchemaVerificationV2 } from "../../packages/contracts/src/text-response-format.js";
import { createAuthoringExecutionSnapshot, createRuntimeAuthoringStageDispatcher, executeAuthoringStage } from "../../services/runtime/src/authoring-stage-adapter.js";
import { prepareAuthoringResponseContractExecution, prepareAuthoringTextExecution, prepareDirectAuthoringTextExecution } from "../../services/runtime/src/authoring-text-execution-preparation.js";
import { capabilityRouteConfigHash } from "../../services/runtime/src/provider-capability-cache.js";
import { createProviderResponseFormatCapabilities } from "../../services/runtime/src/provider-response-format-capabilities.js";
import type { ProviderResult } from "../../packages/story-engine/src/providers.js";
import { expandWorldCharacterSeed } from "../../services/runtime/src/provider-world-generation-adapter.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const descriptor = { id: "text-1", model: "model-pinned", contextWindowTokens: 8192, maxOutputTokens: 1024, requestTimeoutMs: 10_000, temperature: 0.7, configuration: {} };

const claim: AuthoringClaim = {
  jobId: "job-1", stageId: "stage-1", ownerUserId: "owner-1", jobGeneration: 0,
  stageGeneration: 1, leaseToken: "lease-1", leaseExpiresAt: "2026-09-06T00:00:00.000Z"
};

const snapshot: AuthoringExecutionSnapshot = {
  ...createAuthoringExecutionSnapshot(descriptor,
    { world_generation: "world prompt", world_generation_recovery: "world repair" },
    { world: WORLD_AUTHORING_PROMPT_PROTOCOL_VERSION, character: CHARACTER_AUTHORING_PROMPT_PROTOCOL_VERSION }, sha256)
};

function providerResult(content: string): ProviderResult {
  return { content, responseId: "response", finishReason: "stop", outputLimited: false, modelInstanceId: "test", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, reportedCost: null, rawMetadata: {} };
}

function characterContent(id = "durable-character") {
  return {
    id, name: "Iris", characterText: "Iris maps the shifting roads.",
    profile: { story: { role: "Cartographer", background: "Iris learned every lost road.", personality: "Careful.", motivations: "Keep travelers safe.", goals: "Find the vanished gate.", fearsAndConflicts: "The roads may erase her.", keyRelationships: "She trusts the keeper.", narrativeHooks: "Her map changes at dawn.", voiceAndMannerisms: "She speaks precisely.", otherGuidance: "" } }
  };
}

function runtimeStage(overrides: Partial<Parameters<ReturnType<typeof createRuntimeAuthoringStageDispatcher>>[0]> = {}) {
  return {
    input: { kind: "character" as const, idempotencyKey: "character-key", target: { kind: "new_world" as const }, prompt: "Create a capable cartographer.", content: { schemaVersion: 5, world: { title: "Roads", genre: "fantasy", tone: "hopeful", backgroundStory: "Roads move.", premise: "Map them.", firstAction: "Walk.", rules: "" }, playableCharacters: [], entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [], defaults: {} } },
    snapshot: { ...snapshot, prompts: { ...snapshot.prompts, character_generation: "Use {{protocol}} and return complete character JSON." } },
    stageKey: "character:durable-character", parentOutputs: [], ownerUserId: "owner-1", ...overrides
  } as Parameters<ReturnType<typeof createRuntimeAuthoringStageDispatcher>>[0];
}

describe("executeAuthoringStage", () => {
  it("resolves one inherited preset into every frozen authoring operation exactly once", async () => {
    const resolvePreset = vi.fn(async () => ({ slug: "story", name: "Story", versionId: "v1", version: 1, configHash: "a".repeat(64), config: { models: ["model-pinned"] }, systemPrompt: "Preset rules." }));
    const discoverModels = vi.fn(async () => [{ id: "model-pinned", contextWindowTokens: 8192, maxOutputTokens: 1024 }]);
    const prepared = await prepareAuthoringTextExecution({
      ownerUserId: "owner-1",
      execution: { ...descriptor, name: "Text", providerRole: "text", providerType: "openrouter", executionRevision: "ordinary", authorityRevision: "authority", textSelection: { kind: "openrouter_preset", slug: "story" }, execute: async () => providerResult("{}") },
      operationPrompts: { standaloneCharacter: "Create a cartographer.", worldOutline: "Create a world." },
      ports: { resolvePreset, discoverModels }
    });
    expect(resolvePreset).toHaveBeenCalledOnce();
    expect(discoverModels).toHaveBeenCalledOnce();
    expect(prepared.plans.standaloneCharacter!.prompt).toBe("Preset rules.\n\nCreate a cartographer.");
    expect(prepared.plans.worldOutline!.prompt).toBe("Preset rules.\n\nCreate a world.");
    expect(prepared.plans.standaloneCharacter!.authorityRevision).toBe("authority");
    expect(prepared.plans.standaloneCharacter!.requestTimeoutMs).toBe(10_000);
  });

  it("rejects v2 preparation without current authority evidence", async () => {
    await expect(prepareAuthoringTextExecution({
      ownerUserId: "owner-1",
      execution: { ...descriptor, name: "Text", providerRole: "text", providerType: "openrouter", textSelection: { kind: "model", modelId: "model-pinned" }, execute: async () => providerResult("{}") },
      operationPrompts: { standaloneCharacter: "Create a cartographer." },
      ports: { resolvePreset: async () => { throw new Error("unused"); }, discoverModels: async () => [{ id: "model-pinned", contextWindowTokens: 8192, maxOutputTokens: 1024 }] }
    })).rejects.toThrow("authority revisions");
  });

  it("fails closed before direct dispatch when the frozen authority changes", async () => {
    const execute = vi.fn(async () => providerResult("{}"));
    const prepared = await prepareDirectAuthoringTextExecution({
      ownerUserId: "owner-1",
      execution: { ...descriptor, name: "Text", providerRole: "text", providerType: "openrouter", executionRevision: "ordinary", authorityRevision: "authority-a", textSelection: { kind: "openrouter_preset", slug: "story" }, execute: async () => providerResult("{}") },
      operationPrompts: { worldOutline: "Create a world." },
      options: {
        nativePresetPlansEnabled: true,
        preparedExecutor: { execute },
        loadAuthority: async () => ({ id: "text-1", providerRole: "text", authorityRevision: "authority-b" }),
        ports: {
          resolvePreset: async () => ({ slug: "story", name: "Story", versionId: "v1", version: 1, configHash: "a".repeat(64), config: { models: ["model-pinned"] }, systemPrompt: "Preset rules." }),
          discoverModels: async () => [{ id: "model-pinned", contextWindowTokens: 8192, maxOutputTokens: 1024 }]
        }
      }
    });
    await expect(prepared!.execute({ operation: "worldOutline", request: { systemPrompt: "ignored", input: "{}" } })).rejects.toThrow("authority");
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses explicit direct models without preset lookup and resolves explicit preset aliases", async () => {
    const profileId = "22222222-2222-4222-8222-222222222222";
    const getPreset = vi.fn(async ({ slug }: { slug: string }) => ({ slug, name: slug, versionId: "v1", version: 1, configHash: "a".repeat(64), config: { models: ["preset-model"] }, systemPrompt: `${slug} instructions.` }));
    const discoverModels = vi.fn(async ({ modelIds }: { modelIds: readonly string[] }) => modelIds.map((id) => ({
      id, contextWindowTokens: 8192, maxOutputTokens: 1024,
      responseFormatAdvertisement: {
        supportedParameters: ["response_format", "structured_outputs"],
        discoveredAt: "2026-09-20T00:00:00.000Z"
      }
    })));
    const captured: Array<{ plan: { selection: unknown } }> = [];
    const execute = vi.fn(async (input: { plan: { selection: unknown } }) => { captured.push(input); return providerResult("{}"); });
    const verification: SchemaVerificationV2 = {
      version: 2, providerType: "openrouter", endpointIdentity: "native-endpoint", model: "explicit-model",
      routeConfigHash: capabilityRouteConfigHash({}), adapterProtocol: "text-schema-adapter-v2",
      operation: "world_outline", schemaHash: getProviderOutputSchemaV2("world_outline").schemaHash,
      streaming: false, verifiedAt: "2026-09-19T00:00:00.000Z", expiresAt: "2027-09-19T00:00:00.000Z",
      providerRoutingSlugs: ["openai"], nativeOpenTrackerObjects: true
    };
    const options = {
      nativePresetPlansEnabled: true, preparedExecutor: { execute },
      loadAuthority: async () => ({ id: profileId, providerRole: "text" as const, endpointIdentity: "native-endpoint", authorityRevision: "authority" }),
      ports: { resolvePreset: getPreset, discoverModels },
      responseFormatCapabilities: createProviderResponseFormatCapabilities({ records: [verification], now: () => Date.parse("2026-09-20T00:00:00.000Z") })
    };
    const execution = {
      ...descriptor, id: profileId, endpointIdentity: "native-endpoint", name: "Text", providerRole: "text" as const,
      providerType: "openrouter" as const, executionRevision: "ordinary", authorityRevision: "authority",
      textSelection: { kind: "openrouter_preset" as const, slug: "inherited" }, execute: async () => providerResult("{}")
    };
    const direct = await prepareDirectAuthoringTextExecution({ ownerUserId: "owner-1", execution, operationPrompts: { worldOutline: "Create a world." }, options, selectionOverride: { kind: "model", modelId: "explicit-model" } });
    await direct!.execute({ operation: "worldOutline", request: { systemPrompt: "ignored", input: "{}" } });
    expect(getPreset).not.toHaveBeenCalled();
    expect(captured[0]?.plan.selection).toEqual({ kind: "model", modelId: "explicit-model" });

    const alias = normalizeTextSelection({ providerType: "openrouter", providerRole: "text", defaultModel: "@preset/explicit" });
    const preset = await prepareDirectAuthoringTextExecution({ ownerUserId: "owner-1", execution, operationPrompts: { worldOutline: "Create a world." }, options, selectionOverride: alias });
    await preset!.execute({ operation: "worldOutline", request: { systemPrompt: "ignored", input: "{}" } });
    expect(getPreset).toHaveBeenCalledWith(expect.objectContaining({ slug: "explicit" }));
    expect(captured[1]?.plan.selection).toEqual({ kind: "openrouter_preset", slug: "explicit" });
  });
  it("preserves the synchronous seed prompt field names in the shared expansion seam", async () => {
    let sentSeed: unknown;
    const seed = { id: "durable-character", name: "Iris", role: "Cartographer", concept: "Maps shifting roads.", narrativeHook: "Her map changes at dawn." };
    await expandWorldCharacterSeed({
      provider: { execute: async (request) => {
        sentSeed = JSON.parse(request.input).seed;
        return providerResult(JSON.stringify({ ...characterContent(), character_text: "Iris maps roads.", rpg_statistics: [], default_triggers: [] }));
      } },
      outline: { title: "Roads", genre: "Fantasy", tone: "Hopeful", backgroundStory: "Roads move.", premise: "Map them.", firstAction: "Walk.", rules: "Keep promises.", seeds: [seed], rpgStats: [], defaultTriggers: [], eventTriggers: [] },
      seed, characterIndex: 0, acceptedCharacterNames: [], prompt: "Expand the seed.", repairPrompt: "Repair the seed."
    });
    expect(sentSeed).toEqual({ id: seed.id, name: seed.name, role: seed.role, concept: seed.concept, narrative_hook: seed.narrativeHook });
  });
  it("hashes only the approved text execution projection", () => {
    const base = {
      id: "text-1", model: "model-pinned", contextWindowTokens: 8192, maxOutputTokens: 1024,
      requestTimeoutMs: 10_000, temperature: 0.7, endpointIdentity: "endpoint-fingerprint", configuration: { httpReferer: "https://nexus.test", modelDiscoveryEnabled: true }
    };
    const hash = sha256;
    const left = createAuthoringExecutionSnapshot(base, { world: "prompt" }, { authoring: "v1" }, hash);
    const right = createAuthoringExecutionSnapshot({ ...base, configuration: { httpReferer: "https://nexus.test", modelDiscoveryEnabled: false } }, { world: "prompt" }, { authoring: "v1" }, hash);
    expect(left.configurationHash).toEqual(right.configurationHash);
    expect(JSON.stringify(left)).not.toContain("modelDiscoveryEnabled");
    expect(left).toMatchObject({ providerProfileId: "text-1", model: "model-pinned" });
    const changedTemperature = createAuthoringExecutionSnapshot({ ...base, temperature: 0.9 }, { world: "prompt" }, { authoring: "v1" }, hash);
    expect(changedTemperature.configurationHash).not.toEqual(left.configurationHash);
  });

  it("accepts a private v2 per-operation text plan while preserving a literal v1 snapshot", () => {
    const v1 = authoringExecutionSnapshotSchema.parse(snapshot);
    const plan = {
      version: 2,
      selection: { kind: "model", modelId: "model-pinned" },
      preset: null,
      candidates: [{ modelId: "model-pinned", providerPolicy: {}, contextWindowTokens: 8192, maxOutputTokens: 1024 }],
      presetSystemPrompt: "Preset instructions.",
      parameters: { temperature: 0.7 },
      prompt: "Preset instructions.\n\nCreate a capable cartographer.",
      promptHash: "a".repeat(64),
      endpointReference: "endpoint-1",
      credentialReference: "credential-1",
      profileRevision: "profile-1",
      protocolVersion: "authoring-v2",
      planHash: "b".repeat(64)
    };
    const v2 = authoringExecutionSnapshotSchema.parse({
      ...snapshot,
      version: 2,
      textExecutionPlans: { standaloneCharacter: plan }
    });

    expect(v1).not.toHaveProperty("version");
    expect(v2).toMatchObject({ version: 2, textExecutionPlans: { standaloneCharacter: { prompt: plan.prompt } } });
  });

  it("freezes supplied operation plans into a v2 authoring snapshot", () => {
    const parsed = authoringExecutionSnapshotSchema.parse({
      ...snapshot,
      version: 2,
      textExecutionPlans: {
        standaloneCharacter: {
          version: 2, selection: { kind: "model", modelId: "model-pinned" }, preset: null,
          candidates: [{ modelId: "model-pinned", providerPolicy: {}, contextWindowTokens: 8192, maxOutputTokens: 1024 }],
          presetSystemPrompt: "", parameters: {}, prompt: "Frozen prompt.", promptHash: "a".repeat(64),
          endpointReference: "endpoint-1", credentialReference: null, profileRevision: "profile-1", protocolVersion: "authoring-v2", planHash: "b".repeat(64)
        }
      }
    });
    if (!("textExecutionPlans" in parsed)) throw new Error("Expected v2 plan fixture.");
    const plan = parsed.textExecutionPlans;
    const frozen = createAuthoringExecutionSnapshot(descriptor, { character_generation: "legacy" }, { character: "v1" }, sha256, plan);
    expect(frozen).toMatchObject({ version: 2, textExecutionPlans: { standaloneCharacter: { prompt: "Frozen prompt." } } });
  });

  it("loads the pinned claim and dispatches only its missing stage", async () => {
    const executedStageKeys: string[] = [];
    const repository: Pick<AuthoringExecutionRepository, "loadClaim"> = {
      loadClaim: async () => ({
        input: { kind: "world_concept", idempotencyKey: "key", target: { kind: "new_world" }, prompt: "a haunted coast" },
        snapshot,
        stageKey: "world",
        parentOutputs: []
      })
    };

    const output = await executeAuthoringStage({
      claim,
      repository,
      dispatch: async (loaded) => {
        executedStageKeys.push(loaded.stageKey);
        return {
          kind: "outline",
          outline: {
            title: "The Coast", genre: "Gothic", tone: "Ominous", backgroundStory: "Storms hide old debts.",
            premise: "Find the missing bell.", firstAction: "Enter the tide caves.", rules: "Keep promises.",
            seeds: [], rpgStats: [], defaultTriggers: [], eventTriggers: []
          }
        };
      }
    });

    expect(executedStageKeys).toEqual(["world"]);
    expect(output).toMatchObject({ kind: "outline", outline: { title: "The Coast" } });
  });

  it("does not dispatch after a lost or cancelled claim", async () => {
    let calls = 0;
    await expect(executeAuthoringStage({
      claim,
      repository: { loadClaim: async () => null },
      dispatch: async () => { calls += 1; throw new Error("must not execute"); }
    })).resolves.toBeNull();
    expect(calls).toBe(0);
  });

  it("captures a snapshot once before the first dispatch and reloads the pinned claim", async () => {
    let loadCount = 0;
    let resolved = 0;
    let captured: AuthoringExecutionSnapshot | undefined;
    const result = await executeAuthoringStage({
      claim,
      repository: {
        loadClaim: async () => {
          loadCount += 1;
          return loadCount === 1 ? null : {
            input: { kind: "world_concept", idempotencyKey: "key", target: { kind: "new_world" }, prompt: "a haunted coast" },
            snapshot,
            stageKey: "world",
            parentOutputs: []
          };
        },
        readClaimInput: async () => ({ kind: "world_concept", idempotencyKey: "key", target: { kind: "new_world" }, prompt: "a haunted coast" }),
        initializeExecutionSnapshot: async (_claim, value) => { captured = value; return value; }
      },
      resolveSnapshot: async () => { resolved += 1; return snapshot; },
      dispatch: async () => ({ kind: "outline", outline: {
        title: "The Coast", genre: "Gothic", tone: "Ominous", backgroundStory: "Storms hide old debts.",
        premise: "Find the bell.", firstAction: "Enter the caves.", rules: "Keep promises.",
        seeds: [], rpgStats: [], defaultTriggers: [], eventTriggers: []
      } })
    });
    expect(resolved).toBe(1);
    expect(captured).toEqual(snapshot);
    expect(result).toMatchObject({ kind: "outline" });
  });

  it("uses the pinned provider and persisted standalone ID instead of an outline seed or current default", async () => {
    const calls: Array<{ profileId: string; model: string; request: unknown }> = [];
    const execution = {
      text: async (_scope: unknown, profileId: string, _role: string, model?: string) => ({
        id: profileId, model: model!, contextWindowTokens: 8192, maxOutputTokens: 1024, requestTimeoutMs: 10_000,
        temperature: 0.7, configuration: {}, endpointIdentity: undefined,
        execute: async (request: unknown) => { calls.push({ profileId, model: model!, request }); return providerResult(JSON.stringify(characterContent())); }
      })
    } as never;
    const dispatch = createRuntimeAuthoringStageDispatcher({ execution, sha256 });
    const output = await dispatch(runtimeStage());
    expect(output).toMatchObject({ kind: "character", character: { id: "durable-character", name: "Iris" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ profileId: "text-1", model: "model-pinned" });
  });

  it("reuses the pinned effective context cap when loading a provider for a resumed stage", async () => {
    const text = vi.fn(async () => ({
      ...descriptor,
      execute: async () => providerResult(JSON.stringify(characterContent()))
    }));
    const dispatch = createRuntimeAuthoringStageDispatcher({ execution: { text } as never, sha256 });

    await dispatch(runtimeStage());

    expect(text).toHaveBeenCalledWith(
      { ownerUserId: "owner-1" },
      "text-1",
      "text",
      "model-pinned",
      snapshot.contextWindowTokens
    );
  });

  it("uses the pinned source provider before rejecting an invalid source stage", async () => {
    const text = vi.fn(async () => ({ ...descriptor, execute: async () => providerResult(JSON.stringify({ facts: [] })) }));
    const dispatch = createRuntimeAuthoringStageDispatcher({ execution: { text } as never, sha256 });

    await expect(dispatch(runtimeStage({
      input: {
        kind: "story_source", idempotencyKey: "source-key", target: { kind: "new_world" },
        name: "chapter.txt", text: "A chapter.", mode: "faithful", boundaryParagraphId: "paragraph:0", instructions: ""
      },
      stageKey: "source"
    }))).rejects.toMatchObject({ authoringFailure: { code: "source_evidence_invalid", stage: "source", retryable: false } });

    expect(text).toHaveBeenCalledWith({ ownerUserId: "owner-1" }, "text-1", "text", "model-pinned", snapshot.contextWindowTokens);
  });

  it("forwards the durable claim from a source chunk stage before extraction can accept output", async () => {
    const source = normalizeSourceDocument("chapter.txt", "Iris fastened her blue coat.", "job-1");
    const chunk = planSourceChunks({
      source,
      boundaryParagraphId: source.paragraphs[0]!.id,
      systemPrompt: "Extract cited source facts.",
      instructions: "",
      budget: { contextWindowTokens: descriptor.contextWindowTokens, maxOutputTokens: descriptor.maxOutputTokens, countTokens: (value) => new TextEncoder().encode(value).length }
    })[0]!;
    const execute = vi.fn(async () => providerResult(JSON.stringify({ facts: [] })));
    const currentClaim = vi.fn(async () => false);
    const dispatch = createRuntimeAuthoringStageDispatcher({
      execution: { text: async () => ({ ...descriptor, providerType: "lmstudio" as const, execute }) } as never,
      sha256
    });

    await expect(dispatch(runtimeStage({
      input: {
        kind: "story_source", idempotencyKey: "source-key", target: { kind: "new_world" },
        name: "chapter.txt", text: source.text, mode: "faithful", boundaryParagraphId: source.paragraphs[0]!.id, instructions: ""
      },
      snapshot: { ...snapshot, protocols: { ...snapshot.protocols, source: SOURCE_EXTRACTION_PROMPT_PROTOCOL_VERSION } },
      stageKey: `source:chunk:${chunk.id}`,
      parentOutputs: [{ kind: "source_plan", chunks: [{
        ...chunk,
        sourceRange: { ...chunk.sourceRange },
        spans: chunk.spans.map((span) => ({ ...span }))
      }] }],
      jobId: "job-1",
      currentClaim
    }))).rejects.toMatchObject({ authoringFailure: { code: "authoring_cancelled", stage: "source", retryable: false } });

    expect(currentClaim).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["source-extraction-v2-absolute-code-points", "source-extraction-v3-quote-anchor", "source-extraction-v4-labelled-paragraphs", "source-extraction-v5-contiguous-quotes"])("does not send a resumed source chunk with older protocol %s to the provider", async (sourceProtocol) => {
    const source = normalizeSourceDocument("chapter.txt", "Iris fastened her blue coat.", "job-1");
    const chunk = planSourceChunks({
      source,
      boundaryParagraphId: source.paragraphs[0]!.id,
      systemPrompt: "Extract cited source facts.",
      instructions: "",
      budget: { contextWindowTokens: descriptor.contextWindowTokens, maxOutputTokens: descriptor.maxOutputTokens, countTokens: (value) => new TextEncoder().encode(value).length }
    })[0]!;
    const execute = vi.fn(async () => providerResult(JSON.stringify({ facts: [] })));
    const dispatch = createRuntimeAuthoringStageDispatcher({
      execution: { text: async () => ({ ...descriptor, providerType: "lmstudio" as const, execute }) } as never,
      sha256
    });

    await expect(dispatch(runtimeStage({
      input: {
        kind: "story_source", idempotencyKey: "source-key", target: { kind: "new_world" },
        name: "chapter.txt", text: source.text, mode: "faithful", boundaryParagraphId: source.paragraphs[0]!.id, instructions: ""
      },
      snapshot: { ...snapshot, protocols: { ...snapshot.protocols, source: sourceProtocol } },
      stageKey: `source:chunk:${chunk.id}`,
      parentOutputs: [{ kind: "source_plan", chunks: [{
        ...chunk,
        sourceRange: { ...chunk.sourceRange },
        spans: chunk.spans.map((span) => ({ ...span }))
      }] }],
      jobId: "job-1"
    }))).rejects.toMatchObject({ authoringFailure: { code: "source_evidence_invalid", stage: "source", retryable: false } });

    expect(execute).not.toHaveBeenCalled();
  });

  it("does not send a resumed source-world stage with an older closed-mapping protocol to the provider", async () => {
    const source = normalizeSourceDocument("chapter.txt", "Iris wears a blue coat.", "job-1");
    const iris = {
      id: "source-fact:iris", kind: "character" as const, subject: "Iris", predicate: "clothing", value: "blue coat", provenance: "stated" as const,
      citations: [{ sourceId: source.id, paragraphId: "paragraph:0", start: 0, end: source.paragraphs[0]!.end, quote: source.text }]
    };
    const execute = vi.fn(async () => providerResult(JSON.stringify({ fields: [], characterFields: [] })));
    const dispatch = createRuntimeAuthoringStageDispatcher({
      execution: { text: async () => ({ ...descriptor, execute }) } as never,
      sha256
    });

    await expect(dispatch(runtimeStage({
      input: { kind: "story_source", idempotencyKey: "source-key", target: { kind: "new_world" }, name: "chapter.txt", text: source.text, mode: "faithful", boundaryParagraphId: "paragraph:0", instructions: "" },
      snapshot: { ...snapshot, protocols: { ...snapshot.protocols, source: SOURCE_EXTRACTION_PROMPT_PROTOCOL_VERSION, sourceWorld: "source-world-v1" } },
      stageKey: "source:synthesis",
      sourceSelection: { source, boundaryParagraphId: "paragraph:0", acceptedFacts: [iris], selectedCharacterFactIds: [iris.id], characterIdentityGroups: [{ representativeFactId: iris.id, factIds: [iris.id] }], mode: "faithful", reviewGeneration: 1 }
    }))).rejects.toMatchObject({ authoringFailure: { code: "source_evidence_invalid", stage: "source", retryable: false } });

    expect(execute).not.toHaveBeenCalled();
  });

  it("runs a selected source character stage over the complete reviewed selection", async () => {
    const source = normalizeSourceDocument("chapter.txt", "Iris wears a blue coat.", "job-1");
    const iris = {
      id: "source-fact:iris", kind: "character" as const, subject: "Iris", predicate: "clothing", value: "blue coat", provenance: "stated" as const,
      citations: [{ sourceId: source.id, paragraphId: "paragraph:0", start: 0, end: 23, quote: source.text }]
    };
    let requestInput: unknown;
    const dispatch = createRuntimeAuthoringStageDispatcher({
      execution: { text: async () => ({ ...descriptor, execute: async (request: { input: string }) => {
        requestInput = JSON.parse(request.input);
        return providerResult(JSON.stringify({ fields: [], characterFields: [{ selectedCharacterFactId: iris.id, fields: [{ path: "profile.appearance.clothing", value: "blue coat", supportingFactIds: [iris.id] }] }] }));
      } }) } as never,
      sha256
    });

    const output = await dispatch(runtimeStage({
      input: { kind: "story_source", idempotencyKey: "source-key", target: { kind: "new_world" }, name: "chapter.txt", text: source.text, mode: "faithful", boundaryParagraphId: "paragraph:0", instructions: "Use reviewed facts." },
      snapshot: { ...snapshot, protocols: { ...snapshot.protocols, source: SOURCE_EXTRACTION_PROMPT_PROTOCOL_VERSION, sourceWorld: SOURCE_WORLD_PROMPT_PROTOCOL_VERSION } },
      stageKey: `source:character:${iris.id}`,
      sourceSelection: { source, boundaryParagraphId: "paragraph:0", acceptedFacts: [iris], selectedCharacterFactIds: [iris.id], characterIdentityGroups: [{ representativeFactId: iris.id, factIds: [iris.id] }], mode: "faithful", reviewGeneration: 3 }
    }));

    expect(requestInput).toMatchObject({ acceptedFacts: [expect.objectContaining({ id: iris.id })], selectedCharacterFactIds: [iris.id], reviewGeneration: 3 });
    expect(output).toMatchObject({ kind: "source_world", proposal: { world: { title: "chapter.txt" }, playableCharacters: [expect.objectContaining({ name: "Iris", profile: expect.objectContaining({ appearance: expect.objectContaining({ clothing: "blue coat", apparentAge: "" }) }) })] } });
  });

  it.each([
    ["preset", "faithful", "extraction"], ["preset", "expand", "extraction"],
    ["preset", "faithful", "synthesis"], ["preset", "expand", "synthesis"],
    ["preset", "faithful", "character"], ["preset", "expand", "character"],
    ["model", "faithful", "extraction"], ["model", "expand", "extraction"],
    ["model", "faithful", "synthesis"], ["model", "expand", "synthesis"],
    ["model", "faithful", "character"], ["model", "expand", "character"]
  ] as const)("dispatches bound %s %s source %s initial and repair contracts through the actual stage caller", async (routeKind, mode, consumer) => {
    const source = normalizeSourceDocument("chapter.txt", "Iris wears a blue coat.", `job-${mode}-${consumer}`);
    const iris = {
      id: "source-fact:iris", kind: "character" as const, subject: "Iris", predicate: "clothing", value: "blue coat", provenance: "stated" as const,
      citations: [{ sourceId: source.id, paragraphId: source.paragraphs[0]!.id, start: 0, end: source.paragraphs[0]!.end, quote: source.text }]
    };
    const selection = {
      source, boundaryParagraphId: source.paragraphs[0]!.id, acceptedFacts: [iris], selectedCharacterFactIds: [iris.id],
      characterIdentityGroups: [{ representativeFactId: iris.id, factIds: [iris.id] }], mode, reviewGeneration: 3
    };
    const extractionPrompt = (repair: boolean) => buildSourceExtractionPrompt({
      instructions: "", sourceText: "", mode,
      chunk: { sourceRange: { start: 0, end: 0 }, paragraphSpans: [] }, repair
    }).systemPrompt;
    const worldPrompt = (repair: boolean) => buildSourceWorldPrompt({
      instructions: "", reviewGeneration: 0,
      selection: { source: { id: "snapshot", name: "snapshot", sha256: "0".repeat(64) }, boundaryParagraphId: "snapshot", acceptedFacts: [], selectedCharacterFactIds: [], characterIdentityGroups: [], mode },
      repair
    }).systemPrompt;
    const initialOperation = consumer === "extraction" ? "sourceExtraction" : consumer === "synthesis" ? "sourceSynthesis" : "sourceCharacter";
    const repairOperation = consumer === "extraction" ? "sourceExtractionRepair" : consumer === "synthesis" ? "sourceSynthesisRepair" : "sourceCharacterRepair";
    const initialPrompt = consumer === "extraction" ? extractionPrompt(false) : worldPrompt(false);
    const repairPrompt = consumer === "extraction" ? extractionPrompt(true) : worldPrompt(true);
    const nativeProvider = {
      ...descriptor, id: "00000000-0000-4000-8000-000000000031", name: "Native source", providerRole: "text" as const,
      providerType: "openrouter" as const, model: "source-model", endpointIdentity: "source-endpoint", executionRevision: "ordinary-source",
      authorityRevision: "authority-source", textSelection: routeKind === "preset" ? { kind: "openrouter_preset" as const, slug: "source" } : { kind: "model" as const, modelId: "source-model" },
      execute: async () => { throw new Error("legacy source execution must not run"); }
    };
    const schemaOperation = consumer === "extraction" ? "source_extraction" : consumer === "synthesis" ? "source_synthesis" : "source_character";
    const verification: SchemaVerificationV2 = {
      version: 2, providerType: "openrouter", endpointIdentity: "source-endpoint", model: "source-model",
      routeConfigHash: capabilityRouteConfigHash({}), adapterProtocol: "text-schema-adapter-v2",
      operation: schemaOperation, schemaHash: getProviderOutputSchemaV2(schemaOperation).schemaHash,
      streaming: false, verifiedAt: "2026-09-19T00:00:00.000Z", expiresAt: "2027-09-19T00:00:00.000Z",
      providerRoutingSlugs: [], nativeOpenTrackerObjects: true
    };
    const resolvePreset = vi.fn(async () => ({ slug: "source", name: "Source", versionId: "source-v1", version: 1, configHash: "a".repeat(64), config: { models: ["source-model"] }, systemPrompt: "Frozen source preset." }));
    const prepared = await prepareAuthoringResponseContractExecution({
      ownerUserId: "owner-1", execution: nativeProvider,
      operationPrompts: { [initialOperation]: initialPrompt, [repairOperation]: repairPrompt },
      ports: {
        resolvePreset,
        discoverModels: async () => [{ id: "source-model", contextWindowTokens: 8192, maxOutputTokens: 1024,
          ...(routeKind === "model" ? { responseFormatAdvertisement: { supportedParameters: ["response_format", "structured_outputs"], discoveredAt: "2026-09-20T00:00:00.000Z" } } : {}) }]
      },
      ...(routeKind === "model" ? { responseFormatCapabilities: createProviderResponseFormatCapabilities({ records: [verification], now: () => Date.parse("2026-09-20T00:00:00.000Z") }) } : {})
    });
    const fullSnapshot = createAuthoringExecutionSnapshot(nativeProvider, {}, {
      source: SOURCE_EXTRACTION_PROMPT_PROTOCOL_VERSION, sourceWorld: SOURCE_WORLD_PROMPT_PROTOCOL_VERSION
    }, sha256, prepared);
    const chunk = planSourceChunks({
      source, boundaryParagraphId: source.paragraphs[0]!.id, systemPrompt: initialPrompt, instructions: "Use reviewed facts.",
      budget: { contextWindowTokens: descriptor.contextWindowTokens, maxOutputTokens: descriptor.maxOutputTokens, countTokens: (value) => new TextEncoder().encode(value).length }
    })[0]!;
    const calls: any[] = [];
    const preparedExecutor = vi.fn(async (input: any) => {
      calls.push(input);
      if (calls.length === 1) return providerResult("not json");
      if (consumer === "extraction") return providerResult(JSON.stringify({ facts: [] }));
      if (consumer === "synthesis") return providerResult(JSON.stringify({ fields: [], characterFields: [] }));
      return providerResult(JSON.stringify({ fields: [], characterFields: [{ selectedCharacterFactId: iris.id, fields: [{ path: "profile.appearance.clothing", value: "blue coat", supportingFactIds: [iris.id] }] }] }));
    });
    const dispatch = createRuntimeAuthoringStageDispatcher({
      execution: { text: async () => nativeProvider } as never, sha256, preparedExecutor: { execute: preparedExecutor }
    });
    const stageKey = consumer === "extraction" ? `source:chunk:${chunk.id}` : consumer === "synthesis" ? "source:synthesis" : `source:character:${iris.id}`;
    const output = await dispatch(runtimeStage({
      input: { kind: "story_source", idempotencyKey: `source-${mode}-${consumer}`, target: { kind: "new_world" }, name: source.name, text: source.text, mode, boundaryParagraphId: source.paragraphs[0]!.id, instructions: "Use reviewed facts." },
      snapshot: fullSnapshot, stageKey,
      ...(consumer === "extraction" ? { parentOutputs: [{ kind: "source_plan", chunks: [{ ...chunk, sourceRange: { ...chunk.sourceRange }, spans: chunk.spans.map((span) => ({ ...span })) }] }] } : { sourceSelection: selection }),
      jobId: `job-${mode}-${consumer}`
    }));
    expect(output.kind).toBe(consumer === "extraction" ? "source_extraction" : "source_world");
    expect(calls.map((call) => call.operation)).toEqual([
      consumer === "extraction" ? "source_extraction" : consumer === "synthesis" ? "source_synthesis" : "source_character",
      consumer === "extraction" ? "source_extraction_repair" : consumer === "synthesis" ? "source_synthesis_repair" : "source_character_repair"
    ]);
    expect(calls.map((call) => call.invocationKey)).toEqual([
      `${consumer === "extraction" ? "source_extraction" : consumer === "synthesis" ? "source_synthesis" : "source_character"}:nonstream`,
      `${consumer === "extraction" ? "source_extraction" : consumer === "synthesis" ? "source_synthesis" : "source_character"}:nonstream`
    ]);
    for (const [index, call] of calls.entries()) {
      const body = JSON.parse(call.preparedRequest.body);
      expect(body.response_format.json_schema.name).toBe(getProviderOutputSchemaV2(schemaOperation).name);
      expect(body.messages[0].content).toBe(index === 0 ? prepared.plans[initialOperation]!.prompt : prepared.plans[repairOperation]!.prompt);
      expect(body.messages.filter((message: any) => message.content === (index === 0 ? prepared.plans[initialOperation]!.prompt : prepared.plans[repairOperation]!.prompt))).toHaveLength(1);
      expect(call.preparedRequest.budgetAudit).toMatchObject({ countMode: "estimated", outputReserveTokens: 1024 });
      expect(call.frozenResponseContracts.contracts[`${schemaOperation}:nonstream`].admission.basis).toBe(routeKind === "model" ? "model_verified" : "preset_trusted");
    }
    expect(resolvePreset).toHaveBeenCalledTimes(routeKind === "preset" ? 1 : 0);
  });

  it.each(["synthesis", "character"] as const)("reclaims historical v2 source %s initial and repair plans through the actual caller", async (consumer) => {
    const source = normalizeSourceDocument("chapter.txt", "Iris wears a blue coat.", "legacy-" + consumer);
    const iris = {
      id: "source-fact:iris", kind: "character" as const, subject: "Iris", predicate: "clothing", value: "blue coat", provenance: "stated" as const,
      citations: [{ sourceId: source.id, paragraphId: source.paragraphs[0]!.id, start: 0, end: source.paragraphs[0]!.end, quote: source.text }]
    };
    const legacyProvider = {
      ...descriptor, id: "00000000-0000-4000-8000-000000000041", name: "Legacy source", providerRole: "text" as const,
      providerType: "openrouter" as const, model: "legacy-source-model", endpointIdentity: "legacy-source-endpoint",
      executionRevision: "legacy-source-profile", authorityRevision: "legacy-source-authority",
      textSelection: { kind: "openrouter_preset" as const, slug: "legacy-source" },
      execute: async () => { throw new Error("legacy provider execute must not run"); }
    };
    const prepared = await prepareAuthoringTextExecution({
      ownerUserId: "owner-1", execution: legacyProvider,
      operationPrompts: { sourceWorld: "Frozen legacy source prompt.", sourceWorldRepair: "Frozen legacy source repair prompt." },
      ports: {
        resolvePreset: async () => ({ slug: "legacy-source", name: "Legacy source", versionId: "legacy-v1", version: 1, configHash: "b".repeat(64), config: { models: ["legacy-source-model"] }, systemPrompt: "Legacy source preset." }),
        discoverModels: async () => [{ id: "legacy-source-model", contextWindowTokens: 8192, maxOutputTokens: 1024 }]
      }
    });
    const legacySnapshot = createAuthoringExecutionSnapshot(legacyProvider, {}, {
      source: SOURCE_EXTRACTION_PROMPT_PROTOCOL_VERSION, sourceWorld: SOURCE_WORLD_PROMPT_PROTOCOL_VERSION
    }, sha256, prepared.plans as never);
    expect(legacySnapshot).toMatchObject({ version: 2, textExecutionPlans: { sourceWorld: {}, sourceWorldRepair: {} } });
    const calls: any[] = [];
    const preparedExecutor = vi.fn(async (input: any) => {
      calls.push(input);
      if (calls.length === 1) return providerResult("not json");
      return consumer === "synthesis"
        ? providerResult(JSON.stringify({ fields: [], characterFields: [] }))
        : providerResult(JSON.stringify({ fields: [], characterFields: [{ selectedCharacterFactId: iris.id, fields: [{ path: "profile.appearance.clothing", value: "blue coat", supportingFactIds: [iris.id] }] }] }));
    });
    const dispatch = createRuntimeAuthoringStageDispatcher({
      execution: { text: async () => legacyProvider } as never, sha256,
      preparedExecutor: { execute: preparedExecutor }
    });
    const output = await dispatch(runtimeStage({
      input: { kind: "story_source", idempotencyKey: "legacy-" + consumer, target: { kind: "new_world" }, name: source.name, text: source.text, mode: "faithful", boundaryParagraphId: source.paragraphs[0]!.id, instructions: "" },
      snapshot: legacySnapshot,
      stageKey: consumer === "synthesis" ? "source:synthesis" : "source:character:" + iris.id,
      sourceSelection: {
        source, boundaryParagraphId: source.paragraphs[0]!.id, acceptedFacts: [iris], selectedCharacterFactIds: [iris.id],
        characterIdentityGroups: [{ representativeFactId: iris.id, factIds: [iris.id] }], mode: "faithful", reviewGeneration: 1
      },
      jobId: "legacy-" + consumer
    }));
    expect(output.kind).toBe("source_world");
    expect(calls.map((call) => call.operation)).toEqual(["sourceWorld", "sourceWorldRepair"]);
    expect(calls.map((call) => call.request.systemPrompt)).toEqual([
      prepared.plans.sourceWorld!.prompt, prepared.plans.sourceWorldRepair!.prompt
    ]);
  });

  it("reclaims a historical v2 standalone repair through its single frozen operation plan", async () => {
    const legacyProvider = {
      ...descriptor, id: "00000000-0000-4000-8000-000000000042", name: "Legacy standalone", providerRole: "text" as const,
      providerType: "openrouter" as const, endpointIdentity: "legacy-character-endpoint",
      executionRevision: "legacy-character-profile", authorityRevision: "legacy-character-authority",
      textSelection: { kind: "openrouter_preset" as const, slug: "legacy-character" },
      execute: async () => { throw new Error("legacy provider execute must not run"); }
    };
    const prepared = await prepareAuthoringTextExecution({
      ownerUserId: "owner-1", execution: legacyProvider,
      operationPrompts: { standaloneCharacter: "Frozen legacy standalone prompt." },
      ports: {
        resolvePreset: async () => ({ slug: "legacy-character", name: "Legacy character", versionId: "legacy-v1", version: 1, configHash: "c".repeat(64), config: { models: ["model-pinned"] }, systemPrompt: "Legacy standalone preset." }),
        discoverModels: async () => [{ id: "model-pinned", contextWindowTokens: 8192, maxOutputTokens: 1024 }]
      }
    });
    const legacySnapshot = createAuthoringExecutionSnapshot(legacyProvider, {}, { character: CHARACTER_AUTHORING_PROMPT_PROTOCOL_VERSION }, sha256, prepared.plans as never);
    const calls: any[] = [];
    const preparedExecutor = vi.fn(async (input: any) => {
      calls.push(input);
      return calls.length === 1 ? providerResult("not json") : providerResult(JSON.stringify(characterContent()));
    });
    const dispatch = createRuntimeAuthoringStageDispatcher({
      execution: { text: async () => legacyProvider } as never, sha256,
      preparedExecutor: { execute: preparedExecutor }
    });
    await expect(dispatch(runtimeStage({ snapshot: legacySnapshot }))).resolves.toMatchObject({ kind: "character", character: { name: "Iris" } });
    expect(calls.map((call) => call.operation)).toEqual(["standaloneCharacter", "standaloneCharacter"]);
    expect(calls.map((call) => call.request.systemPrompt)).toEqual([
      prepared.plans.standaloneCharacter!.prompt, prepared.plans.standaloneCharacter!.prompt
    ]);
  });

  it.each(["whole-unused-invocation", "unused-repair-half"] as const)("rejects v3 closure tampering before actual dispatch: %s", async (tamper) => {
    const provider = {
      ...descriptor, id: "00000000-0000-4000-8000-000000000043", name: "Closure provider", providerRole: "text" as const,
      providerType: "openrouter" as const, endpointIdentity: "closure-endpoint",
      executionRevision: "closure-profile", authorityRevision: "closure-authority",
      textSelection: { kind: "openrouter_preset" as const, slug: "closure" },
      execute: async () => { throw new Error("legacy execution must not run"); }
    };
    const prepared = await prepareAuthoringResponseContractExecution({
      ownerUserId: "owner-1", execution: provider,
      operationPrompts: {
        standaloneCharacter: "Create the character.", standaloneCharacterRepair: "Repair the character.",
        organizer: "Organize the character.", organizerRepair: "Repair the organization."
      },
      ports: {
        resolvePreset: async () => ({ slug: "closure", name: "Closure", versionId: "closure-v1", version: 1, configHash: "d".repeat(64), config: { models: ["model-pinned"] }, systemPrompt: "Closure preset." }),
        discoverModels: async () => [{ id: "model-pinned", contextWindowTokens: 8192, maxOutputTokens: 1024 }]
      }
    });
    const fullSnapshot = createAuthoringExecutionSnapshot(provider, {}, { character: CHARACTER_AUTHORING_PROMPT_PROTOCOL_VERSION }, sha256, prepared);
    const tampered = structuredClone(fullSnapshot) as any;
    const removed = tamper === "whole-unused-invocation" ? ["organizer", "organizerRepair"] : ["organizerRepair"];
    for (const operation of removed) {
      delete tampered.textExecutionPlans[operation];
      delete tampered.trustedOperationPrompts[operation];
    }
    const execute = vi.fn(async () => providerResult(JSON.stringify(characterContent())));
    const text = vi.fn(async () => provider);
    const dispatch = createRuntimeAuthoringStageDispatcher({
      execution: { text } as never, sha256, preparedExecutor: { execute }
    });
    await expect(dispatch(runtimeStage({ snapshot: tampered }))).rejects.toThrow(/closure|incomplete/i);
    expect(text).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(["source:plan", "source:chunk:source-chunk:0"])("classifies an unavailable resumed %s provider as a source failure", async (stageKey) => {
    const dispatch = createRuntimeAuthoringStageDispatcher({
      execution: { text: async () => { throw new Error("pinned provider unavailable"); } } as never,
      sha256
    });

    await expect(dispatch(runtimeStage({
      input: {
        kind: "story_source", idempotencyKey: "source-key", target: { kind: "new_world" },
        name: "chapter.txt", text: "A chapter.", mode: "faithful", boundaryParagraphId: "paragraph:0", instructions: ""
      },
      stageKey
    }))).rejects.toMatchObject({ authoringFailure: { code: "authoring_provider_unavailable", stage: "source", retryable: true } });
  });

  it.each(["source:plan", "source:chunk:source-chunk:0"])("classifies resumed %s provider snapshot drift as a source failure", async (stageKey) => {
    const dispatch = createRuntimeAuthoringStageDispatcher({
      execution: { text: async () => ({ ...descriptor, contextWindowTokens: 4096, execute: async () => providerResult(JSON.stringify({ facts: [] })) }) } as never,
      sha256
    });

    await expect(dispatch(runtimeStage({
      input: {
        kind: "story_source", idempotencyKey: "source-key", target: { kind: "new_world" },
        name: "chapter.txt", text: "A chapter.", mode: "faithful", boundaryParagraphId: "paragraph:0", instructions: ""
      },
      stageKey
    }))).rejects.toMatchObject({ authoringFailure: { code: "authoring_provider_unavailable", stage: "source", retryable: true } });
  });

  it("turns deleted or disabled pinned provider loads into a recoverable safe failure", async () => {
    const dispatch = createRuntimeAuthoringStageDispatcher({
      execution: { text: async () => { throw Object.assign(new Error("disabled provider"), { statusCode: 404 }); } } as never,
      sha256
    });
    await expect(dispatch(runtimeStage())).rejects.toMatchObject({ authoringFailure: { code: "authoring_provider_unavailable", retryable: true } });
  });

  it.each([
    { model: "different-model" }, { temperature: 0.1 }, { endpointIdentity: "changed-endpoint" },
    { contextWindowTokens: 16384 }, { maxOutputTokens: 4096 }, { requestTimeoutMs: 5000 },
    { configuration: { httpReferer: "https://changed.test" } }
  ])("rejects incompatible execution configuration before provider calls: %j", async (change) => {
    let calls = 0;
    const dispatch = createRuntimeAuthoringStageDispatcher({
      execution: { text: async () => ({ ...descriptor, ...change, execute: async () => { calls += 1; return providerResult(JSON.stringify(characterContent())); } }) } as never,
      sha256
    });
    await expect(dispatch(runtimeStage())).rejects.toMatchObject({ authoringFailure: { code: "authoring_provider_unavailable", retryable: true } });
    expect(calls).toBe(0);
  });

  it.each(["world", "character"])("rejects an incompatible pinned %s prompt protocol before provider calls", async (protocol) => {
    let calls = 0;
    const dispatch = createRuntimeAuthoringStageDispatcher({
      execution: { text: async () => ({ ...descriptor, execute: async () => { calls += 1; return providerResult(JSON.stringify(characterContent())); } }) } as never,
      sha256
    });
    await expect(dispatch(runtimeStage({ snapshot: { ...snapshot, protocols: { ...snapshot.protocols, [protocol]: "obsolete-protocol" } } })))
      .rejects.toMatchObject({ authoringFailure: { code: "authoring_provider_unavailable", retryable: true } });
    expect(calls).toBe(0);
  });
});
