import { castScopeSchema, castDiscoverySourceSchema, castBackfillRequestSchema, castBackfillPreviewSchema, castBackfillProgressSchema, CAST_DISCOVERY_PROTOCOL, type CastDiscoverySource, type CastScope, type CastBackfillRequest } from "@infinite-quest/contracts";
import type { CastDiscoveryExecution } from "../../application/src/campaign-cast/discovery.js";
import { validateCastBackfillRange } from "../../application/src/campaign-cast/backfill.js";
import { CampaignCastError } from "../../application/src/campaign-cast/ports.js";
import { buildCastDiscoverySource, chunkCastDiscoverySource } from "../../domain/src/campaign-cast-discovery.js";
import { withTransaction, type DatabasePool, type DatabaseClient } from "./pool.js";
import { sha256, stableStringify } from "../../domain/src/text.js";
import { enqueueCastDiscoveryWithClient, readCastDiscoveryExecution } from "./campaign-cast-job-repository.js";
import { readCastDiscoveryStatus } from "./campaign-cast-status-repository.js";
import { z } from "zod";
import { castBackfillRetrySchema, type CastBackfillRetry } from "../../contracts/src/campaign-cast-backfill.js";
import { createCastDiscoveryJobRepository } from "./campaign-cast-job-repository.js";

async function readProgress(client: DatabaseClient, scope: CastScope, id: string) {
  const row = (await client.query(`SELECT s.*,
    (SELECT count(*)::int FROM campaign_cast_scan_sources p WHERE p.scan_id=s.id AND p.status='complete') AS complete_turns,
    (SELECT count(*)::int FROM campaign_cast_scan_sources p WHERE p.scan_id=s.id AND p.status='failed') AS failed_turns,
    (SELECT min(turn_number) FROM campaign_cast_scan_sources p WHERE p.scan_id=s.id AND p.status='failed') AS first_failed_turn,
    (SELECT count(*)::int FROM campaign_cast_scan_sources p
      JOIN campaign_cast_discovery_jobs j ON j.campaign_id=p.campaign_id AND j.owner_user_id=p.owner_user_id
        AND j.turn_id::text=p.source->>'turnId' AND j.narration_revision=(p.source->>'narrationRevision')::int
        AND j.source_hash=p.source->>'sourceHash' AND j.status<>'cancelled'
      JOIN campaign_cast_discovery_candidates d ON d.job_id=j.id AND d.campaign_id=j.campaign_id AND d.owner_user_id=j.owner_user_id
      WHERE p.scan_id=s.id AND d.status='pending') AS pending_review_count
    FROM campaign_cast_scans s WHERE s.id=$1 AND s.campaign_id=$2 AND s.owner_user_id=$3`, [id, scope.campaignId, scope.ownerUserId])).rows[0];
  if (!row) throw new CampaignCastError("cast_not_found");
  return castBackfillProgressSchema.parse({ id: row.id, fromTurn: row.from_turn, throughTurn: row.through_turn,
    completeTurns: row.complete_turns, failedTurns: row.failed_turns, firstFailedTurn: row.first_failed_turn,
    pendingReviewCount: row.pending_review_count, status: row.status });
}

export function createCastBackfillRepository(pool: DatabasePool, enabled = () => false) {
  return {
    async retry(rawScope: CastScope, rawId: string, rawRequest: CastBackfillRetry) {
      const scope = castScopeSchema.parse(rawScope), id = z.uuid().parse(rawId), request = castBackfillRetrySchema.parse(rawRequest);
      return withTransaction(pool, async client => {
        if (!enabled()) throw new CampaignCastError("cast_discovery_disabled");
        if (!(await client.query("SELECT id FROM campaigns WHERE id=$1 AND owner_user_id=$2 FOR UPDATE", [scope.campaignId, scope.ownerUserId])).rows.length) throw new CampaignCastError("cast_not_found");
        const scan = await readProgress(client, scope, id);
        if (scan.status === "cancelled") throw new CampaignCastError("cast_revision_conflict");
        const item = (await client.query("SELECT source FROM campaign_cast_scan_sources WHERE scan_id=$1 AND turn_number=$2", [id, request.turnNumber])).rows[0];
        if (!item) throw new CampaignCastError("cast_not_found");
        const source = castDiscoverySourceSchema.parse(item.source);
        const job = (await client.query(`SELECT id,status,retry_generation,execution_snapshot FROM campaign_cast_discovery_jobs WHERE campaign_id=$1 AND owner_user_id=$2
          AND turn_id=$3 AND narration_revision=$4 AND timeline_revision=$5 AND source_hash=$6 AND protocol=$7`,
        [scope.campaignId, scope.ownerUserId, source.turnId, source.narrationRevision, source.timelineRevision, source.sourceHash, CAST_DISCOVERY_PROTOCOL])).rows[0];
        if (!job) throw new CampaignCastError("cast_invalid_request");
        const replacement = job.execution_snapshot.unavailable
          ? readCastDiscoveryExecution((await client.query("SELECT execution_snapshot FROM campaign_cast_scans WHERE id=$1", [id])).rows[0].execution_snapshot)
          : undefined;
        const retry = await createCastDiscoveryJobRepository(pool, enabled, enabled).retryFailed(scope, job.id, {
          expectedCastRevision: request.expectedCastRevision, expectedBoundary: request.expectedBoundary,
          idempotencyKey: `scan:${id}:${sha256(request.idempotencyKey)}`
        }, replacement, client);
        // Only a newly authorized retry becomes scan work. Receipt replay must not
        // reassign a completed job or work subsequently authorized elsewhere.
        if (job.status === "failed" && retry.retryGeneration > job.retry_generation) {
          await client.query("UPDATE campaign_cast_discovery_jobs SET scan_id=$2 WHERE id=$1", [job.id, id]);
        }
        const retried = (await client.query("SELECT status FROM campaign_cast_discovery_jobs WHERE id=$1", [job.id])).rows[0];
        await client.query("UPDATE campaign_cast_scan_sources SET status=$3 WHERE scan_id=$1 AND turn_number=$2",
          [id, request.turnNumber, retried.status === "complete" ? "complete" : retried.status === "failed" ? "failed" : "pending"]);
        await client.query(`UPDATE campaign_cast_scans SET status=CASE WHEN status IN ('paused','complete') THEN status
          WHEN EXISTS (SELECT 1 FROM campaign_cast_scan_sources p WHERE p.scan_id=$1 AND p.status='failed') THEN 'failed' ELSE 'queued' END,
          updated_at=clock_timestamp() WHERE id=$1`, [id]);
        return readProgress(client, scope, id);
      });
    },
    async latest(rawScope: CastScope) {
      const scope = castScopeSchema.parse(rawScope);
      return withTransaction(pool, async client => {
        if (!(await client.query("SELECT id FROM campaigns WHERE id=$1 AND owner_user_id=$2", [scope.campaignId, scope.ownerUserId])).rows.length) throw new CampaignCastError("cast_not_found");
        const row = (await client.query("SELECT id FROM campaign_cast_scans WHERE campaign_id=$1 AND owner_user_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
          [scope.campaignId, scope.ownerUserId])).rows[0];
        return row ? readProgress(client, scope, row.id) : null;
      });
    },
    async replayStart(rawScope: CastScope, rawRequest: CastBackfillRequest) {
      const scope = castScopeSchema.parse(rawScope), request = castBackfillRequestSchema.parse(rawRequest);
      return withTransaction(pool, async client => {
        if (!(await client.query("SELECT id FROM campaigns WHERE id=$1 AND owner_user_id=$2 FOR UPDATE", [scope.campaignId, scope.ownerUserId])).rows.length) throw new CampaignCastError("cast_not_found");
        const prior = (await client.query("SELECT id,request_hash FROM campaign_cast_scans WHERE campaign_id=$1 AND owner_user_id=$2 AND idempotency_key=$3",
          [scope.campaignId, scope.ownerUserId, request.idempotencyKey])).rows[0];
        if (!prior) return null;
        if (prior.request_hash !== sha256(stableStringify(request))) throw new CampaignCastError("cast_idempotency_conflict");
        return readProgress(client, scope, prior.id);
      });
    },
    async scheduleNext() {
      if (!enabled()) return false;
      return withTransaction(pool, async client => {
        const campaign = (await client.query(`SELECT c.id,c.owner_user_id,c.active_turn_number FROM campaigns c
          WHERE EXISTS (SELECT 1 FROM campaign_cast_scans s WHERE s.campaign_id=c.id AND s.status IN ('queued','running'))
          AND NOT EXISTS (SELECT 1 FROM generation_jobs g WHERE g.campaign_id=c.id AND g.owner_user_id=c.owner_user_id
            AND g.status IN ('queued','replacement_queued','assessing','generating','validating','committing','recoverable'))
          AND NOT EXISTS (SELECT 1 FROM campaign_cast_discovery_jobs j JOIN campaign_cast_scans s ON s.id=j.scan_id
            WHERE j.campaign_id=c.id AND s.status IN ('queued','running') AND j.status IN ('queued','running','retry_wait'))
          ORDER BY c.id FOR UPDATE OF c SKIP LOCKED LIMIT 1`)).rows[0];
        if (!campaign || !enabled()) return false;
        const scope = { campaignId: campaign.id as string, ownerUserId: campaign.owner_user_id as string };
        const scan = (await client.query("SELECT * FROM campaign_cast_scans WHERE campaign_id=$1 AND status IN ('queued','running') FOR UPDATE", [scope.campaignId])).rows[0];
        const items = (await client.query("SELECT * FROM campaign_cast_scan_sources WHERE scan_id=$1 ORDER BY turn_number", [scan.id])).rows;
        const state = (await client.query("SELECT timeline_revision FROM campaign_cast_state WHERE campaign_id=$1", [scope.campaignId])).rows[0];
        for (const item of items) {
          const source = castDiscoverySourceSchema.parse(item.source);
          const current = (await client.query(`SELECT effective_narration,correction_revision,turn_number FROM effective_turn_narrations
            WHERE turn_id=$1 AND campaign_id=$2 AND owner_user_id=$3`, [source.turnId, scope.campaignId, scope.ownerUserId])).rows[0];
          if (source.scope.campaignId !== scope.campaignId || source.scope.ownerUserId !== scope.ownerUserId
            || !current || current.turn_number !== source.turnNumber || source.turnNumber > campaign.active_turn_number
            || current.correction_revision !== source.narrationRevision || sha256(current.effective_narration) !== source.sourceHash
            || (state?.timeline_revision ?? 0) !== source.timelineRevision) {
            await cancelScan(client, scan.id);
            return true;
          }
        }
        // Publication and coverage changes wait for active Story generation to finish.
        if ((await client.query(`SELECT id FROM generation_jobs WHERE campaign_id=$1 AND owner_user_id=$2
          AND status IN ('queued','replacement_queued','assessing','generating','validating','committing','recoverable') LIMIT 1`,
        [scope.campaignId, scope.ownerUserId])).rows.length) return false;
        for (const item of items) {
          if (item.status === "complete") continue;
          if (item.status === "failed") {
            await client.query("UPDATE campaign_cast_scans SET status='failed',updated_at=clock_timestamp() WHERE id=$1", [scan.id]);
            return true;
          }
          const source = castDiscoverySourceSchema.parse(item.source);
          const existing = (await client.query(`SELECT id,status FROM campaign_cast_discovery_jobs WHERE campaign_id=$1 AND owner_user_id=$2
            AND turn_id=$3 AND narration_revision=$4 AND timeline_revision=$5 AND source_hash=$6 AND protocol=$7`,
          [scope.campaignId, scope.ownerUserId, source.turnId, source.narrationRevision, source.timelineRevision, source.sourceHash, CAST_DISCOVERY_PROTOCOL])).rows[0];
          if (existing?.status === "complete") {
            await client.query("UPDATE campaign_cast_scan_sources SET status='complete' WHERE scan_id=$1 AND turn_number=$2", [scan.id, source.turnNumber]);
            continue;
          }
          if (existing?.status === "failed") {
            await client.query("UPDATE campaign_cast_scan_sources SET status='failed' WHERE scan_id=$1 AND turn_number=$2", [scan.id, source.turnNumber]);
            await client.query("UPDATE campaign_cast_scans SET status='failed',updated_at=clock_timestamp() WHERE id=$1", [scan.id]);
            return true;
          }
          if (existing && existing.status !== "cancelled") return false;
          const jobId = await enqueueCastDiscoveryWithClient(client, { scope, turnId: source.turnId,
            execution: readCastDiscoveryExecution(scan.execution_snapshot), enabled: true });
          // A new user-requested scan may adopt cancelled work under its newly
          // frozen plan. Keep paid checkpoints and all retry/attempt accounting.
          await client.query(`UPDATE campaign_cast_discovery_jobs SET scan_id=$2,
            execution_snapshot=CASE WHEN status='cancelled' AND checkpoint IS NULL THEN $3::jsonb ELSE execution_snapshot END,
            status=CASE WHEN status='cancelled' THEN 'queued' ELSE status END,
            updated_at=clock_timestamp() WHERE id=$1`, [jobId, scan.id, JSON.stringify(readCastDiscoveryExecution(scan.execution_snapshot))]);
          await client.query(`UPDATE campaign_cast_state SET coverage_start_turn=LEAST(coverage_start_turn,$2) WHERE campaign_id=$1`, [scope.campaignId, scan.from_turn]);
          await client.query("UPDATE campaign_cast_scans SET status='running',updated_at=clock_timestamp() WHERE id=$1", [scan.id]);
          return true;
        }
        await client.query("UPDATE campaign_cast_scans SET status='complete',updated_at=clock_timestamp() WHERE id=$1", [scan.id]);
        return true;
      });
    },
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
        if (action === "cancel") await cancelScan(client, id);
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

async function cancelScan(client: DatabaseClient, id: string) {
  // A publication can finish between scheduler ticks; preserve that receipt-backed progress.
  await client.query(`UPDATE campaign_cast_scan_sources p SET status='complete' WHERE scan_id=$1 AND status='pending'
    AND EXISTS (SELECT 1 FROM campaign_cast_discovery_jobs j WHERE j.campaign_id=p.campaign_id AND j.owner_user_id=p.owner_user_id
      AND j.turn_id::text=p.source->>'turnId' AND j.narration_revision=(p.source->>'narrationRevision')::int
      AND j.source_hash=p.source->>'sourceHash' AND j.status='complete')`, [id]);
  await client.query("UPDATE campaign_cast_scans SET status='cancelled',updated_at=clock_timestamp() WHERE id=$1", [id]);
  await client.query("UPDATE campaign_cast_scan_sources SET status='cancelled' WHERE scan_id=$1 AND status='pending'", [id]);
  await client.query(`UPDATE campaign_cast_discovery_jobs SET status='cancelled',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,
    updated_at=clock_timestamp() WHERE scan_id=$1 AND status NOT IN ('complete','cancelled')`, [id]);
}

/** Caller holds the campaign lock; already applied evidence is handled by the cast lifecycle. */
export async function cancelCastScansWithClient(client: DatabaseClient, scope: CastScope) {
  const scans = (await client.query(`SELECT id FROM campaign_cast_scans WHERE campaign_id=$1 AND owner_user_id=$2
    AND status IN ('queued','running','paused','failed') FOR UPDATE`, [scope.campaignId, scope.ownerUserId])).rows;
  for (const scan of scans) await cancelScan(client, scan.id);
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
