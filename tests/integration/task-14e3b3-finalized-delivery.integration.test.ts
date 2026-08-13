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
    const operationId = await createReservedOperation(selection);
    const table = selection.selectedRowKind === "asset" ? "assets" : "asset_derivatives";
    await pool.query(`UPDATE ${table} SET filesystem_operation_id=$2 WHERE id=$1`, [selection.selectedRowId, operationId]);
    return operationId;
  }

  async function createReservedOperation(selection: Selection): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO durable_filesystem_operations (
         owner_user_id,operation_token_hash,purpose,resource_kind,asset_id,
         lease_id,lease_owner,lease_expires_at,expires_at
       ) VALUES ($1,$2,$3,'asset',$4,gen_random_uuid(),'broken-binding',
                 clock_timestamp()+interval '1 hour',clock_timestamp()+interval '1 day')
       RETURNING id`,
      [selection.ownerUserId, hash(crypto.randomUUID()), selection.purpose, selection.assetId],
    );
    return result.rows[0]!.id;
  }

  async function waitForCondition<T>(
    label: string,
    inspect: () => Promise<T | null>,
  ): Promise<T> {
    const deadline = performance.now() + 5_000;
    while (performance.now() < deadline) {
      const result = await inspect();
      if (result !== null) return result;
      await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  async function waitForAdvisoryWaiter(lockClass: number, lockKey: number): Promise<number> {
    return waitForCondition("legacy race advisory waiter", async () => {
      const result = await pool.query<{ pid: number }>(
        `SELECT activity.pid
           FROM pg_locks lock_state
           JOIN pg_stat_activity activity ON activity.pid=lock_state.pid
          WHERE lock_state.locktype='advisory'
            AND lock_state.classid::bigint=$1
            AND lock_state.objid::bigint=$2
            AND lock_state.objsubid=2
            AND lock_state.granted=false
            AND activity.datname=current_database()
          LIMIT 1`,
        [lockClass, lockKey],
      );
      return result.rows[0]?.pid ?? null;
    });
  }

  async function waitForBackendLock(pid: number): Promise<void> {
    await waitForCondition("binding backend row-lock wait", async () => {
      const result = await pool.query<{ waiting: boolean }>(
        `SELECT wait_event_type='Lock'
                AND query LIKE 'UPDATE assets SET filesystem_operation_id=%' AS waiting
           FROM pg_stat_activity WHERE pid=$1`,
        [pid],
      );
      return result.rows[0]?.waiting === true ? true : null;
    });
  }

  async function waitForWaiterBlockedBy(pid: number): Promise<number> {
    return waitForCondition("finalized-delivery repository row-lock wait", async () => {
      const result = await pool.query<{ pid: number }>(
        `SELECT waiting.pid
           FROM pg_stat_activity waiting
          WHERE waiting.datname=current_database()
            AND waiting.wait_event_type='Lock'
            AND $1=ANY(pg_blocking_pids(waiting.pid))
            AND waiting.query LIKE '%FOR SHARE OF a%'
          LIMIT 1`,
        [pid],
      );
      return result.rows[0]?.pid ?? null;
    });
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

  it("serializes both legacy null-to-bound lock orderings without exposing a post-bind descriptor", async () => {
    const lockClass = 140_033;
    let nextLockKey = 1;
    const repository = createPostgresFinalizedAssetDeliveryRepository(pool);
    type Settled<T> = Readonly<{ kind: "value"; value: T }> | Readonly<{ kind: "error"; error: unknown }>;
    const settled = <T>(promise: Promise<T>): Promise<Settled<T>> => promise.then(
      (value) => ({ kind: "value", value }),
      (error: unknown) => ({ kind: "error", error }),
    );
    const expectFailClosed = (outcome: Settled<unknown>): void => {
      if (outcome.kind === "error") {
        expect(outcome.error).toMatchObject({ code: "40001" });
      } else {
        expect(outcome.value).toBeNull();
      }
    };

    await pool.query(
      `CREATE TABLE task_14e3b3_legacy_race_gates (
         asset_id uuid PRIMARY KEY,
         lock_key integer UNIQUE NOT NULL
       )`,
    );
    await pool.query(
      `CREATE FUNCTION task_14e3b3_legacy_race_gate() RETURNS trigger
       LANGUAGE plpgsql AS $$
       DECLARE
         gate_key integer;
       BEGIN
         SELECT lock_key INTO gate_key
           FROM task_14e3b3_legacy_race_gates
          WHERE asset_id=NEW.asset_id;
         IF gate_key IS NOT NULL THEN
           PERFORM pg_advisory_xact_lock(${lockClass},gate_key);
         END IF;
         RETURN NEW;
       END;
       $$`,
    );
    await pool.query(
      `CREATE TRIGGER aaa_task_14e3b3_legacy_race_gate
       BEFORE INSERT OR UPDATE ON private_legacy_asset_read_capabilities
       FOR EACH ROW EXECUTE FUNCTION task_14e3b3_legacy_race_gate()`,
    );

    const registerGate = async (assetId: string, lockKey: number): Promise<void> => {
      await pool.query(
        `INSERT INTO task_14e3b3_legacy_race_gates (asset_id,lock_key)
         VALUES ($1,$2)`,
        [assetId, lockKey],
      );
    };
    const unregisterGate = async (assetId: string): Promise<void> => {
      await pool.query("DELETE FROM task_14e3b3_legacy_race_gates WHERE asset_id=$1", [assetId]);
    };

    try {
      // Resolve wins the selected-row lock first. Its insert is held only after
      // the production selector has taken FOR SHARE on the still-null row.
      const resolveFirst = await createOriginal();
      const resolveFirstKey = nextLockKey++;
      await registerGate(resolveFirst.assetId, resolveFirstKey);
      const resolveGate = await pool.connect();
      const resolveBinder = await pool.connect();
      let resolveGateHeld = false;
      let resolveBinderTransaction = false;
      try {
        await resolveGate.query("SELECT pg_advisory_lock($1,$2)", [lockClass, resolveFirstKey]);
        resolveGateHeld = true;
        const resolutionOutcome = settled(repository.resolveFinalizedAssetDelivery(
          { ownerUserId, assetId: resolveFirst.assetId },
          { kind: "original" },
        ));
        await waitForAdvisoryWaiter(lockClass, resolveFirstKey);

        const operationId = await createReservedOperation(resolveFirst);
        await resolveBinder.query("BEGIN");
        resolveBinderTransaction = true;
        const backend = await resolveBinder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const bind = resolveBinder.query(
          "UPDATE assets SET filesystem_operation_id=$2 WHERE id=$1",
          [resolveFirst.assetId, operationId],
        );
        await waitForBackendLock(backend.rows[0]!.pid);

        await resolveGate.query("SELECT pg_advisory_unlock($1,$2)", [lockClass, resolveFirstKey]);
        resolveGateHeld = false;
        const resolution = await resolutionOutcome;
        expect(resolution.kind).toBe("value");
        if (resolution.kind !== "value"
          || !resolution.value
          || resolution.value.kind !== "legacy_retained") {
          throw new Error("resolve-first legacy capability expected");
        }
        await bind;
        await resolveBinder.query("COMMIT");
        resolveBinderTransaction = false;

        await expect(repository.redeemLegacyAnchoredRead(
          { ownerUserId, assetId: resolveFirst.assetId },
          { kind: "original" },
          resolution.value.anchoredRead,
        )).resolves.toBeNull();
      } finally {
        if (resolveGateHeld) {
          await resolveGate.query("SELECT pg_advisory_unlock($1,$2)", [lockClass, resolveFirstKey]);
        }
        if (resolveBinderTransaction) await resolveBinder.query("ROLLBACK");
        resolveGate.release();
        resolveBinder.release();
        await unregisterGate(resolveFirst.assetId);
      }

      // A preexisting anchored read wins the selected-row lock first. The bind
      // waits, the one already-authorized read succeeds, and no later read can.
      const redeemFirst = await createOriginal();
      const issued = await repository.resolveFinalizedAssetDelivery(
        { ownerUserId, assetId: redeemFirst.assetId },
        { kind: "original" },
      );
      if (!issued || issued.kind !== "legacy_retained") throw new Error("legacy capability expected");
      const redeemFirstKey = nextLockKey++;
      await registerGate(redeemFirst.assetId, redeemFirstKey);
      const redeemGate = await pool.connect();
      const redeemBinder = await pool.connect();
      let redeemGateHeld = false;
      let redeemBinderTransaction = false;
      try {
        await redeemGate.query("SELECT pg_advisory_lock($1,$2)", [lockClass, redeemFirstKey]);
        redeemGateHeld = true;
        const redemptionOutcome = settled(repository.redeemLegacyAnchoredRead(
          { ownerUserId, assetId: redeemFirst.assetId },
          { kind: "original" },
          issued.anchoredRead,
        ));
        await waitForAdvisoryWaiter(lockClass, redeemFirstKey);

        const operationId = await createReservedOperation(redeemFirst);
        await redeemBinder.query("BEGIN");
        redeemBinderTransaction = true;
        const backend = await redeemBinder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const bind = redeemBinder.query(
          "UPDATE assets SET filesystem_operation_id=$2 WHERE id=$1",
          [redeemFirst.assetId, operationId],
        );
        await waitForBackendLock(backend.rows[0]!.pid);

        await redeemGate.query("SELECT pg_advisory_unlock($1,$2)", [lockClass, redeemFirstKey]);
        redeemGateHeld = false;
        const redemption = await redemptionOutcome;
        expect(redemption).toEqual({
          kind: "value",
          value: {
            relativePath: redeemFirst.relativePath,
            contentHash: redeemFirst.contentHash,
            byteLength: redeemFirst.byteLength
          }
        });
        await bind;
        await redeemBinder.query("COMMIT");
        redeemBinderTransaction = false;

        await expect(repository.redeemLegacyAnchoredRead(
          { ownerUserId, assetId: redeemFirst.assetId },
          { kind: "original" },
          issued.anchoredRead,
        )).resolves.toBeNull();
        await expect(repository.resolveFinalizedAssetDelivery(
          { ownerUserId, assetId: redeemFirst.assetId },
          { kind: "original" },
        )).resolves.toBeNull();
      } finally {
        if (redeemGateHeld) {
          await redeemGate.query("SELECT pg_advisory_unlock($1,$2)", [lockClass, redeemFirstKey]);
        }
        if (redeemBinderTransaction) await redeemBinder.query("ROLLBACK");
        redeemGate.release();
        redeemBinder.release();
        await unregisterGate(redeemFirst.assetId);
      }

      // Bind wins first: a resolver waiting on its row lock may return null or
      // PostgreSQL 40001 under REPEATABLE READ, but never a legacy capability.
      const bindFirstResolve = await createOriginal();
      const resolveOperationId = await createReservedOperation(bindFirstResolve);
      const resolveWinner = await pool.connect();
      let resolveWinnerTransaction = false;
      try {
        await resolveWinner.query("BEGIN");
        resolveWinnerTransaction = true;
        const backend = await resolveWinner.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        await resolveWinner.query(
          "UPDATE assets SET filesystem_operation_id=$2 WHERE id=$1",
          [bindFirstResolve.assetId, resolveOperationId],
        );
        const outcome = settled(repository.resolveFinalizedAssetDelivery(
          { ownerUserId, assetId: bindFirstResolve.assetId },
          { kind: "original" },
        ));
        await waitForWaiterBlockedBy(backend.rows[0]!.pid);
        await resolveWinner.query("COMMIT");
        resolveWinnerTransaction = false;
        expectFailClosed(await outcome);
      } finally {
        if (resolveWinnerTransaction) await resolveWinner.query("ROLLBACK");
        resolveWinner.release();
      }

      // Bind also wins against redemption of an already-issued capability.
      // The blocked redemption may return null or 40001, never a descriptor.
      const bindFirstRedeem = await createOriginal();
      const preexisting = await repository.resolveFinalizedAssetDelivery(
        { ownerUserId, assetId: bindFirstRedeem.assetId },
        { kind: "original" },
      );
      if (!preexisting || preexisting.kind !== "legacy_retained") {
        throw new Error("preexisting legacy capability expected");
      }
      const redeemOperationId = await createReservedOperation(bindFirstRedeem);
      const redeemWinner = await pool.connect();
      let redeemWinnerTransaction = false;
      try {
        await redeemWinner.query("BEGIN");
        redeemWinnerTransaction = true;
        const backend = await redeemWinner.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        await redeemWinner.query(
          "UPDATE assets SET filesystem_operation_id=$2 WHERE id=$1",
          [bindFirstRedeem.assetId, redeemOperationId],
        );
        const outcome = settled(repository.redeemLegacyAnchoredRead(
          { ownerUserId, assetId: bindFirstRedeem.assetId },
          { kind: "original" },
          preexisting.anchoredRead,
        ));
        await waitForWaiterBlockedBy(backend.rows[0]!.pid);
        await redeemWinner.query("COMMIT");
        redeemWinnerTransaction = false;
        expectFailClosed(await outcome);
        await expect(repository.redeemLegacyAnchoredRead(
          { ownerUserId, assetId: bindFirstRedeem.assetId },
          { kind: "original" },
          preexisting.anchoredRead,
        )).resolves.toBeNull();
      } finally {
        if (redeemWinnerTransaction) await redeemWinner.query("ROLLBACK");
        redeemWinner.release();
      }
    } finally {
      await pool.query(
        `DROP TRIGGER IF EXISTS aaa_task_14e3b3_legacy_race_gate
           ON private_legacy_asset_read_capabilities`,
      );
      await pool.query("DROP FUNCTION IF EXISTS task_14e3b3_legacy_race_gate()");
      await pool.query("DROP TABLE IF EXISTS task_14e3b3_legacy_race_gates");
    }
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
