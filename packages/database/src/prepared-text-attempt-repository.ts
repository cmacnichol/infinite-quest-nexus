import type {
  LogicalReservation,
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

function reservationKey(value: LogicalReservation): string {
  if (value.kind === "story") return `${value.generationJobId}:${value.invocationId}`;
  if (value.kind === "authoring") return `${value.jobId}:${value.stageId}:${value.jobGeneration}:${value.stageGeneration}:${value.operation}`;
  if (value.kind === "illustration") return `${value.promptJobId}:${value.claimAttempt}:${value.operation}`;
  return `${value.requestScopeId}:${value.invocationId}:${value.operation}`;
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
        return updated.rows[0] ? loadAttempt(client, attemptId) : null;
      });
    }
  };
}

export type { PresetRouteFailureReason };
