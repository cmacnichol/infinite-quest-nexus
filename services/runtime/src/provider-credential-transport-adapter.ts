import { randomUUID } from "node:crypto";
import type {
  ProviderHealthDiagnosticCode,
  ProviderHealthPort,
  ProviderCandidate,
  ProviderModelInventory,
  ProviderModelInventoryPort,
  ProviderRole,
  ProviderRuntimeLeasePort
} from "../../../packages/application/src/providers/index.js";
import type { DatabaseClient } from "../../../packages/database/src/pool.js";
import type { OpenRouterPresetSnapshot } from "../../../packages/contracts/src/index.js";
import {
  loadPrivateProviderManagementCredentialRow,
  loadPrivateProviderCredentialRow,
  type PrivateProviderCredentialRow,
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
  encryptCredential,
  createOpenRouterPresetDiscovery,
  type OpenRouterPresetSummary,
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
  leaseDurationMs?: number;
}>): RuntimeProviderAdapter {
  const leaseDurationMs = options.leaseDurationMs ?? 60_000;
  const presetDiscovery = createOpenRouterPresetDiscovery(options.transport);

  async function load(ownerUserId: string, providerProfileId: string) {
    const row = await loadPrivateProviderCredentialRow(options.database, ownerUserId, providerProfileId);
    if (!row) throw Object.assign(new Error("Enabled provider profile not found."), { statusCode: 404 });
    return row;
  }

  async function loadForManagementDiscovery(ownerUserId: string, providerProfileId: string) {
    const row = await loadPrivateProviderManagementCredentialRow(options.database, ownerUserId, providerProfileId);
    if (!row) throw Object.assign(new Error("Provider profile not found."), { statusCode: 404 });
    return row;
  }

  function opaqueReference(providerProfileId: string, hasCredential: boolean) {
    return hasCredential ? Object.freeze({
      kind: "provider_credential_reference" as const,
      referenceId: providerProfileId
    }) : null;
  }

  function transportProfile(row: PrivateProviderCredentialRow, model = row.defaultModel): TextProviderProfile {
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
    row: PrivateProviderCredentialRow,
    providerRole: R,
    model = row.defaultModel,
  ): RuntimeProviderDescriptor<R> {
    return Object.freeze({
      id: row.providerProfileId,
      name: row.name,
      providerRole,
      providerType: row.providerType,
      model,
      contextWindowTokens: row.contextWindowTokens,
      maxOutputTokens: row.maxOutputTokens,
      temperature: row.temperature,
      requestTimeoutMs: row.requestTimeoutMs,
      configuration: Object.freeze({ ...row.configuration })
    });
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
        const models = await (request.providerRole === "image"
          ? discoverImageModels(profile, options.transport)
          : request.providerRole === "embedding"
            ? discoverEmbeddingModels(profile, options.transport)
            : discoverModels(profile, options.transport));
        await options.health.recordHealth({ ownerUserId: request.ownerUserId, providerProfileId: request.providerProfileId, outcome: "healthy" });
        return {
          providerProfileId: request.providerProfileId,
          providerRole: request.providerRole,
          models: models.map((value) => ({
            id: value.id,
            name: value.displayName,
            ...(value.contextLength > 0 ? { contextWindowTokens: value.contextLength } : {})
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
    discoverCandidateModels: (candidate) => discoverCandidateModels(candidate, null)
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
          ...(value.contextLength > 0 ? { contextWindowTokens: value.contextLength } : {})
        }))
      };
    } catch {
      throw Object.assign(new Error("Provider model inventory is unavailable."), { statusCode: 502 });
    }
  }

  function assertPresetCandidate(candidate: ProviderCandidate) {
    if (candidate.providerType !== "openrouter" || !["text", "intent"].includes(candidate.providerRole)) {
      throw Object.assign(new Error("OpenRouter preset discovery is available only for text and intent providers."), { statusCode: 400 });
    }
  }

  function candidateProfile(candidate: ProviderCandidate, credential: string | null): TextProviderProfile {
    assertPresetCandidate(candidate);
    return {
      providerType: candidate.providerType,
      baseUrl: candidate.baseUrl.replace(/\/+$/, ""),
      model: candidate.defaultModel,
      contextWindowTokens: candidate.contextWindowTokens,
      maxOutputTokens: candidate.maxOutputTokens,
      temperature: candidate.temperature,
      requestTimeoutMs: candidate.requestTimeoutMs,
      configuration: validateProviderConfiguration(candidate.providerType, candidate.configuration),
      ...(credential?.trim() ? { apiKey: credential.trim() } : {})
    };
  }

  async function presetProfile(ownerUserId: string, providerProfileId: string): Promise<TextProviderProfile> {
    const row = await loadForManagementDiscovery(ownerUserId, providerProfileId);
    if (row.providerType !== "openrouter" || !["text", "intent"].includes(row.providerRole)) {
      throw Object.assign(new Error("OpenRouter preset discovery is available only for text and intent providers."), { statusCode: 400 });
    }
    return transportProfile(row);
  }

  async function presetCandidateProfile(
    ownerUserId: string,
    providerProfileId: string,
    candidate: ProviderCandidate,
  ): Promise<TextProviderProfile> {
    const row = await loadForManagementDiscovery(ownerUserId, providerProfileId);
    assertPresetCandidate(candidate);
    if (row.providerType !== candidate.providerType || row.providerRole !== candidate.providerRole) {
      throw Object.assign(new Error("Provider profile not found."), { statusCode: 404 });
    }
    const credential = row.encryptedCredential
      ? decryptCredential(row.encryptedCredential, options.credentialSecret)
      : null;
    return candidateProfile(candidate, credential);
  }

  const execution: RuntimeProviderExecutionPort = {
    async text(scope, providerProfileId, providerRole, model) {
      const row = await load(scope.ownerUserId, providerProfileId);
      if (row.providerRole !== providerRole) {
        throw Object.assign(new Error(`Enabled ${providerRole} provider profile not found.`), { statusCode: 404 });
      }
      const selectedModel = model?.trim() || row.defaultModel;
      return Object.freeze({
        ...descriptor(row, providerRole, selectedModel),
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
    async discoverPresets(scope, providerProfileId, page) {
      return presetDiscovery.list(await presetProfile(scope.ownerUserId, providerProfileId), page);
    },
    async getPreset(scope, providerProfileId, slug) {
      return presetDiscovery.get(await presetProfile(scope.ownerUserId, providerProfileId), slug);
    },
    async getPresetForCandidate(scope, providerProfileId, candidate, slug) {
      return presetDiscovery.get(
        await presetCandidateProfile(scope.ownerUserId, providerProfileId, candidate),
        slug
      );
    },
    async discoverCandidatePresetsWithCredential(candidate, credential, page) {
      return presetDiscovery.list(candidateProfile(candidate, credential), page);
    },
    async discoverCandidatePresetWithCredential(candidate, credential, slug) {
      return presetDiscovery.get(candidateProfile(candidate, credential), slug);
    },
    async storeCredential(ownerUserId, providerProfileId, credential) {
      const encrypted = credential?.trim()
        ? encryptCredential(credential.trim(), options.credentialSecret)
        : null;
      await writeEncryptedProviderCredential(options.database, ownerUserId, providerProfileId, encrypted);
    }
  };
}
