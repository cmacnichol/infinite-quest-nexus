import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalPortableImportAuthority,
  type PortableCanonicalImportAuthority
} from "../../packages/application/src/imports/private-portable-composition.js";
import {
  toPortableImportedRecordId,
  type PortableStagedInput
} from "../../packages/application/src/imports/types.js";
import { toAssetMutationIdempotencyKey } from "../../packages/application/src/assets/types.js";
import { canonicalArchiveJson, canonicalizeWorldContent } from "../../packages/contracts/src/index.js";
import { calculateContentFingerprint } from "../../packages/contracts/src/archives-node.js";
import { createPostgresImportRepository } from "../../packages/database/src/import-repository.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  createPostgresPortableFamilyMutationRepository,
  createPostgresPortableImportAuthorityRepository
} from "../../packages/database/src/portable-import-family-repository.js";
import { createPostgresWorldRepositoryAdapters } from "../../packages/database/src/world-repository.js";
import { createPortableImportExportComposition } from "../../services/runtime/src/portable-import-export-composition.js";
import { createAssetPublicationComposition } from "../../services/runtime/src/asset-import-composition.js";
import { supportsSecureGeneratedArchiveStaging } from "../../services/api/src/archive-io.js";
import {
  createDatabasePool,
  initialOwnerId,
  type DatabasePool,
  withTransaction
} from "../../packages/database/src/pool.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const secureFilesystemIt = it.runIf(supportsSecureGeneratedArchiveStaging());

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function uniquePng(seed: string): Promise<Buffer> {
  const color = createHash("sha256").update(seed).digest();
  return sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { r: color[0]!, g: color[1]!, b: color[2]!, alpha: 1 }
    }
  }).png().toBuffer();
}

integration("Task 14e3d durable portable composition authority", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  let foreignOwnerUserId = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 8);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    const foreign = await pool.query<{ id: string }>(
      "INSERT INTO users (system_key,display_name) VALUES ($1,'Foreign') RETURNING id",
      [`portable-14e3d-${crypto.randomUUID()}`]
    );
    foreignOwnerUserId = foreign.rows[0]!.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function stage() {
    const portable = createPostgresImportRepository(pool);
    const operationScopeId = `portable-14e3d-${crypto.randomUUID()}`;
    const contentHash = hash(operationScopeId);
    const operation = await pool.query<{ id: string }>(
      `INSERT INTO durable_filesystem_operations (
         owner_user_id,operation_token_hash,purpose,resource_kind,operation_scope_hash,
         lease_id,lease_owner,lease_expires_at,expires_at
       ) VALUES ($1,$2,'portable_staging','portable',$3,gen_random_uuid(),'14e3d-stage',
                 clock_timestamp()+interval '5 minutes',clock_timestamp()+interval '1 hour') RETURNING id`,
      [ownerUserId, hash(crypto.randomUUID()), hash(operationScopeId)]
    );
    const operationId = operation.rows[0]!.id;
    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lifecycle='attached',candidate_token_hash=$2,locator_token_hash=$3,
              attached_at=clock_timestamp()
        WHERE id=$1`,
      [operationId, hash(`candidate-${operationId}`), hash(`locator-${operationId}`)]
    );
    await pool.query(
      `INSERT INTO durable_filesystem_descriptors (
         operation_id,owner_user_id,descriptor_role,ordinal,relative_path,
         device_id,file_id,change_token,content_hash,byte_length
       ) VALUES ($1,$2,'delivery',0,$3,'dev','file','change',$4,64)`,
      [operationId, ownerUserId, `staging/${operationId}.pending`, contentHash]
    );
    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lifecycle='finalized',finalized_at=clock_timestamp()
        WHERE id=$1`,
      [operationId]
    );
    const stagedInput = await portable.registerStagedInput({
      ownerUserId,
      filesystemOperationId: operationId,
      operationScopeId,
      contentHash,
      byteLength: 64,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString()
    });
    return { stagedInput, contentHash };
  }

  async function preview() {
    const staged = await stage();
    const repository = createPostgresPortableImportAuthorityRepository(pool, createPostgresImportRepository(pool));
    const destination = { kind: "create_world" as const };
    const command = {
      ownerUserId,
      stagedInput: staged.stagedInput,
      kind: "world_text" as const,
      destination
    };
    const authority: PortableCanonicalImportAuthority = {
      kind: "world_text",
      destination,
      normalizedPayload: { title: "Restart-safe world", sourceText: "green hills" },
      sourceInstallationId: null,
      sourceRecordId: null,
      selectedCharacterId: null,
      providerConfigurationFingerprint: "a".repeat(64)
    };
    const authorityFingerprint = hash(canonicalPortableImportAuthority(authority));
    const value = await repository.persistPreviewAuthority({
      command,
      authority,
      authorityFingerprint,
      projection: {
        kind: "world_text",
        valid: true,
        requiresProvider: true,
        warnings: [],
        counts: { sourceCharacters: 11, sourceWords: 2 }
      },
      diagnostics: [],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString()
    });
    return { repository, command, authority, authorityFingerprint, preview: value };
  }

  function worldRepository(databasePool = pool) {
    return createPostgresWorldRepositoryAdapters(databasePool, {
      memory: { async autoEnableCampaignEmbedding() { return { enabled: false }; } }
    }).worlds;
  }

  async function createWorldScope(label: string) {
    const content = canonicalizeWorldContent({
      world: { title: label },
      playableCharacters: [{ id: "hero", name: "Hero", characterText: "A durable explorer" }]
    });
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title) VALUES ($1,$2) RETURNING id",
      [ownerUserId, label]
    );
    const worldId = world.rows[0]!.id;
    const version = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id,owner_user_id,version_number,content)
       VALUES ($1,$2,1,$3::jsonb) RETURNING id`,
      [worldId, ownerUserId, JSON.stringify(content)]
    );
    return { worldId, worldVersionId: version.rows[0]!.id, content };
  }

  async function createRealComposition(input: Readonly<{
    archiveRoot: string;
    assetRoot: string;
    target: Awaited<ReturnType<typeof createWorldScope>>;
    leaseOwner: string;
    previewTtlSeconds?: number;
    databasePool?: DatabasePool;
    exports?: Parameters<typeof createPortableImportExportComposition>[0]["exports"];
  }>) {
    const databasePool = input.databasePool ?? pool;
    return createPortableImportExportComposition({
      pool: databasePool,
      roots: { archiveRoot: input.archiveRoot, assetRoot: input.assetRoot },
      worlds: worldRepository(databasePool),
      leaseOwner: input.leaseOwner,
      ...(input.previewTtlSeconds === undefined ? {} : { previewTtlSeconds: input.previewTtlSeconds }),
      provider: {
        async convertTemplate({ template }) {
          const title = template.title.trim() || "Converted portable world";
          return {
            world: {
              format: "infinite-quest-world" as const,
              formatVersion: 1 as const,
              title,
              content: canonicalizeWorldContent({
                world: { title, background: template.summary },
                playableCharacters: [{ id: "hero", name: "Hero", characterText: "A durable explorer" }]
              })
            },
            providerConfigurationFingerprint: "b".repeat(64)
          };
        }
      },
      targets: {
        async readTargetWorldVersion(value) {
          if (value.owner.ownerUserId !== ownerUserId
            || value.worldId !== input.target.worldId
            || value.worldVersionId !== input.target.worldVersionId) return null;
          return {
            ownerUserId,
            worldId: input.target.worldId,
            worldVersionId: input.target.worldVersionId,
            content: input.target.content
          };
        }
      },
      exports: input.exports ?? {
        async buildCampaignArchive() { throw new Error("export_not_expected"); },
        async buildWorldJson() { throw new Error("export_not_expected"); }
      }
    });
  }

  async function stagedInput(
    composition: Awaited<ReturnType<typeof createPortableImportExportComposition>>,
    bytes: Uint8Array,
    label: string,
    expiresAt = new Date(Date.now() + 3_600_000).toISOString(),
  ): Promise<PortableStagedInput> {
    const staged = await composition.stageInput({
      owner: { ownerUserId },
      operationScopeId: `${label}-${crypto.randomUUID()}`,
      leaseOwner: label,
      expiresAt,
      byteLength: bytes.byteLength,
      source: [bytes]
    });
    return staged.stagedInput;
  }

  async function campaignArchiveWithAssets(
    label: string,
    sourceAssetIds: readonly string[],
  ): Promise<Uint8Array> {
    const archive = new JSZip();
    archive.file("campaign.json", JSON.stringify({
      format: "infinite-quest-campaign",
      formatVersion: 1,
      campaign: { title: `${label} campaign` },
      world: { title: `${label} world`, character: "Hero\nA durable explorer" },
      turns: [{ id: `${label}-turn`, action: "Look", narration: "Hero enters the archive hall." }]
    }));
    for (const [index, sourceAssetId] of sourceAssetIds.entries()) {
      archive.file(
        `assets/${sourceAssetId}.png`,
        await uniquePng(`portable-asset-${label}-${index}`),
      );
    }
    return archive.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  }

  async function campaignArchive(label: string): Promise<Uint8Array> {
    return campaignArchiveWithAssets(label, [crypto.randomUUID()]);
  }

  async function richCampaignArchive(label: string) {
    const sourceCampaignId = crypto.randomUUID();
    const sourceWorldId = crypto.randomUUID();
    const sourceWorldVersionId = crypto.randomUUID();
    const sourceTurnId = crypto.randomUUID();
    const sourceAssetId = crypto.randomUUID();
    const sourceSetId = crypto.randomUUID();
    const transientSetId = crypto.randomUUID();
    const sourceSegmentId = crypto.randomUUID();
    const sourceContextId = crypto.randomUUID();
    const image = await uniquePng(`${label}-${sourceAssetId}`);
    const contentHash = createHash("sha256").update(image).digest("hex");
    const assetPath = `assets/sha256/${contentHash.slice(0, 2)}/${contentHash}.png`;
    const content = canonicalizeWorldContent({
      world: { title: `${label} world` },
      playableCharacters: [{ id: "hero", name: "Hero" }]
    });
    const worldHash = hash(canonicalArchiveJson(content));
    const campaign = {
      formatVersion: 3,
      campaign: {
        sourceCampaignId, sourceWorldVersionId, title: `${label} campaign`, stateRevision: 1,
        selectedCharacterId: "hero", characterSnapshot: { id: "hero", name: "Hero" },
        characterProfile: { name: "Hero" }, characterProfileRevision: 1
      },
      settings: { storyLength: "standard", turnControlStyle: "flexible_action" },
      world: { canonicalHash: worldHash, sourceWorldId, sourceWorldVersionId },
      turns: [{
        id: sourceTurnId, turnNumber: 1, action: "Look", narration: "A restored archive hall.",
        imagePrompt: "A quiet archive hall", imageUrl: `/api/v1/assets/${sourceAssetId}`,
        worldStateSnapshot: { scratchpad: "", trackers: [] }, createdAt: "2030-01-02T00:00:00.000Z"
      }],
      trackers: [], defaultTriggers: [], eventTriggers: [], pendingEventTriggers: [], rpgStats: [],
      archiveRecords: {
        formatVersion: 1,
        characterProfileEdits: [{ id: crypto.randomUUID(), revision: 1, previous_profile: null, next_profile: { name: "Hero" }, edit_source: "imported", created_at: "2030-01-01T00:00:00.000Z" }],
        stateEdits: [{ id: crypto.randomUUID(), effective_turn_number: 1, revision: 1, state_snapshot_private: { scratchpad: "restored", trackers: [] }, changed_fields: ["scratchpad"], created_at: "2030-01-02T00:00:00.000Z" }],
        worldMigrations: [{ from_world_version_id: crypto.randomUUID(), to_world_version_id: sourceWorldVersionId }],
        illustrationConfig: { enabled: false, source_policy: "off", matching_scope: "campaign", confidence_profile: "strict", repetition_window: 3, model: "", size: "1024x1024", aspect_ratio: "1:1", quality: "auto", output_format: "png", max_attempts: 3, segment_word_count: 500, images_per_segment: 1, segment_prompt_mode: "direct", refinement_prompt: "" },
        illustrationSets: [
          { id: sourceSetId, turn_id: sourceTurnId, source_text_hash: "source-hash", segment_word_count: 500, images_per_segment: 1, prompt_mode: "direct", status: "completed", is_active: true, character_visual_reference: "Hero", created_at: "2030-01-02T00:00:00.000Z", completed_at: "2030-01-02T00:01:00.000Z" },
          { id: transientSetId, turn_id: null, source_text_hash: "transient", segment_word_count: 500, images_per_segment: 1, prompt_mode: "direct", status: "generating", is_active: false, character_visual_reference: "", created_at: "2030-01-02T00:00:00.000Z", completed_at: null }
        ],
        illustrationSegments: [
          { id: sourceSegmentId, illustration_set_id: sourceSetId, turn_id: sourceTurnId, ordinal: 0, start_offset: 0, end_offset: 24, start_word: 0, end_word: 4, source_text: "A restored archive hall.", source_text_hash: "segment-hash", direct_prompt: "Archive hall", resolved_prompt: "Archive hall", prompt_source: "direct", status: "completed", created_at: "2030-01-02T00:00:00.000Z" },
          { id: crypto.randomUUID(), illustration_set_id: transientSetId, turn_id: null, ordinal: 0, start_offset: 0, end_offset: 0, start_word: 0, end_word: 0, source_text: "", source_text_hash: "transient", direct_prompt: "", resolved_prompt: "", prompt_source: "direct", status: "pending", created_at: "2030-01-02T00:00:00.000Z" }
        ],
        costs: [{ turn_id: sourceTurnId, provider_type: "openai_compatible", category: "image", operation: "illustration", requested_model: "image-model", resolved_model: "image-model", amount: "0.25", currency: "USD", usage_metadata: { images: 1 }, occurred_at: "2030-01-02T00:00:00.000Z" }]
      }
    };
    const world = { canonicalHash: worldHash, sourceWorldId, sourceWorldVersionId, versionNumber: 1, content };
    const chronicle = {
      formatVersion: 1,
      memories: [{ id: crypto.randomUUID(), world_version_id: sourceWorldVersionId, turn_id: sourceTurnId, memory_kind: "turn_fiction", ordinal: 1, content: "A restored archive hall.", token_estimate: 6, importance: 0.8, entities: [], entity_ids: [], metadata: { imported: true }, created_at: "2030-01-02T00:00:00.000Z" }],
      summaries: [{ id: crypto.randomUUID(), through_turn: 1, summary_kind: "campaign_summary", content: { text: "The hall was restored." }, token_estimate: 6, created_at: "2030-01-02T00:00:00.000Z" }]
    };
    const assetRecord = {
      sourceAssetId, contentHash, archivePath: assetPath, mimeType: "image/png", byteLength: image.byteLength,
      pixelWidth: 1, pixelHeight: 1, technicalMetadata: { format: "png", pages: 1 },
      library: { title: "Restored hall", caption: "A caption", notes: "Imported", tags: ["hall"], origin: "imported", reviewStatus: "eligible", reuseScope: "campaign", automaticReuseEnabled: false, contentCategories: ["location"], favorite: true, archivedAt: null },
      createdAt: "2030-01-01T00:00:00.000Z",
      bindings: [
        { role: "world_cover", worldId: sourceWorldId },
        { role: "turn_illustration", campaignId: sourceCampaignId, turnId: sourceTurnId },
        { role: "illustration_segment_variant", campaignId: sourceCampaignId, turnId: sourceTurnId, segmentId: sourceSegmentId, variantIndex: 0 },
        { role: "generation_context", campaignId: sourceCampaignId, worldId: sourceWorldId, worldVersionId: sourceWorldVersionId, turnId: sourceTurnId, sourceContextId }
      ]
    };
    const payloads = [
      ["campaign.json", campaign, "campaign"],
      ["world.json", world, "world"],
      ["chronicle.json", chronicle, "chronicle"],
      ["assets/assets.json", { formatVersion: 1, assets: [assetRecord] }, "assets"]
    ] as const;
    const entries = payloads.map(([path, value, logicalType]) => {
      const body = canonicalArchiveJson(value);
      return { path, logicalType, mediaType: "application/json", byteLength: Buffer.byteLength(body), sha256: hash(body), body };
    });
    const manifestEntries = [
      ...entries.map(({ body: _body, ...entry }) => entry),
      { path: assetPath, logicalType: "asset-original", mediaType: "image/png", byteLength: image.byteLength, sha256: contentHash }
    ];
    const manifest = {
      format: "infinite-quest-archive", formatVersion: 1, archiveType: "campaign",
      createdAt: "2030-01-01T00:00:00.000Z",
      contentFingerprint: calculateContentFingerprint({
        payloadHashes: entries.map((entry) => entry.sha256), originalAssetHashes: [contentHash]
      }),
      campaignId: sourceCampaignId, worldId: sourceWorldId, worldVersionId: sourceWorldVersionId,
      entries: manifestEntries,
      payloads: payloads.map(([path, _value, kind]) => ({ kind, path, formatVersion: 1 })),
      assets: [assetRecord]
    };
    const archive = new JSZip();
    archive.file("manifest.json", canonicalArchiveJson(manifest));
    for (const entry of entries) archive.file(entry.path, entry.body);
    archive.file(assetPath, image);
    return {
      bytes: await archive.generateAsync({ type: "uint8array", compression: "DEFLATE" }),
      sourceAssetId,
      sourceContextId
    };
  }

  it("persists private canonical authority and rolls a caller claim back without consuming staging", async () => {
    const fixture = await preview();
    const stored = await pool.query<{
      normalized_payload: Record<string, unknown>;
      authority_fingerprint: string;
      provider_configuration_fingerprint: string;
      phase: string;
      work_version: number;
    }>(
      `SELECT operation.normalized_payload,operation.authority_fingerprint,
              operation.provider_configuration_fingerprint,work.phase,work.work_version
         FROM portable_import_operations operation
         JOIN portable_import_work work ON work.operation_id=operation.id
        WHERE operation.owner_user_id=$1 AND operation.preview_token_hash=$2`,
      [ownerUserId, hash(fixture.preview.previewHandle.token)]
    );
    expect(stored.rows).toEqual([{
      normalized_payload: fixture.authority.normalizedPayload,
      authority_fingerprint: fixture.authorityFingerprint,
      provider_configuration_fingerprint: "a".repeat(64),
      phase: "previewed",
      work_version: 1
    }]);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const claimed = await fixture.repository.claimPreviewAuthority(client, {
        command: {
          ownerUserId,
          kind: "world_text",
          destination: fixture.command.destination,
          previewHandle: fixture.preview.previewHandle,
          idempotencyKey: `rollback-${crypto.randomUUID()}`
        },
        leaseOwner: "14e3d-rollback",
        leaseSeconds: 60
      });
      expect(claimed.outcome).toBe("ready");
      if (claimed.outcome === "ready") {
        expect(claimed.authority).toEqual(fixture.authority);
        await fixture.repository.updateProgress(client, claimed.claim, {
          phase: "mutating",
          percentage: 60,
          diagnosticCode: null
        });
      }
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    expect(await fixture.repository.readProgress(
      { ownerUserId },
      fixture.preview.previewHandle.token,
    )).toMatchObject({ phase: "previewed", workVersion: 1, status: "running" });
    await expect(pool.query(
      `SELECT operation.status AS operation_status,staged.status AS staged_status
         FROM portable_import_operations operation
         JOIN portable_staged_inputs staged ON staged.id=operation.staged_input_id
        WHERE operation.preview_token_hash=$1`,
      [hash(fixture.preview.previewHandle.token)]
    )).resolves.toMatchObject({ rows: [{ operation_status: "previewed", staged_status: "staged" }] });
  });

  it("owner-scopes abort, releases work authority, and cannot erase a completed result", async () => {
    const abortedFixture = await preview();
    expect(await abortedFixture.repository.abort(
      { ownerUserId: foreignOwnerUserId },
      abortedFixture.preview.previewHandle.token,
    )).toBeNull();
    expect(await abortedFixture.repository.abort(
      { ownerUserId },
      abortedFixture.preview.previewHandle.token,
    )).toMatchObject({ status: "aborted", phase: "previewed", workVersion: 1 });

    const completedFixture = await preview();
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title) VALUES ($1,'14e3d world') RETURNING id",
      [ownerUserId]
    );
    const worldId = world.rows[0]!.id;
    const version = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id,owner_user_id,version_number,content)
       VALUES ($1,$2,1,'{}') RETURNING id`,
      [worldId, ownerUserId]
    );
    const worldVersionId = version.rows[0]!.id;
    const client = await pool.connect();
    let expectedResult: unknown;
    try {
      await client.query("BEGIN");
      const claimed = await completedFixture.repository.claimPreviewAuthority(client, {
        command: {
          ownerUserId,
          kind: "world_text",
          destination: completedFixture.command.destination,
          previewHandle: completedFixture.preview.previewHandle,
          idempotencyKey: `complete-${crypto.randomUUID()}`
        },
        leaseOwner: "14e3d-complete",
        leaseSeconds: 60
      });
      if (claimed.outcome !== "ready") throw new Error("expected ready claim");
      const imported = await client.query<{ id: string }>(
        `INSERT INTO imports (
           owner_user_id,source_type,source_name,source_hash,status,
           world_id,world_version_id,stats,completed_at
         ) VALUES ($1,'portable_14e3d','world.txt',$2,'completed',$3,$4,'{}',clock_timestamp())
         RETURNING id`,
        [ownerUserId, completedFixture.authorityFingerprint, worldId, worldVersionId]
      );
      const importId = imported.rows[0]!.id;
      expectedResult = await completedFixture.repository.completeImport(client, claimed.commitClaim, {
        importId,
        importedRecordId: toPortableImportedRecordId(importId),
        duplicate: false,
        diagnostics: [],
        result: { kind: "world", importId, worldId, worldVersionId, duplicate: false },
        resultExpiresAt: new Date(Date.now() + 3_600_000).toISOString()
      });
      await completedFixture.repository.completeProgress(client, claimed.claim);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    expect(await completedFixture.repository.abort(
      { ownerUserId },
      completedFixture.preview.previewHandle.token,
    )).toMatchObject({ status: "completed", percentage: 100 });
    expect(expectedResult).toMatchObject({ kind: "world_text", duplicate: false });
  });

  it("rejects stale and foreign completion claims outside an already-completed exact operation", async () => {
    const fixture = await preview();
    const client = await pool.connect();
    let staleClaim: import("../../packages/application/src/imports/private-portable-composition.js").PrivatePortableImportWorkClaim | undefined;
    try {
      await client.query("BEGIN");
      const claimed = await fixture.repository.claimPreviewAuthority(client, {
        command: {
          ownerUserId,
          kind: "world_text",
          destination: fixture.command.destination,
          previewHandle: fixture.preview.previewHandle,
          idempotencyKey: `stale-completion-${crypto.randomUUID()}`
        },
        leaseOwner: "14e3d-stale-completion",
        leaseSeconds: 60
      });
      if (claimed.outcome !== "ready") throw new Error("expected ready claim");
      staleClaim = claimed.claim;
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await expect(withTransaction(pool, (database) => (
      fixture.repository.completeProgress(database, staleClaim!)
    ))).rejects.toThrow("portable_import_claim_lost");
    await expect(withTransaction(pool, (database) => (
      fixture.repository.completeProgress(database, {
        ...staleClaim!,
        ownerUserId: foreignOwnerUserId
      })
    ))).rejects.toThrow("portable_import_claim_lost");
  });

  it("rolls embedded world, campaign ledger, Chronicle, asset reference, and import back together", async () => {
    const worlds = createPostgresWorldRepositoryAdapters(pool, {
      memory: { async autoEnableCampaignEmbedding() { return { enabled: false }; } }
    }).worlds;
    const mutations = createPostgresPortableFamilyMutationRepository(worlds);
    const authorityFingerprint = hash(`embedded-${crypto.randomUUID()}`);
    const client = await pool.connect();
    let result: Awaited<ReturnType<typeof mutations.commitCampaignZip>> | undefined;
    let assetId = "";
    try {
      await client.query("BEGIN");
      const asset = await client.query<{ id: string }>(
        `INSERT INTO assets (
           owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length
         ) VALUES ($1,$2,'filesystem',$3,'image/png',4) RETURNING id`,
        [ownerUserId, hash(`asset-${authorityFingerprint}`), `originals/${authorityFingerprint}.png`]
      );
      assetId = asset.rows[0]!.id;
      result = await mutations.commitCampaignZip(client, {
        owner: { ownerUserId },
        destination: { kind: "embedded", operation: "create_world" },
        authorityFingerprint,
        payload: {
          sourceName: "campaign.zip",
          story: {
            format: "infinite-quest-campaign",
            formatVersion: 1,
            campaign: { title: "Atomic embedded campaign" },
            world: { title: "Atomic embedded world", character: "Mira\nA scout" },
            turns: [{ id: "source-turn-1", action: "Look", narration: "Mira surveys the valley." }]
          },
          embeddedWorldImportRequest: JSON.parse(JSON.stringify({
            sourceName: "campaign.zip",
            worldExport: {
              format: "infinite-quest-world",
              formatVersion: 1,
              title: "Atomic embedded world",
              content: canonicalizeWorldContent({
                world: { title: "Atomic embedded world" },
                playableCharacters: [{ id: "mira", name: "Mira", characterText: "A scout" }]
              })
            }
          }))
        },
        publishedAssets: [{
          assetId,
          mimeType: "image/png",
          byteLength: 4,
          contentHash: hash(`asset-${authorityFingerprint}`),
          derivativeIds: []
        }]
      });
      expect(result).toMatchObject({ duplicate: false });
      expect(await client.query("SELECT 1 FROM worlds WHERE id=$1", [result.worldId]))
        .toMatchObject({ rowCount: 1 });
      expect(await client.query("SELECT 1 FROM campaigns WHERE id=$1", [result.campaignId]))
        .toMatchObject({ rowCount: 1 });
      expect(await client.query("SELECT 1 FROM asset_references WHERE asset_id=$1 AND campaign_id=$2", [assetId, result.campaignId]))
        .toMatchObject({ rowCount: 1 });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    if (!result?.campaignId) throw new Error("expected embedded campaign result");
    await expect(pool.query(
      `SELECT
         (SELECT count(*)::int FROM worlds WHERE id=$1) AS worlds,
         (SELECT count(*)::int FROM world_versions WHERE id=$2) AS versions,
         (SELECT count(*)::int FROM campaigns WHERE id=$3) AS campaigns,
         (SELECT count(*)::int FROM turns WHERE campaign_id=$3) AS turns,
         (SELECT count(*)::int FROM chronicle_memories WHERE campaign_id=$3) AS memories,
         (SELECT count(*)::int FROM asset_references WHERE campaign_id=$3) AS asset_refs,
         (SELECT count(*)::int FROM imports WHERE source_hash=$4 OR id=$5) AS imports,
         (SELECT count(*)::int FROM assets WHERE id=$6) AS assets`,
      [result.worldId, result.worldVersionId, result.campaignId, authorityFingerprint, result.importId, assetId]
    )).resolves.toMatchObject({
      rows: [{ worlds: 0, versions: 0, campaigns: 0, turns: 0, memories: 0, asset_refs: 0, imports: 0, assets: 0 }]
    });
  });

  secureFilesystemIt("wires every non-ZIP family through real preview, commit, and same-key replay", async () => {
    const target = await createWorldScope(`14e3d family target ${crypto.randomUUID()}`);
    const archiveRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-family-archive-`);
    const assetRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-family-assets-`);
    const composition = await createRealComposition({
      archiveRoot,
      assetRoot,
      target,
      leaseOwner: "14e3d-family-matrix"
    });
    const encoder = new TextEncoder();
    const existing = {
      kind: "existing_world_version" as const,
      worldId: target.worldId,
      worldVersionId: target.worldVersionId
    };
    const create = { kind: "create_world" as const };
    const portableWorld = {
      format: "infinite-quest-world" as const,
      formatVersion: 1 as const,
      title: `Portable JSON ${crypto.randomUUID()}`,
      content: canonicalizeWorldContent({
        world: { title: "Portable JSON" },
        playableCharacters: [{ id: "hero", name: "Hero" }]
      })
    };
    const cyoa = await readFile(new URL("../fixtures/cyoa_writing_com_sample.json", import.meta.url), "utf8");
    const storyText = `-- Story Background --\nA durable road.\n-- Character --\nHero\n-- Turn 1 --\nOutcome\n-------\nThe road opens.`;
    const variants: readonly Readonly<{
      kind: string;
      bytes: Uint8Array;
      execute(staged: PortableStagedInput, idempotencyKey: string): Promise<readonly [unknown, unknown]>;
    }>[] = [
      {
        kind: "legacy_story",
        bytes: encoder.encode(JSON.stringify({
          world: { title: `Legacy ${crypto.randomUUID()}` },
          turns: [{ id: "legacy-turn", action: "Look", narration: "The horizon clears." }]
        })),
        async execute(staged, idempotencyKey) {
          const preview = await composition.previewLegacyStory({ ownerUserId, stagedInput: staged, kind: "legacy_story", destination: create });
          const command = { ownerUserId, kind: "legacy_story" as const, destination: preview.destination, previewHandle: preview.previewHandle, idempotencyKey };
          const committed = await composition.commit(command);
          return [committed, await composition.commit(command)];
        }
      },
      {
        kind: "infinite_worlds",
        bytes: encoder.encode(JSON.stringify({
          title: `Infinite ${crypto.randomUUID()}`,
          background: "A deterministic imported world.",
          possibleCharacters: [{ name: "Hero", description: "A durable explorer." }]
        })),
        async execute(staged, idempotencyKey) {
          const preview = await composition.previewInfiniteWorlds({ ownerUserId, stagedInput: staged, kind: "infinite_worlds", destination: create });
          const command = { ownerUserId, kind: "infinite_worlds" as const, destination: preview.destination, previewHandle: preview.previewHandle, idempotencyKey };
          const committed = await composition.commit(command);
          return [committed, await composition.commit(command)];
        }
      },
      {
        kind: "cyoa",
        bytes: encoder.encode(cyoa),
        async execute(staged, idempotencyKey) {
          const preview = await composition.previewCyoa({ ownerUserId, stagedInput: staged, kind: "cyoa", destination: create });
          const command = { ownerUserId, kind: "cyoa" as const, destination: preview.destination, previewHandle: preview.previewHandle, idempotencyKey };
          const committed = await composition.commit(command);
          return [committed, await composition.commit(command)];
        }
      },
      {
        kind: "world_json",
        bytes: encoder.encode(JSON.stringify(portableWorld)),
        async execute(staged, idempotencyKey) {
          const preview = await composition.previewWorldJson({ ownerUserId, stagedInput: staged, kind: "world_json", destination: create });
          const command = { ownerUserId, kind: "world_json" as const, destination: preview.destination, previewHandle: preview.previewHandle, idempotencyKey };
          const committed = await composition.commit(command);
          return [committed, await composition.commit(command)];
        }
      },
      {
        kind: "world_text",
        bytes: encoder.encode(`A quiet archive city ${crypto.randomUUID()} where Hero follows durable recovery rules.`),
        async execute(staged, idempotencyKey) {
          const preview = await composition.previewWorldText({ ownerUserId, stagedInput: staged, kind: "world_text", destination: create });
          const command = { ownerUserId, kind: "world_text" as const, destination: preview.destination, previewHandle: preview.previewHandle, idempotencyKey };
          const committed = await composition.commit(command);
          return [committed, await composition.commit(command)];
        }
      },
      {
        kind: "story_text",
        bytes: encoder.encode(storyText),
        async execute(staged, idempotencyKey) {
          const preview = await composition.previewStoryText({
            ownerUserId,
            stagedInput: staged,
            kind: "story_text",
            destination: existing,
            selectedCharacterId: "hero"
          });
          const command = { ownerUserId, kind: "story_text" as const, destination: preview.destination, previewHandle: preview.previewHandle, idempotencyKey };
          const committed = await composition.commit(command);
          return [committed, await composition.commit(command)];
        }
      }
    ];
    try {
      for (const variant of variants) {
        const staged = await stagedInput(composition, variant.bytes, `14e3d-${variant.kind}`);
        const [committed, replayed] = await variant.execute(staged, `14e3d-${variant.kind}-${crypto.randomUUID()}`);
        expect(committed).toMatchObject({ kind: variant.kind, duplicate: false });
        expect(replayed).toEqual(committed);
      }
    } finally {
      await composition.close();
    }
  });

  secureFilesystemIt("commits normalized Legacy Story character, state, metadata, settings, and continuity authority", async () => {
    const target = await createWorldScope(`14e3d legacy fidelity target ${crypto.randomUUID()}`);
    const composition = await createRealComposition({
      archiveRoot: await mkdtemp(`${tmpdir()}/iqn-14e3d-legacy-fidelity-archive-`),
      assetRoot: await mkdtemp(`${tmpdir()}/iqn-14e3d-legacy-fidelity-assets-`),
      target,
      leaseOwner: "14e3d-legacy-fidelity"
    });
    const story = {
      world: {
        title: `Legacy fidelity ${crypto.randomUUID()}`,
        character: "Mara Vale\nAn exiled cartographer.",
        suppressTriggers: true
      },
      settings: {
        storyLength: "long",
        turnControlStyle: "flexible_scene",
        useRpgStats: true,
        memoryManagementMode: "scheduled",
        storyHistoryTokenLimit: 128_000
      },
      rpgStats: [{ name: "Resolve", value: 71 }],
      defaultTriggers: [{ name: "Map fragments", value: "0" }],
      turns: [{
        id: "legacy-fidelity-turn",
        turnNumber: 9,
        action: "Open the archive",
        inputMode: "scene",
        inputModeSource: "generated_choice",
        narration: "The bronze doors open.",
        scratchpadSnapshot: "The key is warm.",
        trackersSnapshot: [{ name: "Archive", value: "open" }],
        worldStateSnapshot: { pendingEventTriggers: [{ name: "Bell", timing: "after" }] },
        roll: { total: 61, target: 70 },
        llmModelInfo: { model: "legacy-model" },
        importedFrom: { source: "browser" },
        createdAt: "2025-01-02T03:04:05.000Z"
      }],
      fullHistory: {
        plotDetails: "Mara reached the archive. DC 15 Wisdom check succeeded.",
        otherImportantNotes: "The bronze key remains important."
      },
      fullHistoryCompressedThroughTurn: 1
    };
    try {
      const staged = await stagedInput(
        composition,
        new TextEncoder().encode(JSON.stringify(story)),
        "14e3d-legacy-fidelity",
      );
      const preview = await composition.previewLegacyStory({
        ownerUserId,
        stagedInput: staged,
        kind: "legacy_story",
        destination: { kind: "create_world" }
      });
      expect(preview.projection.warnings).toEqual(expect.arrayContaining([
        expect.stringContaining("Chronicle replaces legacy memory management mode"),
        expect.stringContaining("provider context window replaces legacy story history token limit")
      ]));
      const committed = await composition.commit({
        ownerUserId,
        kind: "legacy_story",
        destination: preview.destination,
        previewHandle: preview.previewHandle,
        idempotencyKey: `14e3d-legacy-fidelity-${crypto.randomUUID()}`
      });
      const result = committed.result as Readonly<{ campaignId: string; stats: Record<string, unknown> }>;
      const campaign = await pool.query<{
        selected_character_id: string | null;
        character_snapshot: Record<string, unknown> | null;
        story_length_profile: string;
        turn_control_style: string;
        legacy_settings: Record<string, unknown>;
      }>(
        `SELECT selected_character_id,character_snapshot,story_length_profile,turn_control_style,legacy_settings
           FROM campaigns WHERE owner_user_id=$1 AND id=$2`,
        [ownerUserId, result.campaignId]
      );
      expect(campaign.rows[0]).toMatchObject({
        selected_character_id: expect.stringMatching(/^legacy-import-character-/u),
        character_snapshot: { name: "Mara Vale", characterText: "Mara Vale\nAn exiled cartographer." },
        story_length_profile: "long",
        turn_control_style: "flexible_scene",
        legacy_settings: { useRpgStats: true, suppressEventTriggers: true }
      });
      const turn = await pool.query<{
        turn_number: number;
        input_mode: string;
        input_mode_source: string;
        mechanics_private: Record<string, unknown>;
        state_snapshot_private: Record<string, unknown>;
        model_metadata: Record<string, unknown>;
        import_metadata: Record<string, unknown>;
        accepted_at: Date;
      }>(
        `SELECT turn_number,input_mode,input_mode_source,mechanics_private,state_snapshot_private,
                model_metadata,import_metadata,accepted_at
           FROM turns WHERE owner_user_id=$1 AND campaign_id=$2`,
        [ownerUserId, result.campaignId]
      );
      expect(turn.rows[0]).toMatchObject({
        turn_number: 1,
        input_mode: "scene",
        input_mode_source: "generated_choice",
        mechanics_private: { total: 61, target: 70 },
        state_snapshot_private: {
          scratchpad: "The key is warm.",
          trackers: [{ id: "Archive", name: "Archive", value: "open", rules: "" }],
          continuitySummary: "Plot: Mara reached the archive.\n\nImportant notes: The bronze key remains important."
        },
        model_metadata: { model: "legacy-model" },
        import_metadata: { sourceTurnId: "legacy-fidelity-turn", sourceTurnNumber: 9 }
      });
      expect(turn.rows[0]?.accepted_at.toISOString()).toBe("2025-01-02T03:04:05.000Z");
      const memories = await pool.query<{ memory_kind: string; content: string }>(
        `SELECT memory_kind,content FROM chronicle_memories
          WHERE owner_user_id=$1 AND campaign_id=$2 ORDER BY memory_kind`,
        [ownerUserId, result.campaignId]
      );
      expect(memories.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ memory_kind: "legacy_summary", content: "Plot: Mara reached the archive.\n\nImportant notes: The bronze key remains important." }),
        expect.objectContaining({ memory_kind: "turn_fiction", content: expect.stringContaining("The bronze doors open.") })
      ]));
      expect(memories.rows.map((memory) => memory.content).join("\n")).not.toMatch(/DC 15|Wisdom check/u);
      expect(result.stats).toMatchObject({ importedSummary: true, preservedTurnStateCount: 1, warningCount: 3, summaryThroughTurn: 1 });
    } finally {
      await composition.close();
    }
  });

  secureFilesystemIt("commits an embedded Campaign ZIP and its asset through the real composition", async () => {
    const target = await createWorldScope(`14e3d unused campaign target ${crypto.randomUUID()}`);
    const archiveRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-campaign-archive-`);
    const assetRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-campaign-assets-`);
    const composition = await createRealComposition({ archiveRoot, assetRoot, target, leaseOwner: "14e3d-campaign" });
    const sourceAssetId = crypto.randomUUID();
    const archive = new JSZip();
    archive.file("campaign.json", JSON.stringify({
      format: "infinite-quest-campaign",
      formatVersion: 1,
      campaign: { title: `Embedded campaign ${crypto.randomUUID()}` },
      world: { title: `Embedded world ${crypto.randomUUID()}`, character: "Hero\nA durable explorer" },
      turns: [{ id: "embedded-turn", action: "Look", narration: "Hero enters the archive hall." }]
    }));
    archive.file(`assets/${sourceAssetId}.png`, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ));
    const bytes = await archive.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    try {
      const staged = await stagedInput(composition, bytes, "14e3d-campaign");
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
        idempotencyKey: `14e3d-campaign-${crypto.randomUUID()}`
      };
      const committed = await composition.commit(command);
      expect(committed).toMatchObject({
        kind: "campaign_zip",
        duplicate: false,
        result: { stats: { assetCount: 1 }, duplicate: false }
      });
      expect(await composition.commit(command)).toEqual(committed);
      expect(await pool.query(
        `SELECT count(*)::int AS count
           FROM asset_references reference
           JOIN imports imported ON imported.campaign_id=reference.campaign_id
          WHERE imported.id=$1 AND reference.owner_user_id=$2`,
        [committed.importedRecordId, ownerUserId]
      )).toMatchObject({ rows: [{ count: 1 }] });
    } finally {
      await composition.close();
    }
  });

  secureFilesystemIt("restores current manifest campaign records, rich asset metadata, and source bindings", async () => {
    const target = await createWorldScope(`14e3d unused rich target ${crypto.randomUUID()}`);
    const archiveRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-rich-archive-`);
    const assetRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-rich-assets-`);
    const composition = await createRealComposition({ archiveRoot, assetRoot, target, leaseOwner: "14e3d-rich" });
    const archive = await richCampaignArchive(`14e3d rich ${crypto.randomUUID()}`);
    try {
      const staged = await stagedInput(composition, archive.bytes, "14e3d-rich");
      const preview = await composition.previewCampaignZip({
        ownerUserId,
        stagedInput: staged,
        kind: "campaign_zip",
        destination: { kind: "embedded", operation: "create_world" }
      });
      expect(preview.projection.warnings).toEqual([
        expect.stringContaining("Migration history references source world versions"),
        expect.stringContaining("Ignored 1 turnless illustration set and 1 turnless illustration segment")
      ]);
      const command = {
        ownerUserId,
        kind: "campaign_zip" as const,
        destination: preview.destination,
        previewHandle: preview.previewHandle,
        idempotencyKey: `14e3d-rich-${crypto.randomUUID()}`
      };
      const committed = await composition.commit(command);
      const result = committed.result as { campaignId: string; worldId: string; stats: { memoryCount: number; summaryCount: number } };
      expect(result.stats).toMatchObject({ memoryCount: 1, summaryCount: 1 });
      expect(await composition.commit(command)).toEqual(committed);
      await expect(pool.query(
        `SELECT campaign.title,turns.image_url,library.title AS asset_title,library.favorite,
                assets.pixel_width,world.cover_asset_id,
                (SELECT token_estimate FROM chronicle_memories memory WHERE memory.campaign_id=campaign.id) AS memory_tokens,
                (SELECT token_estimate FROM summary_checkpoints summary WHERE summary.campaign_id=campaign.id) AS summary_tokens,
                (SELECT count(*)::int FROM campaign_illustration_configs config WHERE config.campaign_id=campaign.id) AS illustration_configs,
                (SELECT count(*)::int FROM turn_illustration_sets illustration_set WHERE illustration_set.campaign_id=campaign.id) AS illustration_sets,
                (SELECT count(*)::int FROM turn_illustration_segments illustration_segment WHERE illustration_segment.campaign_id=campaign.id) AS illustration_segments,
                (SELECT count(*)::int FROM campaign_character_profile_edits edit WHERE edit.campaign_id=campaign.id) AS profile_edits,
                (SELECT count(*)::int FROM campaign_state_edits edit WHERE edit.campaign_id=campaign.id) AS state_edits,
                (SELECT count(*)::int FROM turn_illustration_segment_assets variant
                  JOIN turn_illustration_segments segment ON segment.id=variant.segment_id
                 WHERE segment.campaign_id=campaign.id) AS segment_variants,
                (SELECT count(*)::int FROM asset_generation_contexts context WHERE context.campaign_id=campaign.id) AS generation_contexts,
                (SELECT count(*)::int FROM provider_cost_events cost WHERE cost.campaign_id=campaign.id) AS costs
           FROM campaigns campaign
           JOIN turns ON turns.campaign_id=campaign.id
           JOIN worlds world ON world.id=$2 AND world.owner_user_id=campaign.owner_user_id
           JOIN assets ON turns.image_url=('/api/v1/assets/' || assets.id::text)
           JOIN asset_library_entries library ON library.asset_id=assets.id
          WHERE campaign.id=$1 AND campaign.owner_user_id=$3`,
        [result.campaignId, result.worldId, ownerUserId]
      )).resolves.toMatchObject({
        rows: [{
          asset_title: "Restored hall",
          favorite: true,
          pixel_width: 1,
          cover_asset_id: expect.any(String),
          memory_tokens: 6,
          summary_tokens: 6,
          illustration_configs: 1,
          illustration_sets: 1,
          illustration_segments: 1,
          profile_edits: 1,
          state_edits: 1,
          segment_variants: 1,
          generation_contexts: 2,
          costs: 1
        }]
      });
    } finally {
      await composition.close();
    }
  });

  secureFilesystemIt("recovers attached imported assets before returning committed replay after restart", async () => {
    const target = await createWorldScope(`14e3d finalize recovery target ${crypto.randomUUID()}`);
    const archiveRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-finalize-archive-`);
    const assetRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-finalize-assets-`);
    let composition = await createRealComposition({ archiveRoot, assetRoot, target, leaseOwner: "14e3d-finalize-a" });
    const bytes = await campaignArchive(`finalize-${crypto.randomUUID()}`);
    const staged = await stagedInput(composition, bytes, "14e3d-finalize");
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
      idempotencyKey: `14e3d-finalize-${crypto.randomUUID()}`
    };
    await pool.query(`CREATE FUNCTION task_14e3d_finalize_fault() RETURNS trigger
      LANGUAGE plpgsql AS $fault$ BEGIN RAISE EXCEPTION 'task_14e3d_finalize_fault'; END; $fault$`);
    await pool.query(`CREATE TRIGGER task_14e3d_finalize_fault_trigger
      BEFORE UPDATE ON durable_filesystem_operations
      FOR EACH ROW WHEN (NEW.lifecycle='finalized' AND OLD.lifecycle='attached')
      EXECUTE FUNCTION task_14e3d_finalize_fault()`);
    try {
      await expect(composition.commit(command)).rejects.toThrow("asset_publication_finalization_recoverable");
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS task_14e3d_finalize_fault_trigger ON durable_filesystem_operations");
      await pool.query("DROP FUNCTION IF EXISTS task_14e3d_finalize_fault()");
      await composition.close();
    }
    composition = await createRealComposition({ archiveRoot, assetRoot, target, leaseOwner: "14e3d-finalize-b" });
    try {
      const replay = await composition.commit(command);
      expect(replay).toMatchObject({ kind: "campaign_zip", result: { stats: { assetCount: 1 } } });
      const lifecycle = await pool.query<{ lifecycle: string; operation_lifecycle: string }>(
        `SELECT request.lifecycle,operation.lifecycle AS operation_lifecycle
           FROM portable_import_normalized_asset_publications mapping
           JOIN asset_publication_requests request
             ON request.id=mapping.request_id AND request.owner_user_id=mapping.owner_user_id
           JOIN durable_filesystem_operations operation
             ON operation.asset_id=request.canonical_asset_id
            AND operation.owner_user_id=request.owner_user_id
          WHERE mapping.import_id=$1 AND mapping.owner_user_id=$2`,
        [replay.importedRecordId, ownerUserId],
      );
      expect(lifecycle.rows).not.toHaveLength(0);
      expect(lifecycle.rows.every((row) => row.lifecycle === "published" && row.operation_lifecycle === "finalized")).toBe(true);
    } finally {
      await composition.close();
    }
  });

  secureFilesystemIt("returns a different-key duplicate without stealing canonical or unrelated recovery claims", async () => {
    const target = await createWorldScope(`14e3d duplicate recovery target ${crypto.randomUUID()}`);
    const archiveRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-duplicate-recovery-archive-`);
    const assetRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-duplicate-recovery-assets-`);
    let composition = await createRealComposition({
      archiveRoot,
      assetRoot,
      target,
      leaseOwner: "14e3d-duplicate-recovery-a"
    });
    const bytes = await campaignArchive(`duplicate-recovery-${crypto.randomUUID()}`);
    const firstStaged = await stagedInput(composition, bytes, "14e3d-duplicate-recovery-first");
    const firstPreview = await composition.previewCampaignZip({
      ownerUserId,
      stagedInput: firstStaged,
      kind: "campaign_zip",
      destination: { kind: "embedded", operation: "create_world" }
    });
    const firstCommand = {
      ownerUserId,
      kind: "campaign_zip" as const,
      destination: firstPreview.destination,
      previewHandle: firstPreview.previewHandle,
      idempotencyKey: `14e3d-duplicate-recovery-first-${crypto.randomUUID()}`
    };
    await pool.query(`CREATE FUNCTION task_14e3d_duplicate_recovery_finalize_fault() RETURNS trigger
      LANGUAGE plpgsql AS $fault$ BEGIN RAISE EXCEPTION 'task_14e3d_duplicate_recovery_finalize_fault'; END; $fault$`);
    await pool.query(`CREATE TRIGGER task_14e3d_duplicate_recovery_finalize_fault_trigger
      BEFORE UPDATE ON durable_filesystem_operations
      FOR EACH ROW WHEN (NEW.lifecycle='finalized' AND OLD.lifecycle='attached')
      EXECUTE FUNCTION task_14e3d_duplicate_recovery_finalize_fault()`);
    try {
      await expect(composition.commit(firstCommand)).rejects.toThrow("asset_publication_finalization_recoverable");
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS task_14e3d_duplicate_recovery_finalize_fault_trigger ON durable_filesystem_operations");
      await pool.query("DROP FUNCTION IF EXISTS task_14e3d_duplicate_recovery_finalize_fault()");
      await composition.close();
    }
    const canonical = await pool.query<{ import_id: string; campaign_id: string }>(
      `SELECT imported.id AS import_id,imported.campaign_id
         FROM portable_import_operations operation
         JOIN imports imported
           ON imported.id=operation.import_id AND imported.owner_user_id=operation.owner_user_id
        WHERE operation.owner_user_id=$1 AND operation.preview_token_hash=$2`,
      [ownerUserId, hash(firstCommand.previewHandle.token)],
    );
    expect(canonical.rows).toHaveLength(1);
    const unrelatedBytes = Buffer.from(`unrelated duplicate recovery asset ${crypto.randomUUID()}`);
    const unrelatedKey = `14e3d-duplicate-recovery-unrelated-${crypto.randomUUID()}`;
    const unrelatedKeyHash = hash(unrelatedKey);
    const unrelatedComposition = await createAssetPublicationComposition(pool, { archiveRoot, assetRoot });
    await pool.query(`CREATE FUNCTION task_14e3d_duplicate_recovery_unrelated_fault() RETURNS trigger
      LANGUAGE plpgsql AS $fault$
      BEGIN
        IF NEW.lifecycle='finalized' AND OLD.lifecycle='attached'
          AND NEW.asset_id=(
            SELECT asset_id FROM asset_publication_identities
             WHERE owner_user_id='${ownerUserId}'::uuid
               AND idempotency_key_hash='${unrelatedKeyHash}'
          )
        THEN
          RAISE EXCEPTION 'task_14e3d_duplicate_recovery_unrelated_fault';
        END IF;
        RETURN NEW;
      END;
      $fault$`);
    await pool.query(`CREATE TRIGGER task_14e3d_duplicate_recovery_unrelated_fault_trigger
      BEFORE UPDATE ON durable_filesystem_operations
      FOR EACH ROW EXECUTE FUNCTION task_14e3d_duplicate_recovery_unrelated_fault()`);
    try {
      await expect(unrelatedComposition.publisher.publishAsset({
        owner: { ownerUserId },
        idempotencyKey: toAssetMutationIdempotencyKey(unrelatedKey),
        leaseOwner: "14e3d-duplicate-recovery-unrelated",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        original: {
          mimeType: "image/png",
          bytes: unrelatedBytes,
          byteLength: unrelatedBytes.byteLength,
          contentHash: createHash("sha256").update(unrelatedBytes).digest("hex")
        },
        derivatives: [],
        provenance: {
          origin: "imported",
          campaignId: canonical.rows[0]!.campaign_id,
          targetType: "other"
        }
      })).rejects.toThrow("task_14e3d_duplicate_recovery_unrelated_fault");
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS task_14e3d_duplicate_recovery_unrelated_fault_trigger ON durable_filesystem_operations");
      await pool.query("DROP FUNCTION IF EXISTS task_14e3d_duplicate_recovery_unrelated_fault()");
      await unrelatedComposition.close();
    }

    composition = await createRealComposition({
      archiveRoot,
      assetRoot,
      target,
      leaseOwner: "14e3d-duplicate-recovery-b"
    });
    try {
      const duplicateStaged = await stagedInput(composition, bytes, "14e3d-duplicate-recovery-second");
      const duplicatePreview = await composition.previewCampaignZip({
        ownerUserId,
        stagedInput: duplicateStaged,
        kind: "campaign_zip",
        destination: { kind: "embedded", operation: "create_world" }
      });
      const duplicate = await composition.commit({
        ownerUserId,
        kind: "campaign_zip",
        destination: duplicatePreview.destination,
        previewHandle: duplicatePreview.previewHandle,
        idempotencyKey: `14e3d-duplicate-recovery-second-${crypto.randomUUID()}`
      });
      expect(duplicate).toMatchObject({ duplicate: true, importedRecordId: canonical.rows[0]!.import_id });
      const canonicalPublication = await pool.query<{ lifecycle: string; operation_lifecycle: string }>(
        `SELECT request.lifecycle,operation.lifecycle AS operation_lifecycle
           FROM portable_import_normalized_asset_publications publication
           JOIN asset_publication_requests request
             ON request.id=publication.request_id AND request.owner_user_id=publication.owner_user_id
           JOIN durable_filesystem_operations operation
             ON operation.asset_id=request.canonical_asset_id AND operation.owner_user_id=request.owner_user_id
          WHERE publication.owner_user_id=$1 AND publication.import_id=$2`,
        [ownerUserId, canonical.rows[0]!.import_id],
      );
      expect(canonicalPublication.rows).not.toHaveLength(0);
      expect(canonicalPublication.rows.every((row) => (
        row.lifecycle === "attached" && row.operation_lifecycle === "attached"
      ))).toBe(true);
      await expect(pool.query(
        `SELECT lifecycle FROM asset_publication_identities
          WHERE owner_user_id=$1 AND idempotency_key_hash=$2`,
        [ownerUserId, unrelatedKeyHash],
      )).resolves.toMatchObject({ rows: [{ lifecycle: "attached" }] });
    } finally {
      await composition.close();
    }
  });

  secureFilesystemIt("does not recover an unrelated attached campaign asset during portable replay", async () => {
    const target = await createWorldScope(`14e3d exact recovery target ${crypto.randomUUID()}`);
    const archiveRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-exact-recovery-archive-`);
    const assetRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-exact-recovery-assets-`);
    const composition = await createRealComposition({
      archiveRoot,
      assetRoot,
      target,
      leaseOwner: "14e3d-exact-recovery"
    });
    const bytes = await campaignArchive(`exact-recovery-${crypto.randomUUID()}`);
    const staged = await stagedInput(composition, bytes, "14e3d-exact-recovery");
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
      idempotencyKey: `14e3d-exact-recovery-${crypto.randomUUID()}`
    };
    const committed = await composition.commit(command);
    const campaignId = (committed.result as { campaignId: string }).campaignId;
    const mapped = await pool.query<{ import_id: string; asset_id: string }>(
      `SELECT publication.import_id,request.canonical_asset_id AS asset_id
         FROM portable_import_normalized_asset_publications publication
         JOIN portable_import_operations operation
           ON operation.id=publication.operation_id
          AND operation.owner_user_id=publication.owner_user_id
         JOIN asset_publication_requests request
           ON request.id=publication.request_id
          AND request.owner_user_id=publication.owner_user_id
        WHERE operation.owner_user_id=$1 AND operation.preview_token_hash=$2`,
      [ownerUserId, hash(command.previewHandle.token)],
    );
    expect(mapped.rows).toHaveLength(1);
    expect(mapped.rows[0]!.import_id).toBe(committed.importedRecordId);
    await expect(pool.query(
      `DELETE FROM portable_import_normalized_asset_publications
        WHERE operation_id=(
          SELECT id FROM portable_import_operations
           WHERE owner_user_id=$1 AND preview_token_hash=$2
        )`,
      [ownerUserId, hash(command.previewHandle.token)],
    )).rejects.toThrow("portable normalized import publication is retained authority");
    const unrelatedBytes = Buffer.from(`unrelated campaign asset ${crypto.randomUUID()}`);
    const unrelatedKey = `14e3d-unrelated-${crypto.randomUUID()}`;
    const unrelatedKeyHash = hash(unrelatedKey);
    const unrelatedComposition = await createAssetPublicationComposition(pool, { archiveRoot, assetRoot });
    await pool.query(`CREATE FUNCTION task_14e3d_unrelated_finalize_fault() RETURNS trigger
      LANGUAGE plpgsql AS $fault$
      BEGIN
        IF NEW.lifecycle='finalized' AND OLD.lifecycle='attached'
          AND NEW.asset_id=(
            SELECT asset_id FROM asset_publication_identities
             WHERE owner_user_id='${ownerUserId}'::uuid
               AND idempotency_key_hash='${unrelatedKeyHash}'
          )
        THEN
          RAISE EXCEPTION 'task_14e3d_unrelated_finalize_fault';
        END IF;
        RETURN NEW;
      END;
      $fault$`);
    await pool.query(`CREATE TRIGGER task_14e3d_unrelated_finalize_fault_trigger
      BEFORE UPDATE ON durable_filesystem_operations
      FOR EACH ROW EXECUTE FUNCTION task_14e3d_unrelated_finalize_fault()`);
    try {
      await expect(unrelatedComposition.publisher.publishAsset({
        owner: { ownerUserId },
        idempotencyKey: toAssetMutationIdempotencyKey(unrelatedKey),
        leaseOwner: "14e3d-unrelated",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        original: {
          mimeType: "image/png",
          bytes: unrelatedBytes,
          byteLength: unrelatedBytes.byteLength,
          contentHash: hash(unrelatedBytes.toString("utf8"))
        },
        derivatives: [],
        provenance: { origin: "imported", campaignId, targetType: "other" }
      })).rejects.toThrow("task_14e3d_unrelated_finalize_fault");
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS task_14e3d_unrelated_finalize_fault_trigger ON durable_filesystem_operations");
      await pool.query("DROP FUNCTION IF EXISTS task_14e3d_unrelated_finalize_fault()");
      await unrelatedComposition.close();
    }
    try {
      await expect(composition.commit(command)).resolves.toEqual(committed);
      await expect(pool.query(
        `SELECT identity.lifecycle,count(publication.operation_id)::int AS mapped_count
           FROM asset_publication_identities identity
           LEFT JOIN asset_publication_requests request
             ON request.canonical_asset_id=identity.asset_id
            AND request.owner_user_id=identity.owner_user_id
           LEFT JOIN portable_import_normalized_asset_publications publication
             ON publication.request_id=request.id
            AND publication.owner_user_id=request.owner_user_id
          WHERE identity.owner_user_id=$1 AND identity.idempotency_key_hash=$2
          GROUP BY identity.lifecycle`,
        [ownerUserId, unrelatedKeyHash],
      )).resolves.toMatchObject({ rows: [{ lifecycle: "attached", mapped_count: 0 }] });
    } finally {
      await composition.close();
    }
  });

  secureFilesystemIt("does not attach assets for a distinct-key duplicate Campaign ZIP authority", async () => {
    const target = await createWorldScope(`14e3d duplicate target ${crypto.randomUUID()}`);
    const archiveRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-duplicate-archive-`);
    const assetRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-duplicate-assets-`);
    const composition = await createRealComposition({ archiveRoot, assetRoot, target, leaseOwner: "14e3d-duplicate" });
    const bytes = await campaignArchive(`duplicate-${crypto.randomUUID()}`);
    try {
      const firstStaged = await stagedInput(composition, bytes, "14e3d-duplicate-first");
      const firstPreview = await composition.previewCampaignZip({
        ownerUserId, stagedInput: firstStaged, kind: "campaign_zip", destination: { kind: "embedded", operation: "create_world" }
      });
      const first = await composition.commit({
        ownerUserId,
        kind: "campaign_zip",
        destination: firstPreview.destination,
        previewHandle: firstPreview.previewHandle,
        idempotencyKey: `14e3d-duplicate-first-${crypto.randomUUID()}`
      });
      const beforeIdentities = await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM asset_publication_identities WHERE owner_user_id=$1",
        [ownerUserId],
      );
      const beforeOperations = await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM durable_filesystem_operations WHERE owner_user_id=$1 AND resource_kind='asset'",
        [ownerUserId],
      );
      const beforeFiles = await readdir(assetRoot, { recursive: true });
      const secondStaged = await stagedInput(composition, bytes, "14e3d-duplicate-second");
      const secondPreview = await composition.previewCampaignZip({
        ownerUserId, stagedInput: secondStaged, kind: "campaign_zip", destination: { kind: "embedded", operation: "create_world" }
      });
      const secondCommand = {
        ownerUserId,
        kind: "campaign_zip" as const,
        destination: secondPreview.destination,
        previewHandle: secondPreview.previewHandle,
        idempotencyKey: `14e3d-duplicate-second-${crypto.randomUUID()}`
      };
      await pool.query(`CREATE FUNCTION task_14e3d_duplicate_reservation_fault() RETURNS trigger
        LANGUAGE plpgsql AS $fault$
        BEGIN
          RAISE EXCEPTION 'task_14e3d_duplicate_reservation_fault';
        END;
        $fault$`);
      await pool.query(`CREATE TRIGGER task_14e3d_duplicate_reservation_fault_trigger
        BEFORE INSERT ON asset_publication_identities
        FOR EACH ROW EXECUTE FUNCTION task_14e3d_duplicate_reservation_fault()`);
      let duplicate;
      try {
        duplicate = await composition.commit(secondCommand);
      } finally {
        await pool.query("DROP TRIGGER IF EXISTS task_14e3d_duplicate_reservation_fault_trigger ON asset_publication_identities");
        await pool.query("DROP FUNCTION IF EXISTS task_14e3d_duplicate_reservation_fault()");
      }
      expect(duplicate).toMatchObject({ duplicate: true, importedRecordId: first.importedRecordId });
      await expect(pool.query(
        "SELECT count(*)::int AS count FROM asset_publication_identities WHERE owner_user_id=$1",
        [ownerUserId],
      )).resolves.toMatchObject({ rows: beforeIdentities.rows });
      await expect(pool.query(
        "SELECT count(*)::int AS count FROM durable_filesystem_operations WHERE owner_user_id=$1 AND resource_kind='asset'",
        [ownerUserId],
      )).resolves.toMatchObject({ rows: beforeOperations.rows });
      expect(await readdir(assetRoot, { recursive: true })).toEqual(beforeFiles);
    } finally {
      await composition.close();
    }
  });

  // Normalized prewrite crash/reap authority is exercised by the e3e4 matrix;
  // the retired 0062 identity-intent path is no longer callable after e3g.
  secureFilesystemIt("imports a Campaign ZIP without exhausting a two-connection pool", async () => {
    const twoConnectionPool = createDatabasePool(databaseUrl!, 2);
    const target = await createWorldScope(`14e3d pool target ${crypto.randomUUID()}`);
    const composition = await createRealComposition({
      archiveRoot: await mkdtemp(`${tmpdir()}/iqn-14e3d-pool-archive-`),
      assetRoot: await mkdtemp(`${tmpdir()}/iqn-14e3d-pool-assets-`),
      target,
      leaseOwner: "14e3d-pool",
      databasePool: twoConnectionPool
    });
    try {
      const bytes = await campaignArchive(`pool-${crypto.randomUUID()}`);
      const staged = await stagedInput(composition, bytes, "14e3d-pool");
      const preview = await composition.previewCampaignZip({
        ownerUserId, stagedInput: staged, kind: "campaign_zip", destination: { kind: "embedded", operation: "create_world" }
      });
      await expect(composition.commit({
        ownerUserId,
        kind: "campaign_zip",
        destination: preview.destination,
        previewHandle: preview.previewHandle,
        idempotencyKey: `14e3d-pool-${crypto.randomUUID()}`
      })).resolves.toMatchObject({ kind: "campaign_zip", duplicate: false });
    } finally {
      await composition.close();
      await twoConnectionPool.end();
    }
  }, 20_000);

  secureFilesystemIt("discards durable asset reservations only after a caller transaction rollback", async () => {
    const target = await createWorldScope(`14e3d reservation rollback target ${crypto.randomUUID()}`);
    const archiveRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-reservation-rollback-archive-`);
    const assetRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-reservation-rollback-assets-`);
    const composition = await createRealComposition({
      archiveRoot,
      assetRoot,
      target,
      leaseOwner: "14e3d-reservation-rollback"
    });
    const bytes = await campaignArchive(`reservation-rollback-${crypto.randomUUID()}`);
    const staged = await stagedInput(composition, bytes, "14e3d-reservation-rollback");
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
      idempotencyKey: `14e3d-reservation-rollback-${crypto.randomUUID()}`
    };
    await pool.query(`CREATE FUNCTION task_14e3d_reservation_rollback_fault() RETURNS trigger
      LANGUAGE plpgsql AS $fault$
      BEGIN
        IF NEW.phase='mutating' AND OLD.phase='publishing_assets' THEN
          RAISE EXCEPTION 'task_14e3d_reservation_rollback_fault';
        END IF;
        RETURN NEW;
      END;
      $fault$`);
    await pool.query(`CREATE TRIGGER task_14e3d_reservation_rollback_fault_trigger
      BEFORE UPDATE ON portable_import_work
      FOR EACH ROW EXECUTE FUNCTION task_14e3d_reservation_rollback_fault()`);
    try {
      await expect(composition.commit(command)).rejects.toThrow("task_14e3d_reservation_rollback_fault");
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS task_14e3d_reservation_rollback_fault_trigger ON portable_import_work");
      await pool.query("DROP FUNCTION IF EXISTS task_14e3d_reservation_rollback_fault()");
    }
    try {
      await expect(pool.query(
        `SELECT operation.status,mapping.publication_state,request.lifecycle
           FROM portable_import_operations operation
           JOIN portable_import_normalized_asset_publications mapping
             ON mapping.operation_id=operation.id AND mapping.owner_user_id=operation.owner_user_id
           JOIN asset_publication_requests request
             ON request.id=mapping.request_id AND request.owner_user_id=mapping.owner_user_id
          WHERE operation.owner_user_id=$1 AND operation.preview_token_hash=$2`,
        [ownerUserId, hash(command.previewHandle.token)],
      )).resolves.toMatchObject({
        rows: [{ status: "previewed", publication_state: "reserved", lifecycle: "prepared" }]
      });
      await expect(composition.commit(command)).resolves.toMatchObject({
        kind: "campaign_zip",
        duplicate: false,
        result: { stats: { assetCount: 1 } }
      });
    } finally {
      await composition.close();
    }
  });

  secureFilesystemIt("compensates earlier durable reservations when a later asset reservation fails", async () => {
    const target = await createWorldScope(`14e3d partial reservation target ${crypto.randomUUID()}`);
    const archiveRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-partial-reservation-archive-`);
    const assetRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-partial-reservation-assets-`);
    const composition = await createRealComposition({
      archiveRoot,
      assetRoot,
      target,
      leaseOwner: "14e3d-partial-reservation"
    });
    const label = `partial-reservation-${crypto.randomUUID()}`;
    const sourceAssetIds = [crypto.randomUUID(), crypto.randomUUID()];
    const bytes = await campaignArchiveWithAssets(label, sourceAssetIds);
    const staged = await stagedInput(composition, bytes, "14e3d-partial-reservation");
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
      idempotencyKey: `14e3d-partial-reservation-${crypto.randomUUID()}`
    };
    await pool.query(`CREATE FUNCTION task_14e3d_second_reservation_fault() RETURNS trigger
      LANGUAGE plpgsql AS $fault$
      BEGIN
        IF NEW.asset_ordinal=1 THEN
          RAISE EXCEPTION 'task_14e3d_second_reservation_fault';
        END IF;
        RETURN NEW;
      END;
      $fault$`);
    await pool.query(`CREATE TRIGGER task_14e3d_second_reservation_fault_trigger
      BEFORE INSERT ON portable_import_normalized_asset_publications
      FOR EACH ROW EXECUTE FUNCTION task_14e3d_second_reservation_fault()`);
    try {
      await expect(composition.commit(command)).rejects.toThrow("task_14e3d_second_reservation_fault");
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS task_14e3d_second_reservation_fault_trigger ON portable_import_normalized_asset_publications");
      await pool.query("DROP FUNCTION IF EXISTS task_14e3d_second_reservation_fault()");
    }
    try {
      await expect(pool.query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM portable_import_normalized_asset_publications mapping
           JOIN portable_import_operations operation ON operation.id=mapping.operation_id
          WHERE operation.owner_user_id=$1 AND operation.preview_token_hash=$2`,
        [ownerUserId, hash(command.previewHandle.token)],
      )).resolves.toMatchObject({ rows: [{ count: 0 }] });
      await expect(composition.commit(command)).resolves.toMatchObject({
        kind: "campaign_zip",
        duplicate: false,
        result: { stats: { assetCount: 2 } }
      });
    } finally {
      await composition.close();
    }
  });

  secureFilesystemIt("returns the committed replay to a concurrent same-command loser without cleaning the winner", async () => {
    const target = await createWorldScope(`14e3d concurrent replay target ${crypto.randomUUID()}`);
    const archiveRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-concurrent-replay-archive-`);
    const assetRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-concurrent-replay-assets-`);
    const firstPool = createDatabasePool(databaseUrl!, 2);
    const secondPool = createDatabasePool(databaseUrl!, 2);
    const composition = await createRealComposition({
      archiveRoot,
      assetRoot,
      target,
      leaseOwner: "14e3d-concurrent-replay-a",
      databasePool: firstPool
    });
    const secondComposition = await createRealComposition({
      archiveRoot,
      assetRoot,
      target,
      leaseOwner: "14e3d-concurrent-replay-b",
      databasePool: secondPool
    });
    const label = `concurrent-replay-${crypto.randomUUID()}`;
    const sourceAssetId = crypto.randomUUID();
    const bytes = await campaignArchiveWithAssets(label, [sourceAssetId]);
    const staged = await stagedInput(composition, bytes, "14e3d-concurrent-replay");
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
      idempotencyKey: `14e3d-concurrent-replay-${crypto.randomUUID()}`
    };
    const gateName = `task-14e3d-concurrent-${crypto.randomUUID()}`;
    const signalName = `task-14e3d-concurrent-signal-${crypto.randomUUID()}`;
    const gate = await pool.connect();
    const observer = await pool.connect();
    let gateHeld = false;
    let winner: ReturnType<typeof composition.commit> | undefined;
    let loser: ReturnType<typeof secondComposition.commit> | undefined;
    let attempts: readonly PromiseSettledResult<Awaited<ReturnType<typeof composition.commit>>>[] = [];
    try {
      await pool.query(`CREATE FUNCTION task_14e3d_concurrent_reservation_gate() RETURNS trigger
        LANGUAGE plpgsql AS $gate$
        BEGIN
          IF NEW.asset_ordinal=0 THEN
            PERFORM pg_advisory_lock(hashtextextended('${signalName}',0));
            PERFORM pg_advisory_xact_lock(hashtextextended('${gateName}',0));
            PERFORM pg_advisory_unlock(hashtextextended('${signalName}',0));
          END IF;
          RETURN NEW;
        END;
        $gate$`);
      await pool.query(`CREATE TRIGGER task_14e3d_concurrent_reservation_gate_trigger
        BEFORE INSERT ON portable_import_normalized_asset_publications
        FOR EACH ROW EXECUTE FUNCTION task_14e3d_concurrent_reservation_gate()`);
      await gate.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [gateName]);
      gateHeld = true;
      winner = composition.commit(command);
      const signalDeadline = Date.now() + 10_000;
      for (;;) {
        const signal = await observer.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
          [signalName],
        );
        if (!signal.rows[0]?.acquired) break;
        await observer.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [signalName]);
        if (Date.now() >= signalDeadline) throw new Error("task_14e3d_concurrent_signal_timeout");
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      let loserSettled = false;
      loser = secondComposition.commit(command).finally(() => { loserSettled = true; });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      expect(loserSettled).toBe(false);
      await gate.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [gateName]);
      gateHeld = false;
      attempts = await Promise.allSettled([winner, loser]);
    } finally {
      if (gateHeld) await gate.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [gateName]);
      await Promise.allSettled([winner, loser].filter((value): value is NonNullable<typeof value> => Boolean(value)));
      await observer.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [signalName]).catch(() => undefined);
      observer.release();
      gate.release();
      await pool.query("DROP TRIGGER IF EXISTS task_14e3d_concurrent_reservation_gate_trigger ON portable_import_normalized_asset_publications");
      await pool.query("DROP FUNCTION IF EXISTS task_14e3d_concurrent_reservation_gate()");
    }
    try {
      if (attempts[0]?.status !== "fulfilled" || attempts[1]?.status !== "fulfilled") {
        throw new AggregateError(
          attempts.flatMap((attempt) => attempt.status === "rejected" ? [attempt.reason] : []),
          "task_14e3d_concurrent_replay_failed",
        );
      }
      expect(attempts[1].value).toEqual(attempts[0].value);
      await expect(pool.query(
        `SELECT mapping.publication_state,request.lifecycle,
                bool_and(operation.lifecycle='finalized') AS all_finalized
           FROM portable_import_operations imported_operation
           JOIN portable_import_normalized_asset_publications mapping
             ON mapping.operation_id=imported_operation.id
            AND mapping.owner_user_id=imported_operation.owner_user_id
           JOIN asset_publication_requests request
             ON request.id=mapping.request_id AND request.owner_user_id=mapping.owner_user_id
           JOIN durable_filesystem_operations operation
             ON operation.asset_id=request.canonical_asset_id
            AND operation.owner_user_id=request.owner_user_id
          WHERE imported_operation.owner_user_id=$1 AND imported_operation.preview_token_hash=$2
          GROUP BY mapping.publication_state,request.lifecycle`,
        [ownerUserId, hash(command.previewHandle.token)],
      )).resolves.toMatchObject({
        rows: [{ publication_state: "published", lifecycle: "published", all_finalized: true }]
      });
    } finally {
      await Promise.all([composition.close(), secondComposition.close()]);
      await Promise.all([firstPool.end(), secondPool.end()]);
    }
  }, 20_000);

  secureFilesystemIt("rejects foreign preview scope and wrong same-owner destination pairs again inside commit", async () => {
    const foreignWorld = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title) VALUES ($1,'Foreign portable world') RETURNING id",
      [foreignOwnerUserId],
    );
    const foreignVersion = await pool.query<{ id: string }>(
      "INSERT INTO world_versions (world_id,owner_user_id,version_number,content) VALUES ($1,$2,1,'{}') RETURNING id",
      [foreignWorld.rows[0]!.id, foreignOwnerUserId],
    );
    const targetA = await createWorldScope(`14e3d destination A ${crypto.randomUUID()}`);
    const targetB = await createWorldScope(`14e3d destination B ${crypto.randomUUID()}`);
    const archiveRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-destination-archive-`);
    const assetRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-destination-assets-`);
    const composition = await createRealComposition({ archiveRoot, assetRoot, target: targetA, leaseOwner: "14e3d-destination" });
    const bytes = new TextEncoder().encode(JSON.stringify({ world: { title: "Scoped legacy" }, turns: [] }));
    try {
      const staged = await stagedInput(composition, bytes, "14e3d-foreign-preview");
      await expect(composition.previewLegacyStory({
        ownerUserId,
        stagedInput: staged,
        kind: "legacy_story",
        destination: {
          kind: "existing_world_version",
          worldId: foreignWorld.rows[0]!.id,
          worldVersionId: foreignVersion.rows[0]!.id
        }
      })).rejects.toThrow();

      const mutations = createPostgresPortableFamilyMutationRepository(worldRepository());
      await expect(withTransaction(pool, (database) => mutations.commitLegacyStory(database, {
        owner: { ownerUserId },
        destination: {
          kind: "existing_world_version",
          worldId: targetA.worldId,
          worldVersionId: targetB.worldVersionId
        },
        authorityFingerprint: hash(`14e3d-wrong-pair-${crypto.randomUUID()}`),
        payload: { sourceName: "wrong-pair.json", story: { world: { title: "Wrong pair" }, turns: [] } }
      }))).rejects.toThrow("portable_import_destination_invalid");
    } finally {
      await composition.close();
    }
  });

  secureFilesystemIt("preserves Legacy Story inline, safe external, and malformed optional image semantics in caller-client mutation", async () => {
    const target = await createWorldScope(`14e3d legacy images ${crypto.randomUUID()}`);
    const archiveRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-legacy-image-archive-`);
    const assetRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-legacy-image-assets-`);
    const publication = await createAssetPublicationComposition(pool, { archiveRoot, assetRoot });
    const image = await uniquePng(`14e3d-legacy-inline-${crypto.randomUUID()}`);
    const contentHash = createHash("sha256").update(image).digest("hex");
    const sourceCampaignId = crypto.randomUUID();
    const sourceTurnId = crypto.randomUUID();
    try {
      const published = await publication.publisher.publishAsset({
        owner: { ownerUserId },
        idempotencyKey: toAssetMutationIdempotencyKey(`14e3d-legacy-inline-${crypto.randomUUID()}`),
        leaseOwner: "14e3d-legacy-inline",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        original: { mimeType: "image/png", bytes: image, byteLength: image.byteLength, contentHash },
        derivatives: [],
        provenance: { origin: "imported" }
      });
      const sourceAssetId = crypto.randomUUID();
      const record = {
        sourceAssetId,
        contentHash,
        mimeType: "image/png" as const,
        byteLength: image.byteLength,
        pixelWidth: 1,
        pixelHeight: 1,
        technicalMetadata: { format: "png" },
        library: {
          title: "", caption: "", notes: "", tags: [], origin: "imported" as const,
          reviewStatus: "unreviewed" as const, reuseScope: "campaign" as const,
          automaticReuseEnabled: false, contentCategories: [], favorite: false, archivedAt: null
        },
        createdAt: "2030-01-01T00:00:00.000Z",
        bindings: [{ role: "turn_illustration" as const, campaignId: sourceCampaignId, turnId: sourceTurnId }]
      };
      const inlineUrl = `data:image/png;base64,${image.toString("base64")}`;
      const mutations = createPostgresPortableFamilyMutationRepository(worldRepository());
      const committed = await withTransaction(pool, (database) => mutations.commitLegacyStory(database, {
        owner: { ownerUserId },
        destination: { kind: "existing_world_version", worldId: target.worldId, worldVersionId: target.worldVersionId },
        authorityFingerprint: hash(`14e3d-legacy-images-${crypto.randomUUID()}`),
        payload: {
          sourceName: "legacy-images.story",
          story: {
            campaign: { title: "Legacy images", sourceCampaignId },
            world: { title: "Legacy images" },
            turns: [
              { id: sourceTurnId, narration: "Inline", imageUrl: inlineUrl },
              { id: crypto.randomUUID(), narration: "External", imageUrl: "https://images.example.test/safe.png" },
              { id: crypto.randomUUID(), narration: "Unsafe", imageUrl: "javascript:alert(1)" },
              { id: crypto.randomUUID(), narration: "Malformed", imageUrl: "data:image/png;base64,not-valid!" },
              { id: crypto.randomUUID(), narration: "Bundle", imageUrl: "images/bundled.png" }
            ]
          }
        },
        publishedAssets: [{ sourceAssetIds: [sourceAssetId], sourceKeys: ["bundled.png"], records: [record], result: published }]
      }));
      const turns = await pool.query<{ turn_number: number; image_url: string }>(
        "SELECT turn_number,image_url FROM turns WHERE campaign_id=$1 ORDER BY turn_number",
        [committed.campaignId]
      );
      expect(turns.rows).toEqual([
        { turn_number: 1, image_url: `/api/v1/assets/${published.assetId}` },
        { turn_number: 2, image_url: "https://images.example.test/safe.png" },
        { turn_number: 3, image_url: "" },
        { turn_number: 4, image_url: "" },
        { turn_number: 5, image_url: `/api/v1/assets/${published.assetId}` }
      ]);
    } finally {
      await publication.close();
    }
  });

  secureFilesystemIt("publishes staged Legacy Story inline and validated companion images through the real composition", async () => {
    const target = await createWorldScope(`14e3d composed legacy assets ${crypto.randomUUID()}`);
    const archiveRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-composed-legacy-archive-`);
    const assetRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-composed-legacy-assets-`);
    let composition = await createRealComposition({
      archiveRoot,
      assetRoot,
      target,
      leaseOwner: "14e3d-composed-legacy-assets"
    });
    const imageHash = (image: Uint8Array) => createHash("sha256").update(image).digest("hex");
    const orderedImages = await Promise.all([
      uniquePng(`14e3d-composed-order-a-${crypto.randomUUID()}`),
      uniquePng(`14e3d-composed-order-b-${crypto.randomUUID()}`)
    ]).then((images) => images.sort((left, right) => imageHash(left).localeCompare(imageHash(right))));
    const companionImage = orderedImages[0]!;
    const inlineImage = orderedImages[1]!;
    expect(imageHash(inlineImage).localeCompare(imageHash(companionImage))).toBeGreaterThan(0);
    const sourceCampaignId = crypto.randomUUID();
    const inlineTurnId = crypto.randomUUID();
    const companionTurnId = crypto.randomUUID();
    const companions = [{
      sourceKey: "bundled.png",
      artifact: {
        mimeType: "image/png" as const,
        bytes: companionImage,
        byteLength: companionImage.byteLength,
        contentHash: imageHash(companionImage)
      }
    }];
    const bytes = new TextEncoder().encode(JSON.stringify({
      campaign: { sourceCampaignId, title: "Composed Legacy assets" },
      world: { title: "Composed Legacy assets" },
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
        }
      ]
    }));
    try {
      const staged = await stagedInput(composition, bytes, "14e3d-composed-legacy-assets");
      const destination = {
        kind: "existing_world_version" as const,
        worldId: target.worldId,
        worldVersionId: target.worldVersionId
      };
      const portableAssets = { legacyStoryCompanions: companions };
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
        idempotencyKey: `14e3d-composed-legacy-assets-${crypto.randomUUID()}`
      };

      const committed = await composition.commit(command, portableAssets);
      await composition.close();
      composition = await createRealComposition({
        archiveRoot,
        assetRoot,
        target,
        leaseOwner: "14e3d-composed-legacy-assets-restart"
      });
      await expect(composition.commit(command)).resolves.toEqual(committed);
      const result = committed.result as Readonly<{ campaignId: string; importId: string }>;

      const turns = await pool.query<{ source_turn_id: string; id: string; image_url: string }>(
        `SELECT source_turn_id,id,image_url
           FROM turns
          WHERE campaign_id=$1
          ORDER BY turn_number`,
        [result.campaignId]
      );
      expect(turns.rows).toHaveLength(2);
      expect(turns.rows.map((turn) => turn.source_turn_id)).toEqual([inlineTurnId, companionTurnId]);
      expect(turns.rows.map((turn) => turn.image_url)).toEqual([
        expect.stringMatching(/^\/api\/v1\/assets\/[0-9a-f-]{36}$/u),
        expect.stringMatching(/^\/api\/v1\/assets\/[0-9a-f-]{36}$/u)
      ]);
      const assetIds = turns.rows.map((turn) => turn.image_url.split("/").at(-1)!);
      expect(new Set(assetIds).size).toBe(2);

      const mappings = await pool.query<{
        asset_id: string;
        identity_lifecycle: string;
        operation_lifecycle: string;
      }>(
        `SELECT DISTINCT request.canonical_asset_id AS asset_id,
                request.lifecycle AS identity_lifecycle,
                operation.lifecycle AS operation_lifecycle
           FROM portable_import_normalized_asset_publications publication
           JOIN asset_publication_requests request
             ON request.id=publication.request_id
            AND request.owner_user_id=publication.owner_user_id
           JOIN durable_filesystem_operations operation
             ON operation.asset_id=request.canonical_asset_id
            AND operation.owner_user_id=request.owner_user_id
          WHERE publication.owner_user_id=$1 AND publication.import_id=$2
          ORDER BY request.canonical_asset_id`,
        [ownerUserId, result.importId]
      );
      expect(mappings.rows.map((row) => row.asset_id).sort()).toEqual([...assetIds].sort());
      expect(mappings.rows.every((row) => (
        row.identity_lifecycle === "published" && row.operation_lifecycle === "finalized"
      ))).toBe(true);

      const references = await pool.query<{ asset_id: string; asset_role: string; turn_id: string | null }>(
        `SELECT asset_id,asset_role,turn_id
           FROM asset_references
          WHERE owner_user_id=$1 AND campaign_id=$2 AND asset_id=ANY($3::uuid[])
          ORDER BY asset_id,asset_role`,
        [ownerUserId, result.campaignId, assetIds]
      );
      expect(references.rows).toHaveLength(2);
      for (const assetId of assetIds) {
        expect(references.rows.filter((reference) => reference.asset_id === assetId)).toEqual([
          {
            asset_id: assetId,
            asset_role: "turn_illustration",
            turn_id: turns.rows.find((turn) => turn.image_url.endsWith(assetId))!.id
          }
        ]);
      }
    } finally {
      await composition.close();
    }
  });

  secureFilesystemIt("resumes a persisted preview after composition restart and preserves replay", async () => {
    const target = await createWorldScope(`14e3d restart target ${crypto.randomUUID()}`);
    const archiveRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-restart-archive-`);
    const assetRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-restart-assets-`);
    let composition = await createRealComposition({ archiveRoot, assetRoot, target, leaseOwner: "14e3d-restart-a" });
    const bytes = new TextEncoder().encode(JSON.stringify({
      format: "infinite-quest-world",
      formatVersion: 1,
      title: `Restart world ${crypto.randomUUID()}`,
      content: canonicalizeWorldContent({ world: { title: "Restart world" } })
    }));
    const staged = await stagedInput(composition, bytes, "14e3d-restart");
    const preview = await composition.previewWorldJson({ ownerUserId, stagedInput: staged, kind: "world_json", destination: { kind: "create_world" } });
    await composition.close();
    composition = await createRealComposition({ archiveRoot, assetRoot, target, leaseOwner: "14e3d-restart-b" });
    try {
      const command = {
        ownerUserId,
        kind: "world_json" as const,
        destination: preview.destination,
        previewHandle: preview.previewHandle,
        idempotencyKey: `14e3d-restart-${crypto.randomUUID()}`
      };
      const committed = await composition.commit(command);
      expect(committed).toMatchObject({ kind: "world_json", duplicate: false });
      expect(await composition.commit(command)).toEqual(committed);
    } finally {
      await composition.close();
    }
  });

  secureFilesystemIt("expires persisted preview/work authority across composition restart", async () => {
    const target = await createWorldScope(`14e3d expiry target ${crypto.randomUUID()}`);
    const archiveRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-expiry-archive-`);
    const assetRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-expiry-assets-`);
    let composition = await createRealComposition({
      archiveRoot,
      assetRoot,
      target,
      leaseOwner: "14e3d-expiry-a",
      previewTtlSeconds: 1
    });
    const bytes = new TextEncoder().encode(JSON.stringify({ world: { title: "Expired story" }, turns: [] }));
    const staged = await stagedInput(
      composition,
      bytes,
      "14e3d-expiry",
      new Date(Date.now() + 1_000).toISOString(),
    );
    const destination = { kind: "existing_world_version" as const, worldId: target.worldId, worldVersionId: target.worldVersionId };
    const preview = await composition.previewLegacyStory({ ownerUserId, stagedInput: staged, kind: "legacy_story", destination });
    await composition.close();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_200));
    composition = await createRealComposition({ archiveRoot, assetRoot, target, leaseOwner: "14e3d-expiry-b" });
    try {
      const reaped = await composition.reap({
        leaseOwner: "14e3d-expiry-reaper",
        leaseSeconds: 60,
        limit: 10
      });
      expect(reaped.claimed).toBeGreaterThanOrEqual(1);
      expect(reaped.cleaned).toBeGreaterThanOrEqual(1);
      expect(reaped.pending).toBe(0);
      await expect(pool.query(
        `SELECT operation.status,work.status AS work_status,work.lease_id
           FROM portable_import_operations operation
           JOIN portable_import_work work ON work.operation_id=operation.id
          WHERE operation.preview_token_hash=$1`,
        [hash(preview.previewHandle.token)],
      )).resolves.toMatchObject({ rows: [{ status: "expired", work_status: "expired", lease_id: null }] });
      await expect(composition.commit({
        ownerUserId,
        kind: "legacy_story",
        destination,
        previewHandle: preview.previewHandle,
        idempotencyKey: `14e3d-expired-${crypto.randomUUID()}`
      })).rejects.toThrow();
      expect(await composition.progress({ ownerUserId }, preview.previewHandle.token)).toMatchObject({ status: "expired" });
    } finally {
      await composition.close();
    }
  });

  secureFilesystemIt("publishes a Campaign ZIP export through a bounded one-shot session", async () => {
    const target = await createWorldScope(`14e3d campaign export ${crypto.randomUUID()}`);
    const campaign = await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id,world_version_id,title) VALUES ($1,$2,'14e3d campaign export') RETURNING id",
      [ownerUserId, target.worldVersionId]
    );
    const campaignId = campaign.rows[0]!.id;
    const expected = new TextEncoder().encode("campaign-zip-stream");
    const composition = await createRealComposition({
      archiveRoot: await mkdtemp(`${tmpdir()}/iqn-14e3d-export-archive-`),
      assetRoot: await mkdtemp(`${tmpdir()}/iqn-14e3d-export-assets-`),
      target,
      leaseOwner: "14e3d-campaign-export",
      exports: {
        async buildCampaignArchive(input) {
          return {
            exportScope: { ownerUserId: input.owner.ownerUserId, exportKind: "campaign_zip", campaignId, ...target },
            contentType: "application/zip",
            byteLength: expected.byteLength,
            source: [expected]
          };
        },
        async buildWorldJson() { throw new Error("world_export_not_expected"); }
      }
    });
    try {
      const view = await composition.createCampaignExport({ owner: { ownerUserId }, campaignId });
      expect(view).not.toHaveProperty("content");
      const command = { owner: { ownerUserId }, exportKind: "campaign_zip" as const, campaignId, ...target, retrieval: view.retrieval };
      const session = await composition.openExportSession(command);
      const chunks: Uint8Array[] = [];
      for await (const chunk of session.chunks) chunks.push(chunk);
      expect(Buffer.concat(chunks)).toEqual(Buffer.from(expected));
      await session.finalize("eof");
      await expect(composition.openExportSession(command)).rejects.toThrow("portable_export_unavailable");
    } finally {
      await composition.close();
    }
  });

  secureFilesystemIt("publishes a world JSON export through a bounded one-shot session", async () => {
    const target = await createWorldScope(`14e3d world export ${crypto.randomUUID()}`);
    const expected = new TextEncoder().encode('{"format":"infinite-quest-world"}');
    const composition = await createRealComposition({
      archiveRoot: await mkdtemp(`${tmpdir()}/iqn-14e3d-export-archive-`),
      assetRoot: await mkdtemp(`${tmpdir()}/iqn-14e3d-export-assets-`),
      target,
      leaseOwner: "14e3d-world-export",
      exports: {
        async buildCampaignArchive() { throw new Error("campaign_export_not_expected"); },
        async buildWorldJson(input) {
          return {
            exportScope: {
              ownerUserId: input.owner.ownerUserId,
              exportKind: "world_json",
              campaignId: null,
              worldId: input.worldId,
              worldVersionId: input.worldVersionId
            },
            contentType: "application/json",
            byteLength: expected.byteLength,
            source: [expected]
          };
        }
      }
    });
    try {
      const view = await composition.createWorldExport({ owner: { ownerUserId }, ...target });
      expect(view).not.toHaveProperty("content");
      const command = {
        owner: { ownerUserId },
        exportKind: "world_json" as const,
        campaignId: null,
        worldId: target.worldId,
        worldVersionId: target.worldVersionId,
        retrieval: view.retrieval
      };
      const session = await composition.openExportSession(command);
      const chunks: Uint8Array[] = [];
      for await (const chunk of session.chunks) chunks.push(chunk);
      expect(Buffer.concat(chunks)).toEqual(Buffer.from(expected));
      await session.finalize("eof");
      await expect(composition.openExportSession(command)).rejects.toThrow("portable_export_unavailable");
    } finally {
      await composition.close();
    }
  });
});
