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
import { withTransaction } from "../../../packages/database/src/pool.js";
import type { WorkerGenerationProviderCollaborators } from "./provider-application-composition.js";
import {
  createGenerationExecutor,
  type GenerationExecutionCollaborators,
  type GenerationExecutorDependencies
} from "./generation-executor-adapter.js";

type WorkerGenerationRepository = GenerationClaimRepository & GenerationExecutionRepository;

export type WorkerGenerationCompositionFactories = Readonly<{
  createRepository(pool: DatabasePool): WorkerGenerationRepository;
  createCollaborators(
    pool: DatabasePool,
    illustration: IllustrationApplication,
    memory: MemoryApplication,
    providers: WorkerGenerationProviderCollaborators,
  ): GenerationExecutionCollaborators;
  createExecutor(dependencies: GenerationExecutorDependencies): GenerationExecutor;
  createApplication(dependencies: Readonly<{
    claims: GenerationClaimRepository;
    executor: GenerationExecutor;
  }>): GenerationWorkerApplication;
}>;

export function createGenerationExecutionCollaborators(
  pool: DatabasePool,
  illustration: IllustrationApplication,
  memory: MemoryApplication,
  providers: WorkerGenerationProviderCollaborators,
): GenerationExecutionCollaborators {
  return {
    memory: memory.generation,
    illustration: illustration.generation,
    loadTextExecution: (ownerUserId, providerProfileId, model) => providers.execution.text(
      { ownerUserId },
      providerProfileId,
      "text",
      model
    ),
    promptFromSnapshot: providers.promptTools.content,
    recordProfileCost: (_database, profile, attribution, result) => withTransaction(pool, (client) =>
      providers.costs.recordGenerationCost(providers.costContext(client), {
        ...attribution,
        providerProfileId: profile.id,
        providerType: profile.providerType,
        requestedModel: profile.model,
        resolvedModel: result.modelInstanceId || profile.model,
        providerResponseId: result.responseId,
        usage: result.usage,
        reportedCost: result.reportedCost
      })
    ),
    attributeGenerationCostsToTurn: (client, ownerUserId, campaignId, generationJobId, turnId) =>
      providers.attributeCosts.attributeGenerationCostsToTurn(providers.costContext(client), {
        ownerUserId,
        campaignId,
        generationJobId,
        turnId
      })
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
  illustration: IllustrationApplication,
  memory: MemoryApplication,
  providers: WorkerGenerationProviderCollaborators,
  factories: WorkerGenerationCompositionFactories = productionFactories,
): GenerationWorkerApplication {
  const repository = factories.createRepository(pool);
  const collaborators = factories.createCollaborators(pool, illustration, memory, providers);
  const executor = factories.createExecutor({
    pool,
    repository,
    collaborators
  });
  return factories.createApplication({ claims: repository, executor });
}
