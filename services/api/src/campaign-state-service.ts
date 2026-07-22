import { campaignRuntimeStateSchema, type CampaignRuntimeStateUpdate, type CampaignTracker } from "../../../packages/contracts/src/generation.js";
import { initialOwnerId, withTransaction, type DatabasePool } from "../../../packages/database/src/pool.js";
import { containsMechanicsLanguage } from "../../../packages/domain/src/text.js";

function json(value: unknown): string {
  return JSON.stringify(value);
}

function trackerId(value: Record<string, unknown>, index: number): string {
  return String(value.id || value.name || `tracker-${index + 1}`).trim().slice(0, 200);
}

function normalizeTrackers(value: unknown): CampaignTracker[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const source = item as Record<string, unknown>;
    const name = String(source.name || source.label || source.title || "").trim().slice(0, 300);
    if (!name) return [];
    return [{
      id: trackerId(source, index),
      name,
      value: String(source.value ?? source.currentValue ?? "").slice(0, 10_000),
      rules: String(source.rules ?? source.updateRules ?? "").slice(0, 4000)
    }];
  });
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
  const row = result.rows[0];
  if (!row) throw Object.assign(new Error("Campaign not found."), { statusCode: 404 });
  const turnNumber = requestedTurnNumber === undefined ? row.active_turn_number : requestedTurnNumber;
  if (!Number.isInteger(turnNumber) || turnNumber < 0 || turnNumber > row.active_turn_number) {
    throw Object.assign(new Error(`Campaign has only ${row.active_turn_number} accepted turns.`), { statusCode: 409 });
  }

  let snapshot: Record<string, unknown> = {};
  let snapshotUpdatedAt: Date | string = row.updated_at;
  if (turnNumber === row.active_turn_number) {
    const latest = turnNumber > 0
      ? await pool.query<{ state_snapshot_private: Record<string, unknown>; accepted_at: Date | string }>(
        `SELECT state_snapshot_private, accepted_at FROM turns
          WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_number = $3`,
        [campaignId, ownerUserId, turnNumber]
      ) : null;
    snapshot = {
      ...(latest?.rows[0]?.state_snapshot_private || row.initial_state_snapshot || {}),
      scratchpad: row.scratchpad_private,
      trackers: row.trackers,
      rpgStats: row.rpg_stats,
      eventTriggers: row.event_triggers,
      pendingEventTriggers: row.pending_event_triggers
    };
  } else if (turnNumber === 0) {
    snapshot = objectValue(row.initial_state_snapshot);
  } else {
    const historical = await pool.query<{ state_snapshot_private: Record<string, unknown>; accepted_at: Date | string }>(
      `SELECT state_snapshot_private, accepted_at FROM turns
        WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_number = $3`,
      [campaignId, ownerUserId, turnNumber]
    );
    if (!historical.rows[0]) throw Object.assign(new Error("Turn state was not found."), { statusCode: 404 });
    snapshot = objectValue(historical.rows[0].state_snapshot_private);
    snapshotUpdatedAt = historical.rows[0].accepted_at;
    const edit = await pool.query<{ state_snapshot_private: Record<string, unknown>; created_at: Date | string }>(
      `SELECT state_snapshot_private, created_at FROM campaign_state_edits
        WHERE campaign_id = $1 AND owner_user_id = $2 AND effective_turn_number = $3
        ORDER BY revision DESC LIMIT 1`,
      [campaignId, ownerUserId, turnNumber]
    );
    if (edit.rows[0]) {
      snapshot = objectValue(edit.rows[0].state_snapshot_private);
      snapshotUpdatedAt = edit.rows[0].created_at;
    }
  }

  return campaignRuntimeStateSchema.parse({
    campaignId,
    activeTurnNumber: row.active_turn_number,
    viewedTurnNumber: turnNumber,
    isCurrent: turnNumber === row.active_turn_number,
    revision: row.revision,
    updatedAt: snapshotUpdatedAt,
    scratchpad: String(snapshot.scratchpad || ""),
    trackers: normalizeTrackers(snapshot.trackers),
    rpgStats: Array.isArray(snapshot.rpgStats) ? snapshot.rpgStats : [],
    eventTriggers: Array.isArray(snapshot.eventTriggers) ? snapshot.eventTriggers : [],
    pendingEventTriggers: Array.isArray(snapshot.pendingEventTriggers) ? snapshot.pendingEventTriggers : [],
    continuitySummary: String(snapshot.continuitySummary || ""),
    canonicalFacts: Array.isArray(snapshot.canonicalFacts) ? snapshot.canonicalFacts.map(String) : [],
    openThreads: Array.isArray(snapshot.openThreads) ? snapshot.openThreads.map(String) : []
  });
}

export async function updateCampaignRuntimeState(pool: DatabasePool, campaignId: string, request: CampaignRuntimeStateUpdate) {
  if (containsMechanicsLanguage(request.scratchpad) || containsMechanicsLanguage(json(request.trackers))) {
    throw Object.assign(new Error("Scratchpad and trackers must contain fiction continuity only, without game mechanics or engine diagnostics."), { statusCode: 400 });
  }
  const ownerUserId = await initialOwnerId(pool);
  await withTransaction(pool, async (client) => {
    const campaignResult = await client.query<{ active_turn_number: number }>(
      `SELECT active_turn_number FROM campaigns WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
      [campaignId, ownerUserId]
    );
    const campaign = campaignResult.rows[0];
    if (!campaign) throw Object.assign(new Error("Campaign not found."), { statusCode: 404 });
    const stateResult = await client.query<{ revision: number; scratchpad_private: string; trackers: unknown; initial_state_snapshot: Record<string, unknown> }>(
      `SELECT revision, scratchpad_private, trackers, initial_state_snapshot FROM campaign_state
        WHERE campaign_id = $1 AND owner_user_id = $2 FOR UPDATE`,
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

    const changedFields = [
      ...(current.scratchpad_private !== request.scratchpad ? ["scratchpad"] : []),
      ...(json(normalizeTrackers(current.trackers)) !== json(request.trackers) ? ["trackers"] : [])
    ];
    if (!changedFields.length) return;
    const nextRevision = current.revision + 1;
    const snapshotBase = campaign.active_turn_number === 0
      ? objectValue(current.initial_state_snapshot)
      : objectValue((await client.query<{ state_snapshot_private: Record<string, unknown> }>(
        `SELECT state_snapshot_private FROM turns WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_number = $3`,
        [campaignId, ownerUserId, campaign.active_turn_number]
      )).rows[0]?.state_snapshot_private);
    const snapshot = { ...snapshotBase, scratchpad: request.scratchpad, trackers: request.trackers };

    await client.query(
      `UPDATE campaign_state SET scratchpad_private = $3, scratchpad_safe_for_prompt = true,
         trackers = $4, revision = $5, updated_at = now()
       WHERE campaign_id = $1 AND owner_user_id = $2`,
      [campaignId, ownerUserId, request.scratchpad, json(request.trackers), nextRevision]
    );
    if (campaign.active_turn_number === 0) {
      await client.query(
        `UPDATE campaign_state SET initial_state_snapshot = $3 WHERE campaign_id = $1 AND owner_user_id = $2`,
        [campaignId, ownerUserId, json(snapshot)]
      );
    }
    await client.query(
      `INSERT INTO campaign_state_edits (owner_user_id, campaign_id, effective_turn_number, revision, state_snapshot_private, changed_fields)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [ownerUserId, campaignId, campaign.active_turn_number, nextRevision, json(snapshot), json(changedFields)]
    );
    await client.query(`DELETE FROM model_chains WHERE campaign_id = $1 AND owner_user_id = $2`, [campaignId, ownerUserId]);
    await client.query(
      `INSERT INTO activity_events (owner_user_id, campaign_id, event_type, details)
       VALUES ($1,$2,'campaign_state_edited',$3)`,
      [ownerUserId, campaignId, json({ effectiveTurnNumber: campaign.active_turn_number, fromRevision: current.revision, toRevision: nextRevision, changedFields })]
    );
  });
  return getCampaignRuntimeState(pool, campaignId);
}
