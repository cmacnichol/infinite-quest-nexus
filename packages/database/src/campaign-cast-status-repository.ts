import { castDiscoveryStatusSchema, type CastDiscoveryStatus } from "../../contracts/src/campaign-cast-discovery.js";
import { castScopeSchema, type CastScope } from "../../contracts/src/campaign-cast.js";
import { CampaignCastError } from "../../application/src/campaign-cast/ports.js";
import { withTransaction, type DatabasePool, type DatabaseClient } from "./pool.js";
import type { CastSnapshot } from "../../contracts/src/campaign-cast.js";
import { currentCastReviewCandidates } from "./campaign-cast-current-review.js";

/** Read enrollment and progress, then filter current review evidence through the effective cast. */
export async function readCastDiscoveryStatus(pool: DatabasePool | DatabaseClient, rawScope: CastScope, enabled: boolean, projected?: CastSnapshot): Promise<CastDiscoveryStatus> {
  const scope = castScopeSchema.parse(rawScope);
  if ("connect" in pool && !("release" in pool)) return withTransaction(pool as DatabasePool, client => readCastDiscoveryStatus(client, scope, enabled, projected));
  const snapshot = projected ?? await (async () => {
    const { rebuildCastWithClient } = await import("./campaign-cast-repository.js");
    const campaign = (await pool.query("SELECT active_turn_number FROM campaigns WHERE id=$1 AND owner_user_id=$2", [scope.campaignId, scope.ownerUserId])).rows[0];
    if (!campaign) throw new CampaignCastError("cast_not_found");
    return rebuildCastWithClient(pool as DatabaseClient, scope, campaign.active_turn_number);
  })();
  const row = (await pool.query(`SELECT c.active_turn_number,s.coverage_start_turn,gap.turn_number,gap.job_id,gap.status,gap.diagnostic_code, automatic.*,
      0 AS unresolved_count
    FROM campaigns c LEFT JOIN campaign_cast_state s ON s.campaign_id=c.id AND s.owner_user_id=c.owner_user_id
    CROSS JOIN LATERAL (
      SELECT count(*) FILTER (WHERE j.status='queued')::int AS queued,
        max(j.turn_number) FILTER (WHERE j.status='running' AND j.lease_expires_at>statement_timestamp()) AS running_turn,
        count(*) FILTER (WHERE j.status='running' AND j.lease_expires_at<=statement_timestamp())::int AS expired,
        count(*) FILTER (WHERE j.status='retry_wait')::int AS retry_wait,
        count(*) FILTER (WHERE j.status='failed')::int AS failed, count(*) FILTER (WHERE j.status='complete')::int AS complete
      FROM campaign_cast_discovery_jobs j WHERE j.campaign_id=c.id AND j.owner_user_id=c.owner_user_id AND j.scan_id IS NULL
        AND j.timeline_revision=s.timeline_revision AND j.turn_number<=c.active_turn_number
    ) automatic
    LEFT JOIN LATERAL (
      SELECT t.turn_number,j.id AS job_id,COALESCE(j.status,'missing') AS status,j.diagnostic_code
      FROM generate_series(COALESCE(s.coverage_start_turn,c.active_turn_number+1),c.active_turn_number) t(turn_number)
      LEFT JOIN effective_turn_narrations n ON n.campaign_id=c.id AND n.owner_user_id=c.owner_user_id AND n.turn_number=t.turn_number
      LEFT JOIN campaign_cast_discovery_jobs j ON j.campaign_id=c.id AND j.owner_user_id=c.owner_user_id AND j.turn_id=n.turn_id
        AND j.narration_revision=n.correction_revision AND j.timeline_revision=s.timeline_revision
        AND j.source_hash=encode(digest(n.effective_narration,'sha256'),'hex')
      WHERE j.status IS DISTINCT FROM 'complete' ORDER BY t.turn_number LIMIT 1
    ) gap ON true WHERE c.id=$1 AND c.owner_user_id=$2`, [scope.campaignId, scope.ownerUserId])).rows[0];
  if (!row) throw new CampaignCastError("cast_not_found");
  const unresolved = await currentCastReviewCandidates(pool, scope, snapshot, true);
  const enrolled = row.coverage_start_turn !== null;
  return castDiscoveryStatusSchema.parse({ enabled, activeTurnNumber: row.active_turn_number,
    coverageStartTurn: row.coverage_start_turn,
    trackedThroughTurn: enrolled ? (row.turn_number === null ? row.active_turn_number : row.turn_number - 1) : null,
    state: !enabled ? "disabled" : !enrolled ? "not_enrolled" : row.status === "failed" ? "failed" : row.turn_number === null ? "complete" : "catching_up",
    automaticJobs: { queued: row.queued + row.expired, runningTurn: row.running_turn, retryWait: row.retry_wait, failed: row.failed, complete: row.complete },
    unresolvedCount: unresolved.length,
    firstGap: row.turn_number === null ? null : { turnNumber: row.turn_number, jobId: row.job_id, status: row.status, diagnosticCode: row.diagnostic_code }
  });
}
