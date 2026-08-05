import type { ProviderProfileInput } from "../../packages/contracts/src/generation.js";
import { toSafeProviderConfiguration } from "../../packages/application/src/providers/index.js";
import { initialOwnerId, type DatabaseClient, type DatabasePool } from "../../packages/database/src/pool.js";
import { createPromptRepository } from "../../packages/database/src/prompt-repository.js";
import {
  createApiProviderApplicationComposition,
  createWorkerProviderApplicationComposition
} from "../../services/runtime/src/provider-application-composition.js";
import { providerPromptProtocolVersion } from "../../services/runtime/src/provider-application-composition.js";
import { currentIntegrationProviderTransport } from "../integration/provider-transport-test-helper.js";

export function apiProviderGraph(pool: DatabasePool, credentialSecret: string) {
  return createApiProviderApplicationComposition(pool, {
    credentialSecret,
    transport: currentIntegrationProviderTransport(),
  });
}

export function workerProviderGraph(pool: DatabasePool, credentialSecret: string) {
  return createWorkerProviderApplicationComposition(pool, {
    credentialSecret,
    transport: currentIntegrationProviderTransport(),
  });
}

export async function createProvider(
  pool: DatabasePool,
  input: Omit<ProviderProfileInput, "isDefault" | "requestTimeoutMs"> & {
    isDefault?: boolean;
    requestTimeoutMs?: number;
  },
  credentialSecret: string,
) {
  const ownerUserId = await initialOwnerId(pool);
  const graph = apiProviderGraph(pool, credentialSecret);
  const mutation = await graph.application.createProfile({
    ownerUserId,
    name: input.name,
    providerType: input.providerType,
    providerRole: input.providerRole,
    baseUrl: input.baseUrl,
    defaultModel: input.defaultModel,
    contextWindowTokens: input.contextWindowTokens,
    maxOutputTokens: input.maxOutputTokens,
    temperature: input.temperature,
    requestTimeoutMs: input.requestTimeoutMs ?? 300_000,
    configuration: toSafeProviderConfiguration(input.configuration),
    enabled: input.enabled,
    isDefault: Boolean(input.isDefault),
  });
  if (input.apiKey !== undefined) {
    await graph.runtime.storeCredential(ownerUserId, mutation.profile.id, input.apiKey || null);
  }
  return mutation.profile;
}

export async function getCampaignCostSummary(pool: DatabasePool, campaignId: string) {
  const ownerUserId = await initialOwnerId(pool);
  return apiProviderGraph(pool, "test-credential-secret").application.getCampaignCostSummary({
    ownerUserId,
    campaignId,
  });
}

export async function readTurnReportedCostsForTest(
  pool: DatabasePool,
  ownerUserId: string,
  turnIds: readonly string[],
) {
  if (!turnIds.length) return new Map();
  const campaign = await pool.query<{ campaign_id: string }>(
    "SELECT campaign_id FROM turns WHERE owner_user_id = $1 AND id = ANY($2::uuid[]) LIMIT 1",
    [ownerUserId, [...turnIds]],
  );
  const campaignId = campaign.rows[0]?.campaign_id;
  if (!campaignId) return new Map();
  return new Map(await apiProviderGraph(pool, "test-credential-secret").generation.reads.getTurnCosts({
    ownerUserId,
    campaignId,
    turnIds,
  }));
}

export async function loadPromptSnapshotForTest(
  pool: DatabasePool | DatabaseClient,
  ownerUserId: string,
  campaignId?: string,
) {
  return (await createPromptRepository(pool as DatabaseClient).loadPromptSnapshot(campaignId
    ? { ownerUserId, scope: "campaign", campaignId }
    : { ownerUserId, scope: "application" })).snapshot;
}

export async function savePromptOverride(
  pool: DatabasePool,
  request: Readonly<{
    key: Parameters<ReturnType<typeof createPromptRepository>["savePromptOverride"]>[0]["key"];
    scope: "application" | "campaign";
    campaignId?: string;
    content: string;
  }>,
) {
  const ownerUserId = await initialOwnerId(pool);
  return apiProviderGraph(pool, "test-credential-secret").application.savePromptOverride({
    ownerUserId,
    key: request.key,
    content: request.content,
    ...(request.scope === "campaign" ? { scope: "campaign" as const, campaignId: request.campaignId! } : { scope: "application" as const }),
  });
}

export async function resetPromptOverride(
  pool: DatabasePool,
  request: Readonly<{
    key: Parameters<ReturnType<typeof createPromptRepository>["resetPromptOverride"]>[0]["key"];
    scope: "application" | "campaign";
    campaignId?: string;
  }>,
) {
  const ownerUserId = await initialOwnerId(pool);
  return apiProviderGraph(pool, "test-credential-secret").application.resetPromptOverride({
    ownerUserId,
    key: request.key,
    ...(request.scope === "campaign" ? { scope: "campaign" as const, campaignId: request.campaignId! } : { scope: "application" as const }),
  });
}

export { providerPromptProtocolVersion };
