import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeDurableFilesystemLifecycle } from "../helpers/private-storage-lifecycle-fake.js";
import type {
  DurableFilesystemJournalPort,
  DurableFilesystemScope,
  PrivateStorageDescriptor,
  ReservedFilesystemOperation
} from "../../packages/application/src/assets/private-storage-lifecycle.js";
import type { ImportOwnerScope } from "../../packages/application/src/imports/types.js";
import {
  createPortableArchiveFilesystemAdapter,
  type SafeFilesystemCapabilityFailure
} from "../helpers/legacy-portable-archive-filesystem-adapter.js";
import type { LegacyDurableFilesystemJournalPort } from "../helpers/legacy-private-storage-lifecycle-contracts.js";
import {
  writeArchiveArtifact,
  type ArchiveLimits
} from "../../services/api/src/archive-io.js";

const limits: ArchiveLimits = {
  maxCompressedBytes: 2_000_000,
  maxUncompressedBytes: 4_000_000,
  maxEntries: 100,
  maxExpansionRatio: 100,
  maxManifestBytes: 100_000,
  maxJsonEntryBytes: 500_000,
  maxOriginalImageBytes: 1_000_000
};
const owner: ImportOwnerScope = { ownerUserId: "00000000-0000-4000-8000-000000000001" };
const foreignOwner: ImportOwnerScope = { ownerUserId: "00000000-0000-4000-8000-000000000002" };
const assetScope: DurableFilesystemScope = {
  resourceKind: "asset",
  ownerUserId: owner.ownerUserId,
  assetId: "10000000-0000-4000-8000-000000000001"
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
const roots: string[] = [];

const filesystemFaultHooks = vi.hoisted(() => ({
  afterLink: undefined as undefined | ((source: string, target: string) => Promise<boolean>),
  beforeRename: undefined as undefined | ((source: string, target: string) => Promise<boolean>),
  beforeUnlink: undefined as undefined | ((path: string) => Promise<boolean>)
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  async function runHook(
    name: keyof typeof filesystemFaultHooks,
    args: string[],
  ): Promise<void> {
    const hook = filesystemFaultHooks[name];
    if (!hook) return;
    filesystemFaultHooks[name] = undefined;
    const consumed = await (hook as (...values: string[]) => Promise<boolean>)(...args);
    if (!consumed) filesystemFaultHooks[name] = hook as never;
  }
  return {
    ...actual,
    link: async (source: string, target: string) => {
      await actual.link(source, target);
      await runHook("afterLink", [source, target]);
    },
    rename: async (source: string, target: string) => {
      await runHook("beforeRename", [source, target]);
      return actual.rename(source, target);
    },
    unlink: async (path: string) => {
      await runHook("beforeUnlink", [path]);
      return actual.unlink(path);
    }
  };
});

afterEach(async () => {
  filesystemFaultHooks.afterLink = undefined;
  filesystemFaultHooks.beforeRename = undefined;
  filesystemFaultHooks.beforeUnlink = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function systemArchive(root: string): Promise<string> {
  const artifact = await writeArchiveArtifact(root, [{
    path: "records/data.json",
    logicalType: "records",
    mediaType: "application/json",
    source: Readable.from(Buffer.from('{"safe":true}', "utf8"))
  }], (entries) => ({
    format: "infinite-quest-archive",
    formatVersion: 1,
    archiveType: "system",
    createdAt: "2026-08-05T00:00:00.000Z",
    contentFingerprint: "f".repeat(64),
    entries: [...entries],
    payloads: entries.map((entry) => ({ kind: "records" as const, path: entry.path, formatVersion: 1 })),
    assets: []
  }), limits);
  return artifact.absolutePath;
}

async function onlyPublishedAsset(assetRoot: string): Promise<string> {
  const paths = await readdir(assetRoot, { recursive: true, withFileTypes: true });
  const file = paths.find((entry) => entry.isFile() && !entry.name.endsWith(".tmp"));
  if (!file) throw new Error("Expected one published asset fixture.");
  return join(file.parentPath, file.name);
}

async function expectSafeFailure(
  operation: Promise<unknown>,
  code: SafeFilesystemCapabilityFailure["code"],
  forbidden: readonly string[] = [],
): Promise<SafeFilesystemCapabilityFailure> {
  try {
    await operation;
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toEqual({ code });
    expect(error).not.toBeInstanceOf(Error);
    expect(Object.keys(error as object)).toEqual(["code"]);
    expect(Object.isFrozen(error)).toBe(true);
    const serialized = JSON.stringify(error);
    for (const value of forbidden) expect(serialized).not.toContain(value);
    return error as SafeFilesystemCapabilityFailure;
  }
}

const publicationDescriptor: PrivateStorageDescriptor = {
  relativePath: "originals/private.asset",
  identity: {
    deviceId: "1",
    fileId: "2",
    changeToken: "3:4:5"
  },
  contentHash: "a".repeat(64),
  byteLength: png.byteLength
};

function publicationPreparation(descriptor: PrivateStorageDescriptor) {
  return {
    deliveryRelativePath: descriptor.relativePath,
    cleanupDescriptors: [descriptor] as const
  };
}

describe("Task 14e2aR persisted filesystem capability", () => {
  it("rehydrates a database-issued staged handle after restart without storing its raw token", async () => {
    const archiveRoot = await temporaryRoot("iq-persisted-staged-");
    const archivePath = await systemArchive(archiveRoot);
    const archiveBytes = await readFile(archivePath);
    const persistence = createFakeDurableFilesystemLifecycle();
    const first = createPortableArchiveFilesystemAdapter({
      archiveRoot,
      assetRoot: archiveRoot,
      limits,
      persistence
    });
    const upload = first.issueOwnerBoundUpload(owner, createReadStream(archivePath), archiveBytes.byteLength);
    const staged = await first.stagingPort.stagePortableArchive(upload);

    const restarted = createPortableArchiveFilesystemAdapter({
      archiveRoot,
      assetRoot: archiveRoot,
      limits,
      persistence
    });
    await expectSafeFailure(restarted.inspectPortableArchive(foreignOwner, staged, "system"), "archive_unavailable");
    await expect(restarted.inspectPortableArchive(owner, staged, "system")).resolves.toMatchObject({
      archiveType: "system",
      entries: [expect.objectContaining({ path: "records/data.json" })]
    });
    expect(persistence.persistedTokenHashes()).toEqual([
      createHash("sha256").update(staged, "utf8").digest("hex")
    ]);
    expect(JSON.stringify(staged)).not.toContain(archiveRoot);
    expect(JSON.stringify(staged)).not.toContain(owner.ownerUserId);
    await restarted.cleanupStagedInput(owner, staged);
  });

  it("rejects stale staged identity and preserves a cleanup-pending record for retry after restart", async () => {
    const archiveRoot = await temporaryRoot("iq-persisted-stale-");
    const archivePath = await systemArchive(archiveRoot);
    const archiveBytes = await readFile(archivePath);
    const persistence = createFakeDurableFilesystemLifecycle();
    const first = createPortableArchiveFilesystemAdapter({ archiveRoot, assetRoot: archiveRoot, limits, persistence });
    const upload = first.issueOwnerBoundUpload(owner, createReadStream(archivePath), archiveBytes.byteLength);
    const staged = await first.stagingPort.stagePortableArchive(upload);
    const stagedDirectory = join(archiveRoot, "staging");
    const stagedName = (await readdir(stagedDirectory))[0]!;
    const stagedPath = join(stagedDirectory, stagedName);
    const originalPath = `${stagedPath}.original`;
    await rename(stagedPath, originalPath);
    await writeFile(stagedPath, Buffer.alloc(archiveBytes.byteLength, 0x41));

    const restarted = createPortableArchiveFilesystemAdapter({ archiveRoot, assetRoot: archiveRoot, limits, persistence });
    await expectSafeFailure(restarted.inspectPortableArchive(owner, staged, "system"), "archive_containment_denied");
    await expectSafeFailure(restarted.cleanupStagedInput(owner, staged), "archive_cleanup_required");
    expect(await stat(stagedPath)).toMatchObject({ size: archiveBytes.byteLength });

    await rm(stagedPath);
    await rename(originalPath, stagedPath);
    const retrying = createPortableArchiveFilesystemAdapter({ archiveRoot, assetRoot: archiveRoot, limits, persistence });
    await retrying.cleanupStagedInput(owner, staged);
    await expect(retrying.cleanupStagedInput(owner, staged)).resolves.toBeUndefined();
    expect(persistence.events()).toEqual(expect.arrayContaining([
      "staged_cleanup_pending",
      "staged_cleaned"
    ]));
  });

  it("rehydrates owner-bound export retrieval after restart and cleans it idempotently", async () => {
    const archiveRoot = await temporaryRoot("iq-persisted-export-");
    const persistence = createFakeDurableFilesystemLifecycle();
    const first = createPortableArchiveFilesystemAdapter({ archiveRoot, assetRoot: archiveRoot, limits, persistence });
    const exported = await first.publishArchiveArtifact(owner, [{
      path: "records/data.json",
      logicalType: "records",
      mediaType: "application/json",
      source: Readable.from(Buffer.from('{"exported":true}', "utf8"))
    }], (entries) => ({
      format: "infinite-quest-archive",
      formatVersion: 1,
      archiveType: "system",
      createdAt: "2026-08-05T00:00:00.000Z",
      contentFingerprint: "e".repeat(64),
      entries: [...entries],
      payloads: entries.map((entry) => ({ kind: "records" as const, path: entry.path, formatVersion: 1 })),
      assets: []
    }));

    const restarted = createPortableArchiveFilesystemAdapter({ archiveRoot, assetRoot: archiveRoot, limits, persistence });
    await expectSafeFailure(
      restarted.readExportArtifact(foreignOwner, exported.retrieval, limits.maxCompressedBytes),
      "archive_unavailable"
    );
    const downloaded = await restarted.readExportArtifact(owner, exported.retrieval, limits.maxCompressedBytes);
    expect(downloaded.content.subarray(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]));
    await restarted.cleanupExportArtifact(owner, exported.retrieval);
    await expect(restarted.cleanupExportArtifact(owner, exported.retrieval)).resolves.toBeUndefined();
  });

  it.each(["asset_original", "asset_derivative"] as const)(
    "reserves, attaches, and finalizes an opaque identity-bound %s publication across restart",
    async (purpose) => {
      const archiveRoot = await temporaryRoot("iq-persisted-publication-archive-");
      const assetRoot = await temporaryRoot("iq-persisted-publication-assets-");
      const persistence = createFakeDurableFilesystemLifecycle();
      const first = createPortableArchiveFilesystemAdapter({ archiveRoot, assetRoot, limits, persistence });
      const reserved = await first.publicationLifecycle.reserve(assetScope, {
        purpose,
        leaseOwner: "publisher",
        expiresAt: "2099-08-05T13:00:00.000Z"
      });
      const candidate = await first.publishAssetCandidate(reserved.operation, {
        content: png,
        mimeType: "image/png"
      });
      expect(typeof candidate).toBe("string");
      expect(JSON.stringify(candidate)).not.toContain(assetRoot);
      const attached = await first.publicationLifecycle.attach({}, reserved.operation, candidate);
      expect(attached.outcome).toBe("attached");
      if (attached.outcome !== "attached") throw new Error("Expected publication attachment.");

      const restarted = createPortableArchiveFilesystemAdapter({ archiveRoot, assetRoot, limits, persistence });
      await expectSafeFailure(restarted.readPublishedAsset({
        scope: { ...assetScope, ownerUserId: foreignOwner.ownerUserId },
        locator: attached.locator,
        mimeType: "image/png",
        maximumBytes: png.byteLength
      }), "asset_storage_unavailable");
      const published = await restarted.readPublishedAsset({
        scope: assetScope,
        locator: attached.locator,
        mimeType: "image/png",
        maximumBytes: png.byteLength
      });
      expect(Buffer.from(published.content)).toEqual(png);
      await expect(restarted.publicationLifecycle.finalizeAfterCommit(attached.operation, attached.claim))
        .resolves.toEqual({ outcome: "finalized" });
      await expect(restarted.publicationLifecycle.finalizeAfterCommit(attached.operation, attached.claim))
        .resolves.toEqual({ outcome: "already_finalized" });
      expect(persistence.persistedTokenHashes()).not.toContain(candidate);
    }
  );

  it("rehydrates a cleanup-pending publication operation and retries identity-safe cleanup", async () => {
    const archiveRoot = await temporaryRoot("iq-publication-cleanup-archive-");
    const assetRoot = await temporaryRoot("iq-publication-cleanup-assets-");
    const persistence = createFakeDurableFilesystemLifecycle();
    const first = createPortableArchiveFilesystemAdapter({ archiveRoot, assetRoot, limits, persistence });
    const reserved = await first.publicationLifecycle.reserve(assetScope, {
      purpose: "asset_derivative",
      leaseOwner: "publisher",
      expiresAt: "2099-08-05T13:00:00.000Z"
    });
    const candidate = await first.publishAssetCandidate(reserved.operation, {
      content: png,
      mimeType: "image/png"
    });
    const attached = await first.publicationLifecycle.attach({}, reserved.operation, candidate);
    if (attached.outcome !== "attached") throw new Error("Expected publication attachment.");
    await expect(first.publicationLifecycle.markCleanup(attached.operation, attached.claim, { cause: "rollback" }))
      .resolves.toEqual({ outcome: "cleanup_pending" });
    const publishedPath = await onlyPublishedAsset(assetRoot);
    const originalPath = `${publishedPath}.original`;
    await chmod(publishedPath, 0o640);
    await rename(publishedPath, originalPath);
    await writeFile(publishedPath, Buffer.alloc(png.byteLength, 0x42));

    const restarted = createPortableArchiveFilesystemAdapter({ archiveRoot, assetRoot, limits, persistence });
    await expectSafeFailure(
      restarted.cleanupPublishedAsset(attached.operation, attached.claim),
      "filesystem_race_detected"
    );
    expect(await readFile(publishedPath)).toEqual(Buffer.alloc(png.byteLength, 0x42));
    await rm(publishedPath);
    await rename(originalPath, publishedPath);

    const retrying = createPortableArchiveFilesystemAdapter({ archiveRoot, assetRoot, limits, persistence });
    await expect(retrying.cleanupPublishedAsset(attached.operation, attached.claim))
      .resolves.toEqual({ outcome: "cleaned" });
    await expect(retrying.cleanupPublishedAsset(attached.operation, attached.claim))
      .resolves.toEqual({ outcome: "already_cleaned" });
  });

  it("rehydrates an attached operation with a newly fenced claim after restart", async () => {
    const archiveRoot = await temporaryRoot("iq-operation-recovery-archive-");
    const assetRoot = await temporaryRoot("iq-operation-recovery-assets-");
    const persistence = createFakeDurableFilesystemLifecycle();
    const first = createPortableArchiveFilesystemAdapter({ archiveRoot, assetRoot, limits, persistence });
    const reserved = await first.publicationLifecycle.reserve(assetScope, {
      purpose: "asset_original",
      leaseOwner: "publisher",
      expiresAt: "2099-08-05T13:00:00.000Z"
    });
    const candidate = await first.publishAssetCandidate(reserved.operation, {
      content: png,
      mimeType: "image/png"
    });
    const attached = await first.publicationLifecycle.attach({}, reserved.operation, candidate);
    if (attached.outcome !== "attached") throw new Error("Expected publication attachment.");

    const restarted = createPortableArchiveFilesystemAdapter({ archiveRoot, assetRoot, limits, persistence });
    const recovered = await restarted.publicationLifecycle.recover({
      leaseOwner: "reaper",
      leaseSeconds: 30,
      limit: 1
    });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ action: "finalize", operation: attached.operation });
    await expect(restarted.publicationLifecycle.finalizeAfterCommit(attached.operation, attached.claim))
      .resolves.toEqual({ outcome: "lease_lost" });
    if (recovered[0]?.action !== "finalize") throw new Error("Expected finalize recovery.");
    await expect(restarted.publicationLifecycle.finalizeAfterCommit(recovered[0].operation, recovered[0].claim))
      .resolves.toEqual({ outcome: "finalized" });
  });

  it.each([
    "reserve",
    "attach",
    "finalizeAfterCommit",
    "markCleanup",
    "completeCleanup",
    "recover"
  ] as const)("maps a hostile %s journal failure to one frozen safe diagnostic", async (method) => {
    const archiveRoot = await temporaryRoot("iq-hostile-journal-archive-");
    const assetRoot = await temporaryRoot("iq-hostile-journal-assets-");
    const persistence = createFakeDurableFilesystemLifecycle();
    const reserved = await persistence.journal.reserve(assetScope, {
      purpose: "asset_original",
      leaseOwner: "publisher",
      expiresAt: "2099-08-05T13:00:00.000Z"
    });
    const candidate = await persistence.issuePublicationCandidate(
      reserved.operation,
      publicationPreparation(publicationDescriptor),
    );
    await persistence.completePublicationCandidate(reserved.operation, candidate, publicationDescriptor);
    const attached = await persistence.journal.attach({}, reserved.operation, candidate);
    if (attached.outcome !== "attached") throw new Error("Expected hostile-journal fixture attachment.");
    const privateFailure = "postgres-password=private-secret /srv/private/assets";
    const fail = async () => {
      throw new Error(privateFailure);
    };
    const hostileJournal: LegacyDurableFilesystemJournalPort = {
      reserve: fail,
      attach: fail,
      finalizeAfterCommit: fail,
      markCleanup: fail,
      completeCleanup: fail,
      heartbeatRecoveryClaim: fail,
      recover: fail
    };
    const adapter = createPortableArchiveFilesystemAdapter({
      archiveRoot,
      assetRoot,
      limits,
      persistence: { ...persistence, journal: hostileJournal }
    });
    let operation: Promise<unknown>;
    switch (method) {
      case "reserve":
        operation = adapter.publicationLifecycle.reserve(assetScope, {
          purpose: "asset_original",
          leaseOwner: "publisher",
          expiresAt: "2099-08-05T13:00:00.000Z"
        });
        break;
      case "attach":
        operation = adapter.publicationLifecycle.attach({}, reserved.operation, candidate);
        break;
      case "finalizeAfterCommit":
        operation = adapter.publicationLifecycle.finalizeAfterCommit(attached.operation, attached.claim);
        break;
      case "markCleanup":
        operation = adapter.publicationLifecycle.markCleanup(
          attached.operation,
          attached.claim,
          { cause: "rollback" },
        );
        break;
      case "completeCleanup":
        operation = adapter.publicationLifecycle.completeCleanup(attached.operation, attached.claim);
        break;
      case "recover":
        operation = adapter.publicationLifecycle.recover({ leaseOwner: "reaper", leaseSeconds: 30, limit: 1 });
        break;
    }
    await expectSafeFailure(operation, "asset_storage_unavailable", [
      privateFailure,
      "private-secret",
      "/srv/private/assets"
    ]);
  });

  it("rejects forged owner and purpose at publication-candidate issuance", async () => {
    const persistence = createFakeDurableFilesystemLifecycle();
    const reserved = await persistence.journal.reserve(assetScope, {
      purpose: "asset_original",
      leaseOwner: "publisher",
      expiresAt: "2099-08-05T13:00:00.000Z"
    });

    await expect(persistence.issuePublicationCandidate({
      ...reserved.operation,
      ownerUserId: foreignOwner.ownerUserId
    } as ReservedFilesystemOperation, publicationPreparation(publicationDescriptor))).rejects.toThrow();
    await expect(persistence.issuePublicationCandidate({
      ...reserved.operation,
      purpose: "asset_derivative"
    } as ReservedFilesystemOperation, publicationPreparation(publicationDescriptor))).rejects.toThrow();
  });

  it("does not attach a prepared candidate before its exact delivery identity is completed", async () => {
    const persistence = createFakeDurableFilesystemLifecycle();
    const reserved = await persistence.journal.reserve(assetScope, {
      purpose: "asset_original",
      leaseOwner: "publisher",
      expiresAt: "2099-08-05T13:00:00.000Z"
    });
    const candidate = await persistence.issuePublicationCandidate(
      reserved.operation,
      publicationPreparation(publicationDescriptor),
    );

    await expect(persistence.journal.attach({}, reserved.operation, candidate))
      .resolves.toEqual({ outcome: "candidate_mismatch" });
    await persistence.completePublicationCandidate(reserved.operation, candidate, publicationDescriptor);
    await expect(persistence.journal.attach({}, reserved.operation, candidate))
      .resolves.toMatchObject({ outcome: "attached" });
  });

  it.each(["owner", "purpose"] as const)(
    "denies publication attachment with a forged %s",
    async (field) => {
      const persistence = createFakeDurableFilesystemLifecycle();
      const reserved = await persistence.journal.reserve(assetScope, {
        purpose: "asset_original",
        leaseOwner: "publisher",
        expiresAt: "2099-08-05T13:00:00.000Z"
      });
      const candidate = await persistence.issuePublicationCandidate(
        reserved.operation,
        publicationPreparation(publicationDescriptor),
      );
      await persistence.completePublicationCandidate(reserved.operation, candidate, publicationDescriptor);
      const forged = {
        ...reserved.operation,
        ...(field === "owner"
          ? { ownerUserId: foreignOwner.ownerUserId }
          : { purpose: "asset_derivative" as const })
      } as ReservedFilesystemOperation;

      await expect(persistence.journal.attach({}, forged, candidate))
        .resolves.toEqual({ outcome: "stale" });
    }
  );

  it("denies locator redemption to foreign scope and after cleanup begins or completes", async () => {
    const persistence = createFakeDurableFilesystemLifecycle();
    const reserved = await persistence.journal.reserve(assetScope, {
      purpose: "asset_original",
      leaseOwner: "publisher",
      expiresAt: "2099-08-05T13:00:00.000Z"
    });
    const candidate = await persistence.issuePublicationCandidate(
      reserved.operation,
      publicationPreparation(publicationDescriptor),
    );
    await persistence.completePublicationCandidate(reserved.operation, candidate, publicationDescriptor);
    const attached = await persistence.journal.attach({}, reserved.operation, candidate);
    if (attached.outcome !== "attached") throw new Error("Expected locator fixture attachment.");

    await expect(persistence.redeemStorageLocator({
      ...assetScope,
      ownerUserId: foreignOwner.ownerUserId
    }, attached.locator)).resolves.toBeNull();
    await expect(persistence.redeemStorageLocator(assetScope, attached.locator))
      .resolves.toEqual(publicationDescriptor);
    await persistence.journal.markCleanup(attached.operation, attached.claim, { cause: "rollback" });
    await expect(persistence.redeemStorageLocator(assetScope, attached.locator)).resolves.toBeNull();
    await persistence.journal.completeCleanup(attached.operation, attached.claim);
    await expect(persistence.redeemStorageLocator(assetScope, attached.locator)).resolves.toBeNull();
  });

  it("persists cleanup authority while the publication is still an exclusive temporary file", async () => {
    const archiveRoot = await temporaryRoot("iq-pre-adoption-archive-");
    const assetRoot = await temporaryRoot("iq-pre-adoption-assets-");
    const persistence = createFakeDurableFilesystemLifecycle();
    const issueCandidate = persistence.issuePublicationCandidate.bind(persistence);
    persistence.issuePublicationCandidate = async (...args) => {
      const files = await readdir(assetRoot, { recursive: true });
      expect(files.filter((path) => path.endsWith(".asset"))).toEqual([]);
      expect(files.filter((path) => path.endsWith(".tmp"))).toHaveLength(1);
      return issueCandidate(...args);
    };
    const adapter = createPortableArchiveFilesystemAdapter({ archiveRoot, assetRoot, limits, persistence });
    const reserved = await adapter.publicationLifecycle.reserve(assetScope, {
      purpose: "asset_original",
      leaseOwner: "publisher",
      expiresAt: "2099-08-05T13:00:00.000Z"
    });

    await expect(adapter.publishAssetCandidate(reserved.operation, {
      content: png,
      mimeType: "image/png"
    })).resolves.toEqual(expect.any(String));
  });

  it.each(["after_link", "before_temporary_unlink"] as const)(
    "recovers both publication aliases after a %s interruption and retries without EEXIST",
    async (fault) => {
      const archiveRoot = await temporaryRoot("iq-adoption-fault-archive-");
      const assetRoot = await temporaryRoot("iq-adoption-fault-assets-");
      const persistence = createFakeDurableFilesystemLifecycle();
      const adapter = createPortableArchiveFilesystemAdapter({ archiveRoot, assetRoot, limits, persistence });
      const reserved = await adapter.publicationLifecycle.reserve(assetScope, {
        purpose: "asset_original",
        leaseOwner: "publisher",
        expiresAt: "2099-08-05T13:00:00.000Z"
      });
      const interruption = Object.assign(new Error("private crash /srv/private/assets"), { code: "EIO" });
      if (fault === "after_link") {
        filesystemFaultHooks.afterLink = async () => {
          throw interruption;
        };
      } else {
        filesystemFaultHooks.beforeUnlink = async (path) => {
          if (!path.endsWith(".tmp")) return false;
          throw interruption;
        };
      }
      filesystemFaultHooks.beforeRename = async (_source, target) => {
        if (!target.includes(".cleanup-")) return false;
        throw interruption;
      };

      await expectSafeFailure(adapter.publishAssetCandidate(reserved.operation, {
        content: png,
        mimeType: "image/png"
      }), "asset_storage_unavailable", ["private crash", "/srv/private/assets"]);
      filesystemFaultHooks.beforeRename = undefined;
      const interruptedFiles = await readdir(assetRoot, { recursive: true });
      expect(interruptedFiles.some((path) => path.endsWith(".asset"))).toBe(true);

      const recovered = await adapter.publicationLifecycle.recover({
        leaseOwner: "reaper",
        leaseSeconds: 30,
        limit: 1
      });
      expect(recovered).toHaveLength(1);
      if (recovered[0]?.action !== "cleanup") throw new Error("Expected cleanup recovery.");
      await expect(adapter.publicationLifecycle.markCleanup(
        recovered[0].operation,
        recovered[0].claim,
        { cause: "recovery" },
      )).resolves.toEqual({ outcome: "cleanup_pending" });
      await expect(adapter.cleanupPublishedAsset(recovered[0].operation, recovered[0].claim))
        .resolves.toEqual({ outcome: "cleaned" });
      const cleanedFiles = await readdir(assetRoot, { recursive: true });
      expect(cleanedFiles.filter((path) => path.endsWith(".asset") || path.endsWith(".tmp"))).toEqual([]);

      const retry = await adapter.publicationLifecycle.reserve(assetScope, {
        purpose: "asset_original",
        leaseOwner: "publisher",
        expiresAt: "2099-08-05T13:00:00.000Z"
      });
      await expect(adapter.publishAssetCandidate(retry.operation, {
        content: png,
        mimeType: "image/png"
      })).resolves.toEqual(expect.any(String));
    }
  );
});
