import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerActivityRoutes } from "../../services/api/src/activity-routes.js";
import { createActivityComposition } from "../../services/runtime/src/activity-composition.js";
import { captureActivity, encodeActivityCursor } from "../../packages/database/src/activity-repository.js";
import { createPostgresActivityMaintenanceRepository } from "../../packages/database/src/activity-maintenance-repository.js";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { dropTestDatabaseWhenIdle } from "./database-test-helpers.js";
const databaseUrl = process.env.TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("activity API PostgreSQL", () => {
  let admin: DatabasePool, pool: DatabasePool, app: FastifyInstance;
  let ownerUserId: string, campaignId: string, foreignCampaign: string;
  const databaseName = `activity_api_${randomUUID().replaceAll("-", "")}`;
  async function campaign(owner: string) {
    const world = (await pool.query("INSERT INTO worlds(owner_user_id,title) VALUES ($1,'API test') RETURNING id", [owner])).rows[0].id;
    const version = (await pool.query("INSERT INTO world_versions(world_id,owner_user_id,version_number,content) VALUES ($1,$2,1,'{}') RETURNING id", [world,owner])).rows[0].id;
    return (await pool.query("INSERT INTO campaigns(owner_user_id,world_version_id,title) VALUES ($1,$2,'API test') RETURNING id", [owner,version])).rows[0].id as string;
  }
  beforeAll(async () => {
    admin = createDatabasePool(databaseUrl!); await admin.query(`CREATE DATABASE ${databaseName}`);
    const url = new URL(databaseUrl!); url.pathname = `/${databaseName}`; pool = createDatabasePool(url.toString());
    await migrateDatabase(pool, resolve("database/migrations")); ownerUserId = await initialOwnerId(pool);
    campaignId = await campaign(ownerUserId);
    const foreign = (await pool.query("INSERT INTO users(display_name) VALUES ('Other') RETURNING id")).rows[0].id;
    foreignCampaign = await campaign(foreign);
    await withTransaction(pool, async client => {
      for (let i = 0; i < 3; i++) {
        const jobId = randomUUID();
        await captureActivity(client, { scope: { ownerUserId, campaignId }, sourceId:jobId, revision:"1", draft:{ version:1,eventId:randomUUID(),occurredAt:"2026-10-03T12:00:00Z",campaignId,source:"generation",kind:"generation.queued",severity:"info",status:"queued",jobId,generationJobId:null,segmentId:null,turnId:null,turnNumber:null,attemptNumber:null,diagnostic:null } });
      }
    });
    await createPostgresActivityMaintenanceRepository(pool).publishBatch(100);
    app = Fastify(); await app.register(registerActivityRoutes, { activityReader:createActivityComposition(pool).reader, resolveOwner:async () => ({ ownerUserId }) });
  });
  afterAll(async () => { if (app) await app.close(); if (pool) await pool.end(); if (admin) { await dropTestDatabaseWhenIdle(admin,databaseName); await admin.end(); } });
  const read = (query = "", id = campaignId) => app.inject(`/api/v1/campaigns/${id}/activity${query}`);
  it("reads initial/before/after and never writes", async () => {
    const initial = (await read("?limit=2")).json(); expect(initial.events).toHaveLength(2);
    const before = (await read(`?limit=2&before=${initial.nextBefore}`)).json(); expect(before.events).toHaveLength(1);
    const after = (await read(`?limit=2&after=${encodeActivityCursor(campaignId,"after",before.events[0].sequence)}`)).json(); expect(after.events).toHaveLength(2);
    expect(BigInt(after.events[0].sequence)).toBeLessThan(BigInt(after.events[1].sequence));
    expect((await pool.query("SELECT count(*) FROM story_activity_events")).rows[0].count).toBe("3");
    expect(JSON.stringify(initial)).not.toContain("ownerUserId");
  });
  it("returns indistinguishable not found for missing and foreign campaigns", async () => {
    for (const id of [randomUUID(),foreignCampaign]) { const response = await read("",id); expect(response.statusCode).toBe(404); expect(response.json().code).toBe("activity_not_found"); }
    const spoof = await app.inject({ url:`/api/v1/campaigns/${foreignCampaign}/activity`, headers:{ "x-owner-user-id":ownerUserId } }); expect(spoof.statusCode).toBe(404);
  });
  it("rejects malformed, oversized, conflicting, wrong-direction and wrong-campaign cursors", async () => {
    for (const query of ["?after=malformed", `?after=${"a".repeat(513)}`, "?before=a&after=b", `?after=${encodeActivityCursor(campaignId,"before","1")}`, `?after=${encodeActivityCursor(foreignCampaign,"after","1")}`, "?limit=201", "?ownerUserId=spoof"]) {
      const response = await read(query); expect(response.statusCode).toBe(400); expect(response.json().correlationId).toBeTruthy(); expect(response.json().issues).toBeUndefined();
    }
  });
});
