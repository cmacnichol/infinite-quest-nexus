import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { initialOwnerId, withTransaction } from "../../../packages/database/src/pool.js";
import {
  type CampaignBranchRequest,
  type CampaignRewindRequest,
  type PlayerCampaignConfig
} from "../../../packages/contracts/src/generation.js";
import {
  normalizeCampaignStateSnapshot,
  normalizeCampaignTrackers
} from "../../../packages/domain/src/index.js";
import type { MemoryGenerationTransactionPort } from "../../../packages/application/src/memory/index.js";
import { loadOrNotFound } from "./service-helpers.js";

function json(value: unknown): string { return JSON.stringify(value ?? null); }

export async function syncPlayerCampaignConfig(pool: DatabasePool, campaignId: string, config: PlayerCampaignConfig) {
  const ownerUserId = await initialOwnerId(pool);
  return withTransaction(pool, async (client) => {
    const campaign = await client.query<{ active_turn_number: number }>(
      `SELECT active_turn_number FROM campaigns WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
      [campaignId, ownerUserId]
    );
    const row = loadOrNotFound(campaign, "Campaign");
    if (row.active_turn_number !== config.expectedTurnNumber) {
      throw Object.assign(new Error(`Campaign is at turn ${row.active_turn_number}, not expected turn ${config.expectedTurnNumber}.`), { statusCode: 409 });
    }
    const activeJob = await client.query(
      `SELECT id FROM generation_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2
          AND status IN ('queued','replacement_queued','assessing','generating','validating','committing','recoverable')
        LIMIT 1`,
      [campaignId, ownerUserId]
    );
    if (activeJob.rows[0]) {
      throw Object.assign(new Error("Campaign configuration cannot change while a story generation is active."), { statusCode: 409 });
    }
    await client.query(
      `UPDATE campaigns
          SET legacy_settings = legacy_settings || $3::jsonb, updated_at = now()
        WHERE id = $1 AND owner_user_id = $2`,
      [campaignId, ownerUserId, json({ useRpgStats: config.useRpgStats, suppressEventTriggers: config.suppressEventTriggers })]
    );
    const stateResult = await client.query<{ scratchpad_private: string; trackers: unknown }>(
      `UPDATE campaign_state
          SET rpg_stats = $3, event_triggers = $4, pending_event_triggers = $5,
              revision = revision + 1, updated_at = now()
        WHERE campaign_id = $1 AND owner_user_id = $2
        RETURNING scratchpad_private, trackers`,
      [campaignId, ownerUserId, json(config.rpgStats), json(config.eventTriggers), json(config.pendingEventTriggers)]
    );
    if (row.active_turn_number === 0) {
      const state = stateResult.rows[0];
      if (!state) throw new Error("Campaign state was not found.");
      const initialStateSnapshot = normalizeCampaignStateSnapshot({
        scratchpad: state.scratchpad_private,
        trackers: state.trackers,
        eventTriggers: config.eventTriggers,
        pendingEventTriggers: config.pendingEventTriggers,
        rpgStats: config.rpgStats
      });
      await client.query(
        `UPDATE campaign_state
            SET initial_state_snapshot = $3::jsonb
          WHERE campaign_id = $1 AND owner_user_id = $2`,
        [campaignId, ownerUserId, json(initialStateSnapshot)]
      );
    }
    return { campaignId, activeTurnNumber: row.active_turn_number, synchronized: true };
  });
}

export async function rewindCampaign(
  pool: DatabasePool,
  campaignId: string,
  request: CampaignRewindRequest,
  memory: MemoryGenerationTransactionPort,
) {
  const ownerUserId = await initialOwnerId(pool);
  return withTransaction(pool, async (client) => {
    const campaignResult = await client.query<{ active_turn_number: number; world_version_id: string }>(
      `SELECT active_turn_number, world_version_id FROM campaigns
        WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
      [campaignId, ownerUserId]
    );
    const campaign = loadOrNotFound(campaignResult, "Campaign");
    if (request.expectedCurrentTurnNumber !== undefined
        && request.expectedCurrentTurnNumber !== campaign.active_turn_number) {
      throw Object.assign(
        new Error(`Campaign is at turn ${campaign.active_turn_number}, not ${request.expectedCurrentTurnNumber}.`),
        { statusCode: 409 }
      );
    }
    if (request.targetTurnNumber > campaign.active_turn_number) {
      throw Object.assign(new Error(`Campaign has only ${campaign.active_turn_number} accepted turns.`), { statusCode: 409 });
    }

    // Resolve the target state snapshot — either from a turn row or the initial snapshot.
    let targetSnapshot: Record<string, unknown>;
    let targetModelMetadata: Record<string, unknown> | null = null;
    let targetStateEdited = false;
    if (request.targetTurnNumber === 0) {
      const initialResult = await client.query<{ initial_state_snapshot: Record<string, unknown> }>(
        `SELECT initial_state_snapshot FROM campaign_state
          WHERE campaign_id = $1 AND owner_user_id = $2 FOR UPDATE`,
        [campaignId, ownerUserId]
      );
      if (!initialResult.rows[0]) throw new Error("Campaign state was not found.");
      targetSnapshot = initialResult.rows[0].initial_state_snapshot || {};
    } else {
      const target = await client.query<{
        state_snapshot_private: Record<string, unknown>;
        model_metadata: Record<string, unknown>;
      }>(
        `SELECT state_snapshot_private, model_metadata FROM turns
          WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_number = $3`,
        [campaignId, ownerUserId, request.targetTurnNumber]
      );
      const targetTurn = target.rows[0];
      if (!targetTurn) throw Object.assign(new Error("The requested rewind turn was not found."), { statusCode: 404 });
      targetSnapshot = targetTurn.state_snapshot_private || {};
      targetModelMetadata = targetTurn.model_metadata || null;
    }
    const targetEdit = await client.query<{ state_snapshot_private: Record<string, unknown> }>(
      `SELECT state_snapshot_private FROM campaign_state_edits
        WHERE campaign_id = $1 AND owner_user_id = $2 AND effective_turn_number = $3
        ORDER BY revision DESC LIMIT 1`,
      [campaignId, ownerUserId, request.targetTurnNumber]
    );
    if (targetEdit.rows[0]) {
      targetSnapshot = targetEdit.rows[0].state_snapshot_private || targetSnapshot;
      targetStateEdited = true;
    }
    if (request.targetTurnNumber === campaign.active_turn_number) {
      return {
        campaignId,
        activeTurnNumber: campaign.active_turn_number,
        discardedTurnCount: 0,
        stateSnapshot: targetSnapshot
      };
    }
    const activeGeneration = await client.query(
      `SELECT id FROM generation_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2
          AND status IN ('queued','replacement_queued','assessing','generating','validating','committing','recoverable')
        LIMIT 1 FOR UPDATE`,
      [campaignId, ownerUserId]
    );
    const futureIllustrations = await client.query<{ status: string }>(
      `SELECT status FROM image_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2
          AND turn_id IN (SELECT id FROM turns WHERE campaign_id = $1 AND turn_number > $3)
        FOR UPDATE`,
      [campaignId, ownerUserId, request.targetTurnNumber]
    );
    const futureResolutions = await client.query<{ status: string }>(
      `SELECT status FROM illustration_resolution_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2
          AND turn_id IN (SELECT id FROM turns WHERE campaign_id = $1 AND turn_number > $3)
        FOR UPDATE`,
      [campaignId, ownerUserId, request.targetTurnNumber]
    );
    const activeChronicle = await client.query(
      `SELECT id FROM chronicle_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2 AND status = 'running'
        LIMIT 1 FOR UPDATE`,
      [campaignId, ownerUserId]
    );
    if (activeGeneration.rows[0]
        || futureIllustrations.rows.some((row) => ["queued", "generating", "provider_pending", "downloading"].includes(row.status))
        || futureResolutions.rows.some((row) => ["queued", "matching", "recoverable", "generation_queued"].includes(row.status))
        || activeChronicle.rows[0]) {
      throw Object.assign(new Error("Wait for active campaign work to finish before resetting to an earlier turn."), { statusCode: 409 });
    }

    const currentStateResult = await client.query<{
      event_triggers: unknown;
      rpg_stats: unknown;
    }>(
      `SELECT event_triggers, rpg_stats FROM campaign_state
        WHERE campaign_id = $1 AND owner_user_id = $2 FOR UPDATE`,
      [campaignId, ownerUserId]
    );
    const currentState = currentStateResult.rows[0];
    if (!currentState) throw new Error("Campaign state was not found.");
    const snapshot = targetSnapshot;
    const scratchpad = typeof snapshot.scratchpad === "string" ? snapshot.scratchpad : "";
    const trackers = normalizeCampaignTrackers(snapshot.trackers);
    const eventTriggers = Array.isArray(snapshot.eventTriggers) ? snapshot.eventTriggers : currentState.event_triggers;
    const pendingEventTriggers = Array.isArray(snapshot.pendingEventTriggers) ? snapshot.pendingEventTriggers : [];
    const rpgStats = Array.isArray(snapshot.rpgStats) ? snapshot.rpgStats : currentState.rpg_stats;
    const scratchpadSafeForPrompt = targetStateEdited || typeof targetModelMetadata?.promptProtocolVersion === "string";
    const discardedTurnCount = campaign.active_turn_number - request.targetTurnNumber;

    await client.query(
      `DELETE FROM generation_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2 AND expected_turn_number > $3`,
      [campaignId, ownerUserId, request.targetTurnNumber]
    );
    await client.query(
      `DELETE FROM campaign_state_edits
        WHERE campaign_id = $1 AND owner_user_id = $2 AND effective_turn_number > $3`,
      [campaignId, ownerUserId, request.targetTurnNumber]
    );
    await client.query(
      `DELETE FROM turns
        WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_number > $3`,
      [campaignId, ownerUserId, request.targetTurnNumber]
    );
    await client.query(
      `DELETE FROM summary_checkpoints
        WHERE campaign_id = $1 AND owner_user_id = $2 AND through_turn > $3`,
      [campaignId, ownerUserId, request.targetTurnNumber]
    );
    await client.query(
      `DELETE FROM chronicle_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2 AND status <> 'running'`,
      [campaignId, ownerUserId]
    );
    const memoryScope = { ownerUserId, campaignId, worldVersionId: campaign.world_version_id };
    await memory.rebuildCampaignMemories(client, memoryScope);
    await memory.enqueueEmbeddingReindex(client, memoryScope);
    await client.query(
      `DELETE FROM model_chains WHERE campaign_id = $1 AND owner_user_id = $2`,
      [campaignId, ownerUserId]
    );
    await client.query(
      `UPDATE campaign_state SET scratchpad_private = $3, scratchpad_safe_for_prompt = $4,
         trackers = $5, event_triggers = $6, pending_event_triggers = $7, rpg_stats = $8,
         revision = revision + 1, updated_at = now()
        WHERE campaign_id = $1 AND owner_user_id = $2`,
      [campaignId, ownerUserId, scratchpad, scratchpadSafeForPrompt, json(trackers), json(eventTriggers),
        json(pendingEventTriggers), json(rpgStats)]
    );
    await client.query(
      `UPDATE campaigns SET active_turn_number = $3, updated_at = now()
        WHERE id = $1 AND owner_user_id = $2`,
      [campaignId, ownerUserId, request.targetTurnNumber]
    );
    await client.query(
      `INSERT INTO activity_events (owner_user_id, campaign_id, event_type, details)
       VALUES ($1,$2,'campaign_rewound',$3)`,
      [ownerUserId, campaignId, json({ fromTurnNumber: campaign.active_turn_number, targetTurnNumber: request.targetTurnNumber, discardedTurnCount })]
    );
    return {
      campaignId,
      activeTurnNumber: request.targetTurnNumber,
      discardedTurnCount,
      stateSnapshot: { scratchpad, trackers, eventTriggers, pendingEventTriggers, rpgStats }
    };
  });
}

export async function branchCampaign(
  pool: DatabasePool,
  campaignId: string,
  request: CampaignBranchRequest,
  memory: MemoryGenerationTransactionPort,
) {
  const ownerUserId = await initialOwnerId(pool);
  return withTransaction(pool, async (client) => {
    const campaignResult = await client.query<{
      active_turn_number: number;
      world_version_id: string;
      title: string;
      story_length_profile: string;
      turn_control_style: string;
      selected_character_id: string | null;
      character_snapshot: Record<string, unknown> | null;
      character_profile: Record<string, unknown> | null;
      character_profile_revision: number;
      legacy_settings: Record<string, unknown>;
      text_provider_profile_id: string | null;
      image_provider_profile_id: string | null;
    }>(
      `SELECT active_turn_number, world_version_id, title, story_length_profile, turn_control_style,
              selected_character_id, character_snapshot, character_profile, character_profile_revision, legacy_settings,
              text_provider_profile_id, image_provider_profile_id
         FROM campaigns
        WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
      [campaignId, ownerUserId]
    );
    const campaign = loadOrNotFound(campaignResult, "Campaign");
    if (request.expectedCurrentTurnNumber !== undefined
        && request.expectedCurrentTurnNumber !== campaign.active_turn_number) {
      throw Object.assign(
        new Error(`Campaign is at turn ${campaign.active_turn_number}, not ${request.expectedCurrentTurnNumber}.`),
        { statusCode: 409 }
      );
    }
    if (request.targetTurnNumber > campaign.active_turn_number) {
      throw Object.assign(new Error(`Campaign has only ${campaign.active_turn_number} accepted turns.`), { statusCode: 409 });
    }

    const parentStateResult = await client.query<{
      default_triggers: unknown;
      initial_state_snapshot: Record<string, unknown>;
    }>(
      `SELECT default_triggers, initial_state_snapshot FROM campaign_state
        WHERE campaign_id = $1 AND owner_user_id = $2 FOR UPDATE`,
      [campaignId, ownerUserId]
    );
    const parentState = parentStateResult.rows[0] || { default_triggers: [], initial_state_snapshot: {} };

    let targetSnapshot: Record<string, unknown>;
    let targetModelMetadata: Record<string, unknown> | null = null;
    let targetStateEdited = false;
    if (request.targetTurnNumber === 0) {
      targetSnapshot = parentState.initial_state_snapshot || {};
    } else {
      const target = await client.query<{
        state_snapshot_private: Record<string, unknown>;
        model_metadata: Record<string, unknown>;
      }>(
        `SELECT state_snapshot_private, model_metadata FROM turns
          WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_number = $3`,
        [campaignId, ownerUserId, request.targetTurnNumber]
      );
      const targetTurn = target.rows[0];
      if (!targetTurn) throw Object.assign(new Error("The requested branch turn was not found."), { statusCode: 404 });
      targetSnapshot = targetTurn.state_snapshot_private || {};
      targetModelMetadata = targetTurn.model_metadata || null;
    }
    const targetEdit = await client.query<{ state_snapshot_private: Record<string, unknown> }>(
      `SELECT state_snapshot_private FROM campaign_state_edits
        WHERE campaign_id = $1 AND owner_user_id = $2 AND effective_turn_number = $3
        ORDER BY revision DESC LIMIT 1`,
      [campaignId, ownerUserId, request.targetTurnNumber]
    );
    if (targetEdit.rows[0]) {
      targetSnapshot = targetEdit.rows[0].state_snapshot_private || targetSnapshot;
      targetStateEdited = true;
    }

    const branchTitle = request.title?.trim() || `${campaign.title} (Branch Turn ${request.targetTurnNumber})`;
    const newCampaignRes = await client.query<{ id: string }>(
      `INSERT INTO campaigns (
         owner_user_id, world_version_id, title, status, active_turn_number,
         story_length_profile, turn_control_style, selected_character_id, character_snapshot,
         character_profile, character_profile_revision, legacy_settings,
         text_provider_profile_id, image_provider_profile_id
       ) VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [
        ownerUserId, campaign.world_version_id, branchTitle, request.targetTurnNumber,
        campaign.story_length_profile, campaign.turn_control_style, campaign.selected_character_id, json(campaign.character_snapshot),
        campaign.character_profile ? json(campaign.character_profile) : null,
        campaign.character_profile ? 1 : 0, json(campaign.legacy_settings),
        campaign.text_provider_profile_id, campaign.image_provider_profile_id
      ]
    );
    const newCampaignId = newCampaignRes.rows[0]?.id;
    if (!newCampaignId) throw new Error("Could not create campaign branch.");
    if (campaign.character_profile) {
      await client.query(
        `INSERT INTO campaign_character_profile_edits (
           owner_user_id, campaign_id, revision, previous_profile, next_profile, edit_source
         ) VALUES ($1,$2,1,NULL,$3,'branch')`,
        [ownerUserId, newCampaignId, json(campaign.character_profile)]
      );
    }

    const materializedTargetSnapshot = normalizeCampaignStateSnapshot(targetSnapshot);
    const branchDefaultTriggers = normalizeCampaignTrackers(parentState.default_triggers);
    const branchInitialStateSnapshot = normalizeCampaignStateSnapshot(parentState.initial_state_snapshot);
    const scratchpad = typeof materializedTargetSnapshot.scratchpad === "string" ? materializedTargetSnapshot.scratchpad : "";
    const trackers = normalizeCampaignTrackers(materializedTargetSnapshot.trackers);
    const eventTriggers = Array.isArray(materializedTargetSnapshot.eventTriggers) ? materializedTargetSnapshot.eventTriggers : [];
    const pendingEventTriggers = Array.isArray(materializedTargetSnapshot.pendingEventTriggers) ? materializedTargetSnapshot.pendingEventTriggers : [];
    const rpgStats = Array.isArray(materializedTargetSnapshot.rpgStats) ? materializedTargetSnapshot.rpgStats : [];
    const scratchpadSafeForPrompt = targetStateEdited || typeof targetModelMetadata?.promptProtocolVersion === "string";

    const branchProvenance = {
      sourceType: "nexus_campaign_branch",
      parentCampaignId: campaignId,
      branchTurnNumber: request.targetTurnNumber,
      branchId: crypto.randomUUID()
    };

    await client.query(
      `INSERT INTO campaign_state (
         campaign_id, owner_user_id, scratchpad_private, scratchpad_safe_for_prompt,
         trackers, default_triggers, event_triggers, pending_event_triggers, rpg_stats,
         import_provenance, initial_state_snapshot
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        newCampaignId, ownerUserId, scratchpad, scratchpadSafeForPrompt,
        json(trackers), json(branchDefaultTriggers), json(eventTriggers), json(pendingEventTriggers), json(rpgStats),
        json(branchProvenance), json(branchInitialStateSnapshot)
      ]
    );
    if (targetStateEdited) {
      await client.query(
        `INSERT INTO campaign_state_edits (
           owner_user_id, campaign_id, effective_turn_number, revision, state_snapshot_private, changed_fields
         ) VALUES ($1,$2,$3,1,$4,$5)`,
        [ownerUserId, newCampaignId, request.targetTurnNumber, json(materializedTargetSnapshot), json(["branchedState"])]
      );
      await client.query(
        `UPDATE campaign_state SET revision = 1 WHERE campaign_id = $1 AND owner_user_id = $2`,
        [newCampaignId, ownerUserId]
      );
    }

    await client.query(
      `INSERT INTO campaign_illustration_configs (
         campaign_id, owner_user_id, enabled, source_policy, matching_scope, confidence_profile, repetition_window,
         provider_profile_id, model, size, aspect_ratio, quality, output_format, max_attempts,
         segment_word_count, images_per_segment, segment_prompt_mode, refinement_prompt
       ) SELECT $1, owner_user_id, enabled, source_policy, matching_scope, confidence_profile, repetition_window,
                provider_profile_id, model, size, aspect_ratio, quality, output_format, max_attempts,
                segment_word_count, images_per_segment, segment_prompt_mode, refinement_prompt
           FROM campaign_illustration_configs WHERE campaign_id = $2 AND owner_user_id = $3 ON CONFLICT DO NOTHING`,
      [newCampaignId, campaignId, ownerUserId]
    );

    await client.query(
      `INSERT INTO campaign_memory_configs (
         campaign_id, owner_user_id, embedding_enabled, embedding_provider_profile_id, embedding_model, embedding_batch_size,
         embedding_document_prefix, embedding_query_prefix
       ) SELECT $1, owner_user_id, embedding_enabled, embedding_provider_profile_id, embedding_model, embedding_batch_size,
                embedding_document_prefix, embedding_query_prefix
           FROM campaign_memory_configs WHERE campaign_id = $2 AND owner_user_id = $3 ON CONFLICT DO NOTHING`,
      [newCampaignId, campaignId, ownerUserId]
    );
    await memory.autoEnableCampaignEmbedding(client, {
      ownerUserId,
      campaignId: newCampaignId,
      worldVersionId: campaign.world_version_id
    });

    if (request.targetTurnNumber > 0) {
      await client.query(
        `INSERT INTO turns (
           campaign_id, owner_user_id, turn_number, source_turn_id, action, input_mode, input_mode_source, narration,
           choices, custom_action_suggestion, image_prompt, image_url, mechanics_private,
           state_snapshot_private, model_metadata, import_metadata, accepted_at, created_at
         ) SELECT $1, owner_user_id, turn_number, source_turn_id, action, input_mode, input_mode_source, narration,
                  choices, custom_action_suggestion, image_prompt, image_url, mechanics_private,
                  state_snapshot_private, model_metadata, import_metadata, accepted_at, created_at
             FROM turns WHERE campaign_id = $2 AND owner_user_id = $3 AND turn_number <= $4
            ORDER BY turn_number ASC`,
        [newCampaignId, campaignId, ownerUserId, request.targetTurnNumber]
      );
      await client.query(
        `INSERT INTO summary_checkpoints (
           owner_user_id, campaign_id, through_turn, summary_kind, content, token_estimate, created_at
         ) SELECT owner_user_id, $1, through_turn, summary_kind, content, token_estimate, created_at
             FROM summary_checkpoints WHERE campaign_id = $2 AND owner_user_id = $3 AND through_turn <= $4`,
        [newCampaignId, campaignId, ownerUserId, request.targetTurnNumber]
      );

      await client.query(
        `INSERT INTO asset_references (
           owner_user_id, asset_id, campaign_id, turn_id, asset_role, created_at
         )
         SELECT source_ref.owner_user_id, source_ref.asset_id, $1, target_turn.id,
                source_ref.asset_role, source_ref.created_at
           FROM asset_references source_ref
           JOIN turns source_turn
             ON source_turn.id = source_ref.turn_id
            AND source_turn.campaign_id = source_ref.campaign_id
            AND source_turn.owner_user_id = source_ref.owner_user_id
           JOIN turns target_turn
             ON target_turn.campaign_id = $1
            AND target_turn.owner_user_id = source_ref.owner_user_id
            AND target_turn.turn_number = source_turn.turn_number
          WHERE source_ref.campaign_id = $2
            AND source_ref.owner_user_id = $3
            AND source_turn.turn_number <= $4
         ON CONFLICT DO NOTHING`,
        [newCampaignId, campaignId, ownerUserId, request.targetTurnNumber]
      );
    }

    await client.query(
      `INSERT INTO asset_references (
         owner_user_id, asset_id, campaign_id, turn_id, asset_role, created_at
       )
       SELECT owner_user_id, asset_id, $1, NULL, asset_role, created_at
         FROM asset_references
        WHERE campaign_id = $2 AND owner_user_id = $3 AND turn_id IS NULL
       ON CONFLICT DO NOTHING`,
      [newCampaignId, campaignId, ownerUserId]
    );

    const memoryScope = { ownerUserId, campaignId: newCampaignId, worldVersionId: campaign.world_version_id };
    await memory.rebuildCampaignMemories(client, memoryScope);
    await memory.enqueueEmbeddingReindex(client, memoryScope);

    await client.query(
      `INSERT INTO activity_events (owner_user_id, campaign_id, event_type, details)
       VALUES ($1,$2,'campaign_branched',$3)`,
      [ownerUserId, newCampaignId, json({ parentCampaignId: campaignId, branchTurnNumber: request.targetTurnNumber })]
    );

    return {
      id: newCampaignId,
      title: branchTitle,
      status: "active",
      activeTurnNumber: request.targetTurnNumber,
      storyLengthProfile: campaign.story_length_profile,
      turnControlStyle: campaign.turn_control_style,
      worldVersionId: campaign.world_version_id,
      selectedCharacterId: campaign.selected_character_id,
      textProviderProfileId: campaign.text_provider_profile_id,
      imageProviderProfileId: campaign.image_provider_profile_id
    };
  });
}
