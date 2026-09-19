import { createHash, randomUUID } from "node:crypto";
import type {
  ProviderHealthDiagnosticCode,
  ProviderHealthPort,
  ProviderCandidate,
  ProviderModelInventory,
  ProviderModelInventoryPort,
  ProviderPresetDetail,
  ProviderPresetInventory,
  ProviderRole,
  ProviderRuntimeLeasePort
} from "../../../packages/application/src/providers/index.js";
import type { DatabaseClient } from "../../../packages/database/src/pool.js";
import {
  loadPrivateProviderCredentialRow,
  validateProviderConfiguration,
  writeEncryptedProviderCredential
} from "../../../packages/database/src/provider-repository.js";
import {
  callEmbeddingProvider,
  callTextProvider,
  decryptCredential,
  discoverEmbeddingModels,
  discoverImageModels,
  discoverModels,
  discoverOpenRouterPreset,
  discoverOpenRouterPresets,
  encryptCredential,
  pollImageProvider,
  submitImageProvider,
  type EmbeddingResult,
  type ImageProviderPollResult,
  type ImageProviderRequest,
  type ImageProviderSubmissionResult,
  type ProviderRequest,
  type ProviderResult,
  type ProviderTransport,
  type TextProviderProfile
} from "../../../packages/story-engine/src/index.js";
import { resolveAuthoringContextWindowTokens } from "./source-authoring-budget.js";
import type { ProviderResponseFormatCapabilities } from "./provider-response-format-capabilities.js";
import { capabilityRouteConfigHash, providerEndpointIdentity, type ProviderCapabilityCacheKey } from "./provider-capability-cache.js";

export type RuntimeProviderDescriptor<R extends ProviderRole = ProviderRole> = Readonly<{
  id: string;
  name: string;
  providerRole: R;
  providerType: TextProviderProfile["providerType"];
  model: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  temperature: number;
  requestTimeoutMs: number;
  /** Opaque hash of the effective non-secret provider destination. */
  endpointIdentity?: string;
  configuration: Readonly<Record<string, unknown>>;
}>;

export type RuntimeTextExecution = RuntimeProviderDescriptor<"text" | "intent"> & Readonly<{
  execute(
    request: ProviderRequest,
    policy?: Readonly<{ maxOutputTokens?: number; temperature?: number }>,
  ): Promise<ProviderResult>;
}>;

export type RuntimeEmbeddingExecution = RuntimeProviderDescriptor<"embedding" | "text"> & Readonly<{
  embed(documents: readonly string[]): Promise<EmbeddingResult>;
}>;

export type RuntimeImageExecution = RuntimeProviderDescriptor<"image"> & Readonly<{
  submit(request: ImageProviderRequest): Promise<ImageProviderSubmissionResult>;
  poll(remoteJobId: string): Promise<ImageProviderPollResult>;
}>;

export type RuntimeProviderExecutionPort = Readonly<{
  text(
    scope: Readonly<{ ownerUserId: string }>,
    providerProfileId: string,
    providerRole: "text" | "intent",
    model?: string,
    /** A caller-supplied selected-model cap may narrow, never enlarge, the profile cap. */
    verifiedModelContextWindowTokens?: number,
  ): Promise<RuntimeTextExecution>;
  embedding(
    scope: Readonly<{ ownerUserId: string }>,
    providerProfileId: string,
    providerRole: "embedding" | "text",
    model?: string,
  ): Promise<RuntimeEmbeddingExecution>;
  image(
    scope: Readonly<{ ownerUserId: string }>,
    providerProfileId: string,
    model?: string,
  ): Promise<RuntimeImageExecution>;
}>;

export type RuntimeProviderAdapter = Readonly<{
  leases: ProviderRuntimeLeasePort;
  inventory: ProviderModelInventoryPort;
  execution: RuntimeProviderExecutionPort;
  storeCredential(ownerUserId: string, providerProfileId: string, credential: string | null): Promise<void>;
  discoverCandidateModelsWithCredential(
    candidate: ProviderCandidate,
    credential: string | null,
  ): Promise<ProviderModelInventory>;
  discoverCandidatePresetsWithCredential(candidate: ProviderCandidate, request: Readonly<{ offset: number; limit: number }>, credential: string | null): Promise<ProviderPresetInventory>;
  resolveCandidatePresetWithCredential(candidate: ProviderCandidate, slug: string, credential: string | null): Promise<ProviderPresetDetail>;
}>;

function diagnostic(error: unknown): ProviderHealthDiagnosticCode {
  const message = error instanceof Error ? `${error.name} ${error.message}`.toLowerCase() : "";
  if (/401|403|auth|credential|token/.test(message)) return "authentication_failed";
  if (/429|rate.?limit/.test(message)) return "rate_limited";
  if (/timeout|abort/.test(message)) return "request_timeout";
  if (/network policy|destination.*allowed|private.*host/.test(message)) return "network_policy_denied";
  if (/model.*(missing|unavailable|not found)/.test(message)) return "model_unavailable";
  if (/response|json|parse|schema/.test(message)) return "invalid_response";
  if (/fetch|socket|connect|dns|transport/.test(message)) return "transport_failure";
  return "provider_unavailable";
}

export function createRuntimeProviderAdapter(options: Readonly<{
  database: DatabaseClient;
  credentialSecret: string;
  transport: ProviderTransport;
  health: ProviderHealthPort;
  responseFormatCapabilities?: ProviderResponseFormatCapabilities;
  leaseDurationMs?: number;
}>): RuntimeProviderAdapter {
  const leaseDurationMs = options.leaseDurationMs ?? 60_000;
  const presetSummaryCache = new Map<string, Readonly<{ expiresAt: number; value: Promise<ProviderPresetInventory> }>>();

  async function load(ownerUserId: string, providerProfileId: string) {
    const row = await loadPrivateProviderCredentialRow(options.database, ownerUserId, providerProfileId);
    if (!row) throw Object.assign(new Error("Enabled provider profile not found."), { statusCode: 404 });
    return row;
  }

  function opaqueReference(providerProfileId: string, hasCredential: boolean) {
    return hasCredential ? Object.freeze({
      kind: "provider_credential_reference" as const,
      referenceId: providerProfileId
    }) : null;
  }

  function transportProfile(row: Awaited<ReturnType<typeof load>>, model = row.defaultModel): TextProviderProfile {
    const apiKey = row.encryptedCredential
      ? decryptCredential(row.encryptedCredential, options.credentialSecret)
      : undefined;
    return {
      providerType: row.providerType,
      baseUrl: row.baseUrl,
      model,
      contextWindowTokens: row.contextWindowTokens,
      maxOutputTokens: row.maxOutputTokens,
      temperature: row.temperature,
      requestTimeoutMs: row.requestTimeoutMs,
      configuration: row.configuration,
      ...(apiKey ? { apiKey } : {})
    };
  }

  function descriptor<R extends ProviderRole>(
    row: Awaited<ReturnType<typeof load>>,
    providerRole: R,
    model = row.defaultModel,
    contextWindowTokens = row.contextWindowTokens,
  ): RuntimeProviderDescriptor<R> {
    return Object.freeze({
      id: row.providerProfileId,
      name: row.name,
      providerRole,
      providerType: row.providerType,
      model,
      contextWindowTokens,
      maxOutputTokens: row.maxOutputTokens,
      temperature: row.temperature,
      requestTimeoutMs: row.requestTimeoutMs,
      endpointIdentity: providerEndpointIdentity(row.baseUrl),
      configuration: Object.freeze({ ...row.configuration })
    });
  }

  function capabilityKey(row: Awaited<ReturnType<typeof load>>, ownerUserId: string, model = row.defaultModel): ProviderCapabilityCacheKey {
    return {
      ownerUserId,
      providerProfileId: row.providerProfileId,
      providerType: row.providerType,
      endpointIdentity: providerEndpointIdentity(row.baseUrl),
      model,
      routeConfigHash: capabilityRouteConfigHash(row.configuration),
      adapterProtocol: "text-schema-adapter-v1"
    };
  }

  const leases: ProviderRuntimeLeasePort = {
    async credentialReference(scope, providerProfileId) {
      const row = await load(scope.ownerUserId, providerProfileId);
      return {
        ownerUserId: scope.ownerUserId,
        providerProfileId,
        providerRole: row.providerRole,
        credential: opaqueReference(providerProfileId, Boolean(row.encryptedCredential))
      };
    },
    async leaseResolved(scope, providerProfileId, providerRole, model) {
      const row = await load(scope.ownerUserId, providerProfileId);
      if (row.providerRole !== providerRole) {
        throw Object.assign(new Error(`Enabled ${providerRole} provider profile not found.`), { statusCode: 404 });
      }
      const selectedModel = model.trim() || row.defaultModel.trim();
      if (!selectedModel) throw Object.assign(new Error("Select a model for this provider profile."), { statusCode: 400 });
      return {
        ownerUserId: scope.ownerUserId,
        leaseId: randomUUID(),
        providerProfileId,
        providerRole,
        baseUrl: row.baseUrl,
        model: selectedModel,
        requestTimeoutMs: row.requestTimeoutMs,
        configuration: row.configuration,
        credential: opaqueReference(providerProfileId, Boolean(row.encryptedCredential)),
        expiresAt: new Date(Date.now() + leaseDurationMs).toISOString()
      };
    }
  };

  const inventory: ProviderModelInventoryPort = {
    async listModels(request) {
      const row = await load(request.ownerUserId, request.providerProfileId);
      const usesTextEmbeddingFallback = row.providerRole === "text" && request.providerRole === "embedding";
      if (row.providerRole !== request.providerRole && !usesTextEmbeddingFallback) {
        throw Object.assign(new Error(`Enabled ${request.providerRole} provider profile not found.`), { statusCode: 404 });
      }
      try {
        const profile = transportProfile(row);
        const models = request.providerRole === "text" && options.responseFormatCapabilities
          ? (await options.responseFormatCapabilities.discoverInventory(
            capabilityKey(row, request.ownerUserId),
            async () => ({
              providerProfileId: request.providerProfileId,
              providerRole: request.providerRole,
              models: (await discoverModels(profile, options.transport)).map((value) => ({
                id: value.id,
                name: value.displayName,
                ...(value.contextLength > 0 ? { contextWindowTokens: value.contextLength } : {}),
                ...(value.responseFormatAdvertisement ? { responseFormatAdvertisement: value.responseFormatAdvertisement } : {})
              }))
            }), request.refresh === true
          )).models
          : (await (request.providerRole === "image"
          ? discoverImageModels(profile, options.transport)
          : request.providerRole === "embedding"
            ? discoverEmbeddingModels(profile, options.transport)
            : discoverModels(profile, options.transport)));
        await options.health.recordHealth({ ownerUserId: request.ownerUserId, providerProfileId: request.providerProfileId, outcome: "healthy" });
        return {
          providerProfileId: request.providerProfileId,
          providerRole: request.providerRole,
          models: models.map((value) => ({
            id: value.id,
            name: "displayName" in value ? value.displayName : value.name,
            ...(() => { const contextWindowTokens = "contextLength" in value ? value.contextLength : value.contextWindowTokens; return contextWindowTokens !== undefined && contextWindowTokens > 0 ? { contextWindowTokens } : {}; })(),
            ...(request.providerRole === "text" && value.responseFormatAdvertisement ? { responseFormatAdvertisement: value.responseFormatAdvertisement } : {})
          }))
        };
      } catch (error) {
        await options.health.recordHealth({
          ownerUserId: request.ownerUserId,
          providerProfileId: request.providerProfileId,
          outcome: "failed",
          diagnosticCode: diagnostic(error)
        });
        throw Object.assign(new Error("Provider model inventory is unavailable."), { statusCode: 502 });
      }
    },
    discoverCandidateModels: (candidate) => discoverCandidateModels(candidate, null),
    async listPresets(request) {
      const row = await load(request.ownerUserId, request.providerProfileId);
      if ((row.providerRole !== "text" && row.providerRole !== "intent") || row.providerType !== "openrouter") throw Object.assign(new Error("OpenRouter text provider profile not found."), { statusCode: 404 });
      const identity = createHash("sha256").update(`${request.ownerUserId}|${row.providerProfileId}|${row.baseUrl}|${row.encryptedCredential ?? ""}|${request.offset}|${request.limit}`).digest("hex");
      if (request.refresh) presetSummaryCache.delete(identity);
      const cached = presetSummaryCache.get(identity);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      const value = discoverOpenRouterPresets(transportProfile(row), request, options.transport).then((page) => Object.freeze({ providerProfileId: request.providerProfileId, page }));
      presetSummaryCache.set(identity, Object.freeze({ expiresAt: Date.now() + 60_000, value }));
      try { return await value; } catch (error) { presetSummaryCache.delete(identity); throw error; }
    },
    async getPreset(request) {
      const row = await load(request.ownerUserId, request.providerProfileId);
      if ((row.providerRole !== "text" && row.providerRole !== "intent") || row.providerType !== "openrouter") throw Object.assign(new Error("OpenRouter text provider profile not found."), { statusCode: 404 });
      return Object.freeze({ providerProfileId: request.providerProfileId, preset: await discoverOpenRouterPreset(transportProfile(row), request.slug, options.transport) });
    },
    async discoverCandidatePresets(candidate, request) {
      if ((candidate.providerRole !== "text" && candidate.providerRole !== "intent") || candidate.providerType !== "openrouter") throw Object.assign(new Error("OpenRouter text provider candidate is required."), { statusCode: 400 });
      const profile: TextProviderProfile = { providerType: candidate.providerType, baseUrl: candidate.baseUrl.replace(/\/+$/, ""), model: candidate.defaultModel, contextWindowTokens: candidate.contextWindowTokens, maxOutputTokens: candidate.maxOutputTokens, temperature: candidate.temperature, requestTimeoutMs: candidate.requestTimeoutMs, configuration: validateProviderConfiguration(candidate.providerType, candidate.configuration) };
      return Object.freeze({ providerProfileId: null, page: await discoverOpenRouterPresets(profile, request, options.transport) });
    },
    async resolveCandidatePreset(candidate, slug) {
      if ((candidate.providerRole !== "text" && candidate.providerRole !== "intent") || candidate.providerType !== "openrouter") throw Object.assign(new Error("OpenRouter text provider candidate is required."), { statusCode: 400 });
      const profile: TextProviderProfile = { providerType: candidate.providerType, baseUrl: candidate.baseUrl.replace(/\/+$/, ""), model: candidate.defaultModel, contextWindowTokens: candidate.contextWindowTokens, maxOutputTokens: candidate.maxOutputTokens, temperature: candidate.temperature, requestTimeoutMs: candidate.requestTimeoutMs, configuration: validateProviderConfiguration(candidate.providerType, candidate.configuration) };
      return Object.freeze({ providerProfileId: null, preset: await discoverOpenRouterPreset(profile, slug, options.transport) });
    }
  };

  async function discoverCandidateModels(
    candidate: ProviderCandidate,
    credential: string | null,
  ): Promise<ProviderModelInventory> {
    const configuration = validateProviderConfiguration(candidate.providerType, candidate.configuration);
    const profile: TextProviderProfile = {
      providerType: candidate.providerType,
      baseUrl: candidate.baseUrl.replace(/\/+$/, ""),
      model: candidate.defaultModel,
      contextWindowTokens: candidate.contextWindowTokens,
      maxOutputTokens: candidate.maxOutputTokens,
      temperature: candidate.temperature,
      requestTimeoutMs: candidate.requestTimeoutMs,
      configuration,
      ...(credential?.trim() ? { apiKey: credential.trim() } : {})
    };
    try {
      const models = await (candidate.providerRole === "image"
        ? discoverImageModels(profile, options.transport)
        : candidate.providerRole === "embedding"
          ? discoverEmbeddingModels(profile, options.transport)
          : discoverModels(profile, options.transport));
      return {
        providerProfileId: null,
        providerRole: candidate.providerRole,
        models: models.map((value) => ({
          id: value.id,
          name: value.displayName,
          ...(value.contextLength > 0 ? { contextWindowTokens: value.contextLength } : {}),
          ...(candidate.providerRole === "text" && value.responseFormatAdvertisement ? { responseFormatAdvertisement: value.responseFormatAdvertisement } : {})
        }))
      };
    } catch {
      throw Object.assign(new Error("Provider model inventory is unavailable."), { statusCode: 502 });
    }
  }

  const execution: RuntimeProviderExecutionPort = {
    async text(scope, providerProfileId, providerRole, model, verifiedModelContextWindowTokens) {
      const row = await load(scope.ownerUserId, providerProfileId);
      if (row.providerRole !== providerRole) {
        throw Object.assign(new Error(`Enabled ${providerRole} provider profile not found.`), { statusCode: 404 });
      }
      const selectedModel = model?.trim() || row.defaultModel;
      const contextWindowTokens = resolveAuthoringContextWindowTokens(row.contextWindowTokens, verifiedModelContextWindowTokens);
      return Object.freeze({
        ...descriptor(row, providerRole, selectedModel, contextWindowTokens),
        execute: (
          request: ProviderRequest,
          policy?: Readonly<{ maxOutputTokens?: number; temperature?: number }>,
        ) => callTextProvider(
          { ...transportProfile(row, selectedModel), ...policy },
          request,
          options.transport
        )
      });
    },
    async embedding(scope, providerProfileId, providerRole, model) {
      const row = await load(scope.ownerUserId, providerProfileId);
      if (row.providerRole !== providerRole) {
        throw Object.assign(new Error(`Enabled ${providerRole} provider profile not found.`), { statusCode: 404 });
      }
      const selectedModel = model?.trim() || row.defaultModel;
      return Object.freeze({
        ...descriptor(row, providerRole, selectedModel),
        embed: (documents: readonly string[]) => callEmbeddingProvider(
          transportProfile(row, selectedModel),
          [...documents],
          options.transport
        )
      });
    },
    async image(scope, providerProfileId, model) {
      const row = await load(scope.ownerUserId, providerProfileId);
      if (row.providerRole !== "image") {
        throw Object.assign(new Error("Enabled image provider profile not found."), { statusCode: 404 });
      }
      const selectedModel = model?.trim() || row.defaultModel;
      return Object.freeze({
        ...descriptor(row, "image", selectedModel),
        submit: (request: ImageProviderRequest) => submitImageProvider(
          transportProfile(row, selectedModel),
          request,
          options.transport
        ),
        poll: (remoteJobId: string) => pollImageProvider(
          transportProfile(row, selectedModel),
          { remoteJobId },
          options.transport
        )
      });
    }
  };

  return {
    leases,
    inventory,
    execution,
    discoverCandidateModelsWithCredential: discoverCandidateModels,
    async discoverCandidatePresetsWithCredential(candidate, request, credential) {
      if ((candidate.providerRole !== "text" && candidate.providerRole !== "intent") || candidate.providerType !== "openrouter") throw Object.assign(new Error("OpenRouter text provider candidate is required."), { statusCode: 400 });
      const profile: TextProviderProfile = { providerType: candidate.providerType, baseUrl: candidate.baseUrl.replace(/\/+$/, ""), model: candidate.defaultModel, contextWindowTokens: candidate.contextWindowTokens, maxOutputTokens: candidate.maxOutputTokens, temperature: candidate.temperature, requestTimeoutMs: candidate.requestTimeoutMs, configuration: validateProviderConfiguration(candidate.providerType, candidate.configuration), ...(credential?.trim() ? { apiKey: credential.trim() } : {}) };
      return Object.freeze({ providerProfileId: null, page: await discoverOpenRouterPresets(profile, request, options.transport) });
    },
    async resolveCandidatePresetWithCredential(candidate, slug, credential) {
      if ((candidate.providerRole !== "text" && candidate.providerRole !== "intent") || candidate.providerType !== "openrouter") throw Object.assign(new Error("OpenRouter text provider candidate is required."), { statusCode: 400 });
      const profile: TextProviderProfile = { providerType: candidate.providerType, baseUrl: candidate.baseUrl.replace(/\/+$/, ""), model: candidate.defaultModel, contextWindowTokens: candidate.contextWindowTokens, maxOutputTokens: candidate.maxOutputTokens, temperature: candidate.temperature, requestTimeoutMs: candidate.requestTimeoutMs, configuration: validateProviderConfiguration(candidate.providerType, candidate.configuration), ...(credential?.trim() ? { apiKey: credential.trim() } : {}) };
      return Object.freeze({ providerProfileId: null, preset: await discoverOpenRouterPreset(profile, slug, options.transport) });
    },
    async storeCredential(ownerUserId, providerProfileId, credential) {
      const encrypted = credential?.trim()
        ? encryptCredential(credential.trim(), options.credentialSecret)
        : null;
      await writeEncryptedProviderCredential(options.database, ownerUserId, providerProfileId, encrypted);
    }
  };
}
