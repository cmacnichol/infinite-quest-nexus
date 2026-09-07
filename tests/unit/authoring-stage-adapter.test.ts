import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { CHARACTER_AUTHORING_PROMPT_PROTOCOL_VERSION, WORLD_AUTHORING_PROMPT_PROTOCOL_VERSION } from "../../packages/domain/src/authoring-prompts.js";
import type { AuthoringClaim, AuthoringExecutionRepository } from "../../packages/application/src/authoring/ports.js";
import type { AuthoringExecutionSnapshot } from "../../packages/application/src/authoring/types.js";
import { createAuthoringExecutionSnapshot, createRuntimeAuthoringStageDispatcher, executeAuthoringStage } from "../../services/runtime/src/authoring-stage-adapter.js";
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

  it("rejects source authoring before loading a text provider", async () => {
    const text = vi.fn();
    const dispatch = createRuntimeAuthoringStageDispatcher({ execution: { text } as never, sha256 });

    await expect(dispatch(runtimeStage({
      input: {
        kind: "story_source", idempotencyKey: "source-key", target: { kind: "new_world" },
        name: "chapter.txt", text: "A chapter.", mode: "faithful", boundaryParagraphId: "paragraph:0", instructions: ""
      },
      stageKey: "source"
    }))).rejects.toMatchObject({ authoringFailure: { code: "source_evidence_invalid", stage: "source", retryable: false } });

    expect(text).not.toHaveBeenCalled();
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
