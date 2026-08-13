import type {
  IllustrationApplication,
  IllustrationApplicationDependencies,
  IllustrationWorkerApplication,
  IllustrationWorkerApplicationDependencies
} from "./ports.js";

export function createIllustrationApplication(
  dependencies: IllustrationApplicationDependencies,
): IllustrationApplication {
  return {
    getIllustrationConfig: (scope) => dependencies.config.getIllustrationConfig(scope),
    setIllustrationConfig: (scope, config) => dependencies.config.setIllustrationConfig(scope, config),
    enqueueWorldCover: (scope, request) => dependencies.jobs.enqueueWorldCover(scope, request),
    getLatestWorldCoverJob: (scope) => dependencies.jobs.getLatestWorldCoverJob(scope),
    enqueueAcceptedTurnIllustration: (scope, request) =>
      dependencies.jobs.enqueueAcceptedTurnIllustration(scope, request),
    enqueueIllustration: (scope, request) => dependencies.jobs.enqueueIllustration(scope, request),
    getImageJob: (scope) => dependencies.jobs.getImageJob(scope),
    listCampaignImageJobs: (scope) => dependencies.jobs.listCampaignImageJobs(scope),
    retryImageJob: (scope) => dependencies.jobs.retryImageJob(scope),
    generateTurnIllustrationSegments: (scope, request) =>
      dependencies.segments.generateTurnIllustrationSegments(scope, request),
    enqueueAcceptedTurnIllustrationSegments: (scope) =>
      dependencies.segments.enqueueAcceptedTurnIllustrationSegments(scope),
    previewIllustrationBackfill: (scope, request) =>
      dependencies.segments.previewIllustrationBackfill(scope, request),
    enqueueIllustrationBackfill: (scope, request) =>
      dependencies.segments.enqueueIllustrationBackfill(scope, request),
    listCampaignIllustrationSegments: (scope) =>
      dependencies.segments.listCampaignIllustrationSegments(scope),
    regenerateSegmentIllustration: (scope, request) =>
      dependencies.segments.regenerateSegmentIllustration(scope, request),
    removeSegmentIllustrationVariant: (scope, variantIndex) =>
      dependencies.segments.removeSegmentIllustrationVariant(scope, variantIndex),
    getTurnIllustrationResolution: (scope) =>
      dependencies.resolutions.getTurnIllustrationResolution(scope),
    rematchTurnIllustration: (scope) => dependencies.resolutions.rematchTurnIllustration(scope),
    loadStreamingIllustrationConfig: (scope) =>
      dependencies.streaming.loadStreamingIllustrationConfig(scope),
    createProvisionalSet: (scope, request) =>
      dependencies.streaming.createProvisionalSet(scope, request),
    createProvisionalSegment: (scope, request) =>
      dependencies.streaming.createProvisionalSegment(scope, request),
    promoteProvisionalSet: (scope, request) =>
      dependencies.streaming.promoteProvisionalSet(scope, request),
    orphanProvisionalSet: (scope) => dependencies.streaming.orphanProvisionalSet(scope),
    generation: {
      loadStreamingIllustrationConfig: (database, scope) =>
        dependencies.transaction.loadStreamingIllustrationConfig(database, scope),
      createProvisionalSet: (database, scope, request) =>
        dependencies.transaction.createProvisionalSet(database, scope, request),
      createProvisionalSegment: (database, scope, request) =>
        dependencies.transaction.createProvisionalSegment(database, scope, request),
      promoteProvisionalSet: (database, scope, request) =>
        dependencies.transaction.promoteProvisionalSet(database, scope, request),
      orphanProvisionalSet: (database, scope) => dependencies.transaction.orphanProvisionalSet(database, scope),
      enqueueAcceptedTurnIllustrationSegments: (database, scope) =>
        dependencies.transaction.enqueueAcceptedTurnIllustrationSegments(database, scope)
    }
  };
}

export function createIllustrationWorkerApplication(
  dependencies: IllustrationWorkerApplicationDependencies,
): IllustrationWorkerApplication {
  return {
    runNextIllustration: (request) => dependencies.executor.runNextIllustration(request),
    claimNextPromptJob: (request) => dependencies.state.claimNextPromptJob(request),
    claimNextResolutionJob: (request) => dependencies.state.claimNextResolutionJob(request),
    claimNextImageJob: (request) => dependencies.state.claimNextImageJob(request),
    loadClaimedJob: (scope) => dependencies.state.loadClaimedJob(scope),
    heartbeatClaim: (scope) => dependencies.state.heartbeatClaim(scope),
    transitionClaim: (scope, transition) => dependencies.state.transitionClaim(scope, transition),
    scheduleRetry: (scope, retry) => dependencies.state.scheduleRetry(scope, retry),
    resolvePrompt: (scope) => dependencies.state.resolvePrompt(scope),
    runPromptHandler: (request) => dependencies.state.runPromptHandler(request),
    runResolutionHandler: (request) => dependencies.state.runResolutionHandler(request),
    runImageHandler: (request) => dependencies.state.runImageHandler(request),
    executeImage: (request) => dependencies.ports.imageProvider.executeImage(request),
    refinePrompt: (request) => dependencies.ports.promptRefinement.refinePrompt(request),
    downloadArtifact: (request) => dependencies.ports.artifactDownload.downloadArtifact(request)
  };
}
