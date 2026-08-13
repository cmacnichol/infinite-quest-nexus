import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { campaignArchiveCommitRequestSchema, campaignArchiveDestinationSchema, type CampaignArchiveDestination } from "../../../packages/contracts/src/archives.js";
import { storyImportRequestSchema } from "../../../packages/contracts/src/imports.js";
import type { RuntimeConfig } from "../../../packages/database/src/config.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import type { MemoryGenerationTransactionPort } from "../../../packages/application/src/memory/index.js";
import type {
  PortableImportExportComposition,
  PrivateLegacyStoryCompanionAsset,
  PrivatePortableImportArtifacts,
} from "../../../packages/application/src/imports/private-portable-composition.js";
import type {
  ImportOwnerScope,
  PortableImportCommitView,
  PortableImportPreviewCommand,
} from "../../../packages/application/src/imports/types.js";
import { ArchiveError, inspectArchiveContainer, readVerifiedContainerEntry, removeArchivePath, stageArchiveUpload, type ArchiveLimits, type StagedArchive } from "./archive-io.js";
import { detectImageMimeType } from "../../../packages/domain/src/image-media.js";
import type { FilesystemAssetStore } from "../../runtime/src/filesystem-asset-store.js";
import { createAssetDeliveryStream } from "./asset-route-stream.js";
import { importPortableLegacyStory } from "./portable-legacy-story-import-route.js";

export type ArchiveRouteOptions = {
  pool: DatabasePool;
  config: RuntimeConfig;
  assetStore: FilesystemAssetStore;
  memory: MemoryGenerationTransactionPort;
  portable: Pick<PortableImportExportComposition,
    "createCampaignExport" | "openExportSession" | "stageInput" | "previewCampaignZip" | "previewLegacyStory" | "commit">;
  resolveOwner(): Promise<ImportOwnerScope>;
};

type CampaignArchiveUpload = {
  staged: StagedArchive;
  sourceName: string;
  destination: CampaignArchiveDestination;
};

type CloseEmitter = {
  once(event: "close", listener: () => void): unknown;
};

type LegacyAssetSource = Readonly<{
  assetIds(): readonly string[];
  read(sourceAssetId: string): Promise<Buffer | undefined>;
}>;

type PortableCampaignArchiveDestination = Extract<PortableImportPreviewCommand, { kind: "campaign_zip" }> ["destination"];

type CleanupLogger = {
  warn(bindings: Record<string, unknown>, message: string): void;
};

const EXPORT_CLEANUP_ATTEMPTS = 3;
const EXPORT_CLEANUP_RETRY_MS = 25;

function archiveUploadError(message: string): ArchiveError {
  return new ArchiveError("archive-format-unrecognized", message);
}

function portableArchivePreviewError(error: unknown): ArchiveError | null {
  if (error instanceof ArchiveError) return error;
  const diagnostic = error && typeof error === "object" && "code" in error
    && typeof error.code === "string"
    ? error.code
    : error instanceof Error ? error.message : null;
  switch (diagnostic) {
    case "archive_format_invalid":
    case "archive_truncated":
      return new ArchiveError(
        "archive-format-unrecognized",
        "The uploaded file is not a Campaign Archive or supported legacy campaign ZIP.",
      );
    case "archive_link_denied":
    case "archive_path_invalid":
      return new ArchiveError("archive-entry-unsafe", "The archive contains an unsafe entry.");
    case "archive_entry_limit_exceeded":
    case "archive_size_limit_exceeded":
      return new ArchiveError("archive-limit-exceeded", "The archive exceeds a configured safety limit.");
    case "archive_unavailable":
      return new ArchiveError("archive-checksum-mismatch", "The archive contents do not match their declared identity.");
    default:
      return null;
  }
}

function parseJsonField(value: unknown, fieldName: string): unknown {
  if (typeof value !== "string") throw new ArchiveError("archive-json-invalid", `The ${fieldName} field must be JSON text.`);
  try {
    return JSON.parse(value);
  } catch {
    throw new ArchiveError("archive-json-invalid", `The ${fieldName} field is not valid JSON.`);
  }
}

function campaignMultipartLimits(config: RuntimeConfig) {
  return {
    fileSize: Math.min(config.campaignArchiveLimits.maxCompressedBytes, config.security.apiImportBodyLimitBytes),
    fieldSize: Math.min(config.campaignArchiveLimits.maxJsonEntryBytes, config.security.apiImportBodyLimitBytes),
    files: 2,
    fields: 2,
    parts: 4
  };
}

function legacyArchiveLimits(config: RuntimeConfig): ArchiveLimits {
  return {
    ...config.campaignArchiveLimits,
    maxCompressedBytes: Math.min(config.campaignArchiveLimits.maxCompressedBytes, config.security.apiImportBodyLimitBytes),
    maxJsonEntryBytes: Math.min(config.campaignArchiveLimits.maxJsonEntryBytes, config.security.apiImportBodyLimitBytes),
    maxOriginalImageBytes: Math.min(config.campaignArchiveLimits.maxOriginalImageBytes, config.security.apiAssetBodyLimitBytes)
  };
}

export function createLegacyArchiveAssetSource(
  entryPaths: Iterable<string>,
  readAsset: (entryPath: string) => Promise<Buffer>
): LegacyAssetSource {
  const entryPathByAssetId = new Map<string, string>();
  for (const entryPath of entryPaths) {
    const name = basename(entryPath);
    const assetId = name.split(".")[0];
    if (assetId) entryPathByAssetId.set(assetId, entryPath);
    if (name) entryPathByAssetId.set(name, entryPath);
  }
  const canonicalAssetIds = [...entryPathByAssetId.keys()].filter((assetId) => !assetId.includes("."));
  return {
    assetIds: () => canonicalAssetIds,
    read: async (assetId) => {
      const entryPath = entryPathByAssetId.get(assetId);
      return entryPath ? readAsset(entryPath) : undefined;
    }
  };
}

function cleanupErrorCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && code.length <= 80 ? code : "cleanup-failed";
}

async function cleanupExportArtifact(cleanup: () => Promise<void>, logger?: CleanupLogger): Promise<void> {
  for (let attempt = 1; attempt <= EXPORT_CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      await cleanup();
      return;
    } catch (error) {
      logger?.warn(
        { attempt, maxAttempts: EXPORT_CLEANUP_ATTEMPTS, errorCode: cleanupErrorCode(error) },
        "campaign export artifact cleanup failed"
      );
      if (attempt < EXPORT_CLEANUP_ATTEMPTS) {
        await new Promise<void>((resolve) => setTimeout(resolve, attempt * EXPORT_CLEANUP_RETRY_MS));
      }
    }
  }
}

export function bindExportArtifactCleanup(
  stream: Readable,
  response: CloseEmitter,
  cleanup: () => Promise<void>,
  logger?: CleanupLogger
): void {
  let cleanupStarted = false;
  stream.once("close", () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    void cleanupExportArtifact(cleanup, logger);
  });
  response.once("close", () => {
    if (!stream.destroyed) stream.destroy();
  });
}

/**
 * Opens a one-time private campaign export session after the route has
 * resolved the campaign's owner-scoped world/version identifiers. No archive
 * path or filesystem receipt crosses this transport boundary.
 */
export async function openPortableCampaignExport(input: Readonly<{
  portable: Pick<PortableImportExportComposition, "createCampaignExport" | "openExportSession">;
  owner: ImportOwnerScope;
  campaignId: string;
  worldId: string;
  worldVersionId: string;
  response: CloseEmitter;
}>): Promise<Readonly<{
  contentType: "application/zip";
  byteLength: number;
  stream: Readable;
}>> {
  const exported = await input.portable.createCampaignExport({
    owner: input.owner,
    campaignId: input.campaignId,
  });
  if (exported.contentType !== "application/zip") throw new Error("portable_campaign_export_content_type_invalid");
  const session = await input.portable.openExportSession({
    owner: input.owner,
    exportKind: "campaign_zip",
    campaignId: input.campaignId,
    worldId: input.worldId,
    worldVersionId: input.worldVersionId,
    retrieval: exported.retrieval,
  });
  return Object.freeze({
    contentType: exported.contentType,
    byteLength: exported.byteLength,
    stream: createAssetDeliveryStream(session, input.response),
  });
}

async function resolvePortableCampaignArchiveDestination(
  pool: DatabasePool,
  owner: ImportOwnerScope,
  destination: CampaignArchiveDestination,
): Promise<PortableCampaignArchiveDestination> {
  if (destination.kind === "embedded") return { kind: "embedded", operation: "create_world" };
  const result = await pool.query<{ world_id: string }>(
    `SELECT world_id
       FROM world_versions
      WHERE id = $1 AND owner_user_id = $2`,
    [destination.worldVersionId, owner.ownerUserId],
  );
  const row = result.rows[0];
  if (row === undefined) throw Object.assign(new Error("World version not found."), { statusCode: 404, expose: true });
  return {
    kind: "existing_world_version",
    worldId: row.world_id,
    worldVersionId: destination.worldVersionId,
  };
}

async function stagePortableCampaignArchive(input: Readonly<{
  portable: Pick<PortableImportExportComposition, "stageInput">;
  owner: ImportOwnerScope;
  staged: StagedArchive;
}>): Promise<import("../../../packages/application/src/imports/types.js").PortableStagedInput> {
  const staged = await input.portable.stageInput({
    owner: input.owner,
    operationScopeId: `campaign-archive-preview-${randomUUID()}`,
    leaseOwner: `api-campaign-archive-${randomUUID()}`,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    byteLength: input.staged.compressedBytes,
    source: createReadStream(input.staged.absolutePath),
  });
  return staged.stagedInput;
}

export async function commitPortableCampaignArchive(input: Readonly<{
  portable: Pick<PortableImportExportComposition, "commit">;
  owner: ImportOwnerScope;
  previewToken: string;
  destination: PortableCampaignArchiveDestination;
}>): Promise<PortableImportCommitView<"campaign_zip">> {
  return input.portable.commit({
    ownerUserId: input.owner.ownerUserId,
    kind: "campaign_zip",
    destination: input.destination,
    previewHandle: {
      token: input.previewToken as never,
      destination: input.destination,
    } as never,
    idempotencyKey: `campaign-archive:${input.previewToken}:${randomUUID()}`,
  } as never) as Promise<PortableImportCommitView<"campaign_zip">>;
}

async function receiveCampaignArchive(request: FastifyRequest, config: RuntimeConfig): Promise<CampaignArchiveUpload> {
  if (!request.isMultipart()) throw archiveUploadError("Campaign Archive preview requires a multipart file upload.");
  let staged: StagedArchive | undefined;
  let sourceName = "campaign-archive.zip";
  let destination: unknown;
  let fileCount = 0;
  let destinationCount = 0;
  try {
    for await (const part of request.parts({ limits: campaignMultipartLimits(config) })) {
      if (part.type === "file") {
        fileCount += 1;
        if (fileCount !== 1 || part.fieldname !== "file") {
          part.file.resume();
          throw archiveUploadError("Campaign Archive preview accepts exactly one file field named file.");
        }
        sourceName = basename(part.filename || sourceName);
        staged = await stageArchiveUpload(part.file, config.archiveStorageRoot, config.campaignArchiveLimits);
        // Reject malformed containers before allocating owner-scoped durable
        // staging authority. The portable composition performs the complete
        // manifest/payload verification after this bounded structural check.
        await inspectArchiveContainer(staged, config.campaignArchiveLimits);
        continue;
      }
      destinationCount += 1;
      if (destinationCount !== 1 || part.fieldname !== "destination" || part.valueTruncated) {
        throw new ArchiveError("archive-json-invalid", "Campaign Archive preview requires one bounded destination JSON field.");
      }
      destination = parseJsonField(part.value, "destination");
    }
    if (!staged || destinationCount !== 1) throw archiveUploadError("Campaign Archive preview requires one file and one destination field.");
    return { staged, sourceName, destination: campaignArchiveDestinationSchema.parse(destination) };
  } catch (error) {
    if (staged) await removeArchivePath(config.archiveStorageRoot, staged.relativePath).catch(() => undefined);
    if (
      error instanceof ArchiveError
      && error.code === "archive-limit-exceeded"
      && config.security.apiImportBodyLimitBytes < config.campaignArchiveLimits.maxCompressedBytes
    ) {
      throw new ArchiveError(error.code, error.message, 413, error.details);
    }
    throw error;
  }
}

async function portableLegacyCompanions(assets: LegacyAssetSource): Promise<readonly PrivateLegacyStoryCompanionAsset[]> {
  const companions: PrivateLegacyStoryCompanionAsset[] = [];
  for (const sourceKey of assets.assetIds()) {
    const bytes = await assets.read(sourceKey);
    if (bytes === undefined) continue;
    companions.push({
      sourceKey,
      artifact: {
        mimeType: detectImageMimeType(bytes),
        byteLength: bytes.byteLength,
        contentHash: createHash("sha256").update(bytes).digest("hex"),
        bytes,
      },
    });
  }
  return companions;
}

async function legacyMultipartRequest(request: FastifyRequest, options: ArchiveRouteOptions): Promise<Readonly<{
  request: ReturnType<typeof storyImportRequestSchema.parse>;
  artifacts?: PrivatePortableImportArtifacts;
}>> {
  if (!request.isMultipart()) {
    return { request: storyImportRequestSchema.parse(request.body) };
  }

  const limits = legacyArchiveLimits(options.config);
  let body: unknown;
  let staged: StagedArchive | undefined;
  let legacyAssets: LegacyAssetSource | undefined;
  let fileCount = 0;
  let overridesCount = 0;
  try {
    for await (const part of request.parts({
      limits: {
        fileSize: limits.maxCompressedBytes,
        fieldSize: limits.maxJsonEntryBytes,
        files: 2,
        fields: 2,
        parts: 4
      }
    })) {
      if (part.type === "file") {
        fileCount += 1;
        if (fileCount !== 1 || part.fieldname !== "file") {
          part.file.resume();
          throw archiveUploadError("Legacy story import accepts exactly one file field named file.");
        }
        staged = await stageArchiveUpload(part.file, options.config.archiveStorageRoot, limits);
        const container = await inspectArchiveContainer(staged, limits);
        const campaignEntries = [...container.entries.values()].filter((entry) => entry.path === "campaign.json" || entry.path === "infinite-quest-campaign.json");
        const campaignEntry = campaignEntries[0];
        if (campaignEntries.length !== 1 || !campaignEntry) throw archiveUploadError("The legacy ZIP does not contain a campaign JSON payload.");
        body = parseJsonField((await readVerifiedContainerEntry(container, campaignEntry.path, limits.maxJsonEntryBytes)).toString("utf8"), "campaign JSON");
        legacyAssets = createLegacyArchiveAssetSource(
          [...container.entries.values()]
            .filter((entry) => (entry.path.startsWith("assets/") || entry.path.includes("/assets/")) && !entry.path.endsWith("/"))
            .map((entry) => entry.path),
          (entryPath) => readVerifiedContainerEntry(container, entryPath, limits.maxOriginalImageBytes)
        );
        continue;
      }
      overridesCount += 1;
      if (part.valueTruncated) {
        throw new ArchiveError("archive-limit-exceeded", "The requestOverrides field exceeds the API import body limit.", 413);
      }
      if (overridesCount !== 1 || part.fieldname !== "requestOverrides") {
        throw new ArchiveError("archive-json-invalid", "Legacy story import accepts only one bounded requestOverrides JSON field.");
      }
      const overrides = parseJsonField(part.value, "requestOverrides");
      if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) throw new ArchiveError("archive-json-invalid", "The requestOverrides field must contain a JSON object.");
      body = body && typeof body === "object" && !Array.isArray(body) ? { ...(body as Record<string, unknown>), ...(overrides as Record<string, unknown>) } : overrides;
    }
    if (!body) throw archiveUploadError("Multipart request missing required file or requestOverrides.");
    const parsed = storyImportRequestSchema.parse(body);
    const companions = legacyAssets === undefined ? [] : await portableLegacyCompanions(legacyAssets);
    return {
      request: parsed,
      ...(companions.length === 0 ? {} : { artifacts: { legacyStoryCompanions: companions } }),
    };
  } finally {
    if (staged) await removeArchivePath(options.config.archiveStorageRoot, staged.relativePath).catch(() => undefined);
  }
}

export async function registerArchiveRoutes(app: FastifyInstance, options: ArchiveRouteOptions): Promise<void> {
  app.get<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/export", async (request, reply) => {
    const owner = await options.resolveOwner();
    const scope = await options.pool.query<{ world_id: string; world_version_id: string }>(
      `SELECT world_versions.world_id, campaigns.world_version_id
         FROM campaigns
         JOIN world_versions
           ON world_versions.id = campaigns.world_version_id
          AND world_versions.owner_user_id = campaigns.owner_user_id
        WHERE campaigns.id = $1 AND campaigns.owner_user_id = $2`,
      [request.params.campaignId, owner.ownerUserId]
    );
    const campaign = scope.rows[0];
    if (!campaign) throw Object.assign(new Error("Campaign not found."), { statusCode: 404, expose: true });
    const exported = await openPortableCampaignExport({
      portable: options.portable,
      owner,
      campaignId: request.params.campaignId,
      worldId: campaign.world_id,
      worldVersionId: campaign.world_version_id,
      response: reply.raw,
    });
    return reply
      .header("Content-Type", exported.contentType)
      .header("Content-Disposition", 'attachment; filename="infinite-quest-campaign.zip"')
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .send(exported.stream);
  });

  app.post("/api/v1/imports/campaign-archive/preview", { bodyLimit: options.config.security.apiImportBodyLimitBytes }, async (request) => {
    const upload = await receiveCampaignArchive(request, options.config);
    try {
      const owner = await options.resolveOwner();
      const destination = await resolvePortableCampaignArchiveDestination(options.pool, owner, upload.destination);
      const stagedInput = await stagePortableCampaignArchive({ portable: options.portable, owner, staged: upload.staged });
      const preview = await (async () => {
        try {
          return destination.kind === "embedded"
            ? await options.portable.previewCampaignZip({
              ownerUserId: owner.ownerUserId,
              stagedInput,
              kind: "campaign_zip",
              destination,
            })
            : await options.portable.previewCampaignZip({
              ownerUserId: owner.ownerUserId,
              stagedInput,
              kind: "campaign_zip",
              destination,
            });
        } catch (error) {
          const mapped = portableArchivePreviewError(error);
          if (mapped) throw mapped;
          throw error;
        }
      })();
      return {
        ...preview.projection,
        previewToken: preview.previewHandle.token,
        expiresAt: preview.expiresAt,
      };
    } finally {
      await removeArchivePath(options.config.archiveStorageRoot, upload.staged.relativePath).catch(() => undefined);
    }
  });

  app.post("/api/v1/imports/campaign-archive", { bodyLimit: options.config.security.apiImportBodyLimitBytes }, async (request, reply) => {
    if (request.isMultipart()) throw new ArchiveError("archive-json-invalid", "Campaign Archive commit accepts a JSON preview token and destination.");
    const requestBody = campaignArchiveCommitRequestSchema.parse(request.body);
    const owner = await options.resolveOwner();
    const destination = await resolvePortableCampaignArchiveDestination(options.pool, owner, requestBody.destination);
    let result: PortableImportCommitView<"campaign_zip">;
    try {
      result = await commitPortableCampaignArchive({
        portable: options.portable,
        owner,
        previewToken: requestBody.previewToken,
        destination,
      });
    } catch (error) {
      if (error instanceof Error
        && (("code" in error && error.code === "import_idempotency_mismatch")
          || error.message === "archive_unavailable")) {
        throw new ArchiveError("archive-preview-stale", "The Campaign Archive preview is no longer valid.");
      }
      throw error;
    }
    return reply.code(result.duplicate ? 200 : 201).send(result.result);
  });

  app.post("/api/v1/imports/legacy-story", { bodyLimit: options.config.security.apiImportBodyLimitBytes }, async (request, reply) => {
    const input = await legacyMultipartRequest(request, options);
    const result = await importPortableLegacyStory({
      portable: options.portable,
      pool: options.pool,
      owner: await options.resolveOwner(),
      request: input.request,
      leaseOwner: `api-legacy-story-${randomUUID()}`,
      ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
    });
    return reply.code(result.duplicate ? 200 : 201).send(result.result);
  });
}
