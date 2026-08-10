import type { DatabaseClient, DatabasePool } from "../../packages/database/src/pool.js";
import type {
  IllustrationSegmentImageRequest,
  IllustrationSegmentRequest,
  WorldCoverRequest
} from "../../packages/contracts/src/generation.js";
import { apiProviderGraph } from "./provider-application-fixtures.js";
import { createIllustrationWorkerPorts } from "../../services/runtime/src/illustration-composition.js";
import { createPrivateIllustrationAssetPublicationComposition } from "../../services/runtime/src/illustration-asset-publication-composition.js";
import {
  enqueueAcceptedTurnIllustration as enqueueAcceptedTurnIllustrationRuntime,
  enqueueIllustration as enqueueIllustrationRuntime,
  enqueueWorldCover as enqueueWorldCoverRuntime,
  runImageJob as runImageJobRuntime
} from "../../services/runtime/src/illustration-image-job-adapter.js";
import { runIllustrationResolutionJob as runIllustrationResolutionJobRuntime } from "../../services/runtime/src/illustration-resolution-job-adapter.js";
import {
  createProvisionalSegment as createProvisionalSegmentRuntime,
  generateTurnIllustrationSegments as generateTurnIllustrationSegmentsRuntime,
  regenerateSegmentIllustration as regenerateSegmentIllustrationRuntime,
  runIllustrationPromptJob as runIllustrationPromptJobRuntime,
  type SegmentConfigRow
} from "../../services/runtime/src/illustration-segment-job-adapter.js";

const CREDENTIAL_SECRET = "synthetic-image-integration-secret";

function providers(pool: DatabasePool, secret = CREDENTIAL_SECRET) {
  return apiProviderGraph(pool, secret).illustration;
}

export async function runImageJob(
  pool: DatabasePool,
  workerId: string,
  leaseSeconds: number,
  credentialSecret: string,
  store: Readonly<{ root: string }>,
) {
  const collaborator = providers(pool, credentialSecret);
  const ports = createIllustrationWorkerPorts(pool, collaborator);
  const publication = await createPrivateIllustrationAssetPublicationComposition(
    pool,
    { archiveRoot: store.root, assetRoot: store.root },
    { downloadArtifact: (input) => ports.artifactDownload.downloadArtifact(input) },
  );
  try {
    return await runImageJobRuntime(
      pool,
      workerId,
      leaseSeconds,
      ports,
      publication.coordinator,
    );
  } finally {
    await publication.close();
  }
}

export async function runIllustrationPromptJob(
  pool: DatabasePool,
  workerId: string,
  leaseSeconds: number,
  credentialSecret: string,
) {
  const collaborator = providers(pool, credentialSecret);
  const ports = createIllustrationWorkerPorts(pool, collaborator);
  return runIllustrationPromptJobRuntime(
    pool, workerId, leaseSeconds, ports.promptRefinement, ports.costs, collaborator,
  );
}

export function runIllustrationResolutionJob(pool: DatabasePool, workerId: string, leaseSeconds: number) {
  return runIllustrationResolutionJobRuntime(pool, workerId, leaseSeconds, providers(pool));
}

export function enqueueWorldCover(pool: DatabasePool, worldId: string, request: WorldCoverRequest) {
  return enqueueWorldCoverRuntime(pool, worldId, request, providers(pool));
}

export function enqueueIllustration(
  pool: DatabasePool,
  turnId: string,
  request: Parameters<typeof enqueueIllustrationRuntime>[2],
) {
  return enqueueIllustrationRuntime(pool, turnId, request, providers(pool));
}

export function enqueueAcceptedTurnIllustration(
  client: DatabaseClient,
  ownerUserId: string,
  campaignId: string,
  turnId: string,
  imagePrompt: string,
) {
  return enqueueAcceptedTurnIllustrationRuntime(
    client, ownerUserId, campaignId, turnId, imagePrompt, providers(client as unknown as DatabasePool),
  );
}

export function createProvisionalSegment(
  pool: DatabasePool,
  ownerUserId: string,
  campaignId: string,
  generationJobId: string,
  setId: string,
  segment: Parameters<typeof createProvisionalSegmentRuntime>[5],
  config: SegmentConfigRow,
  visualReference?: string,
) {
  return createProvisionalSegmentRuntime(
    pool, ownerUserId, campaignId, generationJobId, setId, segment, config, providers(pool), visualReference,
  );
}

export function generateTurnIllustrationSegments(
  pool: DatabasePool,
  turnId: string,
  request: IllustrationSegmentRequest,
) {
  return generateTurnIllustrationSegmentsRuntime(pool, turnId, request, providers(pool));
}

export function regenerateSegmentIllustration(
  pool: DatabasePool,
  segmentId: string,
  request: IllustrationSegmentImageRequest,
) {
  return regenerateSegmentIllustrationRuntime(pool, segmentId, request, providers(pool));
}

export {
  getIllustrationConfig,
  getImageJob,
  getLatestWorldCoverJob,
  listCampaignImageJobs,
  retryImageJob,
  setIllustrationConfig
} from "../../services/runtime/src/illustration-image-job-adapter.js";

export {
  getTurnIllustrationResolution
} from "../../services/runtime/src/illustration-resolution-job-adapter.js";

export {
  createProvisionalSet,
  listCampaignIllustrationSegments,
  loadConfig,
  previewIllustrationBackfill
} from "../../services/runtime/src/illustration-segment-job-adapter.js";
