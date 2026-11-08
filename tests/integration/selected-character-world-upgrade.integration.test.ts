import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { createDatabasePool, initialOwnerId } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";

it("keeps pre-0131 protagonist origin unknown even when old audit resembles native creation", async () => {
  const pool = createDatabasePool(process.env.TEST_DATABASE_URL!);
  const directory = await mkdtemp(join(tmpdir(), "iq-pre-0131-"));
  try {
    for (const file of await readdir(resolve("database/migrations"))) if (file < "0131_") await copyFile(resolve("database/migrations", file), join(directory, file));
    await migrateDatabase(pool, directory);
    const owner = await initialOwnerId(pool), world = randomUUID(), version = randomUUID(), native = randomUUID(), legacy = randomUUID();
    await pool.query("INSERT INTO worlds(id,owner_user_id,title) VALUES($1,$2,'Old world')", [world, owner]);
    await pool.query("INSERT INTO world_versions(id,world_id,owner_user_id,version_number,content) VALUES($1,$2,$3,1,'{}')", [version, world, owner]);
    await pool.query("INSERT INTO campaigns(id,owner_user_id,world_version_id,title,selected_character_id) VALUES($1,$3,$4,'Native','hero'),($2,$3,$4,'Legacy','hero')", [native, legacy, owner, version]);
    await pool.query("INSERT INTO campaign_character_profile_edits(owner_user_id,campaign_id,revision,next_profile,edit_source) VALUES($1,$2,1,$3,'world_version_seed')", [owner, native, { name: "Hero", profile: {} }]);
    await migrateDatabase(pool, resolve("database/migrations"));
    const rows = (await pool.query("SELECT id,selected_character_world_id FROM campaigns WHERE id=ANY($1::uuid[])", [[native, legacy]])).rows;
    expect(rows.find(row => row.id === native)?.selected_character_world_id).toBeNull();
    expect(rows.find(row => row.id === legacy)?.selected_character_world_id).toBeNull();
  } finally { await pool.end(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);
