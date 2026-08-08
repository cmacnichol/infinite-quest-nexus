import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, open, readdir, readlink, rename, stat, symlink, truncate, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  AssetPublicationCandidate,
  AttachedFilesystemOperation,
  DurableFilesystemRecoveryClaim,
  DurableFilesystemOperationId,
  PrivateStorageDescriptor,
  ReservedFilesystemOperation
} from "../../packages/application/src/assets/private-storage-lifecycle.js";
import type { AssetScope } from "../../packages/application/src/assets/types.js";
import { bindPrivateBoundedStreamLimits } from "../../packages/application/src/assets/private-secure-storage.js";
import type {
  PrivatePortableExportCleanupPreparation,
  PrivatePortableExportRehydration,
  PrivatePortableRepositoryPort
} from "../../packages/application/src/imports/private-portable-repository.js";
import type { PortableExportScope } from "../../packages/application/src/imports/private-portable-authority.js";
import type { PortableArchiveExportRetrieval } from "../../packages/application/src/imports/types.js";
import {
  bindLegacyPathV1PreviewDescriptor,
  createSecureFilesystemAdapter
} from "../../services/api/src/portable-archive-filesystem-adapter.js";

const FUTURE = new Date(Date.now() + 60_000).toISOString();

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function descriptor(root: string, relativePath: string, content: Uint8Array): Promise<PrivateStorageDescriptor> {
  const value = await stat(join(root, relativePath), { bigint: true });
  return {
    relativePath,
    identity: {
      deviceId: value.dev.toString(),
      fileId: value.ino.toString(),
      changeToken: `${value.mtimeNs}:${value.ctimeNs}`
    },
    contentHash: sha256(content),
    byteLength: content.byteLength
  };
}

function attachedOperation(scope: PortableExportScope): AttachedFilesystemOperation {
  return {
    resourceKind: "portable",
    ownerUserId: scope.ownerUserId,
    operationScopeId: "export-scope-1",
    operationId: "operation-1",
    purpose: "portable_export"
  } as AttachedFilesystemOperation;
}

function claim(operation: AttachedFilesystemOperation): DurableFilesystemRecoveryClaim {
  return {
    operationId: operation.operationId,
    leaseId: "lease-1",
    leaseOwner: "api-1",
    workVersion: 2,
    leaseExpiresAt: FUTURE
  } as DurableFilesystemRecoveryClaim;
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const values: Uint8Array[] = [];
  for await (const chunk of chunks) values.push(chunk);
  return Buffer.concat(values.map((value) => Buffer.from(value)));
}

function unsupported(): never {
  throw new Error("unexpected_port_call");
}

async function hasOpenDescriptorFor(path: string): Promise<boolean> {
  const descriptors = await readdir("/proc/self/fd");
  const targets = await Promise.all(descriptors.map(
    (value) => readlink(`/proc/self/fd/${value}`).catch(() => ""),
  ));
  return targets.some((value) => value === path || value === `${path} (deleted)`);
}

async function timeoutExportFixture(input: Readonly<{
  deadlineAt: string;
  contentHash?: string;
  chunkBytes?: number;
}>) {
  const archiveRoot = await mkdtemp(join(tmpdir(), "iqn-b4-timeout-export-"));
  const assetRoot = await mkdtemp(join(tmpdir(), "iqn-b4-assets-"));
  await mkdir(join(archiveRoot, "exports"));
  const content = Buffer.from("autonomous timeout export bytes");
  const relativePath = "exports/operation-1.pending";
  const physicalPath = join(archiveRoot, relativePath);
  await writeFile(physicalPath, content);
  const expected = {
    ...await descriptor(archiveRoot, relativePath, content),
    contentHash: input.contentHash ?? sha256(content)
  };
  const scope: PortableExportScope = {
    ownerUserId: "owner-1",
    exportKind: "campaign_zip",
    campaignId: "campaign-1",
    worldId: "world-1",
    worldVersionId: "version-1"
  };
  const retrieval = "retrieval-timeout" as PortableArchiveExportRetrieval;
  const operation = attachedOperation(scope);
  const recoveryClaim = claim(operation);
  const rehydration = {
    identity: { exportScope: scope, retrieval, contentType: "application/zip" },
    operation,
    claim: recoveryClaim,
    descriptor: expected
  } as PrivatePortableExportRehydration;
  const preparation = {
    outcome: "cleanup_required",
    identity: {
      portableKind: "export_artifact",
      artifactId: "artifact-timeout",
      ownerUserId: scope.ownerUserId,
      filesystemOperationId: operation.operationId,
      exportScope: scope
    },
    operation,
    claim: recoveryClaim,
    descriptors: [expected]
  } as unknown as PrivatePortableExportCleanupPreparation;
  const events: string[] = [];
  const acknowledge = vi.fn(async () => {
    events.push("ack");
    expect(await hasOpenDescriptorFor(physicalPath)).toBe(false);
    await expect(stat(physicalPath)).rejects.toMatchObject({ code: "ENOENT" });
    return { outcome: "cleaned" as const };
  });
  const adapter = await createSecureFilesystemAdapter({
    archiveRoot,
    assetRoot,
    platform: "linux",
    portable: {
      async rehydrateExportArtifact() { return rehydration; },
      async prepareExportCleanup() { return preparation; },
      acknowledgeExportCleanup: acknowledge,
      rehydrateStagedInput: unsupported,
      prepareStagedCleanup: unsupported,
      acknowledgeStagedCleanup: unsupported,
      prepareRecoveryCleanup: unsupported
    },
    transactions: { async run(work) { return work({}); } }
  });
  const session = await adapter.openExportSession({
    scope,
    retrieval,
    claim: { leaseOwner: "api-timeout", leaseSeconds: 30 },
    limits: bindPrivateBoundedStreamLimits({
      maximumBytes: 1024,
      chunkBytes: input.chunkBytes ?? 4,
      deadlineAt: input.deadlineAt
    })
  });
  return { acknowledge, adapter, content, events, physicalPath, session };
}

describe("Task 14e3b4 secure filesystem adapter", () => {
  it("records durable target intent before O_EXCL and binds node identity before writing staged bytes", async () => {
    const archiveRoot = await mkdtemp(join(tmpdir(), "iqn-b4-stage-"));
    const assetRoot = await mkdtemp(join(tmpdir(), "iqn-b4-assets-"));
    const content = Buffer.from("staged archive bytes");
    const operationId = "11111111-1111-4111-8111-111111111111" as DurableFilesystemOperationId;
    const reservation = {
      resourceKind: "portable",
      ownerUserId: "owner-1",
      operationScopeId: "stage-scope-1",
      operationId,
      purpose: "portable_staging",
      expiresAt: FUTURE
    } as ReservedFilesystemOperation;
    const recoveryClaim = {
      operationId,
      leaseId: "lease-stage",
      leaseOwner: "api-1",
      workVersion: 1,
      leaseExpiresAt: FUTURE
    } as DurableFilesystemRecoveryClaim;
    const events: string[] = [];
    const journal = {
      async reserve() {
        events.push("reserve");
        return { operation: reservation, claim: recoveryClaim };
      },
      async finalizeAfterCommit() {
        events.push("finalize");
        return { outcome: "finalized" as const };
      },
      attach: unsupported,
      markCleanup: unsupported,
      completeCleanup: unsupported,
      recover: unsupported
    };
    const prewrite = {
      async recordPrewriteTarget(authority: { relativePath: string }) {
        events.push("target");
        expect(authority.relativePath).toBe(`staging/${operationId}.pending`);
        await expect(stat(join(archiveRoot, authority.relativePath)))
          .rejects.toMatchObject({ code: "ENOENT" });
      },
      async recordPrewriteNode(authority: { relativePath: string }) {
        events.push("prewrite");
        expect(authority.relativePath).toBe(`staging/${operationId}.pending`);
        expect((await stat(join(archiveRoot, authority.relativePath))).size).toBe(0);
      },
      preparePrewriteCleanup: unsupported
    };
    const candidates = {
      async issuePublicationCandidate() {
        events.push("candidate_issue");
        return "candidate-1" as AssetPublicationCandidate;
      },
      async completePublicationCandidate(_operation: unknown, _candidate: unknown, value: PrivateStorageDescriptor) {
        events.push("candidate_complete");
        expect(value.contentHash).toBe(sha256(content));
      },
      persistCandidate: unsupported,
      redeemCandidate: unsupported,
      attachCandidate: unsupported
    };
    const atomicPortable = {
      async issueStagedInput(_database: object, issuance: { attachment: { descriptor: PrivateStorageDescriptor } }) {
        events.push("atomic_issue");
        expect(issuance.attachment.descriptor.byteLength).toBe(content.byteLength);
        return {
          stagedInput: "staged-1" as never,
          operation: { ...reservation } as unknown as AttachedFilesystemOperation,
          claim: { ...recoveryClaim, workVersion: 2 }
        };
      },
      issueExportRetrieval: unsupported
    };
    const adapter = await createSecureFilesystemAdapter({
      archiveRoot,
      assetRoot,
      platform: "linux",
      journal,
      prewrite,
      candidates,
      atomicPortable,
      transactions: { async run(work) { return work({}); } }
    });

    const result = await adapter.stagePortableInput({
      owner: { ownerUserId: "owner-1" },
      operationScopeId: "stage-scope-1",
      leaseOwner: "api-1",
      expiresAt: FUTURE,
      byteLength: content.byteLength,
      source: [content]
    });

    expect(result.stagedInput).toBe("staged-1");
    expect(await stat(join(archiveRoot, `staging/${operationId}.pending`))).toMatchObject({
      size: content.byteLength
    });
    expect(events).toEqual([
      "reserve",
      "target",
      "prewrite",
      "candidate_issue",
      "candidate_complete",
      "atomic_issue",
      "finalize"
    ]);
    await adapter.close();
  });

  it("leaves target-only O_EXCL failure pending without deleting or completing cleanup", async () => {
    const archiveRoot = await mkdtemp(join(tmpdir(), "iqn-b4-target-collision-"));
    const assetRoot = await mkdtemp(join(tmpdir(), "iqn-b4-assets-"));
    await mkdir(join(archiveRoot, "staging"));
    const operationId = "12121212-1212-4121-8121-121212121212" as DurableFilesystemOperationId;
    const physicalPath = join(archiveRoot, `staging/${operationId}.pending`);
    await writeFile(physicalPath, "preexisting unknown node");
    const reservation = {
      resourceKind: "portable",
      ownerUserId: "owner-1",
      operationScopeId: "target-collision",
      operationId,
      purpose: "portable_staging",
      expiresAt: FUTURE
    } as ReservedFilesystemOperation;
    const recoveryClaim = {
      operationId,
      leaseId: "lease-collision",
      leaseOwner: "api-1",
      workVersion: 1,
      leaseExpiresAt: FUTURE
    } as DurableFilesystemRecoveryClaim;
    const recordNode = vi.fn();
    const completeCleanup = vi.fn();
    const adapter = await createSecureFilesystemAdapter({
      archiveRoot,
      assetRoot,
      platform: "linux",
      journal: {
        async reserve() { return { operation: reservation, claim: recoveryClaim }; },
        async markCleanup() { return { outcome: "cleanup_pending" as const }; },
        completeCleanup,
        finalizeAfterCommit: unsupported,
        attach: unsupported,
        recover: unsupported
      },
      prewrite: {
        async recordPrewriteTarget() {},
        recordPrewriteNode: recordNode,
        preparePrewriteCleanup: unsupported
      },
      candidates: {
        issuePublicationCandidate: unsupported,
        completePublicationCandidate: unsupported,
        persistCandidate: unsupported,
        redeemCandidate: unsupported,
        attachCandidate: unsupported
      },
      atomicPortable: {
        issueStagedInput: unsupported,
        issueExportRetrieval: unsupported
      },
      transactions: { async run(work) { return work({}); } }
    });
    await expect(adapter.stagePortableInput({
      owner: { ownerUserId: "owner-1" },
      operationScopeId: "target-collision",
      leaseOwner: "api-1",
      expiresAt: FUTURE,
      byteLength: 1,
      source: [Buffer.from("x")]
    })).rejects.toMatchObject({ code: "EEXIST" });
    expect(recordNode).not.toHaveBeenCalled();
    expect(completeCleanup).not.toHaveBeenCalled();
    await expect(stat(physicalPath)).resolves.toBeTruthy();
    await adapter.close();
  });

  it("runs one identity-safe rollback when later atomic staged issuance fails", async () => {
    const archiveRoot = await mkdtemp(join(tmpdir(), "iqn-b4-rollback-"));
    const assetRoot = await mkdtemp(join(tmpdir(), "iqn-b4-assets-"));
    const content = Buffer.from("rollback bytes");
    const operationId = "22222222-2222-4222-8222-222222222222" as DurableFilesystemOperationId;
    const reservation = {
      resourceKind: "portable",
      ownerUserId: "owner-1",
      operationScopeId: "stage-scope-rollback",
      operationId,
      purpose: "portable_staging",
      expiresAt: FUTURE
    } as ReservedFilesystemOperation;
    const recoveryClaim = {
      operationId,
      leaseId: "lease-rollback",
      leaseOwner: "api-1",
      workVersion: 1,
      leaseExpiresAt: FUTURE
    } as DurableFilesystemRecoveryClaim;
    const markCleanup = vi.fn(async () => ({ outcome: "cleanup_pending" as const }));
    const completeCleanup = vi.fn(async () => ({ outcome: "cleaned" as const }));
    const adapter = await createSecureFilesystemAdapter({
      archiveRoot,
      assetRoot,
      platform: "linux",
      journal: {
        async reserve() { return { operation: reservation, claim: recoveryClaim }; },
        finalizeAfterCommit: unsupported,
        attach: unsupported,
        markCleanup,
        completeCleanup,
        recover: unsupported
      },
      prewrite: {
        async recordPrewriteTarget() {},
        async recordPrewriteNode() {},
        preparePrewriteCleanup: unsupported
      },
      candidates: {
        async issuePublicationCandidate() { return "candidate-rollback" as AssetPublicationCandidate; },
        async completePublicationCandidate() {},
        persistCandidate: unsupported,
        redeemCandidate: unsupported,
        attachCandidate: unsupported
      },
      atomicPortable: {
        async issueStagedInput() { throw new Error("injected_atomic_failure"); },
        issueExportRetrieval: unsupported
      },
      transactions: { async run(work) { return work({}); } }
    });

    await expect(adapter.stagePortableInput({
      owner: { ownerUserId: "owner-1" },
      operationScopeId: "stage-scope-rollback",
      leaseOwner: "api-1",
      expiresAt: FUTURE,
      byteLength: content.byteLength,
      source: [content]
    })).rejects.toThrow("injected_atomic_failure");

    await expect(stat(join(archiveRoot, `staging/${operationId}.pending`)))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(markCleanup).toHaveBeenCalledTimes(1);
    expect(completeCleanup).toHaveBeenCalledTimes(1);
    await adapter.close();
  });

  it("prepares export cleanup before streaming and memoizes close-delete-ack finalization", async () => {
    const archiveRoot = await mkdtemp(join(tmpdir(), "iqn-b4-export-"));
    const assetRoot = await mkdtemp(join(tmpdir(), "iqn-b4-assets-"));
    await mkdir(join(archiveRoot, "exports"));
    const content = Buffer.from("bounded export bytes");
    const relativePath = "exports/operation-1.pending";
    await writeFile(join(archiveRoot, relativePath), content);
    const expected = await descriptor(archiveRoot, relativePath, content);
    const scope: PortableExportScope = {
      ownerUserId: "owner-1",
      exportKind: "campaign_zip",
      campaignId: "campaign-1",
      worldId: "world-1",
      worldVersionId: "version-1"
    };
    const retrieval = "retrieval-1" as PortableArchiveExportRetrieval;
    const operation = attachedOperation(scope);
    const recoveryClaim = claim(operation);
    const rehydration = {
      identity: { exportScope: scope, retrieval, contentType: "application/zip" },
      operation,
      claim: recoveryClaim,
      descriptor: expected
    } as PrivatePortableExportRehydration;
    const preparation = {
      outcome: "cleanup_required",
      identity: {
        portableKind: "export_artifact",
        artifactId: "artifact-1",
        ownerUserId: scope.ownerUserId,
        filesystemOperationId: operation.operationId,
        exportScope: scope
      },
      operation,
      claim: recoveryClaim,
      descriptors: [expected]
    } as unknown as PrivatePortableExportCleanupPreparation;
    const events: string[] = [];
    const acknowledge = vi.fn(async () => {
      events.push("ack");
      await expect(stat(join(archiveRoot, relativePath))).rejects.toMatchObject({ code: "ENOENT" });
      return { outcome: "cleaned" as const };
    });
    const portable = {
      async rehydrateExportArtifact() {
        events.push("rehydrate");
        return rehydration;
      },
      async prepareExportCleanup() {
        events.push("prepare");
        return preparation;
      },
      acknowledgeExportCleanup: acknowledge,
      rehydrateStagedInput: unsupported,
      prepareStagedCleanup: unsupported,
      acknowledgeStagedCleanup: unsupported,
      prepareRecoveryCleanup: unsupported
    } satisfies PrivatePortableRepositoryPort;
    const adapter = await createSecureFilesystemAdapter({
      archiveRoot,
      assetRoot,
      platform: "linux",
      portable,
      transactions: { async run(work) { return work({}); } }
    });

    const session = await adapter.openExportSession({
      scope,
      retrieval,
      claim: { leaseOwner: "api-1", leaseSeconds: 30 },
      limits: bindPrivateBoundedStreamLimits({
        maximumBytes: 1024,
        chunkBytes: 4,
        deadlineAt: FUTURE
      })
    });

    expect(events).toEqual(["rehydrate", "prepare"]);
    const iterator = session.chunks[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    await Promise.all([session.finalize("abort"), session.finalize("close")]);
    await iterator.return?.();
    expect(events).toEqual(["rehydrate", "prepare", "ack"]);
    expect(acknowledge).toHaveBeenCalledTimes(1);
    await adapter.close();
  });

  it("autonomously times out idle and between-chunk exports, cleans once, and denies late pulls", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      vi.setSystemTime("2026-08-08T12:00:00.000Z");
      const idle = await timeoutExportFixture({
        deadlineAt: "2026-08-08T12:00:01.000Z"
      });
      await vi.advanceTimersByTimeAsync(1_001);
      await idle.session.finalize("timeout");
      expect(idle.acknowledge).toHaveBeenCalledTimes(1);
      await expect(collect(idle.session.chunks)).rejects.toThrow("filesystem_stream_timeout");
      await idle.session.finalize("close");
      expect(idle.acknowledge).toHaveBeenCalledTimes(1);
      await idle.adapter.close();

      vi.setSystemTime("2026-08-08T13:00:00.000Z");
      const between = await timeoutExportFixture({
        deadlineAt: "2026-08-08T13:00:01.000Z",
        chunkBytes: 4
      });
      const iterator = between.session.chunks[Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toMatchObject({ done: false });
      await vi.advanceTimersByTimeAsync(1_001);
      await between.session.finalize("timeout");
      expect(between.acknowledge).toHaveBeenCalledTimes(1);
      await expect(iterator.next()).rejects.toThrow("filesystem_stream_timeout");
      await between.session.finalize("abort");
      expect(between.acknowledge).toHaveBeenCalledTimes(1);
      await between.adapter.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("autonomously closes timed-out asset sessions without deleting assets and denies late pulls", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      vi.setSystemTime("2026-08-08T14:00:00.000Z");
      const archiveRoot = await mkdtemp(join(tmpdir(), "iqn-b4-timeout-asset-"));
      const assetRoot = await mkdtemp(join(tmpdir(), "iqn-b4-assets-"));
      await mkdir(join(assetRoot, "assets"));
      const bytes = Buffer.from("asset timeout bytes");
      const assetPath = "assets/timed.png";
      const physicalPath = join(assetRoot, assetPath);
      await writeFile(physicalPath, bytes);
      const value = await descriptor(assetRoot, assetPath, bytes);
      const scope: AssetScope = { ownerUserId: "owner-1", assetId: "asset-timeout" };
      const adapter = await createSecureFilesystemAdapter({
        archiveRoot,
        assetRoot,
        platform: "linux",
        delivery: {
          async resolveFinalizedAssetDelivery() {
            return {
              kind: "durable_finalized" as const,
              scope,
              request: { kind: "original" as const },
              descriptor: {
                assetId: scope.assetId,
                kind: "original" as const,
                derivativeKind: null,
                mimeType: "image/png",
                byteLength: bytes.byteLength,
                etag: sha256(bytes)
              },
              grant: "asset-timeout-grant" as never,
              cleanupAuthority: "none" as const
            };
          },
          async redeemFinalizedDeliveryGrant() { return value; },
          redeemLegacyAnchoredRead: unsupported
        },
        transactions: { async run(work) { return work({}); } }
      });
      const session = await adapter.openAssetSession({
        scope,
        request: { kind: "original" },
        limits: bindPrivateBoundedStreamLimits({
          maximumBytes: 1024,
          chunkBytes: 4,
          deadlineAt: "2026-08-08T14:00:01.000Z"
        })
      });
      expect(session).not.toBeNull();
      await vi.advanceTimersByTimeAsync(1_001);
      await session!.finalize("close");
      expect(await hasOpenDescriptorFor(physicalPath)).toBe(false);
      await expect(stat(physicalPath)).resolves.toBeTruthy();
      await expect(collect(session!.chunks)).rejects.toThrow("filesystem_stream_timeout");
      await adapter.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("streams durable and legacy assets without granting cleanup authority", async () => {
    const archiveRoot = await mkdtemp(join(tmpdir(), "iqn-b4-preview-"));
    const assetRoot = await mkdtemp(join(tmpdir(), "iqn-b4-assets-"));
    await mkdir(join(assetRoot, "assets"));
    await mkdir(join(archiveRoot, "legacy"));
    const assetBytes = Buffer.from("asset bytes");
    const previewBytes = Buffer.from("preview bytes");
    const assetPath = "assets/final.png";
    const previewPath = "legacy/preview.zip";
    await writeFile(join(assetRoot, assetPath), assetBytes);
    await writeFile(join(archiveRoot, previewPath), previewBytes);
    const assetDescriptor = await descriptor(assetRoot, assetPath, assetBytes);
    const scope: AssetScope = { ownerUserId: "owner-1", assetId: "asset-1" };
    const resolver = {
      async resolveFinalizedAssetDelivery() {
        return {
          kind: "durable_finalized" as const,
          scope,
          request: { kind: "original" as const },
          descriptor: {
            assetId: scope.assetId,
            kind: "original" as const,
            derivativeKind: null,
            mimeType: "image/png" as const,
            byteLength: assetBytes.byteLength,
            etag: sha256(assetBytes)
          },
          grant: "grant-1" as never,
          cleanupAuthority: "none" as const
        };
      },
      async redeemFinalizedDeliveryGrant() {
        return assetDescriptor;
      },
      redeemLegacyAnchoredRead: unsupported
    };
    const adapter = await createSecureFilesystemAdapter({
      archiveRoot,
      assetRoot,
      platform: "linux",
      delivery: resolver,
      transactions: { async run(work) { return work({}); } }
    });
    const limits = bindPrivateBoundedStreamLimits({
      maximumBytes: 1024,
      chunkBytes: 64,
      deadlineAt: FUTURE
    });

    const asset = await adapter.openAssetSession({
      scope,
      request: { kind: "original" },
      limits
    });
    expect(asset).not.toBeNull();
    await expect(collect(asset!.chunks)).resolves.toEqual(assetBytes);
    await asset!.finalize("close");
    await expect(stat(join(assetRoot, assetPath))).resolves.toBeTruthy();

    const preview = await adapter.openLegacyPathV1Preview({
      descriptor: bindLegacyPathV1PreviewDescriptor({
        relativePath: previewPath,
        contentType: "application/zip",
        contentHash: sha256(previewBytes),
        byteLength: previewBytes.byteLength
      }),
      limits
    });
    await expect(collect(preview.chunks)).resolves.toEqual(previewBytes);
    await preview.finalize("close");
    await expect(stat(join(archiveRoot, previewPath))).resolves.toBeTruthy();

    const activeAsset = await adapter.openAssetSession({
      scope,
      request: { kind: "original" },
      limits
    });
    const activePreview = await adapter.openLegacyPathV1Preview({
      descriptor: bindLegacyPathV1PreviewDescriptor({
        relativePath: previewPath,
        contentType: "application/zip",
        contentHash: sha256(previewBytes),
        byteLength: previewBytes.byteLength
      }),
      limits
    });
    await adapter.close();
    await expect(collect(activeAsset!.chunks)).rejects.toBeTruthy();
    await expect(collect(activePreview.chunks)).rejects.toBeTruthy();
    await expect(stat(join(assetRoot, assetPath))).resolves.toBeTruthy();
    await expect(stat(join(archiveRoot, previewPath))).resolves.toBeTruthy();
  });

  it("anchors reads to the opened root and rejects symlinked intermediate segments", async () => {
    const archiveRoot = await mkdtemp(join(tmpdir(), "iqn-b4-root-"));
    const assetRoot = await mkdtemp(join(tmpdir(), "iqn-b4-assets-"));
    await mkdir(join(archiveRoot, "legacy"));
    const trusted = Buffer.from("trusted root bytes");
    const hostile = Buffer.from("hostile replacement");
    await writeFile(join(archiveRoot, "legacy/preview.zip"), trusted);
    const adapter = await createSecureFilesystemAdapter({
      archiveRoot,
      assetRoot,
      platform: "linux",
      transactions: { async run(work) { return work({}); } }
    });
    const movedRoot = `${archiveRoot}-moved`;
    await rename(archiveRoot, movedRoot);
    await mkdir(join(archiveRoot, "legacy"), { recursive: true });
    await writeFile(join(archiveRoot, "legacy/preview.zip"), hostile);
    const limits = bindPrivateBoundedStreamLimits({
      maximumBytes: 1024,
      chunkBytes: 64,
      deadlineAt: FUTURE
    });
    const session = await adapter.openLegacyPathV1Preview({
      descriptor: bindLegacyPathV1PreviewDescriptor({
        relativePath: "legacy/preview.zip",
        contentType: "application/zip",
        contentHash: sha256(trusted),
        byteLength: trusted.byteLength
      }),
      limits
    });
    await expect(collect(session.chunks)).resolves.toEqual(trusted);
    await adapter.close();

    const symlinkRoot = await mkdtemp(join(tmpdir(), "iqn-b4-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "iqn-b4-outside-"));
    const symlinkAssetRoot = await mkdtemp(join(tmpdir(), "iqn-b4-assets-"));
    await writeFile(join(outside, "preview.zip"), trusted);
    await symlink(outside, join(symlinkRoot, "legacy"), "dir");
    const symlinkAdapter = await createSecureFilesystemAdapter({
      archiveRoot: symlinkRoot,
      assetRoot: symlinkAssetRoot,
      platform: "linux",
      transactions: { async run(work) { return work({}); } }
    });
    await expect(symlinkAdapter.openLegacyPathV1Preview({
      descriptor: bindLegacyPathV1PreviewDescriptor({
        relativePath: "legacy/preview.zip",
        contentType: "application/zip",
        contentHash: sha256(trusted),
        byteLength: trusted.byteLength
      }),
      limits
    })).rejects.toBeTruthy();
    await symlinkAdapter.close();
  });

  it("fails closed on partial, growing, and hash-mismatched positional streams", async () => {
    const limits = bindPrivateBoundedStreamLimits({
      maximumBytes: 1024,
      chunkBytes: 4,
      deadlineAt: FUTURE
    });
    for (const fault of ["partial", "growing", "hash"] as const) {
      const archiveRoot = await mkdtemp(join(tmpdir(), `iqn-b4-${fault}-`));
      const assetRoot = await mkdtemp(join(tmpdir(), "iqn-b4-assets-"));
      await mkdir(join(archiveRoot, "legacy"));
      const content = Buffer.from("verified stream bytes");
      const path = join(archiveRoot, "legacy/preview.zip");
      await writeFile(path, content);
      const adapter = await createSecureFilesystemAdapter({
        archiveRoot,
        assetRoot,
        platform: "linux",
        transactions: { async run(work) { return work({}); } }
      });
      const session = await adapter.openLegacyPathV1Preview({
        descriptor: bindLegacyPathV1PreviewDescriptor({
          relativePath: "legacy/preview.zip",
          contentType: "application/zip",
          contentHash: fault === "hash" ? "0".repeat(64) : sha256(content),
          byteLength: content.byteLength
        }),
        limits
      });
      if (fault === "partial") await truncate(path, content.byteLength - 2);
      if (fault === "growing") await appendFile(path, "growth");
      await expect(collect(session.chunks)).rejects.toThrow(/filesystem_stream_/u);
      await expect(stat(path)).resolves.toBeTruthy();
      await adapter.close();
    }
  });

  it("closes before fail-closed export fault cleanup and only acknowledges an identity-safe delete", async () => {
    for (const fault of ["partial", "growing", "hash"] as const) {
      const fixture = await timeoutExportFixture({
        deadlineAt: FUTURE,
        ...(fault === "hash" ? { contentHash: "0".repeat(64) } : {})
      });
      if (fault === "partial") {
        await truncate(fixture.physicalPath, fixture.content.byteLength - 2);
      }
      if (fault === "growing") await appendFile(fixture.physicalPath, "growth");
      await expect(collect(fixture.session.chunks)).rejects.toThrow();
      expect(await hasOpenDescriptorFor(fixture.physicalPath)).toBe(false);
      if (fault === "hash") {
        expect(fixture.acknowledge).toHaveBeenCalledTimes(1);
        expect(fixture.events).toEqual(["ack"]);
        await fixture.session.finalize("close");
        expect(fixture.acknowledge).toHaveBeenCalledTimes(1);
      } else {
        expect(fixture.acknowledge).not.toHaveBeenCalled();
        await expect(stat(fixture.physicalPath)).resolves.toBeTruthy();
        await fixture.session.finalize("close").catch(() => undefined);
      }
      await fixture.adapter.close();
    }
  });

  it("fails an asset open racing shutdown and closes the unpublished handle", async () => {
    const archiveRoot = await mkdtemp(join(tmpdir(), "iqn-b4-close-race-"));
    const assetRoot = await mkdtemp(join(tmpdir(), "iqn-b4-assets-"));
    const bytes = Buffer.from("shutdown race asset");
    const assetPath = "race.png";
    const physicalPath = join(assetRoot, assetPath);
    await writeFile(physicalPath, bytes);
    const value = await descriptor(assetRoot, assetPath, bytes);
    const scope: AssetScope = { ownerUserId: "owner-1", assetId: "asset-race" };
    const adapter = await createSecureFilesystemAdapter({
      archiveRoot,
      assetRoot,
      platform: "linux",
      delivery: {
        async resolveFinalizedAssetDelivery() {
          return {
            kind: "durable_finalized" as const,
            scope,
            request: { kind: "original" as const },
            descriptor: {
              assetId: scope.assetId,
              kind: "original" as const,
              derivativeKind: null,
              mimeType: "image/png",
              byteLength: bytes.byteLength,
              etag: sha256(bytes)
            },
            grant: "asset-race-grant" as never,
            cleanupAuthority: "none" as const
          };
        },
        async redeemFinalizedDeliveryGrant() { return value; },
        redeemLegacyAnchoredRead: unsupported
      },
      transactions: { async run(work) { return work({}); } }
    });
    const probe = await open(physicalPath);
    const prototype = Object.getPrototypeOf(probe) as { stat: FileHandle["stat"] };
    await probe.close();
    const originalStat = prototype.stat;
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    let block = true;
    const statSpy = vi.spyOn(prototype, "stat").mockImplementation(function (this: FileHandle, options) {
      if (!block) return originalStat.call(this, options);
      block = false;
      enteredResolve();
      return release.then(() => originalStat.call(this, options)) as ReturnType<FileHandle["stat"]>;
    });
    try {
      const opening = adapter.openAssetSession({
        scope,
        request: { kind: "original" },
        limits: bindPrivateBoundedStreamLimits({
          maximumBytes: 1024,
          chunkBytes: 4,
          deadlineAt: FUTURE
        })
      });
      await entered;
      await adapter.close();
      releaseResolve();
      await expect(opening).rejects.toThrow("filesystem_adapter_closed");
      expect(await hasOpenDescriptorFor(physicalPath)).toBe(false);
    } finally {
      releaseResolve();
      statSpy.mockRestore();
    }
  });

  it("quarantines target-only recovery without path deletion or cleanup completion", async () => {
    const archiveRoot = await mkdtemp(join(tmpdir(), "iqn-b4-target-only-"));
    const assetRoot = await mkdtemp(join(tmpdir(), "iqn-b4-assets-"));
    await mkdir(join(archiveRoot, "exports"));
    const relativePath = "exports/44444444-4444-4444-8444-444444444444.pending";
    const physicalPath = join(archiveRoot, relativePath);
    await writeFile(physicalPath, "unknown substituted node");
    const operation = {
      resourceKind: "portable",
      ownerUserId: "owner-1",
      operationScopeId: "target-only-scope",
      operationId: "44444444-4444-4444-8444-444444444444",
      purpose: "portable_export",
      expiresAt: FUTURE
    } as ReservedFilesystemOperation;
    const recovery = {
      action: "cleanup" as const,
      operation,
      claim: {
        operationId: operation.operationId,
        leaseId: "target-only-lease",
        leaseOwner: "reaper-target-only",
        workVersion: 2,
        leaseExpiresAt: FUTURE
      }
    } as never;
    const completeCleanup = vi.fn();
    const adapter = await createSecureFilesystemAdapter({
      archiveRoot,
      assetRoot,
      platform: "linux",
      expiry: { async claimExpiredPortableWork() { return [recovery]; } },
      portable: {
        async prepareRecoveryCleanup() { return { outcome: "already_cleaned" as const }; },
        acknowledgeExportCleanup: unsupported,
        rehydrateStagedInput: unsupported,
        prepareStagedCleanup: unsupported,
        acknowledgeStagedCleanup: unsupported,
        rehydrateExportArtifact: unsupported,
        prepareExportCleanup: unsupported
      },
      prewrite: {
        async preparePrewriteCleanup() { return { outcome: "quarantined" as const }; },
        recordPrewriteTarget: unsupported,
        recordPrewriteNode: unsupported
      },
      journal: {
        completeCleanup,
        reserve: unsupported,
        attach: unsupported,
        finalizeAfterCommit: unsupported,
        markCleanup: unsupported,
        recover: unsupported
      },
      transactions: { async run(work) { return work({}); } }
    });
    await expect(adapter.reapExpiredPortable({
      leaseOwner: "reaper-target-only",
      leaseSeconds: 30,
      limit: 10
    })).resolves.toEqual({ claimed: 1, cleaned: 0, pending: 1 });
    await expect(stat(physicalPath)).resolves.toBeTruthy();
    expect(completeCleanup).not.toHaveBeenCalled();
    await adapter.close();
  });

  it("reaps bearer-free expired export work by deleting before b2c acknowledgement", async () => {
    const archiveRoot = await mkdtemp(join(tmpdir(), "iqn-b4-reaper-"));
    const assetRoot = await mkdtemp(join(tmpdir(), "iqn-b4-assets-"));
    await mkdir(join(archiveRoot, "exports"));
    const content = Buffer.from("expired export");
    const relativePath = "exports/33333333-3333-4333-8333-333333333333.pending";
    await writeFile(join(archiveRoot, relativePath), content);
    const expected = await descriptor(archiveRoot, relativePath, content);
    const scope: PortableExportScope = {
      ownerUserId: "owner-1",
      exportKind: "campaign_zip",
      campaignId: "campaign-1",
      worldId: "world-1",
      worldVersionId: "version-1"
    };
    const operation = {
      ...attachedOperation(scope),
      operationId: "33333333-3333-4333-8333-333333333333"
    } as AttachedFilesystemOperation;
    const recoveryClaim = claim(operation);
    const recovery = {
      action: "cleanup" as const,
      operation,
      claim: recoveryClaim
    } as never;
    const preparation = {
      outcome: "cleanup_required",
      identity: {
        portableKind: "export_artifact",
        artifactId: "artifact-expired",
        ownerUserId: scope.ownerUserId,
        filesystemOperationId: operation.operationId,
        exportScope: scope
      },
      operation,
      claim: recoveryClaim,
      descriptors: [expected]
    } as unknown as PrivatePortableExportCleanupPreparation;
    const acknowledge = vi.fn(async () => {
      await expect(stat(join(archiveRoot, relativePath))).rejects.toMatchObject({ code: "ENOENT" });
      if (acknowledge.mock.calls.length === 1) throw new Error("injected_acknowledgement_crash");
      return { outcome: "cleaned" as const };
    });
    const adapter = await createSecureFilesystemAdapter({
      archiveRoot,
      assetRoot,
      platform: "linux",
      expiry: {
        async claimExpiredPortableWork(request) {
          expect(request).toEqual({ leaseOwner: "reaper-1", leaseSeconds: 30, limit: 10 });
          return [recovery];
        }
      },
      portable: {
        async prepareRecoveryCleanup(_database, value) {
          expect(value).toBe(recovery);
          expect(value).not.toHaveProperty("retrieval");
          return preparation;
        },
        acknowledgeExportCleanup: acknowledge,
        rehydrateStagedInput: unsupported,
        prepareStagedCleanup: unsupported,
        acknowledgeStagedCleanup: unsupported,
        rehydrateExportArtifact: unsupported,
        prepareExportCleanup: unsupported
      },
      prewrite: {
        async preparePrewriteCleanup() { return { outcome: "already_cleaned" as const }; },
        recordPrewriteTarget: unsupported,
        recordPrewriteNode: unsupported
      },
      journal: {
        completeCleanup: unsupported,
        reserve: unsupported,
        attach: unsupported,
        finalizeAfterCommit: unsupported,
        markCleanup: unsupported,
        recover: unsupported
      },
      transactions: { async run(work) { return work({}); } }
    });

    await expect(adapter.reapExpiredPortable({
      leaseOwner: "reaper-1",
      leaseSeconds: 30,
      limit: 10
    })).resolves.toEqual({ claimed: 1, cleaned: 0, pending: 1 });
    await writeFile(join(archiveRoot, relativePath), "substituted export");
    await expect(adapter.reapExpiredPortable({
      leaseOwner: "reaper-1",
      leaseSeconds: 30,
      limit: 10
    })).resolves.toEqual({ claimed: 1, cleaned: 0, pending: 1 });
    expect(acknowledge).toHaveBeenCalledTimes(1);
    await unlink(join(archiveRoot, relativePath));
    await expect(adapter.reapExpiredPortable({
      leaseOwner: "reaper-1",
      leaseSeconds: 30,
      limit: 10
    })).resolves.toEqual({ claimed: 1, cleaned: 1, pending: 0 });
    expect(acknowledge).toHaveBeenCalledTimes(2);
    await adapter.close();
  });
});
