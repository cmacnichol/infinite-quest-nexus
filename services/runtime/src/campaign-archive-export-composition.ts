import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import sharp from "sharp";
import type { ArchiveEntry, ArchiveManifest } from "../../../packages/contracts/src/archives.js";
import { canonicalArchiveJson } from "../../../packages/contracts/src/archives.js";
import { calculateContentFingerprint } from "../../../packages/contracts/src/archives-node.js";
import {
  canonicalizeWorldContent,
  type WorldContent,
} from "../../../packages/contracts/src/world-library.js";
import {
  loadCampaignArchiveExportSnapshot,
  type CampaignArchiveExportSnapshot,
} from "../../../packages/database/src/campaign-archive-export-repository.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { characterLegacyText } from "../../../packages/domain/src/world-characters.js";
import { removeProviderSecrets, sha256, stableStringify } from "../../../packages/domain/src/text.js";
import { detectImageMimeType } from "../../../packages/domain/src/image-media.js";
import {
  ArchiveError,
  writeArchiveArtifact,
  type ArchiveLimits,
  type CompletedArchiveArtifact,
} from "../../api/src/archive-io.js";

export type CampaignArchiveExportAssetReader = Readonly<{
  readOriginal(input: Readonly<{
    ownerUserId: string;
    assetId: string;
    maximumBytes: number;
  }>): Promise<Uint8Array>;
}>;

export type CampaignArchiveExportCommand = Readonly<{
  ownerUserId: string;
  campaignId: string;
  archiveRoot: string;
  limits: ArchiveLimits;
}>;

type ArchiveSourceEntry = Pick<ArchiveEntry, "path" | "logicalType" | "mediaType"> & Readonly<{
  source: Readable;
}>;

function secretKey(key: string): boolean {
  const normalized = key.replaceAll(/[^a-z0-9]/giu, "").toLowerCase();
  return /(?:apikey|password|authorization|credential|secret|privatekey|encryptionkey|encrypted|accesstoken|refreshtoken|bearertoken|authtag|nonce)/u.test(normalized)
    || normalized === "token" || normalized.endsWith("token");
}

function excludedPortableKey(key: string): boolean {
  const normalized = key.replaceAll(/[^a-z0-9]/giu, "").toLowerCase();
  return secretKey(key)
    || /^(?:baseurl|endpoint|customendpoint|lmstudioendpoint|imageendpoint|providerurl)$/u.test(normalized)
    || /^nexus(?:provider|imageprovider|embeddingprovider)/u.test(normalized)
    || /(?:embedding|vector|thumbnail|providerprofile|responsechain|rawresponse)/u.test(normalized);
}

function sanitizePortableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizePortableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !excludedPortableKey(key))
    .map(([key, child]) => [key, sanitizePortableValue(child)]));
}

function portableSettings(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return sanitizePortableValue(removeProviderSecrets(value)) as Record<string, unknown>;
}

function portableModelMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  return Object.fromEntries(["providerType", "model", "promptProtocolVersion"].flatMap((key) => (
    typeof source[key] === "string" && source[key] ? [[key, source[key]]] : []
  )));
}

function portableWorldContent(value: unknown): WorldContent {
  return canonicalizeWorldContent(sanitizePortableValue(value) as WorldContent);
}

function portableWorldContentHash(value: unknown): string {
  return sha256(stableStringify(portableWorldContent(value)));
}

function iso(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

function legacyPayload(snapshot: CampaignArchiveExportSnapshot, exportedAt: string): Record<string, unknown> {
  const row = snapshot.campaign;
  const content = portableWorldContent(row.content);
  const sourceWorld = content.world && typeof content.world === "object" ? content.world : {};
  const { character: _storedCharacter, ...worldWithoutStoredCharacter } = sourceWorld as Record<string, unknown>;
  const profile = row.character_profile as Record<string, unknown> | null;
  const selectedCharacterText = characterLegacyText(row.character_profile, row.character_snapshot);
  return sanitizePortableValue({
    format: "infinite-quest-campaign",
    formatVersion: 3,
    exportedAt,
    campaign: {
      title: row.title,
      sourceCampaignId: row.id,
      sourceWorldVersionId: row.world_version_id,
      sourceWorldVersionNumber: row.version_number,
      selectedCharacterId: row.selected_character_id ?? null,
      characterSnapshot: row.character_snapshot ?? null,
      characterProfile: row.character_profile ?? null,
      characterProfileRevision: Number(row.character_profile_revision || 0),
      stateRevision: Number(row.revision || 0),
    },
    world: { ...worldWithoutStoredCharacter, ...(selectedCharacterText ? { character: selectedCharacterText } : {}) },
    settings: {
      ...portableSettings(row.legacy_settings),
      storyLength: row.story_length_profile,
      turnControlStyle: row.turn_control_style,
    },
    turns: snapshot.turns.map((turn) => ({
      id: turn.id, turnNumber: turn.turn_number, action: turn.action,
      inputMode: turn.input_mode || "action", inputModeSource: turn.input_mode_source || "explicit",
      narration: turn.narration, choices: turn.choices, customActionSuggestion: turn.custom_action_suggestion,
      imagePrompt: turn.image_prompt, imageUrl: turn.image_url, roll: turn.mechanics_private,
      worldStateSnapshot: turn.state_snapshot_private, llmModelInfo: portableModelMetadata(turn.model_metadata),
      createdAt: iso(turn.accepted_at),
    })),
    rpgStats: row.rpg_stats,
    defaultTriggers: row.default_triggers,
    eventTriggers: row.event_triggers,
    pendingEventTriggers: row.pending_event_triggers,
    trackers: row.trackers,
    baseTrackersAtStart: row.default_triggers,
    scratchpad: row.scratchpad_private,
    ...(snapshot.legacyHistory ? {
      fullHistory: snapshot.legacyHistory.content,
      fullHistoryCompressedThroughTurn: snapshot.legacyHistory.through_turn,
    } : {}),
    worldImportProvenance: row.import_provenance?.world ?? null,
    storyImportProvenance: {
      ...(row.import_provenance?.story ?? {}),
      sourceType: "nexus_campaign_export",
      worldVersionId: row.world_version_id,
      worldVersionNumber: row.version_number,
      selectedCharacterId: row.selected_character_id ?? null,
      selectedCharacterName: profile?.name ?? row.character_snapshot?.name ?? null,
    },
  }) as Record<string, unknown>;
}

/**
 * The exact portable JSON payloads written as `campaign.json`, `world.json`, and
 * `chronicle.json`. Exported so the export allowlist can be proven without secure
 * archive staging, which is unavailable outside Linux.
 */
export function campaignArchivePayloads(snapshot: CampaignArchiveExportSnapshot) {
  return payloads(snapshot);
}

function payloads(snapshot: CampaignArchiveExportSnapshot) {
  const legacy = legacyPayload(snapshot, String(iso(snapshot.campaign.updated_at)));
  const content = portableWorldContent(snapshot.campaign.content);
  const canonicalHash = portableWorldContentHash(snapshot.campaign.content);
  const world = {
    canonicalHash,
    sourceWorldId: snapshot.campaign.world_id,
    sourceWorldVersionId: snapshot.campaign.world_version_id,
    versionNumber: Number(snapshot.campaign.version_number),
    content,
  };
  const records = {
    formatVersion: 1,
    characterProfileEdits: snapshot.profileEdits,
    stateEdits: snapshot.stateEdits,
    narrationCorrections: snapshot.narrationCorrections,
    worldMigrations: snapshot.migrations,
    illustrationConfig: snapshot.illustrationConfig,
    illustrationSets: snapshot.illustrationSets,
    illustrationSegments: snapshot.illustrationSegments,
    costs: snapshot.costs,
  };
  return {
    campaign: {
      ...legacy,
      world: { canonicalHash, sourceWorldId: world.sourceWorldId, sourceWorldVersionId: world.sourceWorldVersionId },
      archiveRecords: records,
    },
    world,
    chronicle: { formatVersion: 1, memories: snapshot.memories, summaries: snapshot.summaries },
  };
}

async function verifiedAssetEntries(
  snapshot: CampaignArchiveExportSnapshot,
  reader: CampaignArchiveExportAssetReader,
  maximumBytes: number,
): Promise<readonly ArchiveSourceEntry[]> {
  const entries: ArchiveSourceEntry[] = [];
  for (const original of snapshot.assets.uniqueOriginals) {
    if (original.byteLength > maximumBytes) {
      throw new ArchiveError("archive-limit-exceeded", "A required original image exceeds the configured export byte limit.", 400, {
        assetIds: original.sourceAssetIds,
      });
    }
    let bytes: Buffer | undefined;
    for (const assetId of original.sourceAssetIds) {
      try {
        bytes = Buffer.from(await reader.readOriginal({
          ownerUserId: snapshot.ownerUserId,
          assetId,
          maximumBytes,
        }));
        break;
      } catch {
        // Another logical asset with the same content may still be readable.
      }
    }
    if (!bytes) {
      throw Object.assign(new Error("Required archive assets are missing."), {
        code: "archive-asset-missing",
        assetIds: [...original.sourceAssetIds],
      });
    }
    const rawHash = createHash("sha256").update(bytes).digest("hex");
    const legacyHash = sha256(bytes.toString("base64"));
    const metadata = await sharp(bytes, { failOn: "error", limitInputPixels: false }).metadata();
    const signedMimeType = detectImageMimeType(bytes);
    if ((rawHash !== original.contentHash && legacyHash !== original.contentHash)
      || bytes.byteLength !== original.byteLength
      || metadata.width !== original.pixelWidth
      || metadata.height !== original.pixelHeight
      || signedMimeType !== original.mimeType) {
      throw Object.assign(new Error("Archive asset identity verification failed."), {
        code: "archive-asset-invalid",
        assetIds: [...original.sourceAssetIds],
      });
    }
    entries.push({
      path: original.archivePath,
      logicalType: "asset-original",
      mediaType: original.mimeType,
      source: Readable.from(bytes),
    });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export async function buildCampaignArchiveArtifact(
  pool: DatabasePool,
  reader: CampaignArchiveExportAssetReader,
  command: CampaignArchiveExportCommand,
): Promise<CompletedArchiveArtifact> {
  const snapshot = await loadCampaignArchiveExportSnapshot(pool, command.ownerUserId, command.campaignId);
  const projected = payloads(snapshot);
  const jsonEntries = [
    ["campaign.json", "campaign", projected.campaign],
    ["world.json", "world", projected.world],
    ["chronicle.json", "chronicle", projected.chronicle],
    ["assets/assets.json", "assets", { formatVersion: 1, assets: snapshot.assets.records }],
  ] as const;
  const assets = await verifiedAssetEntries(snapshot, reader, command.limits.maxOriginalImageBytes);
  return writeArchiveArtifact(command.archiveRoot, [
    ...jsonEntries.map(([path, logicalType, value]) => ({
      path,
      logicalType,
      mediaType: "application/json",
      source: Readable.from(Buffer.from(canonicalArchiveJson(value), "utf8")),
    })),
    ...assets.map((entry) => ({
      path: entry.path,
      logicalType: entry.logicalType,
      mediaType: entry.mediaType,
      source: entry.source,
    })),
  ], (entries) => {
    const payloadHashes = entries.filter((entry) => entry.mediaType === "application/json").map((entry) => entry.sha256);
    return {
      format: "infinite-quest-archive",
      formatVersion: 1,
      archiveType: "campaign",
      createdAt: new Date().toISOString(),
      contentFingerprint: calculateContentFingerprint({
        payloadHashes,
        originalAssetHashes: snapshot.assets.uniqueOriginals.map((asset) => asset.contentHash),
      }),
      campaignId: snapshot.campaign.id,
      worldId: snapshot.campaign.world_id,
      worldVersionId: snapshot.campaign.world_version_id,
      entries: [...entries],
      payloads: jsonEntries.map(([path, kind]) => ({ kind, path, formatVersion: kind === "campaign" ? 3 : 1 })),
      assets: [...snapshot.assets.records],
    } satisfies ArchiveManifest;
  }, command.limits);
}
