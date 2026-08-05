import {
  createProviderApplication,
  type ProviderApplication,
  type ProviderCostPort,
  type PromptSnapshotVersion
} from "../../../packages/application/src/providers/index.js";
import { createProviderCostRepository } from "../../../packages/database/src/cost-repository.js";
import type { DatabaseClient, DatabasePool } from "../../../packages/database/src/pool.js";
import { withTransaction } from "../../../packages/database/src/pool.js";
import { createPostgresProviderRepositories } from "../../../packages/database/src/provider-repository.js";
import { createPromptRepository } from "../../../packages/database/src/prompt-repository.js";
import type { ProviderTransport } from "../../../packages/story-engine/src/provider-transport.js";
import {
  createRuntimeProviderAdapter,
  type RuntimeProviderAdapter
} from "./provider-credential-transport-adapter.js";
import { createTurnIntentClassificationAdapter } from "./provider-turn-intent-adapter.js";

export type ProviderApplicationTransaction = Readonly<{
  application: ProviderApplication;
  runtime: RuntimeProviderAdapter;
}>;

export type ProviderPromptCollaborators = Readonly<{
  loadCampaignSnapshot(ownerUserId: string, campaignId: string): Promise<PromptSnapshotVersion>;
  loadApplicationSnapshot(ownerUserId: string): Promise<PromptSnapshotVersion>;
  content(
    snapshot: PromptSnapshotVersion["snapshot"] | Record<string, unknown> | undefined,
    key: keyof PromptSnapshotVersion["snapshot"],
  ): string;
  protocolVersion(snapshot: PromptSnapshotVersion): string;
}>;

export type ProviderApplicationComposition = Readonly<{
  role: "api" | "worker";
  application: ProviderApplication;
  runtime: RuntimeProviderAdapter;
  prompts: ProviderPromptCollaborators;
  costs: ProviderCostPort;
  transaction<T>(work: (binding: ProviderApplicationTransaction, client: DatabaseClient) => Promise<T>): Promise<T>;
}>;

function promptContent(
  snapshot: PromptSnapshotVersion["snapshot"] | Record<string, unknown> | undefined,
  key: keyof PromptSnapshotVersion["snapshot"],
): string {
  const entry = snapshot?.[key];
  return entry && typeof entry === "object" && "content" in entry && typeof entry.content === "string"
    ? entry.content
    : "";
}

function createComposition(
  role: "api" | "worker",
  pool: DatabasePool,
  options: Readonly<{ credentialSecret: string; transport: ProviderTransport }>,
): ProviderApplicationComposition {
  function bind(database: DatabaseClient | DatabasePool): ProviderApplicationTransaction {
    const client = database as DatabaseClient;
    const providerRepositories = createPostgresProviderRepositories(client);
    const prompts = createPromptRepository(client);
    const costs = createProviderCostRepository(database);
    const runtime = createRuntimeProviderAdapter({
      database: client,
      credentialSecret: options.credentialSecret,
      transport: options.transport,
      health: providerRepositories.health
    });
    const intent = createTurnIntentClassificationAdapter({
      pool,
      resolution: providerRepositories.resolution,
      runtime,
      prompts,
      costs,
      health: providerRepositories.health
    });
    return {
      runtime,
      application: createProviderApplication({
        profiles: providerRepositories.profiles,
        inventory: runtime.inventory,
        health: providerRepositories.health,
        resolution: providerRepositories.resolution,
        prompts,
        intent,
        costs
      })
    };
  }

  const base = bind(pool);
  const application: ProviderApplication = Object.freeze({
    ...base.application,
    createProfile: (command: Parameters<ProviderApplication["createProfile"]>[0]) =>
      withTransaction(pool, async (client) => bind(client).application.createProfile(command)),
    updateProfile: (command: Parameters<ProviderApplication["updateProfile"]>[0]) =>
      withTransaction(pool, async (client) => bind(client).application.updateProfile(command)),
    deleteProfile: (command: Parameters<ProviderApplication["deleteProfile"]>[0]) =>
      withTransaction(pool, async (client) => bind(client).application.deleteProfile(command)),
    setDefaultProfile: (command: Parameters<ProviderApplication["setDefaultProfile"]>[0]) =>
      withTransaction(pool, async (client) => bind(client).application.setDefaultProfile(command)),
    savePromptOverride: (command: Parameters<ProviderApplication["savePromptOverride"]>[0]) =>
      withTransaction(pool, async (client) => bind(client).application.savePromptOverride(command)),
    resetPromptOverride: (command: Parameters<ProviderApplication["resetPromptOverride"]>[0]) =>
      withTransaction(pool, async (client) => bind(client).application.resetPromptOverride(command))
  });
  const promptCollaborators: ProviderPromptCollaborators = Object.freeze({
    loadCampaignSnapshot: (ownerUserId, campaignId) => application.loadPromptSnapshot({
      ownerUserId,
      scope: "campaign",
      campaignId
    }),
    loadApplicationSnapshot: (ownerUserId) => application.loadPromptSnapshot({
      ownerUserId,
      scope: "application"
    }),
    content: promptContent,
    protocolVersion: (snapshot) => snapshot.protocolVersion
  });
  return Object.freeze({
    role,
    application,
    runtime: base.runtime,
    prompts: promptCollaborators,
    costs: createProviderCostRepository(pool),
    transaction: <T>(work: (binding: ProviderApplicationTransaction, client: DatabaseClient) => Promise<T>) =>
      withTransaction(pool, async (client) => work(bind(client), client))
  });
}

export function createApiProviderApplicationComposition(
  pool: DatabasePool,
  options: Readonly<{ credentialSecret: string; transport: ProviderTransport }>,
): ProviderApplicationComposition {
  return createComposition("api", pool, options);
}

export function createWorkerProviderApplicationComposition(
  pool: DatabasePool,
  options: Readonly<{ credentialSecret: string; transport: ProviderTransport }>,
): ProviderApplicationComposition {
  return createComposition("worker", pool, options);
}
