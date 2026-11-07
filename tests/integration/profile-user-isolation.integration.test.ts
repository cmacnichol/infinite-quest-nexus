import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createPromptRepository } from "../../packages/database/src/prompt-repository.js";
import { createPostgresProviderRepositories } from "../../packages/database/src/provider-repository.js";
import { createSettingsOperatorRepository } from "../../packages/database/src/settings-operator-repository.js";
import { createSettingsOperatorSessions } from "../../services/api/src/settings-operator-session.js";
import { buildServer } from "../../services/api/src/server.js";
import { inertStorageServerOptions } from "../helpers/build-server-options.js";
import { apiProviderGraph } from "../helpers/provider-application-fixtures.js";
import { createProviderApplicationAdapter } from "../../services/api/src/provider-application-adapter.js";
import { bootstrap } from "../helpers/instance-settings-runtime.js";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("server-resolved profile and Settings ownership", () => {
  let pool: DatabasePool;
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    pool = createDatabasePool(url!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    app = await buildServer(inertStorageServerOptions({ pool, providers: createProviderApplicationAdapter(apiProviderGraph(pool,"test-profile-isolation-key".repeat(2))), config: {...bootstrap(), role: "api", databaseUrl: url!} }));
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });
  it("ignores spoofed owner claims, protects foreign profiles and campaign prompts and creates no installation revision", async () => {
    const a = await initialOwnerId(pool);
    const b = (await pool.query("INSERT INTO users(display_name) VALUES('Second reader') RETURNING id")).rows[0].id;
    const version = (await pool.query("INSERT INTO worlds(owner_user_id,title) VALUES($1,'Foreign world') RETURNING id", [b])).rows[0].id;
    const worldVersion = (await pool.query("INSERT INTO world_versions(world_id,owner_user_id,version_number,content) VALUES($1,$2,1,'{}') RETURNING id",[version,b])).rows[0].id;
    const campaign = (await pool.query("INSERT INTO campaigns(owner_user_id,world_version_id,title) VALUES($1,$2,'Foreign campaign') RETURNING id",[b,worldVersion])).rows[0].id;
    const revisions = () => pool.query("SELECT count(*)::int AS count FROM instance_settings_revisions").then(result => result.rows[0].count);
    const before = await revisions();
    const impersonate = {"x-owner-user-id": b};
    const saved = await app.inject({method:"PATCH", url:"/api/v1/users/me/profile", headers:impersonate, payload:{id:b,ownerUserId:b,displayName:"First reader"}});
    expect(saved.statusCode).toBe(200);
    expect(saved.json().user).toMatchObject({id:a,displayName:"First reader"});
    expect((await pool.query("SELECT display_name FROM users WHERE id=$1",[b])).rows[0].display_name).toBe("Second reader");
    const provider = await app.inject({method:"POST",url:"/api/v1/providers",headers:impersonate,payload:{name:"First reader text",providerType:"openai_compatible",providerRole:"text",baseUrl:"https://fixture.invalid",defaultModel:"fixture",apiKey:"synthetic-provider-key",enabled:false}});
    expect(provider.statusCode).toBeLessThan(300);
    expect(provider.json()).not.toHaveProperty("apiKey");
    expect(provider.json().hasApiKey).toBe(true);
    const fingerprint = async () => (await pool.query(
      "SELECT md5(encrypted_api_key || credential_nonce || credential_auth_tag) AS fingerprint FROM provider_profiles WHERE id=$1 AND owner_user_id=$2",
      [provider.json().id, a]
    )).rows[0].fingerprint;
    const encryptedBefore = await fingerprint();
    expect(encryptedBefore).toEqual(expect.any(String));
    const updated = await app.inject({method:"PATCH",url:`/api/v1/providers/${provider.json().id}`, payload:{name:"Edited text"}});
    expect(updated.statusCode).toBe(200);
    expect(updated.json().hasApiKey).toBe(true);
    expect(JSON.stringify(updated.json())).not.toContain("synthetic-provider-key");
    expect(await fingerprint()).toBe(encryptedBefore);
    const moved = await app.inject({method:"PATCH",url:`/api/v1/providers/${provider.json().id}`, payload:{baseUrl:"https://second-fixture.invalid",apiKey:"   "}});
    expect(moved.statusCode).toBe(400);
    expect(await fingerprint()).toBe(encryptedBefore);
    const replaced = await app.inject({method:"PATCH",url:`/api/v1/providers/${provider.json().id}`, payload:{baseUrl:"https://second-fixture.invalid",apiKey:"second-synthetic-credential"}});
    expect(replaced.statusCode).toBe(200);
    expect(await fingerprint()).not.toBe(encryptedBefore);
    const scoped = await pool.connect();
    try {
      expect(await createPostgresProviderRepositories(scoped).profiles.listProfiles({ownerUserId:b})).toEqual([]);
      const edit = await app.inject({method:"PUT",url:"/api/v1/prompt-library/overrides",headers:impersonate,payload:{key:"story_system",scope:"application",content:"First reader prompt."}});
      expect(edit.statusCode).toBe(200);
      const library = await createPromptRepository(scoped).listPromptLibrary({ownerUserId:b,scope:"application"});
      expect(library.templates.find(t => t.key === "story_system")?.effectiveSource).toBe("shipped");
      const foreign = await app.inject({method:"PUT",url:"/api/v1/prompt-library/overrides",headers:impersonate,payload:{key:"story_system",scope:"campaign",campaignId:campaign,content:"Foreign edit."}});
      expect(foreign.statusCode).toBe(404);
    } finally { scoped.release(); }
    const key = "settings-isolation-test-".repeat(3);
    const sessions = createSettingsOperatorSessions(createSettingsOperatorRepository(pool), () => key);
    const session = await sessions.unlock(key, a, "reader-isolation");
    await expect(sessions.authorize(session.token,b)).rejects.toThrow();
    expect(await revisions()).toBe(before);
  });
});
