import {
  createGenerationWorkerApplication,
  type GenerationClaimRepository,
  type GenerationExecutor,
  type GenerationWorkerApplication,
  type IllustrationApplication,
  type MemoryApplication
} from "../../../packages/application/src/index.js";
import {
  createPostgresGenerationExecutionRepository,
  type GenerationExecutionRepository
} from "../../../packages/database/src/generation-execution-repository.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { loadTextProvider } from "./provider-runtime-adapter.js";
import {
  attributeGenerationCostsToTurn,
  recordProfileCost,
  turnReportedCosts
} from "./provider-cost-adapter.js";
import {
  promptFromSnapshot,
  promptProtocolVersion,
  resolvePromptSnapshot
} from "./provider-prompt-adapter.js";
import {
  createGenerationExecutor,
  type GenerationExecutionCollaborators,
  type GenerationExecutorDependencies
} from "./generation-executor-adapter.js";

type WorkerGenerationRepository = GenerationClaimRepository & GenerationExecutionRepository;

export type WorkerGenerationCompositionFactories = Readonly<{
  createRepository(pool: DatabasePool): WorkerGenerationRepository;
  createCollaborators(illustration: IllustrationApplication, memory: MemoryApplication): GenerationExecutionCollaborators;
  createExecutor(dependencies: GenerationExecutorDependencies): GenerationExecutor;
  createApplication(dependencies: Readonly<{
    claims: GenerationClaimRepository;
    executor: GenerationExecutor;
  }>): GenerationWorkerApplication;
}>;

export function createGenerationExecutionCollaborators(
  illustration: IllustrationApplication,
  memory: MemoryApplication,
): GenerationExecutionCollaborators {
  return {
    memory: memory.generation,
    illustration: illustration.generation,
    loadTextProvider,
    resolvePromptSnapshot,
    promptFromSnapshot,
    promptProtocolVersion,
    recordProfileCost,
    turnReportedCosts: async (database, ownerUserId, turnIds) =>
      await turnReportedCosts(database, ownerUserId, turnIds) as Map<string, unknown>,
    attributeGenerationCostsToTurn
  };
}

const productionFactories: WorkerGenerationCompositionFactories = {
  createRepository: createPostgresGenerationExecutionRepository,
  createCollaborators: createGenerationExecutionCollaborators,
  createExecutor: createGenerationExecutor,
  createApplication: createGenerationWorkerApplication
};

export function createWorkerGenerationApplication(
  pool: DatabasePool,
  credentialSecret: string,
  illustration: IllustrationApplication,
  memory: MemoryApplication,
  factories: WorkerGenerationCompositionFactories = productionFactories,
): GenerationWorkerApplication {
  const repository = factories.createRepository(pool);
  const collaborators = factories.createCollaborators(illustration, memory);
  const executor = factories.createExecutor({
    pool,
    repository,
    collaborators,
    credentialSecret
  });
  return factories.createApplication({ claims: repository, executor });
}
