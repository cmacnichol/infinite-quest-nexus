import { createHash, randomUUID } from "node:crypto";
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
import type {
  SystemArchiveUploadAssembly,
  SystemArchiveUploadRepository,
} from "../../../packages/database/src/system-archive-upload-repository.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { detectImageMimeType } from "../../../packages/domain/src/image-media.js";
import { sha256 as legacySha256 } from "../../../packages/domain/src/text.js";
import {
  ArchiveError,
  createArchiveArtifactSource,
  inspectArchiveContainer,
  readVerifiedContainerEntry,
  type ArchiveArtifactEntry,
  type ArchiveLimits,
  type StagedArchive,
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

type RecordsByDomain = Record<SystemArchiveDomain, SystemRecordEnvelope[]>;

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

function requireSystemRelationship(condition: boolean): void {
  if (!condition) {
    throw importFailure("archive-world-mismatch", "System Archive logical relationships are inconsistent.");
  }
}

function validateRecordRelationships(
  records: RecordsByDomain,
  assets: readonly ArchiveAssetRecord[],
): void {
  const ids = <Domain extends SystemArchiveDomain>(domain: Domain) =>
    new Set(records[domain].map((envelope) => envelope.sourceId));
  const worlds = ids("worlds");
  const worldVersions = ids("world-versions");
  const campaigns = ids("campaigns");
  const turns = ids("turns");
  const assetIds = new Set(assets.map((asset) => asset.sourceAssetId));
  const worldVersionParents = new Map(
    records["world-versions"].map((envelope) => {
      const record = envelope.record as Extract<SystemRecordEnvelope, { domain: "world-versions" }>["record"];
      return [envelope.sourceId, record.worldId] as const;
    }),
  );
  const campaignParents = new Map(
    records.campaigns.map((envelope) => {
      const record = envelope.record as Extract<SystemRecordEnvelope, { domain: "campaigns" }>["record"];
      return [envelope.sourceId, record.worldVersionId] as const;
    }),
  );
  const turnParents = new Map(
    records.turns.map((envelope) => {
      const record = envelope.record as Extract<SystemRecordEnvelope, { domain: "turns" }>["record"];
      return [envelope.sourceId, record.campaignId] as const;
    }),
  );

  for (const envelope of records["world-versions"]) {
    const record = envelope.record as Extract<SystemRecordEnvelope, { domain: "world-versions" }>["record"];
    requireSystemRelationship(worlds.has(record.worldId));
    for (const binding of record.content.assets) requireSystemRelationship(assetIds.has(binding.assetId));
  }
  for (const envelope of records["world-drafts"]) {
    const record = envelope.record as Extract<SystemRecordEnvelope, { domain: "world-drafts" }>["record"];
    requireSystemRelationship(worlds.has(record.worldId));
    requireSystemRelationship(record.basedOnWorldVersionId === null || worldVersions.has(record.basedOnWorldVersionId));
    for (const binding of record.content.assets) requireSystemRelationship(assetIds.has(binding.assetId));
  }
  for (const envelope of records.campaigns) {
    const record = envelope.record as Extract<SystemRecordEnvelope, { domain: "campaigns" }>["record"];
    requireSystemRelationship(worldVersions.has(record.worldVersionId));
  }
  for (const envelope of records.turns) {
    const record = envelope.record as Extract<SystemRecordEnvelope, { domain: "turns" }>["record"];
    requireSystemRelationship(campaigns.has(record.campaignId));
  }
  for (const envelope of records["turn-corrections"]) {
    const record = envelope.record as Extract<SystemRecordEnvelope, { domain: "turn-corrections" }>["record"];
    requireSystemRelationship(turns.has(record.turnId));
  }
  for (const domain of ["campaign-state", "campaign-history", "canonical-facts", "chronicle"] as const) {
    for (const envelope of records[domain]) {
      const record = envelope.record as { campaignId: string };
      requireSystemRelationship(campaigns.has(record.campaignId));
    }
  }
  for (const envelope of records.illustrations) {
    const record = envelope.record as Extract<SystemRecordEnvelope, { domain: "illustrations" }>["record"];
    requireSystemRelationship(campaigns.has(record.campaignId));
    requireSystemRelationship(record.turnId === null || (
      turns.has(record.turnId) && turnParents.get(record.turnId) === record.campaignId
    ));
    requireSystemRelationship(assetIds.has(record.assetId));
  }
  for (const domain of ["cost-events", "activity-events"] as const) {
    for (const envelope of records[domain]) {
      const record = envelope.record as { campaignId: string | null };
      requireSystemRelationship(record.campaignId === null || campaigns.has(record.campaignId));
    }
  }

  for (const asset of assets) {
    for (const binding of asset.bindings) {
      switch (binding.role) {
        case "world_cover":
          requireSystemRelationship(worlds.has(binding.worldId));
          break;
        case "world_version_asset":
          requireSystemRelationship(worlds.has(binding.worldId)
            && worldVersions.has(binding.worldVersionId)
            && worldVersionParents.get(binding.worldVersionId) === binding.worldId);
          break;
        case "campaign_asset":
          requireSystemRelationship(campaigns.has(binding.campaignId));
          break;
        case "turn_illustration":
        case "illustration_segment_variant":
          requireSystemRelationship(campaigns.has(binding.campaignId)
            && turns.has(binding.turnId)
            && turnParents.get(binding.turnId) === binding.campaignId);
          break;
        case "imported_attachment":
          requireSystemRelationship(campaigns.has(binding.campaignId)
            && (binding.turnId === null || (
              turns.has(binding.turnId) && turnParents.get(binding.turnId) === binding.campaignId
            )));
          break;
        case "generation_context":
          requireSystemRelationship((binding.campaignId === null || campaigns.has(binding.campaignId))
            && (binding.worldId === null || worlds.has(binding.worldId))
            && (binding.worldVersionId === null || worldVersions.has(binding.worldVersionId))
            && (binding.turnId === null || turns.has(binding.turnId)));
          break;
      }
    }
  }

  for (const [campaignId, worldVersionId] of campaignParents) {
    requireSystemRelationship(campaigns.has(campaignId) && worldVersions.has(worldVersionId));
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

  const records = Object.fromEntries(
    SYSTEM_ARCHIVE_DOMAINS.map((domain) => [domain, [] as SystemRecordEnvelope[]]),
  ) as unknown as RecordsByDomain;
  const recordIds = new Map<SystemArchiveDomain, Set<string>>(
    SYSTEM_ARCHIVE_DOMAINS.map((domain) => [domain, new Set<string>()]),
  );
  let systemPayload: ReturnType<typeof systemArchivePayloadSchema.parse> | undefined;
  let assetsPayload: ReturnType<typeof systemArchiveAssetsPayloadSchema.parse> | undefined;
  const originalBytesByPath = new Map<string, Buffer>();
  const payloadHashes: string[] = [];
  const originalAssetHashes: string[] = [];

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
    const bytes = await readVerifiedContainerEntry(container, entry.path, maximumBytes);
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== entry.byteLength || actualHash !== entry.sha256) {
      throw importFailure("archive-checksum-mismatch", "A System Archive entry does not match its manifest checksum.");
    }
    if (entry.logicalType === "asset-original") {
      originalAssetHashes.push(actualHash);
      originalBytesByPath.set(normalizedPath(entry.path), bytes);
      continue;
    }
    payloadHashes.push(actualHash);

    if (entry.path === "system.json" && entry.logicalType === "system" && entry.mediaType === "application/json") {
      const parsed = systemArchivePayloadSchema.safeParse(parseJson(bytes, "System Archive system payload"));
      if (!parsed.success || parsed.data.records.length !== 0) {
        throw importFailure("archive-json-invalid", "System Archive system payload does not match the required schema.");
      }
      systemPayload = parsed.data;
      continue;
    }
    if (entry.path === "assets/assets.json" && entry.logicalType === "assets" && entry.mediaType === "application/json") {
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
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      const failure = importFailure("archive-json-invalid", "System Archive NDJSON is not valid UTF-8.");
      failure.cause = error;
      throw failure;
    }
    if (!text.endsWith("\n")) throw importFailure("archive-json-invalid", "System Archive NDJSON is truncated.");
    for (const line of text.slice(0, -1).split("\n")) {
      if (!line) throw importFailure("archive-json-invalid", "System Archive NDJSON contains an empty record.");
      const parsed = systemRecordEnvelopeSchema.safeParse(parseJson(Buffer.from(line, "utf8"), "System Archive record"));
      if (!parsed.success || parsed.data.domain !== domain || parsed.data.sourceId !== parsed.data.record.sourceId) {
        throw importFailure("archive-json-invalid", "System Archive record does not match its shard contract.");
      }
      const seen = recordIds.get(domain)!;
      if (seen.has(parsed.data.sourceId)) {
        throw importFailure("archive-json-invalid", "System Archive contains a duplicate logical record identifier.");
      }
      seen.add(parsed.data.sourceId);
      records[domain].push(parsed.data);
    }
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
  let assetBytes = 0;
  for (const asset of manifest.assets) {
    const path = normalizedPath(asset.archivePath);
    const bytes = originalBytesByPath.get(path);
    if (!bytes) throw importFailure("archive-asset-missing", "A System Archive Original Asset is missing.");
    const entry = manifestEntriesByPath.get(path);
    const legacyHash = legacySha256(bytes.toString("base64"));
    try {
      const metadata = await sharp(bytes, { failOn: "error" }).metadata();
      if (!entry || entry.logicalType !== "asset-original"
        || entry.byteLength !== asset.byteLength
        || entry.mediaType !== asset.mimeType
        || (entry.sha256 !== asset.contentHash && legacyHash !== asset.contentHash)
        || detectImageMimeType(bytes) !== asset.mimeType
        || metadata.width !== asset.pixelWidth
        || metadata.height !== asset.pixelHeight) {
        throw importFailure("archive-asset-invalid", "A System Archive Original Asset does not match its inventory.");
      }
    } catch (error) {
      if (error instanceof ArchiveError) throw error;
      const failure = importFailure("archive-asset-invalid", "A System Archive Original Asset failed image validation.");
      failure.cause = error;
      throw failure;
    }
    if (!uniqueOriginals.has(path)) {
      uniqueOriginals.add(path);
      assetBytes += bytes.byteLength;
    }
  }
  if (uniqueOriginals.size !== originalBytesByPath.size) {
    throw importFailure("archive-asset-invalid", "System Archive contains an uninventoried Original Asset.");
  }
  validateRecordRelationships(records, manifest.assets);

  const recordsByDomain = Object.freeze(Object.fromEntries(
    SYSTEM_ARCHIVE_DOMAINS.map((domain) => [domain, records[domain].length]),
  ) as Record<SystemArchiveDomain, number>);
  return Object.freeze({
    formatVersion: 1,
    archiveFingerprint: manifest.contentFingerprint,
    sourceInstallationId: manifest.sourceInstallationId,
    sourceOwnerId: manifest.sourceOwner.sourceId,
    sourceOwnerCount: 1,
    recordsByDomain,
    assetCount: manifest.assets.length,
    assetBytes,
    disabledProviderCount: records.providers.length,
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
    assemblyOperationId: string;
    index: number;
    offset: number;
    bytes: Uint8Array;
    sha256: string;
  }>): Promise<Readonly<{
    rollback(): Promise<void>;
  }>>;
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
      const publication = await options.storage.publishChunk({
        ownerUserId: owner.ownerUserId,
        assemblyOperationId: session.filesystemOperationId,
        index: request.index,
        offset: request.offset,
        bytes: request.bytes,
        sha256: request.sha256,
      });
      try {
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
      } catch (error) {
        await publication.rollback().catch(() => undefined);
        throw error;
      }
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
      if (!destination.destinationEmpty) errors.push("archive-destination-not-empty");
      if (!staging.sufficient || !assetRoot.sufficient) errors.push("archive-storage-insufficient");
      const warnings = [
        ...unknownCapacityWarning("Staging", staging),
        ...unknownCapacityWarning("Original Asset", assetRoot),
      ];
      const safeProjection = {
        versions: {
          archiveFormat: inspected.inspection.formatVersion,
          sourceApplication: null,
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
  const snapshots = createPostgresSystemArchiveExportRepository(options.pool);
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
