import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { importLegacyStory } from "../helpers/memory-aware-services.js";
import { apiProviderGraph } from "../helpers/provider-application-fixtures.js";
import { inertStorageServerOptions } from "../helpers/build-server-options.js";
import { buildServer } from "../../services/api/src/server.js";
import { createApiWorldCampaignApplication } from "../../services/runtime/src/world-campaign-composition.js";
import { bootstrap } from "../helpers/instance-settings-runtime.js";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("campaign Settings authority", () => {
  let pool: DatabasePool;
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    pool = createDatabasePool(url!,4);
    await migrateDatabase(pool,resolve("database/migrations"));
    const providers = apiProviderGraph(pool,"campaign-settings-fixture-secret");
    app = await buildServer(inertStorageServerOptions({pool, worldCampaign:createApiWorldCampaignApplication(pool,providers),
      config:{...bootstrap(),role:"api",databaseUrl:url!,storyMemoryCapability:"r1",storyMemoryEnforceEnabled:false}}));
  });
  afterAll(async () => {await app?.close();await pool?.end();});
  it("updates one campaign, enforces server limits, and preserves the profile, other campaigns and immutable world", async () => {
    const a = await initialOwnerId(pool);
    const make = async () => {
      const story = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"),"utf8"));
      story.world.title = "Campaign Settings " + crypto.randomUUID();
      return importLegacyStory(pool,storyImportRequestSchema.parse({sourceName:"fixture.story",story}));
    };
    const first = await make();
    const second = await make();
    const b = (await pool.query("INSERT INTO users(display_name) VALUES('Other reader') RETURNING id")).rows[0].id;
    const world = (await pool.query("INSERT INTO worlds(owner_user_id,title) VALUES($1,'Other world') RETURNING id",[b])).rows[0].id;
    const version = (await pool.query("INSERT INTO world_versions(world_id,owner_user_id,version_number,content) VALUES($1,$2,1,'{}') RETURNING id",[world,b])).rows[0].id;
    const foreign = (await pool.query("INSERT INTO campaigns(owner_user_id,world_version_id,title) VALUES($1,$2,'Other story') RETURNING id",[b,version])).rows[0].id;
    const snapshot = async () => (await pool.query(
      `SELECT (SELECT settings FROM users WHERE id=$1) AS profile,
              (SELECT to_jsonb(c) FROM campaigns c WHERE c.id=$2) AS sibling,
              (SELECT to_jsonb(c) FROM campaigns c WHERE c.id=$3) AS foreign_campaign,
              (SELECT to_jsonb(v) FROM world_versions v JOIN campaigns c ON c.world_version_id=v.id WHERE c.id=$4) AS world,
              (SELECT count(*)::int FROM turns WHERE campaign_id=$4) AS accepted_turns,
              (SELECT count(*)::int FROM instance_settings_revisions) AS instance_revisions`,
      [a,second.campaignId,foreign,first.campaignId])).rows[0];
    const before = await snapshot();
    const path = "/api/v1/campaigns/"+first.campaignId;
    const save = await app.inject({method:"PATCH",url:path,payload:{storyContextBudgetTokens:128000}});
    expect(save.statusCode,save.body).toBe(200);
    expect((await pool.query("SELECT story_context_budget_tokens FROM campaigns WHERE id=$1",[first.campaignId])).rows[0].story_context_budget_tokens).toBe(128000);
    const bad = await app.inject({method:"PATCH",url:path,payload:{storyContextBudgetTokens:123}});
    expect(bad.statusCode).toBe(400);
    const unsupported = await app.inject({method:"PUT",url:path+"/story-memory",payload:{level:"max",continuityReviewEnabled:true}});
    expect(unsupported.statusCode).toBeGreaterThanOrEqual(400);
    const denied = await app.inject({method:"PATCH",url:"/api/v1/campaigns/"+foreign,headers:{"x-owner-user-id":b},payload:{storyLengthProfile:"extended"}});
    expect(denied.statusCode).toBe(404);
    const deniedMemory = await app.inject({method:"PUT",url:"/api/v1/campaigns/"+foreign+"/story-memory",payload:{level:"off"}});
    expect(deniedMemory.statusCode).toBe(404);
    expect(await snapshot()).toEqual(before);
  });
});
