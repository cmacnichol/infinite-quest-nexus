import type {
  PromptTemplateKey,
  ProviderProfileInput,
  ProviderProfileUpdate,
  ProviderTextRequest,
  OpenRouterPresetSnapshot
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
import type {
  OpenRouterPresetSummary,
  ProviderRequest,
  ProviderResult
} from "../../../packages/story-engine/src/index.js";

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
  discoverPresets(
    scope: Readonly<{ ownerUserId: string }>,
    providerProfileId: string,
    page: Readonly<{ offset: number; limit: number }>,
  ): Promise<Readonly<{ presets: readonly OpenRouterPresetSummary[]; totalCount: number }>>;
  getPreset(
    scope: Readonly<{ ownerUserId: string }>,
    providerProfileId: string,
    slug: string,
  ): Promise<OpenRouterPresetSnapshot>;
  getPresetForCandidate(
    scope: Readonly<{ ownerUserId: string }>,
    providerProfileId: string,
    candidate: ProviderCandidate,
    slug: string,
  ): Promise<OpenRouterPresetSnapshot>;
  discoverCandidatePresetsWithCredential(
    candidate: ProviderCandidate,
    credential: string | null,
    page: Readonly<{ offset: number; limit: number }>,
  ): Promise<Readonly<{ presets: readonly OpenRouterPresetSummary[]; totalCount: number }>>;
  discoverCandidatePresetWithCredential(
    candidate: ProviderCandidate,
    credential: string | null,
    slug: string,
  ): Promise<OpenRouterPresetSnapshot>;
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
  const response = {
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
  if (profile.providerRole === "text" || profile.providerRole === "intent") {
    return {
      ...response,
      routingSource: profile.routingSource,
      fallbackModels: profile.fallbackModels,
      preset: profile.preset,
      providerPolicy: profile.providerPolicy
    };
  }
  return response;
}

function snapshotSelection(snapshot: OpenRouterPresetSnapshot) {
  const [model, ...fallbackModels] = snapshot.models;
  if (!model) throw Object.assign(new Error("OpenRouter preset did not contain a usable model plan."), { statusCode: 400 });
  return {
    routingSource: "openrouter_preset" as const,
    defaultModel: model,
    fallbackModels,
    preset: {
      slug: snapshot.slug,
      designatedVersionId: snapshot.designatedVersionId,
      version: snapshot.version,
      configHash: snapshot.configHash
    },
    providerPolicy: snapshot.providerPolicy
  };
}

function modelSelection(defaultModel: string, fallbackModels: readonly string[]) {
  return {
    routingSource: "models" as const,
    defaultModel,
    fallbackModels,
    preset: null,
    providerPolicy: {}
  };
}

function assertPresetProfile(profile: ProviderProfileView) {
  if (profile.providerType !== "openrouter" || !["text", "intent"].includes(profile.providerRole)) {
    throw Object.assign(new Error("OpenRouter preset discovery is available only for text and intent providers."), { statusCode: 400 });
  }
}

function candidate(ownerUserId: string, input: ProviderProfileInput): ProviderCandidate {
  if (input.providerType !== "openrouter" || !["text", "intent"].includes(input.providerRole)) {
    throw Object.assign(new Error("OpenRouter preset discovery is available only for text and intent providers."), { statusCode: 400 });
  }
  return {
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
        const selection = input.routingSource === "openrouter_preset"
          ? snapshotSelection(await runtime.discoverCandidatePresetWithCredential(
              candidate(ownerUserId, input), input.apiKey ?? null, input.presetSlug!
            ))
          : modelSelection(input.defaultModel, input.fallbackModels ?? []);
        const mutation = await application.createProfile({
          ownerUserId,
          name: input.name,
          providerType: input.providerType,
          providerRole: input.providerRole,
          baseUrl: input.baseUrl,
          defaultModel: selection.defaultModel,
          routingSource: selection.routingSource,
          fallbackModels: selection.fallbackModels,
          preset: selection.preset,
          providerPolicy: selection.providerPolicy,
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
        const resolvedSelection = input.routingSource === "openrouter_preset"
          ? await (async () => {
              const existing = (await application.listProfiles({ ownerUserId }))
                .find((profile) => profile.id === providerProfileId);
              if (!existing) throw Object.assign(new Error("Provider profile not found."), { statusCode: 404 });
              const patchedCandidate: ProviderCandidate = {
                ownerUserId,
                name: input.name ?? existing.name,
                providerType: existing.providerType,
                providerRole: existing.providerRole,
                baseUrl: input.baseUrl ?? existing.baseUrl,
                defaultModel: "",
                contextWindowTokens: input.contextWindowTokens ?? existing.contextWindowTokens,
                maxOutputTokens: input.maxOutputTokens ?? existing.maxOutputTokens,
                temperature: input.temperature ?? existing.temperature,
                requestTimeoutMs: input.requestTimeoutMs ?? existing.requestTimeoutMs,
                configuration: input.configuration === undefined
                  ? existing.configuration
                  : toSafeProviderConfiguration(input.configuration),
                enabled: input.enabled ?? existing.enabled,
                isDefault: input.isDefault ?? existing.isDefault
              };
              const snapshot = input.apiKey === undefined
                ? await runtime.getPresetForCandidate({ ownerUserId }, providerProfileId, patchedCandidate, input.presetSlug!)
                : await runtime.discoverCandidatePresetWithCredential(
                    patchedCandidate, input.apiKey ?? null, input.presetSlug!
                  );
              return snapshotSelection(snapshot);
            })()
          : input.routingSource === "models"
            ? modelSelection(input.defaultModel!, input.fallbackModels!)
            : undefined;
        const mutation = await application.updateProfile({
          ownerUserId,
          providerProfileId,
          changes: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
            ...(input.defaultModel === undefined ? {} : { defaultModel: input.defaultModel }),
            ...(resolvedSelection === undefined ? {} : {
              defaultModel: resolvedSelection.defaultModel,
              routingSource: resolvedSelection.routingSource,
              fallbackModels: resolvedSelection.fallbackModels,
              preset: resolvedSelection.preset,
              providerPolicy: resolvedSelection.providerPolicy
            }),
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

    async models(ownerUserId: string, providerProfileId: string, requestedRole?: ProviderRole) {
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
        providerRole
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

    async presets(ownerUserId: string, providerProfileId: string, page: Readonly<{ offset: number; limit: number }>) {
      const profile = (await composition.application.listProfiles({ ownerUserId }))
        .find((candidate) => candidate.id === providerProfileId);
      if (!profile) throw Object.assign(new Error("Provider profile not found."), { statusCode: 404 });
      assertPresetProfile(profile);
      return composition.runtime.discoverPresets({ ownerUserId }, providerProfileId, page);
    },

    async preset(ownerUserId: string, providerProfileId: string, slug: string) {
      const profile = (await composition.application.listProfiles({ ownerUserId }))
        .find((candidate) => candidate.id === providerProfileId);
      if (!profile) throw Object.assign(new Error("Provider profile not found."), { statusCode: 404 });
      assertPresetProfile(profile);
      return composition.runtime.getPreset({ ownerUserId }, providerProfileId, slug);
    },

    discoverPresets(ownerUserId: string, input: ProviderProfileInput, page: Readonly<{ offset: number; limit: number }>) {
      return composition.runtime.discoverCandidatePresetsWithCredential(candidate(ownerUserId, input), input.apiKey ?? null, page);
    },

    discoverPreset(ownerUserId: string, input: ProviderProfileInput, slug: string) {
      return composition.runtime.discoverCandidatePresetWithCredential(candidate(ownerUserId, input), input.apiKey ?? null, slug);
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
