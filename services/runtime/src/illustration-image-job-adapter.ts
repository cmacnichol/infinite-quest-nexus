import {
  DEFAULT_ILLUSTRATION_REFINEMENT_PROMPT,
  type IllustrationConfig,
  type IllustrationRequest,
  type WorldCoverRequest
} from "../../../packages/contracts/src/generation.js";
import type {
  IllustrationImageExecutionResult,
  IllustrationImageProviderPort,
  IllustrationWorkerPorts
} from "../../../packages/application/src/index.js";
import type { PrivateIllustrationAssetPublicationCoordinator } from "../../../packages/application/src/illustration/private-illustration-asset-publication.js";
import { Agent } from "undici";
import type { DatabaseClient, DatabasePool } from "../../../packages/database/src/pool.js";
import { initialOwnerId, withTransaction } from "../../../packages/database/src/pool.js";
import { sha256 } from "../../../packages/domain/src/text.js";
import { characterVisualReference, composeIllustrationProviderPrompt } from "../../../packages/domain/src/index.js";
import { logger } from "../../../packages/logger/src/index.js";
import {
  createProviderNetworkPolicy,
  ProviderDestinationNotAllowedError,
  type ProviderNetworkResolver
} from "../../../packages/security/src/provider-network-policy.js";
import {
  containsMechanicsLanguage,
  logProviderTransportError,
  MAX_IMAGE_ARTIFACT_BYTES,
  type ImageProviderArtifact
} from "../../../packages/story-engine/src/index.js";
import { pinnedConnectOptions } from "../../../packages/story-engine/src/provider-transport.js";
import { loadOrNotFound } from "./database-result.js";
import type { IllustrationProviderCollaborators } from "./provider-application-composition.js";

type IllustrationConfigRow = {
  enabled: boolean;
  source_policy?: "off" | "library_only" | "library_then_generate" | "generate_only";
  matching_scope?: "campaign" | "world" | "owner_library" | "shared";
  confidence_profile?: "strict" | "balanced" | "broad";
  repetition_window?: number;
  provider_profile_id: string | null;
  model: string;
  size: string;
  aspect_ratio: string;
  quality: IllustrationConfig["quality"];
  output_format: IllustrationConfig["outputFormat"];
  max_attempts: number;
  segment_word_count?: number;
  images_per_segment?: number;
  segment_prompt_mode?: IllustrationConfig["segmentPromptMode"];
  refinement_prompt?: string;
  updated_at?: Date;
};

type ImageJobRow = {
  id: string;
  owner_user_id: string;
  campaign_id: string | null;
  turn_id: string | null;
  world_id: string | null;
  target_type: "turn_illustration" | "world_cover" | "streaming_illustration";
  segment_id: string | null;
  generation_job_id: string | null;
  image_count: 1 | 2;
  provider_profile_id: string;
  requested_model: string;
  prompt: string;
  status: "queued" | "generating" | "provider_pending" | "downloading" | "completed" | "recoverable" | "failed" | "cancelled" | "expired";
  attempts: number;
  max_attempts: number;
  size: string;
  aspect_ratio: string;
  quality: IllustrationConfig["quality"];
  output_format: IllustrationConfig["outputFormat"];
  asset_id: string | null;
  provider_type: string | null;
  generation_revision: number;
  remote_job_id: string | null;
  provider_status: string | null;
  provider_progress: string | null;
  provider_queue_position: number | null;
  provider_eta_at: Date | null;
  submitted_at: Date | null;
  last_polled_at: Date | null;
  next_poll_at: Date | null;
  generation_deadline: Date | null;
  provider_request_metadata: Record<string, unknown>;
  provider_result_metadata: Record<string, unknown>;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
};

function publicConfig(row?: IllustrationConfigRow) {
  const sourcePolicy = row?.source_policy ?? (row?.enabled ? "generate_only" : "off");
  return {
    enabled: sourcePolicy !== "off",
    sourcePolicy,
    matchingScope: row?.matching_scope ?? "world",
    confidenceProfile: row?.confidence_profile ?? "balanced",
    repetitionWindow: row?.repetition_window ?? 5,
    providerProfileId: row?.provider_profile_id ?? null,
    model: row?.model ?? "",
    size: row?.size ?? "1024x1024",
    aspectRatio: row?.aspect_ratio ?? "1:1",
    quality: row?.quality ?? "auto",
    outputFormat: row?.output_format ?? "png",
    maxAttempts: row?.max_attempts ?? 3,
    segmentWordCount: row?.segment_word_count ?? 500,
    imagesPerSegment: row?.images_per_segment ?? 1,
    segmentPromptMode: row?.segment_prompt_mode ?? "direct",
    refinementPrompt: row?.refinement_prompt?.trim() || DEFAULT_ILLUSTRATION_REFINEMENT_PROMPT,
    defaultRefinementPrompt: DEFAULT_ILLUSTRATION_REFINEMENT_PROMPT,
    updatedAt: row?.updated_at?.toISOString() ?? null
  };
}

function publicJob(row: ImageJobRow) {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    turnId: row.turn_id,
    worldId: row.world_id,
    targetType: row.target_type,
    segmentId: row.segment_id,
    generationJobId: row.generation_job_id,
    imageCount: row.image_count,
    providerProfileId: row.provider_profile_id,
    model: row.requested_model,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    size: row.size,
    aspectRatio: row.aspect_ratio,
    quality: row.quality,
    outputFormat: row.output_format,
    assetId: row.asset_id,
    assetUrl: row.asset_id ? `/api/v1/assets/${row.asset_id}` : "",
    providerType: row.provider_type,
    generationRevision: row.generation_revision,
    remoteJobId: row.remote_job_id,
    providerStatus: row.provider_status,
    providerProgress: row.provider_progress === null ? null : Number(row.provider_progress),
    providerQueuePosition: row.provider_queue_position,
    providerEtaAt: row.provider_eta_at,
    submittedAt: row.submitted_at,
    lastPolledAt: row.last_polled_at,
    nextPollAt: row.next_poll_at,
    generationDeadline: row.generation_deadline,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}

const jobColumns = `id, owner_user_id, campaign_id, turn_id, world_id, target_type, segment_id, image_count, provider_profile_id, requested_model,
  prompt, status, attempts, max_attempts, size, aspect_ratio, quality, output_format, asset_id,
  provider_type, generation_revision, remote_job_id, provider_status, provider_progress, provider_queue_position, provider_eta_at, submitted_at, last_polled_at,
  next_poll_at, generation_deadline, provider_request_metadata, provider_result_metadata,
  error_code, error_message, created_at, updated_at, completed_at, generation_job_id`;

export async function getIllustrationConfig(pool: DatabasePool, campaignId: string) {
  const ownerUserId = await initialOwnerId(pool);
  const campaign = await pool.query("SELECT id FROM campaigns WHERE id = $1 AND owner_user_id = $2", [campaignId, ownerUserId]);
  loadOrNotFound(campaign, "Campaign");
  const result = await pool.query<IllustrationConfigRow>(
    `SELECT enabled, source_policy, matching_scope, confidence_profile, repetition_window,
            provider_profile_id, model, size, aspect_ratio, quality, output_format, max_attempts,
            segment_word_count, images_per_segment, segment_prompt_mode, refinement_prompt, updated_at
       FROM campaign_illustration_configs WHERE campaign_id = $1 AND owner_user_id = $2`,
    [campaignId, ownerUserId]
  );
  return publicConfig(result.rows[0]);
}

export async function setIllustrationConfig(pool: DatabasePool, campaignId: string, config: IllustrationConfig) {
  const ownerUserId = await initialOwnerId(pool);
  const sourcePolicy = config.sourcePolicy ?? (config.enabled ? "generate_only" : "off");
  if (config.matchingScope === "shared") {
    throw Object.assign(new Error("Shared-library matching is unavailable until authentication and grants are implemented."), { statusCode: 409 });
  }
  const needsProvider = sourcePolicy === "library_then_generate" || sourcePolicy === "generate_only";
  if (needsProvider && !config.providerProfileId) {
    throw Object.assign(new Error("Add and enable an image provider before enabling illustrations."), { statusCode: 409 });
  }
  if (needsProvider && !config.model.trim()) {
    throw Object.assign(new Error("Select an image model before enabling illustrations."), { statusCode: 400 });
  }
  if (config.providerProfileId) {
    const provider = await pool.query(
      `SELECT id FROM provider_profiles
        WHERE id = $1 AND owner_user_id = $2 AND provider_role = 'image' AND enabled = true`,
      [config.providerProfileId, ownerUserId]
    );
    if (!provider.rows[0]) throw Object.assign(new Error("The selected image provider does not exist or is disabled."), { statusCode: 409 });
  }
  const result = await pool.query<IllustrationConfigRow>(
    `INSERT INTO campaign_illustration_configs (
       campaign_id, owner_user_id, enabled, source_policy, matching_scope, confidence_profile, repetition_window,
       provider_profile_id, model, size, aspect_ratio, quality, output_format, max_attempts,
       segment_word_count, images_per_segment, segment_prompt_mode, refinement_prompt
     ) SELECT c.id, c.owner_user_id, $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
         FROM campaigns c WHERE c.id = $1 AND c.owner_user_id = $2
     ON CONFLICT (campaign_id) DO UPDATE SET enabled = EXCLUDED.enabled,
       source_policy = EXCLUDED.source_policy, matching_scope = EXCLUDED.matching_scope,
       confidence_profile = EXCLUDED.confidence_profile, repetition_window = EXCLUDED.repetition_window,
       provider_profile_id = EXCLUDED.provider_profile_id, model = EXCLUDED.model, size = EXCLUDED.size,
       aspect_ratio = EXCLUDED.aspect_ratio, quality = EXCLUDED.quality, output_format = EXCLUDED.output_format,
       max_attempts = EXCLUDED.max_attempts, segment_word_count = EXCLUDED.segment_word_count,
       images_per_segment = EXCLUDED.images_per_segment, segment_prompt_mode = EXCLUDED.segment_prompt_mode,
       refinement_prompt = EXCLUDED.refinement_prompt,
       updated_at = now()
     RETURNING enabled, source_policy, matching_scope, confidence_profile, repetition_window,
               provider_profile_id, model, size, aspect_ratio, quality, output_format, max_attempts,
               segment_word_count, images_per_segment, segment_prompt_mode, refinement_prompt, updated_at`,
    [campaignId, ownerUserId, sourcePolicy !== "off", sourcePolicy, config.matchingScope,
      config.confidenceProfile, config.repetitionWindow, config.providerProfileId, config.model, config.size,
      config.aspectRatio, config.quality, config.outputFormat, config.maxAttempts,
      config.segmentWordCount, config.imagesPerSegment, config.segmentPromptMode, config.refinementPrompt]
  );
  return publicConfig(loadOrNotFound(result, "Campaign"));
}

export async function insertImageJob(
  client: DatabaseClient | DatabasePool,
  values: {
    ownerUserId: string;
    campaignId?: string | null;
    turnId?: string | null;
    worldId?: string | null;
    targetType?: ImageJobRow["target_type"];
    segmentId?: string | null;
    generationJobId?: string | null;
    targetVariantIndex?: number | null;
    prompt: string;
    config: ReturnType<typeof publicConfig>;
  }
) {
  const prompt = values.prompt.trim();
  if (!prompt || containsMechanicsLanguage(prompt)) return null;
  const jobId = crypto.randomUUID();
  const result = await client.query<ImageJobRow>(
    `INSERT INTO image_jobs (
       id, owner_user_id, campaign_id, turn_id, world_id, target_type, segment_id, image_count,
       provider_profile_id, requested_model, prompt, prompt_hash,
       size, aspect_ratio, quality, output_format, max_attempts, provider_type, provider_request_metadata,
       generation_job_id
     ) SELECT $1::uuid,$2,$3,$4,$5,$6,$7::uuid,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, provider_type,
              jsonb_build_object(
                'idempotencyKey', ($1::uuid)::text || ':0',
                'requestedModel', $10::text,
                'targetType', $6::text,
                'segmentId', ($7::uuid)::text,
                'targetVariantIndex', $18::integer
              ),
              $19::uuid
         FROM provider_profiles WHERE id = $9 AND owner_user_id = $2
     RETURNING ${jobColumns}`,
    [jobId, values.ownerUserId, values.campaignId ?? null, values.turnId ?? null, values.worldId ?? null,
      values.targetType ?? "turn_illustration", values.segmentId ?? null, values.config.imagesPerSegment,
      values.config.providerProfileId, values.config.model, prompt, sha256(prompt), values.config.size,
      values.config.aspectRatio, values.config.quality, values.config.outputFormat, values.config.maxAttempts,
      values.targetVariantIndex ?? null, values.generationJobId ?? null]
  );
  return result.rows[0] || null;
}

export async function enqueueWorldCover(
  pool: DatabasePool,
  worldId: string,
  request: WorldCoverRequest,
  providers: IllustrationProviderCollaborators,
) {
  const ownerUserId = await initialOwnerId(pool);
  return withTransaction(pool, async (client) => {
    const worldResult = await client.query<{ title: string; status: string; content: Record<string, any> }>(
      `SELECT worlds.title, worlds.status, drafts.content
         FROM worlds JOIN world_drafts drafts
           ON drafts.world_id = worlds.id AND drafts.owner_user_id = worlds.owner_user_id
        WHERE worlds.id = $1 AND worlds.owner_user_id = $2 FOR UPDATE OF worlds, drafts`,
      [worldId, ownerUserId]
    );
    const world = loadOrNotFound(worldResult, "World");
    if (world.status === "archived") throw Object.assign(new Error("Restore the world before generating its cover."), { statusCode: 409 });
    const existing = await client.query<ImageJobRow>(
      `SELECT ${jobColumns} FROM image_jobs
        WHERE world_id = $1 AND owner_user_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [worldId, ownerUserId]
    );
    if (existing.rows[0] && (["queued", "generating", "provider_pending", "downloading"].includes(existing.rows[0].status)
      || (existing.rows[0].status === "completed" && !request.replace))) {
      return { ...publicJob(existing.rows[0]), duplicate: true };
    }
    const resolution = await providers.resolution.resolveDirect({ ownerUserId, providerRole: "image" });
    if (resolution.status !== "resolved") throw Object.assign(new Error("Configure a default image provider before generating a world cover."), { statusCode: 409 });
    const providerProfileId = resolution.providerProfileId;
    const model = resolution.model;
    const overview = world.content?.world || {};
    const prompt = request.prompt || [
      `Create a polished vertical fantasy book cover for the story world “${world.title}”.`,
      overview.genre ? `Genre: ${String(overview.genre).slice(0, 500)}.` : "",
      overview.tone ? `Tone: ${String(overview.tone).slice(0, 500)}.` : "",
      overview.premise ? `Premise: ${String(overview.premise).slice(0, 2000)}.` : "",
      "Show only evocative diegetic scenery and characters. Avoid non-diegetic content, typography, logos, and interface elements."
    ].filter(Boolean).join("\n");
    const job = await insertImageJob(client, {
      ownerUserId,
      worldId,
      targetType: "world_cover",
      prompt,
      config: publicConfig({
        enabled: true,
        provider_profile_id: providerProfileId,
        model,
        size: request.size,
        aspect_ratio: request.aspectRatio,
        quality: request.quality,
        output_format: request.outputFormat,
        max_attempts: 3
      })
    });
    if (!job) throw Object.assign(new Error("The world cover prompt failed the fiction-only boundary."), { statusCode: 409 });
    return { ...publicJob(job), duplicate: false };
  });
}

export async function enqueueAcceptedTurnIllustration(
  client: DatabaseClient,
  ownerUserId: string,
  campaignId: string,
  turnId: string,
  imagePrompt: string,
  providers: IllustrationProviderCollaborators,
): Promise<string | null> {
  const configResult = await client.query<IllustrationConfigRow & { campaign_provider_profile_id: string | null }>(
    `SELECT c.enabled, c.source_policy, c.matching_scope, c.confidence_profile, c.repetition_window,
            c.provider_profile_id, c.model, c.size, c.aspect_ratio, c.quality, c.output_format, c.max_attempts,
            campaign.image_provider_profile_id AS campaign_provider_profile_id
       FROM campaign_illustration_configs c
       JOIN campaigns campaign ON campaign.id = c.campaign_id AND campaign.owner_user_id = c.owner_user_id
      WHERE c.campaign_id = $1 AND c.owner_user_id = $2 AND c.source_policy <> 'off'`,
    [campaignId, ownerUserId]
  );
  const row = configResult.rows[0];
  if (!row) return null;
  if (!imagePrompt.trim() || containsMechanicsLanguage(imagePrompt)) return null;
  if (row.source_policy === "library_only" || row.source_policy === "library_then_generate") {
    const resolution = await client.query<{ id: string }>(
      `INSERT INTO illustration_resolution_jobs (
         owner_user_id, campaign_id, turn_id, source_policy, matching_scope, confidence_profile,
         repetition_window, query_context_snapshot
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (turn_id) WHERE segment_id IS NULL DO NOTHING RETURNING id`,
      [ownerUserId, campaignId, turnId, row.source_policy, row.matching_scope || "world",
        row.confidence_profile || "balanced", row.repetition_window ?? 5, JSON.stringify({ imagePrompt: imagePrompt.trim() })]
    );
    return resolution.rows[0]?.id || null;
  }
  const resolution = await providers.resolution.resolveDirect({
    ownerUserId,
    providerRole: "image",
    ...(row.campaign_provider_profile_id ? { selectedProviderProfileId: row.campaign_provider_profile_id } : {})
  });
  if (resolution.status !== "resolved") return null;
  row.provider_profile_id = resolution.providerProfileId;
  row.model = resolution.model;
  const job = await insertImageJob(client, { ownerUserId, campaignId, turnId, prompt: imagePrompt, config: publicConfig(row) });
  return job?.id || null;
}

export async function enqueueIllustration(
  pool: DatabasePool,
  turnId: string,
  request: IllustrationRequest,
  providers: IllustrationProviderCollaborators,
) {
  const ownerUserId = await initialOwnerId(pool);
  return withTransaction(pool, async (client) => {
    const turnResult = await client.query<{
      campaign_id: string;
      image_prompt: string;
      character_profile: Record<string, unknown> | null;
      character_snapshot: Record<string, unknown> | null;
    }>(
      `SELECT turns.campaign_id, turns.image_prompt, campaigns.character_profile, campaigns.character_snapshot
         FROM turns JOIN campaigns
           ON campaigns.id = turns.campaign_id AND campaigns.owner_user_id = turns.owner_user_id
        WHERE turns.id = $1 AND turns.owner_user_id = $2 FOR UPDATE OF turns`,
      [turnId, ownerUserId]
    );
    const turn = loadOrNotFound(turnResult, "Accepted turn");
    const existing = await client.query<ImageJobRow>(
      `SELECT ${jobColumns} FROM image_jobs WHERE turn_id = $1 AND owner_user_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [turnId, ownerUserId]
    );
    if (existing.rows[0] && (!request.replace || ["queued", "generating", "provider_pending", "downloading"].includes(existing.rows[0].status))) {
      return { ...publicJob(existing.rows[0]), duplicate: true };
    }
    const configResult = await client.query<IllustrationConfigRow & { campaign_provider_profile_id: string | null }>(
      `SELECT config.enabled, config.provider_profile_id, config.model, config.size, config.aspect_ratio, config.quality,
              config.output_format, config.max_attempts, campaign.image_provider_profile_id AS campaign_provider_profile_id
         FROM campaign_illustration_configs config
         JOIN campaigns campaign ON campaign.id = config.campaign_id AND campaign.owner_user_id = config.owner_user_id
        WHERE config.campaign_id = $1 AND config.owner_user_id = $2`,
      [turn.campaign_id, ownerUserId]
    );
    const config = publicConfig(configResult.rows[0]);
    const selectedProviderProfileId = request.providerProfileId || configResult.rows[0]?.campaign_provider_profile_id;
    const resolution = await providers.resolution.resolveDirect({
      ownerUserId,
      providerRole: "image",
      ...(selectedProviderProfileId ? { selectedProviderProfileId } : {}),
      ...(request.model ? { model: request.model } : {})
    });
    config.providerProfileId = resolution.status === "resolved" ? resolution.providerProfileId : "";
    config.model = resolution.status === "resolved" ? resolution.model : "";
    if (!config.providerProfileId || !config.model) throw Object.assign(new Error("Configure an image provider and model before requesting an illustration."), { statusCode: 409 });
    const provider = await client.query(
      `SELECT id FROM provider_profiles WHERE id = $1 AND owner_user_id = $2 AND provider_role = 'image' AND enabled = true`,
      [config.providerProfileId, ownerUserId]
    );
    if (!provider.rows[0]) throw Object.assign(new Error("Enabled image provider profile not found."), { statusCode: 400 });
    const promptSnapshot = await providers.prompts.loadIllustrationPromptSnapshot({
      ownerUserId,
      campaignId: turn.campaign_id
    });
    const prompt = composeIllustrationProviderPrompt(
      request.prompt || turn.image_prompt,
      characterVisualReference(turn.character_profile, turn.character_snapshot),
      providers.promptTools.content(promptSnapshot.snapshot, "illustration_character_reference")
    );
    const job = await insertImageJob(client, { ownerUserId, campaignId: turn.campaign_id, turnId, prompt, config });
    if (!job) throw Object.assign(new Error("The accepted turn does not contain a safe fiction-only image prompt."), { statusCode: 409 });
    return { ...publicJob(job), duplicate: false };
  });
}

export async function getImageJob(pool: DatabasePool, jobId: string) {
  const ownerUserId = await initialOwnerId(pool);
  const result = await pool.query<ImageJobRow>(`SELECT ${jobColumns} FROM image_jobs WHERE id = $1 AND owner_user_id = $2`, [jobId, ownerUserId]);
  return publicJob(loadOrNotFound(result, "Image job"));
}

export async function getLatestWorldCoverJob(pool: DatabasePool, worldId: string) {
  const ownerUserId = await initialOwnerId(pool);
  const world = await pool.query("SELECT id FROM worlds WHERE id = $1 AND owner_user_id = $2", [worldId, ownerUserId]);
  loadOrNotFound(world, "World");
  const result = await pool.query<ImageJobRow>(
    `SELECT ${jobColumns} FROM image_jobs
      WHERE world_id = $1 AND owner_user_id = $2 AND target_type = 'world_cover'
      ORDER BY created_at DESC LIMIT 1`,
    [worldId, ownerUserId]
  );
  return result.rows[0] ? publicJob(result.rows[0]) : null;
}

export async function listCampaignImageJobs(pool: DatabasePool, campaignId: string) {
  const ownerUserId = await initialOwnerId(pool);
  const campaign = await pool.query(
    "SELECT id FROM campaigns WHERE id = $1 AND owner_user_id = $2",
    [campaignId, ownerUserId]
  );
  loadOrNotFound(campaign, "Campaign");
  const result = await pool.query<ImageJobRow>(
    `SELECT ${jobColumns} FROM image_jobs WHERE campaign_id = $1 AND owner_user_id = $2 ORDER BY created_at DESC LIMIT 100`,
    [campaignId, ownerUserId]
  );
  return result.rows.map(publicJob);
}

export async function retryImageJob(pool: DatabasePool, jobId: string) {
  const ownerUserId = await initialOwnerId(pool);
  const existing = await pool.query(
    "SELECT id FROM image_jobs WHERE id = $1 AND owner_user_id = $2",
    [jobId, ownerUserId]
  );
  loadOrNotFound(existing, "Image job");
  const result = await pool.query<ImageJobRow>(
    `UPDATE image_jobs SET status = 'queued', attempts = 0, next_attempt_at = now(), lease_owner = NULL,
       lease_expires_at = NULL, generation_revision = generation_revision + 1,
       remote_job_id = NULL, provider_status = NULL, provider_progress = NULL,
       submitted_at = NULL, last_polled_at = NULL, next_poll_at = NULL, generation_deadline = NULL,
       provider_result_metadata = '{}'::jsonb, response_metadata = '{}'::jsonb,
       provider_request_metadata = jsonb_build_object(
         'idempotencyKey', id::text || ':' || (generation_revision + 1)::text,
         'requestedModel', requested_model,
         'targetType', target_type,
         'segmentId', segment_id,
         'targetVariantIndex', provider_request_metadata->'targetVariantIndex'
       ),
       error_code = NULL, error_message = NULL, completed_at = NULL, updated_at = now()
      WHERE id = $1 AND owner_user_id = $2 AND status IN ('recoverable', 'failed', 'expired', 'cancelled')
      RETURNING ${jobColumns}`,
    [jobId, ownerUserId]
  );
  if (!result.rows[0]) throw Object.assign(new Error("Only terminal unsuccessful image jobs can be retried."), { statusCode: 409 });
  if (result.rows[0].segment_id) {
    await pool.query(
      `UPDATE turn_illustration_segments SET status = 'generating', updated_at = now()
        WHERE id = $1 AND owner_user_id = $2`,
      [result.rows[0].segment_id, ownerUserId]
    );
  }
  await pool.query(
    `UPDATE illustration_resolution_jobs
        SET status = 'generation_queued', reason_code = 'generation_retried', completed_at = NULL, updated_at = now()
      WHERE image_job_id = $1 AND owner_user_id = $2`,
    [jobId, ownerUserId]
  );
  return publicJob(result.rows[0]);
}

async function claimImageJob(pool: DatabasePool, workerId: string, leaseSeconds: number): Promise<ImageJobRow | null> {
  return withTransaction(pool, async (client) => {
    const result = await client.query<ImageJobRow>(
      `WITH candidate AS (
         SELECT id FROM image_jobs
          WHERE (status = 'queued' AND next_attempt_at <= now())
             OR (status = 'provider_pending' AND next_poll_at <= now())
             OR (status IN ('generating', 'downloading') AND lease_expires_at < now())
          ORDER BY COALESCE(next_poll_at, next_attempt_at), created_at FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE image_jobs j SET status = 'generating', attempts = attempts + CASE WHEN remote_job_id IS NULL THEN 1 ELSE 0 END, lease_owner = $1,
         lease_expires_at = now() + ($2::text || ' seconds')::interval, updated_at = now()
       FROM candidate WHERE j.id = candidate.id RETURNING j.*`,
      [workerId, leaseSeconds]
    );
    return result.rows[0] || null;
  });
}

const MAX_ARTIFACT_BYTES = MAX_IMAGE_ARTIFACT_BYTES;
const MAX_ARTIFACT_REDIRECTS = 5;

export type ArtifactDownloadDependencies = {
  fetcher?: typeof fetch;
  resolve?: ProviderNetworkResolver;
};

function pendingProviderStatus(metadata: Record<string, unknown>): string {
  const status = String(metadata.status || "pending").trim().toLowerCase();
  return status.slice(0, 100) || "pending";
}

function artifactMimeType(bytes: Buffer, declared?: string): "image/png" | "image/jpeg" | "image/webp" {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  throw Object.assign(new Error(`Provider artifact was not a supported image${declared ? ` (${declared})` : ""}.`), { code: "invalid_image_artifact", permanent: true });
}

function privateArtifactHostError(): Error {
  return Object.assign(new Error("Provider artifact URL resolved to a private or local host."), {
    code: "private_artifact_host",
    permanent: true
  });
}

function artifactRedirectTarget(location: string, currentUrl: URL): URL {
  try {
    return new URL(location, currentUrl);
  } catch {
    throw Object.assign(new Error("Provider artifact redirect returned an invalid URL."), {
      code: "invalid_artifact_url",
      permanent: true
    });
  }
}

export async function downloadArtifact(
  artifact: ImageProviderArtifact,
  timeoutMs: number,
  allowPrivateHosts = false,
  dependencies: ArtifactDownloadDependencies = {}
): Promise<{ bytes: Buffer; mimeType: "image/png" | "image/jpeg" | "image/webp" }> {
  if (artifact.source === "base64") {
    const normalized = artifact.base64.replace(/\s+/g, "");
    if (!/^[a-z0-9+/]+={0,2}$/i.test(normalized)) throw Object.assign(new Error("Image provider returned invalid base64 data."), { code: "invalid_image_artifact", permanent: true });
    const bytes = Buffer.from(normalized, "base64");
    if (bytes.length > MAX_ARTIFACT_BYTES) throw Object.assign(new Error("Generated image exceeded the 20 MB provider artifact limit."), { code: "image_too_large", permanent: true });
    return { bytes, mimeType: artifactMimeType(bytes, artifact.mimeType) };
  }
  const fetcher = dependencies.fetcher ?? fetch;
  const policy = allowPrivateHosts
    ? null
    : createProviderNetworkPolicy(dependencies.resolve
      ? { allowlist: [], resolver: dependencies.resolve }
      : { allowlist: [] });
  const signal = AbortSignal.timeout(timeoutMs);
  let url = new URL(artifact.url);
  let redirects = 0;

  while (true) {
    if (!(["https:", "http:"] as string[]).includes(url.protocol)) {
      throw Object.assign(new Error("Provider artifact URL used an unsupported protocol."), { code: "invalid_artifact_url", permanent: true });
    }
    let dispatcher: Agent | undefined;
    try {
      let requestUrl = url.toString();
      if (policy) {
        try {
          const destination = await policy.approve(url, "image artifact download");
          requestUrl = destination.url.toString();
          dispatcher = new Agent({ connect: pinnedConnectOptions(destination) });
        } catch (error) {
          if (error instanceof ProviderDestinationNotAllowedError) throw privateArtifactHostError();
          throw error;
        }
      }
      const response = await fetcher(requestUrl, {
        signal,
        redirect: "manual",
        ...(dispatcher ? { dispatcher } : {})
      } as RequestInit);
      if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.has("location")) {
        if (redirects >= MAX_ARTIFACT_REDIRECTS) {
          await response.body?.cancel();
          throw Object.assign(new Error(`Provider artifact exceeded the ${MAX_ARTIFACT_REDIRECTS}-redirect limit.`), {
            code: "artifact_redirect_limit",
            permanent: true
          });
        }
        url = artifactRedirectTarget(response.headers.get("location")!, url);
        redirects += 1;
        await response.body?.cancel();
        continue;
      }
      if (!response.ok) throw Object.assign(new Error(`Provider artifact download failed (${response.status}).`), { code: "artifact_download_failed" });
      const declaredLength = Number(response.headers.get("content-length") || 0);
      if (declaredLength > MAX_ARTIFACT_BYTES) throw Object.assign(new Error("Generated image exceeded the 20 MB provider artifact limit."), { code: "image_too_large", permanent: true });
      if (!response.body) throw Object.assign(new Error("Provider artifact download returned an empty body."), { code: "artifact_download_failed" });
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of response.body) {
        const bytes = Buffer.from(chunk);
        length += bytes.length;
        if (length > MAX_ARTIFACT_BYTES) throw Object.assign(new Error("Generated image exceeded the 20 MB provider artifact limit."), { code: "image_too_large", permanent: true });
        chunks.push(bytes);
      }
      const bytes = Buffer.concat(chunks);
      return { bytes, mimeType: artifactMimeType(bytes, artifact.mimeType || response.headers.get("content-type") || undefined) };
    } finally {
      await dispatcher?.close();
    }
  }
}

async function requeueRemoteImageJob(
  pool: DatabasePool,
  job: ImageJobRow,
  workerId: string,
  code: string,
  message: string
): Promise<void> {
  const retryDelayMs = Math.min(Math.max(job.attempts, 1), 5) * 15_000;
  await pool.query(
    `UPDATE image_jobs SET status = 'queued', attempts = attempts,
       generation_revision = generation_revision + 1,
       remote_job_id = NULL, provider_status = 'retrying', provider_progress = NULL,
       provider_queue_position = NULL, provider_eta_at = NULL, submitted_at = NULL,
       last_polled_at = NULL, next_poll_at = NULL, generation_deadline = NULL,
       next_attempt_at = now() + ($6::text || ' milliseconds')::interval,
       provider_result_metadata = '{}'::jsonb,
       provider_request_metadata = jsonb_build_object(
         'idempotencyKey', id::text || ':' || (generation_revision + 1)::text,
         'requestedModel', requested_model,
         'targetType', target_type,
         'segmentId', segment_id,
         'targetVariantIndex', provider_request_metadata->'targetVariantIndex'
       ),
       error_code = $3, error_message = $4,
       lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $5
       AND status IN ('generating','provider_pending','downloading')`,
    [job.id, job.owner_user_id, code, message.slice(0, 4000), workerId, retryDelayMs]
  );
  logger.warn({
    event: "image_provider_remote_retry", imageJobId: job.id, providerType: job.provider_type,
    remoteJobId: job.remote_job_id, errorCode: code, nextGenerationRevision: job.generation_revision + 1
  });
}

export function imageProviderFailureMetadata(error: unknown): {
  permanent: boolean;
  code: string;
  expired: boolean;
  remoteTerminal: boolean;
} {
  return {
    permanent: typeof error === "object" && error !== null && "permanent" in error && Boolean((error as { permanent: unknown }).permanent),
    code: typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "image_generation_failed",
    expired: typeof error === "object" && error !== null && "expired" in error && Boolean((error as { expired: unknown }).expired),
    remoteTerminal: typeof error === "object" && error !== null && "remoteTerminal" in error && Boolean((error as { remoteTerminal: unknown }).remoteTerminal)
  };
}

export async function runImageJob(
  pool: DatabasePool,
  workerId: string,
  leaseSeconds: number,
  ports: IllustrationWorkerPorts,
  publication: PrivateIllustrationAssetPublicationCoordinator,
): Promise<boolean> {
  return runImageJobThroughPorts(pool, workerId, leaseSeconds, ports, publication);
}

/** Executes the image lane only through the injected illustration/provider ports. */
async function runImageJobThroughPorts(
  pool: DatabasePool,
  workerId: string,
  leaseSeconds: number,
  ports: IllustrationWorkerPorts,
  publication: PrivateIllustrationAssetPublicationCoordinator,
): Promise<boolean> {
  const job = await claimImageJob(pool, workerId, leaseSeconds);
  if (!job) return false;
  try {
    if (containsMechanicsLanguage(job.prompt)) {
      throw Object.assign(new Error("Illustration prompt failed the fiction-only boundary."), {
        code: "unsafe_prompt",
        permanent: true
      });
    }
    const persistedSogniTerminalError = job.remote_job_id && job.provider_type === "sogni_sdk"
      && ["5001", "5002", "5003", "5005"].includes(job.error_code || "");
    if (persistedSogniTerminalError && job.attempts < job.max_attempts) {
      await requeueRemoteImageJob(pool, job, workerId, job.error_code!, job.error_message || "Sogni remote generation failed.");
      return true;
    }
    if (job.remote_job_id && job.generation_deadline && job.generation_deadline.getTime() <= Date.now()) {
      throw Object.assign(new Error("The provider generation deadline expired before completion."), {
        code: "image_generation_expired",
        expired: true,
        permanent: true
      });
    }
    const result = await ports.imageProvider.executeImage({
      ownerUserId: job.owner_user_id,
      jobId: job.id,
      providerProfileId: job.provider_profile_id,
      model: job.requested_model,
      prompt: job.prompt,
      generationRevision: job.generation_revision,
      idempotencyKey: `${job.id}:${job.generation_revision}`,
      imageCount: job.image_count,
      size: job.size,
      aspectRatio: job.aspect_ratio,
      quality: job.quality,
      outputFormat: job.output_format,
      remoteJobId: job.remote_job_id
    });
    if (result.status === "pending") {
      await persistPendingPortImageJob(pool, job, workerId, result);
      return true;
    }
    const completion = await publication.completeClaimedImageJob({
      imageJobId: job.id,
      workerId,
      result
    });
    if (completion.outcome === "committed_finalization_pending") {
      logger.warn({
        event: "image_asset_publication_finalization_pending",
        imageJobId: job.id,
        workerId,
        diagnostic: completion.diagnostic
      }, "illustration image publication committed; finalization recovery is pending");
    }
  } catch (error) {
    logProviderTransportError(error, {
      imageJobId: job.id,
      campaignId: job.campaign_id,
      turnId: job.turn_id,
      providerProfileId: job.provider_profile_id,
      workerId
    });
    const { permanent, code, expired, remoteTerminal } = imageProviderFailureMetadata(error);
    const retryableSubmission = !job.remote_job_id && !permanent && job.attempts < job.max_attempts;
    const retryableRemoteFailure = Boolean(job.remote_job_id) && remoteTerminal && !permanent && job.attempts < job.max_attempts;
    const retryablePoll = Boolean(job.remote_job_id) && !remoteTerminal && !permanent
      && (!job.generation_deadline || job.generation_deadline.getTime() > Date.now());
    if (retryableRemoteFailure) {
      await requeueRemoteImageJob(pool, job, workerId, code, error instanceof Error ? error.message : String(error));
      return true;
    }
    const nextStatus = expired ? "expired" : retryablePoll ? "provider_pending" : retryableSubmission ? "queued" : permanent ? "failed" : "recoverable";
    const requestedRetryDelay = typeof error === "object" && error !== null && "retryAfterMs" in error
      ? Number((error as { retryAfterMs: unknown }).retryAfterMs)
      : Number.NaN;
    const fallbackRetryDelay = retryablePoll
      ? Math.min(Math.max(job.attempts, 1), 5) * 2_000
      : Math.min(Math.max(job.attempts, 1), 5) * 15_000;
    const retryDelayMs = Number.isFinite(requestedRetryDelay)
      ? Math.min(300_000, Math.max(1_000, Math.round(requestedRetryDelay)))
      : fallbackRetryDelay;
    const persistedFailure = await pool.query<{ id: string }>(
      `UPDATE image_jobs SET status = $3, next_attempt_at = CASE WHEN $3 = 'queued'
           THEN now() + ($7::text || ' milliseconds')::interval ELSE next_attempt_at END,
         next_poll_at = CASE WHEN $3 = 'provider_pending'
           THEN now() + ($7::text || ' milliseconds')::interval ELSE next_poll_at END,
         error_code = $4, error_message = $5, lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $6
         AND status IN ('generating','provider_pending','downloading')
       RETURNING id`,
      [job.id, job.owner_user_id, nextStatus, code,
        (error instanceof Error ? error.message : String(error)).slice(0, 4000), workerId, retryDelayMs]
    );
    if (!persistedFailure.rows[0]) return true;
    if (job.segment_id && ["recoverable", "failed", "expired"].includes(nextStatus)) {
      await pool.query(
        `UPDATE turn_illustration_segments
            SET status = $3, updated_at = now()
          WHERE id = $1 AND owner_user_id = $2`,
        [job.segment_id, job.owner_user_id, nextStatus === "recoverable" ? "recoverable" : "failed"]
      );
    }
    if (["failed", "expired"].includes(nextStatus)) {
      await pool.query(
        `UPDATE illustration_resolution_jobs
            SET status = 'failed', reason_code = $3, completed_at = now(), updated_at = now()
          WHERE image_job_id = $1 AND owner_user_id = $2 AND status = 'generation_queued'`,
        [job.id, job.owner_user_id, `generation_${code}`.slice(0, 200)]
      );
    }
  }
  return true;
}

function portPollAfterMs(result: Extract<IllustrationImageExecutionResult, { status: "pending" }>): number {
  return Math.min(30_000, Math.max(1_000, result.pollAfterMs || 2_000));
}

async function persistPendingPortImageJob(
  pool: DatabasePool,
  job: ImageJobRow,
  workerId: string,
  result: Extract<IllustrationImageExecutionResult, { status: "pending" }>,
): Promise<void> {
  const pollAfterMs = portPollAfterMs(result);
  const persisted = await pool.query<{ id: string }>(
    `UPDATE image_jobs SET status = 'provider_pending', remote_job_id = COALESCE(remote_job_id, $3), provider_status = $4,
       provider_progress = $5, provider_queue_position = $6,
       provider_eta_at = CASE WHEN $7::double precision IS NULL THEN NULL ELSE now() + ($7::text || ' seconds')::interval END,
       submitted_at = CASE WHEN remote_job_id IS NULL THEN COALESCE(submitted_at, now()) ELSE submitted_at END,
       last_polled_at = CASE WHEN remote_job_id IS NULL THEN last_polled_at ELSE now() END,
       next_poll_at = now() + ($8::text || ' milliseconds')::interval,
       generation_deadline = COALESCE(generation_deadline, now() + ($9::text || ' milliseconds')::interval),
       provider_result_metadata = $10, lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE id = $1 AND lease_owner = $2
       AND status IN ('generating','provider_pending','downloading')
     RETURNING id`,
    [job.id, workerId, result.remoteJobId, pendingProviderStatus(result.metadata), result.progress, result.queuePosition,
      result.etaSeconds, pollAfterMs, result.generationTimeoutMs, JSON.stringify(result.metadata)]
  );
  if (!persisted.rows[0]) {
    throw Object.assign(new Error("Image job lease was lost before provider state was persisted."), { code: "lease_lost" });
  }
  logger.info({
    event: job.remote_job_id ? "image_provider_status" : "image_provider_submitted",
    imageJobId: job.id,
    providerType: job.provider_type,
    remoteJobId: result.remoteJobId,
    stage: pendingProviderStatus(result.metadata),
    progress: result.progress,
    queuePosition: result.queuePosition,
    etaSeconds: result.etaSeconds
  });
}

function withoutTemporaryUrls(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const sanitize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sanitize);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/(?:url|uri|authorization|token|secret)/i.test(key))
      .map(([key, nested]) => [key, sanitize(nested)]));
  };
  return sanitize(metadata || {}) as Record<string, unknown>;
}
