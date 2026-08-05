import { describe, expect, expectTypeOf, test } from "vitest";
import {
  WorldCampaignApplicationError,
  appendCampaignFact,
  createWorldCampaignApplication,
  mapWorldCampaignTransitionFailure,
  planCampaignDiscoveryPromotion,
  planCampaignWorldVersionMigration,
  publishWorldDraft,
  replaceCampaignFact,
  type BoundedCampaignTurnPagePort,
  type CampaignScope,
  type CampaignListView,
  type CampaignStateEditView,
  type CampaignSyncStatusView,
  type CampaignTransferResultView,
  type CampaignTransferView,
  type CampaignUpdateView,
  type CharacterProfileView,
  type DashboardView,
  type GeneratedPlayableCharacterView,
  type GeneratedWorldPreviewView,
  type OwnerScope,
  type PlayableCharacterSummaryView,
  type WorldAggregateView,
  type WorldCampaignApplication,
  type WorldCampaignApplicationDependencies,
  type WorldCampaignTransactionPort,
  type WorldListView
} from "../../../packages/application/src/index.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const worldId = "22222222-2222-4222-8222-222222222222";
const campaignId = "33333333-3333-4333-8333-333333333333";
const currentVersionId = "44444444-4444-4444-8444-444444444444";
const targetVersionId = "55555555-5555-4555-8555-555555555555";

describe("world and campaign application use cases", () => {
  test("publishes an immutable version snapshot without changing the draft", () => {
    const draftContent = { premise: "A glass observatory", lore: { factions: ["Keepers"] } };
    const draft = {
      ownerUserId,
      worldId,
      draftRevision: 3,
      content: draftContent,
      publishedVersions: []
    };

    const result = publishWorldDraft(draft, {
      expectedDraftRevision: 3,
      versionId: currentVersionId,
      versionNumber: 1,
      publishedAt: "2026-08-05T10:00:00.000Z"
    });

    expect(result).toEqual({
      ok: true,
      value: {
        ownerUserId,
        worldId,
        worldVersionId: currentVersionId,
        versionNumber: 1,
        publishedAt: "2026-08-05T10:00:00.000Z",
        content: { premise: "A glass observatory", lore: { factions: ["Keepers"] } }
      }
    });
    expect(draft.publishedVersions).toEqual([]);
    expect(Object.isFrozen(result.ok ? result.value.content : {})).toBe(true);
    expect(Object.isFrozen(result.ok ? result.value.content.lore : {})).toBe(true);
    draftContent.lore.factions.push("Intruders");
    expect(result.ok ? result.value.content : null).toEqual({
      premise: "A glass observatory",
      lore: { factions: ["Keepers"] }
    });
  });

  test("requires explicit version migration and discovery promotion plans", () => {
    const campaign = {
      ownerUserId,
      campaignId,
      worldId,
      worldVersionId: currentVersionId,
      activeTurnNumber: 7,
      stateRevision: 4
    };

    expect(planCampaignWorldVersionMigration(campaign, {
      targetWorldId: worldId,
      targetWorldVersionId: targetVersionId,
      expectedWorldVersionId: currentVersionId,
      note: "Adopt the revised observatory canon"
    })).toEqual({
      ok: true,
      value: {
        ownerUserId,
        campaignId,
        sourceWorldVersionId: currentVersionId,
        targetWorldVersionId: targetVersionId,
        activeTurnNumber: 7,
        stateRevision: 4,
        note: "Adopt the revised observatory canon"
      }
    });

    expect(planCampaignWorldVersionMigration(campaign, {
      targetWorldId: worldId,
      targetWorldVersionId: currentVersionId,
      expectedWorldVersionId: currentVersionId,
      note: ""
    })).toEqual({
      ok: false,
      failure: { reason: "already_on_world_version", details: { worldVersionId: currentVersionId } }
    });

    expect(planCampaignDiscoveryPromotion(campaign, {
      draftWorldId: worldId,
      expectedWorldVersionId: currentVersionId,
      discoveryFactIds: ["fact-2", "fact-1", "fact-2"]
    })).toEqual({
      ok: true,
      value: {
        ownerUserId,
        campaignId,
        sourceWorldVersionId: currentVersionId,
        draftWorldId: worldId,
        discoveryFactIds: ["fact-2", "fact-1"]
      }
    });
    expect(campaign.worldVersionId).toBe(currentVersionId);
  });

  test("keeps campaign facts append-only when replacing an accepted fact", () => {
    const first = appendCampaignFact([], {
      id: "fact-1",
      campaignId,
      turnId: "turn-1",
      content: "The eastern gate is open."
    });
    expect(first.ok).toBe(true);
    const replaced = replaceCampaignFact(first.ok ? first.value : [], {
      id: "fact-2",
      campaignId,
      turnId: "turn-2",
      content: "The eastern gate is sealed.",
      replacesFactId: "fact-1"
    });

    expect(replaced).toEqual({
      ok: true,
      value: [
        {
          id: "fact-1",
          campaignId,
          turnId: "turn-1",
          content: "The eastern gate is open.",
          replacesFactId: null
        },
        {
          id: "fact-2",
          campaignId,
          turnId: "turn-2",
          content: "The eastern gate is sealed.",
          replacesFactId: "fact-1"
        }
      ]
    });
    expect(first.ok ? first.value : []).toHaveLength(1);
  });

  test("maps closed transition failures to typed application errors", () => {
    const mapped = mapWorldCampaignTransitionFailure({
      reason: "published_version_immutable",
      details: { worldVersionId: currentVersionId }
    });

    expect(mapped).toBeInstanceOf(WorldCampaignApplicationError);
    expect(mapped).toMatchObject({
      kind: "conflict",
      reason: "published_version_immutable",
      details: { worldVersionId: currentVersionId }
    });
  });

  test("uses explicit owner scope and the declared command/read transaction owners", async () => {
    const events: string[] = [];
    const transaction: WorldCampaignTransactionPort = {
      command: async (work) => {
        events.push("command");
        return work(Object.freeze({ kind: "command" }));
      },
      read: async (work) => {
        events.push("read");
        return work(Object.freeze({ kind: "read" }));
      }
    };
    const dependencies = minimalDependencies(transaction, {
      readTurnPage: async () => ({ turns: [], nextCursor: null })
    });
    const worldSummary = {
      id: worldId,
      title: "Glass Stars",
      status: "draft" as const,
      imageUrl: "",
      forkedFromWorldId: null,
      forkedFromWorldVersionId: null,
      createdAt: "2026-08-05T10:00:00.000Z",
      updatedAt: "2026-08-05T10:00:00.000Z",
      draftRevision: 1,
      draftUpdatedAt: "2026-08-05T10:00:00.000Z",
      draftPreview: {
        title: "Glass Stars",
        genre: "science fantasy",
        tone: "hopeful",
        premise: "A glass observatory",
        backgroundStory: "The stars remember.",
        firstAction: "Open the dome."
      },
      latestVersionId: null,
      latestVersionNumber: null,
      latestPublishedAt: null,
      latestPreview: null,
      campaignCount: 0
    };
    dependencies.worlds.listWorlds = async (_transaction, owner) => ({
      worlds: owner.ownerUserId === ownerUserId ? [worldSummary] : []
    });
    dependencies.worlds.createWorld = async (_transaction, owner) => ({
      ok: true,
      value: {
        id: worldId,
        title: "Glass Stars",
        status: "draft",
        imageUrl: "",
        draftRevision: 1,
        draftContent: { schemaVersion: 4 },
        draftBasedOnWorldVersionId: null,
        createdAt: "2026-08-05T10:00:00.000Z",
        updatedAt: "2026-08-05T10:00:00.000Z"
      }
    });
    const application = createWorldCampaignApplication(dependencies);

    const ownedWorlds = await application.listWorlds({ ownerUserId });
    expect(ownedWorlds).toEqual({ worlds: [worldSummary] });
    expect(Object.isFrozen(ownedWorlds)).toBe(true);
    expect(Object.isFrozen(ownedWorlds.worlds)).toBe(true);
    expect(Object.isFrozen(ownedWorlds.worlds[0])).toBe(true);
    await expect(application.listWorlds({ ownerUserId: "foreign-owner" })).resolves.toEqual({ worlds: [] });
    await expect(application.createWorld({ ownerUserId }, { title: "Glass Stars" } as never)).resolves.toEqual({
      id: worldId,
      title: "Glass Stars",
      status: "draft",
      imageUrl: "",
      draftRevision: 1,
      draftContent: { schemaVersion: 4 },
      draftBasedOnWorldVersionId: null,
      createdAt: "2026-08-05T10:00:00.000Z",
      updatedAt: "2026-08-05T10:00:00.000Z"
    });
    await expect(application.listWorlds({ ownerUserId: "" })).rejects.toMatchObject({
      kind: "invalid_request",
      reason: "owner_scope_required"
    });
    expect(events).toEqual(["read", "read", "command"]);
  });

  test("delegates changed sync windows to one bounded turn-page port", async () => {
    const pageRequests: unknown[] = [];
    const transaction: WorldCampaignTransactionPort = {
      command: async (work) => work({}),
      read: async (work) => work({})
    };
    const turnPages: BoundedCampaignTurnPagePort = {
      readTurnPage: async (scope, request) => {
        pageRequests.push({ scope, request });
        if (request.limit > 50 || request.before !== undefined) throw new Error("unbounded sync request");
        return {
          turns: [{
            id: "turn-1",
            turnNumber: 1,
            action: "Enter",
            inputMode: "action",
            inputModeSource: "explicit",
            narration: "The dome opens.",
            choices: [],
            customActionSuggestion: "",
            imagePrompt: "",
            imageUrl: null,
            acceptedAt: "2026-08-05T10:00:00.000Z",
            reportedCost: null
          }],
          nextCursor: "older-page"
        };
      }
    };
    const dependencies = minimalDependencies(transaction, turnPages);
    const campaign = {
      id: campaignId,
      title: "Observatory Campaign",
      activeTurnNumber: 1,
      worldVersionId: currentVersionId,
      storyLengthProfile: "standard" as const,
      updatedAt: "2026-08-05T10:00:00.000Z",
      selectedCharacterId: null,
      selectedCharacterName: "",
      characterSnapshot: null,
      characterProfile: null,
      characterProfileRevision: 0,
      status: "active" as const
    };
    const syncProjection = {
      ...campaign,
      campaign,
      world: {
        id: worldId,
        title: "Glass Stars",
        versionNumber: 1,
        genre: "science fantasy",
        tone: "hopeful",
        premise: "A glass observatory",
        backgroundStory: "The stars remember.",
        character: "",
        firstAction: "Open the dome.",
        rules: "",
        playableCharacters: []
      },
      playerConfig: {
        selectedCharacterId: null,
        selectedCharacterName: "",
        characterSnapshot: null,
        characterProfile: null,
        characterProfileRevision: 0,
        rpgStats: [],
        trackers: [],
        eventTriggers: [],
        useRpgStats: false,
        suppressEventTriggers: false
      },
      pendingGeneration: null,
      generationRecovery: null
    };
    dependencies.sync.readCampaignSyncSnapshot = async () => ({
      syncToken: "sync-2",
      projection: syncProjection
    });
    const application = createWorldCampaignApplication(dependencies);
    const scope = { ownerUserId, campaignId };

    await expect(application.getCampaignSyncStatus(scope, { since: "sync-1" })).resolves.toEqual({
      ...syncProjection,
      syncToken: "sync-2",
      turnWindowMode: "replace",
      turns: {
        campaignId,
        turns: expect.arrayContaining([expect.objectContaining({ id: "turn-1" })]),
        nextCursor: "older-page"
      }
    });
    await expect(application.getCampaignSyncStatus(scope, { since: "sync-2" })).resolves.toEqual({
      ...syncProjection,
      syncToken: "sync-2",
      turnWindowMode: "unchanged",
      turns: null
    });
    expect(pageRequests).toEqual([{ scope, request: { before: undefined, limit: 50 } }]);
  });

  test("requires explicit readonly fields on every public domain projection", () => {
    expectTypeOf<WorldListView["worlds"][number]["latestVersionId"]>().toEqualTypeOf<string | null>();
    expectTypeOf<WorldAggregateView["versions"][number]["deletionBlockers"]["campaignTransfers"]>().toEqualTypeOf<number>();
    expectTypeOf<CampaignListView["campaigns"][number]["worldVersionId"]>().toEqualTypeOf<string>();
    expectTypeOf<CampaignUpdateView["turnControlStyle"]>().toEqualTypeOf<"action_only" | "flexible_auto" | "flexible_action" | "flexible_scene">();
    expectTypeOf<CampaignStateEditView["snapshot"]["canonicalFacts"]>().toMatchTypeOf<readonly unknown[]>();
    expectTypeOf<CharacterProfileView["revision"]>().toEqualTypeOf<number>();
    expectTypeOf<PlayableCharacterSummaryView["readiness"]["ready"]>().toEqualTypeOf<boolean>();
    expectTypeOf<CampaignTransferView["sourceFingerprint"]>().toEqualTypeOf<string>();
    expectTypeOf<CampaignTransferResultView["reused"]>().toEqualTypeOf<boolean>();
    expectTypeOf<DashboardView["providerCosts"]["totals"][number]["currency"]>().toEqualTypeOf<string>();
    expectTypeOf<GeneratedWorldPreviewView["content"]["playableCharacters"]>().toMatchTypeOf<readonly unknown[]>();
    expectTypeOf<GeneratedPlayableCharacterView["character"]["name"]>().toEqualTypeOf<string>();
    expectTypeOf<CampaignSyncStatusView["campaign"]["activeTurnNumber"]>().toEqualTypeOf<number>();
    expectTypeOf<CampaignSyncStatusView["world"]["playableCharacters"]>().toMatchTypeOf<readonly unknown[]>();
    expectTypeOf<CampaignSyncStatusView["playerConfig"]["trackers"]>().toMatchTypeOf<readonly unknown[]>();
  });

  test("exposes the complete platform-free responsibility boundary", () => {
    expectTypeOf<OwnerScope>().toEqualTypeOf<Readonly<{ ownerUserId: string }>>();
    expectTypeOf<CampaignScope>().toMatchTypeOf<Readonly<{ ownerUserId: string; campaignId: string }>>();
    expectTypeOf<WorldCampaignApplication>().toHaveProperty("publishWorld");
    expectTypeOf<WorldCampaignApplication>().toHaveProperty("migrateCampaignWorldVersion");
    expectTypeOf<WorldCampaignApplication>().toHaveProperty("promoteCampaignDiscoveries");
    expectTypeOf<WorldCampaignApplication>().toHaveProperty("getCampaignRuntimeState");
    expectTypeOf<WorldCampaignApplication>().toHaveProperty("getCampaignSyncStatus");
    expectTypeOf<WorldCampaignApplication>().toHaveProperty("getWorldVersionPlayableCharacterSummary");
    expectTypeOf<WorldCampaignApplication>().toHaveProperty("getCampaignCharacterProfile");
    expectTypeOf<WorldCampaignApplication>().toHaveProperty("previewCampaignWorldTransfer");
    expectTypeOf<WorldCampaignApplication>().toHaveProperty("getDashboard");
    expectTypeOf<WorldCampaignApplication>().toHaveProperty("getSessionProfile");
    expectTypeOf<WorldCampaignApplication>().toHaveProperty("generateWorldPreview");
    expectTypeOf<WorldCampaignApplication>().toHaveProperty("getWorldGenerationProgress");
  });
});

function minimalDependencies(
  transaction: WorldCampaignTransactionPort,
  turnPages: BoundedCampaignTurnPagePort,
): WorldCampaignApplicationDependencies {
  const unimplemented = async (): Promise<never> => {
    throw new Error("not exercised");
  };
  return {
    transaction,
    worlds: {
      listWorlds: unimplemented,
      getWorld: unimplemented,
      createWorld: unimplemented,
      updateWorldDraft: unimplemented,
      publishWorld: unimplemented,
      updateWorldStatus: unimplemented,
      forkWorld: unimplemented,
      exportWorld: unimplemented,
      previewWorldImport: unimplemented,
      importWorld: unimplemented,
      deleteWorld: unimplemented,
      deleteWorldVersion: unimplemented,
      promoteCampaignDiscoveries: unimplemented
    },
    campaigns: {
      listCampaigns: unimplemented,
      createCampaign: unimplemented,
      updateCampaign: unimplemented,
      deleteCampaign: unimplemented,
      listWorldVersionPlayableCharacters: unimplemented,
      getWorldVersionPlayableCharacterSummary: unimplemented,
      migrateCampaignWorldVersion: unimplemented,
      syncPlayerCampaignConfig: unimplemented,
      rewindCampaign: unimplemented,
      branchCampaign: unimplemented
    },
    state: {
      loadEffectiveCampaignStateEdit: unimplemented,
      getCampaignRuntimeState: unimplemented,
      updateCampaignRuntimeState: unimplemented
    },
    sync: { readCampaignSyncSnapshot: unimplemented },
    turnPages,
    characters: {
      getCampaignCharacterProfile: unimplemented,
      updateCampaignCharacterProfile: unimplemented
    },
    characterOrganizer: {
      organizeCampaignCharacterProfile: unimplemented,
      organizeWorldCharacterProfile: unimplemented
    },
    transfers: {
      previewCampaignWorldTransfer: unimplemented,
      transferCampaignWorld: unimplemented
    },
    dashboard: { getDashboard: unimplemented },
    sessionProfile: {
      getSessionProfile: unimplemented,
      updateSessionProfile: unimplemented
    },
    worldGeneration: {
      generateWorldPreview: unimplemented,
      generatePlayableCharacterPreview: unimplemented,
      generatePlayableCharacter: unimplemented
    },
    progress: {
      createWorldGenerationProgress: unimplemented,
      updateWorldGenerationProgress: unimplemented,
      getWorldGenerationProgress: unimplemented,
      deleteExpiredWorldGenerationProgress: unimplemented
    }
  };
}
