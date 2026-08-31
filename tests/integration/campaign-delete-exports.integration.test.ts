import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import { createPostgresWorldRepositoryAdapters } from "../../packages/database/src/world-repository.js";
import { runPostgresWorldCampaignCommandWithClient } from "../../packages/database/src/world-campaign-transaction.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type ExportStatus = "ready" | "consumed" | "expired" | "failed" | "cleanup_pending" | "cleaned";

integration("campaign deletion after portable export", () => {
  let pool: DatabasePool;
  let ownerUserId: string;
  let adapters: ReturnType<typeof createPostgresWorldRepositoryAdapters>;

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    adapters = createPostgresWorldRepositoryAdapters(pool, {
      memory: { async autoEnableCampaignEmbedding() { throw new Error("not used by deletion"); } }
    });
  });

  afterAll(async () => { await pool?.end(); });

  async function fixture(scopedOwner = ownerUserId) {
    const title = `Export deletion ${randomUUID()}`;
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title) VALUES ($1,$2) RETURNING id", [scopedOwner, title]
    );
    const worldId = world.rows[0]!.id;
    const version = await pool.query<{ id: string }>(
      "INSERT INTO world_versions (world_id,owner_user_id,version_number,content) VALUES ($1,$2,1,'{}') RETURNING id",
      [worldId, scopedOwner]
    );
    const worldVersionId = version.rows[0]!.id;
    const campaign = await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id,world_version_id,title) VALUES ($1,$2,$3) RETURNING id",
      [scopedOwner, worldVersionId, title]
    );
    return { ownerUserId: scopedOwner, campaignId: campaign.rows[0]!.id, worldId, worldVersionId, title };
  }

  async function transitionExport(artifactId: string, operationId: string, status: "cleanup_pending" | "cleaned") {
    await withTransaction(pool, async (client) => {
      await client.query("UPDATE portable_export_artifacts SET status=$2 WHERE id=$1", [artifactId, status]);
      await client.query(
        `UPDATE durable_filesystem_operations SET lifecycle=$2,
           cleanup_requested_at=COALESCE(cleanup_requested_at,now()),
           cleaned_at=CASE WHEN $2='cleaned' THEN now() ELSE cleaned_at END WHERE id=$1`,
        [operationId, status]
      );
    });
  }

  async function exported(
    scope: Awaited<ReturnType<typeof fixture>>,
    status: ExportStatus,
    kind: "campaign_zip" | "world_json" = "campaign_zip"
  ) {
    const seed = randomUUID();
    const contentHash = hash(seed);
    const operation = await pool.query<{ id: string }>(
      `INSERT INTO durable_filesystem_operations (
         owner_user_id,operation_token_hash,purpose,resource_kind,operation_scope_hash,
         lease_id,lease_owner,lease_expires_at,expires_at
       ) VALUES ($1,$2,'portable_export','portable',$3,gen_random_uuid(),'deletion-test',
         now()+interval '5 minutes',now()+interval '1 hour') RETURNING id`,
      [scope.ownerUserId, hash(`operation-${seed}`), hash(`scope-${seed}`)]
    );
    const operationId = operation.rows[0]!.id;
    await pool.query(
      `UPDATE durable_filesystem_operations
         SET lifecycle='attached',candidate_token_hash=$2,locator_token_hash=$3,attached_at=now() WHERE id=$1`,
      [operationId, hash(`candidate-${seed}`), hash(`locator-${seed}`)]
    );
    await pool.query(
      `INSERT INTO durable_filesystem_descriptors (
         operation_id,owner_user_id,descriptor_role,ordinal,relative_path,
         device_id,file_id,change_token,content_hash,byte_length
       ) VALUES ($1,$2,'delivery',0,$3,'test-device',$4,'test-change',$5,64)`,
      [operationId, scope.ownerUserId, `portable_export/${seed}.zip`, seed, contentHash]
    );
    await pool.query(
      "UPDATE durable_filesystem_operations SET lifecycle='finalized',finalized_at=now() WHERE id=$1", [operationId]
    );
    const artifact = await pool.query<{ id: string }>(
      `INSERT INTO portable_export_artifacts (
         owner_user_id,retrieval_token_hash,filesystem_operation_id,export_kind,campaign_id,
         world_id,world_version_id,content_type,content_hash,byte_length,expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,64,now()-interval '1 minute') RETURNING id`,
      [scope.ownerUserId, hash(`retrieval-${seed}`), operationId, kind,
        kind === "campaign_zip" ? scope.campaignId : null, scope.worldId, scope.worldVersionId,
        kind === "campaign_zip" ? "application/zip" : "application/json", contentHash]
    );
    const artifactId = artifact.rows[0]!.id;
    if (status === "cleanup_pending" || status === "cleaned") {
      await transitionExport(artifactId, operationId, "cleanup_pending");
      if (status === "cleaned") await transitionExport(artifactId, operationId, "cleaned");
    } else if (status !== "ready") {
      await pool.query(
        `UPDATE portable_export_artifacts SET status=$2,
           consumed_at=CASE WHEN $2='consumed' THEN now() ELSE NULL END WHERE id=$1`,
        [artifactId, status]
      );
    }
    return { artifactId, operationId };
  }

  function deleteCampaign(scope: Awaited<ReturnType<typeof fixture>>, expectedTitle = scope.title) {
    return adapters.transaction.command((transaction) => adapters.campaigns.deleteCampaign(
      transaction, scope, { confirmation: "DELETE", expectedTitle }
    ));
  }

  it("deletes a campaign with cleaned expired exports while retaining the filesystem journal", async () => {
    const scope = await fixture();
    const first = await exported(scope, "cleaned");
    const second = await exported(scope, "cleaned");
    expect(await deleteCampaign(scope)).toEqual({ ok: true, value: undefined });
    expect((await pool.query("SELECT id FROM campaigns WHERE id=$1", [scope.campaignId])).rowCount).toBe(0);
    expect((await pool.query("SELECT id FROM portable_export_artifacts WHERE campaign_id=$1", [scope.campaignId])).rowCount).toBe(0);
    expect((await pool.query(
      "SELECT lifecycle FROM durable_filesystem_operations WHERE id=ANY($1::uuid[])", [[first.operationId, second.operationId]]
    )).rows).toEqual([{ lifecycle: "cleaned" }, { lifecycle: "cleaned" }]);
    expect((await pool.query(
      "SELECT operation_id FROM durable_filesystem_descriptors WHERE operation_id=ANY($1::uuid[])",
      [[first.operationId, second.operationId]]
    )).rowCount).toBe(2);
  });

  it.each(["ready", "consumed", "expired", "failed", "cleanup_pending"] as const)(
    "blocks %s exports without deleting cleaned sibling records", async (status) => {
      const scope = await fixture();
      const cleaned = await exported(scope, "cleaned");
      const pending = await exported(scope, status);
      expect(await deleteCampaign(scope)).toMatchObject({
        ok: false, failure: { reason: "deletion_blocked", details: { blockers: ["export:1"] } }
      });
      expect((await pool.query("SELECT id FROM campaigns WHERE id=$1", [scope.campaignId])).rowCount).toBe(1);
      expect((await pool.query("SELECT status FROM portable_export_artifacts WHERE id=$1", [cleaned.artifactId])).rows)
        .toEqual([{ status: "cleaned" }]);
      await expect(pool.query("DELETE FROM portable_export_artifacts WHERE id=$1", [pending.artifactId]))
        .rejects.toMatchObject({ code: "55000" });
    }
  );

  it("preserves export records for other campaigns and owners and rejects title or ownership mismatches", async () => {
    const own = await fixture();
    const sibling = await fixture();
    const foreignOwner = await pool.query<{ id: string }>("INSERT INTO users (display_name) VALUES ('Other owner') RETURNING id");
    const foreign = await fixture(foreignOwner.rows[0]!.id);
    const ownExport = await exported(own, "cleaned");
    const siblingExport = await exported(sibling, "cleaned");
    const foreignExport = await exported(foreign, "cleaned");
    const before = (await pool.query("SELECT * FROM portable_export_artifacts WHERE id=ANY($1::uuid[]) ORDER BY id",
      [[siblingExport.artifactId, foreignExport.artifactId]])).rows;
    expect(await deleteCampaign(own, "Incorrect title")).toMatchObject({ ok: false, failure: { reason: "invalid_transition" } });
    expect(await deleteCampaign({ ...own, ownerUserId: foreign.ownerUserId }))
      .toMatchObject({ ok: false, failure: { reason: "campaign_not_found" } });
    expect((await pool.query("SELECT id FROM portable_export_artifacts WHERE id=$1", [ownExport.artifactId])).rowCount).toBe(1);
    expect(await deleteCampaign(own)).toEqual({ ok: true, value: undefined });
    expect((await pool.query("SELECT * FROM portable_export_artifacts WHERE id=ANY($1::uuid[]) ORDER BY id",
      [[siblingExport.artifactId, foreignExport.artifactId]])).rows).toEqual(before);
  });

  it("rejects deleting an artifact before its filesystem journal is cleaned", async () => {
    const scope = await fixture();
    const artifact = await exported(scope, "cleanup_pending");
    await expect(withTransaction(pool, async (client) => {
      await client.query("UPDATE portable_export_artifacts SET status='cleaned' WHERE id=$1", [artifact.artifactId]);
      // The deferred lifecycle constraint has not run yet; deletion must still refuse this split state.
      await client.query("DELETE FROM portable_export_artifacts WHERE id=$1", [artifact.artifactId]);
    })).rejects.toMatchObject({ code: "55000" });
    expect((await pool.query("SELECT status FROM portable_export_artifacts WHERE id=$1", [artifact.artifactId])).rows)
      .toEqual([{ status: "cleanup_pending" }]);
  });

  it("keeps cleaned world export authority protected", async () => {
    const artifact = await exported(await fixture(), "cleaned", "world_json");
    await expect(pool.query("DELETE FROM portable_export_artifacts WHERE id=$1", [artifact.artifactId]))
      .rejects.toMatchObject({ code: "55000" });
  });

  it("rolls back export metadata removal with a failed campaign transaction", async () => {
    const scope = await fixture();
    const artifact = await exported(scope, "cleaned");
    const before = (await pool.query("SELECT * FROM portable_export_artifacts WHERE id=$1", [artifact.artifactId])).rows;
    const aborted = new Error("abort campaign deletion transaction");
    await expect(withTransaction(pool, async (client) => {
      expect(await runPostgresWorldCampaignCommandWithClient(client, (transaction) => adapters.campaigns.deleteCampaign(
        transaction, scope, { confirmation: "DELETE", expectedTitle: scope.title }
      ))).toEqual({ ok: true, value: undefined });
      throw aborted;
    })).rejects.toBe(aborted);
    expect((await pool.query("SELECT id FROM campaigns WHERE id=$1", [scope.campaignId])).rowCount).toBe(1);
    expect((await pool.query("SELECT * FROM portable_export_artifacts WHERE id=$1", [artifact.artifactId])).rows).toEqual(before);
  });

  it("upgrades existing export records without changing them and restores the old deletion guard on rollback", async () => {
    const scope = await fixture();
    const artifact = await exported(scope, "cleaned");
    const migration = await readFile(resolve("database/migrations/0083_cleaned_campaign_export_deletion.sql"), "utf8");
    const [up, down] = migration.split("-- Down Migration");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(down!);
      const before = (await client.query("SELECT * FROM portable_export_artifacts WHERE id=$1", [artifact.artifactId])).rows;
      await client.query("SAVEPOINT guarded_delete");
      await expect(client.query("DELETE FROM portable_export_artifacts WHERE id=$1", [artifact.artifactId]))
        .rejects.toMatchObject({ code: "55000" });
      await client.query("ROLLBACK TO SAVEPOINT guarded_delete");
      await client.query(up!);
      expect((await client.query("SELECT * FROM portable_export_artifacts WHERE id=$1", [artifact.artifactId])).rows).toEqual(before);
      await client.query("SAVEPOINT allowed_delete");
      expect((await client.query("DELETE FROM portable_export_artifacts WHERE id=$1", [artifact.artifactId])).rowCount).toBe(1);
      await client.query("ROLLBACK TO SAVEPOINT allowed_delete");
      await client.query(down!);
      await expect(client.query("DELETE FROM portable_export_artifacts WHERE id=$1", [artifact.artifactId]))
        .rejects.toMatchObject({ code: "55000" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
