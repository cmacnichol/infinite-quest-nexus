import type { IllustrationConfig, IllustrationRequest, WorldCoverRequest } from "../../../packages/contracts/src/generation.js";
import { isIP } from "node:net";
import type { DatabaseClient, DatabasePool } from "../../../packages/database/src/pool.js";
import { initialOwnerId, withTransaction } from "../../../packages/database/src/pool.js";
import { sha256 } from "../../../packages/domain/src/text.js";
import { logger } from "../../../packages/logger/src/index.js";
import {
  containsMechanicsLanguage,
  logProviderTransportError,
  pollImageProvider,
  submitImageProvider,
  type ImageProviderArtifact,
  type ImageProviderResult,
  type TextProviderProfile
} from "../../../packages/story-engine/src/index.js";
import { persistTurnImage, persistWorldCover, type FilesystemAssetStore } from "./asset-service.js";
import { loadImageProvider, recordProviderHealth, resolveEffectiveProviderId } from "./provider-service.js";
import { recordProfileCost } from "./cost-service.js";

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
};

type ImageJobRow = {
  id: string;
  owner_user_id: string;
  campaign_id: string | null;
  turn_id: string | null;
  world_id: string | null;
  target_type: "turn_illustration" | "world_cover";
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
    maxAttempts: row?.max_attempts ?? 3
  };
}

function publicJob(row: ImageJobRow) {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    turnId: row.turn_id,
    worldId: row.world_id,
    targetType: row.target_type,
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

const jobColumns = `id, owner_user_id, campaign_id, turn_id, world_id, target_type, provider_profile_id, requested_model,
  prompt, status, attempts, max_attempts, size, aspect_ratio, quality, output_format, asset_id,
  provider_type, generation_revision, remote_job_id, provider_status, provider_progress, provider_queue_position, provider_eta_at, submitted_at, last_polled_at,
  next_poll_at, generation_deadline, provider_request_metadata, provider_result_metadata,
  error_code, error_message, created_at, updated_at, completed_at`;

export async function getIllustrationConfig(pool: DatabasePool, campaignId: string) {
  const ownerUserId = await initialOwnerId(pool);
  const campaign = await pool.query("SELECT id FROM campaigns WHERE id = $1 AND owner_user_id = $2", [campaignId, ownerUserId]);
  if (!campaign.rows[0]) throw Object.assign(new Error("Campaign not found."), { statusCode: 404 });
  const result = await pool.query<IllustrationConfigRow>(
    `SELECT enabled, source_policy, matching_scope, confidence_profile, repetition_window,
            provider_profile_id, model, size, aspect_ratio, quality, output_format, max_attempts
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
       provider_profile_id, model, size, aspect_ratio, quality, output_format, max_attempts
     ) SELECT c.id, c.owner_user_id, $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
         FROM campaigns c WHERE c.id = $1 AND c.owner_user_id = $2
     ON CONFLICT (campaign_id) DO UPDATE SET enabled = EXCLUDED.enabled,
       source_policy = EXCLUDED.source_policy, matching_scope = EXCLUDED.matching_scope,
       confidence_profile = EXCLUDED.confidence_profile, repetition_window = EXCLUDED.repetition_window,
       provider_profile_id = EXCLUDED.provider_profile_id, model = EXCLUDED.model, size = EXCLUDED.size,
       aspect_ratio = EXCLUDED.aspect_ratio, quality = EXCLUDED.quality, output_format = EXCLUDED.output_format,
       max_attempts = EXCLUDED.max_attempts, updated_at = now()
     RETURNING enabled, source_policy, matching_scope, confidence_profile, repetition_window,
               provider_profile_id, model, size, aspect_ratio, quality, output_format, max_attempts`,
    [campaignId, ownerUserId, sourcePolicy !== "off", sourcePolicy, config.matchingScope,
      config.confidenceProfile, config.repetitionWindow, config.providerProfileId, config.model, config.size,
      config.aspectRatio, config.quality, config.outputFormat, config.maxAttempts]
  );
  if (!result.rows[0]) throw Object.assign(new Error("Campaign not found."), { statusCode: 404 });
  return publicConfig(result.rows[0]);
}

async function insertImageJob(
  client: DatabaseClient | DatabasePool,
  values: {
    ownerUserId: string;
    campaignId?: string | null;
    turnId?: string | null;
    worldId?: string | null;
    targetType?: ImageJobRow["target_type"];
    prompt: string;
    config: ReturnType<typeof publicConfig>;
  }
) {
  const prompt = values.prompt.trim();
  if (!prompt || containsMechanicsLanguage(prompt)) return null;
  const jobId = crypto.randomUUID();
  const result = await client.query<ImageJobRow>(
    `INSERT INTO image_jobs (
       id, owner_user_id, campaign_id, turn_id, world_id, target_type, provider_profile_id, requested_model, prompt, prompt_hash,
       size, aspect_ratio, quality, output_format, max_attempts, provider_type, provider_request_metadata
     ) SELECT $1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, provider_type,
              jsonb_build_object('idempotencyKey', ($1::uuid)::text || ':0', 'requestedModel', $8::text, 'targetType', $6::text)
         FROM provider_profiles WHERE id = $7 AND owner_user_id = $2
     RETURNING ${jobColumns}`,
    [jobId, values.ownerUserId, values.campaignId ?? null, values.turnId ?? null, values.worldId ?? null,
      values.targetType ?? "turn_illustration", values.config.providerProfileId, values.config.model,
      prompt, sha256(prompt), values.config.size, values.config.aspectRatio, values.config.quality,
      values.config.outputFormat, values.config.maxAttempts]
  );
  return result.rows[0] || null;
}

export async function enqueueWorldCover(pool: DatabasePool, worldId: string, request: WorldCoverRequest) {
  const ownerUserId = await initialOwnerId(pool);
  return withTransaction(pool, async (client) => {
    const worldResult = await client.query<{ title: string; status: string; content: Record<string, any> }>(
      `SELECT worlds.title, worlds.status, drafts.content
         FROM worlds JOIN world_drafts drafts
           ON drafts.world_id = worlds.id AND drafts.owner_user_id = worlds.owner_user_id
        WHERE worlds.id = $1 AND worlds.owner_user_id = $2 FOR UPDATE OF worlds, drafts`,
      [worldId, ownerUserId]
    );
    const world = worldResult.rows[0];
    if (!world) throw Object.assign(new Error("World not found."), { statusCode: 404 });
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
    const providerProfileId = await resolveEffectiveProviderId(client, ownerUserId, "image", null);
    if (!providerProfileId) throw Object.assign(new Error("Configure a default image provider before generating a world cover."), { statusCode: 409 });
    const provider = await client.query<{ default_model: string }>(
      `SELECT default_model FROM provider_profiles
        WHERE id = $1 AND owner_user_id = $2 AND provider_role = 'image' AND enabled = true`,
      [providerProfileId, ownerUserId]
    );
    const model = provider.rows[0]?.default_model.trim();
    if (!model) throw Object.assign(new Error("Select a default model on the default image provider before generating a world cover."), { statusCode: 409 });
    const overview = world.content?.world || {};
    const prompt = request.prompt || [
      `Create a polished vertical fantasy book cover for the story world “${world.title}”.`,
      overview.genre ? `Genre: ${String(overview.genre).slice(0, 500)}.` : "",
      overview.tone ? `Tone: ${String(overview.tone).slice(0, 500)}.` : "",
      overview.premise ? `Premise: ${String(overview.premise).slice(0, 2000)}.` : "",
      "Show only evocative diegetic scenery and characters. Do not include typography, logos, interface elements, statistics, dice, or game mechanics."
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
  imagePrompt: string
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
       ON CONFLICT (turn_id) DO NOTHING RETURNING id`,
      [ownerUserId, campaignId, turnId, row.source_policy, row.matching_scope || "world",
        row.confidence_profile || "balanced", row.repetition_window ?? 5, JSON.stringify({ imagePrompt: imagePrompt.trim() })]
    );
    return resolution.rows[0]?.id || null;
  }
  const configuredProviderId = row.provider_profile_id;
  row.provider_profile_id = await resolveEffectiveProviderId(client, ownerUserId, "image", row.campaign_provider_profile_id);
  if (!row.provider_profile_id) return null;
  if (row.provider_profile_id !== configuredProviderId) {
    const provider = await client.query<{ default_model: string }>("SELECT default_model FROM provider_profiles WHERE id = $1 AND owner_user_id = $2", [row.provider_profile_id, ownerUserId]);
    if (provider.rows[0]?.default_model) row.model = provider.rows[0].default_model;
  }
  const job = await insertImageJob(client, { ownerUserId, campaignId, turnId, prompt: imagePrompt, config: publicConfig(row) });
  return job?.id || null;
}

export async function enqueueIllustration(pool: DatabasePool, turnId: string, request: IllustrationRequest) {
  const ownerUserId = await initialOwnerId(pool);
  return withTransaction(pool, async (client) => {
    const turnResult = await client.query<{ campaign_id: string; image_prompt: string }>(
      `SELECT campaign_id, image_prompt FROM turns WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
      [turnId, ownerUserId]
    );
    const turn = turnResult.rows[0];
    if (!turn) throw Object.assign(new Error("Accepted turn not found."), { statusCode: 404 });
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
    const configuredProviderId = config.providerProfileId;
    config.providerProfileId = await resolveEffectiveProviderId(
      client,
      ownerUserId,
      "image",
      request.providerProfileId || configResult.rows[0]?.campaign_provider_profile_id
    );
    if (config.providerProfileId && config.providerProfileId !== configuredProviderId && !request.model) {
      const providerModel = await client.query<{ default_model: string }>("SELECT default_model FROM provider_profiles WHERE id = $1 AND owner_user_id = $2", [config.providerProfileId, ownerUserId]);
      if (providerModel.rows[0]?.default_model) config.model = providerModel.rows[0].default_model;
    }
    if (request.model) config.model = request.model;
    if (!config.providerProfileId || !config.model) throw Object.assign(new Error("Configure an image provider and model before requesting an illustration."), { statusCode: 409 });
    const provider = await client.query(
      `SELECT id FROM provider_profiles WHERE id = $1 AND owner_user_id = $2 AND provider_role = 'image' AND enabled = true`,
      [config.providerProfileId, ownerUserId]
    );
    if (!provider.rows[0]) throw Object.assign(new Error("Enabled image provider profile not found."), { statusCode: 400 });
    const job = await insertImageJob(client, { ownerUserId, campaignId: turn.campaign_id, turnId, prompt: request.prompt || turn.image_prompt, config });
    if (!job) throw Object.assign(new Error("The accepted turn does not contain a safe fiction-only image prompt."), { statusCode: 409 });
    return { ...publicJob(job), duplicate: false };
  });
}

export async function getImageJob(pool: DatabasePool, jobId: string) {
  const ownerUserId = await initialOwnerId(pool);
  const result = await pool.query<ImageJobRow>(`SELECT ${jobColumns} FROM image_jobs WHERE id = $1 AND owner_user_id = $2`, [jobId, ownerUserId]);
  if (!result.rows[0]) throw Object.assign(new Error("Image job not found."), { statusCode: 404 });
  return publicJob(result.rows[0]);
}

export async function listCampaignImageJobs(pool: DatabasePool, campaignId: string) {
  const ownerUserId = await initialOwnerId(pool);
  const result = await pool.query<ImageJobRow>(
    `SELECT ${jobColumns} FROM image_jobs WHERE campaign_id = $1 AND owner_user_id = $2 ORDER BY created_at DESC LIMIT 100`,
    [campaignId, ownerUserId]
  );
  return result.rows.map(publicJob);
}

export async function retryImageJob(pool: DatabasePool, jobId: string) {
  const ownerUserId = await initialOwnerId(pool);
  const result = await pool.query<ImageJobRow>(
    `UPDATE image_jobs SET status = 'queued', attempts = 0, next_attempt_at = now(), lease_owner = NULL,
       lease_expires_at = NULL, generation_revision = generation_revision + 1,
       remote_job_id = NULL, provider_status = NULL, provider_progress = NULL,
       submitted_at = NULL, last_polled_at = NULL, next_poll_at = NULL, generation_deadline = NULL,
       provider_result_metadata = '{}'::jsonb, response_metadata = '{}'::jsonb,
       provider_request_metadata = jsonb_build_object(
         'idempotencyKey', id::text || ':' || (generation_revision + 1)::text,
         'requestedModel', requested_model
       ),
       error_code = NULL, error_message = NULL, completed_at = NULL, updated_at = now()
      WHERE id = $1 AND owner_user_id = $2 AND status IN ('recoverable', 'failed', 'expired', 'cancelled')
      RETURNING ${jobColumns}`,
    [jobId, ownerUserId]
  );
  if (!result.rows[0]) throw Object.assign(new Error("Only terminal unsuccessful image jobs can be retried."), { statusCode: 409 });
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

const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;

function numberSetting(profile: TextProviderProfile, key: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(profile.configuration?.[key]);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.round(value))) : fallback;
}

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

function privateArtifactHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (isIP(host) === 4) {
    const [first = 0, second = 0] = host.split(".").map(Number);
    return first === 0 || first === 10 || first === 127 || first >= 224
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168);
  }
  if (isIP(host) === 6) {
    return host === "::" || host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)
      || /^::ffff:(?:0|10|127|169\.254|172\.(?:1[6-9]|2\d|3[01])|192\.168)\./.test(host);
  }
  return false;
}

async function downloadArtifact(artifact: ImageProviderArtifact, timeoutMs: number, allowPrivateHosts = false): Promise<{ bytes: Buffer; mimeType: "image/png" | "image/jpeg" | "image/webp" }> {
  if (artifact.source === "base64") {
    const normalized = artifact.base64.replace(/\s+/g, "");
    if (!/^[a-z0-9+/]+={0,2}$/i.test(normalized)) throw Object.assign(new Error("Image provider returned invalid base64 data."), { code: "invalid_image_artifact", permanent: true });
    const bytes = Buffer.from(normalized, "base64");
    if (bytes.length > MAX_ARTIFACT_BYTES) throw Object.assign(new Error("Generated image exceeded the 20 MB provider artifact limit."), { code: "image_too_large", permanent: true });
    return { bytes, mimeType: artifactMimeType(bytes, artifact.mimeType) };
  }
  const url = new URL(artifact.url);
  if (!(["https:", "http:"] as string[]).includes(url.protocol)) throw Object.assign(new Error("Provider artifact URL used an unsupported protocol."), { code: "invalid_artifact_url", permanent: true });
  if (!allowPrivateHosts && privateArtifactHost(url.hostname)) throw Object.assign(new Error("Provider artifact URL resolved to a private or local host."), { code: "private_artifact_host", permanent: true });
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
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
}

async function completeImageJob(
  pool: DatabasePool,
  job: ImageJobRow,
  workerId: string,
  store: FilesystemAssetStore,
  provider: TextProviderProfile & { id: string; name: string },
  result: { artifacts: ImageProviderArtifact[]; usage: Record<string, unknown>; reportedCost: ImageProviderResult["reportedCost"]; providerMetadata: Record<string, unknown> }
): Promise<void> {
  if (!result.artifacts.length || result.artifacts.length > 2) throw Object.assign(new Error("Image provider returned an unsupported artifact count."), { code: "invalid_artifact_count", permanent: true });
  await pool.query("UPDATE image_jobs SET status = 'downloading', provider_status = 'completed', updated_at = now() WHERE id = $1 AND lease_owner = $2", [job.id, workerId]);
  const timeoutMs = numberSetting(provider, "artifactDownloadTimeoutMs", 30_000, 5_000, 120_000);
  const allowPrivateHosts = provider.configuration?.allowPrivateArtifactHosts === true;
  const downloaded = await Promise.all(result.artifacts.map((artifact) => downloadArtifact(artifact, timeoutMs, allowPrivateHosts)));
  await withTransaction(pool, async (client) => {
    const lease = await client.query<{ lease_owner: string | null }>("SELECT lease_owner FROM image_jobs WHERE id = $1 FOR UPDATE", [job.id]);
    if (lease.rows[0]?.lease_owner !== workerId) throw Object.assign(new Error("Image job lease was lost before commit."), { code: "lease_lost" });
    const assets = [];
    for (const [variantIndex, image] of downloaded.entries()) {
      const generationContext = {
        imageJobId: job.id,
        targetType: job.target_type,
        variantIndex,
        prompt: job.prompt,
        providerProfileId: job.provider_profile_id,
        providerType: job.provider_type || provider.providerType,
        model: job.requested_model,
        generationParameters: {
          size: job.size,
          aspectRatio: job.aspect_ratio,
          quality: job.quality,
          outputFormat: job.output_format,
          ...(provider.providerType === "sogni_sdk"
            ? { contentFilterEnabled: provider.configuration?.contentFilter !== false }
            : {})
        }
      };
      assets.push(job.target_type === "world_cover"
        ? await persistWorldCover(client, store, job.owner_user_id, image.bytes, image.mimeType, { generationContext })
        : await persistTurnImage(client, store, job.owner_user_id, job.campaign_id!, job.turn_id!, image.bytes, image.mimeType,
          { generationContext, attachReference: variantIndex === 0 }));
    }
    const primary = assets[0]!;
    const usageQuantity = Number(result.usage.quantity ?? result.usage.images ?? result.usage.image_count);
    const persistedUsageQuantity = Number.isFinite(usageQuantity) && usageQuantity >= 0 ? usageQuantity : assets.length;
    const usageUnit = String(result.usage.unit || "image").slice(0, 100);
    const providerResponseId = String(result.providerMetadata.responseId || job.remote_job_id || "");
    if (job.target_type === "world_cover") {
      await client.query("UPDATE worlds SET cover_asset_id = $3, updated_at = now() WHERE id = $1 AND owner_user_id = $2", [job.world_id, job.owner_user_id, primary.id]);
    } else {
      await client.query("UPDATE turns SET image_url = $3 WHERE id = $1 AND owner_user_id = $2", [job.turn_id, job.owner_user_id, primary.publicUrl]);
    }
    await client.query(
      `UPDATE image_jobs SET status = 'completed', asset_id = $3,
         provider_response_id = COALESCE(NULLIF($10, ''), remote_job_id, provider_response_id),
         response_metadata = $4, provider_result_metadata = $5, provider_progress = 100,
         usage_quantity = $6, usage_unit = $7, reported_cost = $8, reported_currency = $9,
         completed_at = now(), updated_at = now(), lease_owner = NULL, lease_expires_at = NULL,
         next_poll_at = NULL, error_code = NULL, error_message = NULL
       WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $11`,
      [job.id, job.owner_user_id, primary.id,
        JSON.stringify({ usage: result.usage, provider: result.providerMetadata, mimeType: downloaded[0]!.mimeType, byteLength: downloaded[0]!.bytes.length, assetIds: assets.map((asset) => asset.id) }),
        JSON.stringify({ ...result.providerMetadata, artifactCount: assets.length, assetIds: assets.map((asset) => asset.id) }),
        persistedUsageQuantity, usageUnit, result.reportedCost?.amount ?? null, result.reportedCost?.currency ?? null,
        providerResponseId, workerId]
    );
    await client.query(
      `UPDATE illustration_resolution_jobs
          SET status = 'completed', reason_code = 'generated', completed_at = now(), updated_at = now()
        WHERE image_job_id = $1 AND owner_user_id = $2 AND status = 'generation_queued'`,
      [job.id, job.owner_user_id]
    );
    if (job.campaign_id) {
      await recordProfileCost(client, provider, {
        ownerUserId: job.owner_user_id, campaignId: job.campaign_id, turnId: job.turn_id,
        imageJobId: job.id, category: "image", operation: "illustration"
      }, { usage: result.usage, reportedCost: result.reportedCost, responseId: providerResponseId });
    }
  });
  logger.info({
    event: "image_provider_completed", imageJobId: job.id, providerType: provider.providerType,
    remoteJobId: job.remote_job_id, stage: "completed", progress: 100, artifactCount: downloaded.length
  });
}

export async function runImageJob(
  pool: DatabasePool,
  workerId: string,
  leaseSeconds: number,
  credentialSecret: string,
  store: FilesystemAssetStore
): Promise<boolean> {
  const job = await claimImageJob(pool, workerId, leaseSeconds);
  if (!job) return false;
  try {
    if (containsMechanicsLanguage(job.prompt)) throw Object.assign(new Error("Illustration prompt failed the fiction-only boundary."), { code: "unsafe_prompt", permanent: true });
    const provider = await loadImageProvider(pool, job.owner_user_id, job.provider_profile_id, credentialSecret, job.requested_model);
    const request = {
      prompt: job.prompt,
      size: job.size,
      aspectRatio: job.aspect_ratio,
      quality: job.quality,
      outputFormat: job.output_format,
      idempotencyKey: `${job.id}:${job.generation_revision}`,
      imageCount: numberSetting(provider, "defaultImageCount", 1, 1, 2) as 1 | 2
    } as const;
    if (job.remote_job_id) {
      if (job.generation_deadline && job.generation_deadline.getTime() <= Date.now()) {
        throw Object.assign(new Error("The provider generation deadline expired before completion."), { code: "image_generation_expired", expired: true, permanent: true });
      }
      const response = await pollImageProvider(provider, { remoteJobId: job.remote_job_id });
      if (response.status === "pending") {
        const pollAfterMs = Math.min(
          numberSetting(provider, "maximumPollIntervalMs", 10_000, 1_000, 30_000),
          Math.max(numberSetting(provider, "pollIntervalMs", 2_000, 1_000, 30_000), Number(response.pollAfterMs || 0))
        );
        await pool.query(
          `UPDATE image_jobs SET status = 'provider_pending', provider_status = $3,
             provider_progress = COALESCE($4, provider_progress), provider_queue_position = $5,
             provider_eta_at = CASE WHEN $6::double precision IS NULL THEN NULL ELSE now() + ($6::text || ' seconds')::interval END,
             last_polled_at = now(), next_poll_at = now() + ($7::text || ' milliseconds')::interval,
             provider_result_metadata = $8, lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
           WHERE id = $1 AND lease_owner = $2`,
          [job.id, workerId, pendingProviderStatus(response.providerMetadata), response.progress ?? null, response.queuePosition ?? null, response.etaSeconds ?? null,
            pollAfterMs, JSON.stringify(withoutTemporaryUrls(response.providerMetadata))]
        );
        logger.info({
          event: "image_provider_status", imageJobId: job.id, providerType: provider.providerType,
          remoteJobId: job.remote_job_id, stage: pendingProviderStatus(response.providerMetadata),
          progress: response.progress ?? null, queuePosition: response.queuePosition ?? null, etaSeconds: response.etaSeconds ?? null,
          reconciliation: response.providerMetadata.recoveredAfterRestart === true
        });
        await recordProviderHealth(pool, job.owner_user_id, job.provider_profile_id, true);
        return true;
      }
      if (response.status === "failed") {
        throw Object.assign(new Error(response.error.message), {
          code: response.error.code || "provider_generation_failed",
          permanent: !response.error.retryable
        });
      }
      await recordProviderHealth(pool, job.owner_user_id, job.provider_profile_id, true);
      await completeImageJob(pool, job, workerId, store, provider, {
        artifacts: response.artifacts,
        usage: response.usage || {},
        reportedCost: response.reportedCost || null,
        providerMetadata: withoutTemporaryUrls(response.providerMetadata)
      });
    } else {
      const response = await submitImageProvider(provider, request);
      await recordProviderHealth(pool, job.owner_user_id, job.provider_profile_id, true);
      if (response.mode === "pending") {
        const pollAfterMs = Math.min(
          numberSetting(provider, "maximumPollIntervalMs", 10_000, 1_000, 30_000),
          Math.max(numberSetting(provider, "pollIntervalMs", 2_000, 1_000, 30_000), Number(response.pollAfterMs || 0))
        );
        const generationTimeoutMs = numberSetting(provider, "generationTimeoutMs", provider.providerType === "sogni_sdk" ? 600_000 : 180_000,
          30_000, provider.providerType === "sogni_sdk" ? 3_600_000 : 600_000);
        const persisted = await pool.query(
          `UPDATE image_jobs SET status = 'provider_pending', remote_job_id = $3, provider_status = $4,
             provider_progress = $5, provider_queue_position = $6,
             provider_eta_at = CASE WHEN $7::double precision IS NULL THEN NULL ELSE now() + ($7::text || ' seconds')::interval END,
             submitted_at = COALESCE(submitted_at, now()), next_poll_at = now() + ($8::text || ' milliseconds')::interval,
             generation_deadline = COALESCE(generation_deadline, now() + ($9::text || ' milliseconds')::interval),
             provider_result_metadata = $10, lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
           WHERE id = $1 AND lease_owner = $2 AND remote_job_id IS NULL RETURNING id`,
          [job.id, workerId, response.remoteJobId, pendingProviderStatus(response.providerMetadata), response.progress ?? null, response.queuePosition ?? null, response.etaSeconds ?? null,
            pollAfterMs, generationTimeoutMs, JSON.stringify(withoutTemporaryUrls(response.providerMetadata))]
        );
        if (!persisted.rows[0]) throw Object.assign(new Error("Image job lease was lost before the remote job identifier was persisted."), { code: "lease_lost" });
        logger.info({
          event: "image_provider_submitted", imageJobId: job.id, providerType: provider.providerType,
          remoteJobId: response.remoteJobId, stage: pendingProviderStatus(response.providerMetadata),
          progress: response.progress ?? null, queuePosition: response.queuePosition ?? null, etaSeconds: response.etaSeconds ?? null,
          submitPersistBoundary: "remote_id_persisted"
        });
        return true;
      }
      await completeImageJob(pool, job, workerId, store, provider, {
        artifacts: response.artifacts,
        usage: response.usage || {},
        reportedCost: response.reportedCost || null,
        providerMetadata: withoutTemporaryUrls(response.providerMetadata)
      });
    }
  } catch (error) {
    logProviderTransportError(error, {
      imageJobId: job.id,
      campaignId: job.campaign_id,
      turnId: job.turn_id,
      providerProfileId: job.provider_profile_id,
      workerId
    });
    await recordProviderHealth(pool, job.owner_user_id, job.provider_profile_id, false, error instanceof Error ? error.message : String(error)).catch(() => undefined);
    const permanent = typeof error === "object" && error !== null && "permanent" in error && Boolean((error as { permanent: unknown }).permanent);
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "image_generation_failed";
    const expired = typeof error === "object" && error !== null && "expired" in error && Boolean((error as { expired: unknown }).expired);
    const retryableSubmission = !job.remote_job_id && !permanent && job.attempts < job.max_attempts;
    const retryablePoll = Boolean(job.remote_job_id) && !permanent && (!job.generation_deadline || job.generation_deadline.getTime() > Date.now());
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
    await pool.query(
      `UPDATE image_jobs SET status = $3, next_attempt_at = CASE WHEN $3 = 'queued'
           THEN now() + ($7::text || ' milliseconds')::interval ELSE next_attempt_at END,
         next_poll_at = CASE WHEN $3 = 'provider_pending'
           THEN now() + ($7::text || ' milliseconds')::interval ELSE next_poll_at END,
         error_code = $4, error_message = $5, lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $6`,
      [job.id, job.owner_user_id, nextStatus, code,
        (error instanceof Error ? error.message : String(error)).slice(0, 4000), workerId, retryDelayMs]
    );
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
