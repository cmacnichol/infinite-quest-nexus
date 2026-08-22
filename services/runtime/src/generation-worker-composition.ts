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
  type GenerationExecutionRepository,
  type GenerationModelRoutingSnapshot
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
    loadTextExecution: async (ownerUserId, providerProfileId, routing: GenerationModelRoutingSnapshot) => {
      // Do not re-resolve this job through the current profile or a remote
      // preset: queued work must execute the plan accepted at enqueue time.
      return providers.execution.text({ ownerUserId }, {
        status: "resolved",
        requestedRole: "text",
        resolvedRole: "text",
        providerProfileId,
        providerType: routing.providerType as never,
        routingSource: routing.routingSource,
        model: routing.requestedModel,
        fallbackModels: routing.configuredModels.slice(1),
        preset: routing.presetSlug === null || routing.presetVersion === null || routing.presetConfigHash === null
          ? null
          : {
              slug: routing.presetSlug,
              designatedVersionId: "snapshotted",
              version: routing.presetVersion,
              configHash: routing.presetConfigHash
            },
        providerPolicy: routing.providerPolicy
      });
    },
    promptFromSnapshot: providers.promptTools.content,
    recordProfileCost: (_database, profile, attribution, result) => withTransaction(pool, (client) =>
      providers.costs.recordGenerationCost(providers.costContext(client), {
        ...attribution,
        providerProfileId: profile.id,
        providerType: profile.providerType,
        requestedModel: profile.model,
        resolvedModel: result.modelRouting?.resolvedModel || result.modelInstanceId || profile.model,
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
