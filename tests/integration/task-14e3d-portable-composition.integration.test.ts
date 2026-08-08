import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalPortableAssetReservationCommand,
  canonicalPortableImportAuthority,
  type PortableCanonicalImportAuthority
} from "../../packages/application/src/imports/private-portable-composition.js";
import type { PrivateAssetPublicationCommand } from "../../packages/application/src/assets/private-asset-publication.js";
import {
  toPortableImportedRecordId,
  type PortableStagedInput
} from "../../packages/application/src/imports/types.js";
import { toAssetMutationIdempotencyKey } from "../../packages/application/src/assets/types.js";
import { canonicalizeWorldContent } from "../../packages/contracts/src/index.js";
import { createPostgresImportRepository } from "../../packages/database/src/import-repository.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  createPostgresPortableFamilyMutationRepository,
  createPostgresPortableImportAuthorityRepository
} from "../../packages/database/src/portable-import-family-repository.js";
import { createPostgresWorldRepositoryAdapters } from "../../packages/database/src/world-repository.js";
import { createPortableImportExportComposition } from "../../services/runtime/src/portable-import-export-composition.js";
import { createAssetPublicationComposition } from "../../services/runtime/src/asset-import-composition.js";
import {
  createDatabasePool,
  initialOwnerId,
  type DatabasePool,
  withTransaction
} from "../../packages/database/src/pool.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
        new TextEncoder().encode(`portable-asset-${label}-${index}`),
      );
    }
    return archive.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  }

  async function campaignArchive(label: string): Promise<Uint8Array> {
    return campaignArchiveWithAssets(label, [crypto.randomUUID()]);
  }

  async function waitForAdvisoryWaiters(minimum: number): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const waiting = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'
            AND (query ILIKE '%asset_publication_identities%'
              OR query ILIKE '%portable_import_operations%'
              OR query ILIKE '%portable_import_work%'
              OR query ILIKE '%pg_advisory_xact_lock%')`,
      );
      if ((waiting.rows[0]?.count ?? 0) >= minimum) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    throw new Error("task_14e3d_advisory_wait_timeout");
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

  it("wires every non-ZIP family through real preview, commit, and same-key replay", async () => {
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
          const preview = await composition.previewLegacyStory({ ownerUserId, stagedInput: staged, kind: "legacy_story", destination: existing });
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

  it("commits an embedded Campaign ZIP and its asset through the real composition", async () => {
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

  it("recovers attached imported assets before returning committed replay after restart", async () => {
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
      await expect(composition.commit(command)).rejects.toThrow("task_14e3d_finalize_fault");
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
        `SELECT identity.lifecycle,operation.lifecycle AS operation_lifecycle
           FROM asset_publication_identities identity
           JOIN durable_filesystem_operations operation ON operation.asset_id=identity.asset_id
           JOIN asset_references reference ON reference.asset_id=identity.asset_id
          WHERE reference.campaign_id=$1 AND identity.owner_user_id=$2`,
        [(replay.result as { campaignId: string }).campaignId, ownerUserId],
      );
      expect(lifecycle.rows).not.toHaveLength(0);
      expect(lifecycle.rows.every((row) => row.lifecycle === "published" && row.operation_lifecycle === "finalized")).toBe(true);
    } finally {
      await composition.close();
    }
  });

  it("recovers the canonical import's exact assets for a different-key duplicate without touching unrelated campaign assets", async () => {
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
      await expect(composition.commit(firstCommand)).rejects.toThrow("task_14e3d_duplicate_recovery_finalize_fault");
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
      await expect(pool.query(
        `SELECT identity.lifecycle,operation.lifecycle AS operation_lifecycle
           FROM portable_import_asset_publications publication
           JOIN asset_publication_identities identity
             ON identity.asset_id=publication.asset_id AND identity.owner_user_id=publication.owner_user_id
           JOIN durable_filesystem_operations operation
             ON operation.asset_id=identity.asset_id AND operation.owner_user_id=identity.owner_user_id
          WHERE publication.owner_user_id=$1 AND publication.import_id=$2`,
        [ownerUserId, canonical.rows[0]!.import_id],
      )).resolves.toMatchObject({ rows: [{ lifecycle: "published", operation_lifecycle: "finalized" }] });
      await expect(pool.query(
        `SELECT lifecycle FROM asset_publication_identities
          WHERE owner_user_id=$1 AND idempotency_key_hash=$2`,
        [ownerUserId, unrelatedKeyHash],
      )).resolves.toMatchObject({ rows: [{ lifecycle: "attached" }] });
    } finally {
      await composition.close();
    }
  });

  it("does not recover an unrelated attached campaign asset during portable replay", async () => {
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
      `SELECT publication.import_id,publication.asset_id
         FROM portable_import_asset_publications publication
         JOIN portable_import_operations operation
           ON operation.id=publication.operation_id
          AND operation.owner_user_id=publication.owner_user_id
        WHERE operation.owner_user_id=$1 AND operation.preview_token_hash=$2`,
      [ownerUserId, hash(command.previewHandle.token)],
    );
    expect(mapped.rows).toHaveLength(1);
    expect(mapped.rows[0]!.import_id).toBe(committed.importedRecordId);
    await expect(pool.query(
      `DELETE FROM portable_import_asset_publications
        WHERE operation_id=(
          SELECT id FROM portable_import_operations
           WHERE owner_user_id=$1 AND preview_token_hash=$2
        )`,
      [ownerUserId, hash(command.previewHandle.token)],
    )).rejects.toThrow("portable import asset publication association is immutable");
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
        `SELECT identity.lifecycle,count(publication.asset_id)::int AS mapped_count
           FROM asset_publication_identities identity
           LEFT JOIN portable_import_asset_publications publication
             ON publication.asset_id=identity.asset_id
            AND publication.owner_user_id=identity.owner_user_id
          WHERE identity.owner_user_id=$1 AND identity.idempotency_key_hash=$2
          GROUP BY identity.lifecycle`,
        [ownerUserId, unrelatedKeyHash],
      )).resolves.toMatchObject({ rows: [{ lifecycle: "attached", mapped_count: 0 }] });
    } finally {
      await composition.close();
    }
  });

  it("does not attach assets for a distinct-key duplicate Campaign ZIP authority", async () => {
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

  it("reuses an exact operation-owned reservation after process close before claim", async () => {
    const crashPool = createDatabasePool(databaseUrl!, 2);
    const target = await createWorldScope(`14e3d reservation crash target ${crypto.randomUUID()}`);
    const archiveRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-reservation-crash-archive-`);
    const assetRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-reservation-crash-assets-`);
    let composition = await createRealComposition({
      archiveRoot,
      assetRoot,
      target,
      leaseOwner: "14e3d-reservation-crash-a",
      databasePool: crashPool
    });
    const label = `reservation-crash-${crypto.randomUUID()}`;
    const sourceAssetId = crypto.randomUUID();
    const bytes = await campaignArchiveWithAssets(label, [sourceAssetId]);
    const staged = await stagedInput(composition, bytes, "14e3d-reservation-crash");
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
      idempotencyKey: `14e3d-reservation-crash-${crypto.randomUUID()}`
    };
    const crashAssetBytes = Buffer.from(`portable-asset-${label}-0`);
    const crashPublicationKey = `portable-${hash(
      `${command.idempotencyKey}:0:${sourceAssetId}:${hash(crashAssetBytes.toString())}`,
    )}`;
    const crashPublicationKeyHash = hash(crashPublicationKey);
    const crashAssetCommand: PrivateAssetPublicationCommand = {
      owner: { ownerUserId },
      idempotencyKey: toAssetMutationIdempotencyKey(crashPublicationKey),
      leaseOwner: "14e3d-reservation-crash",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      original: {
        mimeType: "image/png",
        bytes: crashAssetBytes,
        byteLength: crashAssetBytes.byteLength,
        contentHash: createHash("sha256").update(crashAssetBytes).digest("hex")
      },
      derivatives: [],
      provenance: { origin: "imported" }
    };
    const authority = createPostgresPortableImportAuthorityRepository(
      crashPool,
      createPostgresImportRepository(crashPool),
    );
    const publication = await createAssetPublicationComposition(crashPool, { archiveRoot, assetRoot });
    const previewAuthority = await authority.readPreviewAuthority({ command });
    expect(previewAuthority).not.toBeNull();
    const reservedAssetId = await withTransaction(crashPool, async (database) => {
      await authority.lockAssetReservationIntentAuthority(database, {
        operationId: previewAuthority!.operationId,
        owner: { ownerUserId },
        authorityFingerprint: previewAuthority!.authorityFingerprint
      });
      const reservations = await publication.transactionalPublisher.reserveImportedAssetsInTransaction(
        database,
        [crashAssetCommand],
      );
      await authority.recordAssetReservationIntents(database, {
        operationId: previewAuthority!.operationId,
        owner: { ownerUserId },
        authorityFingerprint: previewAuthority!.authorityFingerprint,
        commitIdempotencyKeyHash: hash(command.idempotencyKey),
        commandFingerprint: hash(canonicalPortableAssetReservationCommand({
          operationId: previewAuthority!.operationId,
          ownerUserId,
          kind: "campaign_zip",
          authorityFingerprint: previewAuthority!.authorityFingerprint,
          commitIdempotencyKeyHash: hash(command.idempotencyKey)
        })),
        assetIds: reservations.map(({ identity }) => identity.assetId)
      });
      return reservations[0]!.identity.assetId;
    });
    await expect(crashPool.query(
      `SELECT identity.lifecycle,intent.asset_id
         FROM portable_import_asset_reservation_intents intent
         JOIN asset_publication_identities identity
           ON identity.asset_id=intent.asset_id AND identity.owner_user_id=intent.owner_user_id
        WHERE intent.operation_id=$1 AND intent.owner_user_id=$2`,
      [previewAuthority!.operationId, ownerUserId],
    )).resolves.toMatchObject({ rows: [{ lifecycle: "prepared", asset_id: reservedAssetId }] });

    // No claim or composition catch runs before the process-owned graphs close.
    await publication.close();
    await composition.close();
    await crashPool.end();

    await expect(pool.query(
      `SELECT lifecycle FROM asset_publication_identities
        WHERE owner_user_id=$1 AND idempotency_key_hash=$2`,
      [ownerUserId, crashPublicationKeyHash],
    )).resolves.toMatchObject({ rows: [{ lifecycle: "prepared" }] });
    await expect(pool.query(
      `SELECT status FROM portable_import_operations
        WHERE owner_user_id=$1 AND preview_token_hash=$2`,
      [ownerUserId, hash(command.previewHandle.token)],
    )).resolves.toMatchObject({ rows: [{ status: "previewed" }] });

    const reopenedPool = createDatabasePool(databaseUrl!, 2);
    composition = await createRealComposition({
      archiveRoot,
      assetRoot,
      target,
      leaseOwner: "14e3d-reservation-crash-b",
      databasePool: reopenedPool
    });
    try {
      await expect(composition.commit(command)).resolves.toMatchObject({
        kind: "campaign_zip",
        duplicate: false,
        result: { stats: { assetCount: 1 } }
      });
      await expect(reopenedPool.query(
        `SELECT identity.asset_id,identity.lifecycle,
                count(intent.operation_id)::int AS intent_count
           FROM asset_publication_identities identity
           LEFT JOIN portable_import_asset_reservation_intents intent
             ON intent.asset_id=identity.asset_id AND intent.owner_user_id=identity.owner_user_id
          WHERE identity.owner_user_id=$1 AND identity.idempotency_key_hash=$2
          GROUP BY identity.asset_id,identity.lifecycle`,
        [ownerUserId, crashPublicationKeyHash],
      )).resolves.toMatchObject({
        rows: [{ asset_id: reservedAssetId, lifecycle: "published", intent_count: 0 }]
      });
    } finally {
      await composition.close();
      await reopenedPool.end();
    }
  });

  it("reaps an expired operation-owned reservation after process close without leaving prepared identity residue", async () => {
    const crashPool = createDatabasePool(databaseUrl!, 2);
    const target = await createWorldScope(`14e3d reservation reap target ${crypto.randomUUID()}`);
    const archiveRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-reservation-reap-archive-`);
    const assetRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-reservation-reap-assets-`);
    let composition = await createRealComposition({
      archiveRoot,
      assetRoot,
      target,
      leaseOwner: "14e3d-reservation-reap-a",
      previewTtlSeconds: 1,
      databasePool: crashPool
    });
    const label = `reservation-reap-${crypto.randomUUID()}`;
    const sourceAssetId = crypto.randomUUID();
    const bytes = await campaignArchiveWithAssets(label, [sourceAssetId]);
    const staged = await stagedInput(composition, bytes, "14e3d-reservation-reap");
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
      idempotencyKey: `14e3d-reservation-reap-${crypto.randomUUID()}`
    };
    const assetBytes = Buffer.from(`portable-asset-${label}-0`);
    const publicationKey = `portable-${hash(
      `${command.idempotencyKey}:0:${sourceAssetId}:${hash(assetBytes.toString())}`,
    )}`;
    const publicationKeyHash = hash(publicationKey);
    const assetCommand: PrivateAssetPublicationCommand = {
      owner: { ownerUserId },
      idempotencyKey: toAssetMutationIdempotencyKey(publicationKey),
      leaseOwner: "14e3d-reservation-reap",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      original: {
        mimeType: "image/png",
        bytes: assetBytes,
        byteLength: assetBytes.byteLength,
        contentHash: hash(assetBytes.toString())
      },
      derivatives: [],
      provenance: { origin: "imported" }
    };
    const authority = createPostgresPortableImportAuthorityRepository(
      crashPool,
      createPostgresImportRepository(crashPool),
    );
    const publication = await createAssetPublicationComposition(crashPool, { archiveRoot, assetRoot });
    const previewAuthority = await authority.readPreviewAuthority({ command });
    expect(previewAuthority).not.toBeNull();
    const reservedAssetId = await withTransaction(crashPool, async (database) => {
      await authority.lockAssetReservationIntentAuthority(database, {
        operationId: previewAuthority!.operationId,
        owner: { ownerUserId },
        authorityFingerprint: previewAuthority!.authorityFingerprint
      });
      const reservations = await publication.transactionalPublisher.reserveImportedAssetsInTransaction(
        database,
        [assetCommand],
      );
      const commitIdempotencyKeyHash = hash(command.idempotencyKey);
      await authority.recordAssetReservationIntents(database, {
        operationId: previewAuthority!.operationId,
        owner: { ownerUserId },
        authorityFingerprint: previewAuthority!.authorityFingerprint,
        commitIdempotencyKeyHash,
        commandFingerprint: hash(canonicalPortableAssetReservationCommand({
          operationId: previewAuthority!.operationId,
          ownerUserId,
          kind: "campaign_zip",
          authorityFingerprint: previewAuthority!.authorityFingerprint,
          commitIdempotencyKeyHash
        })),
        assetIds: reservations.map(({ identity }) => identity.assetId)
      });
      return reservations[0]!.identity.assetId;
    });
    await publication.close();
    await composition.close();
    await crashPool.end();

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_200));
    const reopenedPool = createDatabasePool(databaseUrl!, 2);
    composition = await createRealComposition({
      archiveRoot,
      assetRoot,
      target,
      leaseOwner: "14e3d-reservation-reap-b",
      databasePool: reopenedPool
    });
    try {
      await composition.reap({
        leaseOwner: "14e3d-reservation-reaper",
        leaseSeconds: 60,
        limit: 10
      });
      await expect(reopenedPool.query(
        `SELECT count(*)::int AS count FROM portable_import_asset_reservation_intents
          WHERE operation_id=$1 AND owner_user_id=$2`,
        [previewAuthority!.operationId, ownerUserId],
      )).resolves.toMatchObject({ rows: [{ count: 0 }] });
      await expect(reopenedPool.query(
        `SELECT count(*)::int AS count FROM asset_publication_identities
          WHERE asset_id=$1 AND owner_user_id=$2 AND idempotency_key_hash=$3`,
        [reservedAssetId, ownerUserId, publicationKeyHash],
      )).resolves.toMatchObject({ rows: [{ count: 0 }] });
      await expect(reopenedPool.query(
        `SELECT operation.status,work.status AS work_status
           FROM portable_import_operations operation
           JOIN portable_import_work work
             ON work.operation_id=operation.id AND work.owner_user_id=operation.owner_user_id
          WHERE operation.id=$1 AND operation.owner_user_id=$2`,
        [previewAuthority!.operationId, ownerUserId],
      )).resolves.toMatchObject({ rows: [{ status: "expired", work_status: "expired" }] });
    } finally {
      await composition.close();
      await reopenedPool.end();
    }
  });

  it("imports a Campaign ZIP without exhausting a two-connection pool", async () => {
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

  it("discards durable asset reservations only after a caller transaction rollback", async () => {
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
    const before = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM asset_publication_identities
        WHERE owner_user_id=$1 AND lifecycle='prepared'`,
      [ownerUserId],
    );
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
        `SELECT identity.lifecycle,operation.lifecycle AS operation_lifecycle
           FROM asset_publication_identities identity
           JOIN durable_filesystem_operations operation
             ON operation.asset_id=identity.asset_id AND operation.owner_user_id=identity.owner_user_id
          WHERE identity.owner_user_id=$1 AND identity.lifecycle='cleanup_pending'
          ORDER BY identity.created_at DESC,operation.created_at
          LIMIT 1`,
        [ownerUserId],
      )).resolves.toMatchObject({
        rows: [{ lifecycle: "cleanup_pending", operation_lifecycle: "cleaned" }]
      });
      await expect(pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM asset_publication_identities
          WHERE owner_user_id=$1 AND lifecycle='prepared'`,
        [ownerUserId],
      )).resolves.toMatchObject({ rows: before.rows });
      await expect(composition.commit(command)).resolves.toMatchObject({
        kind: "campaign_zip",
        duplicate: false,
        result: { stats: { assetCount: 1 } }
      });
    } finally {
      await composition.close();
    }
  });

  it("compensates earlier durable reservations when a later asset reservation fails", async () => {
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
    const secondContentHash = hash(`portable-asset-${label}-1`);
    const secondPublicationKey = `portable-${hash(
      `${command.idempotencyKey}:1:${sourceAssetIds[1]}:${secondContentHash}`,
    )}`;
    const secondPublicationKeyHash = hash(secondPublicationKey);
    const before = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM asset_publication_identities
        WHERE owner_user_id=$1 AND lifecycle='prepared'`,
      [ownerUserId],
    );
    await pool.query(`CREATE FUNCTION task_14e3d_second_reservation_fault() RETURNS trigger
      LANGUAGE plpgsql AS $fault$
      BEGIN
        IF NEW.idempotency_key_hash='${secondPublicationKeyHash}' THEN
          RAISE EXCEPTION 'task_14e3d_second_reservation_fault';
        END IF;
        RETURN NEW;
      END;
      $fault$`);
    await pool.query(`CREATE TRIGGER task_14e3d_second_reservation_fault_trigger
      BEFORE INSERT ON asset_publication_identities
      FOR EACH ROW EXECUTE FUNCTION task_14e3d_second_reservation_fault()`);
    try {
      await expect(composition.commit(command)).rejects.toThrow("task_14e3d_second_reservation_fault");
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS task_14e3d_second_reservation_fault_trigger ON asset_publication_identities");
      await pool.query("DROP FUNCTION IF EXISTS task_14e3d_second_reservation_fault()");
    }
    try {
      await expect(pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM asset_publication_identities
          WHERE owner_user_id=$1 AND lifecycle='prepared'`,
        [ownerUserId],
      )).resolves.toMatchObject({ rows: before.rows });
      await expect(composition.commit(command)).resolves.toMatchObject({
        kind: "campaign_zip",
        duplicate: false,
        result: { stats: { assetCount: 2 } }
      });
    } finally {
      await composition.close();
    }
  });

  it("returns the committed replay to a concurrent same-command loser without cleaning the winner", async () => {
    const target = await createWorldScope(`14e3d concurrent replay target ${crypto.randomUUID()}`);
    const archiveRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-concurrent-replay-archive-`);
    const assetRoot = await mkdtemp(`${tmpdir()}/iqn-14e3d-concurrent-replay-assets-`);
    const composition = await createRealComposition({
      archiveRoot,
      assetRoot,
      target,
      leaseOwner: "14e3d-concurrent-replay"
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
    const contentHash = hash(`portable-asset-${label}-0`);
    const publicationKey = `portable-${hash(
      `${command.idempotencyKey}:0:${sourceAssetId}:${contentHash}`,
    )}`;
    const publicationKeyHash = hash(publicationKey);
    const gateName = `task-14e3d-concurrent-${crypto.randomUUID()}`;
    const gate = await pool.connect();
    let gateHeld = false;
    let attempts: readonly PromiseSettledResult<Awaited<ReturnType<typeof composition.commit>>>[] = [];
    try {
      await pool.query(`CREATE FUNCTION task_14e3d_concurrent_reservation_gate() RETURNS trigger
        LANGUAGE plpgsql AS $gate$
        BEGIN
          IF NEW.idempotency_key_hash='${publicationKeyHash}' THEN
            PERFORM pg_advisory_xact_lock(hashtextextended('${gateName}',0));
          END IF;
          RETURN NEW;
        END;
        $gate$`);
      await pool.query(`CREATE TRIGGER task_14e3d_concurrent_reservation_gate_trigger
        BEFORE INSERT ON asset_publication_identities
        FOR EACH ROW EXECUTE FUNCTION task_14e3d_concurrent_reservation_gate()`);
      await gate.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [gateName]);
      gateHeld = true;
      const winner = composition.commit(command);
      await waitForAdvisoryWaiters(1);
      const loser = composition.commit(command);
      await waitForAdvisoryWaiters(2);
      await gate.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [gateName]);
      gateHeld = false;
      attempts = await Promise.allSettled([winner, loser]);
    } finally {
      if (gateHeld) await gate.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [gateName]);
      gate.release();
      await pool.query("DROP TRIGGER IF EXISTS task_14e3d_concurrent_reservation_gate_trigger ON asset_publication_identities");
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
        `SELECT identity.lifecycle,operation.lifecycle AS operation_lifecycle
           FROM asset_publication_identities identity
           JOIN durable_filesystem_operations operation
             ON operation.asset_id=identity.asset_id AND operation.owner_user_id=identity.owner_user_id
          WHERE identity.owner_user_id=$1 AND identity.idempotency_key_hash=$2`,
        [ownerUserId, publicationKeyHash],
      )).resolves.toMatchObject({
        rows: [{ lifecycle: "published", operation_lifecycle: "finalized" }]
      });
    } finally {
      await composition.close();
    }
  }, 20_000);

  it("rejects foreign preview scope and wrong same-owner destination pairs again inside commit", async () => {
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

  it("resumes a persisted preview after composition restart and preserves replay", async () => {
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

  it("expires persisted preview/work authority across composition restart", async () => {
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

  it("publishes a Campaign ZIP export through a bounded one-shot session", async () => {
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

  it("publishes a world JSON export through a bounded one-shot session", async () => {
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
