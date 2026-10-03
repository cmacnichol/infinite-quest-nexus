import { z } from "zod";
import { activityEventDraftSchema, activityEventSchema, activityPageQuerySchema, activityPageSchema, activityScopeSchema, activitySequenceSchema, type ActivityEventDraft, type ActivityPage, type ActivityScope } from "../../contracts/src/activity.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";

export interface ActivityCapture {
  scope: ActivityScope;
  sourceId: string;
  revision: string;
  ordinal?: number;
  draft: ActivityEventDraft;
}
export interface ActivityReadRepository {
  list(scope: ActivityScope, query?: unknown): Promise<ActivityPage>;
}
export type { ActivityMaintenanceRepository } from "../../application/src/activity.js";
export class ActivityRepositoryError extends Error {
  constructor(public readonly code: "not_found" | "invalid_cursor" | "invalid_snapshot") { super(code); }
}
const cursorSchema = z.strictObject({ version: z.literal(1), campaignId: z.uuid(), direction: z.enum(["before", "after"]), sequence: activitySequenceSchema });
export function encodeActivityCursor(campaignId: string, direction: "before" | "after", sequence: string): string {
  return Buffer.from(JSON.stringify(cursorSchema.parse({ version: 1, campaignId, direction, sequence }))).toString("base64url");
}
function decodeCursor(value: string, scope: ActivityScope, direction: "before" | "after") {
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error();
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (cursor.campaignId !== scope.campaignId || cursor.direction !== direction) throw new Error();
    return cursor;
  } catch { throw new ActivityRepositoryError("invalid_cursor"); }
}
/** The caller must use the same transaction as the authoritative mutation. */
export async function captureActivity(client: DatabaseClient, input: ActivityCapture): Promise<string> {
  const scope = activityScopeSchema.parse(input.scope);
  const draft = activityEventDraftSchema.parse(input.draft);
  const sourceId = z.uuid().parse(input.sourceId);
  const revision = activitySequenceSchema.parse(input.revision);
  const ordinal = z.number().int().nonnegative().parse(input.ordinal ?? 0);
  if (draft.campaignId !== scope.campaignId) throw new ActivityRepositoryError("invalid_snapshot");
  const result = await client.query<{ event_id: string }>(
    `INSERT INTO activity_event_outbox(event_id,owner_user_id,campaign_id,source,source_id,activity_revision,ordinal,occurred_at,snapshot)
     VALUES ($1,$2,$3,$4,$5,$6::bigint,$7,$8,$9::jsonb)
     ON CONFLICT (source,source_id,activity_revision,ordinal) DO UPDATE SET event_id=activity_event_outbox.event_id
     WHERE activity_event_outbox.owner_user_id=EXCLUDED.owner_user_id AND activity_event_outbox.campaign_id=EXCLUDED.campaign_id
     RETURNING event_id`,
    [draft.eventId, scope.ownerUserId, scope.campaignId, draft.source, sourceId, revision, ordinal, draft.occurredAt, JSON.stringify(draft)]
  );
  if (!result.rows[0]) throw new ActivityRepositoryError("invalid_snapshot");
  await client.query(`INSERT INTO campaign_activity_history(owner_user_id,campaign_id,captured_since) VALUES ($1,$2,$3)
    ON CONFLICT (owner_user_id,campaign_id) DO NOTHING`, [scope.ownerUserId, scope.campaignId, draft.occurredAt]);
  return result.rows[0].event_id;
}
export function createPostgresActivityRepository(pool: DatabasePool): ActivityReadRepository {
  return {
    async list(rawScope, rawQuery = {}) {
      const scope = activityScopeSchema.parse(rawScope);
      const query = activityPageQuerySchema.parse(rawQuery);
      const direction = query.after ? "after" : "before";
      const supplied = query.after ?? query.before;
      const cursor = supplied ? decodeCursor(supplied, scope, direction) : null;
      const client = await pool.connect();
      try {
        await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const campaign = await client.query("SELECT id FROM campaigns WHERE id=$1 AND owner_user_id=$2", [scope.campaignId, scope.ownerUserId]);
        if (!campaign.rowCount) throw new ActivityRepositoryError("not_found");
        const metadata = (await client.query<{ captured_since: Date; retention_floor_sequence: string; last_published_sequence: string }>(
          "SELECT captured_since,retention_floor_sequence::text,last_published_sequence::text FROM campaign_activity_history WHERE owner_user_id=$1 AND campaign_id=$2", [scope.ownerUserId, scope.campaignId])).rows[0];
        const high = metadata?.last_published_sequence ?? "0";
        const floor = metadata?.retention_floor_sequence ?? "0";
        const reset = Boolean(cursor && (BigInt(cursor.sequence) > BigInt(high) || (direction === "after" && BigInt(cursor.sequence) < BigInt(floor))));
        const coverageRow = (await client.query<{ oldest: string | null; pending: boolean; incomplete: boolean }>(
          `SELECT (SELECT min(sequence)::text FROM story_activity_events WHERE owner_user_id=$1 AND campaign_id=$2) AS oldest,
            EXISTS(SELECT 1 FROM activity_event_outbox WHERE owner_user_id=$1 AND campaign_id=$2 AND published_at IS NULL AND quarantine_code IS NULL) AS pending,
            EXISTS(SELECT 1 FROM activity_event_outbox WHERE owner_user_id=$1 AND campaign_id=$2 AND quarantine_code IS NOT NULL) AS incomplete`, [scope.ownerUserId, scope.campaignId])).rows[0]!;
        const rows = reset ? [] : (await client.query<{ event_id: string; sequence: string; published_at: Date; occurred_at: Date; source: string; kind: string; severity: string; job_id: string | null; generation_job_id: string | null; segment_id: string | null; turn_id: string | null; snapshot: unknown }>(
          `SELECT event_id,sequence::text,published_at,occurred_at,source,kind,severity,job_id,generation_job_id,segment_id,turn_id,snapshot FROM story_activity_events WHERE owner_user_id=$1 AND campaign_id=$2
           ${cursor ? `AND sequence ${direction === "after" ? ">" : "<"} $3::bigint` : ""}
           ORDER BY story_activity_events.sequence ${direction === "after" ? "ASC" : "DESC"} LIMIT $${cursor ? 4 : 3}`, cursor ? [scope.ownerUserId, scope.campaignId, cursor.sequence, query.limit + 1] : [scope.ownerUserId, scope.campaignId, query.limit + 1])).rows;
        const events = rows.slice(0, query.limit).map(row => {
          const draft = activityEventDraftSchema.safeParse(row.snapshot);
          if (!draft.success || draft.data.eventId !== row.event_id || draft.data.campaignId !== scope.campaignId
            || draft.data.source !== row.source || draft.data.kind !== row.kind || draft.data.severity !== row.severity
            || draft.data.jobId !== row.job_id || draft.data.generationJobId !== row.generation_job_id
            || draft.data.segmentId !== row.segment_id || draft.data.turnId !== row.turn_id
            || Date.parse(draft.data.occurredAt) !== row.occurred_at.getTime()) throw new ActivityRepositoryError("invalid_snapshot");
          const event = activityEventSchema.safeParse({ ...draft.data, sequence: row.sequence, publishedAt: row.published_at.toISOString() });
          if (!event.success) throw new ActivityRepositoryError("invalid_snapshot");
          return event.data;
        });
        const last = events.at(-1)?.sequence;
        const nextAfter = direction === "after" ? last ?? cursor?.sequence ?? high : events[0]?.sequence ?? high;
        const page = activityPageSchema.parse({ version: 1, events,
          nextBefore: last ? encodeActivityCursor(scope.campaignId, "before", direction === "after" ? events[0]!.sequence : last) : null,
          nextAfter: encodeActivityCursor(scope.campaignId, "after", nextAfter), hasMore: rows.length > query.limit,
          coverage: { capturedSince: metadata?.captured_since.toISOString() ?? null, retentionDays: 30, oldestAvailableSequence: coverageRow.oldest, latestPublishedSequence: high, pendingPublication: coverageRow.pending, incomplete: coverageRow.incomplete, resetRequired: reset } });
        await client.query("COMMIT");
        return page;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
  };
}
