import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CAST_DISCOVERY_PROTOCOL, castDiscoveryIdentitySnapshotSchema, castDiscoveryOutputSchema, castDiscoverySourceSchema, type CastDiscoverySource } from "../../contracts/src/campaign-cast-discovery.js";
import { castScopeSchema, type CastScope } from "../../contracts/src/campaign-cast.js";
import { deriveTextExecutionPlan, readTextExecutionPlan, readTextExecutionRouteBasis } from "../../contracts/src/text-execution-plan.js";
import { assertDirectResponseContractRouteBasisAuthority, bindFrozenResponseContractInvocationV2, readFrozenResponseContractsV2 } from "../../contracts/src/generation-response-contract.js";
import { CAST_DISCOVERY_SYSTEM_PROMPT } from "../../contracts/src/prompt-library.js";
import { buildCastDiscoverySource, chunkCastDiscoverySource } from "../../domain/src/campaign-cast-discovery.js";
import { sha256, stableStringify } from "../../domain/src/text.js";
import { withTransaction, type DatabaseClient, type DatabasePool } from "./pool.js";
import { applyValidatedCastDiscovery, captureCastDiscoveryIdentities } from "./campaign-cast-discovery-publication.js";
import { initializeCastWithClient } from "./campaign-cast-repository.js";
import { CampaignCastError } from "../../application/src/campaign-cast/ports.js";
import { retryCastDiscoverySchema, castDiscoveryRetryResultSchema, type RetryCastDiscovery } from "../../contracts/src/campaign-cast-discovery.js";

import type { CastDiscoveryClaim, CastDiscoveryExecution } from "../../application/src/campaign-cast/discovery.js";
export type { CastDiscoveryClaim, CastDiscoveryExecution } from "../../application/src/campaign-cast/discovery.js";
type AppliedDiscovery = { characterIds: string[]; observationIds: string[]; validationSummary?: { accepted: number; unresolved: number; rejected: { localKey: string; code: string }[] } };
const diagnostics = z.enum(["provider_timeout", "provider_failed", "invalid_output", "source_requires_manual_scan", "publication_failed"]);

export function readCastDiscoveryExecution(value: unknown): CastDiscoveryExecution {
  const parsed = z.object({ providerProfileId: z.uuid(), plan: z.unknown(), admission: z.object({
    routeBasis: z.unknown(), frozenResponseContracts: z.unknown(), providerType: z.enum(["openrouter", "openai_compatible"]),
    configuration: z.record(z.string(), z.unknown()) }).strict().optional() }).strict().parse(value);
  const providerProfileId = parsed.providerProfileId;
  const plan = readTextExecutionPlan(parsed.plan);
  if (!plan || plan.protocolVersion !== CAST_DISCOVERY_PROTOCOL || plan.requestTimeoutMs !== 30000) throw new Error("Invalid cast discovery execution snapshot.");
  if (!parsed.admission) return { providerProfileId, plan };
  const routeBasis = readTextExecutionRouteBasis(parsed.admission.routeBasis);
  const frozenResponseContracts = readFrozenResponseContractsV2(parsed.admission.frozenResponseContracts);
  if (routeBasis.credentialReference !== providerProfileId || frozenResponseContracts.queuedPolicy.providerProfileId !== providerProfileId) {
    throw new Error("Invalid cast discovery provider binding.");
  }
  if (plan.selection.kind === "model") {
    assertDirectResponseContractRouteBasisAuthority(frozenResponseContracts.queuedPolicy, routeBasis);
    if (deriveTextExecutionPlan(routeBasis, CAST_DISCOVERY_SYSTEM_PROMPT).planHash !== plan.planHash) throw new Error("Invalid cast discovery plan binding.");
  }
  bindFrozenResponseContractInvocationV2({ frozen: frozenResponseContracts, routeBasis, plan,
    invocationKey: "cast_discovery:nonstream", operation: "cast_discovery", trustedOperationPrompt: CAST_DISCOVERY_SYSTEM_PROMPT });
  return { providerProfileId, plan, admission: { ...parsed.admission, routeBasis, frozenResponseContracts } };
}

const readExecution = readCastDiscoveryExecution;

/** Caller owns the accepted-turn transaction. No provider or nested transaction occurs here. */
export async function enqueueCastDiscoveryWithClient(client: DatabaseClient, input: {
  scope: CastScope; turnId: string; execution?: CastDiscoveryExecution; admissionUnavailable?: boolean; enabled: boolean;
}): Promise<string | null> {
  if (!input.enabled) return null;
  if (!input.execution && input.admissionUnavailable !== true) throw new Error("Discovery admission is required.");
  if (input.execution && input.admissionUnavailable) throw new Error("Conflicting discovery admission.");
  const scope = castScopeSchema.parse(input.scope), execution = input.execution ? readExecution(input.execution) : { unavailable: true };
  const campaign = (await client.query("SELECT active_turn_number FROM campaigns WHERE id=$1 AND owner_user_id=$2 FOR UPDATE", [scope.campaignId, scope.ownerUserId])).rows[0];
  if (!campaign) throw new Error("Campaign not found.");
  const turn = (await client.query(`SELECT turn_number,correction_revision,effective_narration FROM effective_turn_narrations
    WHERE turn_id=$1 AND campaign_id=$2 AND owner_user_id=$3`, [input.turnId, scope.campaignId, scope.ownerUserId])).rows[0];
  if (!turn || turn.turn_number > campaign.active_turn_number) throw new Error("Accepted source not found.");
  await client.query("INSERT INTO campaign_cast_state(owner_user_id,campaign_id) VALUES($1,$2) ON CONFLICT(campaign_id) DO NOTHING", [scope.ownerUserId, scope.campaignId]);
  await client.query("UPDATE campaign_cast_state SET coverage_start_turn=COALESCE(coverage_start_turn,$3) WHERE campaign_id=$1 AND owner_user_id=$2",
    [scope.campaignId, scope.ownerUserId, turn.turn_number]);
  const state = (await client.query("SELECT timeline_revision FROM campaign_cast_state WHERE campaign_id=$1 AND owner_user_id=$2", [scope.campaignId, scope.ownerUserId])).rows[0];
  const source = buildCastDiscoverySource({ scope, turnId: input.turnId, turnNumber: turn.turn_number,
    narrationRevision: turn.correction_revision, timelineRevision: state.timeline_revision, narration: turn.effective_narration });
  const chunks = chunkCastDiscoverySource(source);
  const result = await client.query(`INSERT INTO campaign_cast_discovery_jobs(owner_user_id,campaign_id,turn_id,turn_number,narration_revision,timeline_revision,
    source_hash,protocol,source,chunks,execution_snapshot,status,diagnostic_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT(campaign_id,turn_id,narration_revision,timeline_revision,protocol) DO NOTHING RETURNING id`,
  [scope.ownerUserId, scope.campaignId, source.turnId, source.turnNumber, source.narrationRevision, source.timelineRevision,
    source.sourceHash, CAST_DISCOVERY_PROTOCOL, JSON.stringify(source), JSON.stringify(chunks.chunks), JSON.stringify(execution),
    input.admissionUnavailable || chunks.status !== "ready" ? "failed" : "queued",
    input.admissionUnavailable ? "admission_unavailable" : chunks.status === "ready" ? null : chunks.status]);
  if (result.rows[0]) return result.rows[0].id;
  const prior = (await client.query(`SELECT id,source_hash FROM campaign_cast_discovery_jobs WHERE campaign_id=$1 AND turn_id=$2
    AND narration_revision=$3 AND timeline_revision=$4 AND protocol=$5`, [scope.campaignId, source.turnId, source.narrationRevision, source.timelineRevision, CAST_DISCOVERY_PROTOCOL])).rows[0];
  if (!prior || prior.source_hash !== source.sourceHash) throw new Error("Discovery source changed without a timeline revision.");
  return prior.id;
}

/** Reconcile only already-enrolled sources while the caller holds the campaign lock. */
export async function reconcileCastDiscoveryBoundary(client: DatabaseClient, scope: CastScope, throughTurn: number): Promise<void> {
  const state = (await client.query("SELECT timeline_revision FROM campaign_cast_state WHERE campaign_id=$1 AND owner_user_id=$2",
    [scope.campaignId, scope.ownerUserId])).rows[0];
  const jobs = (await client.query(`SELECT j.*,n.correction_revision,n.effective_narration
    FROM campaign_cast_discovery_jobs j LEFT JOIN effective_turn_narrations n
      ON n.turn_id=j.turn_id AND n.campaign_id=j.campaign_id AND n.owner_user_id=j.owner_user_id
    WHERE j.campaign_id=$1 AND j.owner_user_id=$2 AND j.status<>'cancelled' ORDER BY j.turn_number FOR UPDATE OF j`,
  [scope.campaignId, scope.ownerUserId])).rows;
  for (const job of jobs) {
    const retained = job.turn_number <= throughTurn && typeof job.effective_narration === "string";
    const unchanged = retained && job.narration_revision === job.correction_revision && job.source_hash === sha256(job.effective_narration);
    if (!unchanged) {
      await client.query(`UPDATE campaign_cast_discovery_jobs SET status='cancelled',lease_token=NULL,lease_owner=NULL,
        lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1`, [job.id]);
      await client.query("UPDATE campaign_cast_discovery_candidates SET status='cancelled' WHERE job_id=$1 AND status='pending'", [job.id]);
      if (retained) await enqueueCastDiscoveryWithClient(client, { scope, turnId: job.turn_id, enabled: true,
        ...(job.execution_snapshot.unavailable === true ? { admissionUnavailable: true } : { execution: readExecution(job.execution_snapshot) }) });
      continue;
    }
    // Revoke in-flight work without resetting spent attempts or replaying published chunks.
    // Parsed output remains reusable: publication still reconciles its captured identities.
    const revision = state.timeline_revision;
    await client.query(`UPDATE campaign_cast_discovery_jobs SET timeline_revision=$2,source=$3,chunks=$4,
      status=CASE WHEN status='running' THEN 'queued' ELSE status END,
      lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1`,
    [job.id, revision, JSON.stringify({ ...job.source, timelineRevision: revision }),
      JSON.stringify(job.chunks.map((chunk: CastDiscoverySource) => ({ ...chunk, timelineRevision: revision })))]);
    await client.query(`UPDATE campaign_cast_discovery_candidates SET source=jsonb_set(source,'{timelineRevision}',to_jsonb($2::integer))
      WHERE job_id=$1 AND status='pending'`, [job.id, revision]);
  }
}

function claimFromRow(value: unknown): CastDiscoveryClaim {
  const ordinal = z.number().int().nonnegative();
  const row = z.object({ id: z.uuid(), campaign_id: z.uuid(), owner_user_id: z.uuid(), turn_id: z.uuid(), turn_number: ordinal,
    narration_revision: ordinal, timeline_revision: ordinal, source_hash: z.string(), source: castDiscoverySourceSchema,
    chunks: z.array(castDiscoverySourceSchema).min(1).max(32), chunk_ordinal: ordinal, attempt: ordinal.max(2), retry_generation: ordinal,
    lease_token: z.uuid(), checkpoint: castDiscoveryOutputSchema.nullable(), execution_snapshot: z.unknown(), identity_snapshot: castDiscoveryIdentitySnapshotSchema }).parse(value);
  const chunks = row.chunks;
  const bound = (source: CastDiscoverySource) => source.turnId === row.turn_id && source.turnNumber === row.turn_number
    && source.scope.ownerUserId === row.owner_user_id && source.scope.campaignId === row.campaign_id
    && source.narrationRevision === row.narration_revision && source.timelineRevision === row.timeline_revision && source.sourceHash === row.source_hash;
  if (!bound(row.source) || !chunks.every(bound)
    || sha256(row.source.paragraphs.map((paragraph) => paragraph.text).join("")) !== row.source_hash
    || sha256(chunks.flatMap((chunk) => chunk.paragraphs).map((paragraph) => paragraph.text).join("")) !== row.source_hash) {
    throw new Error("Invalid discovery source binding.");
  }
  if (!chunks[row.chunk_ordinal]) throw new Error("Invalid discovery chunk checkpoint.");
  return { id: z.uuid().parse(row.id), scope: castScopeSchema.parse({ ownerUserId: row.owner_user_id, campaignId: row.campaign_id }),
    source: chunks[row.chunk_ordinal]!, chunkOrdinal: row.chunk_ordinal, chunkCount: chunks.length, execution: readExecution(row.execution_snapshot),
    attempt: row.attempt, retryGeneration: row.retry_generation, leaseToken: z.uuid().parse(row.lease_token), output: row.checkpoint === null ? null : castDiscoveryOutputSchema.parse(row.checkpoint), identities: row.identity_snapshot };
}

async function lockLiveClaim(client: DatabaseClient, claim: CastDiscoveryClaim) {
  const campaign = (await client.query("SELECT active_turn_number FROM campaigns WHERE id=$1 AND owner_user_id=$2 FOR UPDATE", [claim.scope.campaignId, claim.scope.ownerUserId])).rows[0];
  if (!campaign) return null;
  const row = (await client.query(`SELECT * FROM campaign_cast_discovery_jobs WHERE id=$1 AND campaign_id=$2 AND owner_user_id=$3
    AND status='running' AND lease_token=$4 AND lease_expires_at>clock_timestamp() FOR UPDATE`,
  [claim.id, claim.scope.campaignId, claim.scope.ownerUserId, claim.leaseToken])).rows[0];
  return row ? { row, campaign } : null;
}

export function createCastDiscoveryJobRepository(pool: DatabasePool, enabled: () => boolean) {
  return {
    /** Explicit user retry. Any replacement admission must be prepared before this transaction. */
    async retryFailed(rawScope: CastScope, rawId: string, rawRequest: RetryCastDiscovery, replacement?: CastDiscoveryExecution) {
      const scope = castScopeSchema.parse(rawScope), id = z.uuid().parse(rawId), request = retryCastDiscoverySchema.parse(rawRequest);
      return withTransaction(pool, async (client) => {
        const cast = await initializeCastWithClient(client, scope);
        if (!enabled()) throw new CampaignCastError("cast_discovery_disabled");
        const job = (await client.query("SELECT * FROM campaign_cast_discovery_jobs WHERE id=$1 AND campaign_id=$2 AND owner_user_id=$3 FOR UPDATE",
          [id, scope.campaignId, scope.ownerUserId])).rows[0];
        if (!job) throw new CampaignCastError("cast_not_found");
        const turn = (await client.query("SELECT turn_number,correction_revision,effective_narration FROM effective_turn_narrations WHERE turn_id=$1 AND campaign_id=$2 AND owner_user_id=$3",
          [job.turn_id, scope.campaignId, scope.ownerUserId])).rows[0];
        if (!turn || job.status === "cancelled" || job.timeline_revision !== cast.boundary.timelineRevision
          || job.turn_number > cast.boundary.turnNumber || turn.turn_number !== job.turn_number || turn.correction_revision !== job.narration_revision
          || sha256(turn.effective_narration) !== job.source_hash) throw new CampaignCastError("cast_revision_conflict");
        const requestHash = sha256(stableStringify({ id, request }));
        const receipt = (await client.query("SELECT request_hash,retry_generation FROM campaign_cast_discovery_retries WHERE job_id=$1 AND idempotency_key=$2",
          [id, request.idempotencyKey])).rows[0];
        if (receipt) {
          if (receipt.request_hash !== requestHash) throw new CampaignCastError("cast_idempotency_conflict");
          return castDiscoveryRetryResultSchema.parse({ jobId: id, retryGeneration: receipt.retry_generation });
        }
        if (job.status !== "failed" || cast.revision !== request.expectedCastRevision
          || stableStringify(cast.boundary) !== stableStringify(request.expectedBoundary)) throw new CampaignCastError("cast_revision_conflict");
        if ((await client.query(`SELECT id FROM generation_jobs WHERE campaign_id=$1 AND owner_user_id=$2
          AND status IN ('queued','replacement_queued','assessing','generating','validating','committing','recoverable') LIMIT 1`,
        [scope.campaignId, scope.ownerUserId])).rows.length) throw new CampaignCastError("cast_generation_active");
        if (!job.chunks.length || job.chunk_ordinal >= job.chunks.length) throw new CampaignCastError("cast_invalid_request");
        if (job.execution_snapshot.unavailable && !replacement) throw new CampaignCastError("cast_discovery_admission_required");
        const execution = readExecution(replacement ?? job.execution_snapshot);
        const generation = job.retry_generation + 1;
        await client.query(`UPDATE campaign_cast_discovery_jobs SET status='queued',attempt=0,retry_generation=$2,
          execution_snapshot=$3,identity_snapshot=CASE WHEN checkpoint IS NULL THEN NULL ELSE identity_snapshot END,
          lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,diagnostic_code=NULL,available_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,
        [id, generation, JSON.stringify(execution)]);
        await client.query(`INSERT INTO campaign_cast_discovery_retries(job_id,campaign_id,owner_user_id,idempotency_key,request_hash,retry_generation)
          VALUES($1,$2,$3,$4,$5,$6)`, [id, scope.campaignId, scope.ownerUserId, request.idempotencyKey, requestHash, generation]);
        return castDiscoveryRetryResultSchema.parse({ jobId: id, retryGeneration: generation });
      });
    },
    async claim(workerId: string): Promise<CastDiscoveryClaim | null> {
      if (!enabled()) return null;
      const worker = z.string().trim().min(1).max(200).parse(workerId);
      return withTransaction(pool, async (client) => {
        // Lock campaign before job, matching accepted-turn and manual editing order.
        const candidate = (await client.query(`SELECT c.id FROM campaigns c WHERE EXISTS (
          SELECT 1 FROM campaign_cast_discovery_jobs j WHERE j.campaign_id=c.id
          AND (j.scan_id IS NULL OR EXISTS (SELECT 1 FROM campaign_cast_scans s WHERE s.id=j.scan_id AND s.status IN ('queued','running')))
          AND ((j.status IN ('queued','retry_wait') AND j.available_at<=clock_timestamp()) OR (j.status='running' AND j.lease_expires_at<=clock_timestamp()))
          AND NOT EXISTS (SELECT 1 FROM campaign_cast_discovery_jobs earlier WHERE earlier.campaign_id=j.campaign_id
            AND earlier.status NOT IN ('complete','cancelled')
            AND (earlier.scan_id IS NULL OR EXISTS (SELECT 1 FROM campaign_cast_scans s WHERE s.id=earlier.scan_id AND s.status IN ('queued','running')))
            AND (CASE WHEN earlier.scan_id IS NULL THEN 0 ELSE 1 END,earlier.turn_number,earlier.created_at,earlier.id)
              < (CASE WHEN j.scan_id IS NULL THEN 0 ELSE 1 END,j.turn_number,j.created_at,j.id))
          AND NOT EXISTS (SELECT 1 FROM campaign_cast_discovery_jobs live WHERE live.campaign_id=j.campaign_id AND live.status='running' AND live.lease_expires_at>clock_timestamp())
        ) ORDER BY CASE WHEN EXISTS (SELECT 1 FROM campaign_cast_discovery_jobs f WHERE f.campaign_id=c.id
          AND f.scan_id IS NULL AND f.status NOT IN ('complete','cancelled')) THEN 0 ELSE 1 END,c.id
        FOR UPDATE OF c SKIP LOCKED LIMIT 1`)).rows[0];
        if (!candidate || !enabled()) return null;
        // An expired paused lease must not retain the campaign's unique running slot.
        await client.query(`UPDATE campaign_cast_discovery_jobs j SET status='queued',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL
          WHERE campaign_id=$1 AND status='running' AND lease_expires_at<=clock_timestamp()
            AND EXISTS (SELECT 1 FROM campaign_cast_scans s WHERE s.id=j.scan_id AND s.status='paused')`, [candidate.id]);
        const job = (await client.query(`SELECT * FROM campaign_cast_discovery_jobs WHERE campaign_id=$1 AND status NOT IN ('complete','cancelled')
          AND (scan_id IS NULL OR EXISTS (SELECT 1 FROM campaign_cast_scans s WHERE s.id=scan_id AND s.status IN ('queued','running')))
          ORDER BY CASE WHEN scan_id IS NULL THEN 0 ELSE 1 END,turn_number,created_at,id FOR UPDATE LIMIT 1`, [candidate.id])).rows[0];
        if (!job || job.status === "failed") return null;
        if (job.attempt >= 2 && job.checkpoint === null) {
          await client.query("UPDATE campaign_cast_discovery_jobs SET status='failed',diagnostic_code='provider_failed',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1", [job.id]);
          return null;
        }
        const token = randomUUID();
        const identities = job.identity_snapshot ?? await captureCastDiscoveryIdentities(client, { ownerUserId: job.owner_user_id, campaignId: job.campaign_id });
        const result = await client.query(`UPDATE campaign_cast_discovery_jobs SET status='running',lease_token=$2,lease_owner=$3,
          lease_expires_at=clock_timestamp()+interval '90 seconds',attempt=attempt+CASE WHEN checkpoint IS NULL THEN 1 ELSE 0 END,
          identity_snapshot=$4,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [job.id, token, worker, JSON.stringify(identities)]);
        return claimFromRow(result.rows[0]);
      });
    },
    async checkpoint(claim: CastDiscoveryClaim, value: unknown): Promise<boolean> {
      const output = castDiscoveryOutputSchema.parse(value);
      return withTransaction(pool, async (client) => {
        const live = await lockLiveClaim(client, claim);
        if (!live) return false;
        if (live.row.checkpoint !== null && stableStringify(live.row.checkpoint) !== stableStringify(output)) throw new Error("Discovery checkpoint is immutable.");
        await client.query("UPDATE campaign_cast_discovery_jobs SET checkpoint=$2,updated_at=clock_timestamp() WHERE id=$1", [claim.id, JSON.stringify(output)]);
        return true;
      });
    },
    async fail(claim: CastDiscoveryClaim, diagnostic: z.infer<typeof diagnostics>): Promise<boolean> {
      const code = diagnostics.parse(diagnostic);
      return withTransaction(pool, async (client) => {
        const live = await lockLiveClaim(client, claim);
        if (!live) return false;
        await client.query(`UPDATE campaign_cast_discovery_jobs SET status=$2,diagnostic_code=$3,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,
          available_at=clock_timestamp()+interval '5 seconds',updated_at=clock_timestamp() WHERE id=$1`,
        [claim.id, live.row.attempt < 2 ? "retry_wait" : "failed", code]);
        return true;
      });
    },
    async publish(claim: CastDiscoveryClaim, apply: (client: DatabaseClient, current: CastDiscoveryClaim) => Promise<AppliedDiscovery> = applyValidatedCastDiscovery) {
      if (!enabled()) return "disabled" as const;
      return withTransaction(pool, async (client) => {
        const live = await lockLiveClaim(client, claim);
        if (!live) return "lost_lease" as const;
        if (!enabled()) return "disabled" as const;
        const current = claimFromRow(live.row);
        const state = (await client.query("SELECT timeline_revision FROM campaign_cast_state WHERE campaign_id=$1 AND owner_user_id=$2", [current.scope.campaignId, current.scope.ownerUserId])).rows[0];
        const turn = (await client.query("SELECT turn_number,correction_revision,effective_narration FROM effective_turn_narrations WHERE turn_id=$1 AND campaign_id=$2 AND owner_user_id=$3", [current.source.turnId, current.scope.campaignId, current.scope.ownerUserId])).rows[0];
        if (!turn || turn.turn_number > live.campaign.active_turn_number || turn.turn_number !== current.source.turnNumber
          || turn.correction_revision !== current.source.narrationRevision || sha256(turn.effective_narration) !== current.source.sourceHash
          || state?.timeline_revision !== current.source.timelineRevision) {
          await client.query("UPDATE campaign_cast_discovery_jobs SET status='cancelled',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1", [current.id]);
          return "stale_source" as const;
        }
        const generation = (await client.query(`SELECT id FROM generation_jobs WHERE campaign_id=$1 AND owner_user_id=$2
          AND status IN ('queued','replacement_queued','assessing','generating','validating','committing','recoverable') LIMIT 1`,
        [current.scope.campaignId, current.scope.ownerUserId])).rows[0];
        if (generation) return "generation_active" as const;
        if (current.output === null) throw new Error("Discovery output must be checkpointed before publication.");
        const receipt = await apply(client, current);
        z.array(z.uuid()).parse(receipt.characterIds); z.array(z.uuid()).parse(receipt.observationIds);
        await client.query(`INSERT INTO campaign_cast_discovery_receipts(job_id,campaign_id,owner_user_id,chunk_ordinal,output_hash,character_ids,observation_ids,validation_summary)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [current.id, current.scope.campaignId, current.scope.ownerUserId, current.chunkOrdinal,
          sha256(stableStringify(current.output)), receipt.characterIds, receipt.observationIds, JSON.stringify(receipt.validationSummary ?? {})]);
        const complete = current.chunkOrdinal + 1 === current.chunkCount;
        await client.query(`UPDATE campaign_cast_discovery_jobs SET status=$2,chunk_ordinal=chunk_ordinal+1,attempt=0,checkpoint=NULL,identity_snapshot=NULL,
          lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,diagnostic_code=NULL,available_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,
        [current.id, complete ? "complete" : "queued"]);
        return complete ? "complete" as const : "next_chunk" as const;
      });
    }
  };
}
