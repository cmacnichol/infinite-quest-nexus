import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  bindPrivateNormalizedAssetPublicationRequest,
  type PrivateNormalizedAssetFinalizationHandle,
} from "../../packages/application/src/assets/private-normalized-asset-publication.js";
import { bindPrivateBoundedStreamLimits } from "../../packages/application/src/assets/private-secure-storage.js";
import { toAssetMutationIdempotencyKey } from "../../packages/application/src/assets/types.js";
import type { PortableStagedInput } from "../../packages/application/src/imports/types.js";
import { canonicalizeWorldContent } from "../../packages/contracts/src/world-library.js";
import type { RuntimeConfig } from "../../packages/database/src/config.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import { createPostgresDurableFilesystemRepository } from "../../packages/database/src/durable-filesystem-repository.js";
import { createPostgresWorldRepositoryAdapters } from "../../packages/database/src/world-repository.js";
import { convertInfiniteWorldsWorld } from "../../packages/domain/src/infinite-worlds.js";
import { sha256, stableStringify } from "../../packages/domain/src/text.js";
import { persistOriginalImage } from "../legacy-api/src/asset-service.js";
import type { InfiniteWorldsApiProviders } from "../legacy-api/src/infinite-worlds-import-service.js";
import { createPrivateAssetMaintenanceComposition } from "../../services/runtime/src/private-asset-maintenance-composition.js";
import { createPrivateAssetMetadataBackfillComposition } from "../../services/runtime/src/private-asset-metadata-backfill-composition.js";
import { createAssetImportStorageComposition } from "../../services/runtime/src/asset-import-composition.js";
import { createPrivateFilesystemRecoveryComposition } from "../../services/runtime/src/private-filesystem-recovery-composition.js";
import { createPortableImportExportComposition } from "../../services/runtime/src/portable-import-export-composition.js";
import { buildServer } from "../../services/api/src/server.js";
import { runWorker } from "../../services/worker/src/worker.js";
import { serverOptions } from "../helpers/build-server-options.js";
import { createProvider } from "../helpers/provider-application-fixtures.js";
import {
  createApiIllustrationApplication,
  createApiMemoryApplication,
  createApiWorldCampaignApplication,
  createWorkerGenerationApplication,
  createWorkerIllustrationApplication,
  createWorkerMemoryApplication,
} from "../helpers/runtime-application-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const credentialSecret = "task-14e3f-production-composed-parity";

function config(assetStorageRoot: string, role: RuntimeConfig["role"] = "all"): RuntimeConfig {
  return {
    role,
    host: "127.0.0.1",
    port: 8080,
    databaseUrl: databaseUrl!,
    databaseMaxConnections: 4,
    migrationDirectory: resolve("database/migrations"),
    migrationWaitSeconds: 10,
    allowMaintenanceMigrations: false,
    workerPollIntervalMs: 10,
    workerLeaseSeconds: 30,
    workerGenerationConcurrency: 1,
    legacyWebRoot: resolve("apps/web/public"),
    nextWebRoot: resolve("apps/web-next"),
    assetStorageDriver: "filesystem",
    assetStorageRoot,
    archiveStorageRoot: assetStorageRoot,
    archivePreviewTtlSeconds: 1_800,
    systemArchiveArtifactTtlSeconds: 86_400,
    campaignArchiveLimits: {
      maxCompressedBytes: 10 * 1024 * 1024,
      maxUncompressedBytes: 50 * 1024 * 1024,
      maxEntries: 1_000,
      maxExpansionRatio: 100,
      maxManifestBytes: 1024 * 1024,
      maxJsonEntryBytes: 5 * 1024 * 1024,
      maxOriginalImageBytes: 25 * 1024 * 1024,
    },
    systemArchiveLimits: {
      maxCompressedBytes: 10 * 1024 * 1024,
      maxUncompressedBytes: 50 * 1024 * 1024,
      maxEntries: 1_000,
      maxExpansionRatio: 100,
      maxManifestBytes: 1024 * 1024,
      maxJsonEntryBytes: 5 * 1024 * 1024,
      maxOriginalImageBytes: 25 * 1024 * 1024,
    },
    credentialEncryptionKey: credentialSecret,
    security: {
      corsAllowedOrigins: [],
      providerNetworkAllowlist: ["localhost", "127.0.0.0/8", "::1/128"],
      cspImageAllowedOrigins: [],
      apiDefaultBodyLimitBytes: 1_048_576,
      apiImportBodyLimitBytes: 16_777_216,
      apiAssetBodyLimitBytes: 33_554_432,
      apiRateLimitWindowSeconds: 60,
      apiRateLimitProviderRequests: 10,
      apiRateLimitGenerationRequests: 12,
      apiRateLimitImportRequests: 4,
      apiConcurrencyProviderRequests: 2,
      apiConcurrencyImportRequests: 1,
      trustProxyHops: 0,
    },
  };
}

function normalizedRequest(
  ownerUserId: string,
  label: string,
  bytes: Uint8Array,
  idempotencyKey = toAssetMutationIdempotencyKey(`e3f-race-${label}-${crypto.randomUUID()}`),
  importOperationId = crypto.randomUUID(),
) {
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  return bindPrivateNormalizedAssetPublicationRequest({
    owner: { ownerUserId },
    idempotencyKey,
    original: {
      bytes,
      mimeType: "image/png",
      byteLength: bytes.byteLength,
      contentHash,
      technicalMetadata: {
        state: "verified",
        pixelWidth: 4,
        pixelHeight: 4,
        format: "png",
        pages: 1,
      },
    },
    derivatives: [],
    requestedLibrary: {
      title: `E3f ${label}`,
      caption: "",
      notes: "",
      tags: ["e3f"],
      origin: "imported",
      reviewStatus: "eligible",
      reuseScope: "owner_library",
      automaticReuseEnabled: true,
      contentCategories: ["fantasy"],
      favorite: false,
    },
    sourceRecords: [{
      sourceKind: "campaign_zip",
      sourceAssetId: label,
      sourceRecordId: null,
      sourceKey: null,
      requestedLibrary: {
        title: `E3f ${label}`,
        caption: "",
        notes: "",
        tags: ["e3f"],
        origin: "imported",
        reviewStatus: "eligible",
        reuseScope: "owner_library",
        automaticReuseEnabled: true,
        contentCategories: ["fantasy"],
        favorite: false,
      },
      bindingIntentKeys: [],
    }],
    provenance: { kind: "import", importKind: "campaign_zip", importOperationId },
    contextIntents: [],
    referencePolicy: { mode: "omit" },
  });
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const values: Uint8Array[] = [];
  for await (const value of chunks) values.push(value);
  return Buffer.concat(values.map((value) => Buffer.from(value)));
}

async function retireExistingMetadataBackfillCandidates(pool: DatabasePool): Promise<void> {
  await pool.query(
    `INSERT INTO asset_metadata_backfill_jobs (
       owner_user_id,asset_id,status,diagnostic_code,attempts,next_attempt_at
     )
     SELECT asset.owner_user_id,asset.id,'failed','asset_metadata_unavailable',3,clock_timestamp()
       FROM assets asset
      WHERE asset.pixel_width IS NULL OR asset.pixel_height IS NULL OR NOT EXISTS (
        SELECT 1 FROM asset_derivatives derivative
         WHERE derivative.owner_user_id=asset.owner_user_id AND derivative.source_asset_id=asset.id
           AND derivative.derivative_kind='thumbnail' AND derivative.transform_version=1
      )
     ON CONFLICT (asset_id,owner_user_id) DO UPDATE
       SET status='failed',diagnostic_code='asset_metadata_unavailable',attempts=3,
           lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL,completed_at=NULL,
           updated_at=clock_timestamp()`,
  );
}

async function publishNormalizedFixture(
  pool: DatabasePool,
  root: string,
  ownerUserId: string,
  label: string,
  bytes: Uint8Array,
): Promise<string> {
  const publicationModule = await import("../../services/runtime/src/normalized-asset-publication-composition.js");
  const composition = await publicationModule.createPrivateNormalizedAssetPublicationComposition(
    pool,
    { archiveRoot: root, assetRoot: root },
  );
  try {
    const reservation = await composition.publication.reserve({
      request: normalizedRequest(ownerUserId, label, bytes),
      leaseOwner: `e3f-fixture-${label}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const attached = await withTransaction(pool, async (client) => (
      composition.publication.attachInTransaction(client, reservation, async () => ({ contexts: [], references: [] }))
    ));
    await composition.publication.finalize(attached.finalization);
    return attached.result.assetId;
  } finally {
    await composition.close();
  }
}

function expectSuppliedPoolDrained(observedPool: Readonly<{
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}>, maximum: number): void {
  expect(observedPool.waitingCount).toBe(0);
  expect(observedPool.idleCount).toBe(observedPool.totalCount);
  expect(observedPool.totalCount).toBeLessThanOrEqual(maximum);
}

function multipartBody(parts: readonly Readonly<{ name: string; value: string | Buffer; filename?: string; contentType?: string }>[]) {
  const boundary = `----infinitequest-e3f-${crypto.randomUUID()}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, "utf8"));
    chunks.push(Buffer.from(part.filename
      ? `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.contentType ?? "application/octet-stream"}\r\n\r\n`
      : `Content-Disposition: form-data; name="${part.name}"\r\n\r\n`, "utf8"));
    chunks.push(typeof part.value === "string" ? Buffer.from(part.value, "utf8") : part.value, Buffer.from("\r\n", "utf8"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return Object.freeze({ payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` });
}

function portableWorldRequest(title: string, sourceName = `${title}.json`) {
  return {
    sourceName,
    worldExport: {
      format: "infinite-quest-world",
      formatVersion: 1,
      title,
      content: {
        world: {
          title,
          genre: "Fantasy",
          tone: "Hopeful",
          premise: "A route-level portable world fixture.",
          backgroundStory: "An old road waits beyond the city gate.",
          firstAction: "Follow the road.",
          rules: "Keep accepted canon persistent.",
        },
      },
    },
  } as const;
}

function deterministicCyoaProviders(): InfiniteWorldsApiProviders {
  return {
    async generateCyoaWorld() {
      const generated = convertInfiniteWorldsWorld({
        title: `Task 14e3f generated CYOA ${crypto.randomUUID()}`,
        background: "A deterministic route-level progress fixture.",
        possibleCharacters: [{ name: "Progress Explorer", description: "Follows the route contract." }],
      });
      return { title: generated.title, content: generated.content };
    },
    diagnoseWorldGenerationFailure(error: unknown) {
      return { message: error instanceof Error ? error.message : "Deterministic CYOA generation failed." };
    },
  } as unknown as InfiniteWorldsApiProviders;
}

async function campaignZipWithImage(
  label: string,
  sourceAssetId: string,
  image: Uint8Array,
): Promise<Uint8Array> {
  const archive = new JSZip();
  archive.file("campaign.json", JSON.stringify({
    format: "infinite-quest-campaign",
    formatVersion: 1,
    campaign: { title: `${label} campaign` },
    world: { title: `${label} world`, character: "Hero\nA verifier" },
    turns: [{
      id: `${label}-turn`,
      action: "Look",
      narration: "Hero enters the recovery hall.",
      imageUrl: `/api/v1/assets/${sourceAssetId}`,
    }],
  }));
  archive.file(`assets/${sourceAssetId}.png`, image);
  return archive.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

integration("Task 14e3f active production-composed parity", () => {
  let pool: DatabasePool;
  let root = "";
  let ownerUserId = "";
  let ownedAssetId = "";
  let foreignAssetId = "";
  let legacyCampaignId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    root = await mkdtemp(join(tmpdir(), "infinitequest-e3f-production-"));
    ownerUserId = await initialOwnerId(pool);
    const bytes = await sharp({
      create: {
        width: 4,
        height: 4,
        channels: 4,
        background: `#${crypto.randomUUID().replaceAll("-", "").slice(0, 6)}`,
      },
    }).png().toBuffer();
    ownedAssetId = await publishNormalizedFixture(pool, root, ownerUserId, "route-owned", bytes);
    const foreignUserId = crypto.randomUUID();
    await pool.query("INSERT INTO users (id, display_name) VALUES ($1, 'Task e3f foreign owner')", [foreignUserId]);
    const foreignBytes = await sharp({
      create: {
        width: 4,
        height: 4,
        channels: 4,
        background: `#${crypto.randomUUID().replaceAll("-", "").slice(0, 6)}`,
      },
    }).png().toBuffer();
    foreignAssetId = await publishNormalizedFixture(pool, root, foreignUserId, "route-foreign", foreignBytes);
  });

  afterAll(async () => {
    await pool?.end();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("keeps the registered active import/archive/asset/illustration surface and resolves ownership on the server", async () => {
    const app = await buildServer(serverOptions({ config: config(root, "api"), pool }));
    try {
      await expect(app.inject({ method: "GET", url: "/health/live" })).resolves.toMatchObject({
        statusCode: 200,
        json: expect.any(Function),
      });
      const health = await app.inject({ method: "GET", url: "/health/live" });
      expect(health.json()).toEqual({ status: "ok", role: "api" });
      const expectedRoutes = [
        ["POST", "/api/v1/imports/legacy-story/preview"],
        ["POST", "/api/v1/imports/legacy-story"],
        ["POST", "/api/v1/imports/campaign-archive/preview"],
        ["POST", "/api/v1/imports/campaign-archive"],
        ["GET", "/api/v1/campaigns/:campaignId/export"],
        ["POST", "/api/v1/imports/world/preview"],
        ["POST", "/api/v1/imports/world"],
        ["POST", "/api/v1/imports/infinite-worlds/preview"],
        ["POST", "/api/v1/imports/infinite-worlds"],
        ["GET", "/api/v1/imports/progress"],
        ["GET", "/api/v1/assets/:assetId"],
        ["GET", "/api/v1/assets/:assetId/thumbnail"],
        ["GET", "/api/v1/assets"],
        ["GET", "/api/v1/assets/facets"],
        ["PATCH", "/api/v1/assets/:assetId/library-metadata"],
        ["POST", "/api/v1/worlds/:worldId/cover"],
        ["PUT", "/api/v1/worlds/:worldId/cover-asset"],
        ["GET", "/api/v1/campaigns/:campaignId/illustration-config"],
        ["PUT", "/api/v1/campaigns/:campaignId/illustration-config"],
        ["POST", "/api/v1/campaigns/:campaignId/illustration-backfill/preview"],
        ["POST", "/api/v1/campaigns/:campaignId/illustration-backfill"],
        ["POST", "/api/v1/turns/:turnId/illustrations"],
        ["POST", "/api/v1/turns/:turnId/illustration-segments"],
        ["POST", "/api/v1/illustration-segments/:segmentId/images"],
        ["DELETE", "/api/v1/illustration-segments/:segmentId/images/:variantIndex"],
        ["GET", "/api/v1/image-jobs/:jobId"],
        ["POST", "/api/v1/image-jobs/:jobId/retry"],
      ] as const;
      for (const [method, url] of expectedRoutes) {
        expect(app.hasRoute({ method, url })).toBe(true);
      }

      const owned = await app.inject({
        method: "GET",
        url: `/api/v1/assets/${ownedAssetId}`,
        headers: { "x-user-id": crypto.randomUUID(), "x-owner-user-id": crypto.randomUUID() },
      });
      expect(owned.statusCode).toBe(200);
      expect(owned.headers["content-type"]).toContain("image/png");
      expect(owned.headers["cache-control"]).toBe("private, max-age=31536000, immutable");

      const foreign = await app.inject({
        method: "GET",
        url: `/api/v1/assets/${foreignAssetId}`,
        headers: { "x-user-id": ownerUserId },
      });
      expect(foreign.statusCode).toBe(404);
      expect(JSON.stringify(foreign.json())).not.toMatch(/storage_path|private|filesystem|token|bearer/u);
    } finally {
      await app.close();
    }
    expectSuppliedPoolDrained(
      pool as unknown as Readonly<{ totalCount: number; idleCount: number; waitingCount: number }>,
      config(root, "api").databaseMaxConnections,
    );
  });

  it("keeps the active legacy preview, commit, and duplicate lifecycle on its public Fastify contract", async () => {
    const story = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    story.world.title = `Task 14e3f route lifecycle ${crypto.randomUUID()}`;
    const request = { sourceName: `task-14e3f-${crypto.randomUUID()}.story`, story };
    const app = await buildServer(serverOptions({
      config: config(root),
      pool,
      worldCampaign: createApiWorldCampaignApplication(pool, { credentialSecret }),
    }));
    try {
      const preview = await app.inject({
        method: "POST",
        url: "/api/v1/imports/legacy-story/preview",
        payload: request,
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toMatchObject({ kind: "campaign", duplicate: false, valid: true });

      const committed = await app.inject({
        method: "POST",
        url: "/api/v1/imports/legacy-story",
        payload: request,
      });
      expect(committed.statusCode).toBe(201);
      expect(committed.json()).toMatchObject({ duplicate: false, campaignId: expect.any(String) });
      legacyCampaignId = committed.json().campaignId;

      const duplicate = await app.inject({
        method: "POST",
        url: "/api/v1/imports/legacy-story",
        payload: request,
      });
      expect(duplicate.statusCode).toBe(200);
      expect(duplicate.json()).toMatchObject({ duplicate: true, campaignId: committed.json().campaignId });

      for (const url of ["/api/v1/imports/legacy-story/preview", "/api/v1/imports/legacy-story"]) {
        const malformed = await app.inject({
          method: "POST",
          url,
          payload: { sourceName: "malformed.story", story: { world: { title: "Malformed" }, turns: "not-an-array" } },
        });
        expect(malformed.statusCode).toBe(400);
        expect(JSON.stringify(malformed.json())).not.toMatch(new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
      }
    } finally {
      await app.close();
    }
  });

  it("keeps World JSON preview, commit, replay, and altered-input identity on the active Fastify contract", async () => {
    const title = `Task 14e3f World JSON ${crypto.randomUUID()}`;
    const request = portableWorldRequest(title, `task-14e3f-world-${crypto.randomUUID()}.json`);
    const app = await buildServer(serverOptions({
      config: config(root),
      pool,
      worldCampaign: createApiWorldCampaignApplication(pool, { credentialSecret }),
    }));
    try {
      const preview = await app.inject({
        method: "POST",
        url: "/api/v1/imports/world/preview",
        headers: { "x-user-id": crypto.randomUUID(), "x-owner-user-id": crypto.randomUUID() },
        payload: { ...request, ownerUserId: crypto.randomUUID(), sourceInstallationId: crypto.randomUUID() },
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toMatchObject({
        kind: "world",
        title,
        duplicate: false,
        existingWorldId: null,
        counts: { entities: 0, relationships: 0, triggers: 0 },
      });

      const committed = await app.inject({ method: "POST", url: "/api/v1/imports/world", payload: request });
      expect(committed.statusCode).toBe(201);
      expect(committed.json()).toMatchObject({
        importId: expect.any(String),
        worldId: expect.any(String),
        worldVersionId: expect.any(String),
        duplicate: false,
      });

      const replay = await app.inject({
        method: "POST",
        url: "/api/v1/imports/world",
        payload: { ...request, previewToken: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() },
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual({ ...committed.json(), duplicate: true });

      const altered = {
        ...request,
        worldExport: {
          ...request.worldExport,
          content: {
            ...request.worldExport.content,
            world: {
              ...request.worldExport.content.world,
              backgroundStory: "The altered road now ends at a sealed observatory.",
            },
          },
        },
        previewToken: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
      };
      const alteredCommit = await app.inject({ method: "POST", url: "/api/v1/imports/world", payload: altered });
      expect(alteredCommit.statusCode).toBe(201);
      expect(alteredCommit.json()).toMatchObject({ duplicate: false });
      expect(alteredCommit.json().worldId).not.toBe(committed.json().worldId);
      await expect(pool.query<{ worlds: string; imports: string }>(
        `SELECT
           (SELECT count(*)::text FROM worlds WHERE owner_user_id=$1 AND id=ANY($2::uuid[])) AS worlds,
           (SELECT count(*)::text FROM imports WHERE owner_user_id=$1 AND id=ANY($3::uuid[])) AS imports`,
        [ownerUserId, [committed.json().worldId, alteredCommit.json().worldId], [committed.json().importId, alteredCommit.json().importId]],
      )).resolves.toMatchObject({ rows: [{ worlds: "2", imports: "2" }] });
    } finally {
      await app.close();
    }
  });

  it("keeps World JSON foreign fingerprints isolated and forced commit failures atomic", async () => {
    const foreignOwnerId = crypto.randomUUID();
    await pool.query("INSERT INTO users (id,display_name) VALUES ($1,'Task e3f World JSON foreign owner')", [foreignOwnerId]);
    const foreignRequest = portableWorldRequest(
      `Task 14e3f foreign fingerprint ${crypto.randomUUID()}`,
      `task-14e3f-foreign-${crypto.randomUUID()}.json`,
    );
    const foreignContent = canonicalizeWorldContent(foreignRequest.worldExport.content);
    const foreignSourceHash = `world:${sha256(stableStringify(foreignContent))}`;
    const foreignWorld = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title,status) VALUES ($1,$2,'active') RETURNING id",
      [foreignOwnerId, foreignRequest.worldExport.title],
    );
    const foreignVersion = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id,owner_user_id,version_number,content,source_hash,release_notes,created_from_revision)
       VALUES ($1,$2,1,$3,$4,'Foreign fixture',1) RETURNING id`,
      [foreignWorld.rows[0]!.id, foreignOwnerId, JSON.stringify(foreignContent), sha256(stableStringify(foreignContent))],
    );
    await pool.query(
      `INSERT INTO imports (owner_user_id,source_type,source_name,source_hash,status,world_id,world_version_id,completed_at)
       VALUES ($1,'world_json',$2,$3,'completed',$4,$5,now())`,
      [foreignOwnerId, foreignRequest.sourceName, foreignSourceHash, foreignWorld.rows[0]!.id, foreignVersion.rows[0]!.id],
    );

    const rollbackTitle = `Task 14e3f rollback ${crypto.randomUUID()}`;
    const rollbackRequest = portableWorldRequest(rollbackTitle, `task-14e3f-rollback-${crypto.randomUUID()}.json`);
    const triggerName = `task_14e3f_world_rollback_${crypto.randomUUID().replaceAll("-", "")}`;
    const functionName = `${triggerName}_fn`;
    await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM worlds WHERE id=NEW.world_id AND title LIKE 'Task 14e3f rollback %') THEN
          RAISE EXCEPTION 'task 14e3f forced World JSON failure';
        END IF;
        RETURN NEW;
      END
    $$`);
    await pool.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON world_versions FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);

    const app = await buildServer(serverOptions({
      config: config(root),
      pool,
      worldCampaign: createApiWorldCampaignApplication(pool, { credentialSecret }),
    }));
    try {
      const foreignPreview = await app.inject({ method: "POST", url: "/api/v1/imports/world/preview", payload: foreignRequest });
      expect(foreignPreview.statusCode).toBe(200);
      expect(foreignPreview.json()).toMatchObject({ duplicate: false, existingWorldId: null });
      const ownCommit = await app.inject({
        method: "POST",
        url: "/api/v1/imports/world",
        headers: { "x-user-id": foreignOwnerId, "x-owner-user-id": foreignOwnerId },
        payload: { ...foreignRequest, ownerUserId: foreignOwnerId },
      });
      expect(ownCommit.statusCode).toBe(201);
      expect(ownCommit.json()).toMatchObject({ duplicate: false });
      expect(ownCommit.json().worldId).not.toBe(foreignWorld.rows[0]!.id);
      await expect(pool.query<{ owner_user_id: string }>("SELECT owner_user_id FROM worlds WHERE id=$1", [ownCommit.json().worldId]))
        .resolves.toMatchObject({ rows: [{ owner_user_id: ownerUserId }] });
      const foreignRead = await app.inject({ method: "GET", url: `/api/v1/worlds/${foreignWorld.rows[0]!.id}` });
      expect(foreignRead.statusCode).toBe(404);

      const failed = await app.inject({ method: "POST", url: "/api/v1/imports/world", payload: rollbackRequest });
      expect(failed.statusCode).toBe(500);
      expect(JSON.stringify(failed.json())).not.toMatch(/task 14e3f forced|world_versions|storage_path|filesystem|credential|bearer/iu);
      await expect(pool.query<{ worlds: string; imports: string }>(
        `SELECT
           (SELECT count(*)::text FROM worlds WHERE owner_user_id=$1 AND title=$2) AS worlds,
           (SELECT count(*)::text FROM imports WHERE owner_user_id=$1 AND source_name=$3) AS imports`,
        [ownerUserId, rollbackTitle, rollbackRequest.sourceName],
      )).resolves.toMatchObject({ rows: [{ worlds: "0", imports: "0" }] });
    } finally {
      await app.close();
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON world_versions`);
      await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }
  });

  it("exercises the active import progress route through real Infinite Worlds work and safe misses", async () => {
    const sourceName = `task-14e3f-progress-${crypto.randomUUID()}.json`;
    const sourceText = await readFile(resolve("tests/fixtures/cyoa_writing_com_sample.json"), "utf8");
    const progressKey = `${sourceName}:${sourceText.length}`;
    const app = await buildServer(serverOptions({
      config: config(root),
      pool,
      worldCampaign: createApiWorldCampaignApplication(pool, { credentialSecret }),
      infiniteWorldsProviders: deterministicCyoaProviders(),
    }));
    try {
      const imported = await app.inject({
        method: "POST",
        url: "/api/v1/imports/infinite-worlds",
        payload: {
          sourceName,
          sourceText,
          sourceKind: "cyoa_json",
          selectedCharacterIndex: 0,
          enrichFinalTurn: false,
          providerProfileId: crypto.randomUUID(),
        },
      });
      expect(imported.statusCode).toBe(201);

      const progress = await app.inject({
        method: "GET",
        url: `/api/v1/imports/progress?key=${encodeURIComponent(progressKey)}`,
        headers: { "x-user-id": crypto.randomUUID(), "x-owner-user-id": crypto.randomUUID() },
      });
      expect(progress.statusCode).toBe(200);
      expect(progress.json()).toMatchObject({ status: "completed", phase: "completed", progressPercent: 100 });
      expect(JSON.stringify(progress.json())).not.toMatch(/storage_path|filesystem|credential|bearer|private/iu);

      const foreignSafeMiss = await app.inject({
        method: "GET",
        url: `/api/v1/imports/progress?key=${encodeURIComponent(`foreign:${crypto.randomUUID()}`)}&owner_user_id=${crypto.randomUUID()}`,
        headers: { "x-user-id": crypto.randomUUID() },
      });
      expect(foreignSafeMiss.statusCode).toBe(404);
      expect(foreignSafeMiss.json()).toEqual({ error: "No active import found for the provided key." });
      expect(JSON.stringify(foreignSafeMiss.json())).not.toMatch(/storage_path|filesystem|credential|bearer|private/iu);
    } finally {
      await app.close();
    }
  });

  it("keeps active Campaign Archive preview-token ownership, replay, and rollback errors fail-closed", async () => {
    expect(legacyCampaignId).not.toBe("");
    const app = await buildServer(serverOptions({ config: config(root), pool }));
    const previewArchive = async () => {
      const exported = await app.inject({ method: "GET", url: `/api/v1/campaigns/${legacyCampaignId}/export` });
      expect(exported.statusCode).toBe(200);
      const upload = multipartBody([
        { name: "file", filename: "e3f-campaign.zip", value: exported.rawPayload },
        { name: "destination", value: JSON.stringify({ kind: "embedded" }) },
      ]);
      const preview = await app.inject({
        method: "POST",
        url: "/api/v1/imports/campaign-archive/preview",
        headers: { "content-type": upload.contentType },
        payload: upload.payload,
      });
      expect(preview.statusCode).toBe(200);
      return preview.json() as { previewToken: string };
    };
    const previewForeignArchive = async (foreignOwnerId: string) => {
      const exported = await app.inject({ method: "GET", url: `/api/v1/campaigns/${legacyCampaignId}/export` });
      expect(exported.statusCode).toBe(200);
      const portable = await createPortableImportExportComposition({
        pool,
        roots: { archiveRoot: root, assetRoot: root },
        worlds: createPostgresWorldRepositoryAdapters(pool, {
          memory: { async autoEnableCampaignEmbedding() { return { enabled: false }; } },
        }).worlds,
        leaseOwner: `e3f-foreign-preview-${crypto.randomUUID()}`,
        leaseSeconds: 30,
        provider: {
          async convertTemplate() { throw new Error("provider_not_expected"); },
        },
        targets: {
          async readTargetWorldVersion() { return null; },
        },
        exports: {
          async buildCampaignArchive() { throw new Error("export_not_expected"); },
          async buildWorldJson() { throw new Error("export_not_expected"); },
        },
      });
      try {
        const staged = await portable.stageInput({
          owner: { ownerUserId: foreignOwnerId },
          operationScopeId: `e3f-foreign-preview-${crypto.randomUUID()}`,
          leaseOwner: `e3f-foreign-preview-${crypto.randomUUID()}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          byteLength: exported.rawPayload.byteLength,
          source: [exported.rawPayload],
        });
        const preview = await portable.previewCampaignZip({
          ownerUserId: foreignOwnerId,
          stagedInput: staged.stagedInput,
          kind: "campaign_zip",
          destination: { kind: "embedded", operation: "create_world" },
        });
        return { previewToken: preview.previewHandle.token };
      } finally {
        await portable.close();
      }
    };
    const safeFailure = (response: Awaited<ReturnType<typeof app.inject>>, statusCode = 400) => {
      expect(response.statusCode).toBe(statusCode);
      expect(JSON.stringify(response.json())).not.toMatch(/staged_archive_path|storage_path|filesystem|credential|bearer/u);
      expect(JSON.stringify(response.json())).not.toContain(root);
    };
    try {
      const foreignOwnerId = crypto.randomUUID();
      await pool.query("INSERT INTO users (id,display_name) VALUES ($1,'Task e3f archive foreign owner')", [foreignOwnerId]);
      const foreign = await previewForeignArchive(foreignOwnerId);
      safeFailure(await app.inject({
        method: "POST",
        url: "/api/v1/imports/campaign-archive",
        payload: { previewToken: foreign.previewToken, destination: { kind: "embedded" } },
      }), 404);

      const replay = await previewArchive();
      const committed = await app.inject({
        method: "POST",
        url: "/api/v1/imports/campaign-archive",
        payload: { previewToken: replay.previewToken, destination: { kind: "embedded" } },
      });
      expect([200, 201]).toContain(committed.statusCode);
      safeFailure(await app.inject({
        method: "POST",
        url: "/api/v1/imports/campaign-archive",
        payload: { previewToken: replay.previewToken, destination: { kind: "embedded" } },
      }));

      await pool.query(
        "UPDATE campaigns SET title=$2,updated_at=clock_timestamp() WHERE id=$1 AND owner_user_id=$3",
        [legacyCampaignId, `Task e3f rollback ${crypto.randomUUID()}`, ownerUserId],
      );
      const rollback = await previewArchive();
      const rollbackHash = createHash("sha256").update(rollback.previewToken, "utf8").digest("hex");
      const stagedPath = await pool.query<{ relative_path: string }>(
        `SELECT descriptor.relative_path
           FROM portable_import_operations operation
           JOIN portable_staged_inputs staged
             ON staged.id=operation.staged_input_id
            AND staged.owner_user_id=operation.owner_user_id
           JOIN durable_filesystem_descriptors descriptor
             ON descriptor.operation_id=staged.filesystem_operation_id
            AND descriptor.descriptor_role='delivery'
          WHERE operation.preview_token_hash=$1`,
        [rollbackHash],
      );
      expect(stagedPath.rows).toHaveLength(1);
      await rm(join(root, stagedPath.rows[0]!.relative_path), { force: true });
      safeFailure(await app.inject({
        method: "POST",
        url: "/api/v1/imports/campaign-archive",
        payload: { previewToken: rollback.previewToken, destination: { kind: "embedded" } },
      }));
      await expect(pool.query(
        "SELECT status FROM portable_import_operations WHERE preview_token_hash=$1",
        [rollbackHash],
      )).resolves.toMatchObject({ rows: [{ status: "failed" }] });
    } finally {
      await app.close();
    }
  });

  it("cleans the active export artifact after a real network client abort without retaining a pool client", async () => {
    expect(legacyCampaignId).not.toBe("");
    const app = await buildServer(serverOptions({ config: config(root, "api"), pool }));
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const endpoint = new URL(address);
      await new Promise<void>((resolveAbort, rejectAbort) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          if (error) rejectAbort(error);
          else resolveAbort();
        };
        const request = httpRequest({
          host: endpoint.hostname,
          port: Number(endpoint.port),
          method: "GET",
          path: `/api/v1/campaigns/${legacyCampaignId}/export`,
        }, (response) => {
          expect(response.statusCode).toBe(200);
          expect(response.headers["content-type"]).toContain("application/zip");
          expect(response.headers["cache-control"]).toBe("no-store");
          response.resume();
          request.destroy();
        });
        request.once("close", () => finish());
        request.once("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "ECONNRESET") finish();
          else finish(error);
        });
        request.end();
      });
      await vi.waitFor(async () => {
        const artifacts = await readdir(join(root, "artifacts")).catch(() => [] as string[]);
        expect(artifacts).toEqual([]);
      }, { timeout: 5_000, interval: 25 });
    } finally {
      await app.close();
    }
    expectSuppliedPoolDrained(
      pool as unknown as Readonly<{ totalCount: number; idleCount: number; waitingCount: number }>,
      config(root, "api").databaseMaxConnections,
    );
  });

  it("finalizes standalone private recovery exactly once across restart while the active route keeps delivery authoritative", async () => {
    const bytes = await sharp({ create: { width: 6, height: 5, channels: 4, background: "#16a34a" } }).png().toBuffer();
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const relativePath = `${contentHash.slice(0, 2)}/${contentHash}.png`;
    await mkdir(join(root, contentHash.slice(0, 2)), { recursive: true });
    await writeFile(join(root, relativePath), bytes, { flag: "wx" });
    const asset = await pool.query<{ id: string }>(
      `INSERT INTO assets (owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length)
       VALUES ($1,$2,'filesystem',$3,'image/png',$4) RETURNING id`,
      [ownerUserId, contentHash, relativePath, bytes.byteLength],
    );
    const durable = createPostgresDurableFilesystemRepository(pool);
    const reserved = await durable.journal.reserve({
      resourceKind: "asset",
      ownerUserId,
      assetId: asset.rows[0]!.id,
    }, {
      purpose: "asset_original",
      leaseOwner: "e3f-recovery-publisher",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const file = await stat(join(root, relativePath), { bigint: true });
    const descriptor = Object.freeze({
      relativePath,
      identity: Object.freeze({
        deviceId: file.dev.toString(),
        fileId: file.ino.toString(),
        changeToken: `${file.mtimeNs}:${file.ctimeNs}`,
      }),
      contentHash,
      byteLength: bytes.byteLength,
    });
    const candidate = await durable.issuePublicationCandidate(reserved.operation, {
      deliveryRelativePath: relativePath,
      cleanupDescriptors: [descriptor],
    });
    await durable.completePublicationCandidate(reserved.operation, candidate, descriptor);
    await withTransaction(pool, async (client) => {
      await client.query(
        "UPDATE assets SET filesystem_operation_id=$2 WHERE id=$1 AND owner_user_id=$3",
        [asset.rows[0]!.id, reserved.operation.operationId, ownerUserId],
      );
      const attached = await durable.journal.attach(client, reserved.operation, candidate);
      expect(attached.outcome).toBe("attached");
    });
    await pool.query(
      "UPDATE durable_filesystem_operations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [reserved.operation.operationId],
    );
    const [recovered] = await durable.journal.recover({
      leaseOwner: "e3f-recovery-claim",
      leaseSeconds: 30,
      limit: 1,
      resourceKinds: ["asset"],
    });
    expect(recovered).toBeDefined();
    const renewed = await durable.journal.heartbeatRecoveryClaim(recovered!.claim, 30);
    expect(renewed).not.toBeNull();
    await expect(durable.journal.heartbeatRecoveryClaim(recovered!.claim, 30)).resolves.toBeNull();
    await expect(durable.journal.heartbeatRecoveryClaim({ ...renewed!, leaseOwner: "e3f-foreign" }, 30)).resolves.toBeNull();
    await pool.query(
      "UPDATE durable_filesystem_operations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [reserved.operation.operationId],
    );

    await pool.query(`
      CREATE FUNCTION e3f_fail_recovery_finalization_once() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.lifecycle='finalized' THEN RAISE EXCEPTION 'e3f injected finalization fault'; END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER e3f_fail_recovery_finalization_once_trigger
      BEFORE UPDATE ON durable_filesystem_operations
      FOR EACH ROW EXECUTE FUNCTION e3f_fail_recovery_finalization_once();
    `);
    const first = await createPrivateFilesystemRecoveryComposition(pool, { archiveRoot: root, assetRoot: root });
    try {
      await expect(first.executor.processAssetOne({ workerId: "e3f-recovery-first", leaseSeconds: 10, limit: 1 }))
        .resolves.toMatchObject({ claimed: 1, finalized: 0, cleaned: 0, recoverable: 1 });
    } finally {
      await first.close();
      await pool.query("DROP TRIGGER IF EXISTS e3f_fail_recovery_finalization_once_trigger ON durable_filesystem_operations");
      await pool.query("DROP FUNCTION IF EXISTS e3f_fail_recovery_finalization_once()");
    }
    expectSuppliedPoolDrained(
      pool as unknown as Readonly<{ totalCount: number; idleCount: number; waitingCount: number }>,
      config(root).databaseMaxConnections,
    );
    await expect(stat(join(root, relativePath))).resolves.toMatchObject({ size: bytes.byteLength });
    await pool.query(
      "UPDATE durable_filesystem_operations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [reserved.operation.operationId],
    );
    const fresh = await createPrivateFilesystemRecoveryComposition(pool, { archiveRoot: root, assetRoot: root });
    try {
      const freshResult = await fresh.executor.processAssetOne({ workerId: "e3f-recovery-fresh", leaseSeconds: 10, limit: 1 });
      expect(freshResult).toMatchObject({ claimed: 1, finalized: 1, cleaned: 0, recoverable: 0 });
    } finally {
      await fresh.close();
    }
    expectSuppliedPoolDrained(
      pool as unknown as Readonly<{ totalCount: number; idleCount: number; waitingCount: number }>,
      config(root).databaseMaxConnections,
    );
    await expect(pool.query(
      "SELECT lifecycle FROM durable_filesystem_operations WHERE id=$1",
      [reserved.operation.operationId],
    )).resolves.toMatchObject({ rows: [{ lifecycle: "finalized" }] });
    await expect(stat(join(root, relativePath))).resolves.toMatchObject({ size: bytes.byteLength });

    const app = await buildServer(serverOptions({ config: config(root), pool }));
    try {
      const delivery = await app.inject({ method: "GET", url: `/api/v1/assets/${asset.rows[0]!.id}` });
      expect(delivery.statusCode).toBe(200);
      expect(delivery.headers["content-type"]).toContain("image/png");
      expect(delivery.rawPayload).toEqual(bytes);
    } finally {
      await app.close();
    }
  });

  it("runs the unmodified default worker asset lane against a real stored original", async () => {
    await retireExistingMetadataBackfillCandidates(pool);
    const brokenAssetId = (await pool.query<{ id: string }>(
      `INSERT INTO assets (owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length,technical_metadata)
       VALUES ($1,$2,'filesystem',$3,'image/png',1,'{}'::jsonb) RETURNING id`,
      [ownerUserId, createHash("sha256").update(crypto.randomUUID()).digest("hex"), `missing/${crypto.randomUUID()}.png`],
    )).rows[0]!.id;
    const workerAssetId = (await withTransaction(pool, async (client) => persistOriginalImage(
      client,
      { root },
      ownerUserId,
      {
        bytes: await sharp({ create: { width: 8, height: 8, channels: 4, background: "#f97316" } }).png().toBuffer(),
        mimeType: "image/png",
        createThumbnail: false,
      },
    ))).id;
    const controller = new AbortController();
    const apiIllustration = createApiIllustrationApplication(pool, credentialSecret);
    const apiMemory = createApiMemoryApplication(pool, { credentialSecret });
    const worker = runWorker(pool, config(root, "worker"), controller.signal, {
      generation: createWorkerGenerationApplication(pool, credentialSecret, apiIllustration, apiMemory),
      illustration: createWorkerIllustrationApplication(pool, credentialSecret, { root }),
      memory: createWorkerMemoryApplication(pool, credentialSecret),
    });
    try {
      await vi.waitFor(async () => {
        const result = await pool.query<{
          count: string;
          job_status: string | null;
          diagnostic_code: string | null;
          attempts: number | null;
        }>(
          `SELECT count(*)::text AS count,
                  (SELECT status FROM asset_metadata_backfill_jobs
                    WHERE owner_user_id=$1 AND asset_id=$2) AS job_status,
                  (SELECT diagnostic_code FROM asset_metadata_backfill_jobs
                    WHERE owner_user_id=$1 AND asset_id=$2) AS diagnostic_code,
                  (SELECT attempts FROM asset_metadata_backfill_jobs
                    WHERE owner_user_id=$1 AND asset_id=$2) AS attempts
             FROM asset_derivatives
            WHERE owner_user_id=$1 AND source_asset_id=$2 AND derivative_kind='thumbnail'`,
          [ownerUserId, workerAssetId],
        );
        expect(result.rows[0]).toMatchObject({ count: "1", job_status: "completed", diagnostic_code: null });
      }, { timeout: 10_000, interval: 25 });
      await vi.waitFor(async () => {
        const result = await pool.query<{ technical_metadata: { backfillError?: string } }>(
          "SELECT technical_metadata FROM assets WHERE id=$1 AND owner_user_id=$2",
          [brokenAssetId, ownerUserId],
        );
        expect(result.rows[0]?.technical_metadata.backfillError).toBe("asset_storage_unavailable");
      }, { timeout: 10_000, interval: 25 });

      const app = await buildServer(serverOptions({ config: config(root), pool }));
      try {
        const delivery = await app.inject({
          method: "GET",
          url: `/api/v1/assets/${workerAssetId}/thumbnail`,
          headers: { "x-user-id": crypto.randomUUID() },
        });
        expect(delivery.statusCode).toBe(200);
        expect(delivery.headers["content-type"]).toContain("image/webp");
        expect(delivery.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
        expect(delivery.rawPayload.byteLength).toBeGreaterThan(0);
      } finally {
        await app.close();
      }
    } finally {
      controller.abort();
      await worker;
    }
    expectSuppliedPoolDrained(
      pool as unknown as Readonly<{ totalCount: number; idleCount: number; waitingCount: number }>,
      config(root, "worker").databaseMaxConnections,
    );

    await vi.waitFor(async () => {
      const pending = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM assets
          WHERE id=$1 AND (pixel_width IS NULL OR pixel_height IS NULL OR NOT EXISTS (
            SELECT 1 FROM asset_derivatives d
             WHERE d.owner_user_id=assets.owner_user_id AND d.source_asset_id=assets.id
               AND d.derivative_kind='thumbnail' AND d.transform_version=1
          )) AND NOT (technical_metadata ? 'backfillError')`,
        [workerAssetId],
      );
      expect(pending.rows[0]?.count).toBe("0");
    }, { timeout: 10_000, interval: 25 });
    const beforeRestart = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM asset_derivatives");
    const restartedController = new AbortController();
    const restarted = runWorker(pool, config(root), restartedController.signal, {
      generation: createWorkerGenerationApplication(pool, credentialSecret, apiIllustration, apiMemory),
      illustration: createWorkerIllustrationApplication(pool, credentialSecret, { root }),
      memory: createWorkerMemoryApplication(pool, credentialSecret),
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    restartedController.abort();
    await restarted;
    await expect(pool.query<{ count: string }>("SELECT count(*)::text AS count FROM asset_derivatives"))
      .resolves.toEqual(beforeRestart);
  });

  it("keeps a separately constructed private maintenance composition restart-safe and opaque", async () => {
    const first = await createPrivateAssetMaintenanceComposition(pool, { archiveRoot: root, assetRoot: root });
    try {
      const initial = await first.scheduler.tick({ workerId: "e3f-private-first", leaseSeconds: 30 });
      expect(initial.attempted).toBe(1);
      expect(JSON.stringify(initial)).not.toMatch(new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    } finally {
      await first.close();
    }

    const restarted = await createPrivateAssetMaintenanceComposition(pool, { archiveRoot: root, assetRoot: root });
    try {
      const next = await restarted.scheduler.tick({ workerId: "e3f-private-restart", leaseSeconds: 30 });
      expect(next.attempted).toBe(1);
      expect(next.diagnosticCodes).toEqual(expect.arrayContaining([]));
      expect(JSON.stringify(next)).not.toMatch(/storage_path|relative_path|descriptor|bearer|credential|token/u);
    } finally {
      await restarted.close();
    }
  });

  it("returns the supplied API pool to an idle bounded state after active Fastify success and safe failures", async () => {
    const app = await buildServer(serverOptions({ config: config(root), pool }));
    try {
      const [listed, foreignDelivery, malformedWorldImport] = await Promise.all([
        app.inject({ method: "GET", url: "/api/v1/assets" }),
        app.inject({ method: "GET", url: `/api/v1/assets/${foreignAssetId}`, headers: { "x-user-id": crypto.randomUUID() } }),
        app.inject({
          method: "POST",
          url: "/api/v1/imports/world/preview",
          payload: { sourceName: "e3f-invalid-world.json", worldExport: { format: "not-a-world" } },
        }),
      ]);
      expect(listed.statusCode).toBe(200);
      expect(foreignDelivery.statusCode).toBe(404);
      expect(malformedWorldImport.statusCode).toBe(400);
      for (const response of [foreignDelivery, malformedWorldImport]) {
        expect(JSON.stringify(response.json())).not.toMatch(/storage_path|filesystem|credential|bearer|private/i);
        expect(JSON.stringify(response.json())).not.toContain(root);
      }
    } finally {
      await app.close();
    }

    expectSuppliedPoolDrained(
      pool as unknown as Readonly<{ totalCount: number; idleCount: number; waitingCount: number }>,
      config(root).databaseMaxConnections,
    );
  });

  it("keeps active asset-library and illustration route behavior owner-bound and idempotent", async () => {
    const story = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    story.world.title = `Task 14e3f illustration contract ${crypto.randomUUID()}`;
    const app = await buildServer(serverOptions({ config: config(root), pool }));
    try {
      const imported = await app.inject({
        method: "POST",
        url: "/api/v1/imports/legacy-story",
        headers: { "x-user-id": crypto.randomUUID(), "x-owner-user-id": crypto.randomUUID() },
        payload: { sourceName: `e3f-illustration-${crypto.randomUUID()}.story`, story },
      });
      expect(imported.statusCode).toBe(201);
      const importedBody = imported.json() as { campaignId: string; worldId: string };
      const turn = await pool.query<{ id: string }>(
        "SELECT id FROM turns WHERE owner_user_id=$1 AND campaign_id=$2 ORDER BY turn_number DESC LIMIT 1",
        [ownerUserId, importedBody.campaignId],
      );
      const turnId = turn.rows[0]?.id;
      expect(turnId).toEqual(expect.any(String));

      const provider = await createProvider(pool, {
        name: `Task e3f illustration provider ${crypto.randomUUID()}`,
        providerType: "openai_compatible",
        providerRole: "image",
        baseUrl: "http://127.0.0.1:9911",
        defaultModel: "e3f-image-model",
        contextWindowTokens: 4096,
        maxOutputTokens: 256,
        temperature: 0,
        configuration: {},
        enabled: true,
        isDefault: true,
      }, credentialSecret);
      const illustrationConfig = {
        enabled: true,
        sourcePolicy: "generate_only",
        matchingScope: "world",
        confidenceProfile: "balanced",
        repetitionWindow: 5,
        providerProfileId: provider.id,
        model: "e3f-image-model",
        size: "1024x1024",
        aspectRatio: "1:1",
        quality: "auto",
        outputFormat: "png",
        maxAttempts: 3,
        segmentWordCount: 100,
        imagesPerSegment: 1,
        segmentPromptMode: "direct",
        refinementPrompt: "Return a fiction-only image prompt.",
      };
      const configured = await app.inject({
        method: "PUT",
        url: `/api/v1/campaigns/${importedBody.campaignId}/illustration-config`,
        headers: { "x-user-id": crypto.randomUUID() },
        payload: illustrationConfig,
      });
      expect(configured.statusCode).toBe(200);
      const readConfig = await app.inject({
        method: "GET",
        url: `/api/v1/campaigns/${importedBody.campaignId}/illustration-config`,
        headers: { "x-user-id": crypto.randomUUID() },
      });
      expect(readConfig.statusCode).toBe(200);
      expect(readConfig.json()).toMatchObject({ providerProfileId: provider.id, enabled: true, model: "e3f-image-model" });

      const [listed, facets, library] = await Promise.all([
        app.inject({ method: "GET", url: "/api/v1/assets?scope=all&limit=1", headers: { "x-user-id": crypto.randomUUID() } }),
        app.inject({ method: "GET", url: "/api/v1/assets/facets", headers: { "x-user-id": crypto.randomUUID() } }),
        pool.query<{ metadata_revision: number }>(
          "SELECT metadata_revision FROM asset_library_entries WHERE owner_user_id=$1 AND asset_id=$2",
          [ownerUserId, ownedAssetId],
        ),
      ]);
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toMatchObject({ assets: expect.any(Array), total: expect.any(Number) });
      expect(facets.statusCode).toBe(200);
      expect(facets.json()).toMatchObject({ total: expect.any(Number), facets: expect.any(Object) });
      expect(library.rows[0]?.metadata_revision).toEqual(expect.any(Number));
      const metadata = await app.inject({
        method: "PATCH",
        url: `/api/v1/assets/${ownedAssetId}/library-metadata`,
        headers: { "x-user-id": crypto.randomUUID() },
        payload: { expectedRevision: library.rows[0]!.metadata_revision, title: "Task e3f library title", favorite: true },
      });
      expect(metadata.statusCode).toBe(200);
      expect(metadata.json()).toMatchObject({ assetId: ownedAssetId });
      await expect(pool.query<{ title: string; favorite: boolean }>(
        "SELECT title,favorite FROM asset_library_entries WHERE owner_user_id=$1 AND asset_id=$2",
        [ownerUserId, ownedAssetId],
      )).resolves.toMatchObject({ rows: [{ title: "Task e3f library title", favorite: true }] });

      const cover = await app.inject({
        method: "POST",
        url: `/api/v1/worlds/${importedBody.worldId}/cover`,
        headers: { "x-user-id": crypto.randomUUID() },
        payload: { prompt: "A moonlit observatory on a quiet ridge." },
      });
      expect(cover.statusCode).toBe(202);
      const duplicateCover = await app.inject({
        method: "POST",
        url: `/api/v1/worlds/${importedBody.worldId}/cover`,
        payload: { prompt: "A moonlit observatory on a quiet ridge." },
      });
      expect(duplicateCover.statusCode).toBe(200);
      expect(duplicateCover.json()).toMatchObject({ id: cover.json().id, duplicate: true, targetType: "world_cover" });
      const coverJob = await app.inject({ method: "GET", url: `/api/v1/worlds/${importedBody.worldId}/cover-job` });
      expect(coverJob.statusCode).toBe(200);
      expect(coverJob.json()).toMatchObject({ id: cover.json().id, targetType: "world_cover" });

      const illustration = await app.inject({
        method: "POST",
        url: `/api/v1/turns/${turnId}/illustrations`,
        headers: { "x-user-id": crypto.randomUUID() },
        payload: { prompt: "A lantern bearer at the observatory." },
      });
      expect(illustration.statusCode).toBe(202);
      const imageJobId = illustration.json().id as string;
      const duplicateIllustration = await app.inject({
        method: "POST",
        url: `/api/v1/turns/${turnId}/illustrations`,
        payload: { prompt: "A lantern bearer at the observatory." },
      });
      expect(duplicateIllustration.statusCode).toBe(200);
      expect(duplicateIllustration.json()).toMatchObject({ id: imageJobId, duplicate: true, turnId });
      const imageJob = await app.inject({ method: "GET", url: `/api/v1/image-jobs/${imageJobId}` });
      expect(imageJob.statusCode).toBe(200);
      expect(imageJob.json()).toMatchObject({ id: imageJobId, campaignId: importedBody.campaignId, status: "queued" });
      await pool.query("UPDATE image_jobs SET status='failed' WHERE id=$1 AND owner_user_id=$2", [imageJobId, ownerUserId]);
      const retried = await app.inject({ method: "POST", url: `/api/v1/image-jobs/${imageJobId}/retry` });
      expect(retried.statusCode).toBe(202);
      expect(retried.json()).toMatchObject({ id: imageJobId, status: "queued" });
      const jobs = await app.inject({ method: "GET", url: `/api/v1/campaigns/${importedBody.campaignId}/image-jobs` });
      expect(jobs.statusCode).toBe(200);
      expect(jobs.json()).toMatchObject({ jobs: expect.arrayContaining([expect.objectContaining({ id: imageJobId, turnId })]) });
    } finally {
      await app.close();
    }
  });

  it("fences a same-key Campaign ZIP replay behind an actual durable recovery claim", async () => {
    const secondPool = createDatabasePool(databaseUrl!, 4);
    const targetContent = canonicalizeWorldContent({
      world: { title: `Task 14e3f claimed Campaign ZIP ${crypto.randomUUID()}` },
      playableCharacters: [{ id: "hero", name: "Hero", characterText: "A verifier" }],
    });
    const targetWorld = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title) VALUES ($1,$2) RETURNING id",
      [ownerUserId, targetContent.world.title],
    );
    const targetVersion = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id,owner_user_id,version_number,content)
       VALUES ($1,$2,1,$3::jsonb) RETURNING id`,
      [targetWorld.rows[0]!.id, ownerUserId, JSON.stringify(targetContent)],
    );
    const target = Object.freeze({
      worldId: targetWorld.rows[0]!.id,
      worldVersionId: targetVersion.rows[0]!.id,
      content: targetContent,
    });
    const composePortable = (databasePool: DatabasePool, leaseOwner: string) => (
      createPortableImportExportComposition({
        pool: databasePool,
        roots: { archiveRoot: root, assetRoot: root },
        worlds: createPostgresWorldRepositoryAdapters(databasePool, {
          memory: { async autoEnableCampaignEmbedding() { return { enabled: false }; } },
        }).worlds,
        leaseOwner,
        leaseSeconds: 30,
        provider: {
          async convertTemplate({ template }) {
            const title = template.title.trim() || "Converted portable world";
            return {
              world: {
                format: "infinite-quest-world" as const,
                formatVersion: 1 as const,
                title,
                content: canonicalizeWorldContent({ world: { title } }),
              },
              providerConfigurationFingerprint: "f".repeat(64),
            };
          },
        },
        targets: {
          async readTargetWorldVersion(value) {
            if (value.owner.ownerUserId !== ownerUserId
              || value.worldId !== target.worldId
              || value.worldVersionId !== target.worldVersionId) return null;
            return { ownerUserId, ...target };
          },
        },
        exports: {
          async buildCampaignArchive() { throw new Error("export_not_expected"); },
          async buildWorldJson() { throw new Error("export_not_expected"); },
        },
      })
    );
    const first = await composePortable(pool, "e3f-claimed-import-first");
    const replay = await composePortable(secondPool, "e3f-claimed-import-replay");
    const recovery = await createPrivateFilesystemRecoveryComposition(
      secondPool,
      { archiveRoot: root, assetRoot: root },
    );
    const sourceAssetId = crypto.randomUUID();
    const image = await sharp({
      create: { width: 8, height: 5, channels: 4, background: "#115e59" },
    }).png().toBuffer();
    const archive = await campaignZipWithImage(
      `claimed-import-${crypto.randomUUID()}`,
      sourceAssetId,
      image,
    );
    const staged: PortableStagedInput = (await first.stageInput({
      owner: { ownerUserId },
      operationScopeId: `e3f-claimed-import-${crypto.randomUUID()}`,
      leaseOwner: "e3f-claimed-import-stage",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      byteLength: archive.byteLength,
      source: [archive],
    })).stagedInput;
    const preview = await first.previewCampaignZip({
      ownerUserId,
      stagedInput: staged,
      kind: "campaign_zip",
      destination: { kind: "embedded", operation: "create_world" },
    });
    const command = {
      ownerUserId,
      kind: "campaign_zip" as const,
      destination: preview.destination,
      previewHandle: preview.previewHandle,
      idempotencyKey: `e3f-claimed-import-${crypto.randomUUID()}`,
    };

    await pool.query(`CREATE FUNCTION task_14e3f_import_initial_fault() RETURNS trigger
      LANGUAGE plpgsql AS $fault$
      BEGIN RAISE EXCEPTION 'task_14e3f_import_initial_fault'; END;
      $fault$`);
    await pool.query(`CREATE TRIGGER task_14e3f_import_initial_fault_trigger
      BEFORE UPDATE ON durable_filesystem_operations
      FOR EACH ROW WHEN (
        NEW.lifecycle='finalized' AND OLD.lifecycle='attached'
        AND NEW.owner_user_id='${ownerUserId}'::uuid AND NEW.purpose='asset_original'
      ) EXECUTE FUNCTION task_14e3f_import_initial_fault()`);
    try {
      await expect(first.commit(command)).rejects.toThrow("asset_publication_finalization_recoverable");
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS task_14e3f_import_initial_fault_trigger ON durable_filesystem_operations",
      );
      await pool.query("DROP FUNCTION IF EXISTS task_14e3f_import_initial_fault()");
    }

    const pending = await pool.query<Readonly<{
      operation_id: string;
      operation_status: string;
      work_status: string;
      publication_state: string;
      request_lifecycle: string;
      filesystem_lifecycle: string;
      work_version: number;
    }>>(
      `SELECT filesystem.id AS operation_id,operation.status AS operation_status,
              work.status AS work_status,mapping.publication_state,
              request.lifecycle AS request_lifecycle,filesystem.lifecycle AS filesystem_lifecycle,
              filesystem.work_version
         FROM portable_import_operations operation
         JOIN portable_import_work work ON work.operation_id=operation.id
         JOIN portable_import_normalized_asset_publications mapping ON mapping.operation_id=operation.id
         JOIN asset_publication_requests request ON request.id=mapping.request_id
         JOIN durable_filesystem_operations filesystem
           ON filesystem.owner_user_id=request.owner_user_id
          AND filesystem.asset_id=request.canonical_asset_id
          AND filesystem.purpose='asset_original'
        WHERE operation.owner_user_id=$1 AND operation.preview_token_hash=$2`,
      [ownerUserId, sha256(preview.previewHandle.token)],
    );
    expect(pending.rows).toEqual([expect.objectContaining({
      operation_status: "committed",
      work_status: "recoverable",
      publication_state: "committed_finalization_pending",
      request_lifecycle: "attached",
      filesystem_lifecycle: "attached",
    })]);
    const filesystemOperationId = pending.rows[0]!.operation_id;
    const preClaimWorkVersion = pending.rows[0]!.work_version;
    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lease_expires_at=clock_timestamp()-interval '1 second'
        WHERE id=$1 AND lifecycle='attached'`,
      [filesystemOperationId],
    );

    const gateKey = `task-14e3f-import-gate-${crypto.randomUUID()}`;
    const signalKey = `task-14e3f-import-signal-${crypto.randomUUID()}`;
    const blocker = await pool.connect();
    const observer = await pool.connect();
    await blocker.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [gateKey]);
    await pool.query(`CREATE FUNCTION task_14e3f_import_recovery_gate() RETURNS trigger
      LANGUAGE plpgsql AS $gate$
      BEGIN
        PERFORM pg_advisory_lock(hashtextextended('${signalKey}',0));
        PERFORM pg_advisory_xact_lock(hashtextextended('${gateKey}',0));
        PERFORM pg_advisory_unlock(hashtextextended('${signalKey}',0));
        RETURN NEW;
      END;
      $gate$`);
    await pool.query(`CREATE TRIGGER task_14e3f_import_recovery_gate_trigger
      BEFORE UPDATE ON durable_filesystem_operations
      FOR EACH ROW WHEN (
        OLD.id='${filesystemOperationId}'::uuid
        AND NEW.lifecycle='finalized' AND OLD.lifecycle='attached'
      ) EXECUTE FUNCTION task_14e3f_import_recovery_gate()`);

    let gateReleased = false;
    let recoveryPromise: ReturnType<typeof recovery.executor.processAssetOne> | undefined;
    let replayPromise: Promise<Readonly<{
      status: "fulfilled";
      value: Awaited<ReturnType<typeof replay.commit>>;
    }> | Readonly<{ status: "rejected"; error: unknown }>> | undefined;
    try {
      recoveryPromise = recovery.executor.processAssetOne({
        workerId: "e3f-claimed-import-recovery",
        leaseSeconds: 30,
        limit: 256,
      });
      const signalDeadline = Date.now() + 10_000;
      for (;;) {
        const signal = await observer.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
          [signalKey],
        );
        if (!signal.rows[0]?.acquired) break;
        await observer.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [signalKey]);
        if (Date.now() >= signalDeadline) throw new Error("task_14e3f_import_recovery_gate_timeout");
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }

      const claimed = await observer.query<Readonly<{
        lifecycle: string;
        lease_owner: string;
        lease_current: boolean;
        work_version: number;
      }>>(
        `SELECT lifecycle,lease_owner,lease_expires_at>clock_timestamp() AS lease_current,work_version
           FROM durable_filesystem_operations WHERE id=$1`,
        [filesystemOperationId],
      );
      expect(claimed.rows).toEqual([{
        lifecycle: "attached",
        lease_owner: "e3f-claimed-import-recovery",
        lease_current: true,
        work_version: expect.any(Number),
      }]);
      expect(claimed.rows[0]!.work_version).toBeGreaterThan(preClaimWorkVersion);

      let replaySettled = false;
      replayPromise = replay.commit(command).then(
        (value) => Object.freeze({ status: "fulfilled" as const, value }),
        (error: unknown) => Object.freeze({ status: "rejected" as const, error }),
      ).finally(() => { replaySettled = true; });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      expect(replaySettled).toBe(false);
      await expect(observer.query(
        `SELECT mapping.publication_state,request.lifecycle AS request_lifecycle,
                filesystem.lifecycle AS filesystem_lifecycle,filesystem.lease_owner
           FROM portable_import_normalized_asset_publications mapping
           JOIN asset_publication_requests request ON request.id=mapping.request_id
           JOIN durable_filesystem_operations filesystem
             ON filesystem.owner_user_id=request.owner_user_id
            AND filesystem.asset_id=request.canonical_asset_id
            AND filesystem.purpose='asset_original'
          WHERE mapping.operation_id=(
            SELECT id FROM portable_import_operations WHERE preview_token_hash=$1
          )`,
        [sha256(preview.previewHandle.token)],
      )).resolves.toMatchObject({
        rows: [{
          publication_state: "committed_finalization_pending",
          request_lifecycle: "attached",
          filesystem_lifecycle: "attached",
          lease_owner: "e3f-claimed-import-recovery",
        }],
      });

      await blocker.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [gateKey]);
      gateReleased = true;
      const [recovered, replayed] = await Promise.all([recoveryPromise, replayPromise]);
      expect(recovered.claimed).toBeGreaterThanOrEqual(1);
      expect(recovered.finalized).toBeGreaterThanOrEqual(1);
      expect(replayed.status).toBe("fulfilled");
      if (replayed.status !== "fulfilled") throw replayed.error;
      expect(replayed.value).toMatchObject({
        kind: "campaign_zip",
        duplicate: false,
        result: { stats: { assetCount: 1 } },
      });
    } finally {
      if (!gateReleased) {
        await blocker.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [gateKey]).catch(() => undefined);
      }
      await Promise.allSettled([recoveryPromise, replayPromise].filter(Boolean));
      observer.release();
      blocker.release();
      await pool.query(
        "DROP TRIGGER IF EXISTS task_14e3f_import_recovery_gate_trigger ON durable_filesystem_operations",
      );
      await pool.query("DROP FUNCTION IF EXISTS task_14e3f_import_recovery_gate()");
      await Promise.all([first.close(), replay.close(), recovery.close()]);
      await secondPool.end();
    }

    await expect(pool.query(
      `SELECT operation.status AS operation_status,work.status AS work_status,
              mapping.publication_state,request.lifecycle AS request_lifecycle,
              filesystem.lifecycle AS filesystem_lifecycle,
              (SELECT count(*)::int FROM portable_import_normalized_asset_publications exact
                WHERE exact.operation_id=operation.id) AS mapping_count,
              (SELECT count(*)::int FROM asset_publication_requests exact
                WHERE exact.provenance_snapshot->>'importOperationId'=operation.id::text) AS request_count,
              (SELECT count(*)::int FROM imports imported
                WHERE imported.owner_user_id=operation.owner_user_id
                  AND imported.source_hash=operation.authority_fingerprint) AS import_count
         FROM portable_import_operations operation
         JOIN portable_import_work work ON work.operation_id=operation.id
         JOIN portable_import_normalized_asset_publications mapping ON mapping.operation_id=operation.id
         JOIN asset_publication_requests request ON request.id=mapping.request_id
         JOIN durable_filesystem_operations filesystem
           ON filesystem.owner_user_id=request.owner_user_id
          AND filesystem.asset_id=request.canonical_asset_id
          AND filesystem.purpose='asset_original'
        WHERE operation.preview_token_hash=$1`,
      [sha256(preview.previewHandle.token)],
    )).resolves.toMatchObject({
      rows: [{
        operation_status: "committed",
        work_status: "completed",
        publication_state: "published",
        request_lifecycle: "published",
        filesystem_lifecycle: "finalized",
        mapping_count: 1,
        request_count: 1,
        import_count: 1,
      }],
    });
  }, 30_000);

  it("fences thumbnail backfill behind an actual durable recovery claim without duplicating its derivative", async () => {
    await retireExistingMetadataBackfillCandidates(pool);
    const color = createHash("sha256").update(crypto.randomUUID()).digest();
    const sourceBytes = await sharp({
      create: {
        width: 13,
        height: 9,
        channels: 4,
        background: { r: color[0]!, g: color[1]!, b: color[2]!, alpha: 1 },
      },
    }).png().toBuffer();
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const sourcePath = `assets/content/${sourceHash}`;
    await mkdir(join(root, "assets", "content"), { recursive: true });
    await writeFile(join(root, sourcePath), sourceBytes, { flag: "wx" });
    const source = await pool.query<{ id: string }>(
      `INSERT INTO assets (
         owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length,
         pixel_width,pixel_height,technical_metadata
       ) VALUES ($1,$2,'filesystem',$3,'image/png',$4,NULL,NULL,'{}'::jsonb)
       RETURNING id`,
      [ownerUserId, sourceHash, sourcePath, sourceBytes.byteLength],
    );
    const assetId = source.rows[0]!.id;
    await pool.query(
      `INSERT INTO asset_metadata_backfill_jobs (owner_user_id,asset_id,status,next_attempt_at)
       VALUES ($1,$2,'queued',clock_timestamp())`,
      [ownerUserId, assetId],
    );

    await pool.query(`CREATE FUNCTION task_14e3f_thumbnail_initial_fault() RETURNS trigger
      LANGUAGE plpgsql AS $fault$
      BEGIN RAISE EXCEPTION 'task_14e3f_thumbnail_initial_fault'; END;
      $fault$`);
    await pool.query(`CREATE TRIGGER task_14e3f_thumbnail_initial_fault_trigger
      BEFORE UPDATE ON durable_filesystem_operations
      FOR EACH ROW WHEN (
        NEW.lifecycle='finalized' AND OLD.lifecycle='attached'
        AND NEW.owner_user_id='${ownerUserId}'::uuid
        AND NEW.asset_id='${assetId}'::uuid AND NEW.purpose='asset_derivative'
      ) EXECUTE FUNCTION task_14e3f_thumbnail_initial_fault()`);
    const interrupted = await createPrivateAssetMetadataBackfillComposition(
      pool,
      { archiveRoot: root, assetRoot: root },
    );
    try {
      await expect(interrupted.executor.processOne({
        workerId: "e3f-thumbnail-interrupted",
        leaseSeconds: 30,
      })).resolves.toMatchObject({ outcome: "recoverable", assetId });
    } finally {
      await interrupted.close();
      await pool.query(
        "DROP TRIGGER IF EXISTS task_14e3f_thumbnail_initial_fault_trigger ON durable_filesystem_operations",
      );
      await pool.query("DROP FUNCTION IF EXISTS task_14e3f_thumbnail_initial_fault()");
    }

    const pending = await pool.query<Readonly<{
      operation_id: string;
      job_status: string;
      publication_lifecycle: string;
      filesystem_lifecycle: string;
      work_version: number;
      derivative_count: number;
    }>>(
      `SELECT filesystem.id AS operation_id,job.status AS job_status,
              publication.lifecycle AS publication_lifecycle,
              filesystem.lifecycle AS filesystem_lifecycle,filesystem.work_version,
              (SELECT count(*)::int FROM asset_derivatives derivative
                WHERE derivative.owner_user_id=job.owner_user_id
                  AND derivative.source_asset_id=job.asset_id
                  AND derivative.derivative_kind='thumbnail'
                  AND derivative.transform_version=1) AS derivative_count
         FROM asset_metadata_backfill_jobs job
         JOIN asset_metadata_backfill_publications publication
           ON publication.owner_user_id=job.owner_user_id AND publication.asset_id=job.asset_id
         JOIN durable_filesystem_operations filesystem
           ON filesystem.id=publication.filesystem_operation_id
        WHERE job.owner_user_id=$1 AND job.asset_id=$2`,
      [ownerUserId, assetId],
    );
    expect(pending.rows).toEqual([{
      operation_id: expect.any(String),
      job_status: "recoverable",
      publication_lifecycle: "attached",
      filesystem_lifecycle: "attached",
      work_version: expect.any(Number),
      derivative_count: 1,
    }]);
    const filesystemOperationId = pending.rows[0]!.operation_id;
    const preClaimWorkVersion = pending.rows[0]!.work_version;
    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lease_expires_at=clock_timestamp()-interval '1 second'
        WHERE id=$1 AND lifecycle='attached'`,
      [filesystemOperationId],
    );
    await pool.query(
      `UPDATE asset_metadata_backfill_jobs
          SET next_attempt_at=clock_timestamp()
        WHERE owner_user_id=$1 AND asset_id=$2 AND status='recoverable'`,
      [ownerUserId, assetId],
    );

    const secondPool = createDatabasePool(databaseUrl!, 4);
    const recovery = await createPrivateFilesystemRecoveryComposition(
      secondPool,
      { archiveRoot: root, assetRoot: root },
    );
    const contender = await createPrivateAssetMetadataBackfillComposition(
      pool,
      { archiveRoot: root, assetRoot: root },
    );
    const gateKey = `task-14e3f-thumbnail-gate-${crypto.randomUUID()}`;
    const signalKey = `task-14e3f-thumbnail-signal-${crypto.randomUUID()}`;
    const blocker = await pool.connect();
    const observer = await pool.connect();
    await blocker.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [gateKey]);
    await pool.query(`CREATE FUNCTION task_14e3f_thumbnail_recovery_gate() RETURNS trigger
      LANGUAGE plpgsql AS $gate$
      BEGIN
        PERFORM pg_advisory_lock(hashtextextended('${signalKey}',0));
        PERFORM pg_advisory_xact_lock(hashtextextended('${gateKey}',0));
        PERFORM pg_advisory_unlock(hashtextextended('${signalKey}',0));
        RETURN NEW;
      END;
      $gate$`);
    await pool.query(`CREATE TRIGGER task_14e3f_thumbnail_recovery_gate_trigger
      BEFORE UPDATE ON durable_filesystem_operations
      FOR EACH ROW WHEN (
        OLD.owner_user_id='${ownerUserId}'::uuid AND OLD.asset_id='${assetId}'::uuid
        AND OLD.id='${filesystemOperationId}'::uuid
        AND NEW.lifecycle='finalized' AND OLD.lifecycle='attached'
      ) EXECUTE FUNCTION task_14e3f_thumbnail_recovery_gate()`);

    let gateReleased = false;
    let recoveryPromise: ReturnType<typeof recovery.executor.processAssetOne> | undefined;
    let contenderPromise: ReturnType<typeof contender.executor.processOne> | undefined;
    let claimedWorkVersion = 0;
    try {
      recoveryPromise = recovery.executor.processAssetOne({
        workerId: "e3f-thumbnail-recovery",
        leaseSeconds: 30,
        limit: 256,
      });
      const signalDeadline = Date.now() + 10_000;
      for (;;) {
        const signal = await observer.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
          [signalKey],
        );
        if (!signal.rows[0]?.acquired) break;
        await observer.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [signalKey]);
        if (Date.now() >= signalDeadline) throw new Error("task_14e3f_thumbnail_recovery_gate_timeout");
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }

      const claimed = await observer.query<Readonly<{
        filesystem_lifecycle: string;
        lease_owner: string;
        lease_current: boolean;
        work_version: number;
        publication_lifecycle: string;
        job_status: string;
        job_eligible: boolean;
      }>>(
        `SELECT operation.lifecycle AS filesystem_lifecycle,operation.lease_owner,
                operation.lease_expires_at>clock_timestamp() AS lease_current,operation.work_version,
                publication.lifecycle AS publication_lifecycle,job.status AS job_status,
                job.next_attempt_at<=clock_timestamp() AS job_eligible
           FROM durable_filesystem_operations operation
           JOIN asset_metadata_backfill_publications publication
             ON publication.filesystem_operation_id=operation.id
           JOIN asset_metadata_backfill_jobs job
             ON job.owner_user_id=publication.owner_user_id AND job.asset_id=publication.asset_id
          WHERE operation.id=$1`,
        [filesystemOperationId],
      );
      expect(claimed.rows).toEqual([{
        filesystem_lifecycle: "attached",
        lease_owner: "e3f-thumbnail-recovery",
        lease_current: true,
        work_version: expect.any(Number),
        publication_lifecycle: "attached",
        job_status: "recoverable",
        job_eligible: true,
      }]);
      claimedWorkVersion = claimed.rows[0]!.work_version;
      expect(claimedWorkVersion).toBeGreaterThan(preClaimWorkVersion);

      contenderPromise = contender.executor.processOne({
        workerId: "e3f-thumbnail-backfill-racer",
        leaseSeconds: 30,
      });
      const contenderDeadline = Date.now() + 10_000;
      for (;;) {
        const contenderClaim = await observer.query<{ lease_owner: string | null }>(
          `SELECT lease_owner
             FROM asset_metadata_backfill_jobs
            WHERE owner_user_id=$1 AND asset_id=$2 AND status='running'`,
          [ownerUserId, assetId],
        );
        if (contenderClaim.rows[0]?.lease_owner === "e3f-thumbnail-backfill-racer") break;
        if (Date.now() >= contenderDeadline) throw new Error("task_14e3f_thumbnail_contender_claim_timeout");
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      await expect(observer.query(
        `SELECT operation.lifecycle,operation.lease_owner,operation.work_version,
                publication.lifecycle AS publication_lifecycle,job.status AS job_status,
                job.next_attempt_at<=clock_timestamp() AS job_eligible,
                (SELECT count(*)::int FROM asset_derivatives derivative
                  WHERE derivative.owner_user_id=$2 AND derivative.source_asset_id=$3
                    AND derivative.derivative_kind='thumbnail' AND derivative.transform_version=1) AS derivative_count
           FROM durable_filesystem_operations operation
           JOIN asset_metadata_backfill_publications publication
             ON publication.filesystem_operation_id=operation.id
           JOIN asset_metadata_backfill_jobs job
             ON job.owner_user_id=publication.owner_user_id AND job.asset_id=publication.asset_id
          WHERE operation.id=$1`,
        [filesystemOperationId, ownerUserId, assetId],
      )).resolves.toMatchObject({
        rows: [{
          lifecycle: "attached",
          lease_owner: "e3f-thumbnail-recovery",
          work_version: claimedWorkVersion,
          publication_lifecycle: "attached",
          job_status: "running",
          job_eligible: true,
          derivative_count: 1,
        }],
      });

      await blocker.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [gateKey]);
      gateReleased = true;
      await expect(contenderPromise).resolves.toEqual({ outcome: "completed", assetId });
      const recovered = await recoveryPromise;
      expect(recovered.claimed).toBeGreaterThanOrEqual(1);
      expect(recovered.finalized).toBeGreaterThanOrEqual(1);
      expect(recovered.recoverable).toBe(1);
    } finally {
      if (!gateReleased) {
        await blocker.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [gateKey]).catch(() => undefined);
      }
      await Promise.allSettled([recoveryPromise, contenderPromise].filter(Boolean));
      observer.release();
      blocker.release();
      await pool.query(
        "DROP TRIGGER IF EXISTS task_14e3f_thumbnail_recovery_gate_trigger ON durable_filesystem_operations",
      );
      await pool.query("DROP FUNCTION IF EXISTS task_14e3f_thumbnail_recovery_gate()");
      await Promise.all([recovery.close(), contender.close()]);
      await secondPool.end();
    }

    const completed = await pool.query<Readonly<{
      job_status: string;
      publication_lifecycle: string;
      filesystem_lifecycle: string;
      lease_owner: string;
      work_version: number;
      derivative_count: number;
      storage_path: string;
    }>>(
      `SELECT job.status AS job_status,publication.lifecycle AS publication_lifecycle,
              filesystem.lifecycle AS filesystem_lifecycle,filesystem.lease_owner,
              filesystem.work_version,derivative.storage_path,
              (SELECT count(*)::int FROM asset_derivatives exact
                WHERE exact.owner_user_id=job.owner_user_id AND exact.source_asset_id=job.asset_id
                  AND exact.derivative_kind='thumbnail' AND exact.transform_version=1) AS derivative_count
         FROM asset_metadata_backfill_jobs job
         JOIN asset_metadata_backfill_publications publication
           ON publication.owner_user_id=job.owner_user_id AND publication.asset_id=job.asset_id
         JOIN durable_filesystem_operations filesystem ON filesystem.id=publication.filesystem_operation_id
         JOIN asset_derivatives derivative
           ON derivative.owner_user_id=job.owner_user_id AND derivative.source_asset_id=job.asset_id
          AND derivative.derivative_kind='thumbnail' AND derivative.transform_version=1
        WHERE job.owner_user_id=$1 AND job.asset_id=$2`,
      [ownerUserId, assetId],
    );
    expect(completed.rows).toEqual([{
      job_status: "completed",
      publication_lifecycle: "published",
      filesystem_lifecycle: "finalized",
      lease_owner: "e3f-thumbnail-recovery",
      work_version: claimedWorkVersion,
      derivative_count: 1,
      storage_path: expect.any(String),
    }]);
    await expect(stat(join(root, completed.rows[0]!.storage_path))).resolves.toMatchObject({
      size: expect.any(Number),
    });
  }, 30_000);

  it("uses two independent private publication pools for a same-key duplicate and cross-owner shared bytes", async () => {
    const secondPool = createDatabasePool(databaseUrl!, 4);
    const publicationModule = await import("../../services/runtime/src/normalized-asset-publication-composition.js");
    const first = await publicationModule.createPrivateNormalizedAssetPublicationComposition(
      pool,
      { archiveRoot: root, assetRoot: root },
    );
    const second = await publicationModule.createPrivateNormalizedAssetPublicationComposition(
      secondPool,
      { archiveRoot: root, assetRoot: root },
    );
    const attachAndFinalize = async (
      composition: typeof first,
      databasePool: DatabasePool,
      reservation: Awaited<ReturnType<typeof first.publication.reserve>>,
    ) => {
      const attached = await withTransaction(databasePool, async (client) => (
        composition.publication.attachInTransaction(client, reservation, async () => ({ contexts: [], references: [] }))
      ));
      return Object.freeze({
        attached,
        finalized: await composition.publication.finalize(attached.finalization),
      });
    };
    try {
      const bytes = await sharp({
        create: { width: 4, height: 4, channels: 4, background: "#0f766e" },
      }).png().toBuffer();
      const sameKey = toAssetMutationIdempotencyKey(`e3f-two-pool-${crypto.randomUUID()}`);
      const importOperationId = crypto.randomUUID();
      const request = normalizedRequest(ownerUserId, "same-key", bytes, sameKey, importOperationId);
      const firstReservation = await first.publication.reserve({
        request,
        leaseOwner: "e3f-two-pool-first",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      let secondReservationSettled = false;
      const secondReservationPromise = second.publication.reserve({
        request,
        leaseOwner: "e3f-two-pool-second",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }).catch(async (error) => {
        const durableState = await pool.query<Readonly<{
          request_lifecycle: string;
          identity_lifecycle: string | null;
          has_result: boolean;
          operations: string;
        }>>(
          `SELECT request.lifecycle AS request_lifecycle,
                  identity.lifecycle AS identity_lifecycle,
                  request.result IS NOT NULL AS has_result,
                  (SELECT count(*)::text
                     FROM durable_filesystem_operations operation
                    WHERE operation.owner_user_id=request.owner_user_id
                      AND operation.asset_id=request.canonical_asset_id) AS operations
             FROM asset_publication_requests request
             LEFT JOIN asset_publication_identities identity
               ON identity.asset_id=request.canonical_asset_id
              AND identity.owner_user_id=request.owner_user_id
            WHERE request.owner_user_id=$1 AND request.idempotency_key_hash=$2`,
          [ownerUserId, createHash("sha256").update(sameKey, "utf8").digest("hex")],
        );
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}; durable-state=${JSON.stringify(durableState.rows)}`);
      }).finally(() => { secondReservationSettled = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(secondReservationSettled).toBe(false);
      const firstPublished = await attachAndFinalize(first, pool, firstReservation);
      expect(firstPublished.finalized).toMatchObject({ outcome: "published" });

      const secondReservation = await secondReservationPromise;
      const duplicate = await attachAndFinalize(second, secondPool, secondReservation);
      expect(duplicate.finalized).toMatchObject({ outcome: "published" });
      expect(duplicate.attached.result.assetId).toBe(firstPublished.attached.result.assetId);
      await expect(pool.query<{ requests: string; assets: string; operations: string }>(
        `SELECT
           (SELECT count(*)::text FROM asset_publication_requests
             WHERE owner_user_id=$1 AND idempotency_key_hash=$2) AS requests,
           (SELECT count(*)::text FROM assets
             WHERE owner_user_id=$1 AND content_hash=$3) AS assets,
           (SELECT count(*)::text FROM durable_filesystem_operations
             WHERE owner_user_id=$1 AND asset_id=$4 AND purpose='asset_original') AS operations`,
        [
          ownerUserId,
          createHash("sha256").update(sameKey, "utf8").digest("hex"),
          request.original.contentHash,
          firstPublished.attached.result.assetId,
        ],
      )).resolves.toMatchObject({ rows: [{ requests: "1", assets: "1", operations: "1" }] });

      const otherOwner = (await pool.query<{ id: string }>(
        "INSERT INTO users (display_name,status) VALUES ($1,'active') RETURNING id",
        [`Task e3f shared retention ${crypto.randomUUID()}`],
      )).rows[0]!.id;
      const otherRequest = normalizedRequest(otherOwner, "shared-other-owner", bytes);
      const otherReservation = await second.publication.reserve({
        request: otherRequest,
        leaseOwner: "e3f-two-pool-other-owner",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const otherPublished = await attachAndFinalize(second, secondPool, otherReservation);
      expect(otherPublished.finalized).toMatchObject({ outcome: "published" });
      expect(otherPublished.attached.result.assetId).not.toBe(firstPublished.attached.result.assetId);
      const retained = await pool.query<{ storage_path: string; owner_user_id: string; lifecycle: string }>(
        `SELECT asset.storage_path,asset.owner_user_id,identity.lifecycle
           FROM assets asset
           JOIN asset_publication_identities identity
             ON identity.asset_id=asset.id AND identity.owner_user_id=asset.owner_user_id
          WHERE asset.id=ANY($1::uuid[]) ORDER BY asset.owner_user_id`,
        [[firstPublished.attached.result.assetId, otherPublished.attached.result.assetId]],
      );
      expect(retained.rows).toHaveLength(2);
      expect(new Set(retained.rows.map((row) => row.storage_path)).size).toBe(1);
      expect(new Set(retained.rows.map((row) => row.owner_user_id))).toEqual(new Set([ownerUserId, otherOwner]));
      expect(retained.rows.every((row) => row.lifecycle === "published")).toBe(true);
      await expect(readFile(join(root, retained.rows[0]!.storage_path))).resolves.toEqual(bytes);

      const delivery = await createAssetImportStorageComposition(pool, { archiveRoot: root, assetRoot: root });
      try {
        const scope = { ownerUserId, assetId: firstPublished.attached.result.assetId };
        const deliveryRequest = { kind: "original" } as const;
        const resolved = await delivery.finalizedDelivery.resolveFinalizedAssetDelivery(scope, deliveryRequest);
        expect(resolved).toMatchObject({
          kind: "durable_finalized",
          descriptor: {
            assetId: firstPublished.attached.result.assetId,
            kind: "original",
            derivativeKind: null,
            mimeType: "image/png",
            byteLength: bytes.byteLength,
          etag: request.original.contentHash,
          },
        });
        expect(resolved?.kind).toBe("durable_finalized");
        if (!resolved || resolved.kind !== "durable_finalized") {
          throw new Error("expected finalized private asset delivery");
        }
        const redeemed = await delivery.finalizedDelivery.redeemFinalizedDeliveryGrant(
          scope,
          deliveryRequest,
          resolved.grant,
        );
        expect(redeemed).toMatchObject({ contentHash: request.original.contentHash, byteLength: bytes.byteLength });

        const limits = bindPrivateBoundedStreamLimits({
          maximumBytes: 4_096,
          chunkBytes: 8,
          deadlineAt: new Date(Date.now() + 30_000).toISOString(),
        });
        const ownSession = await delivery.adapter.openAssetSession({ scope, request: deliveryRequest, limits });
        const foreignSession = await delivery.adapter.openAssetSession({
          scope: { ownerUserId: otherOwner, assetId: firstPublished.attached.result.assetId },
          request: deliveryRequest,
          limits,
        });
        expect(ownSession).not.toBeNull();
        expect(ownSession?.contentType).toBe("image/png");
        expect(ownSession?.byteLength).toBe(bytes.byteLength);
        expect(foreignSession).toBeNull();
        await expect(collect(ownSession!.chunks)).resolves.toEqual(bytes);
        await ownSession!.finalize("eof");
      } finally {
        await delivery.close();
      }

      const malformedFinalization = crypto.randomUUID() as PrivateNormalizedAssetFinalizationHandle;
      await expect(second.publication.finalize(malformedFinalization)).rejects.toThrow();
      await expect(first.publication.discardAfterRollback(firstReservation)).rejects.toThrow(
        "normalized_asset_publication_discard_unavailable",
      );
    } finally {
      await Promise.all([first.close(), second.close()]);
      await secondPool.end();
    }
    expectSuppliedPoolDrained(
      pool as unknown as Readonly<{ totalCount: number; idleCount: number; waitingCount: number }>,
      config(root).databaseMaxConnections,
    );
  });

  it("keeps active imports, recovery, rollback, and reaping fenced across independent private compositions", async () => {
    await retireExistingMetadataBackfillCandidates(pool);
    const publicationModule = await import("../../services/runtime/src/normalized-asset-publication-composition.js");
    const secondPool = createDatabasePool(databaseUrl!, 4);
    const publisher = await publicationModule.createPrivateNormalizedAssetPublicationComposition(
      pool,
      { archiveRoot: root, assetRoot: root },
    );
    const replayPublisher = await publicationModule.createPrivateNormalizedAssetPublicationComposition(
      secondPool,
      { archiveRoot: root, assetRoot: root },
    );
    const recovery = await createPrivateFilesystemRecoveryComposition(secondPool, { archiveRoot: root, assetRoot: root });
    const attachAndFinalize = async (
      composition: typeof publisher,
      databasePool: DatabasePool,
      reservation: Awaited<ReturnType<typeof publisher.publication.reserve>>,
    ) => {
      const attached = await withTransaction(databasePool, async (client) => (
        composition.publication.attachInTransaction(client, reservation, async () => ({ contexts: [], references: [] }))
      ));
      return Object.freeze({ attached, finalized: await composition.publication.finalize(attached.finalization) });
    };
    try {
      const sharedBytes = await sharp({
        create: { width: 5, height: 4, channels: 4, background: "#be123c" },
      }).png().toBuffer();
      const importKey = toAssetMutationIdempotencyKey(`e3f-import-recovery-${crypto.randomUUID()}`);
      const importOperationId = crypto.randomUUID();
      const request = normalizedRequest(ownerUserId, "import-recovery", sharedBytes, importKey, importOperationId);
      const firstReservation = await publisher.publication.reserve({
        request,
        leaseOwner: "e3f-import-active",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const secondReservationPromise = replayPublisher.publication.reserve({
        request,
        leaseOwner: "e3f-import-replay",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const reaperDuringAttach = recovery.executor.processAssetOne({
        workerId: "e3f-import-recovery-racer",
        leaseSeconds: 30,
        limit: 1,
      });
      const published = await attachAndFinalize(publisher, pool, firstReservation);
      const replayReservation = await secondReservationPromise;
      const replay = await attachAndFinalize(replayPublisher, secondPool, replayReservation);
      const reaperResult = await reaperDuringAttach;

      expect(published.finalized).toMatchObject({ outcome: "published" });
      expect(replay.finalized).toMatchObject({ outcome: "published" });
      expect(replay.attached.result.assetId).toBe(published.attached.result.assetId);
      expect(reaperResult).toMatchObject({ cleaned: 0, finalized: 0, recoverable: 0 });
      await expect(pool.query<{ requests: string; assets: string; operations: string; lifecycle: string }>(
        `SELECT
           (SELECT count(*)::text FROM asset_publication_requests
             WHERE owner_user_id=$1 AND idempotency_key_hash=$2) AS requests,
           (SELECT count(*)::text FROM assets WHERE owner_user_id=$1 AND content_hash=$3) AS assets,
           (SELECT count(*)::text FROM durable_filesystem_operations
             WHERE owner_user_id=$1 AND asset_id=$4 AND purpose='asset_original') AS operations,
           (SELECT lifecycle FROM durable_filesystem_operations
             WHERE owner_user_id=$1 AND asset_id=$4 AND purpose='asset_original') AS lifecycle`,
        [
          ownerUserId,
          createHash("sha256").update(importKey, "utf8").digest("hex"),
          request.original.contentHash,
          published.attached.result.assetId,
        ],
      )).resolves.toMatchObject({ rows: [{ requests: "1", assets: "1", operations: "1", lifecycle: "finalized" }] });

      const rollbackBytes = await Promise.all(["first", "second"].map(async (label) => (
        sharp({ create: { width: 3, height: 3, channels: 4, background: label === "first" ? "#0369a1" : "#a16207" } })
          .png().toBuffer()
      )));
      const rollbackRequests = rollbackBytes.map((bytes, index) => normalizedRequest(
        ownerUserId,
        `rollback-${index}-${crypto.randomUUID()}`,
        bytes,
      ));
      const rollbackReservations = await Promise.all(rollbackRequests.map((rollbackRequest, index) => (
        publisher.publication.reserve({
          request: rollbackRequest,
          leaseOwner: `e3f-partial-rollback-${index}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        })
      )));
      await expect(withTransaction(pool, async (client) => {
        await publisher.publication.attachInTransaction(client, rollbackReservations[0]!, async () => ({ contexts: [], references: [] }));
        await publisher.publication.attachInTransaction(client, rollbackReservations[1]!, async () => {
          throw new Error("e3f deliberate second-asset import rollback");
        });
      })).rejects.toThrow("normalized_asset_publication_attachment_failed");
      await Promise.all(rollbackReservations.map((reservation) => publisher.publication.discardAfterRollback(reservation)));

      await expect(pool.query<{ assets: string; attached: string }>(
        `SELECT
           (SELECT count(*)::text FROM assets WHERE owner_user_id=$1 AND content_hash=ANY($2::text[])) AS assets,
           (SELECT count(*)::text FROM durable_filesystem_operations
             WHERE owner_user_id=$1 AND asset_id IS NOT NULL AND lifecycle IN ('attached','finalized')
               AND asset_id IN (
                 SELECT canonical_asset_id FROM asset_publication_requests
                  WHERE owner_user_id=$1 AND idempotency_key_hash=ANY($3::text[])
               )) AS attached`,
        [
          ownerUserId,
          rollbackRequests.map((rollbackRequest) => rollbackRequest.original.contentHash),
          rollbackRequests.map((rollbackRequest) => createHash("sha256").update(rollbackRequest.idempotencyKey, "utf8").digest("hex")),
        ],
      )).resolves.toMatchObject({ rows: [{ assets: "0", attached: "0" }] });

      const backfillBytes = await sharp({
        create: { width: 11, height: 7, channels: 4, background: "#4f46e5" },
      }).png().toBuffer();
      const backfillHash = createHash("sha256").update(backfillBytes).digest("hex");
      const backfillPath = `assets/content/${backfillHash}`;
      await mkdir(join(root, "assets", "content"), { recursive: true });
      await writeFile(join(root, backfillPath), backfillBytes, { flag: "wx" });
      const backfillAsset = await pool.query<{ id: string }>(
        `INSERT INTO assets (
           owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length,pixel_width,pixel_height,technical_metadata
         ) VALUES ($1,$2,'filesystem',$3,'image/png',$4,NULL,NULL,'{}'::jsonb) RETURNING id`,
        [ownerUserId, backfillHash, backfillPath, backfillBytes.byteLength],
      );
      const backfillAssetId = backfillAsset.rows[0]!.id;
      await pool.query(
        `INSERT INTO asset_metadata_backfill_jobs (owner_user_id,asset_id,status,next_attempt_at)
         VALUES ($1,$2,'queued',clock_timestamp())`,
        [ownerUserId, backfillAssetId],
      );
      const backfill = await createPrivateAssetMetadataBackfillComposition(pool, { archiveRoot: root, assetRoot: root });
      try {
        const [backfillResult, backfillReaperResult] = await Promise.all([
          backfill.executor.processOne({ workerId: "e3f-backfill-active", leaseSeconds: 30 }),
          recovery.executor.processAssetOne({ workerId: "e3f-backfill-reaper", leaseSeconds: 30, limit: 2 }),
        ]);
        expect(backfillResult).toEqual({ outcome: "completed", assetId: backfillAssetId });
        expect(backfillReaperResult.cleaned).toBe(0);
      } finally {
        await backfill.close();
      }
      await expect(pool.query<{ status: string; thumbnails: string }>(
        `SELECT job.status,
                (SELECT count(*)::text FROM asset_derivatives derivative
                  WHERE derivative.owner_user_id=job.owner_user_id AND derivative.source_asset_id=job.asset_id
                    AND derivative.derivative_kind='thumbnail' AND derivative.transform_version=1) AS thumbnails
           FROM asset_metadata_backfill_jobs job WHERE job.owner_user_id=$1 AND job.asset_id=$2`,
        [ownerUserId, backfillAssetId],
      )).resolves.toMatchObject({ rows: [{ status: "completed", thumbnails: "1" }] });
      await expect(stat(join(root, backfillPath))).resolves.toMatchObject({ size: backfillBytes.byteLength });
    } finally {
      await Promise.all([publisher.close(), replayPublisher.close(), recovery.close()]);
      await secondPool.end();
    }
  }, 30_000);

  it("races isolated private e5 backfills once, then survives e6/e7 restart before active thumbnail delivery", async () => {
    await retireExistingMetadataBackfillCandidates(pool);
    const bytes = await sharp({ create: { width: 9, height: 7, channels: 4, background: "#7c3aed" } }).png().toBuffer();
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const relativePath = `assets/content/${contentHash}`;
    await mkdir(join(root, "assets", "content"), { recursive: true });
    await writeFile(join(root, relativePath), bytes, { flag: "wx" });
    const source = await pool.query<{ id: string }>(
      `INSERT INTO assets (
         owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length,
         pixel_width,pixel_height,technical_metadata
       ) VALUES ($1,$2,'filesystem',$3,'image/png',$4,NULL,NULL,'{}'::jsonb)
       RETURNING id`,
      [ownerUserId, contentHash, relativePath, bytes.byteLength],
    );
    const assetId = source.rows[0]!.id;
    await pool.query(
      `INSERT INTO asset_metadata_backfill_jobs (owner_user_id,asset_id,status,next_attempt_at)
       VALUES ($1,$2,'queued',clock_timestamp())`,
      [ownerUserId, assetId],
    );

    const secondPool = createDatabasePool(databaseUrl!, 4);
    const first = await createPrivateAssetMetadataBackfillComposition(pool, { archiveRoot: root, assetRoot: root });
    const second = await createPrivateAssetMetadataBackfillComposition(secondPool, { archiveRoot: root, assetRoot: root });
    try {
      const outcomes = await Promise.all([
        first.executor.processOne({ workerId: "e3f-e5-first", leaseSeconds: 30 }),
        second.executor.processOne({ workerId: "e3f-e5-second", leaseSeconds: 30 }),
      ]);
      expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual(["completed", "idle"]);
    } finally {
      await Promise.all([first.close(), second.close()]);
      await secondPool.end();
    }
    await expect(pool.query<{ status: string; derivatives: string }>(
      `SELECT job.status,
              (SELECT count(*)::text FROM asset_derivatives derivative
                WHERE derivative.owner_user_id=job.owner_user_id AND derivative.source_asset_id=job.asset_id
                  AND derivative.derivative_kind='thumbnail' AND derivative.transform_version=1) AS derivatives
         FROM asset_metadata_backfill_jobs job WHERE job.owner_user_id=$1 AND job.asset_id=$2`,
      [ownerUserId, assetId],
    )).resolves.toMatchObject({ rows: [{ status: "completed", derivatives: "1" }] });

    const recovered = await createPrivateFilesystemRecoveryComposition(pool, { archiveRoot: root, assetRoot: root });
    try {
      await expect(recovered.executor.processAssetOne({ workerId: "e3f-e6-fresh", leaseSeconds: 30, limit: 1 }))
        .resolves.toMatchObject({ claimed: 0, finalized: 0, cleaned: 0, recoverable: 0, leaseLost: 0 });
    } finally {
      await recovered.close();
    }
    const maintenance = await createPrivateAssetMaintenanceComposition(pool, { archiveRoot: root, assetRoot: root });
    try {
      const tick = await maintenance.scheduler.tick({ workerId: "e3f-e7-fresh", leaseSeconds: 30 });
      expect(tick.attempted).toBe(1);
      expect(JSON.stringify(tick)).not.toMatch(/storage_path|relative_path|descriptor|bearer|credential|token/u);
    } finally {
      await maintenance.close();
    }

    const app = await buildServer(serverOptions({ config: config(root), pool }));
    try {
      const thumbnail = await app.inject({ method: "GET", url: `/api/v1/assets/${assetId}/thumbnail` });
      expect(thumbnail.statusCode).toBe(200);
      expect(thumbnail.headers["content-type"]).toContain("image/webp");
      expect(thumbnail.headers.etag).toMatch(/^"[a-f0-9]{64}"$/u);
      expect(thumbnail.rawPayload.byteLength).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});
