import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CAST_DISCOVERY_PROTOCOL, castDiscoveryOutputSchema, castDiscoverySourceSchema, type CastDiscoveryOutput, type CastDiscoverySource } from "../../contracts/src/campaign-cast-discovery.js";
import { castScopeSchema, type CastScope } from "../../contracts/src/campaign-cast.js";
import { readTextExecutionPlan, type TextExecutionPlan } from "../../contracts/src/text-execution-plan.js";
import { buildCastDiscoverySource, chunkCastDiscoverySource } from "../../domain/src/campaign-cast-discovery.js";
import { sha256, stableStringify } from "../../domain/src/text.js";
import { withTransaction, type DatabaseClient, type DatabasePool } from "./pool.js";

export type CastDiscoveryExecution = { providerProfileId: string; plan: TextExecutionPlan };
export type CastDiscoveryClaim = {
  id: string; scope: CastScope; source: CastDiscoverySource; chunkOrdinal: number; chunkCount: number;
  execution: CastDiscoveryExecution; attempt: number; leaseToken: string; output: CastDiscoveryOutput | null;
};
type AppliedDiscovery = { characterIds: string[]; observationIds: string[] };
const diagnostics = z.enum(["provider_timeout", "provider_failed", "invalid_output", "source_requires_manual_scan", "publication_failed"]);

function readExecution(value: unknown): CastDiscoveryExecution {
  const parsed = z.object({ providerProfileId: z.uuid(), plan: z.unknown() }).strict().parse(value);
  const providerProfileId = parsed.providerProfileId;
  const plan = readTextExecutionPlan(parsed.plan);
  if (!plan || plan.protocolVersion !== CAST_DISCOVERY_PROTOCOL || plan.requestTimeoutMs !== 30000) throw new Error("Invalid cast discovery execution snapshot.");
  return { providerProfileId, plan };
}

/** Caller owns the accepted-turn transaction. No provider or nested transaction occurs here. */
export async function enqueueCastDiscoveryWithClient(client: DatabaseClient, input: {
  scope: CastScope; turnId: string; execution: CastDiscoveryExecution; enabled: boolean;
}): Promise<string | null> {
  if (!input.enabled) return null;
  const scope = castScopeSchema.parse(input.scope), execution = readExecution(input.execution);
  const campaign = (await client.query("SELECT active_turn_number FROM campaigns WHERE id=$1 AND owner_user_id=$2 FOR UPDATE", [scope.campaignId, scope.ownerUserId])).rows[0];
  if (!campaign) throw new Error("Campaign not found.");
  const turn = (await client.query(`SELECT turn_number,correction_revision,effective_narration FROM effective_turn_narrations
    WHERE turn_id=$1 AND campaign_id=$2 AND owner_user_id=$3`, [input.turnId, scope.campaignId, scope.ownerUserId])).rows[0];
  if (!turn || turn.turn_number > campaign.active_turn_number) throw new Error("Accepted source not found.");
  await client.query("INSERT INTO campaign_cast_state(owner_user_id,campaign_id) VALUES($1,$2) ON CONFLICT(campaign_id) DO NOTHING", [scope.ownerUserId, scope.campaignId]);
  const state = (await client.query("SELECT timeline_revision FROM campaign_cast_state WHERE campaign_id=$1 AND owner_user_id=$2", [scope.campaignId, scope.ownerUserId])).rows[0];
  const source = buildCastDiscoverySource({ scope, turnId: input.turnId, turnNumber: turn.turn_number,
    narrationRevision: turn.correction_revision, timelineRevision: state.timeline_revision, narration: turn.effective_narration });
  const chunks = chunkCastDiscoverySource(source);
  const result = await client.query(`INSERT INTO campaign_cast_discovery_jobs(owner_user_id,campaign_id,turn_id,turn_number,narration_revision,timeline_revision,
    source_hash,protocol,source,chunks,execution_snapshot,status,diagnostic_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT(campaign_id,turn_id,narration_revision,timeline_revision,protocol) DO NOTHING RETURNING id`,
  [scope.ownerUserId, scope.campaignId, source.turnId, source.turnNumber, source.narrationRevision, source.timelineRevision,
    source.sourceHash, CAST_DISCOVERY_PROTOCOL, JSON.stringify(source), JSON.stringify(chunks.chunks), JSON.stringify(execution),
    chunks.status === "ready" ? "queued" : "failed", chunks.status === "ready" ? null : chunks.status]);
  if (result.rows[0]) return result.rows[0].id;
  const prior = (await client.query(`SELECT id,source_hash FROM campaign_cast_discovery_jobs WHERE campaign_id=$1 AND turn_id=$2
    AND narration_revision=$3 AND timeline_revision=$4 AND protocol=$5`, [scope.campaignId, source.turnId, source.narrationRevision, source.timelineRevision, CAST_DISCOVERY_PROTOCOL])).rows[0];
  if (!prior || prior.source_hash !== source.sourceHash) throw new Error("Discovery source changed without a timeline revision.");
  return prior.id;
}

function claimFromRow(value: unknown): CastDiscoveryClaim {
  const ordinal = z.number().int().nonnegative();
  const row = z.object({ id: z.uuid(), campaign_id: z.uuid(), owner_user_id: z.uuid(), turn_id: z.uuid(), turn_number: ordinal,
    narration_revision: ordinal, timeline_revision: ordinal, source_hash: z.string(), source: castDiscoverySourceSchema,
    chunks: z.array(castDiscoverySourceSchema).min(1).max(32), chunk_ordinal: ordinal, attempt: ordinal.max(2),
    lease_token: z.uuid(), checkpoint: castDiscoveryOutputSchema.nullable(), execution_snapshot: z.unknown() }).parse(value);
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
    attempt: row.attempt, leaseToken: z.uuid().parse(row.lease_token), output: row.checkpoint === null ? null : castDiscoveryOutputSchema.parse(row.checkpoint) };
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
    async claim(workerId: string): Promise<CastDiscoveryClaim | null> {
      if (!enabled()) return null;
      const worker = z.string().trim().min(1).max(200).parse(workerId);
      return withTransaction(pool, async (client) => {
        // Lock campaign before job, matching accepted-turn and manual editing order.
        const candidate = (await client.query(`SELECT c.id FROM campaigns c WHERE EXISTS (
          SELECT 1 FROM campaign_cast_discovery_jobs j WHERE j.campaign_id=c.id
          AND ((j.status IN ('queued','retry_wait') AND j.available_at<=clock_timestamp()) OR (j.status='running' AND j.lease_expires_at<=clock_timestamp()))
          AND NOT EXISTS (SELECT 1 FROM campaign_cast_discovery_jobs earlier WHERE earlier.campaign_id=j.campaign_id
            AND earlier.status NOT IN ('complete','cancelled') AND (earlier.turn_number<j.turn_number OR (earlier.turn_number=j.turn_number AND earlier.created_at<j.created_at)))
          AND NOT EXISTS (SELECT 1 FROM campaign_cast_discovery_jobs live WHERE live.campaign_id=j.campaign_id AND live.status='running' AND live.lease_expires_at>clock_timestamp())
        ) ORDER BY c.id FOR UPDATE OF c SKIP LOCKED LIMIT 1`)).rows[0];
        if (!candidate || !enabled()) return null;
        const job = (await client.query(`SELECT * FROM campaign_cast_discovery_jobs WHERE campaign_id=$1 AND status NOT IN ('complete','cancelled')
          ORDER BY turn_number,created_at,id FOR UPDATE LIMIT 1`, [candidate.id])).rows[0];
        if (!job || job.status === "failed") return null;
        if (job.attempt >= 2 && job.checkpoint === null) {
          await client.query("UPDATE campaign_cast_discovery_jobs SET status='failed',diagnostic_code='provider_failed',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1", [job.id]);
          return null;
        }
        const token = randomUUID();
        const result = await client.query(`UPDATE campaign_cast_discovery_jobs SET status='running',lease_token=$2,lease_owner=$3,
          lease_expires_at=clock_timestamp()+interval '90 seconds',attempt=attempt+CASE WHEN checkpoint IS NULL THEN 1 ELSE 0 END,
          updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [job.id, token, worker]);
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
    async publish(claim: CastDiscoveryClaim, apply: (client: DatabaseClient, current: CastDiscoveryClaim) => Promise<AppliedDiscovery>) {
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
        await client.query(`INSERT INTO campaign_cast_discovery_receipts(job_id,campaign_id,owner_user_id,chunk_ordinal,output_hash,character_ids,observation_ids)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [current.id, current.scope.campaignId, current.scope.ownerUserId, current.chunkOrdinal,
          sha256(stableStringify(current.output)), receipt.characterIds, receipt.observationIds]);
        const complete = current.chunkOrdinal + 1 === current.chunkCount;
        await client.query(`UPDATE campaign_cast_discovery_jobs SET status=$2,chunk_ordinal=chunk_ordinal+1,attempt=0,checkpoint=NULL,
          lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,diagnostic_code=NULL,available_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,
        [current.id, complete ? "complete" : "queued"]);
        return complete ? "complete" as const : "next_chunk" as const;
      });
    }
  };
}
