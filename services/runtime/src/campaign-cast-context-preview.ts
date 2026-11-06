import { randomUUID } from "node:crypto";
import { estimateContinuityReviewPlanningTokens } from "./story-continuity-review-adapter.js";
import { readTextExecutionRouteBasis } from "../../../packages/contracts/src/text-execution-plan.js";
import { readFrozenResponseContractsV2 } from "../../../packages/contracts/src/generation-response-contract.js";
import { continuityReviewExecutionSnapshotSchema } from "../../../packages/contracts/src/continuity-review-execution.js";
import { prepareFrozenContinuityReviewRequest } from "./continuity-review-execution.js";
import { deriveCampaignTextExecutionPlan, serializeFrozenCampaignRequest } from "./generation-executor-adapter.js";
import type { GenerationExecutionPayload } from "../../../packages/database/src/generation-execution-repository.js";
import { castContextExplanationSchema, type CastContextPreviewRequest } from "../../../packages/contracts/src/memory.js";
import { withTransaction, type DatabasePool } from "../../../packages/database/src/pool.js";
import type { RuntimeConfig } from "../../../packages/database/src/config.js";
import { resolveStoryMemoryPolicySnapshot } from "../../../packages/database/src/story-memory-policy-repository.js";
import { resolveGenerationAuthoritySnapshot } from "../../../packages/database/src/generation-authority.js";
import { loadPostgresChronicleGenerationAuthorityContext } from "../../../packages/database/src/chronicle-generation-context.js";
import { resolveStoryMemoryPromptSnapshot } from "../../../packages/database/src/prompt-repository.js";
import { planGenerationPromptContext } from "./generation-context-planner.js";
import { storyLengthProfileFromUnknown, storyLengthWordRange } from "../../../packages/contracts/src/story-settings.js";
import { appendStoryOutputEncodingContract, storyOutputEncodingContract, STORY_PARAGRAPH_WIRE_SCHEMA_VERSION } from "../../../packages/contracts/src/story-prompt.js";
import { composeEffectiveStorySystemPrompt, storyOnlyPromptSnapshot } from "../../../packages/story-engine/src/index.js";
import type { RuntimeTextExecution } from "./provider-credential-transport-adapter.js";

/** Provider-free estimate using current scoped authority and the generation planner.
 * Unsupported routes are explicitly unavailable rather than assigned a guessed budget. */
export function createCastContextPreview(pool: DatabasePool, config: Pick<RuntimeConfig,
  "castContextEnabled" | "storyMemoryCapability" | "storyMemoryEnforceEnabled" | "historyCoverageEnabled">) {
  return async (ownerUserId: string, campaignId: string, request: CastContextPreviewRequest) => withTransaction(pool, async client => {
    const campaign = (await client.query(`SELECT c.*,s.revision AS cast_revision,s.timeline_revision FROM campaigns c
      LEFT JOIN campaign_cast_state s ON s.campaign_id=c.id AND s.owner_user_id=c.owner_user_id
      WHERE c.id=$1 AND c.owner_user_id=$2 FOR UPDATE OF c`, [campaignId, ownerUserId])).rows[0];
    if (!campaign) throw Object.assign(new Error("Campaign not found."), { statusCode: 404 });
    const disabled = (reason: string) => castContextExplanationSchema.parse({ mode: "estimate",
      boundary: { turnNumber: campaign.active_turn_number, timelineRevision: campaign.timeline_revision ?? 0 },
      castRevision: campaign.cast_revision ?? 0, budgetTokens: 0, usedTokens: 0, selected: [], omitted: [],
      coverage: { fromTurn: null, throughTurn: null, baseTurn: campaign.active_turn_number, current: false }, disabledReason: reason });
    if (!config.castContextEnabled || !config.storyMemoryCapability) return disabled("Character context is disabled by the operator.");
    const enrollment = (await client.query("SELECT capability,review_mode FROM campaign_story_memory_enrollments WHERE campaign_id=$1 AND owner_user_id=$2", [campaignId, ownerUserId])).rows[0];
    if (!enrollment) return disabled("Story Memory is off for this campaign.");
    const providerRow = (await client.query(`SELECT id,name,provider_type,default_model,text_selection,context_window_tokens,max_output_tokens,temperature,request_timeout_ms,configuration,updated_at
      FROM provider_profiles WHERE owner_user_id=$1 AND provider_role='text' AND enabled=true
      AND ($2::uuid IS NULL OR id=$2) ORDER BY is_default DESC,name,id LIMIT 1`, [ownerUserId, campaign.text_provider_profile_id])).rows[0];
    const selectedModel = providerRow?.text_selection?.kind === "model" ? providerRow.text_selection.modelId : providerRow?.default_model;
    if (!selectedModel) return disabled("Preview needs a configured text model.");
    const cached = (await client.query(`SELECT orchestration_private->'textExecutionRouteBasis' AS basis,
      orchestration_private->'frozenResponseContracts' AS contracts, orchestration_private->'continuityReviewExecution' AS reviewer
      FROM generation_jobs WHERE owner_user_id=$1 AND campaign_id=$2 AND provider_profile_id=$3
        AND created_at >= $4 AND orchestration_private ? 'frozenResponseContracts'
      ORDER BY created_at DESC LIMIT 1`, [ownerUserId, campaignId, providerRow.id, providerRow.updated_at])).rows[0];
    let frozenJob: Pick<GenerationExecutionPayload, "orchestration_private"> | undefined;
    let reviewer: ReturnType<typeof continuityReviewExecutionSnapshotSchema.parse>["primary"] | undefined;
    if (cached?.basis && cached.contracts) {
      try {
        const basis = readTextExecutionRouteBasis(cached.basis), contracts = readFrozenResponseContractsV2(cached.contracts);
        const selectionMatches = basis.selection.kind === "model" ? basis.selection.modelId === selectedModel
          : providerRow.text_selection?.kind === "openrouter_preset" && basis.selection.slug === providerRow.text_selection.slug;
        if (basis.credentialReference === providerRow.id && contracts.queuedPolicy.providerProfileId === providerRow.id && selectionMatches) {
          frozenJob = { orchestration_private: { textExecutionRouteBasis: basis, frozenResponseContracts: contracts } };
          if (cached.reviewer) reviewer = continuityReviewExecutionSnapshotSchema.parse(cached.reviewer).primary;
        }
      } catch { /* Invalid cached metadata cannot grant a preview execution route. */ }
    }
    const preset = providerRow.text_selection?.kind === "openrouter_preset" || selectedModel.startsWith("@preset/");
    if (preset && !frozenJob) return disabled("Preview needs locally saved settings for this preset. Generate a turn with these settings first.");
    const baseProvider: RuntimeTextExecution = { id: providerRow.id, name: providerRow.name, providerRole: "text", providerType: providerRow.provider_type,
      model: selectedModel, contextWindowTokens: providerRow.context_window_tokens, maxOutputTokens: providerRow.max_output_tokens,
      temperature: providerRow.temperature, requestTimeoutMs: providerRow.request_timeout_ms, configuration: providerRow.configuration,
      async execute() { throw new Error("Context preview cannot execute a model."); } };
    const route = frozenJob?.orchestration_private?.textExecutionRouteBasis;
    const provider: RuntimeTextExecution = route ? { ...baseProvider, model: route.candidates[0]!.modelId,
      contextWindowTokens: Math.min(baseProvider.contextWindowTokens, route.candidates[0]!.contextWindowTokens),
      maxOutputTokens: route.candidates[0]!.maxOutputTokens, temperature: route.parameters.temperature ?? 0, requestTimeoutMs: route.requestTimeoutMs } : baseProvider;
    const policy = await resolveStoryMemoryPolicySnapshot(client, { ownerUserId, campaignId, providerProfileId: provider.id, requestedModel: provider.model, ...(route ? { textExecutionRouteBasis: route } : {}) }, {
      installedCapability: config.storyMemoryCapability, enforceEnabled: config.storyMemoryEnforceEnabled === true,
      castContextEnabled: true, historyCoverageEnabled: config.historyCoverageEnabled !== false });
    if (!policy?.castContext) return disabled("Character context is unavailable for the current Story Memory settings.");
    if (policy.policy.continuityReview !== "off" && providerRow.configuration.continuityReviewExecutionPolicy && !reviewer) {
      return disabled("Preview needs locally saved settings for the configured continuity reviewer.");
    }
    const history = config.historyCoverageEnabled !== false;
    const scope = { ownerUserId, campaignId, operationKind: "append" as const, expectedTurnNumber: campaign.active_turn_number + 1 };
    const captured = await resolveGenerationAuthoritySnapshot(client, { ...scope, baseIdentityVersion: "generation-base-v4",
      captureRecentWindow: history ? policy.policy.capability !== "r1" : policy.policy.recentTurnTarget > 1, ...(history && policy.policy.capability !== "r1" ? { recentWindowTurns: 11 as const } : {}), captureStoryLedger: history, captureProtectedFacts: history });
    const authority = await loadPostgresChronicleGenerationAuthorityContext(client, { ...scope, worldVersionId: campaign.world_version_id,
      query: request.query, expectedBaseIdentity: captured.baseIdentity, storyMemoryPolicy: policy });
    const prompts = await resolveStoryMemoryPromptSnapshot(client, { scope: "campaign", ownerUserId, campaignId }, policy.policy.continuityReview, true);
    const frozenContracts = frozenJob?.orchestration_private?.frozenResponseContracts;
    const streaming = provider.providerType === "lmstudio" || provider.providerType === "openai_compatible"
      || provider.providerType === "openrouter" && (provider.configuration.streaming === true || provider.configuration.streamingSupport === true);
    const storyContract = frozenContracts?.version === 2 ? frozenContracts.contracts[streaming ? "story:stream" : "story:nonstream"] : undefined;
    if (frozenJob && !storyContract) return disabled("Saved route settings do not support the current delivery mode.");
    const systemPrompt = appendStoryOutputEncodingContract(composeEffectiveStorySystemPrompt({ writerPrompt: prompts.templates.story_system.content,
      storyOnlyPolicy: campaign.turn_control_style === "flexible_scene" ? { version: 1, playMode: "story_only", turnControlStyle: "flexible_scene", protocolVersion: "story-only-v1", prompts: storyOnlyPromptSnapshot() } : null, storyMemoryPromptProtocol: policy.promptProtocol, encodingContract: "" }), storyOutputEncodingContract(storyContract?.schemaVersion ?? STORY_PARAGRAPH_WIRE_SCHEMA_VERSION));
    const inputMode = campaign.turn_control_style === "flexible_scene" ? "scene" : request.inputMode;
    const length = storyLengthWordRange(storyLengthProfileFromUnknown(campaign.story_length_profile));
    const inputLimit = provider.contextWindowTokens - provider.maxOutputTokens;
    const budget = Math.max(0, request.budgetTokens ?? campaign.story_context_budget_tokens);
    if (budget === 0) return disabled("No context budget remains for this input.");
    try {
      const plan = planGenerationPromptContext(authority, provider, systemPrompt, request.query, [], length, inputMode,
        budget, inputLimit, randomUUID(), "story_memory", policy.policy,
        frozenJob ? input => serializeFrozenCampaignRequest(provider, frozenJob, "story_generation", { systemPrompt, input,
          ...(streaming ? { onChunk: () => undefined } : {}) }).body : undefined,
        policy.policy.continuityReview !== "off" ? manifest => estimateContinuityReviewPlanningTokens({
          provider: reviewer ? { ...provider, model: reviewer.routeBasis.candidates[0]!.modelId,
            contextWindowTokens: reviewer.effectiveContextWindowTokens, maxOutputTokens: reviewer.effectiveOutputTokens,
            temperature: reviewer.routeBasis.parameters.temperature ?? 0, requestTimeoutMs: reviewer.routeBasis.requestTimeoutMs } : provider,
          manifest, producingRequestHash: manifest.producingRequestHash, promptSnapshot: prompts, reviewMode: policy.policy.continuityReview as "observe" | "enforce",
          direction: request.query, candidateOutputTokens: provider.maxOutputTokens,
          ...(reviewer ? { bindRequest: request => prepareFrozenContinuityReviewRequest({ ...reviewer, effectiveContextWindowTokens: Number.MAX_SAFE_INTEGER }, request).request,
            serializeRequest: request => prepareFrozenContinuityReviewRequest({ ...reviewer, effectiveContextWindowTokens: Number.MAX_SAFE_INTEGER }, request).preparedRequest }
            : frozenJob ? { prepareSystemPrompt: operationPrompt => { const plan = deriveCampaignTextExecutionPlan(frozenJob, operationPrompt); return { systemPrompt: operationPrompt, ...(plan ? { textExecutionPlan: plan } : {}) }; },
              serializeRequest: (request, plan) => serializeFrozenCampaignRequest(provider, frozenJob, "story_continuity_review", request, plan) } : {})
        }) : undefined,
        reviewer ? reviewer.effectiveContextWindowTokens - reviewer.effectiveOutputTokens : inputLimit, policy.contextProtocol);
      return plan.castExplanation ? castContextExplanationSchema.parse({ ...plan.castExplanation, note: "Estimate using configured limits and locally available route settings. Final provider routing, verified output format, action assessment, and new story state may change selection." }) : disabled("No character context was selected.");
    } catch (error) {
      if (error instanceof Error && error.name === "ContextBudgetError") return disabled("The current story authority exceeds the available context budget.");
      throw error;
    }
  });
}
