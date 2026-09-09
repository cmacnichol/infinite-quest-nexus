import { describe, expect, it, vi } from "vitest";
import type {
  ClaimedGeneration,
  IllustrationGenerationTransactionPort
} from "../../packages/application/src/index.js";
import type { GenerationExecutionRepository } from "../../packages/database/src/generation-execution-repository.js";
import type { GenerationExecutionPayload } from "../../packages/database/src/generation-execution-repository.js";
import type { DatabasePool } from "../../packages/database/src/pool.js";
import { PROMPT_TEMPLATE_CATALOG } from "../../packages/contracts/src/prompt-library.js";
import { sha256, stableStringify } from "../../packages/domain/src/index.js";
import { ContextBudgetError } from "../../packages/story-engine/src/context-budget.js";
import { generationExecutionProtocolIdentity, storyOnlyPromptSnapshot } from "../../packages/story-engine/src/index.js";
import {
  createGenerationExecutor,
  generationContextFingerprint,
  sentCanonicalFactIds,
  type GenerationExecutionCollaborators
} from "../../services/runtime/src/generation-executor-adapter.js";
import { providerPromptProtocolVersion } from "../../services/runtime/src/provider-application-composition.js";
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

function snapshotProtocolIdentity(snapshot: GenerationExecutionPayload["prompt_snapshot"]): string {
  return providerPromptProtocolVersion(snapshot);
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
    generation_policy: null,
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
  it("preserves the historical context fingerprint field set and separates frozen policy", () => {
    const input = { providerId: "provider", model: "model", protocol: "legacy", expectedTurnNumber: 2, action: "Act", inputMode: "action", storyLength: { label: "short" }, context: { world: "canon" } };
    expect(generationContextFingerprint(input)).toBe("6f4bd446bda2f101a509ba415a10f79036caf7d252b4f08fe37378e351254de3");
    expect(generationContextFingerprint({ ...input, generationPolicyIdentity: "frozen-policy" })).not.toBe(generationContextFingerprint(input));
  });
  it.each([0, Number.POSITIVE_INFINITY])("rejects supplied effective context window %s before provider execution", async (modelContextWindowTokens) => {
    const job = completeGenerationExecutionPayload();
    job.context_options.modelContextWindowTokens = modelContextWindowTokens;
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async () => true), savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => undefined), markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true),
      markCommitting: vi.fn(async () => true), commitAcceptedTurn: vi.fn(async () => ({ turnId: "unexpected" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = { id: claim.providerProfileId, name: "Provider", providerRole: "text" as const, providerType: "openai_compatible" as const,
      model: "test-model", contextWindowTokens: 16_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {}, execute: vi.fn() };
    const collaborators = { ...rejectedCollaborators(), loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write fiction.") };

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators }).execute({ workerId: "invalid-window", leaseSeconds: 30, claim })).resolves.toBe(true);
    expect(provider.execute).not.toHaveBeenCalled();
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "context_budget_invalid" }));
  });

  it("accounts for the frozen Story Direction supplement before context retrieval or dispatch", async () => {
    const job = completeGenerationExecutionPayload();
    const supplement = "frozen story direction instruction ".repeat(6_000);
    const unmodifiedPolicy = {
      version: 1, playMode: "story_only", turnControlStyle: "flexible_scene", protocolVersion: "story-only-v1",
      prompts: {
        ...storyOnlyPromptSnapshot(),
        systemSupplement: supplement,
        systemSupplementHash: sha256(supplement)
      }
    } as const;
    job.generation_policy = unmodifiedPolicy;
    job.prompt_protocol_version = generationExecutionProtocolIdentity(snapshotProtocolIdentity(job.prompt_snapshot), unmodifiedPolicy);
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async () => true), savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => undefined), markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true),
      markCommitting: vi.fn(async () => true), commitAcceptedTurn: vi.fn(async () => ({ turnId: "unexpected" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = { id: claim.providerProfileId, name: "Provider", providerRole: "text" as const, providerType: "openai_compatible" as const,
      model: "test-model", contextWindowTokens: 12_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {}, execute: vi.fn() };
    const loadGenerationContext = vi.fn();
    const collaborators = {
      ...rejectedCollaborators(), loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write fiction."),
      memory: { loadGenerationContext }, recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators }).execute({ workerId: "story-only-envelope", leaseSeconds: 30, claim })).resolves.toBe(true);

    expect(loadGenerationContext).not.toHaveBeenCalled();
    expect(provider.execute).not.toHaveBeenCalled();
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "context_budget_invalid" }));
  });

  it("marks a hash-mismatched frozen Story Direction policy recoverable before provider work", async () => {
    const job = completeGenerationExecutionPayload();
    const unmodifiedPolicy = {
      version: 1, playMode: "story_only", turnControlStyle: "flexible_scene", protocolVersion: "story-only-v1",
      prompts: storyOnlyPromptSnapshot()
    } as const;
    job.prompt_protocol_version = generationExecutionProtocolIdentity(snapshotProtocolIdentity(job.prompt_snapshot), unmodifiedPolicy);
    job.generation_policy = { ...unmodifiedPolicy, prompts: { ...unmodifiedPolicy.prompts, systemSupplementHash: "0".repeat(64) } };
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async () => true), savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => undefined), markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true),
      markCommitting: vi.fn(async () => true), commitAcceptedTurn: vi.fn(async () => ({ turnId: "unexpected" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = { id: claim.providerProfileId, name: "Provider", providerRole: "text" as const, providerType: "openai_compatible" as const,
      model: "test-model", contextWindowTokens: 16_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {}, execute: vi.fn() };
    const loadGenerationContext = vi.fn();
    const collaborators = {
      ...rejectedCollaborators(), loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write fiction."),
      memory: { loadGenerationContext }, recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators }).execute({ workerId: "story-only-hash", leaseSeconds: 30, claim })).resolves.toBe(false);

    expect(loadGenerationContext).not.toHaveBeenCalled();
    expect(provider.execute).not.toHaveBeenCalled();
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "generation_policy_invalid",
      recoveryMetadata: expect.objectContaining({ reason: "generation_policy_invalid" })
    }));
    expect(repository.markFailed).not.toHaveBeenCalled();
  });

  it("marks a schema-invalid non-null policy recoverable before provider work", async () => {
    const job = completeGenerationExecutionPayload();
    job.generation_policy = { version: 1, playMode: "legacy", turnControlStyle: "flexible_scene" } as never;
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async () => true), savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => undefined), markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true),
      markCommitting: vi.fn(async () => true), commitAcceptedTurn: vi.fn(async () => ({ turnId: "unexpected" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = { id: claim.providerProfileId, name: "Provider", providerRole: "text" as const, providerType: "openai_compatible" as const,
      model: "test-model", contextWindowTokens: 16_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {}, execute: vi.fn() };
    const loadGenerationContext = vi.fn();
    const collaborators = {
      ...rejectedCollaborators(), loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write fiction."),
      memory: { loadGenerationContext }, recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators }).execute({ workerId: "story-only-schema", leaseSeconds: 30, claim })).resolves.toBe(false);

    expect(loadGenerationContext).not.toHaveBeenCalled();
    expect(provider.execute).not.toHaveBeenCalled();
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "generation_policy_invalid" }));
  });

  it("extracts fact authority from exact main, extension, and LM Studio recovery bodies only", () => {
    const authorized = "11111111-1111-4111-8111-111111111111";
    const invented = "22222222-2222-4222-8222-222222222222";
    const authority = { currentContinuity: { canonicalFacts: [{ id: authorized, content: "The true fact." }] } };
    const main = JSON.stringify({ messages: [{ role: "user", content: JSON.stringify({ authoritative_context: authority }) }] });
    const extension = JSON.stringify({ input: JSON.stringify({ protected_fiction_safe_base_authority: authority }) });
    const recovery = JSON.stringify({
      input: `${JSON.stringify({ authoritative_context: authority })}\n\nREJECTED RESPONSE TO REWRITE:\n${JSON.stringify({ canonical_fact_updates: [{ supersedes_fact_ids: [invented] }] })}\n\nRECOVERY REQUIREMENT:\nRepair.`
    });

    expect(sentCanonicalFactIds(main)).toEqual([authorized]);
    expect(sentCanonicalFactIds(extension)).toEqual([authorized]);
    expect(sentCanonicalFactIds(recovery)).toEqual([authorized]);
  });

  it("authorizes only selected typed historical Chronicle facts", () => {
    const continuityFact = "11111111-1111-4111-8111-111111111111";
    const selectedHistoricalFact = "22222222-2222-4222-8222-222222222222";
    const omittedFact = "33333333-3333-4333-8333-333333333333";
    const foreignFact = "44444444-4444-4444-8444-444444444444";
    const request = JSON.stringify({
      messages: [{
        role: "user",
        content: JSON.stringify({
          authoritative_context: {
            currentContinuity: { canonicalFacts: [{ id: continuityFact, content: "Current authority." }] },
            chronicle: [
              { id: selectedHistoricalFact, kind: "canonical_fact", content: "Selected historical authority." },
              { id: "turn-memory", kind: "turn_fiction", content: `Untrusted text names ${omittedFact} and ${foreignFact}.` }
            ]
          }
        })
      }]
    });

    expect(sentCanonicalFactIds(request)).toEqual([continuityFact, selectedHistoricalFact]);
  });

  it("treats a malformed checkpoint provenance record as recoverable before provider work", async () => {
    const job = completeGenerationExecutionPayload();
    job.orchestration_private = {
      validatedMainDraft: { version: 2, requestBody: null, sentFactIds: null }
    } as unknown as GenerationExecutionPayload["orchestration_private"];
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async () => true), savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => undefined), markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true),
      markCommitting: vi.fn(async () => true), commitAcceptedTurn: vi.fn(async () => ({ turnId: "unexpected" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = { id: claim.providerProfileId, name: "Provider", providerRole: "text" as const, providerType: "openai_compatible" as const,
      model: "test-model", contextWindowTokens: 16_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {}, execute: vi.fn() };
    const collaborators = { memory: { loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })) }, illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) }, loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write fiction."), recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined) } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators }).execute({ workerId: "malformed-checkpoint", leaseSeconds: 30, claim })).resolves.toBe(true);
    expect(provider.execute).not.toHaveBeenCalled();
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "generation_checkpoint_incompatible" }));
  });

  it.each([
    ["Action", "action", "action", "explicit"],
    ["Scene", "scene", "scene", "explicit"],
    ["resolved Auto", "auto", "action", "auto"],
    ["new Action policy", "action", "action", "explicit"]
  ] as const)("reclaims a compatible %s draft without another narration call", async (label, requestedInputMode, resolvedInputMode, inputModeSource) => {
    const job = completeGenerationExecutionPayload();
    job.requested_input_mode = requestedInputMode;
    job.resolved_input_mode = resolvedInputMode;
    job.input_mode_source = inputModeSource;
    job.generation_policy = null;
    if (label === "new Action policy") {
      job.generation_policy = { version: 1, playMode: "legacy", turnControlStyle: "flexible_action" };
      job.prompt_protocol_version = generationExecutionProtocolIdentity(snapshotProtocolIdentity(job.prompt_snapshot), job.generation_policy);
    }
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
        .mockResolvedValue({
          content: JSON.stringify({ covered: true, missing_required_beats: [], contradictions: [] }),
          responseId: "scene-coverage", finishReason: "stop", outputLimited: false,
          modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {}
        })
    };
    const collaborators = {
      memory: {
        loadGenerationContext: vi.fn(async () => ({
          authority: {}, candidates: [], baseIdentity: job.generation_base_identity,
          chronicleRetrieval: DEDICATED_CHUNKED_AUDIT
        }))
      },
      illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) },
      loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn((_snapshot, key) => String(key)),
      recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;

    const executor = createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators });
    await expect(executor.execute({ workerId: "worker-a", leaseSeconds: 30, claim })).resolves.toBe(true);
    expect(job.orchestration_private.validatedMainDraft).toBeDefined();
    job.attempts = 2;
    await expect(executor.execute({ workerId: "worker-b", leaseSeconds: 30, claim: { ...claim, attempts: 2 } })).resolves.toBe(true);

    const mainNarrationCalls = (provider.execute as ReturnType<typeof vi.fn>).mock.calls
      .filter(([request]) => request.systemPrompt === "story_system");
    expect(mainNarrationCalls).toHaveLength(1);
    expect(repository.commitAcceptedTurn).toHaveBeenCalledWith(expect.objectContaining({
      story: expect.objectContaining({ narration: firstNarration }),
      response: expect.objectContaining({ responseId: "first-response" })
    }));
    if (label === "new Action policy") {
      expect(job.generation_policy).toEqual({ version: 1, playMode: "legacy", turnControlStyle: "flexible_action" });
    } else {
      expect(job.prompt_protocol_version).toBe("test-protocol");
      expect(job.generation_policy).toBeNull();
    }
    expect(repository.markRecoverable).not.toHaveBeenCalled();
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
    const immediateEvent = {
      id: "immediate-bell",
      triggerId: "00000000-0000-4000-8000-000000000010",
      sourceTriggerId: "00000000-0000-4000-8000-000000000010",
      sourceTurn: claim.expectedTurnNumber,
      addTextAfter: true,
      instructions: "A silver bell rings in the observatory.",
      summary: "The bell must ring."
    };
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
        .mockResolvedValueOnce({ content: JSON.stringify({ event_results: [{ event_id: "immediate-bell", covered: false, missing_required_beats: ["bell"], contradictions: [] }] }), responseId: "coverage-1", finishReason: "stop", outputLimited: false, modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: story("The observatory door opens.\n\nA silver bell rings."), responseId: "repair", finishReason: "stop", outputLimited: false, modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: JSON.stringify({ event_results: [{ event_id: "immediate-bell", covered: true, missing_required_beats: [], contradictions: [] }] }), responseId: "coverage-2", finishReason: "stop", outputLimited: false, modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: JSON.stringify({ event_results: [{ event_id: "immediate-bell", covered: true, missing_required_beats: [], contradictions: [] }] }), responseId: "appended-coverage", finishReason: "stop", outputLimited: false, modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {} })
    };
    const collaborators = {
      memory: { loadGenerationContext: vi.fn(async () => ({
        authority: {
          worldCanon: {
            rpgStats: [{ id: "private-stat", value: 17, note: "PRIVATE_STAT_CANARY" }],
            trackers: [
              { id: "private-tracker", value: 12, note: "PRIVATE_TRACKER_CANARY" },
              { id: "doorway", name: "Silver doorway", value: "hidden" }
            ]
          },
          currentContinuity: {
            rpgStats: [{ id: "private-current-stat", value: 9, note: "PRIVATE_STAT_CANARY" }],
            eventTriggers: [{ id: "private-trigger", instructions: "PRIVATE_TRACKER_CANARY" }]
          }
        },
        candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT
      })) },
      illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) },
      loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write a concise fictional scene."),
      recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;

    const executor = createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators });
    await expect(executor.execute({ workerId: "event-repair-initial", leaseSeconds: 30, claim })).resolves.toBe(true);
    const validatedMainDraftHash = job.orchestration_private.validatedMainDraft?.draftHash;
    expect(validatedMainDraftHash).toEqual(expect.any(String));
    job.orchestration_private.eventCoverageRepair = {
      rejectedFinalStoryHash: "legacy-main-rejection",
      validatedMainDraftHash: validatedMainDraftHash!,
      extensionFinalStoryHash: null,
      extensionProducingAttempt: null,
      consumedAttempt: 1
    };
    job.orchestration_private.afterEvents = [immediateEvent] as never;
    await expect(executor.execute({ workerId: "event-repair-worker", leaseSeconds: 30, claim: { ...claim, attempts: 2 } })).resolves.toBe(true);

    expect(job.orchestration_private.eventCoverageRepair).toEqual(expect.objectContaining({
      consumedAttempt: 1,
      mainRepairConsumed: true
    }));
    expect(repository.commitAcceptedTurn).toHaveBeenCalledWith(expect.objectContaining({
      story: expect.objectContaining({ narration: "The observatory door opens.\n\nA silver bell rings." })
    }));
    const serializedFictionRequests = provider.execute.mock.calls.map(([request]) => String(request.input));
    expect(serializedFictionRequests).toHaveLength(6);
    for (const request of serializedFictionRequests) {
      expect(request).not.toContain("PRIVATE_STAT_CANARY");
      expect(request).not.toContain("PRIVATE_TRACKER_CANARY");
    }
    expect(serializedFictionRequests[0]).toContain("Silver doorway");
    expect(provider.execute.mock.calls[3]?.[0].budgetOutput).toEqual({
      kind: "event_extension",
      protectedStory: {
        narration: "The observatory door opens.",
        scratchpad: "The door is open.",
        continuitySummary: "The observatory door is open.",
        openThreads: []
      },
      narrationCharacterLimit: 200_000
    });
    expect(JSON.parse(provider.execute.mock.calls[3]?.[0].input || "{}")).toMatchObject({
      protected_fiction_safe_base_authority: expect.objectContaining({
        worldCanon: expect.objectContaining({ trackers: [{ id: "doorway", name: "Silver doorway", value: "hidden" }] })
      }),
      complete_validated_main_draft: expect.objectContaining({ narration: "The observatory door opens." }),
      original_player_action: "Open the observatory door."
    });
    job.attempts = 2;
    job.orchestration_private.extension = {
      story: JSON.parse(story("The observatory door opens.\n\nThe keeper's unique warning remains.")),
      finalStoryHash: "",
      producingAttempt: 1,
      producingOperation: "event_extension",
      validatedMainDraftHash: job.orchestration_private.validatedMainDraft?.draftHash || "missing-main-draft",
      producingRequestPayloadHash: "extension-request-fixture",
      sentFactIds: []
    };
    job.orchestration_private.extension.finalStoryHash = stableStringify(job.orchestration_private.extension.story);
    delete job.orchestration_private.eventCoverageRepair;
    provider.execute.mockReset()
      .mockResolvedValueOnce({ content: JSON.stringify({ covered: false, missing_required_beats: ["bell"], contradictions: [] }), responseId: "coverage-drop", finishReason: "stop", outputLimited: false, modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {} })
      .mockResolvedValueOnce({ content: story("The observatory door opens.\n\nA silver bell rings."), responseId: "repair-drop", finishReason: "stop", outputLimited: false, modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {} });
    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "event-repair-reclaim", leaseSeconds: 30, claim: { ...claim, attempts: 2 } })).resolves.toBe(true);
    expect(provider.execute).not.toHaveBeenCalled();
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "generation_checkpoint_incompatible"
    }));
    expect(repository.commitAcceptedTurn).toHaveBeenCalledTimes(2);
  });

  it("repairs before-event coverage once, revalidates it, and commits the repaired main draft", async () => {
    const job = completeGenerationExecutionPayload();
    job.orchestration_private.beforeEvents = [{
      id: "before-event", sourceTriggerId: "before-trigger", name: "Bell", timing: "before",
      condition: "", effect: "", instructions: "A bell rings in the hall.", reason: "", sourceTurn: 3,
      addTextAfter: false
    }];
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async (_scope, value) => { job.orchestration_private = value; return true; }),
      savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true), recordAttempt: vi.fn(async () => undefined),
      markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true), markCommitting: vi.fn(async () => true),
      commitAcceptedTurn: vi.fn(async () => ({ turnId: "turn" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const output = (narration: string) => JSON.stringify({ narration, choices: ["A", "B", "C", "D"], custom_action_suggestion: "Wait.", scratchpad: "", tracker_updates: [], image_prompt: "", continuity_summary: "", canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: [] });
    const provider = { id: claim.providerProfileId, name: "Provider", providerRole: "text" as const, providerType: "openai_compatible" as const,
      model: "test-model", contextWindowTokens: 16_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {},
      execute: vi.fn()
        .mockResolvedValueOnce({ content: output("The hall is quiet."), responseId: "main", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: JSON.stringify({ event_results: [{ event_id: "before-event", covered: false, missing_required_beats: ["before-event"], contradictions: [] }] }), responseId: "miss", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: output("The hall is quiet.\n\nA bell rings in the hall."), responseId: "repair", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: JSON.stringify({ event_results: [{ event_id: "before-event", covered: true, missing_required_beats: [], contradictions: [] }] }), responseId: "verified", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} }) };
    const collaborators = { memory: { loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })) }, illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) }, loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write fiction."), recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined) } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators }).execute({ workerId: "before-repair", leaseSeconds: 30, claim })).resolves.toBe(true);
    expect(repository.markRecoverable).not.toHaveBeenCalled();
    expect(provider.execute).toHaveBeenCalledTimes(4);
    expect(repository.commitAcceptedTurn).toHaveBeenCalledWith(expect.objectContaining({ story: expect.objectContaining({ narration: expect.stringContaining("bell rings") }) }));

  });

  it("stops after a rewritten before-event draft still fails coverage", async () => {
    const job = completeGenerationExecutionPayload();
    job.orchestration_private.beforeEvents = [{
      id: "before-event", sourceTriggerId: "before-trigger", name: "Bell", timing: "before",
      condition: "", effect: "", instructions: "A bell rings in the hall.", reason: "", sourceTurn: 3,
      addTextAfter: false
    }];
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async (_scope, value) => { job.orchestration_private = value; return true; }),
      savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true), recordAttempt: vi.fn(async () => undefined),
      markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true), markCommitting: vi.fn(async () => true),
      commitAcceptedTurn: vi.fn(async () => ({ turnId: "turn" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const output = (narration: string) => JSON.stringify({ narration, choices: ["A", "B", "C", "D"], custom_action_suggestion: "Wait.", scratchpad: "", tracker_updates: [], image_prompt: "", continuity_summary: "", canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: [] });
    const provider = { id: claim.providerProfileId, name: "Provider", providerRole: "text" as const, providerType: "openai_compatible" as const,
      model: "test-model", contextWindowTokens: 16_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {},
      execute: vi.fn()
        .mockResolvedValueOnce({ content: output("The hall is quiet."), responseId: "main", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: JSON.stringify({ event_results: [{ event_id: "before-event", covered: false, missing_required_beats: ["before-event"], contradictions: [] }] }), responseId: "miss", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: output("The hall remains quiet."), responseId: "repair", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: JSON.stringify({ event_results: [{ event_id: "before-event", covered: false, missing_required_beats: ["before-event"], contradictions: [] }] }), responseId: "still-missing", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} }) };
    const collaborators = { memory: { loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })) }, illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) }, loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write fiction."), recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined) } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators }).execute({ workerId: "before-repair-exhausted", leaseSeconds: 30, claim })).resolves.toBe(true);

    expect(provider.execute).toHaveBeenCalledTimes(4);
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "event_coverage_failed",
      recoveryMetadata: expect.objectContaining({ stage: "event_coverage", repairAttempted: true })
    }));
  });

  it("uses replacement output budgeting for a feasible near-limit before-event rewrite", async () => {
    const job = completeGenerationExecutionPayload();
    job.orchestration_private.beforeEvents = [{
      id: "before-event", sourceTriggerId: "before-trigger", name: "Bell", timing: "before",
      condition: "", effect: "", instructions: "A bell rings in the hall.", reason: "", sourceTurn: 3,
      addTextAfter: false
    }];
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async (_scope, value) => { job.orchestration_private = value; return true; }),
      savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true), recordAttempt: vi.fn(async () => undefined),
      markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true), markCommitting: vi.fn(async () => true),
      commitAcceptedTurn: vi.fn(async () => ({ turnId: "turn" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const output = (narration: string) => JSON.stringify({ narration, choices: ["A", "B", "C", "D"], custom_action_suggestion: "Wait.", scratchpad: "", tracker_updates: [], image_prompt: "", continuity_summary: "", canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: [] });
    const provider = { id: claim.providerProfileId, name: "Provider", providerRole: "text" as const, providerType: "openai_compatible" as const,
      model: "test-model", contextWindowTokens: 1_000_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {},
      execute: vi.fn(async (request: { budgetOutput?: { kind: string } }) => {
        if (request.budgetOutput?.kind === "story_replace") return { content: output("A bell rings in the hall."), responseId: "repair", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} };
        if (request.budgetOutput?.kind === "event_extension") throw Object.assign(new Error("prefix-preserving output cannot fit"), { code: "extension_narration_limit_exceeded" });
        if ((provider.execute as ReturnType<typeof vi.fn>).mock.calls.length === 1) return { content: output("N".repeat(200_000)), responseId: "main", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} };
        return { content: JSON.stringify({ event_results: [{ event_id: "before-event", covered: (provider.execute as ReturnType<typeof vi.fn>).mock.calls.length > 2, missing_required_beats: (provider.execute as ReturnType<typeof vi.fn>).mock.calls.length > 2 ? [] : ["before-event"], contradictions: [] }] }), responseId: "coverage", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} };
      }) };
    const collaborators = { memory: { loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })) }, illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) }, loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write fiction."), recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined) } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators }).execute({ workerId: "near-limit-before-repair", leaseSeconds: 30, claim })).resolves.toBe(true);

    expect(provider.execute.mock.calls[2]?.[0].budgetOutput).toEqual({ kind: "story_replace" });
    expect(repository.markRecoverable).not.toHaveBeenCalled();
    expect(repository.commitAcceptedTurn).toHaveBeenCalledWith(expect.objectContaining({ story: expect.objectContaining({ narration: "A bell rings in the hall." }) }));
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
    expect(input.authoritative_context.currentContinuity).not.toHaveProperty("rpgStats");
    expect(input.authoritative_context.currentContinuity).not.toHaveProperty("eventTriggers");
    expect(input.authoritative_context.currentContinuity).not.toHaveProperty("pendingEventTriggers");
    expect(input.authoritative_context.chronicle.map((entry: { id: string }) => entry.id)).toEqual(["selected-memory"]);
    const accepted = (repository.commitAcceptedTurn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(accepted.contextDiagnostics.selectedContext).toEqual([{ id: "authority", revision: expect.any(String) }, { id: "selected-memory", revision: expect.any(String) }]);
    expect(accepted.contextDiagnostics.omittedContext).toEqual([{ id: "omitted-memory", revision: expect.any(String), reason: "context_limit" }]);
    expect(accepted.contextDiagnostics).toMatchObject({
      countMode: "estimated",
      estimatorVersion: "story-token-estimate-v1"
    });
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
      errorMessage: "Generation context could not be safely prepared.",
      recoveryMetadata: expect.objectContaining({
        diagnostic: {
          code: "context_budget_exceeded",
          operation: "story_generation",
          action: "adjust_context",
          scope: "provider_request",
          requiredTokens: 100,
          availableTokens: 10,
          countMode: "estimated",
          estimatorVersion: "story-token-estimate-v1"
        }
      })
    }));
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
    expect(repository.markFailed).not.toHaveBeenCalled();
    expect(provider.execute).toHaveBeenCalledOnce();
    expect(collaborators.memory.loadGenerationContext).toHaveBeenCalledWith({}, expect.objectContaining({
      expectedBaseIdentity: job.generation_base_identity,
      retrievalBudgetTokens: 8_000
    }));
  });

  it("classifies a provider-window overflow independently from a larger campaign context budget", async () => {
    const job = completeGenerationExecutionPayload();
    job.context_options = { ...job.context_options, budgetTokens: 1_000_000 };
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async () => true), savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => undefined), markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true),
      markCommitting: vi.fn(async () => true), commitAcceptedTurn: vi.fn(async () => ({ turnId: "unexpected" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = {
      id: claim.providerProfileId, name: "Constrained provider", providerRole: "text" as const,
      providerType: "openai_compatible" as const, model: "test-model", contextWindowTokens: 20_000,
      maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {}, execute: vi.fn()
    };
    const collaborators = {
      memory: {
        loadGenerationContext: vi.fn(async () => ({
          authority: { worldCanon: { gazetteer: "word ".repeat(12_000) } }, candidates: [],
          baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT
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
      recoveryMetadata: expect.objectContaining({ diagnostic: expect.objectContaining({ scope: "provider_request" }) })
    }));
    expect(provider.execute).not.toHaveBeenCalled();
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
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
        modelContextWindowTokens: 8_000,
        compression: "auto",
        query: "Open the observatory door.",
        recentTurns: 4
      },
      prompt_protocol_version: "test-protocol",
      prompt_snapshot: validPromptSnapshot(),
      generation_policy: null,
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
          candidates: [{
            id: "22222222-2222-4222-8222-222222222222", turnId: null, ordinal: 1,
            kind: "canonical_fact", content: "The historical keeper has left the observatory.", tokenEstimate: 12, rank: 1
          }, {
            id: "33333333-3333-4333-8333-333333333333", turnId: null, ordinal: 0,
            kind: "canonical_fact", content: "x".repeat(100_000), tokenEstimate: 25_000, rank: 2
          }], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT
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
            canonical_fact_updates: [{
              content: "The historical keeper has departed the observatory.",
              supersedes_fact_ids: ["22222222-2222-4222-8222-222222222222"]
            }],
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
    expect(accepted.contextDiagnostics.selectedContext).toEqual([
      { id: "authority", revision: expect.any(String) },
      { id: "22222222-2222-4222-8222-222222222222", revision: expect.any(String) }
    ]);
    expect(accepted.sentFactIds).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222"
    ]);
    expect(accepted.sentFactIds).not.toContain("33333333-3333-4333-8333-333333333333");
    const providerRequest = (collaborators.loadTextExecution as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    const provider = await providerRequest;
    expect((provider.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      canonicalBudgeting: true,
      effectiveContextWindowTokens: 8_000
    });
    const input = JSON.parse((provider.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].input);
    expect(input.authoritative_context.currentContinuity.canonicalFacts).toEqual([
      { id: "11111111-1111-4111-8111-111111111111", content: "The keeper is alive." }
    ]);
    expect(input.authoritative_context.chronicle).toEqual([expect.objectContaining({
      id: "22222222-2222-4222-8222-222222222222", kind: "canonical_fact"
    })]);
  });
});
