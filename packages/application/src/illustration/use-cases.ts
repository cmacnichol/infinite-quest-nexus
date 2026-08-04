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
    orphanProvisionalSet: (scope) => dependencies.streaming.orphanProvisionalSet(scope)
  };
}

export function createIllustrationWorkerApplication(
  dependencies: IllustrationWorkerApplicationDependencies,
): IllustrationWorkerApplication {
  return {
    runNextIllustration: (request) => dependencies.executor.runNextIllustration(request),
    executeImage: (request) => dependencies.ports.imageProvider.executeImage(request),
    refinePrompt: (request) => dependencies.ports.promptRefinement.refinePrompt(request),
    downloadArtifact: (request) => dependencies.ports.artifactDownload.downloadArtifact(request),
    persistTurnIllustration: (input) => dependencies.ports.assets.persistTurnIllustration(input),
    persistWorldCover: (input) => dependencies.ports.assets.persistWorldCover(input),
    bindSegmentAsset: (input) => dependencies.ports.assets.bindSegmentAsset(input)
  };
}
