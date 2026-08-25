import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, unlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

type SpoolEntry = Readonly<{
  path: string;
  logicalType: "system" | "records" | "assets" | "asset-original";
  mediaType: string;
  filePath: string;
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

function safeSpoolName(sequence: number): string {
  return `${String(sequence).padStart(8, "0")}.entry`;
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (written.bytesWritten < 1) throw archiveFailure("archive-export-inconsistent", "System Archive spool write stalled.");
    offset += written.bytesWritten;
  }
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

/**
 * Runtime-only spool and ZIP writer. Application code never receives a path or
 * imports `node:fs`; final ZIP publication delegates to the hardened Campaign
 * Archive writer and may then pass through the durable portable publisher.
 */
export async function createFilesystemSystemArchiveWriter(
  options: FilesystemSystemArchiveWriterOptions,
): Promise<FilesystemSystemArchiveWriter> {
  if (!options.archiveRoot.trim()) throw archiveFailure("archive-export-inconsistent", "System Archive root is required.");
  const spoolRoot = await mkdtemp(join(tmpdir(), "infinitequest-system-export-"));
  await mkdir(spoolRoot, { recursive: true });
  const entries: SpoolEntry[] = [];
  const paths = new Set<string>();
  let sequence = 0;
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
    await rm(spoolRoot, { recursive: true, force: true });
    entries.length = 0;
    paths.clear();
  };
  const writeBufferEntry = async (
    path: string,
    logicalType: SpoolEntry["logicalType"],
    mediaType: string,
    bytes: Uint8Array,
  ): Promise<SystemArchiveWrittenPayload> => {
    requireOpen();
    const filePath = join(spoolRoot, safeSpoolName(sequence++));
    const handle = await open(filePath, "wx", 0o600);
    try {
      await writeAll(handle, bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return addEntry({
      path,
      logicalType,
      mediaType,
      filePath,
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  };

  const writer: FilesystemSystemArchiveWriter = {
    async writeSystemMetadata(owner) {
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
      const written: SystemArchiveWrittenPayload[] = [];
      let shardNumber = 1;
      let handle: FileHandle | undefined;
      let filePath = "";
      let byteLength = 0;
      let digest = createHash("sha256");

      const start = async () => {
        filePath = join(spoolRoot, safeSpoolName(sequence++));
        handle = await open(filePath, "wx", 0o600);
        byteLength = 0;
        digest = createHash("sha256");
      };
      const finish = async () => {
        if (!handle || byteLength === 0) return;
        await handle.sync();
        await handle.close();
        handle = undefined;
        written.push(addEntry({
          path: `records/${domain}/${String(shardNumber++).padStart(6, "0")}.ndjson`,
          logicalType: "records",
          mediaType: "application/x-ndjson",
          filePath,
          byteLength,
          sha256: digest.digest("hex"),
        }));
      };

      try {
        for await (const candidate of records) {
          const record = systemRecordEnvelopeSchema.parse(candidate);
          if (record.domain !== domain) {
            throw archiveFailure("archive-export-inconsistent", "System Archive shard received the wrong domain.");
          }
          const line = Buffer.from(`${canonicalArchiveJson(record)}\n`, "utf8");
          if (line.byteLength > shardOptions.targetBytes) {
            throw archiveFailure("archive-limit-exceeded", "A System Archive record exceeds the maximum shard size.");
          }
          if (handle && byteLength + line.byteLength > shardOptions.targetBytes) await finish();
          if (!handle) await start();
          await writeAll(handle!, line);
          byteLength += line.byteLength;
          digest.update(line);
        }
        await finish();
        return Object.freeze(written);
      } catch (error) {
        if (handle) await handle.close().catch(() => undefined);
        if (filePath) await unlink(filePath).catch(() => undefined);
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
      requireHash(input.expectedSha256, "System Archive expected Original Asset hash");
      if (!Number.isSafeInteger(input.expectedBytes)
        || input.expectedBytes < 1
        || input.expectedBytes > options.limits.maxOriginalImageBytes) {
        throw archiveFailure("archive-limit-exceeded", "System Archive Original Asset byte length is invalid.");
      }
      const filePath = join(spoolRoot, safeSpoolName(sequence++));
      const handle = await open(filePath, "wx", 0o600);
      const digest = createHash("sha256");
      let byteLength = 0;
      try {
        for await (const chunk of input.stream) {
          const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          const nextLength = byteLength + bytes.byteLength;
          if (!Number.isSafeInteger(nextLength) || nextLength > input.expectedBytes) {
            throw archiveFailure("archive-asset-invalid", "System Archive Original Asset grew while it was read.");
          }
          await writeAll(handle, bytes);
          digest.update(bytes);
          byteLength = nextLength;
        }
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(filePath).catch(() => undefined);
        if (typeof error === "object" && error !== null && "code" in error) throw error;
        throw archiveFailure("archive-asset-invalid", "System Archive Original Asset could not be read.");
      }
      await handle.close();
      if (byteLength !== input.expectedBytes) {
        await unlink(filePath).catch(() => undefined);
        throw archiveFailure("archive-asset-invalid", "System Archive Original Asset was truncated while it was read.");
      }
      const rawHash = digest.digest("hex");
      const bytes = await readFile(filePath);
      const legacyHash = legacySha256(bytes.toString("base64"));
      try {
        const metadata = await sharp(bytes, { failOn: "error", limitInputPixels: false }).metadata();
        if ((rawHash !== input.expectedSha256 && legacyHash !== input.expectedSha256)
          || detectImageMimeType(bytes) !== input.expectedMimeType
          || metadata.width !== input.expectedPixelWidth
          || metadata.height !== input.expectedPixelHeight) {
          throw archiveFailure("archive-asset-invalid", "System Archive Original Asset identity verification failed.");
        }
      } catch (error) {
        await unlink(filePath).catch(() => undefined);
        if (typeof error === "object" && error !== null && "code" in error) throw error;
        const failure = archiveFailure("archive-asset-invalid", "System Archive Original Asset failed image decoding.");
        failure.cause = error;
        throw failure;
      }
      return addEntry({
        path: input.archivePath,
        logicalType: "asset-original",
        mediaType: input.expectedMimeType,
        filePath,
        byteLength,
        sha256: rawHash,
      });
    },

    async calculateContentFingerprint(input) {
      return calculateContentFingerprint(input);
    },

    async publish(input) {
      requireOpen();
      requireHash(input.contentFingerprint, "System Archive content fingerprint");
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
        source: createReadStream(entry.filePath),
      }));
      const createdAt = (options.now ?? (() => new Date()))().toISOString();
      const buildManifest = (measuredEntries: readonly ArchiveEntry[]) => systemArchiveManifestSchema.parse({
        format: "infinite-quest-archive",
        formatVersion: 1,
        archiveType: "system",
        createdAt,
        contentFingerprint: input.contentFingerprint,
        sourceOwnerCount: 1,
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
        await removeSpool();
        return published;
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
