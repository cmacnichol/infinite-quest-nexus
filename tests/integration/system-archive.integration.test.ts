import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import JSZip from "jszip";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { worldContentSchema } from "../../packages/contracts/src/world-library.js";
import { archiveAssetRecordSchema } from "../../packages/contracts/src/archives.js";
import {
  SYSTEM_ARCHIVE_DOMAINS,
  systemArchiveAssetsPayloadSchema,
  systemArchiveImportReportSchema,
  systemArchiveManifestSchema,
  systemArchiveReportSchema,
  systemRecordEnvelopeSchema,
} from "../../packages/contracts/src/system-archives.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { createPostgresAssetPublicationRepository } from "../../packages/database/src/asset-publication-repository.js";
import { createPostgresDurableFilesystemRepository } from "../../packages/database/src/durable-filesystem-repository.js";
import {
  createPostgresSystemArchiveExportJobPort,
  createPostgresSystemArchiveExportRepository,
} from "../../packages/database/src/system-archive-export-repository.js";
import {
  SYSTEM_IMPORT_LOCK_KEY,
  createPostgresSystemArchiveImportRepository,
} from "../../packages/database/src/system-archive-import-repository.js";
import { createPostgresSystemArchiveJobRepository } from "../../packages/database/src/system-archive-job-repository.js";
import {
  runSystemExport,
  type SystemArchiveExportDependencies,
  type SystemArchiveExportJob,
} from "../../packages/application/src/system-archives/index.js";
import {
  createPrivateSystemArchiveStaging,
  createFilesystemSystemArchiveWriter,
  createSystemArchiveImportExecutionService,
  createSystemArchiveImportComposition,
  createSystemArchiveImportPreviewService,
  inspectSystemArchiveForPreview,
  type SystemArchiveArtifactPublisherPort,
  type SystemArchiveStagingPort,
} from "../../services/runtime/src/system-archive-composition.js";
import { createAssetImportStorageComposition } from "../../services/runtime/src/asset-import-composition.js";
import {
  stageArchiveUpload,
  supportsSecureGeneratedArchiveStaging,
} from "../../services/api/src/archive-io.js";
import {
  withExclusiveSystemImport,
  withSystemMutationPermit,
} from "../../services/api/src/system-import-gate.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const limits = {
  maxCompressedBytes: 20 * 1024 * 1024,
  maxUncompressedBytes: 50 * 1024 * 1024,
  maxEntries: 10_000,
  maxManifestBytes: 1024 * 1024,
  maxJsonEntryBytes: 1024 * 1024 * 1024,
  maxExpansionRatio: 100,
  maxOriginalImageBytes: 25 * 1024 * 1024,
} as const;
const emptyOperationalOmissions = {
  generation: 0,
  illustration: 0,
  chronicle: 0,
  imports: 0,
  "system-archive": 0,
} as const;

type StoredOriginal = Readonly<{
  id: string;
  path: string;
  bytes: Buffer;
  contentHash: string;
}>;

function job(ownerUserId: string): SystemArchiveExportJob {
  return Object.freeze({ id: randomUUID(), ownerUserId, leaseOwner: "system-archive-integration" });
}

function fakeJobs(): SystemArchiveExportDependencies["jobs"] {
  return {
    setPhase: vi.fn(async () => undefined),
    cancellationRequested: vi.fn(async () => false),
    markPublished: vi.fn(async () => undefined),
    markCancelled: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
  };
}

function importReport(input: Readonly<{
  ownerUserId: string;
  recordsByDomain: Readonly<Record<string, number>>;
  archiveFingerprint?: string;
  assetCount?: number;
  assetBytes?: number;
  omittedOperationalRows?: number;
  completedAt?: string;
}>) {
  const assetCount = input.assetCount ?? 0;
  const omittedOperationalRows = input.omittedOperationalRows ?? 0;
  return systemArchiveImportReportSchema.parse({
    completedAt: input.completedAt ?? "2026-08-25T12:00:03.000Z",
    archiveFingerprint: input.archiveFingerprint ?? sha256("system-archive-import-report"),
    recordsByDomain: input.recordsByDomain,
    assetCount,
    assetBytes: input.assetBytes ?? 0,
    omittedOperationalRows,
    operationalOmissions: {
      generation: 0,
      illustration: 0,
      chronicle: 0,
      imports: 0,
      "system-archive": omittedOperationalRows,
    },
    warnings: [],
    errors: [],
    versions: {
      archiveFormat: 1,
      sourceApplication: "0.1.0",
      sourceMigration: "0079_resumable_system_archive_uploads",
      destinationApplication: "0.1.0",
      destinationMigration: "0079_resumable_system_archive_uploads",
    },
    sourceOwnerCount: 1,
    ownerMapping: {
      sourceOwnerId: input.ownerUserId,
      destinationOwnerId: input.ownerUserId,
    },
    disabledProviders: input.recordsByDomain.providers ?? 0,
    normalization: ["map-source-owner-to-initial-owner", "disable-provider-profiles"],
    invalidatedAccess: ["share-links", "sessions", "oidc-identities", "external-authorizations"],
    integrityReconciliation: {
      archiveFingerprintVerified: true,
      recordsMatched: true,
      assetsMatched: true,
    },
    rebuildState: {
      chronicleIndex: {
        category: "chronicle-index",
        status: "pending",
        itemCount: input.recordsByDomain.campaigns ?? 0,
      },
      assetThumbnails: {
        category: "asset-thumbnails",
        status: "pending",
        itemCount: assetCount,
      },
    },
  });
}

function memoryStaging(options: Readonly<{
  cleanupFailures?: number;
}> = {}): SystemArchiveStagingPort & Readonly<{ activeEntryCount(): number }> {
  const active = new Set<object>();
  let cleanupFailures = options.cleanupFailures ?? 0;
  return Object.freeze({
    async stage(input: Parameters<SystemArchiveStagingPort["stage"]>[0]) {
      const chunks: Buffer[] = [];
      let byteLength = 0;
      for await (const chunk of input.source) {
        const value = Buffer.from(chunk);
        byteLength += value.byteLength;
        if (byteLength > input.maximumBytes) throw new Error("memory_staging_limit_exceeded");
        chunks.push(value);
      }
      const bytes = Buffer.concat(chunks, byteLength);
      const identity = {};
      active.add(identity);
      return Object.freeze({
        byteLength,
        sha256: sha256(bytes),
        open() {
          return ReadableStreamFrom([bytes]);
        },
        async cleanup() {
          if (cleanupFailures > 0) {
            cleanupFailures -= 1;
            throw new Error("forced durable scratch cleanup deferral");
          }
          active.delete(identity);
        },
      });
    },
    activeEntryCount() {
      return active.size;
    },
  });
}

function memoryPublisher(): Readonly<{
  publisher: SystemArchiveArtifactPublisherPort;
  read(relativePath: string): Buffer;
}> {
  const artifacts = new Map<string, Buffer>();
  return Object.freeze({
    publisher: Object.freeze({
      async publishSystemArchive(input: Parameters<SystemArchiveArtifactPublisherPort["publishSystemArchive"]>[0]) {
        const chunks: Buffer[] = [];
        for await (const chunk of input.source) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        if (bytes.byteLength !== input.byteLength || sha256(bytes) !== input.sha256) {
          throw new Error("memory_publication_identity_mismatch");
        }
        const artifactId = randomUUID();
        const relativePath = `memory-system-archives/${artifactId}.zip`;
        artifacts.set(relativePath, bytes);
        return Object.freeze({
          artifactId,
          relativePath,
          byteLength: bytes.byteLength,
          sha256: input.sha256,
        });
      },
    }),
    read(relativePath: string) {
      const artifact = artifacts.get(relativePath);
      if (!artifact) throw new Error("memory_system_archive_missing");
      return artifact;
    },
  });
}

async function archiveText(bytes: Buffer): Promise<Readonly<{
  zip: JSZip;
  serialized: string;
}>> {
  const zip = await JSZip.loadAsync(bytes);
  const portableEntries = Object.values(zip.files)
    .filter((entry) => !entry.dir && (entry.name.endsWith(".json") || entry.name.endsWith(".ndjson")))
    .sort((left, right) => left.name.localeCompare(right.name));
  const serialized = (await Promise.all(portableEntries.map((entry) => entry.async("string")))).join("\n");
  return { zip, serialized };
}

type MutableSystemManifest = {
  contentFingerprint: string;
  entries: { path: string; logicalType: string; mediaType: string; byteLength: number; sha256: string }[];
  assets: Array<{ bindings: unknown[] }>;
};

function refreshSystemFingerprint(manifest: MutableSystemManifest): void {
  const payloadHashes = manifest.entries
    .filter((entry) => entry.logicalType !== "asset-original")
    .map((entry) => entry.sha256)
    .sort();
  const originalAssetHashes = [...new Set(manifest.entries
    .filter((entry) => entry.logicalType === "asset-original")
    .map((entry) => entry.sha256))]
    .sort();
  manifest.contentFingerprint = createHash("sha256")
    .update(JSON.stringify({ originalAssetHashes, payloadHashes }))
    .digest("hex");
}

integration("deterministic owner-wide System Archive export", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  let archiveRoot = "";
  let assetRoot = "";
  let worldId = "";
  let campaignId = "";
  let worldVersionId = "";
  let turnId = "";
  let checkpointOpenThreadId = "";
  let originals: StoredOriginal[] = [];

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    archiveRoot = await mkdtemp(join(tmpdir(), "infinitequest-system-archives-"));
    assetRoot = join(archiveRoot, "source-assets");
    await mkdir(assetRoot, { recursive: true });

    const provider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (
         owner_user_id,name,provider_type,provider_role,base_url,default_model,
         request_timeout_ms,configuration,encrypted_api_key,credential_nonce,credential_auth_tag,
         credential_key_version,enabled,health_status
       ) VALUES ($1,'Portable text','openai_compatible','text',
                 'https://provider-user:provider-password@portable.invalid/v1?api_key=provider-query-secret#provider-fragment-secret',
                 'story-model',654321,$2::jsonb,'encrypted_api_key','nonce','tag',1,true,'healthy')
       RETURNING id`,
      [ownerUserId, JSON.stringify({ timeoutMs: 1234, retryLimit: 2, password: "must-not-export" })],
    );
    await pool.query(
      `INSERT INTO prompt_template_overrides (owner_user_id,prompt_key,content)
       VALUES ($1,'story_system','Portable prompt')`,
      [ownerUserId],
    );

    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title,status) VALUES ($1,'System world','active') RETURNING id",
      [ownerUserId],
    );
    worldId = world.rows[0]!.id;
    const content = worldContentSchema.parse({
      world: {
        title: "System world",
        genre: "Archive fantasy",
        tone: "Exact",
        premise: "Everything portable survives.",
        firstAction: "Begin.",
        providerToken: "world-passthrough-must-not-export",
      },
    });
    const version = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (
         world_id,owner_user_id,version_number,content,source_hash,release_notes,created_from_revision
       ) VALUES ($1,$2,1,$3::jsonb,$4,'Portable release',1) RETURNING id`,
      [worldId, ownerUserId, JSON.stringify(content), sha256("world-content")],
    );
    worldVersionId = version.rows[0]!.id;
    await pool.query(
      `INSERT INTO world_drafts (world_id,owner_user_id,based_on_world_version_id,revision,content)
       VALUES ($1,$2,$3,2,$4::jsonb)`,
      [worldId, ownerUserId, worldVersionId, JSON.stringify(content)],
    );
    const campaign = await pool.query<{ id: string }>(
      `INSERT INTO campaigns (
         owner_user_id,world_version_id,title,active_turn_number,turn_control_style
       ) VALUES ($1,$2,'System campaign',1,'flexible_scene') RETURNING id`,
      [ownerUserId, worldVersionId],
    );
    campaignId = campaign.rows[0]!.id;
    await pool.query(
      `INSERT INTO prompt_template_overrides (owner_user_id,campaign_id,prompt_key,content)
       VALUES ($1,$2,'story_system','Campaign portable prompt')`,
      [ownerUserId, campaignId],
    );
    await pool.query(
      `INSERT INTO campaign_state (
         campaign_id,owner_user_id,scratchpad_private,trackers,default_triggers,
         event_triggers,pending_event_triggers,rpg_stats,revision
       ) VALUES ($1,$2,'Retained continuity','[]'::jsonb,'[]'::jsonb,'[]'::jsonb,
                 '[]'::jsonb,'[]'::jsonb,1)`,
      [campaignId, ownerUserId],
    );
    const turn = await pool.query<{ id: string }>(
      `INSERT INTO turns (
         owner_user_id,campaign_id,turn_number,action,narration,choices,image_prompt,
         input_mode,input_mode_source,state_snapshot_private,accepted_at
       ) VALUES ($1,$2,1,'Open the gate.','The gate opens.','["Enter"]'::jsonb,
                 'A moonlit gate.','scene','auto',$3::jsonb,now()) RETURNING id`,
      [ownerUserId, campaignId, JSON.stringify({
        continuitySummary: "Portable current continuity",
        openThreads: ["Find the gate key"],
        scratchpad: "Retained continuity",
        trackers: [],
        rpgStats: [],
        eventTriggers: [],
        pendingEventTriggers: [],
      })],
    );
    turnId = turn.rows[0]!.id;
    await pool.query(
      `INSERT INTO turn_narration_corrections (
         owner_user_id,campaign_id,turn_id,revision,narration,
         previous_effective_narration_hash,reason,source,created_by_user_id
       ) VALUES ($1,$2,$3,1,'The gate opens silently.',$4,'Preserve accepted wording.','user_edit',$1)`,
      [ownerUserId, campaignId, turnId, sha256("The gate opens.")],
    );
    await pool.query(
      `INSERT INTO campaign_state_edits (
         owner_user_id,campaign_id,effective_turn_number,revision,state_snapshot_private,changed_fields
       ) VALUES ($1,$2,1,1,$3::jsonb,'["scratchpad"]'::jsonb)`,
      [ownerUserId, campaignId, JSON.stringify({
        continuitySummary: "Portable current continuity",
        openThreads: ["Find the gate key"],
        scratchpad: "Retained continuity",
        trackers: [],
        canonicalFacts: [],
        rpgStats: [],
        defaultTriggers: [],
        eventTriggers: [],
        pendingEventTriggers: [],
      })],
    );
    await pool.query(
      `INSERT INTO campaign_character_profile_edits (
         owner_user_id,campaign_id,revision,next_profile,edit_source
       ) VALUES ($1,$2,1,$3::jsonb,'manual')`,
      [ownerUserId, campaignId, JSON.stringify({ name: "Avery", profile: { identity: { aliases: [], pronouns: "they" } } })],
    );
    await pool.query(
      `INSERT INTO campaign_memory_configs (campaign_id,owner_user_id,embedding_enabled)
       VALUES ($1,$2,false)`,
      [campaignId, ownerUserId],
    );
    await pool.query(
      `INSERT INTO campaign_illustration_configs (campaign_id,owner_user_id,enabled)
       VALUES ($1,$2,false)`,
      [campaignId, ownerUserId],
    );
    await pool.query(
      `INSERT INTO turn_input_classifications (
         owner_user_id,campaign_id,input_hash,classification,resolved_mode,
         confidence_band,provider_profile_id,provider_source,diagnostics
       ) VALUES ($1,$2,'classifier-input-hash-must-not-export','mixed','scene',
                 'ambiguous',$3,'story_text',$4::jsonb)`,
      [ownerUserId, campaignId, provider.rows[0]!.id, JSON.stringify({ rawProviderResponse: "classifier-diagnostic-must-not-export" })],
    );
    await pool.query(
      `INSERT INTO campaign_canonical_facts (
         id,owner_user_id,campaign_id,world_version_id,source_turn_id,source_turn_number,
         source_fact_index,content,normalized_content,valid_from_turn
       ) VALUES ($1,$2,$3,$4,$5,1,0,'The gate is open.','the gate is open',1)`,
      [randomUUID(), ownerUserId, campaignId, worldVersionId, turnId],
    );
    const memory = await pool.query<{ id: string; content_hash: string }>(
      `INSERT INTO chronicle_memories (
         owner_user_id,campaign_id,world_version_id,turn_id,memory_kind,ordinal,
         content,token_estimate,entities,metadata
       ) VALUES ($1,$2,$3,$4,'turn_fiction',1,'The gate opened.',4,ARRAY['Gate'],'{}'::jsonb)
       RETURNING id,content_hash`,
      [ownerUserId, campaignId, worldVersionId, turnId],
    );
    await pool.query(
      `INSERT INTO summary_checkpoints (
         owner_user_id,campaign_id,through_turn,summary_kind,content,token_estimate
       ) VALUES ($1,$2,1,'campaign_summary',$3::jsonb,4)`,
      [ownerUserId, campaignId, JSON.stringify({
        summary: "The gate opened.",
        openThreadIds: [checkpointOpenThreadId = randomUUID()],
      })],
    );
    await pool.query(
      `INSERT INTO chronicle_memory_chunks (
         owner_user_id,campaign_id,world_version_id,parent_memory_id,parent_content_hash,
         chunking_protocol_version,chunk_ordinal,chunk_kind,content,source_start_offset,
         source_end_offset,token_estimate
       ) VALUES ($1,$2,$3,$4,$5,'chunk-v2',0,'turn_narration','must-not-export chunk',0,21,4)`,
      [ownerUserId, campaignId, worldVersionId, memory.rows[0]!.id, memory.rows[0]!.content_hash],
    );
    await pool.query(
      `INSERT INTO imports (
         owner_user_id,source_type,source_name,source_hash,status,campaign_id,completed_at
       ) VALUES ($1,'legacy_story','Portable source',$2,'completed',$3,now())`,
      [ownerUserId, sha256("portable-source"), campaignId],
    );
    await pool.query(
      `INSERT INTO provider_cost_events (
         owner_user_id,campaign_id,turn_id,provider_profile_id,provider_type,category,
         operation,amount,currency
       ) VALUES ($1,$2,$3,$4,'openai_compatible','story','response',0.012345,'USD')`,
      [ownerUserId, campaignId, turnId, provider.rows[0]!.id],
    );
    await pool.query(
      `INSERT INTO activity_events (owner_user_id,campaign_id,event_type,details)
       VALUES ($1,$2,'campaign.accepted_turn',$3::jsonb)`,
      [ownerUserId, campaignId, JSON.stringify({ summary: "Turn accepted" })],
    );
    await pool.query(
      `INSERT INTO world_share_links (
         owner_user_id,world_id,world_version_id,token_hash,expires_at
       ) VALUES ($1,$2,$3,$4,now()+interval '1 day')`,
      [ownerUserId, worldId, worldVersionId, sha256("world-share-capability")],
    );
    await pool.query(
      `INSERT INTO chronicle_jobs (owner_user_id,campaign_id,job_type,status)
       VALUES ($1,$2,'reindex_campaign','queued')`,
      [ownerUserId, campaignId],
    );

    originals = await Promise.all(([
      ["cover", "#ff0000"],
      ["selected", "#00ff00"],
      ["alternate", "#0000ff"],
      ["unbound", "#ffff00"],
    ] as const).map(async ([name, background]) => {
      const bytes = await sharp({ create: { width: 2, height: 2, channels: 4, background } }).png().toBuffer();
      const contentHash = sha256(bytes);
      const storagePath = `originals/${contentHash}.png`;
      const path = join(assetRoot, storagePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO assets (
           owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length,
           pixel_width,pixel_height,technical_metadata
         ) VALUES ($1,$2,'filesystem',$3,'image/png',$4,2,2,'{}'::jsonb) RETURNING id`,
        [ownerUserId, contentHash, storagePath, bytes.byteLength],
      );
      await pool.query(
        `UPDATE asset_library_entries
            SET title=$3,reuse_scope=$4,review_status='eligible',
                archived_at=CASE WHEN $3='unbound' THEN COALESCE(archived_at,created_at) ELSE NULL END
          WHERE owner_user_id=$1 AND asset_id=$2`,
        [ownerUserId, inserted.rows[0]!.id, name, name === "unbound" ? "owner_library" : name === "cover" ? "world" : "campaign"],
      );
      return { id: inserted.rows[0]!.id, path, bytes, contentHash };
    }));
    await pool.query("UPDATE worlds SET cover_asset_id=$2 WHERE id=$1", [worldId, originals[0]!.id]);
    await pool.query(
      `UPDATE world_versions
          SET content=jsonb_set(content,'{assets}',$2::jsonb,true)
        WHERE id=$1`,
      [worldVersionId, JSON.stringify([
        { assetId: originals[0]!.id, role: "world_cover" },
        { assetId: originals[1]!.id, role: "world_version_asset" },
      ])],
    );
    const illustrationSet = await pool.query<{ id: string }>(
      `INSERT INTO turn_illustration_sets (
         owner_user_id,campaign_id,turn_id,source_text_hash,segment_word_count,
         images_per_segment,prompt_mode,status,is_active,completed_at
       ) VALUES ($1,$2,$3,$4,100,2,'direct','completed',true,now()) RETURNING id`,
      [ownerUserId, campaignId, turnId, sha256("The gate opens.")],
    );
    const segment = await pool.query<{ id: string }>(
      `INSERT INTO turn_illustration_segments (
         owner_user_id,illustration_set_id,campaign_id,turn_id,ordinal,start_offset,
         end_offset,start_word,end_word,source_text,source_text_hash,direct_prompt,
         resolved_prompt,prompt_source,status
       ) VALUES ($1,$2,$3,$4,0,0,15,0,3,'The gate opens.',$5,
                 'A moonlit gate.','A moonlit gate.','direct','completed') RETURNING id`,
      [ownerUserId, illustrationSet.rows[0]!.id, campaignId, turnId, sha256("The gate opens.")],
    );
    await pool.query(
      `INSERT INTO turn_illustration_segment_assets (
         segment_id,owner_user_id,asset_id,variant_index
       ) VALUES ($1,$2,$3,0),($1,$2,$4,1)`,
      [segment.rows[0]!.id, ownerUserId, originals[1]!.id, originals[2]!.id],
    );
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (archiveRoot) await rm(archiveRoot, { recursive: true, force: true });
  });

  function originalsReader(): SystemArchiveExportDependencies["originals"] {
    return {
      async openOriginal(input) {
        const selected = originals.find((candidate) => candidate.id === input.asset.sourceAssetId);
        if (!selected) throw Object.assign(new Error("missing"), { code: "archive-asset-missing" });
        return createReadStream(selected.path);
      },
    };
  }

  async function ensureOriginalAssetFixtures(): Promise<void> {
    const fixtureNames = ["cover", "selected", "alternate", "unbound"] as const;
    for (const [index, original] of originals.entries()) {
      const storagePath = `originals/${original.contentHash}.png`;
      await pool.query(
        `INSERT INTO assets (
           id,owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length,
           pixel_width,pixel_height,technical_metadata
         ) VALUES ($1,$2,$3,'filesystem',$4,'image/png',$5,2,2,'{}'::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [original.id, ownerUserId, original.contentHash, storagePath, original.bytes.byteLength],
      );
      const name = fixtureNames[index]!;
      await pool.query(
        `UPDATE asset_library_entries
            SET title=$3,reuse_scope=$4,review_status='eligible',
                archived_at=CASE WHEN $3='unbound' THEN COALESCE(archived_at,created_at) ELSE NULL END
          WHERE owner_user_id=$1 AND asset_id=$2`,
        [ownerUserId, original.id, name, name === "unbound" ? "owner_library" : name === "cover" ? "world" : "campaign"],
      );
    }
  }

  async function exportArchive() {
    await ensureOriginalAssetFixtures();
    const snapshots = createPostgresSystemArchiveExportRepository(pool, {
      pageSize: 2,
      sourceApplicationVersion: "0.1.0",
    });
    const publication = memoryPublisher();
    const writer = await createFilesystemSystemArchiveWriter({
      limits,
      staging: memoryStaging(),
      publisher: publication.publisher,
    });
    const result = await runSystemExport(job(ownerUserId), {
      snapshots,
      originals: originalsReader(),
      writer,
      jobs: fakeJobs(),
    });
    if (result.status !== "published") throw new Error("Expected a published System Archive fixture.");
    return { result, writer, bytes: publication.read(result.artifact.relativePath) };
  }

  async function withStagedArchive<Result>(
    bytes: Buffer,
    archiveLimits: typeof limits,
    work: (staged: Awaited<ReturnType<typeof stageArchiveUpload>>) => Promise<Result>,
  ): Promise<Result> {
    const staged = await stageArchiveUpload(Readable.from(bytes), archiveRoot, archiveLimits);
    try {
      return await work(staged);
    } finally {
      await rm(staged.absolutePath, { force: true });
    }
  }

  it("exports exhaustive logical authority, all retained originals, and no excluded state", async () => {
    const first = await exportArchive();
    const second = await exportArchive();

    expect(first.result.report.domainCounts["turn-corrections"]).toBe(1);
    expect(first.result.report.originalAssets).toBe(4);
    expect(first.result.report.excludedOperationalWork.chronicle).toBeGreaterThan(0);
    expect(first.result.artifact.contentFingerprint).toBe(second.result.artifact.contentFingerprint);

    const { zip, serialized } = await archiveText(first.bytes);
    const manifest = systemArchiveManifestSchema.parse(
      JSON.parse(await zip.file("manifest.json")!.async("string")),
    );
    expect(manifest).toMatchObject({
      sourceApplication: "0.1.0",
      sourceMigration: "0079_resumable_system_archive_uploads",
      sourceInstallationId: ownerUserId,
      sourceOwnerCount: 1,
      sourceOwner: {
        sourceId: ownerUserId,
        displayName: "Initial Owner",
      },
    });
    expect(manifest.omittedOperationalRows).toBe(
      Object.values(first.result.report.excludedOperationalWork).reduce((total, count) => total + count, 0),
    );
    const assetPayload = systemArchiveAssetsPayloadSchema.parse(
      JSON.parse(await zip.file("assets/assets.json")!.async("string")),
    );
    expect(assetPayload.assets.find((asset) => asset.sourceAssetId === originals[0]!.id)?.bindings)
      .toEqual(expect.arrayContaining([
        { role: "world_cover", worldId },
        { role: "world_version_asset", worldId, worldVersionId },
      ]));
    const providerEntry = Object.values(zip.files)
      .find((entry) => entry.name.startsWith("records/providers/") && !entry.dir);
    const portableProvider = JSON.parse((await providerEntry!.async("string")).trim()) as {
      record: { baseUrl: string; timeoutMs: number };
    };
    expect(portableProvider.record).toMatchObject({
      baseUrl: "https://portable.invalid/v1",
      timeoutMs: 654321,
    });
    const promptRecords = (await Promise.all(Object.values(zip.files)
      .filter((entry) => entry.name.startsWith("records/prompts/") && !entry.dir)
      .map((entry) => entry.async("string"))))
      .flatMap((entry) => entry.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
        record: { campaignId: string | null; templateKey: string; overrideText: string };
      }));
    expect(promptRecords.map((entry) => entry.record)).toEqual(expect.arrayContaining([
      expect.objectContaining({ campaignId: null, templateKey: "story_system", overrideText: "Portable prompt" }),
      expect.objectContaining({ campaignId, templateKey: "story_system", overrideText: "Campaign portable prompt" }),
    ]));
    const correctionRecord = JSON.parse((await Object.values(zip.files)
      .find((entry) => entry.name.startsWith("records/turn-corrections/") && !entry.dir)!
      .async("string")).trim()) as { record: Record<string, unknown> };
    expect(correctionRecord.record).toMatchObject({
      turnId,
      revision: 1,
      previousEffectiveNarrationHash: sha256("The gate opens."),
      reason: "Preserve accepted wording.",
      source: "user_edit",
    });
    const chronicleRecords = (await Promise.all(Object.values(zip.files)
      .filter((entry) => entry.name.startsWith("records/chronicle/") && !entry.dir)
      .map((entry) => entry.async("string"))))
      .flatMap((entry) => entry.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
        record: Record<string, unknown>;
      }));
    expect(chronicleRecords.find((entry) => entry.record.kind === "memory")?.record).toMatchObject({
      turnId,
      memoryKind: "turn_fiction",
    });
    expect(chronicleRecords.find((entry) => entry.record.kind === "summary-checkpoint")?.record).toMatchObject({
      throughTurn: 1,
      summaryKind: "campaign_summary",
      content: "The gate opened.",
      metadata: { openThreadIds: [checkpointOpenThreadId] },
    });
    expect(serialized).not.toContain("encrypted_api_key");
    expect(serialized).not.toContain("provider-password");
    expect(serialized).not.toContain("provider-query-secret");
    expect(serialized).not.toContain("provider-fragment-secret");
    expect(serialized).not.toContain("world_share_links");
    expect(serialized).not.toContain("chronicle_memory_chunks");
    expect(serialized).not.toContain("must-not-export chunk");
    expect(serialized).not.toContain("world-share-capability");
    expect(serialized).not.toContain("world-passthrough-must-not-export");
    expect(serialized).not.toContain("classifier-input-hash-must-not-export");
    expect(serialized).not.toContain("classifier-diagnostic-must-not-export");
    const history = (await Promise.all(Object.values(zip.files)
      .filter((entry) => entry.name.startsWith("records/campaign-history/") && !entry.dir)
      .map((entry) => entry.async("string"))))
      .flatMap((entry) => entry.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
        record: { eventType: string; content: string };
      }));
    const acceptedTurnMode = history.find((entry) => entry.record.eventType === "accepted-turn-mode");
    expect(acceptedTurnMode).toBeDefined();
    expect(JSON.parse(acceptedTurnMode!.record.content)).toMatchObject({ inputMode: "scene", inputModeSource: "auto" });
    const stateEntry = Object.values(zip.files)
      .find((entry) => entry.name.startsWith("records/campaign-state/") && !entry.dir);
    const currentState = JSON.parse((await stateEntry!.async("string")).trim()) as {
      record: { state: { continuitySummary: string; openThreads: string[] } };
    };
    expect(currentState.record.state).toMatchObject({
      continuitySummary: "Portable current continuity",
      openThreads: ["Find the gate key"],
    });
    for (const original of originals) {
      expect(zip.file(`assets/sha256/${original.contentHash.slice(0, 2)}/${original.contentHash}.png`)).not.toBeNull();
    }
    const inventory = JSON.parse(await zip.file("assets/assets.json")!.async("string")) as { assets: unknown[] };
    expect(inventory.assets).toHaveLength(4);
    expect(serialized).toContain("The gate opens silently.");
  });

  it("validates the exported System Archive into a non-mutating logical preview", async () => {
    const exported = await exportArchive();
    const preview = await withStagedArchive(
      exported.bytes,
      limits,
      (staged) => inspectSystemArchiveForPreview(staged, limits),
    );

    expect(preview).toMatchObject({
      formatVersion: 1,
      sourceApplication: "0.1.0",
      sourceMigration: "0079_resumable_system_archive_uploads",
      archiveFingerprint: exported.result.artifact.contentFingerprint,
      sourceOwnerCount: 1,
      assetCount: 4,
      disabledProviderCount: 1,
    });
    expect(preview.recordsByDomain.campaigns).toBe(1);
    expect(preview.recordsByDomain.turns).toBe(1);
    expect(preview.assetBytes).toBe(originals.reduce((total, original) => total + original.bytes.byteLength, 0));
    expect(preview.rebuilds).toEqual({
      chronicleIndex: { category: "chronicle-index", status: "pending", itemCount: 1 },
      assetThumbnails: { category: "asset-thumbnails", status: "pending", itemCount: 4 },
    });
  });

  it("issues only safe 30-minute preview authority after empty-destination and capacity checks", async () => {
    const exported = await exportArchive();
    await withStagedArchive(exported.bytes, limits, async (staged) => {
      const createPreview = vi.fn(async (
        _owner: Readonly<{ ownerUserId: string }>,
        _request: Readonly<{ projection: Readonly<Record<string, unknown>> }>,
      ) => ({
        jobId: randomUUID(),
        previewHandle: "opaque-preview-authority-token",
        expiresAt: "2026-08-25T12:30:00.000Z",
      }));
      const destination = {
        initialOwnerId: ownerUserId,
        latestMigration: "0079_resumable_system_archive_uploads",
        authoritativeCountsHash: sha256("empty-authority"),
        activeJobsHash: sha256("no-active-work"),
        checkedAt: "2026-08-25T12:00:00.000Z",
        destinationEmpty: true,
      } as const;
      const service = createSystemArchiveImportPreviewService({
        imports: {
          destinationFingerprint: vi.fn(async () => destination),
          createPreview,
        },
        source: {
          async withCompletedUpload(_owner, _uploadId, inspect) {
            return inspect(staged);
          },
        },
        capacity: {
          availableBytes: vi.fn(async () => ({
            staging: exported.bytes.byteLength * 2,
            assetRoot: originals.reduce((total, original) => total + original.bytes.byteLength, 0) * 2,
          })),
        },
        limits,
        destinationApplicationVersion: "0.1.0",
        allowUnknownFreeSpace: false,
      });

      const preview = await service.preview({ ownerUserId }, randomUUID());
      expect(preview).toMatchObject({
        valid: true,
        previewHandle: "opaque-preview-authority-token",
        versions: {
          archiveFormat: 1,
          sourceApplication: "0.1.0",
          sourceMigration: "0079_resumable_system_archive_uploads",
          destinationApplication: "0.1.0",
          destinationMigration: "0079_resumable_system_archive_uploads",
        },
        archiveFingerprint: exported.result.artifact.contentFingerprint,
        destinationEmpty: true,
        ownerMapping: { sourceOwnerId: ownerUserId, destinationOwnerId: ownerUserId },
        disabledProviders: 1,
        space: {
          staging: { verified: true, sufficient: true, overrideUsed: false },
          assetRoot: { verified: true, sufficient: true, overrideUsed: false },
        },
        expiresAt: "2026-08-25T12:30:00.000Z",
      });
      expect(createPreview).toHaveBeenCalledOnce();
      const persistedProjection = createPreview.mock.calls[0]![1].projection;
      expect(JSON.stringify(persistedProjection)).not.toContain(archiveRoot);
      expect(persistedProjection).not.toHaveProperty("previewHandle");
    });
  });

  it("rejects a source migration watermark newer than the supported destination", async () => {
    const exported = await exportArchive();
    const zip = await JSZip.loadAsync(exported.bytes);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string")) as Record<string, unknown>;
    manifest.sourceMigration = "0080_future_system_archive_shape";
    zip.file("manifest.json", JSON.stringify(manifest));
    const newer = await zip.generateAsync({ type: "nodebuffer" });

    await withStagedArchive(newer, limits, async (staged) => {
      const createPreview = vi.fn();
      const service = createSystemArchiveImportPreviewService({
        imports: {
          destinationFingerprint: vi.fn(async () => ({
            initialOwnerId: ownerUserId,
            latestMigration: "0079_resumable_system_archive_uploads",
            authoritativeCountsHash: sha256("empty-authority"),
            activeJobsHash: sha256("no-active-work"),
            checkedAt: "2026-08-25T12:00:00.000Z",
            destinationEmpty: true,
          })),
          createPreview,
        },
        source: {
          async withCompletedUpload(_owner, _uploadId, inspect) {
            return inspect(staged);
          },
        },
        capacity: { availableBytes: vi.fn(async () => ({ staging: 10_000_000, assetRoot: 10_000_000 })) },
        limits,
        destinationApplicationVersion: "0.1.0",
        allowUnknownFreeSpace: false,
      });

      await expect(service.preview({ ownerUserId }, randomUUID())).resolves.toMatchObject({
        valid: false,
        previewHandle: null,
        versions: { sourceMigration: "0080_future_system_archive_shape" },
        errors: ["archive-version-unsupported"],
      });
      expect(createPreview).not.toHaveBeenCalled();
    });
  });

  it("validates the complete preview projection before creating opaque authority", async () => {
    const exported = await exportArchive();
    await withStagedArchive(exported.bytes, limits, async (staged) => {
      const createPreview = vi.fn(async () => ({
        jobId: randomUUID(),
        previewHandle: "authority-must-not-be-created",
        expiresAt: "2026-08-25T12:30:00.000Z",
      }));
      const service = createSystemArchiveImportPreviewService({
        imports: {
          destinationFingerprint: vi.fn(async () => ({
            initialOwnerId: ownerUserId,
            latestMigration: "0079_resumable_system_archive_uploads",
            authoritativeCountsHash: sha256("empty-authority"),
            activeJobsHash: sha256("no-active-work"),
            checkedAt: "2026-08-25T12:00:00.000Z",
            destinationEmpty: true,
          })),
          createPreview,
        },
        source: {
          async withCompletedUpload(_owner, _uploadId, inspect) {
            return inspect(staged);
          },
        },
        capacity: {
          availableBytes: vi.fn(async () => ({
            staging: exported.bytes.byteLength * 2,
            assetRoot: originals.reduce((total, original) => total + original.bytes.byteLength, 0) * 2,
          })),
        },
        limits,
        destinationApplicationVersion: "x".repeat(101),
        allowUnknownFreeSpace: false,
      });

      await expect(service.preview({ ownerUserId }, randomUUID())).rejects.toThrow();
      expect(createPreview).not.toHaveBeenCalled();
    });
  });

  it("fails closed without creating preview authority for a non-empty destination and insufficient space", async () => {
    const exported = await exportArchive();
    await withStagedArchive(exported.bytes, limits, async (staged) => {
      const createPreview = vi.fn();
      const service = createSystemArchiveImportPreviewService({
        imports: {
          destinationFingerprint: vi.fn(async () => ({
            initialOwnerId: ownerUserId,
            latestMigration: "0079_resumable_system_archive_uploads",
            authoritativeCountsHash: sha256("empty-authority"),
            activeJobsHash: sha256("no-active-work"),
            checkedAt: "2026-08-25T12:00:00.000Z",
            destinationEmpty: false,
          })),
          createPreview,
        },
        source: {
          async withCompletedUpload(_owner, _uploadId, inspect) {
            return inspect(staged);
          },
        },
        capacity: { availableBytes: vi.fn(async () => ({ staging: null, assetRoot: 0 })) },
        limits,
        destinationApplicationVersion: "0.1.0",
        allowUnknownFreeSpace: false,
      });

      const preview = await service.preview({ ownerUserId }, randomUUID());
      expect(preview).toMatchObject({
        valid: false,
        previewHandle: null,
        errors: ["archive-destination-not-empty", "archive-storage-insufficient"],
        expiresAt: null,
        space: {
          staging: { verified: false, sufficient: false, overrideUsed: false },
          assetRoot: { verified: true, sufficient: false, overrideUsed: false },
        },
      });
      expect(preview.warnings).toEqual([
        expect.stringContaining("cannot be authorized without an operator override"),
      ]);
      expect(preview.warnings).not.toEqual(expect.arrayContaining([
        expect.stringContaining("override was used"),
      ]));
      expect(createPreview).not.toHaveBeenCalled();
    });
  });

  it("marks the explicit operator override when free space cannot be measured", async () => {
    const exported = await exportArchive();
    await withStagedArchive(exported.bytes, limits, async (staged) => {
      const createPreview = vi.fn(async () => ({
        jobId: randomUUID(),
        previewHandle: "opaque-unknown-capacity-authority",
        expiresAt: "2026-08-25T12:30:00.000Z",
      }));
      const service = createSystemArchiveImportPreviewService({
        imports: {
          destinationFingerprint: vi.fn(async () => ({
            initialOwnerId: ownerUserId,
            latestMigration: "0079_resumable_system_archive_uploads",
            authoritativeCountsHash: sha256("empty-authority"),
            activeJobsHash: sha256("no-active-work"),
            checkedAt: "2026-08-25T12:00:00.000Z",
            destinationEmpty: true,
          })),
          createPreview,
        },
        source: {
          async withCompletedUpload(_owner, _uploadId, inspect) {
            return inspect(staged);
          },
        },
        capacity: { availableBytes: vi.fn(async () => ({ staging: null, assetRoot: null })) },
        limits,
        destinationApplicationVersion: "0.1.0",
        allowUnknownFreeSpace: true,
      });

      await expect(service.preview({ ownerUserId }, randomUUID())).resolves.toMatchObject({
        valid: true,
        warnings: expect.arrayContaining([
          expect.stringContaining("operator override"),
        ]),
        space: {
          staging: { verified: false, sufficient: true, overrideUsed: true },
          assetRoot: { verified: false, sufficient: true, overrideUsed: true },
        },
      });
      expect(createPreview).toHaveBeenCalledOnce();
    });
  });

  it("rejects broken System Archive relationships before preview authority exists", async () => {
    const exported = await exportArchive();
    const zip = await JSZip.loadAsync(exported.bytes);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string")) as {
      contentFingerprint: string;
      entries: { path: string; logicalType: string; mediaType: string; byteLength: number; sha256: string }[];
    };
    const campaignEntry = manifest.entries.find((entry) => entry.path.startsWith("records/campaigns/"))!;
    const line = JSON.parse((await zip.file(campaignEntry.path)!.async("string")).trim()) as {
      record: { worldVersionId: string };
    };
    line.record.worldVersionId = randomUUID();
    const bytes = Buffer.from(`${JSON.stringify(line)}\n`, "utf8");
    zip.file(campaignEntry.path, bytes);
    campaignEntry.byteLength = bytes.byteLength;
    campaignEntry.sha256 = sha256(bytes);
    const payloadHashes = manifest.entries
      .filter((entry) => entry.logicalType !== "asset-original")
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((entry) => entry.sha256);
    const originalAssetHashes = manifest.entries
      .filter((entry) => entry.logicalType === "asset-original")
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((entry) => entry.sha256);
    manifest.contentFingerprint = createHash("sha256")
      .update(JSON.stringify({ originalAssetHashes: [...originalAssetHashes].sort(), payloadHashes: [...payloadHashes].sort() }))
      .digest("hex");
    zip.file("manifest.json", JSON.stringify(manifest));
    const malformed = await zip.generateAsync({ type: "nodebuffer" });

    await withStagedArchive(malformed, limits, async (staged) => {
      await expect(inspectSystemArchiveForPreview(staged, limits)).rejects.toMatchObject({
        code: "archive-world-mismatch",
      });
    });
  });

  it.each(["entity relationship", "selected character"] as const)(
    "rejects an invalid world-content %s before preview authority exists",
    async (invalidRelationship) => {
      const exported = await exportArchive();
      const zip = await JSZip.loadAsync(exported.bytes);
      const manifest = JSON.parse(await zip.file("manifest.json")!.async("string")) as MutableSystemManifest;
      const versionEntry = manifest.entries.find((entry) => entry.path.startsWith("records/world-versions/"))!;
      const version = JSON.parse((await zip.file(versionEntry.path)!.async("string")).trim()) as {
        record: {
          content: {
            relationships: unknown[];
            defaults: { selectedCharacterId: string | null };
          };
        };
      };
      if (invalidRelationship === "entity relationship") {
        version.record.content.relationships = [{
          id: "broken-relationship",
          fromEntityId: "missing-from-entity",
          toEntityId: "missing-to-entity",
          kind: "knows",
          description: "Both endpoints are absent."
        }];
      } else {
        version.record.content.defaults.selectedCharacterId = "missing-playable-character";
      }
      const bytes = Buffer.from(`${JSON.stringify(version)}\n`, "utf8");
      zip.file(versionEntry.path, bytes);
      versionEntry.byteLength = bytes.byteLength;
      versionEntry.sha256 = sha256(bytes);
      refreshSystemFingerprint(manifest);
      zip.file("manifest.json", JSON.stringify(manifest));

      await withStagedArchive(await zip.generateAsync({ type: "nodebuffer" }), limits, async (staged) => {
        await expect(inspectSystemArchiveForPreview(staged, limits)).rejects.toMatchObject({
          code: "archive-world-mismatch",
        });
      });
    }
  );

  it.each(["turn", "world-version"] as const)(
    "requires generation-context %s authority to include its matching parent scope",
    async (bindingKind) => {
      const exported = await exportArchive();
      const zip = await JSZip.loadAsync(exported.bytes);
      const manifest = JSON.parse(await zip.file("manifest.json")!.async("string")) as MutableSystemManifest;
      const readFirstRecord = async (domain: string) => {
        const entry = manifest.entries.find((candidate) => candidate.path.startsWith(`records/${domain}/`))!;
        return JSON.parse((await zip.file(entry.path)!.async("string")).trim()) as {
          sourceId: string;
          record: Record<string, unknown>;
        };
      };
      const turn = await readFirstRecord("turns");
      const worldVersion = await readFirstRecord("world-versions");
      const binding = {
        role: "generation_context",
        campaignId: null,
        worldId: null,
        worldVersionId: bindingKind === "world-version" ? worldVersion.sourceId : null,
        turnId: bindingKind === "turn" ? turn.sourceId : null,
        sourceContextId: randomUUID(),
      };
      manifest.assets[0]!.bindings.push(binding);
      const assetsEntry = manifest.entries.find((entry) => entry.path === "assets/assets.json")!;
      const assetsPayload = JSON.parse(await zip.file(assetsEntry.path)!.async("string")) as {
        assets: Array<{ bindings: unknown[] }>;
      };
      assetsPayload.assets[0]!.bindings.push(binding);
      const assetsBytes = Buffer.from(JSON.stringify(assetsPayload), "utf8");
      zip.file(assetsEntry.path, assetsBytes);
      assetsEntry.byteLength = assetsBytes.byteLength;
      assetsEntry.sha256 = sha256(assetsBytes);
      refreshSystemFingerprint(manifest);
      zip.file("manifest.json", JSON.stringify(manifest));

      await withStagedArchive(await zip.generateAsync({ type: "nodebuffer" }), limits, async (staged) => {
        await expect(inspectSystemArchiveForPreview(staged, limits)).rejects.toMatchObject({
          code: "archive-world-mismatch",
        });
      });
    }
  );

  it("rejects corrupt Original Assets and multiple-owner manifests during preview", async () => {
    const exported = await exportArchive();
    const corruptZip = await JSZip.loadAsync(exported.bytes);
    const assetPath = Object.keys(corruptZip.files).find((path) => path.startsWith("assets/sha256/") && !corruptZip.files[path]!.dir)!;
    corruptZip.file(assetPath, Buffer.from("not an image"));
    const corrupt = await corruptZip.generateAsync({ type: "nodebuffer" });
    await withStagedArchive(corrupt, limits, async (staged) => {
      await expect(inspectSystemArchiveForPreview(staged, limits)).rejects.toMatchObject({
        code: expect.stringMatching(/^archive-(checksum-mismatch|asset-invalid)$/),
      });
    });

    const ownersZip = await JSZip.loadAsync(exported.bytes);
    const manifest = JSON.parse(await ownersZip.file("manifest.json")!.async("string")) as Record<string, unknown>;
    manifest.sourceOwnerCount = 2;
    ownersZip.file("manifest.json", JSON.stringify(manifest));
    const multipleOwners = await ownersZip.generateAsync({ type: "nodebuffer" });
    await withStagedArchive(multipleOwners, limits, async (staged) => {
      await expect(inspectSystemArchiveForPreview(staged, limits)).rejects.toMatchObject({
        code: "archive-owner-count-unsupported",
      });
    });
  });

  it("inherits unsafe-name, Unicode-duplicate, and expansion defenses for System Preview", async () => {
    const unsafeZip = new JSZip();
    unsafeZip.file("C:/private/system.json", "{}", { createFolders: false });
    const unsafe = await unsafeZip.generateAsync({ type: "nodebuffer" });
    await withStagedArchive(unsafe, limits, async (staged) => {
      await expect(inspectSystemArchiveForPreview(staged, limits)).rejects.toMatchObject({
        code: "archive-entry-unsafe",
      });
    });

    const duplicateZip = new JSZip();
    duplicateZip.file("records/caf\u00e9.ndjson", "{}\n", { createFolders: false });
    duplicateZip.file("records/cafe\u0301.ndjson", "{}\n", { createFolders: false });
    const duplicate = await duplicateZip.generateAsync({ type: "nodebuffer" });
    await withStagedArchive(duplicate, limits, async (staged) => {
      await expect(inspectSystemArchiveForPreview(staged, limits)).rejects.toMatchObject({
        code: "archive-entry-duplicate",
      });
    });

    const expansionZip = new JSZip();
    expansionZip.file("system.json", Buffer.alloc(64 * 1024), { createFolders: false });
    const expansion = await expansionZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    await withStagedArchive(expansion, limits, async (staged) => {
      await expect(inspectSystemArchiveForPreview(staged, {
        ...limits,
        maxExpansionRatio: 1,
      })).rejects.toMatchObject({ code: "archive-limit-exceeded" });
    });
  });

  it("counts every active or retryable excluded generation and illustration job family", async () => {
    const snapshots = createPostgresSystemArchiveExportRepository(pool, {
      pageSize: 2,
      sourceApplicationVersion: "0.1.0",
    });
    const before = await snapshots.withOwnerSnapshot(
      { ownerUserId },
      (snapshot) => snapshot.summarizeExcludedOperationalWork(),
    );
    const references = await pool.query<{
      campaign_id: string;
      turn_id: string;
      world_version_id: string;
      provider_profile_id: string;
      provider_type: string;
    }>(
      `SELECT campaigns.id AS campaign_id,turns.id AS turn_id,campaigns.world_version_id,
              provider_profiles.id AS provider_profile_id,provider_profiles.provider_type
         FROM campaigns
         JOIN turns ON turns.campaign_id=campaigns.id AND turns.owner_user_id=campaigns.owner_user_id
         CROSS JOIN LATERAL (
           SELECT id,provider_type FROM provider_profiles
            WHERE owner_user_id=campaigns.owner_user_id ORDER BY id LIMIT 1
         ) provider_profiles
        WHERE campaigns.owner_user_id=$1 ORDER BY campaigns.id LIMIT 1`,
      [ownerUserId],
    );
    const reference = references.rows[0]!;
    const activeCampaigns = await pool.query<{ id: string }>(
      `INSERT INTO campaigns (owner_user_id,world_version_id,title)
       SELECT $1,$2,'Excluded work ' || value::text
         FROM generate_series(1,3) value RETURNING id`,
      [ownerUserId, reference.world_version_id],
    );
    for (const [index, status] of ["replacement_queued", "assessing", "recoverable"].entries()) {
      await pool.query(
        `INSERT INTO generation_jobs (
           owner_user_id,campaign_id,provider_profile_id,idempotency_key,
           expected_turn_number,action,status
         ) VALUES ($1,$2,$3,$4,1,'Excluded active work',$5)`,
        [ownerUserId, activeCampaigns.rows[index]!.id, reference.provider_profile_id, randomUUID(), status],
      );
    }
    await pool.query(
      `INSERT INTO image_jobs (
         owner_user_id,campaign_id,turn_id,provider_profile_id,requested_model,prompt,
         prompt_hash,status,provider_type,target_type
       ) VALUES ($1,$2,$3,$4,'excluded-model','Excluded retryable image','excluded-image',
                 'recoverable',$5,'turn_illustration')`,
      [ownerUserId, reference.campaign_id, reference.turn_id,
        reference.provider_profile_id, reference.provider_type],
    );
    for (const status of ["queued", "matching", "recoverable", "generation_queued"]) {
      await pool.query(
        `INSERT INTO illustration_resolution_jobs (
           owner_user_id,campaign_id,turn_id,source_policy,matching_scope,
           confidence_profile,status
         ) VALUES ($1,$2,NULL,'library_then_generate','owner_library','balanced',$3)`,
        [ownerUserId, reference.campaign_id, status],
      );
    }

    const after = await snapshots.withOwnerSnapshot(
      { ownerUserId },
      (snapshot) => snapshot.summarizeExcludedOperationalWork(),
    );

    expect((after.generation ?? 0) - (before.generation ?? 0)).toBe(3);
    expect((after.illustration ?? 0) - (before.illustration ?? 0)).toBe(5);
    expect(Object.keys(after).sort()).toEqual([
      "chronicle", "generation", "illustration", "imports", "system-archive"
    ]);
  });

  it.each([
    ["missing", "archive-asset-missing"],
    ["changed", "archive-asset-invalid"],
  ] as const)("prevents publication when an inventoried original is %s", async (failure, code) => {
    const staging = memoryStaging();
    const writer = await createFilesystemSystemArchiveWriter({
      limits,
      staging,
      publisher: memoryPublisher().publisher,
    });
    const jobs = fakeJobs();
    const before = await writer.unpublishedArtifactCount();
    const reader: SystemArchiveExportDependencies["originals"] = {
      async openOriginal(input) {
        if (input.asset.sourceAssetId === originals[3]!.id) {
          if (failure === "missing") throw Object.assign(new Error("missing"), { code });
          return ReadableStreamFrom([Buffer.from("changed original")]);
        }
        return createReadStream(originals.find((candidate) => candidate.id === input.asset.sourceAssetId)!.path);
      },
    };

    await expect(runSystemExport(job(ownerUserId), {
      snapshots: createPostgresSystemArchiveExportRepository(pool, {
        pageSize: 2,
        sourceApplicationVersion: "0.1.0",
      }),
      originals: reader,
      writer,
      jobs,
    })).rejects.toMatchObject({ code });

    expect(jobs.markFailed).toHaveBeenCalledWith(expect.anything(), code);
    expect(await writer.unpublishedArtifactCount()).toBe(before);
    expect(staging.activeEntryCount()).toBe(0);
  });

  it("never removes an atomically published archive when abort is called afterward", async () => {
    const { result, writer, bytes } = await exportArchive();

    await writer.abort();

    expect(result.status).toBe("published");
    expect(bytes.subarray(0, 2).toString("ascii")).toBe("PK");
  });

  it("never writes System Archive spool data into the operating-system temp directory", async () => {
    const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("infinitequest-system-export-")));
    const staging = memoryStaging();
    const writer = await createFilesystemSystemArchiveWriter({
      limits,
      staging,
      publisher: memoryPublisher().publisher,
    });
    try {
      await writer.writeSystemMetadata({
        sourceId: ownerUserId,
        sourceInstallationId: ownerUserId,
        displayName: "Initial Owner",
      });
      const created = (await readdir(tmpdir()))
        .filter((name) => name.startsWith("infinitequest-system-export-") && !before.has(name));
      expect(created).toEqual([]);
    } finally {
      await writer.abort();
    }
    expect(staging.activeEntryCount()).toBe(0);
  });

  it("removes only unpublished local and staged artifacts when cancellation wins during publish", async () => {
    const staging = memoryStaging();
    const publishSystemArchive = vi.fn(async () => {
      throw new Error("durable publisher must not be called after cancellation wins");
    });
    const writer = await createFilesystemSystemArchiveWriter({
      limits,
      staging,
      publisher: { publishSystemArchive },
    });
    const metadata = await writer.writeSystemMetadata({
      sourceId: ownerUserId,
      sourceInstallationId: ownerUserId,
      displayName: "Initial Owner",
    });
    const contentFingerprint = await writer.calculateContentFingerprint({
      payloadHashes: [metadata.sha256],
      originalAssetHashes: [],
    });
    let checks = 0;

    await expect(writer.publish({
      manifest: {
        sourceApplication: "0.1.0",
        sourceMigration: "0079_resumable_system_archive_uploads",
        sourceInstallationId: ownerUserId,
        sourceOwnerCount: 1,
        sourceOwner: {
          sourceId: ownerUserId,
          sourceInstallationId: ownerUserId,
          displayName: "Initial Owner",
        },
        domainCounts: Object.fromEntries(
          SYSTEM_ARCHIVE_DOMAINS.map((domain) => [domain, 0]),
        ) as Record<(typeof SYSTEM_ARCHIVE_DOMAINS)[number], number>,
        excludedOperationalWork: emptyOperationalOmissions,
        assets: [],
      },
      contentFingerprint,
      cancellationRequested: async () => ++checks === 2,
    })).resolves.toEqual({ status: "cancelled" });

    expect(checks).toBe(2);
    expect(publishSystemArchive).not.toHaveBeenCalled();
    expect(staging.activeEntryCount()).toBe(0);
    await expect(stat(join(archiveRoot, "artifacts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts pre-publication cancellation when durable scratch cleanup must be retried", async () => {
    const staging = memoryStaging({ cleanupFailures: 1 });
    const writer = await createFilesystemSystemArchiveWriter({
      limits,
      staging,
      publisher: {
        async publishSystemArchive() {
          throw new Error("durable publisher must not run after cancellation");
        },
      },
    });
    const metadata = await writer.writeSystemMetadata({
      sourceId: ownerUserId,
      sourceInstallationId: ownerUserId,
      displayName: "Initial Owner",
    });
    const contentFingerprint = await writer.calculateContentFingerprint({
      payloadHashes: [metadata.sha256],
      originalAssetHashes: [],
    });

    await expect(writer.publish({
      manifest: {
        sourceApplication: "0.1.0",
        sourceMigration: "0079_resumable_system_archive_uploads",
        sourceInstallationId: ownerUserId,
        sourceOwnerCount: 1,
        sourceOwner: {
          sourceId: ownerUserId,
          sourceInstallationId: ownerUserId,
          displayName: "Initial Owner",
        },
        domainCounts: Object.fromEntries(
          SYSTEM_ARCHIVE_DOMAINS.map((domain) => [domain, 0]),
        ) as Record<(typeof SYSTEM_ARCHIVE_DOMAINS)[number], number>,
        excludedOperationalWork: emptyOperationalOmissions,
        assets: [],
      },
      contentFingerprint,
      cancellationRequested: async () => true,
    })).resolves.toEqual({ status: "cancelled" });
    expect(staging.activeEntryCount()).toBe(1);
  });

  it.runIf(supportsSecureGeneratedArchiveStaging())(
    "cleans durable private spool authority when publication fails",
    async () => {
      const privateRoot = await mkdtemp(join(tmpdir(), "infinitequest-system-private-spool-"));
      const privateAssetRoot = join(privateRoot, "assets-root");
      await mkdir(privateAssetRoot, { recursive: true });
      const storage = await createAssetImportStorageComposition(pool, {
        archiveRoot: privateRoot,
        assetRoot: privateAssetRoot,
      });
      const leaseOwner = `system-archive-spool-${randomUUID()}`;
      const staging = createPrivateSystemArchiveStaging(storage.adapter, {
        leaseOwner,
        artifactTtlSeconds: 86_400,
      });
      const writer = await createFilesystemSystemArchiveWriter({
        limits,
        staging,
        publisher: {
          async publishSystemArchive() {
            throw new Error("forced durable publication failure");
          },
        },
      });
      try {
        const metadata = await writer.writeSystemMetadata({
          sourceId: ownerUserId,
          sourceInstallationId: ownerUserId,
          displayName: "Initial Owner",
        });
        const contentFingerprint = await writer.calculateContentFingerprint({
          payloadHashes: [metadata.sha256],
          originalAssetHashes: [],
        });
        const domainCounts = Object.fromEntries(
          SYSTEM_ARCHIVE_DOMAINS.map((domain) => [domain, 0]),
        ) as Record<(typeof SYSTEM_ARCHIVE_DOMAINS)[number], number>;

        await expect(writer.publish({
          manifest: {
            sourceApplication: "0.1.0",
            sourceMigration: "0079_resumable_system_archive_uploads",
            sourceInstallationId: ownerUserId,
            sourceOwnerCount: 1,
            sourceOwner: {
              sourceId: ownerUserId,
              sourceInstallationId: ownerUserId,
              displayName: "Initial Owner",
            },
            domainCounts,
            excludedOperationalWork: emptyOperationalOmissions,
            assets: [],
          },
          contentFingerprint,
          cancellationRequested: async () => false,
        })).rejects.toThrow("forced durable publication failure");

        await expect(pool.query<{ status: string }>(
          `SELECT staged.status
             FROM portable_staged_inputs staged
             JOIN durable_filesystem_operations operation
               ON operation.id=staged.filesystem_operation_id
            WHERE staged.owner_user_id=$1 AND operation.lease_owner=$2`,
          [ownerUserId, leaseOwner],
        )).resolves.toMatchObject({ rows: [{ status: "cleaned" }, { status: "cleaned" }] });
        expect(await readdir(join(privateRoot, "staging"))).toEqual([]);
        expect(await readdir(join(privateRoot, "artifacts"))).toEqual([]);
      } finally {
        await storage.close();
        await rm(privateRoot, { recursive: true, force: true });
      }
    },
  );

  it("honors durable cancellation that wins before the next phase update", async () => {
    const leaseOwner = "system-archive-cancelled-worker";
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO system_archive_jobs (
         owner_user_id,kind,status,idempotency_key_hash,lease_owner,lease_expires_at
       ) VALUES ($1,'export','cancelling',$2,$3,clock_timestamp()+interval '1 minute')
       RETURNING id`,
      [ownerUserId, sha256("system-archive-cancel-before-phase"), leaseOwner],
    );
    const writer = await createFilesystemSystemArchiveWriter({
      limits,
      staging: memoryStaging(),
      publisher: memoryPublisher().publisher,
    });

    await expect(runSystemExport({
      id: inserted.rows[0]!.id,
      ownerUserId,
      leaseOwner,
    }, {
      snapshots: createPostgresSystemArchiveExportRepository(pool, {
        pageSize: 2,
        sourceApplicationVersion: "0.1.0",
      }),
      originals: originalsReader(),
      writer,
      jobs: createPostgresSystemArchiveExportJobPort(pool),
    })).resolves.toEqual({ status: "cancelled" });

    await expect(pool.query<{ status: string }>(
      "SELECT status FROM system_archive_jobs WHERE id=$1",
      [inserted.rows[0]!.id],
    )).resolves.toMatchObject({ rows: [{ status: "cancelled" }] });
    expect(await writer.unpublishedArtifactCount()).toBe(0);
  });

  it("rolls back every logical domain when an atomic System Import fails mid-graph", async () => {
    await pool.query("TRUNCATE TABLE worlds,provider_profiles,prompt_template_overrides,imports,activity_events RESTART IDENTITY CASCADE");
    await pool.query("DELETE FROM system_archive_jobs");
    await pool.query("DELETE FROM system_archive_uploads");
    const imports = createPostgresSystemArchiveImportRepository(pool, { previewTtlSeconds: 1_800 });
    const owner = { ownerUserId };
    const destination = await imports.destinationFingerprint(owner, {});
    expect(destination.destinationEmpty).toBe(true);
    const worldId = randomUUID();
    const invalidVersionId = randomUUID();
    const missingWorldId = randomUUID();
    const records = [
      systemRecordEnvelopeSchema.parse({
        domain: "worlds",
        formatVersion: 1,
        sourceId: worldId,
        record: {
          sourceId: worldId,
          title: "Rollback World",
          status: "active",
          createdAt: "2026-08-25T12:00:00.000Z",
          updatedAt: "2026-08-25T12:00:00.000Z",
        },
      }),
      systemRecordEnvelopeSchema.parse({
        domain: "world-versions",
        formatVersion: 1,
        sourceId: invalidVersionId,
        record: {
          sourceId: invalidVersionId,
          worldId: missingWorldId,
          versionNumber: 1,
          title: "Missing parent",
          content: worldContentSchema.parse({
            schemaVersion: 1,
            world: { title: "Missing parent", genre: "", tone: "", premise: "", backgroundStory: "", firstAction: "", rules: "" },
            playableCharacters: [], entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [],
            defaults: { selectedCharacterId: null, initialLocation: "" },
          }),
          contentFingerprint: null,
          releaseNotes: "",
          createdFromRevision: null,
          publishedAt: "2026-08-25T12:00:00.000Z",
        },
      }),
    ];

    await expect(imports.withAtomicImport(owner, {
      destination,
      ignore: {},
    }, async (transaction) => {
      await transaction.insertLogicalDomains(records);
    })).rejects.toMatchObject({ code: "23503" });

    await expect(pool.query<{ count: string }>("SELECT count(*)::text AS count FROM worlds"))
      .resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  it("restores global and campaign prompt overrides with the same key without collapsing scope", async () => {
    await pool.query("TRUNCATE TABLE worlds,provider_profiles,prompt_template_overrides,imports,activity_events RESTART IDENTITY CASCADE");
    await pool.query("DELETE FROM system_archive_jobs");
    await pool.query("DELETE FROM system_archive_uploads");
    const imports = createPostgresSystemArchiveImportRepository(pool, { previewTtlSeconds: 1_800 });
    const owner = { ownerUserId };
    const destination = await imports.destinationFingerprint(owner, {});
    const globalPromptId = randomUUID();
    const campaignPromptId = randomUUID();
    const worldId = randomUUID();
    const versionId = randomUUID();
    const campaignId = randomUUID();
    const timestamp = "2026-08-25T12:00:00.000Z";
    const records = [
      systemRecordEnvelopeSchema.parse({
        domain: "prompts", formatVersion: 1, sourceId: globalPromptId,
        record: {
          sourceId: globalPromptId, campaignId: null, templateKey: "story_system",
          overrideText: "Global story guidance.", updatedAt: timestamp,
        },
      }),
      systemRecordEnvelopeSchema.parse({
        domain: "prompts", formatVersion: 1, sourceId: campaignPromptId,
        record: {
          sourceId: campaignPromptId, campaignId, templateKey: "story_system",
          overrideText: "Campaign story guidance.", updatedAt: timestamp,
        },
      }),
      systemRecordEnvelopeSchema.parse({
        domain: "worlds", formatVersion: 1, sourceId: worldId,
        record: { sourceId: worldId, title: "Prompt World", status: "active", createdAt: timestamp, updatedAt: timestamp },
      }),
      systemRecordEnvelopeSchema.parse({
        domain: "world-versions", formatVersion: 1, sourceId: versionId,
        record: {
          sourceId: versionId, worldId, versionNumber: 1, title: "Prompt World",
          content: worldContentSchema.parse({
            schemaVersion: 1,
            world: { title: "Prompt World", genre: "", tone: "", premise: "", backgroundStory: "", firstAction: "", rules: "" },
            playableCharacters: [], entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [],
            defaults: { selectedCharacterId: null, initialLocation: "" },
          }),
          contentFingerprint: null, releaseNotes: "", createdFromRevision: null, publishedAt: timestamp,
        },
      }),
      systemRecordEnvelopeSchema.parse({
        domain: "campaigns", formatVersion: 1, sourceId: campaignId,
        record: {
          sourceId: campaignId, worldVersionId: versionId, title: "Prompt Campaign", status: "active", activeTurnNumber: 0,
          settings: { turnControlStyle: "Auto" }, createdAt: timestamp, updatedAt: timestamp,
        },
      }),
    ];

    await imports.withAtomicImport(owner, { destination, ignore: {} }, async (transaction) => {
      await transaction.insertLogicalDomains(records);
    });

    await expect(pool.query<{ id: string; campaign_id: string | null; content: string }>(
      `SELECT id,campaign_id,content FROM prompt_template_overrides
        WHERE owner_user_id=$1 AND prompt_key='story_system'
        ORDER BY campaign_id NULLS FIRST`,
      [ownerUserId],
    )).resolves.toMatchObject({ rows: [
      { id: globalPromptId, campaign_id: null, content: "Global story guidance." },
      { id: campaignPromptId, campaign_id: campaignId, content: "Campaign story guidance." },
    ] });
  });

  it("rolls back when the reported logical inventory does not match rows actually persisted", async () => {
    await pool.query("TRUNCATE TABLE worlds,provider_profiles,prompt_template_overrides,imports,activity_events RESTART IDENTITY CASCADE");
    await pool.query("DELETE FROM system_archive_jobs");
    await pool.query("DELETE FROM system_archive_uploads");
    const imports = createPostgresSystemArchiveImportRepository(pool, { previewTtlSeconds: 1_800 });
    const owner = { ownerUserId };
    const destination = await imports.destinationFingerprint(owner, {});
    const worldId = randomUUID();
    const recordsByDomain = Object.fromEntries(SYSTEM_ARCHIVE_DOMAINS.map((domain) => [domain, 0]));

    await expect(imports.withAtomicImport(owner, { destination, ignore: {} }, async (transaction) => {
      await transaction.insertLogicalDomains([systemRecordEnvelopeSchema.parse({
        domain: "worlds", formatVersion: 1, sourceId: worldId,
        record: {
          sourceId: worldId, title: "Unreconciled World", status: "active",
          createdAt: "2026-08-25T12:00:00.000Z", updatedAt: "2026-08-25T12:00:00.000Z",
        },
      })]);
      await transaction.recordImportReport(importReport({
        ownerUserId,
        recordsByDomain,
      }));
    })).rejects.toMatchObject({ statusCode: 409 });

    await expect(pool.query<{ count: string }>("SELECT count(*)::text AS count FROM worlds"))
      .resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  it("holds the real PostgreSQL exclusive gate against concurrent mutation permits", async () => {
    const exclusive = await pool.connect();
    let releaseExclusive!: () => void;
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolveEntered) => { signalEntered = resolveEntered; });
    const release = new Promise<void>((resolveRelease) => { releaseExclusive = resolveRelease; });
    try {
      await exclusive.query("BEGIN");
      const held = withExclusiveSystemImport(exclusive, async () => {
        signalEntered();
        await release;
      });
      await entered;
      await expect(withSystemMutationPermit(pool, async () => "mutated"))
        .rejects.toMatchObject({ statusCode: 503, code: "system-import-in-progress" });
      releaseExclusive();
      await held;
      await exclusive.query("COMMIT");
    } finally {
      releaseExclusive?.();
      await exclusive.query("ROLLBACK").catch(() => undefined);
      exclusive.release();
    }
  });

  it("relinquishes a contended import lease and reacquires a fresh fence after the gate clears", async () => {
    await pool.query("TRUNCATE TABLE worlds,provider_profiles,prompt_template_overrides,imports,activity_events RESTART IDENTITY CASCADE");
    await pool.query("DELETE FROM system_archive_jobs");
    await pool.query("DELETE FROM system_archive_uploads");
    const operation = await pool.query<{ id: string }>(
      `INSERT INTO durable_filesystem_operations (
         owner_user_id,operation_token_hash,purpose,resource_kind,operation_scope_hash,
         lease_id,lease_owner,lease_expires_at,expires_at
       ) VALUES ($1,$2,'portable_staging','portable',$3,gen_random_uuid(),$4,
                 clock_timestamp()+interval '5 minutes',clock_timestamp()+interval '1 day')
       RETURNING id`,
      [ownerUserId, sha256(randomUUID()), sha256(randomUUID()), "system-import-gate-wait-test"],
    );
    const staged = await pool.query<{ id: string }>(
      `INSERT INTO portable_staged_inputs (
         owner_user_id,handle_token_hash,filesystem_operation_id,content_hash,byte_length,expires_at
       ) VALUES ($1,$2,$3,$4,4,clock_timestamp()+interval '1 day') RETURNING id`,
      [ownerUserId, sha256(randomUUID()), operation.rows[0]!.id, sha256("data")],
    );
    const upload = await pool.query<{ id: string }>(
      `INSERT INTO system_archive_uploads (
         owner_user_id,handle_token_hash,filesystem_operation_id,status,byte_length,
         received_bytes,content_hash,staged_input_id,expires_at
       ) VALUES ($1,$2,$3,'completed',4,4,$4,$5,clock_timestamp()+interval '1 day')
       RETURNING id`,
      [ownerUserId, sha256(randomUUID()), operation.rows[0]!.id, sha256("data"), staged.rows[0]!.id],
    );
    const firstLeaseOwner = "system-import-contended-worker";
    const queued = await pool.query<{ id: string }>(
      `INSERT INTO system_archive_jobs (
         owner_user_id,kind,status,idempotency_key_hash,staged_input_id,
         lease_owner,lease_expires_at
       ) VALUES ($1,'import','revalidating',$2,$3,$4,clock_timestamp()+interval '5 minutes')
       RETURNING id`,
      [ownerUserId, sha256(randomUUID()), staged.rows[0]!.id, firstLeaseOwner],
    );
    const jobId = queued.rows[0]!.id;
    const ignore = { ignoreJobId: jobId, ignoreUploadId: upload.rows[0]!.id };
    const imports = createPostgresSystemArchiveImportRepository(pool, { previewTtlSeconds: 1_800 });
    const jobs = createPostgresSystemArchiveJobRepository(pool);
    const owner = { ownerUserId };
    const destination = await imports.destinationFingerprint(owner, ignore);
    const blocker = await pool.connect();
    const firstWork = vi.fn(async () => undefined);
    let contended: Promise<unknown> | undefined;
    try {
      await blocker.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [SYSTEM_IMPORT_LOCK_KEY]);
      contended = imports.withAtomicImport(owner, {
        destination,
        ignore,
        jobId,
        leaseOwner: firstLeaseOwner,
      }, firstWork);
      void contended.catch(() => undefined);

      let waiting: { status: string; lease_owner: string | null; lease_expires_at: Date | null } | undefined;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const observed = await pool.query<{
          status: string;
          lease_owner: string | null;
          lease_expires_at: Date | null;
        }>("SELECT status,lease_owner,lease_expires_at FROM system_archive_jobs WHERE id=$1", [jobId]);
        waiting = observed.rows[0];
        if (waiting?.status === "waiting_for_gate") break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      expect(waiting).toMatchObject({
        status: "waiting_for_gate",
        lease_owner: null,
        lease_expires_at: null,
      });
      await expect(contended).rejects.toMatchObject({ code: "system-import-waiting-for-gate" });
      expect(firstWork).not.toHaveBeenCalled();
    } finally {
      await blocker.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [SYSTEM_IMPORT_LOCK_KEY]);
      blocker.release();
      await contended?.catch(() => undefined);
    }

    const reclaimed = await jobs.claimNext("system-import-reclaimed-worker", 300);
    expect(reclaimed).toMatchObject({ id: jobId, status: "revalidating" });
    expect(reclaimed?.leaseOwner).toBe("system-import-reclaimed-worker");
    const recordsByDomain = Object.fromEntries(SYSTEM_ARCHIVE_DOMAINS.map((domain) => [domain, 0]));
    await imports.withAtomicImport(owner, {
      destination,
      ignore,
      jobId,
      leaseOwner: reclaimed!.leaseOwner,
    }, async (transaction) => {
      await transaction.recordImportReport(importReport({ ownerUserId, recordsByDomain }));
    });
    await expect(pool.query<{ status: string; lease_owner: string | null }>(
      "SELECT status,lease_owner FROM system_archive_jobs WHERE id=$1",
      [jobId],
    )).resolves.toMatchObject({ rows: [{
      status: "authoritative_committed",
      lease_owner: "system-import-reclaimed-worker",
    }] });
  });

  it("rolls back when an asset binding inventory persists fewer rows than declared", async () => {
    await pool.query("TRUNCATE TABLE worlds,provider_profiles,prompt_template_overrides,imports,activity_events RESTART IDENTITY CASCADE");
    await pool.query("DELETE FROM system_archive_jobs");
    await pool.query("DELETE FROM system_archive_uploads");
    const imports = createPostgresSystemArchiveImportRepository(pool, { previewTtlSeconds: 1_800 });
    const owner = { ownerUserId };
    const destination = await imports.destinationFingerprint(owner, {});
    const worldId = randomUUID();
    const versionId = randomUUID();
    const campaignId = randomUUID();
    const assetId = randomUUID();
    const asset = archiveAssetRecordSchema.parse({
      sourceAssetId: assetId,
      contentHash: sha256("duplicate-binding-original"),
      archivePath: `assets/sha256/aa/${"a".repeat(64)}.png`,
      mimeType: "image/png",
      byteLength: 1,
      pixelWidth: 1,
      pixelHeight: 1,
      technicalMetadata: {},
      library: {
        title: "Duplicate binding",
        caption: "",
        notes: "",
        tags: [],
        origin: "imported",
        reviewStatus: "eligible",
        reuseScope: "campaign",
        automaticReuseEnabled: false,
        contentCategories: [],
        favorite: false,
        archivedAt: null,
      },
      createdAt: "2026-08-25T12:00:00.000Z",
      bindings: [
        { role: "campaign_asset", campaignId },
        { role: "campaign_asset", campaignId },
      ],
    });

    await expect(imports.withAtomicImport(owner, { destination, ignore: {} }, async (transaction) => {
      await transaction.database.query(
        "INSERT INTO worlds (id,owner_user_id,title,status) VALUES ($1,$2,'Binding world','active')",
        [worldId, ownerUserId],
      );
      await transaction.database.query(
        `INSERT INTO world_versions (id,world_id,owner_user_id,version_number,content)
         VALUES ($1,$2,$3,1,'{}'::jsonb)`,
        [versionId, worldId, ownerUserId],
      );
      await transaction.database.query(
        `INSERT INTO campaigns (id,owner_user_id,world_version_id,title)
         VALUES ($1,$2,$3,'Binding campaign')`,
        [campaignId, ownerUserId, versionId],
      );
      await transaction.database.query(
        `INSERT INTO assets (
           id,owner_user_id,content_hash,storage_driver,storage_path,mime_type,
           byte_length,pixel_width,pixel_height,technical_metadata
         ) VALUES ($1,$2,$3,'filesystem','binding-test','image/png',1,1,1,'{}'::jsonb)`,
        [assetId, ownerUserId, asset.contentHash],
      );
      await transaction.insertAssetBindings(asset);
    })).rejects.toMatchObject({ statusCode: 400 });

    await expect(pool.query<{ worlds: string; assets: string; references: string }>(
      `SELECT (SELECT count(*)::text FROM worlds WHERE id=$1) AS worlds,
              (SELECT count(*)::text FROM assets WHERE id=$2) AS assets,
              (SELECT count(*)::text FROM asset_references WHERE asset_id=$2) AS references`,
      [worldId, assetId],
    )).resolves.toMatchObject({ rows: [{ worlds: "0", assets: "0", references: "0" }] });
  });

  it("rolls back when a logical record matches no destination authority row", async () => {
    await pool.query("TRUNCATE TABLE worlds,provider_profiles,prompt_template_overrides,imports,activity_events RESTART IDENTITY CASCADE");
    await pool.query("DELETE FROM system_archive_jobs");
    await pool.query("DELETE FROM system_archive_uploads");
    const imports = createPostgresSystemArchiveImportRepository(pool, { previewTtlSeconds: 1_800 });
    const owner = { ownerUserId };
    const destination = await imports.destinationFingerprint(owner, {});
    const worldId = randomUUID();
    const versionId = randomUUID();
    const campaignId = randomUUID();
    const factId = randomUUID();
    const timestamp = "2026-08-25T12:00:00.000Z";
    const records = [
      systemRecordEnvelopeSchema.parse({
        domain: "worlds", formatVersion: 1, sourceId: worldId,
        record: { sourceId: worldId, title: "Fact World", status: "active", createdAt: timestamp, updatedAt: timestamp },
      }),
      systemRecordEnvelopeSchema.parse({
        domain: "world-versions", formatVersion: 1, sourceId: versionId,
        record: {
          sourceId: versionId, worldId, versionNumber: 1, title: "Fact World",
          content: worldContentSchema.parse({
            schemaVersion: 1,
            world: { title: "Fact World", genre: "", tone: "", premise: "", backgroundStory: "", firstAction: "", rules: "" },
            playableCharacters: [], entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [],
            defaults: { selectedCharacterId: null, initialLocation: "" },
          }),
          contentFingerprint: null, releaseNotes: "", createdFromRevision: null, publishedAt: timestamp,
        },
      }),
      systemRecordEnvelopeSchema.parse({
        domain: "campaigns", formatVersion: 1, sourceId: campaignId,
        record: {
          sourceId: campaignId, worldVersionId: versionId, title: "Fact Campaign", status: "active", activeTurnNumber: 0,
          settings: { turnControlStyle: "Auto" }, createdAt: timestamp, updatedAt: timestamp,
        },
      }),
      systemRecordEnvelopeSchema.parse({
        domain: "canonical-facts", formatVersion: 1, sourceId: factId,
        record: {
          sourceId: factId, campaignId, subject: "gate", predicate: "is", object: "sealed", updatedAt: timestamp,
        },
      }),
    ];
    const recordsByDomain = Object.fromEntries(SYSTEM_ARCHIVE_DOMAINS.map((domain) => [
      domain,
      records.filter((record) => record.domain === domain).length,
    ]));

    await expect(imports.withAtomicImport(owner, { destination, ignore: {} }, async (transaction) => {
      await transaction.insertLogicalDomains(records);
      await transaction.recordImportReport(importReport({
        ownerUserId,
        recordsByDomain,
      }));
    })).rejects.toMatchObject({ statusCode: 400 });

    await expect(pool.query<{ count: string }>("SELECT count(*)::text AS count FROM campaigns"))
      .resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  it("remaps source ownership, rejects a stale destination, and queues rebuilds idempotently after commit", async () => {
    await pool.query("TRUNCATE TABLE worlds,provider_profiles,prompt_template_overrides,imports,activity_events RESTART IDENTITY CASCADE");
    await pool.query("DELETE FROM system_archive_jobs");
    await pool.query("DELETE FROM system_archive_uploads");
    const imports = createPostgresSystemArchiveImportRepository(pool, { previewTtlSeconds: 1_800 });
    const owner = { ownerUserId };
    const stale = await imports.destinationFingerprint(owner, {});
    const competingWorldId = randomUUID();
    await pool.query(
      "INSERT INTO worlds (id,owner_user_id,title,status) VALUES ($1,$2,'Competing world','active')",
      [competingWorldId, ownerUserId],
    );
    await expect(imports.withAtomicImport(owner, { destination: stale, ignore: {} }, async () => undefined))
      .rejects.toMatchObject({ statusCode: 409 });
    await pool.query("DELETE FROM worlds WHERE id=$1", [competingWorldId]);

    const destination = await imports.destinationFingerprint(owner, {});
    const providerId = randomUUID();
    const worldId = randomUUID();
    const versionId = randomUUID();
    const campaignId = randomUUID();
    const turnId = randomUUID();
    const correctionIds = [randomUUID(), randomUUID()];
    const turnModeHistoryId = randomUUID();
    const memoryConfigHistoryId = randomUUID();
    const illustrationSetHistoryId = randomUUID();
    const illustrationSegmentHistoryId = randomUUID();
    const chronicleMemoryIds = [randomUUID(), randomUUID()];
    const summaryCheckpointId = randomUUID();
    const checkpointOpenThreadId = randomUUID();
    const activitySourceId = "00000000-0000-4000-8000-00000000002a";
    const records = [
      systemRecordEnvelopeSchema.parse({
        domain: "providers", formatVersion: 1, sourceId: providerId,
        record: {
          sourceId: providerId, kind: "text", displayName: "Imported text provider",
          baseUrl: "https://provider.invalid/v1", selectedModel: "restored-model",
          contextWindow: 32768, timeoutMs: 300000, retryLimit: 2,
          enabled: false, health: "unknown",
        },
      }),
      systemRecordEnvelopeSchema.parse({
        domain: "worlds", formatVersion: 1, sourceId: worldId,
        record: { sourceId: worldId, title: "Restored World", status: "active", createdAt: "2026-08-25T12:00:00.000Z", updatedAt: "2026-08-25T12:00:00.000Z" },
      }),
      systemRecordEnvelopeSchema.parse({
        domain: "world-versions", formatVersion: 1, sourceId: versionId,
        record: {
          sourceId: versionId, worldId, versionNumber: 1, title: "Restored World",
          content: worldContentSchema.parse({
            schemaVersion: 1,
            world: { title: "Restored World", genre: "Fantasy", tone: "Hopeful", premise: "Return.", backgroundStory: "", firstAction: "Begin.", rules: "" },
            playableCharacters: [], entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [],
            defaults: { selectedCharacterId: null, initialLocation: "" },
          }),
          contentFingerprint: null, releaseNotes: "", createdFromRevision: null, publishedAt: "2026-08-25T12:00:00.000Z",
        },
      }),
      systemRecordEnvelopeSchema.parse({
        domain: "campaigns", formatVersion: 1, sourceId: campaignId,
        record: {
          sourceId: campaignId, worldVersionId: versionId, title: "Restored Campaign", status: "active", activeTurnNumber: 1,
          settings: { turnControlStyle: "Auto" }, createdAt: "2026-08-25T12:00:00.000Z", updatedAt: "2026-08-25T12:00:00.000Z",
        },
      }),
      systemRecordEnvelopeSchema.parse({
        domain: "turns", formatVersion: 1, sourceId: turnId,
        record: {
          sourceId: turnId, campaignId, turnNumber: 1, action: "Open the gate.", narration: "The gate opens.", choices: [], imagePrompt: "A gate at dawn", acceptedAt: "2026-08-25T12:00:00.000Z",
        },
      }),
      ...correctionIds.map((correctionId, index) => systemRecordEnvelopeSchema.parse({
        domain: "turn-corrections", formatVersion: 1, sourceId: correctionId,
        record: {
          sourceId: correctionId,
          turnId,
          revision: index === 0 ? 2 : 7,
          narration: index === 0 ? "The gate opens quietly." : "The gate opens beneath a silver dawn.",
          previousEffectiveNarrationHash: index === 0
            ? sha256("The gate opens.")
            : sha256("The gate opens quietly."),
          reason: index === 0 ? null : "Restore the accepted seventh revision.",
          source: index === 0 ? "legacy_import" : "user_edit",
          correctedAt: `2026-08-25T12:00:0${index}.000Z`,
        },
      })),
      systemRecordEnvelopeSchema.parse({
        domain: "campaign-history", formatVersion: 1, sourceId: turnModeHistoryId,
        record: {
          sourceId: turnModeHistoryId, campaignId, eventType: "accepted-turn-mode",
          content: JSON.stringify({ turnId, turnNumber: 1, inputMode: "scene", inputModeSource: "explicit" }),
          occurredAt: "2026-08-25T12:00:00.000Z",
        },
      }),
      systemRecordEnvelopeSchema.parse({
        domain: "campaign-history", formatVersion: 1, sourceId: memoryConfigHistoryId,
        record: {
          sourceId: memoryConfigHistoryId, campaignId, eventType: "memory-config",
          content: JSON.stringify({
            embeddingEnabled: true,
            embeddingProviderProfileId: providerId,
            embeddingModel: "restored-model",
            embeddingBatchSize: 24,
          }),
          occurredAt: "2026-08-25T12:00:00.000Z",
        },
      }),
      systemRecordEnvelopeSchema.parse({
        domain: "campaign-history", formatVersion: 1, sourceId: illustrationSetHistoryId,
        record: {
          sourceId: illustrationSetHistoryId, campaignId, eventType: "illustration-set",
          content: JSON.stringify({
            turnId,
            segmentWordCount: 100,
            imagesPerSegment: 1,
            promptMode: "direct",
            status: "generating",
            isActive: true,
            characterVisualReference: "",
          }),
          occurredAt: "2026-08-25T12:00:00.000Z",
        },
      }),
      systemRecordEnvelopeSchema.parse({
        domain: "campaign-history", formatVersion: 1, sourceId: illustrationSegmentHistoryId,
        record: {
          sourceId: illustrationSegmentHistoryId, campaignId, eventType: "illustration-segment",
          content: JSON.stringify({
            illustrationSetId: illustrationSetHistoryId,
            turnId,
            ordinal: 0,
            startOffset: 0,
            endOffset: 15,
            startWord: 0,
            endWord: 3,
            directPrompt: "A gate at dawn",
            resolvedPrompt: "A gate at dawn",
            promptSource: "direct",
            status: "recoverable",
          }),
          occurredAt: "2026-08-25T12:00:00.000Z",
        },
      }),
      ...chronicleMemoryIds.map((memoryId, index) => systemRecordEnvelopeSchema.parse({
        domain: "chronicle", formatVersion: 1, sourceId: memoryId,
        record: {
          sourceId: memoryId,
          campaignId,
          kind: "memory",
          turnId: index === 0 ? null : turnId,
          memoryKind: index === 0 ? "campaign_summary" : "turn_fiction",
          content: `Restored Chronicle memory ${index + 1}`,
          occurredAt: `2026-08-25T12:00:0${index}.000Z`,
          metadata: { entityNames: ["Gate"], openThreadIds: [] },
        },
      })),
      systemRecordEnvelopeSchema.parse({
        domain: "chronicle", formatVersion: 1, sourceId: summaryCheckpointId,
        record: {
          sourceId: summaryCheckpointId,
          campaignId,
          kind: "summary-checkpoint",
          throughTurn: 1,
          summaryKind: "legacy_full_history",
          content: "Complete restored story through turn one.",
          occurredAt: "2026-08-25T12:00:02.000Z",
          metadata: { entityNames: ["Gate"], openThreadIds: [checkpointOpenThreadId] },
        },
      }),
      systemRecordEnvelopeSchema.parse({
        domain: "activity-events", formatVersion: 1, sourceId: activitySourceId,
        record: {
          sourceId: activitySourceId,
          campaignId,
          eventType: "campaign-restored",
          summary: "The campaign crossed instances.",
          occurredAt: "2026-08-25T12:00:02.000Z",
        },
      }),
    ];

    await imports.withAtomicImport(owner, { destination, ignore: {} }, async (transaction) => {
      await transaction.insertLogicalDomains(records);
      await transaction.recordImportReport(importReport({
        ownerUserId,
        recordsByDomain: Object.fromEntries(SYSTEM_ARCHIVE_DOMAINS.map((domain) => [
          domain,
          records.filter((record) => record.domain === domain).length,
        ])),
      }));
    });
    await imports.enqueueDerivedRebuilds(owner, { campaignIds: [campaignId], assetIds: [] });
    await imports.enqueueDerivedRebuilds(owner, { campaignIds: [campaignId], assetIds: [] });

    await expect(pool.query<{
      world_owner: string;
      provider_owner: string;
      enabled: boolean;
      health_status: string;
      encrypted_api_key: string | null;
    }>(
      `SELECT world.owner_user_id AS world_owner,provider.owner_user_id AS provider_owner,
              provider.enabled,provider.health_status,provider.encrypted_api_key
         FROM worlds world CROSS JOIN provider_profiles provider
        WHERE world.id=$1 AND provider.id=$2`,
      [worldId, providerId],
    )).resolves.toMatchObject({ rows: [{
      world_owner: ownerUserId,
      provider_owner: ownerUserId,
      enabled: false,
      health_status: "unknown",
      encrypted_api_key: null,
    }] });
    await expect(pool.query<{
      input_mode: string;
      input_mode_source: string;
      embedding_enabled: boolean;
      embedding_provider_profile_id: string;
      embedding_model: string;
      embedding_batch_size: number;
    }>(
      `SELECT turn_row.input_mode,turn_row.input_mode_source,
              config.embedding_enabled,config.embedding_provider_profile_id,
              config.embedding_model,config.embedding_batch_size
         FROM turns turn_row
         JOIN campaign_memory_configs config
           ON config.campaign_id=turn_row.campaign_id
          AND config.owner_user_id=turn_row.owner_user_id
        WHERE turn_row.id=$1`,
      [turnId],
    )).resolves.toMatchObject({ rows: [{
      input_mode: "scene",
      input_mode_source: "explicit",
      embedding_enabled: true,
      embedding_provider_profile_id: providerId,
      embedding_model: "restored-model",
      embedding_batch_size: 24,
    }] });
    await expect(pool.query<{ id: string; turn_id: string | null; memory_kind: string }>(
      "SELECT id,turn_id,memory_kind FROM chronicle_memories WHERE campaign_id=$1 ORDER BY id",
      [campaignId],
    )).resolves.toMatchObject({
      rows: chronicleMemoryIds.map((id, index) => ({
        id,
        turn_id: index === 0 ? null : turnId,
        memory_kind: index === 0 ? "campaign_summary" : "turn_fiction",
      })).sort((left, right) => left.id.localeCompare(right.id)),
    });
    await expect(pool.query<{
      id: string;
      through_turn: number;
      summary_kind: string;
      summary: string;
      open_thread_ids: string[];
    }>(
      `SELECT id,through_turn,summary_kind,content->>'summary' AS summary,
              content->'openThreadIds' AS open_thread_ids
         FROM summary_checkpoints WHERE campaign_id=$1`,
      [campaignId],
    )).resolves.toMatchObject({ rows: [{
      id: summaryCheckpointId,
      through_turn: 1,
      summary_kind: "legacy_full_history",
      summary: "Complete restored story through turn one.",
      open_thread_ids: [checkpointOpenThreadId],
    }] });
    await expect(pool.query<{
      id: string;
      revision: number;
      previous_effective_narration_hash: string;
      reason: string | null;
      source: string;
    }>(
      `SELECT id,revision,previous_effective_narration_hash,reason,source
         FROM turn_narration_corrections WHERE turn_id=$1 ORDER BY revision`,
      [turnId],
    )).resolves.toMatchObject({ rows: [
      {
        id: correctionIds[0],
        revision: 2,
        previous_effective_narration_hash: sha256("The gate opens."),
        reason: null,
        source: "legacy_import",
      },
      {
        id: correctionIds[1],
        revision: 7,
        previous_effective_narration_hash: sha256("The gate opens quietly."),
        reason: "Restore the accepted seventh revision.",
        source: "user_edit",
      },
    ] });
    await expect(pool.query<{ id: string }>(
      "SELECT id::text AS id FROM activity_events WHERE campaign_id=$1 AND event_type='campaign-restored'",
      [campaignId],
    )).resolves.toMatchObject({ rows: [{ id: "42" }] });
    await expect(pool.query<{ set_status: string; segment_status: string }>(
      `SELECT illustration_set.status AS set_status,segment.status AS segment_status
         FROM turn_illustration_sets illustration_set
         JOIN turn_illustration_segments segment ON segment.illustration_set_id=illustration_set.id
        WHERE illustration_set.id=$1 AND segment.id=$2`,
      [illustrationSetHistoryId, illustrationSegmentHistoryId],
    )).resolves.toMatchObject({ rows: [{ set_status: "failed", segment_status: "failed" }] });
    await expect(pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM chronicle_jobs WHERE campaign_id=$1 AND status IN ('queued','running')",
      [campaignId],
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });
  });

  it("reconciles an ambiguous atomic-import response before compensating prepared assets", async () => {
    const exported = await exportArchive();
    await withStagedArchive(exported.bytes, limits, async (staged) => {
      const jobId = randomUUID();
      const stagedInputId = randomUUID();
      const uploadId = randomUUID();
      const rebuildCampaignId = randomUUID();
      const discarded = vi.fn(async () => undefined);
      const finalized = vi.fn(async () => undefined);
      const completedPublications = vi.fn(async (identity: { assetId: string }) => ({
        assetId: identity.assetId,
        mimeType: "image/png" as const,
        byteLength: 0,
        contentHash: sha256("published"),
        derivativeIds: [],
      }));
      const reservedAssetIds: string[] = [];
      let authorityReads = 0;
      const authority = () => ({
        jobId,
        stagedInputId,
        uploadId,
        archiveFingerprint: exported.result.artifact.contentFingerprint,
        destination: {
          initialOwnerId: ownerUserId,
          latestMigration: "0079_resumable_system_archive_uploads",
          authoritativeCountsHash: sha256("empty-authority"),
          activeJobsHash: sha256("ignored-active-import"),
          checkedAt: "2026-08-25T12:00:00.000Z",
          destinationEmpty: true,
        },
        status: authorityReads++ === 0 ? "revalidating" as const : "authoritative_committed" as const,
        report: null,
        rebuildCampaignIds: [rebuildCampaignId],
        rebuildAssetIds: [...reservedAssetIds],
      });
      const markRebuilding = vi.fn(async () => undefined);
      const enqueueRebuilds = vi.fn(async () => undefined);
      const completeImport = vi.fn(async () => undefined);
      const transaction = {
        database: {
          query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
        },
        async insertLogicalDomains(records: AsyncIterable<unknown> | Iterable<unknown>) {
          for await (const _record of records) {
            // Consume every verified NDJSON record as the production transaction does.
          }
          return {
            recordsByDomain: Object.fromEntries(SYSTEM_ARCHIVE_DOMAINS.map((domain) => [domain, 0])),
            campaignIds: [],
            assetIds: [],
          };
        },
        insertOriginalAsset: vi.fn(async () => undefined),
        insertAssetBindings: vi.fn(async () => undefined),
        recordImportReport: vi.fn(async () => undefined),
      };
      const service = createSystemArchiveImportExecutionService({
        imports: {
          loadImportJobAuthority: vi.fn(async () => authority()),
          reserveOriginalAssetIdentity: vi.fn(async (_owner, assetId) => {
            reservedAssetIds.push(assetId);
            return { assetId, ownerUserId, lifecycle: "prepared" };
          }),
          withAtomicImport: vi.fn(async (_owner, _request, work) => {
            await work(transaction as never);
            throw new Error("connection dropped after COMMIT");
          }),
          markImportedJobRebuilding: markRebuilding,
          enqueueDerivedRebuilds: enqueueRebuilds,
          completeImportedJob: completeImport,
        } as never,
        source: {
          async withCompletedUpload(_owner, _uploadId, inspect) {
            return inspect(staged);
          },
        },
        capacity: {
          availableBytes: vi.fn(async () => ({ staging: 1_000_000_000, assetRoot: 1_000_000_000 })),
        },
        limits,
        allowUnknownFreeSpace: false,
        destinationApplicationVersion: "0.1.0",
        storage: {
          prepareAssetPublication: vi.fn(async () => ({
            original: {
              kind: "original" as const,
              derivativeIndex: null,
              attachment: {},
              rollback: vi.fn(async () => undefined),
            },
            derivatives: [],
          })),
          discardPreparedAssetPublication: discarded,
          finalizeAssetPublication: finalized,
        } as never,
        assetPublications: {
          attachPublication: vi.fn(async (_database, identity, command) => ({
            identity: { ...identity, lifecycle: "attached" },
            result: {
              assetId: identity.assetId,
              mimeType: command.original.mimeType,
              byteLength: command.original.byteLength,
              contentHash: command.original.contentHash,
              derivativeIds: [],
            },
            finalization: [],
          })),
          completePublication: completedPublications,
        } as never,
        publicationLeaseSeconds: 300,
      });

      await expect(service.runSystemImport({
        id: jobId,
        kind: "import",
        status: "revalidating",
        createdAt: "2026-08-25T12:00:00.000Z",
        updatedAt: "2026-08-25T12:00:00.000Z",
        report: null,
        ownerUserId,
        stagedInputId,
        leaseOwner: "ambiguous-commit-test",
        leaseExpiresAt: "2026-08-25T12:05:00.000Z",
      })).resolves.toBeUndefined();
      expect(discarded).not.toHaveBeenCalled();
      expect(completedPublications).toHaveBeenCalledTimes(4);
      expect(markRebuilding).toHaveBeenCalledOnce();
      expect(enqueueRebuilds).toHaveBeenCalledWith(
        { ownerUserId },
        { campaignIds: [rebuildCampaignId], assetIds: reservedAssetIds },
      );
      expect(completeImport).toHaveBeenCalledOnce();
    });
  });

  it("accepts import cancellation before importing and rejects it after the transaction boundary", async () => {
    await pool.query("DELETE FROM system_archive_jobs");
    await pool.query("DELETE FROM system_archive_uploads");
    const operation = await pool.query<{ id: string }>(
      `INSERT INTO durable_filesystem_operations (
         owner_user_id,operation_token_hash,purpose,resource_kind,operation_scope_hash,
         lease_id,lease_owner,lease_expires_at,expires_at
       ) VALUES ($1,$2,'portable_staging','portable',$3,gen_random_uuid(),$4,
                 clock_timestamp()+interval '5 minutes',clock_timestamp()+interval '1 day')
       RETURNING id`,
      [ownerUserId, sha256(randomUUID()), sha256(randomUUID()), "system-import-cancellation-test"],
    );
    const staged = await pool.query<{ id: string }>(
      `INSERT INTO portable_staged_inputs (
         owner_user_id,handle_token_hash,filesystem_operation_id,content_hash,byte_length,expires_at
       ) VALUES ($1,$2,$3,$4,4,clock_timestamp()+interval '1 day') RETURNING id`,
      [ownerUserId, sha256(randomUUID()), operation.rows[0]!.id, sha256("data")],
    );
    const jobs = createPostgresSystemArchiveJobRepository(pool);
    const cancelable = await jobs.enqueueImport(
      { ownerUserId },
      staged.rows[0]!.id,
      sha256(randomUUID()),
    );
    await expect(jobs.requestCancellation({ ownerUserId }, cancelable.id))
      .resolves.toMatchObject({ status: "cancelling" });
    await pool.query(
      "UPDATE system_archive_jobs SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
      [cancelable.id],
    );
    const importing = await pool.query<{ id: string }>(
      `INSERT INTO system_archive_jobs (
         owner_user_id,kind,status,idempotency_key_hash,staged_input_id,lease_owner,lease_expires_at
       ) VALUES ($1,'import','importing',$2,$3,$4,clock_timestamp()+interval '5 minutes')
       RETURNING id`,
      [ownerUserId, sha256(randomUUID()), staged.rows[0]!.id, "system-import-cancellation-test"],
    );
    await expect(jobs.requestCancellation({ ownerUserId }, importing.rows[0]!.id))
      .rejects.toMatchObject({ statusCode: 409 });
    await expect(pool.query<{ status: string }>(
      "SELECT status FROM system_archive_jobs WHERE id=$1",
      [importing.rows[0]!.id],
    )).resolves.toMatchObject({ rows: [{ status: "importing" }] });
  });

  it("returns the same queued import when preview consumption is retried after response loss", async () => {
    await pool.query("TRUNCATE TABLE worlds,provider_profiles,prompt_template_overrides,imports,activity_events RESTART IDENTITY CASCADE");
    await pool.query("DELETE FROM system_archive_jobs");
    await pool.query("DELETE FROM system_archive_uploads");
    const operation = await pool.query<{ id: string }>(
      `INSERT INTO durable_filesystem_operations (
         owner_user_id,operation_token_hash,purpose,resource_kind,operation_scope_hash,
         lease_id,lease_owner,lease_expires_at,expires_at
       ) VALUES ($1,$2,'portable_staging','portable',$3,gen_random_uuid(),$4,
                 clock_timestamp()+interval '5 minutes',clock_timestamp()+interval '1 day')
       RETURNING id`,
      [ownerUserId, sha256(randomUUID()), sha256(randomUUID()), "system-import-idempotency-test"],
    );
    const staged = await pool.query<{ id: string }>(
      `INSERT INTO portable_staged_inputs (
         owner_user_id,handle_token_hash,filesystem_operation_id,content_hash,byte_length,expires_at
       ) VALUES ($1,$2,$3,$4,4,clock_timestamp()+interval '1 day') RETURNING id`,
      [ownerUserId, sha256(randomUUID()), operation.rows[0]!.id, sha256("data")],
    );
    const upload = await pool.query<{ id: string }>(
      `INSERT INTO system_archive_uploads (
         owner_user_id,handle_token_hash,filesystem_operation_id,status,byte_length,
         received_bytes,content_hash,staged_input_id,expires_at
       ) VALUES ($1,$2,$3,'completed',4,4,$4,$5,clock_timestamp()+interval '1 day')
       RETURNING id`,
      [ownerUserId, sha256(randomUUID()), operation.rows[0]!.id, sha256("data"), staged.rows[0]!.id],
    );
    const imports = createPostgresSystemArchiveImportRepository(pool, { previewTtlSeconds: 1_800 });
    const owner = { ownerUserId };
    const destination = await imports.destinationFingerprint(owner, { ignoreUploadId: upload.rows[0]!.id });
    const archiveFingerprint = sha256("idempotent-preview");
    const recordsByDomain = Object.fromEntries(SYSTEM_ARCHIVE_DOMAINS.map((domain) => [domain, 0]));
    const preview = await imports.createPreview(owner, {
      uploadId: upload.rows[0]!.id,
      archiveFingerprint,
      destination,
      projection: {
        versions: {
          archiveFormat: 1,
          sourceApplication: "0.1.0",
          sourceMigration: destination.latestMigration,
          destinationApplication: "0.1.0",
          destinationMigration: destination.latestMigration,
        },
        sourceOwnerCount: 1,
        archiveFingerprint,
        recordsByDomain,
        assets: { originalCount: 0, totalBytes: 0 },
        destinationEmpty: true,
        ownerMapping: { sourceOwnerId: ownerUserId, destinationOwnerId: ownerUserId },
        disabledProviders: 0,
        omittedOperationalRows: 7,
        operationalOmissions: {
          generation: 0,
          illustration: 0,
          chronicle: 0,
          imports: 0,
          "system-archive": 7,
        },
        invalidatedAccess: ["share-links", "sessions", "oidc-identities", "external-authorizations"],
        normalization: ["map-source-owner-to-initial-owner", "disable-provider-profiles"],
        rebuilds: {
          chronicleIndex: { category: "chronicle-index", status: "pending", itemCount: 0 },
          assetThumbnails: { category: "asset-thumbnails", status: "pending", itemCount: 0 },
        },
        space: {
          staging: { requiredBytes: 0, availableBytes: 1, verified: true, sufficient: true, overrideUsed: false },
          assetRoot: { requiredBytes: 0, availableBytes: 1, verified: true, sufficient: true, overrideUsed: false },
        },
        warnings: [],
        errors: [],
      },
    });
    const idempotencyKey = `commit-${randomUUID()}`;

    const first = await imports.consumePreviewAuthority(owner, preview.previewHandle, idempotencyKey);
    const replay = await imports.consumePreviewAuthority(owner, preview.previewHandle, idempotencyKey);

    expect(replay).toEqual(first);
    expect(first.jobId).toBe(preview.jobId);
    await expect(imports.consumePreviewAuthority(owner, preview.previewHandle, `different-${randomUUID()}`))
      .rejects.toMatchObject({ statusCode: 409 });
    const persisted = await pool.query<{ status: string; progress_text: string }>(
      "SELECT status,progress::text AS progress_text FROM system_archive_jobs WHERE id=$1",
      [preview.jobId],
    );
    expect(persisted.rows[0]).toMatchObject({ status: "queued" });
    expect(persisted.rows[0]!.progress_text).toContain(sha256(idempotencyKey));
    expect(persisted.rows[0]!.progress_text).not.toContain(idempotencyKey);

    const claimed = await createPostgresSystemArchiveJobRepository(pool).claimNext(
      "system-import-idempotency-test",
      300,
    );
    expect(claimed).toMatchObject({ id: preview.jobId, status: "revalidating" });
    const worldId = randomUUID();
    const actualCounts = Object.fromEntries(SYSTEM_ARCHIVE_DOMAINS.map((domain) => [
      domain,
      domain === "worlds" ? 1 : 0,
    ]));
    await expect(imports.withAtomicImport(owner, {
      destination: first.destination,
      ignore: { ignoreJobId: preview.jobId, ignoreUploadId: upload.rows[0]!.id },
      jobId: preview.jobId,
      leaseOwner: claimed!.leaseOwner,
    }, async (transaction) => {
      await transaction.insertLogicalDomains([systemRecordEnvelopeSchema.parse({
        domain: "worlds",
        formatVersion: 1,
        sourceId: worldId,
        record: {
          sourceId: worldId,
          title: "Preview mismatch world",
          status: "active",
          createdAt: "2026-08-25T12:00:00.000Z",
          updatedAt: "2026-08-25T12:00:00.000Z",
        },
      })]);
      await transaction.recordImportReport(importReport({
        ownerUserId,
        archiveFingerprint,
        recordsByDomain: actualCounts,
      }));
    })).rejects.toMatchObject({ statusCode: 409 });
    await expect(pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM worlds WHERE id=$1",
      [worldId],
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });

    const durableReport = importReport({
      ownerUserId,
      archiveFingerprint,
      recordsByDomain,
      omittedOperationalRows: 7,
    });
    const categoryMismatchReport = systemArchiveImportReportSchema.parse({
      ...durableReport,
      operationalOmissions: {
        ...durableReport.operationalOmissions,
        generation: 7,
        "system-archive": 0,
      },
    });
    await expect(imports.withAtomicImport(owner, {
      destination: first.destination,
      ignore: { ignoreJobId: preview.jobId, ignoreUploadId: upload.rows[0]!.id },
      jobId: preview.jobId,
      leaseOwner: claimed!.leaseOwner,
    }, async (transaction) => {
      await transaction.recordImportReport(categoryMismatchReport);
    })).rejects.toMatchObject({ statusCode: 409 });

    await imports.withAtomicImport(owner, {
      destination: first.destination,
      ignore: { ignoreJobId: preview.jobId, ignoreUploadId: upload.rows[0]!.id },
      jobId: preview.jobId,
      leaseOwner: claimed!.leaseOwner,
    }, async (transaction) => {
      await transaction.recordImportReport(durableReport);
    });
    await expect(pool.query<{ status: string; report: unknown }>(
      "SELECT status,report FROM system_archive_jobs WHERE id=$1",
      [preview.jobId],
    )).resolves.toMatchObject({ rows: [{
      status: "authoritative_committed",
      report: durableReport,
    }] });
  });

  it("rolls back when the worker lease expires after the report is staged but before commit", async () => {
    await pool.query("TRUNCATE TABLE worlds,provider_profiles,prompt_template_overrides,imports,activity_events RESTART IDENTITY CASCADE");
    await pool.query("DELETE FROM system_archive_jobs");
    await pool.query("DELETE FROM system_archive_uploads");
    const operation = await pool.query<{ id: string }>(
      `INSERT INTO durable_filesystem_operations (
         owner_user_id,operation_token_hash,purpose,resource_kind,operation_scope_hash,
         lease_id,lease_owner,lease_expires_at,expires_at
       ) VALUES ($1,$2,'portable_staging','portable',$3,gen_random_uuid(),$4,
                 clock_timestamp()+interval '5 minutes',clock_timestamp()+interval '1 day')
       RETURNING id`,
      [ownerUserId, sha256(randomUUID()), sha256(randomUUID()), "system-import-expiring-lease-test"],
    );
    const staged = await pool.query<{ id: string }>(
      `INSERT INTO portable_staged_inputs (
         owner_user_id,handle_token_hash,filesystem_operation_id,content_hash,byte_length,expires_at
       ) VALUES ($1,$2,$3,$4,4,clock_timestamp()+interval '1 day') RETURNING id`,
      [ownerUserId, sha256(randomUUID()), operation.rows[0]!.id, sha256("data")],
    );
    const upload = await pool.query<{ id: string }>(
      `INSERT INTO system_archive_uploads (
         owner_user_id,handle_token_hash,filesystem_operation_id,status,byte_length,
         received_bytes,content_hash,staged_input_id,expires_at
       ) VALUES ($1,$2,$3,'completed',4,4,$4,$5,clock_timestamp()+interval '1 day')
       RETURNING id`,
      [ownerUserId, sha256(randomUUID()), operation.rows[0]!.id, sha256("data"), staged.rows[0]!.id],
    );
    const leaseOwner = "system-import-expiring-lease-test";
    const queued = await pool.query<{ id: string }>(
      `INSERT INTO system_archive_jobs (
         owner_user_id,kind,status,idempotency_key_hash,staged_input_id,
         lease_owner,lease_expires_at
       ) VALUES ($1,'import','revalidating',$2,$3,$4,
                 clock_timestamp()+interval '250 milliseconds') RETURNING id`,
      [ownerUserId, sha256(randomUUID()), staged.rows[0]!.id, leaseOwner],
    );
    const imports = createPostgresSystemArchiveImportRepository(pool, { previewTtlSeconds: 1_800 });
    const owner = { ownerUserId };
    const ignore = { ignoreJobId: queued.rows[0]!.id, ignoreUploadId: upload.rows[0]!.id };
    const destination = await imports.destinationFingerprint(owner, ignore);
    const recordsByDomain = Object.fromEntries(SYSTEM_ARCHIVE_DOMAINS.map((domain) => [domain, 0]));

    await expect(imports.withAtomicImport(owner, {
      destination,
      ignore,
      jobId: queued.rows[0]!.id,
      leaseOwner,
    }, async (transaction) => {
      await transaction.recordImportReport(importReport({
        ownerUserId,
        completedAt: "2026-08-25T12:00:00.000Z",
        archiveFingerprint: sha256("lease-expiry-report"),
        recordsByDomain,
      }));
      await transaction.database.query("SELECT pg_sleep(0.4)");
    })).rejects.toMatchObject({ statusCode: 409 });

    await expect(pool.query<{ status: string; report: unknown }>(
      "SELECT status,report FROM system_archive_jobs WHERE id=$1",
      [queued.rows[0]!.id],
    )).resolves.toMatchObject({ rows: [{ status: "revalidating", report: null }] });
  });

  it("rejects an expired opaque preview authority without enqueueing its import", async () => {
    await pool.query("DELETE FROM system_archive_jobs");
    await pool.query("DELETE FROM system_archive_uploads");
    const operation = await pool.query<{ id: string }>(
      `INSERT INTO durable_filesystem_operations (
         owner_user_id,operation_token_hash,purpose,resource_kind,operation_scope_hash,
         lease_id,lease_owner,lease_expires_at,expires_at
       ) VALUES ($1,$2,'portable_staging','portable',$3,gen_random_uuid(),$4,
                 clock_timestamp()+interval '5 minutes',clock_timestamp()+interval '1 day')
       RETURNING id`,
      [ownerUserId, sha256(randomUUID()), sha256(randomUUID()), "expired-system-import-preview-test"],
    );
    const staged = await pool.query<{ id: string }>(
      `INSERT INTO portable_staged_inputs (
         owner_user_id,handle_token_hash,filesystem_operation_id,content_hash,byte_length,expires_at
       ) VALUES ($1,$2,$3,$4,4,clock_timestamp()+interval '1 day') RETURNING id`,
      [ownerUserId, sha256(randomUUID()), operation.rows[0]!.id, sha256("data")],
    );
    const upload = await pool.query<{ id: string }>(
      `INSERT INTO system_archive_uploads (
         owner_user_id,handle_token_hash,filesystem_operation_id,status,byte_length,
         received_bytes,content_hash,staged_input_id,expires_at
       ) VALUES ($1,$2,$3,'completed',4,4,$4,$5,clock_timestamp()+interval '1 day')
       RETURNING id`,
      [ownerUserId, sha256(randomUUID()), operation.rows[0]!.id, sha256("data"), staged.rows[0]!.id],
    );
    const previewHandle = createHash("sha256").update(randomUUID()).digest("base64url");
    const preview = await pool.query<{ id: string }>(
      `INSERT INTO system_archive_jobs (
         owner_user_id,kind,status,idempotency_key_hash,staged_input_id,progress,report
       ) VALUES ($1,'import','previewed',$2,$3,$4::jsonb,'{}'::jsonb) RETURNING id`,
      [
        ownerUserId,
        sha256(previewHandle),
        staged.rows[0]!.id,
        JSON.stringify({
          archiveFingerprint: sha256("expired-preview"),
          destinationFingerprint: {
            initialOwnerId: ownerUserId,
            latestMigration: "0079_resumable_system_archive_uploads",
            authoritativeCountsHash: sha256("authority"),
            activeJobsHash: sha256("jobs"),
            checkedAt: "2026-08-25T12:00:00.000Z",
            destinationEmpty: true,
          },
          expiresAt: "2026-08-25T11:59:59.000Z",
        }),
      ],
    );
    const imports = createPostgresSystemArchiveImportRepository(pool, { previewTtlSeconds: 1_800 });
    await expect(imports.consumePreviewAuthority({ ownerUserId }, previewHandle, randomUUID()))
      .rejects.toMatchObject({ statusCode: 409 });
    await expect(pool.query<{ status: string }>(
      "SELECT status FROM system_archive_jobs WHERE id=$1",
      [preview.rows[0]!.id],
    )).resolves.toMatchObject({ rows: [{ status: "previewed" }] });
    expect(upload.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("reloads committed import authority after its staging upload expires", async () => {
    await pool.query("DELETE FROM system_archive_jobs");
    await pool.query("DELETE FROM system_archive_uploads");
    const operation = await pool.query<{ id: string }>(
      `INSERT INTO durable_filesystem_operations (
         owner_user_id,operation_token_hash,purpose,resource_kind,operation_scope_hash,
         lease_id,lease_owner,lease_expires_at,expires_at
       ) VALUES ($1,$2,'portable_staging','portable',$3,gen_random_uuid(),$4,
                 clock_timestamp()+interval '5 minutes',clock_timestamp()+interval '1 day')
       RETURNING id`,
      [ownerUserId, sha256(randomUUID()), sha256(randomUUID()), "expired-staging-rebuild-test"],
    );
    const staged = await pool.query<{ id: string }>(
      `INSERT INTO portable_staged_inputs (
         owner_user_id,handle_token_hash,filesystem_operation_id,content_hash,byte_length,expires_at
       ) VALUES ($1,$2,$3,$4,4,clock_timestamp()+interval '1 day') RETURNING id`,
      [ownerUserId, sha256(randomUUID()), operation.rows[0]!.id, sha256("data")],
    );
    const upload = await pool.query<{ id: string }>(
      `INSERT INTO system_archive_uploads (
         owner_user_id,handle_token_hash,filesystem_operation_id,status,byte_length,
         received_bytes,content_hash,staged_input_id,expires_at
       ) VALUES ($1,$2,$3,'completed',4,4,$4,$5,clock_timestamp()-interval '1 second')
       RETURNING id`,
      [ownerUserId, sha256(randomUUID()), operation.rows[0]!.id, sha256("data"), staged.rows[0]!.id],
    );
    const jobId = randomUUID();
    const archiveFingerprint = sha256("committed-archive");
    const report = importReport({
      ownerUserId,
      completedAt: "2026-08-25T12:00:00.000Z",
      archiveFingerprint,
      recordsByDomain: Object.fromEntries(SYSTEM_ARCHIVE_DOMAINS.map((domain) => [domain, 0])),
    });
    const destination = {
      initialOwnerId: ownerUserId,
      latestMigration: "0079_resumable_system_archive_uploads",
      authoritativeCountsHash: sha256("empty-authority"),
      activeJobsHash: sha256("ignored-import"),
      checkedAt: "2026-08-25T12:00:00.000Z",
      destinationEmpty: true,
    };
    await pool.query(
      `INSERT INTO system_archive_jobs (
         id,owner_user_id,kind,status,idempotency_key_hash,staged_input_id,progress,report,
         lease_owner,lease_expires_at
       ) VALUES ($1,$2,'import','authoritative_committed',$3,$4,$5::jsonb,$6::jsonb,$7,
                 clock_timestamp()+interval '5 minutes')`,
      [
        jobId,
        ownerUserId,
        sha256(randomUUID()),
        staged.rows[0]!.id,
        JSON.stringify({
          archiveFingerprint,
          destinationFingerprint: destination,
          rebuildCampaignIds: [],
          rebuildAssetIds: [],
        }),
        JSON.stringify(report),
        "expired-staging-rebuild-test",
      ],
    );

    const imports = createPostgresSystemArchiveImportRepository(pool, { previewTtlSeconds: 1_800 });
    await expect(imports.loadImportJobAuthority(
      { ownerUserId },
      jobId,
      staged.rows[0]!.id,
    )).resolves.toMatchObject({
      jobId,
      uploadId: upload.rows[0]!.id,
      status: "authoritative_committed",
      archiveFingerprint,
    });

    const failedRebuild = createSystemArchiveImportExecutionService({
      imports: {
        ...imports,
        enqueueDerivedRebuilds: vi.fn(async () => {
          throw new Error("forced_system_import_rebuild_failure");
        }),
      },
      source: {
        withCompletedUpload: vi.fn(async () => {
          throw new Error("committed import must not reopen expired staging");
        }),
      } as never,
      capacity: {
        availableBytes: vi.fn(async () => ({ staging: 0, assetRoot: 0 })),
      },
      limits,
      allowUnknownFreeSpace: false,
      destinationApplicationVersion: "0.1.0",
      storage: {} as never,
      assetPublications: {} as never,
      publicationLeaseSeconds: 300,
    });
    await expect(failedRebuild.runSystemImport({
      id: jobId,
      kind: "import",
      status: "authoritative_committed",
      createdAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-25T12:00:00.000Z",
      report,
      ownerUserId,
      stagedInputId: staged.rows[0]!.id,
      leaseOwner: "expired-staging-rebuild-test",
      leaseExpiresAt: "2026-08-25T12:05:00.000Z",
    })).rejects.toThrow("forced_system_import_rebuild_failure");
    await expect(pool.query<{ status: string; report: unknown }>(
      "SELECT status,report FROM system_archive_jobs WHERE id=$1",
      [jobId],
    )).resolves.toMatchObject({ rows: [{
      status: "rebuilding",
      report: {
        ...report,
        rebuildState: {
          chronicleIndex: { ...report.rebuildState.chronicleIndex, status: "queueing" },
          assetThumbnails: { ...report.rebuildState.assetThumbnails, status: "queueing" },
        },
      },
    }] });

    await pool.query(
      `UPDATE system_archive_jobs
          SET lease_owner='replacement-system-import-worker',
              lease_expires_at=clock_timestamp()+interval '5 minutes'
        WHERE id=$1`,
      [jobId],
    );
    await expect(imports.completeImportedJob(
      { ownerUserId },
      jobId,
      "expired-staging-rebuild-test",
    )).rejects.toMatchObject({ statusCode: 409 });
    await expect(pool.query<{ status: string; lease_owner: string }>(
      "SELECT status,lease_owner FROM system_archive_jobs WHERE id=$1",
      [jobId],
    )).resolves.toMatchObject({
      rows: [{ status: "rebuilding", lease_owner: "replacement-system-import-worker" }],
    });

    await pool.query(
      `UPDATE system_archive_jobs
          SET progress=jsonb_set(progress,'{rebuildCampaignIds}','["not-a-uuid"]'::jsonb)
        WHERE id=$1`,
      [jobId],
    );
    await expect(imports.loadImportJobAuthority(
      { ownerUserId },
      jobId,
      staged.rows[0]!.id,
    )).rejects.toThrow("malformed");
  });

  it.skipIf(!supportsSecureGeneratedArchiveStaging())(
    "consumes opaque preview authority and restores through production staging",
    async () => {
      const exported = await exportArchive();
      await pool.query("TRUNCATE TABLE worlds,provider_profiles,prompt_template_overrides,imports,activity_events RESTART IDENTITY CASCADE");
      await pool.query("DELETE FROM system_archive_jobs");
      await pool.query("DELETE FROM system_archive_uploads");

      const privateRoot = await mkdtemp(join(tmpdir(), "infinitequest-system-import-production-"));
      const privateArchiveRoot = join(privateRoot, "archive");
      const privateAssetRoot = join(privateRoot, "assets");
      await mkdir(privateArchiveRoot, { recursive: true });
      await mkdir(privateAssetRoot, { recursive: true });
      let assetPublications: Parameters<typeof createSystemArchiveImportComposition>[0]["assetPublications"] | undefined;
      const storage = await createAssetImportStorageComposition(pool, {
        archiveRoot: privateArchiveRoot,
        assetRoot: privateAssetRoot,
      }, (captured) => { assetPublications = captured; });
      try {
        if (!assetPublications) throw new Error("Expected production asset publication authority.");
        const composition = createSystemArchiveImportComposition({
          pool,
          assetPublications,
          storage: storage.adapter,
          archiveRoot: privateArchiveRoot,
          capacity: { availableBytes: async () => ({ staging: 1_000_000_000, assetRoot: 1_000_000_000 }) },
          limits,
          destinationApplicationVersion: "0.1.0",
          uploadTtlSeconds: 3_600,
          previewTtlSeconds: 1_800,
          chunkBytes: exported.bytes.byteLength,
          maximumUploadBytes: limits.maxCompressedBytes,
          leaseOwner: "system-import-production-test",
          leaseSeconds: 300,
          allowUnknownFreeSpace: false,
        });
        const upload = await composition.uploads.createUpload({ ownerUserId }, {
          byteLength: exported.bytes.byteLength,
          sha256: sha256(exported.bytes),
        });
        await composition.uploads.putChunk({ ownerUserId }, {
          uploadId: upload.id,
          index: 0,
          offset: 0,
          bytes: exported.bytes,
          sha256: sha256(exported.bytes),
        });
        await composition.uploads.completeUpload({ ownerUserId }, upload.id);
        const preview = await composition.previews.preview({ ownerUserId }, upload.id);
        expect(preview.valid).toBe(true);
        if (!preview.previewHandle) throw new Error("Expected opaque System Import preview authority.");

        const imports = createPostgresSystemArchiveImportRepository(pool, { previewTtlSeconds: 1_800 });
        await imports.consumePreviewAuthority({ ownerUserId }, preview.previewHandle, randomUUID());
        const claimed = await createPostgresSystemArchiveJobRepository(pool).claimNext(
          "system-import-production-test",
          300,
        );
        expect(claimed).toMatchObject({ kind: "import", status: "revalidating" });
        await composition.imports.runSystemImport(claimed!);

        await expect(pool.query<{ status: string }>(
          "SELECT status FROM system_archive_jobs WHERE id=$1",
          [claimed!.id],
        )).resolves.toMatchObject({ rows: [{ status: "completed" }] });
        await expect(pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM worlds WHERE owner_user_id=$1",
          [ownerUserId],
        )).resolves.toMatchObject({ rows: [{ count: "1" }] });
        await expect(pool.query<{ enabled: boolean; health_status: string; encrypted_api_key: string | null }>(
          "SELECT enabled,health_status,encrypted_api_key FROM provider_profiles",
        )).resolves.toMatchObject({ rows: [{
          enabled: false,
          health_status: "unknown",
          encrypted_api_key: null,
        }] });
      } finally {
        await storage.close().catch(() => undefined);
        await rm(privateRoot, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!supportsSecureGeneratedArchiveStaging())(
    "rolls back logical authority when production Original Asset attachment fails and preserves shared bytes",
    async () => {
      const exported = await exportArchive();
      expect(exported.result.report.originalAssets).toBeGreaterThan(1);
      await pool.query("TRUNCATE TABLE worlds,provider_profiles,prompt_template_overrides,imports,activity_events RESTART IDENTITY CASCADE");
      await pool.query("DELETE FROM system_archive_jobs");
      await pool.query("DELETE FROM system_archive_uploads");

      const privateRoot = await mkdtemp(join(tmpdir(), "infinitequest-system-import-rollback-"));
      const privateArchiveRoot = join(privateRoot, "archive");
      const privateAssetRoot = join(privateRoot, "assets");
      const contentRoot = join(privateAssetRoot, "assets", "content");
      await mkdir(privateArchiveRoot, { recursive: true });
      await mkdir(contentRoot, { recursive: true });
      const sharedOriginal = originals[0]!;
      const sharedPath = join(contentRoot, sharedOriginal.contentHash);
      await writeFile(sharedPath, sharedOriginal.bytes);
      const storage = await createAssetImportStorageComposition(pool, {
        archiveRoot: privateArchiveRoot,
        assetRoot: privateAssetRoot,
      });
      try {
        await withStagedArchive(exported.bytes, limits, async (staged) => {
          const repository = createPostgresSystemArchiveImportRepository(pool, { previewTtlSeconds: 1_800 });
          const destination = await repository.destinationFingerprint({ ownerUserId }, {});
          expect(destination.destinationEmpty).toBe(true);
          const jobId = randomUUID();
          const stagedInputId = randomUUID();
          const uploadId = randomUUID();
          const authority = Object.freeze({
            jobId,
            stagedInputId,
            uploadId,
            archiveFingerprint: exported.result.artifact.contentFingerprint,
            destination,
            status: "revalidating" as const,
            report: null,
            rebuildCampaignIds: Object.freeze([]),
            rebuildAssetIds: Object.freeze([]),
          });
          const imports: typeof repository = {
            ...repository,
            loadImportJobAuthority: vi.fn(async () => authority),
            async withAtomicImport(owner, request, work) {
              return repository.withAtomicImport(owner, {
                destination: request.destination,
                ignore: request.ignore,
              }, work);
            },
          };
          const persistedAssetPublications = createPostgresAssetPublicationRepository(
            pool,
            createPostgresDurableFilesystemRepository(pool),
          );
          let attachedCount = 0;
          const assetPublications: typeof persistedAssetPublications = {
            ...persistedAssetPublications,
            async attachPublication(database, identity, command, prepared) {
              const attached = await persistedAssetPublications.attachPublication(
                database,
                identity,
                command,
                prepared,
              );
              attachedCount += 1;
              if (attachedCount === 2) throw new Error("forced_system_import_asset_attachment_failure");
              return attached;
            },
          };
          const service = createSystemArchiveImportExecutionService({
            imports,
            source: {
              async withCompletedUpload(_owner, _uploadId, inspect) {
                return inspect(staged);
              },
            },
            capacity: {
              availableBytes: async () => ({ staging: 1_000_000_000, assetRoot: 1_000_000_000 }),
            },
            limits,
            allowUnknownFreeSpace: false,
            destinationApplicationVersion: "0.1.0",
            storage: storage.adapter,
            assetPublications,
            publicationLeaseSeconds: 300,
          });

          await expect(service.runSystemImport({
            id: jobId,
            kind: "import",
            status: "revalidating",
            createdAt: "2026-08-25T12:00:00.000Z",
            updatedAt: "2026-08-25T12:00:00.000Z",
            report: null,
            ownerUserId,
            stagedInputId,
            leaseOwner: "system-import-rollback-test",
            leaseExpiresAt: "2026-08-25T12:05:00.000Z",
          })).rejects.toThrow("forced_system_import_asset_attachment_failure");
          expect(attachedCount).toBe(2);
          await expect(pool.query<{ worlds: string; providers: string; assets: string }>(
            `SELECT (SELECT count(*)::text FROM worlds WHERE owner_user_id=$1) AS worlds,
                    (SELECT count(*)::text FROM provider_profiles WHERE owner_user_id=$1) AS providers,
                    (SELECT count(*)::text FROM assets WHERE owner_user_id=$1) AS assets`,
            [ownerUserId],
          )).resolves.toMatchObject({ rows: [{ worlds: "0", providers: "0", assets: "0" }] });
          await expect(readFile(sharedPath)).resolves.toEqual(sharedOriginal.bytes);
          await expect(readdir(contentRoot)).resolves.toEqual([sharedOriginal.contentHash]);
        });
      } finally {
        await storage.close().catch(() => undefined);
        await rm(privateRoot, { recursive: true, force: true });
      }
    },
  );
});

function ReadableStreamFrom(chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  };
}
