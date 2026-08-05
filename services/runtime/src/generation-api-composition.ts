import {
  createGenerationApplication,
  type GenerationApplication,
  type GenerationCommandRepository
} from "../../../packages/application/src/index.js";
import { createPostgresGenerationCommandRepository } from "../../../packages/database/src/generation-repository.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
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
  factories: ApiGenerationCompositionFactories = productionFactories
): GenerationApplication {
  const repository = factories === productionFactories
    ? createPostgresGenerationCommandRepository(pool, {
      resolvePromptSnapshot: async (_client, ownerUserId, campaignId) => (
        await providers.prompts.loadGenerationPromptSnapshot({ ownerUserId, campaignId })
      ).snapshot,
      promptProtocolVersion: providers.promptTools.protocolVersion,
      readTurnReportedCosts: (ownerUserId, campaignId, turnIds) => providers.reads.getTurnCosts({
        ownerUserId,
        campaignId,
        turnIds
      })
    })
    : factories.createCommandRepository(pool);
  return factories.createApplication(repository);
}
