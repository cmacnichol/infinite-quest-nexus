import type {
  ProviderApplication,
  ProviderApplicationDependencies
} from "./ports.js";
import type {
  ImmutablePromptSnapshot,
  PromptSnapshotEntry,
  PromptSnapshotVersion,
  SafeProviderConfiguration,
  SafeProviderConfigurationFields
} from "./types.js";

function freezeConfiguration(configuration: SafeProviderConfiguration): SafeProviderConfiguration {
  return Object.freeze({ ...configuration }) as SafeProviderConfiguration;
}

const BOOLEAN_CONFIGURATION_KEYS = new Set([
  "streaming",
  "streamingSupport",
  "modelDiscoveryEnabled",
  "allowPrivateArtifactHosts"
]);
const NUMBER_CONFIGURATION_KEYS = new Set([
  "defaultWidth",
  "defaultHeight",
  "defaultImageCount",
  "defaultSteps",
  "defaultGuidance",
  "defaultSeed",
  "defaultPreviewCount",
  "pollIntervalMs",
  "maximumPollIntervalMs",
  "generationTimeoutMs",
  "maximumAttempts"
]);
const STRING_CONFIGURATION_KEYS = new Set([
  "httpReferer",
  "defaultAspectRatio",
  "defaultSizePreset",
  "defaultSampler",
  "defaultScheduler"
]);
const EMBEDDING_NUMBER_CONFIGURATION_RANGES = new Map<string, readonly [number, number]>([
  ["embeddingMaxInputTokens", [128, 1_000_000]],
  ["embeddingMaxBatchItems", [1, 128]],
  ["embeddingMaxBatchTokens", [128, 4_000_000]],
  ["embeddingDimensions", [1, 16_000]],
  ["embeddingMaxRetries", [0, 5]]
]);

function isSafeConfigurationEntry(key: string, value: unknown): boolean {
  const embeddingRange = EMBEDDING_NUMBER_CONFIGURATION_RANGES.get(key);
  if (embeddingRange) {
    return typeof value === "number" && Number.isSafeInteger(value)
      && value >= embeddingRange[0] && value <= embeddingRange[1];
  }
  if (key === "retryLimit") {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  }
  if (BOOLEAN_CONFIGURATION_KEYS.has(key)) return typeof value === "boolean";
  if (NUMBER_CONFIGURATION_KEYS.has(key)) return typeof value === "number" && Number.isFinite(value);
  if (STRING_CONFIGURATION_KEYS.has(key)) return typeof value === "string";
  if (key === "network") return value === "fast" || value === "relaxed";
  if (key === "tokenType") return value === "auto" || value === "sogni" || value === "spark";
  if (key === "contentFilter") return value === "enabled" || value === "disabled";
  if (key === "defaultOutputFormat") return value === "png" || value === "jpeg" || value === "webp";
  if (key === "defaultQuality") {
    return value === "auto" || value === "low" || value === "medium" || value === "high";
  }
  return false;
}

/** Projects untrusted or stored configuration onto the closed safe contract. */
export function toSafeProviderConfiguration(configuration: unknown): SafeProviderConfiguration {
  const source = configuration && typeof configuration === "object" && !Array.isArray(configuration)
    ? configuration as Readonly<Record<string, unknown>>
    : {};
  const safeFields = Object.fromEntries(
    Object.entries(source).filter(([key, value]) => isSafeConfigurationEntry(key, value)),
  ) as SafeProviderConfigurationFields;
  return Object.freeze(safeFields) as SafeProviderConfiguration;
}

function immutablePromptSnapshot(version: PromptSnapshotVersion): PromptSnapshotVersion {
  const snapshot = Object.fromEntries(Object.entries(version.snapshot).map(([key, entry]) => [
    key,
    Object.freeze({ ...(entry as PromptSnapshotEntry) })
  ])) as ImmutablePromptSnapshot;
  return Object.freeze({
    catalogVersion: version.catalogVersion,
    protocolVersion: version.protocolVersion,
    snapshot: Object.freeze(snapshot)
  });
}

/** Platform-free delegation surface; database and credential adapters arrive in 14d2. */
export function createProviderApplication(
  dependencies: ProviderApplicationDependencies,
): ProviderApplication {
  return {
    listProfiles: (scope) => dependencies.profiles.listProfiles(scope),
    createProfile: async (command) => ({
      profile: await dependencies.profiles.createProfile(command),
      configurationProjection: {
        kind: "same_request_echo",
        configuration: freezeConfiguration(command.configuration)
      }
    }),
    updateProfile: async (command) => {
      const profile = await dependencies.profiles.updateProfile(command);
      return {
        profile,
        configurationProjection: command.changes.configuration === undefined
          ? { kind: "sanitized_read" }
          : {
              kind: "same_request_echo",
              configuration: freezeConfiguration(command.changes.configuration)
            }
      };
    },
    deleteProfile: (command) => dependencies.profiles.deleteProfile(command),
    setDefaultProfile: (command) => dependencies.profiles.setDefaultProfile(command),
    listModels: (request) => dependencies.inventory.listModels(request),
    discoverCandidateModels: (candidate) => dependencies.inventory.discoverCandidateModels(candidate),
    recordHealth: (record) => dependencies.health.recordHealth(record),
    resolveDirect: (request) => dependencies.resolution.resolveDirect(request),
    resolveEmbedding: (request) => dependencies.resolution.resolveEmbedding(request),
    listPromptLibrary: (scope) => dependencies.prompts.listPromptLibrary(scope),
    previewPrompt: (request) => dependencies.prompts.previewPrompt(request),
    savePromptOverride: (command) => dependencies.prompts.savePromptOverride(command),
    resetPromptOverride: (command) => dependencies.prompts.resetPromptOverride(command),
    loadPromptSnapshot: async (scope) =>
      immutablePromptSnapshot(await dependencies.prompts.loadPromptSnapshot(scope)),
    classifyTurnIntent: (command) => dependencies.intent.classifyTurnIntent(command),
    recordCost: (database, command) => dependencies.costs.recordCost(database, command),
    attributeGenerationCostsToTurn: (database, scope) =>
      dependencies.costs.attributeGenerationCostsToTurn(database, scope),
    getTurnCosts: (scope) => dependencies.costs.getTurnCosts(scope),
    getCampaignCostSummary: (scope) => dependencies.costs.getCampaignCostSummary(scope)
  };
}
