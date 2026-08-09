import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import unzipper from "unzipper";
import {
  archiveAssetRecordSchema,
  archiveManifestSchema,
  canonicalArchiveJson,
  canonicalizeWorldContent,
  legacyStorySchema,
  portableWorldSchema,
  worldImportRequestSchema,
  type ArchiveAssetRecord,
  type ArchiveManifest,
  type WorldContent
} from "../../../packages/contracts/src/index.js";
import { calculateContentFingerprint } from "../../../packages/contracts/src/archives-node.js";
import {
  convertInfiniteWorldsWorld,
  infiniteWorldsStoryToLegacyStory,
  parseInfiniteWorldsStory
} from "../../../packages/domain/src/infinite-worlds.js";
import { extractCyoaLayers, parseCyoaExport, type TemplateWorldInput } from "../../../packages/domain/src/world-template.js";
import {
  bindPrivateBoundedStreamLimits,
} from "../../../packages/application/src/assets/private-secure-storage.js";
import { toAssetMutationIdempotencyKey } from "../../../packages/application/src/assets/types.js";
import type {
  PrivateAssetPublicationContextIntentInput,
  PrivateAssetPublicationReferenceIntentInput
} from "../../../packages/application/src/assets/private-normalized-asset-publication.js";
import {
  canonicalPortableImportAuthority,
  type PortableImportExportComposition,
  type PortableCanonicalImportAuthority,
  type PrivatePortableExportBuilderPort,
  type PortableJsonValue,
  type PrivatePortableAssetChildPlan,
  type PrivatePortableFamilyMutationPort,
  type PrivatePortableFamilyPreviewPort,
  type PrivatePortableFamilyTargetPlan
} from "../../../packages/application/src/imports/private-portable-composition.js";
import type { PrivatePortableNormalizedAssetInput } from "../../../packages/application/src/imports/private-normalized-portable-publication.js";
import {
  toPortableImportedRecordId,
  type ImportOwnerScope,
  type PortableImportCommitCommand,
  PortableImportPreviewCommand,
  type PortableImportPreviewView,
  type PortablePreviewDestination,
  type PortablePreviewHandle
} from "../../../packages/application/src/imports/types.js";
import { createPostgresPortableImportAuthorityRepository } from "../../../packages/database/src/portable-import-family-repository.js";
import { withTransaction, type DatabaseClient, type DatabasePool } from "../../../packages/database/src/pool.js";
import type { WorldRepositoryPort } from "../../../packages/application/src/world-campaign/ports.js";
import { createPostgresPortableFamilyMutationRepository } from "../../../packages/database/src/portable-import-family-repository.js";
import { createPrivatePortableNormalizedAssetPublicationComposition } from "./portable-normalized-asset-publication-composition.js";
import { inspectPrivateImageArtifact } from "./private-image-normalization.js";

const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 256;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_ENTRY_NAME_BYTES = 512;
const MAX_ZIP_ENTRY_EXTRA_BYTES = 1024;
const MAX_ZIP_ENTRY_COMMENT_BYTES = 1024;
const MIGRATION_HISTORY_COMPATIBILITY_WARNING = "Migration history references source world versions not included in this Campaign Archive; those audit rows will not be recreated.";
const transientIllustrationCompatibilityWarning = (setCount: number, segmentCount: number) =>
  `Ignored ${setCount} turnless illustration ${setCount === 1 ? "set" : "sets"} and ${segmentCount} turnless illustration ${segmentCount === 1 ? "segment" : "segments"} because provisional illustration work is not portable.`;
const MAX_CENTRAL_DIRECTORY_BYTES = MAX_ARCHIVE_ENTRIES
  * (46 + MAX_ZIP_ENTRY_NAME_BYTES + MAX_ZIP_ENTRY_EXTRA_BYTES + MAX_ZIP_ENTRY_COMMENT_BYTES);

export interface PortableProviderWorldConversionPort {
  convertTemplate(input: Readonly<{
    ownerUserId: string;
    template: TemplateWorldInput;
  }>): Promise<Readonly<{
    world: Readonly<{ format: "infinite-quest-world"; formatVersion: 1; title: string; content: WorldContent }>;
    providerConfigurationFingerprint: string;
  }>>;
}

export interface PortableTargetWorldReaderPort {
  readTargetWorldVersion(input: Readonly<{
    owner: ImportOwnerScope;
    worldId: string;
    worldVersionId: string;
  }>): Promise<Readonly<{
    ownerUserId: string;
    worldId: string;
    worldVersionId: string;
    content: WorldContent;
  }> | null>;
}

async function boundedBytes(source: AsyncIterable<Uint8Array>, maximum = MAX_INPUT_BYTES): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of source) {
    length += chunk.byteLength;
    if (length > maximum) throw new Error("archive_size_limit_exceeded");
    chunks.push(new Uint8Array(chunk));
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function text(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/u, "");
}

function jsonText(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(text(bytes));
  } catch {
    throw new Error("archive_format_invalid");
  }
}

function asJson(value: unknown): PortableJsonValue {
  const parsed = JSON.parse(JSON.stringify(value)) as PortableJsonValue;
  const sanitize = (candidate: PortableJsonValue): PortableJsonValue => {
    if (candidate === null || typeof candidate !== "object") return candidate;
    if (Array.isArray(candidate)) return candidate.map(sanitize);
    return Object.fromEntries(Object.entries(candidate)
      .filter(([key]) => /^token_(?:estimate|count)$/u.test(key)
        || !/(^|_)(path|bearer|credential|secret|token|api_token|access_token|refresh_token|auth_token|provider_response|raw_response)($|_)/iu.test(key))
      .map(([key, child]) => [
        key === "token_estimate" ? "lexicalUnitEstimate"
          : key === "token_count" ? "lexicalUnitCount" : key,
        sanitize(child)
      ]));
  };
  return sanitize(parsed);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function authority(
  command: PortableImportPreviewCommand,
  normalizedPayload: Readonly<Record<string, PortableJsonValue>>,
  providerConfigurationFingerprint: string | null = null,
  selectedCharacterId: string | null = null,
): PortableCanonicalImportAuthority {
  return {
    kind: command.kind,
    destination: command.destination,
    normalizedPayload,
    sourceInstallationId: command.sourceInstallationId ?? null,
    sourceRecordId: command.importedRecordId ?? null,
    selectedCharacterId,
    providerConfigurationFingerprint
  };
}

function worldCounts(content: WorldContent): Readonly<{ entities: number; relationships: number; triggers: number }> {
  const record = content as unknown as Record<string, unknown>;
  return {
    entities: Array.isArray(record.entities) ? record.entities.length : 0,
    relationships: Array.isArray(record.relationships) ? record.relationships.length : 0,
    triggers: [record.defaultTriggers, record.eventTriggers]
      .reduce<number>((count, value) => count + (Array.isArray(value) ? value.length : 0), 0)
  };
}

function worldProjection(world: Readonly<{ title: string; content: WorldContent }>) {
  const characters = Array.isArray(world.content.playableCharacters)
    ? world.content.playableCharacters.map((character, index) => ({ index, name: character.name }))
    : [];
  return {
    kind: "world_json" as const,
    valid: true as const,
    title: world.title,
    duplicate: false,
    existingWorldId: null,
    characters,
    counts: worldCounts(world.content),
    warnings: [] as string[]
  };
}

function legacyProjection(story: ReturnType<typeof legacyStorySchema.parse>) {
  const historyCharacters = typeof story.fullHistory === "string" ? story.fullHistory.length : 0;
  return {
    kind: "campaign" as const,
    valid: true as const,
    title: story.campaign?.title || story.world.title || "Imported campaign",
    duplicate: false,
    existingCampaignId: null,
    counts: {
      turns: story.turns.length,
      completeHistoryCharacters: historyCharacters,
      estimatedHistoryTokens: Math.ceil(historyCharacters / 4)
    },
    warnings: [] as string[]
  };
}

function embeddedWorldRequest(story: ReturnType<typeof legacyStorySchema.parse>) {
  const title = story.world.title?.trim() || "Imported adventure";
  const characterText = String(story.world.character ?? "").trim();
  const characterName = characterText.split(/\r?\n/u).find((line) => line.trim())?.trim().slice(0, 200)
    || "Default character";
  const characterId = `legacy-import-character-${sha256(JSON.stringify({
    characterText,
    rpgStats: story.rpgStats ?? [],
    triggers: story.defaultTriggers ?? story.baseTrackersAtStart ?? []
  })).slice(0, 24)}`;
  const world = { ...story.world, title };
  delete world.character;
  return worldImportRequestSchema.parse({
    sourceName: "campaign.zip",
    worldExport: {
      format: "infinite-quest-world",
      formatVersion: 1,
      title,
      content: canonicalizeWorldContent({
        world,
        playableCharacters: [{
          id: characterId,
          name: characterName,
          characterText,
          rpgStats: story.rpgStats ?? [],
          defaultTriggers: story.defaultTriggers ?? story.baseTrackersAtStart ?? [],
          source: { type: "portable-campaign-import" }
        }],
        rpgStats: [],
        defaultTriggers: [],
        eventTriggers: story.eventTriggers ?? [],
        importedFromLegacyStory: true
      })
    }
  });
}

function safeEntryName(name: string): void {
  const segments = name.split("/");
  if (!name || name.startsWith("/") || /^[A-Za-z]:/u.test(name) || name.includes("\\")
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("archive_path_invalid");
  }
}

type CampaignArchiveAsset = Readonly<{
    sourceAssetIds: readonly string[];
    legacyTurnBindings?: import("../../../packages/application/src/imports/private-portable-composition.js").PrivatePortableAssetInventoryItem["legacyTurnBindings"];
    records: readonly ArchiveAssetRecord[];
    entryName: string;
    mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
    byteLength: number;
    contentHash: string;
    bytes?: Uint8Array;
}>;

type DecodedCampaignZip = Readonly<{
  archiveFormat: "legacy_zip" | "manifest_v1";
  story: ReturnType<typeof legacyStorySchema.parse> | null;
  campaign: Readonly<Record<string, unknown>> | null;
  world: Readonly<Record<string, unknown>> | null;
  chronicle: Readonly<Record<string, unknown>> | null;
  manifest: ArchiveManifest | null;
  assets: readonly CampaignArchiveAsset[];
  warnings: readonly string[];
}>;

type StreamingZipEntry = AsyncIterable<Uint8Array> & Readonly<{
  path: string;
  type: "File" | "Directory";
  vars?: Readonly<{
    externalFileAttributes?: number;
    compressedSize?: number;
    uncompressedSize?: number;
  }>;
  autodrain(): NodeJS.ReadableStream;
}>;

class ZipCentralDirectoryInspector {
  private tail = new Uint8Array(0);
  private totalBytes = 0;

  push(chunk: Uint8Array): void {
    this.totalBytes += chunk.byteLength;
    const keep = Math.min(MAX_CENTRAL_DIRECTORY_BYTES + 65_557, this.tail.byteLength + chunk.byteLength);
    const combined = new Uint8Array(keep);
    const oldBytes = Math.min(this.tail.byteLength, keep - Math.min(chunk.byteLength, keep));
    const chunkBytes = Math.min(chunk.byteLength, keep);
    combined.set(this.tail.subarray(this.tail.byteLength - oldBytes), 0);
    combined.set(chunk.subarray(chunk.byteLength - chunkBytes), oldBytes);
    this.tail = combined;
  }

  verify(expectedPaths: readonly string[]): void {
    const view = new DataView(this.tail.buffer, this.tail.byteOffset, this.tail.byteLength);
    let eocd = -1;
    for (let offset = this.tail.byteLength - 22; offset >= 0; offset -= 1) {
      if (view.getUint32(offset, true) !== 0x06054b50) continue;
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + 22 + commentLength === this.tail.byteLength) {
        eocd = offset;
        break;
      }
    }
    if (eocd < 0) throw new Error("archive_truncated");
    const disk = view.getUint16(eocd + 4, true);
    const centralDisk = view.getUint16(eocd + 6, true);
    const diskEntries = view.getUint16(eocd + 8, true);
    const entries = view.getUint16(eocd + 10, true);
    const centralBytes = view.getUint32(eocd + 12, true);
    const centralOffset = view.getUint32(eocd + 16, true);
    if (disk !== 0 || centralDisk !== 0 || diskEntries !== entries
      || entries === 0xffff || centralBytes === 0xffffffff || centralOffset === 0xffffffff
      || entries !== expectedPaths.length || entries > MAX_ARCHIVE_ENTRIES
      || centralBytes > MAX_CENTRAL_DIRECTORY_BYTES
      || centralOffset + centralBytes > this.totalBytes) {
      throw new Error("archive_format_invalid");
    }
    const tailStart = this.totalBytes - this.tail.byteLength;
    let offset = centralOffset - tailStart;
    const paths: string[] = [];
    for (let index = 0; index < entries; index += 1) {
      if (offset < 0 || offset + 46 > this.tail.byteLength
        || view.getUint32(offset, true) !== 0x02014b50) {
        throw new Error("archive_truncated");
      }
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const external = view.getUint32(offset + 38, true);
      if (nameLength === 0 || nameLength > MAX_ZIP_ENTRY_NAME_BYTES
        || extraLength > MAX_ZIP_ENTRY_EXTRA_BYTES
        || commentLength > MAX_ZIP_ENTRY_COMMENT_BYTES) {
        throw new Error("archive_format_invalid");
      }
      const end = offset + 46 + nameLength + extraLength + commentLength;
      if (end > this.tail.byteLength) throw new Error("archive_truncated");
      const name = text(this.tail.subarray(offset + 46, offset + 46 + nameLength));
      const normalized = name.replace(/\/$/u, "");
      safeEntryName(normalized);
      const mode = (external >>> 16) & 0xffff;
      if ((mode & 0o170000) === 0o120000) throw new Error("archive_link_denied");
      paths.push(name);
      offset = end;
    }
    if (offset !== centralOffset - tailStart + centralBytes
      || paths.length !== expectedPaths.length
      || paths.some((path, index) => path !== expectedPaths[index])) {
      throw new Error("archive_format_invalid");
    }
  }
}

async function* boundedArchiveSource(
  source: AsyncIterable<Uint8Array>,
  inspector: ZipCentralDirectoryInspector,
): AsyncGenerator<Uint8Array> {
  let total = 0;
  for await (const chunk of source) {
    total += chunk.byteLength;
    if (total > MAX_INPUT_BYTES) throw new Error("archive_size_limit_exceeded");
    inspector.push(chunk);
    yield chunk;
  }
}

async function readZipEntry(entry: StreamingZipEntry, maximum: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const value of entry) {
    const chunk = new Uint8Array(value);
    length += chunk.byteLength;
    if (length > maximum) throw new Error("archive_size_limit_exceeded");
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function portableAssetAuthorityRecord(record: ArchiveAssetRecord): PortableJsonValue {
  const { archivePath: _archivePath, ...safe } = record;
  return asJson(safe);
}

function exactPortableAssetAuthority(records: readonly ArchiveAssetRecord[]): PortableJsonValue {
  return asJson(records.map(portableAssetAuthorityRecord));
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("archive_format_invalid");
  return value as Readonly<Record<string, unknown>>;
}

function portableAssetPointers(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(portableAssetPointers);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(portableAssetPointers);
  return typeof value === "string"
    ? [...value.matchAll(/\/api\/v1\/assets\/([0-9a-f-]{36})/giu)].map((match) => match[1]!)
    : [];
}

function validateCurrentCampaignReferences(
  manifest: ArchiveManifest,
  campaign: Readonly<Record<string, unknown>>,
  world: Readonly<Record<string, unknown>>,
): void {
  const metadata = recordValue(campaign.campaign);
  if (metadata.sourceCampaignId !== manifest.campaignId
    || world.sourceWorldId !== manifest.worldId
    || world.sourceWorldVersionId !== manifest.worldVersionId
    || recordValue(campaign.world).canonicalHash !== world.canonicalHash) {
    throw new Error("archive_format_invalid");
  }
  const turns = campaign.turns as readonly unknown[];
  const turnIds = new Set(turns.map((turn) => recordValue(turn).id).filter((id): id is string => typeof id === "string"));
  if (turnIds.size !== turns.length) throw new Error("archive_format_invalid");
  const records = recordValue(campaign.archiveRecords);
  const segments = new Map<string, Readonly<Record<string, unknown>>>();
  for (const segment of Array.isArray(records.illustrationSegments) ? records.illustrationSegments : []) {
    const value = recordValue(segment);
    if (typeof value.id !== "string" || typeof value.turn_id !== "string" || !turnIds.has(value.turn_id)) {
      throw new Error("archive_format_invalid");
    }
    segments.set(value.id, value);
  }
  const assetsBySourceId = new Map(manifest.assets.map((asset) => [asset.sourceAssetId.toLowerCase(), asset]));
  for (const turnValue of turns) {
    const turn = recordValue(turnValue);
    for (const sourceAssetId of portableAssetPointers(turn.imageUrl)) {
      const record = assetsBySourceId.get(sourceAssetId.toLowerCase());
      if (!record?.bindings.some((binding) => binding.role === "turn_illustration" && binding.turnId === turn.id)) {
        throw new Error("archive_format_invalid");
      }
    }
  }
  for (const sourceAssetId of portableAssetPointers(world.content)) {
    const record = assetsBySourceId.get(sourceAssetId.toLowerCase());
    if (!record?.bindings.some((binding) => binding.role === "world_version_asset"
      && binding.worldId === manifest.worldId && binding.worldVersionId === manifest.worldVersionId)) {
      throw new Error("archive_format_invalid");
    }
  }
  for (const asset of manifest.assets) {
    for (const binding of asset.bindings) {
      if (("turnId" in binding && binding.turnId !== null && !turnIds.has(binding.turnId))
        || (binding.role === "illustration_segment_variant"
          && (segments.get(binding.segmentId)?.turn_id !== binding.turnId))) {
        throw new Error("archive_format_invalid");
      }
    }
  }
}

function normalizeCurrentCampaign(
  campaign: Readonly<Record<string, unknown>>,
  world: Readonly<Record<string, unknown>>,
): Readonly<{ campaign: Readonly<Record<string, unknown>>; warnings: readonly string[] }> {
  const records = recordValue(campaign.archiveRecords);
  const sourceSets = Array.isArray(records.illustrationSets) ? records.illustrationSets : [];
  const ignoredSetIds = new Set<string>();
  const illustrationSets = sourceSets.filter((value) => {
    const set = recordValue(value);
    if (set.turn_id !== null) return true;
    if (typeof set.id === "string") ignoredSetIds.add(set.id);
    return false;
  });
  const sourceSegments = Array.isArray(records.illustrationSegments) ? records.illustrationSegments : [];
  const illustrationSegments = sourceSegments.filter((value) => {
    const segment = recordValue(value);
    return segment.turn_id !== null
      || typeof segment.illustration_set_id !== "string"
      || !ignoredSetIds.has(segment.illustration_set_id);
  });
  const worldMigrations = Array.isArray(records.worldMigrations) ? records.worldMigrations : [];
  const migrationHistoryIsIncomplete = worldMigrations.some((value) => {
    const migration = recordValue(value);
    return [migration.from_world_version_id, migration.to_world_version_id]
      .some((worldVersionId) => worldVersionId !== world.sourceWorldVersionId);
  });
  const ignoredSetCount = sourceSets.length - illustrationSets.length;
  const ignoredSegmentCount = sourceSegments.length - illustrationSegments.length;
  return {
    campaign: {
      ...campaign,
      archiveRecords: { ...records, illustrationSets, illustrationSegments }
    },
    warnings: [
      ...(migrationHistoryIsIncomplete ? [MIGRATION_HISTORY_COMPATIBILITY_WARNING] : []),
      ...(ignoredSetCount || ignoredSegmentCount
        ? [transientIllustrationCompatibilityWarning(ignoredSetCount, ignoredSegmentCount)] : [])
    ]
  };
}

function currentWorldImportRequest(world: Readonly<Record<string, unknown>>) {
  const content = canonicalizeWorldContent(recordValue(world.content));
  const worldMetadata = recordValue(content.world);
  const title = typeof worldMetadata.title === "string" && worldMetadata.title.trim()
    ? worldMetadata.title.trim()
    : "Imported world";
  return worldImportRequestSchema.parse({
    sourceName: "campaign.zip",
    worldExport: { format: "infinite-quest-world", formatVersion: 1, title, content }
  });
}

async function verifyCurrentAsset(
  record: ArchiveAssetRecord,
  bytes: Uint8Array,
): Promise<number> {
  if (bytes.byteLength !== record.byteLength || sha256(bytes) !== record.contentHash) {
    throw new Error("archive_unavailable");
  }
  const inspected = await inspectPrivateImageArtifact({
    bytes,
    declaredMimeType: record.mimeType,
    maximumBytes: MAX_ASSET_BYTES,
    maximumPixels: MAXIMUM_NORMALIZED_IMPORT_IMAGE_PIXELS,
    diagnosticPrefix: "portable_import_image"
  }).catch(() => null);
  if (!inspected || inspected.technicalMetadata.pixelWidth !== record.pixelWidth
    || inspected.technicalMetadata.pixelHeight !== record.pixelHeight) {
    throw new Error("archive_format_invalid");
  }
  return inspected.pixelCount;
}

async function campaignZip(
  source: AsyncIterable<Uint8Array>,
  includeAssetBytes: boolean,
): Promise<DecodedCampaignZip> {
  const inspector = new ZipCentralDirectoryInspector();
  const parser = Readable.from(boundedArchiveSource(source, inspector)).pipe(unzipper.Parse({ forceStream: true }));
  let entryCount = 0;
  let expandedBytes = 0;
  let decodedPixelCount = 0;
  let deferredArchiveError: Error | null = null;
  let story: ReturnType<typeof legacyStorySchema.parse> | undefined;
  const legacyAssets: CampaignArchiveAsset[] = [];
  const entryPaths: string[] = [];
  const files = new Map<string, Uint8Array>();
  try {
    for await (const rawEntry of parser) {
      const entry = rawEntry as StreamingZipEntry;
      entryCount += 1;
      if (entryCount > MAX_ARCHIVE_ENTRIES) throw new Error("archive_entry_limit_exceeded");
      entryPaths.push(entry.path);
      if (new TextEncoder().encode(entry.path).byteLength > MAX_ZIP_ENTRY_NAME_BYTES) {
        throw new Error("archive_format_invalid");
      }
      safeEntryName(entry.path.replace(/\/$/u, ""));
      const external = entry.vars?.externalFileAttributes ?? 0;
      const mode = (external >>> 16) & 0xffff;
      if ((mode & 0o170000) === 0o120000) throw new Error("archive_link_denied");
      const declared = entry.vars?.uncompressedSize;
      if (declared !== undefined && (!Number.isSafeInteger(declared) || declared < 0)) {
        throw new Error("archive_format_invalid");
      }
      if (entry.type === "Directory") {
        entry.autodrain();
        continue;
      }
      const isManifestJson = entry.path === "manifest.json";
      const isPayloadJson = ["campaign.json", "infinite-quest-campaign.json", "world.json", "chronicle.json", "assets/assets.json"]
        .includes(entry.path);
      const assetMatch = /^assets\/([0-9a-f-]{36})\.(png|jpe?g|webp|gif)$/iu.exec(entry.path);
      const currentAssetMatch = /^assets\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}\.(png|jpe?g|webp|gif)$/u.exec(entry.path);
      const maximum = isManifestJson || isPayloadJson ? MAX_JSON_BYTES
        : assetMatch || currentAssetMatch ? MAX_ASSET_BYTES : 1024 * 1024;
      if (declared !== undefined && declared > maximum) throw new Error("archive_size_limit_exceeded");
      const bytes = await readZipEntry(entry, maximum);
      expandedBytes += bytes.byteLength;
      if (expandedBytes > MAX_INPUT_BYTES) throw new Error("archive_size_limit_exceeded");
      if (files.has(entry.path)) throw new Error("archive_format_invalid");
      files.set(entry.path, bytes);
      if (entry.path === "campaign.json" || entry.path === "infinite-quest-campaign.json") {
        const candidate = legacyStorySchema.safeParse(jsonText(bytes));
        if (candidate.success) story = candidate.data;
      }
      if (!assetMatch) continue;
      const extension = assetMatch[2]!.toLowerCase();
      const sourceAssetId = assetMatch[1]!;
      const mimeType = extension === "png" ? "image/png" as const
        : extension === "webp" ? "image/webp" as const
          : extension === "gif" ? "image/gif" as const : "image/jpeg" as const;
      const inspected = await inspectPrivateImageArtifact({
        bytes,
        declaredMimeType: mimeType,
        maximumBytes: MAX_ASSET_BYTES,
        maximumPixels: MAXIMUM_NORMALIZED_IMPORT_IMAGE_PIXELS,
        diagnosticPrefix: "portable_import_image"
      }).catch(() => null);
      if (!inspected) {
        deferredArchiveError ??= new Error("archive_format_invalid");
        continue;
      }
      decodedPixelCount += inspected.pixelCount;
      if (decodedPixelCount > MAXIMUM_NORMALIZED_IMPORT_AGGREGATE_PIXELS) {
        throw new Error("archive_size_limit_exceeded");
      }
      const record = archiveAssetRecordSchema.parse({
        sourceAssetId,
        contentHash: sha256(bytes),
        archivePath: entry.path,
        mimeType,
        byteLength: bytes.byteLength,
        pixelWidth: inspected.technicalMetadata.pixelWidth,
        pixelHeight: inspected.technicalMetadata.pixelHeight,
        technicalMetadata: inspected.technicalMetadata,
        library: {
          title: "", caption: "", notes: "", tags: [], origin: "imported",
          reviewStatus: "unreviewed", reuseScope: "campaign", automaticReuseEnabled: false,
          contentCategories: [], favorite: false, archivedAt: null
        },
        createdAt: "1970-01-01T00:00:00.000Z",
        bindings: []
      });
      legacyAssets.push({
        sourceAssetIds: [sourceAssetId],
        records: [record],
        entryName: entry.path,
        mimeType: record.mimeType,
        byteLength: bytes.byteLength,
        contentHash: sha256(bytes),
        ...(includeAssetBytes ? { bytes } : {})
      });
    }
    inspector.verify(entryPaths);
    if (deferredArchiveError) throw deferredArchiveError;
  } catch (error) {
    parser.destroy();
    if (error instanceof Error && error.message.startsWith("archive_")) throw error;
    throw new Error("archive_truncated");
  }
  const manifestBytes = files.get("manifest.json");
  if (!manifestBytes) {
    if (!story) throw new Error("archive_format_invalid");
    const sourceCampaignId = typeof story.campaign?.sourceCampaignId === "string"
      && UUID_PATTERN.test(story.campaign.sourceCampaignId)
      ? story.campaign.sourceCampaignId
      : null;
    const bindingCampaignId = sourceCampaignId ?? PORTABLE_PLACEHOLDER_CAMPAIGN_ID;
    const assets = legacyAssets.map((asset) => {
      const sourceAssetId = asset.sourceAssetIds[0]!;
      const matchingTurns = story.turns.flatMap((turn, turnOrdinal) => (
        turn.imageUrl === `/api/v1/assets/${sourceAssetId}`
          ? [{ turn, turnOrdinal }]
          : []
      ));
      const sourceBindings = matchingTurns.flatMap(({ turn }) => {
        const sourceTurnId = typeof turn.id === "string" ? turn.id : null;
        return sourceTurnId && UUID_PATTERN.test(sourceTurnId)
          ? [{ role: "turn_illustration" as const, campaignId: bindingCampaignId, turnId: sourceTurnId }]
          : [];
      });
      const bindings = matchingTurns.length === 0
        ? [{ role: "imported_attachment" as const, campaignId: bindingCampaignId, turnId: null }]
        : sourceBindings.filter((binding, index) => sourceBindings.findIndex((candidate) => (
          candidate.campaignId === binding.campaignId && candidate.turnId === binding.turnId
        )) === index);
      return {
        ...asset,
        ...(matchingTurns.length > 0 ? {
          legacyTurnBindings: matchingTurns.map(({ turn, turnOrdinal }) => ({
            sourceAssetId,
            sourceCampaignId,
            sourceTurnId: typeof turn.id === "string" ? turn.id : null,
            turnOrdinal
          }))
        } : {}),
        records: asset.records.map((record) => archiveAssetRecordSchema.parse({
          ...record,
          bindings
        }))
      };
    });
    return {
      archiveFormat: "legacy_zip",
      story,
      campaign: null,
      world: null,
      chronicle: null,
      manifest: null,
      assets,
      warnings: []
    };
  }
  const manifest = archiveManifestSchema.parse(jsonText(manifestBytes));
  if (manifest.archiveType !== "campaign") throw new Error("archive_format_invalid");
  const declaredPaths = new Set(manifest.entries.map((entry) => entry.path));
  const actualPaths = [...files.keys()].filter((path) => path !== "manifest.json");
  if (actualPaths.length !== declaredPaths.size || actualPaths.some((path) => !declaredPaths.has(path))) {
    throw new Error("archive_format_invalid");
  }
  for (const entry of manifest.entries) {
    const bytes = files.get(entry.path);
    if (!bytes || bytes.byteLength !== entry.byteLength || sha256(bytes) !== entry.sha256) {
      throw new Error("archive_unavailable");
    }
  }
  const payloadHashes = manifest.payloads.map((payload) => {
    const entry = manifest.entries.find((candidate) => candidate.path === payload.path);
    if (!entry) throw new Error("archive_format_invalid");
    return entry.sha256;
  });
  if (calculateContentFingerprint({
    payloadHashes,
    originalAssetHashes: manifest.assets.map((asset) => asset.contentHash)
  }) !== manifest.contentFingerprint) {
    throw new Error("archive_unavailable");
  }
  const rawCampaign = recordValue(jsonText(files.get("campaign.json")!));
  const world = recordValue(jsonText(files.get("world.json")!));
  const chronicle = recordValue(jsonText(files.get("chronicle.json")!));
  const assetPayload = recordValue(jsonText(files.get("assets/assets.json")!));
  if (assetPayload.formatVersion !== 1 || canonicalArchiveJson(assetPayload.assets) !== canonicalArchiveJson(manifest.assets)) {
    throw new Error("archive_format_invalid");
  }
  if (!Array.isArray(rawCampaign.turns) || recordValue(rawCampaign.archiveRecords).formatVersion !== 1
    || chronicle.formatVersion !== 1 || !Array.isArray(chronicle.memories) || !Array.isArray(chronicle.summaries)) {
    throw new Error("archive_format_invalid");
  }
  const normalized = normalizeCurrentCampaign(rawCampaign, world);
  const campaign = normalized.campaign;
  validateCurrentCampaignReferences(manifest, campaign, world);
  const grouped = new Map<string, ArchiveAssetRecord[]>();
  for (const record of manifest.assets) {
    const group = grouped.get(record.contentHash) ?? [];
    group.push(record);
    grouped.set(record.contentHash, group);
  }
  const assets: CampaignArchiveAsset[] = [];
  for (const records of [...grouped.values()].sort((left, right) => left[0]!.archivePath.localeCompare(right[0]!.archivePath))) {
    const representative = records[0]!;
    if (records.some((record) => record.archivePath !== representative.archivePath
      || record.mimeType !== representative.mimeType || record.byteLength !== representative.byteLength
      || record.pixelWidth !== representative.pixelWidth || record.pixelHeight !== representative.pixelHeight)) {
      throw new Error("archive_format_invalid");
    }
    const bytes = files.get(representative.archivePath);
    if (!bytes) throw new Error("archive_unavailable");
    decodedPixelCount += await verifyCurrentAsset(representative, bytes);
    if (decodedPixelCount > MAXIMUM_NORMALIZED_IMPORT_AGGREGATE_PIXELS) {
      throw new Error("archive_size_limit_exceeded");
    }
    assets.push({
      sourceAssetIds: records.map((record) => record.sourceAssetId),
      records,
      entryName: representative.archivePath,
      mimeType: representative.mimeType,
      byteLength: representative.byteLength,
      contentHash: representative.contentHash,
      ...(includeAssetBytes ? { bytes } : {})
    });
  }
  return {
    archiveFormat: "manifest_v1",
    story: null,
    campaign,
    world,
    chronicle,
    manifest,
    assets,
    warnings: normalized.warnings
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PORTABLE_PLACEHOLDER_CAMPAIGN_ID = "00000000-0000-4000-8000-000000000000";
const MAXIMUM_NORMALIZED_IMPORT_IMAGE_PIXELS = 40_000_000;
const MAXIMUM_NORMALIZED_IMPORT_AGGREGATE_PIXELS = 40_000_000;

function stablePortableUuid(preimage: string): string {
  const value = sha256(preimage).slice(0, 32).split("");
  value[12] = "4";
  value[16] = ["8", "9", "a", "b"][Number.parseInt(value[16]!, 16) % 4]!;
  const hex = value.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parsePortableDataImage(value: unknown): Readonly<{
  mimeType: ArchiveAssetRecord["mimeType"];
  bytes: Uint8Array;
}> | null {
  if (typeof value !== "string" || !value.startsWith("data:image/")) return null;
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/u.exec(value);
  if (!match) return null;
  const bytes = Uint8Array.from(Buffer.from(match[2]!, "base64"));
  return bytes.byteLength > 0 && bytes.byteLength <= MAX_ASSET_BYTES
    ? { mimeType: match[1] as ArchiveAssetRecord["mimeType"], bytes }
    : null;
}

async function inspectedLegacyOptionalImage(
  bytes: Uint8Array,
  mimeType: ArchiveAssetRecord["mimeType"],
) {
  try {
    return await inspectPrivateImageArtifact({
      bytes,
      declaredMimeType: mimeType,
      maximumBytes: MAX_ASSET_BYTES,
      maximumPixels: MAXIMUM_NORMALIZED_IMPORT_IMAGE_PIXELS,
      diagnosticPrefix: "portable_import_image"
    });
  } catch {
    return null;
  }
}

async function legacyInlineAssetInventory(
  story: ReturnType<typeof legacyStorySchema.parse>,
  includeBytes: boolean,
): Promise<readonly CampaignArchiveAsset[]> {
  const sourceCampaignId = typeof story.campaign?.sourceCampaignId === "string"
    && UUID_PATTERN.test(story.campaign.sourceCampaignId)
    ? story.campaign.sourceCampaignId
    : null;
  const campaignId = sourceCampaignId ?? PORTABLE_PLACEHOLDER_CAMPAIGN_ID;
  const candidates = [
    ...(typeof story.world.coverImageUrl === "string"
      && story.world.coverImageUrl.startsWith("data:image/")
      ? [Object.freeze({
        role: "world_cover" as const,
        value: story.world.coverImageUrl
      })]
      : []),
    ...story.turns.flatMap((turn, turnOrdinal) => (
      typeof turn.imageUrl === "string" && turn.imageUrl.startsWith("data:image/")
        ? [Object.freeze({ role: "turn_illustration" as const, value: turn.imageUrl, turn, turnOrdinal })]
        : []
    ))
  ];
  if (candidates.length > MAX_ARCHIVE_ENTRIES) return [];
  const grouped = new Map<string, CampaignArchiveAsset>();
  for (const candidate of candidates) {
    const parsed = parsePortableDataImage(candidate.value);
    if (!parsed) continue;
    const contentHash = sha256(parsed.bytes);
    const inspected = await inspectedLegacyOptionalImage(parsed.bytes, parsed.mimeType);
    if (!inspected) continue;
    const metadata = inspected.technicalMetadata;
    const sourceAssetId = candidate.role === "world_cover"
      ? stablePortableUuid(`legacy-inline-cover:${contentHash}`)
      : stablePortableUuid(`legacy-inline:${candidate.turnOrdinal}:${contentHash}`);
    const sourceTurnId = candidate.role === "turn_illustration"
      && typeof candidate.turn.id === "string"
      ? candidate.turn.id
      : null;
    const bindings: ArchiveAssetRecord["bindings"] = candidate.role === "world_cover"
      ? [{ role: "world_cover", worldId: PORTABLE_PLACEHOLDER_CAMPAIGN_ID }]
      : sourceTurnId && UUID_PATTERN.test(sourceTurnId)
        ? [{ role: "turn_illustration", campaignId, turnId: sourceTurnId }]
        : [];
    const record = archiveAssetRecordSchema.parse({
      sourceAssetId,
      contentHash,
      archivePath: `legacy-inline/${contentHash}`,
      mimeType: parsed.mimeType,
      byteLength: parsed.bytes.byteLength,
      pixelWidth: metadata.pixelWidth,
      pixelHeight: metadata.pixelHeight,
      technicalMetadata: { format: metadata.format, pages: metadata.pages, orientation: metadata.orientation },
      library: {
        title: "", caption: "", notes: "", tags: [], origin: "imported",
        reviewStatus: "unreviewed", reuseScope: "campaign", automaticReuseEnabled: false,
        contentCategories: [], favorite: false, archivedAt: null
      },
      createdAt: "1970-01-01T00:00:00.000Z",
      bindings
    });
    const legacyTurnBindings = candidate.role === "turn_illustration"
      ? [Object.freeze({
        sourceAssetId,
        sourceCampaignId,
        sourceTurnId,
        turnOrdinal: candidate.turnOrdinal
      })]
      : [];
    const existing = grouped.get(contentHash);
    if (existing) {
      grouped.set(contentHash, {
        ...existing,
        sourceAssetIds: [...existing.sourceAssetIds, sourceAssetId],
        records: [...existing.records, record],
        legacyTurnBindings: [...(existing.legacyTurnBindings ?? []), ...legacyTurnBindings]
      });
    } else {
      grouped.set(contentHash, {
        sourceAssetIds: [sourceAssetId],
        records: [record],
        legacyTurnBindings,
        entryName: record.archivePath,
        mimeType: record.mimeType,
        byteLength: record.byteLength,
        contentHash,
        ...(includeBytes ? { bytes: parsed.bytes } : {})
      });
    }
  }
  return [...grouped.values()].sort((left, right) => left.contentHash.localeCompare(right.contentHash));
}

function legacyCompanionLookupKeys(value: string): readonly string[] {
  const uuid = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu)?.[0];
  const name = value.split("/").pop()?.split("?")[0];
  const stem = name?.split(".")[0];
  return [...new Set([value, uuid, name, stem].filter((key): key is string => Boolean(key)))];
}

function isLegacyExternalImageUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isLegacyAbsoluteCompanionKey(value: string): boolean {
  const trimmed = value.trim();
  const segments = trimmed.split("/");
  if (trimmed.startsWith("/") || trimmed.startsWith("\\") || trimmed.includes("\\")
    || segments.some((segment) => segment === "." || segment === "..")) {
    return true;
  }
  try {
    return /^[a-z][a-z0-9+.-]*:/iu.test(trimmed) && Boolean(new URL(trimmed).protocol);
  } catch {
    return false;
  }
}

function optionalLegacyCompanions(
  companions: readonly import("../../../packages/application/src/imports/private-portable-composition.js").PrivateLegacyStoryCompanionAsset[],
): readonly import("../../../packages/application/src/imports/private-portable-composition.js").PrivateLegacyStoryCompanionAsset[] {
  if (companions.length > MAX_ARCHIVE_ENTRIES) return Object.freeze([]);
  let aggregateBytes = 0;
  for (const companion of companions) {
    const artifact = companion.artifact;
    if (!(artifact.bytes instanceof Uint8Array)
      || !Number.isSafeInteger(artifact.byteLength)
      || artifact.byteLength <= 0
      || artifact.byteLength > MAX_ASSET_BYTES
      || artifact.bytes.byteLength !== artifact.byteLength
      || sha256(artifact.bytes) !== artifact.contentHash) {
      return Object.freeze([]);
    }
    aggregateBytes += artifact.byteLength;
    if (aggregateBytes > MAX_INPUT_BYTES) return Object.freeze([]);
  }
  return companions;
}

async function legacyCompanionAssetInventory(
  story: ReturnType<typeof legacyStorySchema.parse>,
  companions: readonly import("../../../packages/application/src/imports/private-portable-composition.js").PrivateLegacyStoryCompanionAsset[],
): Promise<readonly import("../../../packages/application/src/imports/private-portable-composition.js").PrivatePortableAssetInventoryItem[]> {
  if (companions.length > MAX_ARCHIVE_ENTRIES) throw new Error("archive_entry_limit_exceeded");
  type LegacyCompanion = (typeof companions)[number];
  const boundedCompanions: LegacyCompanion[] = [];
  let aggregateBytes = 0;
  for (const companion of companions) {
    const artifact = companion.artifact;
    if (!(artifact.bytes instanceof Uint8Array)
      || !Number.isSafeInteger(artifact.byteLength)
      || artifact.byteLength <= 0
      || artifact.byteLength > MAX_ASSET_BYTES
      || artifact.bytes.byteLength !== artifact.byteLength) {
      throw new Error("archive_size_limit_exceeded");
    }
    aggregateBytes += artifact.byteLength;
    if (aggregateBytes > MAX_INPUT_BYTES) throw new Error("archive_size_limit_exceeded");
    boundedCompanions.push(companion);
  }
  const sourceCampaignId = typeof story.campaign?.sourceCampaignId === "string"
    && UUID_PATTERN.test(story.campaign.sourceCampaignId)
    ? story.campaign.sourceCampaignId
    : null;
  const campaignId = sourceCampaignId ?? PORTABLE_PLACEHOLDER_CAMPAIGN_ID;
  const coverUrl = typeof story.world.coverImageUrl === "string" ? story.world.coverImageUrl : "";
  const normalizedCompanions: {
    companion: LegacyCompanion;
    metadata: NonNullable<Awaited<ReturnType<typeof inspectedLegacyOptionalImage>>>[
      "technicalMetadata"
    ];
  }[] = [];
  for (const companion of boundedCompanions) {
    if (!companion.sourceKey.trim()
      || companion.sourceKey.length > 512
      || companion.sourceKey.includes("\0")
      || isLegacyAbsoluteCompanionKey(companion.sourceKey)) {
      continue;
    }
    const artifact = companion.artifact;
    if (sha256(artifact.bytes) !== artifact.contentHash) throw new Error("archive_unavailable");
    const inspected = await inspectedLegacyOptionalImage(artifact.bytes, artifact.mimeType);
    if (!inspected) continue;
    normalizedCompanions.push(Object.freeze({ companion, metadata: inspected.technicalMetadata }));
  }
  const aliasesOverlap = (sourceKey: string, value: unknown) => typeof value === "string"
    && legacyCompanionLookupKeys(value).some((key) => legacyCompanionLookupKeys(sourceKey).includes(key));
  const aliasesMatch = (sourceKey: string, value: unknown) => typeof value === "string"
    && !isLegacyAbsoluteCompanionKey(value)
    && aliasesOverlap(sourceKey, value);
  const resolveCompanion = (value: unknown) => {
    if (typeof value !== "string" || !value || isLegacyAbsoluteCompanionKey(value)) return null;
    const exact = normalizedCompanions.filter(({ companion }) => companion.sourceKey === value);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null;
    const aliased = normalizedCompanions.filter(({ companion }) => aliasesMatch(companion.sourceKey, value));
    return aliased.length === 1 ? aliased[0] : null;
  };
  const inventory = [];
  for (const normalizedCompanion of normalizedCompanions) {
    const { companion, metadata } = normalizedCompanion;
    const artifact = companion.artifact;
    const sourceKeys = legacyCompanionLookupKeys(companion.sourceKey);
    const matchingTurns = story.turns.flatMap((candidate, turnOrdinal) => (
      resolveCompanion(candidate.imageUrl) === normalizedCompanion ? [{ candidate, turnOrdinal }] : []
    ));
    const assignedCover = resolveCompanion(coverUrl) === normalizedCompanion;
    const mentionedBySource = aliasesOverlap(companion.sourceKey, coverUrl)
      || story.turns.some((candidate) => aliasesOverlap(companion.sourceKey, candidate.imageUrl));
    if (!assignedCover && matchingTurns.length === 0 && mentionedBySource) continue;
    const sourceAssetId = stablePortableUuid(`legacy-companion:${companion.sourceKey}:${artifact.contentHash}`);
    const turnBindings = matchingTurns.flatMap(({ candidate }) => (
      typeof candidate.id === "string" && UUID_PATTERN.test(candidate.id)
        ? [{ role: "turn_illustration" as const, campaignId, turnId: candidate.id }]
        : []
    ));
    const bindings: ArchiveAssetRecord["bindings"] = [
      ...(assignedCover
        ? [{ role: "world_cover" as const, worldId: PORTABLE_PLACEHOLDER_CAMPAIGN_ID }]
        : []),
      ...turnBindings
    ];
    if (bindings.length === 0 && matchingTurns.length === 0) {
      bindings.push({ role: "imported_attachment", campaignId, turnId: null });
    }
    const record = archiveAssetRecordSchema.parse({
      sourceAssetId,
      contentHash: artifact.contentHash,
      archivePath: `legacy-companion/${artifact.contentHash}`,
      mimeType: artifact.mimeType,
      byteLength: artifact.byteLength,
      pixelWidth: metadata.pixelWidth,
      pixelHeight: metadata.pixelHeight,
      technicalMetadata: { format: metadata.format, pages: metadata.pages, orientation: metadata.orientation },
      library: {
        title: "", caption: "", notes: "", tags: [], origin: "imported",
        reviewStatus: "unreviewed", reuseScope: "campaign", automaticReuseEnabled: false,
        contentCategories: [], favorite: false, archivedAt: null
      },
      createdAt: "1970-01-01T00:00:00.000Z",
      bindings
    });
    inventory.push({
      sourceAssetIds: [sourceAssetId],
      sourceKeys,
      legacyTurnBindings: matchingTurns.map(({ candidate, turnOrdinal }) => ({
        sourceAssetId,
        sourceCampaignId,
        sourceTurnId: typeof candidate.id === "string" ? candidate.id : null,
        turnOrdinal
      })),
      records: [record],
      artifact
    });
  }
  return inventory;
}

function mergeLegacyStoryAssetInventory(
  assets: readonly import("../../../packages/application/src/imports/private-portable-composition.js").PrivatePortableAssetInventoryItem[],
): readonly import("../../../packages/application/src/imports/private-portable-composition.js").PrivatePortableAssetInventoryItem[] {
  const grouped = new Map<string, import("../../../packages/application/src/imports/private-portable-composition.js").PrivatePortableAssetInventoryItem>();
  for (const asset of assets) {
    const existing = grouped.get(asset.artifact.contentHash);
    if (!existing) {
      grouped.set(asset.artifact.contentHash, asset);
      continue;
    }
    if (existing.artifact.mimeType !== asset.artifact.mimeType
      || existing.artifact.byteLength !== asset.artifact.byteLength
      || sha256(existing.artifact.bytes) !== sha256(asset.artifact.bytes)) {
      throw new Error("archive_format_invalid");
    }
    grouped.set(asset.artifact.contentHash, {
      sourceAssetIds: [...existing.sourceAssetIds, ...asset.sourceAssetIds],
      sourceKeys: [...new Set([...(existing.sourceKeys ?? []), ...(asset.sourceKeys ?? [])])],
      legacyTurnBindings: [...(existing.legacyTurnBindings ?? []), ...(asset.legacyTurnBindings ?? [])],
      records: [...existing.records, ...asset.records],
      artifact: existing.artifact
    });
  }
  return [...grouped.values()].sort((left, right) => (
    left.artifact.contentHash.localeCompare(right.artifact.contentHash)
  ));
}

function portableAggregatePixels(records: readonly ArchiveAssetRecord[]): number {
  const dimensions = new Map<string, Readonly<{ width: number; height: number }>>();
  for (const record of records) {
    const existing = dimensions.get(record.contentHash);
    if (existing && (existing.width !== record.pixelWidth || existing.height !== record.pixelHeight)) {
      throw new Error("archive_format_invalid");
    }
    dimensions.set(record.contentHash, { width: record.pixelWidth, height: record.pixelHeight });
  }
  return [...dimensions.values()].reduce((total, value) => total + (value.width * value.height), 0);
}

export function createPortableFamilyPreviewAdapter(
  provider: PortableProviderWorldConversionPort,
  targets: PortableTargetWorldReaderPort,
): PrivatePortableFamilyPreviewPort {
  const adapter: PrivatePortableFamilyPreviewPort = {
    async extractCampaignZipAssets(source, expectedAuthority) {
      if (expectedAuthority.kind !== "campaign_zip") throw new Error("portable_import_authority_mismatch");
      const decoded = await campaignZip(source, true);
      const expected = expectedAuthority.normalizedPayload.assetRecords;
      const records = decoded.assets.flatMap((asset) => asset.records);
      const manifestAuthority = (assetManifest: PortableJsonValue) => canonicalPortableImportAuthority({
        ...expectedAuthority,
        normalizedPayload: { assetRecords: assetManifest }
      });
      if (manifestAuthority(exactPortableAssetAuthority(records)) !== manifestAuthority(expected ?? null)) {
        throw new Error("portable_import_authority_mismatch");
      }
      return decoded.assets.map((asset) => {
        const bytes = asset.bytes;
        if (!bytes || sha256(bytes) !== asset.contentHash || bytes.byteLength !== asset.byteLength) {
          throw new Error("archive_unavailable");
        }
        return {
          sourceAssetIds: asset.sourceAssetIds,
          ...(asset.legacyTurnBindings
            ? { legacyTurnBindings: asset.legacyTurnBindings }
            : {}),
          records: asset.records,
          artifact: {
            mimeType: asset.mimeType,
            byteLength: asset.byteLength,
            contentHash: asset.contentHash,
            bytes
          }
        };
      });
    },
    async extractLegacyStoryAssets(source, expectedAuthority, companions = []) {
      if (expectedAuthority.kind !== "legacy_story") throw new Error("portable_import_authority_mismatch");
      const story = legacyStorySchema.parse(jsonText(await boundedBytes(source, MAX_JSON_BYTES)));
      const inline = await legacyInlineAssetInventory(story, true);
      const companion = await legacyCompanionAssetInventory(story, companions);
      const merged = mergeLegacyStoryAssetInventory([
        ...inline.map((asset) => {
          if (!asset.bytes) throw new Error("archive_unavailable");
          return {
            sourceAssetIds: asset.sourceAssetIds,
            ...(asset.legacyTurnBindings
              ? { legacyTurnBindings: asset.legacyTurnBindings }
              : {}),
            records: asset.records,
            artifact: {
              mimeType: asset.mimeType,
              byteLength: asset.byteLength,
              contentHash: asset.contentHash,
              bytes: asset.bytes
            }
          };
        }),
        ...companion
      ]);
      const decoded = portableAggregatePixels(merged.flatMap((asset) => asset.records))
          > MAXIMUM_NORMALIZED_IMPORT_AGGREGATE_PIXELS
        ? []
        : merged.slice(0, MAX_ARCHIVE_ENTRIES);
      const expected = expectedAuthority.normalizedPayload.assetRecords;
      if (canonicalPortableImportAuthority({ ...expectedAuthority, normalizedPayload: { assetRecords: exactPortableAssetAuthority(decoded.flatMap((asset) => asset.records)) } })
        !== canonicalPortableImportAuthority({ ...expectedAuthority, normalizedPayload: { assetRecords: expected ?? null } })) {
        throw new Error("portable_import_authority_mismatch");
      }
      return decoded;
    },
    async previewCampaignZip(source, command) {
      const decoded = await campaignZip(source, false);
      const assetRecords = decoded.assets.flatMap((asset) => asset.records);
      if (decoded.archiveFormat === "manifest_v1") {
        const campaign = decoded.campaign!;
        const world = decoded.world!;
        const chronicle = decoded.chronicle!;
        const campaignMetadata = recordValue(campaign.campaign);
        const turns = campaign.turns as readonly unknown[];
        const worldContent = canonicalizeWorldContent(recordValue(world.content));
        const worldMetadata = recordValue(worldContent.world);
        const normalized = {
          sourceName: "campaign.zip",
          archiveFormat: "manifest_v1",
          contentFingerprint: decoded.manifest!.contentFingerprint,
          campaign: asJson(campaign),
          world: asJson(world),
          chronicle: asJson(chronicle),
          warnings: asJson(decoded.warnings),
          assetRecords: exactPortableAssetAuthority(assetRecords),
          ...(command.destination.kind === "embedded"
            ? { embeddedWorldImportRequest: asJson(currentWorldImportRequest(world)) }
            : {})
        };
        const value = authority(command, normalized);
        return {
          authority: value,
          projection: {
            valid: true,
            archiveType: "campaign",
            formatVersion: 1,
            contentFingerprint: decoded.manifest!.contentFingerprint,
            campaign: {
              title: typeof campaignMetadata.title === "string" && campaignMetadata.title.trim()
                ? campaignMetadata.title : "Imported campaign",
              sourceCampaignId: decoded.manifest!.campaignId!,
              acceptedTurnCount: turns.length,
              activeTurnNumber: Math.max(0, ...turns.map((turn) => Number(recordValue(turn).turnNumber ?? 0))),
              selectedCharacter: null
            },
            world: {
              title: typeof worldMetadata.title === "string" && worldMetadata.title.trim()
                ? worldMetadata.title : "Imported world",
              sourceWorldId: decoded.manifest!.worldId!,
              sourceWorldVersionId: decoded.manifest!.worldVersionId!,
              versionNumber: Number(world.versionNumber)
            },
            chronicle: {
              memoryCount: (chronicle.memories as readonly unknown[]).length,
              summaryCount: (chronicle.summaries as readonly unknown[]).length
            },
            assets: {
              originalCount: decoded.assets.length,
              totalBytes: decoded.assets.reduce((sum, asset) => sum + asset.byteLength, 0)
            },
            destination: command.destination.kind === "embedded"
              ? { kind: "embedded", operation: "create_world", worldId: null, worldVersionId: null }
              : {
                kind: "existing_world_version",
                operation: "attach_existing_world_version",
                worldId: command.destination.worldId,
                worldVersionId: command.destination.worldVersionId
              },
            providerDataIncluded: false,
            warnings: [...decoded.warnings]
          }
        };
      }
      const story = decoded.story!;
      const normalized = {
        sourceName: "campaign.zip",
        archiveFormat: "legacy_zip",
        story: asJson(story),
        assetRecords: exactPortableAssetAuthority(assetRecords),
        ...(command.destination.kind === "embedded"
          ? { embeddedWorldImportRequest: asJson(embeddedWorldRequest(story)) }
          : {})
      };
      const value = authority(command, normalized);
      return {
        authority: value,
        projection: {
          valid: true,
          archiveType: "campaign",
          formatVersion: 1,
          contentFingerprint: sha256(canonicalPortableImportAuthority(value)),
          campaign: {
            title: story.campaign?.title || story.world.title || "Imported campaign",
            sourceCampaignId: story.campaign?.sourceCampaignId ?? "00000000-0000-0000-0000-000000000000",
            acceptedTurnCount: story.turns.length,
            activeTurnNumber: story.turns.length,
            selectedCharacter: null
          },
          world: {
            title: story.world.title || "Imported world",
            sourceWorldId: "00000000-0000-0000-0000-000000000000",
            sourceWorldVersionId: story.campaign?.sourceWorldVersionId ?? "00000000-0000-0000-0000-000000000000",
            versionNumber: story.campaign?.sourceWorldVersionNumber ?? 1
          },
          chronicle: { memoryCount: story.turns.length, summaryCount: 0 },
          assets: {
            originalCount: decoded.assets.length,
            totalBytes: decoded.assets.reduce((sum, asset) => sum + asset.byteLength, 0)
          },
          destination: command.destination.kind === "embedded"
            ? { kind: "embedded", operation: "create_world", worldId: null, worldVersionId: null }
            : {
              kind: "existing_world_version",
              operation: "attach_existing_world_version",
              worldId: command.destination.worldId,
              worldVersionId: command.destination.worldVersionId
            },
          providerDataIncluded: false,
          warnings: []
        }
      };
    },
    async previewLegacyStory(source, command, companions = []) {
      const story = legacyStorySchema.parse(jsonText(await boundedBytes(source, MAX_JSON_BYTES)));
      const inlineAssets = await legacyInlineAssetInventory(story, false);
      const companionAssets = await legacyCompanionAssetInventory(story, companions);
      const groupedRecords = new Map<string, ArchiveAssetRecord[]>();
      for (const asset of inlineAssets) {
        groupedRecords.set(asset.contentHash, [
          ...(groupedRecords.get(asset.contentHash) ?? []),
          ...asset.records
        ]);
      }
      for (const asset of companionAssets) {
        groupedRecords.set(asset.artifact.contentHash, [
          ...(groupedRecords.get(asset.artifact.contentHash) ?? []),
          ...asset.records
        ]);
      }
      const candidateRecords = [...groupedRecords.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, MAX_ARCHIVE_ENTRIES)
        .flatMap(([, records]) => records);
      const assetRecords = portableAggregatePixels(candidateRecords)
          > MAXIMUM_NORMALIZED_IMPORT_AGGREGATE_PIXELS
        ? []
        : candidateRecords;
      return {
        authority: authority(command, {
          sourceName: "legacy.story",
          story: asJson(story),
          assetRecords: exactPortableAssetAuthority(assetRecords)
        }),
        projection: legacyProjection(story)
      };
    },
    async previewInfiniteWorlds(source, command) {
      const world = convertInfiniteWorldsWorld(jsonText(await boundedBytes(source, MAX_JSON_BYTES)));
      const request = worldImportRequestSchema.parse({ sourceName: "infinite-worlds.json", worldExport: world });
      return {
        authority: authority(command, { worldImportRequest: asJson(request) }),
        projection: worldProjection(world)
      };
    },
    async previewCyoa(source, command) {
      const parsed = parseCyoaExport(text(await boundedBytes(source, MAX_JSON_BYTES)));
      const converted = await provider.convertTemplate({
        ownerUserId: command.ownerUserId,
        template: extractCyoaLayers(parsed, "cyoa.json")
      });
      const request = worldImportRequestSchema.parse({ sourceName: "cyoa.json", worldExport: converted.world });
      return {
        authority: authority(command, { worldImportRequest: asJson(request) }, converted.providerConfigurationFingerprint),
        projection: {
          kind: "cyoa_json",
          valid: true,
          requiresProvider: true,
          warnings: [],
          counts: {
            topLevelTitle: converted.world.title,
            layer1ChaptersCount: extractCyoaLayers(parsed).excerpts.length,
            characterTarget: "3-4 playable characters"
          }
        }
      };
    },
    async previewWorldJson(source, command) {
      const world = portableWorldSchema.parse(jsonText(await boundedBytes(source, MAX_JSON_BYTES)));
      const request = worldImportRequestSchema.parse({ sourceName: "world.json", worldExport: world });
      return {
        authority: authority(command, { worldImportRequest: asJson(request) }),
        projection: worldProjection(world)
      };
    },
    async previewWorldText(source, command) {
      const sourceText = text(await boundedBytes(source, MAX_JSON_BYTES));
      const converted = await provider.convertTemplate({
        ownerUserId: command.ownerUserId,
        template: {
          sourceName: "world.txt",
          sourceKind: "prompt",
          title: "Imported world",
          summary: sourceText.slice(0, 10_000),
          keywords: [],
          excerpts: [],
          prompt: sourceText
        }
      });
      const request = worldImportRequestSchema.parse({ sourceName: "world.txt", worldExport: converted.world });
      return {
        authority: authority(command, { worldImportRequest: asJson(request) }, converted.providerConfigurationFingerprint),
        projection: {
          kind: "world_text",
          valid: true,
          requiresProvider: true,
          warnings: [],
          counts: {
            sourceCharacters: sourceText.length,
            sourceWords: sourceText.trim().split(/\s+/u).filter(Boolean).length
          }
        }
      };
    },
    async previewStoryText(source, command) {
      const sourceText = text(await boundedBytes(source, MAX_JSON_BYTES));
      const parsed = parseInfiniteWorldsStory(sourceText);
      const target = portableRecord(command.destination as unknown as PortableJsonValue);
      const loaded = await targets.readTargetWorldVersion({
        owner: { ownerUserId: command.ownerUserId },
        worldId: command.destination.worldId,
        worldVersionId: command.destination.worldVersionId
      });
      if (!loaded
        || loaded.ownerUserId !== command.ownerUserId
        || loaded.worldId !== command.destination.worldId
        || loaded.worldVersionId !== command.destination.worldVersionId) {
        throw new Error("portable_import_destination_invalid");
      }
      const characters = loaded.content.playableCharacters.map((character) => ({
        id: character.id,
        name: character.name
      }));
      const selectedCharacterId = command.selectedCharacterId
        ?? (characters.length === 1 ? characters[0]!.id : undefined);
      if (!selectedCharacterId || !characters.some((character) => character.id === selectedCharacterId)) {
        throw new Error("portable_story_character_required");
      }
      const story = infiniteWorldsStoryToLegacyStory(parsed, loaded.content, "story.txt", selectedCharacterId);
      return {
        authority: authority(
          command,
          { sourceName: "story.txt", story: asJson(story), target: asJson(target) },
          null,
          selectedCharacterId,
        ),
        projection: {
          kind: "story_text",
          valid: true,
          title: story.world.title || "Imported story",
          duplicate: false,
          existingCampaignId: null,
          targetWorldId: command.destination.worldId,
          diagnostics: [],
          characters,
          selectedCharacterId,
          counts: {
            turns: story.turns.length,
            completeHistoryCharacters: 0,
            estimatedHistoryTokens: 0
          },
          warnings: []
        }
      };
    }
  };
  return Object.freeze(adapter);
}

function portableRecord(value: PortableJsonValue): Readonly<Record<string, PortableJsonValue>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("portable_import_invalid");
  return value as Readonly<Record<string, PortableJsonValue>>;
}

export type PortableFamilyPreviewResult = Readonly<{
  authority: PortableCanonicalImportAuthority;
  projection: PortableImportPreviewView["projection"];
}>;

export type PortableImportExportCompositionOptions = Readonly<{
  pool: DatabasePool;
  roots: Readonly<{ archiveRoot: string; assetRoot: string }>;
  worlds: WorldRepositoryPort;
  provider: PortableProviderWorldConversionPort;
  targets: PortableTargetWorldReaderPort;
  exports: PrivatePortableExportBuilderPort;
  leaseOwner: string;
  leaseSeconds?: number;
  previewTtlSeconds?: number;
  exportTtlSeconds?: number;
  streamDeadlineSeconds?: number;
}>;

function future(seconds: number): string {
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 86_400) {
    throw new Error("portable_composition_duration_invalid");
  }
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function exactDestination(
  left: PortablePreviewDestination,
  right: PortablePreviewDestination,
): boolean {
  return canonicalPortableImportAuthority({
    kind: "world_json",
    destination: left,
    normalizedPayload: {},
    sourceInstallationId: null,
    sourceRecordId: null,
    selectedCharacterId: null,
    providerConfigurationFingerprint: null
  }) === canonicalPortableImportAuthority({
    kind: "world_json",
    destination: right,
    normalizedPayload: {},
    sourceInstallationId: null,
    sourceRecordId: null,
    selectedCharacterId: null,
    providerConfigurationFingerprint: null
  });
}

function authorityHash(value: PortableCanonicalImportAuthority): string {
  return sha256(canonicalPortableImportAuthority(value));
}

function safeDiagnostic(error: unknown): import("../../../packages/application/src/imports/types.js").PortableArchiveDiagnosticCode {
  const message = error instanceof Error ? error.message : "archive_unavailable";
  const allowed = new Set([
    "archive_entry_limit_exceeded",
    "archive_format_invalid",
    "archive_link_denied",
    "archive_path_invalid",
    "archive_size_limit_exceeded",
    "archive_truncated",
    "archive_unavailable"
  ]);
  return (allowed.has(message) ? message : "archive_unavailable") as import("../../../packages/application/src/imports/types.js").PortableArchiveDiagnosticCode;
}

function portableTargetPlan(
  operationId: string,
  value: PortableCanonicalImportAuthority,
  artifacts: readonly import("../../../packages/application/src/imports/private-portable-composition.js").PrivatePortableAssetInventoryItem[],
): PrivatePortableFamilyTargetPlan {
  const richCampaign = value.normalizedPayload.archiveFormat === "manifest_v1"
    ? portableRecord(value.normalizedPayload.campaign!)
    : null;
  const richArchiveRecords = richCampaign
    ? portableRecord(richCampaign.archiveRecords as PortableJsonValue)
    : null;
  const turnValues = richCampaign
    ? (Array.isArray(richCampaign.turns) ? richCampaign.turns : [])
    : legacyStorySchema.parse(value.normalizedPayload.story ?? value.normalizedPayload.campaign).turns;
  const turns = turnValues.map((turnValue, ordinal) => {
    const turn = recordValue(turnValue);
    const sourceTurnId = typeof turn.id === "string" ? turn.id : null;
    return Object.freeze({
      ordinal,
      sourceTurnId,
      targetTurnId: stablePortableUuid(`portable-target:${operationId}:turn:${ordinal}:${sourceTurnId ?? "none"}`)
    });
  });
  const mapRecords = (values: unknown, role: string) => (
    (Array.isArray(values) ? values : []).map((entry, ordinal) => {
      const sourceId = recordValue(entry).id;
      if (typeof sourceId !== "string" || !UUID_PATTERN.test(sourceId)) {
        throw new Error("portable_import_reference_invalid");
      }
      return Object.freeze({
        sourceId,
        targetId: stablePortableUuid(`portable-target:${operationId}:${role}:${ordinal}:${sourceId}`)
      });
    })
  );
  const generationContextIds = [...new Set(artifacts.flatMap((artifact) => (
    artifact.records.flatMap((record) => record.bindings
      .filter((binding) => binding.role === "generation_context")
      .map((binding) => binding.sourceContextId))
  )))];
  const worldId = value.destination.kind === "existing_world_version"
    ? value.destination.worldId
    : stablePortableUuid(`portable-target:${operationId}:world`);
  const worldVersionId = value.destination.kind === "existing_world_version"
    ? value.destination.worldVersionId
    : stablePortableUuid(`portable-target:${operationId}:world-version`);
  return Object.freeze({
    worldId,
    worldVersionId,
    campaignId: stablePortableUuid(`portable-target:${operationId}:campaign`),
    turns: Object.freeze(turns),
    illustrationSets: Object.freeze(mapRecords(richArchiveRecords?.illustrationSets, "illustration-set")),
    illustrationSegments: Object.freeze(mapRecords(richArchiveRecords?.illustrationSegments, "illustration-segment")),
    generationContexts: Object.freeze(generationContextIds.map((sourceId, ordinal) => Object.freeze({
      sourceId,
      targetId: stablePortableUuid(`portable-target:${operationId}:generation-context:${ordinal}:${sourceId}`)
    })))
  });
}

type PlannedPortableNormalizedAsset = Readonly<{
  input: PrivatePortableNormalizedAssetInput;
  children: PrivatePortableAssetChildPlan;
}>;

function planPortableNormalizedAssets(input: Readonly<{
  command: PortableImportCommitCommand;
  operationId: string;
  authority: PortableCanonicalImportAuthority;
  artifacts: readonly import("../../../packages/application/src/imports/private-portable-composition.js").PrivatePortableAssetInventoryItem[];
  targetPlan: PrivatePortableFamilyTargetPlan;
}>): readonly PlannedPortableNormalizedAsset[] {
  const turnIds = new Map(input.targetPlan.turns
    .filter((turn) => turn.sourceTurnId !== null)
    .map((turn) => [turn.sourceTurnId!, turn.targetTurnId]));
  const targetWorldId = input.targetPlan.worldId;
  const targetWorldVersionId = input.targetPlan.worldVersionId;
  const safeSourceKey = (sourceKey: string) => `source-key-sha256:${sha256(sourceKey)}`;
  const sourceRecordIdentity = (record: ArchiveAssetRecord) => sha256(canonicalArchiveJson(
    portableAssetAuthorityRecord(record),
  ));

  return Object.freeze(input.artifacts.map((artifact, assetOrdinal) => {
    const contexts = new Map<string, PrivatePortableAssetChildPlan["contexts"][number]>();
    const references = new Map<string, PrivatePortableAssetChildPlan["references"][number]>();
    const recordIntentKeys = artifact.records.map(() => new Set<string>());
    const addContext = (
      recordOrdinal: number,
      semantic: Readonly<Record<string, unknown>>,
      intent: Omit<PrivateAssetPublicationContextIntentInput, "intentKey">,
    ) => {
      const key = `portable-context-${sha256(canonicalArchiveJson(semantic))}`;
      recordIntentKeys[recordOrdinal]!.add(key);
      if (!contexts.has(key)) {
        contexts.set(key, Object.freeze({
          contextId: stablePortableUuid(`${input.operationId}:${assetOrdinal}:context:${key}`),
          intent: Object.freeze({ intentKey: key, ...intent })
        }));
      }
    };
    const addReference = (
      recordOrdinals: readonly number[],
      semantic: Readonly<Record<string, unknown>>,
      intent: Omit<PrivateAssetPublicationReferenceIntentInput, "intentKey">,
    ) => {
      const key = `portable-reference-${sha256(canonicalArchiveJson({
        source: semantic,
        assetRole: intent.assetRole,
        campaignId: intent.campaignId ?? null,
        turnId: intent.turnId ?? null
      }))}`;
      for (const recordOrdinal of recordOrdinals) recordIntentKeys[recordOrdinal]!.add(key);
      if (!references.has(key)) {
        references.set(key, Object.freeze({
          referenceId: stablePortableUuid(`${input.operationId}:${assetOrdinal}:reference:${key}`),
          intent: Object.freeze({ intentKey: key, ...intent })
        }));
      }
    };
    const recordOrdinals = new Map(artifact.records.map((record, ordinal) => [record.sourceAssetId, ordinal]));
    const legacyOrdinalSourceAssetIds = new Set(
      (artifact.legacyTurnBindings ?? []).map((binding) => binding.sourceAssetId),
    );
    for (const binding of artifact.legacyTurnBindings ?? []) {
      const plannedTurn = input.targetPlan.turns[binding.turnOrdinal];
      const recordOrdinal = recordOrdinals.get(binding.sourceAssetId);
      if (!plannedTurn
        || recordOrdinal === undefined
        || plannedTurn.ordinal !== binding.turnOrdinal
        || plannedTurn.sourceTurnId !== binding.sourceTurnId) {
        throw new Error("portable_import_reference_invalid");
      }
      addReference([recordOrdinal], {
        role: "turn_illustration",
        sourceAssetId: binding.sourceAssetId,
        sourceCampaignId: binding.sourceCampaignId,
        sourceTurnId: binding.sourceTurnId,
        campaignId: input.targetPlan.campaignId,
        turnId: plannedTurn.targetTurnId
      }, {
        assetRole: "turn_illustration",
        sourceCampaignId: binding.sourceCampaignId,
        sourceTurnId: binding.sourceTurnId && UUID_PATTERN.test(binding.sourceTurnId)
          ? binding.sourceTurnId
          : null,
        campaignId: input.targetPlan.campaignId,
        turnId: plannedTurn.targetTurnId
      });
    }
    for (const [recordOrdinal, record] of artifact.records.entries()) {
      for (const binding of record.bindings) {
        if (binding.role === "turn_illustration"
          && legacyOrdinalSourceAssetIds.has(record.sourceAssetId)) {
          continue;
        }
        if (binding.role === "world_cover") {
          addContext(recordOrdinal, {
            role: binding.role,
            sourceAssetId: record.sourceAssetId,
            sourceWorldId: binding.worldId,
            targetWorldId,
            targetWorldVersionId
          }, {
            sourceContextId: null,
            targetType: "world_cover",
            variantIndex: 0,
            worldId: targetWorldId,
            worldVersionId: targetWorldVersionId,
            campaignId: null,
            turnId: null,
            fictionPromptIdentity: null
          });
        } else if (binding.role === "turn_illustration"
          || binding.role === "illustration_segment_variant") {
          const targetTurnId = turnIds.get(binding.turnId);
          if (!targetTurnId) throw new Error("portable_import_reference_invalid");
          addReference([recordOrdinal], {
            role: "turn_illustration",
            sourceAssetId: record.sourceAssetId,
            sourceCampaignId: binding.campaignId,
            sourceTurnId: binding.turnId,
            campaignId: input.targetPlan.campaignId,
            turnId: targetTurnId
          }, {
            assetRole: "turn_illustration",
            sourceCampaignId: binding.campaignId,
            sourceTurnId: binding.turnId,
            campaignId: input.targetPlan.campaignId,
            turnId: targetTurnId
          });
          if (binding.role === "illustration_segment_variant") {
            addContext(recordOrdinal, {
              role: binding.role,
              sourceAssetId: record.sourceAssetId,
              segmentId: binding.segmentId,
              variantIndex: binding.variantIndex,
              turnId: targetTurnId
            }, {
              sourceContextId: null,
              targetType: "turn_illustration",
              variantIndex: binding.variantIndex,
              worldId: targetWorldId,
              worldVersionId: targetWorldVersionId,
              campaignId: input.targetPlan.campaignId,
              turnId: targetTurnId,
              fictionPromptIdentity: null
            });
          }
        } else if (binding.role === "campaign_asset" || binding.role === "world_version_asset") {
          addReference([recordOrdinal], {
            role: "world_asset",
            sourceAssetId: record.sourceAssetId,
            sourceRole: binding.role,
            campaignId: input.targetPlan.campaignId
          }, {
            assetRole: "world_asset",
            sourceCampaignId: "campaignId" in binding ? binding.campaignId : null,
            sourceTurnId: null,
            campaignId: input.targetPlan.campaignId,
            turnId: null
          });
        } else if (binding.role === "imported_attachment") {
          const targetTurnId = binding.turnId === null ? null : turnIds.get(binding.turnId);
          if (binding.turnId !== null && !targetTurnId) throw new Error("portable_import_reference_invalid");
          addReference([recordOrdinal], {
            role: binding.role,
            sourceAssetId: record.sourceAssetId,
            sourceCampaignId: binding.campaignId,
            sourceTurnId: binding.turnId,
            campaignId: input.targetPlan.campaignId,
            turnId: targetTurnId ?? null
          }, {
            assetRole: "import_attachment",
            sourceCampaignId: binding.campaignId === PORTABLE_PLACEHOLDER_CAMPAIGN_ID
              ? null
              : binding.campaignId,
            sourceTurnId: binding.turnId,
            campaignId: input.targetPlan.campaignId,
            turnId: targetTurnId ?? null
          });
        } else if (binding.role === "generation_context") {
          let targetTurnId: string | null = null;
          if (binding.turnId !== null) {
            targetTurnId = turnIds.get(binding.turnId) ?? null;
            if (!targetTurnId) throw new Error("portable_import_reference_invalid");
          }
          addContext(recordOrdinal, {
            role: binding.role,
            sourceAssetId: record.sourceAssetId,
            sourceContextId: binding.sourceContextId,
            worldId: binding.worldId === null ? null : targetWorldId,
            worldVersionId: binding.worldVersionId === null ? null : targetWorldVersionId,
            campaignId: binding.campaignId === null ? null : input.targetPlan.campaignId,
            turnId: targetTurnId
          }, {
            sourceContextId: binding.sourceContextId,
            targetType: "other",
            variantIndex: 0,
            worldId: binding.worldId === null ? null : targetWorldId,
            worldVersionId: binding.worldVersionId === null ? null : targetWorldVersionId,
            campaignId: binding.campaignId === null ? null : input.targetPlan.campaignId,
            turnId: targetTurnId,
            fictionPromptIdentity: null
          });
        }
      }
    }
    const contextPlans = Object.freeze([...contexts.values()].sort((left, right) => (
      left.intent.intentKey.localeCompare(right.intent.intentKey)
    )));
    const referencePlans = Object.freeze([...references.values()].sort((left, right) => (
      left.intent.intentKey.localeCompare(right.intent.intentKey)
    )));
    const children = Object.freeze({ contexts: contextPlans, references: referencePlans });
    const sourceRecords = artifact.records.flatMap((record, recordOrdinal) => {
      const originalCompanionKey = (artifact.sourceKeys ?? []).find((sourceKey) => (
        stablePortableUuid(`legacy-companion:${sourceKey}:${artifact.artifact.contentHash}`) === record.sourceAssetId
      ));
      const companionKeys = originalCompanionKey
        ? legacyCompanionLookupKeys(originalCompanionKey)
        : [];
      const keys: readonly (string | null)[] = input.command.kind === "campaign_zip"
        ? [safeSourceKey(record.archivePath)]
        : companionKeys.length > 0
          ? companionKeys.map(safeSourceKey)
          : [null];
      return keys.map((sourceKey) => Object.freeze({
        sourceKind: input.command.kind as "campaign_zip" | "legacy_story",
        sourceAssetId: record.sourceAssetId,
        sourceRecordId: sourceRecordIdentity(record),
        sourceKey,
        requestedLibrary: record.library,
        bindingIntentKeys: Object.freeze([...recordIntentKeys[recordOrdinal]!].sort())
      }));
    });
    const representative = artifact.records[0];
    if (!representative) throw new Error("portable_import_asset_mapping_invalid");
    return Object.freeze({
      input: Object.freeze({
        idempotencyKey: toAssetMutationIdempotencyKey(
          `portable-${sha256(`${input.command.idempotencyKey}:${assetOrdinal}:${artifact.sourceAssetIds.join(",")}:${artifact.artifact.contentHash}`)}`,
        ),
        artifact: Object.freeze({
          bytes: artifact.artifact.bytes,
          declaredMimeType: artifact.artifact.mimeType,
          byteLength: artifact.artifact.byteLength,
          contentHash: artifact.artifact.contentHash
        }),
        requestedLibrary: representative.library,
        sourceRecords: Object.freeze(sourceRecords),
        sourceInstallationId: input.authority.sourceInstallationId === null
          ? null
          : `source-installation-sha256:${sha256(input.authority.sourceInstallationId)}`,
        contextIntents: Object.freeze(contextPlans.map(({ intent }) => intent)),
        referencePolicy: referencePlans.length === 0
          ? Object.freeze({ mode: "omit" as const })
          : Object.freeze({
            mode: "attach" as const,
            intents: Object.freeze(referencePlans.map(({ intent }) => intent))
          })
      }),
      children
    });
  }));
}

/**
 * Private, unconsumed 14e3d graph. Route and worker binding remains 14e3g.
 */
export async function createPortableImportExportComposition(
  options: PortableImportExportCompositionOptions,
): Promise<PortableImportExportComposition> {
  const leaseSeconds = options.leaseSeconds ?? 60;
  const previewTtlSeconds = options.previewTtlSeconds ?? 900;
  const exportTtlSeconds = options.exportTtlSeconds ?? 900;
  const streamDeadlineSeconds = options.streamDeadlineSeconds ?? 60;
  if (!options.leaseOwner.trim() || options.leaseOwner.length > 512) {
    throw new Error("portable_composition_lease_owner_invalid");
  }
  future(leaseSeconds);
  future(previewTtlSeconds);
  future(exportTtlSeconds);
  future(streamDeadlineSeconds);
  const assets = await createPrivatePortableNormalizedAssetPublicationComposition(options.pool, options.roots);
  const storage = assets.portableStorage;
  const authority = createPostgresPortableImportAuthorityRepository(
    options.pool,
    storage.repository,
    assets.coordinator,
  );
  const families = createPortableFamilyPreviewAdapter(options.provider, options.targets);
  const mutations = createPostgresPortableFamilyMutationRepository(options.worlds);
  const inputLimits = () => bindPrivateBoundedStreamLimits({
    maximumBytes: MAX_INPUT_BYTES,
    deadlineAt: future(streamDeadlineSeconds)
  });
  const owner = (ownerUserId: string): ImportOwnerScope => Object.freeze({ ownerUserId });

  const preview = async <Command extends PortableImportPreviewCommand>(
    command: Command,
    decode: (source: AsyncIterable<Uint8Array>, value: Command) => Promise<PortableFamilyPreviewResult>,
  ): Promise<PortableImportPreviewView<Command>> => {
    const session = await storage.adapter.openStagedInputSession({
      owner: owner(command.ownerUserId),
      stagedInput: command.stagedInput,
      claim: { leaseOwner: options.leaseOwner, leaseSeconds },
      limits: inputLimits()
    });
    try {
      const decoded = await decode(session.chunks, command);
      await session.finalize("eof");
      if (decoded.authority.kind !== command.kind
        || !exactDestination(decoded.authority.destination, command.destination)) {
        throw new Error("portable_import_authority_mismatch");
      }
      const fingerprint = authorityHash(decoded.authority);
      return authority.persistPreviewAuthority({
        command,
        authority: decoded.authority,
        authorityFingerprint: fingerprint,
        projection: decoded.projection as PortableImportPreviewView<Command>["projection"],
        diagnostics: [],
        expiresAt: future(previewTtlSeconds)
      });
    } catch (error) {
      await session.finalize("read_failure").catch(() => undefined);
      throw error;
    }
  };

  const completeCommittedReplay = async (
    command: PortableImportCommitCommand,
    view: import("../../../packages/application/src/imports/types.js").PortableImportCommitView,
  ) => {
    if (command.kind === "campaign_zip" || command.kind === "legacy_story") {
      try {
        const recovered = await assets.coordinator.recoverCommitted({
          ownerUserId: command.ownerUserId,
          previewToken: command.previewHandle.token,
          leaseOwner: options.leaseOwner,
          leaseSeconds
        });
        if (recovered.outcome === "committed_finalization_pending"
          && command.kind === "campaign_zip") {
          throw new Error(recovered.diagnostic);
        }
      } catch (error) {
        // Legacy images are optional. The exact mapping remains durable and a
        // later replay can reconcile it without revoking committed story data.
        if (command.kind === "campaign_zip") throw error;
      }
    }
    await authority.completeCommittedReplay(
      owner(command.ownerUserId),
      command.previewHandle.token,
    );
    return view;
  };

  const commit = async (
    command: PortableImportCommitCommand,
    artifacts: import("../../../packages/application/src/imports/private-portable-composition.js").PrivatePortableImportArtifacts = {},
  ) => {
    const suppliedLegacyStoryCompanions = artifacts.legacyStoryCompanions ?? [];
    if (command.kind !== "legacy_story" && suppliedLegacyStoryCompanions.length > 0) {
      throw new Error("portable_import_artifacts_invalid");
    }
    const legacyStoryCompanions = command.kind === "legacy_story"
      ? optionalLegacyCompanions(suppliedLegacyStoryCompanions)
      : Object.freeze([]);
    const assetBackedImport = command.kind === "campaign_zip" || command.kind === "legacy_story";
    // Binary-bearing imports must open and validate staged input before contending on
    // the operation lock used by reservation intents. Otherwise a replay probe
    // can briefly win that lock, roll back, and let another caller consume the
    // staged input before the first caller opens it.
    let previewAuthority = assetBackedImport
      ? await authority.readPreviewAuthority({ command })
      : null;
    const preparationOnly = Symbol("portable-import-preparation-only");
    if (!previewAuthority) {
      try {
        const replay = await withTransaction(options.pool, async (database) => {
          const begun = await authority.claimPreviewAuthority(database, {
            command,
            leaseOwner: options.leaseOwner,
            leaseSeconds
          });
          if (begun.outcome === "replay") return begun.view;
          throw preparationOnly;
        });
        return completeCommittedReplay(command, replay);
      } catch (error) {
        if (error !== preparationOnly) throw error;
      }
      previewAuthority = await authority.readPreviewAuthority({ command });
    }
    if (!previewAuthority) throw new Error("portable_import_authority_unavailable");
    const duplicateBeforeReservation = command.kind === "campaign_zip"
      || command.kind === "legacy_story"
      || command.kind === "story_text"
      ? await withTransaction(options.pool, (database) => mutations.findCampaignDuplicate(database, {
        owner: owner(command.ownerUserId),
        kind: command.kind,
        authorityFingerprint: previewAuthority.authorityFingerprint
      }))
      : null;
    let assetArtifacts: Awaited<ReturnType<PrivatePortableFamilyPreviewPort["extractCampaignZipAssets"]>> = [];
    if (assetBackedImport && !duplicateBeforeReservation) {
      const session = await storage.adapter.openPreviewInputSession<PortablePreviewDestination>({
        owner: owner(command.ownerUserId),
        kind: command.kind,
        previewHandle: command.previewHandle as PortablePreviewHandle<PortablePreviewDestination>,
        claim: { leaseOwner: options.leaseOwner, leaseSeconds },
        limits: inputLimits()
      });
      try {
        assetArtifacts = command.kind === "campaign_zip"
          ? await families.extractCampaignZipAssets(session.chunks, previewAuthority.authority)
          : await families.extractLegacyStoryAssets(
            session.chunks,
            previewAuthority.authority,
            legacyStoryCompanions,
          );
        await session.finalize("eof");
      } catch (error) {
        await session.finalize("read_failure").catch(() => undefined);
        throw error;
      }
    }
    const commitIdempotencyKeyHash = sha256(command.idempotencyKey);
    const targetPlan = assetBackedImport && !duplicateBeforeReservation
      ? portableTargetPlan(previewAuthority.operationId, previewAuthority.authority, assetArtifacts)
      : undefined;
    const plannedAssets = targetPlan
      ? planPortableNormalizedAssets({
        command,
        operationId: previewAuthority.operationId,
        authority: previewAuthority.authority,
        artifacts: assetArtifacts,
        targetPlan
      })
      : Object.freeze([]);
    let reservation: Awaited<ReturnType<typeof assets.coordinator.reserve>> | undefined;
    if (assetBackedImport && !duplicateBeforeReservation) {
      try {
        reservation = await assets.coordinator.reserve({
          scope: {
            operationId: previewAuthority.operationId,
            ownerUserId: command.ownerUserId,
            importKind: command.kind as "campaign_zip" | "legacy_story",
            authorityFingerprint: previewAuthority.authorityFingerprint,
            commitIdempotencyKeyHash
          },
          assets: plannedAssets.map(({ input }) => input),
          leaseOwner: options.leaseOwner,
          expiresAt: future(exportTtlSeconds)
        });
      } catch (reservationError) {
        try {
          const replay = await withTransaction(options.pool, async (database) => {
            const begun = await authority.claimPreviewAuthority(database, {
              command,
              leaseOwner: options.leaseOwner,
              leaseSeconds
            });
            if (begun.outcome === "replay") return begun.view;
            throw preparationOnly;
          });
          return completeCommittedReplay(command, replay);
        } catch (probeError) {
          if (probeError !== preparationOnly) throw probeError;
          throw reservationError;
        }
      }
    }
    let finalClaim: import("../../../packages/application/src/imports/private-portable-composition.js").PrivatePortableImportWorkClaim | undefined;
    let committed: import("../../../packages/application/src/imports/types.js").PortableImportCommitView | undefined;
    let reservationUnused = false;
    try {
      committed = await withTransaction(options.pool, async (database: DatabaseClient) => {
        const begun = await authority.claimPreviewAuthority(database, {
          command,
          leaseOwner: options.leaseOwner,
          leaseSeconds
        });
        if (begun.outcome === "replay") {
          reservationUnused = reservation !== undefined;
          if (reservation) {
            await assets.coordinator.beginRetirementInTransaction(
              database,
              reservation,
              "duplicate",
            );
          }
          return begun.view;
        }
        if (authorityHash(begun.authority) !== previewAuthority.authorityFingerprint
          || authorityHash(begun.authority) !== authorityHash(previewAuthority.authority)) {
          throw new Error("portable_import_authority_mismatch");
        }
        let claim = await authority.updateProgress(database, begun.claim, {
          phase: assetBackedImport ? "publishing_assets" : "mutating",
          percentage: assetBackedImport ? 45 : 55,
          diagnosticCode: null
        });
        const duplicate = command.kind === "campaign_zip"
          || command.kind === "legacy_story"
          || command.kind === "story_text"
          ? await mutations.findCampaignDuplicate(database, {
            owner: owner(command.ownerUserId),
            kind: command.kind,
            authorityFingerprint: previewAuthority.authorityFingerprint
          })
          : null;
        if (duplicate && reservation) reservationUnused = true;
        if (assetBackedImport && !duplicate && reservation) {
          claim = await authority.updateProgress(database, claim, {
            phase: "mutating",
            percentage: 65,
            diagnosticCode: null
          });
        }
        const mutationInput = {
          owner: owner(command.ownerUserId),
          destination: command.destination,
          authorityFingerprint: previewAuthority.authorityFingerprint,
          payload: begun.authority.normalizedPayload
        };
        let mutation: import("../../../packages/application/src/imports/private-portable-composition.js").PrivatePortableFamilyMutationResult;
        if (duplicate) {
          mutation = duplicate;
        } else if (assetBackedImport && reservation && targetPlan) {
          const attached = await assets.coordinator.attachInTransaction(
            database,
            reservation,
            async (results) => {
              const publishedAssets = results.map((result, index) => ({
                sourceAssetIds: assetArtifacts[index]!.sourceAssetIds,
                ...(assetArtifacts[index]!.sourceKeys
                  ? { sourceKeys: assetArtifacts[index]!.sourceKeys }
                  : {}),
                ...(assetArtifacts[index]!.legacyTurnBindings
                  ? { legacyTurnBindings: assetArtifacts[index]!.legacyTurnBindings }
                  : {}),
                records: assetArtifacts[index]!.records.map(({ archivePath: _archivePath, ...record }) => record),
                result,
                normalizedChildren: plannedAssets[index]!.children
              }));
              const value = command.kind === "campaign_zip"
                ? await mutations.commitCampaignZip(database, {
                  ...mutationInput,
                  targetPlan,
                  publishedAssets
                })
                : await mutations.commitLegacyStory(database, {
                  ...mutationInput,
                  targetPlan,
                  publishedAssets
                });
              const childBindings = value.normalizedChildBindings ?? [];
              if (childBindings.length !== results.length) {
                throw new Error("portable_import_asset_mapping_invalid");
              }
              return Object.freeze({ importId: value.importId, childBindings, value });
            },
          );
          mutation = attached.value;
        } else {
          mutation = command.kind === "story_text"
            ? await mutations.commitStoryText(database, mutationInput)
            : await mutations.commitWorld(database, {
              owner: mutationInput.owner,
              kind: command.kind as "infinite_worlds" | "cyoa" | "world_json" | "world_text",
              authorityFingerprint: mutationInput.authorityFingerprint,
              payload: mutationInput.payload
            });
        }
        claim = await authority.updateProgress(database, claim, {
          phase: "committing",
          percentage: 85,
          diagnosticCode: null
        });
        const view = await authority.completeImport(database, begun.commitClaim, {
          importId: mutation.importId,
          importedRecordId: toPortableImportedRecordId(mutation.importedRecordId),
          duplicate: mutation.duplicate,
          diagnostics: [],
          result: mutation.result as never,
          resultExpiresAt: future(previewTtlSeconds)
        });
        if (reservationUnused && reservation) {
          await assets.coordinator.beginRetirementInTransaction(
            database,
            reservation,
            "duplicate",
          );
        }
        finalClaim = await authority.updateProgress(database, claim, {
          phase: "finalizing",
          percentage: 95,
          diagnosticCode: null
        });
        return view;
      });
    } catch (error) {
      if (reservation) {
        try {
          await assets.coordinator.discardAfterRollback(reservation);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `${error instanceof Error ? error.message : "portable_import_failed"}; asset reservation cleanup failed`,
          );
        }
      }
      throw error;
    }
    if (!committed) throw new Error("portable_import_result_unavailable");
    try {
      if (reservationUnused && reservation) {
        try {
          await assets.coordinator.completeRetirement(reservation);
        } catch (error) {
          if (command.kind !== "legacy_story") throw error;
        }
      }
      if (!finalClaim) return await completeCommittedReplay(command, committed);
      if (assetBackedImport && committed.duplicate) {
        return await completeCommittedReplay(command, committed);
      }
      if (assetBackedImport) {
        const finalized = await assets.coordinator.finalizeOperation({
          ownerUserId: command.ownerUserId,
          operationId: previewAuthority.operationId,
          leaseOwner: options.leaseOwner,
          leaseSeconds
        });
        if (finalized.outcome === "committed_finalization_pending"
          && command.kind === "campaign_zip") {
          throw new Error(finalized.diagnostic);
        }
      }
      if (command.kind === "legacy_story") {
        await authority.completeCommittedReplay(
          owner(command.ownerUserId),
          command.previewHandle.token,
        );
        return committed;
      }
      await withTransaction(options.pool, (database) => authority.completeProgress(database, finalClaim!));
      return committed;
    } catch (error) {
      if (finalClaim) await authority.markRecoverable(finalClaim, safeDiagnostic(error));
      throw error;
    }
  };

  const publishExport = async (
    artifact: import("../../../packages/application/src/imports/private-portable-composition.js").PrivatePortableExportArtifact,
  ) => {
    if (!Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 0 || artifact.byteLength > MAX_INPUT_BYTES) {
      throw new Error("archive_size_limit_exceeded");
    }
    const issued = await storage.adapter.publishPortableExport({
      exportScope: artifact.exportScope,
      operationScopeId: randomUUID(),
      leaseOwner: options.leaseOwner,
      expiresAt: future(exportTtlSeconds),
      contentType: artifact.contentType,
      byteLength: artifact.byteLength,
      source: artifact.source
    });
    return Object.freeze({
      retrieval: issued.retrieval,
      contentType: artifact.contentType,
      byteLength: artifact.byteLength
    });
  };

  const composition: PortableImportExportComposition = {
    async stageInput(input) {
      const staged = await storage.adapter.stagePortableInput(input);
      return Object.freeze({ stagedInput: staged.stagedInput });
    },
    previewCampaignZip: (command) => preview(command, families.previewCampaignZip.bind(families)),
    previewLegacyStory: (command, artifacts = {}) => preview(
      command,
      (source, value) => families.previewLegacyStory(
        source,
        value,
        optionalLegacyCompanions(artifacts.legacyStoryCompanions ?? []),
      ),
    ),
    previewInfiniteWorlds: (command) => preview(command, families.previewInfiniteWorlds.bind(families)),
    previewCyoa: (command) => preview(command, families.previewCyoa.bind(families)),
    previewWorldJson: (command) => preview(command, families.previewWorldJson.bind(families)),
    previewWorldText: (command) => preview(command, families.previewWorldText.bind(families)),
    previewStoryText: (command) => preview(command, families.previewStoryText.bind(families)),
    commit,
    async createCampaignExport(input) {
      const artifact = await options.exports.buildCampaignArchive(input);
      if (artifact.exportScope.ownerUserId !== input.owner.ownerUserId
        || artifact.exportScope.exportKind !== "campaign_zip"
        || artifact.exportScope.campaignId !== input.campaignId) {
        throw new Error("portable_export_scope_mismatch");
      }
      return publishExport(artifact);
    },
    async createWorldExport(input) {
      const artifact = await options.exports.buildWorldJson(input);
      if (artifact.exportScope.ownerUserId !== input.owner.ownerUserId
        || artifact.exportScope.exportKind !== "world_json"
        || artifact.exportScope.worldId !== input.worldId
        || artifact.exportScope.worldVersionId !== input.worldVersionId) {
        throw new Error("portable_export_scope_mismatch");
      }
      return publishExport(artifact);
    },
    openExportSession(command) {
      return storage.adapter.openExportSession({
        scope: {
          ownerUserId: command.owner.ownerUserId,
          exportKind: command.exportKind,
          campaignId: command.campaignId,
          worldId: command.worldId,
          worldVersionId: command.worldVersionId
        },
        retrieval: command.retrieval,
        claim: { leaseOwner: options.leaseOwner, leaseSeconds },
        limits: inputLimits()
      });
    },
    progress: (value, previewToken) => authority.readProgress(value, previewToken),
    abort: (value, previewToken) => authority.abort(value, previewToken),
    async reap(input) {
      await authority.expireDueWork(input.limit);
      return storage.adapter.reapExpiredPortable(input);
    },
    close: () => assets.close()
  };
  return Object.freeze(composition);
}
