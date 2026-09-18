import {
  createGenerationApplication,
  type GenerationApplication,
  type GenerationCommandRepository
} from "../../../packages/application/src/index.js";
import { createPostgresGenerationCommandRepository } from "../../../packages/database/src/generation-repository.js";
import { resolveStoryMemoryPromptSnapshot, resolveStoryPromptSnapshot } from "../../../packages/database/src/prompt-repository.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { resolveStoryMemoryPolicySnapshot, type StoryMemoryOperatorConfig } from "../../../packages/database/src/story-memory-policy-repository.js";
import { effectiveProviderConfigurationFingerprint } from "../../../packages/contracts/src/story-memory-policy.js";
import { resolveEffectiveContextWindowTokens } from "../../../packages/story-engine/src/index.js";
import type { ApiGenerationProviderCollaborators } from "./provider-application-composition.js";
import { queuedResponseContractPolicy, responseContractInvocationClosure } from "./generation-response-contract.js";

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

export function createApiGenerationApplication(
  pool: DatabasePool,
  providers: ApiGenerationProviderCollaborators,
  factories: ApiGenerationCompositionFactories = productionFactories,
  operatorConfig?: StoryMemoryOperatorConfig
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
      resolveQueuedResponsePolicy: async (_client, scope) => {
        const profile = await providers.execution.text(
          { ownerUserId: scope.ownerUserId }, scope.providerProfileId, "text", scope.requestedModel,
          scope.modelContextWindowTokens
        );
        const policy = profile.configuration.textResponseFormatPolicy as "legacy" | "auto" | "required" | undefined;
        if (!policy || policy === "legacy") return undefined;
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
      },
      readTurnReportedCosts: (ownerUserId, campaignId, turnIds) => providers.reads.getTurnCosts({
        ownerUserId,
        campaignId,
        turnIds
      })
    })
    : factories.createCommandRepository(pool);
  return factories.createApplication(repository);
}
