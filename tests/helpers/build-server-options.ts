import { randomUUID } from "node:crypto";
import type { BuildServerOptions } from "../../services/api/src/server.js";
import type {
  GenerationEventSource,
  WorldCampaignApplication
} from "../../packages/application/src/index.js";
import { createApiGenerationApplication } from "../../services/runtime/src/generation-api-composition.js";
import { createApiIllustrationApplication } from "../../services/runtime/src/illustration-composition.js";
import { createApiMemoryApplication } from "../../services/runtime/src/memory-composition.js";
import type { ProviderApiTransportAdapter } from "../../services/api/src/provider-application-adapter.js";
import { apiProviderGraph } from "./provider-application-fixtures.js";
import { createAssetApplication } from "../../packages/application/src/assets/index.js";
import type { PortableImportExportComposition } from "../../packages/application/src/imports/private-portable-composition.js";
import { createPostgresAssetRepositories } from "../../packages/database/src/asset-repository.js";
import type { DatabasePool } from "../../packages/database/src/pool.js";
import type { ApiAssetComposition } from "../../services/runtime/src/api-asset-composition.js";
import type {
  ApiPortableImportExportComposition,
  ApiPortableImportExportCompositionOptions,
} from "../../services/runtime/src/api-portable-import-export-composition.js";
import { createApiPortableImportExportComposition } from "../../services/runtime/src/api-portable-import-export-composition.js";
import { supportsSecureGeneratedArchiveStaging } from "../../services/api/src/archive-io.js";
import {
  toPortableImportedRecordId,
  toPortableImportResultRetrieval,
  toPortablePreviewHandle,
  toPortableStagedInput,
  type PortableImportPreviewCommand,
} from "../../packages/application/src/imports/types.js";
import type { StoryImportRequest } from "../../packages/contracts/src/imports.js";
import {
  importLegacyStory,
  previewLegacyStoryImport,
} from "../legacy-api/src/import-service.js";

export type ServerOptionsOverrides = Readonly<
  Pick<BuildServerOptions, "config" | "pool"> &
  Partial<Pick<BuildServerOptions, "generation" | "illustration" | "memory" | "generationEvents" | "worldCampaign" | "providers" | "infiniteWorldsProviders" | "createApiAssets" | "createApiPortable">>
>;

async function unexpectedPortableCall(): Promise<never> {
  throw new Error("Unexpected test portable composition call.");
}

async function createTestApiAssets(pool: DatabasePool): Promise<ApiAssetComposition> {
  return {
    assets: createAssetApplication(createPostgresAssetRepositories(pool)),
    storage: {
      adapter: { openAssetSession: unexpectedPortableCall },
    } as unknown as ApiAssetComposition["storage"],
    close: async () => undefined,
  };
}

async function createTestApiPortable(
  _options: ApiPortableImportExportCompositionOptions,
): Promise<ApiPortableImportExportComposition> {
  const portable = {
    async stageInput(input: { source: AsyncIterable<Uint8Array> | Iterable<Uint8Array> }) {
      for await (const _chunk of input.source) {
        // Consume the transport-owned upload while leaving storage behavior out
        // of API route tests that do not exercise the Linux filesystem adapter.
      }
      return { stagedInput: "test-staged-input" };
    },
    async previewCampaignZip() {
      throw new Error("archive_format_invalid");
    },
    previewLegacyStory: unexpectedPortableCall,
    previewInfiniteWorlds: unexpectedPortableCall,
    previewCyoa: unexpectedPortableCall,
    previewWorldJson: unexpectedPortableCall,
    previewWorldText: unexpectedPortableCall,
    previewStoryText: unexpectedPortableCall,
    commit: unexpectedPortableCall,
    createCampaignExport: unexpectedPortableCall,
    createWorldExport: unexpectedPortableCall,
    openExportSession: unexpectedPortableCall,
    progress: unexpectedPortableCall,
    abort: unexpectedPortableCall,
    reap: unexpectedPortableCall,
    close: async () => undefined,
  } as unknown as PortableImportExportComposition;
  return {
    portable,
    progress: {
      create: unexpectedPortableCall,
      update: unexpectedPortableCall,
      read: unexpectedPortableCall,
    } as unknown as ApiPortableImportExportComposition["progress"],
    close: async () => undefined,
  };
}

async function createLegacyStoryTestApiPortable(
  options: ApiPortableImportExportCompositionOptions,
): Promise<ApiPortableImportExportComposition> {
  const stagedInputs = new Map<string, Uint8Array>();
  const previews = new Map<string, StoryImportRequest>();
  const portable = {
    async stageInput(input: { source: AsyncIterable<Uint8Array> | Iterable<Uint8Array> }) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of input.source) chunks.push(chunk);
      const handle = `test-staged-${randomUUID()}`;
      stagedInputs.set(handle, Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
      return { stagedInput: toPortableStagedInput(handle) };
    },
    async previewLegacyStory(command: Extract<PortableImportPreviewCommand, { kind: "legacy_story" }>) {
      const bytes = stagedInputs.get(command.stagedInput);
      if (bytes === undefined) throw new Error("test_staged_input_missing");
      const request: StoryImportRequest = {
        sourceName: command.sourceName ?? "test-legacy-story.json",
        story: JSON.parse(new TextDecoder().decode(bytes)),
        ...(command.destination.kind === "existing_world_version"
          ? { targetWorldVersionId: command.destination.worldVersionId }
          : {}),
        ...(command.selectedCharacterId === undefined ? {} : { selectedCharacterId: command.selectedCharacterId }),
        ...(command.characterStrategy === undefined ? {} : { characterStrategy: command.characterStrategy }),
      };
      const token = `test-preview-${randomUUID()}`;
      previews.set(token, request);
      return {
        previewHandle: toPortablePreviewHandle(token, command.destination),
        kind: "legacy_story" as const,
        destination: command.destination,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        cleanupOwner: "application" as const,
        diagnostics: [],
        projection: await previewLegacyStoryImport(options.pool, request),
      };
    },
    async commit(command: { kind: string; previewHandle: { token: string } }) {
      if (command.kind !== "legacy_story") throw new Error("Unexpected test portable composition call.");
      const request = previews.get(command.previewHandle.token);
      if (request === undefined) throw new Error("test_preview_handle_missing");
      const result = await importLegacyStory(options.pool, request, options.memory);
      return {
        importedRecordId: toPortableImportedRecordId(result.importId),
        retrieval: toPortableImportResultRetrieval<"legacy_story">(`test-result-${randomUUID()}`),
        kind: "legacy_story" as const,
        duplicate: result.duplicate,
        diagnostics: [],
        result,
      };
    },
    previewCampaignZip: unexpectedPortableCall,
    previewInfiniteWorlds: unexpectedPortableCall,
    previewCyoa: unexpectedPortableCall,
    previewWorldJson: unexpectedPortableCall,
    previewWorldText: unexpectedPortableCall,
    previewStoryText: unexpectedPortableCall,
    createCampaignExport: unexpectedPortableCall,
    createWorldExport: unexpectedPortableCall,
    openExportSession: unexpectedPortableCall,
    progress: unexpectedPortableCall,
    abort: unexpectedPortableCall,
    reap: unexpectedPortableCall,
    close: async () => undefined,
  } as unknown as PortableImportExportComposition;
  if (supportsSecureGeneratedArchiveStaging()) {
    const production = await createApiPortableImportExportComposition(options);
    return {
      portable: {
        ...production.portable,
        stageInput: portable.stageInput,
        previewLegacyStory: portable.previewLegacyStory,
        commit: portable.commit,
      } as PortableImportExportComposition,
      progress: production.progress,
      close: production.close,
    };
  }
  return {
    portable,
    progress: {
      create: unexpectedPortableCall,
      update: unexpectedPortableCall,
      read: unexpectedPortableCall,
    } as unknown as ApiPortableImportExportComposition["progress"],
    close: async () => undefined,
  };
}

export const inertProviders = {
  application: {
    getTurnCosts: async () => new Map(),
    getCampaignCostSummary: async (scope: { campaignId: string }) => ({
      campaignId: scope.campaignId,
      hasReportedCosts: false,
      totals: []
    }),
    classifyTurnIntent: async () => ({
      classificationId: "88888888-8888-4888-8888-888888888888",
      classification: "action",
      resolvedMode: "action",
      confidenceBand: "ambiguous",
      providerSource: "campaign_fallback",
      expiresAt: "2026-08-01T12:00:00.000Z"
    })
  },
  list: async () => [{
    id: "66666666-6666-4666-8666-666666666666",
    name: "Test provider",
    providerType: "openai_compatible",
    providerRole: "text"
  }],
  listPromptLibrary: async (_ownerUserId: string, campaignId?: string) => ({
    catalogVersion: "prompt-library-v1",
    campaignId: campaignId ?? null,
    templates: []
  })
} as unknown as ProviderApiTransportAdapter;

const inertGenerationEvents: GenerationEventSource = {
  async subscribe() {
    let resolvePending: ((result: IteratorResult<never>) => void) | undefined;
    let closed = false;
    return {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            if (closed) return { done: true as const, value: undefined };
            return new Promise<IteratorResult<never>>((resolve) => { resolvePending = resolve; });
          }
        };
      },
      async close() {
        if (closed) return;
        closed = true;
        resolvePending?.({ done: true, value: undefined });
      }
    };
  }
};

const TEST_CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";
const TEST_WORLD_ID = "22222222-2222-4222-8222-222222222222";
const TEST_WORLD_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const TEST_TURN_ID = "55555555-5555-4555-8555-555555555555";
const TEST_BRANCH_ID = "77777777-7777-4777-8777-777777777777";
const TEST_TIMESTAMP = "2026-08-01T12:00:00.000Z";
const TEST_RUNTIME_STATE = {
  continuitySummary: "The observatory is awake.",
  openThreads: ["Read the constellations."],
  canonicalFacts: [],
  scratchpad: "Keep the dome open.",
  trackers: [],
  rpgStats: [],
  eventTriggers: [],
  pendingEventTriggers: []
};

export function testWorldCampaignApplication(
  overrides: Partial<WorldCampaignApplication> = {},
): WorldCampaignApplication {
  const profiles = new Map<string, {
    id: string;
    systemKey: string;
    displayName: string;
    settings: Record<string, unknown>;
  }>();
  const profile = (ownerUserId: string) => {
    const existing = profiles.get(ownerUserId);
    if (existing) return existing;
    const created = {
      id: ownerUserId,
      systemKey: "initial-owner",
      displayName: "Initial Owner",
      settings: { autoSubmitTurnChoices: true, continuousReading: false }
    };
    profiles.set(ownerUserId, created);
    return created;
  };
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected test WorldCampaignApplication call.");
  };
  const base = {
    listWorlds: async () => ({ worlds: [{
      id: TEST_WORLD_ID,
      title: "Emerald Skies",
      status: "active",
      imageUrl: "",
      forkedFromWorldId: null,
      forkedFromWorldVersionId: null,
      createdAt: TEST_TIMESTAMP,
      updatedAt: TEST_TIMESTAMP,
      draftRevision: 1,
      draftUpdatedAt: TEST_TIMESTAMP,
      draftPreview: {
        title: "Emerald Skies",
        genre: "Fantasy",
        tone: "Mysterious",
        premise: "Stars wake.",
        backgroundStory: "Stars slept.",
        firstAction: "Open the dome."
      },
      latestVersionId: TEST_WORLD_VERSION_ID,
      latestVersionNumber: 1,
      latestPublishedAt: TEST_TIMESTAMP,
      latestPreview: {
        title: "Emerald Skies",
        genre: "Fantasy",
        tone: "Mysterious",
        premise: "Stars wake.",
        backgroundStory: "Stars slept.",
        firstAction: "Open the dome.",
        rules: "Stay curious."
      },
      campaignCount: 1
    }] }),
    listCampaigns: async () => ({ campaigns: [{
      id: TEST_CAMPAIGN_ID,
      title: "The Observatory",
      status: "active",
      activeTurnNumber: 2,
      createdAt: TEST_TIMESTAMP,
      updatedAt: TEST_TIMESTAMP,
      storyLengthProfile: "standard",
      turnControlStyle: "flexible_auto",
      selectedCharacterId: "observer",
      selectedCharacterName: "The Observer",
      worldId: TEST_WORLD_ID,
      worldTitle: "Emerald Skies",
      worldVersionId: TEST_WORLD_VERSION_ID,
      textProviderProfileId: null,
      imageProviderProfileId: null,
      worldVersionNumber: 1,
      latestWorldVersionNumber: 1,
      worldUpdateAvailable: false,
      costInformation: []
    }] }),
    getSessionProfile: async (scope: { ownerUserId: string }) => profile(scope.ownerUserId),
    updateSessionProfile: async (scope: { ownerUserId: string }, request: {
      displayName?: string;
      settings?: Record<string, unknown>;
    }) => {
      const current = profile(scope.ownerUserId);
      const updated = {
        ...current,
        ...(request.displayName === undefined ? {} : { displayName: request.displayName }),
        settings: { ...current.settings, ...request.settings }
      };
      profiles.set(scope.ownerUserId, updated);
      return updated;
    },
    getCampaignRuntimeState: async (scope: { campaignId: string }, requestedTurnNumber?: number) => ({
      campaignId: scope.campaignId,
      activeTurnNumber: 2,
      viewedTurnNumber: requestedTurnNumber ?? 2,
      isCurrent: requestedTurnNumber === undefined || requestedTurnNumber === 2,
      revision: 1,
      updatedAt: TEST_TIMESTAMP,
      ...TEST_RUNTIME_STATE
    }),
    updateCampaignRuntimeState: async (scope: { campaignId: string }, request: typeof TEST_RUNTIME_STATE) => ({
      campaignId: scope.campaignId,
      activeTurnNumber: 2,
      viewedTurnNumber: 2,
      isCurrent: true,
      revision: 1,
      updatedAt: TEST_TIMESTAMP,
      ...request
    }),
    loadEffectiveCampaignStateEdit: async () => ({
      id: "99999999-9999-4999-8999-999999999999",
      revision: 1,
      effectiveTurnNumber: 2,
      snapshot: TEST_RUNTIME_STATE,
      updatedAt: TEST_TIMESTAMP
    }),
    rewindCampaign: async (scope: { campaignId: string }, request: { targetTurnNumber: number }) => ({
      campaignId: scope.campaignId,
      activeTurnNumber: request.targetTurnNumber,
      discardedTurnCount: Math.max(0, 2 - request.targetTurnNumber),
      stateSnapshot: TEST_RUNTIME_STATE
    }),
    branchCampaign: async (_scope: unknown, request: { targetTurnNumber: number; title?: string }) => ({
      id: TEST_BRANCH_ID,
      title: request.title || "The Observatory Branch",
      activeTurnNumber: request.targetTurnNumber,
      worldVersionId: TEST_WORLD_VERSION_ID
    }),
    createWorld: async (_scope: unknown, request: { title: string }) => ({
      id: TEST_WORLD_ID,
      title: request.title,
      status: "draft",
      imageUrl: "",
      draftRevision: 1,
      draftContent: { world: { title: request.title } },
      draftBasedOnWorldVersionId: null,
      createdAt: TEST_TIMESTAMP,
      updatedAt: TEST_TIMESTAMP
    }),
    createCampaign: async (_scope: unknown, request: {
      title: string;
      worldVersionId: string;
      selectedCharacterId?: string;
      storyLengthProfile: "brief" | "standard" | "long" | "extended";
      turnControlStyle: "action_only" | "flexible_auto" | "flexible_action" | "flexible_scene";
    }) => ({
      id: TEST_CAMPAIGN_ID,
      title: request.title,
      status: "active",
      activeTurnNumber: 0,
      storyLengthProfile: request.storyLengthProfile,
      turnControlStyle: request.turnControlStyle,
      worldId: TEST_WORLD_ID,
      worldVersionId: request.worldVersionId,
      worldVersionNumber: 1,
      selectedCharacterId: request.selectedCharacterId || "observer",
      selectedCharacterName: "The Observer",
      textProviderProfileId: null,
      imageProviderProfileId: null
    }),
    getWorldVersionPlayableCharacterSummary: async () => ({
      characters: [{ id: "observer", name: "The Observer", rpgStatCount: 0, defaultTriggerCount: 0 }],
      readiness: { ready: true, issues: [] }
    }),
    getCampaignSyncStatus: async (scope: { campaignId: string }, request: { since?: string }) => {
      const projection = {
        id: scope.campaignId,
        title: "The Observatory",
        activeTurnNumber: 2,
        worldVersionId: TEST_WORLD_VERSION_ID,
        storyLengthProfile: "standard",
        turnControlStyle: "flexible_auto",
        updatedAt: TEST_TIMESTAMP,
        selectedCharacterId: "observer",
        selectedCharacterName: "The Observer",
        characterSnapshot: { name: "The Observer", characterText: "A patient observer." },
        characterProfile: null,
        characterProfileRevision: 0,
        status: "active",
        campaign: {
          id: scope.campaignId,
          title: "The Observatory",
          activeTurnNumber: 2,
          worldVersionId: TEST_WORLD_VERSION_ID,
          storyLengthProfile: "standard",
          turnControlStyle: "flexible_auto",
          updatedAt: TEST_TIMESTAMP,
          selectedCharacterId: "observer",
          selectedCharacterName: "The Observer",
          characterSnapshot: { name: "The Observer", characterText: "A patient observer." },
          characterProfile: null,
          characterProfileRevision: 0,
          status: "active"
        },
        world: {
          id: TEST_WORLD_ID,
          title: "Emerald Skies",
          versionNumber: 1,
          genre: "Fantasy",
          tone: "Mysterious",
          premise: "Stars wake.",
          backgroundStory: "Stars slept.",
          character: "",
          firstAction: "Open the dome.",
          rules: "Stay curious.",
          playableCharacters: []
        },
        playerConfig: {
          selectedCharacterId: "observer",
          selectedCharacterName: "The Observer",
          characterSnapshot: { name: "The Observer", characterText: "A patient observer." },
          characterProfile: null,
          characterProfileRevision: 0,
          rpgStats: [],
          trackers: [],
          eventTriggers: [],
          useRpgStats: false,
          suppressEventTriggers: false
        },
        pendingGeneration: null,
        generationRecovery: {
          id: "99999999-9999-4999-8999-999999999999",
          status: "completed",
          operationKind: "replace_latest",
          expectedTurnNumber: 2,
          attempts: 1,
          errorCode: null,
          errorMessage: null,
          resultTurnId: null,
          replacementTurnId: TEST_TURN_ID
        },
        syncToken: "test-sync-token"
      };
      return request.since === projection.syncToken
        ? { ...projection, turnWindowMode: "unchanged", turns: null }
        : {
          ...projection,
          turnWindowMode: "replace",
          turns: { campaignId: scope.campaignId, turns: [], nextCursor: null }
        };
    },
    getDashboard: async () => ({
      worlds: { available: 1, total: 1, published: 1, drafts: 0, archived: 0 },
      campaigns: { open: 1, total: 1, archived: 0 },
      turns: { accepted: 0 },
      providerCosts: { hasReportedCosts: false, totals: [] }
    }),
    getWorldGenerationProgress: async () => null,
    deleteExpiredWorldGenerationProgress: async () => 0,
    getWorld: unexpected,
    updateWorldDraft: unexpected,
    publishWorld: unexpected,
    updateWorldStatus: unexpected,
    forkWorld: unexpected,
    exportWorld: unexpected,
    previewWorldImport: unexpected,
    importWorld: unexpected,
    deleteWorld: unexpected,
    deleteWorldVersion: unexpected,
    promoteCampaignDiscoveries: unexpected,
    updateCampaign: unexpected,
    deleteCampaign: unexpected,
    listWorldVersionPlayableCharacters: unexpected,
    migrateCampaignWorldVersion: unexpected,
    syncPlayerCampaignConfig: unexpected,
    getCampaignCharacterProfile: unexpected,
    updateCampaignCharacterProfile: unexpected,
    organizeCampaignCharacterProfile: unexpected,
    organizeWorldCharacterProfile: unexpected,
    previewCampaignWorldTransfer: unexpected,
    transferCampaignWorld: unexpected,
    generateWorldPreview: unexpected,
    generatePlayableCharacterPreview: unexpected,
    generatePlayableCharacter: unexpected,
    createWorldGenerationProgress: unexpected,
    updateWorldGenerationProgress: unexpected,
    ...overrides
  };
  return base as unknown as WorldCampaignApplication;
}

export function serverOptions(overrides: ServerOptionsOverrides): BuildServerOptions {
  const providerGraph = apiProviderGraph(overrides.pool, overrides.config.credentialEncryptionKey);
  return {
    ...overrides,
    generation: overrides.generation ?? createApiGenerationApplication(overrides.pool, providerGraph.generation),
    illustration: overrides.illustration ?? createApiIllustrationApplication(overrides.pool, providerGraph.illustration),
    memory: overrides.memory ?? createApiMemoryApplication(overrides.pool, providerGraph.chronicle),
    worldCampaign: overrides.worldCampaign ?? testWorldCampaignApplication(),
    providers: overrides.providers ?? inertProviders,
    infiniteWorldsProviders: overrides.infiniteWorldsProviders ?? providerGraph.infiniteWorlds,
    generationEvents: overrides.generationEvents ?? inertGenerationEvents,
    ...(overrides.createApiAssets === undefined ? {} : { createApiAssets: overrides.createApiAssets }),
    ...(overrides.createApiPortable === undefined ? {} : { createApiPortable: overrides.createApiPortable }),
  };
}

export function inertStorageServerOptions(overrides: ServerOptionsOverrides): BuildServerOptions {
  return serverOptions({
    ...overrides,
    createApiAssets: overrides.createApiAssets ?? createTestApiAssets,
    createApiPortable: overrides.createApiPortable ?? createTestApiPortable,
  });
}

export function legacyStoryImportServerOptions(overrides: ServerOptionsOverrides): BuildServerOptions {
  return serverOptions({
    ...overrides,
    createApiAssets: overrides.createApiAssets ?? createTestApiAssets,
    createApiPortable: overrides.createApiPortable ?? createLegacyStoryTestApiPortable,
  });
}
