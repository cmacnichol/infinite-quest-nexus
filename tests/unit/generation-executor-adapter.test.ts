import { describe, expect, it, vi } from "vitest";
import type {
  ClaimedGeneration,
  IllustrationGenerationTransactionPort
} from "../../packages/application/src/index.js";
import type { GenerationExecutionRepository } from "../../packages/database/src/generation-execution-repository.js";
import type { GenerationExecutionPayload } from "../../packages/database/src/generation-execution-repository.js";
import type { DatabasePool } from "../../packages/database/src/pool.js";
import { PROMPT_TEMPLATE_CATALOG } from "../../packages/contracts/src/prompt-library.js";
import { sha256 } from "../../packages/domain/src/index.js";
import { ContextBudgetError } from "../../packages/story-engine/src/context-budget.js";
import {
  createGenerationExecutor,
  type GenerationExecutionCollaborators
} from "../../services/runtime/src/generation-executor-adapter.js";
import { DEDICATED_CHUNKED_AUDIT } from "../fixtures/chronicle-retrieval-audits.js";

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
      loadGenerationContext: unexpected,
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

function validPromptSnapshot(): GenerationExecutionPayload["prompt_snapshot"] {
  return Object.fromEntries(Object.values(PROMPT_TEMPLATE_CATALOG).map((template) => [template.key, {
    content: template.defaultContent,
    hash: sha256(template.defaultContent),
    source: "shipped"
  }])) as GenerationExecutionPayload["prompt_snapshot"];
}

function completeGenerationExecutionPayload(): GenerationExecutionPayload {
  return {
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
    context_options: { budgetTokens: 8_000, compression: "auto", query: "Open the observatory door.", recentTurns: 4 },
    prompt_protocol_version: "test-protocol",
    prompt_snapshot: validPromptSnapshot(),
    generation_base_identity: {
      operationKind: "append", expectedTurnNumber: claim.expectedTurnNumber,
      baseTurnNumber: claim.expectedTurnNumber - 1, campaignActiveTurnNumber: claim.expectedTurnNumber - 1,
      campaignStateRevision: 1, stateEditRevision: null, narrationCorrectionRevision: null,
      baseTurnId: null, stateFingerprint: "state-fingerprint", narrationFingerprint: null
    },
    attempts: 1,
    orchestration_private: {},
    streaming_segments_state: {},
    orchestration_inputs: {
      useRpgStats: false, rpgStats: [], eventTriggers: [], pendingEventTriggers: [],
      storyMemoryDefaults: { canonicalFacts: [], supersededFacts: [] }, suppressEventTriggers: true,
      characterProfile: null, characterSnapshot: null
    }
  };
}

describe("generation executor adapter", () => {
  it("reclaims a compatible validated draft without asking the text provider for a different narration", async () => {
    const job = completeGenerationExecutionPayload();
    const firstNarration = "The first validated draft opens the observatory door.";
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true),
      markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async (_scope, value) => {
        job.orchestration_private = value;
        return true;
      }),
      savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => undefined), markRecoverable: vi.fn(async () => true),
      markValidating: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
      markCommitting: vi.fn(async () => true),
      commitAcceptedTurn: vi.fn(async () => ({ turnId: "00000000-0000-4000-8000-000000000006" })),
      markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = {
      id: claim.providerProfileId, name: "Captured provider", providerRole: "text" as const,
      providerType: "openai_compatible" as const, model: "test-model", contextWindowTokens: 16_000,
      maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {},
      execute: vi.fn()
        .mockResolvedValueOnce({
          content: JSON.stringify({
            narration: firstNarration,
            choices: ["Enter.", "Wait.", "Study.", "Call."],
            custom_action_suggestion: "Study the lens.", scratchpad: "The door is open.",
            tracker_updates: [], image_prompt: "A moonlit observatory hall.",
            continuity_summary: "The observatory door is open.", canonical_facts: [],
            superseded_facts: [], canonical_fact_updates: [], open_threads: []
          }),
          responseId: "first-response", finishReason: "stop", outputLimited: false,
          modelInstanceId: "test-instance", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          reportedCost: null, rawMetadata: {}
        })
        .mockRejectedValueOnce(new Error("A reclaim must not regenerate the main draft."))
    };
    const collaborators = {
      memory: {
        loadGenerationContext: vi.fn(async () => ({
          authority: {}, candidates: [], baseIdentity: job.generation_base_identity,
          chronicleRetrieval: DEDICATED_CHUNKED_AUDIT
        }))
      },
      illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) },
      loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write a concise fictional scene."),
      recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;

    const executor = createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators });
    await expect(executor.execute({ workerId: "worker-a", leaseSeconds: 30, claim })).resolves.toBe(true);
    expect(job.orchestration_private.validatedMainDraft).toBeDefined();
    job.attempts = 2;
    await expect(executor.execute({ workerId: "worker-b", leaseSeconds: 30, claim: { ...claim, attempts: 2 } })).resolves.toBe(true);

    expect(provider.execute).toHaveBeenCalledOnce();
    expect(repository.commitAcceptedTurn).toHaveBeenCalledWith(expect.objectContaining({
      story: expect.objectContaining({ narration: firstNarration }),
      response: expect.objectContaining({ responseId: "first-response" })
    }));
  });

  it("makes an incompatible validated-draft checkpoint recoverable before provider work", async () => {
    const job = completeGenerationExecutionPayload();
    job.orchestration_private = {
      validatedMainDraft: { version: 1, providerId: "different-provider" }
    } as unknown as GenerationExecutionPayload["orchestration_private"];
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true),
      markGenerating: vi.fn(async () => true), saveOrchestration: vi.fn(async () => true),
      savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => undefined), markRecoverable: vi.fn(async () => true),
      markValidating: vi.fn(async () => true), markCommitting: vi.fn(async () => true),
      commitAcceptedTurn: vi.fn(async () => ({ turnId: "unexpected" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = {
      id: claim.providerProfileId, name: "Captured provider", providerRole: "text" as const,
      providerType: "openai_compatible" as const, model: "test-model", contextWindowTokens: 16_000,
      maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {}, execute: vi.fn()
    };
    const collaborators = {
      memory: { loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })) },
      illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) },
      loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write a concise fictional scene."),
      recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "checkpoint-worker", leaseSeconds: 30, claim })).resolves.toBe(true);

    expect(provider.execute).not.toHaveBeenCalled();
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "generation_checkpoint_incompatible"
    }));
  });

  it("does not repeat a consumed automatic repair after a lease reclaim", async () => {
    const job = completeGenerationExecutionPayload();
    job.orchestration_private = {
      automaticRepair: {
        stage: "schema_repair",
        rejectedDraftHash: "rejected-draft-hash",
        consumedAttempt: 1
      }
    };
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true),
      markGenerating: vi.fn(async () => true), saveOrchestration: vi.fn(async () => true),
      markRecoverable: vi.fn(async () => true), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = {
      id: claim.providerProfileId, name: "Captured provider", providerRole: "text" as const,
      providerType: "openai_compatible" as const, model: "test-model", contextWindowTokens: 16_000,
      maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {}, execute: vi.fn()
    };
    const collaborators = {
      memory: { loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })) },
      illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) },
      loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write a concise fictional scene."),
      recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "reclaim-worker", leaseSeconds: 30, claim: { ...claim, attempts: 2 } })).resolves.toBe(true);

    expect(provider.execute).not.toHaveBeenCalled();
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "automatic_repair_consumed",
      recoveryMetadata: expect.objectContaining({ stage: "schema_repair" })
    }));
  });

  it("persists one event-coverage repair and commits only its revalidated full story", async () => {
    const job = completeGenerationExecutionPayload();
    job.orchestration_inputs.suppressEventTriggers = false;
    job.orchestration_private.afterEvents = [{
      triggerId: "00000000-0000-4000-8000-000000000010",
      sourceTurn: claim.expectedTurnNumber,
      addTextAfter: true,
      instructions: "A silver bell rings in the observatory.",
      summary: "The bell must ring."
    }] as never;
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true),
      markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async (_scope, value) => {
        job.orchestration_private = value;
        return true;
      }),
      savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => undefined), markRecoverable: vi.fn(async () => true),
      markValidating: vi.fn(async () => true), markCommitting: vi.fn(async () => true),
      commitAcceptedTurn: vi.fn(async () => ({ turnId: "00000000-0000-4000-8000-000000000006" })),
      markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const story = (narration: string) => JSON.stringify({
      narration, choices: ["Enter.", "Wait.", "Study.", "Call."], custom_action_suggestion: "Study the lens.",
      scratchpad: "The door is open.", tracker_updates: [], image_prompt: "A moonlit observatory hall.",
      continuity_summary: "The observatory door is open.", canonical_facts: [], superseded_facts: [],
      canonical_fact_updates: [], open_threads: []
    });
    const provider = {
      id: claim.providerProfileId, name: "Captured provider", providerRole: "text" as const,
      providerType: "openai_compatible" as const, model: "test-model", contextWindowTokens: 16_000,
      maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {}, execute: vi.fn()
        .mockResolvedValueOnce({ content: story("The observatory door opens."), responseId: "main", finishReason: "stop", outputLimited: false, modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: story("The observatory door opens.\n\nThe chamber stays silent."), responseId: "extension", finishReason: "stop", outputLimited: false, modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: JSON.stringify({ covered: false, missing_required_beats: ["bell"], contradictions: [] }), responseId: "coverage-1", finishReason: "stop", outputLimited: false, modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: story("The observatory door opens and a silver bell rings."), responseId: "repair", finishReason: "stop", outputLimited: false, modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: JSON.stringify({ covered: true, missing_required_beats: [], contradictions: [] }), responseId: "coverage-2", finishReason: "stop", outputLimited: false, modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {} })
    };
    const collaborators = {
      memory: { loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })) },
      illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) },
      loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write a concise fictional scene."),
      recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "event-repair-worker", leaseSeconds: 30, claim })).resolves.toBe(true);

    expect(job.orchestration_private.eventCoverageRepair).toEqual(expect.objectContaining({ consumedAttempt: 1 }));
    expect(repository.commitAcceptedTurn).toHaveBeenCalledWith(expect.objectContaining({
      story: expect.objectContaining({ narration: "The observatory door opens and a silver bell rings." })
    }));
    job.attempts = 2;
    job.orchestration_private.eventCoverageRepair = {
      ...job.orchestration_private.eventCoverageRepair!,
      validatedMainDraftHash: "tampered-main-draft-hash"
    };
    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "event-repair-reclaim", leaseSeconds: 30, claim: { ...claim, attempts: 2 } })).resolves.toBe(true);
    expect(provider.execute).toHaveBeenCalledTimes(5);
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "generation_checkpoint_incompatible"
    }));
  });

  it("sends planner-selected private authority candidates and records omitted candidates without reading the legacy preview", async () => {
    const job = completeGenerationExecutionPayload();
    job.context_options = { ...job.context_options, budgetTokens: 1_000 };
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true),
      markGenerating: vi.fn(async () => true), saveOrchestration: vi.fn(async () => true),
      savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => undefined), markRecoverable: vi.fn(async () => true),
      markValidating: vi.fn(async () => true), markCommitting: vi.fn(async () => true),
      commitAcceptedTurn: vi.fn(async () => ({ turnId: "00000000-0000-4000-8000-000000000006" })),
      markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = {
      id: claim.providerProfileId, name: "Captured provider", providerRole: "text" as const,
      providerType: "openai_compatible" as const, model: "test-model", contextWindowTokens: 16_000,
      maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {},
      execute: vi.fn(async () => ({
        content: JSON.stringify({ narration: "The observatory door opens onto a quiet moonlit hall.",
          choices: ["Enter.", "Wait.", "Study.", "Call."], custom_action_suggestion: "Study the lens.",
          scratchpad: "The door is open.", tracker_updates: [], image_prompt: "A moonlit observatory hall.",
          continuity_summary: "The observatory door is open.", canonical_facts: [], superseded_facts: [],
          canonical_fact_updates: [], open_threads: [] }), responseId: "test-response", finishReason: "stop",
        outputLimited: false, modelInstanceId: "test-instance", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        reportedCost: null, rawMetadata: {}
      }))
    };
    const collaborators = {
      memory: {
        loadGenerationContext: vi.fn(async () => ({
          authority: { rules: ["Never abandon the observatory."], worldCanon: { title: "Moon Archive" },
            selectedCharacterId: null, currentContinuity: { continuitySummary: "The keeper waits.", scratchpad: "Private note.", openThreads: [], canonicalFacts: [], trackers: {}, rpgStats: [], eventTriggers: [], pendingEventTriggers: [] },
            scratchpad: "Private note.", openThreads: [], canonicalFacts: [], trackers: {}, rpgStats: [], eventTriggers: [], pendingEventTriggers: [], latestTurn: null },
          candidates: [
            { id: "selected-memory", turnId: null, ordinal: 1, kind: "turn_fiction", content: "The keeper lit the lantern.", tokenEstimate: 10, rank: 1 },
            { id: "omitted-memory", turnId: null, ordinal: 2, kind: "turn_fiction", content: "x".repeat(10_000), tokenEstimate: 10_000, rank: 2 }
          ], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT
        })),
        buildContextPreview: vi.fn(async () => { throw new Error("legacy preview must not be read"); })
      },
      illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) },
      loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write a concise fictional scene."),
      recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;
    const executor = createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators });

    await expect(executor.execute({ workerId: "worker-a", leaseSeconds: 30, claim })).resolves.toBe(true);

    expect(collaborators.memory.buildContextPreview).not.toHaveBeenCalled();
    const input = JSON.parse((provider.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].input);
    expect(input.authoritative_context.authoritativeRules).toEqual(["Never abandon the observatory."]);
    expect(input.authoritative_context.chronicle.map((entry: { id: string }) => entry.id)).toEqual(["selected-memory"]);
    const accepted = (repository.commitAcceptedTurn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(accepted.contextDiagnostics.selectedContext).toEqual([{ id: "authority", revision: expect.any(String) }, { id: "selected-memory", revision: expect.any(String) }]);
    expect(accepted.contextDiagnostics.omittedContext).toEqual([{ id: "omitted-memory", revision: expect.any(String), reason: "context_limit" }]);
  });

  it("makes a provider-request budget overflow recoverable before an RPG fallback can commit a turn", async () => {
    const job = completeGenerationExecutionPayload();
    job.orchestration_inputs = {
      ...job.orchestration_inputs,
      useRpgStats: true,
      rpgStats: [{ id: "courage", name: "Courage", value: 3, note: "Steady under pressure." }]
    };
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
    const provider = {
      id: claim.providerProfileId, name: "Captured provider", providerRole: "text" as const,
      providerType: "openai_compatible" as const, model: "test-model", contextWindowTokens: 16_000,
      maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {},
      execute: vi.fn()
        .mockRejectedValueOnce(new ContextBudgetError("context_budget_exceeded", 100, 10, undefined, { scope: "provider_request" }))
        .mockResolvedValueOnce({
          content: JSON.stringify({
            narration: "The observatory door opens onto a quiet moonlit hall.",
            choices: ["Enter the hall.", "Wait outside.", "Inspect the lock.", "Call for the keeper."],
            custom_action_suggestion: "Study the observatory lens.", scratchpad: "The door is now open.",
            tracker_updates: [], image_prompt: "A quiet moonlit observatory hall.",
            continuity_summary: "The observatory door is open.", canonical_facts: [],
            superseded_facts: [], canonical_fact_updates: [], open_threads: []
          }), responseId: "test-response", finishReason: "stop", outputLimited: false,
          modelInstanceId: "test-instance", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          reportedCost: null, rawMetadata: {}
        })
    };
    const collaborators = {
      memory: {
        loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })),
        buildContextPreview: vi.fn(async () => ({
          campaign: { id: claim.campaignId, worldVersionId: job.world_version_id, selectedCharacterId: null, characterProfileRevision: 0 },
          selectedCompression: null, retrieval: {}, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT,
          scopes: { worldCanon: {}, campaignCanon: {}, chronicle: [], currentScene: null,
            currentContinuity: { continuitySummary: "", openThreads: [], canonicalFacts: [], scratchpad: "" } }
        }))
      },
      illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) },
      loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write a concise fictional scene."),
      recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;

    const executor = createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators });
    await expect(executor.execute({ workerId: "worker-a", leaseSeconds: 30, claim })).resolves.toBe(true);

    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "context_budget_exceeded",
      errorMessage: "Generation context could not be safely prepared."
    }));
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
    expect(repository.markFailed).not.toHaveBeenCalled();
    expect(provider.execute).toHaveBeenCalledOnce();
    expect(collaborators.memory.loadGenerationContext).toHaveBeenCalledWith({}, expect.objectContaining({
      expectedBaseIdentity: job.generation_base_identity
    }));
  });

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

  it("does not call a provider for a malformed loaded prompt snapshot", async () => {
    const providerCalls: unknown[] = [];
    const malformedJob = { ...completeGenerationExecutionPayload(), prompt_snapshot: {} as never };
    const repository = {
      loadExecutionPayload: vi.fn(async () => malformedJob),
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
    } as GenerationExecutionRepository;
    const provider = {
      id: claim.providerProfileId, name: "Captured provider", providerRole: "text" as const,
      providerType: "openai_compatible" as const, model: "test-model", contextWindowTokens: 16_000,
      maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {},
      execute: vi.fn(async (request: unknown) => {
        providerCalls.push(request);
        throw new Error("The malformed snapshot must not reach provider execution.");
      })
    };
    const collaborators = {
      memory: {
        autoEnableCampaignEmbedding: vi.fn(async () => undefined),
        loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: malformedJob.generation_base_identity })),
        buildContextPreview: vi.fn(async () => ({
          campaign: { id: claim.campaignId, worldVersionId: malformedJob.world_version_id, selectedCharacterId: null, characterProfileRevision: 0 },
          selectedCompression: null,
          retrieval: {},
          chronicleRetrieval: DEDICATED_CHUNKED_AUDIT,
          scopes: {
            worldCanon: {}, campaignCanon: {}, chronicle: [], currentScene: null,
            currentContinuity: { continuitySummary: "", openThreads: [], canonicalFacts: [], scratchpad: "" }
          }
        })),
        enqueueEmbeddingReindex: vi.fn(async () => undefined),
        rebuildCampaignMemories: vi.fn(async () => undefined),
        storeDerivedTurnMemories: vi.fn(async () => undefined),
        writeAcceptedTurnFiction: vi.fn(async () => undefined)
      },
      illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) },
      loadTextExecution: vi.fn(async () => provider),
      promptFromSnapshot: vi.fn(() => "Write a concise fictional scene."),
      recordProfileCost: vi.fn(async () => undefined),
      attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;
    const executor = createGenerationExecutor({
      pool: {} as DatabasePool,
      repository,
      collaborators
    });

    const executed = await executor.execute({ workerId: "worker-a", leaseSeconds: 30, claim });
    expect(providerCalls).toEqual([]);
    expect(executed).toBe(false);
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "generation_prompt_snapshot_invalid"
    }));
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
  });

  it("raises generation_cancelled when malformed snapshot recovery loses its lease", async () => {
    const malformedJob = { ...completeGenerationExecutionPayload(), prompt_snapshot: {} as never };
    const repository = {
      ...guardedRepository(),
      loadExecutionPayload: vi.fn(async () => malformedJob),
      markRecoverable: vi.fn(async () => false)
    } as GenerationExecutionRepository;
    const executor = createGenerationExecutor({
      pool: {} as DatabasePool,
      repository,
      collaborators: rejectedCollaborators()
    });

    await expect(executor.execute({ workerId: "worker-a", leaseSeconds: 30, claim }))
      .rejects.toMatchObject({ code: "generation_cancelled" });
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
      context_options: {
        budgetTokens: 8_000,
        compression: "auto",
        query: "Open the observatory door.",
        recentTurns: 4
      },
      prompt_protocol_version: "test-protocol",
      prompt_snapshot: validPromptSnapshot(),
      generation_base_identity: {
        operationKind: "append",
        expectedTurnNumber: claim.expectedTurnNumber,
        baseTurnNumber: claim.expectedTurnNumber - 1,
        campaignActiveTurnNumber: claim.expectedTurnNumber - 1,
        campaignStateRevision: 1,
        stateEditRevision: null,
        narrationCorrectionRevision: null,
        baseTurnId: null,
        stateFingerprint: "state-fingerprint",
        narrationFingerprint: null
      },
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
        loadGenerationContext: vi.fn(async () => ({
          authority: { currentContinuity: { continuitySummary: "The keeper is alive.", openThreads: [],
            canonicalFacts: [{ id: "11111111-1111-4111-8111-111111111111", content: "The keeper is alive." }],
            scratchpad: "Private harbor details." } },
          candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT
        })),
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
          scopes: {
            worldCanon: {},
            campaignCanon: {},
            chronicle: [],
            currentScene: null,
            currentContinuity: {
              continuitySummary: "The keeper is alive.",
              openThreads: [],
              canonicalFacts: [{ id: "11111111-1111-4111-8111-111111111111", content: "The keeper is alive." }],
              scratchpad: "Private harbor details."
            }
          }
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
        execute: vi.fn(async () => ({
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
        }))
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
      contextDiagnostics: { retrieval?: unknown; selectedContext?: unknown };
      sentFactIds?: unknown;
    };
    expect(accepted.chronicleRetrieval).toStrictEqual(DEDICATED_CHUNKED_AUDIT);
    expect(accepted.contextDiagnostics.selectedContext).toEqual([{ id: "authority", revision: expect.any(String) }]);
    expect(accepted.sentFactIds).toEqual(["11111111-1111-4111-8111-111111111111"]);
    const providerRequest = (collaborators.loadTextExecution as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    const provider = await providerRequest;
    expect((provider.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      canonicalBudgeting: true
    });
    const input = JSON.parse((provider.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].input);
    expect(input.authoritative_context.currentContinuity.canonicalFacts).toEqual([
      { id: "11111111-1111-4111-8111-111111111111", content: "The keeper is alive." }
    ]);
  });
});
