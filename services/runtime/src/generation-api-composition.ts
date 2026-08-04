import {
  createGenerationApplication,
  type GenerationApplication,
  type GenerationCommandRepository
} from "../../../packages/application/src/index.js";
import { createPostgresGenerationCommandRepository } from "../../../packages/database/src/generation-repository.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { turnReportedCosts } from "../../api/src/cost-service.js";
import { promptProtocolVersion, resolvePromptSnapshot } from "../../api/src/prompt-library-service.js";

export type ApiGenerationCompositionFactories = Readonly<{
  createCommandRepository(pool: DatabasePool): GenerationCommandRepository;
  createApplication(repository: GenerationCommandRepository): GenerationApplication;
}>;

const productionFactories: ApiGenerationCompositionFactories = {
  createCommandRepository: (pool) => createPostgresGenerationCommandRepository(pool, {
    resolvePromptSnapshot,
    promptProtocolVersion,
    readTurnReportedCosts: (ownerUserId, turnIds) => turnReportedCosts(pool, ownerUserId, [...turnIds])
  }),
  createApplication: createGenerationApplication
};

export function createApiGenerationApplication(
  pool: DatabasePool,
  factories: ApiGenerationCompositionFactories = productionFactories
): GenerationApplication {
  const repository = factories.createCommandRepository(pool);
  return factories.createApplication(repository);
}
