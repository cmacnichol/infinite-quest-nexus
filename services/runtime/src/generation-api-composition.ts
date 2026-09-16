import {
  createGenerationApplication,
  type GenerationApplication,
  type GenerationCommandRepository
} from "../../../packages/application/src/index.js";
import { createPostgresGenerationCommandRepository } from "../../../packages/database/src/generation-repository.js";
import { resolveStoryMemoryPromptSnapshot } from "../../../packages/database/src/prompt-repository.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { resolveStoryMemoryPolicySnapshot, type StoryMemoryOperatorConfig } from "../../../packages/database/src/story-memory-policy-repository.js";
import type { ApiGenerationProviderCollaborators } from "./provider-application-composition.js";

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
        : (await providers.prompts.loadGenerationPromptSnapshot({ ownerUserId, campaignId })).snapshot,
      promptProtocolVersion: providers.promptTools.protocolVersion,
      resolveStoryMemoryPolicySnapshot: (client, scope) => resolveStoryMemoryPolicySnapshot(client, scope, {
         installedCapability: resolvedOperatorConfig.installedCapability,
         enforceEnabled: resolvedOperatorConfig.enforceEnabled
      }),
      readTurnReportedCosts: (ownerUserId, campaignId, turnIds) => providers.reads.getTurnCosts({
        ownerUserId,
        campaignId,
        turnIds
      })
    })
    : factories.createCommandRepository(pool);
  return factories.createApplication(repository);
}
