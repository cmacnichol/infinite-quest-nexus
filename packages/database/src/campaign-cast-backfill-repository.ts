import { castScopeSchema, castBackfillRequestSchema, castBackfillPreviewSchema, castBackfillProgressSchema, CAST_DISCOVERY_PROTOCOL, type CastDiscoverySource, type CastScope, type CastBackfillRequest } from "@infinite-quest/contracts";
import type { CastDiscoveryExecution } from "../../application/src/campaign-cast/discovery.js";
import { validateCastBackfillRange } from "../../application/src/campaign-cast/backfill.js";
import { CampaignCastError } from "../../application/src/campaign-cast/ports.js";
import { buildCastDiscoverySource, chunkCastDiscoverySource } from "../../domain/src/campaign-cast-discovery.js";
import { withTransaction, type DatabasePool, type DatabaseClient } from "./pool.js";
import { sha256, stableStringify } from "../../domain/src/text.js";
import { readCastDiscoveryExecution } from "./campaign-cast-job-repository.js";
import { readCastDiscoveryStatus } from "./campaign-cast-status-repository.js";
import { z } from "zod";

async function readProgress(client: DatabaseClient, scope: CastScope, id: string) {
  const row = (await client.query(`SELECT s.*,
    (SELECT count(*)::int FROM campaign_cast_scan_sources p WHERE p.scan_id=s.id AND p.status='complete') AS complete_turns,
    (SELECT count(*)::int FROM campaign_cast_scan_sources p WHERE p.scan_id=s.id AND p.status='failed') AS failed_turns,
    (SELECT count(*)::int FROM campaign_cast_scan_sources p
      JOIN campaign_cast_discovery_jobs j ON j.campaign_id=p.campaign_id AND j.owner_user_id=p.owner_user_id
        AND j.turn_id::text=p.source->>'turnId' AND j.narration_revision=(p.source->>'narrationRevision')::int
        AND j.source_hash=p.source->>'sourceHash' AND j.status<>'cancelled'
      JOIN campaign_cast_discovery_candidates d ON d.job_id=j.id AND d.campaign_id=j.campaign_id AND d.owner_user_id=j.owner_user_id
      WHERE p.scan_id=s.id AND d.status='pending') AS pending_review_count
    FROM campaign_cast_scans s WHERE s.id=$1 AND s.campaign_id=$2 AND s.owner_user_id=$3`, [id, scope.campaignId, scope.ownerUserId])).rows[0];
  if (!row) throw new CampaignCastError("cast_not_found");
  return castBackfillProgressSchema.parse({ id: row.id, fromTurn: row.from_turn, throughTurn: row.through_turn,
    completeTurns: row.complete_turns, failedTurns: row.failed_turns, pendingReviewCount: row.pending_review_count, status: row.status });
}

export function createCastBackfillRepository(pool: DatabasePool, enabled = () => false) {
  return {
    async get(rawScope: CastScope, rawId: string) {
      const scope = castScopeSchema.parse(rawScope), id = z.uuid().parse(rawId);
      return withTransaction(pool, client => readProgress(client, scope, id));
    },
    async control(rawScope: CastScope, rawId: string, rawAction: "pause" | "resume" | "cancel") {
      const scope = castScopeSchema.parse(rawScope), id = z.uuid().parse(rawId), action = z.enum(["pause", "resume", "cancel"]).parse(rawAction);
      return withTransaction(pool, async client => {
        if (!(await client.query("SELECT id FROM campaigns WHERE id=$1 AND owner_user_id=$2 FOR UPDATE", [scope.campaignId, scope.ownerUserId])).rows.length) {
          throw new CampaignCastError("cast_not_found");
        }
        const current = await readProgress(client, scope, id);
        if (action === "resume" && !enabled()) throw new CampaignCastError("cast_discovery_disabled");
        if (current.status === "complete" || current.status === "cancelled") {
          if (action !== "cancel") throw new CampaignCastError("cast_revision_conflict");
          return current;
        }
        const status = action === "cancel" ? "cancelled" : action === "pause" ? "paused" : "queued";
        await client.query("UPDATE campaign_cast_scans SET status=$2,updated_at=clock_timestamp() WHERE id=$1", [id, status]);
        if (action === "cancel") await client.query("UPDATE campaign_cast_scan_sources SET status='cancelled' WHERE scan_id=$1 AND status='pending'", [id]);
        return readProgress(client, scope, id);
      });
    },
    async start(rawScope: CastScope, rawRequest: CastBackfillRequest, rawExecution: CastDiscoveryExecution) {
      const scope = castScopeSchema.parse(rawScope), request = castBackfillRequestSchema.parse(rawRequest);
      return withTransaction(pool, async client => {
        if (!enabled()) throw new CampaignCastError("cast_discovery_disabled");
        if (!(await client.query("SELECT id FROM campaigns WHERE id=$1 AND owner_user_id=$2 FOR UPDATE", [scope.campaignId, scope.ownerUserId])).rows.length) {
          throw new CampaignCastError("cast_not_found");
        }
        const requestHash = sha256(stableStringify(request));
        const prior = (await client.query("SELECT id,request_hash FROM campaign_cast_scans WHERE campaign_id=$1 AND owner_user_id=$2 AND idempotency_key=$3",
          [scope.campaignId, scope.ownerUserId, request.idempotencyKey])).rows[0];
        if (prior) {
          if (prior.request_hash !== requestHash) throw new CampaignCastError("cast_idempotency_conflict");
          return readProgress(client, scope, prior.id);
        }
        if ((await client.query("SELECT id FROM campaign_cast_scans WHERE campaign_id=$1 AND status IN ('queued','running','paused','failed')", [scope.campaignId])).rows.length) {
          throw new CampaignCastError("cast_revision_conflict");
        }
        const execution = readCastDiscoveryExecution(rawExecution);
        const prepared = await prepareScan(client, scope, request, execution);
        if (!enabled()) throw new CampaignCastError("cast_discovery_disabled");
        const scan = (await client.query(`INSERT INTO campaign_cast_scans(campaign_id,owner_user_id,from_turn,through_turn,boundary,
          execution_snapshot,idempotency_key,request_hash,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [scope.campaignId, scope.ownerUserId, request.fromTurn, request.throughTurn, JSON.stringify(prepared.preview.boundary),
          JSON.stringify(execution), request.idempotencyKey, requestHash,
          prepared.preview.completedTurns === prepared.preview.turnCount ? "complete" : "queued"])).rows[0];
        for (const item of prepared.sources) {
          await client.query(`INSERT INTO campaign_cast_scan_sources(scan_id,campaign_id,owner_user_id,turn_number,source,status)
            VALUES($1,$2,$3,$4,$5,$6)`, [scan.id, scope.campaignId, scope.ownerUserId, item.source.turnNumber, JSON.stringify(item.source), item.status]);
        }
        return readProgress(client, scope, scan.id);
      });
    },
    async preview(rawScope: CastScope, rawRequest: CastBackfillRequest, rawExecution: CastDiscoveryExecution) {
      const scope = castScopeSchema.parse(rawScope), request = castBackfillRequestSchema.parse(rawRequest);
      const execution = readCastDiscoveryExecution(rawExecution);
      return withTransaction(pool, async client => (await prepareScan(client, scope, request, execution)).preview);
    }
  };
}

async function prepareScan(client: DatabaseClient, scope: CastScope, request: CastBackfillRequest, execution: CastDiscoveryExecution) {
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
  const sources: { source: CastDiscoverySource; status: "pending" | "complete" | "failed" }[] = [];
  for (const row of rows) {
    const source = buildCastDiscoverySource({ scope, turnId: row.turn_id, turnNumber: row.turn_number,
      narrationRevision: row.correction_revision, timelineRevision: boundary.timelineRevision, narration: row.effective_narration });
    const chunks = chunkCastDiscoverySource(source);
    if (chunks.status !== "ready") { manualScanTurns.push(source.turnNumber); sources.push({ source, status: "failed" }); continue; }
    const prior = (await client.query(`SELECT j.status,j.chunk_ordinal,j.checkpoint,
      (SELECT count(*)::integer FROM campaign_cast_discovery_receipts r WHERE r.job_id=j.id AND r.campaign_id=j.campaign_id
        AND r.owner_user_id=j.owner_user_id) AS receipt_count
      FROM campaign_cast_discovery_jobs j WHERE j.campaign_id=$1 AND j.owner_user_id=$2 AND j.turn_id=$3
        AND j.narration_revision=$4 AND j.timeline_revision=$5 AND j.source_hash=$6 AND j.protocol=$7 AND j.status<>'cancelled'`,
    [scope.campaignId, scope.ownerUserId, source.turnId, source.narrationRevision, source.timelineRevision, source.sourceHash, CAST_DISCOVERY_PROTOCOL])).rows[0];
    const receipts = prior?.receipt_count ?? 0;
    completedChunkReceipts += receipts;
    const complete = prior?.status === "complete" && receipts === chunks.chunks.length;
    if (complete) completedTurns++;
    sources.push({ source, status: complete ? "complete" : "pending" });
    estimatedChunkRequests += Math.max(0, chunks.chunks.length - receipts - (prior?.checkpoint ? 1 : 0));
  }
  // Deliberately project only public provider selection, never the frozen admission/configuration.
  return { sources, preview: castBackfillPreviewSchema.parse({ fromTurn: request.fromTurn, throughTurn: request.throughTurn, boundary, turnCount,
    estimatedChunkRequests, completedChunkReceipts, completedTurns, manualScanTurns,
    providerProfileId: execution.providerProfileId, selection: execution.plan.selection }) };
}
