import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  toPortableImportedRecordId,
  toPortableImportResultRetrieval,
  toPortableSourceInstallationId,
  type PortableImportKind,
  type PortableImportPreviewCommand,
  type PortableImportPreviewProjectionFor,
  type PortableImportResultProjectionFor
} from "../../packages/application/src/imports/index.js";
import {
  createPostgresImportRepository,
  PortableImportRepositoryError,
  type PostgresPortableImportRepository
} from "../../packages/database/src/import-repository.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  createDatabasePool,
  initialOwnerId,
  type DatabaseClient,
  type DatabasePool
} from "../../packages/database/src/pool.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type WorldScope = Readonly<{
  worldId: string;
  worldVersionId: string;
  campaignId: string;
}>;

type PortableVariant = Readonly<{
  label: string;
  command: Omit<PortableImportPreviewCommand, "ownerUserId" | "stagedInput">;
  projection: PortableImportPreviewProjectionFor<PortableImportKind>;
  result: PortableImportResultProjectionFor<PortableImportKind>;
}>;

integration("PostgreSQL portable import repository", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  let foreignOwnerUserId = "";
  let scope: WorldScope;
  let foreignScope: WorldScope;
  let repository: PostgresPortableImportRepository;

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 12);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    foreignOwnerUserId = await createOwner("portable-foreign");
    scope = await createWorldScope(ownerUserId, "Portable repository");
    foreignScope = await createWorldScope(foreignOwnerUserId, "Foreign portable repository");
    repository = createPostgresImportRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createOwner(prefix: string): Promise<string> {
    const created = await pool.query<{ id: string }>(
      `INSERT INTO users (system_key, display_name)
       VALUES ($1,$2) RETURNING id`,
      [`${prefix}-${crypto.randomUUID()}`, prefix]
    );
    return created.rows[0]!.id;
  }

  async function createWorldScope(scopedOwner: string, title: string): Promise<WorldScope> {
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title) VALUES ($1,$2) RETURNING id",
      [scopedOwner, `${title} ${crypto.randomUUID()}`]
    );
    const worldId = world.rows[0]!.id;
    const version = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id,owner_user_id,version_number,content)
       VALUES ($1,$2,1,'{}'::jsonb) RETURNING id`,
      [worldId, scopedOwner]
    );
    const worldVersionId = version.rows[0]!.id;
    const campaign = await pool.query<{ id: string }>(
      `INSERT INTO campaigns (owner_user_id,world_version_id,title)
       VALUES ($1,$2,$3) RETURNING id`,
      [scopedOwner, worldVersionId, title]
    );
    return { worldId, worldVersionId, campaignId: campaign.rows[0]!.id };
  }

  async function durableOperation(
    scopedOwner: string,
    purpose: "portable_staging" | "portable_export",
    operationScopeId: string,
    contentHash: string,
    byteLength: number,
  ): Promise<string> {
    const operationToken = `operation-${crypto.randomUUID()}`;
    const candidate = `candidate-${crypto.randomUUID()}`;
    const locator = `locator-${crypto.randomUUID()}`;
    const created = await pool.query<{ id: string }>(
      `INSERT INTO durable_filesystem_operations (
         owner_user_id,operation_token_hash,purpose,resource_kind,operation_scope_hash,
         lease_id,lease_owner,lease_expires_at,expires_at
       ) VALUES ($1,$2,$3,'portable',$4,gen_random_uuid(),'import-repository-test',
                 now()+interval '5 minutes',now()+interval '1 day')
       RETURNING id`,
      [scopedOwner, hash(operationToken), purpose, hash(operationScopeId)]
    );
    const operationId = created.rows[0]!.id;
    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lifecycle='attached',candidate_token_hash=$2,locator_token_hash=$3,attached_at=now()
        WHERE id=$1`,
      [operationId, hash(candidate), hash(locator)]
    );
    await pool.query(
      `INSERT INTO durable_filesystem_descriptors (
         operation_id,owner_user_id,descriptor_role,ordinal,relative_path,
         device_id,file_id,change_token,content_hash,byte_length
       ) VALUES ($1,$2,'delivery',0,$3,'device','file','change',$4,$5)`,
      [operationId, scopedOwner, `${purpose}/${contentHash}.zip`, contentHash, byteLength]
    );
    await pool.query(
      `UPDATE durable_filesystem_operations
          SET lifecycle='finalized',finalized_at=now()
        WHERE id=$1`,
      [operationId]
    );
    return operationId;
  }

  async function stagedInput(scopedOwner = ownerUserId, fingerprint = hash(crypto.randomUUID())) {
    const operationScopeId = `staged-${crypto.randomUUID()}`;
    const operationId = await durableOperation(
      scopedOwner,
      "portable_staging",
      operationScopeId,
      fingerprint,
      512,
    );
    const stagedInput = await repository.registerStagedInput({
      ownerUserId: scopedOwner,
      filesystemOperationId: operationId,
      operationScopeId,
      contentHash: fingerprint,
      byteLength: 512,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    return { stagedInput, fingerprint, operationId };
  }

  async function completedImport(scopedOwner: string, sourceHash: string, target: WorldScope) {
    const created = await pool.query<{ id: string }>(
      `INSERT INTO imports (
         owner_user_id,source_type,source_name,source_hash,status,
         world_id,world_version_id,campaign_id,stats,completed_at
       ) VALUES ($1,'portable_repository_test','portable.test',$2,'completed',$3,$4,$5,'{}'::jsonb,now())
       RETURNING id`,
      [scopedOwner, sourceHash, target.worldId, target.worldVersionId, target.campaignId]
    );
    return created.rows[0]!.id;
  }

  function variants(staged: Awaited<ReturnType<typeof stagedInput>>["stagedInput"]): PortableVariant[] {
    const worldResult = {
      kind: "world" as const,
      importId: crypto.randomUUID(),
      worldId: scope.worldId,
      worldVersionId: scope.worldVersionId,
      duplicate: false
    };
    const storyResult = {
      importId: crypto.randomUUID(),
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
    const campaignProjection = {
      valid: true as const,
      archiveType: "campaign" as const,
      formatVersion: 1 as const,
      contentFingerprint: hash("campaign-projection"),
      campaign: {
        title: "Portable campaign",
        sourceCampaignId: crypto.randomUUID(),
        acceptedTurnCount: 2,
        activeTurnNumber: 2,
        selectedCharacter: null
      },
      world: {
        title: "Portable world",
        sourceWorldId: crypto.randomUUID(),
        sourceWorldVersionId: crypto.randomUUID(),
        versionNumber: 1
      },
      chronicle: { memoryCount: 2, summaryCount: 1 },
      assets: { originalCount: 1, totalBytes: 42 },
      providerDataIncluded: false as const,
      warnings: [] as string[]
    };
    const campaignResult = {
      importId: crypto.randomUUID(),
      worldId: scope.worldId,
      worldVersionId: scope.worldVersionId,
      campaignId: scope.campaignId,
      duplicate: false,
      stats: { turnCount: 2, memoryCount: 2, summaryCount: 1, assetCount: 1, assetBytes: 42 }
    };
    return [
      {
        label: "campaign ZIP embedded create-world",
        command: {
          kind: "campaign_zip",
          destination: { kind: "embedded", operation: "create_world" },
          sourceInstallationId: toPortableSourceInstallationId(foreignOwnerUserId),
          importedRecordId: toPortableImportedRecordId(foreignScope.campaignId)
        },
        projection: {
          ...campaignProjection,
          destination: { kind: "embedded", operation: "create_world", worldId: null, worldVersionId: null }
        },
        result: campaignResult
      },
      {
        label: "campaign ZIP existing version",
        command: {
          kind: "campaign_zip",
          destination: { kind: "existing_world_version", worldId: scope.worldId, worldVersionId: scope.worldVersionId }
        },
        projection: {
          ...campaignProjection,
          destination: {
            kind: "existing_world_version",
            operation: "attach_existing_world_version",
            worldId: scope.worldId,
            worldVersionId: scope.worldVersionId
          }
        },
        result: campaignResult
      },
      {
        label: "legacy Story existing version",
        command: {
          kind: "legacy_story",
          destination: { kind: "existing_world_version", worldId: scope.worldId, worldVersionId: scope.worldVersionId }
        },
        projection: {
          kind: "campaign", valid: true, title: "Legacy story", duplicate: false,
          existingCampaignId: null,
          counts: { turns: 2, completeHistoryCharacters: 20, estimatedHistoryTokens: 5 },
          warnings: []
        },
        result: storyResult
      },
      {
        label: "story text existing version",
        command: {
          kind: "story_text",
          destination: { kind: "existing_world_version", worldId: scope.worldId, worldVersionId: scope.worldVersionId }
        },
        projection: {
          kind: "story_text", valid: true, title: "Story text", duplicate: false,
          existingCampaignId: null, targetWorldId: scope.worldId, diagnostics: [], characters: [],
          selectedCharacterId: null,
          counts: { turns: 2, completeHistoryCharacters: 20, estimatedHistoryTokens: 5 },
          warnings: []
        },
        result: { ...storyResult, kind: "campaign" as const }
      },
      ...(["infinite_worlds", "world_json"] as const).map((kind) => ({
        label: `${kind} create-world`,
        command: { kind, destination: { kind: "create_world" as const } },
        projection: {
          kind: "world_json" as const, valid: true as const, title: `${kind} world`, duplicate: false,
          existingWorldId: null, characters: [],
          counts: { entities: 1, relationships: 0, triggers: 0 }, warnings: []
        },
        result: worldResult
      })),
      {
        label: "CYOA create-world",
        command: { kind: "cyoa", destination: { kind: "create_world" } },
        projection: {
          kind: "cyoa_json", valid: true, requiresProvider: false, warnings: [],
          counts: { topLevelTitle: "CYOA", layer1ChaptersCount: 2, characterTarget: "Hero" }
        },
        result: worldResult
      },
      {
        label: "world text create-world",
        command: { kind: "world_text", destination: { kind: "create_world" } },
        projection: {
          kind: "world_text", valid: true, requiresProvider: true, warnings: [],
          counts: { sourceCharacters: 100, sourceWords: 20 }
        },
        result: worldResult
      }
    ];
  }

  it("persists staged capabilities as hashes and denies foreign or expired redemption", async () => {
    const staged = await stagedInput();
    const payload = await repository.retrieveStagedPayload({ ownerUserId }, staged.stagedInput);

    expect(payload).toMatchObject({
      contentHash: staged.fingerprint,
      byteLength: 512,
      descriptor: { relativePath: `portable_staging/${staged.fingerprint}.zip` }
    });
    expect(await repository.retrieveStagedPayload(
      { ownerUserId: foreignOwnerUserId },
      staged.stagedInput,
    )).toBeNull();
    const persisted = await pool.query<{ handle_token_hash: string }>(
      "SELECT handle_token_hash FROM portable_staged_inputs WHERE filesystem_operation_id=$1",
      [staged.operationId]
    );
    expect(persisted.rows[0]!.handle_token_hash).toBe(hash(staged.stagedInput));
    expect(persisted.rows[0]!.handle_token_hash).not.toBe(staged.stagedInput);

    await pool.query(
      "UPDATE portable_staged_inputs SET expires_at=now()-interval '1 second' WHERE filesystem_operation_id=$1",
      [staged.operationId]
    );
    expect(await repository.retrieveStagedPayload({ ownerUserId }, staged.stagedInput)).toBeNull();
  });

  it("previews and commits all seven kinds and eight destination variants without trusting source provenance", async () => {
    const observedLabels: string[] = [];
    for (const seed of variants((await stagedInput()).stagedInput)) {
      const staged = await stagedInput();
      const command = { ...seed.command, ownerUserId, stagedInput: staged.stagedInput } as PortableImportPreviewCommand;
      const preview = await repository.createPreview({
        command,
        contentFingerprint: staged.fingerprint,
        projection: seed.projection,
        diagnostics: [],
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      });
      const payload = await repository.retrievePreviewPayload(
        { ownerUserId },
        command.kind,
        preview.previewHandle,
      );
      expect(payload?.projection).toEqual(seed.projection);
      expect(payload?.destination).toEqual(command.destination);
      if (command.sourceInstallationId) {
        expect(payload?.sourceInstallationId).toBe(foreignOwnerUserId);
        expect(await repository.retrievePreviewPayload(
          { ownerUserId: foreignOwnerUserId },
          command.kind,
          preview.previewHandle,
        )).toBeNull();
      }

      const importId = await completedImport(ownerUserId, hash(`legacy:${seed.label}:${crypto.randomUUID()}`), scope);
      const result = {
        ...seed.result,
        importId,
        worldId: scope.worldId,
        worldVersionId: scope.worldVersionId,
        ...("campaignId" in seed.result ? { campaignId: scope.campaignId } : {})
      } as unknown as PortableImportResultProjectionFor<PortableImportKind>;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const begun = await repository.beginImport(client, {
          ownerUserId,
          kind: command.kind,
          destination: command.destination,
          previewHandle: preview.previewHandle,
          idempotencyKey: `idempotency-${crypto.randomUUID()}`
        });
        expect(begun.outcome).toBe("ready");
        if (begun.outcome !== "ready") throw new Error("expected ready import");
        const completed = await repository.completeImport(client, begun.claim, {
          importId,
          importedRecordId: toPortableImportedRecordId(importId),
          duplicate: false,
          diagnostics: [],
          result,
          resultExpiresAt: new Date(Date.now() + 60_000).toISOString()
        });
        await client.query("COMMIT");
        expect(completed.kind).toBe(command.kind);
        expect(completed.result).toEqual(result);
        observedLabels.push(seed.label);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    expect(observedLabels).toEqual([
      "campaign ZIP embedded create-world",
      "campaign ZIP existing version",
      "legacy Story existing version",
      "story text existing version",
      "infinite_worlds create-world",
      "world_json create-world",
      "CYOA create-world",
      "world text create-world"
    ]);
    const tokenRows = await pool.query<{
      preview_token_hash: string;
      result_retrieval_token_hash: string;
    }>(
      `SELECT preview_token_hash,result_retrieval_token_hash
         FROM portable_import_operations
        WHERE owner_user_id=$1 AND status='committed'
        ORDER BY completed_at DESC LIMIT 8`,
      [ownerUserId]
    );
    expect(tokenRows.rows).toHaveLength(8);
    for (const row of tokenRows.rows) {
      expect(row.preview_token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.result_retrieval_token_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("binds preview handles to owner, kind, and exact destination", async () => {
    const staged = await stagedInput();
    const destination = {
      kind: "existing_world_version" as const,
      worldId: scope.worldId,
      worldVersionId: scope.worldVersionId
    };
    const preview = await repository.createPreview({
      command: { ownerUserId, stagedInput: staged.stagedInput, kind: "legacy_story", destination },
      contentFingerprint: staged.fingerprint,
      projection: {
        kind: "campaign", valid: true, title: "Bound", duplicate: false, existingCampaignId: null,
        counts: { turns: 1, completeHistoryCharacters: 1, estimatedHistoryTokens: 1 }, warnings: []
      },
      diagnostics: [],
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const wrongDestination = {
      kind: "existing_world_version" as const,
      worldId: foreignScope.worldId,
      worldVersionId: foreignScope.worldVersionId
    };

    expect(await repository.retrievePreviewPayload(
      { ownerUserId: foreignOwnerUserId },
      "legacy_story",
      preview.previewHandle,
    )).toBeNull();
    expect(await repository.retrievePreviewPayload(
      { ownerUserId },
      "story_text",
      preview.previewHandle,
    )).toBeNull();
    expect(await repository.retrievePreviewPayload(
      { ownerUserId },
      "legacy_story",
      { ...preview.previewHandle, destination: wrongDestination },
    )).toBeNull();
  });

  it("supersedes only the same owner, kind, content fingerprint, and destination", async () => {
    const fingerprint = hash(`supersede-${crypto.randomUUID()}`);
    const firstStaged = await stagedInput(ownerUserId, fingerprint);
    const secondStaged = await stagedInput(ownerUserId, fingerprint);
    const destination = { kind: "create_world" as const };
    const projection = {
      kind: "world_text" as const, valid: true as const, requiresProvider: true as const,
      warnings: [] as string[], counts: { sourceCharacters: 20, sourceWords: 4 }
    };
    const first = await repository.createPreview({
      command: { ownerUserId, stagedInput: firstStaged.stagedInput, kind: "world_text", destination },
      contentFingerprint: fingerprint,
      projection,
      diagnostics: [],
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const second = await repository.createPreview({
      command: { ownerUserId, stagedInput: secondStaged.stagedInput, kind: "world_text", destination },
      contentFingerprint: fingerprint,
      projection,
      diagnostics: [],
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });

    expect(await repository.retrievePreviewPayload({ ownerUserId }, "world_text", first.previewHandle)).toBeNull();
    expect(await repository.retrievePreviewPayload({ ownerUserId }, "world_text", second.previewHandle)).not.toBeNull();
    const statuses = await pool.query<{ status: string }>(
      `SELECT status FROM portable_import_operations
        WHERE owner_user_id=$1 AND import_kind='world_text' AND content_fingerprint=$2
        ORDER BY created_at,id`,
      [ownerUserId, fingerprint]
    );
    expect(statuses.rows.map(({ status }) => status)).toEqual(["superseded", "previewed"]);
  });

  it("serializes preview replacement on the deterministic owner, kind, content, and destination advisory key", async () => {
    const fingerprint = hash(`advisory-preview-${crypto.randomUUID()}`);
    const staged = await stagedInput(ownerUserId, fingerprint);
    const destination = { kind: "create_world" as const };
    const destinationFingerprint = hash(JSON.stringify(destination));
    const advisoryKey = `infinite-quest-nexus:portable-import:${ownerUserId}:world_text:${fingerprint}:${destinationFingerprint}`;
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [advisoryKey]);
      let settled = false;
      const preview = repository.createPreview({
        command: { ownerUserId, stagedInput: staged.stagedInput, kind: "world_text", destination },
        contentFingerprint: fingerprint,
        projection: {
          kind: "world_text", valid: true, requiresProvider: true, warnings: [],
          counts: { sourceCharacters: 24, sourceWords: 4 }
        },
        diagnostics: [],
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      }).finally(() => { settled = true; });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      expect(settled).toBe(false);
      await blocker.query("COMMIT");
      await expect(preview).resolves.toMatchObject({ kind: "world_text", destination });
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  });

  it("expires elapsed matching previews before inserting their replacement", async () => {
    const fingerprint = hash(`expired-replacement-${crypto.randomUUID()}`);
    const firstStaged = await stagedInput(ownerUserId, fingerprint);
    const secondStaged = await stagedInput(ownerUserId, fingerprint);
    const destination = { kind: "create_world" as const };
    const projection = {
      kind: "world_text" as const,
      valid: true as const,
      requiresProvider: true as const,
      warnings: [] as string[],
      counts: { sourceCharacters: 20, sourceWords: 4 }
    };
    const first = await repository.createPreview({
      command: { ownerUserId, stagedInput: firstStaged.stagedInput, kind: "world_text", destination },
      contentFingerprint: fingerprint,
      projection,
      diagnostics: [],
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    await pool.query(
      "UPDATE portable_import_operations SET expires_at=now()-interval '1 second' WHERE preview_token_hash=$1",
      [hash(first.previewHandle.token)]
    );
    const second = await repository.createPreview({
      command: { ownerUserId, stagedInput: secondStaged.stagedInput, kind: "world_text", destination },
      contentFingerprint: fingerprint,
      projection,
      diagnostics: [],
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });

    const statuses = await pool.query<{ preview_token_hash: string; status: string }>(
      `SELECT preview_token_hash,status
         FROM portable_import_operations
        WHERE preview_token_hash IN ($1,$2)
        ORDER BY created_at,id`,
      [hash(first.previewHandle.token), hash(second.previewHandle.token)]
    );
    expect(statuses.rows.map(({ status }) => status)).toEqual(["expired", "previewed"]);
  });

  it("serializes concurrent consumption so one transaction executes and the other replays", async () => {
    const staged = await stagedInput();
    const destination = { kind: "create_world" as const };
    const preview = await repository.createPreview({
      command: { ownerUserId, stagedInput: staged.stagedInput, kind: "world_json", destination },
      contentFingerprint: staged.fingerprint,
      projection: {
        kind: "world_json", valid: true, title: "Concurrent", duplicate: false,
        existingWorldId: null, characters: [],
        counts: { entities: 1, relationships: 0, triggers: 0 }, warnings: []
      },
      diagnostics: [],
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const command = {
      ownerUserId,
      kind: "world_json" as const,
      destination,
      previewHandle: preview.previewHandle,
      idempotencyKey: `concurrent-${crypto.randomUUID()}`
    };
    const importId = await completedImport(ownerUserId, staged.fingerprint, scope);
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query("BEGIN");
      await second.query("BEGIN");
      const begun = await repository.beginImport(first, command);
      expect(begun.outcome).toBe("ready");
      if (begun.outcome !== "ready") throw new Error("expected first consumer");

      let secondSettled = false;
      const waiting = repository.beginImport(second, command).then((result) => {
        secondSettled = true;
        return result;
      });
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      expect(secondSettled).toBe(false);

      const result = {
        kind: "world" as const,
        importId,
        worldId: scope.worldId,
        worldVersionId: scope.worldVersionId,
        duplicate: false
      };
      const completed = await repository.completeImport(first, begun.claim, {
        importId,
        importedRecordId: toPortableImportedRecordId(importId),
        duplicate: false,
        diagnostics: [],
        result,
        resultExpiresAt: new Date(Date.now() + 60_000).toISOString()
      });
      await first.query("COMMIT");
      const replay = await waiting;
      expect(replay).toEqual({ outcome: "replay", view: completed });
      await second.query("COMMIT");

      const consumed = await pool.query<{ staged: string; operation: string }>(
        `SELECT staged.status AS staged, operation.status AS operation
           FROM portable_staged_inputs staged
           JOIN portable_import_operations operation ON operation.staged_input_id=staged.id
          WHERE operation.preview_token_hash=$1`,
        [hash(preview.previewHandle.token)]
      );
      expect(consumed.rows).toEqual([{ staged: "consumed", operation: "committed" }]);
    } finally {
      await first.query("ROLLBACK").catch(() => undefined);
      await second.query("ROLLBACK").catch(() => undefined);
      first.release();
      second.release();
    }
  });

  it("requires a caller-owned transaction and restores staged authority on rollback", async () => {
    const staged = await stagedInput();
    const destination = { kind: "create_world" as const };
    const preview = await repository.createPreview({
      command: { ownerUserId, stagedInput: staged.stagedInput, kind: "world_text", destination },
      contentFingerprint: staged.fingerprint,
      projection: {
        kind: "world_text", valid: true, requiresProvider: true, warnings: [],
        counts: { sourceCharacters: 8, sourceWords: 2 }
      },
      diagnostics: [],
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const command = {
      ownerUserId,
      kind: "world_text" as const,
      destination,
      previewHandle: preview.previewHandle,
      idempotencyKey: `transaction-${crypto.randomUUID()}`
    };
    const client = await pool.connect();
    try {
      await expect(repository.beginImport(client, command)).rejects.toMatchObject({
        code: "transaction_unavailable"
      });
      await client.query("BEGIN");
      const first = await repository.beginImport(client, command);
      expect(first.outcome).toBe("ready");
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      const retry = await repository.beginImport(client, command);
      expect(retry.outcome).toBe("ready");
      await client.query("ROLLBACK");

      await pool.query(
        "UPDATE portable_staged_inputs SET expires_at=now()-interval '1 second' WHERE handle_token_hash=$1",
        [hash(staged.stagedInput)]
      );
      await client.query("BEGIN");
      await expect(repository.beginImport(client, command)).rejects.toMatchObject({ code: "archive_expired" });
      await client.query("COMMIT");
      const expired = await pool.query<{ preview_status: string; staged_status: string }>(
        `SELECT operation.status AS preview_status,staged.status AS staged_status
           FROM portable_import_operations operation
           JOIN portable_staged_inputs staged ON staged.id=operation.staged_input_id
          WHERE operation.preview_token_hash=$1`,
        [hash(preview.previewHandle.token)]
      );
      expect(expired.rows[0]).toEqual({ preview_status: "previewed", staged_status: "expired" });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("binds a ready import claim to the exact PostgreSQL transaction that began it", async () => {
    const staged = await stagedInput();
    const destination = { kind: "create_world" as const };
    const preview = await repository.createPreview({
      command: { ownerUserId, stagedInput: staged.stagedInput, kind: "world_text", destination },
      contentFingerprint: staged.fingerprint,
      projection: {
        kind: "world_text", valid: true, requiresProvider: true, warnings: [],
        counts: { sourceCharacters: 18, sourceWords: 3 }
      },
      diagnostics: [],
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const command = {
      ownerUserId,
      kind: "world_text" as const,
      destination,
      previewHandle: preview.previewHandle,
      idempotencyKey: `transaction-claim-${crypto.randomUUID()}`
    };
    const importId = await completedImport(ownerUserId, staged.fingerprint, scope);
    const completion = {
      importId,
      importedRecordId: toPortableImportedRecordId(importId),
      duplicate: false,
      diagnostics: [] as const,
      result: {
        kind: "world" as const,
        importId,
        worldId: scope.worldId,
        worldVersionId: scope.worldVersionId,
        duplicate: false
      },
      resultExpiresAt: new Date(Date.now() + 60_000).toISOString()
    };
    const origin = await pool.connect();
    const other = await pool.connect();
    try {
      await origin.query("BEGIN");
      const begun = await repository.beginImport(origin, command);
      if (begun.outcome !== "ready") throw new Error("expected ready import");

      await other.query("BEGIN");
      await other.query("SET LOCAL statement_timeout='250ms'");
      await expect(repository.completeImport(other, begun.claim, completion)).rejects.toMatchObject({
        code: "transaction_unavailable"
      });
      await other.query("ROLLBACK");

      await expect(repository.completeImport(origin, begun.claim, completion)).resolves.toMatchObject({
        kind: "world_text",
        result: completion.result
      });
      await origin.query("ROLLBACK");

      await origin.query("BEGIN");
      await expect(repository.completeImport(origin, begun.claim, completion)).rejects.toMatchObject({
        code: "transaction_unavailable"
      });
      await origin.query("ROLLBACK");
    } finally {
      await origin.query("ROLLBACK").catch(() => undefined);
      await other.query("ROLLBACK").catch(() => undefined);
      origin.release();
      other.release();
    }
  });

  it("classifies concurrent same-key commits for different previews as idempotency mismatch", async () => {
    const destination = { kind: "create_world" as const };
    const projection = {
      kind: "world_text" as const, valid: true as const, requiresProvider: true as const,
      warnings: [] as string[], counts: { sourceCharacters: 10, sourceWords: 2 }
    };
    const firstStaged = await stagedInput();
    const secondStaged = await stagedInput();
    const firstPreview = await repository.createPreview({
      command: { ownerUserId, stagedInput: firstStaged.stagedInput, kind: "world_text", destination },
      contentFingerprint: firstStaged.fingerprint, projection, diagnostics: [],
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const secondPreview = await repository.createPreview({
      command: { ownerUserId, stagedInput: secondStaged.stagedInput, kind: "world_text", destination },
      contentFingerprint: secondStaged.fingerprint, projection, diagnostics: [],
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const idempotencyKey = `concurrent-mismatch-${crypto.randomUUID()}`;
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query("BEGIN");
      await second.query("BEGIN");
      const firstBegin = repository.beginImport(first, {
        ownerUserId, kind: "world_text", destination,
        previewHandle: firstPreview.previewHandle, idempotencyKey
      });
      const secondBegin = repository.beginImport(second, {
        ownerUserId, kind: "world_text", destination,
        previewHandle: secondPreview.previewHandle, idempotencyKey
      });
      const winner = await Promise.race([
        firstBegin.then((value) => ({ client: first, value, loser: secondBegin, loserClient: second })),
        secondBegin.then((value) => ({ client: second, value, loser: firstBegin, loserClient: first }))
      ]);
      expect(winner.value.outcome).toBe("ready");
      if (winner.value.outcome !== "ready") throw new Error("expected ready winner");
      const importId = await completedImport(ownerUserId, hash(crypto.randomUUID()), scope);
      await repository.completeImport(winner.client, winner.value.claim, {
        importId,
        importedRecordId: toPortableImportedRecordId(importId),
        duplicate: false,
        diagnostics: [],
        result: {
          kind: "world", importId, worldId: scope.worldId,
          worldVersionId: scope.worldVersionId, duplicate: false
        },
        resultExpiresAt: new Date(Date.now() + 60_000).toISOString()
      });
      await winner.client.query("COMMIT");
      await expect(winner.loser).rejects.toMatchObject({ code: "import_idempotency_mismatch" });
      await winner.loserClient.query("ROLLBACK");
    } finally {
      await first.query("ROLLBACK").catch(() => undefined);
      await second.query("ROLLBACK").catch(() => undefined);
      first.release();
      second.release();
    }
  });

  it("replays an exact idempotency key and rejects a mismatched preview", async () => {
    const firstStaged = await stagedInput();
    const secondStaged = await stagedInput();
    const destination = { kind: "create_world" as const };
    const projection = {
      kind: "world_text" as const, valid: true as const, requiresProvider: true as const,
      warnings: [] as string[], counts: { sourceCharacters: 10, sourceWords: 2 }
    };
    const firstPreview = await repository.createPreview({
      command: { ownerUserId, stagedInput: firstStaged.stagedInput, kind: "world_text", destination },
      contentFingerprint: firstStaged.fingerprint, projection, diagnostics: [],
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const secondPreview = await repository.createPreview({
      command: { ownerUserId, stagedInput: secondStaged.stagedInput, kind: "world_text", destination },
      contentFingerprint: secondStaged.fingerprint, projection, diagnostics: [],
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const idempotencyKey = `replay-${crypto.randomUUID()}`;
    const importId = await completedImport(ownerUserId, firstStaged.fingerprint, scope);
    const firstClient = await pool.connect();
    let committed;
    try {
      await firstClient.query("BEGIN");
      const begun = await repository.beginImport(firstClient, {
        ownerUserId, kind: "world_text", destination,
        previewHandle: firstPreview.previewHandle, idempotencyKey
      });
      if (begun.outcome !== "ready") throw new Error("expected ready import");
      committed = await repository.completeImport(firstClient, begun.claim, {
        importId,
        importedRecordId: toPortableImportedRecordId(importId),
        duplicate: false,
        diagnostics: [],
        result: {
          kind: "world", importId, worldId: scope.worldId,
          worldVersionId: scope.worldVersionId, duplicate: false
        },
        resultExpiresAt: new Date(Date.now() + 60_000).toISOString()
      });
      await firstClient.query("COMMIT");
    } finally {
      await firstClient.query("ROLLBACK").catch(() => undefined);
      firstClient.release();
    }

    const replayClient = await pool.connect();
    try {
      await replayClient.query("BEGIN");
      await expect(repository.beginImport(replayClient, {
        ownerUserId, kind: "world_text", destination,
        previewHandle: firstPreview.previewHandle, idempotencyKey
      })).resolves.toEqual({ outcome: "replay", view: committed });
      await expect(repository.beginImport(replayClient, {
        ownerUserId, kind: "world_text", destination,
        previewHandle: secondPreview.previewHandle, idempotencyKey
      })).rejects.toMatchObject({ code: "import_idempotency_mismatch" });
      await replayClient.query("ROLLBACK");
    } finally {
      await replayClient.query("ROLLBACK").catch(() => undefined);
      replayClient.release();
    }
  });

  it("retrieves committed results only for the owning kind before expiry", async () => {
    const staged = await stagedInput();
    const destination = { kind: "create_world" as const };
    const preview = await repository.createPreview({
      command: { ownerUserId, stagedInput: staged.stagedInput, kind: "cyoa", destination },
      contentFingerprint: staged.fingerprint,
      projection: {
        kind: "cyoa_json", valid: true, requiresProvider: false, warnings: [],
        counts: { topLevelTitle: "Result", layer1ChaptersCount: 1, characterTarget: "Hero" }
      },
      diagnostics: [],
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const importId = await completedImport(ownerUserId, staged.fingerprint, scope);
    const client = await pool.connect();
    let committed;
    try {
      await client.query("BEGIN");
      const begun = await repository.beginImport(client, {
        ownerUserId, kind: "cyoa", destination, previewHandle: preview.previewHandle,
        idempotencyKey: `result-${crypto.randomUUID()}`
      });
      if (begun.outcome !== "ready") throw new Error("expected ready import");
      committed = await repository.completeImport(client, begun.claim, {
        importId,
        importedRecordId: toPortableImportedRecordId(importId),
        duplicate: false,
        diagnostics: [],
        result: {
          kind: "world", importId, worldId: scope.worldId,
          worldVersionId: scope.worldVersionId, duplicate: false
        },
        resultExpiresAt: new Date(Date.now() + 60_000).toISOString()
      });
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }

    await expect(repository.retrieveImportResult(
      { ownerUserId },
      "cyoa",
      committed!.retrieval,
    )).resolves.toEqual({ kind: "cyoa", result: committed!.result, diagnostics: [] });
    await expect(repository.retrieveImportResult(
      { ownerUserId: foreignOwnerUserId },
      "cyoa",
      committed!.retrieval,
    )).resolves.toBeNull();
    await expect(repository.retrieveImportResult(
      { ownerUserId },
      "world_json",
      toPortableImportResultRetrieval<"world_json">(committed!.retrieval),
    )).resolves.toBeNull();

    await pool.query(
      "UPDATE portable_import_operations SET expires_at=now()-interval '1 second' WHERE result_retrieval_token_hash=$1",
      [hash(committed!.retrieval)]
    );
    await expect(repository.retrieveImportResult(
      { ownerUserId },
      "cyoa",
      committed!.retrieval,
    )).resolves.toBeNull();
  });

  it("rejects malformed database preview and result payloads with only a safe code", async () => {
    const staged = await stagedInput();
    const destination = { kind: "embedded" as const, operation: "create_world" as const };
    const campaignProjection = {
      valid: true as const,
      archiveType: "campaign" as const,
      formatVersion: 1 as const,
      contentFingerprint: staged.fingerprint,
      campaign: {
        title: "Validated campaign", sourceCampaignId: crypto.randomUUID(),
        acceptedTurnCount: 0, activeTurnNumber: 0, selectedCharacter: null
      },
      world: {
        title: "Validated world", sourceWorldId: crypto.randomUUID(),
        sourceWorldVersionId: crypto.randomUUID(), versionNumber: 1
      },
      chronicle: { memoryCount: 0, summaryCount: 0 },
      assets: { originalCount: 0, totalBytes: 0 },
      destination: { kind: "embedded" as const, operation: "create_world" as const, worldId: null, worldVersionId: null },
      providerDataIncluded: false as const,
      warnings: [] as string[]
    };
    await expect(repository.createPreview({
      command: { ownerUserId, stagedInput: staged.stagedInput, kind: "campaign_zip", destination },
      contentFingerprint: staged.fingerprint,
      projection: {
        ...campaignProjection,
        destination: {
          kind: "existing_world_version", operation: "attach_existing_world_version",
          worldId: scope.worldId, worldVersionId: scope.worldVersionId
        }
      },
      diagnostics: [],
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    })).rejects.toMatchObject({ code: "import_invalid" });
    const preview = await repository.createPreview({
      command: { ownerUserId, stagedInput: staged.stagedInput, kind: "campaign_zip", destination },
      contentFingerprint: staged.fingerprint,
      projection: campaignProjection,
      diagnostics: [],
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const storedProjection = await pool.query<{ preview_projection: unknown }>(
      "SELECT preview_projection FROM portable_import_operations WHERE preview_token_hash=$1",
      [hash(preview.previewHandle.token)]
    );
    await pool.query(
      `UPDATE portable_import_operations
          SET preview_projection=jsonb_set(
            preview_projection,
            '{destination}',
            jsonb_build_object(
              'kind','existing_world_version',
              'operation','attach_existing_world_version',
              'worldId',$2::text,
              'worldVersionId',$3::text
            )
          )
        WHERE preview_token_hash=$1`,
      [hash(preview.previewHandle.token), scope.worldId, scope.worldVersionId]
    );
    await expect(repository.retrievePreviewPayload(
      { ownerUserId },
      "campaign_zip",
      preview.previewHandle,
    )).rejects.toEqual(new PortableImportRepositoryError("archive_unavailable", 503));
    await pool.query(
      "UPDATE portable_import_operations SET preview_projection='{}'::jsonb WHERE preview_token_hash=$1",
      [hash(preview.previewHandle.token)]
    );
    await expect(repository.retrievePreviewPayload(
      { ownerUserId },
      "campaign_zip",
      preview.previewHandle,
    )).rejects.toEqual(new PortableImportRepositoryError("archive_unavailable", 503));
    const malformedClient = await pool.connect();
    try {
      await malformedClient.query("BEGIN");
      await expect(repository.beginImport(malformedClient, {
        ownerUserId,
        kind: "campaign_zip",
        destination,
        previewHandle: preview.previewHandle,
        idempotencyKey: `malformed-preview-${crypto.randomUUID()}`
      })).rejects.toEqual(new PortableImportRepositoryError("archive_unavailable", 503));
      await malformedClient.query("COMMIT");
    } finally {
      await malformedClient.query("ROLLBACK").catch(() => undefined);
      malformedClient.release();
    }
    const unconsumed = await pool.query<{ preview_status: string; staged_status: string }>(
      `SELECT operation.status AS preview_status,staged.status AS staged_status
         FROM portable_import_operations operation
         JOIN portable_staged_inputs staged ON staged.id=operation.staged_input_id
        WHERE operation.preview_token_hash=$1`,
      [hash(preview.previewHandle.token)]
    );
    expect(unconsumed.rows[0]).toEqual({ preview_status: "previewed", staged_status: "staged" });
    await pool.query(
      "UPDATE portable_import_operations SET preview_projection=$2::jsonb WHERE preview_token_hash=$1",
      [hash(preview.previewHandle.token), JSON.stringify(storedProjection.rows[0]!.preview_projection)]
    );

    const importId = await completedImport(ownerUserId, staged.fingerprint, scope);
    const client = await pool.connect();
    let committed;
    try {
      await client.query("BEGIN");
      const begun = await repository.beginImport(client, {
        ownerUserId, kind: "campaign_zip", destination,
        previewHandle: preview.previewHandle, idempotencyKey: `malformed-${crypto.randomUUID()}`
      });
      if (begun.outcome !== "ready") throw new Error("expected ready import");
      await expect(repository.completeImport(client, begun.claim, {
        importId,
        importedRecordId: toPortableImportedRecordId(importId),
        duplicate: false,
        diagnostics: [],
        result: {
          importId: crypto.randomUUID(), worldId: foreignScope.worldId,
          worldVersionId: foreignScope.worldVersionId, campaignId: foreignScope.campaignId,
          duplicate: false,
          stats: { turnCount: 0, memoryCount: 0, summaryCount: 0, assetCount: 0, assetBytes: 0 }
        },
        resultExpiresAt: new Date(Date.now() + 60_000).toISOString()
      })).rejects.toMatchObject({ code: "import_invalid" });
      await expect(repository.completeImport(client, begun.claim, {
        importId,
        importedRecordId: toPortableImportedRecordId(importId),
        duplicate: false,
        diagnostics: [],
        result: {
          importId, worldId: scope.worldId, worldVersionId: scope.worldVersionId,
          campaignId: scope.campaignId, duplicate: true,
          stats: { turnCount: 0, memoryCount: 0, summaryCount: 0, assetCount: 0, assetBytes: 0 }
        },
        resultExpiresAt: new Date(Date.now() + 60_000).toISOString()
      })).rejects.toMatchObject({ code: "import_invalid" });
      committed = await repository.completeImport(client, begun.claim, {
        importId,
        importedRecordId: toPortableImportedRecordId(importId),
        duplicate: false,
        diagnostics: [],
        result: {
          importId, worldId: scope.worldId, worldVersionId: scope.worldVersionId,
          campaignId: scope.campaignId, duplicate: false,
          stats: { turnCount: 0, memoryCount: 0, summaryCount: 0, assetCount: 0, assetBytes: 0 }
        },
        resultExpiresAt: new Date(Date.now() + 60_000).toISOString()
      });
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    await pool.query(
      `UPDATE portable_import_operations
          SET result_projection=jsonb_set(result_projection,'{result}','{}'::jsonb)
        WHERE result_retrieval_token_hash=$1`,
      [hash(committed!.retrieval)]
    );
    await expect(repository.retrieveImportResult(
      { ownerUserId },
      "campaign_zip",
      committed!.retrieval,
    )).rejects.toEqual(new PortableImportRepositoryError("archive_unavailable", 503));
  });

  it("reconstructs every persisted preview and result projection from public allowlisted fields", async () => {
    for (const seed of variants((await stagedInput()).stagedInput)) {
      const staged = await stagedInput();
      const command = {
        ...seed.command,
        ownerUserId,
        stagedInput: staged.stagedInput
      } as PortableImportPreviewCommand;
      const preview = await repository.createPreview({
        command,
        contentFingerprint: staged.fingerprint,
        projection: seed.projection,
        diagnostics: [],
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      });
      await pool.query(
        `UPDATE portable_import_operations
            SET preview_projection=jsonb_set(
                  preview_projection || '{"privatePath":"/private/staged","rawDiagnostic":"provider-secret"}'::jsonb,
                  '{counts,rawTokens}',
                  '"hidden-chain"'::jsonb,
                  true
                )
          WHERE preview_token_hash=$1`,
        [hash(preview.previewHandle.token)]
      );
      const retrievedPreview = await repository.retrievePreviewPayload(
        { ownerUserId },
        command.kind,
        preview.previewHandle,
      );
      expect(retrievedPreview?.projection).toEqual(seed.projection);

      const importId = await completedImport(ownerUserId, staged.fingerprint, scope);
      const expectedResult = {
        ...seed.result,
        importId,
        worldId: scope.worldId,
        worldVersionId: scope.worldVersionId,
        ...(Object.hasOwn(seed.result, "campaignId") ? { campaignId: scope.campaignId } : {})
      } as PortableImportResultProjectionFor<PortableImportKind>;
      const taintedResult = {
        ...expectedResult,
        privatePath: "/private/result",
        rawDiagnostic: "provider-stack",
        ...("stats" in expectedResult
          ? { stats: { ...expectedResult.stats, rawTokens: "hidden-chain" } }
          : {})
      } as unknown as PortableImportResultProjectionFor<PortableImportKind>;
      const idempotencyKey = `projection-${crypto.randomUUID()}`;
      const client = await pool.connect();
      let committed;
      try {
        await client.query("BEGIN");
        const begun = await repository.beginImport(client, {
          ownerUserId,
          kind: command.kind,
          destination: command.destination,
          previewHandle: preview.previewHandle,
          idempotencyKey
        });
        if (begun.outcome !== "ready") throw new Error("expected ready import");
        committed = await repository.completeImport(client, begun.claim, {
          importId,
          importedRecordId: toPortableImportedRecordId(importId),
          duplicate: false,
          diagnostics: [],
          result: taintedResult,
          resultExpiresAt: new Date(Date.now() + 60_000).toISOString()
        });
        expect(committed.result).toEqual(expectedResult);
        await client.query("COMMIT");
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }

      await pool.query(
        `UPDATE portable_import_operations
            SET result_projection=jsonb_set(
                  result_projection || '{"rawDiagnostic":"wrapper-secret"}'::jsonb,
                  '{result,privatePath}',
                  '"/private/persisted"'::jsonb,
                  true
                )
          WHERE result_retrieval_token_hash=$1`,
        [hash(committed!.retrieval)]
      );
      await expect(repository.retrieveImportResult(
        { ownerUserId },
        command.kind,
        committed!.retrieval,
      )).resolves.toEqual({ kind: command.kind, result: expectedResult, diagnostics: [] });

      const replayClient = await pool.connect();
      try {
        await replayClient.query("BEGIN");
        await expect(repository.beginImport(replayClient, {
          ownerUserId,
          kind: command.kind,
          destination: command.destination,
          previewHandle: preview.previewHandle,
          idempotencyKey
        })).resolves.toMatchObject({
          outcome: "replay",
          view: { kind: command.kind, result: expectedResult }
        });
        await replayClient.query("ROLLBACK");
      } finally {
        await replayClient.query("ROLLBACK").catch(() => undefined);
        replayClient.release();
      }
    }
  });

  it("rebinds persisted committed projections and duplicate wrappers to the owning import row", async () => {
    const staged = await stagedInput();
    const destination = { kind: "create_world" as const };
    const preview = await repository.createPreview({
      command: { ownerUserId, stagedInput: staged.stagedInput, kind: "world_json", destination },
      contentFingerprint: staged.fingerprint,
      projection: {
        kind: "world_json", valid: true, title: "Bound result", duplicate: false,
        existingWorldId: null, characters: [],
        counts: { entities: 0, relationships: 0, triggers: 0 }, warnings: []
      },
      diagnostics: [],
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const importId = await completedImport(ownerUserId, staged.fingerprint, scope);
    const idempotencyKey = `result-binding-${crypto.randomUUID()}`;
    const client = await pool.connect();
    let committed;
    try {
      await client.query("BEGIN");
      const begun = await repository.beginImport(client, {
        ownerUserId, kind: "world_json", destination,
        previewHandle: preview.previewHandle, idempotencyKey
      });
      if (begun.outcome !== "ready") throw new Error("expected ready import");
      committed = await repository.completeImport(client, begun.claim, {
        importId,
        importedRecordId: toPortableImportedRecordId(importId),
        duplicate: false,
        diagnostics: [],
        result: {
          kind: "world", importId, worldId: scope.worldId,
          worldVersionId: scope.worldVersionId, duplicate: false
        },
        resultExpiresAt: new Date(Date.now() + 60_000).toISOString()
      });
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }

    const original = await pool.query<{ result_projection: unknown }>(
      "SELECT result_projection FROM portable_import_operations WHERE result_retrieval_token_hash=$1",
      [hash(committed!.retrieval)]
    );
    for (const corrupt of [
      `jsonb_set(result_projection,'{importedRecordId}',to_jsonb('${crypto.randomUUID()}'::text))`,
      `jsonb_set(result_projection,'{result,importId}',to_jsonb('${crypto.randomUUID()}'::text))`,
      `jsonb_set(result_projection,'{result,worldId}',to_jsonb('${foreignScope.worldId}'::text))`,
      `jsonb_set(result_projection,'{duplicate}','true'::jsonb)`,
      `jsonb_set(result_projection,'{result,duplicate}','true'::jsonb)`
    ]) {
      await pool.query(
        `UPDATE portable_import_operations SET result_projection=${corrupt} WHERE result_retrieval_token_hash=$1`,
        [hash(committed!.retrieval)]
      );
      await expect(repository.retrieveImportResult(
        { ownerUserId }, "world_json", committed!.retrieval,
      )).rejects.toEqual(new PortableImportRepositoryError("archive_unavailable", 503));
      const replay = await pool.connect();
      try {
        await replay.query("BEGIN");
        await expect(repository.beginImport(replay, {
          ownerUserId, kind: "world_json", destination,
          previewHandle: preview.previewHandle, idempotencyKey
        })).rejects.toEqual(new PortableImportRepositoryError("archive_unavailable", 503));
        await replay.query("ROLLBACK");
      } finally {
        await replay.query("ROLLBACK").catch(() => undefined);
        replay.release();
      }
      await pool.query(
        "UPDATE portable_import_operations SET result_projection=$2::jsonb WHERE result_retrieval_token_hash=$1",
        [hash(committed!.retrieval), JSON.stringify(original.rows[0]!.result_projection)]
      );
    }

    const otherScope = await createWorldScope(ownerUserId, "Different local import scope");
    const otherImportId = await completedImport(
      ownerUserId, hash(`different-import-${crypto.randomUUID()}`), otherScope,
    );
    await pool.query(
      "UPDATE portable_import_operations SET import_id=$2 WHERE result_retrieval_token_hash=$1",
      [hash(committed!.retrieval), otherImportId]
    );
    await expect(repository.retrieveImportResult(
      { ownerUserId }, "world_json", committed!.retrieval,
    )).rejects.toEqual(new PortableImportRepositoryError("archive_unavailable", 503));
    const reboundReplay = await pool.connect();
    try {
      await reboundReplay.query("BEGIN");
      await expect(repository.beginImport(reboundReplay, {
        ownerUserId, kind: "world_json", destination,
        previewHandle: preview.previewHandle, idempotencyKey
      })).rejects.toEqual(new PortableImportRepositoryError("archive_unavailable", 503));
      await reboundReplay.query("ROLLBACK");
    } finally {
      await reboundReplay.query("ROLLBACK").catch(() => undefined);
      reboundReplay.release();
    }
    await pool.query(
      "UPDATE portable_import_operations SET import_id=$2 WHERE result_retrieval_token_hash=$1",
      [hash(committed!.retrieval), importId]
    );
  });

  it("binds story-text targetWorldId to its exact destination on write and read", async () => {
    const staged = await stagedInput();
    const destination = {
      kind: "existing_world_version" as const,
      worldId: scope.worldId,
      worldVersionId: scope.worldVersionId
    };
    const projection = {
      kind: "story_text" as const,
      valid: true as const,
      title: "Destination-bound story",
      duplicate: false,
      existingCampaignId: null,
      targetWorldId: scope.worldId,
      diagnostics: [] as string[],
      characters: [] as { id: string; name: string }[],
      selectedCharacterId: null,
      counts: { turns: 1, completeHistoryCharacters: 8, estimatedHistoryTokens: 2 },
      warnings: [] as string[]
    };
    await expect(repository.createPreview({
      command: { ownerUserId, stagedInput: staged.stagedInput, kind: "story_text", destination },
      contentFingerprint: staged.fingerprint,
      projection: { ...projection, targetWorldId: foreignScope.worldId },
      diagnostics: [],
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    })).rejects.toMatchObject({ code: "import_invalid" });

    const preview = await repository.createPreview({
      command: { ownerUserId, stagedInput: staged.stagedInput, kind: "story_text", destination },
      contentFingerprint: staged.fingerprint,
      projection,
      diagnostics: [],
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    await pool.query(
      "UPDATE portable_import_operations SET preview_projection=jsonb_set(preview_projection,'{targetWorldId}',to_jsonb($2::text)) WHERE preview_token_hash=$1",
      [hash(preview.previewHandle.token), foreignScope.worldId]
    );
    await expect(repository.retrievePreviewPayload(
      { ownerUserId }, "story_text", preview.previewHandle,
    )).rejects.toEqual(new PortableImportRepositoryError("archive_unavailable", 503));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await expect(repository.beginImport(client, {
        ownerUserId, kind: "story_text", destination,
        previewHandle: preview.previewHandle,
        idempotencyKey: `story-target-${crypto.randomUUID()}`
      })).rejects.toEqual(new PortableImportRepositoryError("archive_unavailable", 503));
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("preserves legacy source hashes and never treats source provenance as local authority", async () => {
    const legacySourceHash = hash(`legacy-source-${crypto.randomUUID()}`);
    const importId = await completedImport(ownerUserId, legacySourceHash, scope);
    const staged = await stagedInput();
    const preview = await repository.createPreview({
      command: {
        ownerUserId,
        stagedInput: staged.stagedInput,
        kind: "world_json",
        destination: { kind: "create_world" },
        sourceInstallationId: toPortableSourceInstallationId(foreignOwnerUserId),
        importedRecordId: toPortableImportedRecordId(foreignScope.worldId)
      },
      contentFingerprint: staged.fingerprint,
      projection: {
        kind: "world_json", valid: true, title: "Provenance", duplicate: false,
        existingWorldId: null, characters: [],
        counts: { entities: 0, relationships: 0, triggers: 0 }, warnings: []
      },
      diagnostics: [],
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const begun = await repository.beginImport(client, {
        ownerUserId,
        kind: "world_json",
        destination: { kind: "create_world" },
        previewHandle: preview.previewHandle,
        idempotencyKey: `legacy-${crypto.randomUUID()}`
      });
      if (begun.outcome !== "ready") throw new Error("expected ready import");
      await repository.completeImport(client, begun.claim, {
        importId,
        importedRecordId: toPortableImportedRecordId(importId),
        duplicate: true,
        diagnostics: [],
        result: {
          kind: "world", importId, worldId: scope.worldId,
          worldVersionId: scope.worldVersionId, duplicate: true
        },
        resultExpiresAt: new Date(Date.now() + 60_000).toISOString()
      });
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }

    const persisted = await pool.query<{
      source_hash: string;
      owner_user_id: string;
      source_installation_id: string;
      source_record_id: string;
    }>(
      `SELECT imports.source_hash,imports.owner_user_id,
              operation.source_installation_id,operation.source_record_id
         FROM portable_import_operations operation
         JOIN imports ON imports.id=operation.import_id
        WHERE operation.preview_token_hash=$1`,
      [hash(preview.previewHandle.token)]
    );
    expect(persisted.rows).toEqual([{
      source_hash: legacySourceHash,
      owner_user_id: ownerUserId,
      source_installation_id: foreignOwnerUserId,
      source_record_id: foreignScope.worldId
    }]);

    const foreignImport = await completedImport(foreignOwnerUserId, hash(crypto.randomUUID()), foreignScope);
    const secondStaged = await stagedInput();
    const secondPreview = await repository.createPreview({
      command: {
        ownerUserId, stagedInput: secondStaged.stagedInput, kind: "world_json",
        destination: { kind: "create_world" },
        importedRecordId: toPortableImportedRecordId(foreignImport)
      },
      contentFingerprint: secondStaged.fingerprint,
      projection: {
        kind: "world_json", valid: true, title: "Foreign import", duplicate: false,
        existingWorldId: null, characters: [],
        counts: { entities: 0, relationships: 0, triggers: 0 }, warnings: []
      },
      diagnostics: [],
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const denied = await pool.connect();
    try {
      await denied.query("BEGIN");
      const begun = await repository.beginImport(denied, {
        ownerUserId, kind: "world_json", destination: { kind: "create_world" },
        previewHandle: secondPreview.previewHandle,
        idempotencyKey: `foreign-import-${crypto.randomUUID()}`
      });
      if (begun.outcome !== "ready") throw new Error("expected ready import");
      await expect(repository.completeImport(denied, begun.claim, {
        importId: foreignImport,
        importedRecordId: toPortableImportedRecordId(foreignImport),
        duplicate: false,
        diagnostics: [],
        result: {
          kind: "world", importId: foreignImport, worldId: foreignScope.worldId,
          worldVersionId: foreignScope.worldVersionId, duplicate: false
        },
        resultExpiresAt: new Date(Date.now() + 60_000).toISOString()
      })).rejects.toBeInstanceOf(PortableImportRepositoryError);
      await denied.query("ROLLBACK");
    } finally {
      await denied.query("ROLLBACK").catch(() => undefined);
      denied.release();
    }
  });

  it("registers path-free export retrieval and denies foreign, mismatched, or expired access", async () => {
    const contentHash = hash(`export-${crypto.randomUUID()}`);
    const operationScopeId = `export-scope-${crypto.randomUUID()}`;
    const operationId = await durableOperation(
      ownerUserId,
      "portable_export",
      operationScopeId,
      contentHash,
      1_024,
    );
    const exported = await repository.registerExportArtifact({
      ownerUserId,
      filesystemOperationId: operationId,
      operationScopeId,
      exportKind: "campaign_zip",
      campaignId: scope.campaignId,
      worldId: scope.worldId,
      worldVersionId: scope.worldVersionId,
      contentType: "application/zip",
      contentHash,
      byteLength: 1_024,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });

    expect(exported).toMatchObject({ contentType: "application/zip", byteLength: 1_024 });
    expect(JSON.stringify(exported)).not.toContain("portable_export/");
    const redeemed = await repository.retrieveExportArtifact({
      ownerUserId,
      exportKind: "campaign_zip",
      campaignId: scope.campaignId,
      worldId: scope.worldId,
      worldVersionId: scope.worldVersionId
    }, exported.retrieval);
    expect(redeemed?.descriptor).toMatchObject({
      relativePath: `portable_export/${contentHash}.zip`,
      contentHash,
      byteLength: 1_024
    });
    expect(await repository.retrieveExportArtifact({
      ownerUserId: foreignOwnerUserId,
      exportKind: "campaign_zip",
      campaignId: foreignScope.campaignId,
      worldId: foreignScope.worldId,
      worldVersionId: foreignScope.worldVersionId
    }, exported.retrieval)).toBeNull();
    expect(await repository.retrieveExportArtifact({
      ownerUserId,
      exportKind: "campaign_zip",
      campaignId: scope.campaignId,
      worldId: scope.worldId,
      worldVersionId: crypto.randomUUID()
    }, exported.retrieval)).toBeNull();

    const persisted = await pool.query<{ retrieval_token_hash: string }>(
      "SELECT retrieval_token_hash FROM portable_export_artifacts WHERE filesystem_operation_id=$1",
      [operationId]
    );
    expect(persisted.rows[0]!.retrieval_token_hash).toBe(hash(exported.retrieval));
    expect(persisted.rows[0]!.retrieval_token_hash).not.toBe(exported.retrieval);
    await pool.query(
      "UPDATE portable_export_artifacts SET expires_at=now()-interval '1 second' WHERE filesystem_operation_id=$1",
      [operationId]
    );
    expect(await repository.retrieveExportArtifact({
      ownerUserId,
      exportKind: "campaign_zip",
      campaignId: scope.campaignId,
      worldId: scope.worldId,
      worldVersionId: scope.worldVersionId
    }, exported.retrieval)).toBeNull();
  });

  it("fails closed when staged or export metadata diverges from its immutable descriptor", async () => {
    const staged = await stagedInput();
    for (const mutation of [
      { column: "content_hash", value: hash(`staged-tamper-${crypto.randomUUID()}`) },
      { column: "byte_length", value: "9007199254740992" }
    ]) {
      await pool.query(
        `UPDATE portable_staged_inputs SET ${mutation.column}=$2 WHERE filesystem_operation_id=$1`,
        [staged.operationId, mutation.value]
      );
      await expect(repository.retrieveStagedPayload(
        { ownerUserId }, staged.stagedInput,
      )).rejects.toEqual(new PortableImportRepositoryError("archive_unavailable", 503));
      await pool.query(
        "UPDATE portable_staged_inputs SET content_hash=$2,byte_length=512 WHERE filesystem_operation_id=$1",
        [staged.operationId, staged.fingerprint]
      );
    }

    const exportHash = hash(`descriptor-export-${crypto.randomUUID()}`);
    const operationScopeId = `descriptor-export-${crypto.randomUUID()}`;
    const operationId = await durableOperation(
      ownerUserId, "portable_export", operationScopeId, exportHash, 1_024,
    );
    const exported = await repository.registerExportArtifact({
      ownerUserId,
      filesystemOperationId: operationId,
      operationScopeId,
      exportKind: "campaign_zip",
      campaignId: scope.campaignId,
      worldId: scope.worldId,
      worldVersionId: scope.worldVersionId,
      contentType: "application/zip",
      contentHash: exportHash,
      byteLength: 1_024,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const exportScope = {
      ownerUserId,
      exportKind: "campaign_zip" as const,
      campaignId: scope.campaignId,
      worldId: scope.worldId,
      worldVersionId: scope.worldVersionId
    };
    for (const mutation of [
      { column: "content_hash", value: hash(`export-tamper-${crypto.randomUUID()}`) },
      { column: "byte_length", value: "9007199254740992" }
    ]) {
      await pool.query(
        `UPDATE portable_export_artifacts SET ${mutation.column}=$2 WHERE filesystem_operation_id=$1`,
        [operationId, mutation.value]
      );
      await expect(repository.retrieveExportArtifact(exportScope, exported.retrieval))
        .rejects.toEqual(new PortableImportRepositoryError("archive_unavailable", 503));
      await pool.query(
        "UPDATE portable_export_artifacts SET content_hash=$2,byte_length=1024 WHERE filesystem_operation_id=$1",
        [operationId, exportHash]
      );
    }
  });

  it("denies staged capability issuance for every authority or descriptor mismatch", async () => {
    const cases = ["owner", "scope", "hash", "length", "purpose", "lifecycle"] as const;
    for (const mismatch of cases) {
      const expectedHash = hash(`staged-issuance-${mismatch}-${crypto.randomUUID()}`);
      const operationScopeId = `staged-issuance-${mismatch}-${crypto.randomUUID()}`;
      const operationOwner = mismatch === "owner" ? foreignOwnerUserId : ownerUserId;
      const purpose = mismatch === "purpose" ? "portable_export" as const : "portable_staging" as const;
      const operationId = await durableOperation(
        operationOwner, purpose, operationScopeId, expectedHash, 512,
      );
      if (mismatch === "lifecycle") {
        await pool.query(
          "UPDATE durable_filesystem_operations SET lifecycle='cleanup_pending',cleanup_requested_at=now() WHERE id=$1",
          [operationId]
        );
      }
      await expect(repository.registerStagedInput({
        ownerUserId,
        filesystemOperationId: operationId,
        operationScopeId: mismatch === "scope" ? `${operationScopeId}-wrong` : operationScopeId,
        contentHash: mismatch === "hash" ? hash(`${expectedHash}-wrong`) : expectedHash,
        byteLength: mismatch === "length" ? 513 : 512,
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      })).rejects.toEqual(new PortableImportRepositoryError("archive_unavailable", 404));
    }
  });

  it("denies both export kinds for every authority or descriptor mismatch and issues valid capabilities", async () => {
    const exportKinds = [
      { exportKind: "campaign_zip" as const, campaignId: scope.campaignId, contentType: "application/zip" as const },
      { exportKind: "world_json" as const, campaignId: null, contentType: "application/json" as const }
    ];
    const cases = ["owner", "scope", "hash", "length", "purpose", "lifecycle"] as const;
    for (const exportVariant of exportKinds) {
      for (const mismatch of cases) {
        const expectedHash = hash(`${exportVariant.exportKind}-${mismatch}-${crypto.randomUUID()}`);
        const operationScopeId = `${exportVariant.exportKind}-${mismatch}-${crypto.randomUUID()}`;
        const operationOwner = mismatch === "owner" ? foreignOwnerUserId : ownerUserId;
        const purpose = mismatch === "purpose" ? "portable_staging" as const : "portable_export" as const;
        const operationId = await durableOperation(
          operationOwner, purpose, operationScopeId, expectedHash, 1_024,
        );
        if (mismatch === "lifecycle") {
          await pool.query(
            "UPDATE durable_filesystem_operations SET lifecycle='cleanup_pending',cleanup_requested_at=now() WHERE id=$1",
            [operationId]
          );
        }
        await expect(repository.registerExportArtifact({
          ownerUserId,
          filesystemOperationId: operationId,
          operationScopeId: mismatch === "scope" ? `${operationScopeId}-wrong` : operationScopeId,
          exportKind: exportVariant.exportKind,
          campaignId: exportVariant.campaignId,
          worldId: scope.worldId,
          worldVersionId: scope.worldVersionId,
          contentType: exportVariant.contentType,
          contentHash: mismatch === "hash" ? hash(`${expectedHash}-wrong`) : expectedHash,
          byteLength: mismatch === "length" ? 1_025 : 1_024,
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        })).rejects.toEqual(new PortableImportRepositoryError("archive_unavailable", 404));
      }

      const contentHash = hash(`valid-${exportVariant.exportKind}-${crypto.randomUUID()}`);
      const operationScopeId = `valid-${exportVariant.exportKind}-${crypto.randomUUID()}`;
      const operationId = await durableOperation(
        ownerUserId, "portable_export", operationScopeId, contentHash, 1_024,
      );
      const exported = await repository.registerExportArtifact({
        ownerUserId,
        filesystemOperationId: operationId,
        operationScopeId,
        exportKind: exportVariant.exportKind,
        campaignId: exportVariant.campaignId,
        worldId: scope.worldId,
        worldVersionId: scope.worldVersionId,
        contentType: exportVariant.contentType,
        contentHash,
        byteLength: 1_024,
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      });
      await expect(repository.retrieveExportArtifact({
        ownerUserId,
        exportKind: exportVariant.exportKind,
        campaignId: exportVariant.campaignId,
        worldId: scope.worldId,
        worldVersionId: scope.worldVersionId
      }, exported.retrieval)).resolves.toMatchObject({
        contentType: exportVariant.contentType,
        contentHash,
        byteLength: 1_024
      });
    }
  });
});
