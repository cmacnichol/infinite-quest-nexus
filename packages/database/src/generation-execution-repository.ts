import type {
  ClaimedGeneration,
  GenerationClaimRepository,
  GenerationExecutionRequest,
  IllustrationGenerationTransactionPort,
  MemoryGenerationTransactionPort
} from "../../application/src/index.js";
import {
  pendingEventTriggerSchema,
  playerEventTriggerSchema,
  playerRpgStatSchema,
  type CampaignTracker,
  type PlayerEventTrigger,
  type PlayerRpgStat,
  type StoryTurnOutput
} from "../../contracts/src/generation.js";
import type { MemoryContextQuery } from "../../contracts/src/memory.js";
import type { PromptSnapshot } from "../../contracts/src/prompt-library.js";
import type { StoryLengthProfile } from "../../contracts/src/story-settings.js";
import {
  applyTriggerHits,
  buildTurnFictionMemory,
  type ActivatedEvent,
  type PrivateRollResolution,
  type ProviderResult,
  type TextProviderProfile
} from "../../story-engine/src/index.js";
import {
  buildScopedEntityCatalog,
  normalizeCampaignTrackers,
  resolveEntityMetadata
} from "../../domain/src/index.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";
import { withTransaction } from "./pool.js";

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export type GenerationLeaseScope = Readonly<{
  jobId: string;
  ownerUserId: string;
  workerId: string;
}>;

export type GenerationOrchestrationState = {
  roll?: PrivateRollResolution | null;
  rpgAssessmentError?: string;
  beforeEvents?: ActivatedEvent[];
  beforeTriggerError?: string;
  afterEvents?: ActivatedEvent[];
  afterTriggerError?: string;
  extension?: {
    additionalText: string;
    scratchpad?: string;
    trackerUpdates: Array<Record<string, unknown>>;
  };
  extensionError?: string;
};

export type GenerationStreamingState = Record<string, unknown> & {
  provisionalSetId?: string | null;
};

export type GenerationOrchestrationInputs = {
  useRpgStats: boolean;
  rpgStats: PlayerRpgStat[];
  eventTriggers: PlayerEventTrigger[];
  pendingEventTriggers: ActivatedEvent[];
  storyMemoryDefaults: {
    continuitySummary?: string;
    canonicalFacts: string[];
    supersededFacts: string[];
    openThreads?: string[];
  };
  suppressEventTriggers: boolean;
  characterProfile: Record<string, unknown> | null;
  characterSnapshot: Record<string, unknown> | null;
};

export type GenerationExecutionPayload = {
  id: string;
  owner_user_id: string;
  campaign_id: string;
  world_version_id?: string;
  provider_profile_id: string;
  expected_turn_number: number;
  operation_kind: "append" | "replace_latest";
  replacement_turn_id: string | null;
  base_turn_number: number | null;
  base_state_private: Record<string, unknown>;
  base_scratchpad_safe_for_prompt: boolean;
  action: string;
  requested_input_mode: "auto" | "action" | "scene";
  resolved_input_mode: "action" | "scene";
  input_mode_source: "explicit" | "auto" | "generated_choice" | "opening_action" | "fallback";
  requested_model: string;
  context_options: MemoryContextQuery & {
    modelContextWindowTokens?: number;
    storyLengthProfile?: StoryLengthProfile;
    narrationMinWords?: number;
    narrationMaxWords?: number;
  };
  prompt_protocol_version: string;
  prompt_snapshot: PromptSnapshot;
  attempts: number;
  orchestration_private: GenerationOrchestrationState;
  streaming_segments_state: GenerationStreamingState;
  orchestration_inputs: GenerationOrchestrationInputs;
};

export type GenerationAttemptRecord = GenerationLeaseScope & Readonly<{
  attemptNumber: number;
  recoveryKind: string;
  requestMetadata: Record<string, unknown>;
  responseMetadata: Record<string, unknown>;
  providerResponseId: string | null;
  finishReason: string | null;
  rawOutput: string | null;
  validationErrors: readonly string[];
  overwrite: boolean;
}>;

export type GenerationRecoverableUpdate = GenerationLeaseScope & Readonly<{
  providerResponseId: string | null;
  providerFinishReason: string | null;
  errorCode: string;
  errorMessage: string;
  recoveryMetadata: Record<string, unknown>;
}>;

export type GenerationFailedUpdate = GenerationLeaseScope & Readonly<{
  errorCode: string;
  errorMessage: string;
  recoveryMetadata: Record<string, unknown>;
}>;

type GenerationTextProvider = TextProviderProfile & {
  id: string;
  name: string;
};

export type AcceptedGenerationCommitCollaborators = Readonly<{
  memory: MemoryGenerationTransactionPort;
  illustration: IllustrationGenerationTransactionPort;
  attributeGenerationCostsToTurn(
    client: DatabaseClient,
    ownerUserId: string,
    campaignId: string,
    generationJobId: string,
    turnId: string
  ): Promise<void>;
}>;

export type AcceptedGenerationCommit = Readonly<{
  scope: GenerationLeaseScope;
  job: GenerationExecutionPayload;
  story: StoryTurnOutput;
  provider: GenerationTextProvider;
  response: ProviderResult;
  contextFingerprint: string;
  contextDiagnostics: Record<string, unknown>;
  inputs: GenerationOrchestrationInputs;
  orchestration: GenerationOrchestrationState;
  fictionAction: string;
  collaborators: AcceptedGenerationCommitCollaborators;
  onIllustrationEnqueueError(error: unknown, turnId: string): void;
}>;

export type GenerationExecutionRepository = Readonly<{
  loadExecutionPayload(request: GenerationExecutionRequest): Promise<GenerationExecutionPayload | null>;
  renewLease(scope: GenerationLeaseScope, leaseSeconds: number): Promise<boolean>;
  markGenerating(scope: GenerationLeaseScope): Promise<boolean>;
  saveOrchestration(scope: GenerationLeaseScope, value: GenerationOrchestrationState): Promise<boolean>;
  savePartialNarration(scope: GenerationLeaseScope, narration: string): Promise<boolean>;
  saveStreamingSegments(scope: GenerationLeaseScope, value: GenerationStreamingState): Promise<boolean>;
  recordAttempt(input: GenerationAttemptRecord): Promise<void>;
  markRecoverable(input: GenerationRecoverableUpdate): Promise<boolean>;
  markValidating(scope: GenerationLeaseScope): Promise<boolean>;
  markCommitting(scope: GenerationLeaseScope): Promise<boolean>;
  commitAcceptedTurn(input: AcceptedGenerationCommit): Promise<{ turnId: string }>;
  markFailed(input: GenerationFailedUpdate): Promise<boolean>;
}>;

type ExecutionPayloadRow = Omit<GenerationExecutionPayload, "orchestration_inputs"> & {
  legacy_settings: Record<string, unknown>;
  rpg_stats: unknown;
  event_triggers: unknown;
  pending_event_triggers: unknown;
  state_snapshot_private: Record<string, unknown> | null;
  character_profile: Record<string, unknown> | null;
  character_snapshot: Record<string, unknown> | null;
};

function claimedGeneration(row: {
  id: string;
  owner_user_id: string;
  campaign_id: string;
  provider_profile_id: string;
  expected_turn_number: number;
  attempts: number;
  operation_kind: "append" | "replace_latest";
  replacement_turn_id: string | null;
}): ClaimedGeneration {
  const base = {
    jobId: row.id,
    ownerUserId: row.owner_user_id,
    campaignId: row.campaign_id,
    providerProfileId: row.provider_profile_id,
    expectedTurnNumber: row.expected_turn_number,
    attempts: row.attempts
  };
  return row.operation_kind === "append"
    ? { ...base, operationKind: "append", replacementTurnId: null }
    : { ...base, operationKind: "replace_latest", replacementTurnId: row.replacement_turn_id! };
}

function orchestrationInputs(row: ExecutionPayloadRow): GenerationOrchestrationInputs {
  const stagedState = row.operation_kind === "replace_latest" ? row.base_state_private || {} : null;
  const rpgSource = stagedState && Array.isArray(stagedState.rpgStats) ? stagedState.rpgStats : row.rpg_stats;
  const eventSource = stagedState && Array.isArray(stagedState.eventTriggers)
    ? stagedState.eventTriggers
    : row.event_triggers;
  const pendingSource = stagedState && Array.isArray(stagedState.pendingEventTriggers)
    ? stagedState.pendingEventTriggers
    : row.pending_event_triggers;
  const rpgStats = (Array.isArray(rpgSource) ? rpgSource : []).flatMap((entry) => {
    const parsed = playerRpgStatSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  const eventTriggers = (Array.isArray(eventSource) ? eventSource : []).flatMap((entry) => {
    const parsed = playerEventTriggerSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  const pendingEventTriggers = (Array.isArray(pendingSource) ? pendingSource : []).flatMap((entry) => {
    const parsed = pendingEventTriggerSchema.safeParse(entry);
    return parsed.success ? [{ ...parsed.data, addTextAfter: false }] : [];
  });
  const latestSnapshot = stagedState || row.state_snapshot_private || {};
  const continuitySummary = typeof latestSnapshot.continuitySummary === "string"
    ? latestSnapshot.continuitySummary.trim()
    : "";
  const openThreads = Array.isArray(latestSnapshot.openThreads)
    ? latestSnapshot.openThreads.filter(
      (value): value is string => typeof value === "string" && Boolean(value.trim())
    )
    : undefined;
  return {
    useRpgStats: row.legacy_settings?.useRpgStats === true,
    rpgStats,
    eventTriggers,
    pendingEventTriggers,
    storyMemoryDefaults: {
      ...(continuitySummary ? { continuitySummary } : {}),
      canonicalFacts: [],
      supersededFacts: [],
      ...(openThreads ? { openThreads } : {})
    },
    suppressEventTriggers: Boolean(row.legacy_settings?.suppressEventTriggers),
    characterProfile: row.character_profile,
    characterSnapshot: row.character_snapshot
  };
}

function mergedTrackers(current: unknown, updates: Array<Record<string, unknown>>): CampaignTracker[] {
  const existing = normalizeCampaignTrackers(current);
  const map = new Map<string, Record<string, unknown>>(
    existing.map((item) => [item.id, { ...item }])
  );
  for (const update of updates) {
    const key = String(update.id || update.name || crypto.randomUUID());
    map.set(key, { ...(map.get(key) || {}), ...update });
  }
  return normalizeCampaignTrackers([...map.values()]);
}

async function commitAcceptedTurn(
  client: DatabaseClient,
  input: AcceptedGenerationCommit
): Promise<{ turnId: string }> {
  const { job, scope, story, provider, response, inputs, orchestration, collaborators } = input;
  const lease = await client.query<{ id: string }>(
    `SELECT id FROM generation_jobs
      WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $3 AND status = 'committing'
      FOR UPDATE`,
    [scope.jobId, scope.ownerUserId, scope.workerId]
  );
  if (!lease.rows[0]) {
    throw Object.assign(new Error("Generation lease was lost or cancelled before commit."), {
      code: "lease_lost"
    });
  }
  const campaignResult = await client.query<{
    active_turn_number: number;
    world_version_id: string;
    character_snapshot: Record<string, unknown> | null;
    character_profile: Record<string, unknown> | null;
    world_content: Record<string, unknown>;
  }>(
    `SELECT c.active_turn_number, c.world_version_id, c.character_snapshot, c.character_profile,
            wv.content AS world_content
       FROM campaigns c
       JOIN world_versions wv ON wv.id = c.world_version_id AND wv.owner_user_id = c.owner_user_id
      WHERE c.id = $1 AND c.owner_user_id = $2
      FOR UPDATE OF c`,
    [job.campaign_id, job.owner_user_id]
  );
  const campaign = campaignResult.rows[0];
  if (!campaign) throw new Error("Campaign disappeared before story commit.");
  const entityCatalog = buildScopedEntityCatalog({
    worldContent: campaign.world_content,
    characterSnapshot: campaign.character_snapshot,
    characterProfile: campaign.character_profile
  });
  const isReplacement = job.operation_kind === "replace_latest";
  const expectedCampaignTurn = isReplacement ? job.expected_turn_number : job.expected_turn_number - 1;
  if (campaign.active_turn_number !== expectedCampaignTurn) {
    throw Object.assign(new Error("Campaign advanced before this generation could commit."), {
      code: "stale_campaign"
    });
  }
  if (isReplacement) {
    const replacement = await client.query<{ id: string }>(
      `SELECT id FROM turns
        WHERE id = $1 AND campaign_id = $2 AND owner_user_id = $3 AND turn_number = $4 FOR UPDATE`,
      [job.replacement_turn_id, job.campaign_id, job.owner_user_id, job.expected_turn_number]
    );
    if (!replacement.rows[0]) {
      throw Object.assign(new Error("The turn selected for replacement changed before commit."), {
        code: "stale_campaign"
      });
    }
    const conflictingWork = await client.query(
      `SELECT 'image' AS kind FROM image_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_id = $3 AND status IN ('queued','generating')
       UNION ALL
       SELECT 'chronicle' AS kind FROM chronicle_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2 AND status = 'running'
       LIMIT 1`,
      [job.campaign_id, job.owner_user_id, job.replacement_turn_id]
    );
    if (conflictingWork.rows[0]) {
      throw Object.assign(new Error("Active derived work prevented the replacement from committing safely."), {
        code: "replacement_work_active"
      });
    }
  }
  const stateResult = await client.query<{ trackers: unknown }>(
    "SELECT trackers FROM campaign_state WHERE campaign_id = $1 AND owner_user_id = $2 FOR UPDATE",
    [job.campaign_id, job.owner_user_id]
  );
  const trackerBase = isReplacement && Array.isArray(job.base_state_private?.trackers)
    ? job.base_state_private.trackers
    : stateResult.rows[0]?.trackers;
  const trackers = mergedTrackers(trackerBase, story.tracker_updates);
  const allEvents = [...(orchestration.beforeEvents || []), ...(orchestration.afterEvents || [])];
  const newlyActivated = allEvents.filter((event) => event.sourceTurn === job.expected_turn_number);
  const eventTriggers = applyTriggerHits(inputs.eventTriggers, newlyActivated, new Date().toISOString());
  const pendingEventTriggers = (orchestration.afterEvents || [])
    .filter((event) => !event.addTextAfter || Boolean(orchestration.extensionError))
    .map(({ addTextAfter: _addTextAfter, ...event }) => event);
  const mechanicsPrivate = {
    roll: orchestration.roll || null,
    beforeEvents: orchestration.beforeEvents || [],
    afterEvents: orchestration.afterEvents || [],
    extensionApplied: Boolean(
      (orchestration.afterEvents || []).some((event) => event.addTextAfter)
      && !orchestration.extensionError
    )
  };
  if (isReplacement) {
    await client.query(
      `DELETE FROM campaign_state_edits
        WHERE campaign_id = $1 AND owner_user_id = $2 AND effective_turn_number > $3`,
      [job.campaign_id, job.owner_user_id, job.base_turn_number ?? 0]
    );
    await client.query(
      `DELETE FROM summary_checkpoints
        WHERE campaign_id = $1 AND owner_user_id = $2 AND through_turn > $3`,
      [job.campaign_id, job.owner_user_id, job.base_turn_number ?? 0]
    );
    await client.query(
      `DELETE FROM chronicle_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2 AND status <> 'running'`,
      [job.campaign_id, job.owner_user_id]
    );
    await client.query(
      "DELETE FROM model_chains WHERE campaign_id = $1 AND owner_user_id = $2",
      [job.campaign_id, job.owner_user_id]
    );
    await client.query(
      "DELETE FROM turns WHERE id = $1 AND campaign_id = $2 AND owner_user_id = $3",
      [job.replacement_turn_id, job.campaign_id, job.owner_user_id]
    );
  }
  const turnResult = await client.query<{ id: string }>(
    `INSERT INTO turns (owner_user_id, campaign_id, turn_number, action, input_mode, input_mode_source, narration, choices,
       custom_action_suggestion, image_prompt, mechanics_private, state_snapshot_private, model_metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [job.owner_user_id, job.campaign_id, job.expected_turn_number, job.action,
      job.resolved_input_mode, job.input_mode_source, story.narration, json(story.choices),
      story.custom_action_suggestion, story.image_prompt, json(mechanicsPrivate),
      json({
        scratchpad: story.scratchpad,
        trackers,
        eventTriggers,
        pendingEventTriggers,
        rpgStats: inputs.rpgStats,
        continuitySummary: story.continuity_summary,
        canonicalFacts: story.canonical_facts,
        supersededFacts: story.superseded_facts,
        canonicalFactUpdates: story.canonical_fact_updates.map((update) => ({
          content: update.content,
          supersedesFactIds: update.supersedes_fact_ids
        })),
        openThreads: story.open_threads
      }),
      json({
        providerProfileId: provider.id,
        providerType: provider.providerType,
        model: provider.model,
        modelInstanceId: response.modelInstanceId,
        responseId: response.responseId,
        usage: response.usage,
        promptProtocolVersion: job.prompt_protocol_version,
        contextFingerprint: input.contextFingerprint,
        contextDiagnostics: input.contextDiagnostics
      })]
  );
  const turnId = turnResult.rows[0]?.id;
  if (!turnId) throw new Error("Story turn insert did not return an ID.");
  await collaborators.attributeGenerationCostsToTurn(
    client,
    job.owner_user_id,
    job.campaign_id,
    job.id,
    turnId
  );
  await client.query(
    `UPDATE campaign_state SET scratchpad_private = $3, scratchpad_safe_for_prompt = true, trackers = $4, event_triggers = $5,
       pending_event_triggers = $6, rpg_stats = $7, revision = revision + 1, updated_at = now()
      WHERE campaign_id = $1 AND owner_user_id = $2`,
    [job.campaign_id, job.owner_user_id, story.scratchpad, json(trackers), json(eventTriggers),
      json(pendingEventTriggers), json(inputs.rpgStats)]
  );
  await client.query(
    "UPDATE campaigns SET active_turn_number = $3, updated_at = now() WHERE id = $1 AND owner_user_id = $2",
    [job.campaign_id, job.owner_user_id, job.expected_turn_number]
  );
  if (isReplacement) {
    await collaborators.memory.rebuildCampaignMemories(client, {
      ownerUserId: job.owner_user_id,
      campaignId: job.campaign_id,
      worldVersionId: campaign.world_version_id
    });
    await client.query(
      `INSERT INTO activity_events (owner_user_id, campaign_id, event_type, correlation_id, details)
       VALUES ($1,$2,'campaign_turn_replaced',$3,$4)`,
      [job.owner_user_id, job.campaign_id, job.id,
        json({ turnNumber: job.expected_turn_number, replacementTurnId: turnId })]
    );
  } else {
    await collaborators.memory.storeDerivedTurnMemories(client, {
      ownerUserId: job.owner_user_id,
      campaignId: job.campaign_id,
      worldVersionId: campaign.world_version_id,
      turnId,
      ordinal: job.expected_turn_number,
      derived: {
        continuitySummary: story.continuity_summary,
        canonicalFacts: story.canonical_facts,
        supersededFacts: story.superseded_facts,
        canonicalFactUpdates: story.canonical_fact_updates.map((update) => ({
          content: update.content,
          supersedesFactIds: update.supersedes_fact_ids
        })),
        openThreads: story.open_threads,
        entityCatalog
      }
    });
    const memory = buildTurnFictionMemory(
      { action: input.fictionAction, narration: story.narration },
      job.expected_turn_number
    );
    const entityMetadata = resolveEntityMetadata(memory.content, entityCatalog);
    await collaborators.memory.writeAcceptedTurnFiction(client, {
      ownerUserId: job.owner_user_id,
      campaignId: job.campaign_id,
      worldVersionId: campaign.world_version_id,
      turnId,
      ordinal: job.expected_turn_number,
      action: input.fictionAction,
      narration: story.narration
    });
  }
  await client.query("SAVEPOINT accepted_turn_illustration_enqueue");
  try {
    if (job.streaming_segments_state?.provisionalSetId) {
      const illustrationConfig = await collaborators.illustration.loadStreamingIllustrationConfig(
        client,
        { ownerUserId: job.owner_user_id, campaignId: job.campaign_id }
      ).catch(() => null);
      if (illustrationConfig) {
        await collaborators.illustration.promoteProvisionalSet(
          client,
          { ownerUserId: job.owner_user_id, campaignId: job.campaign_id, generationJobId: job.id, turnId },
          { finalNarration: story.narration, config: illustrationConfig }
        );
      } else {
        await collaborators.illustration.enqueueAcceptedTurnIllustrationSegments(
          client,
          { ownerUserId: job.owner_user_id, campaignId: job.campaign_id, turnId }
        );
      }
    } else {
      await collaborators.illustration.enqueueAcceptedTurnIllustrationSegments(
        client,
        { ownerUserId: job.owner_user_id, campaignId: job.campaign_id, turnId }
      );
    }
    await client.query("RELEASE SAVEPOINT accepted_turn_illustration_enqueue");
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT accepted_turn_illustration_enqueue");
    await client.query("RELEASE SAVEPOINT accepted_turn_illustration_enqueue");
    input.onIllustrationEnqueueError(error, turnId);
  }
  await collaborators.memory.enqueueEmbeddingReindex(client, {
    ownerUserId: job.owner_user_id,
    campaignId: job.campaign_id,
    worldVersionId: campaign.world_version_id
  });
  const completed = await client.query<{ id: string }>(
    `UPDATE generation_jobs SET status = 'completed', result_turn_id = $3, provider_response_id = $4,
       provider_finish_reason = $5, completed_at = now(), updated_at = now(), lease_owner = NULL, lease_expires_at = NULL,
       partial_output = NULL, error_code = NULL, error_message = NULL
     WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $6 AND status = 'committing'
     RETURNING id`,
    [job.id, job.owner_user_id, turnId, response.responseId || null,
      response.finishReason || null, scope.workerId]
  );
  if (!completed.rows[0]) {
    throw Object.assign(new Error("Generation was cancelled or its lease was lost while marking the committed turn complete."), {
      code: "generation_cancelled"
    });
  }
  return { turnId };
}

function changed(result: { rows: readonly unknown[] }): boolean {
  return result.rows.length === 1;
}

export function createPostgresGenerationExecutionRepository(
  pool: DatabasePool
): GenerationClaimRepository & GenerationExecutionRepository {
  return {
    async claimNext(request) {
      return withTransaction(pool, async (client) => {
        const result = await client.query<{
          id: string;
          owner_user_id: string;
          campaign_id: string;
          provider_profile_id: string;
          expected_turn_number: number;
          operation_kind: "append" | "replace_latest";
          replacement_turn_id: string | null;
          attempts: number;
        }>(
          `WITH candidate AS (
             SELECT id FROM generation_jobs
              WHERE status IN ('queued','replacement_queued')
                 OR (status IN ('assessing','generating','validating','committing') AND lease_expires_at < now())
              ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
           )
           UPDATE generation_jobs j SET status = 'assessing', attempts = attempts + 1, lease_owner = $1,
                  lease_expires_at = now() + ($2::text || ' seconds')::interval, updated_at = now()
             FROM candidate WHERE j.id = candidate.id
           RETURNING j.id, j.owner_user_id, j.campaign_id, j.provider_profile_id,
                     j.expected_turn_number, j.operation_kind, j.replacement_turn_id, j.attempts`,
          [request.workerId, request.leaseSeconds]
        );
        return result.rows[0] ? claimedGeneration(result.rows[0]) : null;
      });
    },

    async loadExecutionPayload(request) {
      const result = await pool.query<ExecutionPayloadRow>(
        `SELECT j.id, j.owner_user_id, j.campaign_id, j.provider_profile_id,
                j.expected_turn_number, j.operation_kind, j.replacement_turn_id,
                j.base_turn_number, j.base_state_private, j.base_scratchpad_safe_for_prompt,
                j.action, j.requested_input_mode, j.resolved_input_mode, j.input_mode_source,
                j.requested_model, j.context_options, j.prompt_protocol_version, j.prompt_snapshot,
                j.attempts, j.orchestration_private, j.streaming_segments_state,
                c.world_version_id, c.legacy_settings, c.character_profile, c.character_snapshot,
                cs.rpg_stats, cs.event_triggers, cs.pending_event_triggers,
                latest.state_snapshot_private
           FROM generation_jobs j
           JOIN campaigns c ON c.id = j.campaign_id AND c.owner_user_id = j.owner_user_id
           JOIN campaign_state cs ON cs.campaign_id = c.id AND cs.owner_user_id = c.owner_user_id
           LEFT JOIN LATERAL (
             SELECT state_snapshot_private FROM turns
              WHERE campaign_id = c.id AND owner_user_id = c.owner_user_id
              ORDER BY turn_number DESC LIMIT 1
           ) latest ON true
          WHERE j.id = $1 AND j.owner_user_id = $2
            AND j.lease_owner = $3 AND j.status = 'assessing'`,
        [request.claim.jobId, request.claim.ownerUserId, request.workerId]
      );
      const row = result.rows[0];
      if (!row) return null;
      const {
        legacy_settings: _legacySettings,
        rpg_stats: _rpgStats,
        event_triggers: _eventTriggers,
        pending_event_triggers: _pendingEventTriggers,
        state_snapshot_private: _stateSnapshot,
        character_profile: _characterProfile,
        character_snapshot: _characterSnapshot,
        ...payload
      } = row;
      return { ...payload, orchestration_inputs: orchestrationInputs(row) };
    },

    async renewLease(scope, leaseSeconds) {
      return changed(await pool.query<{ id: string }>(
        `UPDATE generation_jobs
            SET lease_expires_at = now() + ($4::text || ' seconds')::interval, updated_at = now()
          WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $3
            AND status IN ('assessing','generating','validating','committing')
          RETURNING id`,
        [scope.jobId, scope.ownerUserId, scope.workerId, leaseSeconds]
      ));
    },

    async markGenerating(scope) {
      return changed(await pool.query<{ id: string }>(
        `UPDATE generation_jobs SET status = 'generating', updated_at = now()
          WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $3 AND status = 'assessing'
          RETURNING id`,
        [scope.jobId, scope.ownerUserId, scope.workerId]
      ));
    },

    async saveOrchestration(scope, value) {
      return changed(await pool.query<{ id: string }>(
        `UPDATE generation_jobs SET orchestration_private = $4, updated_at = now()
          WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $3
            AND status IN ('assessing','generating','validating','committing')
          RETURNING id`,
        [scope.jobId, scope.ownerUserId, scope.workerId, json(value)]
      ));
    },

    async savePartialNarration(scope, narration) {
      return changed(await pool.query<{ id: string }>(
        `UPDATE generation_jobs SET partial_output = $4, updated_at = now()
          WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $3 AND status = 'generating'
          RETURNING id`,
        [scope.jobId, scope.ownerUserId, scope.workerId, narration]
      ));
    },

    async saveStreamingSegments(scope, value) {
      return changed(await pool.query<{ id: string }>(
        `UPDATE generation_jobs SET streaming_segments_state = $4, updated_at = now()
          WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $3 AND status = 'generating'
          RETURNING id`,
        [scope.jobId, scope.ownerUserId, scope.workerId, json(value)]
      ));
    },

    async recordAttempt(input) {
      const result = await pool.query(
        `WITH authorized_job AS MATERIALIZED (
           SELECT id FROM generation_jobs
            WHERE id = $2 AND owner_user_id = $1 AND lease_owner = $11
              AND status IN ('assessing','generating','validating','committing')
            FOR UPDATE
         )
         INSERT INTO generation_attempts (
           owner_user_id, generation_job_id, attempt_number, recovery_kind, request_metadata,
           response_metadata, provider_response_id, finish_reason, raw_output, validation_errors, completed_at
         ) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()
             FROM authorized_job
         ON CONFLICT (generation_job_id, attempt_number) DO UPDATE SET
           response_metadata = CASE WHEN $12 THEN EXCLUDED.response_metadata ELSE generation_attempts.response_metadata END,
           provider_response_id = CASE WHEN $12 THEN EXCLUDED.provider_response_id ELSE generation_attempts.provider_response_id END,
           finish_reason = CASE WHEN $12 THEN EXCLUDED.finish_reason ELSE generation_attempts.finish_reason END,
           raw_output = CASE WHEN $12 THEN EXCLUDED.raw_output ELSE generation_attempts.raw_output END,
           validation_errors = CASE WHEN $12 THEN EXCLUDED.validation_errors ELSE generation_attempts.validation_errors END,
           completed_at = CASE WHEN $12 THEN now() ELSE generation_attempts.completed_at END
         RETURNING generation_job_id`,
        [input.ownerUserId, input.jobId, input.attemptNumber, input.recoveryKind,
          json(input.requestMetadata), json(input.responseMetadata), input.providerResponseId,
          input.finishReason, input.rawOutput, json(input.validationErrors), input.workerId,
          input.overwrite]
      );
      if (!changed(result)) {
        throw Object.assign(new Error("Generation attempt owner, lease, or source state no longer matched."), {
          code: "generation_cancelled"
        });
      }
    },

    async markRecoverable(input) {
      return changed(await pool.query<{ id: string }>(
        `UPDATE generation_jobs SET status = 'recoverable', provider_response_id = $4,
           provider_finish_reason = $5, error_code = $6, error_message = $7,
           recovery_metadata = recovery_metadata || $8::jsonb,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $3
           AND status IN ('assessing','generating','validating','committing')
         RETURNING id`,
        [input.jobId, input.ownerUserId, input.workerId, input.providerResponseId,
          input.providerFinishReason, input.errorCode, input.errorMessage,
          json(input.recoveryMetadata)]
      ));
    },

    async markValidating(scope) {
      return changed(await pool.query<{ id: string }>(
        `UPDATE generation_jobs SET status = 'validating', updated_at = now()
          WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $3 AND status = 'generating'
          RETURNING id`,
        [scope.jobId, scope.ownerUserId, scope.workerId]
      ));
    },

    async markCommitting(scope) {
      return changed(await pool.query<{ id: string }>(
        `UPDATE generation_jobs SET status = 'committing', updated_at = now()
          WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $3 AND status = 'validating'
          RETURNING id`,
        [scope.jobId, scope.ownerUserId, scope.workerId]
      ));
    },

    async commitAcceptedTurn(input) {
      return withTransaction(pool, (client) => commitAcceptedTurn(client, input));
    },

    async markFailed(input) {
      return changed(await pool.query<{ id: string }>(
        `UPDATE generation_jobs SET status = 'failed', error_code = $4, error_message = $5,
           recovery_metadata = recovery_metadata || $6::jsonb,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $3
           AND status IN ('assessing','generating','validating','committing')
         RETURNING id`,
        [input.jobId, input.ownerUserId, input.workerId, input.errorCode,
          input.errorMessage, json(input.recoveryMetadata)]
      ));
    }
  };
}
