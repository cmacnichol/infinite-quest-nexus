import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { Readable } from "node:stream";
import sharp from "sharp";
import type { Metadata as SharpMetadata } from "sharp";
import {
  SYSTEM_ARCHIVE_DOMAINS,
  canonicalArchiveJson,
  systemArchiveAssetsPayloadSchema,
  systemArchiveManifestSchema,
  systemArchivePayloadSchema,
  systemRecordEnvelopeSchema,
  type ArchiveEntry,
  type ArchiveErrorCode,
  type ArchiveAssetRecord,
  type SystemArchiveDomain,
  type SystemArchiveUploadView,
  type SystemImportPreviewView,
  type SystemRecordEnvelope,
  systemImportPreviewViewSchema,
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
import type { SystemArchiveImportRepository } from "../../../packages/database/src/system-archive-import-repository.js";
import { createPostgresSystemArchiveImportRepository } from "../../../packages/database/src/system-archive-import-repository.js";
import type {
  SystemArchiveUploadAssembly,
  SystemArchiveUploadRepository,
} from "../../../packages/database/src/system-archive-upload-repository.js";
import { createPostgresSystemArchiveUploadRepository } from "../../../packages/database/src/system-archive-upload-repository.js";
import { createPostgresSystemArchivePrivateStorageRepository } from "../../../packages/database/src/system-archive-private-storage-repository.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { detectImageMimeType } from "../../../packages/domain/src/image-media.js";
import { sha256 as legacySha256 } from "../../../packages/domain/src/text.js";
import {
  ArchiveError,
  consumeVerifiedContainerEntry,
  createArchiveArtifactSource,
  inspectArchiveContainer,
  rehydratePersistedAnchoredStagedArchive,
  readVerifiedContainerEntry,
  releaseAnchoredStagedArchive,
  type ArchiveArtifactEntry,
  type ArchiveLimits,
  type StagedArchive,
} from "../../api/src/archive-io.js";
import type { ApiAssetComposition } from "./api-asset-composition.js";
import type { SecureFilesystemAdapter } from "./secure-filesystem-adapter.js";
import { SystemArchivePreviewIndex } from "./system-archive-preview-index.js";

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
  }>): Promise<Omit<SystemArchivePublishedArtifact, "contentFingerprint">>;
}

export type FilesystemSystemArchiveWriter = SystemArchiveWriterPort & Readonly<{
  unpublishedArtifactCount(): Promise<number>;
}>;

export type FilesystemSystemArchiveWriterOptions = Readonly<{
  limits: ArchiveLimits;
  staging: SystemArchiveStagingPort;
  now?: () => Date;
  publisher: SystemArchiveArtifactPublisherPort;
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

export type SystemArchiveInspection = Readonly<{
  formatVersion: 1;
  sourceApplication: string;
  sourceMigration: string;
  archiveFingerprint: string;
  sourceInstallationId: string;
  sourceOwnerId: string;
  sourceOwnerCount: 1;
  recordsByDomain: Readonly<Record<SystemArchiveDomain, number>>;
  assetCount: number;
  assetBytes: number;
  disabledProviderCount: number;
  invalidatedAccess: readonly string[];
  normalization: readonly string[];
  rebuilds: readonly string[];
}>;

function importFailure(code: ArchiveErrorCode, message: string): ArchiveError {
  return new ArchiveError(code, message);
}

function normalizedPath(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("en-US");
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch (error) {
    const failure = importFailure("archive-json-invalid", `${label} is not valid UTF-8 JSON.`);
    failure.cause = error;
    throw failure;
  }
}

const MAX_SYSTEM_RECORD_BYTES = 256 * 1024 * 1024;

async function consumeSystemRecordShard(
  source: AsyncIterable<Uint8Array>,
  domain: SystemArchiveDomain,
  index: SystemArchivePreviewIndex,
  assetIds: ReadonlySet<string>,
): Promise<void> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let pendingBytes = 0;
  const append = (value: string) => {
    pendingBytes += Buffer.byteLength(value, "utf8");
    if (pendingBytes > MAX_SYSTEM_RECORD_BYTES) {
      throw importFailure("archive-limit-exceeded", "A System Archive logical record exceeds its bounded size.");
    }
    pending += value;
  };
  const acceptLine = () => {
    if (!pending) throw importFailure("archive-json-invalid", "System Archive NDJSON contains an empty record.");
    let raw: unknown;
    try {
      raw = JSON.parse(pending) as unknown;
    } catch (error) {
      const failure = importFailure("archive-json-invalid", "System Archive record is not valid JSON.");
      failure.cause = error;
      throw failure;
    }
    const parsed = systemRecordEnvelopeSchema.safeParse(raw);
    if (!parsed.success || parsed.data.domain !== domain || parsed.data.sourceId !== parsed.data.record.sourceId) {
      throw importFailure("archive-json-invalid", "System Archive record does not match its shard contract.");
    }
    index.add(parsed.data, assetIds);
    pending = "";
    pendingBytes = 0;
  };

  try {
    for await (const chunk of source) {
      const text = decoder.decode(chunk, { stream: true });
      let start = 0;
      for (let newline = text.indexOf("\n", start); newline !== -1; newline = text.indexOf("\n", start)) {
        append(text.slice(start, newline));
        acceptLine();
        start = newline + 1;
      }
      append(text.slice(start));
    }
    append(decoder.decode());
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    const failure = importFailure("archive-json-invalid", "System Archive NDJSON is not valid UTF-8.");
    failure.cause = error;
    throw failure;
  }
  if (pendingBytes !== 0) {
    throw importFailure("archive-json-invalid", "System Archive NDJSON is truncated.");
  }
}

async function inspectOriginalStream(source: AsyncIterable<Uint8Array>): Promise<Readonly<{
  legacyHash: string;
  signature: Buffer;
}>> {
  const legacy = createHash("sha256");
  let carry = Buffer.alloc(0);
  let signature = Buffer.alloc(0);
  for await (const chunk of source) {
    const value = Buffer.from(chunk);
    if (signature.byteLength < 16) {
      signature = Buffer.concat([signature, value.subarray(0, 16 - signature.byteLength)]);
    }
    const combined = carry.byteLength === 0 ? value : Buffer.concat([carry, value]);
    const completeBytes = combined.byteLength - (combined.byteLength % 3);
    if (completeBytes > 0) legacy.update(combined.subarray(0, completeBytes).toString("base64"));
    carry = Buffer.from(combined.subarray(completeBytes));
  }
  if (carry.byteLength > 0) legacy.update(carry.toString("base64"));
  return Object.freeze({ legacyHash: legacy.digest("hex"), signature });
}

async function inspectOriginalMetadata(source: AsyncIterable<Uint8Array>): Promise<SharpMetadata> {
  const image = sharp({ failOn: "error", limitInputPixels: false });
  const metadata = image.metadata();
  try {
    for await (const chunk of source) {
      if (!image.write(Buffer.from(chunk))) await once(image, "drain");
    }
    image.end();
    return await metadata;
  } catch (error) {
    image.destroy();
    throw error;
  }
}

/**
 * Fully validates a privately staged System Archive without creating or
 * changing application authority. The returned projection contains only
 * counts, identifiers needed for owner remapping, and fixed safe diagnostics.
 */
export async function inspectSystemArchiveForPreview(
  staged: StagedArchive,
  limits: ArchiveLimits,
): Promise<SystemArchiveInspection> {
  const container = await inspectArchiveContainer(staged, limits);
  const manifestBytes = await readVerifiedContainerEntry(container, "manifest.json", limits.maxManifestBytes);
  const rawManifest = parseJson(manifestBytes, "System Archive manifest");
  if (typeof rawManifest !== "object" || rawManifest === null || Array.isArray(rawManifest)) {
    throw importFailure("archive-format-unrecognized", "System Archive manifest is not recognized.");
  }
  const candidate = rawManifest as Record<string, unknown>;
  if (candidate.format !== "infinite-quest-archive" || candidate.archiveType !== "system") {
    throw importFailure("archive-format-unrecognized", "System Archive manifest is not recognized.");
  }
  if (candidate.formatVersion !== 1) {
    throw importFailure("archive-version-unsupported", "System Archive format version is unsupported.");
  }
  if (candidate.sourceOwnerCount !== 1) {
    throw importFailure("archive-owner-count-unsupported", "System Archive format version 1 requires exactly one source owner.");
  }
  const parsedManifest = systemArchiveManifestSchema.safeParse(rawManifest);
  if (!parsedManifest.success) {
    throw importFailure("archive-json-invalid", "System Archive manifest does not match the required schema.");
  }
  const manifest = parsedManifest.data;
  const declaredPaths = new Set(manifest.entries.map((entry) => normalizedPath(entry.path)));
  const manifestEntriesByPath = new Map(
    manifest.entries.map((entry) => [normalizedPath(entry.path), entry] as const),
  );
  const expectedPayloads = manifest.entries
    .filter((entry) => entry.logicalType !== "asset-original")
    .map((entry) => ({ kind: entry.logicalType, path: entry.path, formatVersion: 1 }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const declaredPayloads = [...manifest.payloads].sort((left, right) => left.path.localeCompare(right.path));
  if (canonicalArchiveJson(expectedPayloads) !== canonicalArchiveJson(declaredPayloads)) {
    throw importFailure("archive-json-invalid", "System Archive payload declarations are incomplete or inconsistent.");
  }
  if (declaredPaths.size + 1 !== container.entries.size
    || !container.entries.has("manifest.json")
    || [...container.entries.keys()].some((path) => path !== "manifest.json" && !declaredPaths.has(path))) {
    throw importFailure("archive-entry-missing", "System Archive entries do not exactly match the manifest.");
  }

  const index = await SystemArchivePreviewIndex.create();
  const assetIds = new Set(manifest.assets.map((asset) => asset.sourceAssetId));
  let systemPayload: ReturnType<typeof systemArchivePayloadSchema.parse> | undefined;
  let assetsPayload: ReturnType<typeof systemArchiveAssetsPayloadSchema.parse> | undefined;
  const originalsByPath = new Map<string, Readonly<{
    actualHash: string;
    legacyHash: string;
    signature: Buffer;
  }>>();
  const payloadHashes: string[] = [];
  const originalAssetHashes: string[] = [];
  let recordsByDomain: Readonly<Record<SystemArchiveDomain, number>>;
  let assetBytes = 0;
  try {
    for (const entry of manifest.entries) {
      const maximumBytes = entry.logicalType === "asset-original"
        ? limits.maxOriginalImageBytes
        : limits.maxJsonEntryBytes;
      const containerEntry = container.entries.get(normalizedPath(entry.path));
      if (!containerEntry) throw importFailure("archive-entry-missing", "A declared System Archive entry is missing.");
      if (entry.byteLength > maximumBytes || containerEntry.uncompressedBytes > maximumBytes) {
        throw importFailure("archive-limit-exceeded", "A System Archive entry exceeds its configured byte limit.");
      }
      if (containerEntry.uncompressedBytes !== entry.byteLength) {
        throw importFailure("archive-checksum-mismatch", "A System Archive entry does not match its declared byte length.");
      }

      if (entry.logicalType === "asset-original") {
        const streamed = await consumeVerifiedContainerEntry(
          container,
          entry.path,
          maximumBytes,
          inspectOriginalStream,
        );
        if (streamed.byteLength !== entry.byteLength || streamed.sha256 !== entry.sha256) {
          throw importFailure("archive-checksum-mismatch", "A System Archive entry does not match its manifest checksum.");
        }
        originalAssetHashes.push(streamed.sha256);
        originalsByPath.set(normalizedPath(entry.path), Object.freeze({
          actualHash: streamed.sha256,
          legacyHash: streamed.value.legacyHash,
          signature: streamed.value.signature,
        }));
        continue;
      }

      if (entry.path === "system.json" && entry.logicalType === "system" && entry.mediaType === "application/json") {
        const bytes = await readVerifiedContainerEntry(container, entry.path, maximumBytes);
        const actualHash = createHash("sha256").update(bytes).digest("hex");
        if (bytes.byteLength !== entry.byteLength || actualHash !== entry.sha256) {
          throw importFailure("archive-checksum-mismatch", "A System Archive entry does not match its manifest checksum.");
        }
        payloadHashes.push(actualHash);
        const parsed = systemArchivePayloadSchema.safeParse(parseJson(bytes, "System Archive system payload"));
        if (!parsed.success || parsed.data.records.length !== 0) {
          throw importFailure("archive-json-invalid", "System Archive system payload does not match the required schema.");
        }
        systemPayload = parsed.data;
        continue;
      }
      if (entry.path === "assets/assets.json" && entry.logicalType === "assets" && entry.mediaType === "application/json") {
        const bytes = await readVerifiedContainerEntry(container, entry.path, maximumBytes);
        const actualHash = createHash("sha256").update(bytes).digest("hex");
        if (bytes.byteLength !== entry.byteLength || actualHash !== entry.sha256) {
          throw importFailure("archive-checksum-mismatch", "A System Archive entry does not match its manifest checksum.");
        }
        payloadHashes.push(actualHash);
        const parsed = systemArchiveAssetsPayloadSchema.safeParse(parseJson(bytes, "System Archive asset inventory"));
        if (!parsed.success) {
          throw importFailure("archive-json-invalid", "System Archive asset inventory does not match the required schema.");
        }
        assetsPayload = parsed.data;
        continue;
      }
      const match = /^records\/([^/]+)\/\d{6}\.ndjson$/u.exec(entry.path);
      if (!match || entry.logicalType !== "records" || entry.mediaType !== "application/x-ndjson"
        || !SYSTEM_ARCHIVE_DOMAINS.includes(match[1] as SystemArchiveDomain)) {
        throw importFailure("archive-json-invalid", "System Archive contains an unexpected logical entry.");
      }
      const domain = match[1] as SystemArchiveDomain;
      const streamed = await consumeVerifiedContainerEntry(
        container,
        entry.path,
        maximumBytes,
        (source) => consumeSystemRecordShard(source, domain, index, assetIds),
      );
      if (streamed.byteLength !== entry.byteLength || streamed.sha256 !== entry.sha256) {
        throw importFailure("archive-checksum-mismatch", "A System Archive entry does not match its manifest checksum.");
      }
      payloadHashes.push(streamed.sha256);
    }

    if (!systemPayload || !assetsPayload
      || canonicalArchiveJson(assetsPayload.assets) !== canonicalArchiveJson(manifest.assets)
      || systemPayload.sourceInstallationId !== manifest.sourceInstallationId
      || systemPayload.sourceOwner.sourceId !== manifest.sourceOwner.sourceId
      || systemPayload.sourceOwner.displayName !== manifest.sourceOwner.displayName) {
      throw importFailure("archive-world-mismatch", "System Archive manifest and logical payloads are inconsistent.");
    }
    const calculatedFingerprint = calculateContentFingerprint({ payloadHashes, originalAssetHashes });
    if (calculatedFingerprint !== manifest.contentFingerprint) {
      throw importFailure("archive-checksum-mismatch", "System Archive content fingerprint does not match its verified entries.");
    }

    const uniqueOriginals = new Set<string>();
    for (const asset of manifest.assets) {
      const path = normalizedPath(asset.archivePath);
      const streamed = originalsByPath.get(path);
      if (!streamed) throw importFailure("archive-asset-missing", "A System Archive Original Asset is missing.");
      const entry = manifestEntriesByPath.get(path);
      try {
        if (!entry || entry.logicalType !== "asset-original"
          || entry.byteLength !== asset.byteLength
          || entry.mediaType !== asset.mimeType
          || (streamed.actualHash !== asset.contentHash && streamed.legacyHash !== asset.contentHash)
          || detectImageMimeType(streamed.signature) !== asset.mimeType) {
          throw importFailure("archive-asset-invalid", "A System Archive Original Asset does not match its inventory.");
        }
        if (!uniqueOriginals.has(path)) {
          const metadata = await consumeVerifiedContainerEntry(
            container,
            entry.path,
            limits.maxOriginalImageBytes,
            inspectOriginalMetadata,
          );
          if (metadata.sha256 !== entry.sha256
            || metadata.value.width !== asset.pixelWidth
            || metadata.value.height !== asset.pixelHeight) {
            throw importFailure("archive-asset-invalid", "A System Archive Original Asset does not match its inventory.");
          }
          uniqueOriginals.add(path);
          assetBytes += entry.byteLength;
        }
      } catch (error) {
        if (error instanceof ArchiveError) throw error;
        const failure = importFailure("archive-asset-invalid", "A System Archive Original Asset failed image validation.");
        failure.cause = error;
        throw failure;
      }
    }
    if (uniqueOriginals.size !== originalsByPath.size) {
      throw importFailure("archive-asset-invalid", "System Archive contains an uninventoried Original Asset.");
    }
    index.validate(manifest.assets);
    recordsByDomain = index.counts();
  } finally {
    await index.close();
  }

  return Object.freeze({
    formatVersion: 1,
    sourceApplication: manifest.sourceApplication,
    sourceMigration: manifest.sourceMigration,
    archiveFingerprint: manifest.contentFingerprint,
    sourceInstallationId: manifest.sourceInstallationId,
    sourceOwnerId: manifest.sourceOwner.sourceId,
    sourceOwnerCount: 1,
    recordsByDomain,
    assetCount: manifest.assets.length,
    assetBytes,
    disabledProviderCount: recordsByDomain.providers,
    invalidatedAccess: Object.freeze(["share-links", "sessions", "oidc-identities", "external-authorizations"]),
    normalization: Object.freeze(["map-source-owner-to-initial-owner", "disable-provider-profiles"]),
    rebuilds: Object.freeze(["chronicle-index", "asset-thumbnails"]),
  });
}

export interface SystemArchiveUploadStoragePort {
  prepare(input: Readonly<{
    ownerUserId: string;
    byteLength: number;
    sha256: string;
  }>): Promise<Readonly<{
    filesystemOperationId: string;
    rollback(): Promise<void>;
  }>>;
  publishChunk(input: Readonly<{
    ownerUserId: string;
    uploadId: string;
    assemblyOperationId: string;
    index: number;
    offset: number;
    bytes: Uint8Array;
    sha256: string;
  }>, persist: () => Promise<SystemArchiveUploadView>): Promise<SystemArchiveUploadView>;
  assemble(input: Readonly<{
    ownerUserId: string;
    assembly: SystemArchiveUploadAssembly;
  }>): Promise<Readonly<{
    stagedInputId: string;
    byteLength: number;
    sha256: string;
    rollback(): Promise<void>;
  }>>;
}

export type SystemArchiveUploadServiceOptions = Readonly<{
  uploads: SystemArchiveUploadRepository;
  storage: SystemArchiveUploadStoragePort;
  chunkBytes: number;
  maximumBytes: number;
}>;

function requireUploadHash(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw Object.assign(new Error("System Archive upload hash is invalid."), { statusCode: 400 });
  }
}

/**
 * Resumable upload coordinator. Storage owns all paths and must durably,
 * idempotently publish chunk identity before metadata is recorded. The
 * coordinator exposes only upload and staged-input identifiers.
 */
export function createSystemArchiveUploadService(
  options: SystemArchiveUploadServiceOptions,
): Readonly<{
  createUpload(owner: Readonly<{ ownerUserId: string }>, request: Readonly<{
    byteLength: number;
    sha256: string;
  }>): Promise<SystemArchiveUploadView>;
  putChunk(owner: Readonly<{ ownerUserId: string }>, request: Readonly<{
    uploadId: string;
    index: number;
    offset: number;
    bytes: Uint8Array;
    sha256: string;
  }>): Promise<SystemArchiveUploadView>;
  completeUpload(owner: Readonly<{ ownerUserId: string }>, uploadId: string): Promise<SystemArchiveUploadView>;
}> {
  if (!Number.isSafeInteger(options.chunkBytes) || options.chunkBytes < 1) {
    throw new Error("system_archive_chunk_limit_invalid");
  }
  if (!Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < options.chunkBytes) {
    throw new Error("system_archive_upload_limit_invalid");
  }
  return Object.freeze({
    async createUpload(owner, request) {
      requireUploadHash(request.sha256);
      if (!Number.isSafeInteger(request.byteLength)
        || request.byteLength < 1
        || request.byteLength > options.maximumBytes) {
        throw Object.assign(new Error("System Archive upload byte length is invalid."), { statusCode: 400 });
      }
      const prepared = await options.storage.prepare({ ...request, ownerUserId: owner.ownerUserId });
      try {
        return await options.uploads.createUpload(owner, {
          handleTokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
          filesystemOperationId: prepared.filesystemOperationId,
          byteLength: request.byteLength,
          sha256: request.sha256,
        });
      } catch (error) {
        await prepared.rollback().catch(() => undefined);
        throw error;
      }
    },

    async putChunk(owner, request) {
      requireUploadHash(request.sha256);
      if (!(request.bytes instanceof Uint8Array)
        || request.bytes.byteLength < 1
        || request.bytes.byteLength > options.chunkBytes) {
        throw Object.assign(new Error("System Archive upload chunk exceeds the configured byte limit."), {
          statusCode: 413,
        });
      }
      const actualHash = createHash("sha256").update(request.bytes).digest("hex");
      if (actualHash !== request.sha256) {
        throw Object.assign(new Error("System Archive upload chunk checksum does not match its body."), {
          statusCode: 400,
        });
      }
      const session = await options.uploads.getUploadSession(owner, request.uploadId);
      if (!Number.isSafeInteger(request.index) || request.index < 0 || request.index > 2_147_483_647
        || !Number.isSafeInteger(request.offset) || request.offset < 0
        || !Number.isSafeInteger(request.offset + request.bytes.byteLength)
        || request.offset + request.bytes.byteLength > session.byteLength) {
        throw Object.assign(new Error("System Archive upload chunk range is invalid."), { statusCode: 400 });
      }
      return options.storage.publishChunk({
        ownerUserId: owner.ownerUserId,
        uploadId: request.uploadId,
        assemblyOperationId: session.filesystemOperationId,
        index: request.index,
        offset: request.offset,
        bytes: request.bytes,
        sha256: request.sha256,
      }, async () => {
        if (session.status !== "created" && session.status !== "uploading") {
          throw Object.assign(new Error("System Archive upload cannot accept another chunk."), { statusCode: 409 });
        }
        return await options.uploads.recordChunk(owner, {
          uploadId: request.uploadId,
          index: request.index,
          offset: request.offset,
          bytes: request.bytes.byteLength,
          sha256: request.sha256,
        });
      });
    },

    async completeUpload(owner, uploadId) {
      const assembly = await options.uploads.getAssembly(owner, uploadId);
      const staged = await options.storage.assemble({ ownerUserId: owner.ownerUserId, assembly });
      try {
        if (staged.byteLength !== assembly.byteLength || staged.sha256 !== assembly.sha256) {
          throw Object.assign(new Error("System Archive upload assembly failed its final identity check."), {
            statusCode: 409,
          });
        }
        return await options.uploads.completeUpload(owner, {
          uploadId,
          stagedInputId: staged.stagedInputId,
        });
      } catch (error) {
        await staged.rollback().catch(() => undefined);
        throw error;
      }
    },
  });
}

export function createPrivateSystemArchiveUploadStorage(
  storage: Pick<SecureFilesystemAdapter,
    "prepareSystemArchiveUpload"
    | "publishSystemArchiveUploadChunk"
    | "assembleSystemArchiveUpload">,
  options: Readonly<{
    leaseOwner: string;
    leaseSeconds: number;
    uploadTtlSeconds: number;
    now?: () => Date;
  }>,
): SystemArchiveUploadStoragePort {
  if (!options.leaseOwner.trim()
    || !Number.isSafeInteger(options.leaseSeconds) || options.leaseSeconds < 1
    || !Number.isSafeInteger(options.uploadTtlSeconds)
    || options.uploadTtlSeconds < options.leaseSeconds) {
    throw new Error("system_archive_upload_storage_options_invalid");
  }
  const adapter: SystemArchiveUploadStoragePort = {
    prepare(input) {
      const issuedAt = (options.now ?? (() => new Date()))();
      return storage.prepareSystemArchiveUpload({
        ownerUserId: input.ownerUserId,
        operationScopeId: randomUUID(),
        leaseOwner: options.leaseOwner,
        expiresAt: new Date(issuedAt.getTime() + options.uploadTtlSeconds * 1_000).toISOString(),
      });
    },
    publishChunk(input, persist) {
      return storage.publishSystemArchiveUploadChunk({
        ownerUserId: input.ownerUserId,
        uploadId: input.uploadId,
        filesystemOperationId: input.assemblyOperationId,
        leaseOwner: options.leaseOwner,
        leaseSeconds: options.leaseSeconds,
        offset: input.offset,
        bytes: input.bytes,
        sha256: input.sha256,
      }, persist);
    },
    assemble(input) {
      return storage.assembleSystemArchiveUpload({
        ownerUserId: input.ownerUserId,
        uploadId: input.assembly.uploadId,
        filesystemOperationId: input.assembly.filesystemOperationId,
        leaseOwner: options.leaseOwner,
        leaseSeconds: options.leaseSeconds,
        byteLength: input.assembly.byteLength,
        sha256: input.assembly.sha256,
      });
    },
  };
  return Object.freeze(adapter);
}

export interface SystemArchivePreviewSourcePort {
  withCompletedUpload<Result>(
    owner: Readonly<{ ownerUserId: string }>,
    uploadId: string,
    inspect: (staged: StagedArchive) => Promise<Result>,
  ): Promise<Result>;
}

export interface SystemArchiveCapacityPort {
  availableBytes(): Promise<Readonly<{
    staging: number | null;
    assetRoot: number | null;
  }>>;
}

export type SystemArchiveImportPreviewServiceOptions = Readonly<{
  imports: SystemArchiveImportRepository;
  source: SystemArchivePreviewSourcePort;
  capacity: SystemArchiveCapacityPort;
  limits: ArchiveLimits;
  destinationApplicationVersion: string;
  allowUnknownFreeSpace: boolean;
}>;

function capacityCheck(
  requiredBytes: number,
  availableBytes: number | null,
  allowUnknownFreeSpace: boolean,
): SystemImportPreviewView["space"]["staging"] {
  if (availableBytes !== null && (!Number.isSafeInteger(availableBytes) || availableBytes < 0)) {
    throw new Error("system_archive_capacity_invalid");
  }
  const verified = availableBytes !== null;
  const sufficient = availableBytes === null
    ? allowUnknownFreeSpace
    : availableBytes >= requiredBytes;
  return Object.freeze({
    requiredBytes,
    availableBytes,
    verified,
    sufficient,
    overrideUsed: availableBytes === null && allowUnknownFreeSpace,
  });
}

function unknownCapacityWarning(
  label: string,
  capacity: SystemImportPreviewView["space"]["staging"],
): string[] {
  if (capacity.verified) return [];
  return [capacity.overrideUsed
    ? `${label} free space was not measurable; the operator override was used.`
    : `${label} free space was not measurable; preview cannot be authorized without an operator override.`];
}

function supportsSourceMigration(source: string, destination: string): boolean {
  const sourceMatch = /^(\d{4})_/u.exec(source);
  const destinationMatch = /^(\d{4})_/u.exec(destination);
  if (!sourceMatch || !destinationMatch) return false;
  const sourceOrdinal = Number(sourceMatch[1]);
  const destinationOrdinal = Number(destinationMatch[1]);
  return sourceOrdinal < destinationOrdinal
    || (sourceOrdinal === destinationOrdinal && source === destination);
}

/**
 * Creates a short-lived opaque preview only after bounded server-side archive
 * inspection, exact destination fingerprinting, and capacity preflight. An
 * invalid preview has no authority and does not write any operational row.
 */
export function createSystemArchiveImportPreviewService(
  options: SystemArchiveImportPreviewServiceOptions,
): Readonly<{
  preview(owner: Readonly<{ ownerUserId: string }>, uploadId: string): Promise<SystemImportPreviewView>;
}> {
  if (!options.destinationApplicationVersion.trim()) {
    throw new Error("system_archive_destination_version_invalid");
  }
  return Object.freeze({
    async preview(owner, uploadId) {
      const destination = await options.imports.destinationFingerprint(owner, { ignoreUploadId: uploadId });
      const inspected = await options.source.withCompletedUpload(
        owner,
        uploadId,
        (staged) => inspectSystemArchiveForPreview(staged, options.limits).then((inspection) => ({
          inspection,
          compressedBytes: staged.compressedBytes,
        })),
      );
      const available = await options.capacity.availableBytes();
      const staging = capacityCheck(
        inspected.compressedBytes,
        available.staging,
        options.allowUnknownFreeSpace,
      );
      const assetRoot = capacityCheck(
        inspected.inspection.assetBytes,
        available.assetRoot,
        options.allowUnknownFreeSpace,
      );
      const errors: ArchiveErrorCode[] = [];
      if (!supportsSourceMigration(
        inspected.inspection.sourceMigration,
        destination.latestMigration,
      )) errors.push("archive-version-unsupported");
      if (!destination.destinationEmpty) errors.push("archive-destination-not-empty");
      if (!staging.sufficient || !assetRoot.sufficient) errors.push("archive-storage-insufficient");
      const warnings = [
        ...unknownCapacityWarning("Staging", staging),
        ...unknownCapacityWarning("Original Asset", assetRoot),
      ];
      const safeProjection = {
        versions: {
          archiveFormat: inspected.inspection.formatVersion,
          sourceApplication: inspected.inspection.sourceApplication,
          sourceMigration: inspected.inspection.sourceMigration,
          destinationApplication: options.destinationApplicationVersion,
          destinationMigration: destination.latestMigration,
        },
        sourceOwnerCount: inspected.inspection.sourceOwnerCount,
        archiveFingerprint: inspected.inspection.archiveFingerprint,
        recordsByDomain: inspected.inspection.recordsByDomain,
        assets: {
          originalCount: inspected.inspection.assetCount,
          totalBytes: inspected.inspection.assetBytes,
        },
        destinationEmpty: destination.destinationEmpty,
        ownerMapping: {
          sourceOwnerId: inspected.inspection.sourceOwnerId,
          destinationOwnerId: destination.initialOwnerId,
        },
        disabledProviders: inspected.inspection.disabledProviderCount,
        invalidatedAccess: inspected.inspection.invalidatedAccess,
        normalization: inspected.inspection.normalization,
        rebuilds: inspected.inspection.rebuilds,
        space: { staging, assetRoot },
        warnings,
        errors,
      } as const;
      if (errors.length > 0) {
        return systemImportPreviewViewSchema.parse({
          valid: false,
          previewHandle: null,
          ...safeProjection,
          expiresAt: null,
        });
      }
      const validated = systemImportPreviewViewSchema.parse({
        valid: true,
        previewHandle: "preview-validation-placeholder",
        ...safeProjection,
        expiresAt: "1970-01-01T00:00:00.000Z",
      });
      const {
        valid: _valid,
        previewHandle: _previewHandle,
        expiresAt: _expiresAt,
        ...validatedProjection
      } = validated;
      const authority = await options.imports.createPreview(owner, {
        uploadId,
        archiveFingerprint: inspected.inspection.archiveFingerprint,
        destination,
        projection: validatedProjection,
      });
      return systemImportPreviewViewSchema.parse({
        valid: true,
        previewHandle: authority.previewHandle,
        ...validatedProjection,
        expiresAt: authority.expiresAt,
      });
    },
  });
}

export function createPrivateSystemArchivePreviewSource(
  options: Readonly<{
    archiveRoot: string;
    maximumCompressedBytes: number;
    repository: ReturnType<typeof createPostgresSystemArchivePrivateStorageRepository>;
  }>,
): SystemArchivePreviewSourcePort {
  const source: SystemArchivePreviewSourcePort = {
    async withCompletedUpload(owner, uploadId, inspect) {
      const authority = await options.repository.completedUpload(owner.ownerUserId, uploadId);
      if (!authority) {
        throw Object.assign(new Error("System Archive completed upload was not found."), { statusCode: 404 });
      }
      const change = authority.descriptor.identity.changeToken.split(":");
      if (change.length !== 2) throw new Error("system_archive_staged_identity_invalid");
      const staged = await rehydratePersistedAnchoredStagedArchive({
        archiveRoot: options.archiveRoot,
        relativePath: authority.descriptor.relativePath,
        compressedBytes: authority.descriptor.byteLength,
        maximumCompressedBytes: options.maximumCompressedBytes,
        sha256: authority.descriptor.contentHash,
        identity: {
          device: BigInt(authority.descriptor.identity.deviceId),
          inode: BigInt(authority.descriptor.identity.fileId),
          size: BigInt(authority.descriptor.byteLength),
          modifiedNanoseconds: BigInt(change[0]!),
          changedNanoseconds: BigInt(change[1]!),
        },
      });
      try {
        return await inspect(staged);
      } finally {
        await releaseAnchoredStagedArchive(staged);
      }
    },
  };
  return Object.freeze(source);
}

export type SystemArchiveImportCompositionOptions = Readonly<{
  pool: DatabasePool;
  storage: Pick<SecureFilesystemAdapter,
    "prepareSystemArchiveUpload"
    | "publishSystemArchiveUploadChunk"
    | "assembleSystemArchiveUpload">;
  archiveRoot: string;
  capacity: SystemArchiveCapacityPort;
  limits: ArchiveLimits;
  destinationApplicationVersion: string;
  uploadTtlSeconds: number;
  previewTtlSeconds: number;
  chunkBytes: number;
  maximumUploadBytes: number;
  leaseOwner: string;
  leaseSeconds: number;
  allowUnknownFreeSpace: boolean;
  now?: () => Date;
}>;

/** Production import composition only; Task 6 owns API routes and enablement. */
export function createSystemArchiveImportComposition(
  options: SystemArchiveImportCompositionOptions,
): Readonly<{
  uploads: ReturnType<typeof createSystemArchiveUploadService>;
  previews: ReturnType<typeof createSystemArchiveImportPreviewService>;
}> {
  const uploadRepository = createPostgresSystemArchiveUploadRepository(options.pool, {
    uploadTtlSeconds: options.uploadTtlSeconds,
  });
  const importRepository = createPostgresSystemArchiveImportRepository(options.pool, {
    previewTtlSeconds: options.previewTtlSeconds,
  });
  const privateRepository = createPostgresSystemArchivePrivateStorageRepository(options.pool);
  const storage = createPrivateSystemArchiveUploadStorage(options.storage, {
    leaseOwner: options.leaseOwner,
    leaseSeconds: options.leaseSeconds,
    uploadTtlSeconds: options.uploadTtlSeconds,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return Object.freeze({
    uploads: createSystemArchiveUploadService({
      uploads: uploadRepository,
      storage,
      chunkBytes: options.chunkBytes,
      maximumBytes: options.maximumUploadBytes,
    }),
    previews: createSystemArchiveImportPreviewService({
      imports: importRepository,
      source: createPrivateSystemArchivePreviewSource({
        archiveRoot: options.archiveRoot,
        maximumCompressedBytes: options.limits.maxCompressedBytes,
        repository: privateRepository,
      }),
      capacity: options.capacity,
      limits: options.limits,
      destinationApplicationVersion: options.destinationApplicationVersion,
      allowUnknownFreeSpace: options.allowUnknownFreeSpace,
    }),
  });
}

export function createPrivateSystemArchiveStaging(
  storage: Pick<SecureFilesystemAdapter,
    "stagePortableScratch" | "openStagedInputSession" | "discardPortableStagedInput">,
  options: Readonly<{
    leaseOwner: string;
    artifactTtlSeconds: number;
    now?: () => Date;
    leaseSeconds?: number;
  }>,
): SystemArchiveStagingPort {
  const leaseSeconds = options.leaseSeconds ?? 300;
  if (!Number.isSafeInteger(options.artifactTtlSeconds) || options.artifactTtlSeconds < leaseSeconds) {
    throw new Error("system_archive_staging_lifetime_invalid");
  }
  return Object.freeze({
    async stage(input: Parameters<SystemArchiveStagingPort["stage"]>[0]) {
      const issuedAt = (options.now ?? (() => new Date()))();
      const issued = await storage.stagePortableScratch({
        owner: { ownerUserId: input.ownerUserId },
        operationScopeId: randomUUID(),
        leaseOwner: options.leaseOwner,
        // The artifact retention policy is also the minimum active-export
        // budget. Each durable stage receives the full configured lifetime.
        expiresAt: new Date(issuedAt.getTime() + options.artifactTtlSeconds * 1_000).toISOString(),
        maximumBytes: input.maximumBytes,
        source: input.source,
      });
      let cleanupPromise: Promise<void> | undefined;
      let cleaned = false;
      const cleanup = (): Promise<void> => {
        if (cleaned) return Promise.resolve();
        if (cleanupPromise) return cleanupPromise;
        cleanupPromise = storage.discardPortableStagedInput({
          owner: { ownerUserId: input.ownerUserId },
          stagedInput: issued.stagedInput,
          claim: { leaseOwner: options.leaseOwner, leaseSeconds },
        }).then(() => { cleaned = true; }).finally(() => {
          cleanupPromise = undefined;
        });
        return cleanupPromise;
      };
      return Object.freeze({
        byteLength: issued.byteLength,
        sha256: issued.contentHash,
        open(): AsyncIterable<Uint8Array> {
          return {
            async *[Symbol.asyncIterator]() {
              if (cleaned || cleanupPromise) throw new Error("system_archive_staging_cleaned");
              const openedAt = (options.now ?? (() => new Date()))();
              const session = await storage.openStagedInputSession({
                owner: { ownerUserId: input.ownerUserId },
                stagedInput: issued.stagedInput,
                claim: { leaseOwner: options.leaseOwner, leaseSeconds },
                limits: bindPrivateBoundedStreamLimits({
                  maximumBytes: issued.byteLength,
                  chunkBytes: Math.min(64 * 1024, Math.max(1, issued.byteLength)),
                  deadlineAt: new Date(
                    openedAt.getTime() + options.artifactTtlSeconds * 1_000,
                  ).toISOString(),
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
 * a path or imports `node:fs`; both the logical entries and assembled ZIP remain
 * inside durable private lifecycle authority until publication is recorded.
 */
export async function createFilesystemSystemArchiveWriter(
  options: FilesystemSystemArchiveWriterOptions,
): Promise<FilesystemSystemArchiveWriter> {
  const entries: SpoolEntry[] = [];
  const stagedForCleanup = new Set<SystemArchiveStagedContent>();
  const paths = new Set<string>();
  let ownerUserId: string | undefined;
  let state: "open" | "published" | "aborted" = "open";

  const requireOpen = () => {
    if (state !== "open") throw archiveFailure("archive-export-inconsistent", "System Archive writer is no longer open.");
  };
  const registerStaged = (staged: SystemArchiveStagedContent) => {
    stagedForCleanup.add(staged);
    return staged;
  };
  const cleanupStaged = async (staged: SystemArchiveStagedContent) => {
    await staged.cleanup();
    stagedForCleanup.delete(staged);
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
    const staged = [...stagedForCleanup];
    const settled = await Promise.allSettled(staged.map(cleanupStaged));
    const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejected) throw rejected.reason;
    paths.clear();
  };
  const writeBufferEntry = async (
    path: string,
    logicalType: SpoolEntry["logicalType"],
    mediaType: string,
    bytes: Uint8Array,
  ): Promise<SystemArchiveWrittenPayload> => {
    requireOpen();
    if (!ownerUserId) throw archiveFailure("archive-export-inconsistent", "System Archive staging owner is unavailable.");
    const staged = registerStaged(await options.staging.stage({
      ownerUserId,
      maximumBytes: bytes.byteLength,
      source: [bytes],
    }));
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
      await cleanupStaged(staged).catch(() => undefined);
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
          const staged = registerStaged(await options.staging.stage({
            ownerUserId,
            maximumBytes: shardOptions.targetBytes,
            source,
          }));
          if (staged.byteLength === 0) {
            await cleanupStaged(staged);
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
            await cleanupStaged(staged).catch(() => undefined);
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
        staged = registerStaged(await options.staging.stage({
          ownerUserId,
          maximumBytes: input.expectedBytes,
          source: input.stream,
        }));
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
        await cleanupStaged(staged).catch(() => undefined);
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
        // Durable staging retains expiry/reaper cleanup authority. A cleanup
        // retry cannot revoke an already accepted cancellation.
        await removeSpool().catch(() => undefined);
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
        sourceApplication: input.manifest.sourceApplication,
        sourceMigration: input.manifest.sourceMigration,
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
      try {
        const finalArchive = registerStaged(await options.staging.stage({
          ownerUserId: input.manifest.sourceOwner.sourceId,
          maximumBytes: options.limits.maxCompressedBytes,
          source: createArchiveArtifactSource(
            archiveEntries,
            buildManifest,
            options.limits,
            (value) => systemArchiveManifestSchema.parse(value),
          ),
        }));
        if (await input.cancellationRequested()) {
          state = "aborted";
          await removeSpool().catch(() => undefined);
          return Object.freeze({ status: "cancelled" as const });
        }
        const persisted = await options.publisher.publishSystemArchive({
          ownerUserId: input.manifest.sourceOwner.sourceId,
          contentFingerprint: input.contentFingerprint,
          byteLength: finalArchive.byteLength,
          sha256: finalArchive.sha256,
          source: finalArchive.open(),
        });
        state = "published";
        const published: SystemArchivePublishedArtifact = Object.freeze({
          ...persisted,
          contentFingerprint: input.contentFingerprint,
        });
        // The application links the finalized artifact to the durable job
        // before asking cleanupPublishedStaging() to release scratch authority.
        return Object.freeze({ status: "published" as const, artifact: published });
      } catch (error) {
        if (state !== "published") {
          state = "aborted";
          await removeSpool().catch(() => undefined);
        }
        throw error;
      }
    },

    async cleanupPublishedStaging() {
      if (state !== "published") return;
      await removeSpool();
    },

    async abort() {
      if (state !== "open") return;
      state = "aborted";
      await removeSpool().catch(() => undefined);
    },

    async unpublishedArtifactCount() {
      return state === "open" ? stagedForCleanup.size : 0;
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
  applicationVersion: string;
  limits: ArchiveLimits;
  artifactTtlSeconds: number;
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
  const snapshots = createPostgresSystemArchiveExportRepository(options.pool, {
    sourceApplicationVersion: options.applicationVersion,
  });
  const jobs = createPostgresSystemArchiveExportJobPort(options.pool);
  return Object.freeze({
    async runSystemExport(job) {
      const writer = await createFilesystemSystemArchiveWriter({
        limits: options.limits,
        staging: createPrivateSystemArchiveStaging(options.storage, {
          leaseOwner: job.leaseOwner,
          artifactTtlSeconds: options.artifactTtlSeconds,
          ...(options.now === undefined ? {} : { now: options.now }),
        }),
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
