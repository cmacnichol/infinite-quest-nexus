import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalPortableImportAuthority,
  type PortableCanonicalImportAuthority
} from "../../packages/application/src/imports/private-portable-composition.js";
import {
  toPortableImportedRecordId,
  type PortableStagedInput
} from "../../packages/application/src/imports/types.js";
import { canonicalizeWorldContent } from "../../packages/contracts/src/index.js";
import { createPostgresImportRepository } from "../../packages/database/src/import-repository.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  createPostgresPortableFamilyMutationRepository,
  createPostgresPortableImportAuthorityRepository
} from "../../packages/database/src/portable-import-family-repository.js";
import { createPostgresWorldRepositoryAdapters } from "../../packages/database/src/world-repository.js";
import { createPortableImportExportComposition } from "../../services/runtime/src/portable-import-export-composition.js";
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

  function worldRepository() {
    return createPostgresWorldRepositoryAdapters(pool, {
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
    exports?: Parameters<typeof createPortableImportExportComposition>[0]["exports"];
  }>) {
    return createPortableImportExportComposition({
      pool,
      roots: { archiveRoot: input.archiveRoot, assetRoot: input.assetRoot },
      worlds: worldRepository(),
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
      expect(await composition.progress({ ownerUserId }, preview.previewHandle.token)).toMatchObject({ status: "expired" });
      await expect(composition.commit({
        ownerUserId,
        kind: "legacy_story",
        destination,
        previewHandle: preview.previewHandle,
        idempotencyKey: `14e3d-expired-${crypto.randomUUID()}`
      })).rejects.toThrow("archive_expired");
      const reaped = await composition.reap({
        leaseOwner: "14e3d-expiry-reaper",
        leaseSeconds: 60,
        limit: 10
      });
      expect(reaped.claimed).toBeGreaterThanOrEqual(1);
      expect(reaped.cleaned).toBeGreaterThanOrEqual(1);
      expect(reaped.pending).toBe(0);
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
