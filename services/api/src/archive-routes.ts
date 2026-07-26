import { createReadStream } from "node:fs";
import { basename } from "node:path";
import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { campaignArchiveCommitRequestSchema, campaignArchiveDestinationSchema, type CampaignArchiveDestination } from "../../../packages/contracts/src/archives.js";
import { storyImportRequestSchema } from "../../../packages/contracts/src/imports.js";
import type { RuntimeConfig } from "../../../packages/database/src/config.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { exportCampaign, previewCampaignArchive } from "./campaign-archive-service.js";
import { ArchiveError, inspectArchiveContainer, readVerifiedContainerEntry, removeArchivePath, stageArchiveUpload, type ArchiveLimits, type StagedArchive } from "./archive-io.js";
import { type FilesystemAssetStore } from "./asset-service.js";
import { importCampaignArchive, importLegacyStory, type LegacyAssetSource } from "./import-service.js";

export type ArchiveRouteOptions = {
  pool: DatabasePool;
  config: RuntimeConfig;
  assetStore: FilesystemAssetStore;
};

type CampaignArchiveUpload = {
  staged: StagedArchive;
  sourceName: string;
  destination: CampaignArchiveDestination;
};

type CloseEmitter = {
  once(event: "close", listener: () => void): unknown;
};

type CleanupLogger = {
  warn(bindings: Record<string, unknown>, message: string): void;
};

const EXPORT_CLEANUP_ATTEMPTS = 3;
const EXPORT_CLEANUP_RETRY_MS = 25;

function archiveUploadError(message: string): ArchiveError {
  return new ArchiveError("archive-format-unrecognized", message);
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
    fileSize: config.campaignArchiveLimits.maxCompressedBytes,
    fieldSize: config.campaignArchiveLimits.maxJsonEntryBytes,
    files: 2,
    fields: 2,
    parts: 4
  };
}

function legacyArchiveLimits(config: RuntimeConfig): ArchiveLimits {
  return {
    ...config.campaignArchiveLimits,
    maxCompressedBytes: Math.min(config.campaignArchiveLimits.maxCompressedBytes, config.security.apiImportBodyLimitBytes),
    maxOriginalImageBytes: Math.min(config.campaignArchiveLimits.maxOriginalImageBytes, config.security.apiAssetBodyLimitBytes)
  };
}

export function createLegacyArchiveAssetSource(
  entryPaths: Iterable<string>,
  readAsset: (entryPath: string) => Promise<Buffer>
): LegacyAssetSource {
  const entryPathByAssetId = new Map<string, string>();
  for (const entryPath of entryPaths) {
    const assetId = basename(entryPath).split(".")[0];
    if (assetId) entryPathByAssetId.set(assetId, entryPath);
  }
  return {
    assetIds: () => entryPathByAssetId.keys(),
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
    throw error;
  }
}

async function legacyMultipartImport(request: FastifyRequest, options: ArchiveRouteOptions) {
  if (!request.isMultipart()) {
    return importLegacyStory(options.pool, storyImportRequestSchema.parse(request.body), options.assetStore);
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
            .filter((entry) => entry.path.startsWith("assets/") && !entry.path.endsWith("/"))
            .map((entry) => entry.path),
          (entryPath) => readVerifiedContainerEntry(container, entryPath, limits.maxOriginalImageBytes)
        );
        continue;
      }
      overridesCount += 1;
      if (overridesCount !== 1 || part.fieldname !== "requestOverrides" || part.valueTruncated) {
        throw new ArchiveError("archive-json-invalid", "Legacy story import accepts only one bounded requestOverrides JSON field.");
      }
      const overrides = parseJsonField(part.value, "requestOverrides");
      if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) throw new ArchiveError("archive-json-invalid", "The requestOverrides field must contain a JSON object.");
      body = body && typeof body === "object" && !Array.isArray(body) ? { ...(body as Record<string, unknown>), ...(overrides as Record<string, unknown>) } : overrides;
    }
    if (!body) throw archiveUploadError("Multipart request missing required file or requestOverrides.");
    return importLegacyStory(options.pool, storyImportRequestSchema.parse(body), options.assetStore, legacyAssets);
  } finally {
    if (staged) await removeArchivePath(options.config.archiveStorageRoot, staged.relativePath).catch(() => undefined);
  }
}

export async function registerArchiveRoutes(app: FastifyInstance, options: ArchiveRouteOptions): Promise<void> {
  app.get<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/export", async (request, reply) => {
    const archive = await exportCampaign(options.pool, request.params.campaignId, {
      assetStore: options.assetStore,
      archiveRoot: options.config.archiveStorageRoot,
      limits: options.config.campaignArchiveLimits
    });
    const stream = createReadStream(archive.absolutePath);
    bindExportArtifactCleanup(
      stream,
      reply.raw,
      () => removeArchivePath(options.config.archiveStorageRoot, archive.relativePath),
      app.log
    );
    return reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", 'attachment; filename="infinite-quest-campaign.zip"')
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .send(stream);
  });

  app.post("/api/v1/imports/campaign-archive/preview", async (request) => {
    const upload = await receiveCampaignArchive(request, options.config);
    try {
      return await previewCampaignArchive(options.pool, options.config, upload.staged, upload.sourceName, upload.destination, app.log);
    } catch (error) {
      await removeArchivePath(options.config.archiveStorageRoot, upload.staged.relativePath).catch(() => undefined);
      throw error;
    }
  });

  app.post("/api/v1/imports/campaign-archive", async (request, reply) => {
    if (request.isMultipart()) throw new ArchiveError("archive-json-invalid", "Campaign Archive commit accepts a JSON preview token and destination.");
    const result = await importCampaignArchive(options.pool, options.config, options.assetStore, campaignArchiveCommitRequestSchema.parse(request.body), app.log);
    return reply.code(result.duplicate ? 200 : 201).send(result);
  });

  app.post("/api/v1/imports/legacy-story", async (request, reply) => {
    const result = await legacyMultipartImport(request, options);
    return reply.code(result.duplicate ? 200 : 201).send(result);
  });
}
