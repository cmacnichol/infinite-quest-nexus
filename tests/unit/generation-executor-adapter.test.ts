import { describe, expect, it, vi } from "vitest";
import type {
  ClaimedGeneration,
  IllustrationGenerationTransactionPort
} from "../../packages/application/src/index.js";
import type { GenerationExecutionRepository } from "../../packages/database/src/generation-execution-repository.js";
import type { GenerationExecutionPayload } from "../../packages/database/src/generation-execution-repository.js";
import type { DatabasePool } from "../../packages/database/src/pool.js";
import {
  createGenerationExecutor,
  type GenerationExecutionCollaborators
} from "../../services/runtime/src/generation-executor-adapter.js";
import { DEDICATED_CHUNKED_AUDIT } from "../fixtures/chronicle-retrieval-audits.js";
import {
  ProviderModelFallbackExhaustedError,
  ProviderStreamInterruptedError
} from "../../packages/story-engine/src/index.js";

const claim: ClaimedGeneration = {
  jobId: "00000000-0000-4000-8000-000000000001",
  ownerUserId: "00000000-0000-4000-8000-000000000002",
  campaignId: "00000000-0000-4000-8000-000000000003",
  providerProfileId: "00000000-0000-4000-8000-000000000004",
  expectedTurnNumber: 3,
  attempts: 1,
  operationKind: "append",
  replacementTurnId: null
};

function rejectedCollaborators(): GenerationExecutionCollaborators {
  const unexpected = vi.fn(async (): Promise<never> => {
    throw new Error("A collaborator ran before the execution payload guard passed.");
  });
  const unexpectedSync = vi.fn((): never => {
    throw new Error("A collaborator ran before the execution payload guard passed.");
  });
  return {
    memory: {
      autoEnableCampaignEmbedding: unexpected,
      buildContextPreview: unexpected,
      enqueueEmbeddingReindex: unexpected,
      rebuildCampaignMemories: unexpected,
      storeDerivedTurnMemories: unexpected,
      writeAcceptedTurnFiction: unexpected
    } as never,
    illustration: {
      loadStreamingIllustrationConfig: unexpected,
      createProvisionalSet: unexpected,
      createProvisionalSegment: unexpected,
      promoteProvisionalSet: unexpected,
      orphanProvisionalSet: unexpected,
      enqueueAcceptedTurnIllustrationSegments: unexpected
    } as IllustrationGenerationTransactionPort,
    loadTextExecution: unexpected,
    promptFromSnapshot: unexpectedSync,
    recordProfileCost: unexpected,
    attributeGenerationCostsToTurn: unexpected
  };
}

function guardedRepository(): GenerationExecutionRepository {
  const unexpectedBoolean = vi.fn(async () => {
    throw new Error("A durable mutation ran before the execution payload guard passed.");
  });
  return {
    loadExecutionPayload: vi.fn(async () => null),
    renewLease: unexpectedBoolean,
    markGenerating: unexpectedBoolean,
    saveOrchestration: unexpectedBoolean,
    savePartialNarration: unexpectedBoolean,
    saveStreamingSegments: unexpectedBoolean,
    recordAttempt: vi.fn(async () => {
      throw new Error("An attempt was recorded before the execution payload guard passed.");
    }),
    markRecoverable: unexpectedBoolean,
    markValidating: unexpectedBoolean,
    markCommitting: unexpectedBoolean,
    commitAcceptedTurn: vi.fn(async () => {
      throw new Error("A turn committed before the execution payload guard passed.");
    }),
    markFailed: unexpectedBoolean
  };
}

function modelRoutingJob(): GenerationExecutionPayload {
  return {
    id: claim.jobId, owner_user_id: claim.ownerUserId, campaign_id: claim.campaignId,
    world_version_id: "00000000-0000-4000-8000-000000000005", provider_profile_id: claim.providerProfileId,
    expected_turn_number: claim.expectedTurnNumber, operation_kind: "append", replacement_turn_id: null,
    base_turn_number: null, base_state_private: {}, base_scratchpad_safe_for_prompt: false,
    action: "Open the observatory door.", requested_input_mode: "action", resolved_input_mode: "action",
    input_mode_source: "explicit", requested_model: "primary-model",
    model_routing: {
      requestedModel: "primary-model", configuredModels: ["primary-model", "fallback-model"],
      routingSource: "models", presetSlug: null, presetDesignatedVersionId: null, presetVersion: null, presetConfigHash: null,
      providerPolicy: {}, providerPolicyHash: "policy-hash", providerType: "openai_compatible"
    },
    context_options: { budgetTokens: 8_000, compression: "auto", query: "Open the observatory door.", recentTurns: 4 },
    prompt_protocol_version: "test-protocol", prompt_snapshot: {} as GenerationExecutionPayload["prompt_snapshot"],
    attempts: 1, orchestration_private: {}, streaming_segments_state: {},
    orchestration_inputs: {
      useRpgStats: false, rpgStats: [], eventTriggers: [], pendingEventTriggers: [],
      storyMemoryDefaults: { canonicalFacts: [], supersededFacts: [] }, suppressEventTriggers: true,
      characterProfile: null, characterSnapshot: null
    }
  };
}

function failureHarness(error: Error, configuration: Record<string, unknown> = {}) {
  const job = modelRoutingJob();
  const repository = {
    loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true),
    markGenerating: vi.fn(async () => true), saveOrchestration: vi.fn(async () => true),
    savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true),
    recordAttempt: vi.fn(async () => undefined), markRecoverable: vi.fn(async () => true),
    markValidating: vi.fn(async () => true), markCommitting: vi.fn(async () => true),
    commitAcceptedTurn: vi.fn(async () => ({ turnId: "unexpected-turn" })), markFailed: vi.fn(async () => true)
  } as unknown as GenerationExecutionRepository;
  const execute = vi.fn(async (request: { onChunk?: (delta: string, accumulated: string) => Promise<void> }) => {
    if (request.onChunk) await request.onChunk("First visible words", "First visible words");
    throw error;
  });
  const collaborators = {
    memory: { buildContextPreview: vi.fn(async () => ({
      campaign: { id: claim.campaignId, worldVersionId: job.world_version_id, selectedCharacterId: null, characterProfileRevision: 0 },
      selectedCompression: null, retrieval: {}, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT,
      scopes: { worldCanon: {}, campaignCanon: {}, chronicle: [], currentScene: null }
    })) } as never,
    illustration: {
      loadStreamingIllustrationConfig: vi.fn(async () => null), orphanProvisionalSet: vi.fn(async () => undefined)
    } as unknown as IllustrationGenerationTransactionPort,
    loadTextExecution: vi.fn(async () => ({
      id: claim.providerProfileId, name: "Test provider", providerRole: "text" as const,
      providerType: "openai_compatible" as const, model: "primary-model", contextWindowTokens: 16_000,
      maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration, execute
    })),
    promptFromSnapshot: vi.fn(() => "Write a concise fictional scene."),
    recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined)
  } as unknown as GenerationExecutionCollaborators;
  return { job, repository, collaborators, execute };
}

describe("generation executor adapter", () => {
  it("treats a missing guarded payload as cancellation before provider work or mutation", async () => {
    const repository = guardedRepository();
    const collaborators = rejectedCollaborators();
    const executor = createGenerationExecutor({
      pool: {} as DatabasePool,
      repository,
      collaborators
    });

    await expect(executor.execute({ workerId: "worker-a", leaseSeconds: 30, claim })).resolves.toBe(false);

    expect(repository.loadExecutionPayload).toHaveBeenCalledOnce();
    expect(repository.loadExecutionPayload).toHaveBeenCalledWith({
      workerId: "worker-a",
      leaseSeconds: 30,
      claim
    });
    expect(collaborators.illustration.loadStreamingIllustrationConfig).not.toHaveBeenCalled();
    expect(collaborators.illustration.createProvisionalSet).not.toHaveBeenCalled();
    expect(repository.renewLease).not.toHaveBeenCalled();
    expect(repository.markGenerating).not.toHaveBeenCalled();
    expect(repository.markFailed).not.toHaveBeenCalled();
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
  });

  it("passes the validated Chronicle retrieval audit unchanged into the accepted-turn commit", async () => {
    const retrievalDiagnostics = { fallbackReason: "chunk_index_not_ready", selectedMemoryCount: 4 };
    const job = {
      id: claim.jobId,
      owner_user_id: claim.ownerUserId,
      campaign_id: claim.campaignId,
      world_version_id: "00000000-0000-4000-8000-000000000005",
      provider_profile_id: claim.providerProfileId,
      expected_turn_number: claim.expectedTurnNumber,
      operation_kind: "append",
      replacement_turn_id: null,
      base_turn_number: null,
      base_state_private: {},
      base_scratchpad_safe_for_prompt: false,
      action: "Open the observatory door.",
      requested_input_mode: "action",
      resolved_input_mode: "action",
      input_mode_source: "explicit",
      requested_model: "test-model",
      model_routing: {
        requestedModel: "test-model",
        configuredModels: ["test-model"],
        routingSource: "models",
        presetSlug: null,
        presetDesignatedVersionId: null,
        presetVersion: null,
        presetConfigHash: null,
        providerPolicy: {},
        providerPolicyHash: "test-policy-hash",
        providerType: "openai_compatible"
      },
      context_options: {
        budgetTokens: 8_000,
        compression: "auto",
        query: "Open the observatory door.",
        recentTurns: 4
      },
      prompt_protocol_version: "test-protocol",
      prompt_snapshot: {} as GenerationExecutionPayload["prompt_snapshot"],
      attempts: 1,
      orchestration_private: {},
      streaming_segments_state: {},
      orchestration_inputs: {
        useRpgStats: false,
        rpgStats: [],
        eventTriggers: [],
        pendingEventTriggers: [],
        storyMemoryDefaults: { canonicalFacts: [], supersededFacts: [] },
        suppressEventTriggers: true,
        characterProfile: null,
        characterSnapshot: null
      }
    } as GenerationExecutionPayload;
    const repository = {
      loadExecutionPayload: vi.fn(async () => job),
      renewLease: vi.fn(async () => true),
      markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async () => true),
      savePartialNarration: vi.fn(async () => true),
      saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => undefined),
      markRecoverable: vi.fn(async () => true),
      markValidating: vi.fn(async () => true),
      markCommitting: vi.fn(async () => true),
      commitAcceptedTurn: vi.fn(async () => ({ turnId: "00000000-0000-4000-8000-000000000006" })),
      markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const collaborators = {
      memory: {
        buildContextPreview: vi.fn(async () => ({
          campaign: {
            id: claim.campaignId,
            worldVersionId: job.world_version_id,
            selectedCharacterId: null,
            characterProfileRevision: 0
          },
          selectedCompression: null,
          retrieval: retrievalDiagnostics,
          chronicleRetrieval: DEDICATED_CHUNKED_AUDIT,
          scopes: { worldCanon: {}, campaignCanon: {}, chronicle: [], currentScene: null }
        }))
      } as never,
      illustration: {
        loadStreamingIllustrationConfig: vi.fn(async () => null)
      } as unknown as IllustrationGenerationTransactionPort,
      loadTextExecution: vi.fn(async () => ({
        id: claim.providerProfileId,
        name: "Test provider",
        providerRole: "text" as const,
        providerType: "openai_compatible" as const,
        model: "test-model",
        contextWindowTokens: 16_000,
        maxOutputTokens: 2_000,
        temperature: 0,
        requestTimeoutMs: 1_000,
        configuration: {},
        execute: async () => ({
          content: JSON.stringify({
            narration: "The observatory door opens onto a quiet moonlit hall.",
            choices: ["Enter the hall.", "Wait outside.", "Inspect the lock.", "Call for the keeper."],
            custom_action_suggestion: "Study the observatory lens.",
            scratchpad: "The door is now open.",
            tracker_updates: [],
            image_prompt: "A quiet moonlit observatory hall.",
            continuity_summary: "The observatory door is open.",
            canonical_facts: ["The observatory door is open."],
            superseded_facts: [],
            canonical_fact_updates: [],
            open_threads: ["Learn who opened the observatory."]
          }),
          responseId: "test-response",
          finishReason: "stop",
          outputLimited: false,
          modelInstanceId: "test-instance",
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          reportedCost: null,
          rawMetadata: {}
        })
      })),
      promptFromSnapshot: vi.fn(() => "Write a concise fictional scene."),
      recordProfileCost: vi.fn(async () => undefined),
      attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;
    const executor = createGenerationExecutor({
      pool: {} as DatabasePool,
      repository,
      collaborators
    });

    await expect(executor.execute({ workerId: "worker-a", leaseSeconds: 30, claim })).resolves.toBe(true);

    expect(repository.commitAcceptedTurn).toHaveBeenCalledOnce();
    const accepted = (repository.commitAcceptedTurn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      chronicleRetrieval?: unknown;
      contextDiagnostics: { retrieval?: unknown };
    };
    expect(accepted.chronicleRetrieval).toStrictEqual(DEDICATED_CHUNKED_AUDIT);
    expect(accepted.contextDiagnostics.retrieval).toBe(retrievalDiagnostics);
  });

  it("loads text execution from the durable routing snapshot instead of a live model override", async () => {
    const modelRouting = {
      requestedModel: "primary-model",
      configuredModels: ["primary-model", "fallback-model"],
      routingSource: "openrouter_preset" as const,
      presetSlug: "story-router",
      presetDesignatedVersionId: "00000000-0000-4000-8000-000000000007",
      presetVersion: 3,
      presetConfigHash: "preset-hash",
      providerPolicy: { order: ["provider-a"] },
      providerPolicyHash: "policy-hash",
      providerType: "openrouter"
    };
    const job = {
      id: claim.jobId,
      owner_user_id: claim.ownerUserId,
      campaign_id: claim.campaignId,
      world_version_id: "00000000-0000-4000-8000-000000000005",
      provider_profile_id: claim.providerProfileId,
      expected_turn_number: claim.expectedTurnNumber,
      operation_kind: "append",
      replacement_turn_id: null,
      base_turn_number: null,
      base_state_private: {},
      base_scratchpad_safe_for_prompt: false,
      action: "Open the observatory door.",
      requested_input_mode: "action",
      resolved_input_mode: "action",
      input_mode_source: "explicit",
      requested_model: "primary-model",
      context_options: { budgetTokens: 8_000, compression: "auto", query: "Open the observatory door.", recentTurns: 4 },
      model_routing: modelRouting,
      prompt_protocol_version: "test-protocol",
      prompt_snapshot: {} as GenerationExecutionPayload["prompt_snapshot"],
      attempts: 1,
      orchestration_private: {},
      streaming_segments_state: {},
      orchestration_inputs: {
        useRpgStats: false,
        rpgStats: [],
        eventTriggers: [],
        pendingEventTriggers: [],
        storyMemoryDefaults: { canonicalFacts: [], supersededFacts: [] },
        suppressEventTriggers: true,
        characterProfile: null,
        characterSnapshot: null
      }
    } as GenerationExecutionPayload;
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true),
      markGenerating: vi.fn(async () => true), saveOrchestration: vi.fn(async () => true),
      savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => undefined), markRecoverable: vi.fn(async () => true),
      markValidating: vi.fn(async () => true), markCommitting: vi.fn(async () => true),
      commitAcceptedTurn: vi.fn(async () => ({ turnId: "00000000-0000-4000-8000-000000000006" })),
      markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const collaborators = {
      memory: {
        buildContextPreview: vi.fn(async () => ({
          campaign: { id: claim.campaignId, worldVersionId: job.world_version_id, selectedCharacterId: null, characterProfileRevision: 0 },
          selectedCompression: null, retrieval: {}, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT,
          scopes: { worldCanon: {}, campaignCanon: {}, chronicle: [], currentScene: null }
        }))
      } as never,
      illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) } as unknown as IllustrationGenerationTransactionPort,
      loadTextExecution: vi.fn(async () => ({
        id: claim.providerProfileId, name: "Test provider", providerRole: "text" as const, providerType: "openrouter" as const,
        model: "primary-model", contextWindowTokens: 16_000, maxOutputTokens: 2_000, temperature: 0,
        requestTimeoutMs: 1_000, configuration: {}, execute: async () => ({
          content: JSON.stringify({ narration: "The door opens onto moonlight.", choices: ["Enter.", "Wait.", "Listen.", "Leave."], custom_action_suggestion: "Inspect the lock.", scratchpad: "Door open.", tracker_updates: [], image_prompt: "A moonlit observatory door.", continuity_summary: "Door open.", canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: [] }),
          responseId: "test-response", finishReason: "stop", outputLimited: false, modelInstanceId: "fallback-model",
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, reportedCost: null, rawMetadata: {},
          modelRouting: { strategy: "openrouter_preset_snapshot" as const, configuredModels: modelRouting.configuredModels, resolvedModel: "fallback-model", fallbackUsed: true, attempts: [], emittedOutput: false }
        })
      })),
      promptFromSnapshot: vi.fn(() => "Write a concise fictional scene."),
      recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "worker-a", leaseSeconds: 30, claim })).resolves.toBe(true);

    expect(collaborators.loadTextExecution).toHaveBeenCalledWith(
      claim.ownerUserId,
      claim.providerProfileId,
      modelRouting
    );
  });

  it("records exhausted model plans as a redacted recoverable outcome without accepting state", async () => {
    const { repository, collaborators, execute } = failureHarness(new ProviderModelFallbackExhaustedError([
      { model: "primary-model", outcome: "failed", reason: "provider_unavailable", emittedOutput: false },
      { model: "fallback-model", outcome: "refused", reason: "refusal", emittedOutput: false }
    ]));

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "worker-a", leaseSeconds: 30, claim })).resolves.toBe(true);

    expect(execute).toHaveBeenCalledOnce();
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
    expect(repository.markFailed).not.toHaveBeenCalled();
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "model_plan_exhausted",
      recoveryMetadata: {
        modelRouting: {
          reason: "model_plan_exhausted",
          retryDisposition: "explicit_regeneration",
          configuredModels: ["primary-model", "fallback-model"],
          attemptedModels: ["primary-model", "fallback-model"],
          partialNarrationAvailable: false
        }
      }
    }));
    const attempt = (repository.recordAttempt as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(attempt.responseMetadata).toEqual(expect.objectContaining({ modelRouting: expect.any(Object) }));
    expect(JSON.stringify(attempt.responseMetadata)).not.toContain("credential");
    expect(JSON.stringify(attempt.responseMetadata)).not.toContain("provider body");
  });

  it("preserves partial output and does not re-run another model after a stream interruption", async () => {
    const { repository, collaborators, execute } = failureHarness(new ProviderStreamInterruptedError([
      { model: "primary-model", outcome: "failed", reason: "transport_failure", emittedOutput: true }
    ]), { streaming: true });

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "worker-a", leaseSeconds: 30, claim })).resolves.toBe(true);

    expect(execute).toHaveBeenCalledOnce();
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
    expect(repository.markFailed).not.toHaveBeenCalled();
    expect(repository.savePartialNarration).toHaveBeenCalledWith(expect.any(Object), "First visible words");
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "provider_stream_interrupted",
      recoveryMetadata: {
        modelRouting: expect.objectContaining({
          attemptedModels: ["primary-model"],
          partialNarrationAvailable: true,
          retryDisposition: "explicit_regeneration"
        })
      }
    }));
  });
});
