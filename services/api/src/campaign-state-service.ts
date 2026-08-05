import {
  campaignRuntimeStateContentSchema,
  campaignRuntimeStateSchema,
  type CampaignRuntimeStateContent,
  type CampaignRuntimeStateUpdate
} from "../../../packages/contracts/src/generation.js";
import { initialOwnerId, withTransaction, type DatabaseClient, type DatabasePool } from "../../../packages/database/src/pool.js";
import { normalizeCampaignTrackers } from "../../../packages/domain/src/campaign-trackers.js";
import { containsMechanicsLanguage } from "../../../packages/domain/src/text.js";
import { memoryApplicationForPool } from "./memory-application-adapter.js";

type EffectiveCampaignStateEdit = {
  id: string;
  revision: number;
  effectiveTurnNumber: number;
  snapshot: CampaignRuntimeStateContent;
};

type CanonicalFactRow = {
  id: string;
  content: string;
  source_turn_number: number;
};
import { loadOrNotFound } from "./service-helpers.js";

function json(value: unknown): string {
  return JSON.stringify(value);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function runtimeStateContent(snapshot: unknown, canonicalFacts: Array<{ id: string | null; content: string }> = []): CampaignRuntimeStateContent {
  const source = objectValue(snapshot);
  const legacyFacts = Array.isArray(source.canonicalFacts)
    ? source.canonicalFacts.flatMap((fact) => {
      if (typeof fact === "string") return [{ id: null, content: fact }];
      if (!fact || typeof fact !== "object" || Array.isArray(fact)) return [];
      const item = fact as Record<string, unknown>;
      return typeof item.content === "string" ? [{ id: typeof item.id === "string" ? item.id : null, content: item.content }] : [];
    })
    : [];
  return campaignRuntimeStateContentSchema.parse({
    continuitySummary: typeof source.continuitySummary === "string" ? source.continuitySummary : "",
    openThreads: strings(source.openThreads),
    canonicalFacts: canonicalFacts.length ? canonicalFacts : legacyFacts,
    scratchpad: typeof source.scratchpad === "string" ? source.scratchpad : "",
    trackers: normalizeCampaignTrackers(source.trackers),
    rpgStats: Array.isArray(source.rpgStats) ? source.rpgStats : [],
    eventTriggers: Array.isArray(source.eventTriggers) ? source.eventTriggers : [],
    pendingEventTriggers: Array.isArray(source.pendingEventTriggers) ? source.pendingEventTriggers : []
  });
}

async function activeCanonicalFacts(
  client: DatabaseClient | DatabasePool,
  ownerUserId: string,
  campaignId: string,
  throughTurnNumber: number
): Promise<CanonicalFactRow[]> {
  const result = await client.query<CanonicalFactRow>(
    `SELECT id, content, source_turn_number
       FROM campaign_canonical_facts
      WHERE owner_user_id = $1 AND campaign_id = $2
        AND valid_from_turn <= $3
        AND (valid_until_turn IS NULL OR valid_until_turn > $3)
      ORDER BY source_turn_number, source_fact_index`,
    [ownerUserId, campaignId, throughTurnNumber]
  );
  return result.rows;
}

export async function loadEffectiveCampaignStateEdit(
  client: DatabaseClient | DatabasePool,
  ownerUserId: string,
  campaignId: string,
  throughTurnNumber: number
): Promise<EffectiveCampaignStateEdit | null> {
  const result = await client.query<{
    id: string;
    revision: number;
    effective_turn_number: number;
    state_snapshot_private: Record<string, unknown>;
  }>(
    `SELECT id, revision, effective_turn_number, state_snapshot_private
       FROM campaign_state_edits
      WHERE owner_user_id = $1 AND campaign_id = $2
        AND effective_turn_number <= $3
      ORDER BY effective_turn_number DESC, revision DESC
      LIMIT 1`,
    [ownerUserId, campaignId, throughTurnNumber]
  );
  const row = result.rows[0];
  return row ? {
    id: row.id,
    revision: row.revision,
    effectiveTurnNumber: row.effective_turn_number,
    snapshot: runtimeStateContent(row.state_snapshot_private)
  } : null;
}

export async function getCampaignRuntimeState(pool: DatabasePool, campaignId: string, requestedTurnNumber?: number) {
  const ownerUserId = await initialOwnerId(pool);
  const result = await pool.query<{
    active_turn_number: number;
    scratchpad_private: string;
    trackers: unknown;
    rpg_stats: unknown;
    event_triggers: unknown;
    pending_event_triggers: unknown;
    initial_state_snapshot: Record<string, unknown>;
    revision: number;
    updated_at: Date | string;
  }>(
    `SELECT c.active_turn_number, cs.scratchpad_private, cs.trackers, cs.rpg_stats,
            cs.event_triggers, cs.pending_event_triggers, cs.initial_state_snapshot,
            cs.revision, cs.updated_at
       FROM campaigns c
       JOIN campaign_state cs ON cs.campaign_id = c.id AND cs.owner_user_id = c.owner_user_id
      WHERE c.id = $1 AND c.owner_user_id = $2`,
    [campaignId, ownerUserId]
  );
  const row = loadOrNotFound(result, "Campaign");
  const turnNumber = requestedTurnNumber === undefined ? row.active_turn_number : requestedTurnNumber;
  if (!Number.isInteger(turnNumber) || turnNumber < 0 || turnNumber > row.active_turn_number) {
    throw Object.assign(new Error(`Campaign has only ${row.active_turn_number} accepted turns.`), { statusCode: 409 });
  }

  const historical = turnNumber > 0
    ? await pool.query<{ state_snapshot_private: Record<string, unknown>; accepted_at: Date | string }>(
      `SELECT state_snapshot_private, accepted_at FROM turns
        WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_number = $3`,
      [campaignId, ownerUserId, turnNumber]
    )
    : null;
  if (turnNumber > 0 && !historical?.rows[0]) throw Object.assign(new Error("Turn state was not found."), { statusCode: 404 });
  const baseSnapshot = turnNumber === 0 ? row.initial_state_snapshot : historical?.rows[0]?.state_snapshot_private;
  const exactEdit = await loadEffectiveCampaignStateEdit(pool, ownerUserId, campaignId, turnNumber);
  const isExactEdit = exactEdit?.effectiveTurnNumber === turnNumber;
  const canonicalFacts = isExactEdit
    ? exactEdit.snapshot.canonicalFacts
    : (await activeCanonicalFacts(pool, ownerUserId, campaignId, turnNumber)).map((fact) => ({ id: fact.id, content: fact.content }));
  const materializedCurrentSnapshot = turnNumber === row.active_turn_number && !isExactEdit
    ? {
      ...objectValue(baseSnapshot),
      scratchpad: row.scratchpad_private,
      trackers: row.trackers,
      rpgStats: row.rpg_stats,
      eventTriggers: row.event_triggers,
      pendingEventTriggers: row.pending_event_triggers
    }
    : baseSnapshot;
  const content = isExactEdit
    ? exactEdit.snapshot
    : runtimeStateContent(materializedCurrentSnapshot, canonicalFacts);
  return campaignRuntimeStateSchema.parse({
    campaignId,
    activeTurnNumber: row.active_turn_number,
    viewedTurnNumber: turnNumber,
    isCurrent: turnNumber === row.active_turn_number,
    revision: row.revision,
    updatedAt: isExactEdit ? (await pool.query<{ created_at: Date | string }>(
      "SELECT created_at FROM campaign_state_edits WHERE id = $1", [exactEdit.id]
    )).rows[0]?.created_at ?? row.updated_at : historical?.rows[0]?.accepted_at ?? row.updated_at,
    ...content
  });
}

function fictionFields(content: CampaignRuntimeStateContent): string[] {
  return [
    content.continuitySummary,
    ...content.openThreads,
    ...content.canonicalFacts.map((fact) => fact.content),
    content.scratchpad,
    ...content.trackers.flatMap((tracker) => [tracker.name, tracker.value, tracker.rules])
  ];
}

export async function updateCampaignRuntimeState(pool: DatabasePool, campaignId: string, request: CampaignRuntimeStateUpdate) {
  const content = campaignRuntimeStateContentSchema.parse(request);
  if (fictionFields(content).some(containsMechanicsLanguage)) {
    throw Object.assign(new Error("Edited continuity fields must contain fiction only, without game mechanics or engine diagnostics."), { statusCode: 400 });
  }
  const ownerUserId = await initialOwnerId(pool);
  await withTransaction(pool, async (client) => {
    const campaignResult = await client.query<{ active_turn_number: number; world_version_id: string }>(
      `SELECT active_turn_number, world_version_id FROM campaigns WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
      [campaignId, ownerUserId]
    );
    const campaign = loadOrNotFound(campaignResult, "Campaign");
    const stateResult = await client.query<{
      revision: number;
      scratchpad_private: string;
      trackers: unknown;
      rpg_stats: unknown;
      event_triggers: unknown;
      pending_event_triggers: unknown;
      initial_state_snapshot: Record<string, unknown>;
    }>(
      `SELECT revision, scratchpad_private, trackers, rpg_stats, event_triggers, pending_event_triggers, initial_state_snapshot
         FROM campaign_state WHERE campaign_id = $1 AND owner_user_id = $2 FOR UPDATE`,
      [campaignId, ownerUserId]
    );
    const current = stateResult.rows[0];
    if (!current) throw Object.assign(new Error("Campaign state was not found."), { statusCode: 404 });
    if (campaign.active_turn_number !== request.expectedTurnNumber || current.revision !== request.expectedRevision) {
      throw Object.assign(new Error("Campaign state changed after this editor was opened. Reload the latest state before saving."), { statusCode: 409 });
    }
    const activeJob = await client.query(
      `SELECT id FROM generation_jobs WHERE campaign_id = $1 AND owner_user_id = $2
        AND status IN ('queued','replacement_queued','assessing','generating','validating','committing','recoverable') LIMIT 1`,
      [campaignId, ownerUserId]
    );
    if (activeJob.rows[0]) throw Object.assign(new Error("Campaign state cannot change while story generation is active."), { statusCode: 409 });

    const currentSnapshot = campaign.active_turn_number === 0
      ? current.initial_state_snapshot
      : (await client.query<{ state_snapshot_private: Record<string, unknown> }>(
        `SELECT state_snapshot_private FROM turns WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_number = $3`,
        [campaignId, ownerUserId, campaign.active_turn_number]
      )).rows[0]?.state_snapshot_private;
    const existingFacts = await activeCanonicalFacts(client, ownerUserId, campaignId, campaign.active_turn_number);
    const existingById = new Map(existingFacts.map((fact) => [fact.id, fact]));
    const usedIds = new Set<string>();
    const correctedFacts = content.canonicalFacts.map((fact) => {
      const existing = fact.id ? existingById.get(fact.id) : undefined;
      if (fact.id && !existing) throw Object.assign(new Error("A canonical fact no longer belongs to this campaign state. Reload before saving."), { statusCode: 409 });
      const id = existing && existing.content === fact.content
        ? existing.id
        : existing && existing.source_turn_number === campaign.active_turn_number
          ? existing.id
          : crypto.randomUUID();
      if (usedIds.has(id)) throw Object.assign(new Error("Each canonical fact may appear only once."), { statusCode: 400 });
      usedIds.add(id);
      return { id, content: fact.content };
    });
    const correctedContent = { ...content, canonicalFacts: correctedFacts };
    const currentContent = runtimeStateContent({
      ...objectValue(currentSnapshot),
      scratchpad: current.scratchpad_private,
      trackers: current.trackers,
      rpgStats: current.rpg_stats,
      eventTriggers: current.event_triggers,
      pendingEventTriggers: current.pending_event_triggers
    }, existingFacts.map((fact) => ({ id: fact.id, content: fact.content })));
    const changedFields = (Object.keys(correctedContent) as Array<keyof CampaignRuntimeStateContent>)
      .filter((field) => json(correctedContent[field]) !== json(currentContent[field]));
    if (!changedFields.length) return;
    const nextRevision = current.revision + 1;
    const snapshot = { ...objectValue(currentSnapshot), ...correctedContent };
    const editId = crypto.randomUUID();

    await client.query(
      `UPDATE campaign_state SET scratchpad_private = $3, scratchpad_safe_for_prompt = true,
         trackers = $4, rpg_stats = $5, event_triggers = $6, pending_event_triggers = $7,
         revision = $8, updated_at = now()
       WHERE campaign_id = $1 AND owner_user_id = $2`,
      [campaignId, ownerUserId, correctedContent.scratchpad, json(correctedContent.trackers), json(correctedContent.rpgStats),
        json(correctedContent.eventTriggers), json(correctedContent.pendingEventTriggers), nextRevision]
    );
    if (campaign.active_turn_number === 0) {
      await client.query(
        `UPDATE campaign_state SET initial_state_snapshot = $3 WHERE campaign_id = $1 AND owner_user_id = $2`,
        [campaignId, ownerUserId, json(snapshot)]
      );
    }
    await client.query(
      `INSERT INTO campaign_state_edits (
         id, owner_user_id, campaign_id, effective_turn_number, revision, state_snapshot_private, changed_fields
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [editId, ownerUserId, campaignId, campaign.active_turn_number, nextRevision, json(snapshot), json(changedFields)]
    );
    await memoryApplicationForPool(pool).generation.rebuildCampaignMemories(client, {
      ownerUserId,
      campaignId,
      worldVersionId: campaign.world_version_id
    });
    await client.query(`DELETE FROM model_chains WHERE campaign_id = $1 AND owner_user_id = $2`, [campaignId, ownerUserId]);
    await client.query(
      `INSERT INTO activity_events (owner_user_id, campaign_id, event_type, details)
       VALUES ($1,$2,'campaign_state_edited',$3)`,
      [ownerUserId, campaignId, json({ effectiveTurnNumber: campaign.active_turn_number, fromRevision: current.revision, toRevision: nextRevision, changedFields })]
    );
  });
  return getCampaignRuntimeState(pool, campaignId);
}
