import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import sharp from "sharp";
import {
  SYSTEM_ARCHIVE_DOMAINS,
  canonicalArchiveJson,
  systemArchiveAssetsPayloadSchema,
  systemArchiveManifestSchema,
  systemArchivePayloadSchema,
  systemRecordEnvelopeSchema,
  type ArchiveEntry,
  type SystemArchiveDomain,
  type SystemRecordEnvelope,
} from "../../../packages/contracts/src/index.js";
import { calculateContentFingerprint } from "../../../packages/contracts/src/archives-node.js";
import type {
  SystemArchiveExportDependencies,
  SystemArchiveExportJob,
  SystemArchiveOriginalAssetReaderPort,
  SystemArchivePublishedArtifact,
  SystemArchiveWriterPort,
  SystemArchiveWrittenPayload,
} from "../../../packages/application/src/system-archives/ports.js";
import { runSystemExport } from "../../../packages/application/src/system-archives/use-cases.js";
import { bindPrivateBoundedStreamLimits } from "../../../packages/application/src/assets/private-secure-storage.js";
import {
  createPostgresSystemArchiveExportJobPort,
  createPostgresSystemArchiveExportRepository,
} from "../../../packages/database/src/system-archive-export-repository.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { detectImageMimeType } from "../../../packages/domain/src/image-media.js";
import { sha256 as legacySha256 } from "../../../packages/domain/src/text.js";
import {
  removeArchivePath,
  writeArchiveArtifact,
  type ArchiveArtifactEntry,
  type ArchiveLimits,
  type CompletedArchiveArtifact,
} from "../../api/src/archive-io.js";
import type { ApiAssetComposition } from "./api-asset-composition.js";
import type { SecureFilesystemAdapter } from "./secure-filesystem-adapter.js";

export type SystemArchiveStagedContent = Readonly<{
  byteLength: number;
  sha256: string;
  open(): AsyncIterable<Uint8Array>;
  cleanup(): Promise<void>;
}>;

export interface SystemArchiveStagingPort {
  stage(input: Readonly<{
    ownerUserId: string;
    maximumBytes: number;
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  }>): Promise<SystemArchiveStagedContent>;
}

type SpoolEntry = Readonly<{
  path: string;
  logicalType: "system" | "records" | "assets" | "asset-original";
  mediaType: string;
  staged: SystemArchiveStagedContent;
  byteLength: number;
  sha256: string;
}>;

export interface SystemArchiveArtifactPublisherPort {
  publishSystemArchive(input: Readonly<{
    ownerUserId: string;
    contentFingerprint: string;
    byteLength: number;
    sha256: string;
    source: AsyncIterable<Uint8Array>;
  }>): Promise<SystemArchivePublishedArtifact>;
}

export type FilesystemSystemArchiveWriter = SystemArchiveWriterPort & Readonly<{
  unpublishedArtifactCount(): Promise<number>;
}>;

export type FilesystemSystemArchiveWriterOptions = Readonly<{
  archiveRoot: string;
  limits: ArchiveLimits;
  staging: SystemArchiveStagingPort;
  now?: () => Date;
  publisher?: SystemArchiveArtifactPublisherPort;
}>;

function archiveFailure(
  code: "archive-export-inconsistent" | "archive-limit-exceeded" | "archive-asset-invalid" | "archive-asset-missing",
  message: string,
): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function requireHash(value: string, name: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw archiveFailure("archive-export-inconsistent", `${name} is invalid.`);
}

async function artifactSource(artifact: CompletedArchiveArtifact): Promise<AsyncIterable<Uint8Array>> {
  return {
    async *[Symbol.asyncIterator]() {
      const source = createReadStream(artifact.absolutePath);
      try {
        for await (const chunk of source) yield new Uint8Array(chunk);
      } finally {
        if (!source.destroyed) source.destroy();
      }
    },
  };
}

async function collectStaged(
  staged: SystemArchiveStagedContent,
  maximumBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of staged.open()) {
    const value = Buffer.from(chunk);
    byteLength += value.byteLength;
    if (!Number.isSafeInteger(byteLength) || byteLength > maximumBytes) {
      throw archiveFailure("archive-asset-invalid", "System Archive staged content exceeded its verified size.");
    }
    chunks.push(value);
  }
  if (byteLength !== staged.byteLength) {
    throw archiveFailure("archive-asset-invalid", "System Archive staged content changed while reopening.");
  }
  return Buffer.concat(chunks, byteLength);
}

export function createPrivateSystemArchiveStaging(
  storage: Pick<SecureFilesystemAdapter,
    "stagePortableScratch" | "openStagedInputSession" | "discardPortableStagedInput">,
  options: Readonly<{
    leaseOwner: string;
    expiresAt?: () => string;
    leaseSeconds?: number;
  }>,
): SystemArchiveStagingPort {
  const leaseSeconds = options.leaseSeconds ?? 300;
  return Object.freeze({
    async stage(input: Parameters<SystemArchiveStagingPort["stage"]>[0]) {
      const issued = await storage.stagePortableScratch({
        owner: { ownerUserId: input.ownerUserId },
        operationScopeId: randomUUID(),
        leaseOwner: options.leaseOwner,
        expiresAt: (options.expiresAt ?? (() => new Date(Date.now() + 60 * 60 * 1_000).toISOString()))(),
        maximumBytes: input.maximumBytes,
        source: input.source,
      });
      let cleanupPromise: Promise<void> | undefined;
      let cleaned = false;
      const cleanup = (): Promise<void> => {
        cleanupPromise ??= storage.discardPortableStagedInput({
          owner: { ownerUserId: input.ownerUserId },
          stagedInput: issued.stagedInput,
          claim: { leaseOwner: options.leaseOwner, leaseSeconds },
        }).then(() => { cleaned = true; });
        return cleanupPromise;
      };
      return Object.freeze({
        byteLength: issued.byteLength,
        sha256: issued.contentHash,
        open(): AsyncIterable<Uint8Array> {
          return {
            async *[Symbol.asyncIterator]() {
              if (cleaned || cleanupPromise) throw new Error("system_archive_staging_cleaned");
              const session = await storage.openStagedInputSession({
                owner: { ownerUserId: input.ownerUserId },
                stagedInput: issued.stagedInput,
                claim: { leaseOwner: options.leaseOwner, leaseSeconds },
                limits: bindPrivateBoundedStreamLimits({
                  maximumBytes: issued.byteLength,
                  deadlineAt: new Date(Date.now() + leaseSeconds * 1_000).toISOString(),
                }),
              });
              let reason: "eof" | "abort" | "read_failure" = "abort";
              try {
                for await (const chunk of session.chunks) yield chunk;
                reason = "eof";
              } catch (error) {
                reason = "read_failure";
                throw error;
              } finally {
                await session.finalize(reason);
              }
            },
          };
        },
        cleanup,
      });
    },
  });
}

/**
 * Runtime-only durable staging and ZIP writer. Application code never receives
 * a path or imports `node:fs`; final ZIP publication delegates to the hardened
 * Campaign Archive writer and may then pass through the durable portable publisher.
 */
export async function createFilesystemSystemArchiveWriter(
  options: FilesystemSystemArchiveWriterOptions,
): Promise<FilesystemSystemArchiveWriter> {
  if (!options.archiveRoot.trim()) throw archiveFailure("archive-export-inconsistent", "System Archive root is required.");
  const entries: SpoolEntry[] = [];
  const paths = new Set<string>();
  let ownerUserId: string | undefined;
  let state: "open" | "published" | "aborted" = "open";

  const requireOpen = () => {
    if (state !== "open") throw archiveFailure("archive-export-inconsistent", "System Archive writer is no longer open.");
  };
  const addEntry = (entry: SpoolEntry): SystemArchiveWrittenPayload => {
    if (paths.has(entry.path) || entry.path === "manifest.json") {
      throw archiveFailure("archive-export-inconsistent", "System Archive contains a duplicate or reserved path.");
    }
    paths.add(entry.path);
    entries.push(entry);
    return Object.freeze({ path: entry.path, byteLength: entry.byteLength, sha256: entry.sha256 });
  };
  const removeSpool = async () => {
    const staged = entries.splice(0).map((entry) => entry.staged);
    paths.clear();
    const settled = await Promise.allSettled(staged.map((entry) => entry.cleanup()));
    const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejected) throw rejected.reason;
  };
  const writeBufferEntry = async (
    path: string,
    logicalType: SpoolEntry["logicalType"],
    mediaType: string,
    bytes: Uint8Array,
  ): Promise<SystemArchiveWrittenPayload> => {
    requireOpen();
    if (!ownerUserId) throw archiveFailure("archive-export-inconsistent", "System Archive staging owner is unavailable.");
    const staged = await options.staging.stage({
      ownerUserId,
      maximumBytes: bytes.byteLength,
      source: [bytes],
    });
    try {
      if (staged.byteLength !== bytes.byteLength) {
        throw archiveFailure("archive-export-inconsistent", "System Archive staged metadata size changed.");
      }
      return addEntry({
        path,
        logicalType,
        mediaType,
        staged,
        byteLength: staged.byteLength,
        sha256: staged.sha256,
      });
    } catch (error) {
      await staged.cleanup().catch(() => undefined);
      throw error;
    }
  };

  const writer: FilesystemSystemArchiveWriter = {
    async writeSystemMetadata(owner) {
      if (ownerUserId && ownerUserId !== owner.sourceId) {
        throw archiveFailure("archive-export-inconsistent", "System Archive staging owner changed.");
      }
      ownerUserId = owner.sourceId;
      const value = systemArchivePayloadSchema.parse({
        formatVersion: 1,
        sourceInstallationId: owner.sourceInstallationId,
        sourceOwnerCount: 1,
        sourceOwner: { sourceId: owner.sourceId, displayName: owner.displayName },
        records: [],
      });
      return writeBufferEntry(
        "system.json",
        "system",
        "application/json",
        Buffer.from(canonicalArchiveJson(value), "utf8"),
      );
    },

    async writeDomainShards(domain, records, shardOptions) {
      requireOpen();
      if (!SYSTEM_ARCHIVE_DOMAINS.includes(domain)
        || !Number.isSafeInteger(shardOptions.targetBytes)
        || shardOptions.targetBytes < 1
        || shardOptions.targetBytes > options.limits.maxJsonEntryBytes) {
        throw archiveFailure("archive-limit-exceeded", "System Archive shard byte limit is invalid.");
      }
      if (!ownerUserId) throw archiveFailure("archive-export-inconsistent", "System Archive staging owner is unavailable.");
      const written: SystemArchiveWrittenPayload[] = [];
      let shardNumber = 1;
      const iterator = records[Symbol.asyncIterator]();
      let pending: Buffer | undefined;
      let exhausted = false;
      try {
        while (!exhausted || pending) {
          let emittedBytes = 0;
          const source: AsyncIterable<Uint8Array> = {
            async *[Symbol.asyncIterator]() {
              while (true) {
                if (!pending && !exhausted) {
                  const next = await iterator.next();
                  if (next.done) {
                    exhausted = true;
                    break;
                  }
                  const record = systemRecordEnvelopeSchema.parse(next.value);
                  if (record.domain !== domain) {
                    throw archiveFailure("archive-export-inconsistent", "System Archive shard received the wrong domain.");
                  }
                  pending = Buffer.from(`${canonicalArchiveJson(record)}\n`, "utf8");
                  if (pending.byteLength > shardOptions.targetBytes) {
                    throw archiveFailure("archive-limit-exceeded", "A System Archive record exceeds the maximum shard size.");
                  }
                }
                if (!pending || (emittedBytes > 0 && emittedBytes + pending.byteLength > shardOptions.targetBytes)) break;
                const line = pending;
                pending = undefined;
                emittedBytes += line.byteLength;
                yield line;
              }
            },
          };
          const staged = await options.staging.stage({
            ownerUserId,
            maximumBytes: shardOptions.targetBytes,
            source,
          });
          if (staged.byteLength === 0) {
            await staged.cleanup();
            break;
          }
          try {
            written.push(addEntry({
              path: `records/${domain}/${String(shardNumber++).padStart(6, "0")}.ndjson`,
              logicalType: "records",
              mediaType: "application/x-ndjson",
              staged,
              byteLength: staged.byteLength,
              sha256: staged.sha256,
            }));
          } catch (error) {
            await staged.cleanup().catch(() => undefined);
            throw error;
          }
        }
        return Object.freeze(written);
      } catch (error) {
        await iterator.return?.().catch(() => undefined);
        throw error;
      }
    },

    async writeAssetInventory(records) {
      const value = systemArchiveAssetsPayloadSchema.parse({ formatVersion: 1, assets: records });
      return writeBufferEntry(
        "assets/assets.json",
        "assets",
        "application/json",
        Buffer.from(canonicalArchiveJson(value), "utf8"),
      );
    },

    async writeOriginal(input) {
      requireOpen();
      if (!ownerUserId) throw archiveFailure("archive-export-inconsistent", "System Archive staging owner is unavailable.");
      requireHash(input.expectedSha256, "System Archive expected Original Asset hash");
      if (!Number.isSafeInteger(input.expectedBytes)
        || input.expectedBytes < 1
        || input.expectedBytes > options.limits.maxOriginalImageBytes) {
        throw archiveFailure("archive-limit-exceeded", "System Archive Original Asset byte length is invalid.");
      }
      let staged: SystemArchiveStagedContent;
      try {
        staged = await options.staging.stage({
          ownerUserId,
          maximumBytes: input.expectedBytes,
          source: input.stream,
        });
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error) throw error;
        throw archiveFailure("archive-asset-invalid", "System Archive Original Asset could not be read.");
      }
      try {
        if (staged.byteLength !== input.expectedBytes) {
          throw archiveFailure("archive-asset-invalid", "System Archive Original Asset was truncated while it was read.");
        }
        const bytes = await collectStaged(staged, input.expectedBytes);
        const legacyHash = legacySha256(bytes.toString("base64"));
        const metadata = await sharp(bytes, { failOn: "error", limitInputPixels: false }).metadata();
        if ((staged.sha256 !== input.expectedSha256 && legacyHash !== input.expectedSha256)
          || detectImageMimeType(bytes) !== input.expectedMimeType
          || metadata.width !== input.expectedPixelWidth
          || metadata.height !== input.expectedPixelHeight) {
          throw archiveFailure("archive-asset-invalid", "System Archive Original Asset identity verification failed.");
        }
        return addEntry({
          path: input.archivePath,
          logicalType: "asset-original",
          mediaType: input.expectedMimeType,
          staged,
          byteLength: staged.byteLength,
          sha256: staged.sha256,
        });
      } catch (error) {
        await staged.cleanup().catch(() => undefined);
        if (typeof error === "object" && error !== null && "code" in error) throw error;
        const failure = archiveFailure("archive-asset-invalid", "System Archive Original Asset failed image decoding.");
        failure.cause = error;
        throw failure;
      }
    },

    async calculateContentFingerprint(input) {
      return calculateContentFingerprint(input);
    },

    async publish(input) {
      requireOpen();
      requireHash(input.contentFingerprint, "System Archive content fingerprint");
      if (await input.cancellationRequested()) {
        state = "aborted";
        await removeSpool();
        return Object.freeze({ status: "cancelled" as const });
      }
      const ordered = [...entries].sort((left, right) => left.path.localeCompare(right.path));
      const calculated = calculateContentFingerprint({
        payloadHashes: ordered.filter((entry) => entry.logicalType !== "asset-original").map((entry) => entry.sha256),
        originalAssetHashes: ordered.filter((entry) => entry.logicalType === "asset-original").map((entry) => entry.sha256),
      });
      if (calculated !== input.contentFingerprint) {
        throw archiveFailure("archive-export-inconsistent", "System Archive fingerprint does not match its written entries.");
      }
      const archiveEntries: ArchiveArtifactEntry[] = ordered.map((entry) => ({
        path: entry.path,
        logicalType: entry.logicalType,
        mediaType: entry.mediaType,
        source: Readable.from(entry.staged.open()),
      }));
      const createdAt = (options.now ?? (() => new Date()))().toISOString();
      const buildManifest = (measuredEntries: readonly ArchiveEntry[]) => systemArchiveManifestSchema.parse({
        format: "infinite-quest-archive",
        formatVersion: 1,
        archiveType: "system",
        createdAt,
        contentFingerprint: input.contentFingerprint,
        sourceInstallationId: input.manifest.sourceInstallationId,
        sourceOwnerCount: 1,
        sourceOwner: {
          sourceId: input.manifest.sourceOwner.sourceId,
          displayName: input.manifest.sourceOwner.displayName,
        },
        entries: [...measuredEntries],
        payloads: ordered
          .filter((entry) => entry.logicalType !== "asset-original")
          .map((entry) => ({
            kind: entry.logicalType,
            path: entry.path,
            formatVersion: 1,
          })),
        assets: [...input.manifest.assets],
      });
      buildManifest(ordered.map(({ path, logicalType, mediaType, byteLength, sha256 }) => ({
        path,
        logicalType,
        mediaType,
        byteLength,
        sha256,
      })));
      let local: CompletedArchiveArtifact | undefined;
      try {
        local = await writeArchiveArtifact(
          options.archiveRoot,
          archiveEntries,
          buildManifest,
          options.limits,
          (value) => systemArchiveManifestSchema.parse(value),
        );
        if (local.contentFingerprint !== input.contentFingerprint) {
          throw archiveFailure("archive-export-inconsistent", "Published System Archive fingerprint changed.");
        }
        if (options.publisher && await input.cancellationRequested()) {
          await removeArchivePath(options.archiveRoot, local.relativePath);
          local = undefined;
          state = "aborted";
          await removeSpool();
          return Object.freeze({ status: "cancelled" as const });
        }
        let published: SystemArchivePublishedArtifact;
        if (options.publisher) {
          const source = await artifactSource(local);
          published = await options.publisher.publishSystemArchive({
            ownerUserId: input.manifest.sourceOwner.sourceId,
            contentFingerprint: input.contentFingerprint,
            byteLength: local.byteLength,
            sha256: local.sha256,
            source,
          });
          if (published.contentFingerprint !== input.contentFingerprint) {
            throw archiveFailure("archive-export-inconsistent", "Durable System Archive publication changed its fingerprint.");
          }
          await removeArchivePath(options.archiveRoot, local.relativePath);
        } else {
          published = Object.freeze({
            relativePath: local.relativePath,
            absolutePath: local.absolutePath,
            byteLength: local.byteLength,
            sha256: local.sha256,
            contentFingerprint: local.contentFingerprint,
          });
        }
        state = "published";
        // Durable portable staging retains cleanup authority for restart
        // recovery, so a finalized export is never downgraded if immediate
        // scratch cleanup must be retried by the reaper.
        await removeSpool().catch(() => undefined);
        return Object.freeze({ status: "published" as const, artifact: published });
      } catch (error) {
        if (local && options.publisher) {
          await removeArchivePath(options.archiveRoot, local.relativePath).catch(() => undefined);
        }
        state = "aborted";
        await removeSpool().catch(() => undefined);
        throw error;
      }
    },

    async abort() {
      if (state !== "open") return;
      state = "aborted";
      await removeSpool();
    },

    async unpublishedArtifactCount() {
      return state === "open" ? entries.length : 0;
    },
  };
  return Object.freeze(writer);
}

/** Private descriptor-anchored Original Asset reader reused by System Export. */
export function createSystemArchiveOriginalAssetReader(
  assets: Pick<ApiAssetComposition, "storage">,
): SystemArchiveOriginalAssetReaderPort {
  return Object.freeze({
    async openOriginal(input: Parameters<SystemArchiveOriginalAssetReaderPort["openOriginal"]>[0]) {
      const session = await assets.storage.adapter.openAssetSession({
        scope: { ownerUserId: input.owner.ownerUserId, assetId: input.asset.sourceAssetId },
        request: { kind: "original" },
        limits: bindPrivateBoundedStreamLimits({
          maximumBytes: input.maximumBytes,
          deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      });
      if (!session) {
        throw archiveFailure("archive-asset-missing", "System Archive Original Asset was not found.");
      }
      return {
        async *[Symbol.asyncIterator]() {
          try {
            for await (const chunk of session.chunks) yield chunk;
            await session.finalize("eof");
          } catch (error) {
            await session.finalize("read_failure").catch(() => undefined);
            if (typeof error === "object" && error !== null && "code" in error) throw error;
            throw archiveFailure("archive-asset-invalid", "System Archive Original Asset changed during its private read.");
          }
        },
      };
    },
  });
}

export type SystemArchiveCompositionOptions = Readonly<{
  pool: DatabasePool;
  archiveRoot: string;
  limits: ArchiveLimits;
  originals: SystemArchiveOriginalAssetReaderPort;
  storage: Pick<SecureFilesystemAdapter,
    "stagePortableScratch" | "openStagedInputSession" | "discardPortableStagedInput">;
  publisher: SystemArchiveArtifactPublisherPort;
  now?: () => Date;
}>;

/** Feature-disabled worker composition; Task 6 owns wiring and worker scheduling. */
export function createSystemArchiveComposition(options: SystemArchiveCompositionOptions): Readonly<{
  runSystemExport(job: SystemArchiveExportJob): Promise<import("../../../packages/application/src/system-archives/ports.js").SystemArchiveExportResult>;
}> {
  const snapshots = createPostgresSystemArchiveExportRepository(options.pool);
  const jobs = createPostgresSystemArchiveExportJobPort(options.pool);
  return Object.freeze({
    async runSystemExport(job) {
      const writer = await createFilesystemSystemArchiveWriter({
        archiveRoot: options.archiveRoot,
        limits: options.limits,
        staging: createPrivateSystemArchiveStaging(options.storage, { leaseOwner: job.leaseOwner }),
        publisher: options.publisher,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      const dependencies: SystemArchiveExportDependencies = {
        snapshots,
        originals: options.originals,
        writer,
        jobs,
        ...(options.now === undefined ? {} : { now: options.now }),
      };
      return runSystemExport(job, dependencies);
    },
  });
}
