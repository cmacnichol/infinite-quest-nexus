import type { IllustrationConfig, IllustrationRequest } from "../../../packages/contracts/src/generation.js";
import type { DatabaseClient, DatabasePool } from "../../../packages/database/src/pool.js";
import { initialOwnerId, withTransaction } from "../../../packages/database/src/pool.js";
import { sha256 } from "../../../packages/domain/src/text.js";
import { callImageProvider, containsMechanicsLanguage, logProviderTransportError } from "../../../packages/story-engine/src/index.js";
import { persistTurnImage, type FilesystemAssetStore } from "./asset-service.js";
import { loadImageProvider, recordProviderHealth, resolveEffectiveProviderId } from "./provider-service.js";
import { recordProfileCost } from "./cost-service.js";

type IllustrationConfigRow = {
  enabled: boolean;
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
  campaign_id: string;
  turn_id: string;
  provider_profile_id: string;
  requested_model: string;
  prompt: string;
  status: "queued" | "generating" | "completed" | "recoverable" | "failed";
  attempts: number;
  max_attempts: number;
  size: string;
  aspect_ratio: string;
  quality: IllustrationConfig["quality"];
  output_format: IllustrationConfig["outputFormat"];
  asset_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
};

function publicConfig(row?: IllustrationConfigRow) {
  return {
    enabled: row?.enabled ?? false,
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
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}

const jobColumns = `id, owner_user_id, campaign_id, turn_id, provider_profile_id, requested_model,
  prompt, status, attempts, max_attempts, size, aspect_ratio, quality, output_format, asset_id,
  error_code, error_message, created_at, updated_at, completed_at`;

export async function getIllustrationConfig(pool: DatabasePool, campaignId: string) {
  const ownerUserId = await initialOwnerId(pool);
  const campaign = await pool.query("SELECT id FROM campaigns WHERE id = $1 AND owner_user_id = $2", [campaignId, ownerUserId]);
  if (!campaign.rows[0]) throw Object.assign(new Error("Campaign not found."), { statusCode: 404 });
  const result = await pool.query<IllustrationConfigRow>(
    `SELECT enabled, provider_profile_id, model, size, aspect_ratio, quality, output_format, max_attempts
       FROM campaign_illustration_configs WHERE campaign_id = $1 AND owner_user_id = $2`,
    [campaignId, ownerUserId]
  );
  return publicConfig(result.rows[0]);
}

export async function setIllustrationConfig(pool: DatabasePool, campaignId: string, config: IllustrationConfig) {
  const ownerUserId = await initialOwnerId(pool);
  if (config.enabled && !config.providerProfileId) {
    throw Object.assign(new Error("Add and enable an image provider before enabling illustrations."), { statusCode: 409 });
  }
  if (config.enabled && !config.model.trim()) {
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
       campaign_id, owner_user_id, enabled, provider_profile_id, model, size, aspect_ratio, quality, output_format, max_attempts
     ) SELECT c.id, c.owner_user_id, $3,$4,$5,$6,$7,$8,$9,$10
         FROM campaigns c WHERE c.id = $1 AND c.owner_user_id = $2
     ON CONFLICT (campaign_id) DO UPDATE SET enabled = EXCLUDED.enabled,
       provider_profile_id = EXCLUDED.provider_profile_id, model = EXCLUDED.model, size = EXCLUDED.size,
       aspect_ratio = EXCLUDED.aspect_ratio, quality = EXCLUDED.quality, output_format = EXCLUDED.output_format,
       max_attempts = EXCLUDED.max_attempts, updated_at = now()
     RETURNING enabled, provider_profile_id, model, size, aspect_ratio, quality, output_format, max_attempts`,
    [campaignId, ownerUserId, config.enabled, config.providerProfileId, config.model, config.size,
      config.aspectRatio, config.quality, config.outputFormat, config.maxAttempts]
  );
  if (!result.rows[0]) throw Object.assign(new Error("Campaign not found."), { statusCode: 404 });
  return publicConfig(result.rows[0]);
}

async function insertImageJob(
  client: DatabaseClient | DatabasePool,
  values: { ownerUserId: string; campaignId: string; turnId: string; prompt: string; config: ReturnType<typeof publicConfig> }
) {
  const prompt = values.prompt.trim();
  if (!prompt || containsMechanicsLanguage(prompt)) return null;
  const result = await client.query<ImageJobRow>(
    `INSERT INTO image_jobs (
       owner_user_id, campaign_id, turn_id, provider_profile_id, requested_model, prompt, prompt_hash,
       size, aspect_ratio, quality, output_format, max_attempts
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING ${jobColumns}`,
    [values.ownerUserId, values.campaignId, values.turnId, values.config.providerProfileId, values.config.model,
      prompt, sha256(prompt), values.config.size, values.config.aspectRatio, values.config.quality,
      values.config.outputFormat, values.config.maxAttempts]
  );
  return result.rows[0] || null;
}

export async function enqueueAcceptedTurnIllustration(
  client: DatabaseClient,
  ownerUserId: string,
  campaignId: string,
  turnId: string,
  imagePrompt: string
): Promise<string | null> {
  const configResult = await client.query<IllustrationConfigRow & { campaign_provider_profile_id: string | null }>(
    `SELECT c.enabled, c.provider_profile_id, c.model, c.size, c.aspect_ratio, c.quality, c.output_format, c.max_attempts,
            campaign.image_provider_profile_id AS campaign_provider_profile_id
       FROM campaign_illustration_configs c
       JOIN campaigns campaign ON campaign.id = c.campaign_id AND campaign.owner_user_id = c.owner_user_id
      WHERE c.campaign_id = $1 AND c.owner_user_id = $2 AND c.enabled = true`,
    [campaignId, ownerUserId]
  );
  const row = configResult.rows[0];
  if (!row) return null;
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
    if (existing.rows[0] && (!request.replace || ["queued", "generating"].includes(existing.rows[0].status))) {
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
       lease_expires_at = NULL, error_code = NULL, error_message = NULL, updated_at = now()
      WHERE id = $1 AND owner_user_id = $2 AND status IN ('recoverable', 'failed')
      RETURNING ${jobColumns}`,
    [jobId, ownerUserId]
  );
  if (!result.rows[0]) throw Object.assign(new Error("Only recoverable or failed image jobs can be retried."), { statusCode: 409 });
  return publicJob(result.rows[0]);
}

async function claimImageJob(pool: DatabasePool, workerId: string, leaseSeconds: number): Promise<ImageJobRow | null> {
  return withTransaction(pool, async (client) => {
    const result = await client.query<ImageJobRow>(
      `WITH candidate AS (
         SELECT id FROM image_jobs
          WHERE (status = 'queued' AND next_attempt_at <= now())
             OR (status = 'generating' AND lease_expires_at < now())
          ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE image_jobs j SET status = 'generating', attempts = attempts + 1, lease_owner = $1,
         lease_expires_at = now() + ($2::text || ' seconds')::interval, updated_at = now()
       FROM candidate WHERE j.id = candidate.id RETURNING j.*`,
      [workerId, leaseSeconds]
    );
    return result.rows[0] || null;
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
    const response = await callImageProvider(provider, {
      prompt: job.prompt,
      size: job.size,
      aspectRatio: job.aspect_ratio,
      quality: job.quality,
      outputFormat: job.output_format
    });
    await recordProviderHealth(pool, job.owner_user_id, job.provider_profile_id, true);
    if (!/^[a-z0-9+/]+={0,2}$/i.test(response.base64.replace(/\s+/g, ""))) throw new Error("Image provider returned invalid base64 data.");
    const bytes = Buffer.from(response.base64.replace(/\s+/g, ""), "base64");
    await withTransaction(pool, async (client) => {
      const lease = await client.query<{ lease_owner: string | null }>("SELECT lease_owner FROM image_jobs WHERE id = $1 FOR UPDATE", [job.id]);
      if (lease.rows[0]?.lease_owner !== workerId) throw Object.assign(new Error("Image job lease was lost before commit."), { code: "lease_lost" });
      const asset = await persistTurnImage(client, store, job.owner_user_id, job.campaign_id, job.turn_id, bytes, response.mimeType);
      await client.query("UPDATE turns SET image_url = $3 WHERE id = $1 AND owner_user_id = $2", [job.turn_id, job.owner_user_id, asset.publicUrl]);
      await client.query(
        `UPDATE image_jobs SET status = 'completed', asset_id = $3, provider_response_id = $4,
           response_metadata = $5, completed_at = now(), updated_at = now(), lease_owner = NULL,
           lease_expires_at = NULL, error_code = NULL, error_message = NULL
         WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $6`,
        [job.id, job.owner_user_id, asset.id, response.responseId || null,
          JSON.stringify({ usage: response.usage, provider: response.rawMetadata, mimeType: response.mimeType, byteLength: bytes.length }), workerId]
      );
      await recordProfileCost(client, provider, {
        ownerUserId: job.owner_user_id,
        campaignId: job.campaign_id,
        turnId: job.turn_id,
        imageJobId: job.id,
        category: "image",
        operation: "illustration"
      }, response);
    });
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
    const retryable = !permanent && job.attempts < job.max_attempts;
    await pool.query(
      `UPDATE image_jobs SET status = $3, next_attempt_at = CASE WHEN $3 = 'queued'
           THEN now() + (LEAST(attempts, 5) * 15) * interval '1 second' ELSE next_attempt_at END,
         error_code = $4, error_message = $5, lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $6`,
      [job.id, job.owner_user_id, retryable ? "queued" : permanent ? "failed" : "recoverable", code,
        (error instanceof Error ? error.message : String(error)).slice(0, 4000), workerId]
    );
  }
  return true;
}
