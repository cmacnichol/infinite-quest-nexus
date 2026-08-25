import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SYSTEM_ARCHIVE_DOMAINS } from "../../packages/contracts/src/system-archives.js";
import { toPortableArchiveExportRetrieval } from "../../packages/application/src/imports/types.js";
import { createPostgresImportRepository } from "../../packages/database/src/import-repository.js";
import { createSystemArchiveAssetStorageComposition } from "../../services/runtime/src/api-asset-composition.js";
import {
  createFilesystemSystemArchiveWriter,
  createPrivateSystemArchiveStaging,
  type SystemArchiveStagedContent,
  type SystemArchiveStagingPort,
} from "../../services/runtime/src/system-archive-composition.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const limits = {
  maxCompressedBytes: 20 * 1024 * 1024,
  maxUncompressedBytes: 50 * 1024 * 1024,
  maxEntries: 10_000,
  maxManifestBytes: 1024 * 1024,
  maxJsonEntryBytes: 1024 * 1024,
  maxExpansionRatio: 100,
  maxOriginalImageBytes: 25 * 1024 * 1024,
} as const;
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
function memoryStaging(): SystemArchiveStagingPort & Readonly<{ activeCount(): number }> {
  const active = new Set<SystemArchiveStagedContent>();
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
      const staged: SystemArchiveStagedContent = Object.freeze({
        byteLength,
        sha256: sha256(bytes),
        open(): AsyncIterable<Uint8Array> {
          return {
            async *[Symbol.asyncIterator]() {
              yield bytes;
            },
          };
        },
        async cleanup() {
          active.delete(staged);
        },
      });
      active.add(staged);
      return staged;
    },
    activeCount() {
      return active.size;
    },
  });
}

describe("System Archive durable writer composition", () => {
  it("captures the existing private asset-publication boundary and closes storage once", async () => {
    const close = vi.fn(async () => undefined);
    const publication = { identity: "private-test-double" };
    const createStorage = vi.fn(async (
      _pool: unknown,
      _roots: unknown,
      capture?: (value: unknown) => void,
    ) => {
      capture?.(publication);
      return { close };
    });

    const composition = await createSystemArchiveAssetStorageComposition(
      {} as never,
      { archiveRoot: "archive", assetRoot: "assets" },
      { createStorage: createStorage as never },
    );

    expect(composition.assetPublications).toBe(publication);
    await composition.close();
    await composition.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes storage when private asset-publication authority cannot be captured", async () => {
    const close = vi.fn(async () => undefined);

    await expect(createSystemArchiveAssetStorageComposition(
      {} as never,
      { archiveRoot: "archive", assetRoot: "assets" },
      { createStorage: vi.fn(async () => ({ close })) as never },
    )).rejects.toThrow("system_archive_asset_publication_unavailable");

    expect(close).toHaveBeenCalledOnce();
  });

  it("retrieves an owner-wide system artifact with null-safe portable scope matching", async () => {
    const contentHash = sha256("zip");
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT artifact.id AS artifact_id")) {
        const nullSafe = sql.includes("artifact.world_id IS NOT DISTINCT FROM $5::uuid")
          && sql.includes("artifact.world_version_id IS NOT DISTINCT FROM $6::uuid");
        return {
          rowCount: nullSafe ? 1 : 0,
          rows: nullSafe ? [{
            artifact_id: "22222222-2222-4222-8222-222222222222",
            content_type: "application/zip",
            artifact_content_hash: contentHash,
            artifact_byte_length: "3",
            expires_at: new Date("2026-08-26T12:00:00.000Z"),
            relative_path: "portable/system.zip",
            device_id: "1",
            file_id: "2",
            change_token: "3",
            content_hash: contentHash,
            byte_length: "3",
          }] : [],
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const client = { query, release: vi.fn() };
    const repository = createPostgresImportRepository({
      connect: vi.fn(async () => client),
    } as never);

    const artifact = await repository.retrieveExportArtifact({
      ownerUserId,
      exportKind: "system_zip",
      campaignId: null,
      worldId: null,
      worldVersionId: null,
    }, toPortableArchiveExportRetrieval("opaque-system-retrieval"));

    expect(artifact).toMatchObject({
      contentType: "application/zip",
      contentHash,
      byteLength: 3,
    });
  });

  it("stages the final ZIP durably until the published artifact is linked", async () => {
    const staging = memoryStaging();
    let publishedZip = Buffer.alloc(0);
    const writer = await createFilesystemSystemArchiveWriter({
      limits,
      staging,
      publisher: {
        async publishSystemArchive(input) {
          expect(staging.activeCount()).toBe(2);
          const chunks: Buffer[] = [];
          for await (const chunk of input.source) chunks.push(Buffer.from(chunk));
          publishedZip = Buffer.concat(chunks);
          return Object.freeze({
            artifactId: randomUUID(),
            relativePath: `portable/${randomUUID()}.zip`,
            byteLength: input.byteLength,
            sha256: input.sha256,
          });
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

    const result = await writer.publish({
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
        excludedOperationalWork: {
          generation: 0,
          illustration: 0,
          chronicle: 0,
          imports: 0,
          "system-archive": 0,
        },
        assets: [],
      },
      contentFingerprint,
      cancellationRequested: async () => false,
    });

    expect(result.status).toBe("published");
    expect(publishedZip.subarray(0, 2).toString("ascii")).toBe("PK");
    expect(staging.activeCount()).toBe(2);

    await writer.cleanupPublishedStaging();
    expect(staging.activeCount()).toBe(0);
  });

  it("derives scratch expiry and a later reopen deadline from the configured artifact lifetime", async () => {
    const stagePortableScratch = vi.fn(async () => ({
      stagedInput: "staged-input" as never,
      operation: {} as never,
      claim: {} as never,
      byteLength: 3,
      contentHash: sha256("abc"),
    }));
    const openStagedInputSession = vi.fn(async () => ({
      chunks: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from("abc");
        },
      },
      finalize: vi.fn(async () => undefined),
    }));
    const now = vi.fn()
      .mockReturnValueOnce(new Date("2026-08-25T12:00:00.000Z"))
      .mockReturnValueOnce(new Date("2026-08-25T18:00:00.000Z"));
    const staging = createPrivateSystemArchiveStaging({
      stagePortableScratch,
      openStagedInputSession: openStagedInputSession as never,
      discardPortableStagedInput: vi.fn(async () => undefined),
    }, {
      leaseOwner: "system-archive-lifetime-test",
      artifactTtlSeconds: 86_400,
      now,
    });

    const staged = await staging.stage({
      ownerUserId,
      maximumBytes: 3,
      source: [Buffer.from("abc")],
    });
    for await (const _chunk of staged.open()) {
      // Consume the bounded durable stage.
    }

    expect(stagePortableScratch).toHaveBeenCalledWith(expect.objectContaining({
      expiresAt: "2026-08-26T12:00:00.000Z",
    }));
    expect(openStagedInputSession).toHaveBeenCalledWith(expect.objectContaining({
      limits: expect.objectContaining({
        deadlineAt: "2026-08-26T18:00:00.000Z",
      }),
    }));
    expect(now).toHaveBeenCalledTimes(2);
  });

  it("cannot reject a finalized artifact because the publisher repeats logical fingerprint metadata", async () => {
    const staging = memoryStaging();
    const writer = await createFilesystemSystemArchiveWriter({
      limits,
      staging,
      publisher: {
        async publishSystemArchive(input) {
          for await (const _chunk of input.source) {
            // Consume the finalized durable staging source.
          }
          return Object.freeze({
            artifactId: randomUUID(),
            relativePath: `portable/${randomUUID()}.zip`,
            byteLength: input.byteLength,
            sha256: input.sha256,
          });
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

    const publication = await writer.publish({
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
        excludedOperationalWork: {
          generation: 0,
          illustration: 0,
          chronicle: 0,
          imports: 0,
          "system-archive": 0,
        },
        assets: [],
      },
      contentFingerprint,
      cancellationRequested: async () => false,
    });

    expect(publication).toMatchObject({
      status: "published",
      artifact: { contentFingerprint },
    });
  });

  it("allows durable scratch cleanup to retry after a transient failure", async () => {
    const discardPortableStagedInput = vi.fn()
      .mockRejectedValueOnce(new Error("cleanup deferred"))
      .mockResolvedValueOnce(undefined);
    const staging = createPrivateSystemArchiveStaging({
      stagePortableScratch: vi.fn(async () => ({
        stagedInput: "staged-input" as never,
        operation: {} as never,
        claim: {} as never,
        byteLength: 3,
        contentHash: sha256("abc"),
      })),
      openStagedInputSession: vi.fn() as never,
      discardPortableStagedInput,
    }, {
      leaseOwner: "system-archive-cleanup-retry-test",
      artifactTtlSeconds: 86_400,
      now: () => new Date("2026-08-25T12:00:00.000Z"),
    });
    const staged = await staging.stage({
      ownerUserId,
      maximumBytes: 3,
      source: [Buffer.from("abc")],
    });

    await expect(staged.cleanup()).rejects.toThrow("cleanup deferred");
    await expect(staged.cleanup()).resolves.toBeUndefined();
    expect(discardPortableStagedInput).toHaveBeenCalledTimes(2);
  });
});
