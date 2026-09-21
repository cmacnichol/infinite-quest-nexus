import type {
  PromptCatalogKey,
  ProviderProfileInput,
  ProviderProfileUpdate,
  ProviderTextRequest
} from "../../../packages/contracts/src/index.js";
import {
  toSafeProviderConfiguration,
  assertProviderConfiguration,
  type ProviderApplication,
  type ProviderCandidate,
  type ProviderModelInventory,
  type ProviderPresetDetail,
  type ProviderPresetInventory,
  type ProviderProfileMutationResult,
  type ProviderProfileView,
  type ProviderRole,
  type PromptScope
} from "../../../packages/application/src/providers/index.js";
import { normalizeTextSelection, selectionCompatibilityId } from "../../../packages/contracts/src/provider-selection.js";
import type { ProviderRequest, ProviderResult } from "../../../packages/story-engine/src/index.js";
import { getProviderOutputSchema } from "../../../packages/story-engine/src/provider-output-schema.js";
import { capabilityRouteConfigHash, providerEndpointIdentity } from "../../../packages/contracts/src/provider-capability-identity.js";
import type { ModelParameterAdvertisement, ResponseSchemaOperation } from "../../../packages/contracts/src/text-response-format.js";
import { projectSafePresetDetail, projectSafePresetPage } from "../../../packages/contracts/src/provider-presets.js";

type ApiRuntimeProviderAdapter = Readonly<{
  execution: Readonly<{
    text(
      scope: Readonly<{ ownerUserId: string }>,
      providerProfileId: string,
      providerRole: "text" | "intent",
      model?: string,
    ): Promise<Readonly<{
      model: string;
      execute(
        request: ProviderRequest,
        policy?: Readonly<{ maxOutputTokens?: number; temperature?: number }>,
      ): Promise<ProviderResult>;
    }>>;
  }>;
  storeCredential(ownerUserId: string, providerProfileId: string, credential: string | null): Promise<void>;
  discoverCandidateModelsWithCredential(
    candidate: ProviderCandidate,
    credential: string | null,
  ): Promise<ProviderModelInventory>;
  discoverCandidatePresetsWithCredential(candidate: ProviderCandidate, request: Readonly<{ offset: number; limit: number }>, credential: string | null): Promise<ProviderPresetInventory>;
  resolveCandidatePresetWithCredential(candidate: ProviderCandidate, slug: string, credential: string | null, signal?: AbortSignal): Promise<ProviderPresetDetail>;
}>;

type ProviderApiComposition = Readonly<{
  application: ProviderApplication;
  runtime: ApiRuntimeProviderAdapter;
  responseFormatCapabilities?: Readonly<{
    registryDigest: string;
    now?: () => string;
    eligibility(input: Readonly<{ advertisement: ModelParameterAdvertisement | null; providerType: "openrouter" | "openai_compatible"; endpointIdentity: string; model: string; routeConfigHash: string; adapterProtocol: "text-schema-adapter-v1"; operation: ResponseSchemaOperation; schemaHash: string; streaming: boolean; now: string; nativeOpenTrackerObjects: boolean }>): Readonly<{ status: string; reason: string; verification: Readonly<{ verifiedAt: string; expiresAt: string }> | null }>;
  }>;
  transaction<T>(work: (binding: Readonly<{
    application: ProviderApplication;
    runtime: ApiRuntimeProviderAdapter;
  }>) => Promise<T>): Promise<T>;
}>;

function responseFormatCapability(profile: ProviderProfileView, model: string, advertisement: ModelParameterAdvertisement | null | undefined, capabilities: ProviderApiComposition["responseFormatCapabilities"]) {
  if (profile.providerRole !== "text" || !capabilities) return undefined;
  const supportedProvider = profile.providerType === "openrouter" || profile.providerType === "openai_compatible";
  const endpointIdentity = providerEndpointIdentity(profile.baseUrl);
  const operations = ([
    ["story", true], ["story", false], ["choices", false], ["continuity_review", false]
  ] as const).map(([operation, streaming]) => {
    const schema = getProviderOutputSchema(operation);
    const result = supportedProvider ? capabilities.eligibility({ advertisement: advertisement ?? null, providerType: profile.providerType, endpointIdentity, model, routeConfigHash: capabilityRouteConfigHash(profile.configuration), adapterProtocol: "text-schema-adapter-v1", operation, schemaHash: schema.schemaHash, streaming, now: capabilities.now?.() ?? new Date().toISOString(), nativeOpenTrackerObjects: schema.requiresOpenTrackerObjects }) : { status: "unknown", reason: "discovery_unavailable", verification: null };
    return { operation, streaming, status: result.status, reason: result.reason, schemaVersion: schema.version, schemaHash: schema.schemaHash, verifiedAt: result.verification?.verifiedAt ?? null, expiresAt: result.verification?.expiresAt ?? null };
  });
  return { version: 1 as const, model, expectedRegistryDigest: capabilities.registryDigest, advertisedAt: advertisement?.discoveredAt ?? null, operations };
}

function profileResponse(
  profile: ProviderProfileView,
  mutation?: ProviderProfileMutationResult,
  capabilities?: ProviderApiComposition["responseFormatCapabilities"],
) {
  const configuration = mutation?.configurationProjection.kind === "same_request_echo"
    ? Object.freeze({ ...profile.configuration, ...mutation.configurationProjection.configuration })
    : profile.configuration;
  return {
    id: profile.id,
    name: profile.name,
    providerType: profile.providerType,
    providerRole: profile.providerRole,
    baseUrl: profile.baseUrl,
    defaultModel: profile.defaultModel,
    ...(profile.textSelection === undefined ? {} : { textSelection: profile.textSelection }),
    contextWindowTokens: profile.contextWindowTokens,
    maxOutputTokens: profile.maxOutputTokens,
    temperature: profile.temperature,
    requestTimeoutMs: profile.requestTimeoutMs,
    configuration,
    enabled: profile.enabled,
    isDefault: profile.isDefault,
    healthStatus: profile.health.status,
    consecutiveFailures: profile.health.consecutiveFailures,
    lastHealthCheckAt: profile.health.lastCheckedAt,
    lastHealthError: null,
    hasApiKey: profile.hasCredential,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    ...(profile.providerRole === "text" ? { responseFormatCapability: responseFormatCapability(profile, profile.defaultModel, null, capabilities) } : {})
  };
}

export type ProviderApiTransportAdapter = ReturnType<typeof createProviderApplicationAdapter>;

function assertTextSelectionRole(input: Readonly<{ providerRole: ProviderRole; textSelection?: unknown }>): void {
  if (input.textSelection !== undefined && input.providerRole !== "text" && input.providerRole !== "intent") {
    throw Object.assign(new Error("Text selections are available only for text or intent provider profiles."), { statusCode: 400 });
  }
}

export function createProviderApplicationAdapter(composition: ProviderApiComposition) {
  return Object.freeze({
    application: composition.application,
    async list(ownerUserId: string) {
      return (await composition.application.listProfiles({ ownerUserId })).map((profile) => profileResponse(profile, undefined, composition.responseFormatCapabilities));
    },

    async create(ownerUserId: string, input: ProviderProfileInput) {
      assertProviderConfiguration(input.configuration, input.providerRole);
      assertTextSelectionRole(input);
      const textSelection = input.providerRole === "text" || input.providerRole === "intent"
        ? normalizeTextSelection(input)
        : undefined;
      const defaultModel = textSelection ? selectionCompatibilityId(textSelection) : input.defaultModel;
      return composition.transaction(async ({ application, runtime }) => {
        const mutation = await application.createProfile({
          ownerUserId,
          name: input.name,
          providerType: input.providerType,
          providerRole: input.providerRole,
          baseUrl: input.baseUrl,
          defaultModel,
          ...(textSelection === undefined ? {} : { textSelection }),
          contextWindowTokens: input.contextWindowTokens,
          maxOutputTokens: input.maxOutputTokens,
          temperature: input.temperature,
          requestTimeoutMs: input.requestTimeoutMs,
          configuration: toSafeProviderConfiguration(input.configuration),
          enabled: input.enabled,
          isDefault: input.isDefault
        });
        if (input.apiKey !== undefined) {
          await runtime.storeCredential(ownerUserId, mutation.profile.id, input.apiKey || null);
        }
        const profile = input.apiKey === undefined
          ? mutation.profile
          : { ...mutation.profile, hasCredential: Boolean(input.apiKey) };
        return profileResponse(profile, { ...mutation, profile }, composition.responseFormatCapabilities);
      });
    },

    async update(ownerUserId: string, providerProfileId: string, input: ProviderProfileUpdate) {
      assertProviderConfiguration(input.configuration);
      const textSelection = input.textSelection;
      return composition.transaction(async ({ application, runtime }) => {
        const mutation = await application.updateProfile({
          ownerUserId,
          providerProfileId,
          changes: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
            ...(input.defaultModel === undefined && textSelection === undefined ? {} : {
              ...(input.defaultModel === undefined ? { defaultModel: selectionCompatibilityId(textSelection!) } : { defaultModel: input.defaultModel }),
              ...(textSelection === undefined ? {} : { textSelection })
            }),
            ...(input.contextWindowTokens === undefined ? {} : { contextWindowTokens: input.contextWindowTokens }),
            ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
            ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
            ...(input.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: input.requestTimeoutMs }),
            ...(input.configuration === undefined ? {} : {
              configuration: toSafeProviderConfiguration(input.configuration),
              ...(!Object.prototype.hasOwnProperty.call(input.configuration, "textExecutionOverrides") ? {} : {
                textExecutionOverrides: input.configuration.textExecutionOverrides === null
                  ? null
                  : toSafeProviderConfiguration(input.configuration).textExecutionOverrides
              })
            }),
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault })
          }
        });
        if (input.apiKey !== undefined) {
          await runtime.storeCredential(ownerUserId, providerProfileId, input.apiKey || null);
        }
        const profile = input.apiKey === undefined
          ? mutation.profile
          : { ...mutation.profile, hasCredential: Boolean(input.apiKey) };
        return profileResponse(profile, { ...mutation, profile }, composition.responseFormatCapabilities);
      });
    },

    async delete(ownerUserId: string, providerProfileId: string) {
      const deleted = await composition.application.deleteProfile({ ownerUserId, providerProfileId });
      return { deleted: true, id: deleted.id, name: deleted.name, provider_role: deleted.providerRole };
    },

    async setDefault(ownerUserId: string, providerProfileId: string) {
      const profile = (await composition.application.listProfiles({ ownerUserId }))
        .find((candidate) => candidate.id === providerProfileId);
      if (!profile) throw Object.assign(new Error("Enabled provider profile not found."), { statusCode: 404 });
      return profileResponse(await composition.application.setDefaultProfile({
        ownerUserId,
        providerProfileId,
        providerRole: profile.providerRole
      }), undefined, composition.responseFormatCapabilities);
    },

    async models(ownerUserId: string, providerProfileId: string, requestedRole?: ProviderRole, refresh = false) {
      const profile = (await composition.application.listProfiles({ ownerUserId }))
        .find((candidate) => candidate.id === providerProfileId);
      if (!profile) throw Object.assign(new Error("Provider profile not found."), { statusCode: 404 });
      const providerRole = requestedRole ?? profile.providerRole;
      const usesTextEmbeddingFallback = profile.providerRole === "text" && providerRole === "embedding";
      if (profile.providerRole !== providerRole && !usesTextEmbeddingFallback) {
        throw Object.assign(new Error("Provider profile role does not support the requested model inventory."), { statusCode: 400 });
      }
      const inventory = await composition.application.listModels({
        ownerUserId,
        providerProfileId,
        providerRole,
        refresh
      });
      const exposeTextResponseFormatMetadata = providerRole === "text";
      return inventory.models.map((model) => ({
        id: model.id,
        displayName: model.name,
        loaded: false,
        instanceId: model.id,
        contextLength: model.contextWindowTokens ?? 0,
        ...(exposeTextResponseFormatMetadata && model.responseFormatAdvertisement ? { responseFormatAdvertisement: model.responseFormatAdvertisement } : {}),
        ...(exposeTextResponseFormatMetadata && composition.responseFormatCapabilities?.registryDigest ? { responseFormatRegistryDigest: composition.responseFormatCapabilities.registryDigest } : {}),
        ...(exposeTextResponseFormatMetadata ? { responseFormatCapability: responseFormatCapability(profile, model.id, model.responseFormatAdvertisement, composition.responseFormatCapabilities) } : {})
      }));
    },

    async presets(ownerUserId: string, providerProfileId: string, offset: number, limit: number, refresh = false, signal?: AbortSignal) {
      const profile = (await composition.application.listProfiles({ ownerUserId })).find((candidate) => candidate.id === providerProfileId);
      if (!profile) throw Object.assign(new Error("Provider profile not found."), { statusCode: 404 });
      if ((profile.providerRole !== "text" && profile.providerRole !== "intent") || profile.providerType !== "openrouter") throw Object.assign(new Error("OpenRouter text provider profile is required."), { statusCode: 400 });
      return projectSafePresetPage((await composition.application.listPresets({ ownerUserId, providerProfileId, offset, limit, refresh, ...(signal ? { signal } : {}) })).page);
    },

    async preset(ownerUserId: string, providerProfileId: string, slug: string, signal?: AbortSignal) {
      const profile = (await composition.application.listProfiles({ ownerUserId })).find((candidate) => candidate.id === providerProfileId);
      if (!profile) throw Object.assign(new Error("Provider profile not found."), { statusCode: 404 });
      if ((profile.providerRole !== "text" && profile.providerRole !== "intent") || profile.providerType !== "openrouter") throw Object.assign(new Error("OpenRouter text provider profile is required."), { statusCode: 400 });
      return projectSafePresetDetail((await composition.application.getPreset({ ownerUserId, providerProfileId, slug, ...(signal ? { signal } : {}) })).preset);
    },

    async discoverModels(ownerUserId: string, input: ProviderProfileInput) {
      assertProviderConfiguration(input.configuration, input.providerRole);
      assertTextSelectionRole(input);
      const textSelection = input.providerRole === "text" || input.providerRole === "intent"
        ? normalizeTextSelection(input)
        : undefined;
      const inventory = await composition.runtime.discoverCandidateModelsWithCredential({
        ownerUserId,
        name: input.name,
        providerType: input.providerType,
        providerRole: input.providerRole,
        baseUrl: input.baseUrl,
        defaultModel: textSelection ? selectionCompatibilityId(textSelection) : input.defaultModel,
        ...(textSelection === undefined ? {} : { textSelection }),
        contextWindowTokens: input.contextWindowTokens,
        maxOutputTokens: input.maxOutputTokens,
        temperature: input.temperature,
        requestTimeoutMs: input.requestTimeoutMs,
        configuration: toSafeProviderConfiguration(input.configuration),
        enabled: input.enabled,
        isDefault: input.isDefault
      }, input.apiKey ?? null);
      return inventory.models.map((model) => ({
        id: model.id,
        displayName: model.name,
        loaded: false,
        instanceId: model.id,
        contextLength: model.contextWindowTokens ?? 0,
        ...(input.providerRole === "text" && model.responseFormatAdvertisement ? { responseFormatAdvertisement: model.responseFormatAdvertisement } : {}),
        ...(input.providerRole === "text" && composition.responseFormatCapabilities?.registryDigest ? { responseFormatRegistryDigest: composition.responseFormatCapabilities.registryDigest } : {})
      }));
    },

    async discoverPresets(ownerUserId: string, input: ProviderProfileInput, offset: number, limit: number, signal?: AbortSignal) {
      assertProviderConfiguration(input.configuration, input.providerRole);
      assertTextSelectionRole(input);
      const textSelection = input.providerRole === "text" || input.providerRole === "intent" ? normalizeTextSelection(input) : undefined;
      const candidate: ProviderCandidate = { ownerUserId, name: input.name, providerType: input.providerType, providerRole: input.providerRole, baseUrl: input.baseUrl, defaultModel: textSelection ? selectionCompatibilityId(textSelection) : input.defaultModel, ...(textSelection ? { textSelection } : {}), contextWindowTokens: input.contextWindowTokens, maxOutputTokens: input.maxOutputTokens, temperature: input.temperature, requestTimeoutMs: input.requestTimeoutMs, configuration: toSafeProviderConfiguration(input.configuration), enabled: input.enabled, isDefault: input.isDefault };
      return projectSafePresetPage((await composition.runtime.discoverCandidatePresetsWithCredential(candidate, { offset, limit, ...(signal ? { signal } : {}) }, input.apiKey ?? null)).page);
    },

    async resolvePreset(ownerUserId: string, input: ProviderProfileInput, slug: string, signal?: AbortSignal) {
      assertProviderConfiguration(input.configuration, input.providerRole);
      assertTextSelectionRole(input);
      const textSelection = input.providerRole === "text" || input.providerRole === "intent" ? normalizeTextSelection(input) : undefined;
      const candidate: ProviderCandidate = { ownerUserId, name: input.name, providerType: input.providerType, providerRole: input.providerRole, baseUrl: input.baseUrl, defaultModel: textSelection ? selectionCompatibilityId(textSelection) : input.defaultModel, ...(textSelection ? { textSelection } : {}), contextWindowTokens: input.contextWindowTokens, maxOutputTokens: input.maxOutputTokens, temperature: input.temperature, requestTimeoutMs: input.requestTimeoutMs, configuration: toSafeProviderConfiguration(input.configuration), enabled: input.enabled, isDefault: input.isDefault };
      return projectSafePresetDetail((await composition.runtime.resolveCandidatePresetWithCredential(candidate, slug, input.apiKey ?? null, signal)).preset);
    },

    async generateText(ownerUserId: string, request: ProviderTextRequest) {
      const resolution = await composition.application.resolveDirect({
        ownerUserId,
        providerRole: "text",
        ...(request.providerProfileId === undefined ? {} : {
          selectedProviderProfileId: request.providerProfileId
        }),
        ...(request.model === undefined ? {} : { model: request.model })
      });
      if (resolution.status === "unconfigured") {
        throw Object.assign(new Error("Add a text provider or mark one as default in Provider Management."), { statusCode: 409 });
      }
      const provider = await composition.runtime.execution.text(
        { ownerUserId },
        resolution.providerProfileId,
        "text",
        resolution.model
      );
      const systemPrompt = request.messages.filter((message) => message.role === "system")
        .map((message) => message.content).join("\n\n") || "Return only the requested result.";
      const input = request.messages.filter((message) => message.role !== "system")
        .map((message) => `${message.role}: ${message.content}`).join("\n\n");
      const result = await provider.execute({ systemPrompt, input });
      return {
        content: result.content,
        finishReason: result.finishReason,
        model: result.modelInstanceId || provider.model,
        usage: result.usage
      };
    },

    listPromptLibrary(ownerUserId: string, campaignId?: string) {
      const scope: PromptScope = campaignId
        ? { ownerUserId, scope: "campaign", campaignId }
        : { ownerUserId, scope: "application" };
      return composition.application.listPromptLibrary(scope);
    },

    previewPrompt(ownerUserId: string, input: Readonly<{ key: PromptCatalogKey; content: string }>) {
      return composition.application.previewPrompt({ ownerUserId, ...input });
    },

    savePromptOverride(ownerUserId: string, input: Readonly<{
      key: PromptCatalogKey;
      content: string;
      scope: "application" | "campaign";
      campaignId?: string;
      compatibilityAcknowledgement?: Readonly<{ requiredShapeVersion: string; protocolIdentity: string; contentHash: string }>;
    }>) {
      const scope = input.scope === "campaign"
        ? { ownerUserId, scope: "campaign" as const, campaignId: input.campaignId! }
        : { ownerUserId, scope: "application" as const };
      return composition.application.savePromptOverride({
        ...scope,
        key: input.key,
        content: input.content,
        ...(input.compatibilityAcknowledgement === undefined ? {} : { compatibilityAcknowledgement: input.compatibilityAcknowledgement })
      });
    },

    resetPromptOverride(ownerUserId: string, input: Readonly<{
      key: PromptCatalogKey;
      scope: "application" | "campaign";
      campaignId?: string;
    }>) {
      const scope = input.scope === "campaign"
        ? { ownerUserId, scope: "campaign" as const, campaignId: input.campaignId! }
        : { ownerUserId, scope: "application" as const };
      return composition.application.resetPromptOverride({ ...scope, key: input.key });
    }
  });
}
