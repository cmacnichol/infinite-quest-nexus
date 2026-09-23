import { castDiscoveryStatusSchema, type CastDiscoveryStatus } from "../../contracts/src/campaign-cast-discovery.js";
import { castScopeSchema, type CastScope } from "../../contracts/src/campaign-cast.js";
import { CampaignCastError } from "../../application/src/campaign-cast/ports.js";
import type { DatabasePool, DatabaseClient } from "./pool.js";

/** One statement observes enrollment, current narration, and progress at one database snapshot. */
export async function readCastDiscoveryStatus(pool: DatabasePool | DatabaseClient, rawScope: CastScope, enabled: boolean): Promise<CastDiscoveryStatus> {
  const scope = castScopeSchema.parse(rawScope);
  const row = (await pool.query(`SELECT c.active_turn_number,s.coverage_start_turn,gap.turn_number,gap.job_id,gap.status,gap.diagnostic_code,
      (SELECT count(*)::integer FROM campaign_cast_discovery_candidates p
        JOIN campaign_cast_discovery_jobs j ON j.id=p.job_id AND j.campaign_id=p.campaign_id AND j.owner_user_id=p.owner_user_id
        JOIN effective_turn_narrations n ON n.turn_id=j.turn_id AND n.campaign_id=j.campaign_id AND n.owner_user_id=j.owner_user_id
        WHERE p.campaign_id=c.id AND p.owner_user_id=c.owner_user_id AND p.status='pending' AND j.status<>'cancelled'
          AND j.timeline_revision=s.timeline_revision AND j.turn_number<=c.active_turn_number
          AND j.narration_revision=n.correction_revision AND j.source_hash=encode(digest(n.effective_narration,'sha256'),'hex')) AS unresolved_count
    FROM campaigns c LEFT JOIN campaign_cast_state s ON s.campaign_id=c.id AND s.owner_user_id=c.owner_user_id
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
  const enrolled = row.coverage_start_turn !== null;
  return castDiscoveryStatusSchema.parse({ enabled, activeTurnNumber: row.active_turn_number,
    coverageStartTurn: row.coverage_start_turn,
    trackedThroughTurn: enrolled ? (row.turn_number === null ? row.active_turn_number : row.turn_number - 1) : null,
    state: !enabled ? "disabled" : !enrolled ? "not_enrolled" : row.status === "failed" ? "failed" : row.turn_number === null ? "complete" : "catching_up",
    unresolvedCount: row.unresolved_count,
    firstGap: row.turn_number === null ? null : { turnNumber: row.turn_number, jobId: row.job_id, status: row.status, diagnosticCode: row.diagnostic_code }
  });
}
