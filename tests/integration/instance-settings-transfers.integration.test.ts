import { createApiSystemArchiveComposition } from "../../services/runtime/src/system-archive-composition.js";
import { createPostgresSecureStorageRepository } from "../../packages/database/src/secure-storage-repository.js";
import { createPostgresDurableFilesystemRepository } from "../../packages/database/src/durable-filesystem-repository.js";
import { setTimeout as delay } from "node:timers/promises";
import { createPostgresSystemArchivePrivateStorageRepository } from "../../packages/database/src/system-archive-private-storage-repository.js";
import { request as httpRequest } from "node:http";
import { createPostgresImportRepository } from "../../packages/database/src/import-repository.js";
import { createPostgresPortableImportAuthorityRepository } from "../../packages/database/src/portable-import-family-repository.js";
import { canonicalPortableImportAuthority } from "../../packages/application/src/imports/private-portable-composition.js";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { Readable } from "node:stream";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYSTEM_ARCHIVE_DOMAINS } from "../../packages/contracts/src/system-archives.js";
import { historicalArchivePolicy, type ArchivePolicySnapshot } from "../../packages/contracts/src/archive-policy.js";
import { registerArchiveRoutes } from "../../services/api/src/archive-routes.js";
import { registerSystemArchiveRoutes } from "../../services/api/src/system-archive-routes.js";
import { runtimeArchivePolicy } from "../../services/runtime/src/archive-policy.js";
import { createPostgresSystemArchiveImportRepository } from "../../packages/database/src/system-archive-import-repository.js";
import { createInstanceSettingsRepository } from "../../packages/database/src/instance-settings-repository.js";
import { createSettingsActivationGuard } from "../../services/runtime/src/settings-activation.js";
import { loadActiveRuntimeSettings, settingsDigest } from "../../services/runtime/src/instance-settings.js";
import { bootstrap, runtimePolicy } from "../helpers/instance-settings-runtime.js";
import { settingsFixture } from "../fixtures/instance-settings.js";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createPostgresSystemArchiveUploadRepository } from "../../packages/database/src/system-archive-upload-repository.js";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
describe("durable transfer settings across restart", () => {
  let pool: DatabasePool, owner: { ownerUserId: string };
  beforeAll(async () => { pool = createDatabasePool(process.env.TEST_DATABASE_URL!, 8); await migrateDatabase(pool, resolve("database/migrations")); owner = { ownerUserId: await initialOwnerId(pool) }; }, 60000);
  afterAll(async () => { await pool?.end(); });
  beforeEach(async () => { await pool.query("UPDATE portable_import_work SET status='expired',terminal_at=clock_timestamp(),lease_id=NULL,lease_owner=NULL,lease_expires_at=NULL WHERE status IN ('running','recoverable')"); await pool.query("UPDATE portable_import_operations SET status='expired' WHERE status='previewed'"); await pool.query("DELETE FROM system_archive_jobs"); await pool.query("DELETE FROM system_archive_uploads"); });
  it("loads every transfer control from the active revision while keeping staged changes inactive", async () => {
    const policy = runtimePolicy();
    const repository = createInstanceSettingsRepository(pool, { activationGuard: createSettingsActivationGuard(policy) });
    const actor = { userId: owner.ownerUserId, cliReference: "transfer-settings-test" };
    const seed = settingsFixture();
    const active = { ...seed, archivePreviewTtlSeconds: 2400, systemArchiveArtifactTtlSeconds: 3600, systemArchiveUploadTtlSeconds: 1200, systemArchiveChunkBytes: 1048576,
      campaignArchiveLimits: Object.fromEntries(Object.entries(seed.campaignArchiveLimits).map(([key, value]) => [key, Math.floor(value / 2)])) as typeof seed.campaignArchiveLimits,
      systemArchiveLimits: Object.fromEntries(Object.entries(seed.systemArchiveLimits).map(([key, value]) => [key, Math.floor(value / 2)])) as typeof seed.systemArchiveLimits };
    await repository.seed({ installationId: policy.installationId, snapshot: active, policyDigest: settingsDigest(policy), seedDigest: settingsDigest(active), actor });
    await repository.activate({ expectedActiveRevision: null, expectedRequestedRevision: "1", policyDigest: settingsDigest(policy), maintenanceReference: "transfer-test-drained", actor });
    const loaded = await loadActiveRuntimeSettings(pool, bootstrap(), policy);
    expect(runtimeArchivePolicy(loaded.config, "campaign")).toEqual({ version: 1, settingsRevision: "1", previewTtlSeconds: 2400, artifactTtlSeconds: 3600, uploadTtlSeconds: 1200, chunkBytes: 1048576, limits: active.campaignArchiveLimits });
    expect(runtimeArchivePolicy(loaded.config, "system")).toMatchObject({ settingsRevision: "1", previewTtlSeconds: 1800, limits: active.systemArchiveLimits });
    const staged = { ...active, archivePreviewTtlSeconds: 3000, systemArchiveEnabled: false };
    await repository.propose({ expectedRequestedRevision: "1", snapshot: staged, actor, reason: "transfer-staged" });
    const restarted = await loadActiveRuntimeSettings(pool, bootstrap(), policy);
    expect(restarted.config.archivePreviewTtlSeconds).toBe(2400);
    expect(restarted.config.systemArchiveEnabled).toBe(true);
    expect(runtimeArchivePolicy(bootstrap(), "campaign").previewTtlSeconds).toBe(1800);
    expect(runtimeArchivePolicy(bootstrap(), "system").previewTtlSeconds).toBe(1800);
  });
  it("retains the original inactivity TTL on new chunk, replay and assembly after restart", async () => {
    const operation = await pool.query<{ id: string }>(`INSERT INTO durable_filesystem_operations(owner_user_id,operation_token_hash,purpose,resource_kind,operation_scope_hash,lease_id,lease_owner,lease_expires_at,expires_at) VALUES($1,$2,'portable_staging','portable',$3,gen_random_uuid(),'settings-transfer',now()+interval '5 minutes',now()+interval '1 day') RETURNING id`, [owner.ownerUserId, hash(randomUUID()), hash(randomUUID())]);
    const original = createPostgresSystemArchiveUploadRepository(pool, { uploadTtlSeconds: 600 });
    const upload = await original.createUpload(owner, { filesystemOperationId: operation.rows[0]!.id, handleTokenHash: hash(randomUUID()), byteLength: 4, sha256: hash("abcd") });
    const restarted = createPostgresSystemArchiveUploadRepository(pool, { uploadTtlSeconds: 3600 });
    const chunk = { uploadId: upload.id, index: 0, offset: 0, bytes: 4, sha256: hash("abcd") };
    const assertOriginalTtl = async () => { const result = await pool.query("SELECT extract(epoch from expires_at-clock_timestamp())::float AS remaining FROM system_archive_uploads WHERE id=$1", [upload.id]); expect(result.rows[0].remaining).toBeGreaterThan(590); expect(result.rows[0].remaining).toBeLessThanOrEqual(600); };
    await restarted.recordChunk(owner, chunk); await assertOriginalTtl();
    await restarted.recordChunk(owner, chunk); await assertOriginalTtl();
    await restarted.getAssembly(owner, upload.id); await assertOriginalTtl();
  });
  async function completedUpload(policy: ArchivePolicySnapshot) {
    const operation = await pool.query<{ id: string }>(`INSERT INTO durable_filesystem_operations(owner_user_id,operation_token_hash,purpose,resource_kind,operation_scope_hash,lease_id,lease_owner,lease_expires_at,expires_at) VALUES($1,$2,'portable_staging','portable',$3,gen_random_uuid(),'settings-transfer',now()+interval '5 minutes',now()+interval '1 day') RETURNING id`, [owner.ownerUserId, hash(randomUUID()), hash(randomUUID())]);
    const uploads = createPostgresSystemArchiveUploadRepository(pool, { uploadTtlSeconds: policy.uploadTtlSeconds, policy });
    const upload = await uploads.createUpload(owner, { filesystemOperationId: operation.rows[0]!.id, handleTokenHash: hash(randomUUID()), byteLength: 4, sha256: hash("abcd") });
    await uploads.recordChunk(owner, { uploadId: upload.id, index: 0, offset: 0, bytes: 4, sha256: hash("abcd") });
    const staged = await pool.query<{ id: string }>(`INSERT INTO portable_staged_inputs(owner_user_id,handle_token_hash,filesystem_operation_id,content_hash,byte_length,expires_at) VALUES($1,$2,$3,$4,4,now()+interval '1 day') RETURNING id`, [owner.ownerUserId, hash(randomUUID()), operation.rows[0]!.id, hash("abcd")]);
    await uploads.completeUpload(owner, { uploadId: upload.id, stagedInputId: staged.rows[0]!.id });
    return upload;
  }
  async function preview(policy: ArchivePolicySnapshot, uploadId?: string) {
    const upload = uploadId ? { id: uploadId } : await completedUpload(policy);
    const imports = createPostgresSystemArchiveImportRepository(pool, policy);
    const destination = await imports.destinationFingerprint(owner, { ignoreUploadId: upload.id });
    const archiveFingerprint = hash("validated-system-archive");
    const projection = {
      versions: { archiveFormat: 1, sourceApplication: "0.1.0", sourceMigration: "0079_resumable_system_archive_uploads", destinationApplication: "0.1.0", destinationMigration: destination.latestMigration },
      sourceOwnerCount: 1, archiveFingerprint, recordsByDomain: Object.fromEntries(SYSTEM_ARCHIVE_DOMAINS.map((domain) => [domain, 0])),
      assets: { originalCount: 0, totalBytes: 0 }, destinationEmpty: true, ownerMapping: { sourceOwnerId: owner.ownerUserId, destinationOwnerId: owner.ownerUserId }, disabledProviders: 0, omittedOperationalRows: 0,
      operationalOmissions: { generation: 0, illustration: 0, chronicle: 0, imports: 0, "system-archive": 0 },
      invalidatedAccess: ["share-links", "sessions", "oidc-identities", "external-authorizations"], normalization: ["map-source-owner-to-initial-owner", "disable-provider-profiles"],
      rebuilds: { chronicleIndex: { category: "chronicle-index", status: "pending", itemCount: 0 }, assetThumbnails: { category: "asset-thumbnails", status: "pending", itemCount: 0 } },
      space: { staging: { requiredBytes: 0, availableBytes: 0, verified: true, sufficient: true, overrideUsed: false }, assetRoot: { requiredBytes: 0, availableBytes: 0, verified: true, sufficient: true, overrideUsed: false } }, warnings: [], errors: [],
    };
    return { ...await imports.createPreview(owner, { uploadId: upload.id, archiveFingerprint, destination, projection }), uploadId: upload.id };
  }
  it.each(Object.keys(historicalArchivePolicy("system").limits) as (keyof ArchivePolicySnapshot["limits"])[])("requires a fresh System preview after tightening %s across restart", async (key) => {
    const original = { ...historicalArchivePolicy("system"), settingsRevision: "1" };
    const issued = await preview(original);
    const record = (await pool.query("SELECT policy_snapshot,extract(epoch from (progress->>'expiresAt')::timestamptz-created_at)::float AS ttl FROM system_archive_jobs WHERE id=$1", [issued.jobId])).rows[0];
    expect(record.policy_snapshot).toEqual(original);
    expect(record.ttl).toBeGreaterThan(1799); expect(record.ttl).toBeLessThanOrEqual(1801);
    const tightened = { ...original, settingsRevision: "2", limits: { ...original.limits, [key]: original.limits[key] - 1 } };
    await expect(createPostgresSystemArchiveImportRepository(pool, tightened).consumePreviewAuthority(owner, issued.previewHandle, "commit-test")).rejects.toMatchObject({ statusCode: 409, code: "archive-preview-stale" });
    expect((await pool.query("SELECT status FROM system_archive_jobs WHERE id=$1", [issued.jobId])).rows[0].status).toBe("expired");
    const fresh = await preview(tightened, issued.uploadId);
    // A later increase keeps the historical snapshot and original expiry.
    const relaxed = { ...original, settingsRevision: "3", limits: { ...original.limits, [key]: original.limits[key] + 1 } };
    await createPostgresSystemArchiveImportRepository(pool, relaxed).consumePreviewAuthority(owner, fresh.previewHandle, "commit-test");
    expect((await pool.query("SELECT policy_snapshot,progress->>'expiresAt' AS expiry FROM system_archive_jobs WHERE id=$1", [issued.jobId])).rows[0]).toEqual({ policy_snapshot: original, expiry: issued.expiresAt });
    await expect(pool.query("UPDATE system_archive_jobs SET policy_snapshot=NULL WHERE id=$1", [issued.jobId])).rejects.toThrow("archive_policy_snapshot_immutable");
  });
  it("rejects a streamed multipart preview over the new compressed limit and preserves prior files", async () => {
    const root = await mkdtemp(join(tmpdir(), "iqn-settings-multipart-"));
    const marker = join(root, "previous-upload.pending"); await writeFile(marker, "prior durable upload");
    const app = Fastify(); await app.register(multipart);
    const stageInput = vi.fn();
    const config = { ...bootstrap(), archiveStorageRoot: root, campaignArchiveLimits: { ...historicalArchivePolicy("campaign").limits, maxCompressedBytes: 16 } };
    await app.register(registerArchiveRoutes, { pool, config, portable: { stageInput }, imports: {}, resolveOwner: async () => owner } as never);
    const boundary = "transfer-settings-boundary";
    const chunks = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="campaign.zip"\r\nContent-Type: application/zip\r\n\r\n`), Buffer.alloc(32, 120), Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="destination"\r\n\r\n{"kind":"embedded"}\r\n--${boundary}--\r\n`)];
    try {
      const result = await app.inject({ method: "POST", url: "/api/v1/imports/campaign-archive/preview", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: Readable.from(chunks) });
      expect(result.statusCode).toBe(400); expect(result.json().code).toBe("archive-limit-exceeded"); expect(stageInput).not.toHaveBeenCalled();
      expect(await readFile(marker, "utf8")).toBe("prior durable upload");
      expect(await readdir(root)).toEqual(["previous-upload.pending", "staging"]);
      expect(await readdir(join(root, "staging"))).toEqual([]);
    } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  });
  it("rejects a new chunk before reading its body under a tighter route ceiling", async () => {
    const app = Fastify(); const putChunk = vi.fn();
    await app.register(registerSystemArchiveRoutes, { enabled: true, application: { putChunk } as never, downloads: {} as never, resolveOwner: async () => owner, limits: { chunkBytes: 4, maximumUploadBytes: 64, maximumDownloadBytes: 64, downloadDeadlineMs: 1000 } });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const status = await new Promise<number>((done, reject) => {
        const request = httpRequest(`${address}/api/v1/system-imports/uploads/${randomUUID()}/chunks/0`, { method: "PUT", headers: { "content-type": "application/octet-stream", "content-length": "8" } }, (response) => {
          response.resume(); response.once("end", () => { done(response.statusCode!); request.destroy(); });
        });
        request.setTimeout(3000, () => { request.destroy(); reject(new Error("chunk-body-was-awaited")); });
        request.once("error", reject);
        // Deliberately send headers only. Admission must reject before any body arrives.
        request.flushHeaders();
      });
      expect(status).toBe(413); expect(putChunk).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("keeps a historical session's recorded expiry rather than guessing a TTL from the latest environment", async () => {
    const operation = await pool.query<{ id: string }>(`INSERT INTO durable_filesystem_operations(owner_user_id,operation_token_hash,purpose,resource_kind,operation_scope_hash,lease_id,lease_owner,lease_expires_at,expires_at) VALUES($1,$2,'portable_staging','portable',$3,gen_random_uuid(),'settings-transfer',now()+interval '5 minutes',now()+interval '10 minutes') RETURNING id`, [owner.ownerUserId, hash(randomUUID()), hash(randomUUID())]);
    const inserted = await pool.query<{ id: string; expires_at: Date }>(`INSERT INTO system_archive_uploads(owner_user_id,handle_token_hash,filesystem_operation_id,byte_length,content_hash,expires_at) VALUES($1,$2,$3,4,$4,now()+interval '10 minutes') RETURNING id,expires_at`, [owner.ownerUserId, hash(randomUUID()), operation.rows[0]!.id, hash("abcd")]);
    const upload = inserted.rows[0]!;
    const restarted = createPostgresSystemArchiveUploadRepository(pool, { uploadTtlSeconds: 86400 });
    await restarted.recordChunk(owner, { uploadId: upload.id, index: 0, offset: 0, bytes: 4, sha256: hash("abcd") });
    await restarted.getAssembly(owner, upload.id);
    expect((await pool.query("SELECT expires_at FROM system_archive_uploads WHERE id=$1", [upload.id])).rows[0].expires_at).toEqual(upload.expires_at);
  });
  async function portableOperation(purpose: "portable_staging" | "portable_export") {
    const scope = randomUUID();
    const operation = await pool.query<{ id: string }>(`INSERT INTO durable_filesystem_operations(owner_user_id,operation_token_hash,purpose,resource_kind,operation_scope_hash,lease_id,lease_owner,lease_expires_at,expires_at) VALUES($1,$2,$3,'portable',$4,gen_random_uuid(),'settings-transfer',now()+interval '5 minutes',now()+interval '1 day') RETURNING id`, [owner.ownerUserId, hash(randomUUID()), purpose, hash(scope)]);
    const id = operation.rows[0]!.id;
    await pool.query("UPDATE durable_filesystem_operations SET lifecycle='attached',candidate_token_hash=$2,locator_token_hash=$3,attached_at=clock_timestamp() WHERE id=$1", [id, hash(randomUUID()), hash(randomUUID())]);
    await pool.query(`INSERT INTO durable_filesystem_descriptors(operation_id,owner_user_id,descriptor_role,ordinal,relative_path,device_id,file_id,change_token,content_hash,byte_length) VALUES($1,$2,'delivery',0,$3,'dev','file','change',$4,4)`, [id, owner.ownerUserId, `staging/${id}.pending`, hash("abcd")]);
    await pool.query("UPDATE durable_filesystem_operations SET lifecycle='finalized',finalized_at=clock_timestamp() WHERE id=$1", [id]);
    return { id, scope };
  }
  it("pins campaign/world preview policy outside portable payloads and rejects a tighter resumed preview", async () => {
    const original = { ...historicalArchivePolicy("campaign"), settingsRevision: "1" };
    const operation = await portableOperation("portable_staging");
    const portable = createPostgresImportRepository(pool);
    const stagedInput = await portable.registerStagedInput({ ownerUserId: owner.ownerUserId, filesystemOperationId: operation.id, operationScopeId: operation.scope, contentHash: hash("abcd"), byteLength: 4, expiresAt: new Date(Date.now()+5000).toISOString() });
    const command = { ownerUserId: owner.ownerUserId, stagedInput, kind: "world_text" as const, destination: { kind: "create_world" as const } };
    const authority = { kind: "world_text" as const, destination: command.destination, normalizedPayload: { title: "Transfer world", sourceText: "green hills" }, sourceInstallationId: null, sourceRecordId: null, selectedCharacterId: null, providerConfigurationFingerprint: "a".repeat(64) };
    const repository = createPostgresPortableImportAuthorityRepository(pool, portable, undefined, original);
    const issued = await repository.persistPreviewAuthority({ command, authority, authorityFingerprint: hash(canonicalPortableImportAuthority(authority)), projection: { kind: "world_text", valid: true, requiresProvider: true, warnings: [], counts: { sourceCharacters: 11, sourceWords: 2 } }, diagnostics: [], expiresAt: new Date(Date.now()+1800000).toISOString() });
    const commit = { ...command, previewHandle: issued.previewHandle, idempotencyKey: "transfer-resume" };
    const tighter = { ...original, settingsRevision: "2", limits: { ...original.limits, maxEntries: 1 } };
    await expect(createPostgresPortableImportAuthorityRepository(pool, portable, undefined, tighter).readPreviewAuthority({ command: commit })).rejects.toMatchObject({ code: "archive-preview-stale" });
    const relaxed = { ...original, settingsRevision: "3", limits: { ...original.limits, maxEntries: original.limits.maxEntries+1 } };
    const resumed = await createPostgresPortableImportAuthorityRepository(pool, portable, undefined, relaxed).readPreviewAuthority({ command: commit });
    expect(resumed?.authority).toEqual(authority);
    const row = (await pool.query("SELECT policy_snapshot,normalized_payload,expires_at FROM portable_import_operations WHERE preview_token_hash=$1", [hash(issued.previewHandle.token)])).rows[0];
    expect((await pool.query("SELECT expires_at FROM portable_staged_inputs WHERE filesystem_operation_id=$1", [operation.id])).rows[0].expires_at.getTime()).toBeGreaterThanOrEqual(new Date(issued.expiresAt).getTime());
    expect(row.policy_snapshot).toEqual(original); expect(row.normalized_payload).toEqual(authority.normalizedPayload); expect(row.expires_at.toISOString()).toBe(issued.expiresAt);
  });

  it("keeps an issued artifact's recorded expiry and policy after later configuration changes", async () => {
    const operation = await portableOperation("portable_export");
    const policy = { ...historicalArchivePolicy("system"), settingsRevision: "1", artifactTtlSeconds: 600 };
    const expiresAt = new Date(Date.now()+600000).toISOString();
    const portable = createPostgresImportRepository(pool);
    const issued = await portable.registerExportArtifact({ ownerUserId: owner.ownerUserId, exportKind: "system_zip", campaignId: null, worldId: null, worldVersionId: null, filesystemOperationId: operation.id, operationScopeId: operation.scope, contentType: "application/zip", contentHash: hash("abcd"), byteLength: 4, expiresAt, policy });
    await loadActiveRuntimeSettings(pool, bootstrap(), runtimePolicy());
    const artifact = await portable.retrieveExportArtifact({ ownerUserId: owner.ownerUserId, exportKind: "system_zip", campaignId: null, worldId: null, worldVersionId: null }, issued.retrieval);
    expect(artifact?.expiresAt).toBe(expiresAt);
    expect((await pool.query("SELECT policy_snapshot FROM portable_export_artifacts WHERE filesystem_operation_id=$1", [operation.id])).rows[0].policy_snapshot).toEqual(policy);
  });

  it("uses original inactivity TTL in long-running storage heartbeats after restart", async () => {
    const upload = await completedUpload({ ...historicalArchivePolicy("system"), uploadTtlSeconds: 1 });
    const id = (await pool.query("SELECT filesystem_operation_id AS id FROM system_archive_uploads WHERE id=$1", [upload.id])).rows[0].id;
    await pool.query("INSERT INTO durable_filesystem_prewrite_nodes(operation_id,owner_user_id,purpose,relative_path,authority_state) VALUES($1,$2,'portable_staging',$3,'target_only')", [id, owner.ownerUserId, `staging/${id}.pending`]);
    await pool.query("UPDATE durable_filesystem_prewrite_nodes SET authority_state='identity_bound',device_id='dev',file_id='file',identity_bound_at=clock_timestamp() WHERE operation_id=$1", [id]);
    await pool.query("UPDATE durable_filesystem_operations SET lifecycle='attached',candidate_token_hash=$2,locator_token_hash=$3,attached_at=clock_timestamp() WHERE id=$1", [id, hash(randomUUID()), hash(randomUUID())]);
    await pool.query(`INSERT INTO durable_filesystem_descriptors(operation_id,owner_user_id,descriptor_role,ordinal,relative_path,device_id,file_id,change_token,content_hash,byte_length) VALUES($1,$2,'delivery',0,$3,'dev','file','change',$4,4)`, [id, owner.ownerUserId, `staging/${id}.pending`, hash("abcd")]);
    await pool.query("UPDATE durable_filesystem_operations SET lifecycle='finalized',finalized_at=clock_timestamp() WHERE id=$1", [id]);
    await pool.query("UPDATE durable_filesystem_operations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
    await createPostgresSystemArchivePrivateStorageRepository(pool).withCompletedUploadLock({ ownerUserId: owner.ownerUserId, uploadId: upload.id, leaseOwner: "settings-restarted", leaseSeconds: 1, activitySeconds: 4 }, async () => {
      await delay(1200);
      const row = (await pool.query("SELECT extract(epoch from expires_at-clock_timestamp())::float AS remaining FROM system_archive_uploads WHERE id=$1", [upload.id])).rows[0];
      expect(row.remaining).toBeGreaterThan(0); expect(row.remaining).toBeLessThanOrEqual(1);
    });
  });

  it("keeps expired upload cleanup eligible when new archive admission is disabled", async () => {
    const upload = await completedUpload(historicalArchivePolicy("system"));
    const id = (await pool.query("SELECT filesystem_operation_id AS id FROM system_archive_uploads WHERE id=$1", [upload.id])).rows[0].id;
    await pool.query("INSERT INTO durable_filesystem_prewrite_nodes(operation_id,owner_user_id,purpose,relative_path,authority_state) VALUES($1,$2,'portable_staging',$3,'target_only')", [id, owner.ownerUserId, `staging/${id}.pending`]);
    await pool.query("UPDATE system_archive_uploads SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [upload.id]);
    await pool.query("UPDATE durable_filesystem_operations SET expires_at=clock_timestamp()-interval '1 second',lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
    const app = Fastify();
    await app.register(registerSystemArchiveRoutes, { enabled: false } as never);
    try {
      expect((await app.inject({ method: "POST", url: "/api/v1/system-imports/uploads", payload: { byteLength: 4, sha256: hash("abcd") } })).statusCode).toBe(404);
      const work = await createPostgresSecureStorageRepository(pool, createPostgresDurableFilesystemRepository(pool)).claimExpiredPortableWork({ leaseOwner: "settings-disabled-reaper", leaseSeconds: 30, limit: 100 });
      expect(work.some((item) => item.operation.operationId === id)).toBe(true);
    } finally { await app.close(); }
  });

  it("retains the original chunk cap after an increase and requires restart when the declared upload no longer fits", async () => {
    const original = { ...historicalArchivePolicy("system"), uploadTtlSeconds: 600, chunkBytes: 4, limits: { ...historicalArchivePolicy("system").limits, maxCompressedBytes: 64 } };
    const upload = await completedUpload(original);
    const config = { ...bootstrap(), systemArchiveUploadTtlSeconds: 3600, systemArchiveChunkBytes: 8, systemArchiveLimits: original.limits };
    const increased = createApiSystemArchiveComposition({ pool, config, storage: { adapter: {} } as never });
    await expect(increased.uploadAdmission!(owner, upload.id, 5)).rejects.toMatchObject({ statusCode: 413 });
    await expect(increased.uploadAdmission!(owner, upload.id, 4)).resolves.toBeUndefined();
    const tightened = createApiSystemArchiveComposition({ pool, config: { ...config, systemArchiveChunkBytes: 2, systemArchiveLimits: { ...original.limits, maxCompressedBytes: 3 } }, storage: { adapter: {} } as never });
    await expect(tightened.uploadAdmission!(owner, upload.id, 2)).rejects.toMatchObject({ statusCode: 409, code: "system-archive-upload-restart-required" });
    expect((await pool.query("SELECT received_bytes,policy_snapshot FROM system_archive_uploads WHERE id=$1", [upload.id])).rows[0]).toEqual({ received_bytes: "4", policy_snapshot: original });
  });

  it.each(["incomplete", "full-prefix", "completed"])("rejects oversized completion before renewal for %s", async (mode) => {
    const original = { ...historicalArchivePolicy("system"), chunkBytes: 4, uploadTtlSeconds: 600 };
    const upload = await completedUpload(original);
    if (mode !== "completed") {
      // A separate incomplete authority avoids mutating the completed lifecycle.
      await pool.query("DELETE FROM system_archive_jobs");
    }
    const operation = await portableOperation("portable_staging");
    let id = upload.id;
    if (mode !== "completed") {
      await pool.query("INSERT INTO system_archive_uploads(owner_user_id,handle_token_hash,filesystem_operation_id,byte_length,content_hash,expires_at,policy_snapshot) VALUES($1,$2,$3,4,$4,clock_timestamp()+interval '10 minutes',$5::jsonb) RETURNING id", [owner.ownerUserId, hash(randomUUID()), operation.id, hash("abcd"), JSON.stringify(original)]).then(result => { id = result.rows[0].id; });
    }
    if (mode === "full-prefix") await createPostgresSystemArchiveUploadRepository(pool, { uploadTtlSeconds: 600, policy: original }).recordChunk(owner, { uploadId: id, index: 0, offset: 0, bytes: 4, sha256: hash("abcd") });
    const before = (await pool.query("SELECT expires_at FROM system_archive_uploads WHERE id=$1", [id])).rows[0].expires_at;
    const config = { ...bootstrap(), systemArchiveUploadTtlSeconds: 3600, systemArchiveChunkBytes: 2, systemArchiveLimits: { ...original.limits, maxCompressedBytes: 3 } };
    const api = createApiSystemArchiveComposition({ pool, config, storage: { adapter: {} } as never });
    await expect(api.application.completeUpload({ ownerUserId: owner.ownerUserId, uploadId: id as never })).rejects.toMatchObject({ code: "system-archive-upload-restart-required", statusCode: 409 });
    expect((await pool.query("SELECT expires_at FROM system_archive_uploads WHERE id=$1", [id])).rows[0].expires_at).toEqual(before);
  });

  it("returns the effective 1 MiB chunk ceiling and durable resume index through owner-scoped APIs", async () => {
    const cap = 1024 * 1024;
    const policy = { ...historicalArchivePolicy("system"), chunkBytes: cap * 1.5, uploadTtlSeconds: 600 };
    const operation = await portableOperation("portable_staging");
    const original = createPostgresSystemArchiveUploadRepository(pool, { uploadTtlSeconds: 600, policy });
    const upload = await pool.query(`INSERT INTO system_archive_uploads(owner_user_id,handle_token_hash,filesystem_operation_id,byte_length,content_hash,expires_at,policy_snapshot) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '10 minutes',$6::jsonb) RETURNING id`, [owner.ownerUserId, hash(randomUUID()), operation.id, cap*2.5, hash("archive"), JSON.stringify(policy)]);
    const id = upload.rows[0].id;
    await original.recordChunk(owner, { uploadId: id, index: 6, offset: 0, bytes: cap*1.5, sha256: hash("prefix") });
    const api = createApiSystemArchiveComposition({ pool, config: { ...bootstrap(), systemArchiveChunkBytes: cap }, storage: { adapter: {} } as never });
    const resumed = await api.application.getUpload({ ownerUserId: owner.ownerUserId, uploadId: id });
    expect(resumed).toMatchObject({ chunkBytes: cap, nextChunkIndex: 7, receivedBytes: cap*1.5 });
    const foreign = (await pool.query("INSERT INTO users(display_name) VALUES('Foreign') RETURNING id")).rows[0].id;
    await expect(api.application.getUpload({ ownerUserId: foreign, uploadId: id })).rejects.toMatchObject({ statusCode: 404 });
    await pool.query("DELETE FROM users WHERE id=$1", [foreign]);
  });
  it("retires only an incompatible owner's preview and keeps unrelated work blocking replacement", async () => {
    const policy = historicalArchivePolicy("system"), issued = await preview(policy);
    const current = { ...policy, limits: { ...policy.limits, maxEntries: policy.limits.maxEntries-1 } };
    const imports = createPostgresSystemArchiveImportRepository(pool, current);
    const foreign = (await pool.query("INSERT INTO users(display_name) VALUES('Foreign') RETURNING id")).rows[0].id;
    await expect(imports.consumePreviewAuthority({ ownerUserId: foreign }, issued.previewHandle, "wrong-owner")).rejects.toMatchObject({ statusCode: 409 });
    await pool.query("DELETE FROM users WHERE id=$1", [foreign]);
    expect((await pool.query("SELECT status FROM system_archive_jobs WHERE id=$1", [issued.jobId])).rows[0].status).toBe("previewed");
    await expect(imports.consumePreviewAuthority(owner, issued.previewHandle, "changed-policy")).rejects.toMatchObject({ code: "archive-preview-stale" });
    const unrelated = (await pool.query("INSERT INTO system_archive_jobs(owner_user_id,kind,status,idempotency_key_hash) VALUES($1,'export','queued',$2) RETURNING id", [owner.ownerUserId, hash(randomUUID())])).rows[0].id;
    await expect(preview(current, issued.uploadId)).rejects.toMatchObject({ statusCode: 409 });
    expect((await pool.query("SELECT status FROM system_archive_jobs WHERE id=$1", [unrelated])).rows[0].status).toBe("queued");
    await pool.query("DELETE FROM system_archive_jobs WHERE id=$1", [unrelated]);
    const fresh = await preview(current, issued.uploadId);
    expect(fresh.jobId).not.toBe(issued.jobId);
  });

  it.each(["created", "uploading"])("cancels owner-scoped %s uploads through the production API projection", async (status) => {
    const cap = 1024 * 1024, policy = { ...historicalArchivePolicy("system"), chunkBytes: cap, uploadTtlSeconds: 600 };
    const operation = await portableOperation("portable_staging");
    const id = (await pool.query("INSERT INTO system_archive_uploads(owner_user_id,handle_token_hash,filesystem_operation_id,byte_length,content_hash,expires_at,policy_snapshot) VALUES($1,$2,$3,4,$4,clock_timestamp()+interval '10 minutes',$5::jsonb) RETURNING id", [owner.ownerUserId, hash(randomUUID()), operation.id, hash("abcd"), JSON.stringify(policy)])).rows[0].id;
    const uploads = createPostgresSystemArchiveUploadRepository(pool, { uploadTtlSeconds: 600, policy });
    if (status === "uploading") await uploads.recordChunk(owner, { uploadId: id, index: 3, offset: 0, bytes: 2, sha256: hash("ab") });
    const before = (await pool.query("SELECT expires_at FROM system_archive_uploads WHERE id=$1", [id])).rows[0].expires_at;
    const api = createApiSystemArchiveComposition({ pool, config: { ...bootstrap(), systemArchiveChunkBytes: cap }, storage: { adapter: {} } as never });
    const foreign = (await pool.query("INSERT INTO users(display_name) VALUES('Foreign cancel') RETURNING id")).rows[0].id;
    try {
      await expect(api.application.cancelUpload({ ownerUserId: foreign, uploadId: id })).rejects.toMatchObject({ statusCode: 404 });
      expect((await pool.query("SELECT status,expires_at FROM system_archive_uploads WHERE id=$1", [id])).rows[0]).toEqual({ status, expires_at: before });
      const cancelled = await api.application.cancelUpload({ ownerUserId: owner.ownerUserId, uploadId: id });
      expect(cancelled).toMatchObject({ id, status: "expired", receivedBytes: status === "uploading" ? 2 : 0, chunkBytes: cap, nextChunkIndex: status === "uploading" ? 4 : 0 });
      expect(new Date(cancelled.expiresAt).getTime()).toBeLessThanOrEqual(Date.now());
      expect((await pool.query("SELECT expires_at<=clock_timestamp() AS expired FROM durable_filesystem_operations WHERE id=$1", [operation.id])).rows[0].expired).toBe(true);
      await expect(api.application.cancelUpload({ ownerUserId: owner.ownerUserId, uploadId: id })).rejects.toMatchObject({ statusCode: 409 });
      await expect(api.application.cancelUpload({ ownerUserId: owner.ownerUserId, uploadId: randomUUID() as never })).rejects.toMatchObject({ statusCode: 404 });
    } finally { await pool.query("DELETE FROM users WHERE id=$1", [foreign]); }
  });
  it("continues a sparse upload after its first chunk uses the maximum PostgreSQL index", async () => {
    const policy = { ...historicalArchivePolicy("system"), uploadTtlSeconds: 600 };
    const operation = await portableOperation("portable_staging");
    const id = (await pool.query("INSERT INTO system_archive_uploads(owner_user_id,handle_token_hash,filesystem_operation_id,byte_length,content_hash,expires_at,policy_snapshot) VALUES($1,$2,$3,4,$4,clock_timestamp()+interval '10 minutes',$5::jsonb) RETURNING id", [owner.ownerUserId, hash(randomUUID()), operation.id, hash("abcd"), JSON.stringify(policy)])).rows[0].id;
    const uploads = createPostgresSystemArchiveUploadRepository(pool, { uploadTtlSeconds: 600, policy });
    const first = { uploadId: id, index: 2147483647, offset: 0, bytes: 2, sha256: hash("ab") };
    const recorded = await uploads.recordChunk(owner, first);
    expect(recorded.nextChunkIndex).toBe(0);
    expect((await uploads.getUpload(owner, id)).nextChunkIndex).toBe(0);
    expect((await uploads.reconcileChunk(owner, first))?.nextChunkIndex).toBe(0);
    const continued = await uploads.recordChunk(owner, { uploadId: id, index: recorded.nextChunkIndex!, offset: 2, bytes: 2, sha256: hash("cd") });
    expect(continued).toMatchObject({ receivedBytes: 4, nextChunkIndex: 1 });
    expect((await uploads.getAssembly(owner, id)).chunks.map(chunk => chunk.index)).toEqual([2147483647, 0]);
    const staged = (await pool.query("INSERT INTO portable_staged_inputs(owner_user_id,handle_token_hash,filesystem_operation_id,content_hash,byte_length,expires_at) VALUES($1,$2,$3,$4,4,clock_timestamp()+interval '1 day') RETURNING id", [owner.ownerUserId, hash(randomUUID()), operation.id, hash("abcd")])).rows[0].id;
    const completion = { uploadId: id, stagedInputId: staged };
    expect(await uploads.completeUpload(owner, completion)).toMatchObject({ status: "completed", receivedBytes: 4, nextChunkIndex: 1 });
    expect(await uploads.reconcileCompletion(owner, completion)).toMatchObject({ status: "completed", receivedBytes: 4, nextChunkIndex: 1 });
  });

});
