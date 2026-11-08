import { z } from "zod";

export const INSTANCE_SETTINGS_SCHEMA_VERSION = 1;
const integer = (min: number, max = Number.MAX_SAFE_INTEGER) => z.number().int().min(min).max(max).safe();
export const instanceSettingsLogLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);
const campaignArchiveLimitsSchema = z.object({
  maxCompressedBytes: integer(1, 2147483648), maxUncompressedBytes: integer(1, 21474836480),
  maxEntries: integer(1, 100000), maxExpansionRatio: integer(1, 100), maxManifestBytes: integer(1, 5242880),
  maxJsonEntryBytes: integer(1, 1073741824), maxOriginalImageBytes: integer(1, 26214400)
}).strict();
// The existing deployment exception can approve higher System Archive bounds.
const systemArchiveLimitsSchema = z.object({
  maxCompressedBytes: integer(1), maxUncompressedBytes: integer(1), maxEntries: integer(1),
  maxExpansionRatio: integer(1), maxManifestBytes: integer(1), maxJsonEntryBytes: integer(1), maxOriginalImageBytes: integer(1)
}).strict();
export const settingsFeatureGatesSchema = z.object({
  aiAuthoringJobsEnabled: z.boolean(), aiStorySourceAuthoringEnabled: z.boolean(),
  castEditingEnabled: z.boolean(), castDiscoveryEnabled: z.boolean(), castAutoMatchEnabled: z.boolean(),
  castContextEnabled: z.boolean(), castPresetsEnabled: z.boolean(), castContextWithoutDiscoveryEnabled: z.boolean(), castBackfillEnabled: z.boolean(), worldSharingEnabled: z.boolean(), systemArchiveEnabled: z.boolean()
}).strict();
export const instanceSettingsSchema = z.object({
  ...settingsFeatureGatesSchema.shape,
  logLevel: instanceSettingsLogLevelSchema,
  workerPollIntervalMs: integer(250, 60000), textProviderConcurrency: integer(1, 1000),
  archivePreviewTtlSeconds: integer(60, 86400), systemArchiveArtifactTtlSeconds: integer(300, 604800),
  systemArchiveUploadTtlSeconds: integer(300, 604800), systemArchiveChunkBytes: integer(1048576, 67108864),
  workerGenerationConcurrency: integer(1, 4), apiDefaultBodyLimitBytes: integer(65536, 67108864),
  apiImportBodyLimitBytes: integer(1048576, 2147483648), apiAssetBodyLimitBytes: integer(1048576, 67108864),
  apiRateLimitWindowSeconds: integer(1, 3600), apiRateLimitProviderRequests: integer(1, 10000),
  apiRateLimitGenerationRequests: integer(1, 10000), apiRateLimitImportRequests: integer(1, 10000),
  apiConcurrencyProviderRequests: integer(1, 1000), apiConcurrencyImportRequests: integer(1, 1000),
  campaignArchiveLimits: campaignArchiveLimitsSchema, systemArchiveLimits: systemArchiveLimitsSchema
}).strict();
export type InstanceSettings = z.infer<typeof instanceSettingsSchema>;
export type SettingsFeatureKey = keyof z.infer<typeof settingsFeatureGatesSchema>;
export type SettingsNumericKey = Exclude<keyof InstanceSettings, SettingsFeatureKey | "logLevel" | "campaignArchiveLimits" | "systemArchiveLimits"> | `${"campaignArchiveLimits" | "systemArchiveLimits"}.${keyof InstanceSettings["campaignArchiveLimits"]}`;
export type SettingsFieldKey = SettingsNumericKey | SettingsFeatureKey | "logLevel";
export const instanceSettingsChangesSchema = instanceSettingsSchema.partial().extend({
  campaignArchiveLimits: campaignArchiveLimitsSchema.partial().optional(), systemArchiveLimits: systemArchiveLimitsSchema.partial().optional()
}).strict().refine((value) => Object.values(value).some((item) => item !== undefined && (typeof item !== "object" || Object.keys(item).length > 0)), "At least one setting must change.");
export const settingsRevisionSchema = z.string().regex(/^[1-9]\d*$/).refine((value) => /^[1-9]\d*$/.test(value) && BigInt(value) <= 9223372036854775807n);
export const instanceSettingsPatchSchema = z.object({ expectedRequestedRevision: settingsRevisionSchema.nullable(), changes: instanceSettingsChangesSchema, reason: z.string().trim().min(1).max(1000) }).strict();
export type InstanceSettingsPatch = z.infer<typeof instanceSettingsPatchSchema>;
export const INSTANCE_SETTINGS_NUMERIC_BOUNDS: Record<SettingsNumericKey, { min: number; max: number }> = {
  workerPollIntervalMs: { min: 250, max: 60000 }, textProviderConcurrency: { min: 1, max: 1000 },
  archivePreviewTtlSeconds: { min: 60, max: 86400 }, systemArchiveArtifactTtlSeconds: { min: 300, max: 604800 },
  systemArchiveUploadTtlSeconds: { min: 300, max: 604800 }, systemArchiveChunkBytes: { min: 1048576, max: 67108864 },
  workerGenerationConcurrency: { min: 1, max: 4 }, apiDefaultBodyLimitBytes: { min: 65536, max: 67108864 },
  apiImportBodyLimitBytes: { min: 1048576, max: 2147483648 }, apiAssetBodyLimitBytes: { min: 1048576, max: 67108864 },
  apiRateLimitWindowSeconds: { min: 1, max: 3600 }, apiRateLimitProviderRequests: { min: 1, max: 10000 },
  apiRateLimitGenerationRequests: { min: 1, max: 10000 }, apiRateLimitImportRequests: { min: 1, max: 10000 },
  apiConcurrencyProviderRequests: { min: 1, max: 1000 }, apiConcurrencyImportRequests: { min: 1, max: 1000 },
  "campaignArchiveLimits.maxCompressedBytes": { min: 1, max: 2147483648 },
  "campaignArchiveLimits.maxUncompressedBytes": { min: 1, max: 21474836480 },
  "campaignArchiveLimits.maxEntries": { min: 1, max: 100000 }, "campaignArchiveLimits.maxExpansionRatio": { min: 1, max: 100 },
  "campaignArchiveLimits.maxManifestBytes": { min: 1, max: 5242880 }, "campaignArchiveLimits.maxJsonEntryBytes": { min: 1, max: 1073741824 },
  "campaignArchiveLimits.maxOriginalImageBytes": { min: 1, max: 26214400 },
  "systemArchiveLimits.maxCompressedBytes": { min: 1, max: 53687091200 },
  "systemArchiveLimits.maxUncompressedBytes": { min: 1, max: 214748364800 },
  "systemArchiveLimits.maxEntries": { min: 1, max: 1000000 }, "systemArchiveLimits.maxExpansionRatio": { min: 1, max: 100 },
  "systemArchiveLimits.maxManifestBytes": { min: 1, max: 16777216 }, "systemArchiveLimits.maxJsonEntryBytes": { min: 1, max: 1073741824 },
  "systemArchiveLimits.maxOriginalImageBytes": { min: 1, max: 26214400 }
};
const numericBoundSchema = z.object({ min: integer(1), max: integer(1) }).strict().refine((bound) => bound.min <= bound.max);
export const runtimeRoleCapacitySchema = z.object({ role: z.enum(["all", "api", "worker", "migrate"]), databaseMaxConnections: integer(2, 100) }).strict();
export type RuntimeRoleCapacity = z.infer<typeof runtimeRoleCapacitySchema>;
export const deploymentSettingsPolicySchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]), installationId: z.uuid(), minimumSettingsProtocolVersion: integer(1), featureGates: settingsFeatureGatesSchema.partial({ castPresetsEnabled: true, castContextWithoutDiscoveryEnabled: true }),
  numericBounds: z.record(z.enum(Object.keys(INSTANCE_SETTINGS_NUMERIC_BOUNDS) as [SettingsNumericKey, ...SettingsNumericKey[]]), numericBoundSchema),
  approvedRateTuples: z.array(z.object({ windowSeconds: integer(1, 3600), providerRequests: integer(1, 10000), generationRequests: integer(1, 10000), importRequests: integer(1, 10000) }).strict()).min(1),
  expectedRoles: z.array(runtimeRoleCapacitySchema.extend({
    role: z.enum(["all", "api", "worker"]), replicas: integer(1, 1000), maximumReplicas: integer(1, 1000).optional()
  }).strict().refine(role => (role.maximumReplicas ?? role.replicas) >= role.replicas)).min(1)
    .refine(roles => new Set(roles.map(role => role.role)).size === roles.length), systemArchiveAllowLimitIncrease: z.boolean()
}).strict().refine(policy => policy.version === 1 || settingsFeatureGatesSchema.safeParse(policy.featureGates).success);
export type DeploymentSettingsPolicy = z.infer<typeof deploymentSettingsPolicySchema>;
export const settingsFieldDescriptorSchema = z.object({
  key: z.enum(["logLevel", ...Object.keys(settingsFeatureGatesSchema.shape), ...Object.keys(INSTANCE_SETTINGS_NUMERIC_BOUNDS)] as [SettingsFieldKey, ...SettingsFieldKey[]]), environmentName: z.string(), label: z.string(), section: z.enum(["characters", "sharing", "performance", "diagnostics"]),
  scope: z.literal("installation"), kind: z.enum(["boolean", "integer", "enum"]), unit: z.enum(["boolean", "bytes", "milliseconds", "seconds", "count", "ratio", "level"]),
  minimum: integer(1).optional(), maximum: integer(1).optional(), permittedRange: numericBoundSchema.nullable(),
  effectiveValue: z.union([z.boolean(), z.number().safe(), instanceSettingsLogLevelSchema]), source: z.enum(["environment", "database"]),
  lockReason: z.enum(["deployment_disabled", "dependency_disabled"]).nullable(), applyMode: z.literal("restart")
}).strict();
export type SettingsFieldDescriptor = z.infer<typeof settingsFieldDescriptorSchema> & { key: SettingsFieldKey };
export const instanceSettingsViewSchema = z.object({
  activeRevision: settingsRevisionSchema.nullable(), requestedRevision: settingsRevisionSchema.nullable(), active: instanceSettingsSchema,
  requested: instanceSettingsSchema.nullable(), resetDefaults: instanceSettingsSchema.nullable(), fields: z.array(settingsFieldDescriptorSchema), activationStatus: z.enum(["environment", "active", "restart_required"])
}).strict();
export type InstanceSettingsView = z.infer<typeof instanceSettingsViewSchema>;
export const settingsOperatorSessionRequestSchema = z.object({ managementKey: z.string().min(1).max(4096) }).strict();
export const settingsOperatorSessionResponseSchema = z.object({ csrfToken: z.string().min(1), expiresAt: z.iso.datetime() }).strict();

export const settingsOperatorStatusSchema = z.union([
  z.object({managementEnabled:z.boolean(),unlocked:z.literal(false)}).strict(),
  z.object({managementEnabled:z.literal(true),unlocked:z.literal(true),csrfToken:z.string().min(1),expiresAt:z.iso.datetime()}).strict(),
  z.object({managementEnabled:z.literal(true),unlocked:z.literal(true),accessMode:z.literal("local-single-user")}).strict()
]);
export const instanceSettingsHistorySchema = z.object({
  events:z.array(z.object({id:settingsRevisionSchema,kind:z.enum(["seed","proposal","rollback","activation","cancellation"]),revision:settingsRevisionSchema,
    actorUserId:z.uuid(),operatorSessionId:z.uuid().nullable(),localSingleUser:z.boolean().optional(),reasonCode:z.enum(["seed_import","operator_rollback","operator_change","maintenance_activation","maintenance_environment"]),
    changedKeys:z.array(settingsFieldDescriptorSchema.shape.key).max(Object.keys(settingsFieldDescriptorSchema.shape.key.enum).length),createdAt:z.iso.datetime()}).strict()).max(100),
  nextCursor:settingsRevisionSchema.nullable()
}).strict();

export const localSettingsRestartRequestSchema = z.object({ expectedRequestedRevision: settingsRevisionSchema, operationId: z.string().uuid() }).strict();
export const localSettingsRestartOperationSchema = z.object({ operationId: z.string().uuid(), revision: settingsRevisionSchema, status: z.enum(["draining", "restarting", "failed", "ready"]), error: z.string().max(1000).optional() }).strict();
export type LocalSettingsRestartOperation = z.infer<typeof localSettingsRestartOperationSchema>;
