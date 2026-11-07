import { archivePolicySnapshotSchema, type ArchivePolicySnapshot } from "../../../packages/contracts/src/archive-policy.js";
import type { RuntimeConfig } from "../../../packages/database/src/config.js";
/** Each family owns its safety limits and preview contract. */
export function runtimeArchivePolicy(config: RuntimeConfig, scope: "campaign" | "system"): ArchivePolicySnapshot {
  return archivePolicySnapshotSchema.parse({ version: 1,
    settingsRevision: config.instanceSettingsRevision ?? "environment",
    previewTtlSeconds: scope === "system" ? 1800 : config.archivePreviewTtlSeconds,
    artifactTtlSeconds: config.systemArchiveArtifactTtlSeconds,
    uploadTtlSeconds: config.systemArchiveUploadTtlSeconds,
    chunkBytes: config.systemArchiveChunkBytes,
    limits: scope === "system" ? config.systemArchiveLimits : {
      ...config.campaignArchiveLimits,
      maxCompressedBytes: Math.min(config.campaignArchiveLimits.maxCompressedBytes, config.security.apiImportBodyLimitBytes),
      maxJsonEntryBytes: Math.min(config.campaignArchiveLimits.maxJsonEntryBytes, config.security.apiImportBodyLimitBytes),
      maxOriginalImageBytes: Math.min(config.campaignArchiveLimits.maxOriginalImageBytes, config.security.apiAssetBodyLimitBytes),
    },
  });
}
