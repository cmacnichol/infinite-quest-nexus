import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureActivity, createPostgresActivityRepository, encodeActivityCursor } from "../../packages/database/src/activity-repository.js";
import { createDatabasePool, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { dropTestDatabaseWhenIdle } from "./database-test-helpers.js";
import type { ActivityEventDraft, ActivityScope } from "../../packages/contracts/src/activity.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
integration("scoped activity repository", () => {
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
  async function publish(scopeValue: ActivityScope, count: number, offset = 0n) {
    await withTransaction(pool, async client => {
      for (let index = 1; index <= count; index++) {
        const value = draft(scopeValue.campaignId);
        const sequence = String(offset + BigInt(index));
        await captureActivity(client, { scope: scopeValue, sourceId: value.jobId!, revision: "1", draft: value });
        await client.query(`INSERT INTO story_activity_events(event_id,sequence,owner_user_id,campaign_id,occurred_at,published_at,source,kind,severity,job_id,snapshot)
          VALUES ($1,$2,$3,$4,$5,now(),$6,$7,$8,$9,$10)`, [value.eventId,sequence,scopeValue.ownerUserId,scopeValue.campaignId,value.occurredAt,value.source,value.kind,value.severity,value.jobId,JSON.stringify(value)]);
        await client.query("UPDATE activity_event_outbox SET published_at=now() WHERE event_id=$1", [value.eventId]);
      }
      await client.query("UPDATE campaign_activity_history SET last_published_sequence=$3 WHERE owner_user_id=$1 AND campaign_id=$2", [scopeValue.ownerUserId, scopeValue.campaignId, String(offset + BigInt(count))]);
    });
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
  it("captureRollsBackWithMutation", async () => {
    const value = draft();
    await expect(withTransaction(pool, async client => {
      await client.query("UPDATE campaigns SET title='rolled back' WHERE id=$1", [scope.campaignId]);
      await captureActivity(client, { scope, sourceId: value.jobId!, revision: "1", draft: value });
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect((await pool.query("SELECT event_id FROM activity_event_outbox WHERE event_id=$1", [value.eventId])).rowCount).toBe(0);
    expect((await pool.query("SELECT title FROM campaigns WHERE id=$1", [scope.campaignId])).rows[0].title).toBe("Activity test");
    expect((await pool.query("SELECT * FROM campaign_activity_history WHERE campaign_id=$1", [scope.campaignId])).rowCount).toBe(0);
  });
  it("captureReplayReturnsSameId", async () => {
    const value = draft();
    const input = { scope, sourceId: value.jobId!, revision: "1", draft: value };
    const id = await withTransaction(pool, client => captureActivity(client, input));
    expect(await withTransaction(pool, client => captureActivity(client, { ...input, draft: { ...value, eventId: randomUUID() } }))).toBe(id);
    expect((await pool.query("SELECT * FROM activity_event_outbox WHERE source_id=$1", [value.jobId])).rowCount).toBe(1);
  });
  it("ownerCampaignConstraintRejectsMismatch", async () => {
    const value = draft();
    await expect(withTransaction(pool, client => captureActivity(client, { scope: { ...scope, ownerUserId: foreignOwner }, sourceId: value.jobId!, revision: "1", draft: value }))).rejects.toMatchObject({ code: "23503" });
    await expect(pool.query("INSERT INTO campaign_activity_history(owner_user_id,campaign_id,captured_since) VALUES ($1,$2,now())", [foreignOwner,scope.campaignId])).rejects.toMatchObject({ code: "23503" });
  });
  it("capture failure rolls back the authoritative mutation", async () => {
    const value = draft();
    await expect(withTransaction(pool, async client => {
      await client.query("UPDATE campaigns SET title='must rollback' WHERE id=$1", [scope.campaignId]);
      await captureActivity(client, { scope, sourceId: value.jobId!, revision: "1", draft: { ...value, diagnostic: { code: "request_failed", message: "PRIVATE CANARY" } } });
    })).rejects.toThrow();
    expect((await pool.query("SELECT title FROM campaigns WHERE id=$1", [scope.campaignId])).rows[0].title).toBe("Activity test");
  });
  it("deletedSourceKeepsHistory and existing private ledger stays separate", async () => {
    const local = { ...scope, campaignId: await campaign() };
    const profile = (await pool.query<{ id: string }>("INSERT INTO provider_profiles(owner_user_id,name,provider_type,base_url) VALUES ($1,'Activity fixture','openai_compatible','http://fixture.invalid') RETURNING id", [local.ownerUserId])).rows[0]!;
    const job = (await pool.query<{ id: string }>("INSERT INTO generation_jobs(owner_user_id,campaign_id,provider_profile_id,idempotency_key,expected_turn_number,action,status) VALUES ($1,$2,$3,'activity-source',1,'safe fixture','queued') RETURNING id", [local.ownerUserId,local.campaignId,profile.id])).rows[0]!;
    const value = { ...draft(local.campaignId), jobId: job.id };
    await withTransaction(pool, client => captureActivity(client, { scope: local, sourceId: job.id, revision: "1", draft: value }));
    await pool.query(`INSERT INTO story_activity_events(event_id,sequence,owner_user_id,campaign_id,occurred_at,published_at,source,kind,severity,job_id,snapshot)
      VALUES ($1,99,$2,$3,$4,now(),$5,$6,$7,$8,$9)`, [value.eventId,local.ownerUserId,local.campaignId,value.occurredAt,value.source,value.kind,value.severity,job.id,JSON.stringify(value)]);
    await pool.query("UPDATE activity_event_outbox SET published_at=now() WHERE event_id=$1", [value.eventId]);
    await pool.query("UPDATE campaign_activity_history SET last_published_sequence=99 WHERE campaign_id=$1", [local.campaignId]);
    await pool.query("DELETE FROM generation_jobs WHERE id=$1", [job.id]);
    expect((await pool.query("SELECT * FROM activity_event_outbox WHERE source_id=$1", [job.id])).rowCount).toBe(1);
    await pool.query("INSERT INTO activity_events(owner_user_id,campaign_id,event_type,details) VALUES ($1,$2,'legacy','{\"private\":\"CANARY\"}')", [local.ownerUserId,local.campaignId]);
    const page = await createPostgresActivityRepository(pool).list(local);
    expect(page.events.map(event => event.jobId)).toEqual([job.id]);
    expect(JSON.stringify(page)).not.toContain("CANARY");
    expect((await pool.query("SELECT details FROM activity_events WHERE campaign_id=$1", [local.campaignId])).rows[0].details).toEqual({ private: "CANARY" });
  });
  it("pagesHaveStableBoundaries and preserve bigint precision", async () => {
    const local = { ...scope, campaignId: await campaign() };
    const offset = 9007199254740992n;
    await publish(local, 205, offset);
    const repository = createPostgresActivityRepository(pool);
    const first = await repository.list(local);
    expect(first.events).toHaveLength(100); expect(first.hasMore).toBe(true);
    expect(first.events[0]!.sequence).toBe(String(offset + 205n));
    const second = await repository.list(local, { before: first.nextBefore });
    const third = await repository.list(local, { before: second.nextBefore });
    expect(third.events).toHaveLength(5); expect(third.hasMore).toBe(false);
    expect(new Set([...first.events,...second.events,...third.events].map(value => value.sequence)).size).toBe(205);
    const newer = await repository.list(local, { after: encodeActivityCursor(local.campaignId,"after",String(offset)), limit: 200 });
    expect(newer.events).toHaveLength(200); expect(newer.events[0]!.sequence).toBe(String(offset+1n)); expect(newer.hasMore).toBe(true);
    const tail = await repository.list(local, { after: newer.nextAfter }); expect(tail.events).toHaveLength(5);
    const empty = await repository.list(local, { after: tail.nextAfter }); expect(empty.nextAfter).toBe(tail.nextAfter); expect(empty.events).toEqual([]);
    await expect(repository.list(local, { after: first.nextBefore })).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(repository.list(local, { after: encodeActivityCursor(scope.campaignId,"after","1") })).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(repository.list({ ...local, ownerUserId: foreignOwner })).rejects.toMatchObject({ code: "not_found" });
    await expect(repository.list(local, { limit: 201 })).rejects.toThrow();
    await expect(repository.list(local, { before: first.nextBefore, after: first.nextAfter })).rejects.toThrow();
  });
  it("resets retention gaps and future cursors without losing high-water", async () => {
    const local = { ...scope, campaignId: await campaign() };
    await publish(local, 2, 100n);
    await pool.query("DELETE FROM story_activity_events WHERE campaign_id=$1", [local.campaignId]);
    await pool.query("UPDATE campaign_activity_history SET retention_floor_sequence=102 WHERE campaign_id=$1", [local.campaignId]);
    const repository = createPostgresActivityRepository(pool);
    for (const sequence of ["101","103"]) {
      const page = await repository.list(local,{ after: encodeActivityCursor(local.campaignId,"after",sequence) });
      expect(page.coverage.resetRequired).toBe(true); expect(page.events).toEqual([]); expect(page.coverage.latestPublishedSequence).toBe("102");
    }
    const first = await repository.list(local); expect(first.coverage.oldestAvailableSequence).toBeNull();
    expect(first.nextAfter).toBe(encodeActivityCursor(local.campaignId,"after","102"));
  });
  it("corrupt snapshots yield a controlled error and quarantines mark incomplete coverage", async () => {
    const local = { ...scope, campaignId: await campaign() };
    await publish(local,1,1000n);
    await pool.query("UPDATE story_activity_events SET snapshot=snapshot || '{\"private\":\"CANARY\"}' WHERE campaign_id=$1", [local.campaignId]);
    await expect(createPostgresActivityRepository(pool).list(local)).rejects.toMatchObject({ code: "invalid_snapshot", message: "invalid_snapshot" });
    await pool.query("UPDATE story_activity_events SET snapshot=snapshot - 'private', kind='image.queued' WHERE campaign_id=$1", [local.campaignId]);
    await expect(createPostgresActivityRepository(pool).list(local)).rejects.toMatchObject({ code: "invalid_snapshot" });
    await pool.query("DELETE FROM story_activity_events WHERE campaign_id=$1", [local.campaignId]);
    await pool.query("UPDATE activity_event_outbox SET published_at=NULL,quarantine_code='invalid_snapshot' WHERE campaign_id=$1", [local.campaignId]);
    const page = await createPostgresActivityRepository(pool).list(local); expect(page.coverage.incomplete).toBe(true); expect(page.coverage.pendingPublication).toBe(false);
  });
  it("page and coverage share one repeatable-read snapshot", async () => {
    const local = { ...scope, campaignId: await campaign() };
    await publish(local, 1, 3000n);
    const client = await pool.connect();
    const originalQuery = client.query.bind(client);
    let injected = false;
    client.query = (async (...args: unknown[]) => {
      const result = await (originalQuery as (...values: unknown[]) => Promise<unknown>)(...args);
      if (!injected && String(args[0]).includes("SELECT captured_since")) {
        injected = true;
        await publish(local, 1, 3001n);
      }
      return result;
    }) as typeof client.query;
    const proxy = { connect: async () => client } as DatabasePool;
    const page = await createPostgresActivityRepository(proxy).list(local);
    expect(injected).toBe(true);
    expect(page.events.map(event => event.sequence)).toEqual(["3001"]);
    expect(page.coverage.latestPublishedSequence).toBe("3001");
    const fresh = await createPostgresActivityRepository(pool).list(local);
    expect(fresh.events.map(event => event.sequence)).toEqual(["3002","3001"]);
    expect(fresh.coverage.latestPublishedSequence).toBe("3002");
  });
  it("database capture failure rolls back the mutation and rejects mismatched scopes", async () => {
    const value = draft();
    await expect(withTransaction(pool, async client => {
      await client.query("UPDATE campaigns SET title='must rollback database failure' WHERE id=$1", [scope.campaignId]);
      await captureActivity(client, { scope: { ...scope, ownerUserId: foreignOwner }, sourceId: value.jobId!, revision: "1", draft: value });
    })).rejects.toMatchObject({ code: "23503" });
    expect((await pool.query("SELECT title FROM campaigns WHERE id=$1", [scope.campaignId])).rows[0].title).toBe("Activity test");
    await expect(withTransaction(pool, client => captureActivity(client, { scope, sourceId: value.jobId!, revision: "-1", draft: value }))).rejects.toThrow();
    await expect(withTransaction(pool, client => captureActivity(client, { scope, sourceId: value.jobId!, revision: "1", draft: { ...value, campaignId: randomUUID() } }))).rejects.toMatchObject({ code: "invalid_snapshot" });
  });
  it("all storage tables constrain owner and campaign scope and public reads reject malformed cursors", async () => {
    const value = draft();
    await expect(pool.query(`INSERT INTO story_activity_events(event_id,owner_user_id,campaign_id,occurred_at,published_at,source,kind,severity,snapshot)
      VALUES ($1,$2,$3,now(),now(),'generation','generation.queued','info',$4)`, [value.eventId,foreignOwner,scope.campaignId,JSON.stringify(value)])).rejects.toMatchObject({ code: "23503" });
    const repository = createPostgresActivityRepository(pool);
    for (const after of ["!", Buffer.from(JSON.stringify({version:1,campaignId:scope.campaignId,direction:"after",sequence:"9223372036854775808"})).toString("base64url"), "x".repeat(513)]) {
      await expect(repository.list(scope, { after })).rejects.toThrow();
    }
  });
  it("deletedCampaignCascadesHistory", async () => {
    const local = { ...scope, campaignId: await campaign() };
    await publish(local,1,2000n);
    await pool.query("DELETE FROM campaigns WHERE id=$1", [local.campaignId]);
    for (const table of ["activity_event_outbox","story_activity_events","campaign_activity_history"]) {
      expect((await pool.query(`SELECT * FROM ${table} WHERE campaign_id=$1`, [local.campaignId])).rowCount).toBe(0);
    }
    await expect(createPostgresActivityRepository(pool).list(local)).rejects.toMatchObject({ code: "not_found" });
  });
});
