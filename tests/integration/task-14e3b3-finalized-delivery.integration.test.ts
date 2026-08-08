import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  PrivateFinalizedAssetDeliveryGrant,
  PrivateLegacyAnchoredReadCapability
} from "../../packages/application/src/assets/private-finalized-delivery.js";
import { createPostgresAssetRepositories } from "../../packages/database/src/asset-repository.js";
import { createPostgresFinalizedAssetDeliveryRepository } from "../../packages/database/src/finalized-asset-delivery-repository.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  createDatabasePool,
  initialOwnerId,
  type DatabasePool
} from "../../packages/database/src/pool.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type Selection = Readonly<{
  ownerUserId: string;
  assetId: string;
  selectedRowKind: "asset" | "asset_derivative";
  selectedRowId: string;
  purpose: "asset_original" | "asset_derivative";
  relativePath: string;
  contentHash: string;
  byteLength: number;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
}>;

type FinalizedSelection = Selection & Readonly<{
  operationId: string;
  candidateTokenHash: string;
  deviceId: string;
  fileId: string;
  changeToken: string;
}>;

integration("Task 14e3b3 PostgreSQL finalized delivery repository", () => {
  let pool: DatabasePool;
  let ownerUserId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 10);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createOwner(prefix: string): Promise<string> {
    const result = await pool.query<{ id: string }>(
      "INSERT INTO users (system_key,display_name) VALUES ($1,$2) RETURNING id",
      [`${prefix}-${crypto.randomUUID()}`, prefix],
    );
    return result.rows[0]!.id;
  }

  async function createOriginal(
    scopedOwner = ownerUserId,
    overrides: Partial<Pick<Selection, "relativePath" | "contentHash" | "byteLength">> = {},
  ): Promise<Selection> {
    const seed = crypto.randomUUID();
    const relativePath = overrides.relativePath ?? `assets/${seed}.png`;
    const contentHash = overrides.contentHash ?? hash(`content-${seed}`);
    const byteLength = overrides.byteLength ?? 41;
    const result = await pool.query<{ id: string }>(
      `INSERT INTO assets (
         owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length
       ) VALUES ($1,$2,'filesystem',$3,'image/png',$4) RETURNING id`,
      [scopedOwner, contentHash, relativePath, byteLength],
    );
    const assetId = result.rows[0]!.id;
    return {
      ownerUserId: scopedOwner,
      assetId,
      selectedRowKind: "asset",
      selectedRowId: assetId,
      purpose: "asset_original",
      relativePath,
      contentHash,
      byteLength,
      mimeType: "image/png"
    };
  }

  async function createThumbnail(
    original: Selection,
    options: Readonly<{
      width: number;
      transformVersion?: number;
      rowId?: string;
    }>,
  ): Promise<Selection> {
    const seed = crypto.randomUUID();
    const relativePath = `assets/${seed}.webp`;
    const contentHash = hash(`thumbnail-${seed}`);
    const byteLength = options.width;
    const result = await pool.query<{ id: string }>(
      `INSERT INTO asset_derivatives (
         id,owner_user_id,source_asset_id,derivative_kind,transform_version,
         pixel_width,pixel_height,storage_driver,storage_path,mime_type,byte_length,content_hash
       ) VALUES (COALESCE($1::uuid,gen_random_uuid()),$2,$3,'thumbnail',$4,
                 $5,$5,'filesystem',$6,'image/webp',$7,$8) RETURNING id`,
      [
        options.rowId ?? null,
        original.ownerUserId,
        original.assetId,
        options.transformVersion ?? 1,
        options.width,
        relativePath,
        byteLength,
        contentHash
      ],
    );
    return {
      ownerUserId: original.ownerUserId,
      assetId: original.assetId,
      selectedRowKind: "asset_derivative",
      selectedRowId: result.rows[0]!.id,
      purpose: "asset_derivative",
      relativePath,
      contentHash,
      byteLength,
      mimeType: "image/webp"
    };
  }

  async function finalize(
    selection: Selection,
    options: Readonly<{
      candidateLifetime?: string;
      descriptorContentHash?: string;
      descriptorByteLength?: number;
    }> = {},
  ): Promise<FinalizedSelection> {
    const seed = crypto.randomUUID();
    const candidateTokenHash = hash(`candidate-${seed}`);
    const descriptorContentHash = options.descriptorContentHash ?? selection.contentHash;
    const descriptorByteLength = options.descriptorByteLength ?? selection.byteLength;
    const deviceId = `device-${seed}`;
    const fileId = `file-${seed}`;
    const changeToken = `change-${seed}`;
    const operation = await pool.query<{ id: string }>(
      `INSERT INTO durable_filesystem_operations (
         owner_user_id,operation_token_hash,purpose,resource_kind,asset_id,
         lease_id,lease_owner,lease_expires_at,expires_at
       ) VALUES ($1,$2,$3,'asset',$4,gen_random_uuid(),'b3-repository',
                 clock_timestamp()+interval '1 hour',clock_timestamp()+interval '1 day')
       RETURNING id`,
      [selection.ownerUserId, hash(`operation-${seed}`), selection.purpose, selection.assetId],
    );
    const operationId = operation.rows[0]!.id;
    await pool.query(
      `INSERT INTO durable_filesystem_candidate_authorities (
         candidate_token_hash,operation_id,owner_user_id,purpose,resource_kind,asset_id,
         relative_path,device_id,file_id,change_token,content_hash,byte_length,expires_at
       ) VALUES ($1,$2,$3,$4,'asset',$5,$6,$7,$8,$9,$10,$11,
                 clock_timestamp()+$12::interval)`,
      [
        candidateTokenHash,
        operationId,
        selection.ownerUserId,
        selection.purpose,
        selection.assetId,
        selection.relativePath,
        deviceId,
        fileId,
        changeToken,
        descriptorContentHash,
        descriptorByteLength,
        options.candidateLifetime ?? "1 hour"
      ],
    );
    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lifecycle='attached',candidate_token_hash=$2,locator_token_hash=$3,
              attached_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE id=$1`,
      [operationId, candidateTokenHash, hash(`locator-${seed}`)],
    );
    await pool.query(
      `INSERT INTO durable_filesystem_descriptors (
         operation_id,owner_user_id,descriptor_role,ordinal,relative_path,
         device_id,file_id,change_token,content_hash,byte_length
       ) VALUES ($1,$2,'delivery',0,$3,$4,$5,$6,$7,$8)`,
      [
        operationId,
        selection.ownerUserId,
        selection.relativePath,
        deviceId,
        fileId,
        changeToken,
        descriptorContentHash,
        descriptorByteLength
      ],
    );
    await pool.query(
      `UPDATE durable_filesystem_candidate_authorities
          SET lifecycle='attached',updated_at=clock_timestamp()
        WHERE candidate_token_hash=$1`,
      [candidateTokenHash],
    );
    const table = selection.selectedRowKind === "asset" ? "assets" : "asset_derivatives";
    await pool.query(
      `UPDATE ${table} SET filesystem_operation_id=$2 WHERE id=$1`,
      [selection.selectedRowId, operationId],
    );
    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lifecycle='finalized',finalized_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE id=$1`,
      [operationId],
    );
    return {
      ...selection,
      operationId,
      candidateTokenHash,
      deviceId,
      fileId,
      changeToken
    };
  }

  async function bindReservedOperation(selection: Selection): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO durable_filesystem_operations (
         owner_user_id,operation_token_hash,purpose,resource_kind,asset_id,
         lease_id,lease_owner,lease_expires_at,expires_at
       ) VALUES ($1,$2,$3,'asset',$4,gen_random_uuid(),'broken-binding',
                 clock_timestamp()+interval '1 hour',clock_timestamp()+interval '1 day')
       RETURNING id`,
      [selection.ownerUserId, hash(crypto.randomUUID()), selection.purpose, selection.assetId],
    );
    const operationId = result.rows[0]!.id;
    const table = selection.selectedRowKind === "asset" ? "assets" : "asset_derivatives";
    await pool.query(`UPDATE ${table} SET filesystem_operation_id=$2 WHERE id=$1`, [selection.selectedRowId, operationId]);
    return operationId;
  }

  it("issues a hash-only original grant after candidate TTL expiry and redeems it once after restart", async () => {
    const original = await finalize(await createOriginal(), { candidateLifetime: "150 milliseconds" });
    await pool.query("SELECT pg_sleep(0.2)");
    const firstRepository = createPostgresFinalizedAssetDeliveryRepository(pool);
    const resolution = await firstRepository.resolveFinalizedAssetDelivery(
      { ownerUserId, assetId: original.assetId },
      { kind: "original" },
    );
    expect(resolution).toMatchObject({
      kind: "durable_finalized",
      descriptor: {
        assetId: original.assetId,
        kind: "original",
        derivativeKind: null,
        byteLength: original.byteLength,
        etag: original.contentHash
      },
      cleanupAuthority: "none"
    });
    if (!resolution || resolution.kind !== "durable_finalized") throw new Error("durable grant expected");
    expect(firstRepository).not.toHaveProperty("redeemStorageLocator");

    const persisted = await pool.query<{
      grant_token_hash: string;
      candidate_token_hash: string;
      operation_id: string;
      relative_path: string;
      device_id: string;
      file_id: string;
      change_token: string;
      content_hash: string;
      byte_length: string;
    }>(
      `SELECT grant_token_hash,candidate_token_hash,operation_id,relative_path,
              device_id,file_id,change_token,content_hash,byte_length::text
         FROM private_finalized_asset_delivery_grants
        WHERE owner_user_id=$1 AND asset_id=$2`,
      [ownerUserId, original.assetId],
    );
    expect(persisted.rows[0]).toEqual({
      grant_token_hash: hash(resolution.grant),
      candidate_token_hash: original.candidateTokenHash,
      operation_id: original.operationId,
      relative_path: original.relativePath,
      device_id: original.deviceId,
      file_id: original.fileId,
      change_token: original.changeToken,
      content_hash: original.contentHash,
      byte_length: String(original.byteLength)
    });
    expect(JSON.stringify(persisted.rows[0])).not.toContain(resolution.grant);

    const restarted = createPostgresFinalizedAssetDeliveryRepository(pool);
    await expect(restarted.redeemFinalizedDeliveryGrant(
      { ownerUserId, assetId: original.assetId },
      { kind: "original" },
      resolution.grant,
    )).resolves.toEqual({
      relativePath: original.relativePath,
      identity: {
        deviceId: original.deviceId,
        fileId: original.fileId,
        changeToken: original.changeToken
      },
      contentHash: original.contentHash,
      byteLength: original.byteLength
    });
    await expect(restarted.redeemFinalizedDeliveryGrant(
      { ownerUserId, assetId: original.assetId },
      { kind: "original" },
      resolution.grant,
    )).resolves.toBeNull();
  });

  it("shares width-first then row-ID thumbnail selection with the asset repository", async () => {
    const original = await createOriginal();
    const higherWidth = await finalize(
      await createThumbnail(original, { width: 512, transformVersion: 1 }),
      { candidateLifetime: "150 milliseconds" },
    );
    await createThumbnail(original, { width: 256, transformVersion: 99 });
    await pool.query("SELECT pg_sleep(0.2)");
    const repository = createPostgresFinalizedAssetDeliveryRepository(pool);
    const publicAssetRepository = createPostgresAssetRepositories(pool);

    const privateResolution = await repository.resolveFinalizedAssetDelivery(
      { ownerUserId, assetId: original.assetId },
      { kind: "derivative", derivativeKind: "thumbnail" },
    );
    expect(privateResolution).toMatchObject({
      kind: "durable_finalized",
      request: { kind: "derivative", derivativeKind: "thumbnail" },
      descriptor: { etag: higherWidth.contentHash, byteLength: 512 }
    });
    if (!privateResolution || privateResolution.kind !== "durable_finalized") {
      throw new Error("durable thumbnail grant expected");
    }
    await expect(createPostgresFinalizedAssetDeliveryRepository(pool).redeemFinalizedDeliveryGrant(
      { ownerUserId, assetId: original.assetId },
      { kind: "derivative", derivativeKind: "thumbnail" },
      privateResolution.grant,
    )).resolves.toMatchObject({
      relativePath: higherWidth.relativePath,
      contentHash: higherWidth.contentHash,
      byteLength: higherWidth.byteLength
    });
    await expect(publicAssetRepository.delivery.describeAssetDelivery(
      { ownerUserId, assetId: original.assetId },
      { kind: "derivative", derivativeKind: "thumbnail" },
    )).resolves.toMatchObject({ etag: higherWidth.contentHash, byteLength: 512 });

    const tiedOriginal = await createOriginal();
    await createThumbnail(tiedOriginal, {
      width: 320,
      transformVersion: 9,
      rowId: "10000000-0000-4000-8000-000000000001"
    });
    const higherId = await finalize(await createThumbnail(tiedOriginal, {
      width: 320,
      transformVersion: 1,
      rowId: "10000000-0000-4000-8000-000000000002"
    }));
    await expect(repository.resolveFinalizedAssetDelivery(
      { ownerUserId, assetId: tiedOriginal.assetId },
      { kind: "derivative", derivativeKind: "thumbnail" },
    )).resolves.toMatchObject({ descriptor: { etag: higherId.contentHash } });
  });

  it("retains thumbnail intent when selection falls back to the original", async () => {
    const original = await createOriginal();
    const repository = createPostgresFinalizedAssetDeliveryRepository(pool);
    const resolution = await repository.resolveFinalizedAssetDelivery(
      { ownerUserId, assetId: original.assetId },
      { kind: "derivative", derivativeKind: "thumbnail" },
    );
    expect(resolution).toMatchObject({
      kind: "legacy_retained",
      request: { kind: "derivative", derivativeKind: "thumbnail" },
      descriptor: {
        kind: "derivative",
        derivativeKind: "thumbnail",
        etag: original.contentHash,
        byteLength: original.byteLength
      }
    });
    if (!resolution || resolution.kind !== "legacy_retained") {
      throw new Error("legacy fallback capability expected");
    }
    await expect(createPostgresFinalizedAssetDeliveryRepository(pool).redeemLegacyAnchoredRead(
      { ownerUserId, assetId: original.assetId },
      { kind: "derivative", derivativeKind: "thumbnail" },
      resolution.anchoredRead,
    )).resolves.toEqual({
      relativePath: original.relativePath,
      contentHash: original.contentHash,
      byteLength: original.byteLength
    });
  });

  it("rejects bearer scope and intent substitutions and expires grants using database time", async () => {
    const foreignOwner = await createOwner("b3-scope-foreign");
    const original = await finalize(await createOriginal());
    const other = await createOriginal();
    const repository = createPostgresFinalizedAssetDeliveryRepository(pool, {
      capabilityLifetimeMilliseconds: 100
    });
    const resolution = await repository.resolveFinalizedAssetDelivery(
      { ownerUserId, assetId: original.assetId },
      { kind: "original" },
    );
    if (!resolution || resolution.kind !== "durable_finalized") throw new Error("durable grant expected");

    await expect(repository.redeemFinalizedDeliveryGrant(
      { ownerUserId: foreignOwner, assetId: original.assetId },
      { kind: "original" },
      resolution.grant,
    )).resolves.toBeNull();
    await expect(repository.redeemFinalizedDeliveryGrant(
      { ownerUserId, assetId: other.assetId },
      { kind: "original" },
      resolution.grant,
    )).resolves.toBeNull();
    await expect(repository.redeemFinalizedDeliveryGrant(
      { ownerUserId, assetId: original.assetId },
      { kind: "derivative", derivativeKind: "thumbnail" },
      resolution.grant,
    )).resolves.toBeNull();
    await expect(repository.redeemFinalizedDeliveryGrant(
      { ownerUserId, assetId: original.assetId },
      { kind: "original" },
      "wrong-grant" as PrivateFinalizedAssetDeliveryGrant,
    )).resolves.toBeNull();

    await pool.query("SELECT pg_sleep(0.15)");
    await expect(repository.redeemFinalizedDeliveryGrant(
      { ownerUserId, assetId: original.assetId },
      { kind: "original" },
      resolution.grant,
    )).resolves.toBeNull();
    const row = await pool.query<{ lifecycle: string }>(
      "SELECT lifecycle FROM private_finalized_asset_delivery_grants WHERE grant_token_hash=$1",
      [hash(resolution.grant)],
    );
    expect(row.rows[0]?.lifecycle).toBe("expired");
  });

  it("fails closed for non-finalized or descriptor-mismatched non-null bindings without legacy fallback", async () => {
    const nonFinalized = await createOriginal();
    await bindReservedOperation(nonFinalized);
    const descriptorMismatch = await createOriginal();
    await finalize(descriptorMismatch, {
      descriptorContentHash: hash("different-descriptor-content"),
      descriptorByteLength: descriptorMismatch.byteLength + 1
    });
    const repository = createPostgresFinalizedAssetDeliveryRepository(pool);

    await expect(repository.resolveFinalizedAssetDelivery(
      { ownerUserId, assetId: nonFinalized.assetId },
      { kind: "original" },
    )).resolves.toBeNull();
    await expect(repository.resolveFinalizedAssetDelivery(
      { ownerUserId, assetId: descriptorMismatch.assetId },
      { kind: "original" },
    )).resolves.toBeNull();
    const fallbackRows = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM private_legacy_asset_read_capabilities
        WHERE asset_id=ANY($1::uuid[])`,
      [[nonFinalized.assetId, descriptorMismatch.assetId]],
    );
    expect(fallbackRows.rows[0]?.count).toBe("0");
  });

  it("issues restart-safe one-time legacy original and thumbnail anchored reads", async () => {
    const original = await createOriginal();
    const thumbnail = await createThumbnail(original, { width: 256 });
    const firstRepository = createPostgresFinalizedAssetDeliveryRepository(pool);
    const originalResolution = await firstRepository.resolveFinalizedAssetDelivery(
      { ownerUserId, assetId: original.assetId },
      { kind: "original" },
    );
    const thumbnailResolution = await firstRepository.resolveFinalizedAssetDelivery(
      { ownerUserId, assetId: original.assetId },
      { kind: "derivative", derivativeKind: "thumbnail" },
    );
    if (!originalResolution || originalResolution.kind !== "legacy_retained"
      || !thumbnailResolution || thumbnailResolution.kind !== "legacy_retained") {
      throw new Error("legacy capabilities expected");
    }

    const restarted = createPostgresFinalizedAssetDeliveryRepository(pool);
    await expect(restarted.redeemLegacyAnchoredRead(
      { ownerUserId, assetId: original.assetId },
      { kind: "original" },
      originalResolution.anchoredRead,
    )).resolves.toEqual({
      relativePath: original.relativePath,
      contentHash: original.contentHash,
      byteLength: original.byteLength
    });
    await expect(restarted.redeemLegacyAnchoredRead(
      { ownerUserId, assetId: original.assetId },
      { kind: "derivative", derivativeKind: "thumbnail" },
      thumbnailResolution.anchoredRead,
    )).resolves.toEqual({
      relativePath: thumbnail.relativePath,
      contentHash: thumbnail.contentHash,
      byteLength: thumbnail.byteLength
    });
    await expect(restarted.redeemLegacyAnchoredRead(
      { ownerUserId, assetId: original.assetId },
      { kind: "original" },
      originalResolution.anchoredRead,
    )).resolves.toBeNull();
  });

  it("rejects a legacy capability if its null selected row becomes durably bound", async () => {
    const original = await createOriginal();
    const repository = createPostgresFinalizedAssetDeliveryRepository(pool);
    const resolution = await repository.resolveFinalizedAssetDelivery(
      { ownerUserId, assetId: original.assetId },
      { kind: "original" },
    );
    if (!resolution || resolution.kind !== "legacy_retained") throw new Error("legacy capability expected");
    await finalize(original);

    await expect(repository.redeemLegacyAnchoredRead(
      { ownerUserId, assetId: original.assetId },
      { kind: "original" },
      resolution.anchoredRead,
    )).resolves.toBeNull();
  });

  it("keeps equal physical content owner-scoped for durable and legacy delivery", async () => {
    const foreignOwner = await createOwner("b3-shared-owner");
    const sharedHash = hash(`shared-${crypto.randomUUID()}`);
    const sharedPath = `assets/shared-${sharedHash}.png`;
    const first = await finalize(await createOriginal(ownerUserId, {
      contentHash: sharedHash,
      relativePath: sharedPath
    }));
    const second = await finalize(await createOriginal(foreignOwner, {
      contentHash: sharedHash,
      relativePath: sharedPath
    }));
    const repository = createPostgresFinalizedAssetDeliveryRepository(pool);
    const firstResolution = await repository.resolveFinalizedAssetDelivery(
      { ownerUserId, assetId: first.assetId },
      { kind: "original" },
    );
    const secondResolution = await repository.resolveFinalizedAssetDelivery(
      { ownerUserId: foreignOwner, assetId: second.assetId },
      { kind: "original" },
    );
    if (!firstResolution || firstResolution.kind !== "durable_finalized"
      || !secondResolution || secondResolution.kind !== "durable_finalized") {
      throw new Error("durable grants expected");
    }

    await expect(repository.redeemFinalizedDeliveryGrant(
      { ownerUserId: foreignOwner, assetId: second.assetId },
      { kind: "original" },
      firstResolution.grant,
    )).resolves.toBeNull();
    await expect(repository.redeemFinalizedDeliveryGrant(
      { ownerUserId, assetId: first.assetId },
      { kind: "original" },
      firstResolution.grant,
    )).resolves.toMatchObject({ contentHash: sharedHash, relativePath: sharedPath });
    await expect(repository.redeemFinalizedDeliveryGrant(
      { ownerUserId: foreignOwner, assetId: second.assetId },
      { kind: "original" },
      secondResolution.grant,
    )).resolves.toMatchObject({ contentHash: sharedHash, relativePath: sharedPath });

    const legacyHash = hash(`legacy-shared-${crypto.randomUUID()}`);
    const legacyPath = `assets/shared-${legacyHash}.png`;
    const legacyFirst = await createOriginal(ownerUserId, {
      contentHash: legacyHash,
      relativePath: legacyPath
    });
    const legacySecond = await createOriginal(foreignOwner, {
      contentHash: legacyHash,
      relativePath: legacyPath
    });
    const legacyFirstResolution = await repository.resolveFinalizedAssetDelivery(
      { ownerUserId, assetId: legacyFirst.assetId },
      { kind: "original" },
    );
    const legacySecondResolution = await repository.resolveFinalizedAssetDelivery(
      { ownerUserId: foreignOwner, assetId: legacySecond.assetId },
      { kind: "original" },
    );
    if (!legacyFirstResolution || legacyFirstResolution.kind !== "legacy_retained"
      || !legacySecondResolution || legacySecondResolution.kind !== "legacy_retained") {
      throw new Error("legacy capabilities expected");
    }
    await expect(repository.redeemLegacyAnchoredRead(
      { ownerUserId: foreignOwner, assetId: legacySecond.assetId },
      { kind: "original" },
      legacyFirstResolution.anchoredRead,
    )).resolves.toBeNull();
    await expect(repository.redeemLegacyAnchoredRead(
      { ownerUserId, assetId: legacyFirst.assetId },
      { kind: "original" },
      legacyFirstResolution.anchoredRead,
    )).resolves.toEqual({
      relativePath: legacyPath,
      contentHash: legacyHash,
      byteLength: legacyFirst.byteLength
    });
    await expect(repository.redeemLegacyAnchoredRead(
      { ownerUserId: foreignOwner, assetId: legacySecond.assetId },
      { kind: "original" },
      legacySecondResolution.anchoredRead,
    )).resolves.toEqual({
      relativePath: legacyPath,
      contentHash: legacyHash,
      byteLength: legacySecond.byteLength
    });
  });

  it("rejects legacy bearer substitutions without granting cleanup authority", async () => {
    const original = await createOriginal();
    const other = await createOriginal();
    const repository = createPostgresFinalizedAssetDeliveryRepository(pool);
    const resolution = await repository.resolveFinalizedAssetDelivery(
      { ownerUserId, assetId: original.assetId },
      { kind: "original" },
    );
    if (!resolution || resolution.kind !== "legacy_retained") throw new Error("legacy capability expected");
    expect(resolution.cleanupAuthority).toBe("none");
    await expect(repository.redeemLegacyAnchoredRead(
      { ownerUserId, assetId: other.assetId },
      { kind: "original" },
      resolution.anchoredRead,
    )).resolves.toBeNull();
    await expect(repository.redeemLegacyAnchoredRead(
      { ownerUserId, assetId: original.assetId },
      { kind: "derivative", derivativeKind: "thumbnail" },
      resolution.anchoredRead,
    )).resolves.toBeNull();
    await expect(repository.redeemLegacyAnchoredRead(
      { ownerUserId, assetId: original.assetId },
      { kind: "original" },
      "wrong-legacy" as PrivateLegacyAnchoredReadCapability,
    )).resolves.toBeNull();
  });
});
