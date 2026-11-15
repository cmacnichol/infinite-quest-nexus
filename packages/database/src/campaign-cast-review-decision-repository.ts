import { randomUUID } from "node:crypto";
import { z } from "zod";
import { castScopeSchema, type CastScope } from "../../contracts/src/campaign-cast.js";
import { castDiscoveryCandidateSchema, castDiscoverySourceSchema } from "../../contracts/src/campaign-cast-discovery.js";
import { dismissedReviewPageSchema, dismissedReviewQuerySchema, reviewDecisionRequestSchema, reviewDecisionResultSchema, type ReviewDecisionRequest } from "../../contracts/src/campaign-cast-review-decisions.js";
import { CampaignCastError } from "../../application/src/campaign-cast/ports.js";
import { canonicalReviewTarget, reviewTargetFingerprint, type ReviewTarget } from "../../domain/src/campaign-cast-review-decisions.js";
import { sha256, stableStringify } from "../../domain/src/text.js";
import { initializeCastWithClient } from "./campaign-cast-repository.js";
import { withTransaction, type DatabaseClient, type DatabasePool } from "./pool.js";

type Row = { id: string; candidate_id: string; source: any; target_payload: any; target_kind: string; observation_index: number | null; target_fingerprint: string; revision: string; action: string; restores_decision_id: string | null };
/** Active operational and legacy dismissals. Caller independently validates candidate source. */
export async function readActiveReviewDismissals(client: DatabaseClient | DatabasePool, scope: CastScope) {
  const rows = (await client.query(`SELECT d.* FROM campaign_cast_review_decisions d WHERE d.campaign_id=$1 AND d.owner_user_id=$2 AND d.action='dismiss'
    AND NOT EXISTS (SELECT 1 FROM campaign_cast_review_decisions r WHERE r.campaign_id=d.campaign_id AND r.owner_user_id=d.owner_user_id AND r.restores_decision_id=d.id) ORDER BY d.revision`, [scope.campaignId, scope.ownerUserId])).rows as Row[];
  const legacy = (await client.query(`SELECT p.source,p.proposal,d AS decision FROM campaign_cast_discovery_candidates p CROSS JOIN LATERAL jsonb_array_elements(p.detail_decisions) d
    WHERE p.campaign_id=$1 AND p.owner_user_id=$2 AND p.status<>'cancelled' AND d->'result'->>'disposition'='dismiss'`, [scope.campaignId, scope.ownerUserId])).rows;
  return { rows, legacy };
}
export function isReviewDismissed(active: Awaited<ReturnType<typeof readActiveReviewDismissals>>, source: any, target: ReviewTarget): boolean {
  if (!active.rows.length && (target.kind === "identity" || !active.legacy.length)) return false;
  if (!castDiscoverySourceSchema.safeParse(source).success || !castDiscoveryCandidateSchema.safeParse(target.proposal).success) return false;
  const canonical = canonicalReviewTarget(source, target), fingerprint = reviewTargetFingerprint(source, target);
  if (active.rows.some(row => row.target_fingerprint === fingerprint && canonicalReviewTarget(row.source, row.target_payload) === canonical)) return true;
  return target.kind === "detail" && active.legacy.some(row => {
    if (!castDiscoverySourceSchema.safeParse(row.source).success || !castDiscoveryCandidateSchema.safeParse(row.proposal).success) return false;
    const observation = row.proposal.observations[row.decision.observationIndex];
    return observation && canonicalReviewTarget(row.source, { kind: "detail", proposal: row.proposal, observation }) === canonical;
  });
}
export async function readReviewRevision(client: DatabaseClient | DatabasePool, scope: CastScope): Promise<number> {
  return Number((await client.query("SELECT revision FROM campaign_cast_review_sequences WHERE campaign_id=$1 AND owner_user_id=$2", [scope.campaignId, scope.ownerUserId])).rows[0]?.revision ?? 0);
}
function eligible(row: any, target: ReviewTarget, index: number | null): boolean {
  if (!castDiscoveryCandidateSchema.safeParse(row.proposal).success) return false;
  const currentTarget: ReviewTarget | null = target.kind === "identity" ? { kind: "identity", proposal: row.proposal }
    : index !== null && row.proposal.observations[index] ? { kind: "detail", proposal: row.proposal, observation: row.proposal.observations[index] } : null;
  if (!currentTarget || canonicalReviewTarget(row.source, currentTarget) !== canonicalReviewTarget(row.source, target)) return false;
  if (row.status !== "pending") return false;
  if (target.kind === "identity") return !row.resolution_receipt;
  if (!row.resolution_receipt) return index !== null && !!row.proposal.observations[index];
  return row.resolution_receipt.result.pendingObservations?.some((item: any) => item.index === index)
    && !row.detail_decisions.some((item: any) => item.observationIndex === index);
}
async function currentSource(client: DatabaseClient, scope: CastScope, cast: any, row: any): Promise<boolean> {
  const source = castDiscoverySourceSchema.parse(row.source);
  const turn = (await client.query("SELECT turn_number,correction_revision,effective_narration FROM effective_turn_narrations WHERE turn_id=$1 AND campaign_id=$2 AND owner_user_id=$3", [source.turnId, scope.campaignId, scope.ownerUserId])).rows[0];
  return !!turn && source.scope.ownerUserId === scope.ownerUserId && source.scope.campaignId === scope.campaignId && source.timelineRevision === cast.boundary.timelineRevision && source.turnNumber <= cast.boundary.turnNumber && turn.turn_number === source.turnNumber && turn.correction_revision === source.narrationRevision && sha256(turn.effective_narration) === source.sourceHash;
}
/** Reject restoration if an equivalent proposal has already been accepted or confirmed. */
async function alreadyResolved(client: DatabaseClient, scope: CastScope, source: any, target: ReviewTarget): Promise<boolean> {
  const rows = (await client.query(`SELECT source,proposal,resolution_receipt,detail_decisions FROM campaign_cast_discovery_candidates
    WHERE campaign_id=$1 AND owner_user_id=$2 AND status<>'cancelled' AND source->>'turnId'=$3
      AND source->>'narrationRevision'=$4 AND source->>'sourceHash'=$5`, [scope.campaignId, scope.ownerUserId, source.turnId, String(source.narrationRevision), source.sourceHash])).rows;
  const canonical = canonicalReviewTarget(source, target);
  return rows.some(row => {
    if (!row.resolution_receipt) return false;
    if (target.kind === "identity") return canonicalReviewTarget(row.source, { kind: "identity", proposal: row.proposal }) === canonical;
    return row.proposal.observations.some((observation: any, index: number) => {
      if (canonicalReviewTarget(row.source, { kind: "detail", proposal: row.proposal, observation }) !== canonical) return false;
      const decision = row.detail_decisions.find((item: any) => item.observationIndex === index);
      return decision ? ["accept", "confirm"].includes(decision.result?.disposition)
        : !row.resolution_receipt.result.pendingObservations?.some((item: any) => item.index === index);
    });
  });
}
/** Run a review decision inside the caller's existing campaign transaction. */
export async function reviewDecisionWithClient(client: DatabaseClient, scope: CastScope, id: string, request: ReviewDecisionRequest, editingEnabled: boolean, receiptExtra?: Record<string, unknown>) {
  const cast = await initializeCastWithClient(client, scope);
  if (!editingEnabled) throw new CampaignCastError("cast_editing_disabled");
  const row = (await client.query("SELECT * FROM campaign_cast_discovery_candidates WHERE id=$1 AND campaign_id=$2 AND owner_user_id=$3 FOR UPDATE", [id, scope.campaignId, scope.ownerUserId])).rows[0];
  if (!row) throw new CampaignCastError("cast_not_found");
  const requestHash = sha256(stableStringify({ id, request }));
  const prior = (await client.query("SELECT request_hash,result_receipt FROM campaign_cast_review_decisions WHERE campaign_id=$1 AND owner_user_id=$2 AND idempotency_key=$3", [scope.campaignId, scope.ownerUserId, request.idempotencyKey])).rows[0];
  if (prior) { if (prior.request_hash !== requestHash) throw new CampaignCastError("cast_idempotency_conflict"); const { decisionId, candidateId, reviewRevision, revision, boundary, disposition } = prior.result_receipt; return reviewDecisionResultSchema.parse({ decisionId, candidateId, reviewRevision, revision, boundary, disposition }); }
  const revision = await readReviewRevision(client, scope);
  if (!await currentSource(client, scope, cast, row) || request.sourceHash !== row.source.sourceHash || request.expectedCastRevision !== cast.revision || stableStringify(request.expectedBoundary) !== stableStringify(cast.boundary) || request.expectedReviewRevision !== revision) throw new CampaignCastError("cast_revision_conflict");
  if ((await client.query("SELECT 1 FROM generation_jobs WHERE campaign_id=$1 AND owner_user_id=$2 AND status IN ('queued','replacement_queued','assessing','generating','validating','committing','recoverable') LIMIT 1", [scope.campaignId, scope.ownerUserId])).rowCount) throw new CampaignCastError("cast_generation_active");
  const active = await readActiveReviewDismissals(client, scope);
  const proposal = castDiscoveryCandidateSchema.parse(row.proposal);
  let target: ReviewTarget, index: number | null, restores: string | null = null;
  if (request.action === "restore") {
    const decision = active.rows.find(item => item.id === request.decisionId && item.candidate_id === id);
    if (!decision) throw new CampaignCastError("cast_invalid_request");
    target = decision.target_payload; index = decision.observation_index; restores = decision.id;
    if (canonicalReviewTarget(row.source, target) !== canonicalReviewTarget(decision.source, target) || !eligible(row, target, index) || await alreadyResolved(client, scope, row.source, target)) throw new CampaignCastError("cast_invalid_request");
  } else {
    index = request.action === "dismiss_detail" ? request.observationIndex : null;
    if (index !== null && !proposal.observations[index]) throw new CampaignCastError("cast_invalid_request");
    target = index === null ? { kind: "identity", proposal } : { kind: "detail", proposal, observation: proposal.observations[index]! };
    if (!eligible(row, target, index) || isReviewDismissed(active, row.source, target)) throw new CampaignCastError("cast_invalid_request");
  }
  const next = revision + 1, decisionId = randomUUID();
  const result = reviewDecisionResultSchema.parse({ decisionId, candidateId: id, reviewRevision: next, revision: cast.revision, boundary: cast.boundary, disposition: request.action });
  await client.query(`INSERT INTO campaign_cast_review_sequences(campaign_id,owner_user_id,revision) VALUES($1,$2,$3) ON CONFLICT(campaign_id,owner_user_id) DO UPDATE SET revision=EXCLUDED.revision`, [scope.campaignId, scope.ownerUserId, next]);
  await client.query(`INSERT INTO campaign_cast_review_decisions(id,campaign_id,owner_user_id,candidate_id,turn_id,narration_revision,timeline_revision,source_hash,source,target_kind,observation_index,target_payload,target_fingerprint,action,restores_decision_id,revision,request_hash,idempotency_key,result_receipt)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`, [decisionId, scope.campaignId, scope.ownerUserId, id, row.source.turnId, row.source.narrationRevision, row.source.timelineRevision, row.source.sourceHash, JSON.stringify(row.source), target.kind, index, JSON.stringify(target), reviewTargetFingerprint(row.source, target), restores ? "restore" : "dismiss", restores, next, requestHash, request.idempotencyKey, JSON.stringify({ ...result, ...receiptExtra })]);
  return result;
}
export function createCastReviewDecisionRepository(pool: DatabasePool, editingEnabled: boolean) {
  return {
    async reviewDecision(rawScope: CastScope, rawId: string, rawRequest: ReviewDecisionRequest) {
      const scope = castScopeSchema.parse(rawScope), id = z.uuid().parse(rawId), request = reviewDecisionRequestSchema.parse(rawRequest);
      return withTransaction(pool, async client => {
        return reviewDecisionWithClient(client, scope, id, request, editingEnabled);
      });
    },
    async dismissedReview(rawScope: CastScope, input: { cursor?: string; limit?: number } = {}) {
      const scope = castScopeSchema.parse(rawScope), query = dismissedReviewQuerySchema.parse(input);
      return withTransaction(pool, async client => {
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const snapshot = (await client.query(`SELECT c.active_turn_number, COALESCE(s.revision, 0) AS revision, COALESCE(s.timeline_revision, 0) AS timeline_revision
          FROM campaigns c LEFT JOIN campaign_cast_state s ON s.campaign_id=c.id AND s.owner_user_id=c.owner_user_id
          WHERE c.id=$1 AND c.owner_user_id=$2`, [scope.campaignId, scope.ownerUserId])).rows[0];
        if (!snapshot) throw new CampaignCastError("cast_not_found");
        const cast = { revision: Number(snapshot.revision), boundary: { turnNumber: Number(snapshot.active_turn_number), timelineRevision: Number(snapshot.timeline_revision) } };
        const active = await readActiveReviewDismissals(client, scope);
        const entries: { decision: Row; row: any }[] = [];
        for (const decision of active.rows) {
          if (query.cursor && decision.id <= query.cursor) continue;
          const row = (await client.query("SELECT * FROM campaign_cast_discovery_candidates WHERE id=$1 AND campaign_id=$2 AND owner_user_id=$3", [decision.candidate_id, scope.campaignId, scope.ownerUserId])).rows[0];
          if (row && await currentSource(client, scope, cast, row)) entries.push({ decision, row });
        }
        entries.sort((a, b) => a.decision.id < b.decision.id ? -1 : a.decision.id > b.decision.id ? 1 : 0);
        const selected = entries.slice(0, query.limit);
        const page = [];
        for (const { decision, row } of selected) {
          const target: ReviewTarget = decision.target_payload;
          page.push({ decisionId: decision.id, candidateId: row.id, source: decision.source, target: target.kind === "identity" ? target : { kind: "detail", observationIndex: decision.observation_index, observation: target.observation }, canRestore: eligible(row, target, decision.observation_index) && !await alreadyResolved(client, scope, row.source, target) });
        }
        return dismissedReviewPageSchema.parse({ reviewRevision: await readReviewRevision(client, scope), revision: cast.revision, boundary: cast.boundary, decisions: page, nextCursor: entries.length > query.limit ? page.at(-1)!.decisionId : null });
      });
    }
  };
}
