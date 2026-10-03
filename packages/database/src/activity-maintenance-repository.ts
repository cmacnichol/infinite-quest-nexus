import { logger } from "../../logger/src/index.js";
import { activityEventDraftSchema, activityEventSchema } from "../../contracts/src/activity.js";
import type { ActivityMaintenanceRepository } from "./activity-repository.js";
import type { DatabasePool } from "./pool.js";

// Shared across replicas; acquired before the first sequence is allocated.
export const ACTIVITY_PUBLICATION_LOCK = 714114;
export function createPostgresActivityMaintenanceRepository(pool: DatabasePool): ActivityMaintenanceRepository {
  return {
    async publishBatch(limit) {
      if (!Number.isFinite(limit) || limit < 1) throw new RangeError("invalid_batch_limit");
      const bounded = Math.min(100, Math.max(1, Math.trunc(limit)));
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS locked", [ACTIVITY_PUBLICATION_LOCK]);
        if (!lock.rows[0]!.locked) { await client.query("COMMIT"); return { published: 0, quarantined: 0 }; }
        const rows = (await client.query<{ event_id: string; owner_user_id: string; campaign_id: string; source: string; occurred_at: Date; snapshot: unknown }>(
          `SELECT event_id,owner_user_id,campaign_id,source,occurred_at,snapshot FROM activity_event_outbox
           WHERE published_at IS NULL AND quarantine_code IS NULL ORDER BY occurred_at,event_id LIMIT $1 FOR UPDATE`, [bounded])).rows;
        let published = 0;
        let quarantined = 0;
        for (const row of rows) {
          const parsed = activityEventDraftSchema.safeParse(row.snapshot);
          if (!parsed.success || parsed.data.eventId !== row.event_id || parsed.data.campaignId !== row.campaign_id
            || parsed.data.source !== row.source || Date.parse(parsed.data.occurredAt) !== row.occurred_at.getTime()) {
            await client.query("UPDATE activity_event_outbox SET quarantine_code='invalid_snapshot' WHERE event_id=$1", [row.event_id]);
            quarantined++;
            continue;
          }
          const draft = parsed.data;
          const existing = (await client.query<{ sequence: string; published_at: Date }>("SELECT sequence::text,published_at FROM story_activity_events WHERE event_id=$1", [row.event_id])).rows[0];
          const allocation = existing ?? (await client.query<{ sequence: string; published_at: Date }>(
            "SELECT nextval(pg_get_serial_sequence('story_activity_events','sequence'))::text AS sequence,clock_timestamp() AS published_at")).rows[0]!;
          if (!activityEventSchema.safeParse({ ...draft, sequence: allocation.sequence, publishedAt: allocation.published_at.toISOString() }).success) {
            await client.query("UPDATE activity_event_outbox SET quarantine_code='invalid_snapshot' WHERE event_id=$1", [row.event_id]);
            quarantined++;
            continue;
          }
          await client.query(`INSERT INTO story_activity_events(event_id,sequence,owner_user_id,campaign_id,occurred_at,published_at,source,kind,severity,job_id,generation_job_id,segment_id,turn_id,snapshot)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb) ON CONFLICT(event_id) DO NOTHING`,
            [row.event_id,allocation.sequence,row.owner_user_id,row.campaign_id,draft.occurredAt,allocation.published_at,draft.source,draft.kind,draft.severity,draft.jobId,draft.generationJobId,draft.segmentId,draft.turnId,JSON.stringify(draft)]);
          await client.query("UPDATE activity_event_outbox SET published_at=$2 WHERE event_id=$1", [row.event_id,allocation.published_at]);
          await client.query(`UPDATE campaign_activity_history SET last_published_sequence=greatest(last_published_sequence,$3::bigint)
            WHERE owner_user_id=$1 AND campaign_id=$2`, [row.owner_user_id,row.campaign_id,allocation.sequence]);
          published++;
        }
        const health = (await client.query<{ pending_count: string; oldest_pending_age_ms: string | null }>(`SELECT count(*)::text AS pending_count,
          greatest(0,extract(epoch FROM (clock_timestamp()-min(occurred_at)))*1000)::text AS oldest_pending_age_ms
          FROM activity_event_outbox WHERE published_at IS NULL AND quarantine_code IS NULL`)).rows[0]!;
        await client.query("COMMIT");
        logger.info({ event: "activity_publication_health", published, quarantined, pendingCount: health.pending_count,
          oldestPendingAgeMs: health.oldest_pending_age_ms });
        return { published, quarantined };
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    },
    async pruneBatch(limit) {
      if (!Number.isFinite(limit) || limit < 1) throw new RangeError("invalid_batch_limit");
      const bounded = Math.min(1000, Math.max(1, Math.trunc(limit)));
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS locked", [ACTIVITY_PUBLICATION_LOCK]);
        if (!lock.rows[0]!.locked) { await client.query("COMMIT"); return 0; }
        const removed = await client.query(`WITH expired AS (
            SELECT event_id FROM story_activity_events WHERE published_at <= now()-interval '30 days'
            ORDER BY published_at,sequence LIMIT $1 FOR UPDATE
          ), deleted AS (DELETE FROM story_activity_events e USING expired x WHERE e.event_id=x.event_id
            RETURNING e.owner_user_id,e.campaign_id,e.sequence), floors AS (
            SELECT owner_user_id,campaign_id,max(sequence) AS sequence FROM deleted GROUP BY owner_user_id,campaign_id)
          , updated AS (UPDATE campaign_activity_history h SET retention_floor_sequence=greatest(h.retention_floor_sequence,f.sequence)
          FROM floors f WHERE h.owner_user_id=f.owner_user_id AND h.campaign_id=f.campaign_id RETURNING h.campaign_id) SELECT count(*)::int AS count FROM deleted`, [bounded]);
        const receipts = await client.query(`DELETE FROM activity_event_outbox WHERE event_id IN (
          SELECT event_id FROM activity_event_outbox WHERE published_at <= now()-interval '7 days' AND quarantine_code IS NULL
          ORDER BY published_at,event_id LIMIT $1) RETURNING event_id`, [bounded - Number(removed.rows[0]!.count)]);
        await client.query("COMMIT");
        return Number(removed.rows[0]!.count) + (receipts.rowCount ?? 0);
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
  };
}
