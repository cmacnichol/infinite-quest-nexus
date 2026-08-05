import type {
  ProviderApplication,
  ProviderApplicationDependencies
} from "./ports.js";
import type {
  ImmutablePromptSnapshot,
  PromptSnapshotEntry,
  PromptSnapshotVersion,
  SafeProviderConfiguration
} from "./types.js";

function freezeConfiguration(configuration: SafeProviderConfiguration): SafeProviderConfiguration {
  return Object.freeze({ ...configuration });
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
