import {
  createGenerationWorkerApplication,
  type GenerationClaimRepository,
  type GenerationExecutor,
  type GenerationWorkerApplication,
  type IllustrationApplication
} from "../../../packages/application/src/index.js";
import {
  createPostgresGenerationExecutionRepository,
  type GenerationExecutionRepository
} from "../../../packages/database/src/generation-execution-repository.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import {
  autoEnableCampaignEmbeddingIfAvailable,
  buildContextPreview,
  enqueueEmbeddingReindex,
  rebuildCampaignMemories,
  storeDerivedTurnMemories,
  type DerivedStoryMemory
} from "../../api/src/memory-service.js";
import { loadTextProvider } from "../../api/src/provider-service.js";
import {
  attributeGenerationCostsToTurn,
  recordProfileCost,
  turnReportedCosts
} from "../../api/src/cost-service.js";
import {
  promptFromSnapshot,
  promptProtocolVersion,
  resolvePromptSnapshot
} from "../../api/src/prompt-library-service.js";
import {
  createGenerationExecutor,
  type GenerationExecutionCollaborators,
  type GenerationExecutorDependencies
} from "./generation-executor-adapter.js";

type WorkerGenerationRepository = GenerationClaimRepository & GenerationExecutionRepository;

export type WorkerGenerationCompositionFactories = Readonly<{
  createRepository(pool: DatabasePool): WorkerGenerationRepository;
  createCollaborators(illustration: IllustrationApplication): GenerationExecutionCollaborators;
  createExecutor(dependencies: GenerationExecutorDependencies): GenerationExecutor;
  createApplication(dependencies: Readonly<{
    claims: GenerationClaimRepository;
    executor: GenerationExecutor;
  }>): GenerationWorkerApplication;
}>;

export function createGenerationExecutionCollaborators(
  illustration: IllustrationApplication,
): GenerationExecutionCollaborators {
  return {
    autoEnableCampaignEmbeddingIfAvailable,
    buildContextPreview: (
      pool,
      ownerUserId,
      campaignId,
      options,
      credentialSecret,
      costAttribution,
      scope
    ) => buildContextPreview(
      pool,
      campaignId,
      options,
      credentialSecret,
      costAttribution,
      scope,
      ownerUserId
    ),
    enqueueEmbeddingReindex: (database, ownerUserId, campaignId) =>
      enqueueEmbeddingReindex(database, campaignId, ownerUserId),
    rebuildCampaignMemories,
    storeDerivedTurnMemories: (
      client,
      ownerUserId,
      campaignId,
      worldVersionId,
      turnId,
      ordinal,
      derived
    ) => storeDerivedTurnMemories(
      client,
      ownerUserId,
      campaignId,
      worldVersionId,
      turnId,
      ordinal,
      derived as DerivedStoryMemory
    ),
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
  factories: WorkerGenerationCompositionFactories = productionFactories
): GenerationWorkerApplication {
  const repository = factories.createRepository(pool);
  const collaborators = factories.createCollaborators(illustration);
  const executor = factories.createExecutor({
    pool,
    repository,
    collaborators,
    credentialSecret
  });
  return factories.createApplication({ claims: repository, executor });
}
