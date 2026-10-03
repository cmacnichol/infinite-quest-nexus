import { ACTIVITY_PUBLICATION_LOCK, createPostgresActivityMaintenanceRepository } from "../../packages/database/src/activity-maintenance-repository.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureActivity, createPostgresActivityRepository, encodeActivityCursor } from "../../packages/database/src/activity-repository.js";
import { createDatabasePool, withTransaction, type DatabasePool, type DatabaseClient } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { dropTestDatabaseWhenIdle } from "./database-test-helpers.js";
import type { ActivityEventDraft, ActivityScope } from "../../packages/contracts/src/activity.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
integration("durable activity publication", () => {
  let admin: DatabasePool;
  let pool: DatabasePool;
  let scope: ActivityScope;
  let foreignOwner: string;
  const databaseName = `activity_${randomUUID().replaceAll("-", "")}`;
  function draft(campaignId = scope.campaignId): ActivityEventDraft {
    return { version: 1, eventId: randomUUID(), occurredAt: "2026-10-03T12:00:00.000Z", campaignId,
      source: "generation", kind: "generation.queued", severity: "info", status: "queued",
      jobId: randomUUID(), generationJobId: null, segmentId: null, turnId: null, turnNumber: null, attemptNumber: null, diagnostic: null };
  }
  async function campaign(ownerUserId = scope.ownerUserId) {
    const world = (await pool.query<{ id: string }>("INSERT INTO worlds(owner_user_id,title) VALUES ($1,'Activity test') RETURNING id", [ownerUserId])).rows[0]!;
    const version = (await pool.query<{ id: string }>("INSERT INTO world_versions(world_id,owner_user_id,version_number,content) VALUES ($1,$2,1,'{}') RETURNING id", [world.id, ownerUserId])).rows[0]!;
    return (await pool.query<{ id: string }>("INSERT INTO campaigns(owner_user_id,world_version_id,title) VALUES ($1,$2,'Activity test') RETURNING id", [ownerUserId, version.id])).rows[0]!.id;
  }
  beforeAll(async () => {
    admin = createDatabasePool(databaseUrl!, 2);
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const url = new URL(databaseUrl!); url.pathname = `/${databaseName}`;
    pool = createDatabasePool(url.toString(), 3);
    await migrateDatabase(pool, resolve("database/migrations"));
    const ownerUserId = (await pool.query<{ id: string }>("SELECT id FROM users WHERE system_key='initial-owner'")).rows[0]!.id;
    scope = { ownerUserId, campaignId: "" }; scope.campaignId = await campaign();
    foreignOwner = (await pool.query<{ id: string }>("INSERT INTO users(display_name) VALUES ('Foreign') RETURNING id")).rows[0]!.id;
  });
  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) { await dropTestDatabaseWhenIdle(admin, databaseName); await admin.end(); }
  });
  async function capture(value = draft()) {
    await withTransaction(pool, client => captureActivity(client, { scope, sourceId: value.jobId!, revision: "1", draft: value }));
    return value;
  }
  it("lateCommitCannotBeSkipped and contention allocates no sequence", async () => {
    const value = await capture();
    const first = await pool.connect();
    await first.query("BEGIN");
    await first.query("SELECT pg_advisory_xact_lock($1)", [ACTIVITY_PUBLICATION_LOCK]);
    const repository = createPostgresActivityMaintenanceRepository(pool);
    try {
      expect(await repository.publishBatch(100)).toEqual({ published: 0, quarantined: 0 });
      expect(await repository.pruneBatch(1000)).toBe(0);
    } finally { await first.query("ROLLBACK"); first.release(); }
    expect(await repository.publishBatch(1)).toEqual({ published: 1, quarantined: 0 });
    const initial = await createPostgresActivityRepository(pool).list(scope);
    expect(initial.events[0]!.eventId).toBe(value.eventId);
    const second = await capture();
    await repository.publishBatch(100);
    expect((await createPostgresActivityRepository(pool).list(scope, { after: initial.nextAfter })).events.map(event => event.eventId)).toEqual([second.eventId]);
  });
  it("actual paused publisher serializes allocations and reverse source commits remain readable", async () => {
    const value = await capture();
    let acquired!: () => void;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const intercepted = Object.create(pool) as DatabasePool;
    intercepted.connect = (async () => {
      const client = await pool.connect();
      const query = client.query.bind(client);
      const wrapped = Object.create(client);
      wrapped.query = async (...args: unknown[]) => {
        const result = await (query as (...args: unknown[]) => Promise<unknown>)(...args);
        if (typeof args[0] === "string" && args[0].includes("pg_try_advisory_xact_lock")) { acquired(); await gate; }
        return result;
      };
      wrapped.release = () => client.release();
      return wrapped;
    }) as DatabasePool["connect"];
    const first = createPostgresActivityMaintenanceRepository(intercepted).publishBatch(100);
    const repository = createPostgresActivityMaintenanceRepository(pool);
    try {
      await Promise.race([ready, first]);
      expect(await repository.publishBatch(100)).toEqual({ published: 0, quarantined: 0 });
    } finally { release(); await first; }
    const anchor = await createPostgresActivityRepository(pool).list(scope);
    expect(anchor.events[0]!.eventId).toBe(value.eventId);
    const a = await pool.connect();
    let b: DatabaseClient | undefined;
    try {
      b = await pool.connect();
      const early = draft(), late = draft();
      await a.query("BEGIN"); await b.query("BEGIN");
      // Existing campaign metadata avoids a first-capture metadata uniqueness wait.
      await captureActivity(a, { scope, sourceId: early.jobId!, revision: "1", draft: early });
      await captureActivity(b, { scope, sourceId: late.jobId!, revision: "1", draft: late });
      await b.query("COMMIT");
      await repository.publishBatch(100);
      const page = await createPostgresActivityRepository(pool).list(scope, { after: anchor.nextAfter });
      expect(page.events.map(event => event.eventId)).toEqual([late.eventId]);
      await a.query("COMMIT");
      await repository.publishBatch(100);
      expect((await createPostgresActivityRepository(pool).list(scope, { after: page.nextAfter })).events.map(event => event.eventId)).toEqual([early.eventId]);
    } finally {
      await Promise.allSettled([a.query("ROLLBACK"), b?.query("ROLLBACK")]);
      a.release();
      b?.release();
    }
  });  it("publisherCrashDoesNotLoseOrDuplicate and quarantine does not poison valid rows", async () => {
    const corrupt = await capture();
    await pool.query("UPDATE activity_event_outbox SET snapshot=snapshot || '{\"private\":\"CANARY\"}'::jsonb WHERE event_id=$1", [corrupt.eventId]);
    const valid = await capture();
    const repository = createPostgresActivityMaintenanceRepository(pool);
    await pool.query(`CREATE FUNCTION fail_activity_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected crash'; END $$`);
    await pool.query("CREATE TRIGGER fail_activity BEFORE INSERT ON story_activity_events FOR EACH ROW EXECUTE FUNCTION fail_activity_insert()");
    await expect(repository.publishBatch(100)).rejects.toThrow("injected crash");
    expect((await pool.query("SELECT published_at,quarantine_code FROM activity_event_outbox WHERE event_id=$1", [corrupt.eventId])).rows[0]).toEqual({ published_at: null, quarantine_code: null });
    await pool.query("DROP TRIGGER fail_activity ON story_activity_events");
    expect(await repository.publishBatch(100)).toEqual({ published: 1, quarantined: 1 });
    expect(await repository.publishBatch(100)).toEqual({ published: 0, quarantined: 0 });
    expect((await pool.query("SELECT event_id FROM story_activity_events WHERE event_id=$1", [valid.eventId])).rowCount).toBe(1);
    const page = await createPostgresActivityRepository(pool).list(scope);
    expect(page.coverage.incomplete).toBe(true);
    expect(page.coverage.pendingPublication).toBe(false);
  });
  it("retentionHonorsPublicationDate, pendingOutboxNeverExpires, receiptExpiresAfterSevenDays, emptyHistoryRetainsWatermark, staleCursorResets", async () => {
    const repository = createPostgresActivityMaintenanceRepository(pool);
    const oldOccurrence = await capture({ ...draft(), occurredAt: "2000-01-01T00:00:00.000Z" });
    await repository.publishBatch(100);
    const initial = await createPostgresActivityRepository(pool).list(scope);
    await repository.pruneBatch(1);
    expect((await pool.query("SELECT event_id FROM story_activity_events WHERE event_id=$1", [oldOccurrence.eventId])).rowCount).toBe(1);
    const pending = await capture();
    await pool.query("UPDATE activity_event_outbox SET occurred_at='2000-01-01' WHERE event_id=$1", [pending.eventId]);
    await pool.query("UPDATE story_activity_events SET published_at=now()-interval '30 days'");
    await pool.query("UPDATE activity_event_outbox SET published_at=now()-interval '7 days' WHERE published_at IS NOT NULL");
    for (let index=0; index<30; index++) expect(await repository.pruneBatch(1)).toBeLessThanOrEqual(1);
    expect((await pool.query("SELECT event_id FROM story_activity_events")).rowCount).toBe(0);
    expect((await pool.query("SELECT event_id FROM activity_event_outbox WHERE event_id=$1", [pending.eventId])).rowCount).toBe(1);
    expect((await pool.query("SELECT event_id FROM activity_event_outbox WHERE published_at IS NOT NULL")).rowCount).toBe(0);
    const empty = await createPostgresActivityRepository(pool).list(scope);
    expect(empty.coverage.latestPublishedSequence).toBe(initial.coverage.latestPublishedSequence);
    const stale = encodeActivityCursor(scope.campaignId, "after", "0");
    expect((await createPostgresActivityRepository(pool).list(scope, { after: stale })).coverage.resetRequired).toBe(true);
  });
  it("first and incremental pages use the scoped sequence index with representative data", async () => {
    const otherCampaign = await campaign();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO story_activity_events(event_id,owner_user_id,campaign_id,occurred_at,published_at,source,kind,severity,snapshot)
        SELECT gen_random_uuid(),$1,CASE WHEN n%100=0 THEN $2::uuid ELSE $3::uuid END,now(),now(),'generation','generation.queued','info','{}'::jsonb FROM generate_series(1,10000) n`, [scope.ownerUserId,scope.campaignId,otherCampaign]);
      await client.query("ANALYZE story_activity_events");
      for (const incremental of [false,true]) {
        const plan = (await client.query(`EXPLAIN (FORMAT JSON) SELECT sequence,snapshot FROM story_activity_events
          WHERE owner_user_id=$1 AND campaign_id=$2 ${incremental ? "AND sequence > 5000" : ""}
          ORDER BY sequence ${incremental ? "ASC" : "DESC"} LIMIT 101`, [scope.ownerUserId,scope.campaignId])).rows;
        expect(JSON.stringify(plan)).toContain("story_activity_scope_sequence");
      }
    } finally { await client.query("ROLLBACK"); client.release(); }
  });  it("expires the exact database-time boundary and retains events just inside it", async () => {
    const expired = await capture();
    const retained = await capture();
    await createPostgresActivityMaintenanceRepository(pool).publishBatch(100);
    const intercepted = Object.create(pool) as DatabasePool;
    intercepted.connect = (async () => {
      const client = await pool.connect();
      const query = client.query.bind(client);
      const wrapped = Object.create(client);
      wrapped.query = async (...args: unknown[]) => {
        const result = await (query as (...args: unknown[]) => Promise<unknown>)(...args);
        if (args[0] === "BEGIN") {
          await query("UPDATE story_activity_events SET published_at=now()-interval '30 days' WHERE event_id=$1", [expired.eventId]);
          await query("UPDATE story_activity_events SET published_at=now()-interval '30 days'+interval '1 millisecond' WHERE event_id=$1", [retained.eventId]);
        }
        return result;
      };
      wrapped.release = () => client.release();
      return wrapped;
    }) as DatabasePool["connect"];
    expect(await createPostgresActivityMaintenanceRepository(intercepted).pruneBatch(1000)).toBe(1);
    expect((await pool.query("SELECT event_id FROM story_activity_events WHERE event_id=$1", [expired.eventId])).rowCount).toBe(0);
    expect((await pool.query("SELECT event_id FROM story_activity_events WHERE event_id=$1", [retained.eventId])).rowCount).toBe(1);
  });});
