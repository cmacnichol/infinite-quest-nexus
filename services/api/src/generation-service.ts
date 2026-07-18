import type { DatabaseClient, DatabasePool } from "../../../packages/database/src/pool.js";
import { initialOwnerId, withTransaction } from "../../../packages/database/src/pool.js";
import {
  pendingEventTriggerSchema,
  playerEventTriggerSchema,
  playerRpgStatSchema,
  type GenerationRequest,
  type PlayerCampaignConfig,
  type PlayerEventTrigger,
  type PlayerRpgStat,
  type StoryTurnOutput
} from "../../../packages/contracts/src/generation.js";
import type { MemoryContextQuery } from "../../../packages/contracts/src/memory.js";
import { buildTurnFictionMemory } from "../../../packages/story-engine/src/chronicle.js";
import {
  activatedEventsFromResponse,
  applyTriggerHits,
  buildEventExtensionPrompt,
  buildEventTriggerPrompt,
  buildRpgAssessmentPrompt,
  buildStoryUserPrompt,
  callTextProvider,
  containsMechanicsLanguage,
  EVENT_EXTENSION_SYSTEM_PROMPT,
  EVENT_TRIGGER_SYSTEM_PROMPT,
  fictionGuidanceForEvents,
  fictionGuidanceForRoll,
  localRpgAssessment,
  mechanicsLeakFields,
  parseEventExtension,
  parseRpgAssessment,
  parseStoryOutput,
  performPrivateRoll,
  recoveryInstruction,
  RPG_ASSESSMENT_SYSTEM_PROMPT,
  STORY_PROMPT_PROTOCOL_VERSION,
  STORY_SYSTEM_PROMPT,
  type ActivatedEvent,
  type PrivateRollResolution
} from "../../../packages/story-engine/src/index.js";
import { sha256, stripMechanicsLeakage } from "../../../packages/domain/src/text.js";
import { buildContextPreview, enqueueEmbeddingReindex } from "./memory-service.js";
import { loadTextProvider } from "./provider-service.js";

function json(value: unknown): string { return JSON.stringify(value ?? null); }

type ClaimedJob = {
  id: string;
  owner_user_id: string;
  campaign_id: string;
  provider_profile_id: string;
  expected_turn_number: number;
  action: string;
  requested_model: string;
  context_options: MemoryContextQuery & { modelContextWindowTokens?: number };
  prompt_protocol_version: string;
  attempts: number;
  orchestration_private: OrchestrationPrivate;
};

type OrchestrationPrivate = {
  roll?: PrivateRollResolution | null;
  rpgAssessmentError?: string;
  beforeEvents?: ActivatedEvent[];
  beforeTriggerError?: string;
  afterEvents?: ActivatedEvent[];
  afterTriggerError?: string;
  extension?: { additionalText: string; scratchpad?: string; trackerUpdates: Array<Record<string, unknown>> };
  extensionError?: string;
};

type OrchestrationInputs = {
  useRpgStats: boolean;
  suppressEventTriggers: boolean;
  rpgStats: PlayerRpgStat[];
  eventTriggers: PlayerEventTrigger[];
  pendingEventTriggers: ActivatedEvent[];
};

export async function enqueueGeneration(pool: DatabasePool, campaignId: string, request: GenerationRequest) {
  const ownerUserId = await initialOwnerId(pool);
  return withTransaction(pool, async (client) => {
    const existing = await client.query(`SELECT id, status, result_turn_id AS "resultTurnId" FROM generation_jobs WHERE campaign_id = $1 AND idempotency_key = $2 AND owner_user_id = $3`, [campaignId, request.idempotencyKey, ownerUserId]);
    if (existing.rows[0]) return { ...existing.rows[0], duplicate: true };
    const campaign = await client.query<{ active_turn_number: number }>(`SELECT active_turn_number FROM campaigns WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`, [campaignId, ownerUserId]);
    const row = campaign.rows[0];
    if (!row) throw Object.assign(new Error("Campaign not found."), { statusCode: 404 });
    try {
      const result = await client.query(
        `INSERT INTO generation_jobs (
           owner_user_id, campaign_id, provider_profile_id, idempotency_key, expected_turn_number,
           action, requested_model, context_options, prompt_protocol_version, recovery_metadata
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id, status, expected_turn_number AS "expectedTurnNumber", created_at AS "createdAt"`,
        [ownerUserId, campaignId, request.providerProfileId, request.idempotencyKey, row.active_turn_number + 1,
          request.action, request.model || "", json(request.context), STORY_PROMPT_PROTOCOL_VERSION, json({})]
      );
      return { ...result.rows[0], duplicate: false };
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "23505") {
        throw Object.assign(new Error("This campaign already has an active story generation."), { statusCode: 409 });
      }
      throw error;
    }
  });
}

export async function getGenerationJob(pool: DatabasePool, jobId: string) {
  const ownerUserId = await initialOwnerId(pool);
  const result = await pool.query(
    `SELECT id, campaign_id AS "campaignId", provider_profile_id AS "providerProfileId",
            expected_turn_number AS "expectedTurnNumber", action, status, attempts,
            requested_model AS "requestedModel", provider_response_id AS "providerResponseId",
            provider_finish_reason AS "providerFinishReason", result_turn_id AS "resultTurnId",
            error_code AS "errorCode", error_message AS "errorMessage", recovery_metadata AS "recoveryMetadata",
            created_at AS "createdAt", updated_at AS "updatedAt", completed_at AS "completedAt"
       FROM generation_jobs WHERE id = $1 AND owner_user_id = $2`, [jobId, ownerUserId]
  );
  const row = result.rows[0];
  if (!row) throw Object.assign(new Error("Generation job not found."), { statusCode: 404 });
  return row;
}

export async function getGenerationResult(pool: DatabasePool, jobId: string) {
  const ownerUserId = await initialOwnerId(pool);
  const result = await pool.query(
    `SELECT j.id, j.status, j.campaign_id AS "campaignId", j.expected_turn_number AS "expectedTurnNumber",
            j.result_turn_id AS "resultTurnId", j.error_code AS "errorCode", j.error_message AS "errorMessage",
            t.turn_number AS "turnNumber", t.action, t.narration, t.choices,
            t.custom_action_suggestion AS "customActionSuggestion", t.image_prompt AS "imagePrompt",
            t.model_metadata AS "modelMetadata", t.mechanics_private AS mechanics,
            jsonb_build_object(
              'scratchpad', cs.scratchpad_private,
              'trackers', cs.trackers,
              'eventTriggers', cs.event_triggers,
              'pendingEventTriggers', cs.pending_event_triggers,
              'rpgStats', cs.rpg_stats
            ) AS "stateSnapshot"
       FROM generation_jobs j
       LEFT JOIN turns t ON t.id = j.result_turn_id AND t.owner_user_id = j.owner_user_id
       LEFT JOIN campaign_state cs ON cs.campaign_id = j.campaign_id AND cs.owner_user_id = j.owner_user_id
      WHERE j.id = $1 AND j.owner_user_id = $2`,
    [jobId, ownerUserId]
  );
  const row = result.rows[0];
  if (!row) throw Object.assign(new Error("Generation job not found."), { statusCode: 404 });
  if (row.status !== "completed" || !row.resultTurnId) {
    throw Object.assign(new Error(row.errorMessage || `Generation is ${row.status}.`), { statusCode: 409 });
  }
  return row;
}

export async function retryGeneration(pool: DatabasePool, jobId: string) {
  const ownerUserId = await initialOwnerId(pool);
  const result = await pool.query(
    `UPDATE generation_jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
            error_code = NULL, error_message = NULL, prompt_protocol_version = $3, updated_at = now()
      WHERE id = $1 AND owner_user_id = $2 AND status IN ('recoverable', 'failed')
      RETURNING id, status`, [jobId, ownerUserId, STORY_PROMPT_PROTOCOL_VERSION]
  );
  if (!result.rows[0]) throw Object.assign(new Error("Only recoverable or failed generation jobs can be retried."), { statusCode: 409 });
  return result.rows[0];
}

export async function syncPlayerCampaignConfig(pool: DatabasePool, campaignId: string, config: PlayerCampaignConfig) {
  const ownerUserId = await initialOwnerId(pool);
  return withTransaction(pool, async (client) => {
    const campaign = await client.query<{ active_turn_number: number }>(
      `SELECT active_turn_number FROM campaigns WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
      [campaignId, ownerUserId]
    );
    const row = campaign.rows[0];
    if (!row) throw Object.assign(new Error("Campaign not found."), { statusCode: 404 });
    if (row.active_turn_number !== config.expectedTurnNumber) {
      throw Object.assign(new Error(`Campaign is at turn ${row.active_turn_number}, not expected turn ${config.expectedTurnNumber}.`), { statusCode: 409 });
    }
    const activeJob = await client.query(
      `SELECT id FROM generation_jobs
        WHERE campaign_id = $1 AND owner_user_id = $2
          AND status IN ('queued','assessing','generating','validating','committing','indexing')
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
    await client.query(
      `UPDATE campaign_state
          SET rpg_stats = $3, event_triggers = $4, pending_event_triggers = $5, updated_at = now()
        WHERE campaign_id = $1 AND owner_user_id = $2`,
      [campaignId, ownerUserId, json(config.rpgStats), json(config.eventTriggers), json(config.pendingEventTriggers)]
    );
    return { campaignId, activeTurnNumber: row.active_turn_number, synchronized: true };
  });
}

async function claimGeneration(pool: DatabasePool, workerId: string, leaseSeconds: number): Promise<ClaimedJob | null> {
  return withTransaction(pool, async (client) => {
    const result = await client.query<ClaimedJob>(
      `WITH candidate AS (
         SELECT id FROM generation_jobs
          WHERE status = 'queued' OR (status IN ('assessing','generating','validating','committing','indexing') AND lease_expires_at < now())
          ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE generation_jobs j SET status = 'assessing', attempts = attempts + 1, lease_owner = $1,
              lease_expires_at = now() + ($2::text || ' seconds')::interval, updated_at = now()
         FROM candidate WHERE j.id = candidate.id
       RETURNING j.id, j.owner_user_id, j.campaign_id, j.provider_profile_id, j.expected_turn_number,
                 j.action, j.requested_model, j.context_options, j.prompt_protocol_version, j.attempts,
                 j.orchestration_private`,
      [workerId, leaseSeconds]
    );
    return result.rows[0] ?? null;
  });
}

function mergedTrackers(current: unknown, updates: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const existing = Array.isArray(current) ? current.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null) : [];
  const map = new Map(existing.map((item, index) => [String(item.id || item.name || index), item]));
  for (const update of updates) {
    const key = String(update.id || update.name || crypto.randomUUID());
    map.set(key, { ...(map.get(key) || {}), ...update });
  }
  return [...map.values()];
}

async function loadOrchestrationInputs(pool: DatabasePool, job: ClaimedJob): Promise<OrchestrationInputs> {
  const result = await pool.query<{
    legacy_settings: Record<string, unknown>;
    rpg_stats: unknown;
    event_triggers: unknown;
    pending_event_triggers: unknown;
  }>(
    `SELECT c.legacy_settings, cs.rpg_stats, cs.event_triggers, cs.pending_event_triggers
       FROM campaigns c
       JOIN campaign_state cs ON cs.campaign_id = c.id AND cs.owner_user_id = c.owner_user_id
      WHERE c.id = $1 AND c.owner_user_id = $2`,
    [job.campaign_id, job.owner_user_id]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Campaign orchestration state was not found.");
  const rpgStats = (Array.isArray(row.rpg_stats) ? row.rpg_stats : []).flatMap((entry) => {
    const parsed = playerRpgStatSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  const eventTriggers = (Array.isArray(row.event_triggers) ? row.event_triggers : []).flatMap((entry) => {
    const parsed = playerEventTriggerSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  const pendingEventTriggers = (Array.isArray(row.pending_event_triggers) ? row.pending_event_triggers : []).flatMap((entry) => {
    const parsed = pendingEventTriggerSchema.safeParse(entry);
    return parsed.success ? [{ ...parsed.data, addTextAfter: false }] : [];
  });
  return {
    useRpgStats: row.legacy_settings?.useRpgStats === true,
    suppressEventTriggers: row.legacy_settings?.suppressEventTriggers === true,
    rpgStats,
    eventTriggers,
    pendingEventTriggers
  };
}

async function persistOrchestration(pool: DatabasePool, job: ClaimedJob, patch: Partial<OrchestrationPrivate>, workerId: string): Promise<OrchestrationPrivate> {
  const merged = { ...(job.orchestration_private || {}), ...patch };
  const result = await pool.query(
    `UPDATE generation_jobs SET orchestration_private = $3, updated_at = now()
      WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $4
      RETURNING id`,
    [job.id, job.owner_user_id, json(merged), workerId]
  );
  if (!result.rows[0]) throw Object.assign(new Error("Generation lease was lost while persisting private orchestration."), { code: "lease_lost" });
  job.orchestration_private = merged;
  return merged;
}

async function evaluateTriggers(
  provider: Awaited<ReturnType<typeof loadTextProvider>>,
  phase: "before" | "after",
  context: unknown,
  job: ClaimedJob,
  triggers: PlayerEventTrigger[],
  narration = ""
): Promise<ActivatedEvent[]> {
  if (!triggers.length) return [];
  const response = await callTextProvider(provider, {
    systemPrompt: EVENT_TRIGGER_SYSTEM_PROMPT,
    input: buildEventTriggerPrompt(phase, context, job.action, job.expected_turn_number, triggers, narration)
  });
  if (response.outputLimited) throw new Error("The private event evaluation reached its output limit.");
  return activatedEventsFromResponse(response.content, triggers, job.expected_turn_number);
}

async function commitStory(
  client: DatabaseClient,
  job: ClaimedJob,
  story: StoryTurnOutput,
  provider: Awaited<ReturnType<typeof loadTextProvider>>,
  response: Awaited<ReturnType<typeof callTextProvider>>,
  contextFingerprint: string,
  inputs: OrchestrationInputs,
  orchestration: OrchestrationPrivate,
  fictionAction: string,
  workerId: string
): Promise<string> {
  const lease = await client.query<{ lease_owner: string | null }>(
    `SELECT lease_owner FROM generation_jobs WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
    [job.id, job.owner_user_id]
  );
  if (lease.rows[0]?.lease_owner !== workerId) throw Object.assign(new Error("Generation lease was lost before commit."), { code: "lease_lost" });
  const campaignResult = await client.query<{ active_turn_number: number; world_version_id: string }>(
    `SELECT active_turn_number, world_version_id FROM campaigns WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`, [job.campaign_id, job.owner_user_id]
  );
  const campaign = campaignResult.rows[0];
  if (!campaign) throw new Error("Campaign disappeared before story commit.");
  if (campaign.active_turn_number + 1 !== job.expected_turn_number) throw Object.assign(new Error("Campaign advanced before this generation could commit."), { code: "stale_campaign" });
  const stateResult = await client.query<{ trackers: unknown }>(`SELECT trackers FROM campaign_state WHERE campaign_id = $1 AND owner_user_id = $2 FOR UPDATE`, [job.campaign_id, job.owner_user_id]);
  const trackers = mergedTrackers(stateResult.rows[0]?.trackers, story.tracker_updates);
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
    extensionApplied: Boolean((orchestration.afterEvents || []).some((event) => event.addTextAfter) && !orchestration.extensionError)
  };
  const turnResult = await client.query<{ id: string }>(
    `INSERT INTO turns (owner_user_id, campaign_id, turn_number, action, narration, choices,
       custom_action_suggestion, image_prompt, mechanics_private, state_snapshot_private, model_metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [job.owner_user_id, job.campaign_id, job.expected_turn_number, job.action, story.narration, json(story.choices),
      story.custom_action_suggestion, story.image_prompt, json(mechanicsPrivate),
      json({ scratchpad: story.scratchpad, trackers, eventTriggers, pendingEventTriggers, rpgStats: inputs.rpgStats }),
      json({ providerProfileId: provider.id, providerType: provider.providerType, model: provider.model, modelInstanceId: response.modelInstanceId,
        responseId: response.responseId, usage: response.usage, promptProtocolVersion: job.prompt_protocol_version })]
  );
  const turnId = turnResult.rows[0]?.id;
  if (!turnId) throw new Error("Story turn insert did not return an ID.");
  await client.query(
    `UPDATE campaign_state SET scratchpad_private = $3, trackers = $4, event_triggers = $5,
       pending_event_triggers = $6, updated_at = now()
      WHERE campaign_id = $1 AND owner_user_id = $2`,
    [job.campaign_id, job.owner_user_id, story.scratchpad, json(trackers), json(eventTriggers), json(pendingEventTriggers)]
  );
  await client.query(`UPDATE campaigns SET active_turn_number = $3, updated_at = now() WHERE id = $1 AND owner_user_id = $2`, [job.campaign_id, job.owner_user_id, job.expected_turn_number]);
  const memory = buildTurnFictionMemory({ action: fictionAction, narration: story.narration }, job.expected_turn_number);
  await client.query(
    `INSERT INTO chronicle_memories (owner_user_id, campaign_id, world_version_id, turn_id, memory_kind, ordinal, content, token_estimate, importance, entities, metadata)
     VALUES ($1,$2,$3,$4,'turn_fiction',$5,$6,$7,$8,$9,$10)`,
    [job.owner_user_id, job.campaign_id, campaign.world_version_id, turnId, job.expected_turn_number, memory.content, memory.tokenEstimate,
      Math.min(1, 0.5 + job.expected_turn_number / 100), memory.entities, json({ sanitized: memory.sanitized, removedMechanicsSegments: memory.removedMechanicsSegments, generated: true })]
  );
  if (response.responseId) {
    await client.query(
      `INSERT INTO model_chains (owner_user_id, campaign_id, world_version_id, provider_profile_id, model, endpoint_identity,
         prompt_protocol_version, context_fingerprint, previous_response_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (campaign_id, provider_profile_id, model, endpoint_identity, prompt_protocol_version, context_fingerprint)
       DO UPDATE SET previous_response_id = EXCLUDED.previous_response_id, active = true, updated_at = now()`,
      [job.owner_user_id, job.campaign_id, campaign.world_version_id, provider.id, provider.model, provider.baseUrl,
        job.prompt_protocol_version, contextFingerprint, response.responseId]
    );
  }
  await client.query(
    `UPDATE generation_jobs SET status = 'completed', result_turn_id = $3, provider_response_id = $4,
       provider_finish_reason = $5, completed_at = now(), updated_at = now(), lease_owner = NULL, lease_expires_at = NULL,
       partial_output = NULL, error_code = NULL, error_message = NULL
     WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $6`,
    [job.id, job.owner_user_id, turnId, response.responseId || null, response.finishReason || null, workerId]
  );
  return turnId;
}

export async function runGenerationJob(pool: DatabasePool, workerId: string, leaseSeconds: number, credentialSecret: string): Promise<boolean> {
  const job = await claimGeneration(pool, workerId, leaseSeconds);
  if (!job) return false;
  const heartbeat = setInterval(() => {
    void pool.query(
      `UPDATE generation_jobs SET lease_expires_at = now() + ($3::text || ' seconds')::interval, updated_at = now()
        WHERE id = $1 AND lease_owner = $2 AND status IN ('assessing','generating','validating','committing','indexing')`,
      [job.id, workerId, leaseSeconds]
    ).catch(() => undefined);
  }, Math.max(5000, Math.floor(leaseSeconds * 1000 / 3)));
  try {
    const provider = await loadTextProvider(pool, job.owner_user_id, job.provider_profile_id, credentialSecret, job.requested_model);
    const strippedAction = stripMechanicsLeakage(job.action).text;
    const safeAction = strippedAction && !containsMechanicsLanguage(strippedAction)
      ? strippedAction
      : "Continue from the current scene through natural fictional events.";
    const effectiveContextWindow = Number(job.context_options.modelContextWindowTokens || provider.contextWindowTokens);
    const safeContextBudget = Math.max(512, Math.min(
      Number(job.context_options.budgetTokens || 32000),
      Math.max(512, effectiveContextWindow - provider.maxOutputTokens - 1024)
    ));
    const context = await buildContextPreview(pool, job.campaign_id, { ...job.context_options, budgetTokens: safeContextBudget, query: safeAction }, credentialSecret);
    const promptContext = context.scopes;
    const inputs = await loadOrchestrationInputs(pool, job);
    let orchestration = job.orchestration_private || {};
    if (orchestration.roll === undefined) {
      if (inputs.useRpgStats && job.expected_turn_number > 1 && inputs.rpgStats.length) {
        let assessment;
        let assessmentError = "";
        try {
          const response = await callTextProvider(provider, {
            systemPrompt: RPG_ASSESSMENT_SYSTEM_PROMPT,
            input: buildRpgAssessmentPrompt(promptContext, job.action, inputs.rpgStats)
          });
          if (response.outputLimited) throw new Error("The private RPG assessment reached its output limit.");
          assessment = parseRpgAssessment(response.content);
        } catch (error) {
          assessmentError = error instanceof Error ? error.message : String(error);
          assessment = localRpgAssessment(job.action, inputs.rpgStats);
        }
        orchestration = await persistOrchestration(pool, job, {
          roll: performPrivateRoll(assessment, inputs.rpgStats),
          ...(assessmentError ? { rpgAssessmentError: assessmentError.slice(0, 2000) } : {})
        }, workerId);
      } else {
        orchestration = await persistOrchestration(pool, job, { roll: null }, workerId);
      }
    }
    if (orchestration.beforeEvents === undefined) {
      let activated: ActivatedEvent[] = [];
      let triggerError = "";
      if (!inputs.suppressEventTriggers) {
        const triggers = inputs.eventTriggers.filter((trigger) => trigger.timing === "before");
        try {
          activated = await evaluateTriggers(provider, "before", promptContext, job, triggers);
        } catch (error) {
          triggerError = error instanceof Error ? error.message : String(error);
        }
      }
      orchestration = await persistOrchestration(pool, job, {
        beforeEvents: [...inputs.pendingEventTriggers, ...activated],
        ...(triggerError ? { beforeTriggerError: triggerError.slice(0, 2000) } : {})
      }, workerId);
    }
    const safeGuidance = [
      ...fictionGuidanceForRoll(orchestration.roll || null),
      ...fictionGuidanceForEvents(orchestration.beforeEvents || [])
    ].filter((entry) => entry && !containsMechanicsLanguage(entry));
    await pool.query(`UPDATE generation_jobs SET status = 'generating', updated_at = now() WHERE id = $1 AND lease_owner = $2`, [job.id, workerId]);
    const contextFingerprint = sha256(json({ provider: provider.id, model: provider.model, protocol: job.prompt_protocol_version, contextOptions: job.context_options }));
    const baseRequest = { systemPrompt: STORY_SYSTEM_PROMPT, input: buildStoryUserPrompt(promptContext, safeAction, false, safeGuidance) };
    let result = await callTextProvider(provider, baseRequest);
    let parsed = parseStoryOutput(result.content);
    const firstReason = result.outputLimited ? "output_limit" : (!parsed.ok ? parsed.code : null);
    const initialValidationErrors = parsed.ok ? [] : parsed.errors;
    const initialAttemptNumber = job.attempts * 2 - 1;
    await pool.query(
      `INSERT INTO generation_attempts (owner_user_id, generation_job_id, attempt_number, recovery_kind, request_metadata,
         response_metadata, provider_response_id, finish_reason, raw_output, validation_errors, completed_at)
       VALUES ($1,$2,$3,'initial',$4,$5,$6,$7,$8,$9,now())
       ON CONFLICT (generation_job_id, attempt_number) DO UPDATE SET response_metadata = EXCLUDED.response_metadata,
         provider_response_id = EXCLUDED.provider_response_id, finish_reason = EXCLUDED.finish_reason,
         raw_output = EXCLUDED.raw_output, validation_errors = EXCLUDED.validation_errors, completed_at = now()`,
      [job.owner_user_id, job.id, initialAttemptNumber, json({ model: provider.model, providerType: provider.providerType, contextFingerprint }),
        json({ usage: result.usage, outputLimited: result.outputLimited, modelInstanceId: result.modelInstanceId }), result.responseId || null,
        result.finishReason || null, result.content || null, json(initialValidationErrors)]
    );
    if (firstReason) {
      const recoveryKind = firstReason === "mechanics_leak" ? "mechanics_cleanup" : firstReason === "output_limit" ? "compact_completion" : "schema_repair";
      result = await callTextProvider(provider, {
        ...baseRequest,
        ...(provider.providerType === "lmstudio" && result.responseId && firstReason !== "mechanics_leak" ? { previousResponseId: result.responseId } : {}),
        recoveryInput: recoveryInstruction(firstReason, initialValidationErrors)
      });
      parsed = parseStoryOutput(result.content);
      await pool.query(
        `INSERT INTO generation_attempts (owner_user_id, generation_job_id, attempt_number, recovery_kind, request_metadata,
           response_metadata, provider_response_id, finish_reason, raw_output, validation_errors, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())`,
        [job.owner_user_id, job.id, initialAttemptNumber + 1, recoveryKind, json({ model: provider.model, providerType: provider.providerType, previousResponseIdUsed: provider.providerType === "lmstudio" && firstReason !== "mechanics_leak" }),
          json({ usage: result.usage, outputLimited: result.outputLimited, modelInstanceId: result.modelInstanceId }), result.responseId || null,
          result.finishReason || null, result.content || null, json(parsed.ok ? [] : parsed.errors)]
      );
    }
    const validationFailure = "code" in parsed ? parsed : null;
    if (result.outputLimited || validationFailure) {
      const code = result.outputLimited ? "output_limit" : validationFailure?.code || "invalid_schema";
      const messages = result.outputLimited ? ["The provider stopped before a complete story object was available."] : validationFailure?.errors || ["Story validation failed."];
      const recoverable = await pool.query(
        `UPDATE generation_jobs SET status = 'recoverable', provider_response_id = $3, provider_finish_reason = $4,
           partial_output = $5, error_code = $6, error_message = $7, recovery_metadata = recovery_metadata || $8::jsonb,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2 AND lease_owner = $9
         RETURNING id`,
        [job.id, job.owner_user_id, result.responseId || null, result.finishReason || null, result.content || null, code,
          messages.join(" ").slice(0, 4000), json({ retryable: true, attemptCount: firstReason ? 2 : 1 }), workerId]
      );
      if (!recoverable.rows[0]) throw Object.assign(new Error("Generation lease was lost before recovery state could be saved."), { code: "lease_lost" });
      return true;
    }
    if (!parsed.ok) throw new Error("Story validation invariant failed.");
    if (mechanicsLeakFields(parsed.story).length) throw new Error("Mechanics validation invariant failed.");
    if (orchestration.afterEvents === undefined) {
      let activated: ActivatedEvent[] = [];
      let triggerError = "";
      if (!inputs.suppressEventTriggers) {
        const triggers = inputs.eventTriggers.filter((trigger) => trigger.timing === "after");
        try {
          activated = await evaluateTriggers(provider, "after", promptContext, job, triggers, parsed.story.narration);
        } catch (error) {
          triggerError = error instanceof Error ? error.message : String(error);
        }
      }
      orchestration = await persistOrchestration(pool, job, {
        afterEvents: activated,
        ...(triggerError ? { afterTriggerError: triggerError.slice(0, 2000) } : {})
      }, workerId);
    }
    const immediateEvents = (orchestration.afterEvents || []).filter((event) => event.addTextAfter);
    if (immediateEvents.length && !orchestration.extension && !orchestration.extensionError) {
      try {
        const guidance = fictionGuidanceForEvents(immediateEvents);
        if (!guidance.length) throw new Error("Activated extension instructions were not safe for a fiction prompt.");
        const extensionResponse = await callTextProvider(provider, {
          systemPrompt: EVENT_EXTENSION_SYSTEM_PROMPT,
          input: buildEventExtensionPrompt(parsed.story.narration, guidance)
        });
        if (extensionResponse.outputLimited) throw new Error("The optional event extension reached its output limit.");
        const extension = parseEventExtension(extensionResponse.content);
        orchestration = await persistOrchestration(pool, job, {
          extension: {
            additionalText: extension.additional_text,
            ...(extension.scratchpad !== undefined ? { scratchpad: extension.scratchpad } : {}),
            trackerUpdates: extension.tracker_updates
          }
        }, workerId);
      } catch (error) {
        orchestration = await persistOrchestration(pool, job, { extensionError: (error instanceof Error ? error.message : String(error)).slice(0, 2000) }, workerId);
      }
    }
    const committedStory: StoryTurnOutput = orchestration.extension ? {
      ...parsed.story,
      narration: `${parsed.story.narration}\n\n${orchestration.extension.additionalText}`.trim(),
      scratchpad: orchestration.extension.scratchpad ?? parsed.story.scratchpad,
      tracker_updates: [...parsed.story.tracker_updates, ...orchestration.extension.trackerUpdates]
    } : parsed.story;
    if (mechanicsLeakFields(committedStory).length) throw new Error("Mechanics validation invariant failed after event extension.");
    await pool.query(`UPDATE generation_jobs SET status = 'validating', updated_at = now() WHERE id = $1 AND lease_owner = $2`, [job.id, workerId]);
    await withTransaction(pool, (client) => commitStory(client, job, committedStory, provider, result, contextFingerprint, inputs, orchestration, safeAction, workerId));
    await enqueueEmbeddingReindex(pool, job.campaign_id);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "generation_failed";
    await pool.query(
      `UPDATE generation_jobs SET status = 'failed', error_code = $3, error_message = $4,
         lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND owner_user_id = $2 AND status <> 'completed' AND lease_owner = $5`,
      [job.id, job.owner_user_id, code, (error instanceof Error ? error.message : String(error)).slice(0, 4000), workerId]
    );
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}
