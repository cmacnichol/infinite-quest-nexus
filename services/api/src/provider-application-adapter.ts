import type {
  PromptTemplateKey,
  ProviderProfileInput,
  ProviderProfileUpdate,
  ProviderTextRequest
} from "../../../packages/contracts/src/index.js";
import {
  toSafeProviderConfiguration,
  type ProviderApplication,
  type ProviderCandidate,
  type ProviderModelInventory,
  type ProviderProfileMutationResult,
  type ProviderProfileView,
  type ProviderRole,
  type PromptScope
} from "../../../packages/application/src/providers/index.js";
import { callTextProvider } from "../../../packages/story-engine/src/providers.js";
import type { ProviderTransport, TextProviderProfile } from "../../../packages/story-engine/src/index.js";

type ApiRuntimeProviderAdapter = Readonly<{
  transport: ProviderTransport;
  loadProvider(
    scope: Readonly<{ ownerUserId: string }>,
    providerProfileId: string,
    providerRole: ProviderRole,
    model?: string,
  ): Promise<TextProviderProfile & Readonly<{ id: string; name: string }>>;
  storeCredential(ownerUserId: string, providerProfileId: string, credential: string | null): Promise<void>;
  discoverCandidateModelsWithCredential(
    candidate: ProviderCandidate,
    credential: string | null,
  ): Promise<ProviderModelInventory>;
}>;

type ProviderApiComposition = Readonly<{
  application: ProviderApplication;
  runtime: ApiRuntimeProviderAdapter;
  transaction<T>(work: (binding: Readonly<{
    application: ProviderApplication;
    runtime: ApiRuntimeProviderAdapter;
  }>) => Promise<T>): Promise<T>;
}>;

function profileResponse(
  profile: ProviderProfileView,
  mutation?: ProviderProfileMutationResult,
) {
  const configuration = mutation?.configurationProjection.kind === "same_request_echo"
    ? mutation.configurationProjection.configuration
    : profile.configuration;
  return {
    id: profile.id,
    name: profile.name,
    providerType: profile.providerType,
    providerRole: profile.providerRole,
    baseUrl: profile.baseUrl,
    defaultModel: profile.defaultModel,
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
    updatedAt: profile.updatedAt
  };
}

export type ProviderApiTransportAdapter = ReturnType<typeof createProviderApplicationAdapter>;

export function createProviderApplicationAdapter(composition: ProviderApiComposition) {
  return Object.freeze({
    application: composition.application,
    async list(ownerUserId: string) {
      return (await composition.application.listProfiles({ ownerUserId })).map((profile) => profileResponse(profile));
    },

    async create(ownerUserId: string, input: ProviderProfileInput) {
      return composition.transaction(async ({ application, runtime }) => {
        const mutation = await application.createProfile({
          ownerUserId,
          name: input.name,
          providerType: input.providerType,
          providerRole: input.providerRole,
          baseUrl: input.baseUrl,
          defaultModel: input.defaultModel,
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
        return profileResponse(profile, { ...mutation, profile });
      });
    },

    async update(ownerUserId: string, providerProfileId: string, input: ProviderProfileUpdate) {
      return composition.transaction(async ({ application, runtime }) => {
        const mutation = await application.updateProfile({
          ownerUserId,
          providerProfileId,
          changes: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
            ...(input.defaultModel === undefined ? {} : { defaultModel: input.defaultModel }),
            ...(input.contextWindowTokens === undefined ? {} : { contextWindowTokens: input.contextWindowTokens }),
            ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
            ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
            ...(input.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: input.requestTimeoutMs }),
            ...(input.configuration === undefined ? {} : {
              configuration: toSafeProviderConfiguration(input.configuration)
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
        return profileResponse(profile, { ...mutation, profile });
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
      }));
    },

    async models(ownerUserId: string, providerProfileId: string) {
      const profile = (await composition.application.listProfiles({ ownerUserId }))
        .find((candidate) => candidate.id === providerProfileId);
      if (!profile) throw Object.assign(new Error("Provider profile not found."), { statusCode: 404 });
      const inventory = await composition.application.listModels({
        ownerUserId,
        providerProfileId,
        providerRole: profile.providerRole
      });
      return inventory.models.map((model) => ({
        id: model.id,
        displayName: model.name,
        loaded: false,
        instanceId: model.id,
        contextLength: model.contextWindowTokens ?? 0
      }));
    },

    async discoverModels(ownerUserId: string, input: ProviderProfileInput) {
      const inventory = await composition.runtime.discoverCandidateModelsWithCredential({
        ownerUserId,
        name: input.name,
        providerType: input.providerType,
        providerRole: input.providerRole,
        baseUrl: input.baseUrl,
        defaultModel: input.defaultModel,
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
        contextLength: model.contextWindowTokens ?? 0
      }));
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
      const profile = await composition.runtime.loadProvider(
        { ownerUserId },
        resolution.providerProfileId,
        "text",
        resolution.model
      );
      const systemPrompt = request.messages.filter((message) => message.role === "system")
        .map((message) => message.content).join("\n\n") || "Return only the requested result.";
      const input = request.messages.filter((message) => message.role !== "system")
        .map((message) => `${message.role}: ${message.content}`).join("\n\n");
      const result = await callTextProvider(profile, { systemPrompt, input }, composition.runtime.transport);
      return {
        content: result.content,
        finishReason: result.finishReason,
        model: result.modelInstanceId || profile.model,
        usage: result.usage
      };
    },

    listPromptLibrary(ownerUserId: string, campaignId?: string) {
      const scope: PromptScope = campaignId
        ? { ownerUserId, scope: "campaign", campaignId }
        : { ownerUserId, scope: "application" };
      return composition.application.listPromptLibrary(scope);
    },

    previewPrompt(ownerUserId: string, input: Readonly<{ key: PromptTemplateKey; content: string }>) {
      return composition.application.previewPrompt({ ownerUserId, ...input });
    },

    savePromptOverride(ownerUserId: string, input: Readonly<{
      key: PromptTemplateKey;
      content: string;
      scope: "application" | "campaign";
      campaignId?: string;
    }>) {
      const scope = input.scope === "campaign"
        ? { ownerUserId, scope: "campaign" as const, campaignId: input.campaignId! }
        : { ownerUserId, scope: "application" as const };
      return composition.application.savePromptOverride({ ...scope, key: input.key, content: input.content });
    },

    resetPromptOverride(ownerUserId: string, input: Readonly<{
      key: PromptTemplateKey;
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
