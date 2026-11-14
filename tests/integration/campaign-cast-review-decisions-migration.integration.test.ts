import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration("cast review decision migration", () => {
  let pool: DatabasePool, dir: string, owner: string;
  beforeAll(async () => {
    pool = createDatabasePool(process.env.TEST_DATABASE_URL!, 4);
    dir = await mkdtemp(join(tmpdir(), "cast-review-migration-"));
    await copyFile(resolve("database/migrations/0133_baseline.sql"), join(dir, "0133_baseline.sql"));
    expect(await migrateDatabase(pool, dir)).toEqual(["0133_baseline"]);
    owner = await initialOwnerId(pool);
  });
  afterAll(async () => { await pool?.end(); await rm(dir, { recursive: true, force: true }); });
  it("upgrades a baseline and enforces scoped references, idempotency, and retained rollback", async () => {
    await copyFile(resolve("database/migrations/0134_cast_review_decisions.sql"), join(dir, "0134_cast_review_decisions.sql"));
    expect(await migrateDatabase(pool, dir)).toEqual(["0134_cast_review_decisions"]);
    const world = randomUUID(), version = randomUUID(), campaign = randomUUID(), otherCampaign = randomUUID(), turn = randomUUID(), candidate = randomUUID();
    await pool.query("INSERT INTO worlds(id,owner_user_id,title) VALUES($1,$2,'Review')", [world, owner]);
    await pool.query("INSERT INTO world_versions(id,world_id,owner_user_id,version_number,content) VALUES($1,$2,$3,1,'{}')", [version, world, owner]);
    for (const id of [campaign, otherCampaign]) await pool.query("INSERT INTO campaigns(id,owner_user_id,world_version_id,title) VALUES($1,$2,$3,'Review')", [id, owner, version]);
    await pool.query("INSERT INTO turns(id,owner_user_id,campaign_id,turn_number,narration) VALUES($1,$2,$3,1,'text')", [turn, owner, campaign]);
    await pool.query("INSERT INTO campaign_cast_discovery_candidates(id,owner_user_id,campaign_id,chunk_ordinal,local_key,source,proposal,reason) VALUES($1,$2,$3,0,'candidate','{}','{}','review')", [candidate, owner, campaign]);
    const insert = `INSERT INTO campaign_cast_review_decisions(campaign_id,owner_user_id,candidate_id,turn_id,narration_revision,timeline_revision,source_hash,source,target_kind,target_payload,target_fingerprint,action,revision,request_hash,idempotency_key,result_receipt) VALUES($1,$2,$3,$4,0,0,$5,'{}','identity','{}',$5,'dismiss',$6,$5,$7,'{}')`;
    const hash = "a".repeat(64);
    const dismissal = (await pool.query(`${insert} RETURNING id`, [campaign, owner, candidate, turn, hash, 1, "key"])).rows[0]!.id;
    await expect(pool.query(insert, [campaign, owner, candidate, turn, hash, 2, "key"])).rejects.toMatchObject({ code: "23505" });
    await expect(pool.query(insert, [otherCampaign, owner, candidate, turn, hash, 1, "other"])).rejects.toMatchObject({ code: "23503" });
    await expect(pool.query("UPDATE campaign_cast_review_decisions SET revision=3")).rejects.toMatchObject({ code: "55000" });
    await expect(pool.query("DELETE FROM campaign_cast_review_decisions WHERE id=$1", [dismissal])).rejects.toMatchObject({ code: "55000" });
    await expect(pool.query("DELETE FROM campaign_cast_discovery_candidates WHERE id=$1", [candidate])).rejects.toMatchObject({ code: "55000" });
    const sql = await readFile(resolve("database/migrations/0134_cast_review_decisions.sql"), "utf8");
    await expect(pool.query(sql.split("-- Down Migration")[1]!)).rejects.toThrow("Cannot remove retained cast review decisions");
    expect((await pool.query("SELECT count(*)::int AS count FROM campaign_cast_review_decisions")).rows[0].count).toBe(1);

    // A source-backed candidate disappears through the discovery job when its turn is rewound.
    const turn2 = randomUUID(), job2 = randomUUID(), candidate2 = randomUUID();
    await pool.query("INSERT INTO turns(id,owner_user_id,campaign_id,turn_number,narration) VALUES($1,$2,$3,1,'other')", [turn2, owner, otherCampaign]);
    await pool.query(`INSERT INTO campaign_cast_discovery_jobs(id,owner_user_id,campaign_id,turn_id,turn_number,narration_revision,timeline_revision,source_hash,protocol,source,chunks,execution_snapshot,status)
      VALUES($1,$2,$3,$4,1,0,0,$5,'cast-discovery-v1','{}','[]','{}','queued')`, [job2, owner, otherCampaign, turn2, hash]);
    await pool.query("INSERT INTO campaign_cast_discovery_candidates(id,owner_user_id,campaign_id,job_id,chunk_ordinal,local_key,source,proposal,reason) VALUES($1,$2,$3,$4,0,'candidate','{}','{}','review')", [candidate2, owner, otherCampaign, job2]);
    const second = (await pool.query(`${insert} RETURNING id`, [otherCampaign, owner, candidate2, turn2, hash, 1, "second"])).rows[0]!.id;
    await pool.query(`INSERT INTO campaign_cast_review_decisions(campaign_id,owner_user_id,candidate_id,turn_id,narration_revision,timeline_revision,source_hash,source,target_kind,target_payload,target_fingerprint,action,restores_decision_id,revision,request_hash,idempotency_key,result_receipt)
      VALUES($1,$2,$3,$4,0,0,$5,'{}','identity','{}',$5,'restore',$6,2,$5,'restore','{}')`, [otherCampaign, owner, candidate2, turn2, hash, second]);
    await expect(pool.query("DELETE FROM turns WHERE id=$1 AND campaign_id=$2 AND owner_user_id=$3", [turn2, otherCampaign, owner])).resolves.toMatchObject({ rowCount: 1 });
    expect((await pool.query("SELECT id FROM campaign_cast_review_decisions ORDER BY id")).rows).toEqual([{ id: dismissal }]);
    await pool.query(`INSERT INTO campaign_cast_review_decisions(campaign_id,owner_user_id,candidate_id,turn_id,narration_revision,timeline_revision,source_hash,source,target_kind,target_payload,target_fingerprint,action,restores_decision_id,revision,request_hash,idempotency_key,result_receipt)
      VALUES($1,$2,$3,$4,0,0,$5,'{}','identity','{}',$5,'restore',$6,2,$5,'restore','{}')`, [campaign, owner, candidate, turn, hash, dismissal]);
    const retainedTurn = randomUUID(), retainedCandidate = randomUUID();
    await pool.query("INSERT INTO turns(id,owner_user_id,campaign_id,turn_number,narration) VALUES($1,$2,$3,1,'retained')", [retainedTurn, owner, otherCampaign]);
    await pool.query("INSERT INTO campaign_cast_discovery_candidates(id,owner_user_id,campaign_id,chunk_ordinal,local_key,source,proposal,reason) VALUES($1,$2,$3,0,'retained','{}','{}','review')", [retainedCandidate, owner, otherCampaign]);
    const retained = (await pool.query(`${insert} RETURNING id`, [otherCampaign, owner, retainedCandidate, retainedTurn, hash, 3, "retained"])).rows[0]!.id;
    await expect(pool.query("DELETE FROM campaigns WHERE id=$1 AND owner_user_id=$2", [campaign, owner])).resolves.toMatchObject({ rowCount: 1 });
    expect((await pool.query("SELECT id FROM campaign_cast_review_decisions")).rows).toEqual([{ id: retained }]);
    expect((await pool.query("SELECT count(*)::int AS count FROM campaigns WHERE id=$1", [otherCampaign])).rows[0].count).toBe(1);
  });
});
