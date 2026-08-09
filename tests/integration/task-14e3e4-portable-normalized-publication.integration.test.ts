import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bindPrivateNormalizedAssetPublicationRequest } from "../../packages/application/src/assets/private-normalized-asset-publication.js";
import { toAssetMutationIdempotencyKey } from "../../packages/application/src/assets/types.js";
import type { PrivatePortableNormalizedPublicationScope } from "../../packages/application/src/imports/private-normalized-portable-publication.js";
import {
  toPortableSourceInstallationId,
  type PortableStagedInput
} from "../../packages/application/src/imports/types.js";
import { canonicalArchiveJson, canonicalizeWorldContent } from "../../packages/contracts/src/index.js";
import { calculateContentFingerprint } from "../../packages/contracts/src/archives-node.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createPostgresImportRepository } from "../../packages/database/src/import-repository.js";
import { createPostgresPortableImportAuthorityRepository } from "../../packages/database/src/portable-import-family-repository.js";
import { createPostgresNormalizedAssetPublicationRepository } from "../../packages/database/src/normalized-asset-publication-repository.js";
import {
  createDatabasePool,
  initialOwnerId,
  type DatabasePool
} from "../../packages/database/src/pool.js";
import { createPostgresPortableNormalizedAssetPublicationRepository } from "../../packages/database/src/portable-normalized-asset-publication-repository.js";
import { createPostgresWorldRepositoryAdapters } from "../../packages/database/src/world-repository.js";
import { createPortableImportExportComposition } from "../../services/runtime/src/portable-import-export-composition.js";
import { createPrivateFilesystemRecoveryComposition } from "../../services/runtime/src/private-filesystem-recovery-composition.js";
import { createPrivatePortableNormalizedAssetPublicationComposition } from "../../services/runtime/src/portable-normalized-asset-publication-composition.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const UUID_PATTERN_FOR_TEST = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

integration("Task 14e3e4 portable normalized publication", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  let archiveRoot = "";
  let assetRoot = "";
  const compositions = new Set<Readonly<{ close(): Promise<void> }>>();

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 2);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    archiveRoot = await mkdtemp(join(tmpdir(), "iqn-e4-archive-"));
    assetRoot = await mkdtemp(join(tmpdir(), "iqn-e4-assets-"));
    await mkdir(join(assetRoot, "assets"));
  });

  afterEach(async () => {
    await Promise.all([...compositions].map((composition) => composition.close()));
    compositions.clear();
  });

  afterAll(async () => {
    await pool.end();
    await rm(archiveRoot, { recursive: true, force: true });
    await rm(assetRoot, { recursive: true, force: true });
  });

  const hash = (value: string | Uint8Array): string => (
    createHash("sha256").update(value).digest("hex")
  );

  const stableUuid = (preimage: string): string => {
    const value = hash(preimage).slice(0, 32).split("");
    value[12] = "4";
    value[16] = ["8", "9", "a", "b"][Number.parseInt(value[16]!, 16) % 4]!;
    const hex = value.join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };

  async function compose() {
    const composition = await createPrivatePortableNormalizedAssetPublicationComposition(
      pool,
      { archiveRoot, assetRoot },
    );
    compositions.add(composition);
    return composition;
  }

  function worldRepository(databasePool = pool) {
    return createPostgresWorldRepositoryAdapters(databasePool, {
      memory: { async autoEnableCampaignEmbedding() { return { enabled: false }; } }
    }).worlds;
  }

  async function createWorldScope(label: string, scopedOwnerUserId = ownerUserId) {
    const content = canonicalizeWorldContent({
      world: { title: label },
      playableCharacters: [{ id: "hero", name: "Hero", characterText: "A verifier" }]
    });
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title) VALUES ($1,$2) RETURNING id",
      [scopedOwnerUserId, label],
    );
    const version = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id,owner_user_id,version_number,content)
       VALUES ($1,$2,1,$3::jsonb) RETURNING id`,
      [world.rows[0]!.id, scopedOwnerUserId, JSON.stringify(content)],
    );
    return Object.freeze({
      worldId: world.rows[0]!.id,
      worldVersionId: version.rows[0]!.id,
      content
    });
  }

  async function composePortable(
    target: Awaited<ReturnType<typeof createWorldScope>>,
    leaseOwner: string,
    databasePool = pool,
    timing: Readonly<{ previewTtlSeconds?: number; leaseSeconds?: number }> = {},
    scopedOwnerUserId = ownerUserId,
  ) {
    const composition = await createPortableImportExportComposition({
      pool: databasePool,
      roots: { archiveRoot, assetRoot },
      worlds: worldRepository(databasePool),
      leaseOwner,
      ...timing,
      provider: {
        async convertTemplate({ template }) {
          const title = template.title.trim() || "Converted portable world";
          return {
            world: {
              format: "infinite-quest-world" as const,
              formatVersion: 1 as const,
              title,
              content: canonicalizeWorldContent({ world: { title } })
            },
            providerConfigurationFingerprint: "f".repeat(64)
          };
        }
      },
      targets: {
        async readTargetWorldVersion(value) {
          if (value.owner.ownerUserId !== scopedOwnerUserId
            || value.worldId !== target.worldId
            || value.worldVersionId !== target.worldVersionId) return null;
          return {
            ownerUserId: scopedOwnerUserId,
            worldId: target.worldId,
            worldVersionId: target.worldVersionId,
            content: target.content
          };
        }
      },
      exports: {
        async buildCampaignArchive() { throw new Error("export_not_expected"); },
        async buildWorldJson() { throw new Error("export_not_expected"); }
      }
    });
    compositions.add(composition);
    return composition;
  }

  async function stagedInput(
    composition: Awaited<ReturnType<typeof createPortableImportExportComposition>>,
    bytes: Uint8Array,
    label: string,
    scopedOwnerUserId = ownerUserId,
  ): Promise<PortableStagedInput> {
    const staged = await composition.stageInput({
      owner: { ownerUserId: scopedOwnerUserId },
      operationScopeId: `${label}-${crypto.randomUUID()}`,
      leaseOwner: label,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      byteLength: bytes.byteLength,
      source: [bytes]
    });
    return staged.stagedInput;
  }

  async function campaignZip(
    label: string,
    image?: Readonly<{ sourceAssetId: string; bytes: Uint8Array }>
      | readonly Readonly<{ sourceAssetId: string; bytes: Uint8Array }>[],
    options: Readonly<{
      turnId?: string;
      pointerSourceAssetId?: string;
      turns?: readonly Readonly<{ id: string; pointerSourceAssetId: string }>[];
    }> = {},
  ): Promise<Uint8Array> {
    const archive = new JSZip();
    archive.file("campaign.json", JSON.stringify({
      format: "infinite-quest-campaign",
      formatVersion: 1,
      campaign: { title: `${label} campaign` },
      world: { title: `${label} world`, character: "Hero\nA verifier" },
      turns: (options.turns ?? [{
        id: options.turnId ?? `${label}-turn`,
        pointerSourceAssetId: options.pointerSourceAssetId
      }]).map((turn) => ({
        id: turn.id,
        action: "Look",
        narration: "Hero enters the archive hall.",
        ...(turn.pointerSourceAssetId
          ? { imageUrl: `/api/v1/assets/${turn.pointerSourceAssetId}` }
          : {})
      }))
    }));
    const images = image ? (Array.isArray(image) ? image : [image]) : [];
    for (const artifact of images) {
      archive.file(`assets/${artifact.sourceAssetId}.png`, artifact.bytes);
    }
    return archive.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  }

  async function richCampaignZip(
    label: string,
    options: Readonly<{
      image?: Uint8Array;
      sourceAssetId?: string;
      secondarySourceAssetId?: string;
      libraryTitle?: string;
    }> = {},
  ): Promise<Readonly<{
    bytes: Uint8Array;
    sourceContextId: string;
    sourceAssetId: string;
  }>> {
    const sourceCampaignId = crypto.randomUUID();
    const sourceWorldId = crypto.randomUUID();
    const sourceWorldVersionId = crypto.randomUUID();
    const sourceTurnId = crypto.randomUUID();
    const sourceAssetId = options.sourceAssetId ?? crypto.randomUUID();
    const sourceSetId = crypto.randomUUID();
    const sourceSegmentId = crypto.randomUUID();
    const sourceContextId = crypto.randomUUID();
    const color = createHash("sha256").update(label).digest();
    const image = options.image ?? await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 4,
        background: { r: color[0]!, g: color[1]!, b: color[2]!, alpha: 1 }
      }
    }).png().toBuffer();
    const contentHash = hash(image);
    const assetPath = `assets/sha256/${contentHash.slice(0, 2)}/${contentHash}.png`;
    const content = canonicalizeWorldContent({
      world: { title: `${label} world` },
      playableCharacters: [{ id: "hero", name: "Hero" }]
    });
    const worldHash = hash(canonicalArchiveJson(content));
    const campaign = {
      formatVersion: 3,
      campaign: {
        sourceCampaignId,
        sourceWorldVersionId,
        title: `${label} campaign`,
        stateRevision: 1,
        selectedCharacterId: "hero",
        characterSnapshot: { id: "hero", name: "Hero" },
        characterProfile: { name: "Hero" },
        characterProfileRevision: 1
      },
      settings: { storyLength: "standard", turnControlStyle: "flexible_action" },
      world: { canonicalHash: worldHash, sourceWorldId, sourceWorldVersionId },
      turns: [{
        id: sourceTurnId,
        turnNumber: 1,
        action: "Look",
        narration: "A restored archive hall.",
        imagePrompt: "A quiet archive hall",
        imageUrl: `/api/v1/assets/${sourceAssetId}`,
        worldStateSnapshot: { scratchpad: "", trackers: [] },
        createdAt: "2030-01-02T00:00:00.000Z"
      }],
      trackers: [],
      defaultTriggers: [],
      eventTriggers: [],
      pendingEventTriggers: [],
      rpgStats: [],
      archiveRecords: {
        formatVersion: 1,
        characterProfileEdits: [],
        stateEdits: [],
        worldMigrations: [],
        illustrationConfig: {
          enabled: false,
          source_policy: "off",
          matching_scope: "campaign",
          confidence_profile: "strict",
          repetition_window: 3,
          model: "",
          size: "1024x1024",
          aspect_ratio: "1:1",
          quality: "auto",
          output_format: "png",
          max_attempts: 3,
          segment_word_count: 500,
          images_per_segment: 1,
          segment_prompt_mode: "direct",
          refinement_prompt: ""
        },
        illustrationSets: [{
          id: sourceSetId,
          turn_id: sourceTurnId,
          source_text_hash: "source-hash",
          segment_word_count: 500,
          images_per_segment: 1,
          prompt_mode: "direct",
          status: "completed",
          is_active: true,
          character_visual_reference: "Hero",
          created_at: "2030-01-02T00:00:00.000Z",
          completed_at: "2030-01-02T00:01:00.000Z"
        }],
        illustrationSegments: [{
          id: sourceSegmentId,
          illustration_set_id: sourceSetId,
          turn_id: sourceTurnId,
          ordinal: 0,
          start_offset: 0,
          end_offset: 24,
          start_word: 0,
          end_word: 4,
          source_text: "A restored archive hall.",
          source_text_hash: "segment-hash",
          direct_prompt: "Archive hall",
          resolved_prompt: "Archive hall",
          prompt_source: "direct",
          status: "completed",
          created_at: "2030-01-02T00:00:00.000Z"
        }],
        costs: []
      }
    };
    const world = {
      canonicalHash: worldHash,
      sourceWorldId,
      sourceWorldVersionId,
      versionNumber: 1,
      content
    };
    const chronicle = { formatVersion: 1, memories: [], summaries: [] };
    const assetRecord = {
      sourceAssetId,
      contentHash,
      archivePath: assetPath,
      mimeType: "image/png",
      byteLength: image.byteLength,
      pixelWidth: 1,
      pixelHeight: 1,
      technicalMetadata: { format: "png", pages: 1 },
      library: {
        title: options.libraryTitle ?? "Restored hall",
        caption: "A caption",
        notes: "Imported",
        tags: ["hall"],
        origin: "imported",
        reviewStatus: "eligible",
        reuseScope: "campaign",
        automaticReuseEnabled: false,
        contentCategories: ["location"],
        favorite: true,
        archivedAt: null
      },
      createdAt: "2030-01-01T00:00:00.000Z",
      bindings: [
        { role: "world_cover", worldId: sourceWorldId },
        {
          role: "turn_illustration",
          campaignId: sourceCampaignId,
          turnId: sourceTurnId
        },
        {
          role: "illustration_segment_variant",
          campaignId: sourceCampaignId,
          turnId: sourceTurnId,
          segmentId: sourceSegmentId,
          variantIndex: 0
        },
        {
          role: "generation_context",
          campaignId: sourceCampaignId,
          worldId: sourceWorldId,
          worldVersionId: sourceWorldVersionId,
          turnId: sourceTurnId,
          sourceContextId
        }
      ]
    };
    const assetRecords = options.secondarySourceAssetId
      ? [assetRecord, {
        ...assetRecord,
        sourceAssetId: options.secondarySourceAssetId,
        bindings: [{
          role: "turn_illustration" as const,
          campaignId: sourceCampaignId,
          turnId: sourceTurnId
        }]
      }]
      : [assetRecord];
    const payloads = [
      ["campaign.json", campaign, "campaign"],
      ["world.json", world, "world"],
      ["chronicle.json", chronicle, "chronicle"],
      ["assets/assets.json", { formatVersion: 1, assets: assetRecords }, "assets"]
    ] as const;
    const entries = payloads.map(([path, value, logicalType]) => {
      const body = canonicalArchiveJson(value);
      return {
        path,
        logicalType,
        mediaType: "application/json",
        byteLength: Buffer.byteLength(body),
        sha256: hash(body),
        body
      };
    });
    const manifest = {
      format: "infinite-quest-archive",
      formatVersion: 1,
      archiveType: "campaign",
      createdAt: "2030-01-01T00:00:00.000Z",
      contentFingerprint: calculateContentFingerprint({
        payloadHashes: entries.map((entry) => entry.sha256),
        originalAssetHashes: assetRecords.map((record) => record.contentHash)
      }),
      campaignId: sourceCampaignId,
      worldId: sourceWorldId,
      worldVersionId: sourceWorldVersionId,
      entries: [
        ...entries.map(({ body: _body, ...entry }) => entry),
        {
          path: assetPath,
          logicalType: "asset-original",
          mediaType: "image/png",
          byteLength: image.byteLength,
          sha256: contentHash
        }
      ],
      payloads: payloads.map(([path, _value, kind]) => ({ kind, path, formatVersion: 1 })),
      assets: assetRecords
    };
    const archive = new JSZip();
    archive.file("manifest.json", canonicalArchiveJson(manifest));
    for (const entry of entries) archive.file(entry.path, entry.body);
    archive.file(assetPath, image);
    return Object.freeze({
      bytes: await archive.generateAsync({ type: "uint8array", compression: "DEFLATE" }),
      sourceContextId,
      sourceAssetId
    });
  }

  async function previewOperation(
    importKind: "campaign_zip" | "legacy_story" = "campaign_zip",
    ttlMilliseconds = 3_600_000,
  ): Promise<Readonly<{
    scope: PrivatePortableNormalizedPublicationScope;
    previewToken: string;
  }>> {
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title) VALUES ($1,$2) RETURNING id",
      [ownerUserId, `Task 14e3e4 ${crypto.randomUUID()}`],
    );
    const worldId = world.rows[0]!.id;
    const version = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id,owner_user_id,version_number,content)
       VALUES ($1,$2,1,$3::jsonb) RETURNING id`,
      [worldId, ownerUserId, JSON.stringify(canonicalizeWorldContent({
        world: { title: "Task 14e3e4" },
        playableCharacters: [{ id: "hero", name: "Hero", characterText: "A verifier" }]
      }))],
    );
    const operationScope = `task-14e3e4-stage-${crypto.randomUUID()}`;
    const contentHash = hash(operationScope);
    const filesystem = await pool.query<{ id: string }>(
      `INSERT INTO durable_filesystem_operations (
         owner_user_id,operation_token_hash,purpose,resource_kind,operation_scope_hash,
         lease_id,lease_owner,lease_expires_at,expires_at
       ) VALUES ($1,$2,'portable_staging','portable',$3,gen_random_uuid(),'task-14e3e4-stage',
                 clock_timestamp()+interval '5 minutes',clock_timestamp()+interval '1 hour')
       RETURNING id`,
      [ownerUserId, hash(crypto.randomUUID()), hash(operationScope)],
    );
    const filesystemOperationId = filesystem.rows[0]!.id;
    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lifecycle='attached',candidate_token_hash=$2,locator_token_hash=$3,
              attached_at=clock_timestamp()
        WHERE id=$1`,
      [filesystemOperationId, hash(`candidate-${filesystemOperationId}`), hash(`locator-${filesystemOperationId}`)],
    );
    await pool.query(
      `INSERT INTO durable_filesystem_descriptors (
         operation_id,owner_user_id,descriptor_role,ordinal,relative_path,
         device_id,file_id,change_token,content_hash,byte_length
       ) VALUES ($1,$2,'delivery',0,$3,'dev','file','change',$4,64)`,
      [filesystemOperationId, ownerUserId, `staging/${filesystemOperationId}.pending`, contentHash],
    );
    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lifecycle='finalized',finalized_at=clock_timestamp()
        WHERE id=$1`,
      [filesystemOperationId],
    );
    const staged = await pool.query<{ id: string }>(
      `INSERT INTO portable_staged_inputs (
         owner_user_id,handle_token_hash,filesystem_operation_id,content_hash,byte_length,expires_at
       ) VALUES ($1,$2,$3,$4,64,clock_timestamp()+interval '1 hour') RETURNING id`,
      [ownerUserId, hash(crypto.randomUUID()), filesystemOperationId, contentHash],
    );
    const authorityFingerprint = hash(`authority-${crypto.randomUUID()}`);
    const previewToken = `preview-${crypto.randomUUID()}`;
    const commitIdempotencyKeyHash = hash(`commit-${crypto.randomUUID()}`);
    const expiresAt = new Date(Date.now() + ttlMilliseconds);
    const operation = await pool.query<{ id: string }>(
      `INSERT INTO portable_import_operations (
         owner_user_id,staged_input_id,import_kind,preview_token_hash,content_fingerprint,
         destination_fingerprint,destination_kind,destination_world_id,destination_world_version_id,
         preview_projection,expires_at,normalized_payload,authority_fingerprint
       ) VALUES ($1,$2,$3,$4,$5,$6,'existing_world_version',$7,$8,'{}'::jsonb,
                 $10,'{}'::jsonb,$9)
       RETURNING id`,
      [ownerUserId, staged.rows[0]!.id, importKind, hash(previewToken), contentHash,
        hash(`destination-${worldId}`), worldId, version.rows[0]!.id, authorityFingerprint, expiresAt],
    );
    await pool.query(
      `INSERT INTO portable_import_work (operation_id,owner_user_id,expires_at)
       VALUES ($1,$2,$3)`,
      [operation.rows[0]!.id, ownerUserId, expiresAt],
    );
    return Object.freeze({
      previewToken,
      scope: Object.freeze({
        operationId: operation.rows[0]!.id,
        ownerUserId,
        importKind,
        authorityFingerprint,
        commitIdempotencyKeyHash
      })
    });
  }

  async function normalizedImportRequest(
    scope: PrivatePortableNormalizedPublicationScope,
    label: string,
  ) {
    const color = createHash("sha256").update(label).digest();
    const bytes = await sharp({
      create: {
        width: 4,
        height: 3,
        channels: 3,
        background: { r: color[0]!, g: color[1]!, b: color[2]! }
      }
    }).png().toBuffer();
    const library = {
      title: label,
      caption: "",
      notes: "",
      tags: [],
      origin: "imported" as const,
      reviewStatus: "unreviewed" as const,
      reuseScope: "campaign" as const,
      automaticReuseEnabled: false,
      contentCategories: [],
      favorite: false
    };
    return Object.freeze({
      bytes,
      request: bindPrivateNormalizedAssetPublicationRequest({
        owner: { ownerUserId },
        idempotencyKey: toAssetMutationIdempotencyKey(`${label}-${crypto.randomUUID()}`),
        original: {
          bytes,
          mimeType: "image/png",
          byteLength: bytes.byteLength,
          contentHash: hash(bytes),
          technicalMetadata: {
            state: "verified",
            pixelWidth: 4,
            pixelHeight: 3,
            format: "png",
            pages: 1
          }
        },
        derivatives: [],
        requestedLibrary: library,
        sourceRecords: [{
          sourceKind: scope.importKind,
          sourceAssetId: crypto.randomUUID(),
          sourceRecordId: hash(label),
          sourceKey: null,
          requestedLibrary: library,
          bindingIntentKeys: []
        }],
        provenance: {
          kind: "import",
          importKind: scope.importKind,
          importOperationId: scope.operationId
        },
        contextIntents: [],
        referencePolicy: { mode: "omit" }
      })
    });
  }

  it("creates durable operation-owned normalized request intent before imported asset publication", async () => {
    const relation = await pool.query<{ relation: string | null }>(
      "SELECT to_regclass('portable_import_normalized_asset_publications')::text AS relation",
    );

    expect(relation.rows[0]?.relation).toBe("portable_import_normalized_asset_publications");
  });

  it("permits only bound duplicate or terminal abandoned retirement authority", async () => {
    const constraints = await pool.query<{ constraint_name: string; definition: string }>(
      `SELECT conname AS constraint_name,pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid='portable_import_normalized_asset_publications'::regclass
          AND contype='c'`,
    );
    const state = constraints.rows.find(({ constraint_name }) => (
      constraint_name === "portable_import_normalized_asset_publication_state_check"
    ))?.definition ?? "";
    const definitions = constraints.rows.map(({ definition }) => definition).join(" ");

    expect(state).toMatch(/retirement_pending/u);
    expect(state).toMatch(/retired/u);
    expect(state).toContain("retirement_reason IS NOT NULL");
    expect(definitions).toContain("'duplicate'::text");
    expect(definitions).toContain("'abandoned'::text");
  });

  it("retires an unbound normalized prewrite intent when its preview expires", async () => {
    const { scope } = await previewOperation("campaign_zip", 1_000);
    const { request } = await normalizedImportRequest(scope, "14e3e4-expired-intent");
    const repository = createPostgresPortableNormalizedAssetPublicationRepository(pool);
    await repository.recordReservationIntents(scope, [{ request }]);
    const normalized = await compose();
    const authority = createPostgresPortableImportAuthorityRepository(
      pool,
      createPostgresImportRepository(pool),
      normalized.coordinator,
    );

    await new Promise((resolveWait) => setTimeout(resolveWait, 1_100));
    await expect(authority.expireDueWork(10)).resolves.toBeGreaterThanOrEqual(1);
    await expect(pool.query(
      `SELECT operation.status AS operation_status,work.status AS work_status,
              mapping.publication_state,mapping.retirement_reason,mapping.request_id
         FROM portable_import_operations operation
         JOIN portable_import_work work
           ON work.operation_id=operation.id AND work.owner_user_id=operation.owner_user_id
         JOIN portable_import_normalized_asset_publications mapping
           ON mapping.operation_id=operation.id AND mapping.owner_user_id=operation.owner_user_id
        WHERE operation.id=$1`,
      [scope.operationId],
    )).resolves.toMatchObject({ rows: [{
      operation_status: "expired",
      work_status: "expired",
      publication_state: "retired",
      retirement_reason: "abandoned",
      request_id: null
    }] });
  }, 30_000);

  it("recovers a crash-bound normalized reservation through terminal abort retirement after exact cleanup", async () => {
    const { scope, previewToken } = await previewOperation();
    const { bytes, request } = await normalizedImportRequest(scope, "14e3e4-abandoned-crash");
    const first = await compose();
    await first.coordinator.reserve({
      scope,
      leaseOwner: "14e3e4-abandoned-crash",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      assets: [{
        idempotencyKey: request.idempotencyKey,
        artifact: {
          bytes,
          declaredMimeType: request.original.mimeType,
          byteLength: bytes.byteLength,
          contentHash: hash(bytes)
        },
        requestedLibrary: request.requestedLibrary,
        sourceRecords: request.sourceRecords,
        sourceInstallationId: null,
        contextIntents: [],
        referencePolicy: { mode: "omit" }
      }]
    });
    await first.close();
    compositions.delete(first);

    const restarted = await compose();
    const authority = createPostgresPortableImportAuthorityRepository(
      pool,
      createPostgresImportRepository(pool),
      restarted.coordinator,
    );
    await expect(authority.abort({ ownerUserId }, previewToken)).resolves.toMatchObject({
      status: "aborted"
    });
    const pending = await pool.query<{
      publication_state: string;
      retirement_reason: string;
      request_lifecycle: string;
      identity_lifecycle: string;
      canonical_asset_id: string;
      canonical_content_hash: string;
      derivative_hashes: string[];
      active_operations: number;
    }>(
      `SELECT mapping.publication_state,mapping.retirement_reason,
              request.lifecycle AS request_lifecycle,identity.lifecycle AS identity_lifecycle,
              request.canonical_asset_id,request.canonical_content_hash,
              ARRAY(SELECT derivative.content_hash
                      FROM asset_publication_request_derivatives derivative
                     WHERE derivative.request_id=request.id
                       AND derivative.owner_user_id=request.owner_user_id
                     ORDER BY derivative.ordinal) AS derivative_hashes,
              (SELECT count(*)::int FROM durable_filesystem_operations filesystem
                WHERE filesystem.asset_id=request.canonical_asset_id
                  AND filesystem.owner_user_id=request.owner_user_id
                  AND filesystem.lifecycle<>'cleaned') AS active_operations
         FROM portable_import_normalized_asset_publications mapping
         JOIN asset_publication_requests request
           ON request.id=mapping.request_id AND request.owner_user_id=mapping.owner_user_id
         JOIN asset_publication_identities identity
           ON identity.asset_id=request.canonical_asset_id
          AND identity.owner_user_id=request.owner_user_id
        WHERE mapping.operation_id=$1`,
      [scope.operationId],
    );
    expect(pending.rows).toEqual([expect.objectContaining({
      publication_state: "retirement_pending",
      retirement_reason: "abandoned",
      request_lifecycle: "prepared",
      identity_lifecycle: "prepared",
      active_operations: 2
    })]);
    const pendingRow = pending.rows[0]!;
    const physicalHashes = [pendingRow.canonical_content_hash, ...pendingRow.derivative_hashes];
    for (const contentHash of physicalHashes) {
      const target = join(assetRoot, "assets/content", contentHash);
      await expect(access(target)).resolves.toBeUndefined();
      await rm(target);
    }
    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lifecycle='cleanup_pending',cleanup_requested_at=clock_timestamp()
        WHERE asset_id=$1 AND owner_user_id=$2
          AND lifecycle IN ('reserved','attached','finalized')`,
      [pendingRow.canonical_asset_id, ownerUserId],
    );
    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lifecycle='cleaned',cleaned_at=clock_timestamp()
        WHERE asset_id=$1 AND owner_user_id=$2 AND lifecycle='cleanup_pending'`,
      [pendingRow.canonical_asset_id, ownerUserId],
    );

    await expect(authority.abort({ ownerUserId }, previewToken)).resolves.toMatchObject({
      status: "aborted"
    });
    await expect(pool.query(
      `SELECT mapping.publication_state,mapping.retirement_reason,
              request.lifecycle AS request_lifecycle,identity.lifecycle AS identity_lifecycle,
              (SELECT count(*)::int FROM durable_filesystem_operations filesystem
                WHERE filesystem.asset_id=request.canonical_asset_id
                  AND filesystem.owner_user_id=request.owner_user_id
                  AND filesystem.lifecycle<>'cleaned') AS active_operations
         FROM portable_import_normalized_asset_publications mapping
         JOIN asset_publication_requests request
           ON request.id=mapping.request_id AND request.owner_user_id=mapping.owner_user_id
         JOIN asset_publication_identities identity
           ON identity.asset_id=request.canonical_asset_id
          AND identity.owner_user_id=request.owner_user_id
        WHERE mapping.operation_id=$1`,
      [scope.operationId],
    )).resolves.toMatchObject({ rows: [{
      publication_state: "retired",
      retirement_reason: "abandoned",
      request_lifecycle: "failed",
      identity_lifecycle: "cleanup_pending",
      active_operations: 0
    }] });
  }, 30_000);

  it("lets a fresh e6 filesystem recovery reconcile an e4 abandonment only after its exact cleanup", async () => {
    const { scope, previewToken } = await previewOperation();
    const { bytes, request } = await normalizedImportRequest(scope, "14e3e6-e4-retirement-bridge");
    const first = await compose();
    await first.coordinator.reserve({
      scope,
      leaseOwner: "14e3e6-e4-retirement-bridge",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      assets: [{
        idempotencyKey: request.idempotencyKey,
        artifact: {
          bytes,
          declaredMimeType: request.original.mimeType,
          byteLength: bytes.byteLength,
          contentHash: hash(bytes),
        },
        requestedLibrary: request.requestedLibrary,
        sourceRecords: request.sourceRecords,
        sourceInstallationId: null,
        contextIntents: [],
        referencePolicy: { mode: "omit" },
      }],
    });
    await first.close();
    compositions.delete(first);
    const normalized = await compose();
    const authority = createPostgresPortableImportAuthorityRepository(
      pool,
      createPostgresImportRepository(pool),
      normalized.coordinator,
    );
    await expect(authority.abort({ ownerUserId }, previewToken)).resolves.toMatchObject({ status: "aborted" });
    const pending = await pool.query<{
      canonical_asset_id: string;
      operation_id: string;
      lifecycle: string;
    }>(
      `SELECT request.canonical_asset_id,filesystem.id AS operation_id,filesystem.lifecycle
         FROM portable_import_normalized_asset_publications mapping
         JOIN asset_publication_requests request
           ON request.id=mapping.request_id AND request.owner_user_id=mapping.owner_user_id
         JOIN durable_filesystem_operations filesystem
           ON filesystem.asset_id=request.canonical_asset_id AND filesystem.owner_user_id=request.owner_user_id
        WHERE mapping.operation_id=$1 AND mapping.publication_state='retirement_pending'
          AND filesystem.lifecycle='reserved'`,
      [scope.operationId],
    );
    expect(pending.rows).toHaveLength(2);
    expect(pending.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ lifecycle: "reserved" }),
      expect.objectContaining({ lifecycle: "reserved" }),
    ]));
    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lease_expires_at=clock_timestamp()-interval '1 second'
        WHERE id=ANY($1::uuid[])`,
      [pending.rows.map((row) => row.operation_id)],
    );
    const recovery = await createPrivateFilesystemRecoveryComposition(pool, { archiveRoot, assetRoot });
    try {
      await expect(recovery.executor.processOne({
        workerId: "14e3e6-e4-retirement-recovery",
        leaseSeconds: 10,
        limit: 2,
      })).resolves.toMatchObject({ claimed: 2, cleaned: 2, recoverable: 1 });
    } finally {
      await recovery.close();
    }
    await expect(pool.query(
      `SELECT mapping.publication_state,request.lifecycle AS request_lifecycle,
              identity.lifecycle AS identity_lifecycle
         FROM portable_import_normalized_asset_publications mapping
         JOIN asset_publication_requests request
           ON request.id=mapping.request_id AND request.owner_user_id=mapping.owner_user_id
         JOIN asset_publication_identities identity
           ON identity.asset_id=request.canonical_asset_id AND identity.owner_user_id=request.owner_user_id
        WHERE mapping.operation_id=$1`,
      [scope.operationId],
    )).resolves.toMatchObject({ rows: [{
      publication_state: "retired",
      request_lifecycle: "failed",
      identity_lifecycle: "cleanup_pending",
    }] });
  }, 30_000);

  it("serializes terminal abort after the filesystem lifecycle guard and reconciles cleanup", async () => {
    const { scope, previewToken } = await previewOperation("campaign_zip");
    const { bytes, request } = await normalizedImportRequest(scope, "14e3e4-terminal-journal-race");
    const composition = await compose();
    const abortPool = createDatabasePool(databaseUrl!, 2);
    const authority = createPostgresPortableImportAuthorityRepository(
      abortPool,
      createPostgresImportRepository(abortPool),
      composition.coordinator,
    );
    const gateKey = `task-14e3e4-journal-gate-${crypto.randomUUID()}`;
    const signalKey = `task-14e3e4-journal-signal-${crypto.randomUUID()}`;
    const blockerPool = createDatabasePool(databaseUrl!, 2);
    const blocker = await blockerPool.connect();
    await blocker.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [gateKey]);
    await pool.query(`CREATE FUNCTION task_14e3e4_journal_gate() RETURNS trigger
      LANGUAGE plpgsql AS $gate$
      BEGIN
        IF NEW.asset_id IS NOT NULL THEN
          PERFORM pg_advisory_lock(hashtextextended('${signalKey}',0));
          PERFORM pg_advisory_xact_lock(hashtextextended('${gateKey}',0));
          PERFORM pg_advisory_unlock(hashtextextended('${signalKey}',0));
        END IF;
        RETURN NEW;
      END;
      $gate$`);
    await pool.query(`CREATE TRIGGER zzz_task_14e3e4_journal_gate_trigger
      BEFORE INSERT ON durable_filesystem_operations
      FOR EACH ROW EXECUTE FUNCTION task_14e3e4_journal_gate()`);
    const reservation = composition.coordinator.reserve({
      scope,
      leaseOwner: "14e3e4-terminal-journal-race",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      assets: [{
        idempotencyKey: request.idempotencyKey,
        artifact: {
          bytes,
          declaredMimeType: request.original.mimeType,
          byteLength: bytes.byteLength,
          contentHash: hash(bytes)
        },
        requestedLibrary: request.requestedLibrary,
        sourceRecords: request.sourceRecords,
        sourceInstallationId: null,
        contextIntents: [],
        referencePolicy: { mode: "omit" }
      }]
    });
    let abort: Promise<Awaited<ReturnType<typeof authority.abort>>> | undefined;
    let handle: Awaited<typeof reservation> | undefined;
    try {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const signal = await blockerPool.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
          [signalKey],
        );
        if (!signal.rows[0]?.acquired) break;
        await blockerPool.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [signalKey]);
        if (Date.now() >= deadline) throw new Error("task_14e3e4_journal_gate_timeout");
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      abort = authority.abort({ ownerUserId }, previewToken);
      await expect(Promise.race([
        abort.then(() => "settled", () => "settled"),
        new Promise<"blocked">((resolveDelay) => setTimeout(() => resolveDelay("blocked"), 150))
      ])).resolves.toBe("blocked");
      await blocker.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [gateKey]);
      handle = await reservation;
      await expect(abort).resolves.toMatchObject({ status: "aborted" });

      await expect(pool.query(
        `SELECT mapping.publication_state,mapping.retirement_reason,
                request.lifecycle AS request_lifecycle,identity.lifecycle AS identity_lifecycle,
                (SELECT count(*)::int FROM durable_filesystem_operations filesystem
                  WHERE filesystem.asset_id=request.canonical_asset_id
                    AND filesystem.owner_user_id=request.owner_user_id
                    AND filesystem.lifecycle<>'cleaned') AS active_operation_count
           FROM portable_import_normalized_asset_publications mapping
           JOIN asset_publication_requests request ON request.id=mapping.request_id
           JOIN asset_publication_identities identity
             ON identity.asset_id=request.canonical_asset_id AND identity.owner_user_id=request.owner_user_id
          WHERE mapping.operation_id=$1`,
        [scope.operationId],
      )).resolves.toMatchObject({ rows: [{
        publication_state: "retirement_pending",
        retirement_reason: "abandoned",
        request_lifecycle: "prepared",
        identity_lifecycle: "prepared",
        active_operation_count: expect.any(Number)
      }] });

      await composition.coordinator.discardAfterRollback(handle);
    } finally {
      await blocker.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [gateKey]).catch(() => undefined);
      blocker.release();
      await blockerPool.end();
      await abortPool.end();
      await pool.query(
        "DROP TRIGGER IF EXISTS zzz_task_14e3e4_journal_gate_trigger ON durable_filesystem_operations",
      );
      await pool.query("DROP FUNCTION IF EXISTS task_14e3e4_journal_gate()");
      await Promise.allSettled([reservation, ...(abort ? [abort] : [])]);
    }
    await expect(pool.query(
      `SELECT mapping.publication_state,mapping.retirement_reason,
              request.lifecycle AS request_lifecycle,identity.lifecycle AS identity_lifecycle,
              (SELECT count(*)::int FROM durable_filesystem_operations filesystem
                WHERE filesystem.asset_id=request.canonical_asset_id
                  AND filesystem.owner_user_id=request.owner_user_id
                  AND filesystem.lifecycle<>'cleaned') AS active_operation_count
         FROM portable_import_normalized_asset_publications mapping
         JOIN asset_publication_requests request ON request.id=mapping.request_id
         JOIN asset_publication_identities identity
           ON identity.asset_id=request.canonical_asset_id AND identity.owner_user_id=request.owner_user_id
        WHERE mapping.operation_id=$1`,
      [scope.operationId],
    )).resolves.toMatchObject({ rows: [{
      publication_state: "retired",
      retirement_reason: "abandoned",
      request_lifecycle: "failed",
      identity_lifecycle: "cleanup_pending",
      active_operation_count: 0
    }] });
  }, 30_000);

  it("exposes a private repository that records prewrite intent before binding a 0064 request", async () => {
    await expect(import(
      "../../packages/database/src/portable-normalized-asset-publication-repository.js"
    )).resolves.toHaveProperty("createPostgresPortableNormalizedAssetPublicationRepository");
  });

  it("exposes an unbound private coordinator over the e2 normalized batch seam", async () => {
    await expect(import(
      "../../services/runtime/src/portable-normalized-asset-publication-composition.js"
    )).resolves.toHaveProperty("createPrivatePortableNormalizedAssetPublicationComposition");
  });

  it("rejects asset-backed reservation intent without an exact grouped source child", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const request = bindPrivateNormalizedAssetPublicationRequest({
      owner: { ownerUserId },
      idempotencyKey: toAssetMutationIdempotencyKey(`14e3e4-empty-source-${crypto.randomUUID()}`),
      original: {
        bytes,
        mimeType: "image/png",
        byteLength: bytes.byteLength,
        contentHash: createHash("sha256").update(bytes).digest("hex"),
        technicalMetadata: {
          state: "verified",
          pixelWidth: 1,
          pixelHeight: 1,
          format: "png",
          pages: 1
        }
      },
      derivatives: [],
      requestedLibrary: {
        title: "",
        caption: "",
        notes: "",
        tags: [],
        origin: "imported",
        reviewStatus: "unreviewed",
        reuseScope: "campaign",
        automaticReuseEnabled: false,
        contentCategories: [],
        favorite: false
      },
      sourceRecords: [],
      provenance: {
        kind: "import",
        importKind: "campaign_zip",
        importOperationId: crypto.randomUUID()
      },
      contextIntents: [],
      referencePolicy: { mode: "omit" }
    });
    const repository = createPostgresPortableNormalizedAssetPublicationRepository(pool);

    await expect(repository.recordReservationIntents({
      operationId: request.provenance.kind === "import"
        ? request.provenance.importOperationId
        : crypto.randomUUID(),
      ownerUserId,
      importKind: "campaign_zip",
      authorityFingerprint: "a".repeat(64),
      commitIdempotencyKeyHash: "b".repeat(64)
    }, [{ request }])).rejects.toThrow("portable_normalized_publication_request_invalid");
  });

  it("rejects raw path-like source keys before recording portable authority", async () => {
    const { scope } = await previewOperation("legacy_story");
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const library = {
      title: "",
      caption: "",
      notes: "",
      tags: [],
      origin: "imported" as const,
      reviewStatus: "unreviewed" as const,
      reuseScope: "campaign" as const,
      automaticReuseEnabled: false,
      contentCategories: [],
      favorite: false
    };
    const request = bindPrivateNormalizedAssetPublicationRequest({
      owner: { ownerUserId },
      idempotencyKey: toAssetMutationIdempotencyKey(`14e3e4-path-source-${crypto.randomUUID()}`),
      original: {
        bytes,
        mimeType: "image/png",
        byteLength: bytes.byteLength,
        contentHash: hash(bytes),
        technicalMetadata: {
          state: "verified",
          pixelWidth: 1,
          pixelHeight: 1,
          format: "png",
          pages: 1
        }
      },
      derivatives: [],
      requestedLibrary: library,
      sourceRecords: [{
        sourceKind: "legacy_story",
        sourceAssetId: crypto.randomUUID(),
        sourceRecordId: null,
        sourceKey: "images/companion.png",
        requestedLibrary: library,
        bindingIntentKeys: []
      }],
      provenance: {
        kind: "import",
        importKind: "legacy_story",
        importOperationId: scope.operationId
      },
      contextIntents: [],
      referencePolicy: { mode: "omit" }
    });
    const repository = createPostgresPortableNormalizedAssetPublicationRepository(pool);

    await expect(repository.recordReservationIntents(scope, [{ request }]))
      .rejects.toThrow("portable_normalized_publication_request_invalid");
    await expect(pool.query(
      "SELECT count(*)::int AS count FROM portable_import_normalized_asset_publications WHERE operation_id=$1",
      [scope.operationId],
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("rejects raw path and URL source identities at application, repository, and SQL boundaries", async () => {
    const { scope } = await previewOperation("legacy_story");
    const { request } = await normalizedImportRequest(scope, "14e3e4-opaque-source-authority");
    const source = request.sourceRecords[0]!;
    expect(() => bindPrivateNormalizedAssetPublicationRequest({
      ...request,
      sourceRecords: [{ ...source, sourceAssetId: "../private/cover.png" }]
    })).not.toThrow();
    expect(() => bindPrivateNormalizedAssetPublicationRequest({
      ...request,
      sourceRecords: [{ ...source, sourceRecordId: "https://example.test/private.png" }]
    })).not.toThrow();
    const rawSourceInstallationId = "https://source.example.test/private?token=do-not-retain";
    const rawInstallationRequest = bindPrivateNormalizedAssetPublicationRequest({
      ...request,
      provenance: {
        kind: "import",
        importKind: scope.importKind,
        importOperationId: scope.operationId,
        sourceInstallationId: toPortableSourceInstallationId(rawSourceInstallationId)
      }
    });

    const repository = createPostgresPortableNormalizedAssetPublicationRepository(pool);
    const forged = Object.freeze({
      ...request,
      sourceRecords: Object.freeze([{ ...source, sourceAssetId: "/tmp/private.png" }])
    }) as typeof request;
    await expect(repository.recordReservationIntents(scope, [{ request: forged }]))
      .rejects.toThrow("portable_normalized_publication_request_invalid");
    await expect(repository.recordReservationIntents(scope, [{ request: rawInstallationRequest }]))
      .rejects.toThrow("portable_normalized_publication_request_invalid");

    await pool.query(
      `INSERT INTO portable_import_normalized_asset_publications (
         operation_id,owner_user_id,asset_ordinal,import_kind,authority_fingerprint,
         commit_idempotency_key_hash,request_fingerprint,request_idempotency_key_hash
       ) VALUES ($1,$2,77,$3,$4,$5,$6,$7)`,
      [
        scope.operationId,
        ownerUserId,
        scope.importKind,
        scope.authorityFingerprint,
        scope.commitIdempotencyKeyHash,
        hash("sql-source-fingerprint"),
        hash("sql-source-idempotency")
      ],
    );
    const insertSource = (sourceAssetId: string, sourceRecordId: string | null, ordinal: number) => pool.query(
      `INSERT INTO portable_import_normalized_asset_sources (
         operation_id,owner_user_id,asset_ordinal,source_ordinal,source_kind,
         source_asset_id,source_record_id,source_key,requested_library_snapshot,binding_intent_keys
       ) VALUES ($1,$2,77,$3,$4,$5,$6,NULL,$7::jsonb,'[]'::jsonb)`,
      [
        scope.operationId,
        ownerUserId,
        ordinal,
        scope.importKind,
        sourceAssetId,
        sourceRecordId,
        JSON.stringify(source.requestedLibrary)
      ],
    );
    await expect(insertSource("../private/cover.png", hash("record"), 0)).rejects.toThrow();
    await expect(insertSource(crypto.randomUUID(), "https://example.test/private.png", 1)).rejects.toThrow();

    const generic = createPostgresNormalizedAssetPublicationRepository(pool);
    const rawReserved = await generic.reserveRequest(rawInstallationRequest);
    expect(rawReserved.outcome).toBe("reserved");
    const rawRequest = await pool.query<{
      request_fingerprint: string;
      idempotency_key_hash: string;
    }>(
      `SELECT request_fingerprint,idempotency_key_hash
         FROM asset_publication_requests
        WHERE id=$1 AND owner_user_id=$2`,
      [rawReserved.requestId, ownerUserId],
    );
    await pool.query(
      `INSERT INTO portable_import_normalized_asset_publications (
         operation_id,owner_user_id,asset_ordinal,import_kind,authority_fingerprint,
         commit_idempotency_key_hash,request_fingerprint,request_idempotency_key_hash
       ) VALUES ($1,$2,78,$3,$4,$5,$6,$7)`,
      [
        scope.operationId,
        ownerUserId,
        scope.importKind,
        scope.authorityFingerprint,
        scope.commitIdempotencyKeyHash,
        rawRequest.rows[0]!.request_fingerprint,
        rawRequest.rows[0]!.idempotency_key_hash
      ],
    );
    await pool.query(
      `INSERT INTO portable_import_normalized_asset_sources (
         operation_id,owner_user_id,asset_ordinal,source_ordinal,source_kind,
         source_asset_id,source_record_id,source_key,requested_library_snapshot,binding_intent_keys
       ) VALUES ($1,$2,78,0,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
      [
        scope.operationId,
        ownerUserId,
        source.sourceKind,
        source.sourceAssetId,
        source.sourceRecordId,
        source.sourceKey,
        JSON.stringify(source.requestedLibrary),
        JSON.stringify(source.bindingIntentKeys)
      ],
    );
    await expect(pool.query(
      `UPDATE portable_import_normalized_asset_publications
          SET request_id=$3,publication_state='reserved'
        WHERE operation_id=$1 AND owner_user_id=$2 AND asset_ordinal=78`,
      [scope.operationId, ownerUserId, rawReserved.requestId],
    )).rejects.toThrow();
  });

  it("rejects duplicate nullable source semantics and post-terminal request attachment", async () => {
    const { scope, previewToken } = await previewOperation("legacy_story");
    const { request } = await normalizedImportRequest(scope, "14e3e4-terminal-source-fence");
    const repository = createPostgresPortableNormalizedAssetPublicationRepository(pool);
    await repository.recordReservationIntents(scope, [{ request }]);
    const source = request.sourceRecords[0]!;
    await expect(pool.query(
      `INSERT INTO portable_import_normalized_asset_sources (
         operation_id,owner_user_id,asset_ordinal,source_ordinal,source_kind,
         source_asset_id,source_record_id,source_key,requested_library_snapshot,binding_intent_keys
       ) VALUES ($1,$2,0,1,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
      [
        scope.operationId,
        ownerUserId,
        scope.importKind,
        source.sourceAssetId,
        source.sourceRecordId,
        source.sourceKey,
        JSON.stringify(source.requestedLibrary),
        JSON.stringify(source.bindingIntentKeys)
      ],
    )).rejects.toThrow();

    const authority = createPostgresPortableImportAuthorityRepository(
      pool,
      createPostgresImportRepository(pool),
      { retireAbandonedOperationInTransaction: repository.retireAbandonedOperationInTransaction },
    );
    await authority.abort({ ownerUserId }, previewToken);
    const retiredAuthority = await pool.query<{
      request_fingerprint: string;
      request_idempotency_key_hash: string;
    }>(
      `SELECT request_fingerprint,request_idempotency_key_hash
         FROM portable_import_normalized_asset_publications
        WHERE operation_id=$1 AND owner_user_id=$2`,
      [scope.operationId, ownerUserId],
    );
    const detachedRequest = await pool.query<{ id: string }>(
      `INSERT INTO asset_publication_requests (
         owner_user_id,idempotency_key_hash,request_fingerprint,
         requested_library_snapshot,provenance_snapshot
       ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb) RETURNING id`,
      [
        ownerUserId,
        retiredAuthority.rows[0]!.request_idempotency_key_hash,
        retiredAuthority.rows[0]!.request_fingerprint,
        JSON.stringify(request.requestedLibrary),
        JSON.stringify({
          kind: "import",
          importKind: scope.importKind,
          importOperationId: scope.operationId,
          importId: null,
          sourceInstallationId: null
        })
      ],
    );
    await expect(pool.query(
      `UPDATE portable_import_normalized_asset_publications
          SET request_id=$2
        WHERE operation_id=$1 AND owner_user_id=$3 AND publication_state='retired'`,
      [scope.operationId, detachedRequest.rows[0]!.id, ownerUserId],
    )).rejects.toThrow();
    await expect(pool.query(
      `SELECT publication_state,retirement_reason,request_id
         FROM portable_import_normalized_asset_publications
        WHERE operation_id=$1`,
      [scope.operationId],
    )).resolves.toMatchObject({ rows: [{
      publication_state: "retired",
      retirement_reason: "abandoned",
      request_id: null
    }] });
  });

  it("rejects a malformed derivative kind in a normalized safe result", async () => {
    const malformed = {
      assetId: crypto.randomUUID(),
      mimeType: "image/png",
      byteLength: 1,
      contentHash: "a".repeat(64),
      pixelWidth: 1,
      pixelHeight: 1,
      derivatives: [{
        derivativeId: crypto.randomUUID(),
        derivativeKind: null,
        transformVersion: 1,
        pixelWidth: 1,
        pixelHeight: 1
      }]
    };
    const validity = await pool.query<{ valid: boolean }>(
      "SELECT portable_import_normalized_safe_result_valid($1::jsonb) AS valid",
      [JSON.stringify(malformed)],
    );

    expect(validity.rows).toEqual([{ valid: false }]);
  });

  it("rejects attachment authority when the consuming operation owns a different commit key", async () => {
    const { scope } = await previewOperation();
    await pool.query(
      `UPDATE portable_import_operations
          SET status='consuming',idempotency_key_hash=$2,commit_request_fingerprint=$3,
              consumed_at=clock_timestamp()
        WHERE id=$1`,
      [scope.operationId, "c".repeat(64), hash(`claim-${scope.operationId}`)],
    );
    const repository = createPostgresPortableNormalizedAssetPublicationRepository(pool);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await expect(repository.recordAttachedInTransaction(
        client,
        scope,
        crypto.randomUUID(),
        [],
      )).rejects.toThrow("portable_normalized_publication_operation_unavailable");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("records source intent before e2 reserve, attaches atomically, and finalizes after a fresh composition", async () => {
    const { scope, previewToken } = await previewOperation();
    const target = await createWorldScope(`14e3e4 exact child authority ${crypto.randomUUID()}`);
    const campaign = await pool.query<{ id: string }>(
      `INSERT INTO campaigns (owner_user_id,world_version_id,title)
       VALUES ($1,$2,'Task 14e3e4 exact child authority') RETURNING id`,
      [ownerUserId, target.worldVersionId],
    );
    const campaignId = campaign.rows[0]!.id;
    const bytes = await sharp({
      create: {
        width: 4,
        height: 2,
        channels: 3,
        background: { r: 12, g: 34, b: 56 }
      }
    }).png().toBuffer();
    const sourceAssetId = crypto.randomUUID();
    const contextIntentKey = `portable-context-${hash(`context:${scope.operationId}`)}`;
    const referenceIntentKey = `portable-reference-${hash(`reference:${scope.operationId}`)}`;
    const contextId = crypto.randomUUID();
    const referenceId = crypto.randomUUID();
    await pool.query(`CREATE FUNCTION task_14e3e4_prewrite_guard() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.provenance_snapshot->>'importOperationId'=$1 AND (
          NOT EXISTS (
              SELECT 1 FROM portable_import_normalized_asset_publications mapping
               WHERE mapping.operation_id=$1::uuid
                 AND mapping.owner_user_id=NEW.owner_user_id
                 AND mapping.request_fingerprint=NEW.request_fingerprint
                 AND mapping.publication_state='reservation_intent'
            )
          OR NOT EXISTS (
              SELECT 1 FROM portable_import_normalized_asset_sources source
               WHERE source.operation_id=$1::uuid
                 AND source.owner_user_id=NEW.owner_user_id
            )
          OR NOT EXISTS (
              SELECT 1 FROM portable_import_normalized_asset_contexts context_intent
               WHERE context_intent.operation_id=$1::uuid
                 AND context_intent.owner_user_id=NEW.owner_user_id
            )
          OR NOT EXISTS (
              SELECT 1 FROM portable_import_normalized_asset_references reference_intent
               WHERE reference_intent.operation_id=$1::uuid
                 AND reference_intent.owner_user_id=NEW.owner_user_id
            )
        ) THEN
          RAISE EXCEPTION 'task_14e3e4_prewrite_missing';
        END IF;
        RETURN NEW;
      END;
      $$`.replaceAll("$1", `'${scope.operationId}'`));
    await pool.query(`CREATE TRIGGER task_14e3e4_prewrite_guard_trigger
      BEFORE INSERT ON asset_publication_requests
      FOR EACH ROW EXECUTE FUNCTION task_14e3e4_prewrite_guard()`);
    const first = await compose();
    const reservation = await first.coordinator.reserve({
      scope,
      leaseOwner: "task-14e3e4-reserve",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      assets: [{
        idempotencyKey: toAssetMutationIdempotencyKey(`task-14e3e4-${crypto.randomUUID()}`),
        artifact: {
          bytes,
          declaredMimeType: "image/png",
          byteLength: bytes.byteLength,
          contentHash: hash(bytes)
        },
        requestedLibrary: {
          title: "Frozen archive title",
          caption: "",
          notes: "",
          tags: ["archive"],
          origin: "imported",
          reviewStatus: "eligible",
          reuseScope: "campaign",
          automaticReuseEnabled: false,
          contentCategories: [],
          favorite: false
        },
        sourceRecords: [{
          sourceKind: "campaign_zip",
          sourceAssetId,
          sourceRecordId: hash(sourceAssetId),
          sourceKey: `source-key-sha256:${hash("assets/grouped-cover.png")}`,
          requestedLibrary: {
            title: "Frozen archive title",
            caption: "",
            notes: "",
            tags: ["archive"],
            origin: "imported",
            reviewStatus: "eligible",
            reuseScope: "campaign",
            automaticReuseEnabled: false,
            contentCategories: [],
            favorite: false
          },
          bindingIntentKeys: [contextIntentKey, referenceIntentKey]
        }],
        sourceInstallationId: `source-installation-sha256:${hash("source-installation")}`,
        contextIntents: [{
          intentKey: contextIntentKey,
          sourceContextId: null,
          targetType: "other",
          variantIndex: 0,
          worldId: target.worldId,
          worldVersionId: target.worldVersionId,
          campaignId,
          turnId: null,
          fictionPromptIdentity: null
        }],
        referencePolicy: {
          mode: "attach",
          intents: [{
            intentKey: referenceIntentKey,
            assetRole: "import_attachment",
            sourceCampaignId: null,
            sourceTurnId: null,
            campaignId,
            turnId: null
          }]
        }
      }]
    });
    await pool.query("DROP TRIGGER task_14e3e4_prewrite_guard_trigger ON asset_publication_requests");
    await pool.query("DROP FUNCTION task_14e3e4_prewrite_guard()");

    const precommit = await pool.query<{
      publication_state: string;
      sources: number;
      contexts: number;
      references: number;
      request_sources: number;
      request_contexts: number;
      request_references: number;
      derivatives: number;
    }>(
      `SELECT mapping.publication_state,
              (SELECT count(*)::int FROM portable_import_normalized_asset_sources source
                WHERE source.operation_id=mapping.operation_id
                  AND source.asset_ordinal=mapping.asset_ordinal) AS sources,
              (SELECT count(*)::int FROM portable_import_normalized_asset_contexts context_intent
                WHERE context_intent.operation_id=mapping.operation_id
                  AND context_intent.asset_ordinal=mapping.asset_ordinal) AS contexts,
              (SELECT count(*)::int FROM portable_import_normalized_asset_references reference_intent
                WHERE reference_intent.operation_id=mapping.operation_id
                  AND reference_intent.asset_ordinal=mapping.asset_ordinal) AS references,
              (SELECT count(*)::int FROM asset_publication_request_sources request_source
                WHERE request_source.request_id=mapping.request_id) AS request_sources,
              (SELECT count(*)::int FROM asset_publication_request_contexts request_context
                WHERE request_context.request_id=mapping.request_id) AS request_contexts,
              (SELECT count(*)::int FROM asset_publication_request_references request_reference
                WHERE request_reference.request_id=mapping.request_id) AS request_references,
              (SELECT count(*)::int FROM asset_publication_request_derivatives derivative
                WHERE derivative.request_id=mapping.request_id) AS derivatives
         FROM portable_import_normalized_asset_publications mapping
        WHERE mapping.operation_id=$1`,
      [scope.operationId],
    );
    expect(precommit.rows).toEqual([{
      publication_state: "reserved",
      sources: 1,
      contexts: 1,
      references: 1,
      request_sources: 0,
      request_contexts: 0,
      request_references: 0,
      derivatives: 0
    }]);

    const client = await pool.connect();
    let importId = "";
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE portable_import_operations
            SET status='consuming',idempotency_key_hash=$2,commit_request_fingerprint=$3,
                consumed_at=clock_timestamp()
          WHERE id=$1`,
        [scope.operationId, scope.commitIdempotencyKeyHash, hash(`claim-${scope.operationId}`)],
      );
      const attached = await first.coordinator.attachInTransaction(
        client,
        reservation,
        async (results) => {
          await client.query(
            `INSERT INTO asset_generation_contexts (
               id,owner_user_id,asset_id,created_by_user_id,world_id,world_version_id,
               campaign_id,target_type,variant_index
             ) VALUES ($1,$2,$3,$2,$4,$5,$6,'other',0)`,
            [contextId, ownerUserId, results[0]!.assetId, target.worldId, target.worldVersionId, campaignId],
          );
          await client.query(
            `INSERT INTO asset_references (
               id,owner_user_id,asset_id,campaign_id,asset_role
             ) VALUES ($1,$2,$3,$4,'import_attachment')`,
            [referenceId, ownerUserId, results[0]!.assetId, campaignId],
          );
          const imported = await client.query<{ id: string }>(
            `INSERT INTO imports (
               owner_user_id,source_type,source_name,source_hash,status,completed_at
             ) VALUES ($1,'portable_campaign_zip','campaign.zip',$2,'completed',clock_timestamp())
             RETURNING id`,
            [ownerUserId, scope.authorityFingerprint],
          );
          importId = imported.rows[0]!.id;
          return Object.freeze({
            importId,
            childBindings: Object.freeze([{
              contexts: [{ intentKey: contextIntentKey, contextId }],
              references: [{ intentKey: referenceIntentKey, referenceId }]
            }]),
            value: Object.freeze({ assetId: results[0]!.assetId })
          });
        },
      );
      expect(attached.publications).toHaveLength(1);
      await client.query(
        `UPDATE portable_import_operations
            SET status='committed',result_retrieval_token_hash=$2,import_id=$3,
                result_projection='{}'::jsonb,completed_at=clock_timestamp()
          WHERE id=$1`,
        [scope.operationId, hash(`result-${scope.operationId}`), importId],
      );
      await client.query(
        `UPDATE portable_import_work
            SET status='completed',phase='completed',percentage=100,terminal_at=clock_timestamp()
          WHERE operation_id=$1`,
        [scope.operationId],
      );
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    await first.close();
    compositions.delete(first);
    const restarted = await compose();
    await expect(restarted.coordinator.recoverCommitted({
      ownerUserId,
      previewToken,
      leaseOwner: "task-14e3e4-restart",
      leaseSeconds: 30
    })).resolves.toMatchObject({ outcome: "published", assets: [{ contentHash: hash(bytes) }] });

    const persisted = await pool.query<{
      publication_state: string;
      request_lifecycle: string;
      source_asset_id: string;
      source_key: string;
      title: string;
      context_count: number;
      reference_count: number;
      contexts_match: boolean;
      references_match: boolean;
    }>(
      `SELECT mapping.publication_state,request.lifecycle AS request_lifecycle,
              source.source_asset_id,source.source_key,library.title,
              (SELECT count(*)::int FROM portable_import_normalized_asset_contexts exact_context
                WHERE exact_context.operation_id=mapping.operation_id
                  AND exact_context.asset_ordinal=mapping.asset_ordinal) AS context_count,
              (SELECT count(*)::int FROM portable_import_normalized_asset_references exact_reference
                WHERE exact_reference.operation_id=mapping.operation_id
                  AND exact_reference.asset_ordinal=mapping.asset_ordinal) AS reference_count,
              (SELECT jsonb_agg(jsonb_build_array(intent_key,context_snapshot) ORDER BY intent_key)
                 FROM portable_import_normalized_asset_contexts exact_context
                WHERE exact_context.operation_id=mapping.operation_id
                  AND exact_context.asset_ordinal=mapping.asset_ordinal)
                = (SELECT jsonb_agg(jsonb_build_array(intent_key,context_snapshot) ORDER BY intent_key)
                     FROM asset_publication_request_contexts request_context
                    WHERE request_context.request_id=mapping.request_id) AS contexts_match,
              (SELECT jsonb_agg(jsonb_build_array(intent_key,reference_snapshot) ORDER BY intent_key)
                 FROM portable_import_normalized_asset_references exact_reference
                WHERE exact_reference.operation_id=mapping.operation_id
                  AND exact_reference.asset_ordinal=mapping.asset_ordinal)
                = (SELECT jsonb_agg(jsonb_build_array(intent_key,reference_snapshot) ORDER BY intent_key)
                     FROM asset_publication_request_references request_reference
                    WHERE request_reference.request_id=mapping.request_id) AS references_match
         FROM portable_import_normalized_asset_publications mapping
         JOIN asset_publication_requests request ON request.id=mapping.request_id
         JOIN portable_import_normalized_asset_sources source
           ON source.operation_id=mapping.operation_id
          AND source.asset_ordinal=mapping.asset_ordinal
         JOIN asset_library_entries library
           ON library.asset_id=(mapping.safe_result->>'assetId')::uuid
          AND library.owner_user_id=mapping.owner_user_id
        WHERE mapping.operation_id=$1`,
      [scope.operationId],
    );
    expect(persisted.rows).toEqual([{
      publication_state: "published",
      request_lifecycle: "published",
      source_asset_id: sourceAssetId,
      source_key: `source-key-sha256:${hash("assets/grouped-cover.png")}`,
      title: "Frozen archive title",
      context_count: 1,
      reference_count: 1,
      contexts_match: true,
      references_match: true
    }]);
  }, 30_000);

  it("keeps committed finalization recoverable after progress TTL and completes replay", async () => {
    const target = await createWorldScope(`14e3e4 committed ttl target ${crypto.randomUUID()}`);
    let composition = await composePortable(
      target,
      "14e3e4-committed-ttl-a",
      pool,
      { previewTtlSeconds: 2, leaseSeconds: 1 },
    );
    const sourceAssetId = crypto.randomUUID();
    const image = await sharp({
      create: {
        width: 4,
        height: 4,
        channels: 3,
        background: { r: 81, g: 101, b: 121 }
      }
    }).png().toBuffer();
    const bytes = await campaignZip(`committed-ttl-${crypto.randomUUID()}`, { sourceAssetId, bytes: image });
    const staged = await stagedInput(composition, bytes, "14e3e4-committed-ttl");
    const preview = await composition.previewCampaignZip({
      ownerUserId,
      stagedInput: staged,
      kind: "campaign_zip",
      destination: { kind: "embedded", operation: "create_world" }
    });
    const command = {
      ownerUserId,
      kind: "campaign_zip" as const,
      destination: preview.destination,
      previewHandle: preview.previewHandle,
      idempotencyKey: `14e3e4-committed-ttl-${crypto.randomUUID()}`
    };
    await pool.query(`CREATE FUNCTION task_14e3e4_finalization_pending_fault() RETURNS trigger
      LANGUAGE plpgsql AS $fault$
      BEGIN RAISE EXCEPTION 'task_14e3e4_finalization_pending_fault'; END;
      $fault$`);
    await pool.query(`CREATE TRIGGER task_14e3e4_finalization_pending_fault_trigger
      BEFORE UPDATE ON portable_import_normalized_asset_publications
      FOR EACH ROW WHEN (NEW.publication_state='published' AND OLD.publication_state='committed_finalization_pending')
      EXECUTE FUNCTION task_14e3e4_finalization_pending_fault()`);
    try {
      await expect(composition.commit(command)).rejects.toThrow(
        "asset_publication_finalization_recoverable",
      );
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS task_14e3e4_finalization_pending_fault_trigger ON portable_import_normalized_asset_publications",
      );
      await pool.query("DROP FUNCTION IF EXISTS task_14e3e4_finalization_pending_fault()");
    }
    const expiry = await pool.query<{ remaining_ms: number }>(
      `SELECT GREATEST(
                0,
                ceil(extract(epoch FROM (work.expires_at-clock_timestamp()))*1000)
              )::int AS remaining_ms
         FROM portable_import_work work
         JOIN portable_import_operations operation ON operation.id=work.operation_id
        WHERE operation.preview_token_hash=$1`,
      [hash(preview.previewHandle.token)],
    );
    await new Promise((resolveDelay) => setTimeout(
      resolveDelay,
      (expiry.rows[0]?.remaining_ms ?? 0) + 50,
    ));

    await expect(composition.progress(
      { ownerUserId },
      preview.previewHandle.token,
    )).resolves.toMatchObject({ status: "recoverable", phase: "finalizing" });
    await composition.close();
    composition = await composePortable(target, "14e3e4-committed-ttl-b");
    await expect(composition.commit(command)).resolves.toMatchObject({
      kind: "campaign_zip",
      duplicate: false
    });
    await expect(composition.progress(
      { ownerUserId },
      preview.previewHandle.token,
    )).resolves.toMatchObject({ status: "completed", phase: "completed" });
  }, 30_000);

  it("keeps Legacy story completion nonfatal when slow post-commit finalization outlives its lease", async () => {
    const target = await createWorldScope(`14e3e4 legacy slow finalize ${crypto.randomUUID()}`);
    let composition = await composePortable(
      target,
      "14e3e4-legacy-slow-finalize-a",
      pool,
      { previewTtlSeconds: 10, leaseSeconds: 1 },
    );
    const image = await sharp({
      create: { width: 3, height: 2, channels: 3, background: { r: 92, g: 42, b: 142 } }
    }).png().toBuffer();
    const bytes = new TextEncoder().encode(JSON.stringify({
      campaign: { title: "Legacy slow finalization" },
      world: { title: "Legacy slow finalization" },
      turns: [{
        id: "legacy-slow-finalize-turn",
        narration: "The narration commits before optional illustration recovery.",
        imageUrl: `data:image/png;base64,${image.toString("base64")}`
      }]
    }));
    const staged = await stagedInput(composition, bytes, "14e3e4-legacy-slow-finalize");
    const destination = {
      kind: "existing_world_version" as const,
      worldId: target.worldId,
      worldVersionId: target.worldVersionId
    };
    const preview = await composition.previewLegacyStory({
      ownerUserId,
      stagedInput: staged,
      kind: "legacy_story",
      destination
    });
    const command = {
      ownerUserId,
      kind: "legacy_story" as const,
      destination,
      previewHandle: preview.previewHandle,
      idempotencyKey: `14e3e4-legacy-slow-finalize-${crypto.randomUUID()}`
    };
    await pool.query(`CREATE FUNCTION task_14e3e4_legacy_slow_finalize_fault() RETURNS trigger
      LANGUAGE plpgsql AS $fault$
      BEGIN
        PERFORM pg_sleep(1.2);
        RAISE EXCEPTION 'task_14e3e4_legacy_slow_finalize_fault';
      END;
      $fault$`);
    await pool.query(`CREATE TRIGGER task_14e3e4_legacy_slow_finalize_fault_trigger
      BEFORE UPDATE ON portable_import_normalized_asset_publications
      FOR EACH ROW WHEN (NEW.publication_state='published' AND OLD.publication_state='committed_finalization_pending')
      EXECUTE FUNCTION task_14e3e4_legacy_slow_finalize_fault()`);
    const startedAt = Date.now();
    let committed: Awaited<ReturnType<typeof composition.commit>> | undefined;
    try {
      committed = await composition.commit(command);
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS task_14e3e4_legacy_slow_finalize_fault_trigger ON portable_import_normalized_asset_publications",
      );
      await pool.query("DROP FUNCTION IF EXISTS task_14e3e4_legacy_slow_finalize_fault()");
    }
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_000);
    expect(committed).toMatchObject({ kind: "legacy_story", duplicate: false });
    await expect(pool.query(
      `SELECT operation.status AS operation_status,work.status AS work_status,
              mapping.publication_state,request.lifecycle AS request_lifecycle
         FROM portable_import_operations operation
         JOIN portable_import_work work
           ON work.operation_id=operation.id AND work.owner_user_id=operation.owner_user_id
         JOIN portable_import_normalized_asset_publications mapping
           ON mapping.operation_id=operation.id AND mapping.owner_user_id=operation.owner_user_id
         JOIN asset_publication_requests request
           ON request.id=mapping.request_id AND request.owner_user_id=mapping.owner_user_id
        WHERE operation.preview_token_hash=$1`,
      [hash(preview.previewHandle.token)],
    )).resolves.toMatchObject({ rows: [{
      operation_status: "committed",
      work_status: "completed",
      publication_state: "committed_finalization_pending",
      request_lifecycle: "published"
    }] });

    await composition.close();
    composition = await composePortable(target, "14e3e4-legacy-slow-finalize-b");
    await expect(composition.commit(command)).resolves.toEqual(committed);
    await expect(pool.query(
      `SELECT mapping.publication_state,request.lifecycle AS request_lifecycle,work.status AS work_status
         FROM portable_import_operations operation
         JOIN portable_import_work work
           ON work.operation_id=operation.id AND work.owner_user_id=operation.owner_user_id
         JOIN portable_import_normalized_asset_publications mapping
           ON mapping.operation_id=operation.id AND mapping.owner_user_id=operation.owner_user_id
         JOIN asset_publication_requests request
           ON request.id=mapping.request_id AND request.owner_user_id=mapping.owner_user_id
        WHERE operation.preview_token_hash=$1`,
      [hash(preview.previewHandle.token)],
    )).resolves.toMatchObject({ rows: [{
      publication_state: "published",
      request_lifecycle: "published",
      work_status: "completed"
    }] });
  }, 30_000);

  it("publishes Campaign ZIP images only through normalized 0064/0066 authority and replays exactly", async () => {
    const target = await createWorldScope(`14e3e4 campaign target ${crypto.randomUUID()}`);
    const composition = await composePortable(target, "14e3e4-campaign");
    const sourceAssetId = crypto.randomUUID();
    const image = await sharp({
      create: {
        width: 6,
        height: 3,
        channels: 4,
        background: { r: 44, g: 66, b: 88, alpha: 1 }
      }
    }).png().toBuffer();
    const bytes = await campaignZip(`campaign-${crypto.randomUUID()}`, {
      sourceAssetId,
      bytes: image
    });
    const staged = await stagedInput(composition, bytes, "14e3e4-campaign");
    const preview = await composition.previewCampaignZip({
      ownerUserId,
      stagedInput: staged,
      kind: "campaign_zip",
      destination: { kind: "embedded", operation: "create_world" }
    });
    const command = {
      ownerUserId,
      kind: "campaign_zip" as const,
      destination: preview.destination,
      previewHandle: preview.previewHandle,
      idempotencyKey: `14e3e4-campaign-${crypto.randomUUID()}`
    };

    const committed = await composition.commit(command);
    expect(committed).toMatchObject({
      kind: "campaign_zip",
      duplicate: false,
      result: { stats: { assetCount: 1 } }
    });
    await expect(composition.commit(command)).resolves.toEqual(committed);

    const authority = await pool.query<{
      publication_state: string;
      request_lifecycle: string;
      content_hash: string;
      derivative_count: number;
      source_count: number;
      context_count: number;
      reference_count: number;
      legacy_count: number;
    }>(
      `SELECT mapping.publication_state,request.lifecycle AS request_lifecycle,
              mapping.safe_result->>'contentHash' AS content_hash,
              jsonb_array_length(mapping.safe_result->'derivatives') AS derivative_count,
              (SELECT count(*)::int FROM asset_publication_request_sources source
                WHERE source.request_id=request.id) AS source_count,
              (SELECT count(*)::int FROM asset_publication_request_contexts context
                WHERE context.request_id=request.id) AS context_count,
              (SELECT count(*)::int FROM asset_publication_request_references reference
                WHERE reference.request_id=request.id) AS reference_count,
              (SELECT count(*)::int FROM portable_import_asset_publications legacy
                WHERE legacy.operation_id=operation.id) AS legacy_count
         FROM portable_import_normalized_asset_publications mapping
         JOIN portable_import_operations operation
           ON operation.id=mapping.operation_id AND operation.owner_user_id=mapping.owner_user_id
         JOIN asset_publication_requests request
           ON request.id=mapping.request_id AND request.owner_user_id=mapping.owner_user_id
        WHERE operation.preview_token_hash=$1`,
      [hash(preview.previewHandle.token)],
    );
    expect(authority.rows).toEqual([{
      publication_state: "published",
      request_lifecycle: "published",
      content_hash: hash(image),
      derivative_count: 1,
      source_count: 1,
      context_count: 0,
      reference_count: 1,
      legacy_count: 0
    }]);
    await expect(pool.query(
      `SELECT source.source_asset_id,source.source_key
         FROM portable_import_normalized_asset_sources source
         JOIN portable_import_operations operation ON operation.id=source.operation_id
        WHERE operation.preview_token_hash=$1`,
      [hash(preview.previewHandle.token)],
    )).resolves.toMatchObject({ rows: [{
      source_asset_id: sourceAssetId,
      source_key: `source-key-sha256:${hash(`assets/${sourceAssetId}.png`)}`
    }] });
  }, 30_000);

  it("rewrites legacy Campaign ZIP pointers by ordinal for non-UUID source turn IDs", async () => {
    const target = await createWorldScope(`14e3e4 legacy-zip-ordinal ${crypto.randomUUID()}`);
    const composition = await composePortable(target, "14e3e4-legacy-zip-ordinal");
    const sourceAssetId = crypto.randomUUID();
    const image = await sharp({
      create: { width: 3, height: 2, channels: 3, background: { r: 41, g: 82, b: 123 } }
    }).png().toBuffer();
    const bytes = await campaignZip(
      `legacy-zip-ordinal-${crypto.randomUUID()}`,
      { sourceAssetId, bytes: image },
      { turnId: "legacy-turn-1", pointerSourceAssetId: sourceAssetId },
    );
    const staged = await stagedInput(composition, bytes, "14e3e4-legacy-zip-ordinal");
    const preview = await composition.previewCampaignZip({
      ownerUserId,
      stagedInput: staged,
      kind: "campaign_zip",
      destination: { kind: "embedded", operation: "create_world" }
    });
    const committed = await composition.commit({
      ownerUserId,
      kind: "campaign_zip",
      destination: preview.destination,
      previewHandle: preview.previewHandle,
      idempotencyKey: `14e3e4-legacy-zip-ordinal-${crypto.randomUUID()}`
    });
    const campaignId = (committed.result as Readonly<{ campaignId: string }>).campaignId;
    const turn = await pool.query<{ id: string; source_turn_id: string; image_url: string }>(
      "SELECT id,source_turn_id,image_url FROM turns WHERE campaign_id=$1",
      [campaignId],
    );
    expect(turn.rows).toEqual([expect.objectContaining({
      source_turn_id: "legacy-turn-1",
      image_url: expect.stringMatching(/^\/api\/v1\/assets\/[0-9a-f-]{36}$/u)
    })]);
    await expect(pool.query(
      `SELECT source.source_asset_id,
              reference.reference_snapshot->>'sourceTurnId' AS source_turn_id,
              live.turn_id AS live_turn_id
         FROM portable_import_operations operation
         JOIN portable_import_normalized_asset_publications mapping
           ON mapping.operation_id=operation.id
         JOIN portable_import_normalized_asset_sources source
           ON source.operation_id=mapping.operation_id AND source.asset_ordinal=mapping.asset_ordinal
         JOIN asset_publication_request_references reference ON reference.request_id=mapping.request_id
         JOIN asset_references live ON live.id=reference.reference_id
        WHERE operation.preview_token_hash=$1`,
      [hash(preview.previewHandle.token)],
    )).resolves.toMatchObject({ rows: [{
      source_asset_id: sourceAssetId,
      source_turn_id: null,
      live_turn_id: turn.rows[0]!.id
    }] });
  }, 30_000);

  it("maps shared legacy ZIP assets and duplicate UUID source turns by exact ordinal", async () => {
    const target = await createWorldScope(`14e3e4 legacy-zip-shared ${crypto.randomUUID()}`);
    const composition = await composePortable(target, "14e3e4-legacy-zip-shared");
    const firstSourceAssetId = crypto.randomUUID();
    const secondSourceAssetId = crypto.randomUUID();
    const duplicateSourceTurnId = crypto.randomUUID();
    const uniqueSourceTurnId = crypto.randomUUID();
    const firstImage = await sharp({
      create: { width: 3, height: 2, channels: 3, background: { r: 211, g: 31, b: 61 } }
    }).png().toBuffer();
    const secondImage = await sharp({
      create: { width: 2, height: 3, channels: 3, background: { r: 17, g: 151, b: 91 } }
    }).png().toBuffer();
    const bytes = await campaignZip(
      `legacy-zip-shared-${crypto.randomUUID()}`,
      [
        { sourceAssetId: secondSourceAssetId, bytes: secondImage },
        { sourceAssetId: firstSourceAssetId, bytes: firstImage }
      ],
      {
        turns: [
          { id: duplicateSourceTurnId, pointerSourceAssetId: firstSourceAssetId },
          { id: duplicateSourceTurnId, pointerSourceAssetId: secondSourceAssetId },
          { id: uniqueSourceTurnId, pointerSourceAssetId: firstSourceAssetId }
        ]
      },
    );
    const staged = await stagedInput(composition, bytes, "14e3e4-legacy-zip-shared");
    const preview = await composition.previewCampaignZip({
      ownerUserId,
      stagedInput: staged,
      kind: "campaign_zip",
      destination: { kind: "embedded", operation: "create_world" }
    });
    const committed = await composition.commit({
      ownerUserId,
      kind: "campaign_zip",
      destination: preview.destination,
      previewHandle: preview.previewHandle,
      idempotencyKey: `14e3e4-legacy-zip-shared-${crypto.randomUUID()}`
    });
    const campaignId = (committed.result as Readonly<{ campaignId: string }>).campaignId;
    const turns = await pool.query<{
      id: string;
      source_turn_id: string;
      image_url: string | null;
    }>(
      "SELECT id,source_turn_id,image_url FROM turns WHERE campaign_id=$1 ORDER BY turn_number",
      [campaignId],
    );
    expect(turns.rows.map(({ source_turn_id, image_url }) => ({ source_turn_id, image_url }))).toEqual([
      { source_turn_id: duplicateSourceTurnId, image_url: expect.stringMatching(/^\/api\/v1\/assets\/[0-9a-f-]{36}$/u) },
      { source_turn_id: duplicateSourceTurnId, image_url: expect.stringMatching(/^\/api\/v1\/assets\/[0-9a-f-]{36}$/u) },
      { source_turn_id: uniqueSourceTurnId, image_url: expect.stringMatching(/^\/api\/v1\/assets\/[0-9a-f-]{36}$/u) }
    ]);
    expect(turns.rows[0]!.image_url).toBe(turns.rows[2]!.image_url);
    expect(turns.rows[1]!.image_url).not.toBe(turns.rows[0]!.image_url);

    const references = await pool.query<{
      source_asset_id: string;
      source_turn_id: string | null;
      live_turn_id: string;
    }>(
      `SELECT source.source_asset_id,
              reference.reference_snapshot->>'sourceTurnId' AS source_turn_id,
              live.turn_id AS live_turn_id
         FROM portable_import_operations operation
         JOIN portable_import_normalized_asset_publications mapping
           ON mapping.operation_id=operation.id
         JOIN portable_import_normalized_asset_sources source
           ON source.operation_id=mapping.operation_id AND source.asset_ordinal=mapping.asset_ordinal
         JOIN asset_publication_request_references reference ON reference.request_id=mapping.request_id
         JOIN asset_references live ON live.id=reference.reference_id
        WHERE operation.preview_token_hash=$1
        ORDER BY live.turn_id,source.source_asset_id`,
      [hash(preview.previewHandle.token)],
    );
    expect(references.rows).toHaveLength(3);
    expect(references.rows).toEqual(expect.arrayContaining([
      { source_asset_id: firstSourceAssetId, source_turn_id: duplicateSourceTurnId, live_turn_id: turns.rows[0]!.id },
      { source_asset_id: secondSourceAssetId, source_turn_id: duplicateSourceTurnId, live_turn_id: turns.rows[1]!.id },
      { source_asset_id: firstSourceAssetId, source_turn_id: uniqueSourceTurnId, live_turn_id: turns.rows[2]!.id }
    ]));
  }, 30_000);

  it("retains distinct grouped source provenance while deduplicating one live reference", async () => {
    const target = await createWorldScope(`14e3e4 grouped provenance ${crypto.randomUUID()}`);
    const composition = await composePortable(target, "14e3e4-grouped-provenance");
    const firstSourceAssetId = crypto.randomUUID();
    const secondSourceAssetId = crypto.randomUUID();
    const archive = await richCampaignZip(`grouped-${crypto.randomUUID()}`, {
      sourceAssetId: firstSourceAssetId,
      secondarySourceAssetId: secondSourceAssetId
    });
    const rawSourceInstallationId = `https://source.example.test/private/${crypto.randomUUID()}?token=secret`;
    const staged = await stagedInput(composition, archive.bytes, "14e3e4-grouped-provenance");
    const preview = await composition.previewCampaignZip({
      ownerUserId,
      stagedInput: staged,
      kind: "campaign_zip",
      sourceInstallationId: toPortableSourceInstallationId(rawSourceInstallationId),
      destination: { kind: "embedded", operation: "create_world" }
    });
    await composition.commit({
      ownerUserId,
      kind: "campaign_zip",
      destination: preview.destination,
      previewHandle: preview.previewHandle,
      idempotencyKey: `14e3e4-grouped-provenance-${crypto.randomUUID()}`
    });
    const provenance = await pool.query<{
      source_asset_id: string;
      binding_intent_keys: unknown[];
      request_reference_count: number;
      live_reference_count: number;
      source_installation_id: string;
      raw_installation_retained: boolean;
    }>(
      `SELECT source.source_asset_id,source.binding_intent_keys,
              (SELECT count(*)::int FROM asset_publication_request_references child
                WHERE child.request_id=mapping.request_id) AS request_reference_count,
              (SELECT count(*)::int FROM asset_references live
                WHERE live.asset_id=(mapping.safe_result->>'assetId')::uuid
                  AND live.asset_role='turn_illustration') AS live_reference_count,
              request.provenance_snapshot->>'sourceInstallationId' AS source_installation_id,
              request.provenance_snapshot::text LIKE ('%' || $2 || '%') AS raw_installation_retained
         FROM portable_import_operations operation
         JOIN portable_import_normalized_asset_publications mapping ON mapping.operation_id=operation.id
         JOIN asset_publication_requests request ON request.id=mapping.request_id
         JOIN portable_import_normalized_asset_sources source
           ON source.operation_id=mapping.operation_id AND source.asset_ordinal=mapping.asset_ordinal
        WHERE operation.preview_token_hash=$1
        ORDER BY source.source_asset_id`,
      [hash(preview.previewHandle.token), rawSourceInstallationId],
    );
    expect(provenance.rows.map((row) => row.source_asset_id)).toEqual(
      [firstSourceAssetId, secondSourceAssetId].sort(),
    );
    expect(provenance.rows.every((row) => row.binding_intent_keys.length > 0)).toBe(true);
    expect(new Set(provenance.rows.flatMap((row) => row.binding_intent_keys.map(String))).size)
      .toBeGreaterThanOrEqual(2);
    expect(provenance.rows).toEqual(provenance.rows.map((row) => expect.objectContaining({
      request_reference_count: 2,
      live_reference_count: 1,
      source_installation_id: `source-installation-sha256:${hash(rawSourceInstallationId)}`,
      raw_installation_retained: false
    })));
  }, 30_000);

  it("deduplicates normalized assets within one owner and isolates the same bytes across owners", async () => {
    const foreign = await pool.query<{ id: string }>(
      "INSERT INTO users (system_key,display_name) VALUES ($1,'Task 14e3e4 foreign') RETURNING id",
      [`task-14e3e4-owner-${crypto.randomUUID()}`],
    );
    const foreignOwnerUserId = foreign.rows[0]!.id;
    const firstTarget = await createWorldScope(`14e3e4 owner first ${crypto.randomUUID()}`);
    const foreignTarget = await createWorldScope(
      `14e3e4 owner foreign ${crypto.randomUUID()}`,
      foreignOwnerUserId,
    );
    const sharedImage = await sharp({
      create: { width: 1, height: 1, channels: 4, background: { r: 19, g: 89, b: 159, alpha: 1 } }
    }).png().toBuffer();
    const uppercaseSourceId = "AAAAAAAA-AAAA-7AAA-8AAA-AAAAAAAAAAAA";
    const archives = [
      await richCampaignZip(`owner-first-${crypto.randomUUID()}`, {
        image: sharedImage,
        sourceAssetId: uppercaseSourceId,
        libraryTitle: "First immutable title"
      }),
      await richCampaignZip(`owner-replay-${crypto.randomUUID()}`, {
        image: sharedImage,
        libraryTitle: "Conflicting later title"
      }),
      await richCampaignZip(`owner-foreign-${crypto.randomUUID()}`, {
        image: sharedImage,
        libraryTitle: "Foreign owner title"
      })
    ];
    const firstComposition = await composePortable(firstTarget, "l".repeat(201));
    const replayComposition = await composePortable(firstTarget, "14e3e4-owner-replay");
    const foreignComposition = await composePortable(
      foreignTarget,
      "14e3e4-owner-foreign",
      pool,
      {},
      foreignOwnerUserId,
    );
    const cases = [
      { composition: firstComposition, ownerId: ownerUserId, archive: archives[0]! },
      { composition: replayComposition, ownerId: ownerUserId, archive: archives[1]! },
      { composition: foreignComposition, ownerId: foreignOwnerUserId, archive: archives[2]! }
    ] as const;
    const previewHashes: string[] = [];
    for (const [index, value] of cases.entries()) {
      const staged = await stagedInput(
        value.composition,
        value.archive.bytes,
        `14e3e4-owner-${index}`,
        value.ownerId,
      );
      const preview = await value.composition.previewCampaignZip({
        ownerUserId: value.ownerId,
        stagedInput: staged,
        kind: "campaign_zip",
        destination: { kind: "embedded", operation: "create_world" }
      });
      await value.composition.commit({
        ownerUserId: value.ownerId,
        kind: "campaign_zip",
        destination: preview.destination,
        previewHandle: preview.previewHandle,
        idempotencyKey: `14e3e4-owner-${index}-${crypto.randomUUID()}`
      });
      previewHashes.push(hash(preview.previewHandle.token));
    }
    const rows = await pool.query<{
      owner_user_id: string;
      asset_id: string;
      storage_path: string;
      title: string;
      source_asset_id: string;
    }>(
      `SELECT operation.owner_user_id,mapping.safe_result->>'assetId' AS asset_id,
              asset.storage_path,library.title,source.source_asset_id
         FROM portable_import_operations operation
         JOIN portable_import_normalized_asset_publications mapping
           ON mapping.operation_id=operation.id AND mapping.owner_user_id=operation.owner_user_id
         JOIN assets asset
           ON asset.id=(mapping.safe_result->>'assetId')::uuid AND asset.owner_user_id=mapping.owner_user_id
         JOIN asset_library_entries library
           ON library.asset_id=asset.id AND library.owner_user_id=asset.owner_user_id
         JOIN portable_import_normalized_asset_sources source
           ON source.operation_id=mapping.operation_id AND source.asset_ordinal=mapping.asset_ordinal
        WHERE operation.preview_token_hash=ANY($1::text[])
        ORDER BY array_position($1::text[],operation.preview_token_hash),source.source_ordinal`,
      [previewHashes],
    );
    const primaryRows = rows.rows.filter((_row, index) => index === 0
      || rows.rows[index - 1]!.owner_user_id !== _row.owner_user_id
      || rows.rows[index - 1]!.asset_id !== _row.asset_id
      || rows.rows[index - 1]!.source_asset_id !== _row.source_asset_id);
    expect(primaryRows).toHaveLength(3);
    expect(primaryRows[0]!.source_asset_id).toBe(uppercaseSourceId);
    expect(primaryRows[0]!.asset_id).toBe(primaryRows[1]!.asset_id);
    expect(primaryRows[0]!.title).toBe("First immutable title");
    expect(primaryRows[1]!.title).toBe("First immutable title");
    expect(primaryRows[2]!.asset_id).not.toBe(primaryRows[0]!.asset_id);
    expect(primaryRows[2]!.owner_user_id).toBe(foreignOwnerUserId);
    expect(primaryRows[2]!.storage_path).toBe(primaryRows[0]!.storage_path);
    await expect(pool.query(
      `SELECT count(*)::int AS count
         FROM portable_import_normalized_asset_publications mapping
        WHERE mapping.owner_user_id=$1
          AND mapping.operation_id IN (
            SELECT operation.id FROM portable_import_operations operation
             WHERE operation.preview_token_hash=ANY($2::text[])
          )`,
      [foreignOwnerUserId, previewHashes.slice(0, 2)],
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  }, 60_000);

  it("freezes exact embedded world targets before rich Campaign ZIP publication", async () => {
    const target = await createWorldScope(`14e3e4 embedded target ${crypto.randomUUID()}`);
    const composition = await composePortable(target, "14e3e4-embedded-targets");
    const archive = await richCampaignZip(`embedded-${crypto.randomUUID()}`);
    const staged = await stagedInput(composition, archive.bytes, "14e3e4-embedded-targets");
    const preview = await composition.previewCampaignZip({
      ownerUserId,
      stagedInput: staged,
      kind: "campaign_zip",
      destination: { kind: "embedded", operation: "create_world" }
    });
    const committed = await composition.commit({
      ownerUserId,
      kind: "campaign_zip",
      destination: preview.destination,
      previewHandle: preview.previewHandle,
      idempotencyKey: `14e3e4-embedded-targets-${crypto.randomUUID()}`
    });
    const result = committed.result as Readonly<{
      worldId: string;
      worldVersionId: string;
      campaignId: string;
    }>;

    const frozen = await pool.query<{
      world_id: string | null;
      world_version_id: string | null;
      live_world_id: string | null;
      live_world_version_id: string | null;
    }>(
      `SELECT context.context_snapshot->>'worldId' AS world_id,
              context.context_snapshot->>'worldVersionId' AS world_version_id,
              live.world_id AS live_world_id,
              live.world_version_id AS live_world_version_id
         FROM portable_import_operations operation
         JOIN portable_import_normalized_asset_publications mapping
           ON mapping.operation_id=operation.id AND mapping.owner_user_id=operation.owner_user_id
         JOIN asset_publication_request_contexts context
           ON context.request_id=mapping.request_id AND context.owner_user_id=mapping.owner_user_id
         JOIN asset_generation_contexts live
           ON live.id=context.context_id AND live.owner_user_id=context.owner_user_id
        WHERE operation.preview_token_hash=$1
        ORDER BY context.intent_key`,
      [hash(preview.previewHandle.token)],
    );
    expect(frozen.rows.length).toBeGreaterThan(0);
    expect(frozen.rows).toEqual(frozen.rows.map(() => ({
      world_id: result.worldId,
      world_version_id: result.worldVersionId,
      live_world_id: result.worldId,
      live_world_version_id: result.worldVersionId
    })));
    await expect(pool.query(
      `SELECT campaign.world_version_id AS campaign_world_version_id,
              world.id AS world_id,
              version.id AS world_version_id
         FROM campaigns campaign
         JOIN world_versions version
           ON version.id=campaign.world_version_id AND version.owner_user_id=campaign.owner_user_id
         JOIN worlds world
           ON world.id=version.world_id AND world.owner_user_id=version.owner_user_id
        WHERE campaign.id=$1 AND campaign.owner_user_id=$2`,
      [result.campaignId, ownerUserId],
    )).resolves.toMatchObject({ rows: [{
      campaign_world_version_id: result.worldVersionId,
      world_id: result.worldId,
      world_version_id: result.worldVersionId
    }] });
  }, 30_000);

  it("publishes every image in a valid 101-image Campaign ZIP atomically", async () => {
    const target = await createWorldScope(`14e3e4 cardinality target ${crypto.randomUUID()}`);
    const composition = await composePortable(target, "14e3e4-cardinality");
    const images = await Promise.all(Array.from({ length: 101 }, async (_, index) => ({
      sourceAssetId: crypto.randomUUID(),
      bytes: await sharp({
        create: {
          width: 1,
          height: 1,
          channels: 4,
          background: { r: index, g: 255 - index, b: (index * 17) % 256, alpha: 1 }
        }
      }).png().toBuffer()
    })));
    const bytes = await campaignZip(`cardinality-${crypto.randomUUID()}`, images);
    const staged = await stagedInput(composition, bytes, "14e3e4-cardinality");
    const preview = await composition.previewCampaignZip({
      ownerUserId,
      stagedInput: staged,
      kind: "campaign_zip",
      destination: { kind: "embedded", operation: "create_world" }
    });

    const committed = await composition.commit({
      ownerUserId,
      kind: "campaign_zip",
      destination: preview.destination,
      previewHandle: preview.previewHandle,
      idempotencyKey: `14e3e4-cardinality-${crypto.randomUUID()}`
    });
    expect(committed).toMatchObject({
      kind: "campaign_zip",
      duplicate: false,
      result: { stats: { assetCount: 101 } }
    });
    await expect(pool.query(
      `SELECT count(*)::int AS count
         FROM portable_import_normalized_asset_publications mapping
         JOIN portable_import_operations operation ON operation.id=mapping.operation_id
        WHERE operation.preview_token_hash=$1 AND mapping.publication_state='published'`,
      [hash(preview.previewHandle.token)],
    )).resolves.toMatchObject({ rows: [{ count: 101 }] });
  }, 60_000);

  it("serializes a concurrent Campaign ZIP replay before normalized reservation", async () => {
    const target = await createWorldScope(`14e3e4 duplicate target ${crypto.randomUUID()}`);
    const firstComposition = await composePortable(target, "14e3e4-duplicate-a");
    const secondRuntimePool = createDatabasePool(databaseUrl!, 2);
    const secondComposition = await composePortable(target, "14e3e4-duplicate-b", secondRuntimePool);
    const sourceAssetId = crypto.randomUUID();
    const image = await sharp({
      create: {
        width: 8,
        height: 3,
        channels: 3,
        background: { r: 31, g: 91, b: 151 }
      }
    }).png().toBuffer();
    const bytes = await campaignZip(`duplicate-${crypto.randomUUID()}`, { sourceAssetId, bytes: image });
    const firstStaged = await stagedInput(firstComposition, bytes, "14e3e4-duplicate-first");
    const firstPreview = await firstComposition.previewCampaignZip({
      ownerUserId,
      stagedInput: firstStaged,
      kind: "campaign_zip",
      destination: { kind: "embedded", operation: "create_world" }
    });
    const command = {
      ownerUserId,
      kind: "campaign_zip" as const,
      destination: firstPreview.destination,
      previewHandle: firstPreview.previewHandle,
      idempotencyKey: `14e3e4-duplicate-first-${crypto.randomUUID()}`
    };
    const operation = await pool.query<{ id: string }>(
      `SELECT id
         FROM portable_import_operations
        WHERE preview_token_hash=$1`,
      [hash(firstPreview.previewHandle.token)],
    );
    const operationId = operation.rows[0]?.id;
    expect(operationId).toMatch(UUID_PATTERN_FOR_TEST);

    const gateKey = `task-14e3e4-duplicate-gate-${crypto.randomUUID()}`;
    const signalKey = `task-14e3e4-duplicate-signal-${crypto.randomUUID()}`;
    const blockerPool = createDatabasePool(databaseUrl!, 2);
    const blocker = await blockerPool.connect();
    await blocker.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [gateKey]);
    await pool.query(`CREATE FUNCTION task_14e3e4_duplicate_gate() RETURNS trigger
      LANGUAGE plpgsql AS $fault$
      BEGIN
        PERFORM pg_advisory_lock(hashtextextended('${signalKey}',0));
        PERFORM pg_advisory_xact_lock(hashtextextended('${gateKey}',0));
        PERFORM pg_advisory_unlock(hashtextextended('${signalKey}',0));
        RETURN NEW;
      END;
      $fault$`);
    await pool.query(`CREATE TRIGGER task_14e3e4_duplicate_gate_trigger
      BEFORE INSERT ON portable_import_normalized_asset_publications
      FOR EACH ROW EXECUTE FUNCTION task_14e3e4_duplicate_gate()`);

    let firstCommit: Promise<Awaited<ReturnType<typeof firstComposition.commit>>> | undefined;
    let secondCommit: Promise<Awaited<ReturnType<typeof secondComposition.commit>>> | undefined;
    try {
      firstCommit = firstComposition.commit(command);
      const signalDeadline = Date.now() + 10_000;
      for (;;) {
        const signal = await blockerPool.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
          [signalKey],
        );
        if (!signal.rows[0]?.acquired) break;
        await blockerPool.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [signalKey]);
        if (Date.now() >= signalDeadline) throw new Error("task_14e3e4_duplicate_gate_timeout");
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      secondCommit = secondComposition.commit(command);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      await blocker.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [gateKey]);
      const [first, second] = await Promise.all([firstCommit, secondCommit]);
      expect(first.duplicate).toBe(false);
      expect(second).toEqual(first);
    } finally {
      await blocker.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [gateKey]).catch(() => undefined);
      blocker.release();
      await blockerPool.end();
      await Promise.allSettled([firstCommit, secondCommit].filter(Boolean));
      await pool.query(
        "DROP TRIGGER IF EXISTS task_14e3e4_duplicate_gate_trigger ON portable_import_normalized_asset_publications",
      );
      await pool.query("DROP FUNCTION IF EXISTS task_14e3e4_duplicate_gate()");
      await secondComposition.close();
      compositions.delete(secondComposition);
      await secondRuntimePool.end();
    }

    await expect(pool.query(
      `SELECT
         mapping.publication_state,
         request.lifecycle AS request_lifecycle,
         (SELECT count(*)::int
            FROM portable_import_normalized_asset_publications exact_mapping
           WHERE exact_mapping.operation_id=$1) AS mapping_count,
         (SELECT count(*)::int
            FROM asset_publication_requests exact_request
           WHERE exact_request.provenance_snapshot->>'importOperationId'=$1::text) AS request_count
         FROM portable_import_normalized_asset_publications mapping
         JOIN asset_publication_requests request ON request.id=mapping.request_id
        WHERE mapping.operation_id=$1`,
      [operationId],
    )).resolves.toMatchObject({
      rows: [{
        publication_state: "published",
        request_lifecycle: "published",
        mapping_count: 1,
        request_count: 1
      }]
    });
  }, 30_000);

  it("reconciles a bound late-duplicate retirement after a cleanup fault and fresh composition", async () => {
    const target = await createWorldScope(`14e3e4 retirement target ${crypto.randomUUID()}`);
    let composition = await composePortable(target, "14e3e4-retirement-a");
    const sourceAssetId = crypto.randomUUID();
    const image = await sharp({
      create: {
        width: 5,
        height: 3,
        channels: 3,
        background: { r: 29, g: 79, b: 129 }
      }
    }).png().toBuffer();
    const bytes = await campaignZip(`retirement-${crypto.randomUUID()}`, {
      sourceAssetId,
      bytes: image
    });
    const staged = await stagedInput(composition, bytes, "14e3e4-retirement");
    const preview = await composition.previewCampaignZip({
      ownerUserId,
      stagedInput: staged,
      kind: "campaign_zip",
      destination: { kind: "embedded", operation: "create_world" }
    });
    const command = {
      ownerUserId,
      kind: "campaign_zip" as const,
      destination: preview.destination,
      previewHandle: preview.previewHandle,
      idempotencyKey: `14e3e4-retirement-${crypto.randomUUID()}`
    };
    const operation = await pool.query<{ authority_fingerprint: string }>(
      `SELECT authority_fingerprint
         FROM portable_import_operations
        WHERE owner_user_id=$1 AND preview_token_hash=$2`,
      [ownerUserId, hash(preview.previewHandle.token)],
    );
    const authorityFingerprint = operation.rows[0]!.authority_fingerprint;
    const gateKey = `task-14e3e4-retirement-gate-${crypto.randomUUID()}`;
    const signalKey = `task-14e3e4-retirement-signal-${crypto.randomUUID()}`;
    const blockerPool = createDatabasePool(databaseUrl!, 2);
    const blocker = await blockerPool.connect();
    await blocker.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [gateKey]);
    await pool.query(`CREATE FUNCTION task_14e3e4_retirement_gate() RETURNS trigger
      LANGUAGE plpgsql AS $gate$
      BEGIN
        PERFORM pg_advisory_lock(hashtextextended('${signalKey}',0));
        PERFORM pg_advisory_xact_lock(hashtextextended('${gateKey}',0));
        PERFORM pg_advisory_unlock(hashtextextended('${signalKey}',0));
        RETURN NEW;
      END;
      $gate$`);
    await pool.query(`CREATE TRIGGER task_14e3e4_retirement_gate_trigger
      BEFORE INSERT ON portable_import_normalized_asset_publications
      FOR EACH ROW EXECUTE FUNCTION task_14e3e4_retirement_gate()`);
    await pool.query(`CREATE FUNCTION task_14e3e4_retirement_fault() RETURNS trigger
      LANGUAGE plpgsql AS $fault$
      BEGIN RAISE EXCEPTION 'task_14e3e4_retirement_fault'; END;
      $fault$`);
    await pool.query(`CREATE TRIGGER task_14e3e4_retirement_fault_trigger
      BEFORE UPDATE ON portable_import_normalized_asset_publications
      FOR EACH ROW WHEN (
        NEW.publication_state='retired' AND OLD.publication_state='retirement_pending'
      ) EXECUTE FUNCTION task_14e3e4_retirement_fault()`);
    let commit: Promise<Awaited<ReturnType<typeof composition.commit>>> | undefined;
    let duplicateImportId = "";
    try {
      commit = composition.commit(command);
      const signalDeadline = Date.now() + 10_000;
      for (;;) {
        const signal = await blockerPool.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
          [signalKey],
        );
        if (!signal.rows[0]?.acquired) break;
        await blockerPool.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [signalKey]);
        if (Date.now() >= signalDeadline) throw new Error("task_14e3e4_retirement_gate_timeout");
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      const campaign = await blockerPool.query<{ id: string }>(
        `INSERT INTO campaigns (owner_user_id,world_version_id,title)
         VALUES ($1,$2,$3) RETURNING id`,
        [ownerUserId, target.worldVersionId, "Previously imported duplicate"],
      );
      const imported = await blockerPool.query<{ id: string }>(
        `INSERT INTO imports (
           owner_user_id,source_type,source_name,source_hash,status,
           world_id,world_version_id,campaign_id,stats,completed_at
         ) VALUES ($1,'portable_campaign_zip','campaign.zip',$2,'completed',$3,$4,$5,$6::jsonb,clock_timestamp())
         RETURNING id`,
        [
          ownerUserId,
          authorityFingerprint,
          target.worldId,
          target.worldVersionId,
          campaign.rows[0]!.id,
          JSON.stringify({
            assetCount: 1,
            assetBytes: image.byteLength,
            turnCount: 0,
            memoryCount: 0,
            summaryCount: 0
          })
        ],
      );
      duplicateImportId = imported.rows[0]!.id;
      await blocker.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [gateKey]);
      await expect(commit).rejects.toThrow("task_14e3e4_retirement_fault");
    } finally {
      await blocker.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [gateKey]).catch(() => undefined);
      blocker.release();
      await blockerPool.end();
      await Promise.allSettled(commit ? [commit] : []);
      await pool.query(
        "DROP TRIGGER IF EXISTS task_14e3e4_retirement_gate_trigger ON portable_import_normalized_asset_publications",
      );
      await pool.query("DROP FUNCTION IF EXISTS task_14e3e4_retirement_gate()");
      await pool.query(
        "DROP TRIGGER IF EXISTS task_14e3e4_retirement_fault_trigger ON portable_import_normalized_asset_publications",
      );
      await pool.query("DROP FUNCTION IF EXISTS task_14e3e4_retirement_fault()");
    }

    await expect(composition.progress(
      { ownerUserId },
      preview.previewHandle.token,
    )).resolves.toMatchObject({ status: "recoverable", phase: "finalizing" });
    const pending = await pool.query<{
      operation_id: string;
      publication_state: string;
      retirement_reason: string;
      request_id: string | null;
      request_lifecycle: string;
      identity_lifecycle: string;
    }>(
      `SELECT mapping.operation_id,mapping.publication_state,mapping.retirement_reason,
              mapping.request_id,request.lifecycle AS request_lifecycle,
              identity.lifecycle AS identity_lifecycle
         FROM portable_import_normalized_asset_publications mapping
         JOIN portable_import_operations operation
           ON operation.id=mapping.operation_id AND operation.owner_user_id=mapping.owner_user_id
         JOIN asset_publication_requests request
           ON request.id=mapping.request_id AND request.owner_user_id=mapping.owner_user_id
         JOIN asset_publication_identities identity
           ON identity.asset_id=request.canonical_asset_id AND identity.owner_user_id=request.owner_user_id
        WHERE operation.preview_token_hash=$1`,
      [hash(preview.previewHandle.token)],
    );
    expect(pending.rows).toEqual([{
      operation_id: expect.stringMatching(UUID_PATTERN_FOR_TEST),
      publication_state: "retirement_pending",
      retirement_reason: "duplicate",
      request_id: expect.stringMatching(UUID_PATTERN_FOR_TEST),
      request_lifecycle: "failed",
      identity_lifecycle: "cleanup_pending"
    }]);

    await composition.close();
    composition = await composePortable(target, "14e3e4-retirement-b");
    const replay = await composition.commit(command);
    expect(replay).toMatchObject({ kind: "campaign_zip", duplicate: true });
    expect(replay.importedRecordId).toEqual(duplicateImportId);
    await expect(composition.progress(
      { ownerUserId },
      preview.previewHandle.token,
    )).resolves.toMatchObject({ status: "completed", phase: "completed" });
    await expect(pool.query(
      `SELECT mapping.publication_state,mapping.retirement_reason,
              mapping.retirement_requested_at IS NOT NULL AS retirement_requested,
              mapping.retired_at IS NOT NULL AS retired,
              request.lifecycle AS request_lifecycle,
              (SELECT count(*)::int
                 FROM portable_import_normalized_asset_sources source
                WHERE source.operation_id=mapping.operation_id
                  AND source.asset_ordinal=mapping.asset_ordinal) AS retained_source_count
         FROM portable_import_normalized_asset_publications mapping
         JOIN portable_import_operations operation
           ON operation.id=mapping.operation_id AND operation.owner_user_id=mapping.owner_user_id
         JOIN asset_publication_requests request
           ON request.id=mapping.request_id AND request.owner_user_id=mapping.owner_user_id
        WHERE operation.preview_token_hash=$1`,
      [hash(preview.previewHandle.token)],
    )).resolves.toMatchObject({ rows: [{
      publication_state: "retired",
      retirement_reason: "duplicate",
      retirement_requested: true,
      retired: true,
      request_lifecycle: "failed",
      retained_source_count: 1
    }] });
    await expect(pool.query(
      `SELECT count(*)::int AS count
         FROM imports imported
        WHERE imported.owner_user_id=$1 AND imported.source_hash=$2`,
      [ownerUserId, authorityFingerprint],
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
  }, 30_000);

  it("publishes exact Legacy image references and applies a companion world cover atomically", async () => {
    const target = await createWorldScope(`14e3e4 legacy target ${crypto.randomUUID()}`);
    let composition = await composePortable(target, "14e3e4-legacy-a");
    const inlineImage = await sharp({
      create: {
        width: 3,
        height: 2,
        channels: 3,
        background: { r: 101, g: 22, b: 33 }
      }
    }).png().toBuffer();
    const companionImage = await sharp({
      create: {
        width: 2,
        height: 3,
        channels: 3,
        background: { r: 9, g: 121, b: 45 }
      }
    }).png().toBuffer();
    const noIdInlineImage = await sharp({
      create: {
        width: 4,
        height: 2,
        channels: 3,
        background: { r: 77, g: 33, b: 144 }
      }
    }).png().toBuffer();
    const coverImage = await sharp({
      create: {
        width: 5,
        height: 2,
        channels: 3,
        background: { r: 18, g: 52, b: 117 }
      }
    }).png().toBuffer();
    const orphanImage = await sharp({
      create: {
        width: 2,
        height: 5,
        channels: 3,
        background: { r: 123, g: 81, b: 19 }
      }
    }).png().toBuffer();
    const sourceCampaignId = crypto.randomUUID();
    const inlineTurnId = crypto.randomUUID();
    const companionTurnId = inlineTurnId;
    const repeatedCompanionTurnId = crypto.randomUUID();
    const coverTurnId = crypto.randomUUID();
    const externalUrl = "https://images.example.test/preserved.png";
    const bytes = new TextEncoder().encode(JSON.stringify({
      campaign: { sourceCampaignId, title: "Normalized Legacy Story" },
      world: { title: "Normalized Legacy Story", coverImageUrl: "covers/world-cover.png" },
      turns: [
        {
          id: inlineTurnId,
          narration: "Inline image",
          imageUrl: `data:image/png;base64,${inlineImage.toString("base64")}`
        },
        {
          id: companionTurnId,
          narration: "Companion image",
          imageUrl: "images/bundled.png"
        },
        {
          id: repeatedCompanionTurnId,
          narration: "Repeated companion image",
          imageUrl: "images/bundled.png"
        },
        {
          id: coverTurnId,
          narration: "World cover reused as a turn image",
          imageUrl: "covers/world-cover.png"
        },
        {
          narration: "Inline image without a source turn id",
          imageUrl: `data:image/png;base64,${noIdInlineImage.toString("base64")}`
        },
        { id: crypto.randomUUID(), narration: "External", imageUrl: externalUrl },
        { id: crypto.randomUUID(), narration: "Unsafe", imageUrl: "javascript:alert(1)" },
        { id: crypto.randomUUID(), narration: "Malformed", imageUrl: "data:image/png;base64,not-valid!" }
      ]
    }));
    const portableAssets = {
      legacyStoryCompanions: [
        {
          sourceKey: "bundled.png",
          artifact: {
            mimeType: "image/png" as const,
            bytes: companionImage,
            byteLength: companionImage.byteLength,
            contentHash: hash(companionImage)
          }
        },
        {
          sourceKey: "world-cover.png",
          artifact: {
            mimeType: "image/png" as const,
            bytes: coverImage,
            byteLength: coverImage.byteLength,
            contentHash: hash(coverImage)
          }
        },
        {
          sourceKey: "orphan.png",
          artifact: {
            mimeType: "image/png" as const,
            bytes: orphanImage,
            byteLength: orphanImage.byteLength,
            contentHash: hash(orphanImage)
          }
        }
      ]
    };
    const staged = await stagedInput(composition, bytes, "14e3e4-legacy");
    const destination = {
      kind: "existing_world_version" as const,
      worldId: target.worldId,
      worldVersionId: target.worldVersionId
    };
    const preview = await composition.previewLegacyStory({
      ownerUserId,
      stagedInput: staged,
      kind: "legacy_story",
      destination
    }, portableAssets);
    const command = {
      ownerUserId,
      kind: "legacy_story" as const,
      destination,
      previewHandle: preview.previewHandle,
      idempotencyKey: `14e3e4-legacy-${crypto.randomUUID()}`
    };

    const committed = await composition.commit(command, portableAssets);
    const legacyResult = committed.result as Readonly<{ campaignId: string }>;
    await composition.close();
    composition = await composePortable(target, "14e3e4-legacy-b");
    await expect(composition.commit(command)).resolves.toEqual(committed);

    const turns = await pool.query<{ source_turn_id: string; image_url: string }>(
      `SELECT source_turn_id,image_url
         FROM turns
        WHERE campaign_id=$1
        ORDER BY turn_number`,
      [legacyResult.campaignId],
    );
    expect(turns.rows.map((turn) => turn.image_url)).toEqual([
      expect.stringMatching(/^\/api\/v1\/assets\/[0-9a-f-]{36}$/u),
      expect.stringMatching(/^\/api\/v1\/assets\/[0-9a-f-]{36}$/u),
      expect.stringMatching(/^\/api\/v1\/assets\/[0-9a-f-]{36}$/u),
      expect.stringMatching(/^\/api\/v1\/assets\/[0-9a-f-]{36}$/u),
      expect.stringMatching(/^\/api\/v1\/assets\/[0-9a-f-]{36}$/u),
      externalUrl,
      "",
      ""
    ]);
    expect(turns.rows.slice(0, 5).map((turn) => turn.source_turn_id))
      .toEqual([inlineTurnId, companionTurnId, repeatedCompanionTurnId, coverTurnId, null]);

    const operationHash = hash(preview.previewHandle.token);
    const normalized = await pool.query<{
      publication_state: string;
      source_key: string | null;
      source_asset_id: string;
      asset_id: string;
      reference_count: number;
      context_count: number;
    }>(
      `SELECT mapping.publication_state,source.source_key,source.source_asset_id,
              mapping.safe_result->>'assetId' AS asset_id,
              (SELECT count(*)::int FROM asset_publication_request_references reference
                WHERE reference.request_id=mapping.request_id) AS reference_count,
              (SELECT count(*)::int FROM asset_publication_request_contexts context
                WHERE context.request_id=mapping.request_id) AS context_count
         FROM portable_import_normalized_asset_publications mapping
         JOIN portable_import_operations operation ON operation.id=mapping.operation_id
         JOIN portable_import_normalized_asset_sources source
           ON source.operation_id=mapping.operation_id
          AND source.asset_ordinal=mapping.asset_ordinal
        WHERE operation.preview_token_hash=$1
        ORDER BY source.source_key NULLS FIRST`,
      [operationHash],
    );
    const normalizedBySource = new Map(normalized.rows.map((row) => [row.source_key, row]));
    const inlineSourceAssetId = stableUuid(`legacy-inline:0:${hash(inlineImage)}`);
    const noIdInlineSourceAssetId = stableUuid(`legacy-inline:4:${hash(noIdInlineImage)}`);
    const normalizedByAsset = new Map(normalized.rows.map((row) => [row.source_asset_id, row]));
    expect(normalizedByAsset.get(inlineSourceAssetId)).toMatchObject({
      publication_state: "published",
      reference_count: 1,
      context_count: 0
    });
    expect(normalizedByAsset.get(noIdInlineSourceAssetId)).toMatchObject({
      publication_state: "published",
      reference_count: 1,
      context_count: 0
    });
    expect(normalizedBySource.get(`source-key-sha256:${hash("bundled.png")}`)).toMatchObject({
      publication_state: "published",
      reference_count: 2,
      context_count: 0
    });
    expect(normalizedBySource.get(`source-key-sha256:${hash("bundled")}`)).toMatchObject({
      publication_state: "published",
      reference_count: 2,
      context_count: 0
    });
    const coverPublication = normalizedBySource.get(
      `source-key-sha256:${hash("world-cover.png")}`,
    );
    expect(coverPublication).toMatchObject({
      publication_state: "published",
      reference_count: 1,
      context_count: 1
    });
    expect(normalizedBySource.get(`source-key-sha256:${hash("orphan.png")}`)).toMatchObject({
      publication_state: "published",
      reference_count: 1,
      context_count: 0
    });
    await expect(pool.query(
      "SELECT cover_asset_id FROM worlds WHERE id=$1 AND owner_user_id=$2",
      [target.worldId, ownerUserId],
    )).resolves.toMatchObject({ rows: [{ cover_asset_id: coverPublication?.asset_id }] });
    expect(JSON.stringify(normalized.rows)).not.toContain("bundled.png");
    expect(JSON.stringify(normalized.rows)).not.toContain("images/");
    expect(JSON.stringify(normalized.rows)).not.toContain("https://");
    await expect(pool.query(
      `SELECT
         (SELECT count(*)::int FROM portable_import_asset_reservation_intents legacy
           JOIN portable_import_operations operation ON operation.id=legacy.operation_id
          WHERE operation.preview_token_hash=$1) AS reservation_count,
         (SELECT count(*)::int FROM portable_import_asset_publications legacy
           JOIN portable_import_operations operation ON operation.id=legacy.operation_id
          WHERE operation.preview_token_hash=$1) AS publication_count`,
      [operationHash],
    )).resolves.toMatchObject({ rows: [{ reservation_count: 0, publication_count: 0 }] });
  }, 30_000);

  it("preserves external Legacy URLs and ignores absolute or traversal companion aliases", async () => {
    const target = await createWorldScope(`14e3e4 external aliases ${crypto.randomUUID()}`);
    const composition = await composePortable(target, "14e3e4-external-aliases");
    const companion = await sharp({
      create: { width: 3, height: 3, channels: 3, background: { r: 22, g: 66, b: 110 } }
    }).png().toBuffer();
    const inline = await sharp({
      create: { width: 2, height: 4, channels: 3, background: { r: 130, g: 70, b: 10 } }
    }).png().toBuffer();
    const skipped = await sharp({
      create: { width: 1, height: 2, channels: 3, background: { r: 200, g: 10, b: 10 } }
    }).png().toBuffer();
    const orphan = await sharp({
      create: { width: 2, height: 1, channels: 3, background: { r: 10, g: 120, b: 210 } }
    }).png().toBuffer();
    const externalUrl = "https://cdn.example.test/cover.png";
    const values = [
      "folder/cover.png",
      `  ${externalUrl}  `,
      "file:///private/cover.png",
      "/tmp/private/cover.png",
      "../private/cover.png",
      "javascript:cover.png",
      `data:image/png;base64,${inline.toString("base64")}`
    ];
    const bytes = new TextEncoder().encode(JSON.stringify({
      campaign: { title: "Safe aliases" },
      world: { title: "Safe aliases", coverImageUrl: externalUrl },
      turns: values.map((imageUrl, index) => ({
        id: `legacy-source-turn-${index}`,
        narration: `Turn ${index + 1}`,
        imageUrl
      }))
    }));
    const artifacts = {
      legacyStoryCompanions: [{
        sourceKey: "cover.png",
        artifact: {
          mimeType: "image/png" as const,
          bytes: companion,
          byteLength: companion.byteLength,
          contentHash: hash(companion)
        }
      }, {
        sourceKey: "https://attacker.example/absolute.png",
        artifact: {
          mimeType: "image/png" as const,
          bytes: skipped,
          byteLength: skipped.byteLength,
          contentHash: hash(skipped)
        }
      }, {
        sourceKey: "orphan.png",
        artifact: {
          mimeType: "image/png" as const,
          bytes: orphan,
          byteLength: orphan.byteLength,
          contentHash: hash(orphan)
        }
      }]
    };
    const staged = await stagedInput(composition, bytes, "14e3e4-external-aliases");
    const destination = {
      kind: "existing_world_version" as const,
      worldId: target.worldId,
      worldVersionId: target.worldVersionId
    };
    const preview = await composition.previewLegacyStory({
      ownerUserId,
      stagedInput: staged,
      kind: "legacy_story",
      destination
    }, artifacts);
    const committed = await composition.commit({
      ownerUserId,
      kind: "legacy_story",
      destination,
      previewHandle: preview.previewHandle,
      idempotencyKey: `14e3e4-external-aliases-${crypto.randomUUID()}`
    }, artifacts);
    const campaignId = (committed.result as Readonly<{ campaignId: string }>).campaignId;
    const turns = await pool.query<{ source_turn_id: string; image_url: string }>(
      "SELECT source_turn_id,image_url FROM turns WHERE campaign_id=$1 ORDER BY turn_number",
      [campaignId],
    );
    expect(turns.rows.map((turn) => turn.source_turn_id)).toEqual(
      values.map((_value, index) => `legacy-source-turn-${index}`),
    );
    expect(turns.rows.map((turn) => turn.image_url)).toEqual([
      expect.stringMatching(/^\/api\/v1\/assets\/[0-9a-f-]{36}$/u),
      externalUrl,
      "",
      "",
      "",
      "",
      expect.stringMatching(/^\/api\/v1\/assets\/[0-9a-f-]{36}$/u)
    ]);
    await expect(pool.query(
      "SELECT cover_asset_id FROM worlds WHERE id=$1 AND owner_user_id=$2",
      [target.worldId, ownerUserId],
    )).resolves.toMatchObject({ rows: [{ cover_asset_id: null }] });
    await expect(pool.query(
      `SELECT
         (SELECT count(*)::int FROM portable_import_normalized_asset_publications mapping
           JOIN portable_import_operations operation ON operation.id=mapping.operation_id
          WHERE operation.preview_token_hash=$1) AS mapping_count,
         (SELECT count(*)::int FROM asset_publication_request_references reference
           JOIN portable_import_normalized_asset_publications mapping ON mapping.request_id=reference.request_id
           JOIN portable_import_operations operation ON operation.id=mapping.operation_id
          WHERE operation.preview_token_hash=$1) AS reference_count,
         (SELECT count(*)::int FROM asset_publication_request_references reference
           JOIN portable_import_normalized_asset_publications mapping ON mapping.request_id=reference.request_id
           JOIN portable_import_operations operation ON operation.id=mapping.operation_id
          WHERE operation.preview_token_hash=$1
            AND reference.reference_snapshot->>'sourceTurnId' IS NOT NULL) AS raw_source_turn_count,
         (SELECT count(*)::int FROM asset_publication_request_references reference
           JOIN portable_import_normalized_asset_publications mapping ON mapping.request_id=reference.request_id
           JOIN portable_import_operations operation ON operation.id=mapping.operation_id
           JOIN portable_import_normalized_asset_sources source
             ON source.operation_id=mapping.operation_id
            AND source.asset_ordinal=mapping.asset_ordinal
          WHERE operation.preview_token_hash=$1
            AND source.source_key=$2
            AND reference.reference_snapshot->>'assetRole'='import_attachment'
            AND reference.reference_snapshot->>'sourceCampaignId' IS NULL) AS placeholder_source_count`,
      [hash(preview.previewHandle.token), `source-key-sha256:${hash("orphan.png")}`],
    )).resolves.toMatchObject({ rows: [{
      mapping_count: 3,
      reference_count: 3,
      raw_source_turn_count: 0,
      placeholder_source_count: 1
    }] });
  }, 30_000);

  it("commits Legacy narration image-free when normalized request reservation is unavailable", async () => {
    const target = await createWorldScope(`14e3e4 optional-reserve target ${crypto.randomUUID()}`);
    const composition = await composePortable(target, "14e3e4-optional-reserve");
    const image = await sharp({
      create: {
        width: 3,
        height: 3,
        channels: 3,
        background: { r: 23, g: 67, b: 109 }
      }
    }).png().toBuffer();
    const sourceTurnId = "legacy-turn-non-uuid";
    const bytes = new TextEncoder().encode(JSON.stringify({
      campaign: { title: "Optional reservation" },
      world: { title: "Optional reservation" },
      turns: [{
        id: sourceTurnId,
        narration: "The story survives unavailable image storage.",
        imageUrl: `data:image/png;base64,${image.toString("base64")}`
      }]
    }));
    const staged = await stagedInput(composition, bytes, "14e3e4-optional-reserve");
    const destination = {
      kind: "existing_world_version" as const,
      worldId: target.worldId,
      worldVersionId: target.worldVersionId
    };
    const preview = await composition.previewLegacyStory({
      ownerUserId,
      stagedInput: staged,
      kind: "legacy_story",
      destination
    });
    await pool.query(`CREATE FUNCTION task_14e3e4_optional_reserve_fault() RETURNS trigger
      LANGUAGE plpgsql AS $fault$
      BEGIN RAISE EXCEPTION 'task_14e3e4_optional_reserve_fault'; END;
      $fault$`);
    await pool.query(`CREATE TRIGGER task_14e3e4_optional_reserve_fault_trigger
      BEFORE INSERT ON asset_publication_requests
      FOR EACH ROW EXECUTE FUNCTION task_14e3e4_optional_reserve_fault()`);
    let committed: Awaited<ReturnType<typeof composition.commit>> | undefined;
    try {
      committed = await composition.commit({
        ownerUserId,
        kind: "legacy_story",
        destination,
        previewHandle: preview.previewHandle,
        idempotencyKey: `14e3e4-optional-reserve-${crypto.randomUUID()}`
      });
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS task_14e3e4_optional_reserve_fault_trigger ON asset_publication_requests",
      );
      await pool.query("DROP FUNCTION IF EXISTS task_14e3e4_optional_reserve_fault()");
    }
    expect(committed).toMatchObject({ duplicate: false });
    const campaignId = (committed!.result as Readonly<{ campaignId: string }>).campaignId;
    await expect(pool.query(
      "SELECT source_turn_id,image_url FROM turns WHERE campaign_id=$1",
      [campaignId],
    )).resolves.toMatchObject({ rows: [{ source_turn_id: sourceTurnId, image_url: "" }] });
    await expect(pool.query(
      `SELECT operation.status AS operation_status,imported.status AS import_status,
              mapping.publication_state,mapping.retirement_reason,mapping.request_id,
              (SELECT count(*)::int FROM asset_references reference
                WHERE reference.campaign_id=imported.campaign_id) AS reference_count
         FROM portable_import_operations operation
         JOIN imports imported
           ON imported.id=operation.import_id AND imported.owner_user_id=operation.owner_user_id
         JOIN portable_import_normalized_asset_publications mapping
           ON mapping.operation_id=operation.id AND mapping.owner_user_id=operation.owner_user_id
        WHERE operation.preview_token_hash=$1`,
      [hash(preview.previewHandle.token)],
    )).resolves.toMatchObject({ rows: [{
      operation_status: "committed",
      import_status: "completed",
      publication_state: "retired",
      retirement_reason: "optional_unavailable",
      request_id: null,
      reference_count: 0
    }] });
  }, 30_000);

  it("retires a prior Legacy prewrite when fresh normalization is unavailable", async () => {
    const target = await createWorldScope(`14e3e4 prior prewrite ${crypto.randomUUID()}`);
    let composition = await composePortable(target, "14e3e4-prior-prewrite-a");
    const decodable = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 73, g: 113, b: 153 } }
    }).png().toBuffer();
    const truncated = decodable.subarray(0, 78);
    await expect(sharp(truncated, { animated: true }).metadata()).resolves.toMatchObject({
      format: "png",
      width: 10,
      height: 10
    });
    const sourceTurnId = crypto.randomUUID();
    const bytes = new TextEncoder().encode(JSON.stringify({
      campaign: { title: "Prior Legacy prewrite" },
      world: { title: "Prior Legacy prewrite" },
      turns: [{
        id: sourceTurnId,
        narration: "The story survives when a previously accepted image cannot be decoded again.",
        imageUrl: "images/truncated.png"
      }]
    }));
    const artifacts = {
      legacyStoryCompanions: [{
        sourceKey: "truncated.png",
        artifact: {
          mimeType: "image/png" as const,
          bytes: truncated,
          byteLength: truncated.byteLength,
          contentHash: hash(truncated)
        }
      }]
    };
    const staged = await stagedInput(composition, bytes, "14e3e4-prior-prewrite");
    const destination = {
      kind: "existing_world_version" as const,
      worldId: target.worldId,
      worldVersionId: target.worldVersionId
    };
    const preview = await composition.previewLegacyStory({
      ownerUserId,
      stagedInput: staged,
      kind: "legacy_story",
      destination
    }, artifacts);
    const command = {
      ownerUserId,
      kind: "legacy_story" as const,
      destination,
      previewHandle: preview.previewHandle,
      idempotencyKey: `14e3e4-prior-prewrite-${crypto.randomUUID()}`
    };
    const operation = await pool.query<{ id: string; authority_fingerprint: string }>(
      `SELECT id,authority_fingerprint
         FROM portable_import_operations
        WHERE owner_user_id=$1 AND preview_token_hash=$2`,
      [ownerUserId, hash(preview.previewHandle.token)],
    );
    const scope: PrivatePortableNormalizedPublicationScope = Object.freeze({
      operationId: operation.rows[0]!.id,
      ownerUserId,
      importKind: "legacy_story",
      authorityFingerprint: operation.rows[0]!.authority_fingerprint,
      commitIdempotencyKeyHash: hash(command.idempotencyKey)
    });
    const prior = await normalizedImportRequest(scope, "14e3e4-prior-prewrite-authority");
    const publicationRepository = createPostgresPortableNormalizedAssetPublicationRepository(pool);
    await publicationRepository.recordReservationIntents(scope, [{ request: prior.request }]);
    await expect(pool.query(
      `SELECT mapping.publication_state,mapping.request_id,
              (SELECT count(*)::int FROM portable_import_normalized_asset_sources source
                WHERE source.operation_id=mapping.operation_id
                  AND source.asset_ordinal=mapping.asset_ordinal) AS source_count
         FROM portable_import_normalized_asset_publications mapping
        WHERE mapping.operation_id=$1 AND mapping.owner_user_id=$2`,
      [scope.operationId, ownerUserId],
    )).resolves.toMatchObject({ rows: [{
      publication_state: "reservation_intent",
      request_id: null,
      source_count: 1
    }] });

    await composition.close();
    composition = await composePortable(target, "14e3e4-prior-prewrite-b");
    const committed = await composition.commit(command, artifacts);
    expect(committed).toMatchObject({ kind: "legacy_story", duplicate: false });
    const campaignId = (committed.result as Readonly<{ campaignId: string }>).campaignId;
    await expect(pool.query(
      "SELECT source_turn_id,image_url FROM turns WHERE campaign_id=$1",
      [campaignId],
    )).resolves.toMatchObject({ rows: [{ source_turn_id: sourceTurnId, image_url: "" }] });
    await expect(pool.query(
      `SELECT operation.status AS operation_status,work.status AS work_status,
              mapping.publication_state,mapping.retirement_reason,mapping.request_id,
              (SELECT count(*)::int FROM asset_publication_requests request
                WHERE request.provenance_snapshot->>'importOperationId'=operation.id::text) AS request_count,
              (SELECT count(*)::int FROM asset_references reference
                WHERE reference.campaign_id=imported.campaign_id) AS reference_count
         FROM portable_import_operations operation
         JOIN portable_import_work work
           ON work.operation_id=operation.id AND work.owner_user_id=operation.owner_user_id
         JOIN imports imported
           ON imported.id=operation.import_id AND imported.owner_user_id=operation.owner_user_id
         JOIN portable_import_normalized_asset_publications mapping
           ON mapping.operation_id=operation.id AND mapping.owner_user_id=operation.owner_user_id
        WHERE operation.id=$1 AND operation.owner_user_id=$2`,
      [scope.operationId, ownerUserId],
    )).resolves.toMatchObject({ rows: [{
      operation_status: "committed",
      work_status: "completed",
      publication_state: "retired",
      retirement_reason: "optional_unavailable",
      request_id: null,
      request_count: 0,
      reference_count: 0
    }] });
  }, 30_000);

  it("keeps optional omission terminal evidence when Legacy reservation faults before a late duplicate", async () => {
    const target = await createWorldScope(`14e3e4 optional duplicate ${crypto.randomUUID()}`);
    const composition = await composePortable(target, "14e3e4-optional-duplicate");
    const image = await sharp({
      create: { width: 4, height: 2, channels: 3, background: { r: 55, g: 105, b: 155 } }
    }).png().toBuffer();
    const bytes = new TextEncoder().encode(JSON.stringify({
      campaign: { title: "Optional late duplicate" },
      world: { title: "Optional late duplicate" },
      turns: [{
        id: "optional-late-duplicate-turn",
        narration: "Existing story authority wins after optional image omission.",
        imageUrl: `data:image/png;base64,${image.toString("base64")}`
      }]
    }));
    const invalidCompanions = {
      legacyStoryCompanions: [{
        sourceKey: "unused-companion.png",
        artifact: {
          mimeType: "image/png" as const,
          bytes: image,
          byteLength: image.byteLength,
          contentHash: "0".repeat(64)
        }
      }]
    };
    const staged = await stagedInput(composition, bytes, "14e3e4-optional-duplicate");
    const destination = {
      kind: "existing_world_version" as const,
      worldId: target.worldId,
      worldVersionId: target.worldVersionId
    };
    const preview = await composition.previewLegacyStory({
      ownerUserId,
      stagedInput: staged,
      kind: "legacy_story",
      destination
    }, invalidCompanions);
    const operation = await pool.query<{ authority_fingerprint: string }>(
      `SELECT authority_fingerprint
         FROM portable_import_operations
        WHERE owner_user_id=$1 AND preview_token_hash=$2`,
      [ownerUserId, hash(preview.previewHandle.token)],
    );
    const authorityFingerprint = operation.rows[0]!.authority_fingerprint;
    const gateKey = `task-14e3e4-optional-duplicate-gate-${crypto.randomUUID()}`;
    const signalKey = `task-14e3e4-optional-duplicate-signal-${crypto.randomUUID()}`;
    const duplicatePool = createDatabasePool(databaseUrl!, 2);
    const blocker = await duplicatePool.connect();
    await blocker.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [gateKey]);
    await pool.query(`CREATE FUNCTION task_14e3e4_optional_duplicate_reserve_fault() RETURNS trigger
      LANGUAGE plpgsql AS $fault$
      BEGIN
        PERFORM pg_advisory_lock(hashtextextended('${signalKey}',0));
        PERFORM pg_advisory_xact_lock(hashtextextended('${gateKey}',0));
        PERFORM pg_advisory_unlock(hashtextextended('${signalKey}',0));
        RAISE EXCEPTION 'task_14e3e4_optional_duplicate_reserve_fault';
      END;
      $fault$`);
    await pool.query(`CREATE TRIGGER task_14e3e4_optional_duplicate_reserve_fault_trigger
      BEFORE INSERT ON asset_publication_requests
      FOR EACH ROW EXECUTE FUNCTION task_14e3e4_optional_duplicate_reserve_fault()`);
    let committed: Awaited<ReturnType<typeof composition.commit>> | undefined;
    let commit: Promise<Awaited<ReturnType<typeof composition.commit>>> | undefined;
    let existingImportId = "";
    try {
      commit = composition.commit({
        ownerUserId,
        kind: "legacy_story",
        destination,
        previewHandle: preview.previewHandle,
        idempotencyKey: `14e3e4-optional-duplicate-${crypto.randomUUID()}`
      }, invalidCompanions);
      const signalDeadline = Date.now() + 10_000;
      for (;;) {
        const signal = await duplicatePool.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
          [signalKey],
        );
        if (!signal.rows[0]?.acquired) break;
        await duplicatePool.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [signalKey]);
        if (Date.now() >= signalDeadline) throw new Error("task_14e3e4_optional_duplicate_gate_timeout");
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      const existingCampaign = await blocker.query<{ id: string }>(
        `INSERT INTO campaigns (owner_user_id,world_version_id,title)
         VALUES ($1,$2,'Existing optional duplicate') RETURNING id`,
        [ownerUserId, target.worldVersionId],
      );
      const existingImport = await blocker.query<{ id: string }>(
        `INSERT INTO imports (
           owner_user_id,source_type,source_name,source_hash,status,
           world_id,world_version_id,campaign_id,stats,completed_at
         ) VALUES ($1,'portable_legacy_story','legacy.json',$2,'completed',$3,$4,$5,$6::jsonb,clock_timestamp())
         RETURNING id`,
        [
          ownerUserId,
          authorityFingerprint,
          target.worldId,
          target.worldVersionId,
          existingCampaign.rows[0]!.id,
          JSON.stringify({
            turnCount: 1,
            memoryCount: 0,
            completeHistoryCharacters: 0,
            estimatedHistoryTokens: 0,
            importedSummary: false,
            sanitizedMemoryCount: 0
          })
        ],
      );
      existingImportId = existingImport.rows[0]!.id;
      await blocker.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [gateKey]);
      committed = await commit;
    } finally {
      await blocker.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [gateKey]).catch(() => undefined);
      blocker.release();
      await duplicatePool.end();
      await Promise.allSettled(commit ? [commit] : []);
      await pool.query(
        "DROP TRIGGER IF EXISTS task_14e3e4_optional_duplicate_reserve_fault_trigger ON asset_publication_requests",
      );
      await pool.query("DROP FUNCTION IF EXISTS task_14e3e4_optional_duplicate_reserve_fault()");
    }
    expect(committed).toMatchObject({
      kind: "legacy_story",
      duplicate: true,
      importedRecordId: existingImportId
    });
    await expect(pool.query(
      `SELECT operation.status AS operation_status,work.status AS work_status,
              mapping.publication_state,mapping.retirement_reason,mapping.request_id,
              (SELECT count(*)::int FROM asset_publication_requests request
                WHERE request.provenance_snapshot->>'importOperationId'=operation.id::text) AS request_count
         FROM portable_import_operations operation
         JOIN portable_import_work work
           ON work.operation_id=operation.id AND work.owner_user_id=operation.owner_user_id
         JOIN portable_import_normalized_asset_publications mapping
           ON mapping.operation_id=operation.id AND mapping.owner_user_id=operation.owner_user_id
        WHERE operation.preview_token_hash=$1`,
      [hash(preview.previewHandle.token)],
    )).resolves.toMatchObject({ rows: [{
      operation_status: "committed",
      work_status: "completed",
      publication_state: "retired",
      retirement_reason: "optional_unavailable",
      request_id: null,
      request_count: 0
    }] });
  }, 30_000);

  it("keeps a committed Legacy late duplicate non-fatal across retirement fault and fresh replay", async () => {
    const target = await createWorldScope(`14e3e4 legacy retirement ${crypto.randomUUID()}`);
    let composition = await composePortable(target, "14e3e4-legacy-retirement-a");
    const image = await sharp({
      create: { width: 5, height: 3, channels: 3, background: { r: 41, g: 91, b: 141 } }
    }).png().toBuffer();
    const sourceTurnId = crypto.randomUUID();
    const bytes = new TextEncoder().encode(JSON.stringify({
      campaign: { title: "Legacy retirement duplicate" },
      world: { title: "Legacy retirement duplicate" },
      turns: [{
        id: sourceTurnId,
        narration: "Story authority remains accepted when optional image cleanup needs recovery.",
        imageUrl: `data:image/png;base64,${image.toString("base64")}`
      }]
    }));
    const staged = await stagedInput(composition, bytes, "14e3e4-legacy-retirement");
    const destination = {
      kind: "existing_world_version" as const,
      worldId: target.worldId,
      worldVersionId: target.worldVersionId
    };
    const preview = await composition.previewLegacyStory({
      ownerUserId,
      stagedInput: staged,
      kind: "legacy_story",
      destination
    });
    const command = {
      ownerUserId,
      kind: "legacy_story" as const,
      destination,
      previewHandle: preview.previewHandle,
      idempotencyKey: `14e3e4-legacy-retirement-${crypto.randomUUID()}`
    };
    const operation = await pool.query<{ authority_fingerprint: string }>(
      `SELECT authority_fingerprint
         FROM portable_import_operations
        WHERE owner_user_id=$1 AND preview_token_hash=$2`,
      [ownerUserId, hash(preview.previewHandle.token)],
    );
    const authorityFingerprint = operation.rows[0]!.authority_fingerprint;
    const gateKey = `task-14e3e4-legacy-retirement-gate-${crypto.randomUUID()}`;
    const signalKey = `task-14e3e4-legacy-retirement-signal-${crypto.randomUUID()}`;
    const duplicatePool = createDatabasePool(databaseUrl!, 2);
    const blocker = await duplicatePool.connect();
    await blocker.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [gateKey]);
    await pool.query(`CREATE FUNCTION task_14e3e4_legacy_retirement_gate() RETURNS trigger
      LANGUAGE plpgsql AS $gate$
      BEGIN
        PERFORM pg_advisory_lock(hashtextextended('${signalKey}',0));
        PERFORM pg_advisory_xact_lock(hashtextextended('${gateKey}',0));
        PERFORM pg_advisory_unlock(hashtextextended('${signalKey}',0));
        RETURN NEW;
      END;
      $gate$`);
    await pool.query(`CREATE TRIGGER task_14e3e4_legacy_retirement_gate_trigger
      BEFORE INSERT ON portable_import_normalized_asset_publications
      FOR EACH ROW EXECUTE FUNCTION task_14e3e4_legacy_retirement_gate()`);
    await pool.query(`CREATE FUNCTION task_14e3e4_legacy_retirement_fault() RETURNS trigger
      LANGUAGE plpgsql AS $fault$
      BEGIN RAISE EXCEPTION 'task_14e3e4_legacy_retirement_fault'; END;
      $fault$`);
    await pool.query(`CREATE TRIGGER task_14e3e4_legacy_retirement_fault_trigger
      BEFORE UPDATE ON portable_import_normalized_asset_publications
      FOR EACH ROW WHEN (
        NEW.publication_state='retired' AND OLD.publication_state='retirement_pending'
      ) EXECUTE FUNCTION task_14e3e4_legacy_retirement_fault()`);
    let commit: Promise<Awaited<ReturnType<typeof composition.commit>>> | undefined;
    let committed: Awaited<ReturnType<typeof composition.commit>> | undefined;
    let duplicateImportId = "";
    try {
      commit = composition.commit(command);
      const signalDeadline = Date.now() + 10_000;
      for (;;) {
        const signal = await duplicatePool.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
          [signalKey],
        );
        if (!signal.rows[0]?.acquired) break;
        await duplicatePool.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [signalKey]);
        if (Date.now() >= signalDeadline) throw new Error("task_14e3e4_legacy_retirement_gate_timeout");
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      const existingCampaign = await blocker.query<{ id: string }>(
        `INSERT INTO campaigns (owner_user_id,world_version_id,title)
         VALUES ($1,$2,'Existing Legacy retirement duplicate') RETURNING id`,
        [ownerUserId, target.worldVersionId],
      );
      const existingImport = await blocker.query<{ id: string }>(
        `INSERT INTO imports (
           owner_user_id,source_type,source_name,source_hash,status,
           world_id,world_version_id,campaign_id,stats,completed_at
         ) VALUES ($1,'portable_legacy_story','legacy.json',$2,'completed',$3,$4,$5,$6::jsonb,clock_timestamp())
         RETURNING id`,
        [
          ownerUserId,
          authorityFingerprint,
          target.worldId,
          target.worldVersionId,
          existingCampaign.rows[0]!.id,
          JSON.stringify({
            turnCount: 1,
            memoryCount: 0,
            completeHistoryCharacters: 0,
            estimatedHistoryTokens: 0,
            importedSummary: false,
            sanitizedMemoryCount: 0
          })
        ],
      );
      duplicateImportId = existingImport.rows[0]!.id;
      await blocker.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [gateKey]);
      committed = await commit;
    } finally {
      await blocker.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [gateKey]).catch(() => undefined);
      blocker.release();
      await duplicatePool.end();
      await Promise.allSettled(commit ? [commit] : []);
      await pool.query(
        "DROP TRIGGER IF EXISTS task_14e3e4_legacy_retirement_gate_trigger ON portable_import_normalized_asset_publications",
      );
      await pool.query("DROP FUNCTION IF EXISTS task_14e3e4_legacy_retirement_gate()");
      await pool.query(
        "DROP TRIGGER IF EXISTS task_14e3e4_legacy_retirement_fault_trigger ON portable_import_normalized_asset_publications",
      );
      await pool.query("DROP FUNCTION IF EXISTS task_14e3e4_legacy_retirement_fault()");
    }

    expect(committed).toMatchObject({
      kind: "legacy_story",
      duplicate: true,
      importedRecordId: duplicateImportId
    });
    await expect(composition.progress(
      { ownerUserId },
      preview.previewHandle.token,
    )).resolves.toMatchObject({ status: "completed", phase: "completed" });
    await expect(pool.query(
      `SELECT operation.status AS operation_status,work.status AS work_status,
              mapping.publication_state,mapping.retirement_reason,
              request.lifecycle AS request_lifecycle,identity.lifecycle AS identity_lifecycle
         FROM portable_import_operations operation
         JOIN portable_import_work work
           ON work.operation_id=operation.id AND work.owner_user_id=operation.owner_user_id
         JOIN portable_import_normalized_asset_publications mapping
           ON mapping.operation_id=operation.id AND mapping.owner_user_id=operation.owner_user_id
         JOIN asset_publication_requests request
           ON request.id=mapping.request_id AND request.owner_user_id=mapping.owner_user_id
         JOIN asset_publication_identities identity
           ON identity.asset_id=request.canonical_asset_id AND identity.owner_user_id=request.owner_user_id
        WHERE operation.preview_token_hash=$1`,
      [hash(preview.previewHandle.token)],
    )).resolves.toMatchObject({ rows: [{
      operation_status: "committed",
      work_status: "completed",
      publication_state: "retirement_pending",
      retirement_reason: "duplicate",
      request_lifecycle: "failed",
      identity_lifecycle: "cleanup_pending"
    }] });

    await composition.close();
    composition = await composePortable(target, "14e3e4-legacy-retirement-b");
    await expect(composition.commit(command)).resolves.toEqual(committed);
    await expect(pool.query(
      `SELECT mapping.publication_state,mapping.retirement_reason,
              mapping.retirement_requested_at IS NOT NULL AS retirement_requested,
              mapping.retired_at IS NOT NULL AS retired,
              request.lifecycle AS request_lifecycle
         FROM portable_import_normalized_asset_publications mapping
         JOIN portable_import_operations operation
           ON operation.id=mapping.operation_id AND operation.owner_user_id=mapping.owner_user_id
         JOIN asset_publication_requests request
           ON request.id=mapping.request_id AND request.owner_user_id=mapping.owner_user_id
        WHERE operation.preview_token_hash=$1`,
      [hash(preview.previewHandle.token)],
    )).resolves.toMatchObject({ rows: [{
      publication_state: "retired",
      retirement_reason: "duplicate",
      retirement_requested: true,
      retired: true,
      request_lifecycle: "failed"
    }] });
  }, 30_000);

  it("omits oversized and undecodable optional Legacy images without failing story authority", async () => {
    const target = await createWorldScope(`14e3e4 optional-image target ${crypto.randomUUID()}`);
    const composition = await composePortable(target, "14e3e4-optional-images");
    const oversized = await sharp({
      create: {
        width: 6_400,
        height: 6_400,
        channels: 3,
        background: { r: 17, g: 37, b: 57 }
      }
    }).png({ compressionLevel: 9 }).toBuffer();
    const decodable = await sharp({
      create: {
        width: 10,
        height: 10,
        channels: 3,
        background: { r: 71, g: 91, b: 111 }
      }
    }).png().toBuffer();
    const truncated = decodable.subarray(0, 78);
    await expect(sharp(truncated, { animated: true }).metadata()).resolves.toMatchObject({
      format: "png",
      width: 10,
      height: 10
    });
    const inlineTurnId = crypto.randomUUID();
    const companionTurnId = crypto.randomUUID();
    const bytes = new TextEncoder().encode(JSON.stringify({
      campaign: { title: "Optional images remain optional" },
      world: { title: "Optional images remain optional" },
      turns: [
        {
          id: inlineTurnId,
          narration: "The oversized illustration is omitted.",
          imageUrl: `data:image/png;base64,${oversized.toString("base64")}`
        },
        {
          id: companionTurnId,
          narration: "The undecodable companion is omitted.",
          imageUrl: "images/truncated.png"
        }
      ]
    }));
    const artifacts = {
      legacyStoryCompanions: Array.from({ length: 257 }, (_unused, index) => ({
        sourceKey: index === 1 ? "" : index === 0 ? "truncated.png" : `ignored-${index}.png`,
        artifact: {
          mimeType: "image/png" as const,
          bytes: truncated,
          byteLength: truncated.byteLength,
          contentHash: index === 2 ? "0".repeat(64) : hash(truncated)
        }
      }))
    };
    const staged = await stagedInput(composition, bytes, "14e3e4-optional-images");
    const destination = {
      kind: "existing_world_version" as const,
      worldId: target.worldId,
      worldVersionId: target.worldVersionId
    };
    const preview = await composition.previewLegacyStory({
      ownerUserId,
      stagedInput: staged,
      kind: "legacy_story",
      destination
    }, artifacts);

    const committed = await composition.commit({
      ownerUserId,
      kind: "legacy_story",
      destination,
      previewHandle: preview.previewHandle,
      idempotencyKey: `14e3e4-optional-images-${crypto.randomUUID()}`
    }, artifacts);
    const campaignId = (committed.result as Readonly<{ campaignId: string }>).campaignId;
    await expect(pool.query(
      "SELECT source_turn_id,image_url FROM turns WHERE campaign_id=$1 ORDER BY turn_number",
      [campaignId],
    )).resolves.toMatchObject({ rows: [
      { source_turn_id: inlineTurnId, image_url: "" },
      { source_turn_id: companionTurnId, image_url: "" }
    ] });
    await expect(pool.query(
      `SELECT count(*)::int AS count
         FROM portable_import_normalized_asset_publications mapping
         JOIN portable_import_operations operation ON operation.id=mapping.operation_id
        WHERE operation.preview_token_hash=$1`,
      [hash(preview.previewHandle.token)],
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  }, 30_000);

  it("enforces aggregate image pixels strictly for Campaign ZIP and optionally for Legacy story", async () => {
    const target = await createWorldScope(`14e3e4 aggregate pixels ${crypto.randomUUID()}`);
    const composition = await composePortable(target, "14e3e4-aggregate-pixels");
    const firstImage = await sharp({
      create: { width: 4_500, height: 4_500, channels: 3, background: { r: 13, g: 53, b: 93 } }
    }).png({ compressionLevel: 9 }).toBuffer();
    const secondImage = await sharp({
      create: { width: 4_500, height: 4_500, channels: 3, background: { r: 113, g: 153, b: 193 } }
    }).png({ compressionLevel: 9 }).toBuffer();
    const campaignBytes = await campaignZip(`aggregate-pixels-${crypto.randomUUID()}`, [
      { sourceAssetId: crypto.randomUUID(), bytes: firstImage },
      { sourceAssetId: crypto.randomUUID(), bytes: secondImage }
    ]);
    const campaignStaged = await stagedInput(
      composition,
      campaignBytes,
      "14e3e4-aggregate-pixels-campaign",
    );
    const beforeCampaign = await pool.query<{ request_count: number; mapping_count: number }>(
      `SELECT
         (SELECT count(*)::int FROM asset_publication_requests) AS request_count,
         (SELECT count(*)::int FROM portable_import_normalized_asset_publications) AS mapping_count`,
    );
    await expect(composition.previewCampaignZip({
      ownerUserId,
      stagedInput: campaignStaged,
      kind: "campaign_zip",
      destination: { kind: "embedded", operation: "create_world" }
    })).rejects.toThrow("archive_size_limit_exceeded");
    await expect(pool.query(
      `SELECT
         (SELECT count(*)::int FROM asset_publication_requests) AS request_count,
         (SELECT count(*)::int FROM portable_import_normalized_asset_publications) AS mapping_count`,
    )).resolves.toEqual(beforeCampaign);

    const legacyBytes = new TextEncoder().encode(JSON.stringify({
      campaign: { title: "Aggregate pixels remain optional" },
      world: { title: "Aggregate pixels remain optional" },
      turns: [firstImage, secondImage].map((image, index) => ({
        id: `aggregate-pixels-turn-${index + 1}`,
        narration: `Narration ${index + 1} survives aggregate image omission.`,
        imageUrl: `data:image/png;base64,${image.toString("base64")}`
      }))
    }));
    const legacyStaged = await stagedInput(
      composition,
      legacyBytes,
      "14e3e4-aggregate-pixels-legacy",
    );
    const destination = {
      kind: "existing_world_version" as const,
      worldId: target.worldId,
      worldVersionId: target.worldVersionId
    };
    const legacyPreview = await composition.previewLegacyStory({
      ownerUserId,
      stagedInput: legacyStaged,
      kind: "legacy_story",
      destination
    });
    const legacyCommitted = await composition.commit({
      ownerUserId,
      kind: "legacy_story",
      destination,
      previewHandle: legacyPreview.previewHandle,
      idempotencyKey: `14e3e4-aggregate-pixels-legacy-${crypto.randomUUID()}`
    });
    const campaignId = (legacyCommitted.result as Readonly<{ campaignId: string }>).campaignId;
    await expect(pool.query(
      "SELECT image_url FROM turns WHERE campaign_id=$1 ORDER BY turn_number",
      [campaignId],
    )).resolves.toMatchObject({ rows: [{ image_url: "" }, { image_url: "" }] });
    await expect(pool.query(
      `SELECT operation.import_kind,
              (SELECT count(*)::int FROM asset_publication_requests request
                WHERE request.provenance_snapshot->>'importOperationId'=operation.id::text) AS request_count,
              (SELECT count(*)::int FROM portable_import_normalized_asset_publications mapping
                WHERE mapping.operation_id=operation.id) AS mapping_count
         FROM portable_import_operations operation
        WHERE operation.preview_token_hash=$1
        ORDER BY operation.import_kind`,
      [hash(legacyPreview.previewHandle.token)],
    )).resolves.toMatchObject({ rows: [
      { import_kind: "legacy_story", request_count: 0, mapping_count: 0 }
    ] });
  }, 60_000);

  it("omits excessive repeated Legacy inline images before normalization", async () => {
    const target = await createWorldScope(`14e3e4 excessive-inline target ${crypto.randomUUID()}`);
    const composition = await composePortable(target, "14e3e4-excessive-inline");
    const image = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 3,
        background: { r: 12, g: 34, b: 56 }
      }
    }).png().toBuffer();
    const imageUrl = `data:image/png;base64,${image.toString("base64")}`;
    const bytes = new TextEncoder().encode(JSON.stringify({
      campaign: { title: "Excess inline images remain optional" },
      world: { title: "Excess inline images remain optional" },
      turns: Array.from({ length: 257 }, (_unused, index) => ({
        id: crypto.randomUUID(),
        narration: `Turn ${index + 1}`,
        imageUrl
      }))
    }));
    const staged = await stagedInput(composition, bytes, "14e3e4-excessive-inline");
    const destination = {
      kind: "existing_world_version" as const,
      worldId: target.worldId,
      worldVersionId: target.worldVersionId
    };
    const preview = await composition.previewLegacyStory({
      ownerUserId,
      stagedInput: staged,
      kind: "legacy_story",
      destination
    });
    const committed = await composition.commit({
      ownerUserId,
      kind: "legacy_story",
      destination,
      previewHandle: preview.previewHandle,
      idempotencyKey: `14e3e4-excessive-inline-${crypto.randomUUID()}`
    });
    const campaignId = (committed.result as Readonly<{ campaignId: string }>).campaignId;
    await expect(pool.query(
      "SELECT count(*)::int AS count FROM turns WHERE campaign_id=$1 AND image_url<>''",
      [campaignId],
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(pool.query(
      `SELECT count(*)::int AS count
         FROM portable_import_normalized_asset_publications mapping
         JOIN portable_import_operations operation ON operation.id=mapping.operation_id
        WHERE operation.preview_token_hash=$1`,
      [hash(preview.previewHandle.token)],
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  }, 30_000);

  it("publishes inline Legacy covers and omits ambiguous companion cover aliases", async () => {
    const inlineTarget = await createWorldScope(`14e3e4 inline-cover target ${crypto.randomUUID()}`);
    const composition = await composePortable(inlineTarget, "14e3e4-inline-cover");
    const inlineCover = await sharp({
      create: {
        width: 3,
        height: 4,
        channels: 3,
        background: { r: 88, g: 44, b: 22 }
      }
    }).png().toBuffer();
    const inlineBytes = new TextEncoder().encode(JSON.stringify({
      campaign: { title: "Inline cover" },
      world: {
        title: "Inline cover",
        coverImageUrl: `data:image/png;base64,${inlineCover.toString("base64")}`
      },
      turns: [{ id: crypto.randomUUID(), narration: "Cover only", imageUrl: "" }]
    }));
    const inlineStaged = await stagedInput(composition, inlineBytes, "14e3e4-inline-cover");
    const inlineDestination = {
      kind: "existing_world_version" as const,
      worldId: inlineTarget.worldId,
      worldVersionId: inlineTarget.worldVersionId
    };
    const inlinePreview = await composition.previewLegacyStory({
      ownerUserId,
      stagedInput: inlineStaged,
      kind: "legacy_story",
      destination: inlineDestination
    });
    await composition.commit({
      ownerUserId,
      kind: "legacy_story",
      destination: inlineDestination,
      previewHandle: inlinePreview.previewHandle,
      idempotencyKey: `14e3e4-inline-cover-${crypto.randomUUID()}`
    });
    const inlineWorld = await pool.query<{ cover_asset_id: string | null }>(
      "SELECT cover_asset_id FROM worlds WHERE id=$1 AND owner_user_id=$2",
      [inlineTarget.worldId, ownerUserId],
    );
    expect(inlineWorld.rows[0]?.cover_asset_id).toMatch(UUID_PATTERN_FOR_TEST);

    const ambiguousTarget = await createWorldScope(`14e3e4 ambiguous-cover target ${crypto.randomUUID()}`);
    const ambiguousA = await sharp({
      create: { width: 2, height: 3, channels: 3, background: { r: 1, g: 2, b: 3 } }
    }).png().toBuffer();
    const ambiguousB = await sharp({
      create: { width: 3, height: 2, channels: 3, background: { r: 3, g: 2, b: 1 } }
    }).png().toBuffer();
    const ambiguousBytes = new TextEncoder().encode(JSON.stringify({
      campaign: { title: "Ambiguous cover" },
      world: { title: "Ambiguous cover", coverImageUrl: "cover.png" },
      turns: [{ id: crypto.randomUUID(), narration: "No unambiguous cover", imageUrl: "" }]
    }));
    const ambiguousStaged = await stagedInput(composition, ambiguousBytes, "14e3e4-ambiguous-cover");
    const ambiguousDestination = {
      kind: "existing_world_version" as const,
      worldId: ambiguousTarget.worldId,
      worldVersionId: ambiguousTarget.worldVersionId
    };
    const ambiguousAssets = {
      legacyStoryCompanions: [
        {
          sourceKey: "a/cover.png",
          artifact: {
            mimeType: "image/png" as const,
            bytes: ambiguousA,
            byteLength: ambiguousA.byteLength,
            contentHash: hash(ambiguousA)
          }
        },
        {
          sourceKey: "b/cover.png",
          artifact: {
            mimeType: "image/png" as const,
            bytes: ambiguousB,
            byteLength: ambiguousB.byteLength,
            contentHash: hash(ambiguousB)
          }
        }
      ]
    };
    const ambiguousPreview = await composition.previewLegacyStory({
      ownerUserId,
      stagedInput: ambiguousStaged,
      kind: "legacy_story",
      destination: ambiguousDestination
    }, ambiguousAssets);
    await expect(composition.commit({
      ownerUserId,
      kind: "legacy_story",
      destination: ambiguousDestination,
      previewHandle: ambiguousPreview.previewHandle,
      idempotencyKey: `14e3e4-ambiguous-cover-${crypto.randomUUID()}`
    }, ambiguousAssets)).resolves.toMatchObject({ duplicate: false });
    await expect(pool.query(
      "SELECT cover_asset_id FROM worlds WHERE id=$1 AND owner_user_id=$2",
      [ambiguousTarget.worldId, ownerUserId],
    )).resolves.toMatchObject({ rows: [{ cover_asset_id: null }] });
    await expect(pool.query(
      `SELECT count(*)::int AS count
         FROM portable_import_normalized_asset_publications mapping
         JOIN portable_import_operations operation ON operation.id=mapping.operation_id
        WHERE operation.preview_token_hash=$1`,
      [hash(ambiguousPreview.previewHandle.token)],
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  }, 30_000);

  it("treats every image-free import family as a normalized publication no-op", async () => {
    const target = await createWorldScope(`14e3e4 image-free target ${crypto.randomUUID()}`);
    const composition = await composePortable(target, "14e3e4-image-free");
    const campaignBytes = await campaignZip(`image-free-${crypto.randomUUID()}`);
    const campaignStaged = await stagedInput(composition, campaignBytes, "14e3e4-image-free-campaign");
    const campaignPreview = await composition.previewCampaignZip({
      ownerUserId,
      stagedInput: campaignStaged,
      kind: "campaign_zip",
      destination: { kind: "embedded", operation: "create_world" }
    });
    const campaignCommand = {
      ownerUserId,
      kind: "campaign_zip" as const,
      destination: campaignPreview.destination,
      previewHandle: campaignPreview.previewHandle,
      idempotencyKey: `14e3e4-image-free-campaign-${crypto.randomUUID()}`
    };
    const illegalCompanion = new Uint8Array([1]);
    await expect(composition.commit(campaignCommand, {
      legacyStoryCompanions: [{
        sourceKey: "illegal.png",
        artifact: {
          mimeType: "image/png",
          bytes: illegalCompanion,
          byteLength: illegalCompanion.byteLength,
          contentHash: "0".repeat(64)
        }
      }]
    })).rejects.toThrow("portable_import_artifacts_invalid");
    const campaignCommitted = await composition.commit(campaignCommand);
    const campaignResult = campaignCommitted.result as Readonly<{ stats: Readonly<{ assetCount: number }> }>;
    expect(campaignResult.stats.assetCount).toBe(0);

    const legacyBytes = new TextEncoder().encode(JSON.stringify({
      campaign: { title: "Image-free legacy" },
      world: { title: "Image-free legacy" },
      turns: [{ id: crypto.randomUUID(), narration: "Only narration", imageUrl: "" }]
    }));
    const legacyStaged = await stagedInput(composition, legacyBytes, "14e3e4-image-free-legacy");
    const destination = {
      kind: "existing_world_version" as const,
      worldId: target.worldId,
      worldVersionId: target.worldVersionId
    };
    const legacyPreview = await composition.previewLegacyStory({
      ownerUserId,
      stagedInput: legacyStaged,
      kind: "legacy_story",
      destination
    });
    const legacyCommitted = await composition.commit({
      ownerUserId,
      kind: "legacy_story",
      destination,
      previewHandle: legacyPreview.previewHandle,
      idempotencyKey: `14e3e4-image-free-legacy-${crypto.randomUUID()}`
    });
    const legacyResult = legacyCommitted.result as Readonly<{ campaignId: string }>;
    expect(legacyResult.campaignId).toMatch(UUID_PATTERN_FOR_TEST);

    const createDestination = { kind: "create_world" as const };
    const encoder = new TextEncoder();
    const infiniteStaged = await stagedInput(
      composition,
      encoder.encode(JSON.stringify({
        title: `Image-free Infinite Worlds ${crypto.randomUUID()}`,
        background: "An image-free imported world.",
        possibleCharacters: [{ name: "Hero", description: "A verifier." }]
      })),
      "14e3e4-image-free-infinite-worlds",
    );
    const infinitePreview = await composition.previewInfiniteWorlds({
      ownerUserId,
      stagedInput: infiniteStaged,
      kind: "infinite_worlds",
      destination: createDestination
    });
    await composition.commit({
      ownerUserId,
      kind: "infinite_worlds",
      destination: infinitePreview.destination,
      previewHandle: infinitePreview.previewHandle,
      idempotencyKey: `14e3e4-image-free-infinite-worlds-${crypto.randomUUID()}`
    });

    const cyoaBytes = await readFile(
      new URL("../fixtures/cyoa_writing_com_sample.json", import.meta.url),
    );
    const cyoaStaged = await stagedInput(composition, cyoaBytes, "14e3e4-image-free-cyoa");
    const cyoaPreview = await composition.previewCyoa({
      ownerUserId,
      stagedInput: cyoaStaged,
      kind: "cyoa",
      destination: createDestination
    });
    await composition.commit({
      ownerUserId,
      kind: "cyoa",
      destination: cyoaPreview.destination,
      previewHandle: cyoaPreview.previewHandle,
      idempotencyKey: `14e3e4-image-free-cyoa-${crypto.randomUUID()}`
    });

    const portableWorld = {
      format: "infinite-quest-world" as const,
      formatVersion: 1 as const,
      title: `Image-free portable world ${crypto.randomUUID()}`,
      content: canonicalizeWorldContent({
        world: { title: "Image-free portable world" },
        playableCharacters: [{ id: "hero", name: "Hero", characterText: "A verifier" }]
      })
    };
    const worldJsonStaged = await stagedInput(
      composition,
      encoder.encode(JSON.stringify(portableWorld)),
      "14e3e4-image-free-world-json",
    );
    const worldJsonPreview = await composition.previewWorldJson({
      ownerUserId,
      stagedInput: worldJsonStaged,
      kind: "world_json",
      destination: createDestination
    });
    await composition.commit({
      ownerUserId,
      kind: "world_json",
      destination: worldJsonPreview.destination,
      previewHandle: worldJsonPreview.previewHandle,
      idempotencyKey: `14e3e4-image-free-world-json-${crypto.randomUUID()}`
    });

    const worldTextStaged = await stagedInput(
      composition,
      encoder.encode(`Image-free archive city ${crypto.randomUUID()} where Hero verifies durable state.`),
      "14e3e4-image-free-world-text",
    );
    const worldTextPreview = await composition.previewWorldText({
      ownerUserId,
      stagedInput: worldTextStaged,
      kind: "world_text",
      destination: createDestination
    });
    await composition.commit({
      ownerUserId,
      kind: "world_text",
      destination: worldTextPreview.destination,
      previewHandle: worldTextPreview.previewHandle,
      idempotencyKey: `14e3e4-image-free-world-text-${crypto.randomUUID()}`
    });

    const storyTextStaged = await stagedInput(
      composition,
      encoder.encode("-- Story Background --\nA durable road.\n-- Character --\nHero\n-- Turn 1 --\nOutcome\n-------\nThe road opens."),
      "14e3e4-image-free-story-text",
    );
    const storyTextPreview = await composition.previewStoryText({
      ownerUserId,
      stagedInput: storyTextStaged,
      kind: "story_text",
      destination,
      selectedCharacterId: "hero"
    });
    await composition.commit({
      ownerUserId,
      kind: "story_text",
      destination: storyTextPreview.destination,
      previewHandle: storyTextPreview.previewHandle,
      idempotencyKey: `14e3e4-image-free-story-text-${crypto.randomUUID()}`
    });

    const operationHashes = [
      campaignPreview,
      legacyPreview,
      infinitePreview,
      cyoaPreview,
      worldJsonPreview,
      worldTextPreview,
      storyTextPreview
    ].map((previewValue) => hash(previewValue.previewHandle.token));
    const counts = await pool.query<{
      request_count: number;
      mapping_count: number;
      legacy_count: number;
      filesystem_count: number;
    }>(
      `SELECT
         (SELECT count(*)::int
            FROM asset_publication_requests request
           WHERE request.provenance_snapshot->>'importOperationId'=operation.id::text) AS request_count,
         (SELECT count(*)::int
            FROM portable_import_normalized_asset_publications mapping
           WHERE mapping.operation_id=operation.id) AS mapping_count,
         (SELECT count(*)::int
            FROM portable_import_asset_publications legacy
           WHERE legacy.operation_id=operation.id) AS legacy_count,
         (SELECT count(*)::int
            FROM asset_publication_requests request
            JOIN durable_filesystem_operations filesystem
              ON filesystem.asset_id=request.canonical_asset_id
             AND filesystem.owner_user_id=request.owner_user_id
           WHERE request.provenance_snapshot->>'importOperationId'=operation.id::text
             AND filesystem.purpose IN ('asset_original','asset_derivative')) AS filesystem_count
         FROM portable_import_operations operation
        WHERE operation.preview_token_hash=ANY($1::text[])
        ORDER BY operation.import_kind`,
      [operationHashes],
    );
    expect(counts.rows).toHaveLength(7);
    expect(counts.rows).toEqual(counts.rows.map(() => ({
      request_count: 0,
      mapping_count: 0,
      legacy_count: 0,
      filesystem_count: 0
    })));
  }, 30_000);

  it("rolls normalized attachment and family rows back together, then retries from durable prewrite intent", async () => {
    const target = await createWorldScope(`14e3e4 rollback target ${crypto.randomUUID()}`);
    let composition = await composePortable(target, "14e3e4-rollback-a");
    const sourceAssetId = crypto.randomUUID();
    const image = await sharp({
      create: {
        width: 5,
        height: 4,
        channels: 3,
        background: { r: 201, g: 88, b: 17 }
      }
    }).png().toBuffer();
    const bytes = await campaignZip(`rollback-${crypto.randomUUID()}`, { sourceAssetId, bytes: image });
    const staged = await stagedInput(composition, bytes, "14e3e4-rollback");
    const preview = await composition.previewCampaignZip({
      ownerUserId,
      stagedInput: staged,
      kind: "campaign_zip",
      destination: { kind: "embedded", operation: "create_world" }
    });
    const command = {
      ownerUserId,
      kind: "campaign_zip" as const,
      destination: preview.destination,
      previewHandle: preview.previewHandle,
      idempotencyKey: `14e3e4-rollback-${crypto.randomUUID()}`
    };
    const operation = await pool.query<{ id: string; authority_fingerprint: string }>(
      `SELECT id,authority_fingerprint
         FROM portable_import_operations
        WHERE owner_user_id=$1 AND preview_token_hash=$2`,
      [ownerUserId, hash(preview.previewHandle.token)],
    );
    const operationId = operation.rows[0]!.id;
    await pool.query(`CREATE FUNCTION task_14e3e4_domain_rollback_fault() RETURNS trigger
      LANGUAGE plpgsql AS $fault$
      BEGIN RAISE EXCEPTION 'task_14e3e4_domain_rollback_fault'; END;
      $fault$`);
    await pool.query(`CREATE TRIGGER task_14e3e4_domain_rollback_fault_trigger
      BEFORE UPDATE ON portable_import_work
      FOR EACH ROW WHEN (NEW.phase='finalizing' AND OLD.phase IS DISTINCT FROM 'finalizing')
      EXECUTE FUNCTION task_14e3e4_domain_rollback_fault()`);
    try {
      await expect(composition.commit(command)).rejects.toThrow("task_14e3e4_domain_rollback_fault");
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS task_14e3e4_domain_rollback_fault_trigger ON portable_import_work",
      );
      await pool.query("DROP FUNCTION IF EXISTS task_14e3e4_domain_rollback_fault()");
    }

    const rolledBack = await pool.query<{
      operation_status: string;
      publication_state: string;
      request_lifecycle: string;
      request_source_count: number;
      request_derivative_count: number;
      import_count: number;
      asset_count: number;
    }>(
      `SELECT operation.status AS operation_status,mapping.publication_state,
              request.lifecycle AS request_lifecycle,
              (SELECT count(*)::int FROM asset_publication_request_sources source
                WHERE source.request_id=request.id) AS request_source_count,
              (SELECT count(*)::int FROM asset_publication_request_derivatives derivative
                WHERE derivative.request_id=request.id) AS request_derivative_count,
              (SELECT count(*)::int FROM imports imported
                WHERE imported.owner_user_id=operation.owner_user_id
                  AND imported.source_hash=operation.authority_fingerprint) AS import_count,
              (SELECT count(*)::int FROM assets asset
                WHERE asset.owner_user_id=operation.owner_user_id
                  AND asset.content_hash=$2) AS asset_count
         FROM portable_import_operations operation
         JOIN portable_import_normalized_asset_publications mapping
           ON mapping.operation_id=operation.id AND mapping.owner_user_id=operation.owner_user_id
         JOIN asset_publication_requests request
           ON request.id=mapping.request_id AND request.owner_user_id=mapping.owner_user_id
        WHERE operation.id=$1`,
      [operationId, hash(image)],
    );
    expect(rolledBack.rows).toEqual([{
      operation_status: "previewed",
      publication_state: "reserved",
      request_lifecycle: "prepared",
      request_source_count: 0,
      request_derivative_count: 0,
      import_count: 0,
      asset_count: 0
    }]);

    await composition.close();
    composition = await composePortable(target, "14e3e4-rollback-b");
    const retried = await composition.commit(command);
    expect(retried).toMatchObject({
      kind: "campaign_zip",
      duplicate: false,
      result: { stats: { assetCount: 1 } }
    });
    await expect(pool.query(
      `SELECT operation.status,mapping.publication_state,request.lifecycle
         FROM portable_import_operations operation
         JOIN portable_import_normalized_asset_publications mapping ON mapping.operation_id=operation.id
         JOIN asset_publication_requests request ON request.id=mapping.request_id
        WHERE operation.id=$1`,
      [operationId],
    )).resolves.toMatchObject({
      rows: [{ status: "committed", publication_state: "published", lifecycle: "published" }]
    });
  }, 30_000);

  it("recovers committed normalized finalization after a fresh composition", async () => {
    const target = await createWorldScope(`14e3e4 finalize target ${crypto.randomUUID()}`);
    let composition = await composePortable(target, "14e3e4-finalize-a");
    const sourceAssetId = crypto.randomUUID();
    const image = await sharp({
      create: {
        width: 7,
        height: 2,
        channels: 4,
        background: { r: 71, g: 41, b: 191, alpha: 1 }
      }
    }).png().toBuffer();
    const bytes = await campaignZip(`finalize-${crypto.randomUUID()}`, { sourceAssetId, bytes: image });
    const staged = await stagedInput(composition, bytes, "14e3e4-finalize");
    const preview = await composition.previewCampaignZip({
      ownerUserId,
      stagedInput: staged,
      kind: "campaign_zip",
      destination: { kind: "embedded", operation: "create_world" }
    });
    const command = {
      ownerUserId,
      kind: "campaign_zip" as const,
      destination: preview.destination,
      previewHandle: preview.previewHandle,
      idempotencyKey: `14e3e4-finalize-${crypto.randomUUID()}`
    };
    await pool.query(`CREATE FUNCTION task_14e3e4_finalize_fault() RETURNS trigger
      LANGUAGE plpgsql AS $fault$
      BEGIN RAISE EXCEPTION 'task_14e3e4_finalize_fault'; END;
      $fault$`);
    await pool.query(`CREATE TRIGGER task_14e3e4_finalize_fault_trigger
      BEFORE UPDATE ON durable_filesystem_operations
      FOR EACH ROW WHEN (NEW.lifecycle='finalized' AND OLD.lifecycle='attached')
      EXECUTE FUNCTION task_14e3e4_finalize_fault()`);
    try {
      await expect(composition.commit(command))
        .rejects.toThrow("asset_publication_finalization_recoverable");
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS task_14e3e4_finalize_fault_trigger ON durable_filesystem_operations",
      );
      await pool.query("DROP FUNCTION IF EXISTS task_14e3e4_finalize_fault()");
    }

    const pending = await pool.query<{
      operation_status: string;
      work_status: string;
      phase: string;
      publication_state: string;
      request_lifecycle: string;
    }>(
      `SELECT operation.status AS operation_status,work.status AS work_status,work.phase,
              mapping.publication_state,request.lifecycle AS request_lifecycle
         FROM portable_import_operations operation
         JOIN portable_import_work work ON work.operation_id=operation.id
         JOIN portable_import_normalized_asset_publications mapping ON mapping.operation_id=operation.id
         JOIN asset_publication_requests request ON request.id=mapping.request_id
        WHERE operation.preview_token_hash=$1`,
      [hash(preview.previewHandle.token)],
    );
    expect(pending.rows).toEqual([{
      operation_status: "committed",
      work_status: "recoverable",
      phase: "finalizing",
      publication_state: "committed_finalization_pending",
      request_lifecycle: "attached"
    }]);

    await composition.close();
    composition = await composePortable(target, "14e3e4-finalize-b");
    const replay = await composition.commit(command);
    expect(replay).toMatchObject({ kind: "campaign_zip", result: { stats: { assetCount: 1 } } });
    await expect(pool.query(
      `SELECT work.status AS work_status,work.phase,mapping.publication_state,
              request.lifecycle AS request_lifecycle
         FROM portable_import_operations operation
         JOIN portable_import_work work ON work.operation_id=operation.id
         JOIN portable_import_normalized_asset_publications mapping ON mapping.operation_id=operation.id
         JOIN asset_publication_requests request ON request.id=mapping.request_id
        WHERE operation.preview_token_hash=$1`,
      [hash(preview.previewHandle.token)],
    )).resolves.toMatchObject({
      rows: [{
        work_status: "completed",
        phase: "completed",
        publication_state: "published",
        request_lifecycle: "published"
      }]
    });
  }, 30_000);
});
