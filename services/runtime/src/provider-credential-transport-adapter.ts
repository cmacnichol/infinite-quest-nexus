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
import {
  loadPrivateProviderCredentialRow,
  validateProviderConfiguration,
  writeEncryptedProviderCredential
} from "../../../packages/database/src/provider-repository.js";
import {
  decryptCredential,
  discoverEmbeddingModels,
  discoverImageModels,
  discoverModels,
  encryptCredential,
  type ProviderTransport,
  type TextProviderProfile
} from "../../../packages/story-engine/src/index.js";

export type RuntimeProviderAdapter = Readonly<{
  leases: ProviderRuntimeLeasePort;
  inventory: ProviderModelInventoryPort;
  storeCredential(ownerUserId: string, providerProfileId: string, credential: string | null): Promise<void>;
  discoverCandidateModelsWithCredential(
    candidate: ProviderCandidate,
    credential: string | null,
  ): Promise<ProviderModelInventory>;
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
      if (row.providerRole !== request.providerRole) {
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
  }

  return {
    leases,
    inventory,
    discoverCandidateModelsWithCredential: discoverCandidateModels,
    async storeCredential(ownerUserId, providerProfileId, credential) {
      const encrypted = credential?.trim()
        ? encryptCredential(credential.trim(), options.credentialSecret)
        : null;
      await writeEncryptedProviderCredential(options.database, ownerUserId, providerProfileId, encrypted);
    }
  };
}
