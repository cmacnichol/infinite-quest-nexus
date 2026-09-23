import type {
  LogicalReservation,
  PhysicalAttemptAccountingSummary,
  PhysicalAttemptRecord,
  PhysicalAttemptRepository,
  PresetRouteFailureReason
} from "../../story-engine/src/index.js";
import type { TextRouteCandidate } from "../../contracts/src/text-execution-plan.js";
import { stableStringify } from "../../domain/src/text.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";
import { withTransaction } from "./pool.js";

type AttemptRow = Readonly<{
  id: string;
  status: "reserved" | "dispatched" | "completed";
  logical_reservation: LogicalReservation;
  plan_hash: string;
  requested_preset_slug: string | null;
  requested_preset_version_id: string | null;
  requested_preset_config_hash: string | null;
  candidate_ordinal: number;
  requested_model: string;
  provider_policy: TextRouteCandidate["providerPolicy"];
  request_payload_hash: string;
  request_body: string;
  provider_response_id: string | null;
  returned_model: string | null;
  returned_provider_route: string | null;
  emitted_output: boolean;
}>;

type CampaignCostAttribution = Readonly<{
  campaignId: string;
  providerProfileId: string;
  providerType: string;
  generationJobId: string | null;
  turnId: string | null;
  category: "story" | "image";
  operation: string;
}>;

function reservationKey(value: LogicalReservation): string {
  if (value.kind === "cast_discovery") return `${value.jobId}:${value.chunkOrdinal}:${value.claimAttempt}`;
  if (value.kind === "story") return `${value.generationJobId}:${value.invocationId}`;
  if (value.kind === "authoring") return `${value.jobId}:${value.stageId}:${value.jobGeneration}:${value.stageGeneration}:${value.operation}`;
  if (value.kind === "illustration") return `${value.promptJobId}:${value.claimAttempt}:${value.operation}`;
  return `${value.requestScopeId}:${value.invocationId}:${value.operation}`;
}

function decimalTotal(amounts: readonly string[]): string {
  const scale = Math.max(0, ...amounts.map((amount) => amount.split(".")[1]?.length ?? 0));
  const total = amounts.reduce((sum, amount) => {
    const [whole, fraction = ""] = amount.split(".");
    return sum + BigInt(`${whole}${fraction.padEnd(scale, "0")}`);
  }, 0n);
  if (scale === 0) return total.toString();
  const padded = total.toString().padStart(scale + 1, "0");
  return `${padded.slice(0, -scale)}.${padded.slice(-scale)}`.replace(/\.0+$/u, "").replace(/(\.\d*?)0+$/u, "$1");
}

function accountingSummary(rows: readonly Readonly<{ status: string; usage: unknown; reported_cost: unknown }>[]): PhysicalAttemptAccountingSummary {
  const keys = ["inputTokens", "outputTokens", "totalTokens"] as const;
  const coverage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const totals = { inputTokens: 0n, outputTokens: 0n, totalTokens: 0n };
  const costs = new Map<string, string[]>();
  for (const row of rows) {
    if (row.status !== "completed") continue;
    const usage = row.usage && typeof row.usage === "object" && !Array.isArray(row.usage) ? row.usage as Record<string, unknown> : {};
    for (const key of keys) {
      const amount = usage[key];
      if (Number.isSafeInteger(amount) && Number(amount) >= 0) {
        coverage[key] += 1;
        totals[key] += BigInt(amount as number);
      }
    }
    const cost = row.reported_cost && typeof row.reported_cost === "object" && !Array.isArray(row.reported_cost)
      ? row.reported_cost as Record<string, unknown> : {};
    if (typeof cost.currency === "string" && /^[A-Z]{3}$/u.test(cost.currency)
      && typeof cost.amount === "string" && /^\d+(?:\.\d+)?$/u.test(cost.amount)) {
      costs.set(cost.currency, [...(costs.get(cost.currency) ?? []), cost.amount]);
    }
  }
  return Object.freeze({
    attemptCount: rows.length, completedCount: rows.filter((row) => row.status === "completed").length,
    observedUsage: Object.freeze(Object.fromEntries(keys.map((key) => [key, coverage[key] && totals[key] <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(totals[key]) : null])) as PhysicalAttemptAccountingSummary["observedUsage"]),
    usageCoverage: Object.freeze(coverage),
    reportedCosts: Object.freeze([...costs].sort(([left], [right]) => left.localeCompare(right)).map(([currency, amounts]) => Object.freeze({ currency, amount: decimalTotal(amounts) })))
  });
}

function record(row: AttemptRow): PhysicalAttemptRecord {
  return {
    id: row.id,
    status: row.status,
    logicalReservation: row.logical_reservation,
    planProvenance: {
      planHash: row.plan_hash,
      preset: row.requested_preset_slug && row.requested_preset_version_id && row.requested_preset_config_hash
        ? { slug: row.requested_preset_slug, versionId: row.requested_preset_version_id, configHash: row.requested_preset_config_hash }
        : null
    },
    candidateOrdinal: row.candidate_ordinal,
    candidate: {
      modelId: row.requested_model,
      providerPolicy: row.provider_policy,
      // Durable candidate limits are part of the frozen plan supplied again
      // on reclaim; the attempt row never becomes a plan authority.
      contextWindowTokens: 1,
      maxOutputTokens: 1
    },
    request: { body: row.request_body, payloadHash: row.request_payload_hash },
    responseStarted: row.provider_response_id !== null || row.returned_model !== null || row.returned_provider_route !== null,
    providerResponseId: row.provider_response_id,
    returnedModel: row.returned_model,
    returnedProviderRoute: row.returned_provider_route,
    emittedOutput: row.emitted_output
  };
}

async function hasLiveReservation(client: DatabaseClient, value: LogicalReservation): Promise<boolean> {
  if (value.kind === "direct") return true;
  if (value.kind === "cast_discovery") {
    const parent = (await client.query("SELECT campaign_id FROM campaign_cast_discovery_jobs WHERE id=$1 AND owner_user_id=$2", [value.jobId, value.ownerUserId])).rows[0];
    if (!parent) return false;
    // Serialize against source changes in the same campaign-before-job order as discovery publication.
    const campaign = (await client.query("SELECT active_turn_number FROM campaigns WHERE id=$1 AND owner_user_id=$2 FOR KEY SHARE", [parent.campaign_id, value.ownerUserId])).rows[0];
    if (!campaign) return false;
    const result = await client.query(`SELECT 1 FROM campaign_cast_discovery_jobs job
      JOIN campaign_cast_state state ON state.campaign_id=job.campaign_id AND state.owner_user_id=job.owner_user_id
      JOIN effective_turn_narrations source ON source.turn_id=job.turn_id AND source.campaign_id=job.campaign_id AND source.owner_user_id=job.owner_user_id
      WHERE job.id=$1 AND job.owner_user_id=$2 AND job.status='running' AND job.chunk_ordinal=$3 AND job.attempt=$4
        AND job.lease_token=$5 AND job.lease_expires_at>clock_timestamp() AND job.checkpoint IS NULL
        AND job.timeline_revision=state.timeline_revision AND job.narration_revision=source.correction_revision
        AND job.turn_number<=$6 FOR UPDATE OF job`,
    [value.jobId, value.ownerUserId, value.chunkOrdinal, value.claimAttempt, value.leaseToken, campaign.active_turn_number]);
    return Boolean(result.rows[0]);
  }
  if (value.kind === "story") {
    const result = await client.query(
      `SELECT 1 FROM generation_jobs job
        WHERE job.id=$1 AND job.owner_user_id=$2 AND job.lease_owner=$3
          AND job.status IN ('assessing','generating','validating','committing')
          AND job.lease_expires_at > now()
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(coalesce(job.orchestration_private->'responseContractInvocations','[]'::jsonb)) invocation
             WHERE invocation->>'id'=$4 AND invocation->>'status'='dispatched'
          )`,
      [value.generationJobId, value.ownerUserId, value.workerId, value.invocationId]
    );
    return Boolean(result.rows[0]);
  }
  if (value.kind === "authoring") {
    const result = await client.query(
      `SELECT 1 FROM authoring_jobs job
        JOIN authoring_job_stages stage ON stage.job_id=job.id AND stage.owner_user_id=job.owner_user_id
       WHERE job.id=$1 AND job.owner_user_id=$2 AND stage.id=$3
         AND job.execution_generation=$4 AND stage.generation=$5
         AND stage.status='running' AND stage.lease_token=$6::uuid AND stage.lease_expires_at > now()`,
      [value.jobId, value.ownerUserId, value.stageId, value.jobGeneration, value.stageGeneration, value.leaseToken]
    );
    return Boolean(result.rows[0]);
  }
  const result = await client.query(
    `SELECT 1 FROM illustration_prompt_jobs
      WHERE id=$1 AND owner_user_id=$2 AND status='refining' AND attempts=$3
        AND lease_owner=$4 AND lease_expires_at > now()`,
    [value.promptJobId, value.ownerUserId, value.claimAttempt, value.leaseOwner]
  );
  return Boolean(result.rows[0]);
}

async function lockCampaignCostAttribution(
  client: DatabaseClient,
  reservation: LogicalReservation,
): Promise<CampaignCostAttribution | null> {
  if (reservation.kind === "cast_discovery") {
    // hasLiveReservation already holds the campaign and job locks for this transaction.
    const result = await client.query<{ campaign_id: string; turn_id: string; provider_profile_id: string; provider_type: string }>(
      `SELECT job.campaign_id,job.turn_id,profile.id AS provider_profile_id,profile.provider_type
        FROM campaign_cast_discovery_jobs job JOIN provider_profiles profile
          ON profile.id::text=job.execution_snapshot->>'providerProfileId' AND profile.owner_user_id=job.owner_user_id
        WHERE job.id=$1 AND job.owner_user_id=$2 AND profile.provider_role='text' FOR KEY SHARE OF profile`,
      [reservation.jobId, reservation.ownerUserId]);
    const row = result.rows[0];
    return row ? { campaignId: row.campaign_id, turnId: row.turn_id, providerProfileId: row.provider_profile_id,
      providerType: row.provider_type, generationJobId: null, category: "story", operation: "cast_discovery" } : null;
  }
  if (reservation.kind !== "story" && reservation.kind !== "illustration") return null;
  const parent = reservation.kind === "story"
    ? await client.query<{ provider_profile_id: string | null }>(
      "SELECT provider_profile_id FROM generation_jobs WHERE id=$1 AND owner_user_id=$2",
      [reservation.generationJobId, reservation.ownerUserId]
    )
    : await client.query<{ provider_profile_id: string | null }>(
      "SELECT provider_profile_id FROM illustration_prompt_jobs WHERE id=$1 AND owner_user_id=$2",
      [reservation.promptJobId, reservation.ownerUserId]
    );
  const providerProfileId = parent.rows[0]?.provider_profile_id;
  if (!providerProfileId) return null;
  const profile = await client.query<{ provider_type: string }>(
    "SELECT provider_type FROM provider_profiles WHERE id=$1 AND owner_user_id=$2 FOR KEY SHARE",
    [providerProfileId, reservation.ownerUserId]
  );
  if (!profile.rows[0]) return null;
  const campaign = reservation.kind === "story"
    ? await client.query<{ campaign_id: string }>(
      "SELECT campaign_id FROM generation_jobs WHERE id=$1 AND owner_user_id=$2",
      [reservation.generationJobId, reservation.ownerUserId]
    )
    : await client.query<{ campaign_id: string }>(
      "SELECT campaign_id FROM illustration_prompt_jobs WHERE id=$1 AND owner_user_id=$2",
      [reservation.promptJobId, reservation.ownerUserId]
    );
  const campaignId = campaign.rows[0]?.campaign_id;
  if (!campaignId) return null;
  const lockedCampaign = await client.query<{ id: string }>(
    "SELECT id FROM campaigns WHERE id=$1 AND owner_user_id=$2 FOR KEY SHARE",
    [campaignId, reservation.ownerUserId]
  );
  if (!lockedCampaign.rows[0]) return null;
  if (reservation.kind === "story") {
    const locked = await client.query<{
      campaign_id: string; provider_profile_id: string; operation: string;
    }>(
      `SELECT job.campaign_id,job.provider_profile_id,invocation->>'operation' AS operation
         FROM generation_jobs job
         CROSS JOIN LATERAL jsonb_array_elements(coalesce(job.orchestration_private->'responseContractInvocations','[]'::jsonb)) invocation
        WHERE job.id=$1 AND job.owner_user_id=$2 AND job.lease_owner=$3
          AND job.status IN ('assessing','generating','validating','committing')
          AND job.lease_expires_at > now() AND job.provider_profile_id=$4
          AND invocation->>'id'=$5 AND invocation->>'status'='dispatched'
        FOR UPDATE OF job`,
      [reservation.generationJobId, reservation.ownerUserId, reservation.workerId, providerProfileId, reservation.invocationId]
    );
    const row = locked.rows[0];
    return row && row.campaign_id === campaignId ? {
      campaignId: row.campaign_id, providerProfileId: row.provider_profile_id, providerType: profile.rows[0].provider_type,
      generationJobId: reservation.generationJobId, turnId: null, category: "story", operation: row.operation
    } : null;
  }
  const locked = await client.query<{
    campaign_id: string; turn_id: string; provider_profile_id: string;
  }>(
    `SELECT campaign_id,turn_id,provider_profile_id FROM illustration_prompt_jobs
      WHERE id=$1 AND owner_user_id=$2 AND status='refining' AND attempts=$3
        AND lease_owner=$4 AND lease_expires_at > now() AND provider_profile_id=$5
      FOR UPDATE`,
    [reservation.promptJobId, reservation.ownerUserId, reservation.claimAttempt, reservation.leaseOwner, providerProfileId]
  );
  const row = locked.rows[0];
  return row && row.campaign_id === campaignId ? {
    campaignId: row.campaign_id, providerProfileId: row.provider_profile_id, providerType: profile.rows[0].provider_type,
    generationJobId: null, turnId: row.turn_id, category: "image", operation: "illustration_prompt_refinement"
  } : null;
}

function hasRecordableCost(value: unknown): value is Readonly<{ amount: string; currency: string }> {
  return Boolean(value) && typeof value === "object"
    && typeof (value as { amount?: unknown }).amount === "string"
    && (value as { amount: string }).amount.length <= 64
    && /^\d+(?:\.\d+)?$/u.test((value as { amount: string }).amount)
    && typeof (value as { currency?: unknown }).currency === "string"
    && /^[A-Z]{3}$/u.test((value as { currency: string }).currency);
}

async function materializeCampaignCost(
  client: DatabaseClient,
  attemptId: string,
  attempt: AttemptRow,
  attribution: CampaignCostAttribution,
  completion: Parameters<PhysicalAttemptRepository["complete"]>[2],
): Promise<void> {
  if (!hasRecordableCost(completion.reportedCost)) return;
  await client.query(
    `INSERT INTO provider_cost_events (
       owner_user_id,campaign_id,turn_id,provider_profile_id,generation_job_id,local_call_id,
       provider_type,provider_response_id,category,operation,requested_model,resolved_model,amount,currency,usage_metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
     ON CONFLICT DO NOTHING`,
    [attempt.logical_reservation.ownerUserId, attribution.campaignId, attribution.turnId, attribution.providerProfileId,
      attribution.generationJobId, attemptId, attribution.providerType, completion.providerResponseId ?? null,
      attribution.category, attribution.operation, attempt.requested_model, completion.returnedModel ?? attempt.requested_model,
      completion.reportedCost.amount, completion.reportedCost.currency, JSON.stringify(completion.usage ?? {})]
  );
}

async function loadAttempt(client: DatabaseClient, attemptId: string): Promise<PhysicalAttemptRecord | null> {
  const result = await client.query<AttemptRow>(
    `SELECT id,status,logical_reservation,plan_hash,requested_preset_slug,requested_preset_version_id,
            requested_preset_config_hash,candidate_ordinal,requested_model,provider_policy,
            request_payload_hash,request_body,provider_response_id,returned_model,returned_provider_route,emitted_output
       FROM prepared_text_physical_attempts WHERE id=$1`,
    [attemptId]
  );
  return result.rows[0] ? record(result.rows[0]) : null;
}

export function createPostgresPreparedTextAttemptRepository(pool: DatabasePool): PhysicalAttemptRepository {
  return {
    async summarize(scope) {
      const logicalKind = scope.kind === "logical" ? scope.reservation.kind : scope.logicalKind;
      const ownerUserId = scope.kind === "logical" ? scope.reservation.ownerUserId : scope.ownerUserId;
      const scopeField = { story: "generationJobId", authoring: "jobId", illustration: "promptJobId", direct: "requestScopeId", cast_discovery: "jobId" }[logicalKind];
      const result = scope.kind === "logical"
        ? await pool.query<{ status: string; usage: unknown; reported_cost: unknown }>(
          `SELECT status,usage,reported_cost FROM prepared_text_physical_attempts
             WHERE owner_user_id=$1 AND logical_kind=$2 AND reservation_key=$3 ORDER BY candidate_ordinal`,
          [ownerUserId, logicalKind, reservationKey(scope.reservation)])
        : await pool.query<{ status: string; usage: unknown; reported_cost: unknown }>(
          `SELECT status,usage,reported_cost FROM prepared_text_physical_attempts
             WHERE owner_user_id=$1 AND logical_kind=$2 AND logical_reservation->>$3=$4 ORDER BY reserved_at,id`,
          [ownerUserId, logicalKind, scopeField, scope.scopeId]);
      return accountingSummary(result.rows);
    },
    async reserve(input) {
      return withTransaction(pool, async (client) => {
        if (!await hasLiveReservation(client, input.logicalReservation)) return null;
        const key = reservationKey(input.logicalReservation);
        const existing = await client.query<AttemptRow>(
          `SELECT id,status,logical_reservation,plan_hash,requested_preset_slug,requested_preset_version_id,
                  requested_preset_config_hash,candidate_ordinal,requested_model,provider_policy,
                  request_payload_hash,request_body,provider_response_id,returned_model,returned_provider_route,emitted_output
             FROM prepared_text_physical_attempts
            WHERE logical_kind=$1 AND reservation_key=$2 AND candidate_ordinal=$3 FOR UPDATE`,
          [input.logicalReservation.kind, key, input.candidateOrdinal]
        );
        const prior = existing.rows[0];
        if (prior) {
          if (prior.request_payload_hash !== input.request.payloadHash || prior.request_body !== input.request.body
            || prior.requested_model !== input.candidate.modelId
            || prior.plan_hash !== input.planProvenance.planHash
            || prior.requested_preset_slug !== (input.planProvenance.preset?.slug ?? null)
            || prior.requested_preset_version_id !== (input.planProvenance.preset?.versionId ?? null)
            || prior.requested_preset_config_hash !== (input.planProvenance.preset?.configHash ?? null)
            || stableStringify(prior.provider_policy) !== stableStringify(input.candidate.providerPolicy)) return null;
          return record(prior);
        }
        const inserted = await client.query<AttemptRow>(
          `INSERT INTO prepared_text_physical_attempts (
             owner_user_id,logical_kind,reservation_key,logical_reservation,plan_hash,
             requested_preset_slug,requested_preset_version_id,requested_preset_config_hash,candidate_ordinal,
             requested_model,provider_policy,request_payload_hash,request_body
           ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
           RETURNING id,status,logical_reservation,plan_hash,requested_preset_slug,requested_preset_version_id,
                     requested_preset_config_hash,candidate_ordinal,requested_model,provider_policy,
                     request_payload_hash,request_body,provider_response_id,returned_model,returned_provider_route,emitted_output`,
          [input.logicalReservation.ownerUserId, input.logicalReservation.kind, key, JSON.stringify(input.logicalReservation),
            input.planProvenance.planHash, input.planProvenance.preset?.slug ?? null,
            input.planProvenance.preset?.versionId ?? null, input.planProvenance.preset?.configHash ?? null,
            input.candidateOrdinal, input.candidate.modelId, JSON.stringify(input.candidate.providerPolicy),
            input.request.payloadHash, input.request.body]
        );
        return inserted.rows[0] ? record(inserted.rows[0]) : null;
      });
    },

    async markDispatched(reservation, attemptId, expectedPayloadHash) {
      return withTransaction(pool, async (client) => {
        if (!await hasLiveReservation(client, reservation)) return null;
        const updated = await client.query<{ id: string }>(
          `UPDATE prepared_text_physical_attempts SET status='dispatched',dispatched_at=clock_timestamp()
            WHERE id=$1 AND owner_user_id=$2 AND logical_kind=$3 AND reservation_key=$4
              AND status='reserved' AND request_payload_hash=$5 RETURNING id`,
          [attemptId, reservation.ownerUserId, reservation.kind, reservationKey(reservation), expectedPayloadHash]
        );
        return updated.rows[0] ? loadAttempt(client, attemptId) : null;
      });
    },

    async recordResponseStart(reservation, attemptId, evidence) {
      return withTransaction(pool, async (client) => {
        if (!await hasLiveReservation(client, reservation)) return null;
        const updated = await client.query<{ id: string }>(
          `UPDATE prepared_text_physical_attempts
              SET response_started_at=coalesce(response_started_at,clock_timestamp()),
                  provider_response_id=coalesce(provider_response_id,$5),
                  returned_model=coalesce(returned_model,$6),
                  returned_provider_route=coalesce(returned_provider_route,$7)
            WHERE id=$1 AND owner_user_id=$2 AND logical_kind=$3 AND reservation_key=$4 AND status='dispatched'
              AND (provider_response_id IS NULL OR provider_response_id IS NOT DISTINCT FROM $5)
              AND (returned_model IS NULL OR returned_model IS NOT DISTINCT FROM $6)
              AND (returned_provider_route IS NULL OR returned_provider_route IS NOT DISTINCT FROM $7)
            RETURNING id`,
          [attemptId, reservation.ownerUserId, reservation.kind, reservationKey(reservation), evidence.providerResponseId,
            evidence.returnedModel ?? null, evidence.returnedProviderRoute ?? null]
        );
        return updated.rows[0] ? loadAttempt(client, attemptId) : null;
      });
    },

    async recordOutput(reservation, attemptId) {
      return withTransaction(pool, async (client) => {
        if (!await hasLiveReservation(client, reservation)) return null;
        const updated = await client.query<{ id: string }>(
          `UPDATE prepared_text_physical_attempts SET emitted_output=true
            WHERE id=$1 AND owner_user_id=$2 AND logical_kind=$3 AND reservation_key=$4 AND status='dispatched'
            RETURNING id`,
          [attemptId, reservation.ownerUserId, reservation.kind, reservationKey(reservation)]
        );
        return updated.rows[0] ? loadAttempt(client, attemptId) : null;
      });
    },

    async complete(reservation, attemptId, completion) {
      return withTransaction(pool, async (client) => {
        if (!await hasLiveReservation(client, reservation)) return null;
        const attribution = await lockCampaignCostAttribution(client, reservation);
        if ((reservation.kind === "story" || reservation.kind === "illustration" || reservation.kind === "cast_discovery") && !attribution) return null;
        const updated = await client.query<{ id: string }>(
          `UPDATE prepared_text_physical_attempts
              SET status='completed',outcome=$5,failure_reason=$6,provider_response_id=coalesce(provider_response_id,$7),
                  returned_model=coalesce(returned_model,$8),returned_provider_route=coalesce(returned_provider_route,$9),
                  usage=$10::jsonb,reported_cost=$11::jsonb,emitted_output=(emitted_output OR $12),completed_at=clock_timestamp()
            WHERE id=$1 AND owner_user_id=$2 AND logical_kind=$3 AND reservation_key=$4 AND status='dispatched'
              AND (provider_response_id IS NULL OR provider_response_id IS NOT DISTINCT FROM $7)
              AND (returned_model IS NULL OR returned_model IS NOT DISTINCT FROM $8)
              AND (returned_provider_route IS NULL OR returned_provider_route IS NOT DISTINCT FROM $9)
            RETURNING id`,
          [attemptId, reservation.ownerUserId, reservation.kind, reservationKey(reservation), completion.outcome,
            completion.failureReason ?? null, completion.providerResponseId, completion.returnedModel,
            completion.returnedProviderRoute, completion.usage === null ? null : JSON.stringify(completion.usage),
            completion.reportedCost === null ? null : JSON.stringify(completion.reportedCost), completion.emittedOutput]
        );
        if (!updated.rows[0]) return null;
        const attempt = await client.query<AttemptRow>(
          `SELECT id,status,logical_reservation,plan_hash,requested_preset_slug,requested_preset_version_id,
                  requested_preset_config_hash,candidate_ordinal,requested_model,provider_policy,
                  request_payload_hash,request_body,provider_response_id,returned_model,returned_provider_route,emitted_output
             FROM prepared_text_physical_attempts WHERE id=$1`,
          [attemptId]
        );
        if (!attempt.rows[0]) return null;
        if (attribution) await materializeCampaignCost(client, attemptId, attempt.rows[0], attribution, completion);
        return record(attempt.rows[0]);
      });
    }
  };
}

export type { PresetRouteFailureReason };
