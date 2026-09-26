import { describe, expect, it, vi } from "vitest";
import { deriveTextExecutionPlan, presetPromptInjectedRemotely, STORY_PRESET_ROUTE_PROTOCOL_V2, textExecutionRouteBasisHash } from "../../packages/contracts/src/text-execution-plan.js";
import type {
  ClaimedGeneration,
  IllustrationGenerationTransactionPort
} from "../../packages/application/src/index.js";
import type { FactFormatRepairApplication, GenerationExecutionRepository } from "../../packages/database/src/generation-execution-repository.js";
import type { GenerationExecutionPayload } from "../../packages/database/src/generation-execution-repository.js";
import type { DatabasePool } from "../../packages/database/src/pool.js";
import { PROMPT_TEMPLATE_CATALOG } from "../../packages/contracts/src/prompt-library.js";
import { storyTurnOutputSchema } from "../../packages/contracts/src/generation.js";
import { defaultStoryMemoryPolicy, storyMemoryPolicyHash } from "../../packages/contracts/src/story-memory-policy.js";
import { characterFictionAuthority, sha256, stableStringify } from "../../packages/domain/src/index.js";
import { canonicalEvidenceJson, readStoryEvidenceFromSource } from "../../packages/application/src/memory/generation-context.js";
import { ContextBudgetError } from "../../packages/story-engine/src/context-budget.js";
import { generationExecutionProtocolIdentity, PreparedResponseContractError, serializeProviderRequest, storyOnlyPromptSnapshot } from "../../packages/story-engine/src/index.js";
import {
  createGenerationExecutor,
  callCampaignTextProvider,
  appendFactFormatRepairApplication,
  bindCampaignTextExecutionPlan,
  deriveCampaignTextExecutionPlan,
  bindCampaignResponseContract,
  responseContractInvocationDetails,
  generationContextFingerprint,
  planGenerationPromptContext,
  preparePrimaryReservation,
  semanticRepairScope,
  sentCanonicalFactIds,
  type GenerationExecutionCollaborators
} from "../../services/runtime/src/generation-executor-adapter.js";
import { providerPromptProtocolVersion } from "../../services/runtime/src/provider-application-composition.js";
import { resolveGenerationResponseContractsV2 } from "../../services/runtime/src/generation-response-contract.js";
import { getProviderOutputSchemaV2, type ProviderOutputSchemaV2 } from "../../packages/contracts/src/provider-output-schema.js";
import { appendStoryOutputEncodingContract, STORY_OUTPUT_ENCODING_CONTRACT_V3 } from "../../packages/contracts/src/story-prompt.js";
import { composeEffectiveStorySystemPrompt } from "../../packages/story-engine/src/effective-story-system-prompt.js";
import type { ResponseFormatEligibilityV2 } from "../../packages/contracts/src/text-response-format.js";
import { prepareGenerationReview } from "../../services/runtime/src/generation-review-adapter.js";
import { generationReviewCheckpointSchema, type GenerationReviewCheckpoint } from "../../packages/application/src/generation/review-checkpoint.js";
import { DEDICATED_CHUNKED_AUDIT } from "../fixtures/chronicle-retrieval-audits.js";
import { logger } from "../../packages/logger/src/index.js";

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

/**
 * Task 8 Step 3 golden fixture: the exact byte-for-byte provider request the
 * PRE-BRANCH code produced for a job frozen on story-native-v2, computed once
 * against commit f69785f4 (the commit immediately before this remediation
 * branch started) and pinned here so the "byte-identical after deployment"
 * unit test below compares current-code output against a real historical
 * artifact instead of comparing current code against itself.
 *
 * Produced by: `git worktree add <scratch>/wt-f69785f4 f69785f4`, junctioning
 * node_modules (root + every workspace package/app that has its own) into that
 * worktree, adding a temporary `tests/unit/__task8_golden_v2.test.ts` there
 * that constructs the IDENTICAL fixture below (same `claim`, same
 * `completeGenerationExecutionPayload()`, same `modelPolicy`/`verifiedEligibility`
 * shape, adapted only for the pre-branch `eligible(operation, streaming)`
 * signature, which pre-branch has no third `schema` parameter because only
 * one story schema version, story-native-v2, existed yet) and printing the
 * `serializeProviderRequest(...).payloadHash`/`.body` its executor dispatched.
 * `git diff f69785f4 HEAD -- tests/unit/generation-executor-adapter.test.ts`
 * confirms `claim`, `validPromptSnapshot`, and `completeGenerationExecutionPayload`
 * are byte-for-byte unchanged since f69785f4, so this is the same fixture.
 * The worktree and its node_modules junctions were removed afterward.
 */
const TASK8_GOLDEN_V2_PAYLOAD_HASH = "c3920cfa0fab804179db268f26ad6f5b92977b16ea76ae823149e1895c72e6ee";
const TASK8_GOLDEN_V2_BODY_LENGTH = 4314;
const TASK8_GOLDEN_V2_BODY = "{\"model\":\"test-model\",\"messages\":[{\"role\":\"system\",\"content\":\"Write a concise fictional scene.\"},{\"role\":\"user\",\"content\":\"{\\\"authoritative_context\\\":{\\\"authoritativeRules\\\":[],\\\"worldCanon\\\":{},\\\"selectedCharacterId\\\":null,\\\"currentContinuity\\\":{},\\\"currentScene\\\":null,\\\"chronicle\\\":[]},\\\"narration_length\\\":{\\\"profile\\\":\\\"standard\\\",\\\"preferred_min_words\\\":450,\\\"preferred_max_words\\\":900,\\\"policy\\\":\\\"soft_pacing_goal\\\",\\\"early_stop_allowed\\\":true},\\\"instructions\\\":[\\\"Obey every applicable constraint in authoritative_context.authoritativeRules. These rules are mandatory and take priority over conflicting story history or player requests.\\\",\\\"Treat the database snapshot as authoritative even if provider conversation memory disagrees.\\\",\\\"Use corrected current continuity as authoritative for the next turn when it conflicts with historical narration or provider conversation memory. Empty corrected fields are intentional. Mandatory world rules still apply.\\\",\\\"Continue established chronology and character continuity.\\\",\\\"Treat narration_length as a soft pacing goal, not as a minimum requirement or permission to pad. Fidelity to authoritative context and the current turn input outranks length.\\\",\\\"Do not expose or invent non-diegetic resolution metadata.\\\",\\\"In canonical_fact_updates, supersedes_fact_ids may contain only exact IDs copied from canonical facts visible in the authoritative context; never invent a fact ID.\\\",\\\"The current turn input is a player action or attempt. Preserve its stated manner, dialogue, and intent while resolving uncertain outcomes from authoritative context and fiction-only outcome guidance.\\\",\\\"Once the attempted action and its directly supported consequence are complete, end the turn rather than opening unsupported developments to reach the preferred range.\\\",\\\"Return one complete JSON object, not a fragment or continuation.\\\"],\\\"current_turn_input\\\":{\\\"mode\\\":\\\"action\\\",\\\"text\\\":\\\"Open the observatory door.\\\"},\\\"task\\\":\\\"Generate the next complete story turn from this authoritative database snapshot. Prefer 450-900 narration words only while the current input and supported consequences naturally sustain that length. End early when the turn is complete; do not pad, repeat, or invent material story facts to meet the range.\\\"}\"}],\"temperature\":0,\"max_tokens\":2000,\"response_format\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"infinite_quest_story_native_v2\",\"strict\":true,\"schema\":{\"additionalProperties\":false,\"properties\":{\"canonical_fact_updates\":{\"items\":{\"additionalProperties\":false,\"properties\":{\"content\":{\"maxLength\":4000,\"minLength\":1,\"pattern\":\"^\\\\S(?:[\\\\s\\\\S]*\\\\S)?$\",\"type\":\"string\"},\"supersedes_fact_ids\":{\"items\":{\"maxLength\":36,\"minLength\":36,\"pattern\":\"^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$\",\"type\":\"string\"},\"maxItems\":100,\"type\":\"array\"}},\"required\":[\"content\",\"supersedes_fact_ids\"],\"type\":\"object\"},\"maxItems\":100,\"type\":\"array\"},\"canonical_facts\":{\"items\":{\"maxLength\":4000,\"minLength\":1,\"pattern\":\"^\\\\S(?:[\\\\s\\\\S]*\\\\S)?$\",\"type\":\"string\"},\"maxItems\":100,\"type\":\"array\"},\"choices\":{\"items\":{\"maxLength\":2000,\"minLength\":1,\"pattern\":\"^\\\\S(?:[\\\\s\\\\S]*\\\\S)?$\",\"type\":\"string\"},\"maxItems\":4,\"minItems\":4,\"type\":\"array\"},\"continuity_summary\":{\"maxLength\":20000,\"type\":\"string\"},\"custom_action_suggestion\":{\"maxLength\":2000,\"minLength\":1,\"pattern\":\"^\\\\S(?:[\\\\s\\\\S]*\\\\S)?$\",\"type\":\"string\"},\"image_prompt\":{\"maxLength\":20000,\"type\":\"string\"},\"narration\":{\"maxLength\":200000,\"minLength\":1,\"pattern\":\"^\\\\S(?:[\\\\s\\\\S]*\\\\S)?$\",\"type\":\"string\"},\"open_threads\":{\"items\":{\"maxLength\":4000,\"minLength\":1,\"pattern\":\"^\\\\S(?:[\\\\s\\\\S]*\\\\S)?$\",\"type\":\"string\"},\"maxItems\":500,\"type\":\"array\"},\"scratchpad\":{\"maxLength\":100000,\"type\":\"string\"},\"superseded_facts\":{\"items\":{\"maxLength\":4000,\"minLength\":1,\"pattern\":\"^\\\\S(?:[\\\\s\\\\S]*\\\\S)?$\",\"type\":\"string\"},\"maxItems\":0,\"type\":\"array\"},\"tracker_updates\":{\"items\":{\"additionalProperties\":true,\"type\":\"object\"},\"maxItems\":200,\"type\":\"array\"}},\"required\":[\"narration\",\"choices\",\"custom_action_suggestion\",\"scratchpad\",\"tracker_updates\",\"image_prompt\",\"continuity_summary\",\"canonical_facts\",\"superseded_facts\",\"canonical_fact_updates\",\"open_threads\"],\"type\":\"object\"}}}}";

describe("frozen Story route basis", () => {
  it("composes the saved preset exactly once and rejects a plan from another basis", () => {
    const basis = {
      version: 2 as const, selection: { kind: "openrouter_preset" as const, slug: "night-shift" },
      preset: { slug: "night-shift", versionId: "v1", configHash: "a".repeat(64) },
      candidates: [{ modelId: "story-model", providerPolicy: {}, contextWindowTokens: 16_000, maxOutputTokens: 1_000 }],
      presetSystemPrompt: "Use spare prose.", parameters: { temperature: 0.2 }, endpointReference: "endpoint",
      credentialReference: "profile", profileRevision: "profile", authorityRevision: "authority", requestTimeoutMs: 30_000,
      protocolVersion: "route-basis-v2"
    };
    const routeBasis = { ...basis, routeBasisHash: sha256(stableStringify(basis)) };
    const job = { ...completeGenerationExecutionPayload(), orchestration_private: { textExecutionRouteBasis: routeBasis } };
    const plan = deriveCampaignTextExecutionPlan(job, "Return Story JSON.")!;
    const request = bindCampaignTextExecutionPlan(job, { systemPrompt: "Return Story JSON.", input: "{}" });

    expect(request.systemPrompt).toBe("Use spare prose.\n\nReturn Story JSON.");
    expect(bindCampaignTextExecutionPlan(job, request, plan)).toBe(request);
    (request as { systemPrompt: string }).systemPrompt = "different";
    expect(() => bindCampaignTextExecutionPlan(job, request, plan)).toThrow("conflicts");

    const twoParagraphPlan = deriveCampaignTextExecutionPlan(job, "First operation paragraph.\n\nLast operation paragraph.")!;
    expect(() => bindCampaignTextExecutionPlan(job, {
      systemPrompt: "Last operation paragraph.", input: "{}"
    }, twoParagraphPlan)).toThrow("conflicts");

    const otherBasis = { ...basis, preset: { ...basis.preset, configHash: "b".repeat(64) } };
    const otherRouteBasis = { ...otherBasis, routeBasisHash: sha256(stableStringify(otherBasis)) };
    const otherJob = { ...job, orchestration_private: { textExecutionRouteBasis: otherRouteBasis } };
    expect(() => bindCampaignTextExecutionPlan(otherJob, {
      systemPrompt: plan.prompt,
      input: "{}"
    }, plan)).toThrow("different route basis");
  });

  it("binds a v2 remote-injected preset route without local preset text, tolerating a whitespace-padded operation prompt, with the v3 encoding contract last", () => {
    const basis = {
      version: 2 as const, selection: { kind: "openrouter_preset" as const, slug: "remote-route" },
      preset: { slug: "remote-route", versionId: "v1", configHash: "9".repeat(64) },
      candidates: [{ modelId: "@preset/remote-route", providerPolicy: {}, contextWindowTokens: 16_000, maxOutputTokens: 1_000 }],
      presetSystemPrompt: "PRESET SYSTEM TEXT", parameters: { temperature: 0.2 }, endpointReference: "endpoint",
      credentialReference: "profile", profileRevision: "profile", authorityRevision: "authority", requestTimeoutMs: 30_000,
      protocolVersion: STORY_PRESET_ROUTE_PROTOCOL_V2
    };
    const routeBasis = { ...basis, routeBasisHash: sha256(stableStringify(basis)) };
    expect(presetPromptInjectedRemotely(routeBasis)).toBe(true);
    const job = { ...completeGenerationExecutionPayload(), orchestration_private: { textExecutionRouteBasis: routeBasis } };

    const writerPrompt = "Write a concise fictional scene.";
    const composedWriterSystemPrompt = composeEffectiveStorySystemPrompt({
      writerPrompt, storyOnlyPolicy: null, storyMemoryPromptProtocol: null, encodingContract: ""
    });
    const v3OperationPrompt = appendStoryOutputEncodingContract(composedWriterSystemPrompt, STORY_OUTPUT_ENCODING_CONTRACT_V3);

    const plan = deriveCampaignTextExecutionPlan(job, v3OperationPrompt)!;
    expect(plan.prompt).toBe(v3OperationPrompt);
    expect(plan.prompt).not.toContain("PRESET SYSTEM TEXT");

    // A prompt-library override is not trimmed (prompt-library.ts) and the plain
    // writer path returns writerPrompt unchanged, so a real caller can bind a
    // request whose systemPrompt carries trailing whitespace the plan does not.
    expect(() => bindCampaignTextExecutionPlan(job, { systemPrompt: `${v3OperationPrompt}\n`, input: "{}" }, plan)).not.toThrow();
    const request = bindCampaignTextExecutionPlan(job, { systemPrompt: `${v3OperationPrompt}\n`, input: "{}" }, plan);

    expect(request.systemPrompt).toBe(plan.prompt);
    expect(request.systemPrompt).not.toContain("PRESET SYSTEM TEXT");
    expect(request.systemPrompt.endsWith(STORY_OUTPUT_ENCODING_CONTRACT_V3)).toBe(true);
  });

  it("uses the prebound main plan once and reduces retrieval budget before context planning", async () => {
    const presetPrompt = "Conserve context. ".repeat(1_000).trim();
    const basis = {
      version: 2 as const, selection: { kind: "openrouter_preset" as const, slug: "tight-route" },
      preset: { slug: "tight-route", versionId: "v1", configHash: "c".repeat(64) },
      candidates: [{ modelId: "story-model", providerPolicy: {}, contextWindowTokens: 20_000, maxOutputTokens: 2_000 }],
      presetSystemPrompt: presetPrompt, parameters: { temperature: 0.2 }, endpointReference: "endpoint",
      credentialReference: "profile", profileRevision: "profile", authorityRevision: "authority", requestTimeoutMs: 30_000,
      protocolVersion: "route-basis-v2"
    };
    const routeBasis = { ...basis, routeBasisHash: sha256(stableStringify(basis)) };
    const output = JSON.stringify({ narration: "The observatory door opens.", choices: ["Enter.", "Wait.", "Listen.", "Call."],
      custom_action_suggestion: "Study the door.", scratchpad: "", tracker_updates: [], image_prompt: "", continuity_summary: "", canonical_facts: [],
      superseded_facts: [], canonical_fact_updates: [], open_threads: [] });
    const run = async (frozenRouteBasis?: typeof routeBasis) => {
      const job = completeGenerationExecutionPayload();
      job.context_options = { ...job.context_options, budgetTokens: 15_000 };
      if (frozenRouteBasis) job.orchestration_private = { textExecutionRouteBasis: frozenRouteBasis };
      const repository = {
        loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
        saveOrchestration: vi.fn(async () => true), savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true),
        recordAttempt: vi.fn(async () => undefined), markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true),
        markCommitting: vi.fn(async () => true), commitAcceptedTurn: vi.fn(async () => ({ turnId: "turn" })), markFailed: vi.fn(async () => true),
        pauseForReview: vi.fn(async () => true)
      } as unknown as GenerationExecutionRepository;
      const providerResult = { content: output, responseId: "main", finishReason: "stop", outputLimited: false, modelInstanceId: "instance", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, reportedCost: null, rawMetadata: {} };
      const provider = { id: claim.providerProfileId, name: "Captured provider", providerRole: "text" as const,
        providerType: "openai_compatible" as const, model: "test-model", contextWindowTokens: 20_000, maxOutputTokens: 2_000,
        temperature: 0, requestTimeoutMs: 1_000, configuration: {}, execute: vi.fn(async (_request: unknown) => providerResult) };
      const preparedCalls: unknown[] = [];
      const executePrepared = vi.fn(async (input: unknown) => { preparedCalls.push(input); return providerResult; });
      let retrievalBudgetTokens: number | undefined;
      const loadGenerationContext = vi.fn(async (_pool: unknown, input: { retrievalBudgetTokens: number }) => {
        retrievalBudgetTokens = input.retrievalBudgetTokens;
        return { authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT };
      });
      const loadTextExecution = vi.fn(async () => provider);
      const collaborators = { memory: { loadGenerationContext }, illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) },
        loadTextExecution, verifyTextExecutionRouteAuthority: vi.fn(async () => true),
        promptFromSnapshot: vi.fn(() => "Write a concise fictional scene."), recordProfileCost: vi.fn(async () => undefined),
        attributeGenerationCostsToTurn: vi.fn(async () => undefined),
        ...(frozenRouteBasis ? { preparedTextExecutor: { execute: executePrepared } } : {}) } as unknown as GenerationExecutionCollaborators;
      await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
        .execute({ workerId: frozenRouteBasis ? "frozen-main" : "baseline-main", leaseSeconds: 30, claim })).resolves.toBe(true);
      expect(repository.markRecoverable).not.toHaveBeenCalled();
      expect(loadGenerationContext).toHaveBeenCalledOnce();
      return { retrievalBudgetTokens: retrievalBudgetTokens!,
        request: (frozenRouteBasis
          ? (preparedCalls[0] as { request: { systemPrompt: string } } | undefined)?.request
          : provider.execute.mock.calls[0]?.[0]) as { systemPrompt: string },
        prepared: executePrepared,
        loadTextExecution,
        commitAcceptedTurn: repository.commitAcceptedTurn as ReturnType<typeof vi.fn>,
        markFailed: repository.markFailed as ReturnType<typeof vi.fn> };
    };

    const baseline = await run();
    const frozen = await run(routeBasis);

    expect(frozen.retrievalBudgetTokens).toBeLessThan(baseline.retrievalBudgetTokens);
    expect(frozen.request.systemPrompt).toBe(`${presetPrompt}\n\nWrite a concise fictional scene.`);
    expect(frozen.request.systemPrompt.split(presetPrompt)).toHaveLength(2);
    expect(frozen.prepared).toHaveBeenCalledWith(expect.objectContaining({
      operation: "story_generation", plan: expect.objectContaining({ requestTimeoutMs: 30_000, parameters: { temperature: 0.2 }, candidates: basis.candidates })
    }));
    expect(frozen.loadTextExecution).not.toHaveBeenCalled();
    expect(frozen.commitAcceptedTurn).toHaveBeenCalledOnce();
    expect(frozen.markFailed).not.toHaveBeenCalled();
  });

  it("derives every auxiliary and repair prompt once at the prepared dispatch seam", async () => {
    const basis = {
      version: 2 as const, selection: { kind: "openrouter_preset" as const, slug: "night-shift" },
      preset: { slug: "night-shift", versionId: "v1", configHash: "d".repeat(64) },
      candidates: [{ modelId: "story-model", providerPolicy: {}, contextWindowTokens: 16_000, maxOutputTokens: 1_000 }],
      presetSystemPrompt: "Use spare prose.", parameters: { temperature: 0.2 }, endpointReference: "endpoint",
      credentialReference: "profile", profileRevision: "profile", authorityRevision: "authority", requestTimeoutMs: 30_000,
      protocolVersion: "route-basis-v2"
    };
    const routeBasis = { ...basis, routeBasisHash: sha256(stableStringify(basis)) };
    const job = { ...completeGenerationExecutionPayload(), orchestration_private: { textExecutionRouteBasis: routeBasis } };
    const provider = { id: "profile", name: "Frozen route", providerType: "openrouter" as const, providerRole: "text" as const, model: "story-model",
      contextWindowTokens: 16_000, maxOutputTokens: 1_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {}, execute: vi.fn(async (_request: unknown, _policy?: unknown) => ({
        content: "{}", responseId: "auxiliary", finishReason: "stop", outputLimited: false, modelInstanceId: "story-model", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, reportedCost: null, rawMetadata: {}
      })) };
    const preparedCalls: unknown[] = [];
    const executePrepared = vi.fn(async (input: unknown) => {
      preparedCalls.push(input);
      return {
      content: "{}", responseId: "auxiliary", finishReason: "stop", outputLimited: false, modelInstanceId: "story-model", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, reportedCost: null, rawMetadata: {}
      };
    });
    const dependencies = { pool: {} as DatabasePool, collaborators: { recordProfileCost: vi.fn(async () => undefined), preparedTextExecutor: { execute: executePrepared } } } as never;

    const operations = [
      "rpg_assessment", "event_trigger_before", "story_recovery", "story_choice_repair", "event_trigger_after",
      "event_extension", "scene_coverage_validation", "scene_coverage_rewrite", "story_continuity_review", "story_continuity_repair"
    ] as const;
    for (const operation of operations) {
      await callCampaignTextProvider(dependencies, provider, job, operation, {
        systemPrompt: `Actual ${operation} prompt.`, input: "{}"
      });
    }

    expect(provider.execute).not.toHaveBeenCalled();
    expect(preparedCalls).toHaveLength(operations.length);
    for (const [index, operation] of operations.entries()) {
      const prepared = preparedCalls[index] as { operation: string; request: { systemPrompt: string }; plan: { requestTimeoutMs: number; parameters: unknown; candidates: unknown } };
      expect(prepared.operation).toBe(operation);
      expect(prepared.request.systemPrompt).toBe(`Use spare prose.\n\nActual ${operation} prompt.`);
      expect(prepared.request.systemPrompt.split("Use spare prose.")).toHaveLength(2);
      expect(prepared.plan).toMatchObject({ requestTimeoutMs: 30_000, parameters: { temperature: 0.2 }, candidates: basis.candidates });
    }
  });

  it("fails a native invocation before inference when Task 5 has not supplied a prepared executor", async () => {
    const basis = {
      version: 2 as const, selection: { kind: "openrouter_preset" as const, slug: "night-shift" },
      preset: { slug: "night-shift", versionId: "v1", configHash: "e".repeat(64) },
      candidates: [{ modelId: "story-model", providerPolicy: {}, contextWindowTokens: 16_000, maxOutputTokens: 1_000 }],
      presetSystemPrompt: "Use spare prose.", parameters: {}, endpointReference: "endpoint", credentialReference: "profile",
      profileRevision: "profile", authorityRevision: "authority", requestTimeoutMs: 30_000, protocolVersion: "route-basis-v2"
    };
    const routeBasis = { ...basis, routeBasisHash: sha256(stableStringify(basis)) };
    const job = { ...completeGenerationExecutionPayload(), orchestration_private: { textExecutionRouteBasis: routeBasis } };
    const provider = { id: "profile", name: "legacy", providerRole: "text" as const, providerType: "openrouter" as const,
      model: "legacy", contextWindowTokens: 16_000, maxOutputTokens: 1_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {}, execute: vi.fn() };
    const dependencies = { pool: {} as DatabasePool, collaborators: { recordProfileCost: vi.fn(async () => undefined) } } as never;

    await expect(callCampaignTextProvider(dependencies, provider, job, "scene_coverage_validation", {
      systemPrompt: "Actual coverage prompt.", input: "{}"
    })).rejects.toMatchObject({ code: "prepared_text_execution_unavailable" });
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it("appends the v3 output-encoding contract to the primary story system prompt for a v3-frozen job, and leaves a v2-frozen job unchanged", async () => {
    const evidenceHash = "b".repeat(64);
    const verifiedEligibility = (
      operation: Parameters<typeof getProviderOutputSchemaV2>[0],
      streaming: boolean,
      schema: ProviderOutputSchemaV2
    ): ResponseFormatEligibilityV2 => ({
      status: "verified", reason: "verified",
      verification: {
        version: 2, providerType: "openai_compatible", endpointIdentity: "endpoint", model: "test-model",
        routeConfigHash: evidenceHash, adapterProtocol: "text-schema-adapter-v2", operation, schemaHash: schema.schemaHash,
        streaming, verifiedAt: "2026-09-18T00:00:00.000Z", expiresAt: "2026-09-20T00:00:00.000Z",
        providerRoutingSlugs: ["strict-route"], nativeOpenTrackerObjects: schema.requiresOpenTrackerObjects
      }
    });
    const modelPolicy = {
      version: 2 as const, policy: "required" as const, providerProfileId: claim.providerProfileId,
      admission: { mode: "json_schema" as const, basis: "model_verified" as const, verification: {
        version: 2 as const, providerType: "openai_compatible" as const, endpointIdentity: "endpoint", model: "test-model",
        routeConfigHash: evidenceHash, adapterProtocol: "text-schema-adapter-v2" as const, operation: "story" as const,
        schemaHash: getProviderOutputSchemaV2("story").schemaHash, streaming: false,
        verifiedAt: "2026-09-18T00:00:00.000Z", expiresAt: "2026-09-20T00:00:00.000Z",
        providerRoutingSlugs: ["strict-route"], nativeOpenTrackerObjects: getProviderOutputSchemaV2("story").requiresOpenTrackerObjects
      } },
      authority: {
        kind: "model_verified" as const, providerProfileId: claim.providerProfileId,
        providerType: "openai_compatible" as const, endpointIdentity: "endpoint", model: "test-model",
        providerConfigurationHash: evidenceHash, routeConfigHash: evidenceHash, verificationRegistryHash: evidenceHash,
        authorityRevision: "authority-v1"
      },
      operationClosureVersion: 2 as const,
      invocationKeys: ["story:nonstream"] as ("story:nonstream")[]
    };
    // The v2 fixture deliberately disqualifies the story-native-v3 schema so selection falls back to the catalog's v2 schema.
    const frozenContractsFor = (schemaVersion: "story-native-v3" | "story-native-v2") => resolveGenerationResponseContractsV2({
      queuedPolicy: modelPolicy, capabilityEvidenceHash: evidenceHash,
      eligible: (operation, streaming, schema) => schemaVersion === "story-native-v2" && operation === "story" && schema.version === "story-native-v3"
        ? { status: "unsupported", reason: "schema_incompatible", verification: null }
        : verifiedEligibility(operation, streaming, schema)
    });

    const run = async (schemaVersion: "story-native-v3" | "story-native-v2") => {
      const job = completeGenerationExecutionPayload();
      job.orchestration_private = { frozenResponseContracts: frozenContractsFor(schemaVersion) } as never;
      const output = JSON.stringify({ narration: "Fine.", choices: ["A", "B", "C", "D"],
        custom_action_suggestion: "Study the door.", scratchpad: "", tracker_updates: [], image_prompt: "", continuity_summary: "",
        canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: [] });
      const provider = { id: claim.providerProfileId, name: "Encoding fixture", providerRole: "text" as const,
        providerType: "openai_compatible" as const, model: "test-model", endpointIdentity: "endpoint",
        contextWindowTokens: 20_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {},
        execute: vi.fn(async (dispatchedRequest: any) => {
          const preparedRequest = serializeProviderRequest({ ...provider, baseUrl: "" }, dispatchedRequest);
          return { content: output, responseId: "main", finishReason: "stop", outputLimited: false, modelInstanceId: "instance",
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, reportedCost: null, rawMetadata: {}, preparedRequest };
        }) };
      const repository = {
        loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
        saveOrchestration: vi.fn(async () => true), savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true),
        recordAttempt: vi.fn(async () => undefined), markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true),
        markCommitting: vi.fn(async () => true), commitAcceptedTurn: vi.fn(async () => ({ turnId: "turn" })), markFailed: vi.fn(async () => true),
        pauseForReview: vi.fn(async () => true),
        reserveResponseContractInvocation: vi.fn(async (_scope: unknown, input: any) => ({ id: "b".repeat(64), status: "reserved", ...input })),
        markResponseContractInvocationDispatched: vi.fn(async (_scope: unknown, id: string) => ({ id, status: "dispatched" })),
        completeResponseContractInvocation: vi.fn(async (_scope: unknown, id: string, response: unknown) => ({ id, status: "completed", response }))
      } as unknown as GenerationExecutionRepository;
      const collaborators = {
        memory: { loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })) },
        illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) }, loadTextExecution: vi.fn(async () => provider),
        promptFromSnapshot: vi.fn(() => "Write a concise fictional scene."), recordProfileCost: vi.fn(async () => undefined),
        attributeGenerationCostsToTurn: vi.fn(async () => undefined)
      } as unknown as GenerationExecutionCollaborators;
      await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
        .execute({ workerId: `encoding-${schemaVersion}`, leaseSeconds: 30, claim })).resolves.toBe(true);
      expect(repository.markRecoverable).not.toHaveBeenCalled();
      expect(repository.markFailed).not.toHaveBeenCalled();
      const dispatched = (provider.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        systemPrompt: string;
        responseContract?: { mode: string; schemaVersion?: string | null; schemaHash?: string | null };
      };
      const resolvedResponse = await (provider.execute as ReturnType<typeof vi.fn>).mock.results[0]!.value as {
        preparedRequest: { body: string; payloadHash: string };
      };
      return { systemPrompt: dispatched.systemPrompt, responseContract: dispatched.responseContract, preparedRequest: resolvedResponse.preparedRequest };
    };

    const v3 = await run("story-native-v3");
    expect(v3.systemPrompt).toBe(`Write a concise fictional scene.\n\n${STORY_OUTPUT_ENCODING_CONTRACT_V3}`);

    const v2 = await run("story-native-v2");
    expect(v2.systemPrompt).toBe("Write a concise fictional scene.");
    expect(v2.systemPrompt).not.toContain(STORY_OUTPUT_ENCODING_CONTRACT_V3);

    // Task 8 Step 3: a job already frozen on story-native-v2 must keep dispatching
    // byte-identical requests after this deployment. Confirm the v2 job's bound
    // schema is still the exact pre-existing catalog entry (same hash/version,
    // untouched by the new v3 registry addition)...
    expect(v2.responseContract).toMatchObject({
      mode: "json_schema",
      schemaVersion: "story-native-v2",
      schemaHash: getProviderOutputSchemaV2("story", "story-native-v2").schemaHash
    });
    // ...and, decisively, that the current code's serialized request for this
    // exact fixture is byte-identical to the request the PRE-BRANCH code
    // (commit f69785f4) actually produced for the same fixture. This compares
    // against a real historical artifact, not against another run of today's
    // code, so it would catch a deterministic-but-different regression that a
    // same-code double-run could never detect.
    expect(v2.preparedRequest.body.length).toBe(TASK8_GOLDEN_V2_BODY_LENGTH);
    expect(v2.preparedRequest.body).toBe(TASK8_GOLDEN_V2_BODY);
    expect(v2.preparedRequest.payloadHash).toBe(TASK8_GOLDEN_V2_PAYLOAD_HASH);
  });

  it("composes a preset route's v3 primary system prompt as preset, then writer, then the encoding contract last", () => {
    // Reproduces the executor's exact primary-prompt composition (lines around
    // generation-executor-adapter.ts's input_preparation phase): first
    // composeEffectiveStorySystemPrompt (writer prompt, no contract yet), then
    // appendStoryOutputEncodingContract (contract last), then
    // deriveTextExecutionPlan (preset prepended). Appending the v3 contract
    // directly to routeBasis.presetSystemPrompt instead would skip the writer
    // prompt entirely and prove freeze/persistence but not this order.
    const basis = {
      version: 2 as const, selection: { kind: "openrouter_preset" as const, slug: "night-shift" },
      preset: { slug: "night-shift", versionId: "v1", configHash: "f".repeat(64) },
      candidates: [{ modelId: "story-model", providerPolicy: {}, contextWindowTokens: 16_000, maxOutputTokens: 1_000 }],
      presetSystemPrompt: "Use spare prose.", parameters: { temperature: 0.2 }, endpointReference: "endpoint",
      credentialReference: "profile", profileRevision: "profile", authorityRevision: "authority", requestTimeoutMs: 30_000,
      protocolVersion: "route-basis-v2"
    };
    const routeBasis = { ...basis, routeBasisHash: sha256(stableStringify(basis)) };
    const writerPrompt = "Write a concise fictional scene.";
    const composedWriterSystemPrompt = composeEffectiveStorySystemPrompt({
      writerPrompt, storyOnlyPolicy: null, storyMemoryPromptProtocol: null, encodingContract: ""
    });
    const storyBaseSystemPrompt = appendStoryOutputEncodingContract(composedWriterSystemPrompt, STORY_OUTPUT_ENCODING_CONTRACT_V3);
    const composedSystemPrompt = deriveTextExecutionPlan(routeBasis, storyBaseSystemPrompt).prompt;

    expect(composedSystemPrompt).toBe(`Use spare prose.\n\n${writerPrompt}\n\n${STORY_OUTPUT_ENCODING_CONTRACT_V3}`);
    expect(composedSystemPrompt.indexOf("Use spare prose.")).toBe(0);
    expect(composedSystemPrompt.endsWith(STORY_OUTPUT_ENCODING_CONTRACT_V3)).toBe(true);
  });
});

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
    pauseForReview: unexpectedBoolean,
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
    world_id: "00000000-0000-4000-8000-000000000006",
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

function authorizeReviewRetry(job: GenerationExecutionPayload, checkpoint: GenerationReviewCheckpoint): void {
  job.orchestration_private = {
    ...job.orchestration_private,
    generationReview: {
      ...checkpoint,
      state: "decided",
      revision: checkpoint.revision + 1,
      decisionJournal: [...checkpoint.decisionJournal, {
        reviewId: checkpoint.reviewId,
        revision: checkpoint.revision,
        actorUserId: job.owner_user_id,
        decision: "retry",
        decidedAt: "2026-09-17T00:00:00.000Z",
        candidateScope: checkpoint.candidateScope,
        candidateHash: checkpoint.gateCandidate.storyHash,
        findingsHash: checkpoint.originalFindingsHash,
        nextStage: checkpoint.stage,
        offeredCandidate: checkpoint.gateCandidate,
        offeredReasons: checkpoint.reasons,
        actionReceipt: {
          jobId: job.id,
          status: job.operation_kind === "append" ? "queued" : "replacement_queued",
          operationKind: job.operation_kind,
          replacementTurnId: job.replacement_turn_id
        }
      }]
    }
  };
}

describe("generation executor adapter", () => {
  function contractDispatchFixture() {
    const job = completeGenerationExecutionPayload();
    job.orchestration_private = {
      logicalAttempt: { version: 1, id: job.id, semanticRepairsConsumed: 0, reviewsConsumed: 0, automaticRepairsConsumed: 0, choiceRepairsConsumed: 0, eventCoverageRepairsConsumed: 0 },
      frozenResponseContracts: { selectionHash: "a".repeat(64), contracts: {
        "story:nonstream": { version: 1, mode: "json_object", operation: "story", streaming: false, forbidFormatFallback: true }
      } }
    } as never;
    const provider: any = { id: job.provider_profile_id, name: "Contract fixture", providerRole: "text" as const, providerType: "openai_compatible" as const,
      model: "test-model", contextWindowTokens: 16_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {}, execute: vi.fn() };
    const completed = vi.fn(async (_scope: unknown, id: string, response: unknown) => ({ id, status: "completed", response }));
    const dependencies: any = { pool: {} as DatabasePool, responseContractScope: { jobId: job.id, ownerUserId: job.owner_user_id, workerId: "contract-fixture" },
      repository: { reserveResponseContractInvocation: vi.fn(async (_scope: unknown, input: any) => ({ id: "b".repeat(64), status: "reserved", ...input })),
        markResponseContractInvocationDispatched: vi.fn(async (_scope: unknown, id: string) => ({ id, status: "dispatched" })), completeResponseContractInvocation: completed },
      collaborators: { onProviderDispatch: vi.fn(), recordProfileCost: vi.fn(async () => undefined) } } as never;
    return { job, provider, dependencies, completed };
  }

  it("rejects an oversized frozen request before creating its primary reservation", () => {
    const { job, provider } = contractDispatchFixture();
    expect(() => preparePrimaryReservation(provider, job, "story_generation", {
      systemPrompt: "Rules", input: "History. ".repeat(10_000)
    }, true)).toThrow(expect.objectContaining({ code: "context_budget_exceeded", scope: "provider_request" }));
  });

  it("keeps pre-dispatch budget rejection retryable without creating an interrupted-output review", async () => {
    const { job, provider } = contractDispatchFixture();
    provider.maxOutputTokens = 1;
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async (_scope, value) => { job.orchestration_private = value; return true; }),
      pauseForReview: vi.fn(async () => true), markRecoverable: vi.fn(async () => true), markFailed: vi.fn(async () => true),
      commitAcceptedTurn: vi.fn(), recordAttempt: vi.fn()
    } as unknown as GenerationExecutionRepository;
    const collaborators = {
      memory: { loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })) },
      illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) }, loadTextExecution: vi.fn(async () => provider),
      promptFromSnapshot: vi.fn(() => "Write fiction."), recordProfileCost: vi.fn(), attributeGenerationCostsToTurn: vi.fn()
    } as unknown as GenerationExecutionCollaborators;
    const executor = createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators });
    for (const attempts of [1, 2]) {
      job.attempts = attempts;
      await executor.execute({ workerId: "pre-dispatch-budget", leaseSeconds: 30, claim: { ...claim, attempts } });
      expect(repository.markRecoverable).toHaveBeenLastCalledWith(expect.objectContaining({ errorCode: "continuity_output_budget_exceeded" }));
      expect(job.orchestration_private?.primaryReservation).toBeUndefined();
    }
    expect(repository.pauseForReview).not.toHaveBeenCalled();
    expect(repository.markFailed).not.toHaveBeenCalled();
    expect(provider.execute).not.toHaveBeenCalled();
    expect(repository.recordAttempt).not.toHaveBeenCalled();
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
  });

  it("rejects a new-mode provider result whose prepared request differs from its reservation", async () => {
    const { job, provider, dependencies, completed } = contractDispatchFixture();
    provider.execute = vi.fn(async () => ({ content: "{}", responseId: "result", finishReason: "stop", outputLimited: false, modelInstanceId: "test", usage: {}, reportedCost: null, rawMetadata: {}, preparedRequest: { body: "{\\\"tampered\\\":true}", payloadHash: sha256("{\\\"tampered\\\":true}") } }));
    await expect(callCampaignTextProvider(dependencies, provider as never, job, "story_generation", { systemPrompt: "rules", input: "action" })).rejects.toMatchObject({ code: "response_contract_identity_mismatch" });
    expect(provider.execute).toHaveBeenCalledOnce();
    expect(completed).not.toHaveBeenCalled();
  });

  it("does not replace completed response provenance when a post-success cost write fails", async () => {
    const warnings = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const { job, provider, dependencies, completed } = contractDispatchFixture();
    provider.execute = vi.fn(async (request: any) => {
      const preparedRequest = serializeProviderRequest({ ...provider, baseUrl: "" }, request);
      return { content: "{}", responseId: "result", finishReason: "stop", outputLimited: false, modelInstanceId: "test", usage: {}, reportedCost: null, rawMetadata: {}, returnedModel: "returned", returnedProviderRoute: "route", preparedRequest };
    });
    dependencies.collaborators.recordProfileCost.mockRejectedValueOnce(new Error("cost write failed"));
    await expect(callCampaignTextProvider(dependencies, provider as never, job, "story_generation", { systemPrompt: "rules", input: "action" })).rejects.toThrow("cost write failed");
    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledWith(expect.any(Object), expect.any(String), {
      returnedModel: "returned",
      returnedProviderRoute: "route",
      diagnosticCode: null,
      resultHash: null
    });
    expect(warnings.mock.calls.map(([event]) => event)).toContainEqual(expect.objectContaining({
      event: "turn_generation_accounting_failed"
    }));
    expect(warnings.mock.calls.map(([event]) => event)).not.toContainEqual(expect.objectContaining({
      event: "turn_generation_provider_failed"
    }));
    warnings.mockRestore();
  });

  it("labels historical v1 post-response cost failure as accounting failure", async () => {
    const warnings = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const job = completeGenerationExecutionPayload();
    const provider = { id: job.provider_profile_id, name: "Historical", providerRole: "text" as const,
      providerType: "openai_compatible" as const, model: "model", contextWindowTokens: 16_000,
      maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {},
      execute: vi.fn(async () => ({ content: "{}", responseId: "response", finishReason: "stop",
        outputLimited: false, modelInstanceId: "model", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        reportedCost: null, rawMetadata: {} })) };
    await expect(callCampaignTextProvider({ pool: {} as DatabasePool, collaborators: {
      recordProfileCost: vi.fn(async () => { throw new Error("cost write failed"); })
    } } as never, provider, job, "story_generation", { systemPrompt: "Rules", input: "Act" }))
      .rejects.toThrow("cost write failed");
    expect(warnings.mock.calls.map(([event]) => event)).toContainEqual(expect.objectContaining({
      event: "turn_generation_accounting_failed"
    }));
    expect(warnings.mock.calls.map(([event]) => event)).not.toContainEqual(expect.objectContaining({
      event: "turn_generation_provider_failed"
    }));
    warnings.mockRestore();
  });

  it("persists bounded private partial prepared-response evidence before completing the failed invocation", async () => {
    const { job, provider, dependencies, completed } = contractDispatchFixture();
    const saveOrchestration = vi.fn(async (_scope: unknown, value: unknown) => { job.orchestration_private = value as never; return true; });
    dependencies.repository.saveOrchestration = saveOrchestration;
    provider.execute = vi.fn(async (request: any) => {
      const prepared = serializeProviderRequest({ ...provider, baseUrl: "" }, request);
      throw new PreparedResponseContractError(Object.assign(new Error("private transport"), { code: "provider_schema_invalid" }), prepared, {
        responseId: "partial-id", partialContent: "private partial", returnedModel: "returned", returnedProviderRoute: "route", diagnosticCode: "provider_schema_invalid"
      });
    });
    await expect(callCampaignTextProvider(dependencies, provider, job, "story_generation", { systemPrompt: "rules", input: "action" })).rejects.toBeInstanceOf(PreparedResponseContractError);
    expect(saveOrchestration).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      preparedResponseFailures: [expect.objectContaining({ invocationId: "b".repeat(64), responseId: "partial-id", partialContent: "private partial", diagnosticCode: "provider_schema_invalid" })]
    }));
    expect(completed).toHaveBeenCalledOnce();
  });
  it("binds the frozen stream contract before reservation and preserves the legacy reservation body", () => {
    const provider = { id: "provider", providerType: "openai_compatible", model: "model", contextWindowTokens: 100_000, maxOutputTokens: 100,
      temperature: 0, requestTimeoutMs: 1_000, configuration: {} } as never;
    const streamContract = { version: 1, mode: "json_object", operation: "story", streaming: true, forbidFormatFallback: true } as const;
    const nonstreamContract = { version: 1, mode: "json_object", operation: "story", streaming: false, forbidFormatFallback: true } as const;
    const frozenJob = completeGenerationExecutionPayload();
    frozenJob.orchestration_private = { frozenResponseContracts: { contracts: {
      "story:stream": streamContract, "story:nonstream": nonstreamContract
    } } } as never;
    const callback = vi.fn();
    const dispatched = bindCampaignResponseContract(frozenJob, "story_generation", {
      systemPrompt: "rules", input: "action", onChunk: callback
    });
    const reserved = preparePrimaryReservation(provider, dispatched, true);
    const legacy = preparePrimaryReservation(provider, { systemPrompt: "rules", input: "action", onChunk: callback }, false);

    expect(reserved.body).toContain('"stream":true');
    expect(reserved.body).toContain('"response_format":{"type":"json_object"}');
    expect(reserved.payloadHash).toBe(sha256(reserved.body));
    expect(legacy.body).not.toContain('"stream":true');
    expect(legacy.body).not.toContain('"stream_options"');
    expect(() => bindCampaignResponseContract(frozenJob, "story_choice_repair", { systemPrompt: "rules", input: "repair" }))
      .toThrow(/does not permit/u);
    expect(bindCampaignResponseContract(frozenJob, "rpg_assessment", { systemPrompt: "rules", input: "assess" }).responseContract).toBeUndefined();
  });
  it("derives immutable ledger provenance from the frozen contract and exact prepared body", () => {
    const job = completeGenerationExecutionPayload();
    job.orchestration_private = {
      logicalAttempt: { version: 1, id: job.id, semanticRepairsConsumed: 0, reviewsConsumed: 0, automaticRepairsConsumed: 0, choiceRepairsConsumed: 0, eventCoverageRepairsConsumed: 0 },
      frozenResponseContracts: {
        selectionHash: "a".repeat(64),
        contracts: {
          "story:nonstream": { version: 1, mode: "json_object", operation: "story", streaming: false, forbidFormatFallback: true }
        }
      }
    } as never;
    expect(responseContractInvocationDetails(job, "story_generation", false, "b".repeat(64), {
      id: "provider", model: "model"
    } as never)).toEqual({
      logicalAttemptId: claim.jobId,
      invocationKey: "story:nonstream",
      operation: "story_generation",
      requestPayloadHash: "b".repeat(64),
      request: {
        version: 1, selectionHash: "a".repeat(64), invocationKey: "story:nonstream", mode: "json_object",
        schemaVersion: null, schemaHash: null, requestedModel: "model", providerRoutingSlugs: [],
        returnedModel: null, returnedProviderRoute: null, diagnosticCode: null
      }
    });
  });
  it("records an applied fact-format repair exactly once and rejects a conflicting replay", () => {
    const application: FactFormatRepairApplication = {
      version: 1, jobId: claim.jobId, reviewId: "00000000-0000-4000-8000-000000000007", revision: 1,
      planHash: "a".repeat(64), sourceResponseId: "repair-response", rawOutputReference: "generation-primary:1:1",
      producingRequestHash: "b".repeat(64), rawOutputHash: "c".repeat(64), resultHash: "d".repeat(64),
      providerConfigurationHash: "e".repeat(64)
    };
    const first = appendFactFormatRepairApplication([], application);
    expect(appendFactFormatRepairApplication(first, application)).toEqual(first);
    const later = {
      ...application,
      reviewId: "00000000-0000-4000-8000-000000000008",
      revision: 3,
      planHash: "f".repeat(64)
    };
    const history = appendFactFormatRepairApplication(first, later);
    expect(history).toEqual([application, later]);
    expect(first).toEqual([application]);
    expect(() => appendFactFormatRepairApplication(first, {
      ...application, planHash: "b".repeat(64)
    })).toThrow(/conflicts with its receipt/u);
  });

  it("prepares a final continuity offer that preserves the reviewed candidate and its retry stage", () => {
    const job = completeGenerationExecutionPayload();
    const story = storyTurnOutputSchema.parse({
      narration: "The observatory door opens onto a silent moonlit archive.",
      choices: ["Enter.", "Wait.", "Study.", "Call."], custom_action_suggestion: "Study the door.",
      scratchpad: "", tracker_updates: [], image_prompt: "A moonlit observatory archive.",
      continuity_summary: "The archive is open.", canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: []
    });
    const baseIdentity = { ...job.generation_base_identity!, stateFingerprint: "e".repeat(64) };
    const candidate = {
      scope: "final" as const, story, storyHash: sha256(canonicalEvidenceJson(story)), rawOutputReference: null,
      producingRequestHash: "a".repeat(64), producingResponseId: "provider-response", sentFactIds: [],
      ownerUserId: job.owner_user_id, campaignId: job.campaign_id, worldId: "00000000-0000-4000-8000-000000000006",
      worldVersionId: job.world_version_id ?? null, baseTurnNumber: baseIdentity.baseTurnNumber,
      expectedTurnNumber: job.expected_turn_number, policy: {}, policyHash: "b".repeat(64), baseIdentity,
      protocol: { version: job.prompt_protocol_version, promptHash: "c".repeat(64) },
      provider: { type: "openai_compatible", profileId: job.provider_profile_id, configurationHash: "d".repeat(64) },
      resumeDependencies: { generationContext: {}, producingProviderResult: { responseId: "provider-response" }, stageState: {}, frozenCommitInputs: {}, replacementTarget: null }
    };

    const review = prepareGenerationReview({ candidate, stage: "continuity", reasons: ["narrative_conflict"], operationKind: "append", replacementTurnId: null,
      eligibility: { structurallyValid: true, mechanicsClean: true, authorityValid: true, stageComplete: true, retryAvailable: true } });

    expect(review).toMatchObject({ state: "pending", stage: "continuity", candidateScope: "final", reasons: ["narrative_conflict"], eligibility: { complete: true, structurallyValid: true, mechanicsClean: true, authorityValid: true, stageComplete: true, retryAvailable: true } });
    expect(review.gateCandidate).toEqual(candidate);
    expect(review.originalFindingsHash).toBe(sha256(canonicalEvidenceJson(["narrative_conflict"])));
  });
  it("limits extension-only semantic repair to appended narration contradictions", () => {
    expect(semanticRepairScope({ hasExtension: true, mainNarration: "Main scene.", findings: [{ kind: "contradiction", output: { path: "/narration", start: "Main scene.".length } }] })).toBe("extension_only");
    expect(semanticRepairScope({ hasExtension: true, mainNarration: "Main scene.", findings: [{ kind: "contradiction", output: { path: "/continuity_summary", start: 0 } }] })).toBe("main");
    expect(semanticRepairScope({ hasExtension: false, mainNarration: "Main scene.", findings: [{ kind: "contradiction", output: { path: "/narration", start: 99 } }] })).toBe("main");
  });
  function plannerContext(characterAuthority: unknown, version: "legacy" | "v3" = "v3") {
    const baseIdentity = version === "v3"
      ? { version: "generation-base-v3", operationKind: "append", expectedTurnNumber: 1, baseTurnNumber: 0, campaignActiveTurnNumber: 0, campaignStateRevision: 1, stateEditRevision: null, narrationCorrectionRevision: null, baseTurnId: null, stateFingerprint: "a".repeat(64), narrationFingerprint: null, characterProfileRevision: 1, characterProfileFingerprint: "b".repeat(64) }
      : { operationKind: "append", expectedTurnNumber: 1, baseTurnNumber: 0, campaignActiveTurnNumber: 0, campaignStateRevision: 1, stateEditRevision: null, narrationCorrectionRevision: null, baseTurnId: null, stateFingerprint: "a".repeat(64), narrationFingerprint: null };
    return {
      authority: {
        rules: ["World rule."], worldCanon: { title: "World" }, selectedCharacterId: "mira",
        ...(version === "v3" ? { characterAuthority } : {}),
        currentContinuity: { continuitySummary: "", scratchpad: "", canonicalFacts: [], openThreads: [], trackers: [], rpgStats: [], eventTriggers: [], pendingEventTriggers: [] },
        scratchpad: "", openThreads: [], canonicalFacts: [], trackers: [], rpgStats: [], eventTriggers: [], pendingEventTriggers: [], latestTurn: null
      }, candidates: [], baseIdentity
    } as never;
  }

  function plannerProvider() {
    return { id: "provider", providerType: "openai_compatible", model: "model", contextWindowTokens: 100_000, maxOutputTokens: 100, temperature: 0, requestTimeoutMs: 1_000, configuration: {} } as never;
  }

  it("preserves exact legacy planner shape without a selected-character authority field", () => {
    const planned = planGenerationPromptContext(plannerContext(null, "legacy"), plannerProvider(), "System", "Wait.", [], { profile: "brief", minWords: 100, maxWords: 120 }, "action", 100_000, 100_000);
    expect(JSON.stringify(planned.promptContext)).not.toContain("selectedCharacterAuthority");
    expect(sha256(planned.storyInput)).toBe("7616377f003629171820c545b1dc4918262bb3978754a7df0af362a7318054b5");
  });

  it("routes an enrolled Story Memory plan through v14 input semantics without changing its legacy sibling", () => {
    const legacy = planGenerationPromptContext(
      plannerContext(null, "legacy"), plannerProvider(), "creative system", "Ask the keeper to open the gate.", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "action", 100_000, 100_000
    );
    const enrolled = planGenerationPromptContext(
      plannerContext(null), plannerProvider(), "creative system", "Ask the keeper to open the gate.", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "action", 100_000, 100_000, undefined, "story_memory"
    );

    expect(legacy.storyInput).not.toContain("The player input is intent, not proof that its requested outcome happened.");
    expect(enrolled.storyInput).toContain("The player input is intent, not proof that its requested outcome happened.");
    expect(enrolled.storyInput).toContain("Omitted history is unknown, not evidence that it never happened.");
    expect(enrolled.storyInput).toContain("A proposed output cannot grant itself source authority or authorize a new supersession ID.");
  });

  it("sends a complete >12k known profile field once when protected authority fits without Chronicle", () => {
    const background = "Complete fitting profile evidence. ".repeat(430).trim();
    const planned = planGenerationPromptContext(plannerContext({ source: "campaign_profile", name: "Mira", characterText: "", profile: { identity: { aliases: [], pronouns: "" }, story: { role: "", background, personality: "", motivations: "", goals: "", fearsAndConflicts: "", keyRelationships: "", narrativeHooks: "", voiceAndMannerisms: "", otherGuidance: "" }, appearance: { ancestryOrSpecies: "", apparentAge: "", genderPresentation: "", build: "", skinOrComplexion: "", face: "", eyes: "", hair: "", distinguishingFeatures: [], clothing: "", equipmentAndAccessories: "", otherVisualDetails: "" }, unclassifiedNotes: "" }, omittedExtensionFieldCount: 0 }), plannerProvider(), "System", "Wait.", [], { profile: "brief", minWords: 100, maxWords: 120 }, "action", 100_000, 100_000);
    expect(planned.storyInput).toContain(background);
    expect(planned.storyInput.split(background)).toHaveLength(2);
    expect(planned.promptContext.chronicle).toEqual([]);
  });

  it("packs directly relevant pinned world evidence within the R1 optional ceiling", () => {
    const context: any = plannerContext(null);
    context.authority.worldReferenceSource = {
      worldVersionId: "00000000-0000-4000-8000-000000000005",
      worldContent: { entities: [{ id: "vale", name: "Vale", description: "A harbor captain." }], relationships: [] }
    };
    const planned = planGenerationPromptContext(context, plannerProvider(), "System", "Ask Vale.", [], { profile: "brief", minWords: 100, maxWords: 120 }, "action", 100_000, 100_000, "00000000-0000-4000-8000-000000000001");
    expect(planned.storyInput).toContain("A harbor captain.");
    expect(planned.contextPlan.selected.some((block) => block.scope === "world")).toBe(true);
    expect(planned.worldReferenceOmissions).toEqual({ unrecognizedRecordCount: 0, missingEndpointCount: 0, ambiguousAliasCount: 0, oversizedRecordCount: 0, entityCapCount: 0, relationshipCapCount: 0 });
    expect(planned.sourceManifest?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ semanticRole: "world_reference", sourcePath: "/entities/0", form: "complete", selectionGroup: "world" })
    ]));
  });

  it("omits an oversized whole world record under a tight quota while optional history borrows the unused share", () => {
    const context: any = plannerContext({ source: "campaign_profile", name: "Mira", characterText: "", profile: { identity: { aliases: ["Vale"] } } });
    context.authority.worldReferenceSource = {
      worldVersionId: "00000000-0000-4000-8000-000000000005",
      worldContent: { entities: [
        { id: "vale", name: "Vale", description: "This complete world record is deliberately larger than the optional world allocation. ".repeat(14) }
      ], relationships: [] }
    };
    context.candidates = [{ id: "history", turnId: null, ordinal: 1, kind: "turn_fiction", content: "Borrowed history remains available when no world entry fits.", tokenEstimate: 10, rank: 0 }];

    const planned = planGenerationPromptContext(context, plannerProvider(), "System", "Ask Vale.", [], { profile: "brief", minWords: 100, maxWords: 120 }, "action", 3_000, 3_000);

    expect(planned.contextPlan.selected.some((block) => block.scope === "world")).toBe(false);
    expect(planned.promptContext.chronicle.map((candidate) => candidate.id)).toEqual(["history"]);
  });

  it("records every sent protected source and rebinds selected world evidence to its original pinned path", () => {
    const context: any = plannerContext({ source: "campaign_profile", name: "Mira", characterText: "", profile: { identity: { aliases: ["Vale"] } } });
    context.authority.currentContinuity = { continuitySummary: "Mira promised to return.", scratchpad: "", canonicalFacts: [{ id: "11111111-1111-4111-8111-111111111111", content: "The tide gate is locked." }], openThreads: ["Find Vale."], trackers: [], rpgStats: [], eventTriggers: [], pendingEventTriggers: [] };
    context.authority.latestTurn = { action: "Ask Vale.", narration: "The quay bell answers." };
    context.authority.worldReferenceSource = {
      worldVersionId: "00000000-0000-4000-8000-000000000005",
      worldContent: { entities: [{ id: "vale", name: "Vale", description: "A harbor captain.", internal: { secret: "must not reach the provider" } }], relationships: [] }
    };
    const planned = planGenerationPromptContext(context, plannerProvider(), "System", "Ask Vale.", [], { profile: "brief", minWords: 100, maxWords: 120 }, "action", 100_000, 100_000, "00000000-0000-4000-8000-000000000001");
    const manifest = planned.sourceManifest!;
    const roles = manifest.entries.map((entry) => entry.semanticRole);

    expect(roles).toEqual(expect.arrayContaining(["world_rule", "character_authority", "current_continuity", "canonical_fact", "accepted_narration", "player_intent", "world_reference"]));
    const world = manifest.entries.find((entry) => entry.semanticRole === "world_reference")!;
    expect(world.sourcePath).toBe("/entities/0");
    expect(world.source.revision).toBe(context.authority.worldReferenceSource.worldVersionId);
    expect(world.source.contentHash).toBe(sha256(canonicalEvidenceJson(context.authority.worldReferenceSource.worldContent)));
    expect(world.content).not.toContain("must not reach the provider");
    expect(planned.storyInput).not.toContain("must not reach the provider");
    expect(readStoryEvidenceFromSource(world, { entities: [world.content], relationships: [] }, {
      contentHash: sha256(canonicalEvidenceJson(context.authority.worldReferenceSource.worldContent))
    })).toEqual(world);
    const direction = manifest.entries.find((entry) => entry.selectionGroup === "direction")!;
    expect(readStoryEvidenceFromSource(direction, { text: "Ask Vale." })).toEqual(direction);
  });

  it("uses a stable character source identifier when no character is selected", () => {
    const context: any = plannerContext({ source: "none", name: "", characterText: "", profile: null });
    context.authority.selectedCharacterId = null;

    const planned = planGenerationPromptContext(context, plannerProvider(), "System", "Wait.", [],
      { profile: "brief", minWords: 100, maxWords: 120 }, "action", 100_000, 100_000,
      "00000000-0000-4000-8000-000000000001");

    expect(planned.sourceManifest?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ semanticRole: "character_authority", source: expect.objectContaining({ id: "selected-character" }) })
    ]));
  });

  it("exposes bounded count-only world selection omissions without world contents", () => {
    const context: any = plannerContext(null);
    const witnesses = Array.from({ length: 25 }, (_, index) => ({ id: `witness-${index}`, name: `Witness ${index}`, description: `Witness detail ${index}.` }));
    context.authority.worldReferenceSource = {
      worldVersionId: "00000000-0000-4000-8000-000000000005",
      worldContent: {
        entities: [
          { id: "warden-one", name: "Warden", description: "First warden." },
          { id: "warden-two", name: "Warden", description: "Second warden." },
          { id: "large", name: "Large", description: "x".repeat(30_000) },
          { hidden: "UNRECOGNIZED_WORLD_CONTENT" },
          ...witnesses
        ],
        relationships: [
          { from: "warden-one", to: "missing", description: "Broken relationship." },
          { source: { hidden: "UNRECOGNIZED_WORLD_CONTENT" } }
        ]
      }
    };
    const planned = planGenerationPromptContext(context, plannerProvider(), "System", `Warden ${witnesses.map((entry) => entry.name).join(" ")}`,
      [], { profile: "brief", minWords: 100, maxWords: 120 }, "action", 100_000, 100_000);

    expect(planned.worldReferenceOmissions).toEqual({ unrecognizedRecordCount: 2, missingEndpointCount: 1, ambiguousAliasCount: 1, oversizedRecordCount: 1, entityCapCount: 1, relationshipCapCount: 0 });
    expect(JSON.stringify(planned.worldReferenceOmissions)).not.toContain("UNRECOGNIZED_WORLD_CONTENT");
  });

  it("fails protected character overflow before any provider call or partial profile serialization", () => {
    const background = "Protected profile overflow. ".repeat(500).trim();
    expect(() => planGenerationPromptContext(plannerContext({ source: "campaign_profile", name: "Mira", characterText: "", profile: { identity: { aliases: [], pronouns: "" }, story: { role: "", background, personality: "", motivations: "", goals: "", fearsAndConflicts: "", keyRelationships: "", narrativeHooks: "", voiceAndMannerisms: "", otherGuidance: "" }, appearance: { ancestryOrSpecies: "", apparentAge: "", genderPresentation: "", build: "", skinOrComplexion: "", face: "", eyes: "", hair: "", distinguishingFeatures: [], clothing: "", equipmentAndAccessories: "", otherVisualDetails: "" }, unclassifiedNotes: "" }, omittedExtensionFieldCount: 0 }), plannerProvider(), "System", "Wait.", [], { profile: "brief", minWords: 100, maxWords: 120 }, "action", 100, 100)).toThrow(expect.objectContaining({ code: "context_budget_exceeded", protectedBlockIds: ["authority"] }));
  });

  it("uses a profile-only edit even when Chronicle candidates are unavailable", () => {
    const before = planGenerationPromptContext(plannerContext({ source: "campaign_profile", name: "Mira", characterText: "", profile: { story: { motivations: "Guard the east gate." } }, omittedExtensionFieldCount: 0 }), plannerProvider(), "System", "Wait.", [], { profile: "brief", minWords: 100, maxWords: 120 }, "action", 100_000, 100_000);
    const after = planGenerationPromptContext(plannerContext({ source: "campaign_profile", name: "Mira", characterText: "", profile: { story: { motivations: "Guard the west gate." } }, omittedExtensionFieldCount: 0 }), plannerProvider(), "System", "Wait.", [], { profile: "brief", minWords: 100, maxWords: 120 }, "action", 100_000, 100_000);
    expect(before.promptContext.chronicle).toEqual([]);
    expect(after.storyInput).toContain("Guard the west gate.");
    expect(after.storyInput).not.toContain("Guard the east gate.");
  });

  it("does not serialize recognized profile credentials into the private provider input", () => {
    const secret = "fixture-serialized-provider-token-T04";
    const authority = characterFictionAuthority({
      name: "Mira",
      profile: {
        story: { background: `Provider token: ${secret}\nMira keeps the bridge watch.` },
        unclassifiedNotes: `api_key=${secret}\nThe bridge bell rings at dusk.`
      }
    }, null);
    const planned = planGenerationPromptContext(plannerContext(authority), plannerProvider(), "System", "Wait.", [], { profile: "brief", minWords: 100, maxWords: 120 }, "action", 100_000, 100_000);
    expect(planned.storyInput).not.toContain(secret);
    expect(planned.storyInput).toContain("Mira keeps the bridge watch.");
    expect(planned.storyInput).toContain("The bridge bell rings at dusk.");
  });

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

  it("makes malformed canonical authority recoverable with a safe repair diagnostic before provider execution", async () => {
    const job = completeGenerationExecutionPayload();
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async () => true), recordAttempt: vi.fn(async () => undefined),
      markRecoverable: vi.fn(async () => true), markFailed: vi.fn(async () => true), commitAcceptedTurn: vi.fn()
    } as unknown as GenerationExecutionRepository;
    const provider = { id: claim.providerProfileId, providerType: "openai_compatible", model: "test",
      contextWindowTokens: 100_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000,
      configuration: {}, execute: vi.fn() };
    const collaborators = { ...rejectedCollaborators(), loadTextExecution: vi.fn(async () => provider),
      promptFromSnapshot: vi.fn(() => "Write fiction."), memory: { loadGenerationContext: vi.fn(async () => {
        throw Object.assign(new Error("PRIVATE malformed persisted source"), { code: "authoritative_context_invalid", field: "canonical_facts" });
      }) } } as unknown as GenerationExecutionCollaborators;
    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "invalid-authority", leaseSeconds: 30, claim })).resolves.toBe(true);
    expect(provider.execute).not.toHaveBeenCalled();
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "authoritative_context_invalid",
      recoveryMetadata: expect.objectContaining({ diagnostic: { code: "authoritative_context_invalid", operation: "story_generation",
        action: "repair_authority", field: "canonical_facts" } }) }));
    expect(JSON.stringify(vi.mocked(repository.markRecoverable).mock.calls)).not.toContain("PRIVATE");
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

  it.each([
    { label: "a normal completion", finishReason: "stop", outputLimited: false },
    { label: "a complete length-finish response", finishReason: "length", outputLimited: true }
  ])("runs Story Direction through one fiction-only provider operation without dormant mechanics guidance after $label", async ({ finishReason, outputLimited }) => {
    const job = completeGenerationExecutionPayload();
    job.generation_base_identity = { ...job.generation_base_identity!, stateFingerprint: "a".repeat(64) };
    const policy = {
      version: 1, playMode: "story_only", turnControlStyle: "flexible_scene", protocolVersion: "story-only-v1",
      prompts: storyOnlyPromptSnapshot()
    } as const;
    job.generation_policy = policy;
    job.prompt_protocol_version = generationExecutionProtocolIdentity(snapshotProtocolIdentity(job.prompt_snapshot), policy);
    job.resolved_input_mode = "scene";
    job.orchestration_inputs = {
      ...job.orchestration_inputs,
      useRpgStats: true,
      suppressEventTriggers: false,
      rpgStats: [{ id: "private-stat", name: "PRIVATE_STAT_CANARY", value: 17 }] as never,
      eventTriggers: [
        { id: "before-trigger", label: "PRIVATE_BEFORE_CANARY", timing: "before", condition: "PRIVATE_BEFORE_CANARY", effect: "PRIVATE_BEFORE_CANARY", addTextAfter: false, triggeredCount: 0, lastTriggeredTurn: null, lastTriggeredAt: null },
        { id: "after-trigger", label: "PRIVATE_AFTER_CANARY", timing: "after", condition: "PRIVATE_AFTER_CANARY", effect: "PRIVATE_AFTER_CANARY", addTextAfter: true, triggeredCount: 0, lastTriggeredTurn: null, lastTriggeredAt: null }
      ] as never,
      pendingEventTriggers: [{ id: "pending-trigger", sourceTriggerId: "dormant-trigger", name: "PRIVATE_PENDING_CANARY", timing: "before", condition: "PRIVATE_PENDING_CANARY", effect: "PRIVATE_PENDING_CANARY", instructions: "PRIVATE_PENDING_CANARY", reason: "", sourceTurn: 2, addTextAfter: false }] as never
    };
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async (_scope, value) => { job.orchestration_private = value; return true; }),
      savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => undefined), markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true),
      markCommitting: vi.fn(async () => true), commitAcceptedTurn: vi.fn(async () => ({ turnId: "00000000-0000-4000-8000-000000000006" })),
      markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const story = {
      narration: "The observatory door opens onto a room of silver instruments.",
      choices: ["Enter the room.", "Study the instruments.", "Call for the keeper.", "Wait outside."],
      custom_action_suggestion: "Examine the moonlit lens.", scratchpad: "The door is open.", tracker_updates: [],
      image_prompt: "A moonlit observatory.", continuity_summary: "The observatory door is open.",
      canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: ["Learn who built the observatory."]
    };
    const provider = {
      id: claim.providerProfileId, name: "Story-only provider", providerRole: "text" as const,
      providerType: "openai_compatible" as const, model: "test-model", contextWindowTokens: 16_000,
      maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {},
      execute: vi.fn(async () => ({ content: JSON.stringify(story), responseId: "story-only", finishReason, outputLimited, modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {} }))
    };
    const operations: string[] = [];
    const collaborators = {
      memory: { loadGenerationContext: vi.fn(async () => ({
        authority: { rules: ["Protect the observatory."], worldCanon: { title: "Observatory" }, currentContinuity: { openThreads: ["Learn who built the observatory."] }, latestTurn: null },
        candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT
      })) },
      illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) },
      loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write a concise fictional scene."),
      recordProfileCost: vi.fn(async (_pool, _provider, attribution) => { operations.push(attribution.operation); }),
      attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "story-only-worker", leaseSeconds: 30, claim })).resolves.toBe(true);

    expect(operations).toEqual(["story_generation"]);
    expect(provider.execute).toHaveBeenCalledOnce();
    expect(repository.commitAcceptedTurn, JSON.stringify(job.orchestration_private)).toHaveBeenCalledWith(expect.objectContaining({
      story: expect.objectContaining({ choices: story.choices }),
      orchestration: expect.not.objectContaining({ beforeEvents: expect.any(Array) })
    }));
    expect(repository.commitAcceptedTurn).toHaveBeenCalledWith(expect.objectContaining({
      orchestration: expect.not.objectContaining({ afterEvents: expect.any(Array) })
    }));
    const wire = JSON.stringify((provider.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
    expect(wire).not.toContain("PRIVATE_STAT_CANARY");
    expect(wire).not.toContain("PRIVATE_BEFORE_CANARY");
    expect(wire).not.toContain("PRIVATE_AFTER_CANARY");
    expect(wire).not.toContain("PRIVATE_PENDING_CANARY");
  });

  it("stops before validation when the complete primary capture cannot be persisted", async () => {
    const job = completeGenerationExecutionPayload();
    const policy = { version: 1, playMode: "story_only", turnControlStyle: "flexible_scene", protocolVersion: "story-only-v1", prompts: storyOnlyPromptSnapshot() } as const;
    job.generation_policy = policy;
    job.prompt_protocol_version = generationExecutionProtocolIdentity(snapshotProtocolIdentity(job.prompt_snapshot), policy);
    job.resolved_input_mode = "scene";
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async (_scope, value) => !value.primaryResult),
      savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true), recordAttempt: vi.fn(async () => undefined),
      markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true), markCommitting: vi.fn(async () => true),
      commitAcceptedTurn: vi.fn(async () => ({ turnId: "unexpected" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = {
      id: claim.providerProfileId, name: "Capture failure provider", providerRole: "text" as const, providerType: "openai_compatible" as const,
      model: "test-model", contextWindowTokens: 16_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {},
      execute: vi.fn(async () => ({ content: JSON.stringify({ narration: "The moonlit observatory opens.", choices: ["Enter.", "Wait.", "Study.", "Call."], custom_action_suggestion: "Study the lens.", scratchpad: "", tracker_updates: [], image_prompt: "A moonlit observatory.", continuity_summary: "The observatory opens.", canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: [] }), responseId: "capture-failure", finishReason: "stop", outputLimited: false, modelInstanceId: "test", usage: {}, reportedCost: null, rawMetadata: {} }))
    };
    const collaborators = {
      memory: { loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })) },
      illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) }, loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write fiction."),
      recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "capture-failure", leaseSeconds: 30, claim })).resolves.toBe(true);

    expect(provider.execute).toHaveBeenCalledOnce();
    expect(repository.recordAttempt).not.toHaveBeenCalled();
    expect(repository.markValidating).not.toHaveBeenCalled();
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
  });

  it("pauses a reclaimed reserved primary request before another narration call", async () => {
    const job = completeGenerationExecutionPayload();
    job.attempts = 2;
    job.generation_base_identity = { ...job.generation_base_identity!, stateFingerprint: "e".repeat(64) };
    job.orchestration_private = {
      primaryReservation: { version: 1, requestBody: "{\"request\":true}", requestPayloadHash: sha256("{\"request\":true}"), providerConfigurationHash: "a".repeat(64), attempt: 1, status: "reserved" }
    } as never;
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async () => true), pauseForReview: vi.fn(async () => true), savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => undefined), markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true), markCommitting: vi.fn(async () => true),
      commitAcceptedTurn: vi.fn(async () => ({ turnId: "unexpected" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = { id: claim.providerProfileId, name: "Reservation provider", providerRole: "text" as const, providerType: "openai_compatible" as const,
      model: "test-model", contextWindowTokens: 16_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {}, execute: vi.fn() };
    const collaborators = { memory: { loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })) },
      illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) }, loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write fiction."), recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined) } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "reserved-primary", leaseSeconds: 30, claim: { ...claim, attempts: 2 } })).resolves.toBe(true);

    expect(provider.execute).not.toHaveBeenCalled();
    expect(repository.markFailed).not.toHaveBeenCalled();
    expect(repository.pauseForReview).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      stage: "structure", candidateScope: "main", reasons: ["output_incomplete"], gateCandidate: expect.objectContaining({ story: null })
    }));
  });

  it("records a fatal diagnostic against the phase that actually failed", async () => {
    const job = completeGenerationExecutionPayload();
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async () => true), savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => { throw Object.assign(new Error("persisted validation attempt failed"), { code: "invalid_schema" }); }),
      markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true), markCommitting: vi.fn(async () => true),
      commitAcceptedTurn: vi.fn(async () => ({ turnId: "unexpected" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = {
      id: claim.providerProfileId, name: "Validation phase provider", providerRole: "text" as const, providerType: "openai_compatible" as const,
      model: "test-model", contextWindowTokens: 16_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {},
      execute: vi.fn(async () => ({ content: JSON.stringify({ narration: "The moonlit observatory opens.", choices: ["Enter.", "Wait.", "Study.", "Call."], custom_action_suggestion: "Study the lens.", scratchpad: "", tracker_updates: [], image_prompt: "A moonlit observatory.", continuity_summary: "The observatory opens.", canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: [] }), responseId: "validation-phase", finishReason: "stop", outputLimited: false, modelInstanceId: "test", usage: {}, reportedCost: null, rawMetadata: {} }))
    };
    const collaborators = {
      memory: { loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })) },
      illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) }, loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write fiction."),
      recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "validation-phase", leaseSeconds: 30, claim })).resolves.toBe(true);

    expect(repository.markFailed).toHaveBeenCalledWith(expect.objectContaining({
      lastFailureDiagnostic: expect.objectContaining({ category: "format", code: "invalid_schema", phase: "story_validation", attemptNumber: 1 })
    }));
  });

  it.each([
    { label: "malformed JSON", content: "{not-valid-json", outputLimited: false, expectedOperations: ["story_generation"], errorCode: "invalid_json", expectedStage: "structure", expectedReason: "invalid_structure", failureCategory: "format", failureCode: "invalid_schema" },
    { label: "schema-invalid JSON", content: JSON.stringify({ narration: "The observatory door opens." }), outputLimited: false, expectedOperations: ["story_generation"], errorCode: "invalid_schema", expectedStage: "structure", expectedReason: "invalid_structure", failureCategory: "format", failureCode: "invalid_schema" },
    { label: "mechanics-contaminated JSON", content: JSON.stringify({ narration: "Test Character rolls a 17 and opens the observatory.", choices: ["Enter.", "Wait.", "Study.", "Call."], custom_action_suggestion: "Study the lens.", scratchpad: "", tracker_updates: [], image_prompt: "A moonlit observatory.", continuity_summary: "The observatory opens.", canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: [] }), outputLimited: false, expectedOperations: ["story_generation"], errorCode: "mechanics_leak", expectedStage: "structure", expectedReason: "mechanics_contamination", failureCategory: "mechanics", failureCode: "mechanics_leak" },
    { label: "output-limited partial JSON", content: "{\"narration\":\"The observatory", outputLimited: true, expectedOperations: ["story_generation"], errorCode: "output_limit", expectedStage: "structure", expectedReason: "output_incomplete", failureCategory: "output_incomplete", failureCode: "output_limit" },
    { label: "output-limited duplicate choices", content: JSON.stringify({ narration: "The observatory door opens.", choices: ["Wait.", " WAIT. ", "Look.", "Listen."], custom_action_suggestion: "Study.", scratchpad: "", tracker_updates: [], image_prompt: "", continuity_summary: "The door opens.", canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: [] }), outputLimited: true, expectedOperations: ["story_generation"], errorCode: "output_limit", expectedStage: "choices", expectedReason: "invalid_choices", failureCategory: "format", failureCode: "invalid_schema" }
  ])("keeps Story Direction $label recoverable without mechanical follow-up dispatch", async ({ content, outputLimited, expectedOperations, errorCode, expectedStage, expectedReason, failureCategory, failureCode }) => {
    const job = completeGenerationExecutionPayload();
    job.generation_base_identity = { ...job.generation_base_identity!, stateFingerprint: "a".repeat(64) };
    const policy = {
      version: 1, playMode: "story_only", turnControlStyle: "flexible_scene", protocolVersion: "story-only-v1",
      prompts: storyOnlyPromptSnapshot()
    } as const;
    job.generation_policy = policy;
    job.prompt_protocol_version = generationExecutionProtocolIdentity(snapshotProtocolIdentity(job.prompt_snapshot), policy);
    job.resolved_input_mode = "scene";
    job.orchestration_inputs = {
      ...job.orchestration_inputs,
      useRpgStats: true,
      suppressEventTriggers: false,
      rpgStats: [{ id: "private-stat", name: "PRIVATE_STAT_CANARY", value: 17 }] as never,
      eventTriggers: [{ id: "before", label: "PRIVATE_EVENT_CANARY", timing: "before", condition: "PRIVATE_EVENT_CANARY", effect: "PRIVATE_EVENT_CANARY", addTextAfter: false, triggeredCount: 0, lastTriggeredTurn: null, lastTriggeredAt: null }] as never,
      pendingEventTriggers: [{ id: "pending", sourceTriggerId: "separate", name: "PRIVATE_PENDING_CANARY", timing: "before", condition: "PRIVATE_PENDING_CANARY", effect: "PRIVATE_PENDING_CANARY", instructions: "PRIVATE_PENDING_CANARY", reason: "", sourceTurn: 2, addTextAfter: false }] as never
    };
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async (_scope, value) => { job.orchestration_private = value; return true; }),
      savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true),
      recordAttempt: vi.fn(async () => undefined), pauseForReview: vi.fn(async () => true), markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true),
      markCommitting: vi.fn(async () => true), commitAcceptedTurn: vi.fn(async () => ({ turnId: "unexpected" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = {
      id: claim.providerProfileId, name: "Story-only recovery provider", providerRole: "text" as const,
      providerType: "openai_compatible" as const, model: "test-model", contextWindowTokens: 16_000,
      maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {},
      execute: vi.fn(async () => ({ content, responseId: "invalid-story", finishReason: outputLimited ? "length" : "stop", outputLimited, modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {} }))
    };
    const operations: string[] = [];
    const collaborators = {
      memory: { loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })) },
      illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) },
      loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write fiction."),
      recordProfileCost: vi.fn(async (_pool, _provider, attribution) => { operations.push(attribution.operation); }),
      attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: `story-only-${errorCode}`, leaseSeconds: 30, claim })).resolves.toBe(true);

    expect(operations).toEqual(expectedOperations);
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
    expect(repository.markRecoverable).not.toHaveBeenCalled();
    expect(repository.markFailed).not.toHaveBeenCalled();
    expect(repository.pauseForReview).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      state: "pending", stage: expectedStage, candidateScope: "main",
      reasons: [expectedReason]
    }));
    expect(repository.saveOrchestration).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      lastFailureDiagnostic: expect.objectContaining({ version: 1, category: failureCategory, code: failureCode,
        phase: "story_validation", attemptNumber: 1 })
    }));
  });

  it("rejects a reclaimed Story Direction mechanical checkpoint before it can consume dormant events", async () => {
    const job = completeGenerationExecutionPayload();
    const policy = {
      version: 1, playMode: "story_only", turnControlStyle: "flexible_scene", protocolVersion: "story-only-v1",
      prompts: storyOnlyPromptSnapshot()
    } as const;
    job.generation_policy = policy;
    job.prompt_protocol_version = generationExecutionProtocolIdentity(snapshotProtocolIdentity(job.prompt_snapshot), policy);
    job.orchestration_private = {
      beforeEvents: [{ id: "dormant", sourceTriggerId: "dormant", name: "Dormant", timing: "before", condition: "", effect: "", instructions: "must not be consumed", reason: "", sourceTurn: 2, addTextAfter: false }]
    } as never;
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markRecoverable: vi.fn(async () => true),
      markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = { id: claim.providerProfileId, name: "Provider", providerRole: "text" as const, providerType: "openai_compatible" as const,
      model: "test-model", contextWindowTokens: 16_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {}, execute: vi.fn() };
    const collaborators = {
      ...rejectedCollaborators(), loadTextExecution: vi.fn(async () => provider),
      promptFromSnapshot: vi.fn(() => "Write fiction."),
      memory: { loadGenerationContext: vi.fn(async () => ({
        authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT
      })) }
    } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "story-only-reclaim", leaseSeconds: 30, claim: { ...claim, attempts: 2 } })).resolves.toBe(true);

    expect(provider.execute).not.toHaveBeenCalled();
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "generation_checkpoint_incompatible",
      recoveryMetadata: expect.objectContaining({ reason: "story_only_mechanics_checkpoint" })
    }));
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

  it("authorizes only complete canonical facts carried by a semantic-repair envelope", () => {
    const allowed = "11111111-1111-4111-8111-111111111111";
    const omitted = "22222222-2222-4222-8222-222222222222";
    const request = JSON.stringify({ messages: [{ role: "user", content: JSON.stringify({
      protocol: "story-continuity-repair-v1", protected_authority: [
        { canonicalFactId: allowed, form: "complete" },
        { canonicalFactId: omitted, form: "excerpt" }
      ]
    }) }] });
    expect(sentCanonicalFactIds(request)).toEqual([allowed]);
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

  it("rejects an authorized legacy format repair after its provider configuration changes before an applied write or primary redispatch", async () => {
    const job = completeGenerationExecutionPayload();
    job.generation_base_identity = { ...job.generation_base_identity!, stateFingerprint: "a".repeat(64) };
    // This intentionally has no storyMemoryPolicy snapshot: legacy jobs still fence provider configuration.
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async (_scope, value) => { job.orchestration_private = value; return true; }),
      pauseForReview: vi.fn(async (_scope, review) => { job.orchestration_private = { ...job.orchestration_private, generationReview: review }; return true; }),
      savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true), recordAttempt: vi.fn(async () => undefined),
      markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true), markCommitting: vi.fn(async () => true),
      commitAcceptedTurn: vi.fn(async () => ({ turnId: "unexpected" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const malformed = JSON.stringify({
      narration: "The observatory door opens onto a silent moonlit archive.", choices: ["Enter.", "Wait.", "Study.", "Call."],
      custom_action_suggestion: "Study the door.", scratchpad: "", tracker_updates: [], image_prompt: "A moonlit observatory.",
      continuity_summary: "The archive is open.", canonical_facts: [{ id: "new-label", content: "The archive is open." }],
      superseded_facts: [], canonical_fact_updates: [], open_threads: []
    });
    const provider = {
      id: claim.providerProfileId, name: "Provider", providerRole: "text" as const, providerType: "openai_compatible" as const,
      model: "test-model", contextWindowTokens: 16_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000,
      configuration: { revision: "offered" },
      execute: vi.fn(async () => ({ content: malformed, responseId: "repair-source", finishReason: "stop", outputLimited: false,
        modelInstanceId: "test", usage: {}, reportedCost: null, rawMetadata: {} }))
    };
    const collaborators = {
      memory: { loadGenerationContext: vi.fn(async () => ({ authority: { currentContinuity: { canonicalFacts: [] }, chronicle: [] }, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })) },
      illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) }, loadTextExecution: vi.fn(async () => provider),
      promptFromSnapshot: vi.fn(() => "Write fiction."), recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;
    const executor = createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators });

    await expect(executor.execute({ workerId: "repair-provider-offer", leaseSeconds: 30, claim })).resolves.toBe(true);
    const offered = job.orchestration_private.generationReview!;
    const repair = offered.factFormatRepair;
    expect(repair).toMatchObject({ status: "offered" });
    if (!repair) throw new Error("Expected a repair offer.");
    const receipt = {
      reviewId: offered.reviewId, revision: offered.revision, actorUserId: job.owner_user_id, decision: "repair_format" as const,
      decidedAt: "2026-09-18T00:00:00.000Z", candidateScope: offered.candidateScope, candidateHash: offered.gateCandidate.storyHash,
      findingsHash: sha256(canonicalEvidenceJson(offered.reasons)), nextStage: "structure" as const,
      offeredCandidate: offered.gateCandidate, offeredReasons: offered.reasons,
      actionReceipt: { jobId: job.id, status: "queued" as const, operationKind: job.operation_kind, replacementTurnId: job.replacement_turn_id },
      planHash: repair.planHash, repair
    };
    job.orchestration_private = {
      ...job.orchestration_private,
      generationReview: { ...offered, state: "decided", revision: offered.revision + 1,
        factFormatRepair: { ...repair, status: "authorized" }, decisionJournal: [...offered.decisionJournal, receipt] }
    } as GenerationExecutionPayload["orchestration_private"];
    job.attempts = 2;
    provider.configuration = { revision: "changed" };

    await expect(executor.execute({ workerId: "repair-provider-changed", leaseSeconds: 30, claim: { ...claim, attempts: 2 } })).resolves.toBe(true);
    expect(provider.execute).toHaveBeenCalledOnce();
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "generation_checkpoint_incompatible" }));
    expect(repository.saveOrchestration).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      generationReview: expect.objectContaining({ factFormatRepair: expect.objectContaining({ status: "applied" }) })
    }));
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
  });

  it.each(["untampered", "raw output", "producing request", "repair plan"] as const)("applies an intact authorized repair and rejects a tampered %s before a primary redispatch or canonical commit", async (surface) => {
    const job = completeGenerationExecutionPayload();
    job.generation_base_identity = { ...job.generation_base_identity!, stateFingerprint: "a".repeat(64) };
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async (_scope, value) => { job.orchestration_private = value; return true; }),
      pauseForReview: vi.fn(async (_scope, review) => { job.orchestration_private = { ...job.orchestration_private, generationReview: review }; return true; }),
      savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true), recordAttempt: vi.fn(async () => undefined),
      markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true), markCommitting: vi.fn(async () => true),
      commitAcceptedTurn: vi.fn(async () => ({ turnId: "unexpected" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const malformed = JSON.stringify({
      narration: "The observatory door opens onto a silent moonlit archive.", choices: ["Enter.", "Wait.", "Study.", "Call."],
      custom_action_suggestion: "Study the door.", scratchpad: "", tracker_updates: [], image_prompt: "A moonlit observatory.",
      continuity_summary: "The archive is open.", canonical_facts: [{ id: "new-label", content: "The archive is open." }],
      superseded_facts: [], canonical_fact_updates: [], open_threads: []
    });
    const provider = {
      id: claim.providerProfileId, name: "Provider", providerRole: "text" as const, providerType: "openai_compatible" as const,
      model: "test-model", contextWindowTokens: 16_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {},
      execute: vi.fn(async () => ({ content: malformed, responseId: "repair-source", finishReason: "stop", outputLimited: false,
        modelInstanceId: "test", usage: {}, reportedCost: null, rawMetadata: {} }))
    };
    const collaborators = {
      memory: { loadGenerationContext: vi.fn(async () => ({ authority: { currentContinuity: { canonicalFacts: [] }, chronicle: [] }, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })) },
      illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) }, loadTextExecution: vi.fn(async () => provider),
      promptFromSnapshot: vi.fn(() => "Write fiction."), recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;
    const executor = createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators });

    await expect(executor.execute({ workerId: `repair-${surface}-offer`, leaseSeconds: 30, claim })).resolves.toBe(true);
    const offered = job.orchestration_private.generationReview!;
    const repair = offered.factFormatRepair;
    if (!repair) throw new Error("Expected a repair offer.");
    const receipt = {
      reviewId: offered.reviewId, revision: offered.revision, actorUserId: job.owner_user_id, decision: "repair_format" as const,
      decidedAt: "2026-09-18T00:00:00.000Z", candidateScope: offered.candidateScope, candidateHash: offered.gateCandidate.storyHash,
      findingsHash: sha256(canonicalEvidenceJson(offered.reasons)), nextStage: "structure" as const,
      offeredCandidate: offered.gateCandidate, offeredReasons: offered.reasons,
      actionReceipt: { jobId: job.id, status: "queued" as const, operationKind: job.operation_kind, replacementTurnId: job.replacement_turn_id },
      planHash: repair.planHash, repair
    };
    job.orchestration_private = {
      ...job.orchestration_private,
      generationReview: { ...offered, state: "decided", revision: offered.revision + 1,
        factFormatRepair: { ...repair, status: "authorized" }, decisionJournal: [...offered.decisionJournal, receipt] }
    } as GenerationExecutionPayload["orchestration_private"];
    expect(generationReviewCheckpointSchema.safeParse(job.orchestration_private.generationReview).success).toBe(true);

    if (surface === "raw output") {
      const primary = job.orchestration_private.primaryResult!;
      job.orchestration_private = {
        ...job.orchestration_private,
        primaryResult: { ...primary, response: { ...primary.response, content: `${primary.response.content} ` } }
      } as GenerationExecutionPayload["orchestration_private"];
    } else if (surface === "producing request") {
      const primary = job.orchestration_private.primaryResult!;
      const requestBody = `${primary.requestBody} `;
      job.orchestration_private = {
        ...job.orchestration_private,
        primaryResult: { ...primary, requestBody, requestPayloadHash: sha256(requestBody) }
      } as GenerationExecutionPayload["orchestration_private"];
    } else if (surface === "repair plan") {
      const review = job.orchestration_private.generationReview!;
      const authorizedRepair = review.factFormatRepair!;
      const plan = {
        ...authorizedRepair.plan,
        changes: [...authorizedRepair.plan.changes, { sourceIndex: 0, kind: "id_label_to_addition" as const }]
      };
      const planHash = sha256(canonicalEvidenceJson(plan));
      const changedRepair = { ...authorizedRepair, plan, planHash };
      const changedReceipt = { ...receipt, repair: { ...receipt.repair, plan, planHash }, planHash };
      job.orchestration_private = {
        ...job.orchestration_private,
        generationReview: {
          ...review,
          factFormatRepair: changedRepair,
          decisionJournal: [...offered.decisionJournal, changedReceipt]
        }
      } as GenerationExecutionPayload["orchestration_private"];
      expect(generationReviewCheckpointSchema.safeParse(job.orchestration_private.generationReview).success).toBe(true);
    }
    job.attempts = 2;

    await expect(executor.execute({ workerId: `repair-${surface}-tampered`, leaseSeconds: 30, claim: { ...claim, attempts: 2 } })).resolves.toBe(true);
    if (surface === "untampered") {
      expect(repository.saveOrchestration).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        generationReview: expect.objectContaining({ factFormatRepair: expect.objectContaining({ status: "applied" }) })
      }));
      expect(provider.execute).toHaveBeenCalledOnce();
      expect(repository.commitAcceptedTurn).toHaveBeenCalledOnce();
      return;
    }
    expect(provider.execute).toHaveBeenCalledOnce();
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "generation_checkpoint_incompatible" }));
    expect(repository.saveOrchestration).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      generationReview: expect.objectContaining({ factFormatRepair: expect.objectContaining({ status: "applied" }) })
    }));
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
  });

  it.each([
    ["Action", "action", "action", "explicit"],
    ["Scene", "scene", "scene", "explicit"],
    ["resolved Auto", "auto", "action", "auto"],
    ["new Action policy", "action", "action", "explicit"]
  ] as const)("reclaims a captured complete %s result without another narration call", async (label, requestedInputMode, resolvedInputMode, inputModeSource) => {
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
      pauseForReview: vi.fn(async (_scope, checkpoint) => {
        job.orchestration_private = { ...job.orchestration_private, generationReview: checkpoint };
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
    expect(job.orchestration_private.primaryResult).toMatchObject({
      requestPayloadHash: expect.any(String), response: { responseId: "first-response" },
      sentFactIds: expect.any(Array)
    });
    expect(repository.savePartialNarration).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: job.id }), firstNarration
    );
    expect(job.orchestration_private.validatedMainDraft).toBeDefined();
    const capturedPrimary = job.orchestration_private.primaryResult;
    job.orchestration_private = { primaryResult: capturedPrimary! };
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
    job.generation_base_identity = { ...job.generation_base_identity!, stateFingerprint: "a".repeat(64) };
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
    job.orchestration_private.afterEvents = [immediateEvent] as never;
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true),
      markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async (_scope, value) => {
        job.orchestration_private = value;
        return true;
      }),
      pauseForReview: vi.fn(async (_scope, checkpoint) => {
        job.orchestration_private = { ...job.orchestration_private, generationReview: checkpoint };
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
        .mockResolvedValueOnce({ content: JSON.stringify({ event_results: [{ event_id: "immediate-bell", covered: true, missing_required_beats: [], contradictions: [] }] }), responseId: "coverage-2", finishReason: "stop", outputLimited: false, modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: JSON.stringify({ event_results: [{ event_id: "immediate-bell", covered: true, missing_required_beats: [], contradictions: [] }] }), responseId: "appended-coverage", finishReason: "stop", outputLimited: false, modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: story("The observatory door opens.\n\nA silver bell rings."), responseId: "repair", finishReason: "stop", outputLimited: false, modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: JSON.stringify({ event_results: [{ event_id: "immediate-bell", covered: true, missing_required_beats: [], contradictions: [] }] }), responseId: "repair-coverage", finishReason: "stop", outputLimited: false, modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: JSON.stringify({ event_results: [{ event_id: "immediate-bell", covered: true, missing_required_beats: [], contradictions: [] }] }), responseId: "repair-appended-coverage", finishReason: "stop", outputLimited: false, modelInstanceId: "test-instance", usage: {}, reportedCost: null, rawMetadata: {} })
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
    expect(provider.execute).toHaveBeenCalledTimes(3);
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
    const pendingEventGate = job.orchestration_private.generationReview as GenerationReviewCheckpoint;
    expect(pendingEventGate).toMatchObject({ state: "pending", stage: "event_coverage", candidateScope: "final" });
    authorizeReviewRetry(job, pendingEventGate);
    await expect(executor.execute({ workerId: "event-repair-worker", leaseSeconds: 30, claim: { ...claim, attempts: 2 } })).resolves.toBe(true);

    expect(job.orchestration_private.eventCoverageRepair).toEqual(expect.objectContaining({
      consumedAttempt: 1,
      authorizedReviewId: pendingEventGate.reviewId,
      authorizedRevision: pendingEventGate.revision
    }));
    expect(repository.commitAcceptedTurn).toHaveBeenCalledWith(expect.objectContaining({
      story: expect.objectContaining({ narration: "The observatory door opens.\n\nA silver bell rings." })
    }));
    const serializedFictionRequests = provider.execute.mock.calls.map(([request]) => String(request.input));
    expect(serializedFictionRequests).toHaveLength(8);
    for (const request of serializedFictionRequests) {
      expect(request).not.toContain("PRIVATE_STAT_CANARY");
      expect(request).not.toContain("PRIVATE_TRACKER_CANARY");
    }
    expect(serializedFictionRequests[0]).toContain("Silver doorway");
    expect(provider.execute.mock.calls[5]?.[0].budgetOutput).toEqual({
      kind: "event_extension",
      protectedStory: {
        narration: "The observatory door opens.",
        scratchpad: "The door is open.",
        continuitySummary: "The observatory door is open.",
        openThreads: []
      },
      narrationCharacterLimit: 200_000
    });
    expect(JSON.parse(provider.execute.mock.calls[5]?.[0].input || "{}")).toMatchObject({
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
    expect(repository.commitAcceptedTurn).toHaveBeenCalledTimes(1);
  });

  it("repairs before-event coverage once, revalidates it, and commits the repaired main draft", async () => {
    const job = completeGenerationExecutionPayload();
    job.generation_base_identity = { ...job.generation_base_identity!, stateFingerprint: "a".repeat(64) };
    job.orchestration_inputs.suppressEventTriggers = false;
    job.orchestration_private.beforeEvents = [{
      id: "before-event", sourceTriggerId: "before-trigger", name: "Bell", timing: "before",
      condition: "", effect: "", instructions: "A bell rings in the hall.", reason: "", sourceTurn: 3,
      addTextAfter: false
    }];
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async (_scope, value) => { job.orchestration_private = value; return true; }),
      pauseForReview: vi.fn(async (_scope, checkpoint) => { job.orchestration_private = { ...job.orchestration_private, generationReview: checkpoint }; return true; }),
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
        .mockResolvedValueOnce({ content: JSON.stringify({ event_results: [{ event_id: "before-event", covered: true, missing_required_beats: [], contradictions: [] }] }), responseId: "retry-check", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: output("The hall is quiet.\n\nA bell rings in the hall."), responseId: "repair", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: JSON.stringify({ event_results: [{ event_id: "before-event", covered: true, missing_required_beats: [], contradictions: [] }] }), responseId: "verified", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} }) };
    const collaborators = { memory: { loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })) }, illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) }, loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write fiction."), recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined) } as unknown as GenerationExecutionCollaborators;

    const executor = createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators });
    await expect(executor.execute({ workerId: "before-repair", leaseSeconds: 30, claim })).resolves.toBe(true);
    expect(provider.execute).toHaveBeenCalledTimes(2);
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
    const pendingEventGate = job.orchestration_private.generationReview as GenerationReviewCheckpoint;
    expect(pendingEventGate).toMatchObject({ state: "pending", stage: "event_coverage", candidateScope: "main" });
    authorizeReviewRetry(job, pendingEventGate);
    await expect(executor.execute({ workerId: "before-repair-retry", leaseSeconds: 30, claim: { ...claim, attempts: 2 } })).resolves.toBe(true);
    expect(repository.markRecoverable).not.toHaveBeenCalled();
    expect(provider.execute).toHaveBeenCalledTimes(5);
    expect(repository.commitAcceptedTurn).toHaveBeenCalledWith(expect.objectContaining({ story: expect.objectContaining({ narration: expect.stringContaining("bell rings") }) }));

  });

  it("dispatches main before-event coverage with its distinct operation on a v1 frozen job", async () => {
    const job = completeGenerationExecutionPayload();
    job.generation_base_identity = { ...job.generation_base_identity!, stateFingerprint: "a".repeat(64) };
    job.orchestration_inputs.suppressEventTriggers = false;
    // Historical v1 selections do not freeze an event-coverage schema; the
    // invocation stays on its legacy request path but retains its operation.
    job.orchestration_private = {
      logicalAttempt: { version: 1, id: job.id, semanticRepairsConsumed: 0, reviewsConsumed: 0, automaticRepairsConsumed: 0, choiceRepairsConsumed: 0, eventCoverageRepairsConsumed: 0 },
      frozenResponseContracts: { version: 1, selectionHash: "a".repeat(64), contracts: {
        "story:nonstream": { version: 1, mode: "json_object", operation: "story", streaming: false, forbidFormatFallback: true }
      } },
      beforeEvents: [{ id: "before-event", sourceTriggerId: "before-trigger", name: "Bell", timing: "before", condition: "", effect: "", instructions: "A bell rings in the hall.", reason: "", sourceTurn: 3, addTextAfter: false }]
    } as never;
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async (_scope, value) => { job.orchestration_private = value; return true; }),
      pauseForReview: vi.fn(async (_scope, checkpoint) => { job.orchestration_private = { ...job.orchestration_private, generationReview: checkpoint }; return true; }),
      savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true), recordAttempt: vi.fn(async () => undefined),
      reserveResponseContractInvocation: vi.fn(async (_scope, input) => ({ id: "b".repeat(64), status: "reserved", ...input })),
      markResponseContractInvocationDispatched: vi.fn(async (_scope, id) => ({ id, status: "dispatched" })),
      completeResponseContractInvocation: vi.fn(async (_scope, id) => ({ id, status: "completed" })),
      markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true), markCommitting: vi.fn(async () => true),
      commitAcceptedTurn: vi.fn(async () => ({ turnId: "turn" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const story = JSON.stringify({ narration: "The hall is quiet.", choices: ["A", "B", "C", "D"], custom_action_suggestion: "Wait.", scratchpad: "", tracker_updates: [], image_prompt: "", continuity_summary: "", canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: [] });
    const responses = [
      { content: story, responseId: "main", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} },
      { content: JSON.stringify({ event_results: [{ event_id: "before-event", covered: false, missing_required_beats: ["before-event"], contradictions: [] }] }), responseId: "coverage", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} }
    ];
    const provider = { id: claim.providerProfileId, name: "Provider", providerRole: "text" as const, providerType: "openai_compatible" as const,
      model: "test-model", contextWindowTokens: 16_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {}, execute: vi.fn() };
    provider.execute.mockImplementation(async (request: any) => {
      const response = responses.shift()!;
      return request.responseContract
        ? { ...response, preparedRequest: serializeProviderRequest({ ...provider, baseUrl: "" }, request) }
        : response;
    });
    const operations: string[] = [];
    const collaborators = { memory: { loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })) }, illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) }, loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write fiction."), recordProfileCost: vi.fn(async (_pool, _provider, attribution) => { operations.push(attribution.operation); }), attributeGenerationCostsToTurn: vi.fn(async () => undefined) } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "before-event-v1", leaseSeconds: 30, claim })).resolves.toBe(true);

    expect(operations).toEqual(["story_generation", "event_coverage_validation"]);
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
  });

  it("dispatches scene coverage with its distinct operation on a v1 frozen job", async () => {
    const job = completeGenerationExecutionPayload();
    job.generation_base_identity = { ...job.generation_base_identity!, stateFingerprint: "a".repeat(64) };
    job.resolved_input_mode = "scene";
    job.orchestration_private = {
      logicalAttempt: { version: 1, id: job.id, semanticRepairsConsumed: 0, reviewsConsumed: 0, automaticRepairsConsumed: 0, choiceRepairsConsumed: 0, eventCoverageRepairsConsumed: 0 },
      frozenResponseContracts: { version: 1, selectionHash: "a".repeat(64), contracts: {
        "story:nonstream": { version: 1, mode: "json_object", operation: "story", streaming: false, forbidFormatFallback: true }
      } }
    } as never;
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async (_scope, value) => { job.orchestration_private = value; return true; }),
      pauseForReview: vi.fn(async (_scope, checkpoint) => { job.orchestration_private = { ...job.orchestration_private, generationReview: checkpoint }; return true; }),
      savePartialNarration: vi.fn(async () => true), saveStreamingSegments: vi.fn(async () => true), recordAttempt: vi.fn(async () => undefined),
      reserveResponseContractInvocation: vi.fn(async (_scope, input) => ({ id: "b".repeat(64), status: "reserved", ...input })),
      markResponseContractInvocationDispatched: vi.fn(async (_scope, id) => ({ id, status: "dispatched" })),
      completeResponseContractInvocation: vi.fn(async (_scope, id) => ({ id, status: "completed" })),
      markRecoverable: vi.fn(async () => true), markValidating: vi.fn(async () => true), markCommitting: vi.fn(async () => true),
      commitAcceptedTurn: vi.fn(async () => ({ turnId: "turn" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const story = JSON.stringify({ narration: "The hall is quiet.", choices: ["A", "B", "C", "D"], custom_action_suggestion: "Wait.", scratchpad: "", tracker_updates: [], image_prompt: "", continuity_summary: "", canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: [] });
    const responses = [
      { content: story, responseId: "main", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} },
      { content: JSON.stringify({ covered: false, missing_required_beats: ["scene"], contradictions: [] }), responseId: "coverage", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} }
    ];
    const provider = { id: claim.providerProfileId, name: "Provider", providerRole: "text" as const, providerType: "openai_compatible" as const,
      model: "test-model", contextWindowTokens: 16_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {}, execute: vi.fn() };
    provider.execute.mockImplementation(async (request: any) => {
      const response = responses.shift()!;
      return request.responseContract
        ? { ...response, preparedRequest: serializeProviderRequest({ ...provider, baseUrl: "" }, request) }
        : response;
    });
    const operations: string[] = [];
    const collaborators = { memory: { loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })) }, illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) }, loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write fiction."), recordProfileCost: vi.fn(async (_pool, _provider, attribution) => { operations.push(attribution.operation); }), attributeGenerationCostsToTurn: vi.fn(async () => undefined) } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "scene-v1", leaseSeconds: 30, claim })).resolves.toBe(true);

    expect(operations).toEqual(["story_generation", "scene_coverage_validation"]);
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
  });

  it("stops after a rewritten before-event draft still fails coverage", async () => {
    const job = completeGenerationExecutionPayload();
    job.generation_base_identity = { ...job.generation_base_identity!, stateFingerprint: "a".repeat(64) };
    job.orchestration_inputs.suppressEventTriggers = false;
    job.orchestration_private.beforeEvents = [{
      id: "before-event", sourceTriggerId: "before-trigger", name: "Bell", timing: "before",
      condition: "", effect: "", instructions: "A bell rings in the hall.", reason: "", sourceTurn: 3,
      addTextAfter: false
    }];
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async (_scope, value) => { job.orchestration_private = value; return true; }),
      pauseForReview: vi.fn(async (_scope, checkpoint) => { job.orchestration_private = { ...job.orchestration_private, generationReview: checkpoint }; return true; }),
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
        .mockResolvedValueOnce({ content: JSON.stringify({ event_results: [{ event_id: "before-event", covered: true, missing_required_beats: [], contradictions: [] }] }), responseId: "retry-check", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: output("The hall remains quiet."), responseId: "repair", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} })
        .mockResolvedValueOnce({ content: JSON.stringify({ event_results: [{ event_id: "before-event", covered: false, missing_required_beats: ["before-event"], contradictions: [] }] }), responseId: "still-missing", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} }) };
    const collaborators = { memory: { loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })) }, illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) }, loadTextExecution: vi.fn(async () => provider), promptFromSnapshot: vi.fn(() => "Write fiction."), recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined) } as unknown as GenerationExecutionCollaborators;

    const executor = createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators });
    await expect(executor.execute({ workerId: "before-repair-exhausted", leaseSeconds: 30, claim })).resolves.toBe(true);
    expect(provider.execute).toHaveBeenCalledTimes(2);
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
    authorizeReviewRetry(job, job.orchestration_private.generationReview as GenerationReviewCheckpoint);
    await expect(executor.execute({ workerId: "before-repair-exhausted-retry", leaseSeconds: 30, claim: { ...claim, attempts: 2 } })).resolves.toBe(true);

    expect(provider.execute).toHaveBeenCalledTimes(5);
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
    expect(repository.markRecoverable).not.toHaveBeenCalled();
    expect(job.orchestration_private.generationReview).toMatchObject({ state: "pending", stage: "event_coverage", eligibility: { retryAvailable: false } });
  });

  it("uses replacement output budgeting for a feasible near-limit before-event rewrite", async () => {
    const job = completeGenerationExecutionPayload();
    job.generation_base_identity = { ...job.generation_base_identity!, stateFingerprint: "a".repeat(64) };
    job.orchestration_inputs.suppressEventTriggers = false;
    job.orchestration_private.beforeEvents = [{
      id: "before-event", sourceTriggerId: "before-trigger", name: "Bell", timing: "before",
      condition: "", effect: "", instructions: "A bell rings in the hall.", reason: "", sourceTurn: 3,
      addTextAfter: false
    }];
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async (_scope, value) => { job.orchestration_private = value; return true; }),
      pauseForReview: vi.fn(async (_scope, checkpoint) => { job.orchestration_private = { ...job.orchestration_private, generationReview: checkpoint }; return true; }),
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

    const executor = createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators });
    await expect(executor.execute({ workerId: "near-limit-before-repair", leaseSeconds: 30, claim })).resolves.toBe(true);
    expect(provider.execute).toHaveBeenCalledTimes(2);
    authorizeReviewRetry(job, job.orchestration_private.generationReview as GenerationReviewCheckpoint);
    await expect(executor.execute({ workerId: "near-limit-before-repair-retry", leaseSeconds: 30, claim: { ...claim, attempts: 2 } })).resolves.toBe(true);

    expect(provider.execute.mock.calls[3]?.[0].budgetOutput).toEqual({ kind: "story_replace" });
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
      pauseForReview: vi.fn(async () => true),
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

  it.each(["legacy", "v3"])("classifies a provider-window overflow with safe protected categories: %s", async (version) => {
    const job = completeGenerationExecutionPayload();
    job.context_options = { ...job.context_options, budgetTokens: 1_000_000 };
    if (version === "v3") job.generation_base_identity = { ...job.generation_base_identity!, version: "generation-base-v3", characterProfileRevision: 1, characterProfileFingerprint: "b".repeat(64) };
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
          authority: { worldCanon: { premise: "word ".repeat(12_000) } }, candidates: [],
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
    if (version === "v3") expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({
      recoveryMetadata: expect.objectContaining({ diagnostic: expect.objectContaining({ protectedComponents: expect.objectContaining({ world_canon: expect.any(Number) }) }) })
    }));
    expect(provider.execute).not.toHaveBeenCalled();
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
  });

  it("hands one opaque prepared illustration snapshot through streamed provisional work and the accepted commit", async () => {
    const job = completeGenerationExecutionPayload();
    const frozenSnapshot = {
      version: 2, state: "prepared",
      routeBasis: { credentialReference: "illustration-profile", authorityRevision: "authority", endpointReference: "endpoint" },
      plan: { prompt: "PRIVATE_FROZEN_ILLUSTRATION_PROMPT", parameters: { temperature: 0.27 }, candidates: [{ modelId: "frozen-illustration-model" }] },
      operationPrompt: "Refine fiction only."
    } as never;
    const narration = Array.from({ length: 120 }, () => "Lanterns guide Mira through the quiet observatory.").join(" ");
    const output = JSON.stringify({ narration, choices: ["Enter.", "Wait.", "Study.", "Call."],
      custom_action_suggestion: "Follow the lanterns.", scratchpad: "", tracker_updates: [], image_prompt: "", continuity_summary: "",
      canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: [] });
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async () => true), pauseForReview: vi.fn(async () => true), savePartialNarration: vi.fn(async () => true),
      saveStreamingSegments: vi.fn(async () => true), recordAttempt: vi.fn(async () => undefined), markRecoverable: vi.fn(async () => true),
      markValidating: vi.fn(async () => true), markCommitting: vi.fn(async () => true),
      commitAcceptedTurn: vi.fn(async () => ({ turnId: "00000000-0000-4000-8000-000000000006" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = {
      id: claim.providerProfileId, name: "Streaming provider", providerRole: "text" as const, providerType: "openai_compatible" as const,
      model: "test-model", contextWindowTokens: 16_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000,
      configuration: { streaming: true }, execute: vi.fn(async (request: { onChunk?: (delta: string, accumulated: string) => Promise<void> }) => {
        await request.onChunk?.(output, output);
        return { content: output, responseId: "stream", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} };
      })
    };
    const illustration = {
      loadStreamingIllustrationConfig: vi.fn(async () => ({
        enabled: true, sourcePolicy: "library_only", matchingScope: "campaign", confidenceProfile: "balanced", repetitionWindow: 3,
        providerProfileId: null, model: "", size: "1024x1024", aspectRatio: "1:1", quality: "auto", outputFormat: "png", maxAttempts: 3,
        segmentWordCount: 100, imagesPerSegment: 1, segmentPromptMode: "ai_refined", refinementPrompt: "", defaultRefinementPrompt: "",
        updatedAt: null, campaignImageProviderProfileId: null, campaignTextProviderProfileId: claim.providerProfileId
      })),
      createProvisionalSet: vi.fn(async () => "provisional-set"), createProvisionalSegment: vi.fn(async () => undefined),
      promoteProvisionalSet: vi.fn(async () => undefined), orphanProvisionalSet: vi.fn(async () => undefined),
      enqueueAcceptedTurnIllustrationSegments: vi.fn(async () => undefined)
    };
    const collaborators = {
      memory: { loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })) },
      illustration, prepareIllustrationTextExecution: vi.fn(async () => frozenSnapshot), loadTextExecution: vi.fn(async () => provider),
      promptFromSnapshot: vi.fn(() => "Write fiction."), recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "native-streaming-snapshot", leaseSeconds: 30, claim })).resolves.toBe(true);

    expect(collaborators.prepareIllustrationTextExecution).toHaveBeenCalledOnce();
    expect(repository.saveStreamingSegments).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      provisionalSetId: "provisional-set", illustrationTextExecutionSnapshot: frozenSnapshot
    }));
    expect((illustration.createProvisionalSegment as ReturnType<typeof vi.fn>).mock.calls.some(([, , request]) =>
      (request as { textExecutionSnapshot?: unknown }).textExecutionSnapshot === frozenSnapshot
    )).toBe(true);
    expect(repository.commitAcceptedTurn).toHaveBeenCalledWith(expect.objectContaining({ illustrationTextExecutionSnapshot: frozenSnapshot }));
  });

  it.each(["unavailable", "ready", "saved", "disabled"] as const)("commits accepted story with illustration metadata outage and %s discovery admission", async (discovery) => {
    const job = completeGenerationExecutionPayload();
    const basis = { version: 2 as const, selection: { kind: "model" as const, modelId: "fixture" }, preset: null,
      candidates: [{ modelId: "fixture", providerPolicy: {}, contextWindowTokens: 8000, maxOutputTokens: 2000 }],
      presetSystemPrompt: "", parameters: {}, endpointReference: "fixture", credentialReference: claim.providerProfileId,
      profileRevision: "fixture", authorityRevision: "fixture", requestTimeoutMs: 30000, protocolVersion: "cast-discovery-v1", routeBasisHash: "0".repeat(64) };
    const frozen = { providerProfileId: claim.providerProfileId, plan: deriveTextExecutionPlan({ ...basis, routeBasisHash: textExecutionRouteBasisHash(basis) }, "Frozen discovery fixture.") };
    if (discovery === "saved") job.orchestration_private.castDiscoveryAdmission = { status: "ready", execution: frozen };
    const output = JSON.stringify({ narration: "The observatory door opens onto a quiet moonlit hall.", choices: ["Enter.", "Wait.", "Study.", "Call."],
      custom_action_suggestion: "Study the door.", scratchpad: "", tracker_updates: [], image_prompt: "", continuity_summary: "",
      canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: [] });
    const repository = {
      loadExecutionPayload: vi.fn(async () => job), renewLease: vi.fn(async () => true), markGenerating: vi.fn(async () => true),
      saveOrchestration: vi.fn(async () => true), pauseForReview: vi.fn(async () => true), savePartialNarration: vi.fn(async () => true),
      saveStreamingSegments: vi.fn(async () => true), recordAttempt: vi.fn(async () => undefined), markRecoverable: vi.fn(async () => true),
      markValidating: vi.fn(async () => true), markCommitting: vi.fn(async () => true),
      commitAcceptedTurn: vi.fn(async () => ({ turnId: "00000000-0000-4000-8000-000000000006" })), markFailed: vi.fn(async () => true)
    } as unknown as GenerationExecutionRepository;
    const provider = {
      id: claim.providerProfileId, name: "Commit provider", providerRole: "text" as const, providerType: "openai_compatible" as const,
      model: "test-model", contextWindowTokens: 16_000, maxOutputTokens: 2_000, temperature: 0, requestTimeoutMs: 1_000, configuration: {},
      execute: vi.fn(async () => ({ content: output, responseId: "normal", finishReason: "stop", outputLimited: false, modelInstanceId: "i", usage: {}, reportedCost: null, rawMetadata: {} }))
    };
    const collaborators = {
      memory: { loadGenerationContext: vi.fn(async () => ({ authority: {}, candidates: [], baseIdentity: job.generation_base_identity, chronicleRetrieval: DEDICATED_CHUNKED_AUDIT })) },
      illustration: { loadStreamingIllustrationConfig: vi.fn(async () => null) }, loadTextExecution: vi.fn(async () => provider),
      prepareIllustrationTextExecution: vi.fn(async () => { throw new Error("synthetic metadata outage"); }),
      ...(discovery === "disabled" ? {} : { prepareCastDiscoveryExecution: vi.fn(async () => {
        if (discovery === "unavailable") throw new Error("synthetic discovery metadata outage");
        return frozen;
      }) }),
      promptFromSnapshot: vi.fn(() => "Write fiction."), recordProfileCost: vi.fn(async () => undefined), attributeGenerationCostsToTurn: vi.fn(async () => undefined)
    } as unknown as GenerationExecutionCollaborators;

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "illustration-preflight-outage", leaseSeconds: 30, claim })).resolves.toBe(true);

    expect(repository.commitAcceptedTurn).toHaveBeenCalledWith(expect.objectContaining({
      illustrationTextExecutionSnapshot: { version: 3, state: "unavailable", errorCode: "illustration_text_route_unavailable" }
    }));
    expect(repository.markRecoverable).not.toHaveBeenCalled();
    if (discovery === "unavailable") expect(repository.commitAcceptedTurn).toHaveBeenCalledWith(expect.objectContaining({ castDiscoveryUnavailable: true }));
    else if (discovery !== "disabled") expect(repository.commitAcceptedTurn).toHaveBeenCalledWith(expect.objectContaining({ castDiscoveryExecution: frozen }));
    else expect(vi.mocked(repository.commitAcceptedTurn).mock.calls[0]![0]).not.toHaveProperty("castDiscoveryExecution");
    if (discovery !== "disabled") expect(collaborators.prepareCastDiscoveryExecution).toHaveBeenCalledTimes(discovery === "saved" ? 0 : 1);
    expect(provider.execute).toHaveBeenCalledOnce();
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
      pauseForReview: vi.fn(async () => true),
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
      errorCode: "generation_prompt_snapshot_invalid",
      recoveryMetadata: expect.objectContaining({ diagnostic: {
        code: "prompt_protocol_upgrade_required", operation: "story_generation", action: "discard_and_reenqueue"
      } })
    }));
    expect(repository.commitAcceptedTurn).not.toHaveBeenCalled();
  });

  it.each([true, false])("rejects mismatched cast policy and captured base before provider loading: %s", async (castContext) => {
    const policy = defaultStoryMemoryPolicy("r1");
    const job = completeGenerationExecutionPayload();
    if (castContext) job.context_options = { ...job.context_options, storyMemoryPolicy: {
      policy, policyHash: storyMemoryPolicyHash(policy), castContext: true, contextProtocol: "current-continuity-v4",
      promptProtocol: "story-v17-campaign-cast", providerConfigurationFingerprint: "a".repeat(64)
    } } as never;
    else job.generation_base_identity = { ...job.generation_base_identity, version: "generation-base-v4" } as never;
    const repository = { ...guardedRepository(), loadExecutionPayload: vi.fn(async () => job), markRecoverable: vi.fn(async () => true) };
    const collaborators = rejectedCollaborators();
    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "worker-a", leaseSeconds: 30, claim })).resolves.toBe(false);
    expect(collaborators.loadTextExecution).not.toHaveBeenCalled();
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "story_memory_cast_base_mismatch" }));
  });

  it("refuses an unsupported future Story Memory policy before loading its provider and publishes discard recovery", async () => {
    const policy = defaultStoryMemoryPolicy("r2");
    const job = completeGenerationExecutionPayload();
    job.context_options = {
      ...job.context_options,
      storyMemoryPolicy: {
        policy: { ...policy, capability: "r4" }, policyHash: storyMemoryPolicyHash(policy), contextProtocol: "current-continuity-v3",
        promptProtocol: "story-v14-continuity-context", providerConfigurationFingerprint: "a".repeat(64)
      }
    } as never;
    const repository = { ...guardedRepository(), loadExecutionPayload: vi.fn(async () => job), markRecoverable: vi.fn(async () => true) };
    const collaborators = rejectedCollaborators();

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "worker-a", leaseSeconds: 30, claim })).resolves.toBe(false);

    expect(collaborators.loadTextExecution).not.toHaveBeenCalled();
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "story_memory_policy_invalid",
      recoveryMetadata: expect.objectContaining({ diagnostic: {
        code: "prompt_protocol_upgrade_required", operation: "story_generation", action: "discard_and_reenqueue"
      } })
    }));
  });

  it("does not dispatch a captured v14 Story Memory job under the v15 protocol", async () => {
    const policy = defaultStoryMemoryPolicy("r2");
    const job = completeGenerationExecutionPayload();
    job.context_options = {
      ...job.context_options,
      storyMemoryPolicy: {
        policy, policyHash: storyMemoryPolicyHash(policy), contextProtocol: "current-continuity-v3",
        promptProtocol: "story-v14-continuity-context", providerConfigurationFingerprint: "a".repeat(64)
      }
    } as never;
    job.prompt_protocol_version = "story-memory-v1|story-v14-continuity-context|story-output-v2|current-continuity-v3";
    const templates = validPromptSnapshot();
    job.prompt_snapshot = {
      version: 2, templates, continuityReview: null,
      storyMemoryCompatibility: {
        protocolIdentity: "story-v15-canonical-fact-format|story-output-v2|current-continuity-v3",
        templateHashes: { story_system: templates.story_system.hash, event_extension: templates.event_extension.hash }
      }
    } as never;
    const repository = { ...guardedRepository(), loadExecutionPayload: vi.fn(async () => job), markRecoverable: vi.fn(async () => true) };
    const collaborators = rejectedCollaborators();

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "worker-a", leaseSeconds: 30, claim })).resolves.toBe(false);

    expect(collaborators.loadTextExecution).not.toHaveBeenCalled();
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({
      recoveryMetadata: expect.objectContaining({ diagnostic: {
        code: "prompt_protocol_upgrade_required", operation: "story_generation", action: "discard_and_reenqueue"
      } })
    }));
  });

  it("rejects a coherent frozen v14 Story Memory job before current prompt composition", async () => {
    const policy = defaultStoryMemoryPolicy("r2");
    const job = completeGenerationExecutionPayload();
    job.context_options = {
      ...job.context_options,
      storyMemoryPolicy: {
        policy, policyHash: storyMemoryPolicyHash(policy), contextProtocol: "current-continuity-v3",
        promptProtocol: "story-v14-continuity-context", providerConfigurationFingerprint: "a".repeat(64)
      }
    } as never;
    const templates = validPromptSnapshot();
    job.prompt_protocol_version = `story-memory-v1|${snapshotProtocolIdentity(templates)}`;
    job.prompt_snapshot = {
      version: 2, templates, continuityReview: null,
      storyMemoryCompatibility: {
        protocolIdentity: "story-v14-continuity-context|story-output-v2|current-continuity-v3",
        templateHashes: { story_system: templates.story_system.hash, event_extension: templates.event_extension.hash }
      }
    } as never;
    const repository = { ...guardedRepository(), loadExecutionPayload: vi.fn(async () => job), markRecoverable: vi.fn(async () => true) };
    const collaborators = rejectedCollaborators();

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "worker-a", leaseSeconds: 30, claim })).resolves.toBe(false);

    expect(collaborators.loadTextExecution).not.toHaveBeenCalled();
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "generation_prompt_snapshot_invalid",
      recoveryMetadata: { reason: "generation_prompt_snapshot_invalid", diagnostic: {
        code: "prompt_protocol_upgrade_required", operation: "story_generation", action: "discard_and_reenqueue"
      } }
    }));
  });

  it("does not dispatch a v15 Story Memory policy with a captured v14 acknowledgement", async () => {
    const policy = defaultStoryMemoryPolicy("r2");
    const job = completeGenerationExecutionPayload();
    job.context_options = {
      ...job.context_options,
      storyMemoryPolicy: {
        policy, policyHash: storyMemoryPolicyHash(policy), contextProtocol: "current-continuity-v3",
        promptProtocol: "story-v15-canonical-fact-format", providerConfigurationFingerprint: "a".repeat(64)
      }
    } as never;
    const templates = validPromptSnapshot();
    job.prompt_snapshot = {
      version: 2, templates, continuityReview: null,
      storyMemoryCompatibility: {
        protocolIdentity: "story-v14-continuity-context|story-output-v2|current-continuity-v3",
        templateHashes: { story_system: templates.story_system.hash, event_extension: templates.event_extension.hash }
      }
    } as never;
    const repository = { ...guardedRepository(), loadExecutionPayload: vi.fn(async () => job), markRecoverable: vi.fn(async () => true) };
    const collaborators = rejectedCollaborators();

    await expect(createGenerationExecutor({ pool: {} as DatabasePool, repository, collaborators })
      .execute({ workerId: "worker-a", leaseSeconds: 30, claim })).resolves.toBe(false);

    expect(collaborators.loadTextExecution).not.toHaveBeenCalled();
    expect(repository.markRecoverable).toHaveBeenCalledWith(expect.objectContaining({
      recoveryMetadata: expect.objectContaining({ diagnostic: {
        code: "prompt_protocol_upgrade_required", operation: "story_generation", action: "discard_and_reenqueue"
      } })
    }));
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
