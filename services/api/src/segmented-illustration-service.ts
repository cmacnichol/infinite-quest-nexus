import type {
  IllustrationBackfillRequest,
  IllustrationConfig,
  IllustrationSegmentImageRequest,
  IllustrationSegmentRequest
} from "../../../packages/contracts/src/generation.js";
import { DEFAULT_ILLUSTRATION_REFINEMENT_PROMPT } from "../../../packages/contracts/src/generation.js";
import type { DatabaseClient, DatabasePool } from "../../../packages/database/src/pool.js";
import { initialOwnerId, withTransaction } from "../../../packages/database/src/pool.js";
import { directIllustrationPrompt, segmentIllustrationText, sha256, stripMechanicsLeakage, truncateAtBoundary } from "../../../packages/domain/src/index.js";
import {
  callTextProvider,
  containsMechanicsLanguage,
  logProviderTransportError
} from "../../../packages/story-engine/src/index.js";
import { recordProfileCost } from "./cost-service.js";
import { insertImageJob } from "./image-service.js";
import { loadTextProvider, resolveEffectiveProviderId } from "./provider-service.js";

type SegmentConfigRow = {
  enabled: boolean;
  source_policy: "off" | "library_only" | "library_then_generate" | "generate_only";
  matching_scope: IllustrationConfig["matchingScope"];
  confidence_profile: IllustrationConfig["confidenceProfile"];
  repetition_window: number;
  provider_profile_id: string | null;
  campaign_image_provider_id: string | null;
  campaign_text_provider_id: string | null;
  model: string;
  size: string;
  aspect_ratio: string;
  quality: IllustrationConfig["quality"];
  output_format: IllustrationConfig["outputFormat"];
  max_attempts: number;
  segment_word_count: number;
  images_per_segment: 1 | 2;
  segment_prompt_mode: IllustrationConfig["segmentPromptMode"];
  refinement_prompt: string;
  updated_at: Date;
};

type SegmentRow = {
  id: string;
  owner_user_id: string;
  campaign_id: string;
  turn_id: string;
  illustration_set_id: string;
  source_text: string;
  direct_prompt: string;
  resolved_prompt: string;
};

async function loadConfig(client: DatabaseClient | DatabasePool, ownerUserId: string, campaignId: string): Promise<SegmentConfigRow> {
  const result = await client.query<SegmentConfigRow>(
    `SELECT config.enabled, config.source_policy, config.matching_scope, config.confidence_profile,
            config.repetition_window, config.provider_profile_id, config.model, config.size,
            config.aspect_ratio, config.quality, config.output_format, config.max_attempts,
            config.segment_word_count, config.images_per_segment, config.segment_prompt_mode, config.refinement_prompt,
            config.updated_at, campaigns.image_provider_profile_id AS campaign_image_provider_id,
            campaigns.text_provider_profile_id AS campaign_text_provider_id
       FROM campaign_illustration_configs config
       JOIN campaigns ON campaigns.id = config.campaign_id
        AND campaigns.owner_user_id = config.owner_user_id
      WHERE config.campaign_id = $1 AND config.owner_user_id = $2`,
    [campaignId, ownerUserId]
  );
  const config = result.rows[0];
  if (!config || !config.enabled || config.source_policy === "off") {
    throw Object.assign(new Error("Enable campaign illustrations before generating segment images."), { statusCode: 409 });
  }
  return config;
}

function imageConfig(config: SegmentConfigRow, providerProfileId: string | null) {
  return {
    enabled: true,
    sourcePolicy: config.source_policy,
    matchingScope: config.matching_scope,
    confidenceProfile: config.confidence_profile,
    repetitionWindow: config.repetition_window,
    providerProfileId,
    model: config.model,
    size: config.size,
    aspectRatio: config.aspect_ratio,
    quality: config.quality,
    outputFormat: config.output_format,
    maxAttempts: config.max_attempts,
    segmentWordCount: config.segment_word_count,
    imagesPerSegment: config.images_per_segment,
    segmentPromptMode: config.segment_prompt_mode,
    refinementPrompt: config.refinement_prompt.trim() || DEFAULT_ILLUSTRATION_REFINEMENT_PROMPT,
    defaultRefinementPrompt: DEFAULT_ILLUSTRATION_REFINEMENT_PROMPT,
    updatedAt: config.updated_at.toISOString()
  };
}

async function queueSegmentDelivery(
  client: DatabaseClient,
  ownerUserId: string,
  segment: SegmentRow,
  config: SegmentConfigRow,
  prompt: string,
  promptSource: "direct" | "ai_refined" | "ai_fallback"
) {
  if (!prompt.trim() || containsMechanicsLanguage(prompt)) {
    throw Object.assign(new Error("The segment illustration prompt failed the fiction-only boundary."), { statusCode: 409 });
  }
  await client.query(
    `UPDATE turn_illustration_segments
        SET resolved_prompt = $3, prompt_source = $4, status = 'generating', updated_at = now()
      WHERE id = $1 AND owner_user_id = $2`,
    [segment.id, ownerUserId, prompt.trim(), promptSource]
  );
  await client.query(
    `UPDATE turn_illustration_sets SET status = 'generating'
      WHERE id = $1 AND owner_user_id = $2 AND status IN ('queued', 'refining')`,
    [segment.illustration_set_id, ownerUserId]
  );
  if (config.source_policy === "library_only" || config.source_policy === "library_then_generate") {
    await client.query(
      `INSERT INTO illustration_resolution_jobs (
         owner_user_id, campaign_id, turn_id, segment_id, source_policy, matching_scope,
         confidence_profile, repetition_window, query_context_snapshot
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (segment_id) WHERE segment_id IS NOT NULL DO NOTHING`,
      [ownerUserId, segment.campaign_id, segment.turn_id, segment.id, config.source_policy,
        config.matching_scope, config.confidence_profile, config.repetition_window,
        JSON.stringify({ imagePrompt: prompt.trim(), segmentId: segment.id, segmentTextHash: sha256(segment.source_text) })]
    );
    return;
  }
  const providerProfileId = await resolveEffectiveProviderId(
    client,
    ownerUserId,
    "image",
    config.provider_profile_id || config.campaign_image_provider_id
  );
  if (!providerProfileId) throw Object.assign(new Error("No enabled image provider is available for segment generation."), { statusCode: 409 });
  const job = await insertImageJob(client, {
    ownerUserId,
    campaignId: segment.campaign_id,
    turnId: segment.turn_id,
    segmentId: segment.id,
    prompt,
    config: imageConfig(config, providerProfileId)
  });
  if (!job) throw Object.assign(new Error("The segment image job could not be created."), { statusCode: 409 });
}

async function createTurnSet(
  client: DatabaseClient,
  ownerUserId: string,
  turnId: string,
  mode: "missing" | "rebuild"
) {
  const turnResult = await client.query<{ campaign_id: string; narration: string }>(
    `SELECT campaign_id, narration FROM turns WHERE id = $1 AND owner_user_id = $2 FOR SHARE`,
    [turnId, ownerUserId]
  );
  const turn = turnResult.rows[0];
  if (!turn) throw Object.assign(new Error("Accepted turn not found."), { statusCode: 404 });
  const config = await loadConfig(client, ownerUserId, turn.campaign_id);
  const active = await client.query<{ id: string }>(
    `SELECT id FROM turn_illustration_sets
      WHERE turn_id = $1 AND owner_user_id = $2 AND is_active = true
      FOR UPDATE`,
    [turnId, ownerUserId]
  );
  if (active.rows[0] && mode === "missing") return { setId: active.rows[0].id, duplicate: true, segmentCount: 0 };
  if (active.rows[0]) {
    await client.query(
      `UPDATE turn_illustration_sets SET is_active = false, status = 'superseded'
        WHERE id = $1 AND owner_user_id = $2`,
      [active.rows[0].id, ownerUserId]
    );
  }
  const pieces = segmentIllustrationText(turn.narration, config.segment_word_count);
  if (!pieces.length) throw Object.assign(new Error("Accepted turn narration is empty."), { statusCode: 409 });
  const setResult = await client.query<{ id: string }>(
    `INSERT INTO turn_illustration_sets (
       owner_user_id, campaign_id, turn_id, source_text_hash, segment_word_count,
       images_per_segment, prompt_mode, status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [ownerUserId, turn.campaign_id, turnId, sha256(turn.narration), config.segment_word_count,
      config.images_per_segment, config.segment_prompt_mode,
      config.segment_prompt_mode === "ai_refined" ? "refining" : "queued"]
  );
  const setId = setResult.rows[0]!.id;
  for (const piece of pieces) {
    const sanitizedSegment = stripMechanicsLeakage(piece.text).text;
    if (!sanitizedSegment) {
      throw Object.assign(new Error("A segment contains no fiction-only text suitable for illustration."), { statusCode: 409 });
    }
    const directPrompt = directIllustrationPrompt(sanitizedSegment);
    const segmentResult = await client.query<SegmentRow>(
      `INSERT INTO turn_illustration_segments (
         owner_user_id, illustration_set_id, campaign_id, turn_id, ordinal,
         start_offset, end_offset, start_word, end_word, source_text, source_text_hash,
         direct_prompt, resolved_prompt, prompt_source, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'direct',$14)
       RETURNING id, owner_user_id, campaign_id, turn_id, illustration_set_id,
                 source_text, direct_prompt, resolved_prompt`,
      [ownerUserId, setId, turn.campaign_id, turnId, piece.ordinal, piece.startOffset, piece.endOffset,
        piece.startWord, piece.endWord, piece.text, sha256(piece.text), directPrompt,
        config.segment_prompt_mode === "direct" ? directPrompt : "",
        config.segment_prompt_mode === "ai_refined" ? "refining" : "queued"]
    );
    const segment = segmentResult.rows[0]!;
    if (config.segment_prompt_mode === "direct") {
      await queueSegmentDelivery(client, ownerUserId, segment, config, directPrompt, "direct");
      continue;
    }
    const textProviderId = await resolveEffectiveProviderId(
      client,
      ownerUserId,
      "text",
      config.campaign_text_provider_id
    );
    if (!textProviderId) {
      await queueSegmentDelivery(client, ownerUserId, segment, config, directPrompt, "ai_fallback");
      continue;
    }
    const provider = await client.query<{ default_model: string }>(
      "SELECT default_model FROM provider_profiles WHERE id = $1 AND owner_user_id = $2",
      [textProviderId, ownerUserId]
    );
    await client.query(
      `INSERT INTO illustration_prompt_jobs (
         owner_user_id, campaign_id, turn_id, segment_id, provider_profile_id,
         requested_model, max_attempts
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [ownerUserId, turn.campaign_id, turnId, segment.id, textProviderId,
        provider.rows[0]?.default_model || "", config.max_attempts]
    );
  }
  return { setId, duplicate: false, segmentCount: pieces.length };
}

export async function generateTurnIllustrationSegments(
  pool: DatabasePool,
  turnId: string,
  request: IllustrationSegmentRequest
) {
  const ownerUserId = await initialOwnerId(pool);
  return withTransaction(pool, (client) => createTurnSet(client, ownerUserId, turnId, request.mode));
}

export async function enqueueAcceptedTurnIllustrationSegments(
  client: DatabaseClient,
  ownerUserId: string,
  campaignId: string,
  turnId: string
) {
  const enabled = await client.query(
    `SELECT 1 FROM campaign_illustration_configs
      WHERE campaign_id = $1 AND owner_user_id = $2 AND enabled = true AND source_policy <> 'off'`,
    [campaignId, ownerUserId]
  );
  if (!enabled.rows[0]) return null;
  return createTurnSet(client, ownerUserId, turnId, "missing");
}

export async function previewIllustrationBackfill(
  pool: DatabasePool | DatabaseClient,
  campaignId: string,
  mode: "missing" | "rebuild"
) {
  const ownerUserId = await initialOwnerId(pool);
  const config = await loadConfig(pool, ownerUserId, campaignId);
  const turns = await pool.query<{ id: string; narration: string; has_set: boolean }>(
    `SELECT turns.id, turns.narration,
            EXISTS (
              SELECT 1 FROM turn_illustration_sets sets
               WHERE sets.turn_id = turns.id AND sets.owner_user_id = turns.owner_user_id AND sets.is_active
            ) AS has_set
       FROM turns
      WHERE turns.campaign_id = $1 AND turns.owner_user_id = $2
      ORDER BY turns.turn_number`,
    [campaignId, ownerUserId]
  );
  const affected = turns.rows.filter((turn) => mode === "rebuild" || !turn.has_set);
  const segmentCount = affected.reduce(
    (count, turn) => count + segmentIllustrationText(turn.narration, config.segment_word_count).length,
    0
  );
  return {
    campaignId,
    mode,
    turnCount: affected.length,
    segmentCount,
    imageCount: segmentCount * config.images_per_segment,
    providerRequestCount: segmentCount,
    refinementCallCount: config.segment_prompt_mode === "ai_refined" ? segmentCount : 0,
    configUpdatedAt: config.updated_at.toISOString(),
    totalCampaignTurns: turns.rows.length,
    settings: {
      segmentWordCount: config.segment_word_count,
      imagesPerSegment: config.images_per_segment,
      segmentPromptMode: config.segment_prompt_mode
    }
  };
}

export async function enqueueIllustrationBackfill(
  pool: DatabasePool,
  campaignId: string,
  request: IllustrationBackfillRequest
) {
  const ownerUserId = await initialOwnerId(pool);
  return withTransaction(pool, async (client) => {
    const duplicate = await client.query(
      `SELECT id, status, estimated_turns AS "turnCount", estimated_segments AS "segmentCount",
              estimated_images AS "imageCount", queued_sets AS "queuedSets"
         FROM illustration_backfill_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2 AND idempotency_key = $3`,
      [campaignId, ownerUserId, request.idempotencyKey]
    );
    if (duplicate.rows[0]) return { ...duplicate.rows[0], duplicate: true };
    const preview = await previewIllustrationBackfill(client, campaignId, request.mode);
    if (preview.configUpdatedAt !== request.expectedConfigUpdatedAt || preview.totalCampaignTurns !== request.expectedTurnCount) {
      throw Object.assign(new Error("Campaign turns or illustration settings changed after the estimate. Review the updated estimate."), { statusCode: 409 });
    }
    const turns = await client.query<{ id: string }>(
      `SELECT turns.id FROM turns
        WHERE turns.campaign_id = $1 AND turns.owner_user_id = $2
          AND ($3 = 'rebuild' OR NOT EXISTS (
            SELECT 1 FROM turn_illustration_sets sets
             WHERE sets.turn_id = turns.id AND sets.owner_user_id = turns.owner_user_id AND sets.is_active
          ))
        ORDER BY turns.turn_number`,
      [campaignId, ownerUserId, request.mode]
    );
    let queuedSets = 0;
    for (const turn of turns.rows) {
      const queued = await createTurnSet(client, ownerUserId, turn.id, request.mode);
      if (!queued.duplicate) queuedSets += 1;
    }
    const inserted = await client.query(
      `INSERT INTO illustration_backfill_jobs (
         owner_user_id, campaign_id, idempotency_key, mode, status, config_snapshot,
         estimated_turns, estimated_segments, estimated_images, queued_sets, completed_at
       ) VALUES ($1,$2,$3,$4,'completed',$5,$6,$7,$8,$9,now())
       RETURNING id, status, estimated_turns AS "turnCount", estimated_segments AS "segmentCount",
                 estimated_images AS "imageCount", queued_sets AS "queuedSets"`,
      [ownerUserId, campaignId, request.idempotencyKey, request.mode, JSON.stringify(preview.settings),
        preview.turnCount, preview.segmentCount, preview.imageCount, queuedSets]
    );
    return { ...inserted.rows[0], duplicate: false };
  });
}

export async function listCampaignIllustrationSegments(pool: DatabasePool, campaignId: string) {
  const ownerUserId = await initialOwnerId(pool);
  const rows = await pool.query(
    `SELECT sets.id AS "setId", sets.turn_id AS "turnId", sets.status AS "setStatus",
            sets.segment_word_count AS "segmentWordCount", sets.images_per_segment AS "imagesPerSegment",
            sets.prompt_mode AS "promptMode", segments.id, segments.ordinal,
            segments.start_offset AS "startOffset", segments.end_offset AS "endOffset",
            segments.start_word AS "startWord", segments.end_word AS "endWord",
            segments.source_text AS "text", segments.status, segments.prompt_source AS "promptSource",
            segments.direct_prompt AS "directPrompt", segments.resolved_prompt AS "resolvedPrompt",
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'assetId', assets.asset_id,
                'url', '/api/v1/assets/' || assets.asset_id::text,
                'variantIndex', assets.variant_index,
                'prompt', COALESCE(asset_jobs.prompt, segments.resolved_prompt, segments.direct_prompt),
                'providerType', asset_jobs.provider_type,
                'model', asset_jobs.requested_model,
                'createdAt', assets.created_at,
                'selectionReason', resolutions.reason_code,
                'matchScore', resolutions.selected_score::float8,
                'matchThreshold', resolutions.resolved_threshold::float8,
                'matchingAlgorithm', resolutions.matching_algorithm_version
              ) ORDER BY assets.variant_index)
                FROM turn_illustration_segment_assets assets
                LEFT JOIN image_jobs asset_jobs
                  ON asset_jobs.id = assets.image_job_id AND asset_jobs.owner_user_id = assets.owner_user_id
                LEFT JOIN LATERAL (
                  SELECT resolution.reason_code, resolution.selected_score,
                         resolution.resolved_threshold, resolution.matching_algorithm_version
                    FROM illustration_resolution_jobs resolution
                   WHERE resolution.segment_id = segments.id
                     AND resolution.owner_user_id = segments.owner_user_id
                     AND resolution.selected_asset_id = assets.asset_id
                   ORDER BY resolution.created_at DESC LIMIT 1
                ) resolutions ON true
               WHERE assets.segment_id = segments.id AND assets.owner_user_id = segments.owner_user_id
            ), '[]'::jsonb) AS variants,
            jobs.id AS "imageJobId", jobs.status AS "imageJobStatus",
            jobs.provider_status AS "providerStatus", jobs.provider_progress AS "providerProgress",
            jobs.error_message AS "errorMessage",
            prompts.status AS "promptJobStatus"
       FROM turn_illustration_sets sets
       JOIN turn_illustration_segments segments
         ON segments.illustration_set_id = sets.id AND segments.owner_user_id = sets.owner_user_id
       LEFT JOIN LATERAL (
         SELECT image_jobs.id, image_jobs.status, image_jobs.provider_status,
                image_jobs.provider_progress, image_jobs.error_message
           FROM image_jobs
          WHERE image_jobs.segment_id = segments.id AND image_jobs.owner_user_id = segments.owner_user_id
          ORDER BY image_jobs.created_at DESC LIMIT 1
       ) jobs ON true
       LEFT JOIN illustration_prompt_jobs prompts
         ON prompts.segment_id = segments.id AND prompts.owner_user_id = segments.owner_user_id
      WHERE sets.campaign_id = $1 AND sets.owner_user_id = $2 AND sets.is_active
      ORDER BY sets.turn_id, segments.ordinal`,
    [campaignId, ownerUserId]
  );
  return { segments: rows.rows };
}

export async function regenerateSegmentIllustration(
  pool: DatabasePool,
  segmentId: string,
  request: IllustrationSegmentImageRequest
) {
  const ownerUserId = await initialOwnerId(pool);
  return withTransaction(pool, async (client) => {
    const result = await client.query<SegmentRow & { images_per_segment: 1 | 2 }>(
      `SELECT segments.id, segments.owner_user_id, segments.campaign_id, segments.turn_id,
              segments.illustration_set_id, segments.source_text, segments.direct_prompt,
              segments.resolved_prompt, sets.images_per_segment
         FROM turn_illustration_segments segments
         JOIN turn_illustration_sets sets
           ON sets.id = segments.illustration_set_id AND sets.owner_user_id = segments.owner_user_id
         JOIN turns ON turns.id = segments.turn_id AND turns.owner_user_id = segments.owner_user_id
         JOIN campaigns ON campaigns.id = segments.campaign_id AND campaigns.owner_user_id = segments.owner_user_id
        WHERE segments.id = $1 AND segments.owner_user_id = $2 AND sets.is_active
          AND turns.turn_number = campaigns.active_turn_number
        FOR UPDATE OF segments`,
      [segmentId, ownerUserId]
    );
    const segment = result.rows[0];
    if (!segment) {
      throw Object.assign(new Error("Detailed image controls are available only for the current accepted turn."), { statusCode: 409 });
    }
    if (request.variantIndex >= segment.images_per_segment) {
      throw Object.assign(new Error("That illustration variant is not configured for this segment."), { statusCode: 409 });
    }
    if (containsMechanicsLanguage(request.prompt)) {
      throw Object.assign(new Error("The edited illustration prompt failed the fiction-only boundary."), { statusCode: 409 });
    }
    const active = await client.query<{ id: string }>(
      `SELECT id FROM image_jobs
        WHERE segment_id = $1 AND owner_user_id = $2
          AND status IN ('queued', 'generating', 'provider_pending', 'downloading')
          AND (
            provider_request_metadata->>'targetVariantIndex' IS NULL
            OR provider_request_metadata->>'targetVariantIndex' = $3
          )
        ORDER BY created_at DESC LIMIT 1`,
      [segmentId, ownerUserId, String(request.variantIndex)]
    );
    if (active.rows[0]) return { id: active.rows[0].id, duplicate: true, segmentId, variantIndex: request.variantIndex };
    const config = await loadConfig(client, ownerUserId, segment.campaign_id);
    const providerProfileId = await resolveEffectiveProviderId(
      client,
      ownerUserId,
      "image",
      config.provider_profile_id || config.campaign_image_provider_id
    );
    if (!providerProfileId) throw Object.assign(new Error("No enabled image provider is available for this segment."), { statusCode: 409 });
    const job = await insertImageJob(client, {
      ownerUserId,
      campaignId: segment.campaign_id,
      turnId: segment.turn_id,
      segmentId,
      targetVariantIndex: request.variantIndex,
      prompt: request.prompt,
      config: { ...imageConfig(config, providerProfileId), imagesPerSegment: 1 }
    });
    if (!job) throw Object.assign(new Error("The edited illustration prompt could not be queued."), { statusCode: 409 });
    await client.query(
      `UPDATE turn_illustration_segments SET status = 'generating', updated_at = now()
        WHERE id = $1 AND owner_user_id = $2`,
      [segmentId, ownerUserId]
    );
    return { id: job.id, duplicate: false, segmentId, variantIndex: request.variantIndex, status: "queued" };
  });
}

export async function removeSegmentIllustrationVariant(
  pool: DatabasePool,
  segmentId: string,
  variantIndex: number
) {
  const ownerUserId = await initialOwnerId(pool);
  const result = await pool.query<{ asset_id: string }>(
    `DELETE FROM turn_illustration_segment_assets assets
      USING turn_illustration_segments segments, turn_illustration_sets sets, turns, campaigns
      WHERE assets.segment_id = $1 AND assets.variant_index = $2 AND assets.owner_user_id = $3
        AND segments.id = assets.segment_id AND segments.owner_user_id = assets.owner_user_id
        AND sets.id = segments.illustration_set_id AND sets.owner_user_id = segments.owner_user_id AND sets.is_active
        AND turns.id = segments.turn_id AND turns.owner_user_id = segments.owner_user_id
        AND campaigns.id = segments.campaign_id AND campaigns.owner_user_id = segments.owner_user_id
        AND turns.turn_number = campaigns.active_turn_number
      RETURNING assets.asset_id`,
    [segmentId, variantIndex, ownerUserId]
  );
  if (!result.rows[0]) {
    throw Object.assign(new Error("This current-turn illustration variant is not available."), { statusCode: 404 });
  }
  return { segmentId, variantIndex, removedAssetId: result.rows[0].asset_id, retainedInLibrary: true };
}

export async function enqueueSegmentProviderImage(pool: DatabasePool, segmentId: string) {
  const ownerUserId = await initialOwnerId(pool);
  return withTransaction(pool, async (client) => {
    const result = await client.query<SegmentRow>(
      `SELECT id, owner_user_id, campaign_id, turn_id, illustration_set_id,
              source_text, direct_prompt, resolved_prompt
         FROM turn_illustration_segments
        WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
      [segmentId, ownerUserId]
    );
    const segment = result.rows[0];
    if (!segment) throw Object.assign(new Error("Illustration segment not found."), { statusCode: 404 });
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM image_jobs
        WHERE segment_id = $1 AND owner_user_id = $2
          AND status IN ('queued', 'generating', 'provider_pending', 'downloading', 'completed')
        ORDER BY created_at DESC LIMIT 1`,
      [segmentId, ownerUserId]
    );
    if (existing.rows[0]) return { id: existing.rows[0].id, duplicate: true };
    const config = await loadConfig(client, ownerUserId, segment.campaign_id);
    const providerProfileId = await resolveEffectiveProviderId(
      client,
      ownerUserId,
      "image",
      config.provider_profile_id || config.campaign_image_provider_id
    );
    if (!providerProfileId) throw Object.assign(new Error("No enabled image provider is available for segment generation."), { statusCode: 409 });
    const job = await insertImageJob(client, {
      ownerUserId,
      campaignId: segment.campaign_id,
      turnId: segment.turn_id,
      segmentId,
      prompt: segment.resolved_prompt || segment.direct_prompt,
      config: imageConfig(config, providerProfileId)
    });
    if (!job) throw Object.assign(new Error("The segment image job could not be created."), { statusCode: 409 });
    return { id: job.id, duplicate: false };
  });
}

export function parseRefinedPrompt(content: string): string {
  const normalized = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  let prompt = normalized;
  if (normalized.startsWith("{")) {
    const parsed = JSON.parse(normalized) as { image_prompt?: unknown };
    if (typeof parsed.image_prompt !== "string") throw new Error("Prompt refinement did not return image_prompt.");
    prompt = parsed.image_prompt.trim();
  }
  if (!prompt || prompt.length > 20_000 || containsMechanicsLanguage(prompt)) {
    throw new Error("Refined prompt failed the fiction-only boundary.");
  }
  return prompt;
}

type IllustrationStoryContext = {
  campaignTitle: string;
  worldContent: Record<string, unknown>;
  characterSnapshot: Record<string, unknown> | null;
  continuity: string;
  previousNarration: string;
};

function briefFictionText(value: unknown, maximumCharacters: number): string {
  if (typeof value !== "string") return "";
  return truncateAtBoundary(stripMechanicsLeakage(value).text.trim(), maximumCharacters);
}

export function buildBriefIllustrationStoryContext(context: IllustrationStoryContext): string {
  const overview = context.worldContent.world && typeof context.worldContent.world === "object"
    ? context.worldContent.world as Record<string, unknown>
    : context.worldContent;
  const characterName = briefFictionText(context.characterSnapshot?.name, 120);
  const characterDescription = briefFictionText(context.characterSnapshot?.characterText, 500);
  const lines = [
    briefFictionText(overview.title, 160) ? `World: ${briefFictionText(overview.title, 160)}` : "",
    briefFictionText(context.campaignTitle, 160) ? `Campaign: ${briefFictionText(context.campaignTitle, 160)}` : "",
    [briefFictionText(overview.genre, 100), briefFictionText(overview.tone, 160)].filter(Boolean).length
      ? `Genre and tone: ${[briefFictionText(overview.genre, 100), briefFictionText(overview.tone, 160)].filter(Boolean).join("; ")}`
      : "",
    briefFictionText(overview.premise, 420) ? `Premise: ${briefFictionText(overview.premise, 420)}` : "",
    characterName || characterDescription
      ? `Player character: ${[characterName, characterDescription].filter(Boolean).join(" — ")}`
      : "",
    briefFictionText(context.continuity, 360) ? `Continuity: ${briefFictionText(context.continuity, 360)}` : "",
    briefFictionText(context.previousNarration, 500) ? `Previous scene: ${briefFictionText(context.previousNarration, 500)}` : ""
  ].filter(Boolean);
  return truncateAtBoundary(lines.join("\n"), 1_800);
}

export function buildIllustrationRefinementInput(sourceText: string, storyContext: string): string {
  return [
    storyContext
      ? `STORY CONTEXT (use only to resolve established appearance, setting continuity, and tone; do not depict events from this context unless they occur in the excerpt):\n${storyContext}`
      : "",
    `FICTION EXCERPT TO ILLUSTRATE:\n${stripMechanicsLeakage(sourceText).text.trim()}`
  ].filter(Boolean).join("\n\n");
}

async function loadBriefIllustrationStoryContext(
  pool: DatabasePool,
  ownerUserId: string,
  campaignId: string,
  turnId: string
): Promise<string> {
  const result = await pool.query<{
    campaign_title: string;
    world_content: Record<string, unknown>;
    character_snapshot: Record<string, unknown> | null;
    continuity: string;
    previous_narration: string;
  }>(
    `SELECT campaigns.title AS campaign_title, world_versions.content AS world_content,
            campaigns.character_snapshot,
            CASE WHEN state.scratchpad_safe_for_prompt THEN state.scratchpad_private ELSE '' END AS continuity,
            COALESCE(previous.narration, '') AS previous_narration
       FROM turns target
       JOIN campaigns ON campaigns.id = target.campaign_id AND campaigns.owner_user_id = target.owner_user_id
       JOIN world_versions ON world_versions.id = campaigns.world_version_id AND world_versions.owner_user_id = campaigns.owner_user_id
       LEFT JOIN campaign_state state ON state.campaign_id = campaigns.id AND state.owner_user_id = campaigns.owner_user_id
       LEFT JOIN LATERAL (
         SELECT narration FROM turns
          WHERE campaign_id = target.campaign_id AND owner_user_id = target.owner_user_id
            AND turn_number < target.turn_number
          ORDER BY turn_number DESC LIMIT 1
       ) previous ON true
      WHERE target.id = $1 AND target.campaign_id = $2 AND target.owner_user_id = $3`,
    [turnId, campaignId, ownerUserId]
  );
  const row = result.rows[0];
  return row ? buildBriefIllustrationStoryContext({
    campaignTitle: row.campaign_title,
    worldContent: row.world_content,
    characterSnapshot: row.character_snapshot,
    continuity: row.continuity,
    previousNarration: row.previous_narration
  }) : "";
}

export async function runIllustrationPromptJob(
  pool: DatabasePool,
  workerId: string,
  leaseSeconds: number,
  credentialSecret: string
): Promise<boolean> {
  const claimed = await withTransaction(pool, async (client) => {
    const result = await client.query<any>(
      `WITH candidate AS (
         SELECT id FROM illustration_prompt_jobs
          WHERE (status IN ('queued', 'recoverable') AND next_attempt_at <= now())
             OR (status = 'refining' AND lease_expires_at < now())
          ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE illustration_prompt_jobs jobs
          SET status = 'refining', attempts = attempts + 1, lease_owner = $1,
              lease_expires_at = now() + ($2::text || ' seconds')::interval, updated_at = now()
         FROM candidate WHERE jobs.id = candidate.id
       RETURNING jobs.*`,
      [workerId, leaseSeconds]
    );
    return result.rows[0] || null;
  });
  if (!claimed) return false;
  const segmentResult = await pool.query<SegmentRow>(
    `SELECT id, owner_user_id, campaign_id, turn_id, illustration_set_id,
            source_text, direct_prompt, resolved_prompt
       FROM turn_illustration_segments WHERE id = $1 AND owner_user_id = $2`,
    [claimed.segment_id, claimed.owner_user_id]
  );
  const segment = segmentResult.rows[0];
  if (!segment) return true;
  try {
    const provider = await loadTextProvider(
      pool,
      claimed.owner_user_id,
      claimed.provider_profile_id,
      credentialSecret,
      claimed.requested_model
    );
    const config = await loadConfig(pool, claimed.owner_user_id, claimed.campaign_id);
    const storyContext = await loadBriefIllustrationStoryContext(
      pool,
      claimed.owner_user_id,
      claimed.campaign_id,
      claimed.turn_id
    );
    const result = await callTextProvider(provider, {
      systemPrompt: config.refinement_prompt.trim() || DEFAULT_ILLUSTRATION_REFINEMENT_PROMPT,
      input: buildIllustrationRefinementInput(segment.source_text, storyContext)
    });
    const prompt = parseRefinedPrompt(result.content);
    await withTransaction(pool, async (client) => {
      const currentConfig = await loadConfig(client, claimed.owner_user_id, claimed.campaign_id);
      await queueSegmentDelivery(client, claimed.owner_user_id, segment, currentConfig, prompt, "ai_refined");
      await client.query(
        `UPDATE illustration_prompt_jobs
            SET status = 'completed', response_id = $3, completed_at = now(), updated_at = now(),
                lease_owner = NULL, lease_expires_at = NULL, error_code = NULL, error_message = NULL
          WHERE id = $1 AND lease_owner = $2`,
        [claimed.id, workerId, result.responseId]
      );
      await recordProfileCost(client, provider, {
        ownerUserId: claimed.owner_user_id,
        campaignId: claimed.campaign_id,
        turnId: claimed.turn_id,
        category: "image",
        operation: "illustration_prompt_refinement",
        localCallId: claimed.id
      }, result);
    });
  } catch (error) {
    logProviderTransportError(error, {
      campaignId: claimed.campaign_id,
      providerProfileId: claimed.provider_profile_id,
      storyOperation: "illustration_prompt_refinement"
    });
    await withTransaction(pool, async (client) => {
      if (claimed.attempts >= claimed.max_attempts) {
        const config = await loadConfig(client, claimed.owner_user_id, claimed.campaign_id);
        await queueSegmentDelivery(client, claimed.owner_user_id, segment, config, segment.direct_prompt, "ai_fallback");
        await client.query(
          `UPDATE illustration_prompt_jobs
              SET status = 'fallback', completed_at = now(), updated_at = now(),
                  error_code = 'refinement_exhausted', error_message = $3,
                  lease_owner = NULL, lease_expires_at = NULL
            WHERE id = $1 AND lease_owner = $2`,
          [claimed.id, workerId, error instanceof Error ? error.message.slice(0, 4000) : String(error).slice(0, 4000)]
        );
      } else {
        await client.query(
          `UPDATE illustration_prompt_jobs
              SET status = 'recoverable', next_attempt_at = now() + interval '15 seconds',
                  error_code = 'refinement_failed', error_message = $3,
                  lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
            WHERE id = $1 AND lease_owner = $2`,
          [claimed.id, workerId, error instanceof Error ? error.message.slice(0, 4000) : String(error).slice(0, 4000)]
        );
      }
    });
  }
  return true;
}
