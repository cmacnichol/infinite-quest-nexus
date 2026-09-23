import { castScopeSchema, castBackfillRequestSchema, castBackfillPreviewSchema, CAST_DISCOVERY_PROTOCOL, type CastScope, type CastBackfillRequest } from "@infinite-quest/contracts";
import type { CastDiscoveryExecution } from "../../application/src/campaign-cast/discovery.js";
import { validateCastBackfillRange } from "../../application/src/campaign-cast/backfill.js";
import { CampaignCastError } from "../../application/src/campaign-cast/ports.js";
import { buildCastDiscoverySource, chunkCastDiscoverySource } from "../../domain/src/campaign-cast-discovery.js";
import { withTransaction, type DatabasePool } from "./pool.js";
import { readCastDiscoveryExecution } from "./campaign-cast-job-repository.js";
import { readCastDiscoveryStatus } from "./campaign-cast-status-repository.js";

export function createCastBackfillRepository(pool: DatabasePool) {
  return { async preview(rawScope: CastScope, rawRequest: CastBackfillRequest, rawExecution: CastDiscoveryExecution) {
    const scope = castScopeSchema.parse(rawScope), request = castBackfillRequestSchema.parse(rawRequest);
    const execution = readCastDiscoveryExecution(rawExecution);
    return withTransaction(pool, async client => {
      // The campaign lock gives the preview a consistent source/boundary snapshot without enrolling it.
      const campaign = (await client.query(`SELECT c.active_turn_number,COALESCE(s.timeline_revision,0) AS timeline_revision
        FROM campaigns c LEFT JOIN campaign_cast_state s ON s.campaign_id=c.id AND s.owner_user_id=c.owner_user_id
        WHERE c.id=$1 AND c.owner_user_id=$2 FOR UPDATE OF c`, [scope.campaignId, scope.ownerUserId])).rows[0];
      if (!campaign) throw new CampaignCastError("cast_not_found");
      const boundary = { turnNumber: campaign.active_turn_number as number, timelineRevision: campaign.timeline_revision as number };
      const rows = (await client.query(`SELECT turn_id,turn_number,correction_revision,effective_narration
        FROM effective_turn_narrations WHERE campaign_id=$1 AND owner_user_id=$2 AND turn_number BETWEEN $3 AND $4
        ORDER BY turn_number`, [scope.campaignId, scope.ownerUserId, request.fromTurn, request.throughTurn])).rows;
      const coverage = await readCastDiscoveryStatus(client, scope, true);
      const { turnCount } = validateCastBackfillRange({ request, boundary, coverageStartTurn: coverage.coverageStartTurn,
        trackedThroughTurn: coverage.trackedThroughTurn, acceptedTurnNumbers: rows.map(row => row.turn_number as number) });
      let estimatedChunkRequests = 0, completedChunkReceipts = 0, completedTurns = 0;
      const manualScanTurns: number[] = [];
      for (const row of rows) {
        const source = buildCastDiscoverySource({ scope, turnId: row.turn_id, turnNumber: row.turn_number,
          narrationRevision: row.correction_revision, timelineRevision: boundary.timelineRevision, narration: row.effective_narration });
        const chunks = chunkCastDiscoverySource(source);
        if (chunks.status !== "ready") { manualScanTurns.push(source.turnNumber); continue; }
        const prior = (await client.query(`SELECT j.status,j.chunk_ordinal,j.checkpoint,
          (SELECT count(*)::integer FROM campaign_cast_discovery_receipts r WHERE r.job_id=j.id AND r.campaign_id=j.campaign_id
            AND r.owner_user_id=j.owner_user_id) AS receipt_count
          FROM campaign_cast_discovery_jobs j WHERE j.campaign_id=$1 AND j.owner_user_id=$2 AND j.turn_id=$3
            AND j.narration_revision=$4 AND j.timeline_revision=$5 AND j.source_hash=$6 AND j.protocol=$7 AND j.status<>'cancelled'`,
        [scope.campaignId, scope.ownerUserId, source.turnId, source.narrationRevision, source.timelineRevision, source.sourceHash, CAST_DISCOVERY_PROTOCOL])).rows[0];
        const receipts = prior?.receipt_count ?? 0;
        completedChunkReceipts += receipts;
        if (prior?.status === "complete" && receipts === chunks.chunks.length) completedTurns++;
        estimatedChunkRequests += Math.max(0, chunks.chunks.length - receipts - (prior?.checkpoint ? 1 : 0));
      }
      // Deliberately project only public provider selection, never the frozen admission/configuration.
      return castBackfillPreviewSchema.parse({ fromTurn: request.fromTurn, throughTurn: request.throughTurn, boundary, turnCount,
        estimatedChunkRequests, completedChunkReceipts, completedTurns, manualScanTurns,
        providerProfileId: execution.providerProfileId, selection: execution.plan.selection });
    });
  } };
}
