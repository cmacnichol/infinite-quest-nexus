import type { DatabaseClient, DatabasePool } from "../../../packages/database/src/pool.js";
import { initialOwnerId, withTransaction } from "../../../packages/database/src/pool.js";
import type {
  CampaignTransferCommitRequest,
  CampaignTransferFinding,
  CampaignTransferPreviewRequest
} from "../../../packages/contracts/src/campaign-transfer.js";
import { worldContentSchema, type WorldContent } from "../../../packages/contracts/src/world-library.js";
import { assessCampaignTransferCompatibility } from "../../../packages/domain/src/campaign-transfer.js";
import { removeProviderSecrets, sha256, stableStringify } from "../../../packages/domain/src/text.js";
import { enqueueEmbeddingReindex, rebuildCampaignMemories } from "./memory-service.js";

function json(value: unknown): string { return JSON.stringify(value ?? null); }
function httpError(statusCode: number, message: string, details?: unknown): Error {
  return Object.assign(new Error(message), { statusCode, ...(details === undefined ? {} : { details }) });
}

function transferableLegacySettings(value: Record<string, unknown>): Record<string, unknown> {
  const sanitize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(sanitize);
    if (!candidate || typeof candidate !== "object") return candidate;
    return Object.fromEntries(Object.entries(candidate as Record<string, unknown>).flatMap(([key, entry]) => {
      const normalized = key.replaceAll(/[^a-z]/gi, "").toLocaleLowerCase();
      const sensitive = /(?:apikey|password|authorization|credential|secret|endpoint|baseurl|providerurl)/.test(normalized)
        || /^(?:token|accesstoken|refreshtoken)$/.test(normalized);
      return sensitive ? [] : [[key, sanitize(entry)]];
    }));
  };
  return sanitize(removeProviderSecrets(value)) as Record<string, unknown>;
}

type SourceRow = {
  id: string;
  title: string;
  status: string;
  active_turn_number: number;
  story_length_profile: string;
  turn_control_style: string;
  selected_character_id: string | null;
  character_snapshot: Record<string, unknown> | null;
  legacy_settings: Record<string, unknown>;
  text_provider_profile_id: string | null;
  image_provider_profile_id: string | null;
  world_version_id: string;
  world_id: string;
  world_title: string;
  world_version_number: number;
  world_content: unknown;
  state_revision: number;
  scratchpad_private: string;
  scratchpad_safe_for_prompt: boolean;
  trackers: unknown[];
  default_triggers: unknown[];
  event_triggers: unknown[];
  pending_event_triggers: unknown[];
  rpg_stats: unknown[];
  import_provenance: Record<string, unknown>;
  initial_state_snapshot: Record<string, unknown>;
  state_updated_at: Date;
  campaign_updated_at: Date;
  latest_turn_id: string | null;
};

type TargetRow = {
  id: string;
  world_id: string;
  world_title: string;
  world_status: string;
  version_number: number;
  content: unknown;
};

async function loadSource(client: DatabaseClient | DatabasePool, ownerUserId: string, campaignId: string, lock = false): Promise<SourceRow> {
  const result = await client.query<SourceRow>(
    `SELECT c.id, c.title, c.status, c.active_turn_number, c.story_length_profile, c.turn_control_style,
            c.selected_character_id, c.character_snapshot, c.legacy_settings,
            c.text_provider_profile_id, c.image_provider_profile_id, c.world_version_id,
            w.id AS world_id, w.title AS world_title, wv.version_number AS world_version_number,
            wv.content AS world_content, cs.revision AS state_revision,
            cs.scratchpad_private, cs.scratchpad_safe_for_prompt, cs.trackers,
            cs.default_triggers, cs.event_triggers, cs.pending_event_triggers, cs.rpg_stats,
            cs.import_provenance, cs.initial_state_snapshot, cs.updated_at AS state_updated_at,
            c.updated_at AS campaign_updated_at,
            (SELECT t.id FROM turns t WHERE t.owner_user_id = c.owner_user_id AND t.campaign_id = c.id
              ORDER BY t.turn_number DESC LIMIT 1) AS latest_turn_id
       FROM campaigns c
       JOIN campaign_state cs ON cs.campaign_id = c.id AND cs.owner_user_id = c.owner_user_id
       JOIN world_versions wv ON wv.id = c.world_version_id AND wv.owner_user_id = c.owner_user_id
       JOIN worlds w ON w.id = wv.world_id AND w.owner_user_id = c.owner_user_id
      WHERE c.id = $1 AND c.owner_user_id = $2${lock ? " FOR UPDATE OF c, cs" : ""}`,
    [campaignId, ownerUserId]
  );
  const source = result.rows[0];
  if (!source) throw httpError(404, "Campaign not found.");
  return source;
}

async function loadTarget(client: DatabaseClient | DatabasePool, ownerUserId: string, targetWorldVersionId: string): Promise<TargetRow> {
  const result = await client.query<TargetRow>(
    `SELECT wv.id, wv.world_id, w.title AS world_title, w.status AS world_status,
            wv.version_number, wv.content
       FROM world_versions wv
       JOIN worlds w ON w.id = wv.world_id AND w.owner_user_id = wv.owner_user_id
      WHERE wv.id = $1 AND wv.owner_user_id = $2`,
    [targetWorldVersionId, ownerUserId]
  );
  const target = result.rows[0];
  if (!target) throw httpError(404, "Target world version not found.");
  return target;
}

function fingerprint(source: SourceRow, targetWorldVersionId: string, request: CampaignTransferPreviewRequest): string {
  return sha256(stableStringify({
    campaignId: source.id,
    title: source.title,
    status: source.status,
    activeTurnNumber: source.active_turn_number,
    stateRevision: source.state_revision,
    stateUpdatedAt: source.state_updated_at.toISOString(),
    campaignUpdatedAt: source.campaign_updated_at.toISOString(),
    latestTurnId: source.latest_turn_id,
    worldVersionId: source.world_version_id,
    targetWorldVersionId,
    requestedTitle: request.title || null,
    characterStrategy: request.characterStrategy,
    stateStrategy: request.stateStrategy,
    targetDefaultsPolicy: request.targetDefaultsPolicy
  }));
}

async function operationalCounts(client: DatabaseClient | DatabasePool, ownerUserId: string, campaignId: string) {
  const result = await client.query<{
    turn_count: number;
    state_edit_count: number;
    summary_count: number;
    asset_count: number;
    active_generation_count: number;
    active_image_count: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM turns WHERE owner_user_id = $1 AND campaign_id = $2) AS turn_count,
       (SELECT count(*)::int FROM campaign_state_edits WHERE owner_user_id = $1 AND campaign_id = $2) AS state_edit_count,
       (SELECT count(*)::int FROM summary_checkpoints WHERE owner_user_id = $1 AND campaign_id = $2) AS summary_count,
       (SELECT count(*)::int FROM asset_references WHERE owner_user_id = $1 AND campaign_id = $2) AS asset_count,
       (SELECT count(*)::int FROM generation_jobs WHERE owner_user_id = $1 AND campaign_id = $2
          AND status IN ('queued','replacement_queued','assessing','generating','validating','committing','recoverable')) AS active_generation_count,
       (SELECT count(*)::int FROM image_jobs WHERE owner_user_id = $1 AND campaign_id = $2
          AND status IN ('queued','generating','recoverable')) AS active_image_count`,
    [ownerUserId, campaignId]
  );
  return result.rows[0]!;
}

function compatibility(source: SourceRow, target: TargetRow, counts: Awaited<ReturnType<typeof operationalCounts>>): CampaignTransferFinding[] {
  const sourceContent = worldContentSchema.parse(source.world_content);
  const targetContent = worldContentSchema.parse(target.content);
  return assessCampaignTransferCompatibility({
    sourceWorldId: source.world_id,
    targetWorldId: target.world_id,
    targetWorldStatus: target.world_status,
    sourceContent,
    targetContent,
    selectedCharacterId: source.selected_character_id,
    characterSnapshot: source.character_snapshot,
    campaignState: {
      rpgStats: source.rpg_stats,
      defaultTriggers: source.default_triggers,
      eventTriggers: source.event_triggers
    },
    activeGenerationJobs: counts.active_generation_count,
    activeImageJobs: counts.active_image_count
  });
}

export async function previewCampaignWorldTransfer(pool: DatabasePool, campaignId: string, request: CampaignTransferPreviewRequest) {
  const ownerUserId = await initialOwnerId(pool);
  const [source, target, counts] = await Promise.all([
    loadSource(pool, ownerUserId, campaignId),
    loadTarget(pool, ownerUserId, request.targetWorldVersionId),
    operationalCounts(pool, ownerUserId, campaignId)
  ]);
  const findings = compatibility(source, target, counts);
  const targetContent: WorldContent = worldContentSchema.parse(target.content);
  const snapshotName = typeof source.character_snapshot?.name === "string" ? source.character_snapshot.name : null;
  return {
    allowed: !findings.some((finding) => finding.severity === "blocking"),
    source: {
      campaignId: source.id,
      campaignTitle: source.title,
      worldId: source.world_id,
      worldTitle: source.world_title,
      worldVersionId: source.world_version_id,
      worldVersionNumber: source.world_version_number
    },
    target: {
      worldId: target.world_id,
      worldTitle: target.world_title,
      worldVersionId: target.id,
      worldVersionNumber: target.version_number
    },
    proposedTitle: request.title || `${source.title} (${target.world_title})`,
    counts: {
      turns: counts.turn_count,
      stateEdits: counts.state_edit_count,
      summaries: counts.summary_count,
      assets: counts.asset_count
    },
    character: {
      id: source.selected_character_id,
      name: snapshotName,
      targetMatches: targetContent.playableCharacters.filter((character) => (
        character.id === source.selected_character_id || (snapshotName && character.name.toLocaleLowerCase() === snapshotName.toLocaleLowerCase())
      )).map((character) => ({ id: character.id, name: character.name }))
    },
    findings,
    expectedActiveTurnNumber: source.active_turn_number,
    expectedStateRevision: source.state_revision,
    sourceFingerprint: fingerprint(source, target.id, request)
  };
}

async function insertCampaignClone(
  client: DatabaseClient,
  ownerUserId: string,
  source: SourceRow,
  target: TargetRow,
  title: string,
  transferId: string
): Promise<{ campaignId: string; memoryCount: number; embeddingJobId: string | null }> {
  const campaignResult = await client.query<{ id: string }>(
    `INSERT INTO campaigns (
       owner_user_id, world_version_id, title, status, active_turn_number, story_length_profile, turn_control_style,
       selected_character_id, character_snapshot, legacy_settings, text_provider_profile_id, image_provider_profile_id
     ) VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [ownerUserId, target.id, title, source.active_turn_number, source.story_length_profile, source.turn_control_style,
      source.selected_character_id, json(source.character_snapshot), json(transferableLegacySettings(source.legacy_settings)),
      source.text_provider_profile_id, source.image_provider_profile_id]
  );
  const campaignId = campaignResult.rows[0]?.id;
  if (!campaignId) throw new Error("Could not create the transferred campaign.");
  const provenance = {
    ...(source.import_provenance || {}),
    transfer: { type: "nexus_world_transfer", transferId, sourceCampaignId: source.id, sourceWorldVersionId: source.world_version_id }
  };
  await client.query(
    `INSERT INTO campaign_state (
       campaign_id, owner_user_id, scratchpad_private, scratchpad_safe_for_prompt, trackers,
       default_triggers, event_triggers, pending_event_triggers, rpg_stats, import_provenance,
       initial_state_snapshot, revision
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [campaignId, ownerUserId, source.scratchpad_private, source.scratchpad_safe_for_prompt,
      json(source.trackers), json(source.default_triggers), json(source.event_triggers),
      json(source.pending_event_triggers), json(source.rpg_stats), json(provenance),
      json(source.initial_state_snapshot), source.state_revision]
  );
  await client.query(
    `INSERT INTO campaign_state_edits (
       owner_user_id, campaign_id, effective_turn_number, revision, state_snapshot_private, changed_fields, created_at
     ) SELECT owner_user_id, $1, effective_turn_number, revision, state_snapshot_private, changed_fields, created_at
         FROM campaign_state_edits WHERE owner_user_id = $2 AND campaign_id = $3 ORDER BY revision`,
    [campaignId, ownerUserId, source.id]
  );

  const sourceTurns = await client.query<Record<string, any>>(
    `SELECT * FROM turns WHERE owner_user_id = $1 AND campaign_id = $2 ORDER BY turn_number`,
    [ownerUserId, source.id]
  );
  const turnIds = new Map<string, string>();
  for (const turn of sourceTurns.rows) {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO turns (
         campaign_id, owner_user_id, turn_number, source_turn_id, action, input_mode, input_mode_source, narration, choices,
         custom_action_suggestion, image_prompt, image_url, mechanics_private, state_snapshot_private,
         model_metadata, import_metadata, accepted_at, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
      [campaignId, ownerUserId, turn.turn_number, turn.source_turn_id, turn.action,
        turn.input_mode || "action", turn.input_mode_source || "explicit", turn.narration,
        json(turn.choices), turn.custom_action_suggestion, turn.image_prompt, turn.image_url,
        json(turn.mechanics_private), json(turn.state_snapshot_private), json(turn.model_metadata),
        json(turn.import_metadata), turn.accepted_at, turn.created_at]
    );
    turnIds.set(turn.id, inserted.rows[0]!.id);
  }
  await client.query(
    `INSERT INTO summary_checkpoints (owner_user_id, campaign_id, through_turn, summary_kind, content, token_estimate, created_at)
     SELECT owner_user_id, $1, through_turn, summary_kind, content, token_estimate, created_at
       FROM summary_checkpoints WHERE owner_user_id = $2 AND campaign_id = $3`,
    [campaignId, ownerUserId, source.id]
  );
  await client.query(
    `INSERT INTO campaign_illustration_configs (
       campaign_id, owner_user_id, enabled, provider_profile_id, model, size, aspect_ratio, quality, output_format, max_attempts, created_at, updated_at
     ) SELECT $1, owner_user_id, enabled, provider_profile_id, model, size, aspect_ratio, quality, output_format, max_attempts, created_at, updated_at
         FROM campaign_illustration_configs WHERE owner_user_id = $2 AND campaign_id = $3`,
    [campaignId, ownerUserId, source.id]
  );
  await client.query(
    `INSERT INTO campaign_memory_configs (
       campaign_id, owner_user_id, embedding_enabled, embedding_provider_profile_id, embedding_model,
       embedding_batch_size, embedding_document_prefix, embedding_query_prefix, created_at, updated_at
     ) SELECT $1, owner_user_id, embedding_enabled, embedding_provider_profile_id, embedding_model,
              embedding_batch_size, embedding_document_prefix, embedding_query_prefix, created_at, updated_at
         FROM campaign_memory_configs WHERE owner_user_id = $2 AND campaign_id = $3`,
    [campaignId, ownerUserId, source.id]
  );
  const references = await client.query<{ asset_id: string; turn_id: string | null; asset_role: string; created_at: Date }>(
    `SELECT asset_id, turn_id, asset_role, created_at FROM asset_references
      WHERE owner_user_id = $1 AND campaign_id = $2 ORDER BY created_at`,
    [ownerUserId, source.id]
  );
  for (const reference of references.rows) {
    const mappedTurnId = reference.turn_id ? turnIds.get(reference.turn_id) : null;
    if (reference.turn_id && !mappedTurnId) throw new Error("Could not map a transferred asset reference to its turn.");
    await client.query(
      `INSERT INTO asset_references (owner_user_id, asset_id, campaign_id, turn_id, asset_role, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [ownerUserId, reference.asset_id, campaignId, mappedTurnId, reference.asset_role, reference.created_at]
    );
  }
  const memoryCount = await rebuildCampaignMemories(client, ownerUserId, campaignId);
  const embeddingJobId = await enqueueEmbeddingReindex(client, campaignId);
  return { campaignId, memoryCount, embeddingJobId };
}

async function existingTransferResult(client: DatabaseClient, ownerUserId: string, idempotencyKey: string) {
  const result = await client.query<{
    id: string;
    source_campaign_id: string | null;
    target_campaign_id: string | null;
    from_world_version_id: string;
    to_world_version_id: string;
    target_world_id: string;
    source_fingerprint: string;
    warnings: CampaignTransferFinding[];
  }>(
    `SELECT cwt.id, cwt.source_campaign_id, cwt.target_campaign_id, cwt.from_world_version_id,
            cwt.to_world_version_id, cwt.source_fingerprint, cwt.warnings, wv.world_id AS target_world_id
       FROM campaign_world_transfers cwt
       JOIN world_versions wv ON wv.id = cwt.to_world_version_id AND wv.owner_user_id = cwt.owner_user_id
      WHERE cwt.owner_user_id = $1 AND cwt.idempotency_key = $2`,
    [ownerUserId, idempotencyKey]
  );
  const transfer = result.rows[0];
  if (!transfer) return null;
  if (!transfer.source_campaign_id || !transfer.target_campaign_id) {
    throw httpError(409, "The prior transfer result is no longer available.");
  }
  const campaign = await client.query<{ active_turn_number: number }>(
    "SELECT active_turn_number FROM campaigns WHERE owner_user_id = $1 AND id = $2",
    [ownerUserId, transfer.target_campaign_id]
  );
  if (!campaign.rows[0]) throw httpError(409, "The prior transferred campaign no longer exists.");
  const memory = await client.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM chronicle_memories WHERE owner_user_id = $1 AND campaign_id = $2",
    [ownerUserId, transfer.target_campaign_id]
  );
  const job = await client.query<{ id: string }>(
    `SELECT id FROM chronicle_jobs WHERE owner_user_id = $1 AND campaign_id = $2 AND job_type = 'embed_campaign'
      ORDER BY created_at DESC LIMIT 1`,
    [ownerUserId, transfer.target_campaign_id]
  );
  return {
    transferId: transfer.id,
    sourceCampaignId: transfer.source_campaign_id,
    targetCampaignId: transfer.target_campaign_id,
    fromWorldVersionId: transfer.from_world_version_id,
    targetWorldId: transfer.target_world_id,
    targetWorldVersionId: transfer.to_world_version_id,
    sourceFingerprint: transfer.source_fingerprint,
    activeTurnNumber: campaign.rows[0].active_turn_number,
    chronicleMemoryCount: memory.rows[0]?.count || 0,
    embeddingJobId: job.rows[0]?.id || null,
    warnings: transfer.warnings,
    reused: true
  };
}

export async function transferCampaignWorld(pool: DatabasePool, campaignId: string, request: CampaignTransferCommitRequest) {
  return withTransaction(pool, async (client) => {
    const ownerUserId = await initialOwnerId(client);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${ownerUserId}:${request.idempotencyKey}`]);
    const existing = await existingTransferResult(client, ownerUserId, request.idempotencyKey);
    if (existing) {
      if (existing.sourceCampaignId !== campaignId
        || existing.targetWorldVersionId !== request.targetWorldVersionId
        || existing.sourceFingerprint !== request.sourceFingerprint) {
        throw httpError(409, "The idempotency key was already used for a different transfer.");
      }
      return existing;
    }
    const source = await loadSource(client, ownerUserId, campaignId, true);
    const target = await loadTarget(client, ownerUserId, request.targetWorldVersionId);
    const counts = await operationalCounts(client, ownerUserId, campaignId);
    const findings = compatibility(source, target, counts);
    const blockers = findings.filter((finding) => finding.severity === "blocking");
    if (blockers.length) throw httpError(409, "The campaign cannot be transferred in its current state.", { findings });
    const currentFingerprint = fingerprint(source, target.id, request);
    if (source.active_turn_number !== request.expectedActiveTurnNumber
      || source.state_revision !== request.expectedStateRevision
      || currentFingerprint !== request.sourceFingerprint) {
      throw httpError(409, "The campaign changed after the transfer preview. Preview it again.");
    }
    const transferId = crypto.randomUUID();
    const title = request.title || `${source.title} (${target.world_title})`;
    const clone = await insertCampaignClone(client, ownerUserId, source, target, title, transferId);
    const warnings = findings.filter((finding) => finding.severity !== "blocking");
    await client.query(
      `INSERT INTO campaign_world_transfers (
         id, owner_user_id, idempotency_key, source_campaign_id, target_campaign_id,
         from_world_version_id, to_world_version_id, character_strategy, state_strategy,
         target_defaults_policy, source_fingerprint, warnings, note
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [transferId, ownerUserId, request.idempotencyKey, source.id, clone.campaignId,
        source.world_version_id, target.id, request.characterStrategy, request.stateStrategy,
        request.targetDefaultsPolicy, currentFingerprint, json(warnings), request.note]
    );
    const details = json({
      transferId,
      sourceCampaignId: source.id,
      targetCampaignId: clone.campaignId,
      fromWorldVersionId: source.world_version_id,
      toWorldVersionId: target.id,
      copiedTurns: counts.turn_count,
      copiedStateEdits: counts.state_edit_count,
      copiedAssetReferences: counts.asset_count,
      compatibilityCodes: warnings.map((finding) => finding.code)
    });
    await client.query(
      `INSERT INTO activity_events (owner_user_id, campaign_id, event_type, correlation_id, details)
       VALUES ($1,$2,'campaign_world_transfer_source',$3,$4),
              ($1,$5,'campaign_world_transfer_target',$3,$4)`,
      [ownerUserId, source.id, transferId, details, clone.campaignId]
    );
    return {
      transferId,
      sourceCampaignId: source.id,
      targetCampaignId: clone.campaignId,
      fromWorldVersionId: source.world_version_id,
      targetWorldId: target.world_id,
      targetWorldVersionId: target.id,
      activeTurnNumber: source.active_turn_number,
      chronicleMemoryCount: clone.memoryCount,
      embeddingJobId: clone.embeddingJobId,
      warnings,
      reused: false
    };
  });
}
