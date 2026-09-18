import { createHash } from "node:crypto";
import {
  createProviderApplication,
  type CharacterOrganizationCostPort,
  type CharacterOrganizationPromptPort,
  type ChronicleCostPort,
  type ChroniclePromptPort,
  type GenerationCostPort,
  type GenerationPromptPort,
  type IllustrationPromptPort,
  type InfiniteWorldsCostPort,
  type InfiniteWorldsPromptPort,
  type ProviderApplication,
  type ProviderCostPort,
  type ProviderHealthPort,
  type ProviderIllustrationCostPort,
  type ProviderResolutionPort,
  type PromptSnapshotVersion,
  type WorldGenerationCostPort,
  type WorldGenerationPromptPort
} from "../../../packages/application/src/providers/index.js";
import {
  createProviderCostRepository,
  createProviderCostTransactionContext
} from "../../../packages/database/src/cost-repository.js";
import type { DatabaseClient, DatabasePool } from "../../../packages/database/src/pool.js";
import { withTransaction } from "../../../packages/database/src/pool.js";
import { createPostgresProviderRepositories } from "../../../packages/database/src/provider-repository.js";
import { createPromptRepository } from "../../../packages/database/src/prompt-repository.js";
import type { ProviderTransport } from "../../../packages/story-engine/src/provider-transport.js";
import type { WorldContent } from "../../../packages/contracts/src/world-library.js";
import type { TemplateWorldInput } from "../../../packages/domain/src/world-template.js";
import {
  createRuntimeProviderAdapter,
  type RuntimeProviderAdapter,
  type RuntimeProviderExecutionPort
} from "./provider-credential-transport-adapter.js";
import type { SourceAuthoringModelInventory } from "./source-authoring-budget.js";
import type { ProviderModelInventoryPort } from "../../../packages/application/src/providers/ports.js";
import {
  generateTemplateWorld,
  worldGenerationFailureDiagnostic,
} from "./provider-world-generation-adapter.js";
import { createProviderResponseFormatCapabilities, type ProviderResponseFormatCapabilities } from "./provider-response-format-capabilities.js";
import type { SchemaVerification } from "@infinite-quest/contracts";

export type ProviderApplicationTransaction = Readonly<{
  application: ProviderApplication;
  runtime: RuntimeProviderAdapter;
}>;

export type ProviderPromptTools = Readonly<{
  content(
    snapshot: PromptSnapshotVersion["snapshot"] | Record<string, unknown> | undefined,
    key: keyof PromptSnapshotVersion["snapshot"],
  ): string;
  protocolVersion(snapshot: PromptSnapshotVersion["snapshot"]): string;
}>;

export type ProviderConsumerRuntime = Readonly<{
  execution: RuntimeProviderExecutionPort;
  resolution: ProviderResolutionPort;
  health: ProviderHealthPort;
  promptTools: ProviderPromptTools;
  costContext(client: DatabaseClient): Parameters<ProviderCostPort["recordCost"]>[0];
}>;

export type ApiGenerationProviderCollaborators = ProviderConsumerRuntime & Readonly<{
  prompts: GenerationPromptPort;
  costs: GenerationCostPort;
  reads: Pick<ProviderCostPort, "getTurnCosts">;
  /** Private runtime preflight collaborator; never projected to browser status. */
  responseFormatCapabilities: ProviderResponseFormatCapabilities;
  responseFormatInventory: ProviderModelInventoryPort;
  /** Uses the enqueue transaction's client; this never borrows a second pool connection. */
  loadQueuedTextProfile(client: DatabaseClient, ownerUserId: string, providerProfileId: string, model?: string): ReturnType<RuntimeProviderExecutionPort["text"]>;
}>;

export type WorkerGenerationProviderCollaborators = ApiGenerationProviderCollaborators & Readonly<{
  attributeCosts: Pick<ProviderCostPort, "attributeGenerationCostsToTurn">;
}>;

export type IllustrationProviderCollaborators = ProviderConsumerRuntime & Readonly<{
  prompts: IllustrationPromptPort;
  costs: ProviderIllustrationCostPort;
}>;

export type ChronicleProviderCollaborators = ProviderConsumerRuntime & Readonly<{
  prompts: ChroniclePromptPort;
  costs: ChronicleCostPort;
}>;

export type WorldGenerationProviderCollaborators = ProviderConsumerRuntime & Readonly<{
  prompts: WorldGenerationPromptPort;
  costs: WorldGenerationCostPort;
}>;

export type AuthoringWorkerProviderCollaborators = Readonly<{
  execution: RuntimeProviderExecutionPort;
  inventory: SourceAuthoringModelInventory;
  resolution: Pick<ProviderResolutionPort, "resolveDirect">;
  prompts: WorldGenerationPromptPort;
  promptTools: ProviderPromptTools;
}>;

export type CharacterOrganizationProviderCollaborators = ProviderConsumerRuntime & Readonly<{
  prompts: CharacterOrganizationPromptPort;
  costs: CharacterOrganizationCostPort;
}>;

export type InfiniteWorldsProviderCollaborators = ProviderConsumerRuntime & Readonly<{
  prompts: InfiniteWorldsPromptPort;
  costs: InfiniteWorldsCostPort;
  generateCyoaWorld(command: Readonly<{
    ownerUserId: string;
    providerProfileId: string;
    input: TemplateWorldInput;
    worldId: string;
    model?: string;
    onProgress?: (phase: string, percent: number, message: string) => Promise<void> | void;
  }>): Promise<Readonly<{ title: string; content: WorldContent }>>;
  diagnoseWorldGenerationFailure: typeof worldGenerationFailureDiagnostic;
}>;

export type ApiProviderApplicationComposition = Readonly<{
  role: "api";
  application: ProviderApplication;
  runtime: RuntimeProviderAdapter;
  responseFormatCapabilities: ProviderResponseFormatCapabilities;
  generation: ApiGenerationProviderCollaborators;
  illustration: IllustrationProviderCollaborators;
  chronicle: ChronicleProviderCollaborators;
  worldGeneration: WorldGenerationProviderCollaborators;
  characterOrganization: CharacterOrganizationProviderCollaborators;
  infiniteWorlds: InfiniteWorldsProviderCollaborators;
  transaction<T>(work: (binding: ProviderApplicationTransaction, client: DatabaseClient) => Promise<T>): Promise<T>;
}>;

export type WorkerProviderApplicationComposition = Readonly<{
  role: "worker";
  responseFormatCapabilities: ProviderResponseFormatCapabilities;
  generation: WorkerGenerationProviderCollaborators;
  illustration: IllustrationProviderCollaborators;
  chronicle: ChronicleProviderCollaborators;
  worldGeneration: AuthoringWorkerProviderCollaborators;
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

export function providerPromptProtocolVersion(snapshot: PromptSnapshotVersion["snapshot"]): string {
  const keys: readonly (keyof PromptSnapshotVersion["snapshot"])[] = [
    "story_system", "story_recovery_output_limit", "story_recovery_mechanics", "story_recovery_schema",
    "rpg_assessment", "event_trigger", "event_extension", "turn_intent", "scene_coverage", "scene_coverage_rewrite"
  ];
  const identity = keys.map((key) => `${key}:${promptContent(snapshot, key)}`).join("\n");
  return `prompt-library-v1-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}

function createInternals(
  pool: DatabasePool,
  options: Readonly<{ credentialSecret: string; transport: ProviderTransport; schemaVerifications?: readonly SchemaVerification[]; schemaVerificationDigest?: string; clock?: () => number }>,
) {
  const responseFormatCapabilities = createProviderResponseFormatCapabilities({
    ...(options.schemaVerifications ? { records: options.schemaVerifications } : {}),
    ...(options.schemaVerificationDigest ? { registryDigest: options.schemaVerificationDigest } : {}),
    ...(options.clock ? { now: options.clock } : {})
  });
  function bind(
    database: DatabaseClient | DatabasePool,
    capabilities = responseFormatCapabilities,
    onProfileMutation?: (providerProfileId: string) => void
  ): ProviderApplicationTransaction {
    const client = database as DatabaseClient;
    const providerRepositories = createPostgresProviderRepositories(client);
    const prompts = createPromptRepository(client);
    const costs = createProviderCostRepository(database);
    const runtime = createRuntimeProviderAdapter({
      database: client,
      credentialSecret: options.credentialSecret,
      transport: options.transport,
      health: providerRepositories.health,
      responseFormatCapabilities: capabilities
    });
    const rawApplication = createProviderApplication({
      profiles: providerRepositories.profiles,
      inventory: runtime.inventory,
      health: providerRepositories.health,
      resolution: providerRepositories.resolution,
      prompts,
      costs
    });
    const application = Object.freeze({
      ...rawApplication,
      updateProfile: async (command: Parameters<ProviderApplication["updateProfile"]>[0]) => {
        const result = await rawApplication.updateProfile(command);
        capabilities.invalidate(command.providerProfileId);
        onProfileMutation?.(command.providerProfileId);
        return result;
      },
      deleteProfile: async (command: Parameters<ProviderApplication["deleteProfile"]>[0]) => {
        const result = await rawApplication.deleteProfile(command);
        capabilities.invalidate(command.providerProfileId);
        onProfileMutation?.(command.providerProfileId);
        return result;
      }
    });
    return {
      runtime,
      application
    };
  }

  const base = bind(pool);
  async function runProfileMutation<T>(
    providerProfileId: string,
    work: (binding: ProviderApplicationTransaction) => Promise<T>
  ): Promise<T> {
    const transactionCapabilities = responseFormatCapabilities.transactionLocal();
    const result = await withTransaction(pool, async (client) => work(bind(client, transactionCapabilities)));
    responseFormatCapabilities.invalidate(providerProfileId);
    return result;
  }
  const application: ProviderApplication = Object.freeze({
    ...base.application,
    createProfile: (command: Parameters<ProviderApplication["createProfile"]>[0]) =>
      withTransaction(pool, async (client) => bind(client).application.createProfile(command)),
    updateProfile: (command: Parameters<ProviderApplication["updateProfile"]>[0]) =>
      runProfileMutation(command.providerProfileId, (binding) => binding.application.updateProfile(command)),
    deleteProfile: (command: Parameters<ProviderApplication["deleteProfile"]>[0]) =>
      runProfileMutation(command.providerProfileId, (binding) => binding.application.deleteProfile(command)),
    setDefaultProfile: (command: Parameters<ProviderApplication["setDefaultProfile"]>[0]) =>
      withTransaction(pool, async (client) => bind(client).application.setDefaultProfile(command)),
    savePromptOverride: (command: Parameters<ProviderApplication["savePromptOverride"]>[0]) =>
      withTransaction(pool, async (client) => bind(client).application.savePromptOverride(command)),
    resetPromptOverride: (command: Parameters<ProviderApplication["resetPromptOverride"]>[0]) =>
      withTransaction(pool, async (client) => bind(client).application.resetPromptOverride(command))
  });
  const costs = createProviderCostRepository(pool);
  const promptTools: ProviderPromptTools = Object.freeze({
    content: promptContent,
    protocolVersion: providerPromptProtocolVersion
  });
  const runtime: ProviderConsumerRuntime = Object.freeze({
    execution: base.runtime.execution,
    resolution: application,
    health: application,
    promptTools,
    costContext: createProviderCostTransactionContext
  });
  const campaignPrompts = (ownerUserId: string, campaignId: string) => application.loadPromptSnapshot({
    ownerUserId,
    scope: "campaign",
    campaignId
  });
  const applicationPrompts = (ownerUserId: string) => application.loadPromptSnapshot({
    ownerUserId,
    scope: "application"
  });
  const generationPrompts: GenerationPromptPort = {
    loadGenerationPromptSnapshot: ({ ownerUserId, campaignId }) => campaignPrompts(ownerUserId, campaignId)
  };
  const illustrationPrompts: IllustrationPromptPort = {
    loadIllustrationPromptSnapshot: ({ ownerUserId, campaignId }) => campaignPrompts(ownerUserId, campaignId)
  };
  const chroniclePrompts: ChroniclePromptPort = {
    loadChroniclePromptSnapshot: ({ ownerUserId, campaignId }) => campaignPrompts(ownerUserId, campaignId)
  };
  const worldPrompts: WorldGenerationPromptPort = {
    loadWorldGenerationPromptSnapshot: ({ ownerUserId }) => applicationPrompts(ownerUserId)
  };
  const characterPrompts: CharacterOrganizationPromptPort = {
    loadCharacterOrganizationPromptSnapshot: ({ ownerUserId }) => applicationPrompts(ownerUserId)
  };
  const infiniteWorldsPrompts: InfiniteWorldsPromptPort = {
    loadInfiniteWorldsPromptSnapshot: ({ ownerUserId }) => applicationPrompts(ownerUserId)
  };
  const generationCosts: GenerationCostPort = {
    recordGenerationCost: (database, command) => costs.recordCost(database, command)
  };
  const illustrationCosts: ProviderIllustrationCostPort = {
    recordIllustrationCost: (database, command) => costs.recordCost(database, command)
  };
  const chronicleCosts: ChronicleCostPort = {
    recordChronicleCost: (database, command) => costs.recordCost(database, command)
  };
  const worldCosts: WorldGenerationCostPort = {
    recordWorldGenerationCost: (database, command) => costs.recordCost(database, command)
  };
  const characterCosts: CharacterOrganizationCostPort = {
    recordCharacterOrganizationCost: (database, command) => costs.recordCost(database, command)
  };
  const infiniteWorldsCosts: InfiniteWorldsCostPort = {
    recordInfiniteWorldsCost: (database, command) => costs.recordCost(database, command)
  };

  const worldGeneration = Object.freeze({ ...runtime, prompts: worldPrompts, costs: worldCosts });
  const infiniteWorlds = Object.freeze({
    ...runtime,
    prompts: infiniteWorldsPrompts,
    costs: infiniteWorldsCosts,
    generateCyoaWorld: (command: Parameters<InfiniteWorldsProviderCollaborators["generateCyoaWorld"]>[0]) =>
      generateTemplateWorld(
        pool,
        command.ownerUserId,
        command.providerProfileId,
        command.input,
        worldGeneration,
        command.worldId,
        command.model,
        command.onProgress,
      ),
    diagnoseWorldGenerationFailure: worldGenerationFailureDiagnostic,
  });

  return {
    application,
    runtimeAdapter: base.runtime,
    responseFormatCapabilities,
    transaction: async <T>(work: (binding: ProviderApplicationTransaction, client: DatabaseClient) => Promise<T>) => {
      const invalidatedProfileIds = new Set<string>();
      const transactionCapabilities = responseFormatCapabilities.transactionLocal();
      const result = await withTransaction(pool, async (client) => work(
        bind(client, transactionCapabilities, (providerProfileId) => invalidatedProfileIds.add(providerProfileId)),
        client
      ));
      for (const providerProfileId of invalidatedProfileIds) responseFormatCapabilities.invalidate(providerProfileId);
      return result;
    },
    generation: Object.freeze({ ...runtime, prompts: generationPrompts, costs: generationCosts, reads: costs, responseFormatCapabilities, responseFormatInventory: base.runtime.inventory,
      loadQueuedTextProfile: (client: DatabaseClient, ownerUserId: string, providerProfileId: string, model?: string) =>
        bind(client).runtime.execution.text({ ownerUserId }, providerProfileId, "text", model) }),
    workerGeneration: Object.freeze({
      ...runtime,
      prompts: generationPrompts,
      costs: generationCosts,
      reads: costs,
      attributeCosts: costs,
      responseFormatCapabilities,
      responseFormatInventory: base.runtime.inventory,
      loadQueuedTextProfile: (client: DatabaseClient, ownerUserId: string, providerProfileId: string, model?: string) =>
        bind(client).runtime.execution.text({ ownerUserId }, providerProfileId, "text", model)
    }),
    illustration: Object.freeze({ ...runtime, prompts: illustrationPrompts, costs: illustrationCosts }),
    chronicle: Object.freeze({ ...runtime, prompts: chroniclePrompts, costs: chronicleCosts }),
    worldGeneration,
    characterOrganization: Object.freeze({ ...runtime, prompts: characterPrompts, costs: characterCosts }),
    infiniteWorlds,
  };
}

export function createApiProviderApplicationComposition(
  pool: DatabasePool,
  options: Readonly<{ credentialSecret: string; transport: ProviderTransport; schemaVerifications?: readonly SchemaVerification[]; schemaVerificationDigest?: string; clock?: () => number }>,
): ApiProviderApplicationComposition {
  const graph = createInternals(pool, options);
  return Object.freeze({
    role: "api",
    application: graph.application,
    runtime: graph.runtimeAdapter,
    responseFormatCapabilities: graph.responseFormatCapabilities,
    generation: graph.generation,
    illustration: graph.illustration,
    chronicle: graph.chronicle,
    worldGeneration: graph.worldGeneration,
    characterOrganization: graph.characterOrganization,
    infiniteWorlds: graph.infiniteWorlds,
    transaction: graph.transaction
  });
}

export function createWorkerProviderApplicationComposition(
  pool: DatabasePool,
  options: Readonly<{ credentialSecret: string; transport: ProviderTransport; schemaVerifications?: readonly SchemaVerification[]; schemaVerificationDigest?: string; clock?: () => number }>,
): WorkerProviderApplicationComposition {
  const graph = createInternals(pool, options);
  return Object.freeze({
    role: "worker",
    responseFormatCapabilities: graph.responseFormatCapabilities,
    generation: graph.workerGeneration,
    illustration: graph.illustration,
    chronicle: graph.chronicle,
    worldGeneration: Object.freeze({
      execution: graph.worldGeneration.execution,
      inventory: graph.runtimeAdapter.inventory,
      resolution: Object.freeze({ resolveDirect: graph.worldGeneration.resolution.resolveDirect }),
      prompts: graph.worldGeneration.prompts,
      promptTools: graph.worldGeneration.promptTools
    })
  });
}
