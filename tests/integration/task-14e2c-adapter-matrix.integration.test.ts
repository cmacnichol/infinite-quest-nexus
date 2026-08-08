import { createHash } from "node:crypto";
import { readFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import JSZip from "jszip";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toAssetMutationIdempotencyKey } from "../../packages/application/src/assets/index.js";
import {
  toPortableImportedRecordId,
  toPortableSourceInstallationId,
  type PortableImportKind,
  type PortableImportPreviewCommand,
  type PortableImportPreviewProjectionFor,
  type PortableImportResultProjectionFor
} from "../../packages/application/src/imports/index.js";
import {
  infiniteWorldsImportRequestSchema,
  storyImportRequestSchema
} from "../../packages/contracts/src/imports.js";
import { PROMPT_TEMPLATE_CATALOG, type PromptSnapshot } from "../../packages/contracts/src/prompt-library.js";
import { convertInfiniteWorldsWorld } from "../../packages/domain/src/infinite-worlds.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { writeArchiveArtifact, type ArchiveLimits } from "../../services/api/src/archive-io.js";
import {
  persistArchiveAssets,
  restoreAssetBindings,
  type ArchiveIdMap
} from "../../services/api/src/asset-archive-service.js";
import { previewLegacyStoryImport } from "../../services/api/src/import-service.js";
import {
  previewInfiniteWorldsImport,
  type InfiniteWorldsApiProviders
} from "../../services/api/src/infinite-worlds-import-service.js";
import { createTask14e2cAdapters } from "../helpers/task-14e2c-adapters.js";
import {
  importInfiniteWorldsWithClient,
  importLegacyStoryWithClient,
  portableWorldApplicationForTest,
  transactionBoundPortableWorldApplicationForTest
} from "../helpers/memory-aware-services.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const limits: ArchiveLimits = {
  maxCompressedBytes: 2_000_000,
  maxUncompressedBytes: 4_000_000,
  maxEntries: 100,
  maxExpansionRatio: 100,
  maxManifestBytes: 100_000,
  maxJsonEntryBytes: 500_000,
  maxOriginalImageBytes: 1_000_000
};
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function deterministicInfiniteWorldsProviders(): InfiniteWorldsApiProviders {
  const snapshot = Object.fromEntries(Object.entries(PROMPT_TEMPLATE_CATALOG).map(([key, definition]) => [
    key,
    { content: definition.defaultContent, hash: `task-14e2c-${key}`, source: "shipped" }
  ])) as PromptSnapshot;
  const convertedWorld = JSON.stringify({
    title: "Task 14e2c provider-converted world text",
    genre: "Archive fantasy",
    tone: "Deterministic",
    backgroundStory: "A quiet archive city preserves every authoritative record.",
    premise: "Test Character verifies the durable archive.",
    firstAction: "Inspect the transaction ledger.",
    story_rules: "Every committed record must be recoverable.",
    player_character: "",
    playable_characters: [{
      name: "Test Character",
      character_text: "A careful archivist who verifies transaction boundaries.",
      rpg_statistics: [],
      default_triggers: []
    }],
    rpg_statistics: [],
    default_triggers: [],
    event_triggers: []
  });
  return {
    resolution: {
      async resolveDirect(request) {
        return {
          status: "resolved",
          requestedRole: request.providerRole,
          resolvedRole: request.providerRole,
          providerProfileId: request.selectedProviderProfileId ?? "task-14e2c-provider",
          providerType: "openai_compatible",
          model: request.model ?? "task-14e2c-model"
        };
      },
      async resolveEmbedding() {
        return { status: "unconfigured", requestedRole: "embedding", resolvedRole: null, source: "none" };
      }
    },
    prompts: {
      async loadInfiniteWorldsPromptSnapshot() {
        return { catalogVersion: "task-14e2c", protocolVersion: "task-14e2c", snapshot };
      }
    },
    promptTools: {
      content(current, key) {
        return current[key].content;
      }
    },
    execution: {
      async text() {
        return {
          async execute() {
            return {
              content: convertedWorld,
              responseId: "task-14e2c-response",
              finishReason: "stop",
              outputLimited: false,
              modelInstanceId: "task-14e2c-instance",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              reportedCost: null,
              rawMetadata: {}
            };
          }
        };
      }
    },
    async generateCyoaWorld() {
      const generated = convertInfiniteWorldsWorld({
        title: "Task 14e2c provider-generated CYOA world",
        background: "A generated archive realm proves the CYOA service branch ran.",
        possibleCharacters: [{ name: "Test Character", description: "A deterministic generated character." }]
      });
      return { title: generated.title, content: generated.content };
    },
    diagnoseWorldGenerationFailure(error) {
      return { message: error instanceof Error ? error.message : "Deterministic world generation failed." };
    }
  };
}

integration("Task 14e2c additive adapter contract matrix", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  let foreignOwnerUserId = "";
  let zipBytes = Buffer.alloc(0);
  let legacyStoryFixture: Record<string, unknown> = {};
  let cyoaFixture = "";
  const roots: string[] = [];

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 8);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    const foreign = await pool.query<{ id: string }>(
      "INSERT INTO users (system_key,display_name) VALUES ($1,$2) RETURNING id",
      [`task-14e2c-foreign-${crypto.randomUUID()}`, "Task 14e2c foreign owner"]
    );
    foreignOwnerUserId = foreign.rows[0]!.id;
    legacyStoryFixture = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    cyoaFixture = await readFile(resolve("tests/fixtures/cyoa_writing_com_sample.json"), "utf8");
    const sourceRoot = await root("iq-14e2c-source-");
    const artifact = await writeArchiveArtifact(sourceRoot, [{
      path: "records/legacy-story.json",
      logicalType: "records",
      mediaType: "application/json",
      source: Readable.from(Buffer.from('{"title":"Adapter Story"}', "utf8"))
    }], (entries) => ({
      format: "infinite-quest-archive",
      formatVersion: 1,
      archiveType: "system",
      createdAt: "2026-08-08T00:00:00.000Z",
      contentFingerprint: "a".repeat(64),
      entries: [...entries],
      payloads: entries.map((entry) => ({ kind: "records" as const, path: entry.path, formatVersion: 1 })),
      assets: []
    }), limits);
    zipBytes = await readFile(artifact.absolutePath);
  });

  afterAll(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    await pool.end();
  });

  async function root(prefix: string): Promise<string> {
    const value = await mkdtemp(join(tmpdir(), prefix));
    roots.push(value);
    return value;
  }

  function hash(value: string | Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
  }

  async function worldScope(scopedOwner = ownerUserId) {
    const content = convertInfiniteWorldsWorld({
      title: "Task 14e2c target world",
      background: "A test-only world used to validate import composition.",
      possibleCharacters: [{ name: "Test Character", description: "A deterministic test character." }]
    }).content;
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title) VALUES ($1,$2) RETURNING id",
      [scopedOwner, `Task 14e2c world ${crypto.randomUUID()}`]
    );
    const version = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id,owner_user_id,version_number,content)
       VALUES ($1,$2,1,$3::jsonb) RETURNING id`,
      [world.rows[0]!.id, scopedOwner, JSON.stringify(content)]
    );
    const campaign = await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id,world_version_id,title) VALUES ($1,$2,$3) RETURNING id",
      [scopedOwner, version.rows[0]!.id, "Task 14e2c campaign"]
    );
    const turn = await pool.query<{ id: string }>(
      "INSERT INTO turns (owner_user_id,campaign_id,turn_number,narration) VALUES ($1,$2,1,$3) RETURNING id",
      [scopedOwner, campaign.rows[0]!.id, "A test scene waits for its illustration."]
    );
    return {
      worldId: world.rows[0]!.id,
      worldVersionId: version.rows[0]!.id,
      campaignId: campaign.rows[0]!.id,
      turnId: turn.rows[0]!.id
    };
  }

  async function asset(scopedOwner = ownerUserId, dimensions: readonly [number | null, number | null] = [null, null]) {
    const contentHash = hash(crypto.randomUUID());
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO assets (
         owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length,pixel_width,pixel_height
       ) VALUES ($1,$2,'filesystem',$3,'image/png',128,$4,$5) RETURNING id`,
      [scopedOwner, contentHash, `originals/legacy-${contentHash}.png`, dimensions[0], dimensions[1]]
    );
    return { assetId: inserted.rows[0]!.id, contentHash };
  }

  function lifecycleLegacyVariant(scope: Awaited<ReturnType<typeof worldScope>>) {
    return {
      command: {
        kind: "legacy_story" as const,
        destination: {
          kind: "existing_world_version" as const,
          worldId: scope.worldId,
          worldVersionId: scope.worldVersionId
        }
      },
      projection: {
        kind: "campaign" as const,
        valid: true as const,
        title: "Legacy Story lifecycle fixture",
        duplicate: false,
        existingCampaignId: null,
        counts: { turns: 2, completeHistoryCharacters: 20, estimatedHistoryTokens: 5 },
        warnings: [] as string[]
      }
    };
  }

  function portableResult(
    kind: PortableImportKind,
    importId: string,
    scope: Awaited<ReturnType<typeof worldScope>>,
  ): PortableImportResultProjectionFor<PortableImportKind> {
    if (kind === "campaign_zip") {
      return {
        importId,
        worldId: scope.worldId,
        worldVersionId: scope.worldVersionId,
        campaignId: scope.campaignId,
        duplicate: false,
        stats: { turnCount: 2, memoryCount: 2, summaryCount: 1, assetCount: 1, assetBytes: 42 }
      };
    }
    if (kind === "legacy_story" || kind === "story_text") {
      return {
        ...(kind === "story_text" ? { kind: "campaign" as const } : {}),
        importId,
        worldId: scope.worldId,
        worldVersionId: scope.worldVersionId,
        campaignId: scope.campaignId,
        duplicate: false,
        stats: {
          turnCount: 2,
          memoryCount: 2,
          completeHistoryCharacters: 20,
          estimatedHistoryTokens: 5,
          importedSummary: true,
          sanitizedMemoryCount: 2
        }
      };
    }
    return {
      kind: "world",
      importId,
      worldId: scope.worldId,
      worldVersionId: scope.worldVersionId,
      duplicate: false
    };
  }

  async function wrapPortableSource(path: string, content: string): Promise<Buffer> {
    const sourceRoot = await root("iq-14e2c-variant-source-");
    const artifact = await writeArchiveArtifact(sourceRoot, [{
      path,
      logicalType: "records",
      mediaType: path.endsWith(".json") ? "application/json" : "text/plain",
      source: Readable.from(Buffer.from(content, "utf8"))
    }], (entries) => ({
      format: "infinite-quest-archive",
      formatVersion: 1,
      archiveType: "system",
      createdAt: "2026-08-08T00:00:00.000Z",
      contentFingerprint: hash(content),
      entries: [...entries],
      payloads: [{ kind: "records", path, formatVersion: 1 }],
      assets: []
    }), limits);
    return readFile(artifact.absolutePath);
  }

  async function legacyCampaignZip(label: string) {
    const sourceAssetId = crypto.randomUUID();
    const sourceCampaignId = crypto.randomUUID();
    const sourceWorldVersionId = crypto.randomUUID();
    const sourceTurnId = crypto.randomUUID();
    const story = structuredClone(legacyStoryFixture) as Record<string, any>;
    story.format = "infinite-quest-campaign";
    story.formatVersion = 3;
    story.campaign = {
      title: label,
      sourceCampaignId,
      sourceWorldVersionId,
      sourceWorldVersionNumber: 1,
      selectedCharacterId: null,
      characterSnapshot: null,
      characterProfile: null,
      characterProfileRevision: 0,
      stateRevision: 0
    };
    story.turns[0] = {
      ...story.turns[0],
      id: sourceTurnId,
      imageUrl: `/api/v1/assets/${sourceAssetId}`
    };
    const archive = new JSZip();
    archive.file("campaign.json", JSON.stringify(story));
    archive.file(`assets/${sourceAssetId}.png`, tinyPng);
    return {
      bytes: await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
      sourceAssetId,
      sourceCampaignId,
      sourceWorldVersionId,
      sourceTurnId
    };
  }

  it("reserves durable staging before filesystem mutation and denies the resulting handle to another owner", async () => {
    const storageRoot = await root("iq-14e2c-storage-");
    const adapters = createTask14e2cAdapters({
      pool,
      archiveRoot: storageRoot,
      assetRoot: storageRoot,
      limits
    });

    const staged = await adapters.archive.stage(
      { ownerUserId },
      Readable.from(zipBytes),
      zipBytes.byteLength,
    );
    const inspection = await adapters.archive.inspect({ ownerUserId }, staged, "container");

    expect(inspection.entries.map((entry) => entry.path)).toContain("records/legacy-story.json");
    await expect(adapters.archive.inspect(
      { ownerUserId: foreignOwnerUserId },
      staged,
      "container",
    )).rejects.toEqual({ code: "archive_unavailable" });
    const operation = await pool.query<{ lifecycle: string; purpose: string }>(
      `SELECT operation.lifecycle,operation.purpose
         FROM portable_staged_inputs staged
         JOIN durable_filesystem_operations operation ON operation.id=staged.filesystem_operation_id
        WHERE staged.owner_user_id=$1`,
      [ownerUserId]
    );
    expect(operation.rows.at(-1)).toEqual({ lifecycle: "finalized", purpose: "portable_staging" });
    const restarted = createTask14e2cAdapters({
      pool,
      archiveRoot: storageRoot,
      assetRoot: storageRoot,
      limits
    });
    await restarted.archive.abort({ ownerUserId: foreignOwnerUserId }, staged);
    expect((await readdir(storageRoot, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())).toHaveLength(1);
    await restarted.archive.abort({ ownerUserId }, staged);
    const cleaned = await pool.query<{ lifecycle: string; status: string }>(
      `SELECT operation.lifecycle,staged.status
         FROM portable_staged_inputs staged
         JOIN durable_filesystem_operations operation ON operation.id=staged.filesystem_operation_id
        WHERE staged.owner_user_id=$1`,
      [ownerUserId]
    );
    expect(cleaned.rows.at(-1)).toEqual({ lifecycle: "cleaned", status: "cleaned" });
  });

  it("composes selection clear, metadata, derivative delivery, and database-owned backfill leases", async () => {
    const storageRoot = await root("iq-14e2c-assets-");
    const adapters = createTask14e2cAdapters({ pool, archiveRoot: storageRoot, assetRoot: storageRoot, limits });
    const target = await worldScope();
    const selected = await asset(ownerUserId, [640, 360]);
    const thumbnailHash = hash(`thumbnail:${selected.assetId}`);
    await pool.query(
      `INSERT INTO asset_derivatives (
         owner_user_id,source_asset_id,derivative_kind,transform_version,pixel_width,pixel_height,
         storage_driver,storage_path,mime_type,byte_length,content_hash
       ) VALUES ($1,$2,'thumbnail',1,480,270,'filesystem',$3,'image/webp',64,$4)`,
      [ownerUserId, selected.assetId, `derivatives/${thumbnailHash}.webp`, thumbnailHash]
    );
    await pool.query(
      "UPDATE asset_metadata_backfill_jobs SET next_attempt_at=now()+interval '1 day' WHERE owner_user_id=$1 AND asset_id=$2",
      [ownerUserId, selected.assetId]
    );

    await expect(adapters.assets.selectTurnIllustration(
      { ownerUserId, campaignId: target.campaignId, turnId: target.turnId },
      { assetId: selected.assetId, idempotencyKey: toAssetMutationIdempotencyKey(`select-${crypto.randomUUID()}`) },
    )).resolves.toEqual({ assetId: selected.assetId, selected: true });
    const cleared = await adapters.assets.selectTurnIllustration(
      { ownerUserId, campaignId: target.campaignId, turnId: target.turnId },
      { assetId: null, idempotencyKey: toAssetMutationIdempotencyKey(`clear-${crypto.randomUUID()}`) },
    );
    expect(cleared).toEqual({ assetId: null, selected: false });

    const metadata = await adapters.assets.updateAssetMetadata(
      { ownerUserId, assetId: selected.assetId },
      {
        expectedRevision: 1,
        title: "Adapter remapped illustration",
        tags: ["archive-remap", "illustration"],
        idempotencyKey: toAssetMutationIdempotencyKey(`metadata-${crypto.randomUUID()}`)
      },
    );
    expect(metadata).toEqual({ assetId: selected.assetId, metadataRevision: 2 });
    await expect(adapters.assets.describeAssetDelivery(
      { ownerUserId, assetId: selected.assetId },
      { kind: "derivative", derivativeKind: "thumbnail" },
    )).resolves.toMatchObject({
      assetId: selected.assetId,
      kind: "derivative",
      derivativeKind: "thumbnail",
      mimeType: "image/webp",
      byteLength: 64,
      etag: thumbnailHash
    });
    await expect(adapters.assets.describeAssetDelivery(
      { ownerUserId: foreignOwnerUserId, assetId: selected.assetId },
      { kind: "original" },
    )).rejects.toMatchObject({ code: "asset_not_found" });

    const incomplete = await asset(foreignOwnerUserId);
    await pool.query(
      "INSERT INTO asset_metadata_backfill_jobs (owner_user_id,asset_id) VALUES ($1,$2)",
      [foreignOwnerUserId, incomplete.assetId]
    );
    const [workerA, workerB] = await Promise.all([
      adapters.assets.claimNextMetadataBackfill({ workerId: "task-14e2c-worker-a", leaseSeconds: 60 }),
      adapters.assets.claimNextMetadataBackfill({ workerId: "task-14e2c-worker-b", leaseSeconds: 60 })
    ]);
    const claims = [workerA, workerB].filter((claim) => claim !== null);
    expect(claims).toHaveLength(1);
    const claim = claims[0]!;
    expect(claim.ownerUserId).toBe(foreignOwnerUserId);
    expect(claim.assetId).toBe(incomplete.assetId);
    await expect(adapters.assets.heartbeatMetadataBackfill(
      { ...claim, leaseId: crypto.randomUUID() },
      { leaseSeconds: 60 }
    )).resolves.toEqual({ outcome: "lease_lost" });
    await expect(adapters.assets.heartbeatMetadataBackfill(
      { ...claim, leaseOwner: "task-14e2c-wrong-worker" },
      { leaseSeconds: 60 }
    )).resolves.toEqual({ outcome: "lease_lost" });
    const renewed = await adapters.assets.heartbeatMetadataBackfill(claim, { leaseSeconds: 60 });
    expect(renewed).toMatchObject({ outcome: "renewed", claim: { ownerUserId: foreignOwnerUserId } });
    await pool.query(
      "UPDATE asset_metadata_backfill_jobs SET lease_expires_at=now()-interval '1 second' WHERE owner_user_id=$1 AND asset_id=$2",
      [foreignOwnerUserId, incomplete.assetId]
    );
    await expect(adapters.assets.heartbeatMetadataBackfill(claim, { leaseSeconds: 60 }))
      .resolves.toEqual({ outcome: "lease_lost" });
    const reclaimed = await adapters.assets.claimNextMetadataBackfill({
      workerId: "task-14e2c-worker-reclaimed",
      leaseSeconds: 60
    });
    expect(reclaimed).toMatchObject({
      ownerUserId: foreignOwnerUserId,
      assetId: incomplete.assetId,
      leaseOwner: "task-14e2c-worker-reclaimed"
    });
    if (!reclaimed) throw new Error("Expected expired work to be reclaimed.");
    expect(reclaimed.workVersion).toBeGreaterThan(claim.workVersion);
    await expect(adapters.assets.heartbeatMetadataBackfill(claim, { leaseSeconds: 60 }))
      .resolves.toEqual({ outcome: "stale" });
    await expect(adapters.assets.requeueMetadataBackfill(reclaimed, {
      diagnosticCode: "asset_storage_unavailable"
    })).resolves.toEqual({ outcome: "requeued" });
    const retry = await adapters.assets.claimNextMetadataBackfill({
      workerId: "task-14e2c-worker-retry",
      leaseSeconds: 60
    });
    expect(retry).toMatchObject({ ownerUserId: foreignOwnerUserId, assetId: incomplete.assetId });
    if (!retry) throw new Error("Expected requeued work to be reclaimed.");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await expect(adapters.assets.backfillMetadata(client, {
        ...retry,
        leaseOwner: "task-14e2c-wrong-worker"
      })).resolves.toEqual({ assetId: incomplete.assetId, outcome: "lease_lost" });
      await expect(adapters.assets.backfillMetadata(client, claim))
        .resolves.toEqual({ assetId: incomplete.assetId, outcome: "stale" });
      const failed = await adapters.assets.backfillMetadata(client, retry);
      expect(failed).toEqual({
        assetId: incomplete.assetId,
        outcome: "safe_failure",
        diagnosticCode: "asset_metadata_unavailable"
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const diagnostic = await pool.query<{ diagnostic_code: string; leaked: string | null }>(
      `SELECT diagnostic_code,
              CASE WHEN diagnostic_code LIKE '%/%' OR diagnostic_code LIKE '%Error%' THEN diagnostic_code END AS leaked
         FROM asset_metadata_backfill_jobs
        WHERE owner_user_id=$1 AND asset_id=$2`,
      [foreignOwnerUserId, incomplete.assetId]
    );
    expect(diagnostic.rows[0]).toEqual({ diagnostic_code: "asset_metadata_unavailable", leaked: null });
  });

  it("parses and commits all eight legacy variants through durable adapters and remaps campaign assets", async () => {
    const storageRoot = await root("iq-14e2c-portable-");
    const adapters = createTask14e2cAdapters({ pool, archiveRoot: storageRoot, assetRoot: storageRoot, limits });
    const scope = await worldScope();
    const portableWorld = portableWorldApplicationForTest(pool, "task-14e2c-credential-secret");
    const providers = deterministicInfiniteWorldsProviders();
    const embeddedCampaign = await legacyCampaignZip("Campaign ZIP embedded create-world");
    const existingCampaign = await legacyCampaignZip("Campaign ZIP existing version");
    const storyText = `-- Story Background --
A deterministic adapter story.
-- Character --
Test Character
-- Turn 1 --
Outcome
-------
Test Character enters the archive hall.
-- Turn 2 --
Action
------
Inspect the durable record
Outcome
-------
The durable record is verified.`;
    const worldJson = JSON.stringify({
      title: "Task 14e2c Infinite Worlds",
      background: "A deterministic imported world.",
      objective: "Validate the composed import path.",
      possibleCharacters: [{ name: "Test Character", description: "A portable test character." }],
      triggerEvents: [{ name: "Arrival", triggerOnStartOfGame: true, triggerEffects: ["Begin the test."] }]
    });
    const legacyStoryJson = JSON.stringify({
      ...structuredClone(legacyStoryFixture),
      world: { ...(legacyStoryFixture.world as object), title: `Legacy Story ${crypto.randomUUID()}` }
    });
    const variants = [
      {
        label: "campaign ZIP embedded create-world",
        kind: "campaign_zip" as const,
        destination: { kind: "embedded", operation: "create_world" } as const,
        bytes: embeddedCampaign.bytes,
        campaign: embeddedCampaign,
        sourceInstallationId: toPortableSourceInstallationId(foreignOwnerUserId)
      },
      {
        label: "campaign ZIP existing version",
        kind: "campaign_zip" as const,
        destination: {
          kind: "existing_world_version",
          worldId: scope.worldId,
          worldVersionId: scope.worldVersionId
        } as const,
        bytes: existingCampaign.bytes,
        campaign: existingCampaign
      },
      {
        label: "Legacy Story existing version",
        kind: "legacy_story" as const,
        destination: {
          kind: "existing_world_version",
          worldId: scope.worldId,
          worldVersionId: scope.worldVersionId
        } as const,
        bytes: await wrapPortableSource("records/legacy-story.json", legacyStoryJson),
        entryPath: "records/legacy-story.json"
      },
      {
        label: "story text existing version",
        kind: "story_text" as const,
        destination: {
          kind: "existing_world_version",
          worldId: scope.worldId,
          worldVersionId: scope.worldVersionId
        } as const,
        bytes: await wrapPortableSource("records/story.txt", storyText),
        entryPath: "records/story.txt"
      },
      {
        label: "infinite_worlds create-world",
        kind: "infinite_worlds" as const,
        destination: { kind: "create_world" } as const,
        bytes: await wrapPortableSource("records/infinite-worlds.json", worldJson),
        entryPath: "records/infinite-worlds.json",
        sourceKind: "auto" as const
      },
      {
        label: "world_json create-world",
        kind: "world_json" as const,
        destination: { kind: "create_world" } as const,
        bytes: await wrapPortableSource("records/world.json", JSON.stringify({
          ...JSON.parse(worldJson),
          title: "Task 14e2c explicit world JSON"
        })),
        entryPath: "records/world.json",
        sourceKind: "world_json" as const
      },
      {
        label: "CYOA create-world",
        kind: "cyoa" as const,
        destination: { kind: "create_world" } as const,
        bytes: await wrapPortableSource("records/cyoa.json", cyoaFixture),
        entryPath: "records/cyoa.json",
        sourceKind: "cyoa_json" as const
      },
      {
        label: "world text create-world",
        kind: "world_text" as const,
        destination: { kind: "create_world" } as const,
        bytes: await wrapPortableSource(
          "records/world.txt",
          "A quiet archive city where Test Character verifies durable records and follows safe recovery rules."
        ),
        entryPath: "records/world.txt",
        sourceKind: "world_text" as const
      }
    ];
    const labels: string[] = [];
    const remappedAssets: Array<{ sourceAssetId: string; destinationAssetId: string }> = [];

    for (const variant of variants) {
      const stagedInput = await adapters.archive.stage(
        { ownerUserId },
        Readable.from(variant.bytes),
        variant.bytes.byteLength,
      );
      let projection: PortableImportPreviewProjectionFor<PortableImportKind>;
      let completion: (
        client: import("../../packages/database/src/pool.js").DatabaseClient,
      ) => Promise<any>;

      if (variant.kind === "campaign_zip") {
        const inspection = await adapters.archive.inspect({ ownerUserId }, stagedInput, "container");
        expect(inspection.entries.map((entry) => entry.path)).toEqual([
          "campaign.json",
          `assets/${variant.campaign.sourceAssetId}.png`
        ]);
        const decoded = await adapters.archive.parseLegacyCampaignZip({ ownerUserId }, stagedInput);
        expect(decoded.assets.originals).toHaveLength(1);
        expect(decoded.assets.records[0]?.sourceAssetId).toBe(variant.campaign.sourceAssetId);
        const campaignData = decoded.campaign.campaign as Record<string, unknown>;
        const decodedTurns = Array.isArray(decoded.campaign.turns) ? decoded.campaign.turns : [];
        const decodedWorldContent = decoded.world.content as Record<string, unknown>;
        projection = {
          valid: true,
          archiveType: "campaign",
          formatVersion: 1,
          contentFingerprint: decoded.contentFingerprint,
          campaign: {
            title: String(campaignData.title),
            sourceCampaignId: String(campaignData.sourceCampaignId),
            acceptedTurnCount: decodedTurns.length,
            activeTurnNumber: decodedTurns.length,
            selectedCharacter: null
          },
          world: {
            title: String((decodedWorldContent.world as Record<string, unknown>).title),
            sourceWorldId: decoded.world.sourceWorldId,
            sourceWorldVersionId: decoded.world.sourceWorldVersionId,
            versionNumber: decoded.world.versionNumber
          },
          chronicle: {
            memoryCount: decoded.chronicle.memories.length,
            summaryCount: decoded.chronicle.summaries.length
          },
          assets: {
            originalCount: decoded.assets.originals.length,
            totalBytes: decoded.assets.originals.reduce((sum, asset) => sum + asset.byteLength, 0)
          },
          destination: variant.destination.kind === "embedded"
            ? { kind: "embedded", operation: "create_world", worldId: null, worldVersionId: null }
            : {
                kind: "existing_world_version",
                operation: "attach_existing_world_version",
                worldId: variant.destination.worldId,
                worldVersionId: variant.destination.worldVersionId
              },
          providerDataIncluded: false,
          warnings: decoded.warnings
        };
        const request = storyImportRequestSchema.parse({
          sourceName: `${variant.label}.zip`,
          story: decoded.campaign,
          ...(variant.destination.kind === "existing_world_version"
            ? { targetWorldVersionId: variant.destination.worldVersionId }
            : {})
        });
        const parsedPreview = await previewLegacyStoryImport(pool, request);
        expect(parsedPreview).toMatchObject({ valid: true, counts: { turns: 2 } });
        completion = async (client) => {
          const imported = await importLegacyStoryWithClient(pool, client, request);
          const destinationTurns = await client.query<{ id: string; source_turn_id: string }>(
            `SELECT id,source_turn_id FROM turns
              WHERE owner_user_id=$1 AND campaign_id=$2 AND source_turn_id IS NOT NULL`,
            [ownerUserId, imported.campaignId]
          );
          const idMap = new Map() as ArchiveIdMap;
          idMap.set("world", new Map([[decoded.world.sourceWorldId, imported.worldId]]));
          idMap.set("worldVersion", new Map([[decoded.world.sourceWorldVersionId, imported.worldVersionId]]));
          idMap.set("campaign", new Map([[String(campaignData.sourceCampaignId), imported.campaignId]]));
          idMap.set("turn", new Map(destinationTurns.rows.map((turn) => [turn.source_turn_id, turn.id])));
          const restored = await persistArchiveAssets(client, { root: storageRoot }, ownerUserId, decoded.assets, idMap);
          await restoreAssetBindings(client, ownerUserId, decoded.inspected.manifest.assets, restored.assetIds, idMap);
          const destinationAssetId = restored.assetIds.get(variant.campaign.sourceAssetId);
          if (!destinationAssetId) throw new Error("Expected campaign asset remapping.");
          remappedAssets.push({ sourceAssetId: variant.campaign.sourceAssetId, destinationAssetId });
          return {
            importId: imported.importId,
            importedRecordId: toPortableImportedRecordId(imported.importId),
            duplicate: imported.duplicate,
            diagnostics: [],
            result: {
              importId: imported.importId,
              worldId: imported.worldId,
              worldVersionId: imported.worldVersionId,
              campaignId: imported.campaignId,
              duplicate: imported.duplicate,
              stats: {
                turnCount: decodedTurns.length,
                memoryCount: decoded.chronicle.memories.length,
                summaryCount: decoded.chronicle.summaries.length,
                assetCount: decoded.assets.originals.length,
                assetBytes: decoded.assets.originals.reduce((sum, asset) => sum + asset.byteLength, 0)
              }
            },
            resultExpiresAt: new Date(Date.now() + 60_000).toISOString()
          };
        };
      } else {
        await adapters.archive.inspect({ ownerUserId }, stagedInput, "system");
        const extracted = await adapters.archive.extract(
          { ownerUserId },
          stagedInput,
          variant.entryPath,
          limits.maxJsonEntryBytes,
        );
        const sourceText = Buffer.from(extracted.content).toString("utf8");
        if (variant.kind === "legacy_story") {
          const request = storyImportRequestSchema.parse({
            sourceName: variant.entryPath,
            story: JSON.parse(sourceText),
            targetWorldVersionId: scope.worldVersionId
          });
          projection = await previewLegacyStoryImport(pool, request);
          completion = async (client) => {
            const imported = await importLegacyStoryWithClient(pool, client, request);
            return {
              importId: imported.importId,
              importedRecordId: toPortableImportedRecordId(imported.importId),
              duplicate: imported.duplicate,
              diagnostics: [],
              result: imported,
              resultExpiresAt: new Date(Date.now() + 60_000).toISOString()
            };
          };
        } else {
          const request = infiniteWorldsImportRequestSchema.parse({
            sourceName: variant.entryPath,
            sourceText,
            sourceKind: variant.kind === "story_text" ? "story_text" : variant.sourceKind,
            ...(variant.kind === "story_text" ? { targetWorldVersionId: scope.worldVersionId } : {}),
            ...(["cyoa", "world_text"].includes(variant.kind)
              ? { providerProfileId: crypto.randomUUID() }
              : {})
          });
          projection = await previewInfiniteWorldsImport(pool, request, portableWorld) as typeof projection;
          completion = async (client) => {
            const transactionBoundPortableWorld = await transactionBoundPortableWorldApplicationForTest(
              pool,
              client,
              "task-14e2c-credential-secret",
            );
            const imported = await importInfiniteWorldsWithClient(
              pool,
              client,
              request,
              providers,
              transactionBoundPortableWorld,
            );
            return {
              importId: imported.importId,
              importedRecordId: toPortableImportedRecordId(imported.importId),
              duplicate: imported.duplicate,
              diagnostics: [],
              result: imported,
              resultExpiresAt: new Date(Date.now() + 60_000).toISOString()
            };
          };
        }
      }
      const command = {
        ownerUserId,
        stagedInput,
        kind: variant.kind,
        destination: variant.destination,
        ...("sourceInstallationId" in variant ? {
          sourceInstallationId: variant.sourceInstallationId,
          importedRecordId: toPortableImportedRecordId(crypto.randomUUID())
        } : {})
      } as PortableImportPreviewCommand;
      const preview = await adapters.archive.preview({
        command,
        projection,
      });
      expect(await adapters.imports.retrievePreviewPayload(
        { ownerUserId: foreignOwnerUserId },
        command.kind,
        preview.previewHandle,
      )).toBeNull();

      const commitCommand = {
        ownerUserId,
        kind: command.kind,
        destination: command.destination,
        previewHandle: preview.previewHandle,
        idempotencyKey: `task-14e2c-${command.kind}-${crypto.randomUUID()}`
      };
      const committed = await adapters.archive.commit(commitCommand, completion).catch((error) => {
        throw new Error(`Task 14e2c variant '${variant.label}' failed to commit.`, { cause: error });
      });
      expect(committed.kind).toBe(command.kind);
      expect((await adapters.archive.retrieve(
        { ownerUserId },
        command.kind,
        committed.retrieval,
      ))?.kind).toBe(command.kind);
      const replay = await adapters.archive.commit(commitCommand, async () => {
        throw new Error("Exact idempotent replay must not repeat domain work.");
      });
      expect(replay).toEqual(committed);
      await adapters.archive.cleanup({ ownerUserId }, stagedInput);
      labels.push(variant.label);
    }

    expect(labels).toEqual([
      "campaign ZIP embedded create-world",
      "campaign ZIP existing version",
      "Legacy Story existing version",
      "story text existing version",
      "infinite_worlds create-world",
      "world_json create-world",
      "CYOA create-world",
      "world text create-world"
    ]);
    expect(remappedAssets).toHaveLength(2);
    expect(remappedAssets.every(({ sourceAssetId, destinationAssetId }) => sourceAssetId !== destinationAssetId))
      .toBe(true);
    const restoredTurns = await pool.query<{ image_url: string }>(
      `SELECT image_url FROM turns
        WHERE owner_user_id=$1 AND image_url = ANY($2::text[])`,
      [ownerUserId, remappedAssets.map(({ destinationAssetId }) => `/api/v1/assets/${destinationAssetId}`)]
    );
    expect(restoredTurns.rows).toHaveLength(2);
    const provenance = await pool.query<{ owner_user_id: string; source_installation_id: string }>(
      `SELECT owner_user_id,source_installation_id
         FROM portable_import_operations
        WHERE source_installation_id=$1`,
      [foreignOwnerUserId]
    );
    expect(provenance.rows).toEqual([{ owner_user_id: ownerUserId, source_installation_id: foreignOwnerUserId }]);
  });

  it("rolls back real import domain state with portable completion, then succeeds and replays exactly", async () => {
    const storageRoot = await root("iq-14e2c-transaction-bound-import-");
    const adapters = createTask14e2cAdapters({ pool, archiveRoot: storageRoot, assetRoot: storageRoot, limits });
    const scope = await worldScope();
    const sourceName = `task-14e2c-transaction-${crypto.randomUUID()}.json`;
    const campaignTitle = `Task 14e2c transaction ${crypto.randomUUID()}`;
    const story = {
      ...structuredClone(legacyStoryFixture),
      world: { ...(legacyStoryFixture.world as object), title: campaignTitle }
    };
    const bytes = await wrapPortableSource("records/transaction-bound-legacy.json", JSON.stringify(story));
    const stagedInput = await adapters.archive.stage(
      { ownerUserId },
      Readable.from(bytes),
      bytes.byteLength,
    );
    await adapters.archive.inspect({ ownerUserId }, stagedInput, "system");
    const extracted = await adapters.archive.extract(
      { ownerUserId },
      stagedInput,
      "records/transaction-bound-legacy.json",
      limits.maxJsonEntryBytes,
    );
    const request = storyImportRequestSchema.parse({
      sourceName,
      story: JSON.parse(Buffer.from(extracted.content).toString("utf8")),
      targetWorldVersionId: scope.worldVersionId
    });
    const projection = await previewLegacyStoryImport(pool, request);
    const command = {
      ownerUserId,
      stagedInput,
      kind: "legacy_story" as const,
      destination: {
        kind: "existing_world_version" as const,
        worldId: scope.worldId,
        worldVersionId: scope.worldVersionId
      }
    };
    const preview = await adapters.archive.preview({ command, projection });
    const commitCommand = {
      ownerUserId,
      kind: command.kind,
      destination: command.destination,
      previewHandle: preview.previewHandle,
      idempotencyKey: `task-14e2c-transaction-${crypto.randomUUID()}`
    };

    await expect(adapters.archive.commit(commitCommand, async (client) => {
      const imported = await importLegacyStoryWithClient(pool, client, request);
      expect((await client.query(
        "SELECT 1 FROM imports WHERE owner_user_id=$1 AND id=$2",
        [ownerUserId, imported.importId]
      )).rowCount).toBe(1);
      throw new Error("task_14e2c_forced_after_domain_mutation");
    })).rejects.toThrow("task_14e2c_forced_after_domain_mutation");

    expect((await pool.query(
      "SELECT 1 FROM imports WHERE owner_user_id=$1 AND source_name=$2",
      [ownerUserId, sourceName]
    )).rowCount).toBe(0);
    expect((await pool.query(
      "SELECT 1 FROM campaigns WHERE owner_user_id=$1 AND title=$2",
      [ownerUserId, campaignTitle]
    )).rowCount).toBe(0);
    expect((await pool.query<{ status: string }>(
      "SELECT status FROM portable_import_operations WHERE owner_user_id=$1 AND preview_token_hash=$2",
      [ownerUserId, hash(preview.previewHandle.token)]
    )).rows[0]).toEqual({ status: "previewed" });

    const committed = await adapters.archive.commit(commitCommand, async (client) => {
      const imported = await importLegacyStoryWithClient(pool, client, request);
      return {
        importId: imported.importId,
        importedRecordId: toPortableImportedRecordId(imported.importId),
        duplicate: imported.duplicate,
        diagnostics: [],
        result: imported,
        resultExpiresAt: new Date(Date.now() + 60_000).toISOString()
      };
    });
    expect(committed.duplicate).toBe(false);
    const replay = await adapters.archive.commit(commitCommand, async () => {
      throw new Error("Exact replay must not repeat transaction-bound domain work.");
    });
    expect(replay).toEqual(committed);
    expect((await pool.query(
      "SELECT 1 FROM imports WHERE owner_user_id=$1 AND source_name=$2 AND status='completed'",
      [ownerUserId, sourceName]
    )).rowCount).toBe(1);
    await adapters.archive.cleanup({ ownerUserId }, stagedInput);
  });

  it("cleans superseded, expired, aborted, rolled-back, and crash-recovered portable work", async () => {
    const storageRoot = await root("iq-14e2c-lifecycle-");
    const adapters = createTask14e2cAdapters({ pool, archiveRoot: storageRoot, assetRoot: storageRoot, limits });
    const scope = await worldScope();
    const legacy = lifecycleLegacyVariant(scope);

    async function stagedPreview(expiresAt?: string) {
      const stagedInput = await adapters.archive.stage(
        { ownerUserId },
        Readable.from(zipBytes),
        zipBytes.byteLength,
      );
      const command = {
        ...legacy.command,
        ownerUserId,
        stagedInput
      } as PortableImportPreviewCommand;
      const preview = await adapters.archive.preview({
        command,
        projection: legacy.projection as never,
        ...(expiresAt ? { expiresAt } : {})
      });
      return { stagedInput, command, preview };
    }

    const first = await stagedPreview();
    const replacement = await stagedPreview();
    expect(await adapters.imports.retrievePreviewPayload(
      { ownerUserId },
      first.command.kind,
      first.preview.previewHandle,
    )).toBeNull();
    const superseded = await pool.query<{ status: string }>(
      "SELECT status FROM portable_import_operations WHERE preview_token_hash=$1",
      [hash(first.preview.previewHandle.token)]
    );
    expect(superseded.rows[0]).toEqual({ status: "superseded" });
    await adapters.archive.abort({ ownerUserId }, first.stagedInput);
    await adapters.archive.abort({ ownerUserId }, replacement.stagedInput);

    const expiring = await stagedPreview();
    await pool.query(
      `UPDATE portable_import_operations
          SET expires_at=now()-interval '1 second'
        WHERE preview_token_hash=$1`,
      [hash(expiring.preview.previewHandle.token)]
    );
    expect(await adapters.imports.retrievePreviewPayload(
      { ownerUserId },
      expiring.command.kind,
      expiring.preview.previewHandle,
    )).toBeNull();
    await adapters.archive.abort({ ownerUserId }, expiring.stagedInput);

    const retrying = await stagedPreview();
    const retryCommand = {
      ownerUserId,
      kind: retrying.command.kind,
      destination: retrying.command.destination,
      previewHandle: retrying.preview.previewHandle,
      idempotencyKey: `task-14e2c-rollback-${crypto.randomUUID()}`
    };
    const rolledBackSourceHash = hash(`rollback:${crypto.randomUUID()}`);
    await expect(adapters.archive.commit(retryCommand, async (client) => {
      await client.query(
        "INSERT INTO imports (owner_user_id,source_type,source_name,source_hash,status) VALUES ($1,'task_14e2c','rollback',$2,'processing')",
        [ownerUserId, rolledBackSourceHash]
      );
      throw new Error("task_14e2c_forced_import_rollback");
    })).rejects.toThrow("task_14e2c_forced_import_rollback");
    expect((await pool.query(
      "SELECT 1 FROM imports WHERE owner_user_id=$1 AND source_hash=$2",
      [ownerUserId, rolledBackSourceHash]
    )).rowCount).toBe(0);
    const retried = await adapters.archive.commit(retryCommand, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO imports (
           owner_user_id,source_type,source_name,source_hash,status,world_id,world_version_id,campaign_id,stats,completed_at
         ) VALUES ($1,'task_14e2c','retry',$2,'completed',$3,$4,$5,'{}'::jsonb,now()) RETURNING id`,
        [ownerUserId, rolledBackSourceHash, scope.worldId, scope.worldVersionId, scope.campaignId]
      );
      const importId = inserted.rows[0]!.id;
      return {
        importId,
        importedRecordId: toPortableImportedRecordId(importId),
        duplicate: false,
        diagnostics: [],
        result: portableResult("legacy_story", importId, scope),
        resultExpiresAt: new Date(Date.now() + 60_000).toISOString()
      };
    });
    expect(retried.kind).toBe("legacy_story");
    await adapters.archive.cleanup({ ownerUserId }, retrying.stagedInput);

    await adapters.archive.stage(
      { ownerUserId },
      Readable.from(zipBytes),
      zipBytes.byteLength,
      { simulateCrashAfterAttach: true },
    );
    const crashed = await pool.query<{ id: string }>(
      `SELECT operation.id
         FROM durable_filesystem_operations operation
         LEFT JOIN portable_staged_inputs staged ON staged.filesystem_operation_id=operation.id
        WHERE operation.owner_user_id=$1 AND operation.purpose='portable_staging'
          AND operation.lifecycle='attached' AND staged.id IS NULL
        ORDER BY operation.created_at DESC LIMIT 1`,
      [ownerUserId]
    );
    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lease_expires_at=now()-interval '1 second',expires_at=now()-interval '1 second'
        WHERE id=$1`,
      [crashed.rows[0]!.id]
    );
    const recovery = await adapters.archive.recover("task-14e2c-reaper");
    expect(recovery).toContainEqual({
      operationId: crashed.rows[0]!.id,
      ownerUserId,
      action: "cleanup",
      outcome: "cleaned"
    });
    const remainingFiles = (await readdir(storageRoot, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile());
    expect(remainingFiles).toHaveLength(0);
  });

  it("publishes and redeems a campaign ZIP with exact owner/scope and idempotent cleanup", async () => {
    const storageRoot = await root("iq-14e2c-export-");
    const adapters = createTask14e2cAdapters({ pool, archiveRoot: storageRoot, assetRoot: storageRoot, limits });
    const scope = await worldScope();
    const exportScope = {
      ownerUserId,
      exportKind: "campaign_zip" as const,
      campaignId: scope.campaignId,
      worldId: scope.worldId,
      worldVersionId: scope.worldVersionId
    };
    const payloads = [
      { path: "campaign.json", kind: "campaign" as const, formatVersion: 3 },
      { path: "world.json", kind: "world" as const, formatVersion: 1 },
      { path: "chronicle.json", kind: "chronicle" as const, formatVersion: 1 },
      { path: "assets/assets.json", kind: "assets" as const, formatVersion: 1 }
    ];
    const exported = await adapters.archive.publishCampaignExport(exportScope, payloads.map((payload) => ({
      path: payload.path,
      logicalType: payload.kind,
      mediaType: "application/json",
      source: Readable.from(Buffer.from(JSON.stringify({ formatVersion: payload.formatVersion }), "utf8"))
    })), (entries) => ({
      format: "infinite-quest-archive",
      formatVersion: 1,
      archiveType: "campaign",
      createdAt: "2026-08-08T00:00:00.000Z",
      contentFingerprint: hash("task-14e2c-export"),
      campaignId: scope.campaignId,
      worldId: scope.worldId,
      worldVersionId: scope.worldVersionId,
      entries: [...entries],
      payloads,
      assets: []
    }));

    await expect(adapters.archive.downloadExport(
      { ...exportScope, ownerUserId: foreignOwnerUserId },
      exported.retrieval,
    )).rejects.toEqual({ code: "archive_unavailable" });
    const downloaded = await adapters.archive.downloadExport(exportScope, exported.retrieval);
    expect(downloaded.content.subarray(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]));
    expect(downloaded.byteLength).toBe(exported.byteLength);
    const restarted = createTask14e2cAdapters({
      pool,
      archiveRoot: storageRoot,
      assetRoot: storageRoot,
      limits
    });
    await expect(restarted.archive.cleanupExport(
      { ...exportScope, ownerUserId: foreignOwnerUserId },
      exported.retrieval,
    )).rejects.toEqual({ code: "archive_cleanup_required" });
    expect((await readdir(storageRoot, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())).toHaveLength(1);
    await restarted.archive.cleanupExport(exportScope, exported.retrieval);
    await expect(restarted.archive.cleanupExport(exportScope, exported.retrieval)).resolves.toBeUndefined();
    const persisted = await pool.query<{ status: string }>(
      "SELECT status FROM portable_export_artifacts WHERE owner_user_id=$1 AND campaign_id=$2",
      [ownerUserId, scope.campaignId]
    );
    expect(persisted.rows.at(-1)).toEqual({ status: "cleaned" });
  });

  it("persists verified image metadata atomically and leaves no reachable partial file on rollback", async () => {
    const storageRoot = await root("iq-14e2c-images-");
    const adapters = createTask14e2cAdapters({ pool, archiveRoot: storageRoot, assetRoot: storageRoot, limits });
    const completedAsset = await asset();
    const published = await adapters.illustration.publishOriginal({
      ownerUserId,
      assetId: completedAsset.assetId,
      content: tinyPng,
      mimeType: "image/png"
    });
    expect(published).toMatchObject({ width: 1, height: 1, contentHash: hash(tinyPng) });
    const metadata = await pool.query<{
      storage_path: string;
      content_hash: string;
      pixel_width: number;
      pixel_height: number;
      format: string;
      pages: number;
    }>(
      `SELECT storage_path,content_hash,pixel_width,pixel_height,
              technical_metadata->>'format' AS format,
              (technical_metadata->>'pages')::int AS pages
         FROM assets WHERE owner_user_id=$1 AND id=$2`,
      [ownerUserId, completedAsset.assetId]
    );
    expect(metadata.rows[0]).toEqual({
      storage_path: published.relativePath,
      content_hash: hash(tinyPng),
      pixel_width: 1,
      pixel_height: 1,
      format: "png",
      pages: 1
    });
    const restarted = createTask14e2cAdapters({
      pool,
      archiveRoot: storageRoot,
      assetRoot: storageRoot,
      limits
    });
    const restartedRead = await restarted.filesystem.readPublishedAsset({
      scope: { resourceKind: "asset", ownerUserId, assetId: completedAsset.assetId },
      locator: published.locator,
      mimeType: "image/png",
      maximumBytes: limits.maxOriginalImageBytes
    });
    expect(Buffer.from(restartedRead.content)).toEqual(tinyPng);
    expect(restartedRead).toMatchObject({ width: 1, height: 1, contentHash: hash(tinyPng) });
    await expect(restarted.filesystem.readPublishedAsset({
      scope: { resourceKind: "asset", ownerUserId: foreignOwnerUserId, assetId: completedAsset.assetId },
      locator: published.locator,
      mimeType: "image/png",
      maximumBytes: limits.maxOriginalImageBytes
    })).rejects.toEqual({ code: "asset_storage_unavailable" });

    const rolledBackAsset = await asset();
    const before = await pool.query<{ storage_path: string; content_hash: string }>(
      "SELECT storage_path,content_hash FROM assets WHERE owner_user_id=$1 AND id=$2",
      [ownerUserId, rolledBackAsset.assetId]
    );
    await expect(adapters.illustration.publishOriginal({
      ownerUserId,
      assetId: rolledBackAsset.assetId,
      content: tinyPng,
      mimeType: "image/png",
      failBeforeDomainCommit: true
    })).rejects.toThrow("task_14e2c_forced_image_rollback");
    const after = await pool.query<{ storage_path: string; content_hash: string }>(
      "SELECT storage_path,content_hash FROM assets WHERE owner_user_id=$1 AND id=$2",
      [ownerUserId, rolledBackAsset.assetId]
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    const files = (await readdir(storageRoot, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile());
    expect(files).toHaveLength(1);
    expect(files[0]!.name.endsWith(".asset")).toBe(true);

    const crashedAsset = await asset();
    await expect(adapters.illustration.publishOriginal({
      ownerUserId,
      assetId: crashedAsset.assetId,
      content: tinyPng,
      mimeType: "image/png",
      simulateCrashAfterAttach: true
    })).rejects.toThrow("task_14e2c_simulated_image_crash");
    const crashed = await pool.query<{ id: string }>(
      `SELECT id FROM durable_filesystem_operations
        WHERE owner_user_id=$1 AND asset_id=$2 AND purpose='asset_original'
          AND lifecycle='attached'
        ORDER BY created_at DESC LIMIT 1`,
      [ownerUserId, crashedAsset.assetId]
    );
    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lease_expires_at=now()-interval '1 second',expires_at=now()-interval '1 second'
        WHERE id=$1`,
      [crashed.rows[0]!.id]
    );
    await expect(adapters.archive.recover("task-14e2c-image-reaper")).resolves.toContainEqual({
      operationId: crashed.rows[0]!.id,
      ownerUserId,
      action: "cleanup",
      outcome: "cleaned"
    });
    const afterRecovery = (await readdir(storageRoot, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile());
    expect(afterRecovery).toHaveLength(1);

    const postCommitAsset = await asset();
    const alternatePng = await sharp({
      create: { width: 1, height: 1, channels: 4, background: { r: 220, g: 40, b: 40, alpha: 1 } }
    }).png().toBuffer();
    let postCommitLocator: typeof published.locator | null = null;
    await expect(adapters.illustration.publishOriginal({
      ownerUserId,
      assetId: postCommitAsset.assetId,
      content: alternatePng,
      mimeType: "image/png",
      failFinalizedTransitionAfterDomainCommit: true,
      captureAttachedLocator(locator) {
        postCommitLocator = locator;
      }
    })).rejects.toThrow("task_14e2c_forced_image_finalize_failure");
    expect(postCommitLocator).not.toBeNull();
    const attached = await pool.query<{ id: string; lifecycle: string; storage_path: string }>(
      `SELECT operation.id,operation.lifecycle,asset.storage_path
         FROM durable_filesystem_operations operation
         JOIN assets asset ON asset.id=operation.asset_id AND asset.owner_user_id=operation.owner_user_id
        WHERE operation.owner_user_id=$1 AND operation.asset_id=$2 AND operation.purpose='asset_original'`,
      [ownerUserId, postCommitAsset.assetId]
    );
    expect(attached.rows[0]).toMatchObject({ lifecycle: "attached", storage_path: expect.stringMatching(/\.asset$/) });
    await expect(restarted.filesystem.readPublishedAsset({
      scope: { resourceKind: "asset", ownerUserId, assetId: postCommitAsset.assetId },
      locator: postCommitLocator!,
      mimeType: "image/png",
      maximumBytes: limits.maxOriginalImageBytes
    })).rejects.toEqual({ code: "asset_storage_unavailable" });
    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lease_expires_at=now()-interval '1 second',expires_at=now()-interval '1 second'
        WHERE id=$1`,
      [attached.rows[0]!.id]
    );
    const postCommitRecovery = await restarted.archive.recover("task-14e2c-post-commit-reaper");
    expect(postCommitRecovery).toContainEqual({
      operationId: attached.rows[0]!.id,
      ownerUserId,
      action: "finalize",
      outcome: "finalized"
    });
    const recoveredRead = await createTask14e2cAdapters({
      pool,
      archiveRoot: storageRoot,
      assetRoot: storageRoot,
      limits
    }).filesystem.readPublishedAsset({
      scope: { resourceKind: "asset", ownerUserId, assetId: postCommitAsset.assetId },
      locator: postCommitLocator!,
      mimeType: "image/png",
      maximumBytes: limits.maxOriginalImageBytes
    });
    expect(Buffer.from(recoveredRead.content)).toEqual(alternatePng);
    const survivingFiles = (await readdir(storageRoot, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile());
    expect(survivingFiles).toHaveLength(2);
  });
});
