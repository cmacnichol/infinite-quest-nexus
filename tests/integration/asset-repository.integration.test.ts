import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAssetApplication,
  toAssetMutationIdempotencyKey,
  type AssetMetadataBackfillClaim,
  type AssetTransactionContext
} from "../../packages/application/src/assets/index.js";
import type {
  DatabaseIssuedStorageLocator,
  DurableFilesystemScope
} from "../../packages/application/src/assets/private-storage-lifecycle.js";
import { assetListQuerySchema } from "../../packages/contracts/src/assets.js";
import {
  createPostgresAssetRepositories,
  createPostgresAssetStorageLocatorRedemptionRepository
} from "../../packages/database/src/asset-repository.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { importLegacyStory } from "../helpers/memory-aware-services.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

type CampaignFixture = Readonly<{
  campaignId: string;
  turnId: string;
  worldId: string;
  worldVersionId: string;
}>;

type AssetFixture = Readonly<{
  assetId: string;
  contentHash: string;
}>;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

integration("PostgreSQL asset repository", () => {
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

  function application() {
    return createAssetApplication(createPostgresAssetRepositories(pool));
  }

  async function campaign(): Promise<CampaignFixture> {
    const fixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    fixture.world.title = `Asset repository ${crypto.randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({
      sourceName: `asset-repository-${crypto.randomUUID()}.story`,
      story: fixture
    }));
    const scope = await pool.query<{
      turn_id: string;
      world_id: string;
      world_version_id: string;
    }>(
      `SELECT t.id AS turn_id, wv.world_id, c.world_version_id
         FROM campaigns c
         JOIN world_versions wv
           ON wv.id = c.world_version_id
          AND wv.owner_user_id = c.owner_user_id
         JOIN LATERAL (
           SELECT id FROM turns
            WHERE campaign_id = c.id AND owner_user_id = c.owner_user_id
            ORDER BY turn_number DESC LIMIT 1
         ) t ON true
        WHERE c.id = $1 AND c.owner_user_id = $2`,
      [imported.campaignId, ownerUserId]
    );
    return {
      campaignId: imported.campaignId,
      turnId: scope.rows[0]!.turn_id,
      worldId: scope.rows[0]!.world_id,
      worldVersionId: scope.rows[0]!.world_version_id
    };
  }

  async function asset(input: Partial<{
    ownerUserId: string;
    campaignId: string;
    turnId: string;
    createdAt: string;
    mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
    width: number | null;
    height: number | null;
    title: string;
    caption: string;
    notes: string;
    tags: string[];
    origin: "generated" | "imported" | "uploaded";
    reuseScope: "private" | "campaign" | "world" | "owner_library" | "shared";
    automaticReuseEnabled: boolean;
    reviewStatus: "unreviewed" | "eligible" | "restricted" | "blocked";
    contentCategories: string[];
    favorite: boolean;
    archived: boolean;
  }> = {}): Promise<AssetFixture> {
    const scopedOwner = input.ownerUserId ?? ownerUserId;
    const contentHash = hash(crypto.randomUUID());
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO assets (
         owner_user_id, campaign_id, turn_id, content_hash, storage_driver, storage_path,
         mime_type, byte_length, pixel_width, pixel_height, created_at
       ) VALUES ($1,$2,$3,$4,'filesystem',$5,$6,128,$7,$8,$9)
       RETURNING id`,
      [
        scopedOwner,
        input.campaignId ?? null,
        input.turnId ?? null,
        contentHash,
        `originals/${contentHash}.png`,
        input.mimeType ?? "image/png",
        input.width === undefined ? 640 : input.width,
        input.height === undefined ? 360 : input.height,
        input.createdAt ?? new Date().toISOString()
      ]
    );
    const assetId = inserted.rows[0]!.id;
    await pool.query(
      `UPDATE asset_library_entries SET
         title=$3, caption=$4, notes=$5, tags=$6, origin=$7, reuse_scope=$8,
         automatic_reuse_enabled=$9, review_status=$10, content_categories=$11,
         favorite=$12, archived_at=CASE WHEN $13 THEN now() ELSE NULL END
       WHERE asset_id=$1 AND owner_user_id=$2`,
      [
        assetId,
        scopedOwner,
        input.title ?? "",
        input.caption ?? "",
        input.notes ?? "",
        input.tags ?? [],
        input.origin ?? "imported",
        input.reuseScope ?? "private",
        input.automaticReuseEnabled ?? false,
        input.reviewStatus ?? "unreviewed",
        input.contentCategories ?? [],
        input.favorite ?? false,
        input.archived ?? false
      ]
    );
    return { assetId, contentHash };
  }

  async function addThumbnail(assetId: string, scopedOwner = ownerUserId): Promise<string> {
    const contentHash = hash(`thumbnail:${assetId}:${crypto.randomUUID()}`);
    await pool.query(
      `INSERT INTO asset_derivatives (
         owner_user_id, source_asset_id, derivative_kind, transform_version,
         pixel_width, pixel_height, storage_driver, storage_path, mime_type, byte_length, content_hash
       ) VALUES ($1,$2,'thumbnail',1,480,270,'filesystem',$3,'image/webp',64,$4)`,
      [scopedOwner, assetId, `derivatives/${contentHash}.webp`, contentHash]
    );
    return contentHash;
  }

  async function addContext(assetId: string, fixture: CampaignFixture): Promise<void> {
    await pool.query(
      `INSERT INTO asset_generation_contexts (
         owner_user_id, asset_id, created_by_user_id, world_id, world_version_id,
         campaign_id, turn_id, target_type, fiction_prompt, entities, locations,
         provider_type, model
       ) VALUES ($1,$2,$1,$3,$4,$5,$6,'turn_illustration',$7,$8,$9,$10,$11)`,
      [
        ownerUserId,
        assetId,
        fixture.worldId,
        fixture.worldVersionId,
        fixture.campaignId,
        fixture.turnId,
        "A moonlit citadel above the harbor",
        JSON.stringify(["entity-citadel"]),
        JSON.stringify(["location-harbor"]),
        "openai_compatible",
        "illustrator-v1"
      ]
    );
  }

  async function addReference(assetId: string, fixture: CampaignFixture, role: "turn_illustration" | "import_attachment" = "import_attachment") {
    await pool.query(
      `INSERT INTO asset_references (owner_user_id, asset_id, campaign_id, turn_id, asset_role)
       VALUES ($1,$2,$3,$4,$5)`,
      [ownerUserId, assetId, fixture.campaignId, fixture.turnId, role]
    );
  }

  async function durableLocator(
    target: AssetFixture,
    purpose: "asset_original" | "asset_derivative",
    relativePath: string,
    byteLength: number,
    contentHash: string,
  ): Promise<string> {
    const locator = `locator-${crypto.randomUUID()}`;
    const candidate = `candidate-${crypto.randomUUID()}`;
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO durable_filesystem_operations (
         owner_user_id, operation_token_hash, purpose, resource_kind, asset_id,
         lease_id, lease_owner, lease_expires_at, expires_at
       ) VALUES ($1,$2,$3,'asset',$4,gen_random_uuid(),'asset-repository-test',now()+interval '5 minutes',now()+interval '1 hour')
       RETURNING id`,
      [ownerUserId, hash(`operation-${crypto.randomUUID()}`), purpose, target.assetId]
    );
    const operationId = inserted.rows[0]!.id;
    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lifecycle='attached', candidate_token_hash=$2, locator_token_hash=$3, attached_at=now()
        WHERE id=$1`,
      [operationId, hash(candidate), hash(locator)]
    );
    await pool.query(
      `INSERT INTO durable_filesystem_descriptors (
         operation_id, owner_user_id, descriptor_role, ordinal, relative_path,
         device_id, file_id, change_token, content_hash, byte_length
       ) VALUES ($1,$2,'delivery',0,$3,'dev-1',$4,'change-1',$5,$6)`,
      [operationId, ownerUserId, relativePath, `file-${crypto.randomUUID()}`, contentHash, byteLength]
    );
    await pool.query(
      "UPDATE durable_filesystem_operations SET lifecycle='finalized', finalized_at=now() WHERE id=$1",
      [operationId]
    );
    return locator;
  }

  it("preserves the complete filtered list, facet, sort, cursor, metadata, and context projection", async () => {
    const fixture = await campaign();
    const target = await asset({
      campaignId: fixture.campaignId,
      turnId: fixture.turnId,
      createdAt: "2026-08-03T12:00:00.000Z",
      title: "Moonlit Citadel",
      caption: "Silver towers above a harbor",
      notes: "watchtower",
      tags: ["harbor", "moonlit"],
      origin: "generated",
      reuseScope: "campaign",
      automaticReuseEnabled: true,
      reviewStatus: "eligible",
      contentCategories: ["architecture"],
      favorite: true
    });
    await addContext(target.assetId, fixture);
    await addReference(target.assetId, fixture);
    await asset({ title: "Filtered out", tags: ["other"], createdAt: "2026-08-04T12:00:00.000Z" });

    const query = assetListQuerySchema.parse({
      q: "citadel harbor",
      scope: "campaign",
      creator: "me",
      worldId: fixture.worldId,
      worldVersionId: fixture.worldVersionId,
      campaignId: fixture.campaignId,
      origin: ["generated"],
      tags: ["harbor", "moonlit"],
      allTags: true,
      entityIds: ["entity-citadel"],
      locationIds: ["location-harbor"],
      provider: ["openai_compatible"],
      model: ["illustrator-v1"],
      reviewStatus: ["eligible"],
      reuseScope: ["campaign"],
      eligible: true,
      favorite: true,
      archived: false,
      mimeType: ["image/png"],
      aspect: ["landscape"],
      createdFrom: "2026-08-01T00:00:00.000Z",
      createdTo: "2026-08-05T23:59:59.000Z",
      sort: "most_used",
      limit: 40
    });

    await expect(application().listAssets({ ownerUserId }, query)).resolves.toEqual({
      assets: [{
        assetId: target.assetId,
        id: target.assetId,
        url: `/api/v1/assets/${target.assetId}`,
        thumbnailUrl: `/api/v1/assets/${target.assetId}/thumbnail`,
        mimeType: "image/png",
        byteLength: 128,
        width: 640,
        height: 360,
        createdAt: "2026-08-03T12:00:00.000Z",
        campaignId: fixture.campaignId,
        turnId: fixture.turnId,
        title: "Moonlit Citadel",
        caption: "Silver towers above a harbor",
        alt: "Silver towers above a harbor",
        tags: ["harbor", "moonlit"],
        origin: "generated",
        reuseScope: "campaign",
        automaticReuseEnabled: true,
        reviewStatus: "eligible",
        contentCategories: ["architecture"],
        favorite: true,
        archived: false,
        metadataRevision: 1,
        provider: "openai_compatible",
        model: "illustrator-v1",
        worldId: fixture.worldId,
        worldVersionId: fixture.worldVersionId,
        usageCount: 1
      }],
      nextCursor: null,
      total: 1,
      facets: {
        origin: { generated: 1 },
        reviewStatus: { eligible: 1 },
        reuseScope: { campaign: 1 },
        tags: { harbor: 1, moonlit: 1 }
      }
    });

    const pageQuery = assetListQuerySchema.parse({ sort: "newest", limit: 1 });
    const first = await application().listAssets({ ownerUserId }, pageQuery);
    expect(first.assets).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await application().listAssets({ ownerUserId }, { ...pageQuery, cursor: first.nextCursor! });
    expect(second.assets).toHaveLength(1);
    expect(second.assets[0]!.assetId).not.toBe(first.assets[0]!.assetId);
    await expect(application().listAssets({ ownerUserId }, { ...pageQuery, sort: "oldest", cursor: first.nextCursor! }))
      .rejects.toMatchObject({ code: "asset_cursor_invalid" });
  });

  it("replays an identical metadata key, rejects a mismatch, and fences concurrent revision writers", async () => {
    const target = await asset({ title: "Original" });
    const assets = application();
    const scope = { ownerUserId, assetId: target.assetId };
    const replayKey = toAssetMutationIdempotencyKey(`metadata-${crypto.randomUUID()}`);
    const command = { expectedRevision: 1, title: "First update", idempotencyKey: replayKey };

    await expect(assets.updateAssetMetadata(scope, command)).resolves.toEqual({ assetId: target.assetId, metadataRevision: 2 });
    await expect(assets.updateAssetMetadata(scope, command)).resolves.toEqual({ assetId: target.assetId, metadataRevision: 2 });
    await expect(assets.updateAssetMetadata(scope, { ...command, title: "Mismatch" }))
      .rejects.toMatchObject({ statusCode: 409, code: "asset_idempotency_mismatch" });

    const concurrent = await asset({ title: "Concurrent" });
    const attempts = await Promise.allSettled([
      assets.updateAssetMetadata(
        { ownerUserId, assetId: concurrent.assetId },
        { expectedRevision: 1, caption: "writer-a", idempotencyKey: toAssetMutationIdempotencyKey(`writer-a-${crypto.randomUUID()}`) }
      ),
      assets.updateAssetMetadata(
        { ownerUserId, assetId: concurrent.assetId },
        { expectedRevision: 1, caption: "writer-b", idempotencyKey: toAssetMutationIdempotencyKey(`writer-b-${crypto.randomUUID()}`) }
      )
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect((attempts.find((attempt) => attempt.status === "rejected") as PromiseRejectedResult).reason)
      .toMatchObject({ statusCode: 409, code: "asset_revision_conflict" });
    await expect(pool.query(
      "SELECT metadata_revision FROM asset_library_entries WHERE asset_id=$1 AND owner_user_id=$2",
      [concurrent.assetId, ownerUserId]
    )).resolves.toMatchObject({ rows: [{ metadata_revision: 2 }] });
  });

  it("sets, replays, mismatches, and explicitly clears scoped turn and world selections", async () => {
    const fixture = await campaign();
    const target = await asset();
    const assets = application();
    const turnScope = { ownerUserId, campaignId: fixture.campaignId, turnId: fixture.turnId };
    const turnKey = toAssetMutationIdempotencyKey(`turn-select-${crypto.randomUUID()}`);

    await expect(assets.selectTurnIllustration(turnScope, { assetId: target.assetId, idempotencyKey: turnKey }))
      .resolves.toEqual({ assetId: target.assetId, selected: true });
    await expect(assets.selectTurnIllustration(turnScope, { assetId: target.assetId, idempotencyKey: turnKey }))
      .resolves.toEqual({ assetId: target.assetId, selected: true });
    await expect(assets.selectTurnIllustration(turnScope, { assetId: null, idempotencyKey: turnKey }))
      .rejects.toMatchObject({ code: "asset_idempotency_mismatch" });
    await expect(assets.selectTurnIllustration(turnScope, {
      assetId: null,
      idempotencyKey: toAssetMutationIdempotencyKey(`turn-clear-${crypto.randomUUID()}`)
    })).resolves.toEqual({ assetId: null, selected: false });
    await expect(pool.query(
      "SELECT image_url FROM turns WHERE id=$1 AND campaign_id=$2 AND owner_user_id=$3",
      [fixture.turnId, fixture.campaignId, ownerUserId]
    )).resolves.toMatchObject({ rows: [{ image_url: "" }] });

    const worldScope = { ownerUserId, worldId: fixture.worldId };
    await expect(assets.selectWorldCover(worldScope, {
      assetId: target.assetId,
      idempotencyKey: toAssetMutationIdempotencyKey(`world-select-${crypto.randomUUID()}`)
    })).resolves.toEqual({ assetId: target.assetId, selected: true });
    await expect(assets.selectWorldCover(worldScope, {
      assetId: null,
      idempotencyKey: toAssetMutationIdempotencyKey(`world-clear-${crypto.randomUUID()}`)
    })).resolves.toEqual({ assetId: null, selected: false });
    await expect(pool.query(
      "SELECT cover_asset_id FROM worlds WHERE id=$1 AND owner_user_id=$2",
      [fixture.worldId, ownerUserId]
    )).resolves.toMatchObject({ rows: [{ cover_asset_id: null }] });
  });

  it("denies cross-owner reads, metadata, delivery, and scoped selection", async () => {
    const fixture = await campaign();
    const target = await asset();
    const foreignOwner = crypto.randomUUID();
    await pool.query(
      "INSERT INTO users (id, display_name, status) VALUES ($1,'Foreign asset owner','active')",
      [foreignOwner]
    );
    const assets = application();

    await expect(assets.readAsset({ ownerUserId: foreignOwner, assetId: target.assetId }))
      .rejects.toMatchObject({ statusCode: 404, code: "asset_not_found" });
    await expect(assets.describeAssetDelivery({ ownerUserId: foreignOwner, assetId: target.assetId }, { kind: "original" }))
      .rejects.toMatchObject({ statusCode: 404, code: "asset_not_found" });
    await expect(assets.updateAssetMetadata(
      { ownerUserId: foreignOwner, assetId: target.assetId },
      { expectedRevision: 1, title: "stolen", idempotencyKey: toAssetMutationIdempotencyKey(`foreign-${crypto.randomUUID()}`) }
    )).rejects.toMatchObject({ statusCode: 404, code: "asset_not_found" });
    await expect(assets.selectTurnIllustration(
      { ownerUserId, campaignId: crypto.randomUUID(), turnId: fixture.turnId },
      { assetId: target.assetId, idempotencyKey: toAssetMutationIdempotencyKey(`wrong-campaign-${crypto.randomUUID()}`) }
    )).rejects.toMatchObject({ statusCode: 404, code: "asset_scope_not_found" });
    await expect(assets.selectTurnIllustration(
      { ownerUserId: foreignOwner, campaignId: fixture.campaignId, turnId: fixture.turnId },
      { assetId: target.assetId, idempotencyKey: toAssetMutationIdempotencyKey(`foreign-turn-${crypto.randomUUID()}`) }
    )).rejects.toMatchObject({ statusCode: 404, code: "asset_scope_not_found" });
    await expect(assets.listAssets({ ownerUserId: foreignOwner }, assetListQuerySchema.parse({})))
      .resolves.toMatchObject({ assets: [], total: 0 });
  });

  it("describes original and thumbnail delivery without exposing paths and falls back when a thumbnail is absent", async () => {
    const target = await asset({ mimeType: "image/png" });
    const thumbnailHash = await addThumbnail(target.assetId);
    const assets = application();

    await expect(assets.readAsset({ ownerUserId, assetId: target.assetId })).resolves.toEqual({
      assetId: target.assetId,
      mimeType: "image/png",
      byteLength: 128
    });
    const original = await assets.describeAssetDelivery({ ownerUserId, assetId: target.assetId }, { kind: "original" });
    expect(original).toEqual({
      assetId: target.assetId,
      kind: "original",
      derivativeKind: null,
      mimeType: "image/png",
      byteLength: 128,
      etag: target.contentHash
    });
    expect(original).not.toHaveProperty("storagePath");
    expect(original).not.toHaveProperty("relativePath");
    await expect(assets.describeAssetDelivery(
      { ownerUserId, assetId: target.assetId },
      { kind: "derivative", derivativeKind: "thumbnail" }
    )).resolves.toEqual({
      assetId: target.assetId,
      kind: "derivative",
      derivativeKind: "thumbnail",
      mimeType: "image/webp",
      byteLength: 64,
      etag: thumbnailHash
    });

    const withoutThumbnail = await asset({ mimeType: "image/jpeg" });
    await expect(assets.describeAssetDelivery(
      { ownerUserId, assetId: withoutThumbnail.assetId },
      { kind: "derivative", derivativeKind: "thumbnail" }
    )).resolves.toMatchObject({
      assetId: withoutThumbnail.assetId,
      kind: "derivative",
      derivativeKind: "thumbnail",
      mimeType: "image/jpeg",
      byteLength: 128,
      etag: withoutThumbnail.contentHash
    });
  });

  it("redeems finalized original and derivative locators only for their database-owned asset scope", async () => {
    const target = await asset();
    const originalLocator = await durableLocator(
      target,
      "asset_original",
      `originals/${target.contentHash}.png`,
      128,
      target.contentHash
    );
    const thumbnailHash = hash(`thumbnail-locator-${crypto.randomUUID()}`);
    const derivativeLocator = await durableLocator(
      target,
      "asset_derivative",
      `derivatives/${thumbnailHash}.webp`,
      64,
      thumbnailHash
    );
    const redemption = createPostgresAssetStorageLocatorRedemptionRepository(pool);
    const scope: DurableFilesystemScope = { ownerUserId, resourceKind: "asset", assetId: target.assetId };

    await expect(redemption.redeemStorageLocator(scope, originalLocator as DatabaseIssuedStorageLocator))
      .resolves.toMatchObject({ relativePath: `originals/${target.contentHash}.png`, contentHash: target.contentHash, byteLength: 128 });
    await expect(redemption.redeemStorageLocator(scope, derivativeLocator as DatabaseIssuedStorageLocator))
      .resolves.toMatchObject({ relativePath: `derivatives/${thumbnailHash}.webp`, contentHash: thumbnailHash, byteLength: 64 });
    await expect(redemption.redeemStorageLocator(
      { ownerUserId: crypto.randomUUID(), resourceKind: "asset", assetId: target.assetId },
      originalLocator as DatabaseIssuedStorageLocator
    )).resolves.toBeNull();
    await expect(redemption.redeemStorageLocator(
      { ownerUserId, resourceKind: "asset", assetId: crypto.randomUUID() },
      originalLocator as DatabaseIssuedStorageLocator
    )).resolves.toBeNull();
  });

  it("uses SKIP LOCKED so two workers claim distinct rows and derive owner only from each claimed job", async () => {
    const foreignOwner = crypto.randomUUID();
    await pool.query("INSERT INTO users (id, display_name, status) VALUES ($1,'Backfill owner','active')", [foreignOwner]);
    const first = await asset({ width: null, height: null });
    const second = await asset({ ownerUserId: foreignOwner, width: null, height: null });
    await pool.query(
      `INSERT INTO asset_metadata_backfill_jobs (owner_user_id, asset_id)
       VALUES ($1,$2),($3,$4)`,
      [ownerUserId, first.assetId, foreignOwner, second.assetId]
    );
    const metadata = createPostgresAssetRepositories(pool).metadata;

    const [claimA, claimB] = await Promise.all([
      metadata.claimNextMetadataBackfill({ workerId: "worker-a", leaseSeconds: 30 }),
      metadata.claimNextMetadataBackfill({ workerId: "worker-b", leaseSeconds: 30 })
    ]);
    expect(claimA).not.toBeNull();
    expect(claimB).not.toBeNull();
    expect(new Set([claimA!.assetId, claimB!.assetId])).toEqual(new Set([first.assetId, second.assetId]));
    expect(new Set([claimA!.ownerUserId, claimB!.ownerUserId])).toEqual(new Set([ownerUserId, foreignOwner]));
    expect(claimA!.leaseOwner).toBe("worker-a");
    expect(claimB!.leaseOwner).toBe("worker-b");
  });

  it("heartbeats live work, reports expiry, requeues diagnostics, reclaims work, and rejects the stale lease", async () => {
    const target = await asset({ width: null, height: null });
    await pool.query(
      "INSERT INTO asset_metadata_backfill_jobs (owner_user_id, asset_id) VALUES ($1,$2)",
      [ownerUserId, target.assetId]
    );
    const metadata = createPostgresAssetRepositories(pool).metadata;
    const first = (await metadata.claimNextMetadataBackfill({ workerId: "worker-a", leaseSeconds: 30 }))!;
    const renewed = await metadata.heartbeatMetadataBackfill(first, { leaseSeconds: 60 });
    expect(renewed).toMatchObject({ outcome: "renewed", claim: { leaseOwner: "worker-a", workVersion: first.workVersion } });

    await pool.query(
      "UPDATE asset_metadata_backfill_jobs SET lease_expires_at=now()-interval '1 second' WHERE asset_id=$1 AND owner_user_id=$2",
      [target.assetId, ownerUserId]
    );
    await expect(metadata.heartbeatMetadataBackfill(first, { leaseSeconds: 30 }))
      .resolves.toEqual({ outcome: "lease_lost" });
    const reclaimed = (await metadata.claimNextMetadataBackfill({ workerId: "worker-b", leaseSeconds: 30 }))!;
    expect(reclaimed.workVersion).toBeGreaterThan(first.workVersion);
    await expect(metadata.heartbeatMetadataBackfill(first, { leaseSeconds: 30 }))
      .resolves.toEqual({ outcome: "stale" });
    await expect(metadata.requeueMetadataBackfill(reclaimed, { diagnosticCode: "asset_storage_unavailable" }))
      .resolves.toEqual({ outcome: "requeued" });
    await expect(pool.query(
      "SELECT status, diagnostic_code, lease_id FROM asset_metadata_backfill_jobs WHERE asset_id=$1 AND owner_user_id=$2",
      [target.assetId, ownerUserId]
    )).resolves.toMatchObject({ rows: [{ status: "recoverable", diagnostic_code: "asset_storage_unavailable", lease_id: null }] });
    const retried = (await metadata.claimNextMetadataBackfill({ workerId: "worker-c", leaseSeconds: 30 }))!;
    await expect(metadata.requeueMetadataBackfill(
      retried,
      { diagnosticCode: "raw /srv/assets/secret failure" as never }
    )).rejects.toMatchObject({ statusCode: 400, code: "asset_diagnostic_invalid" });
    await expect(pool.query(
      "SELECT diagnostic_code FROM asset_metadata_backfill_jobs WHERE asset_id=$1 AND owner_user_id=$2",
      [target.assetId, ownerUserId]
    )).resolves.toMatchObject({ rows: [{ diagnostic_code: "asset_storage_unavailable" }] });
  });

  it("completes metadata work only through the caller transaction and fences stale completion", async () => {
    const target = await asset();
    await addThumbnail(target.assetId);
    await pool.query(
      "INSERT INTO asset_metadata_backfill_jobs (owner_user_id, asset_id) VALUES ($1,$2)",
      [ownerUserId, target.assetId]
    );
    const metadata = createPostgresAssetRepositories(pool).metadata;
    const claim = (await metadata.claimNextMetadataBackfill({ workerId: "worker-complete", leaseSeconds: 30 }))!;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await expect(metadata.backfillMetadata(client as AssetTransactionContext, claim))
        .resolves.toEqual({ assetId: target.assetId, outcome: "updated" });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await expect(pool.query(
      "SELECT status, completed_at, lease_id FROM asset_metadata_backfill_jobs WHERE asset_id=$1 AND owner_user_id=$2",
      [target.assetId, ownerUserId]
    )).resolves.toMatchObject({ rows: [{ status: "completed", completed_at: expect.any(Date), lease_id: null }] });

    const verificationClient = await pool.connect();
    try {
      await verificationClient.query("BEGIN");
      await expect(metadata.backfillMetadata(verificationClient as AssetTransactionContext, claim))
        .resolves.toEqual({ assetId: target.assetId, outcome: "already_current" });
      const stale: AssetMetadataBackfillClaim = { ...claim, workVersion: claim.workVersion - 1 };
      await expect(metadata.backfillMetadata(verificationClient as AssetTransactionContext, stale))
        .resolves.toEqual({ assetId: target.assetId, outcome: "stale" });
      await verificationClient.query("COMMIT");
    } catch (error) {
      await verificationClient.query("ROLLBACK");
      throw error;
    } finally {
      verificationClient.release();
    }
  });
});
