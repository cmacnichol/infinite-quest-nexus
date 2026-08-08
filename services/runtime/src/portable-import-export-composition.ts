import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import unzipper from "unzipper";
import {
  canonicalizeWorldContent,
  legacyStorySchema,
  portableWorldSchema,
  worldImportRequestSchema,
  type WorldContent
} from "../../../packages/contracts/src/index.js";
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
import {
  canonicalPortableImportAuthority,
  type PortableImportExportComposition,
  type PortableCanonicalImportAuthority,
  type PrivatePortableExportBuilderPort,
  type PortableJsonValue,
  type PrivatePortableFamilyMutationPort,
  type PrivatePortableFamilyPreviewPort
} from "../../../packages/application/src/imports/private-portable-composition.js";
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
import { createAssetPublicationComposition } from "./asset-import-composition.js";

const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 256;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_ENTRY_NAME_BYTES = 512;
const MAX_ZIP_ENTRY_EXTRA_BYTES = 1024;
const MAX_ZIP_ENTRY_COMMENT_BYTES = 1024;
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
      .filter(([key]) => !/(^|_)(path|bearer|credential|secret|token|provider_response|raw_response)($|_)/iu.test(key))
      .map(([key, child]) => [key, sanitize(child)]));
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
    sourceAssetId: string;
    entryName: string;
    mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
    byteLength: number;
    contentHash: string;
    bytes?: Uint8Array;
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

async function campaignZip(
  source: AsyncIterable<Uint8Array>,
  includeAssetBytes: boolean,
) {
  const inspector = new ZipCentralDirectoryInspector();
  const parser = Readable.from(boundedArchiveSource(source, inspector)).pipe(unzipper.Parse({ forceStream: true }));
  let entryCount = 0;
  let expandedBytes = 0;
  let story: ReturnType<typeof legacyStorySchema.parse> | undefined;
  const assets: CampaignArchiveAsset[] = [];
  const entryPaths: string[] = [];
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
      const isCampaign = entry.path === "campaign.json" || entry.path === "infinite-quest-campaign.json";
      const assetMatch = /^assets\/([0-9a-f-]{36})\.(png|jpe?g|webp|gif)$/iu.exec(entry.path);
      const maximum = isCampaign ? MAX_JSON_BYTES : assetMatch ? MAX_ASSET_BYTES : 1024 * 1024;
      if (declared !== undefined && declared > maximum) throw new Error("archive_size_limit_exceeded");
      const bytes = await readZipEntry(entry, maximum);
      expandedBytes += bytes.byteLength;
      if (expandedBytes > MAX_INPUT_BYTES) throw new Error("archive_size_limit_exceeded");
      if (isCampaign) {
        if (story) throw new Error("archive_format_invalid");
        story = legacyStorySchema.parse(jsonText(bytes));
        continue;
      }
      if (entry.path === "assets/assets.json") continue;
      if (/^assets\//u.test(entry.path) && !assetMatch) throw new Error("archive_format_invalid");
      if (!assetMatch) continue;
      const extension = assetMatch[2]!.toLowerCase();
      assets.push({
        sourceAssetId: assetMatch[1]!,
        entryName: entry.path,
        mimeType: extension === "png" ? "image/png"
          : extension === "webp" ? "image/webp"
            : extension === "gif" ? "image/gif" : "image/jpeg",
        byteLength: bytes.byteLength,
        contentHash: sha256(bytes),
        ...(includeAssetBytes ? { bytes } : {})
      });
    }
    inspector.verify(entryPaths);
  } catch (error) {
    parser.destroy();
    if (error instanceof Error && error.message.startsWith("archive_")) throw error;
    throw new Error("archive_truncated");
  }
  if (!story) throw new Error("archive_format_invalid");
  return { story, assets };
}

export function createPortableFamilyPreviewAdapter(
  provider: PortableProviderWorldConversionPort,
  targets: PortableTargetWorldReaderPort,
): PrivatePortableFamilyPreviewPort {
  const adapter: PrivatePortableFamilyPreviewPort = {
    async extractCampaignZipAssets(source, expectedAuthority) {
      if (expectedAuthority.kind !== "campaign_zip") throw new Error("portable_import_authority_mismatch");
      const decoded = await campaignZip(source, true);
      const expected = expectedAuthority.normalizedPayload.assetManifest;
      const manifest = decoded.assets.map(({ bytes: _bytes, ...asset }) => asset);
      const manifestAuthority = (assetManifest: PortableJsonValue) => canonicalPortableImportAuthority({
        ...expectedAuthority,
        normalizedPayload: { assetManifest }
      });
      if (manifestAuthority(asJson(manifest)) !== manifestAuthority(expected ?? null)) {
        throw new Error("portable_import_authority_mismatch");
      }
      return decoded.assets.map((asset) => {
        const bytes = asset.bytes;
        if (!bytes || sha256(bytes) !== asset.contentHash || bytes.byteLength !== asset.byteLength) {
          throw new Error("archive_unavailable");
        }
        return {
          sourceAssetId: asset.sourceAssetId,
          artifact: {
            mimeType: asset.mimeType,
            byteLength: asset.byteLength,
            contentHash: asset.contentHash,
            bytes
          }
        };
      });
    },
    async previewCampaignZip(source, command) {
      const decoded = await campaignZip(source, false);
      const assetManifest = decoded.assets.map(({ bytes: _bytes, ...asset }) => asset);
      const normalized = {
        sourceName: "campaign.zip",
        story: asJson(decoded.story),
        assetManifest: asJson(assetManifest),
        ...(command.destination.kind === "embedded"
          ? { embeddedWorldImportRequest: asJson(embeddedWorldRequest(decoded.story)) }
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
            title: decoded.story.campaign?.title || decoded.story.world.title || "Imported campaign",
            sourceCampaignId: decoded.story.campaign?.sourceCampaignId ?? "00000000-0000-0000-0000-000000000000",
            acceptedTurnCount: decoded.story.turns.length,
            activeTurnNumber: decoded.story.turns.length,
            selectedCharacter: null
          },
          world: {
            title: decoded.story.world.title || "Imported world",
            sourceWorldId: "00000000-0000-0000-0000-000000000000",
            sourceWorldVersionId: decoded.story.campaign?.sourceWorldVersionId ?? "00000000-0000-0000-0000-000000000000",
            versionNumber: decoded.story.campaign?.sourceWorldVersionNumber ?? 1
          },
          chronicle: { memoryCount: decoded.story.turns.length, summaryCount: 0 },
          assets: {
            originalCount: assetManifest.length,
            totalBytes: assetManifest.reduce((sum, asset) => sum + asset.byteLength, 0)
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
    async previewLegacyStory(source, command) {
      const story = legacyStorySchema.parse(jsonText(await boundedBytes(source, MAX_JSON_BYTES)));
      return {
        authority: authority(command, { sourceName: "legacy.story", story: asJson(story) }),
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
  const assets = await createAssetPublicationComposition(options.pool, options.roots);
  const authority = createPostgresPortableImportAuthorityRepository(options.pool, assets.storage.portable);
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
    const session = await assets.storage.adapter.openStagedInputSession({
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

  const buildAssetCommands = (
    command: PortableImportCommitCommand,
    artifacts: Awaited<ReturnType<PrivatePortableFamilyPreviewPort["extractCampaignZipAssets"]>>,
  ) => artifacts.map((asset, index) => ({
    owner: owner(command.ownerUserId),
    idempotencyKey: toAssetMutationIdempotencyKey(
      `portable-${sha256(`${command.idempotencyKey}:${index}:${asset.sourceAssetId}:${asset.artifact.contentHash}`)}`,
    ),
    leaseOwner: options.leaseOwner,
    expiresAt: future(exportTtlSeconds),
    original: asset.artifact,
    derivatives: [],
    provenance: { origin: "imported" as const }
  }));

  const completeCommittedReplay = async (
    command: PortableImportCommitCommand,
    view: import("../../../packages/application/src/imports/types.js").PortableImportCommitView,
  ) => {
    if (command.kind === "campaign_zip") {
      const result = view.result as Readonly<{ campaignId?: unknown }>;
      if (typeof result.campaignId !== "string" || result.campaignId.trim().length === 0) {
        throw new Error("portable_import_result_unavailable");
      }
      await assets.transactionalPublisher.recoverImportedAssets(
        owner(command.ownerUserId),
        result.campaignId,
        { leaseOwner: options.leaseOwner, leaseSeconds },
      );
    }
    await authority.completeCommittedReplay(
      owner(command.ownerUserId),
      command.previewHandle.token,
    );
    return view;
  };

  const commit = async (command: PortableImportCommitCommand) => {
    const preparationOnly = Symbol("portable-import-preparation-only");
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
    const previewAuthority = await authority.readPreviewAuthority({ command });
    if (!previewAuthority) throw new Error("portable_import_authority_unavailable");
    let assetArtifacts: Awaited<ReturnType<PrivatePortableFamilyPreviewPort["extractCampaignZipAssets"]>> = [];
    if (command.kind === "campaign_zip") {
      const campaignCommand = command as Extract<PortableImportCommitCommand, { kind: "campaign_zip" }>;
      const session = await assets.storage.adapter.openPreviewInputSession<PortablePreviewDestination>({
        owner: owner(command.ownerUserId),
        kind: command.kind,
        previewHandle: campaignCommand.previewHandle as PortablePreviewHandle<PortablePreviewDestination>,
        claim: { leaseOwner: options.leaseOwner, leaseSeconds },
        limits: inputLimits()
      });
      try {
        assetArtifacts = await families.extractCampaignZipAssets(session.chunks, previewAuthority.authority);
        await session.finalize("eof");
      } catch (error) {
        await session.finalize("read_failure").catch(() => undefined);
        throw error;
      }
    }
    const reservedAssets = await assets.transactionalPublisher.reserveImportedAssets(
      buildAssetCommands(command, assetArtifacts),
    );
    let attachments: Awaited<ReturnType<typeof assets.transactionalPublisher.attachImportedAssets>> = [];
    let finalClaim: import("../../../packages/application/src/imports/private-portable-composition.js").PrivatePortableImportWorkClaim | undefined;
    let committed: import("../../../packages/application/src/imports/types.js").PortableImportCommitView | undefined;
    try {
      committed = await withTransaction(options.pool, async (database: DatabaseClient) => {
        const begun = await authority.claimPreviewAuthority(database, {
          command,
          leaseOwner: options.leaseOwner,
          leaseSeconds
        });
        if (begun.outcome === "replay") {
          if (reservedAssets.length > 0) {
            await assets.transactionalPublisher.discardPreparedImportedAssets(database, reservedAssets);
          }
          return begun.view;
        }
        if (authorityHash(begun.authority) !== previewAuthority.authorityFingerprint
          || authorityHash(begun.authority) !== authorityHash(previewAuthority.authority)) {
          throw new Error("portable_import_authority_mismatch");
        }
        let claim = await authority.updateProgress(database, begun.claim, {
          phase: command.kind === "campaign_zip" ? "publishing_assets" : "mutating",
          percentage: command.kind === "campaign_zip" ? 45 : 55,
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
        if (duplicate && reservedAssets.length > 0) {
          await assets.transactionalPublisher.discardPreparedImportedAssets(database, reservedAssets);
        }
        if (command.kind === "campaign_zip" && !duplicate) {
          attachments = await assets.transactionalPublisher.attachImportedAssets(
            database,
            reservedAssets,
          );
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
        const mutation: import("../../../packages/application/src/imports/private-portable-composition.js").PrivatePortableFamilyMutationResult =
          duplicate ?? (command.kind === "campaign_zip"
            ? await mutations.commitCampaignZip(database, {
              ...mutationInput,
              publishedAssets: attachments.map((attachment) => attachment.result)
            })
            : command.kind === "legacy_story"
              ? await mutations.commitLegacyStory(database, mutationInput)
              : command.kind === "story_text"
                ? await mutations.commitStoryText(database, mutationInput)
                : await mutations.commitWorld(database, {
                  owner: mutationInput.owner,
                  kind: command.kind,
                  authorityFingerprint: mutationInput.authorityFingerprint,
                  payload: mutationInput.payload
                }));
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
        finalClaim = await authority.updateProgress(database, claim, {
          phase: "finalizing",
          percentage: 95,
          diagnosticCode: null
        });
        return view;
      });
    } catch (error) {
      await Promise.allSettled(attachments.map((attachment) => attachment.rollback()));
      const preparedReservations = reservedAssets.filter(({ identity }) => identity.lifecycle === "prepared");
      if (preparedReservations.length > 0) {
        try {
          await withTransaction(options.pool, (database) => (
            assets.transactionalPublisher.discardPreparedImportedAssets(database, preparedReservations)
          ));
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
    if (!finalClaim) return completeCommittedReplay(command, committed);
    try {
      await assets.transactionalPublisher.finalizeImportedAssets(attachments);
      await withTransaction(options.pool, (database) => authority.completeProgress(database, finalClaim!));
      return committed;
    } catch (error) {
      await authority.markRecoverable(finalClaim, safeDiagnostic(error));
      throw error;
    }
  };

  const publishExport = async (
    artifact: import("../../../packages/application/src/imports/private-portable-composition.js").PrivatePortableExportArtifact,
  ) => {
    if (!Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 0 || artifact.byteLength > MAX_INPUT_BYTES) {
      throw new Error("archive_size_limit_exceeded");
    }
    const issued = await assets.storage.adapter.publishPortableExport({
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
      const staged = await assets.storage.adapter.stagePortableInput(input);
      return Object.freeze({ stagedInput: staged.stagedInput });
    },
    previewCampaignZip: (command) => preview(command, families.previewCampaignZip.bind(families)),
    previewLegacyStory: (command) => preview(command, families.previewLegacyStory.bind(families)),
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
      return assets.storage.adapter.openExportSession({
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
      return assets.storage.adapter.reapExpiredPortable(input);
    },
    close: () => assets.close()
  };
  return Object.freeze(composition);
}
