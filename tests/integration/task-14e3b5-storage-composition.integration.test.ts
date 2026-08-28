import { createHash } from "node:crypto";
import { closeSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readlink,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bindPrivateFilesystemCandidateAttachment } from "../../packages/application/src/assets/private-filesystem-repository.js";
import {
  bindLegacyPathV1PreviewDescriptor,
  bindPrivateBoundedStreamLimits,
  bindPrivatePrewriteNodeAuthority,
  bindPrivatePrewriteTargetAuthority
} from "../../packages/application/src/assets/private-secure-storage.js";
import type {
  AssetPublicationCandidate,
  AttachedFilesystemOperation,
  DurableFilesystemRecoveryClaim,
  PrivateStorageDescriptor,
  ReservedFilesystemOperation
} from "../../packages/application/src/assets/private-storage-lifecycle.js";
import { bindPrivateAtomicStagedIssuance, type PortableExportScope } from "../../packages/application/src/imports/private-portable-authority.js";
import type { PortableArchiveExportRetrieval } from "../../packages/application/src/imports/types.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  createDatabasePool,
  initialOwnerId,
  withTransaction,
  type DatabasePool
} from "../../packages/database/src/pool.js";
import {
  createAssetImportStorageComposition,
  type AssetImportStorageComposition
} from "../../services/runtime/src/asset-import-composition.js";
import { supportsSecureGeneratedArchiveStaging } from "../../services/api/src/archive-io.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl && supportsSecureGeneratedArchiveStaging() ? describe : describe.skip;

type WorldScope = Readonly<{
  campaignId: string;
  worldId: string;
  worldVersionId: string;
}>;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const values: Uint8Array[] = [];
  for await (const value of chunks) values.push(value);
  return Buffer.concat(values.map((value) => Buffer.from(value)));
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMilliseconds = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("condition_timeout");
    await new Promise<void>((done) => setTimeout(done, 10));
  }
}

async function descriptor(root: string, relativePath: string, bytes: Uint8Array): Promise<PrivateStorageDescriptor> {
  const value = await stat(join(root, relativePath), { bigint: true });
  return {
    relativePath,
    identity: {
      deviceId: value.dev.toString(),
      fileId: value.ino.toString(),
      changeToken: `${value.mtimeNs}:${value.ctimeNs}`
    },
    contentHash: sha256(bytes),
    byteLength: bytes.byteLength
  };
}

async function openDescriptorCount(path: string): Promise<number> {
  const descriptors = await readdir("/proc/self/fd");
  const targets = await Promise.all(descriptors.map(
    (descriptor) => readlink(`/proc/self/fd/${descriptor}`).catch(() => ""),
  ));
  return targets.filter((target) => target === path || target === `${path} (deleted)`).length;
}

async function openDescriptorFor(path: string): Promise<number> {
  const descriptors = await readdir("/proc/self/fd");
  for (const descriptor of descriptors) {
    if (await readlink(`/proc/self/fd/${descriptor}`).catch(() => "") === path) {
      return Number(descriptor);
    }
  }
  throw new Error("open_descriptor_missing");
}

integration("Task 14e3b5 production storage composition (requires Linux descriptor anchors)", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  let world: WorldScope;
  let archiveRoot = "";
  let assetRoot = "";
  const compositions = new Set<AssetImportStorageComposition>();
  const temporaryRoots = new Set<string>();

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 10);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    archiveRoot = await mkdtemp(join(tmpdir(), "iqn-b5-archive-"));
    assetRoot = await mkdtemp(join(tmpdir(), "iqn-b5-assets-"));
    temporaryRoots.add(archiveRoot);
    temporaryRoots.add(assetRoot);
    await mkdir(join(assetRoot, "assets"));
    const createdWorld = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title) VALUES ($1,$2) RETURNING id",
      [ownerUserId, `b5-${crypto.randomUUID()}`],
    );
    const worldId = createdWorld.rows[0]!.id;
    const createdVersion = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id,owner_user_id,version_number,content)
       VALUES ($1,$2,1,'{}'::jsonb) RETURNING id`,
      [worldId, ownerUserId],
    );
    const worldVersionId = createdVersion.rows[0]!.id;
    const createdCampaign = await pool.query<{ id: string }>(
      `INSERT INTO campaigns (owner_user_id,world_version_id,title)
       VALUES ($1,$2,'b5') RETURNING id`,
      [ownerUserId, worldVersionId],
    );
    world = { worldId, worldVersionId, campaignId: createdCampaign.rows[0]!.id };
  });

  afterEach(async () => {
    await Promise.all([...compositions].map((composition) => composition.close().catch(() => undefined)));
    compositions.clear();
  });

  afterAll(async () => {
    await pool.end();
    for (const root of temporaryRoots) await rm(root, { recursive: true, force: true });
  });

  async function compose(
    roots: Readonly<{ archiveRoot: string; assetRoot: string }> = { archiveRoot, assetRoot },
  ): Promise<AssetImportStorageComposition> {
    const composition = await createAssetImportStorageComposition(pool, roots);
    compositions.add(composition);
    return composition;
  }

  function exportScope(): PortableExportScope {
    return {
      ownerUserId,
      exportKind: "campaign_zip",
      campaignId: world.campaignId,
      worldId: world.worldId,
      worldVersionId: world.worldVersionId
    };
  }

  function streamLimits(maximumBytes = 8_192, deadlineMilliseconds = 10_000) {
    return bindPrivateBoundedStreamLimits({
      maximumBytes,
      chunkBytes: Math.min(7, maximumBytes),
      deadlineAt: new Date(Date.now() + deadlineMilliseconds).toISOString()
    });
  }

  async function publishExport(
    composition: AssetImportStorageComposition,
    bytes: Buffer,
    expiresAt = new Date(Date.now() + 60_000).toISOString(),
  ) {
    const scope = exportScope();
    const issued = await composition.adapter.publishPortableExport({
      exportScope: scope,
      operationScopeId: `b5-export:${crypto.randomUUID()}`,
      leaseOwner: "b5-export",
      expiresAt,
      contentType: "application/zip",
      byteLength: bytes.byteLength,
      source: [bytes]
    });
    return { ...issued, scope };
  }

  async function exportRow(retrieval: PortableArchiveExportRetrieval): Promise<Readonly<{
    status: string;
    relativePath: string;
    retrievalTokenHash: string;
    contentType: string;
  }>> {
    const selected = await pool.query<{
      status: string;
      relative_path: string;
      retrieval_token_hash: string;
      content_type: string;
    }>(
      `SELECT artifact.status,descriptor.relative_path,
              artifact.retrieval_token_hash,artifact.content_type
         FROM portable_export_artifacts artifact
         JOIN durable_filesystem_descriptors descriptor
           ON descriptor.operation_id=artifact.filesystem_operation_id
          AND descriptor.descriptor_role='delivery'
        WHERE artifact.retrieval_token_hash=$1`,
      [sha256(retrieval)],
    );
    const row = selected.rows[0]!;
    return {
      status: row.status,
      relativePath: row.relative_path,
      retrievalTokenHash: row.retrieval_token_hash,
      contentType: row.content_type
    };
  }

  async function waitForDatabaseExpiry(expiresAt: string): Promise<void> {
    await pool.query(
      `SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.05)`,
      [expiresAt],
    );
  }

  it("returns only the frozen private graph, closes idempotently, and cleans a partial construction", async () => {
    const composition = await compose();
    expect(Object.isFrozen(composition)).toBe(true);
    expect(Object.keys(composition).sort()).toEqual([
      "adapter",
      "atomicPortable",
      "candidate",
      "close",
      "expiryRecovery",
      "finalizedDelivery",
      "journal",
      "portable",
      "prewrite"
    ]);
    expect(composition.atomicPortable).toBe(composition.prewrite);
    expect(composition.atomicPortable).toBe(composition.expiryRecovery);
    const firstClose = composition.close();
    const secondClose = composition.close();
    expect(firstClose).toBe(secondClose);
    await firstClose;
    await expect(composition.adapter.stagePortableInput({
      owner: { ownerUserId },
      operationScopeId: `closed:${crypto.randomUUID()}`,
      leaseOwner: "b5-closed",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      byteLength: 1,
      source: [Buffer.from("x")]
    })).rejects.toThrow("filesystem_adapter_closed");

    const constructionArchiveRoot = await mkdtemp(join(tmpdir(), "iqn-b5-construction-"));
    temporaryRoots.add(constructionArchiveRoot);
    const before = await openDescriptorCount(constructionArchiveRoot);
    await expect(createAssetImportStorageComposition(pool, {
      archiveRoot: constructionArchiveRoot,
      assetRoot: join(constructionArchiveRoot, "missing")
    })).rejects.toThrow();
    expect(await openDescriptorCount(constructionArchiveRoot)).toBe(before);
  });

  it("uses a real caller transaction for candidate attachment, rollback, fencing, and hash-only restart", async () => {
    const composition = await compose();
    const bytes = Buffer.from("b5 staged bytes");
    const staged = await composition.adapter.stagePortableInput({
      owner: { ownerUserId },
      operationScopeId: `b5-stage:${crypto.randomUUID()}`,
      leaseOwner: "b5-stage",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      byteLength: bytes.byteLength,
      source: [bytes]
    });
    const stored = await pool.query<{
      handle_token_hash: string;
      candidate_token_hash: string;
      lifecycle: string;
      status: string;
    }>(
      `SELECT staged.handle_token_hash,candidate.candidate_token_hash,
              operation.lifecycle,staged.status
         FROM portable_staged_inputs staged
         JOIN durable_filesystem_operations operation ON operation.id=staged.filesystem_operation_id
         JOIN durable_filesystem_candidate_authorities candidate ON candidate.operation_id=operation.id
        WHERE operation.id=$1`,
      [staged.operation.operationId],
    );
    expect(stored.rows[0]).toMatchObject({ lifecycle: "finalized", status: "staged" });
    expect(stored.rows[0]!.handle_token_hash).toBe(sha256(staged.stagedInput));
    expect(stored.rows[0]!.handle_token_hash).not.toBe(staged.stagedInput);
    expect(stored.rows[0]!.candidate_token_hash).toMatch(/^[0-9a-f]{64}$/u);

    await composition.close();
    compositions.delete(composition);
    const restarted = await compose();
    await expect(restarted.portable.rehydrateStagedInput(
      { ownerUserId },
      staged.stagedInput,
      { leaseOwner: "b5-restart", leaseSeconds: 30 },
    )).resolves.toMatchObject({
      identity: { ownerUserId, stagedInput: staged.stagedInput },
      operation: { operationId: staged.operation.operationId }
    });
    await expect(restarted.portable.rehydrateStagedInput(
      { ownerUserId: crypto.randomUUID() },
      staged.stagedInput,
      { leaseOwner: "b5-foreign", leaseSeconds: 30 },
    )).resolves.toBeNull();

    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const reserved = await restarted.journal.reserve(
      { resourceKind: "portable", ownerUserId, operationScopeId: `b5-rollback:${crypto.randomUUID()}` },
      { purpose: "portable_staging", leaseOwner: "b5-rollback", expiresAt },
    );
    await mkdir(join(archiveRoot, "staging"), { recursive: true });
    const relativePath = `staging/${reserved.operation.operationId}.pending`;
    await writeFile(join(archiveRoot, relativePath), bytes, { flag: "wx", mode: 0o600 });
    const value = await descriptor(archiveRoot, relativePath, bytes);
    const candidate = await restarted.candidate.issuePublicationCandidate(reserved.operation, {
      deliveryRelativePath: relativePath,
      cleanupDescriptors: [value]
    });
    await restarted.candidate.completePublicationCandidate(reserved.operation, candidate, value);
    const attachment = bindPrivateFilesystemCandidateAttachment(
      reserved.operation,
      candidate,
      value,
      reserved.claim,
    );
    const issuance = bindPrivateAtomicStagedIssuance({ ownerUserId }, attachment);
    await expect(withTransaction(pool, async (client) => {
      await restarted.atomicPortable.issueStagedInput(client, issuance);
      throw new Error("b5-injected-rollback");
    })).rejects.toThrow("b5-injected-rollback");
    await expect(pool.query<{ lifecycle: string; count: string }>(
      `SELECT operation.lifecycle,
              (SELECT count(*)::text FROM portable_staged_inputs staged
                WHERE staged.filesystem_operation_id=operation.id) AS count
         FROM durable_filesystem_operations operation WHERE operation.id=$1`,
      [reserved.operation.operationId],
    )).resolves.toMatchObject({ rows: [{ lifecycle: "reserved", count: "0" }] });
    const issued = await withTransaction(
      pool,
      (client) => restarted.atomicPortable.issueStagedInput(client, issuance),
    );
    await expect(restarted.journal.finalizeAfterCommit(issued.operation, issued.claim))
      .resolves.toMatchObject({ outcome: "finalized" });
    await expect(withTransaction(pool, (client) => restarted.atomicPortable.issueStagedInput(client, issuance)))
      .rejects.toThrow();
  });

  it("holds a durable read lease across initial stage expiry so the reaper cannot close the active stream", async () => {
    const composition = await compose();
    const bytes = Buffer.from("active staged system archive bytes");
    const expiresAt = new Date(Date.now() + 1_500).toISOString();
    const staged = await composition.adapter.stagePortableScratch({
      owner: { ownerUserId },
      operationScopeId: `b5-active-stage:${crypto.randomUUID()}`,
      leaseOwner: "b5-active-stage-writer",
      expiresAt,
      maximumBytes: bytes.byteLength,
      source: [bytes]
    });
    const session = await composition.adapter.openStagedInputSession({
      owner: { ownerUserId },
      stagedInput: staged.stagedInput,
      claim: { leaseOwner: "b5-active-stage-reader", leaseSeconds: 1 },
      limits: bindPrivateBoundedStreamLimits({
        maximumBytes: bytes.byteLength,
        chunkBytes: 1,
        deadlineAt: new Date(Date.now() + 10_000).toISOString()
      })
    });
    const iterator = session.chunks[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first).toMatchObject({ done: false });

    await waitForDatabaseExpiry(expiresAt);
    await expect(composition.adapter.reapExpiredPortable({
      leaseOwner: "b5-active-stage-reaper",
      leaseSeconds: 1,
      limit: 10
    })).resolves.toEqual({ claimed: 0, cleaned: 0, pending: 0 });

    const read = [Buffer.from(first.value!)];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      read.push(Buffer.from(next.value));
    }
    expect(Buffer.concat(read)).toEqual(bytes);

    const lease = await pool.query<{ lease_expires_at: Date }>(
      "SELECT lease_expires_at FROM durable_filesystem_operations WHERE id=$1",
      [staged.operation.operationId],
    );
    await waitForDatabaseExpiry(lease.rows[0]!.lease_expires_at.toISOString());
    await expect(composition.adapter.reapExpiredPortable({
      leaseOwner: "b5-finished-stage-reaper",
      leaseSeconds: 1,
      limit: 10
    })).resolves.toEqual({ claimed: 1, cleaned: 1, pending: 0 });
  });

  it("fails a clock-skewed stalled reader closed after its last durable lease expires and a separate reaper wins", async () => {
    const reader = await compose();
    const reaper = await compose();
    const prototypeProbePath = join(archiveRoot, `.b5-read-spy-${crypto.randomUUID()}`);
    await writeFile(prototypeProbePath, "probe");
    const prototypeProbe = await open(prototypeProbePath);
    const fileHandlePrototype = Object.getPrototypeOf(prototypeProbe);
    await prototypeProbe.close();
    await unlink(prototypeProbePath);
    const bytes = Buffer.from("stalled staged reader must not outlive durable authority");
    const expiresAt = new Date(Date.now() + 1_500).toISOString();
    const staged = await reader.adapter.stagePortableScratch({
      owner: { ownerUserId },
      operationScopeId: `b5-stalled-stage:${crypto.randomUUID()}`,
      leaseOwner: "b5-stalled-stage-writer",
      expiresAt,
      maximumBytes: bytes.byteLength,
      source: [bytes]
    });

    const originalHeartbeat = reader.journal.heartbeatRecoveryClaim.bind(reader.journal);
    let heartbeatCalls = 0;
    let markHeartbeatStalled!: () => void;
    const heartbeatStalled = new Promise<void>((resolve) => { markHeartbeatStalled = resolve; });
    let releaseStalledHeartbeat!: (claim: DurableFilesystemRecoveryClaim | null) => void;
    const stalledHeartbeat = new Promise<DurableFilesystemRecoveryClaim | null>((resolve) => {
      releaseStalledHeartbeat = resolve;
    });
    vi.spyOn(reader.journal, "heartbeatRecoveryClaim").mockImplementation((claim, leaseSeconds) => {
      heartbeatCalls += 1;
      if (heartbeatCalls === 1) return originalHeartbeat(claim, leaseSeconds);
      markHeartbeatStalled();
      return stalledHeartbeat;
    });

    const session = await reader.adapter.openStagedInputSession({
      owner: { ownerUserId },
      stagedInput: staged.stagedInput,
      claim: { leaseOwner: "b5-stalled-stage-reader", leaseSeconds: 1 },
      limits: bindPrivateBoundedStreamLimits({
        maximumBytes: bytes.byteLength,
        chunkBytes: 1,
        deadlineAt: new Date(Date.now() + 10_000).toISOString()
      })
    });
    const iterator = session.chunks[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    await heartbeatStalled;

    const durableLease = await pool.query<{ lease_expires_at: Date }>(
      "SELECT lease_expires_at FROM durable_filesystem_operations WHERE id=$1",
      [staged.operation.operationId],
    );
    await waitForDatabaseExpiry(new Date(Math.max(
      Date.parse(expiresAt),
      durableLease.rows[0]!.lease_expires_at.getTime(),
    )).toISOString());
    await expect(reaper.adapter.reapExpiredPortable({
      leaseOwner: "b5-stalled-stage-reaper",
      leaseSeconds: 1,
      limit: 10
    })).resolves.toEqual({ claimed: 1, cleaned: 1, pending: 0 });

    const actualDateNow = Date.now.bind(Date);
    const laggingNodeClock = vi.spyOn(Date, "now")
      .mockImplementation(() => actualDateNow() - 60_000);
    const readAfterCleanup = vi.spyOn(fileHandlePrototype, "read");
    const releaseTimer = setTimeout(() => releaseStalledHeartbeat(null), 50);
    try {
      await expect(iterator.next()).rejects.toThrow("filesystem_stream_lease_lost");
      expect(readAfterCleanup).not.toHaveBeenCalled();
    } finally {
      clearTimeout(releaseTimer);
      releaseStalledHeartbeat(null);
      readAfterCleanup.mockRestore();
      laggingNodeClock.mockRestore();
      await session.finalize("abort").catch(() => undefined);
    }
  });

  it("persists exact export scope/content type and closes every terminal path with one cleanup", async () => {
    const composition = await compose();
    const terminals = ["eof", "close", "abort"] as const;
    for (const terminal of terminals) {
      const bytes = Buffer.from(`b5 export ${terminal}`);
      const exported = await publishExport(composition, bytes);
      const row = await exportRow(exported.retrieval);
      expect(row).toMatchObject({
        status: "ready",
        retrievalTokenHash: sha256(exported.retrieval),
        contentType: "application/zip"
      });
      const session = await composition.adapter.openExportSession({
        scope: exported.scope,
        retrieval: exported.retrieval,
        claim: { leaseOwner: `b5-${terminal}`, leaseSeconds: 30 },
        limits: streamLimits(bytes.byteLength + 64)
      });
      if (terminal === "eof") {
        await expect(collect(session.chunks)).resolves.toEqual(bytes);
      } else {
        await Promise.all([session.finalize(terminal), session.finalize(terminal)]);
      }
      await expect(stat(join(archiveRoot, row.relativePath))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(pool.query<{ status: string; lifecycle: string }>(
        `SELECT artifact.status,operation.lifecycle
           FROM portable_export_artifacts artifact
           JOIN durable_filesystem_operations operation ON operation.id=artifact.filesystem_operation_id
          WHERE artifact.retrieval_token_hash=$1`,
        [sha256(exported.retrieval)],
      )).resolves.toMatchObject({ rows: [{ status: "cleaned", lifecycle: "cleaned" }] });
      await expect(session.finalize("close")).resolves.toBeUndefined();
    }
  });

  it("finalizes injected pre-send and read failures in close-delete-ack order", async () => {
    const composition = await compose();
    for (const failure of ["pre_send_failure", "read_failure"] as const) {
      const bytes = Buffer.from(`b5 injected ${failure}`);
      const exported = await publishExport(composition, bytes);
      const row = await exportRow(exported.retrieval);
      const physicalPath = join(archiveRoot, row.relativePath);
      const session = await composition.adapter.openExportSession({
        scope: exported.scope,
        retrieval: exported.retrieval,
        claim: { leaseOwner: `b5-${failure}`, leaseSeconds: 30 },
        limits: streamLimits(1_024)
      });
      expect(await openDescriptorCount(physicalPath)).toBe(1);
      const streamDescriptor = await openDescriptorFor(physicalPath);
      const blocker = await pool.connect();
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT 1 FROM portable_export_artifacts WHERE retrieval_token_hash=$1 FOR UPDATE",
        [sha256(exported.retrieval)],
      );
      let injectedPreSendCalled = false;
      let terminalSettled = false;
      const terminal = (failure === "pre_send_failure"
        ? (async (send: (chunks: AsyncIterable<Uint8Array>) => Promise<never>) => {
          try {
            await send(session.chunks);
          } catch (error) {
            await session.finalize("pre_send_failure");
            throw error;
          }
          throw new Error("injected_pre_send_did_not_fail");
        })(async (chunks) => {
          injectedPreSendCalled = true;
          expect(chunks).toBe(session.chunks);
          throw new Error("injected_pre_send_failure");
        })
        : (async () => {
          closeSync(streamDescriptor);
          await collect(session.chunks);
        })())
        .then(
          () => ({ error: null as unknown }),
          (error: unknown) => ({ error }),
        )
        .finally(() => {
          terminalSettled = true;
        });
      try {
        await waitUntil(async () => stat(physicalPath).then(() => false, () => true));
        if (failure === "pre_send_failure") expect(injectedPreSendCalled).toBe(true);
        // Linux reports an unlinked-but-open descriptor as "<path> (deleted)".
        // Counting both forms proves close happened before unlink, not merely
        // that the pathname disappeared while the stream retained authority.
        expect(await openDescriptorCount(physicalPath)).toBe(0);
        expect(terminalSettled).toBe(false);
        await expect(pool.query<{ status: string; lifecycle: string }>(
          `SELECT artifact.status,operation.lifecycle
             FROM portable_export_artifacts artifact
             JOIN durable_filesystem_operations operation ON operation.id=artifact.filesystem_operation_id
            WHERE artifact.retrieval_token_hash=$1`,
          [sha256(exported.retrieval)],
        )).resolves.toMatchObject({
          rows: [{ status: "cleanup_pending", lifecycle: "cleanup_pending" }]
        });
      } finally {
        await blocker.query("COMMIT");
        blocker.release();
      }
      expect((await terminal).error).toBeInstanceOf(Error);
      expect(terminalSettled).toBe(true);
      await expect(pool.query<{ status: string; lifecycle: string }>(
        `SELECT artifact.status,operation.lifecycle
           FROM portable_export_artifacts artifact
           JOIN durable_filesystem_operations operation ON operation.id=artifact.filesystem_operation_id
          WHERE artifact.retrieval_token_hash=$1`,
        [sha256(exported.retrieval)],
      )).resolves.toMatchObject({ rows: [{ status: "cleaned", lifecycle: "cleaned" }] });
    }
  });

  it("autonomously times out exports and fails closed on stream growth, truncation, and hash faults", async () => {
    const composition = await compose();
    const timeoutBytes = Buffer.from("b5 timeout export");
    const timed = await publishExport(composition, timeoutBytes);
    const timedRow = await exportRow(timed.retrieval);
    const timedSession = await composition.adapter.openExportSession({
      scope: timed.scope,
      retrieval: timed.retrieval,
      claim: { leaseOwner: "b5-timeout", leaseSeconds: 30 },
      limits: streamLimits(1_024, 100)
    });
    await waitUntil(async () => {
      const selected = await pool.query<{ status: string }>(
        "SELECT status FROM portable_export_artifacts WHERE retrieval_token_hash=$1",
        [sha256(timed.retrieval)],
      );
      return selected.rows[0]?.status === "cleaned";
    });
    await expect(collect(timedSession.chunks)).rejects.toThrow("filesystem_stream_timeout");
    await expect(stat(join(archiveRoot, timedRow.relativePath))).rejects.toMatchObject({ code: "ENOENT" });

    for (const fault of ["truncate", "grow", "hash"] as const) {
      const bytes = Buffer.from(`b5 ${fault} stream bytes`);
      const exported = await publishExport(composition, bytes);
      const row = await exportRow(exported.retrieval);
      const physical = join(archiveRoot, row.relativePath);
      const session = await composition.adapter.openExportSession({
        scope: exported.scope,
        retrieval: exported.retrieval,
        claim: { leaseOwner: `b5-${fault}`, leaseSeconds: 30 },
        limits: streamLimits(1_024)
      });
      if (fault === "truncate") await truncate(physical, Math.max(0, bytes.byteLength - 2));
      if (fault === "grow") await writeFile(physical, Buffer.concat([bytes, Buffer.from("growth")]));
      if (fault === "hash") await writeFile(physical, Buffer.alloc(bytes.byteLength, 0x78));
      await expect(collect(session.chunks)).rejects.toThrow();
      const state = await pool.query<{ status: string }>(
        "SELECT status FROM portable_export_artifacts WHERE retrieval_token_hash=$1",
        [sha256(exported.retrieval)],
      );
      expect(state.rows[0]!.status).toBe("cleanup_pending");
    }
  });

  it("delivers durable and legacy assets across restart without reaping shared or preview bytes", async () => {
    const composition = await compose();
    const durableBytes = Buffer.from("b5 durable asset");
    const relativePath = `assets/${crypto.randomUUID()}.png`;
    await writeFile(join(assetRoot, relativePath), durableBytes, { flag: "wx", mode: 0o600 });
    const asset = await pool.query<{ id: string }>(
      `INSERT INTO assets (
         owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length
       ) VALUES ($1,$2,'filesystem',$3,'image/png',$4) RETURNING id`,
      [ownerUserId, sha256(durableBytes), relativePath, durableBytes.byteLength],
    );
    const assetId = asset.rows[0]!.id;
    const reserved = await composition.journal.reserve(
      { resourceKind: "asset", ownerUserId, assetId },
      {
        purpose: "asset_original",
        leaseOwner: "b5-asset",
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      },
    );
    const value = await descriptor(assetRoot, relativePath, durableBytes);
    const candidate = await composition.candidate.issuePublicationCandidate(reserved.operation, {
      deliveryRelativePath: relativePath,
      cleanupDescriptors: [value]
    });
    await composition.candidate.completePublicationCandidate(reserved.operation, candidate, value);
    const attachment = bindPrivateFilesystemCandidateAttachment(
      reserved.operation,
      candidate,
      value,
      reserved.claim,
    );
    const attached = await withTransaction(pool, async (client) => {
      await client.query("UPDATE assets SET filesystem_operation_id=$2 WHERE id=$1", [assetId, reserved.operation.operationId]);
      return composition.candidate.attachCandidate(client, attachment);
    });
    expect(attached.outcome).toBe("attached");
    if (attached.outcome !== "attached") throw new Error("b5_asset_attach_failed");
    await expect(composition.journal.finalizeAfterCommit(attached.operation, attached.claim))
      .resolves.toMatchObject({ outcome: "finalized" });

    const grant = await composition.finalizedDelivery.resolveFinalizedAssetDelivery(
      { ownerUserId, assetId },
      { kind: "original" },
    );
    expect(grant?.kind).toBe("durable_finalized");
    if (!grant || grant.kind !== "durable_finalized") throw new Error("b5_delivery_grant_missing");
    await expect(composition.finalizedDelivery.redeemFinalizedDeliveryGrant(
      { ownerUserId: crypto.randomUUID(), assetId },
      { kind: "original" },
      grant.grant,
    )).resolves.toBeNull();
    await expect(composition.finalizedDelivery.redeemFinalizedDeliveryGrant(
      { ownerUserId, assetId },
      { kind: "original" },
      grant.grant,
    )).resolves.toMatchObject({ relativePath, contentHash: sha256(durableBytes) });
    await expect(composition.finalizedDelivery.redeemFinalizedDeliveryGrant(
      { ownerUserId, assetId },
      { kind: "original" },
      grant.grant,
    )).resolves.toBeNull();

    await composition.close();
    compositions.delete(composition);
    const restarted = await compose();
    const durableSession = await restarted.adapter.openAssetSession({
      scope: { ownerUserId, assetId },
      request: { kind: "original" },
      limits: streamLimits(1_024)
    });
    expect(durableSession).not.toBeNull();
    await expect(collect(durableSession!.chunks)).resolves.toEqual(durableBytes);
    await expect(stat(join(assetRoot, relativePath))).resolves.toBeTruthy();

    const sharedOwner = await pool.query<{ id: string }>(
      "INSERT INTO users (system_key,display_name) VALUES ($1,'b5 shared owner') RETURNING id",
      [`b5-shared-${crypto.randomUUID()}`],
    );
    const sharedAsset = await pool.query<{ id: string }>(
      `INSERT INTO assets (
         owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length
       ) VALUES ($1,$2,'filesystem',$3,'image/png',$4) RETURNING id`,
      [sharedOwner.rows[0]!.id, sha256(durableBytes), relativePath, durableBytes.byteLength],
    );
    const retainedOriginalSession = await restarted.adapter.openAssetSession({
      scope: { ownerUserId, assetId },
      request: { kind: "original" },
      limits: streamLimits(1_024)
    });
    const timedSharedSession = await restarted.adapter.openAssetSession({
      scope: { ownerUserId: sharedOwner.rows[0]!.id, assetId: sharedAsset.rows[0]!.id },
      request: { kind: "original" },
      limits: streamLimits(1_024, 250)
    });
    expect(retainedOriginalSession).not.toBeNull();
    expect(timedSharedSession).not.toBeNull();
    expect(await openDescriptorCount(join(assetRoot, relativePath))).toBe(2);
    await waitUntil(async () => (await openDescriptorCount(join(assetRoot, relativePath))) === 1);
    await expect(collect(timedSharedSession!.chunks)).rejects.toThrow("filesystem_stream_timeout");
    await expect(stat(join(assetRoot, relativePath))).resolves.toBeTruthy();
    await expect(collect(retainedOriginalSession!.chunks)).resolves.toEqual(durableBytes);
    await expect(pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM assets
        WHERE storage_path=$1 AND content_hash=$2`,
      [relativePath, sha256(durableBytes)],
    )).resolves.toMatchObject({ rows: [{ count: "2" }] });
    await expect(stat(join(assetRoot, relativePath))).resolves.toBeTruthy();

    const legacyBytes = Buffer.from("b5 retained legacy asset");
    const legacyPath = `assets/${crypto.randomUUID()}.png`;
    await writeFile(join(assetRoot, legacyPath), legacyBytes, { flag: "wx", mode: 0o600 });
    const legacyAsset = await pool.query<{ id: string }>(
      `INSERT INTO assets (
         owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length
       ) VALUES ($1,$2,'filesystem',$3,'image/png',$4) RETURNING id`,
      [ownerUserId, sha256(legacyBytes), legacyPath, legacyBytes.byteLength],
    );
    const legacySession = await restarted.adapter.openAssetSession({
      scope: { ownerUserId, assetId: legacyAsset.rows[0]!.id },
      request: { kind: "original" },
      limits: streamLimits(1_024)
    });
    expect(legacySession).not.toBeNull();
    await expect(collect(legacySession!.chunks)).resolves.toEqual(legacyBytes);
    await expect(stat(join(assetRoot, legacyPath))).resolves.toBeTruthy();

    await mkdir(join(archiveRoot, "legacy"), { recursive: true });
    const previewBytes = Buffer.from("b5 server-bound legacy preview");
    const previewPath = `legacy/${crypto.randomUUID()}.zip`;
    await writeFile(join(archiveRoot, previewPath), previewBytes, { flag: "wx", mode: 0o600 });
    const preview = await restarted.adapter.openLegacyPathV1Preview({
      descriptor: bindLegacyPathV1PreviewDescriptor({
        relativePath: previewPath,
        contentType: "application/zip",
        contentHash: sha256(previewBytes),
        byteLength: previewBytes.byteLength
      }),
      limits: streamLimits(1_024)
    });
    await expect(collect(preview.chunks)).resolves.toEqual(previewBytes);
    await restarted.adapter.reapExpiredPortable({ leaseOwner: "b5-preview-reaper", leaseSeconds: 1, limit: 10 });
    await expect(stat(join(archiveRoot, previewPath))).resolves.toBeTruthy();
  });

  it("recovers expired portable and prewrite nodes, retries identity races, and anchors the opened root", async () => {
    const composition = await compose();
    const exported = await publishExport(
      composition,
      Buffer.from("b5 expired export"),
      new Date(Date.now() + 1_500).toISOString(),
    );
    const exportExpiresAt = await pool.query<{ expires_at: Date }>(
      "SELECT expires_at FROM durable_filesystem_operations WHERE id=$1",
      [exported.operation.operationId],
    );
    await waitForDatabaseExpiry(exportExpiresAt.rows[0]!.expires_at.toISOString());
    const recoveredExport = await composition.adapter.reapExpiredPortable({
      leaseOwner: "b5-export-recovery",
      leaseSeconds: 1,
      limit: 100
    });
    expect(recoveredExport.claimed).toBeGreaterThanOrEqual(1);
    expect((await exportRow(exported.retrieval)).status).toBe("cleaned");

    const expiresAt = new Date(Date.now() + 1_500).toISOString();
    const reserved = await composition.journal.reserve(
      { resourceKind: "portable", ownerUserId, operationScopeId: `b5-prewrite:${crypto.randomUUID()}` },
      { purpose: "portable_staging", leaseOwner: "b5-prewrite", expiresAt },
    );
    await mkdir(join(archiveRoot, "staging"), { recursive: true });
    const relativePath = `staging/${reserved.operation.operationId}.pending`;
    const physicalPath = join(archiveRoot, relativePath);
    const originalBytes = Buffer.from("b5 prewrite original");
    await composition.prewrite.recordPrewriteTarget(
      bindPrivatePrewriteTargetAuthority(reserved.operation, relativePath),
    );
    await writeFile(physicalPath, originalBytes, { flag: "wx", mode: 0o600 });
    const original = await stat(physicalPath, { bigint: true });
    await composition.prewrite.recordPrewriteNode(bindPrivatePrewriteNodeAuthority(
      reserved.operation,
      relativePath,
      { deviceId: original.dev.toString(), fileId: original.ino.toString() },
    ));
    const savedPath = `${physicalPath}.saved`;
    await rename(physicalPath, savedPath);
    await writeFile(physicalPath, Buffer.from("substitution"), { flag: "wx", mode: 0o600 });
    await waitForDatabaseExpiry(expiresAt);
    const firstRecovery = await composition.adapter.reapExpiredPortable({
      leaseOwner: "b5-prewrite-recovery-1",
      leaseSeconds: 1,
      limit: 100
    });
    expect(firstRecovery.pending).toBeGreaterThanOrEqual(1);
    await unlink(physicalPath);
    await rename(savedPath, physicalPath);
    await pool.query("SELECT pg_sleep(1.05)");
    const secondRecovery = await composition.adapter.reapExpiredPortable({
      leaseOwner: "b5-prewrite-recovery-2",
      leaseSeconds: 1,
      limit: 100
    });
    expect(secondRecovery.cleaned).toBeGreaterThanOrEqual(1);
    await expect(stat(physicalPath)).rejects.toMatchObject({ code: "ENOENT" });

    const anchoredArchiveRoot = await mkdtemp(join(tmpdir(), "iqn-b5-anchor-"));
    const anchoredAssetRoot = await mkdtemp(join(tmpdir(), "iqn-b5-anchor-assets-"));
    temporaryRoots.add(anchoredArchiveRoot);
    temporaryRoots.add(anchoredAssetRoot);
    await mkdir(join(anchoredArchiveRoot, "legacy"));
    const trusted = Buffer.from("b5 trusted anchored bytes");
    await writeFile(join(anchoredArchiveRoot, "legacy/preview.zip"), trusted);
    const anchored = await compose({ archiveRoot: anchoredArchiveRoot, assetRoot: anchoredAssetRoot });
    const movedRoot = `${anchoredArchiveRoot}-moved`;
    temporaryRoots.add(movedRoot);
    await rename(anchoredArchiveRoot, movedRoot);
    await mkdir(join(anchoredArchiveRoot, "legacy"), { recursive: true });
    await writeFile(join(anchoredArchiveRoot, "legacy/preview.zip"), Buffer.from("hostile replacement"));
    const anchoredSession = await anchored.adapter.openLegacyPathV1Preview({
      descriptor: bindLegacyPathV1PreviewDescriptor({
        relativePath: "legacy/preview.zip",
        contentType: "application/zip",
        contentHash: sha256(trusted),
        byteLength: trusted.byteLength
      }),
      limits: streamLimits(1_024)
    });
    await expect(collect(anchoredSession.chunks)).resolves.toEqual(trusted);

    const symlinkArchiveRoot = await mkdtemp(join(tmpdir(), "iqn-b5-symlink-"));
    const symlinkAssetRoot = await mkdtemp(join(tmpdir(), "iqn-b5-symlink-assets-"));
    const outside = await mkdtemp(join(tmpdir(), "iqn-b5-outside-"));
    temporaryRoots.add(symlinkArchiveRoot);
    temporaryRoots.add(symlinkAssetRoot);
    temporaryRoots.add(outside);
    await writeFile(join(outside, "preview.zip"), trusted);
    await symlink(outside, join(symlinkArchiveRoot, "legacy"), "dir");
    const symlinked = await compose({ archiveRoot: symlinkArchiveRoot, assetRoot: symlinkAssetRoot });
    await expect(symlinked.adapter.openLegacyPathV1Preview({
      descriptor: bindLegacyPathV1PreviewDescriptor({
        relativePath: "legacy/preview.zip",
        contentType: "application/zip",
        contentHash: sha256(trusted),
        byteLength: trusted.byteLength
      }),
      limits: streamLimits(1_024)
    })).rejects.toThrow();
  });
});
