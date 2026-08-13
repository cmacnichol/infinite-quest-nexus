import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PrivateAssetPublicationCommand } from "../../packages/application/src/assets/private-asset-publication.js";
import { bindPrivateBoundedStreamLimits } from "../../packages/application/src/assets/private-secure-storage.js";
import { toAssetMutationIdempotencyKey } from "../../packages/application/src/assets/types.js";
import { createPostgresAssetPublicationRepository } from "../../packages/database/src/asset-publication-repository.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  createDatabasePool,
  initialOwnerId,
  type DatabasePool
} from "../../packages/database/src/pool.js";
import { withTransaction } from "../../packages/database/src/pool.js";
import {
  createAssetPublicationComposition,
  type AssetPublicationComposition
} from "../../services/runtime/src/asset-import-composition.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

type WorldScope = Readonly<{
  campaignId: string;
  worldId: string;
  worldVersionId: string;
}>;

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const values: Uint8Array[] = [];
  for await (const value of chunks) values.push(value);
  return Buffer.concat(values.map((value) => Buffer.from(value)));
}

integration("Task 14e3c asset-publication composition", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  let scope: WorldScope;
  let archiveRoot = "";
  let assetRoot = "";
  const compositions = new Set<AssetPublicationComposition>();

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 6);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    archiveRoot = await mkdtemp(join(tmpdir(), "iqn-14e3c-archive-"));
    assetRoot = await mkdtemp(join(tmpdir(), "iqn-14e3c-assets-"));
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title) VALUES ($1,$2) RETURNING id",
      [ownerUserId, `14e3c-${crypto.randomUUID()}`],
    );
    const version = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id,owner_user_id,version_number,content)
       VALUES ($1,$2,1,'{}'::jsonb) RETURNING id`,
      [world.rows[0]!.id, ownerUserId],
    );
    const campaign = await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id,world_version_id,title) VALUES ($1,$2,$3) RETURNING id",
      [ownerUserId, version.rows[0]!.id, `14e3c-${crypto.randomUUID()}`],
    );
    scope = {
      worldId: world.rows[0]!.id,
      worldVersionId: version.rows[0]!.id,
      campaignId: campaign.rows[0]!.id
    };
  });

  afterEach(async () => {
    await Promise.all([...compositions].map((composition) => composition.close().catch(() => undefined)));
    compositions.clear();
  });

  afterAll(async () => {
    await pool.end();
    await rm(archiveRoot, { recursive: true, force: true });
    await rm(assetRoot, { recursive: true, force: true });
  });

  async function compose(): Promise<AssetPublicationComposition> {
    const composition = await createAssetPublicationComposition(pool, { archiveRoot, assetRoot });
    compositions.add(composition);
    return composition;
  }

  function command(
    key = `14e3c:${crypto.randomUUID()}`,
    contentSuffix = "",
  ): PrivateAssetPublicationCommand {
    const original = Buffer.from(`14e3c original image bytes${contentSuffix}`);
    const thumbnail = Buffer.from(`14e3c thumbnail image bytes${contentSuffix}`);
    return {
      owner: { ownerUserId },
      idempotencyKey: toAssetMutationIdempotencyKey(key),
      leaseOwner: "14e3c-test",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      original: {
        mimeType: "image/png",
        bytes: original,
        byteLength: original.byteLength,
        contentHash: sha256(original)
      },
      derivatives: [{
        derivativeKind: "thumbnail",
        transformVersion: 1,
        pixelWidth: 64,
        pixelHeight: 64,
        mimeType: "image/png",
        bytes: thumbnail,
        byteLength: thumbnail.byteLength,
        contentHash: sha256(thumbnail)
      }],
      provenance: {
        origin: "imported",
        campaignId: scope.campaignId,
        worldId: scope.worldId,
        worldVersionId: scope.worldVersionId,
        targetType: "other"
      }
    };
  }

  it("publishes an original and thumbnail through the private graph with safe replay and restart delivery", async () => {
    const composition = await compose();
    const request = command();
    const published = await composition.publisher.publishAsset(request);

    expect(Object.keys(published).sort()).toEqual([
      "assetId", "byteLength", "contentHash", "derivativeIds", "mimeType"
    ]);
    expect(published.derivativeIds).toHaveLength(1);
    expect(await composition.assets.readAsset({ ownerUserId, assetId: published.assetId })).toEqual({
      assetId: published.assetId,
      mimeType: "image/png",
      byteLength: request.original.byteLength
    });
    await expect(composition.publisher.publishAsset(request)).resolves.toEqual(published);
    const changedBytes = Buffer.from("14e3c changed original image bytes");
    await expect(composition.publisher.publishAsset({
      ...request,
      original: {
        ...request.original,
        bytes: changedBytes,
        byteLength: changedBytes.byteLength,
        contentHash: sha256(changedBytes)
      }
    })).rejects.toThrow("asset_publication_idempotency_mismatch");

    const rows = await pool.query<{
      asset_id: string;
      original_lifecycle: string;
      derivative_lifecycle: string;
      originals: string;
      derivatives: string;
      origin: string;
    }>(
      `SELECT identity.asset_id,
              (SELECT lifecycle FROM durable_filesystem_operations
                WHERE owner_user_id=identity.owner_user_id AND asset_id=identity.asset_id
                  AND purpose='asset_original') AS original_lifecycle,
              (SELECT lifecycle FROM durable_filesystem_operations
                WHERE owner_user_id=identity.owner_user_id AND asset_id=identity.asset_id
                  AND purpose='asset_derivative') AS derivative_lifecycle,
              (SELECT count(*)::text FROM assets
                WHERE owner_user_id=identity.owner_user_id AND id=identity.asset_id) AS originals,
              (SELECT count(*)::text FROM asset_derivatives
                WHERE owner_user_id=identity.owner_user_id AND source_asset_id=identity.asset_id) AS derivatives,
              (SELECT origin::text FROM asset_library_entries
                WHERE owner_user_id=identity.owner_user_id AND asset_id=identity.asset_id) AS origin
         FROM asset_publication_identities identity
        WHERE identity.asset_id=$1 AND identity.owner_user_id=$2 AND identity.lifecycle='published'`,
      [published.assetId, ownerUserId],
    );
    expect(rows.rows).toEqual([{
      asset_id: published.assetId,
      original_lifecycle: "finalized",
      derivative_lifecycle: "finalized",
      originals: "1",
      derivatives: "1",
      origin: "imported"
    }]);

    await composition.close();
    compositions.delete(composition);
    const restarted = await compose();
    const limits = bindPrivateBoundedStreamLimits({
      maximumBytes: 4_096,
      chunkBytes: 8,
      deadlineAt: new Date(Date.now() + 30_000).toISOString()
    });
    const originalSession = await restarted.storage.adapter.openAssetSession({
      scope: { ownerUserId, assetId: published.assetId },
      request: { kind: "original" },
      limits
    });
    const thumbnailSession = await restarted.storage.adapter.openAssetSession({
      scope: { ownerUserId, assetId: published.assetId },
      request: { kind: "derivative", derivativeKind: "thumbnail" },
      limits
    });
    expect(originalSession).not.toBeNull();
    expect(thumbnailSession).not.toBeNull();
    await expect(collect(originalSession!.chunks)).resolves.toEqual(request.original.bytes);
    await originalSession!.finalize("eof");
    await expect(collect(thumbnailSession!.chunks)).resolves.toEqual(request.derivatives[0]!.bytes);
    await thumbnailSession!.finalize("eof");
  });

  it("resumes a multi-artifact publication after one artifact finalized before restart", async () => {
    let composition = await compose();
    const request = command(`14e3c-partial-finalize:${crypto.randomUUID()}`, ":partial-finalize");
    await pool.query(`CREATE FUNCTION task_14e3c_partial_finalize_fault() RETURNS trigger
      LANGUAGE plpgsql AS $fault$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM durable_filesystem_operations operation
           WHERE operation.asset_id=OLD.asset_id
             AND operation.owner_user_id=OLD.owner_user_id
             AND operation.id<>OLD.id
             AND operation.lifecycle='finalized'
        ) THEN
          RAISE EXCEPTION 'task_14e3c_partial_finalize_fault';
        END IF;
        RETURN NEW;
      END;
      $fault$`);
    await pool.query(`CREATE TRIGGER task_14e3c_partial_finalize_fault_trigger
      BEFORE UPDATE ON durable_filesystem_operations
      FOR EACH ROW WHEN (NEW.lifecycle='finalized' AND OLD.lifecycle='attached')
      EXECUTE FUNCTION task_14e3c_partial_finalize_fault()`);
    try {
      await expect(composition.publisher.publishAsset(request))
        .rejects.toThrow("task_14e3c_partial_finalize_fault");
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS task_14e3c_partial_finalize_fault_trigger ON durable_filesystem_operations");
      await pool.query("DROP FUNCTION IF EXISTS task_14e3c_partial_finalize_fault()");
      await composition.close();
      compositions.delete(composition);
    }
    await expect(pool.query<{ lifecycle: string }>(
      `SELECT operation.lifecycle
         FROM durable_filesystem_operations operation
         JOIN asset_publication_identities identity ON identity.asset_id=operation.asset_id
        WHERE identity.owner_user_id=$1 AND identity.idempotency_key_hash=$2
        ORDER BY operation.purpose`,
      [ownerUserId, sha256(request.idempotencyKey)],
    )).resolves.toMatchObject({
      rows: expect.arrayContaining([{ lifecycle: "attached" }, { lifecycle: "finalized" }])
    });

    composition = await compose();
    await expect(composition.publisher.publishAsset(request)).resolves.toMatchObject({
      derivativeIds: [{ derivativeKind: "thumbnail" }]
    });
    await expect(pool.query<{ lifecycle: string }>(
      `SELECT operation.lifecycle
         FROM durable_filesystem_operations operation
         JOIN asset_publication_identities identity ON identity.asset_id=operation.asset_id
        WHERE identity.owner_user_id=$1 AND identity.idempotency_key_hash=$2`,
      [ownerUserId, sha256(request.idempotencyKey)],
    )).resolves.toMatchObject({
      rows: [{ lifecycle: "finalized" }, { lifecycle: "finalized" }]
    });
  });

  it("rejects original and derivative byte/hash mismatches before it creates durable publication state", async () => {
    const composition = await compose();
    const isolatedOwner = await pool.query<{ id: string }>(
      "INSERT INTO users (system_key,display_name,status) VALUES ($1,$2,'active') RETURNING id",
      [`14e3c-hash:${crypto.randomUUID()}`, "14e3c hash owner"],
    );
    const hashOwnerUserId = isolatedOwner.rows[0]!.id;
    const originalMismatch = command(`14e3c-hash-original:${crypto.randomUUID()}`, `:hash-original`);
    const derivativeMismatch = command(`14e3c-hash-derivative:${crypto.randomUUID()}`, `:hash-derivative`);
    const requests = [
      {
        ...originalMismatch,
        owner: { ownerUserId: hashOwnerUserId },
        provenance: { origin: "imported", targetType: "other" as const },
        original: { ...originalMismatch.original, contentHash: "d".repeat(64) }
      },
      {
        ...derivativeMismatch,
        owner: { ownerUserId: hashOwnerUserId },
        provenance: { origin: "imported", targetType: "other" as const },
        derivatives: [{
          ...derivativeMismatch.derivatives[0]!,
          contentHash: "e".repeat(64)
        }]
      }
    ] as const;

    for (const request of requests) {
      await expect(composition.publisher.publishAsset(request)).rejects.toThrow("asset_publication_content_hash_mismatch");
      await expect(pool.query(
        `SELECT asset_id FROM asset_publication_identities
          WHERE owner_user_id=$1 AND idempotency_key_hash=$2`,
        [hashOwnerUserId, sha256(request.idempotencyKey)],
      )).resolves.toMatchObject({ rows: [] });
      await expect(pool.query(
        "SELECT count(*)::int AS count FROM durable_filesystem_operations WHERE owner_user_id=$1",
        [hashOwnerUserId],
      )).resolves.toMatchObject({ rows: [{ count: 0 }] });
    }
    await expect(access(join(assetRoot, "assets/content", "d".repeat(64)))).rejects.toThrow();
    await expect(access(join(assetRoot, "assets/content", "e".repeat(64)))).rejects.toThrow();
  });

  it("replays the same semantic provenance regardless of key ordering or undefined optional fields", async () => {
    const composition = await compose();
    const request = command(`14e3c-provenance:${crypto.randomUUID()}`, `:provenance`);
    const reordered = {
      ...request,
      provenance: {
        worldVersionId: request.provenance.worldVersionId!,
        targetType: undefined,
        origin: request.provenance.origin,
        campaignId: request.provenance.campaignId!,
        worldId: request.provenance.worldId!
      }
    } as unknown as PrivateAssetPublicationCommand;
    const published = await composition.publisher.publishAsset(request);
    await expect(composition.publisher.publishAsset(reordered)).resolves.toEqual(published);
  });

  it("keeps a corrupt EEXIST target pending and quarantinable when verification fails before node authority", async () => {
    const composition = await compose();
    const request = command(`14e3c-eexist:${crypto.randomUUID()}`, `:eexist`);
    const target = join(assetRoot, "assets/content", request.original.contentHash);
    const corrupt = Buffer.from("14e3c corrupt existing bytes");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, corrupt);

    await expect(composition.publisher.publishAsset(request)).rejects.toThrow("filesystem_identity_mismatch");
    await expect(pool.query<{
      lifecycle: string;
      cleanup_pending: string;
      target_only: string;
      node_bound: string;
    }>(
      `SELECT identity.lifecycle,
              (SELECT count(*)::text FROM durable_filesystem_operations operation
                WHERE operation.asset_id=identity.asset_id AND operation.owner_user_id=identity.owner_user_id
                  AND operation.lifecycle='cleanup_pending') AS cleanup_pending,
              (SELECT count(*)::text FROM durable_filesystem_prewrite_nodes prewrite
                JOIN durable_filesystem_operations operation ON operation.id=prewrite.operation_id
                WHERE operation.asset_id=identity.asset_id AND operation.owner_user_id=identity.owner_user_id
                  AND prewrite.authority_state='target_only') AS target_only,
              (SELECT count(*)::text FROM durable_filesystem_prewrite_nodes prewrite
                JOIN durable_filesystem_operations operation ON operation.id=prewrite.operation_id
                WHERE operation.asset_id=identity.asset_id AND operation.owner_user_id=identity.owner_user_id
                  AND prewrite.authority_state='identity_bound') AS node_bound
         FROM asset_publication_identities identity
        WHERE identity.owner_user_id=$1 AND identity.idempotency_key_hash=$2`,
      [ownerUserId, sha256(request.idempotencyKey)],
    )).resolves.toMatchObject({ rows: [{
      lifecycle: "prepared",
      cleanup_pending: "1",
      target_only: "1",
      node_bound: "0"
    }] });
    await expect(readFile(target)).resolves.toEqual(corrupt);
  });

  it("shares verified physical content across owners and preserves it when a later scoped attach rolls back", async () => {
    const composition = await compose();
    const firstRequest = command(undefined, `:${crypto.randomUUID()}`);
    const first = await composition.publisher.publishAsset(firstRequest);
    const foreignOwner = await pool.query<{ id: string }>(
      "INSERT INTO users (system_key,display_name,status) VALUES ($1,$2,'active') RETURNING id",
      [`14e3c-shared:${crypto.randomUUID()}`, "14e3c shared owner"],
    );
    const foreignOwnerUserId = foreignOwner.rows[0]!.id;
    const secondRequest: PrivateAssetPublicationCommand = {
      ...firstRequest,
      owner: { ownerUserId: foreignOwnerUserId },
      idempotencyKey: toAssetMutationIdempotencyKey(`14e3c-shared:${crypto.randomUUID()}`),
      provenance: { origin: "imported", targetType: "other" }
    };
    const second = await composition.publisher.publishAsset(secondRequest);
    await expect(pool.query<{ paths: number; assets: number }>(
      `SELECT count(DISTINCT storage_path)::int AS paths,count(*)::int AS assets
         FROM assets
        WHERE id=ANY($1::uuid[])`,
      [[first.assetId, second.assetId]],
    )).resolves.toMatchObject({ rows: [{ paths: 1, assets: 2 }] });

    const failingOwner = await pool.query<{ id: string }>(
      "INSERT INTO users (system_key,display_name,status) VALUES ($1,$2,'active') RETURNING id",
      [`14e3c-shared-failure:${crypto.randomUUID()}`, "14e3c failing owner"],
    );

    const failedRequest: PrivateAssetPublicationCommand = {
      ...secondRequest,
      owner: { ownerUserId: failingOwner.rows[0]!.id },
      idempotencyKey: toAssetMutationIdempotencyKey(`14e3c-shared-failure:${crypto.randomUUID()}`),
      provenance: {
        origin: "imported",
        campaignId: scope.campaignId,
        worldId: scope.worldId,
        worldVersionId: scope.worldVersionId,
        targetType: "other"
      }
    };
    await expect(composition.publisher.publishAsset(failedRequest))
      .rejects.toThrow("asset_publication_campaign_scope_invalid");
    await expect(pool.query<{
      asset_id: string;
      lifecycle: string;
      assets: string;
      cleanupPending: string;
      targetOnly: string;
    }>(
      `SELECT identity.asset_id,identity.lifecycle,
              (SELECT count(*)::text FROM assets asset
                WHERE asset.id=identity.asset_id AND asset.owner_user_id=identity.owner_user_id) AS assets,
              (SELECT count(*)::text FROM durable_filesystem_operations operation
                WHERE operation.asset_id=identity.asset_id AND operation.owner_user_id=identity.owner_user_id
                  AND operation.lifecycle='cleanup_pending') AS "cleanupPending",
              (SELECT count(*)::text FROM durable_filesystem_prewrite_nodes prewrite
                JOIN durable_filesystem_operations operation ON operation.id=prewrite.operation_id
                WHERE operation.asset_id=identity.asset_id AND operation.owner_user_id=identity.owner_user_id
                  AND prewrite.authority_state='target_only') AS "targetOnly"
         FROM asset_publication_identities identity
        WHERE identity.owner_user_id=$1`,
      [failingOwner.rows[0]!.id],
    )).resolves.toMatchObject({
      rows: [{
        asset_id: expect.any(String),
        lifecycle: "prepared",
        assets: "0",
        cleanupPending: "2",
        targetOnly: "2"
      }]
    });

    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lease_expires_at=clock_timestamp()-interval '1 second'
        WHERE owner_user_id=$1 AND resource_kind='asset' AND lifecycle='cleanup_pending'`,
      [failingOwner.rows[0]!.id],
    );
    const recoveries = await composition.storage.journal.recover({
      leaseOwner: "14e3c-target-only-quarantine",
      leaseSeconds: 10,
      limit: 10
    });
    const targetOnlyRecoveries = recoveries.filter((recovery) => (
      recovery.action === "cleanup"
      && recovery.operation.resourceKind === "asset"
      && recovery.operation.ownerUserId === failingOwner.rows[0]!.id
    ));
    expect(targetOnlyRecoveries).toHaveLength(2);
    const quarantines = await Promise.all(targetOnlyRecoveries.map((recovery) => withTransaction(
      pool,
      (database) => composition.storage.prewrite.preparePrewriteCleanup(database, recovery),
    )));
    expect(quarantines).toEqual([{ outcome: "quarantined" }, { outcome: "quarantined" }]);

    const limits = bindPrivateBoundedStreamLimits({
      maximumBytes: 4_096,
      chunkBytes: 8,
      deadlineAt: new Date(Date.now() + 30_000).toISOString()
    });
    const retained = await composition.storage.adapter.openAssetSession({
      scope: { ownerUserId, assetId: first.assetId },
      request: { kind: "original" },
      limits
    });
    expect(retained).not.toBeNull();
    await expect(collect(retained!.chunks)).resolves.toEqual(firstRequest.original.bytes);
    await retained!.finalize("eof");
  });

  it("keeps post-commit attachments private until same-key retry finalizes them", async () => {
    const composition = await compose();
    const request = {
      ...command(undefined, `:finalize:${crypto.randomUUID()}`),
      expiresAt: new Date(Date.now() + 30_000).toISOString()
    };
    await pool.query(
      `CREATE FUNCTION task_14e3c_finalize_fault() RETURNS trigger
       LANGUAGE plpgsql AS $fault$
       BEGIN
         RAISE EXCEPTION 'task_14e3c_finalize_fault';
       END;
       $fault$`,
    );
    await pool.query(
      `CREATE TRIGGER task_14e3c_finalize_fault_trigger
       BEFORE UPDATE ON durable_filesystem_operations
       FOR EACH ROW WHEN (NEW.lifecycle = 'finalized')
       EXECUTE FUNCTION task_14e3c_finalize_fault()`,
    );
    try {
      await expect(composition.publisher.publishAsset(request))
        .rejects.toThrow("task_14e3c_finalize_fault");
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS task_14e3c_finalize_fault_trigger ON durable_filesystem_operations");
      await pool.query("DROP FUNCTION IF EXISTS task_14e3c_finalize_fault()");
    }

    const committed = await pool.query<{ asset_id: string; lifecycle: string; operations: string }>(
      `SELECT identity.asset_id,identity.lifecycle,
              (SELECT count(*)::text FROM durable_filesystem_operations operation
                WHERE operation.asset_id=identity.asset_id AND operation.owner_user_id=identity.owner_user_id
                  AND operation.lifecycle='attached') AS operations
         FROM asset_publication_identities identity
        WHERE identity.owner_user_id=$1 AND identity.idempotency_key_hash=$2`,
      [ownerUserId, sha256(request.idempotencyKey)],
    );
    expect(committed.rows).toEqual([{
      asset_id: expect.any(String),
      lifecycle: "attached",
      operations: "2"
    }]);

    const retried = await composition.publisher.publishAsset(request);
    expect(retried.assetId).toBe(committed.rows[0]!.asset_id);
    await expect(pool.query(
      `SELECT lifecycle FROM asset_publication_identities
        WHERE asset_id=$1 AND owner_user_id=$2`,
      [retried.assetId, ownerUserId],
    )).resolves.toMatchObject({ rows: [{ lifecycle: "published" }] });
    const limits = bindPrivateBoundedStreamLimits({
      maximumBytes: 4_096,
      chunkBytes: 8,
      deadlineAt: new Date(Date.now() + 30_000).toISOString()
    });
    const original = await composition.storage.adapter.openAssetSession({
      scope: { ownerUserId, assetId: retried.assetId },
      request: { kind: "original" },
      limits
    });
    const thumbnail = await composition.storage.adapter.openAssetSession({
      scope: { ownerUserId, assetId: retried.assetId },
      request: { kind: "derivative", derivativeKind: "thumbnail" },
      limits
    });
    expect(original).not.toBeNull();
    expect(thumbnail).not.toBeNull();
    await original!.finalize("eof");
    await thumbnail!.finalize("eof");
  });

  it("reconciles recovered finalizations before replay uses stale attached claims", async () => {
    const composition = await compose();
    const request = {
      ...command(undefined, `:recovered-finalize:${crypto.randomUUID()}`),
      expiresAt: new Date(Date.now() + 30_000).toISOString()
    };
    await pool.query(
      `CREATE FUNCTION task_14e3c_recovered_finalize_fault() RETURNS trigger
       LANGUAGE plpgsql AS $fault$
       BEGIN
         RAISE EXCEPTION 'task_14e3c_recovered_finalize_fault';
       END;
       $fault$`,
    );
    await pool.query(
      `CREATE TRIGGER task_14e3c_recovered_finalize_fault_trigger
       BEFORE UPDATE ON durable_filesystem_operations
       FOR EACH ROW WHEN (NEW.lifecycle = 'finalized')
       EXECUTE FUNCTION task_14e3c_recovered_finalize_fault()`,
    );
    try {
      await expect(composition.publisher.publishAsset(request))
        .rejects.toThrow("task_14e3c_recovered_finalize_fault");
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS task_14e3c_recovered_finalize_fault_trigger ON durable_filesystem_operations");
      await pool.query("DROP FUNCTION IF EXISTS task_14e3c_recovered_finalize_fault()");
    }

    const attached = await pool.query<{ asset_id: string }>(
      `SELECT asset_id FROM asset_publication_identities
        WHERE owner_user_id=$1 AND idempotency_key_hash=$2 AND lifecycle='attached'`,
      [ownerUserId, sha256(request.idempotencyKey)],
    );
    expect(attached.rows).toHaveLength(1);
    const assetId = attached.rows[0]!.asset_id;
    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lease_expires_at=clock_timestamp()-interval '1 second'
        WHERE owner_user_id=$1 AND asset_id=$2 AND lifecycle='attached'`,
      [ownerUserId, assetId],
    );
    const recovered = await composition.storage.journal.recover({
      leaseOwner: "14e3c-recovered-finalize",
      leaseSeconds: 10,
      limit: 10
    });
    const finalizations = recovered.filter((recovery): recovery is Extract<(typeof recovered)[number], Readonly<{ action: "finalize" }>> => (
      recovery.action === "finalize"
      && recovery.operation.resourceKind === "asset"
      && recovery.operation.assetId === assetId
    ));
    expect(finalizations).toHaveLength(2);
    await expect(Promise.all(finalizations.map((recovery) => (
      composition.storage.journal.finalizeAfterCommit(recovery.operation, recovery.claim)
    )))).resolves.toEqual([{ outcome: "finalized" }, { outcome: "finalized" }]);

    const replay = await composition.publisher.publishAsset(request);
    expect(replay.assetId).toBe(assetId);
    await expect(pool.query(
      "SELECT lifecycle FROM asset_publication_identities WHERE asset_id=$1 AND owner_user_id=$2",
      [assetId, ownerUserId],
    )).resolves.toMatchObject({ rows: [{ lifecycle: "published" }] });
    const limits = bindPrivateBoundedStreamLimits({
      maximumBytes: 4_096,
      chunkBytes: 8,
      deadlineAt: new Date(Date.now() + 30_000).toISOString()
    });
    const original = await composition.storage.adapter.openAssetSession({
      scope: { ownerUserId, assetId },
      request: { kind: "original" },
      limits
    });
    const thumbnail = await composition.storage.adapter.openAssetSession({
      scope: { ownerUserId, assetId },
      request: { kind: "derivative", derivativeKind: "thumbnail" },
      limits
    });
    expect(original).not.toBeNull();
    expect(thumbnail).not.toBeNull();
    await expect(collect(original!.chunks)).resolves.toEqual(request.original.bytes);
    await expect(collect(thumbnail!.chunks)).resolves.toEqual(request.derivatives[0]!.bytes);
    await original!.finalize("eof");
    await thumbnail!.finalize("eof");
  });

  it("keeps an attached identity and its delivery private when an unexpected durable asset operation remains", async () => {
    const composition = await compose();
    const request = {
      ...command(undefined, `:unexpected-operation:${crypto.randomUUID()}`),
      expiresAt: new Date(Date.now() + 30_000).toISOString()
    };
    const publication = createPostgresAssetPublicationRepository(pool, composition.storage.candidate);
    const identity = await publication.prepareIdentity(request);
    const unexpected = await composition.storage.journal.reserve(
      { resourceKind: "asset", ownerUserId, assetId: identity.assetId },
      {
        purpose: "asset_derivative",
        leaseOwner: "14e3c-unexpected-operation",
        expiresAt: request.expiresAt
      },
    );
    await expect(composition.storage.journal.markCleanup(
      unexpected.operation,
      unexpected.claim,
      { cause: "rollback" },
    )).resolves.toEqual({ outcome: "cleanup_pending" });
    await pool.query(
      `CREATE FUNCTION task_14e3c_unexpected_operation_fault() RETURNS trigger
       LANGUAGE plpgsql AS $fault$
       BEGIN
         RAISE EXCEPTION 'task_14e3c_unexpected_operation_fault';
       END;
       $fault$`,
    );
    await pool.query(
      `CREATE TRIGGER task_14e3c_unexpected_operation_fault_trigger
       BEFORE UPDATE ON durable_filesystem_operations
       FOR EACH ROW WHEN (NEW.lifecycle = 'finalized')
       EXECUTE FUNCTION task_14e3c_unexpected_operation_fault()`,
    );
    try {
      await expect(composition.publisher.publishAsset(request))
        .rejects.toThrow("task_14e3c_unexpected_operation_fault");
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS task_14e3c_unexpected_operation_fault_trigger ON durable_filesystem_operations");
      await pool.query("DROP FUNCTION IF EXISTS task_14e3c_unexpected_operation_fault()");
    }

    const attached = await pool.query<{ asset_id: string }>(
      `SELECT asset_id FROM asset_publication_identities
        WHERE owner_user_id=$1 AND idempotency_key_hash=$2 AND lifecycle='attached'`,
      [ownerUserId, sha256(request.idempotencyKey)],
    );
    const assetId = attached.rows[0]!.asset_id;
    expect(assetId).toBe(identity.assetId);
    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lease_expires_at=clock_timestamp()-interval '1 second'
        WHERE owner_user_id=$1 AND asset_id=$2 AND lifecycle='attached'`,
      [ownerUserId, assetId],
    );
    const recovered = await composition.storage.journal.recover({
      leaseOwner: "14e3c-unexpected-operation-finalize",
      leaseSeconds: 10,
      limit: 10
    });
    const expectedFinalization = recovered.filter((recovery): recovery is Extract<(typeof recovered)[number], Readonly<{ action: "finalize" }>> => (
      recovery.action === "finalize"
      && recovery.operation.resourceKind === "asset"
      && recovery.operation.assetId === assetId
    ));
    expect(expectedFinalization).toHaveLength(2);
    await Promise.all(expectedFinalization.map((recovery) => (
      composition.storage.journal.finalizeAfterCommit(recovery.operation, recovery.claim)
    )));

    await expect(composition.publisher.publishAsset(request))
      .rejects.toThrow("asset_publication_finalization_recoverable");
    const limits = bindPrivateBoundedStreamLimits({
      maximumBytes: 4_096,
      chunkBytes: 8,
      deadlineAt: new Date(Date.now() + 30_000).toISOString()
    });
    await expect(composition.storage.adapter.openAssetSession({
      scope: { ownerUserId, assetId },
      request: { kind: "original" },
      limits
    })).resolves.toBeNull();
    await expect(pool.query(
      "SELECT lifecycle FROM asset_publication_identities WHERE asset_id=$1 AND owner_user_id=$2",
      [assetId, ownerUserId],
    )).resolves.toMatchObject({ rows: [{ lifecycle: "attached" }] });

    await expect(composition.storage.journal.completeCleanup(
      unexpected.operation,
      unexpected.claim,
    )).resolves.toEqual({ outcome: "cleaned" });
    await pool.query("DELETE FROM durable_filesystem_operations WHERE id=$1", [unexpected.operation.operationId]);
    const replay = await composition.publisher.publishAsset(request);
    expect(replay.assetId).toBe(assetId);
    const delivered = await composition.storage.adapter.openAssetSession({
      scope: { ownerUserId, assetId },
      request: { kind: "original" },
      limits: bindPrivateBoundedStreamLimits({
        maximumBytes: 4_096,
        chunkBytes: 8,
        deadlineAt: new Date(Date.now() + 30_000).toISOString()
      })
    });
    expect(delivered).not.toBeNull();
    await delivered!.finalize("eof");
  });

  it("quarantines an O_EXCL node when durable node authority recording faults", async () => {
    const composition = await compose();
    const request = command(`14e3c-node-authority:${crypto.randomUUID()}`, `:node-authority`);
    const target = join(assetRoot, "assets/content", request.original.contentHash);
    await pool.query(
      `CREATE FUNCTION task_14e3c_node_authority_fault() RETURNS trigger
       LANGUAGE plpgsql AS $fault$
       BEGIN
         RAISE EXCEPTION 'task_14e3c_node_authority_fault';
       END;
       $fault$`,
    );
    await pool.query(
      `CREATE TRIGGER task_14e3c_node_authority_fault_trigger
       BEFORE UPDATE ON durable_filesystem_prewrite_nodes
       FOR EACH ROW WHEN (NEW.authority_state = 'identity_bound')
       EXECUTE FUNCTION task_14e3c_node_authority_fault()`,
    );
    try {
      await expect(composition.publisher.publishAsset(request))
        .rejects.toThrow("task_14e3c_node_authority_fault");
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS task_14e3c_node_authority_fault_trigger ON durable_filesystem_prewrite_nodes");
      await pool.query("DROP FUNCTION IF EXISTS task_14e3c_node_authority_fault()");
    }

    await expect(readFile(target)).resolves.toEqual(Buffer.alloc(0));
    const pending = await pool.query<{ asset_id: string; lifecycle: string; authority_state: string }>(
      `SELECT identity.asset_id,operation.lifecycle,prewrite.authority_state
         FROM asset_publication_identities identity
         JOIN durable_filesystem_operations operation
           ON operation.asset_id=identity.asset_id AND operation.owner_user_id=identity.owner_user_id
         JOIN durable_filesystem_prewrite_nodes prewrite
           ON prewrite.operation_id=operation.id
        WHERE identity.owner_user_id=$1 AND identity.idempotency_key_hash=$2`,
      [ownerUserId, sha256(request.idempotencyKey)],
    );
    expect(pending.rows).toEqual([{
      asset_id: expect.any(String),
      lifecycle: "cleanup_pending",
      authority_state: "target_only"
    }]);
    const assetId = pending.rows[0]!.asset_id;
    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lease_expires_at=clock_timestamp()-interval '1 second'
        WHERE owner_user_id=$1 AND asset_id=$2 AND lifecycle='cleanup_pending'`,
      [ownerUserId, assetId],
    );
    const recoveries = await composition.storage.journal.recover({
      leaseOwner: "14e3c-node-authority-quarantine",
      leaseSeconds: 10,
      limit: 10
    });
    const cleanup = recoveries.filter((recovery) => (
      recovery.action === "cleanup"
      && recovery.operation.resourceKind === "asset"
      && recovery.operation.assetId === assetId
    ));
    expect(cleanup).toHaveLength(1);
    await expect(withTransaction(
      pool,
      (database) => composition.storage.prewrite.preparePrewriteCleanup(database, cleanup[0]!),
    )).resolves.toEqual({ outcome: "quarantined" });
    await expect(readFile(target)).resolves.toEqual(Buffer.alloc(0));
    await expect(pool.query(
      `SELECT operation.lifecycle,prewrite.authority_state
         FROM durable_filesystem_operations operation
         JOIN durable_filesystem_prewrite_nodes prewrite ON prewrite.operation_id=operation.id
        WHERE operation.owner_user_id=$1 AND operation.asset_id=$2`,
      [ownerUserId, assetId],
    )).resolves.toMatchObject({ rows: [{
      lifecycle: "cleanup_pending",
      authority_state: "quarantined"
    }] });
  });
});
