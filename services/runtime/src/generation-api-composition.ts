import {
  createGenerationApplication,
  GenerationApplicationError,
  type GenerationApplication,
  type GenerationCommandRepository
} from "../../../packages/application/src/index.js";
import { createPostgresGenerationCommandRepository, resolveTextProviderId } from "../../../packages/database/src/generation-repository.js";
import type { PostgresGenerationCommandRepositoryDependencies } from "../../../packages/database/src/generation-repository.js";
import { resolveStoryMemoryPromptSnapshot, resolveStoryPromptSnapshot } from "../../../packages/database/src/prompt-repository.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { resolveStoryMemoryPolicySnapshot, type StoryMemoryOperatorConfig } from "../../../packages/database/src/story-memory-policy-repository.js";
import { effectiveProviderConfigurationFingerprint } from "../../../packages/contracts/src/story-memory-policy.js";
import { resolveEffectiveContextWindowTokens } from "../../../packages/story-engine/src/index.js";
import type { ApiGenerationProviderCollaborators } from "./provider-application-composition.js";
import { queuedResponseContractPolicy, responseContractInvocationClosure } from "./generation-response-contract.js";
import { resolveTextExecutionRouteBasis } from "./provider-preset-resolution.js";
import type { TextExecutionRouteBasis } from "../../../packages/contracts/src/text-execution-plan.js";
import { normalizeTextSelection } from "../../../packages/contracts/src/provider-selection.js";

export type ApiGenerationCompositionFactories = Readonly<{
  createCommandRepository(pool: DatabasePool): GenerationCommandRepository;
  createApplication(repository: GenerationCommandRepository): GenerationApplication;
}>;

const productionFactories: ApiGenerationCompositionFactories = {
  createCommandRepository: () => {
    throw new Error("Provider collaborators are required.");
  },
  createApplication: createGenerationApplication
};

/**
 * Queue metadata is derived from the same transaction-local profile read that
 * selected the campaign provider.  It intentionally keeps the profile's base
 * cap separate from the caller's selected-model cap used in the fingerprint.
 */
export function createQueuedResponsePolicyResolver(providers: ApiGenerationProviderCollaborators): NonNullable<PostgresGenerationCommandRepositoryDependencies["resolveQueuedResponsePolicy"]> {
  return async (client, scope) => {
    const profile = await providers.loadQueuedTextProfile(client, scope.ownerUserId, scope.providerProfileId, scope.requestedModel);
    const policy = profile.configuration.textResponseFormatPolicy as "legacy" | "auto" | "required" | undefined ?? "required";
    if (policy === "legacy") return undefined;
    const effectiveContextWindowTokens = resolveEffectiveContextWindowTokens(profile.contextWindowTokens, scope.modelContextWindowTokens);
    const configurationHash = effectiveProviderConfigurationFingerprint({
      providerId: profile.id, providerType: profile.providerType, endpointIdentity: profile.endpointIdentity ?? "",
      model: profile.model, contextWindowTokens: profile.contextWindowTokens, maxOutputTokens: profile.maxOutputTokens,
      temperature: profile.temperature, requestTimeoutMs: profile.requestTimeoutMs, configuration: profile.configuration,
      effectiveContextWindowTokens, inputSafetyPolicy: "estimated_20_percent_plus_1024"
    });
    return queuedResponseContractPolicy({
      policy,
      profile: { id: profile.id, providerType: profile.providerType, model: profile.model,
        endpointIdentity: profile.endpointIdentity ?? "", configurationHash },
      verificationRegistryHash: providers.responseFormatCapabilities.registryDigest,
      invocationKeys: responseContractInvocationClosure({
        streamingPrimary: profile.configuration.streaming === true || profile.configuration.streamingSupport === true,
        storyOnly: scope.generationPolicy.playMode === "story_only",
        continuityReview: scope.storyMemoryPolicy?.policy.continuityReview ?? "off"
      })
    });
  };
}

/**
 * Resolves remote preset/model metadata before the command repository acquires
 * campaign locks. The matching verifier below only performs a local profile
 * read, so an unavailable remote endpoint can never extend a DB transaction.
 */
function createTextExecutionRouteBasisPreparation(
  pool: DatabasePool,
  providers: ApiGenerationProviderCollaborators,
): Pick<PostgresGenerationCommandRepositoryDependencies, "prepareTextExecutionRouteBasis" | "verifyTextExecutionRouteBasis"> {
  return {
    prepareTextExecutionRouteBasis: async (scope): Promise<TextExecutionRouteBasis | undefined> => {
      const campaign = await pool.query<{ textProviderProfileId: string | null }>(
        `SELECT text_provider_profile_id AS "textProviderProfileId" FROM campaigns WHERE id=$1 AND owner_user_id=$2`,
        [scope.campaignId, scope.ownerUserId]
      );
      if (!campaign.rows[0]) throw new GenerationApplicationError("not_found", { campaignId: scope.campaignId });
      const providerProfileId = await resolveTextProviderId(
        pool,
        scope.ownerUserId,
        scope.requestedProviderProfileId ?? campaign.rows[0]?.textProviderProfileId,
      );
      if (!providerProfileId) return undefined;
      const profile = await providers.execution.text({ ownerUserId: scope.ownerUserId }, providerProfileId, "text", undefined);
      // Typed request selections win. The legacy model field is normalized
      // only through its exact compatibility alias, so @preset/slug remains a
      // preset and is never mistaken for a model ID.
      const selection = scope.requestedTextSelection ?? (scope.requestedModel.trim()
        ? normalizeTextSelection({ providerType: profile.providerType, providerRole: "text", defaultModel: scope.requestedModel })
        : profile.textSelection ?? normalizeTextSelection({ providerType: profile.providerType, providerRole: "text", defaultModel: profile.model }));
      // Tasks 4/5 own admission and dispatch. Ordinary model jobs retain the
      // historical queue path; only an explicitly selected native preset gets
      // a frozen v2 descriptor here.
      if (selection.kind !== "openrouter_preset") return undefined;
      if (!profile.executionRevision || !profile.authorityRevision) {
        throw new GenerationApplicationError("conflict", { reason: "provider_profile_changed_refresh_required" });
      }
      return resolveTextExecutionRouteBasis({
        profile: {
          ownerUserId: scope.ownerUserId, providerProfileId, profileRevision: profile.executionRevision,
          authorityRevision: profile.authorityRevision,
          providerType: profile.providerType, selection, contextWindowTokens: profile.contextWindowTokens,
          maxOutputTokens: profile.maxOutputTokens, endpointReference: profile.endpointIdentity ?? profile.id,
          credentialReference: profile.id, requestTimeoutMs: profile.requestTimeoutMs,
          parameters: { temperature: profile.temperature }, protocolVersion: "text-execution-route-basis-v2"
        },
        ports: {
          resolvePreset: async ({ ownerUserId, providerProfileId: id, slug }) =>
            (await providers.responseFormatInventory.getPreset({ ownerUserId, providerProfileId: id, slug })).preset,
          discoverModels: async ({ ownerUserId, providerProfileId: id, modelIds }) => {
            const inventory = await providers.responseFormatInventory.listModels({ ownerUserId, providerProfileId: id, providerRole: "text" });
            return inventory.models.filter((model) => modelIds.includes(model.id)).map((model) => ({ id: model.id,
              ...(model.contextWindowTokens === undefined ? {} : { contextWindowTokens: model.contextWindowTokens }) }));
          }
        }
      });
    },
    verifyTextExecutionRouteBasis: async (client, scope) => {
      const profile = await providers.loadQueuedTextProfile(client, scope.ownerUserId, scope.providerProfileId, undefined);
      return profile.executionRevision === scope.routeBasis.profileRevision
        && profile.authorityRevision === scope.routeBasis.authorityRevision
        && (profile.endpointIdentity ?? profile.id) === scope.routeBasis.endpointReference
        && profile.id === scope.providerProfileId
        && scope.routeBasis.credentialReference === profile.id;
    }
  };
}

export function createApiGenerationApplication(
  pool: DatabasePool,
  providers: ApiGenerationProviderCollaborators,
  factories: ApiGenerationCompositionFactories = productionFactories,
  operatorConfig?: StoryMemoryOperatorConfig,
  /** Task 4/5 owns the production admission gate. Tests may opt in to exercise persistence. */
  nativeTextExecutionPlanAdmission = false
): GenerationApplication {
  // Callers may pass already-resolved operator settings. The safe legacy
  // default keeps isolated factory composition from reading process env.
  const resolvedOperatorConfig = operatorConfig ?? { installedCapability: null, enforceEnabled: false };
  const repository = factories === productionFactories
    ? createPostgresGenerationCommandRepository(pool, {
      resolvePromptSnapshot: async (client, ownerUserId, campaignId, storyMemoryPolicy) => storyMemoryPolicy
        ? resolveStoryMemoryPromptSnapshot(client, { ownerUserId, scope: "campaign", campaignId }, storyMemoryPolicy.policy.continuityReview)
        : resolveStoryPromptSnapshot(client, { ownerUserId, scope: "campaign", campaignId }),
      promptProtocolVersion: providers.promptTools.protocolVersion,
      resolveStoryMemoryPolicySnapshot: (client, scope) => resolveStoryMemoryPolicySnapshot(client, scope, {
         installedCapability: resolvedOperatorConfig.installedCapability,
         enforceEnabled: resolvedOperatorConfig.enforceEnabled
      }),
      resolveQueuedResponsePolicy: createQueuedResponsePolicyResolver(providers),
      ...(nativeTextExecutionPlanAdmission ? createTextExecutionRouteBasisPreparation(pool, providers) : {}),
      readTurnReportedCosts: (ownerUserId, campaignId, turnIds) => providers.reads.getTurnCosts({
        ownerUserId,
        campaignId,
        turnIds
      })
    })
    : factories.createCommandRepository(pool);
  return factories.createApplication(repository);
}
