import {
  deploymentSettingsPolicySchema, instanceSettingsSchema, runtimeRoleCapacitySchema, INSTANCE_SETTINGS_NUMERIC_BOUNDS,
  type DeploymentSettingsPolicy, type InstanceSettings, type RuntimeRoleCapacity, type SettingsFieldDescriptor,
  type SettingsFieldKey, type SettingsFeatureKey, type SettingsNumericKey
} from "../../contracts/src/instance-settings.js";

type RegistryField = Pick<SettingsFieldDescriptor, "key" | "environmentName" | "label" | "section" | "unit" | "kind"> & { minimum?: number; maximum?: number };
export const INSTANCE_SETTING_FIELDS: readonly RegistryField[] = [
  { key: "logLevel", environmentName: "LOG_LEVEL", label: "Log level", section: "diagnostics", unit: "level", kind: "enum" },
  { key: "workerPollIntervalMs", environmentName: "WORKER_POLL_INTERVAL_MS", label: "Worker poll interval ms", section: "performance", unit: "milliseconds", kind: "integer" },
  { key: "textProviderConcurrency", environmentName: "TEXT_PROVIDER_CONCURRENCY", label: "Text provider concurrency", section: "performance", unit: "count", kind: "integer" },
  { key: "archivePreviewTtlSeconds", environmentName: "ARCHIVE_PREVIEW_TTL_SECONDS", label: "Archive preview retention", section: "sharing", unit: "seconds", kind: "integer" },
  { key: "systemArchiveArtifactTtlSeconds", environmentName: "SYSTEM_ARCHIVE_ARTIFACT_TTL_SECONDS", label: "System archive artifact ttl seconds", section: "sharing", unit: "seconds", kind: "integer" },
  { key: "systemArchiveUploadTtlSeconds", environmentName: "SYSTEM_ARCHIVE_UPLOAD_TTL_SECONDS", label: "System archive upload ttl seconds", section: "sharing", unit: "seconds", kind: "integer" },
  { key: "systemArchiveChunkBytes", environmentName: "SYSTEM_ARCHIVE_CHUNK_BYTES", label: "System archive chunk bytes", section: "sharing", unit: "bytes", kind: "integer" },
  { key: "aiAuthoringJobsEnabled", environmentName: "AI_AUTHORING_JOBS_ENABLED", label: "AI authoring jobs enabled", section: "characters", unit: "boolean", kind: "boolean" },
  { key: "aiStorySourceAuthoringEnabled", environmentName: "AI_STORY_SOURCE_AUTHORING_ENABLED", label: "AI story source authoring enabled", section: "characters", unit: "boolean", kind: "boolean" },
  { key: "castEditingEnabled", environmentName: "CAST_EDITING_ENABLED", label: "Cast editing enabled", section: "characters", unit: "boolean", kind: "boolean" },
  { key: "castDiscoveryEnabled", environmentName: "CAST_DISCOVERY_ENABLED", label: "Cast discovery enabled", section: "characters", unit: "boolean", kind: "boolean" },
  { key: "castAutoMatchEnabled", environmentName: "CAST_AUTO_MATCH_ENABLED", label: "Cast auto match enabled", section: "characters", unit: "boolean", kind: "boolean" },
  { key: "castContextEnabled", environmentName: "CAST_CONTEXT_ENABLED", label: "Cast context enabled", section: "characters", unit: "boolean", kind: "boolean" },
  { key: "castBackfillEnabled", environmentName: "CAST_BACKFILL_ENABLED", label: "Cast backfill enabled", section: "characters", unit: "boolean", kind: "boolean" },
  { key: "worldSharingEnabled", environmentName: "WORLD_SHARING_ENABLED", label: "World sharing enabled", section: "sharing", unit: "boolean", kind: "boolean" },
  { key: "systemArchiveEnabled", environmentName: "SYSTEM_ARCHIVE_ENABLED", label: "System archive enabled", section: "sharing", unit: "boolean", kind: "boolean" },
  { key: "workerGenerationConcurrency", environmentName: "WORKER_GENERATION_CONCURRENCY", label: "Worker generation concurrency", section: "performance", unit: "count", kind: "integer" },
  { key: "apiDefaultBodyLimitBytes", environmentName: "API_DEFAULT_BODY_LIMIT_BYTES", label: "API default body limit bytes", section: "performance", unit: "bytes", kind: "integer" },
  { key: "apiImportBodyLimitBytes", environmentName: "API_IMPORT_BODY_LIMIT_BYTES", label: "API import body limit bytes", section: "performance", unit: "bytes", kind: "integer" },
  { key: "apiAssetBodyLimitBytes", environmentName: "API_ASSET_BODY_LIMIT_BYTES", label: "API asset body limit bytes", section: "performance", unit: "bytes", kind: "integer" },
  { key: "apiRateLimitWindowSeconds", environmentName: "API_RATE_LIMIT_WINDOW_SECONDS", label: "API rate limit window seconds", section: "performance", unit: "seconds", kind: "integer" },
  { key: "apiRateLimitProviderRequests", environmentName: "API_RATE_LIMIT_PROVIDER_REQUESTS", label: "API rate limit provider requests", section: "performance", unit: "count", kind: "integer" },
  { key: "apiRateLimitGenerationRequests", environmentName: "API_RATE_LIMIT_GENERATION_REQUESTS", label: "API rate limit generation requests", section: "performance", unit: "count", kind: "integer" },
  { key: "apiRateLimitImportRequests", environmentName: "API_RATE_LIMIT_IMPORT_REQUESTS", label: "API rate limit import requests", section: "performance", unit: "count", kind: "integer" },
  { key: "apiConcurrencyProviderRequests", environmentName: "API_CONCURRENCY_PROVIDER_REQUESTS", label: "API concurrency provider requests", section: "performance", unit: "count", kind: "integer" },
  { key: "apiConcurrencyImportRequests", environmentName: "API_CONCURRENCY_IMPORT_REQUESTS", label: "API concurrency import requests", section: "performance", unit: "count", kind: "integer" },
  { key: "campaignArchiveLimits.maxCompressedBytes", environmentName: "CAMPAIGN_ARCHIVE_MAX_COMPRESSED_BYTES", label: "Campaign archive limits max compressed bytes", section: "sharing", unit: "bytes", kind: "integer" },
  { key: "campaignArchiveLimits.maxUncompressedBytes", environmentName: "CAMPAIGN_ARCHIVE_MAX_UNCOMPRESSED_BYTES", label: "Campaign archive limits max uncompressed bytes", section: "sharing", unit: "bytes", kind: "integer" },
  { key: "campaignArchiveLimits.maxEntries", environmentName: "CAMPAIGN_ARCHIVE_MAX_ENTRIES", label: "Campaign archive limits max entries", section: "sharing", unit: "count", kind: "integer" },
  { key: "campaignArchiveLimits.maxExpansionRatio", environmentName: "CAMPAIGN_ARCHIVE_MAX_EXPANSION_RATIO", label: "Campaign archive limits max expansion ratio", section: "sharing", unit: "ratio", kind: "integer" },
  { key: "campaignArchiveLimits.maxManifestBytes", environmentName: "CAMPAIGN_ARCHIVE_MAX_MANIFEST_BYTES", label: "Campaign archive limits max manifest bytes", section: "sharing", unit: "bytes", kind: "integer" },
  { key: "campaignArchiveLimits.maxJsonEntryBytes", environmentName: "CAMPAIGN_ARCHIVE_MAX_JSON_ENTRY_BYTES", label: "Campaign archive limits max json entry bytes", section: "sharing", unit: "bytes", kind: "integer" },
  { key: "campaignArchiveLimits.maxOriginalImageBytes", environmentName: "CAMPAIGN_ARCHIVE_MAX_ORIGINAL_IMAGE_BYTES", label: "Campaign archive limits max original image bytes", section: "sharing", unit: "bytes", kind: "integer" },
  { key: "systemArchiveLimits.maxCompressedBytes", environmentName: "SYSTEM_ARCHIVE_MAX_COMPRESSED_BYTES", label: "System archive limits max compressed bytes", section: "sharing", unit: "bytes", kind: "integer" },
  { key: "systemArchiveLimits.maxUncompressedBytes", environmentName: "SYSTEM_ARCHIVE_MAX_UNCOMPRESSED_BYTES", label: "System archive limits max uncompressed bytes", section: "sharing", unit: "bytes", kind: "integer" },
  { key: "systemArchiveLimits.maxEntries", environmentName: "SYSTEM_ARCHIVE_MAX_ENTRIES", label: "System archive limits max entries", section: "sharing", unit: "count", kind: "integer" },
  { key: "systemArchiveLimits.maxExpansionRatio", environmentName: "SYSTEM_ARCHIVE_MAX_EXPANSION_RATIO", label: "System archive limits max expansion ratio", section: "sharing", unit: "ratio", kind: "integer" },
  { key: "systemArchiveLimits.maxManifestBytes", environmentName: "SYSTEM_ARCHIVE_MAX_MANIFEST_BYTES", label: "System archive limits max manifest bytes", section: "sharing", unit: "bytes", kind: "integer" },
  { key: "systemArchiveLimits.maxJsonEntryBytes", environmentName: "SYSTEM_ARCHIVE_MAX_JSON_ENTRY_BYTES", label: "System archive limits max json entry bytes", section: "sharing", unit: "bytes", kind: "integer" },
  { key: "systemArchiveLimits.maxOriginalImageBytes", environmentName: "SYSTEM_ARCHIVE_MAX_ORIGINAL_IMAGE_BYTES", label: "System archive limits max original image bytes", section: "sharing", unit: "bytes", kind: "integer" },
].map((field) => {
  const bounds = INSTANCE_SETTINGS_NUMERIC_BOUNDS[field.key as SettingsNumericKey];
  return { ...field, ...(bounds ? { minimum: bounds.min, maximum: bounds.max } : {}) } as RegistryField;
});
export type SettingsResolutionError = { code: "invalid_settings" | "invalid_policy" | "invalid_capacity" | "policy_bound" | "reviewed_bound" | "archive_chunk_capacity" | "pool_capacity" | "rate_policy"; field?: SettingsFieldKey };
export type SettingsResolution = { ok: true; effective: InstanceSettings; fields: SettingsFieldDescriptor[] } | { ok: false; errors: SettingsResolutionError[] };
function valueAt(settings: InstanceSettings, key: SettingsFieldKey): boolean | number | InstanceSettings["logLevel"] {
  const [group, property] = key.split(".");
  if (property) return settings[group as "campaignArchiveLimits" | "systemArchiveLimits"][property as keyof InstanceSettings["campaignArchiveLimits"]];
  return settings[key as Exclude<SettingsFieldKey, SettingsNumericKey> | Exclude<SettingsNumericKey, `${string}.${string}`>];
}
/** Policy disables capabilities; incompatible numeric preferences reject activation. Inputs stay immutable. */
export function resolveInstanceSettings(requested: InstanceSettings, policy: DeploymentSettingsPolicy, capacity: RuntimeRoleCapacity): SettingsResolution {
  const parsed = instanceSettingsSchema.safeParse(requested);
  if (!parsed.success) return { ok: false, errors: [{ code: "invalid_settings" }] };
  if (!deploymentSettingsPolicySchema.safeParse(policy).success) return { ok: false, errors: [{ code: "invalid_policy" }] };
  if (!runtimeRoleCapacitySchema.safeParse(capacity).success) return { ok: false, errors: [{ code: "invalid_capacity" }] };
  const effective = parsed.data;
  const errors: SettingsResolutionError[] = [];
  for (const [key, reviewed] of Object.entries(INSTANCE_SETTINGS_NUMERIC_BOUNDS)) {
    const field = key as SettingsNumericKey;
    const bounds = policy.numericBounds[field];
    const exception = field.startsWith("systemArchiveLimits.") && policy.systemArchiveAllowLimitIncrease;
    if (bounds.min < reviewed.min || (!exception && bounds.max > reviewed.max)) errors.push({ code: "reviewed_bound", field });
    const value = valueAt(effective, field) as number;
    if (value < bounds.min || value > bounds.max) errors.push({ code: "policy_bound", field });
    if (!exception && value > reviewed.max) errors.push({ code: "reviewed_bound", field });
  }
  const required = effective.workerGenerationConcurrency + (capacity.role === "worker" ? 4 : capacity.role === "all" ? 8 : 0);
  if ((capacity.role === "worker" || capacity.role === "all") && capacity.databaseMaxConnections < required) errors.push({ code: "pool_capacity", field: "workerGenerationConcurrency" });
  if (!policy.approvedRateTuples.some((tuple) => tuple.windowSeconds === effective.apiRateLimitWindowSeconds && tuple.providerRequests === effective.apiRateLimitProviderRequests && tuple.generationRequests === effective.apiRateLimitGenerationRequests && tuple.importRequests === effective.apiRateLimitImportRequests)) errors.push({ code: "rate_policy" });
  if (errors.length) return { ok: false, errors };
  const locks = new Map<SettingsFieldKey, SettingsFieldDescriptor["lockReason"]>();
  for (const [key, allowed] of Object.entries(policy.featureGates)) {
    if (!allowed) { effective[key as SettingsFeatureKey] = false; locks.set(key as SettingsFeatureKey, "deployment_disabled"); }
  }
  const dependencies: Partial<Record<SettingsFeatureKey, SettingsFeatureKey>> = {
    castDiscoveryEnabled: "castEditingEnabled", castAutoMatchEnabled: "castDiscoveryEnabled",
    castContextEnabled: "castDiscoveryEnabled", castBackfillEnabled: "castDiscoveryEnabled"
  };
  for (const [child, parent] of Object.entries(dependencies)) {
    if (!effective[parent]) {
      effective[child as SettingsFeatureKey] = false;
      if (!locks.has(child as SettingsFeatureKey)) locks.set(child as SettingsFeatureKey, "dependency_disabled");
    }
  }
  // Both the API route and resumable coordinator require this same capacity.
  // Evaluate after capability gates: a disabled archive has no upload admission.
  if (effective.systemArchiveEnabled && effective.systemArchiveChunkBytes > effective.systemArchiveLimits.maxCompressedBytes) {
    return { ok: false, errors: [{ code: "archive_chunk_capacity", field: "systemArchiveChunkBytes" }] };
  }
  return { ok: true, effective, fields: INSTANCE_SETTING_FIELDS.map((field) => ({
    ...field, scope: "installation", effectiveValue: valueAt(effective, field.key),
    permittedRange: field.kind === "integer" ? policy.numericBounds[field.key as SettingsNumericKey] : null,
    source: "database", lockReason: locks.get(field.key) ?? null, applyMode: "restart"
  })) };
}
