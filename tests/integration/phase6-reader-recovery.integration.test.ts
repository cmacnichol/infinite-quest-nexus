import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, withTransaction } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createPostgresCampaignCastRepository } from "../../packages/database/src/campaign-cast-repository.js";
import { exportCampaignCast } from "../../packages/database/src/campaign-cast-portability.js";

const baseline = process.env.IQ_PHASE6_BASELINE;
it.runIf(Boolean(baseline))("restores a pre-v4 database copy with the old reader and accounts for later lifecycle writes", async () => {
  const oldCast = await import(`${baseline}/packages/contracts/src/campaign-cast.ts`);
  const oldRepository = await import(`${baseline}/packages/database/src/campaign-cast-repository.ts`);
  const admin = createDatabasePool(process.env.TEST_DATABASE_URL!, 2), suffix = randomUUID().replaceAll("-", "");
  const sourceName = `phase6_source_${suffix}`, backupName = `phase6_backup_${suffix}`, restoredName = `phase6_restore_${suffix}`;
  const connection = (name: string) => { const url = new URL(process.env.TEST_DATABASE_URL!); url.pathname = `/${name}`; return url.toString(); };
  const world = randomUUID(), version = randomUUID(), campaignId = randomUUID();
  try {
    await admin.query(`CREATE DATABASE ${sourceName}`);
    let source = createDatabasePool(connection(sourceName));
    let ownerUserId = "", characterId = "";
    try {
      await migrateDatabase(source, `${baseline}/database/migrations`);
      ownerUserId = await initialOwnerId(source);
      await source.query("INSERT INTO worlds(id,owner_user_id,title) VALUES($1,$2,'Recovery')", [world, ownerUserId]);
      await source.query("INSERT INTO world_versions(id,world_id,owner_user_id,version_number,content) VALUES($1,$2,$3,1,$4)", [version, world, ownerUserId, { world: { title: "Recovery" } }]);
      await source.query("INSERT INTO campaigns(id,owner_user_id,world_version_id,title) VALUES($1,$2,$3,'Recovery')", [campaignId, ownerUserId, version]);
      const oldRepo = oldRepository.createPostgresCampaignCastRepository(source, { editingEnabled: true });
      const created = await oldRepo.create({ ownerUserId, campaignId }, { expectedCastRevision: 0, expectedBoundary: { turnNumber: 0, timelineRevision: 0 }, idempotencyKey: "before", name: "Mara", aliases: [], profile: {} });
      characterId = created.character.id;
    } finally { await source.end(); }
    // PostgreSQL's template copy is the isolated recovery set, captured before any v4 write.
    await admin.query(`CREATE DATABASE ${backupName} TEMPLATE ${sourceName}`);
    source = createDatabasePool(connection(sourceName));
    try {
      await migrateDatabase(source, resolve("database/migrations"));
      const scope = { ownerUserId, campaignId }, repo = createPostgresCampaignCastRepository(source, { editingEnabled: true, lifecycleEnabled: true });
      const before = await repo.current(scope), person = before.characters.find(item => item.id === characterId)!;
      await repo.changeRemoval!(scope, characterId, "remove", { expectedCastRevision: before.revision, expectedBoundary: before.boundary, expectedCharacterRevision: person.revision, idempotencyKey: "after" });
      const after = await withTransaction(source, client => exportCampaignCast(client, scope));
      expect(after?.formatVersion).toBe(4);
      expect(oldCast.portableCampaignCastSchema.safeParse(after).success).toBe(false);
      expect((await source.query("SELECT count(*)::int AS n FROM campaign_cast_events WHERE campaign_id=$1", [campaignId])).rows[0].n).toBe(2);
    } finally { await source.end(); }
    await admin.query(`CREATE DATABASE ${restoredName} TEMPLATE ${backupName}`);
    const restored = createDatabasePool(connection(restoredName));
    try {
      const oldRepo = oldRepository.createPostgresCampaignCastRepository(restored, { editingEnabled: true });
      const state = await oldRepo.current({ ownerUserId, campaignId });
      expect(state.characters.find((person: { id: string }) => person.id === characterId)).toMatchObject({ name: "Mara" });
      expect((await restored.query("SELECT count(*)::int AS n FROM campaign_cast_events WHERE campaign_id=$1", [campaignId])).rows[0].n).toBe(1);
      const saved = await withTransaction(restored, client => exportCampaignCast(client, { ownerUserId, campaignId }));
      expect(oldCast.portableCampaignCastSchema.safeParse(saved).success).toBe(true);
    } finally { await restored.end(); }
  } finally {
    for (const name of [restoredName, backupName, sourceName]) await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  }
}, 120_000);
