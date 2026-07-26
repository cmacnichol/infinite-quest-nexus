import { createReadStream } from "node:fs";
import { basename } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { campaignArchiveCommitRequestSchema, campaignArchiveDestinationSchema, type CampaignArchiveDestination } from "../../../packages/contracts/src/archives.js";
import { storyImportRequestSchema } from "../../../packages/contracts/src/imports.js";
import type { RuntimeConfig } from "../../../packages/database/src/config.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { adaptLegacyCampaignZip, exportCampaign, previewCampaignArchive } from "./campaign-archive-service.js";
import { ArchiveError, inspectArchiveContainer, readVerifiedContainerEntry, removeArchivePath, stageArchiveUpload, type ArchiveLimits, type StagedArchive } from "./archive-io.js";
import { type FilesystemAssetStore } from "./asset-service.js";
import { importCampaignArchive, importLegacyStory } from "./import-service.js";

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
  let assetBuffers = new Map<string, Buffer>();
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
        assetBuffers = new Map(await Promise.all(
          [...container.entries.values()]
            .filter((entry) => entry.path.startsWith("assets/") && !entry.path.endsWith("/"))
            .map(async (entry) => [basename(entry.path).split(".")[0]!, await readVerifiedContainerEntry(container, entry.path, limits.maxOriginalImageBytes)] as const)
        ));
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
    return importLegacyStory(options.pool, storyImportRequestSchema.parse(body), options.assetStore, assetBuffers);
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
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      void removeArchivePath(options.config.archiveStorageRoot, archive.relativePath).catch(() => undefined);
    };
    reply.raw.once("finish", cleanup);
    reply.raw.once("close", cleanup);
    return reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", 'attachment; filename="infinite-quest-campaign.zip"')
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .send(createReadStream(archive.absolutePath));
  });

  app.post("/api/v1/imports/campaign-archive/preview", async (request) => {
    const upload = await receiveCampaignArchive(request, options.config);
    try {
      return await previewCampaignArchive(options.pool, options.config, upload.staged, upload.sourceName, upload.destination);
    } catch (error) {
      await removeArchivePath(options.config.archiveStorageRoot, upload.staged.relativePath).catch(() => undefined);
      throw error;
    }
  });

  app.post("/api/v1/imports/campaign-archive", async (request, reply) => {
    if (request.isMultipart()) throw new ArchiveError("archive-json-invalid", "Campaign Archive commit accepts a JSON preview token and destination.");
    const result = await importCampaignArchive(options.pool, options.config, options.assetStore, campaignArchiveCommitRequestSchema.parse(request.body));
    return reply.code(result.duplicate ? 200 : 201).send(result);
  });

  app.post("/api/v1/imports/legacy-story", async (request, reply) => {
    const result = await legacyMultipartImport(request, options);
    return reply.code(result.duplicate ? 200 : 201).send(result);
  });
}
