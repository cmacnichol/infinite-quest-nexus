import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import JSZip from "jszip";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { worldContentSchema } from "../../packages/contracts/src/world-library.js";
import {
  SYSTEM_ARCHIVE_DOMAINS,
  systemArchiveManifestSchema,
} from "../../packages/contracts/src/system-archives.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import {
  createPostgresSystemArchiveExportJobPort,
  createPostgresSystemArchiveExportRepository,
} from "../../packages/database/src/system-archive-export-repository.js";
import {
  runSystemExport,
  type SystemArchiveExportDependencies,
  type SystemArchiveExportJob,
} from "../../packages/application/src/system-archives/index.js";
import {
  createPrivateSystemArchiveStaging,
  createFilesystemSystemArchiveWriter,
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
    const worldId = world.rows[0]!.id;
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
    const worldVersionId = version.rows[0]!.id;
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
    const campaignId = campaign.rows[0]!.id;
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
    const turnId = turn.rows[0]!.id;
    await pool.query(
      `INSERT INTO turn_narration_corrections (
         owner_user_id,campaign_id,turn_id,revision,narration,
         previous_effective_narration_hash,source,created_by_user_id
       ) VALUES ($1,$2,$3,1,'The gate opens silently.',$4,'user_edit',$1)`,
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
      [ownerUserId, campaignId, JSON.stringify({ summary: "The gate opened." })],
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
                archived_at=CASE WHEN $3='unbound' THEN now() ELSE NULL END
          WHERE owner_user_id=$1 AND asset_id=$2`,
        [ownerUserId, inserted.rows[0]!.id, name, name === "unbound" ? "owner_library" : name === "cover" ? "world" : "campaign"],
      );
      return { id: inserted.rows[0]!.id, path, bytes, contentHash };
    }));
    await pool.query("UPDATE worlds SET cover_asset_id=$2 WHERE id=$1", [worldId, originals[0]!.id]);
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

  async function exportArchive() {
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
    const providerEntry = Object.values(zip.files)
      .find((entry) => entry.name.startsWith("records/providers/") && !entry.dir);
    const portableProvider = JSON.parse((await providerEntry!.async("string")).trim()) as {
      record: { baseUrl: string; timeoutMs: number };
    };
    expect(portableProvider.record).toMatchObject({
      baseUrl: "https://portable.invalid/v1",
      timeoutMs: 654321,
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
    expect(preview.rebuilds).toEqual(expect.arrayContaining(["chronicle-index", "asset-thumbnails"]));
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
        excludedOperationalWork: {},
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
        excludedOperationalWork: {},
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
            excludedOperationalWork: {},
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
});

function ReadableStreamFrom(chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  };
}
