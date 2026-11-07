import { z } from "zod";

const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const archiveSafetyLimitsSchema = z.object({
  maxCompressedBytes: positiveInteger, maxUncompressedBytes: positiveInteger,
  maxEntries: positiveInteger, maxExpansionRatio: positiveInteger,
  maxManifestBytes: positiveInteger, maxJsonEntryBytes: positiveInteger,
  maxOriginalImageBytes: positiveInteger,
}).strict();
/** Installation provenance only. Never include this authority in portable data. */
export const archivePolicySnapshotSchema = z.object({
  version: z.literal(1), settingsRevision: z.string().regex(/^(?:[1-9][0-9]*|environment|historical)$/u),
  previewTtlSeconds: positiveInteger, artifactTtlSeconds: positiveInteger,
  uploadTtlSeconds: positiveInteger, chunkBytes: positiveInteger,
  limits: archiveSafetyLimitsSchema,
}).strict();
export type ArchivePolicySnapshot = z.infer<typeof archivePolicySnapshotSchema>;
export type ArchiveSafetyLimits = ArchivePolicySnapshot["limits"];
/** Code-owned pre-settings baseline, never the current process environment. */
export function historicalArchivePolicy(scope: "campaign" | "system"): ArchivePolicySnapshot {
  return { version: 1, settingsRevision: "historical", previewTtlSeconds: 1800,
    artifactTtlSeconds: 86400, uploadTtlSeconds: 86400, chunkBytes: 16777216,
    limits: { maxCompressedBytes: scope === "system" ? 53687091200 : 2147483648,
      maxUncompressedBytes: scope === "system" ? 214748364800 : 21474836480,
      maxEntries: scope === "system" ? 1000000 : 100000, maxExpansionRatio: 100,
      maxManifestBytes: scope === "system" ? 16777216 : 5242880,
      maxJsonEntryBytes: 1073741824, maxOriginalImageBytes: 26214400 } };
}
export function stricterArchiveLimits(stored: ArchivePolicySnapshot, current: ArchivePolicySnapshot): ArchiveSafetyLimits {
  return Object.fromEntries(Object.entries(stored.limits).map(([key, value]) =>
    [key, Math.min(value, current.limits[key as keyof ArchiveSafetyLimits])])) as ArchiveSafetyLimits;
}
export function requireCompatibleArchivePreview(stored: ArchivePolicySnapshot, current: ArchivePolicySnapshot): void {
  if (Object.entries(stored.limits).some(([key, value]) => current.limits[key as keyof ArchiveSafetyLimits] < value)) {
    throw Object.assign(new Error("archive-preview-policy-changed"), {
      statusCode: 409, code: "archive-preview-stale", retryable: true,
    });
  }
}
