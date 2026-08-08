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
import { queryAssets as queryLegacyAssets } from "../../services/api/src/asset-service.js";
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

  async function addContext(
    assetId: string,
    fixture: CampaignFixture,
    input: Partial<{
      fictionPrompt: string;
      entities: string[];
      locations: string[];
      providerType: string;
      model: string;
    }> = {},
  ): Promise<void> {
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
        input.fictionPrompt ?? "A moonlit citadel above the harbor",
        JSON.stringify(input.entities ?? ["entity-citadel"]),
        JSON.stringify(input.locations ?? ["location-harbor"]),
        input.providerType ?? "openai_compatible",
        input.model ?? "illustrator-v1"
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
    finalized = true,
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
    if (finalized) {
      await pool.query(
        "UPDATE durable_filesystem_operations SET lifecycle='finalized', finalized_at=now() WHERE id=$1",
        [operationId]
      );
    }
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

  it("differentially preserves every validated list filter, sort, cursor, and facet", async () => {
    const firstCampaign = await campaign();
    const secondCampaign = await campaign();
    const marker = `parity${crypto.randomUUID().replaceAll("-", "")}`;
    const foreignCreator = crypto.randomUUID();
    await pool.query(
      "INSERT INTO users (id, display_name, status) VALUES ($1,'Asset parity creator','active')",
      [foreignCreator]
    );
    const alpha = await asset({
      campaignId: firstCampaign.campaignId,
      turnId: firstCampaign.turnId,
      createdAt: "2026-08-01T12:00:00.000Z",
      title: `Alpha ${marker}`,
      tags: ["common", "red"],
      origin: "generated",
      reuseScope: "campaign",
      automaticReuseEnabled: true,
      reviewStatus: "eligible",
      favorite: true,
      mimeType: "image/png",
      width: 640,
      height: 360
    });
    const beta = await asset({
      campaignId: secondCampaign.campaignId,
      turnId: secondCampaign.turnId,
      createdAt: "2026-08-02T12:00:00.000Z",
      title: `Beta ${marker}`,
      tags: ["blue", "common"],
      origin: "imported",
      reuseScope: "owner_library",
      automaticReuseEnabled: false,
      reviewStatus: "restricted",
      mimeType: "image/jpeg",
      width: 320,
      height: 640
    });
    const gamma = await asset({
      createdAt: "2026-08-03T12:00:00.000Z",
      title: `Gamma ${marker}`,
      tags: ["archived"],
      origin: "generated",
      reuseScope: "world",
      reviewStatus: "blocked",
      mimeType: "image/gif",
      width: 512,
      height: 512,
      archived: true
    });
    const delta = await asset({
      createdAt: "2026-08-04T12:00:00.000Z",
      title: `Delta ${marker}`,
      tags: ["green"],
      origin: "uploaded",
      reuseScope: "private",
      automaticReuseEnabled: false,
      reviewStatus: "unreviewed",
      mimeType: "image/webp",
      width: null,
      height: null
    });
    await addContext(alpha.assetId, firstCampaign, {
      fictionPrompt: `Citadel ${marker}`,
      entities: ["entity-alpha"],
      locations: ["location-alpha"],
      providerType: "provider-alpha",
      model: "model-alpha"
    });
    await addContext(beta.assetId, secondCampaign, {
      fictionPrompt: `Forest ${marker}`,
      entities: ["entity-beta"],
      locations: ["location-beta"],
      providerType: "provider-beta",
      model: "model-beta"
    });
    await addReference(alpha.assetId, firstCampaign, "turn_illustration");
    await addReference(alpha.assetId, firstCampaign, "import_attachment");
    await addReference(beta.assetId, secondCampaign, "import_attachment");
    await pool.query(
      "UPDATE asset_library_entries SET created_by_user_id=$3 WHERE asset_id=$1 AND owner_user_id=$2",
      [beta.assetId, ownerUserId, foreignCreator]
    );

    const defaultOrder = [delta.assetId, beta.assetId, alpha.assetId];
    const cases: Array<Readonly<{
      name: string;
      input: Record<string, unknown>;
      expected: string[];
    }>> = [
      { name: "q", input: {}, expected: defaultOrder },
      { name: "scope all", input: { scope: "all" }, expected: defaultOrder },
      { name: "scope campaign", input: { scope: "campaign", campaignId: firstCampaign.campaignId }, expected: [alpha.assetId] },
      { name: "scope world", input: { scope: "world", worldId: firstCampaign.worldId }, expected: [alpha.assetId] },
      { name: "scope owner library", input: { scope: "owner_library" }, expected: [beta.assetId] },
      { name: "scope shared negative", input: { scope: "shared" }, expected: [] },
      { name: "creator me", input: { creator: "me" }, expected: [delta.assetId, alpha.assetId] },
      { name: "world id", input: { worldId: firstCampaign.worldId }, expected: [alpha.assetId] },
      { name: "world version id", input: { worldVersionId: firstCampaign.worldVersionId }, expected: [alpha.assetId] },
      { name: "campaign id", input: { campaignId: firstCampaign.campaignId }, expected: [alpha.assetId] },
      { name: "origin", input: { origin: ["generated"] }, expected: [alpha.assetId] },
      { name: "tags any", input: { tags: ["red", "blue"] }, expected: [beta.assetId, alpha.assetId] },
      { name: "tags all", input: { tags: ["common", "red"], allTags: true }, expected: [alpha.assetId] },
      { name: "entity ids", input: { entityIds: ["entity-alpha"] }, expected: [alpha.assetId] },
      { name: "location ids", input: { locationIds: ["location-alpha"] }, expected: [alpha.assetId] },
      { name: "provider", input: { provider: ["provider-alpha"] }, expected: [alpha.assetId] },
      { name: "model", input: { model: ["model-alpha"] }, expected: [alpha.assetId] },
      { name: "review status", input: { reviewStatus: ["restricted"] }, expected: [beta.assetId] },
      { name: "reuse scope", input: { reuseScope: ["owner_library"] }, expected: [beta.assetId] },
      { name: "eligible true", input: { eligible: true }, expected: [alpha.assetId] },
      { name: "eligible false", input: { eligible: false }, expected: [delta.assetId, beta.assetId] },
      { name: "favorite true", input: { favorite: true }, expected: [alpha.assetId] },
      { name: "favorite false", input: { favorite: false }, expected: [delta.assetId, beta.assetId] },
      { name: "archived", input: { archived: true }, expected: [gamma.assetId] },
      { name: "mime type", input: { mimeType: ["image/jpeg"] }, expected: [beta.assetId] },
      { name: "aspect landscape", input: { aspect: ["landscape"] }, expected: [alpha.assetId] },
      { name: "aspect portrait", input: { aspect: ["portrait"] }, expected: [beta.assetId] },
      { name: "aspect unknown", input: { aspect: ["unknown"] }, expected: [delta.assetId] },
      { name: "created from", input: { createdFrom: "2026-08-03T18:00:00.000Z" }, expected: [delta.assetId] },
      { name: "created to", input: { createdTo: "2026-08-02T18:00:00.000Z" }, expected: [beta.assetId, alpha.assetId] },
      { name: "q negative", input: { q: `missing${marker}` }, expected: [] },
      { name: "tag negative", input: { tags: ["missing-tag"] }, expected: [] },
      { name: "entity negative", input: { entityIds: ["missing-entity"] }, expected: [] },
      { name: "provider negative", input: { provider: ["missing-provider"] }, expected: [] }
    ];

    for (const testCase of cases) {
      const query = assetListQuerySchema.parse({ q: marker, ...testCase.input });
      const [legacy, current] = await Promise.all([
        queryLegacyAssets(pool, ownerUserId, query),
        application().listAssets({ ownerUserId }, query)
      ]);
      const comparableCurrent = {
        ...current,
        assets: current.assets.map(({ assetId: _assetId, ...item }) => item),
        nextCursor: current.nextCursor ? "cursor" : null
      };
      expect(comparableCurrent, testCase.name).toEqual({
        ...legacy,
        nextCursor: legacy.nextCursor ? "cursor" : null
      });
      expect(current.assets.map((item) => item.assetId), testCase.name).toEqual(testCase.expected);
    }

    const base = assetListQuerySchema.parse({ q: marker });
    const facetResult = await application().listAssets({ ownerUserId }, base);
    expect(facetResult.facets).toEqual({
      origin: { generated: 1, imported: 1, uploaded: 1 },
      reviewStatus: { eligible: 1, restricted: 1, unreviewed: 1 },
      reuseScope: { campaign: 1, owner_library: 1, private: 1 },
      tags: { blue: 1, common: 2, green: 1, red: 1 }
    });

    const sortCases = [
      { sort: "newest" as const, expected: [delta.assetId, beta.assetId, alpha.assetId] },
      { sort: "oldest" as const, expected: [alpha.assetId, beta.assetId, delta.assetId] },
      { sort: "title" as const, expected: [alpha.assetId, beta.assetId, delta.assetId] },
      { sort: "most_used" as const, expected: [alpha.assetId, beta.assetId, delta.assetId] }
    ];
    for (const testCase of sortCases) {
      const query = assetListQuerySchema.parse({ q: marker, sort: testCase.sort, limit: 1 });
      const currentIds: string[] = [];
      const legacyIds: string[] = [];
      let currentCursor: string | undefined;
      let legacyCursor: string | undefined;
      do {
        const current = await application().listAssets({ ownerUserId }, { ...query, cursor: currentCursor });
        currentIds.push(...current.assets.map((item) => item.assetId));
        currentCursor = current.nextCursor ?? undefined;
        const legacy = await queryLegacyAssets(pool, ownerUserId, { ...query, cursor: legacyCursor });
        legacyIds.push(...legacy.assets.map((item) => item.id));
        legacyCursor = legacy.nextCursor ?? undefined;
      } while (currentCursor || legacyCursor);
      expect(currentIds, `${testCase.sort} current cursor`).toEqual(testCase.expected);
      expect(legacyIds, `${testCase.sort} legacy cursor`).toEqual(testCase.expected);
    }
  });

  it("rejects a cursor minted for another owner", async () => {
    const marker = `ownercursor${crypto.randomUUID().replaceAll("-", "")}`;
    await asset({ title: marker, createdAt: "2026-08-05T12:00:00.000Z" });
    await asset({ title: marker, createdAt: "2026-08-04T12:00:00.000Z" });
    const foreignOwner = crypto.randomUUID();
    await pool.query(
      "INSERT INTO users (id, display_name, status) VALUES ($1,'Cursor owner','active')",
      [foreignOwner]
    );
    const query = assetListQuerySchema.parse({ q: marker, limit: 1 });
    const first = await application().listAssets({ ownerUserId }, query);
    expect(first.nextCursor).toEqual(expect.any(String));
    await expect(application().listAssets(
      { ownerUserId: foreignOwner },
      { ...query, cursor: first.nextCursor! }
    )).rejects.toMatchObject({ statusCode: 400, code: "asset_cursor_invalid" });
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

  it("serializes an owner-scoped mutation on its deterministic advisory key before mutation row locks", async () => {
    const target = await asset();
    const idempotencyKey = toAssetMutationIdempotencyKey(`advisory-${crypto.randomUUID()}`);
    const keyHash = hash(idempotencyKey);
    const advisoryKey = `infinite-quest-nexus:asset-mutation:${ownerUserId}:asset_metadata_update:${keyHash}`;
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [advisoryKey]);
      let settled = false;
      const update = application().updateAssetMetadata(
        { ownerUserId, assetId: target.assetId },
        { expectedRevision: 1, title: "Advisory serialized", idempotencyKey },
      ).finally(() => { settled = true; });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      expect(settled).toBe(false);
      await blocker.query("COMMIT");
      await expect(update).resolves.toEqual({ assetId: target.assetId, metadataRevision: 2 });
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
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
    const worldKey = toAssetMutationIdempotencyKey(`world-select-${crypto.randomUUID()}`);
    const worldCommand = {
      assetId: target.assetId,
      idempotencyKey: worldKey
    };
    await expect(assets.selectWorldCover(worldScope, worldCommand))
      .resolves.toEqual({ assetId: target.assetId, selected: true });
    await expect(assets.selectWorldCover(worldScope, worldCommand))
      .resolves.toEqual({ assetId: target.assetId, selected: true });
    await expect(assets.selectWorldCover(worldScope, { assetId: null, idempotencyKey: worldKey }))
      .rejects.toMatchObject({ code: "asset_idempotency_mismatch" });
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
    const foreignAsset = await asset({ ownerUserId: foreignOwner });
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
    await expect(assets.selectWorldCover(
      { ownerUserId, worldId: fixture.worldId },
      { assetId: foreignAsset.assetId, idempotencyKey: toAssetMutationIdempotencyKey(`foreign-asset-${crypto.randomUUID()}`) }
    )).rejects.toMatchObject({ statusCode: 404, code: "asset_not_found" });
    const foreignLibrary = await assets.listAssets({ ownerUserId: foreignOwner }, assetListQuerySchema.parse({}));
    expect(foreignLibrary.assets.map((item) => item.assetId)).toEqual([foreignAsset.assetId]);
    expect(foreignLibrary.assets.some((item) => item.assetId === target.assetId)).toBe(false);
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
    const attachedLocator = await durableLocator(
      target,
      "asset_derivative",
      `derivatives/attached-${thumbnailHash}.webp`,
      64,
      thumbnailHash,
      false
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
    await expect(redemption.redeemStorageLocator(scope, attachedLocator as DatabaseIssuedStorageLocator))
      .resolves.toBeNull();
  });

  it("uses SKIP LOCKED to bypass a transaction-locked first job and derives owner from each claimed row", async () => {
    const foreignOwner = crypto.randomUUID();
    await pool.query("INSERT INTO users (id, display_name, status) VALUES ($1,'Backfill owner','active')", [foreignOwner]);
    const first = await asset({ width: null, height: null });
    const second = await asset({ ownerUserId: foreignOwner, width: null, height: null });
    await pool.query(
      `INSERT INTO asset_metadata_backfill_jobs (owner_user_id, asset_id, next_attempt_at, created_at)
       VALUES ($1,$2,'2000-01-01T00:00:00Z','2000-01-01T00:00:00Z'),
              ($3,$4,'2000-01-01T00:00:00Z','2000-01-02T00:00:00Z')`,
      [ownerUserId, first.assetId, foreignOwner, second.assetId]
    );
    const metadata = createPostgresAssetRepositories(pool).metadata;
    const lockClient = await pool.connect();
    try {
      await lockClient.query("BEGIN");
      await lockClient.query(
        "SELECT id FROM asset_metadata_backfill_jobs WHERE owner_user_id=$1 AND asset_id=$2 FOR UPDATE",
        [ownerUserId, first.assetId]
      );
      const skipped = await metadata.claimNextMetadataBackfill({ workerId: "worker-b", leaseSeconds: 30 });
      expect(skipped).toMatchObject({
        assetId: second.assetId,
        ownerUserId: foreignOwner,
        leaseOwner: "worker-b"
      });
      await lockClient.query("COMMIT");
    } catch (error) {
      await lockClient.query("ROLLBACK");
      throw error;
    } finally {
      lockClient.release();
    }
    const firstClaim = await metadata.claimNextMetadataBackfill({ workerId: "worker-a", leaseSeconds: 30 });
    expect(firstClaim).toMatchObject({
      assetId: first.assetId,
      ownerUserId,
      leaseOwner: "worker-a"
    });
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
      await expect(metadata.backfillMetadata(
        verificationClient as AssetTransactionContext,
        { ...claim, leaseId: crypto.randomUUID() }
      )).resolves.toEqual({ assetId: target.assetId, outcome: "lease_lost" });
      await expect(metadata.backfillMetadata(
        verificationClient as AssetTransactionContext,
        { ...claim, leaseOwner: "wrong-completing-worker" }
      )).resolves.toEqual({ assetId: target.assetId, outcome: "lease_lost" });
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

  it("keeps completion in the caller transaction and persists only allowlisted safe failure", async () => {
    const rollbackTarget = await asset();
    await addThumbnail(rollbackTarget.assetId);
    await pool.query(
      "INSERT INTO asset_metadata_backfill_jobs (owner_user_id, asset_id) VALUES ($1,$2)",
      [ownerUserId, rollbackTarget.assetId]
    );
    const metadata = createPostgresAssetRepositories(pool).metadata;
    const rollbackClaim = (await metadata.claimNextMetadataBackfill({
      workerId: "worker-rollback",
      leaseSeconds: 30
    }))!;
    const rollbackClient = await pool.connect();
    try {
      await rollbackClient.query("BEGIN");
      await expect(metadata.backfillMetadata(rollbackClient as AssetTransactionContext, rollbackClaim))
        .resolves.toEqual({ assetId: rollbackTarget.assetId, outcome: "updated" });
      await rollbackClient.query("ROLLBACK");
    } finally {
      rollbackClient.release();
    }
    await expect(pool.query(
      `SELECT status, lease_id, lease_owner, work_version
         FROM asset_metadata_backfill_jobs
        WHERE owner_user_id=$1 AND asset_id=$2`,
      [ownerUserId, rollbackTarget.assetId]
    )).resolves.toMatchObject({
      rows: [{
        status: "running",
        lease_id: rollbackClaim.leaseId,
        lease_owner: rollbackClaim.leaseOwner,
        work_version: rollbackClaim.workVersion
      }]
    });

    const failedTarget = await asset({ width: null, height: null });
    await pool.query(
      "INSERT INTO asset_metadata_backfill_jobs (owner_user_id, asset_id) VALUES ($1,$2)",
      [ownerUserId, failedTarget.assetId]
    );
    const failureClaim = (await metadata.claimNextMetadataBackfill({
      workerId: "worker-safe-failure",
      leaseSeconds: 30
    }))!;
    const failureClient = await pool.connect();
    try {
      await failureClient.query("BEGIN");
      await expect(metadata.backfillMetadata(failureClient as AssetTransactionContext, failureClaim))
        .resolves.toEqual({
          assetId: failedTarget.assetId,
          outcome: "safe_failure",
          diagnosticCode: "asset_metadata_unavailable"
        });
      await failureClient.query("COMMIT");
    } catch (error) {
      await failureClient.query("ROLLBACK");
      throw error;
    } finally {
      failureClient.release();
    }
    await expect(pool.query(
      `SELECT status, diagnostic_code, lease_id, lease_owner
         FROM asset_metadata_backfill_jobs
        WHERE owner_user_id=$1 AND asset_id=$2`,
      [ownerUserId, failedTarget.assetId]
    )).resolves.toMatchObject({
      rows: [{
        status: "failed",
        diagnostic_code: "asset_metadata_unavailable",
        lease_id: null,
        lease_owner: null
      }]
    });
  });
});
