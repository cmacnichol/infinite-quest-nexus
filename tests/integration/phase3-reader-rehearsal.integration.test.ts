import { historicalMigrations } from "../fixtures/historical-migrations.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, withTransaction } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { worldContentSchema } from "../../packages/contracts/src/world-library.js";
import { instanceSettingsSchema } from "../../packages/contracts/src/instance-settings.js";
import { createPostgresCampaignCastRepository } from "../../packages/database/src/campaign-cast-repository.js";
import { exportCampaignCast } from "../../packages/database/src/campaign-cast-portability.js";
import { exportSettingsSeed } from "../../services/runtime/src/settings-operator.js";
import { bootstrap } from "../helpers/instance-settings-runtime.js";

const baseline = process.env.IQ_PHASE3_BASELINE;
it.runIf(Boolean(baseline))("restores pre-boundary database copies and detects old reader incompatibilities", async () => {
  const oldSettings = await import(`${baseline}/packages/contracts/src/instance-settings.ts`);
  const oldWorld = await import(`${baseline}/packages/contracts/src/world-library.ts`);
  const oldCharacters = await import(`${baseline}/packages/domain/src/world-characters.ts`);
  const oldCast = await import(`${baseline}/packages/contracts/src/campaign-cast.ts`);
  const admin = createDatabasePool(process.env.TEST_DATABASE_URL!, 2);
  const suffix = randomUUID().replaceAll("-", ""), templateName = `phase3_base_${suffix}`;
  const names = [templateName, ...["settings", "roster", "cast"].map(part => `phase3_${part}_${suffix}`)];
  const connection = (name: string) => { const url = new URL(process.env.TEST_DATABASE_URL!); url.pathname = `/${name}`; return url.toString(); };
  const worldId = randomUUID(), versionId = randomUUID(), campaignId = randomUUID();
  const oldSeed = { ...exportSettingsSeed(bootstrap()).snapshot } as Record<string, unknown>;
  delete oldSeed.castLifecycleEnabled; delete oldSeed.castPresetsEnabled; delete oldSeed.castContextWithoutDiscoveryEnabled;
  let ownerUserId = "";
  try {
    await admin.query(`CREATE DATABASE ${templateName}`);
    const template = createDatabasePool(connection(templateName));
    try {
      await migrateDatabase(template, `${baseline}/database/migrations`);
      ownerUserId = await initialOwnerId(template);
      const content = { world: { title: "Reader rehearsal" }, playableCharacters: [{ id: "hero", name: "Hero", characterText: "A guide" }] };
      await template.query("INSERT INTO worlds(id,owner_user_id,title) VALUES($1,$2,'Reader rehearsal')", [worldId, ownerUserId]);
      await template.query("INSERT INTO world_versions(id,world_id,owner_user_id,version_number,content) VALUES($1,$2,$3,1,$4)", [versionId, worldId, ownerUserId, content]);
      await template.query("INSERT INTO campaigns(id,owner_user_id,world_version_id,title) VALUES($1,$2,$3,'Reader rehearsal')", [campaignId, ownerUserId, versionId]);
      await template.query("INSERT INTO instance_settings_revisions(revision,snapshot,schema_version,actor_user_id,cli_reference,kind,policy_digest) VALUES(1,$1,1,$2,'rehearsal','seed',$3)", [oldSeed, ownerUserId, "a".repeat(64)]);
      expect(oldCharacters.resolvePlayableCharacters(oldWorld.worldContentSchema.parse(content))).toHaveLength(1);
    } finally { await template.end(); }
    for (const name of names.slice(1)) await admin.query(`CREATE DATABASE ${name} TEMPLATE ${templateName}`);
    const pools = names.slice(1).map(name => createDatabasePool(connection(name)));
    try {
      for (const pool of pools) {
        await migrateDatabase(pool, historicalMigrations);
        await migrateDatabase(pool, resolve("database/migrations"));
      }
      const restoredSeed = (await pools[0]!.query("SELECT snapshot FROM instance_settings_revisions WHERE revision=1")).rows[0].snapshot;
      expect(oldSettings.instanceSettingsSchema.safeParse(restoredSeed).success).toBe(true);
      const newSeed = instanceSettingsSchema.parse({ ...oldSeed, castLifecycleEnabled: false, castPresetsEnabled: true, castContextWithoutDiscoveryEnabled: false });
      await pools[0]!.query("INSERT INTO instance_settings_revisions(revision,previous_revision,snapshot,schema_version,actor_user_id,cli_reference,kind,policy_digest) VALUES(2,1,$1,1,$2,'rehearsal','proposal',$3)", [newSeed, ownerUserId, "a".repeat(64)]);
      const savedSeed = (await pools[0]!.query("SELECT snapshot FROM instance_settings_revisions WHERE revision=2")).rows[0].snapshot;
      expect(oldSettings.instanceSettingsSchema.safeParse(savedSeed).success).toBe(false);
      const roster = worldContentSchema.parse({ world: { title: "Reader rehearsal" }, playableCharacters: [
        { id: "hero", name: "Hero", characterText: "A guide" }, { id: "npc", name: "NPC", characterText: "", campaignUse: "supporting" }
      ] });
      const mixedVersionId = randomUUID();
      await pools[1]!.query("INSERT INTO world_versions(id,world_id,owner_user_id,version_number,content) VALUES($1,$2,$3,2,$4)", [mixedVersionId, worldId, ownerUserId, roster]);
      const published = (await pools[1]!.query("SELECT content FROM world_versions WHERE id=$1", [mixedVersionId])).rows[0].content;
      expect(oldCharacters.resolvePlayableCharacters(oldWorld.worldContentSchema.parse(published))).toHaveLength(2);
      const repo = createPostgresCampaignCastRepository(pools[2]!, { editingEnabled: true }), scope = { ownerUserId, campaignId };
      await repo.create(scope, { expectedCastRevision: 0, expectedBoundary: { turnNumber: 0, timelineRevision: 0 }, idempotencyKey: "v3-rehearsal", name: "Mara", aliases: [], profile: { "story.goals": "g".repeat(2001) } });
      const cast = await withTransaction(pools[2]!, client => exportCampaignCast(client, scope));
      expect(cast?.formatVersion).toBe(3);
      expect(oldCast.portableCampaignCastSchema.safeParse(cast).success).toBe(false);
      expect((await pools[2]!.query("SELECT first_appearance_eligible FROM campaigns WHERE id=$1", [campaignId])).rows[0].first_appearance_eligible).toBe(false);
    } finally { await Promise.all(pools.map(pool => pool.end())); }
  } finally {
    for (const name of names.reverse()) await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  }
}, 120_000);
