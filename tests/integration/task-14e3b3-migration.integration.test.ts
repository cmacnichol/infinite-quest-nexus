import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

type SelectedRowKind = "asset" | "asset_derivative";
type DeliveryIntent = "original" | "thumbnail";

type Selection = Readonly<{
  ownerUserId: string;
  assetId: string;
  selectedRowKind: SelectedRowKind;
  selectedRowId: string;
  purpose: "asset_original" | "asset_derivative";
  relativePath: string;
  contentHash: string;
  byteLength: number;
  mimeType: string;
}>;

type FinalizedSelection = Selection & Readonly<{
  operationId: string;
  candidateTokenHash: string;
  deviceId: string;
  fileId: string;
  changeToken: string;
}>;

integration("Task 14e3b3 finalized delivery migration guards", () => {
  let pool: DatabasePool;
  let ownerUserId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 8);
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

  async function createOriginal(scopedOwner = ownerUserId): Promise<Selection> {
    const seed = crypto.randomUUID();
    const relativePath = `legacy/${seed}.png`;
    const contentHash = hash(`content-${seed}`);
    const result = await pool.query<{ id: string }>(
      `INSERT INTO assets (
         owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length
       ) VALUES ($1,$2,'filesystem',$3,'image/png',41) RETURNING id`,
      [scopedOwner, contentHash, relativePath],
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
      byteLength: 41,
      mimeType: "image/png"
    };
  }

  async function createThumbnail(original: Selection, width = 256): Promise<Selection> {
    const seed = crypto.randomUUID();
    const relativePath = `legacy/${seed}.webp`;
    const contentHash = hash(`thumb-${seed}`);
    const result = await pool.query<{ id: string }>(
      `INSERT INTO asset_derivatives (
         owner_user_id,source_asset_id,derivative_kind,transform_version,
         pixel_width,pixel_height,storage_driver,storage_path,mime_type,byte_length,content_hash
       ) VALUES ($1,$2,'thumbnail',1,$3,$3,'filesystem',$4,'image/webp',23,$5)
       RETURNING id`,
      [original.ownerUserId, original.assetId, width, relativePath, contentHash],
    );
    return {
      ownerUserId: original.ownerUserId,
      assetId: original.assetId,
      selectedRowKind: "asset_derivative",
      selectedRowId: result.rows[0]!.id,
      purpose: "asset_derivative",
      relativePath,
      contentHash,
      byteLength: 23,
      mimeType: "image/webp"
    };
  }

  async function finalize(
    selection: Selection,
    candidateLifetime = "1 hour",
  ): Promise<FinalizedSelection> {
    const seed = crypto.randomUUID();
    const candidateTokenHash = hash(`candidate-${seed}`);
    const deviceId = `device-${seed}`;
    const fileId = `file-${seed}`;
    const changeToken = `change-${seed}`;
    const operation = await pool.query<{ id: string }>(
      `INSERT INTO durable_filesystem_operations (
         owner_user_id,operation_token_hash,purpose,resource_kind,asset_id,
         lease_id,lease_owner,lease_expires_at,expires_at
       ) VALUES ($1,$2,$3,'asset',$4,gen_random_uuid(),'b3-migration',
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
        selection.contentHash,
        selection.byteLength,
        candidateLifetime
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
        selection.contentHash,
        selection.byteLength
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

  async function insertFinalizedGrant(
    selection: FinalizedSelection,
    intent: DeliveryIntent,
    lifetime = "30 seconds",
  ): Promise<string> {
    const grantTokenHash = hash(`grant-${crypto.randomUUID()}`);
    await pool.query(
      `INSERT INTO private_finalized_asset_delivery_grants (
         grant_token_hash,owner_user_id,asset_id,delivery_intent,
         selected_row_kind,selected_row_id,operation_id,operation_purpose,
         candidate_token_hash,relative_path,device_id,file_id,change_token,
         content_hash,byte_length,mime_type,expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                 clock_timestamp()+$17::interval)`,
      [
        grantTokenHash,
        selection.ownerUserId,
        selection.assetId,
        intent,
        selection.selectedRowKind,
        selection.selectedRowId,
        selection.operationId,
        selection.purpose,
        selection.candidateTokenHash,
        selection.relativePath,
        selection.deviceId,
        selection.fileId,
        selection.changeToken,
        selection.contentHash,
        selection.byteLength,
        selection.mimeType,
        lifetime
      ],
    );
    return grantTokenHash;
  }

  async function insertLegacyCapability(
    selection: Selection,
    intent: DeliveryIntent,
    lifetime = "30 seconds",
  ): Promise<string> {
    const capabilityTokenHash = hash(`legacy-${crypto.randomUUID()}`);
    await pool.query(
      `INSERT INTO private_legacy_asset_read_capabilities (
         capability_token_hash,owner_user_id,asset_id,delivery_intent,
         selected_row_kind,selected_row_id,relative_path,content_hash,
         byte_length,mime_type,expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
                 clock_timestamp()+$11::interval)`,
      [
        capabilityTokenHash,
        selection.ownerUserId,
        selection.assetId,
        intent,
        selection.selectedRowKind,
        selection.selectedRowId,
        selection.relativePath,
        selection.contentHash,
        selection.byteLength,
        selection.mimeType,
        lifetime
      ],
    );
    return capabilityTokenHash;
  }

  it("stores only hashes and freezes finalized owner, intent, selected row, operation, and descriptor identity", async () => {
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name IN (
            'private_finalized_asset_delivery_grants',
            'private_legacy_asset_read_capabilities'
          )`,
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names).toContain("grant_token_hash");
    expect(names).toContain("capability_token_hash");
    expect(names).not.toContain("grant_token");
    expect(names).not.toContain("capability_token");
    expect(names).not.toContain("storage_locator");

    const finalized = await finalize(await createOriginal());
    const grantTokenHash = await insertFinalizedGrant(finalized, "original");
    const replacements: readonly [string, unknown][] = [
      ["grant_token_hash", hash("replacement-grant")],
      ["owner_user_id", await createOwner("b3-foreign")],
      ["asset_id", crypto.randomUUID()],
      ["delivery_intent", "thumbnail"],
      ["selected_row_kind", "asset_derivative"],
      ["selected_row_id", crypto.randomUUID()],
      ["operation_id", crypto.randomUUID()],
      ["operation_purpose", "asset_derivative"],
      ["candidate_token_hash", hash("replacement-candidate")],
      ["relative_path", "replacement/file.png"],
      ["device_id", "replacement-device"],
      ["file_id", "replacement-file"],
      ["change_token", "replacement-change"],
      ["content_hash", hash("replacement-content")],
      ["byte_length", 999],
      ["mime_type", "image/jpeg"],
      ["expires_at", new Date(Date.now() + 10_000).toISOString()]
    ];
    for (const [column, value] of replacements) {
      await expect(pool.query(
        `UPDATE private_finalized_asset_delivery_grants SET ${column}=$2 WHERE grant_token_hash=$1`,
        [grantTokenHash, value],
      )).rejects.toMatchObject({ code: "55000" });
    }
  });

  it("allows post-finalization issuance after candidate expiry but enforces current-clock grant expiry and one-time redemption", async () => {
    const finalized = await finalize(await createOriginal(), "150 milliseconds");
    await pool.query("SELECT pg_sleep(0.2)");
    await expect(insertFinalizedGrant(finalized, "original", "61 seconds"))
      .rejects.toMatchObject({ code: "55000" });
    await expect(insertLegacyCapability(await createOriginal(), "original", "61 seconds"))
      .rejects.toMatchObject({ code: "55000" });
    const redeemable = await insertFinalizedGrant(finalized, "original", "2 seconds");
    await expect(pool.query(
      `UPDATE private_finalized_asset_delivery_grants
          SET lifecycle='redeemed',redeemed_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE grant_token_hash=$1`,
      [redeemable],
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(pool.query(
      `UPDATE private_finalized_asset_delivery_grants
          SET lifecycle='redeemed',redeemed_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE grant_token_hash=$1`,
      [redeemable],
    )).rejects.toMatchObject({ code: "55000" });

    const expired = await insertFinalizedGrant(finalized, "original", "100 milliseconds");
    await pool.query("SELECT pg_sleep(0.2)");
    await expect(pool.query(
      `UPDATE private_finalized_asset_delivery_grants
          SET lifecycle='redeemed',redeemed_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE grant_token_hash=$1`,
      [expired],
    )).rejects.toMatchObject({ code: "55000" });
  });

  it("freezes legacy-null row snapshots and grants one successful read only", async () => {
    const original = await createOriginal();
    const capabilityTokenHash = await insertLegacyCapability(original, "original");
    const replacements: readonly [string, unknown][] = [
      ["capability_token_hash", hash("replacement-legacy-capability")],
      ["owner_user_id", await createOwner("b3-legacy-foreign")],
      ["asset_id", crypto.randomUUID()],
      ["delivery_intent", "thumbnail"],
      ["selected_row_kind", "asset_derivative"],
      ["selected_row_id", crypto.randomUUID()],
      ["relative_path", "replacement/legacy.png"],
      ["content_hash", hash("replacement-legacy")],
      ["byte_length", 999],
      ["mime_type", "image/jpeg"],
      ["expires_at", new Date(Date.now() + 10_000).toISOString()]
    ];
    for (const [column, value] of replacements) {
      await expect(pool.query(
        `UPDATE private_legacy_asset_read_capabilities SET ${column}=$2
          WHERE capability_token_hash=$1`,
        [capabilityTokenHash, value],
      )).rejects.toMatchObject({ code: "55000" });
    }

    await expect(pool.query(
      `UPDATE private_legacy_asset_read_capabilities
          SET lifecycle='redeemed',redeemed_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE capability_token_hash=$1`,
      [capabilityTokenHash],
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(pool.query(
      `UPDATE private_legacy_asset_read_capabilities
          SET lifecycle='redeemed',redeemed_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE capability_token_hash=$1`,
      [capabilityTokenHash],
    )).rejects.toMatchObject({ code: "55000" });
  });

  it("rejects legacy redemption when the selected row becomes durably bound", async () => {
    const original = await createOriginal();
    const capabilityTokenHash = await insertLegacyCapability(original, "original");
    await finalize(original);

    await expect(pool.query(
      `UPDATE private_legacy_asset_read_capabilities
          SET lifecycle='redeemed',redeemed_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE capability_token_hash=$1`,
      [capabilityTokenHash],
    )).rejects.toMatchObject({ code: "55000" });
  });

  it("accepts a thumbnail row only for thumbnail intent while permitting original fallback for that intent", async () => {
    const original = await createOriginal();
    const thumbnail = await finalize(await createThumbnail(original));
    await expect(insertFinalizedGrant(thumbnail, "thumbnail")).resolves.toMatch(/^[0-9a-f]{64}$/u);

    const fallback = await finalize(await createOriginal());
    await expect(insertFinalizedGrant(fallback, "thumbnail")).resolves.toMatch(/^[0-9a-f]{64}$/u);
    await expect(insertFinalizedGrant(thumbnail, "original")).rejects.toMatchObject({ code: "23514" });
  });
});
