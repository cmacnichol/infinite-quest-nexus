import type {
  MemoryApplication,
  MemoryApplicationDependencies,
  MemoryWorkerApplication,
  MemoryWorkerApplicationDependencies
} from "./ports.js";

/** Platform-free delegation surface; concrete repositories arrive in 14b2. */
export function createMemoryApplication(
  dependencies: MemoryApplicationDependencies,
): MemoryApplication {
  return {
    getEmbeddingConfig: (scope) => dependencies.configuration.getEmbeddingConfig(scope),
    setEmbeddingConfig: (scope, input) => dependencies.configuration.setEmbeddingConfig(scope, input),
    getMetrics: (scope) => dependencies.queries.getMetrics(scope),
    previewContext: (scope, request) => dependencies.queries.previewContext(scope, request),
    enqueueChronicleReindex: (scope) => dependencies.jobs.enqueueChronicleReindex(scope),
    enqueueEmbeddingReindex: (scope) => dependencies.jobs.enqueueEmbeddingReindex(scope),
    getJob: (scope) => dependencies.jobs.getJob(scope),
    generation: {
      autoEnableCampaignEmbedding: (database, scope) =>
        dependencies.transaction.autoEnableCampaignEmbedding(database, scope),
      buildContextPreview: (database, scope) =>
        dependencies.transaction.buildContextPreview(database, scope),
      enqueueEmbeddingReindex: (database, scope) =>
        dependencies.transaction.enqueueEmbeddingReindex(database, scope),
      enqueueChunkIndex: (database, scope) =>
        dependencies.transaction.enqueueChunkIndex(database, scope),
      rebuildCampaignMemories: (database, scope) =>
        dependencies.transaction.rebuildCampaignMemories(database, scope),
      storeDerivedTurnMemories: (database, scope) =>
        dependencies.transaction.storeDerivedTurnMemories(database, scope),
      writeAcceptedTurnFiction: (database, scope) =>
        dependencies.transaction.writeAcceptedTurnFiction(database, scope)
    }
  };
}

export function createMemoryWorkerApplication(
  dependencies: MemoryWorkerApplicationDependencies,
): MemoryWorkerApplication {
  return {
    runNextChronicle: (request) => dependencies.executor.runNextChronicle(request),
    claimNext: (request) => dependencies.state.claimNext(request),
    loadClaimedJob: (scope) => dependencies.state.loadClaimedJob(scope),
    heartbeatClaim: (scope) => dependencies.state.heartbeatClaim(scope),
    completeClaim: (scope, completion) => dependencies.state.completeClaim(scope, completion),
    failClaim: (scope, failure) => dependencies.state.failClaim(scope, failure),
    requeueClaim: (scope, retry) => dependencies.state.requeueClaim(scope, retry),
    loadForClaim: (scope, request) => dependencies.retrieval.loadForClaim(scope, request),
    runClaimed: (claim) => dependencies.executor.runClaimed(claim)
  };
}
