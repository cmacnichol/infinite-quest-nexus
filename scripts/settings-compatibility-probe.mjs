// Mount this standalone file under /app/scripts in the target pre-Settings
// image. Its configuration loader belongs to that image. No connection or
// provider call is needed to check how that binary interprets the override.
import { createHash } from "node:crypto";
import { loadRuntimeConfig } from "../dist/packages/database/src/config.js";

const config = loadRuntimeConfig();
const inputs = { ...config, ...config.security, logLevel: process.env.LOG_LEVEL || "info" };
const scalarKeys = [
  "logLevel", "workerPollIntervalMs", "textProviderConcurrency", "archivePreviewTtlSeconds",
  "systemArchiveArtifactTtlSeconds", "systemArchiveUploadTtlSeconds", "systemArchiveChunkBytes",
  "aiAuthoringJobsEnabled", "aiStorySourceAuthoringEnabled", "castEditingEnabled", "castDiscoveryEnabled",
  "castAutoMatchEnabled", "castContextEnabled", "castBackfillEnabled", "worldSharingEnabled", "systemArchiveEnabled",
  "workerGenerationConcurrency", "apiDefaultBodyLimitBytes", "apiImportBodyLimitBytes", "apiAssetBodyLimitBytes",
  "apiRateLimitWindowSeconds", "apiRateLimitProviderRequests", "apiRateLimitGenerationRequests",
  "apiRateLimitImportRequests", "apiConcurrencyProviderRequests", "apiConcurrencyImportRequests"
];
const archiveKeys = ["maxCompressedBytes", "maxUncompressedBytes", "maxEntries", "maxExpansionRatio",
  "maxManifestBytes", "maxJsonEntryBytes", "maxOriginalImageBytes"];

function pick(source, keys) {
  return Object.fromEntries(keys.map(key => {
    const value = source?.[key];
    if (!["string", "number", "boolean"].includes(typeof value)) throw new Error("target_settings_field_unavailable");
    return [key, value];
  }));
}
const snapshot = pick(inputs, scalarKeys);
for (const group of ["campaignArchiveLimits", "systemArchiveLimits"]) snapshot[group] = pick(inputs[group], archiveKeys);

function ordered(value) {
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)]));
}
const digest = createHash("sha256").update(JSON.stringify(ordered(snapshot))).digest("hex");
process.stdout.write(JSON.stringify({ version: 1, role: { role: config.role, databaseMaxConnections: config.databaseMaxConnections }, snapshot, digest }) + "\n");
