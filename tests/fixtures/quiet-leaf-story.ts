import { parseHTML } from "linkedom";
import { createCampaignStore } from "../../packages/client-core/src/index.js";
import { campaignSyncStatusSchema, type CampaignSummary, type CampaignSyncStatus } from "../../packages/contracts/src/index.js";
import { vi } from "vitest";
import type { StoryPlayerComposition } from "../../apps/web-next/src/story-player-composition.js";

const campaignId = "11111111-1111-4111-8111-111111111111";
const worldVersionId = "22222222-2222-4222-8222-222222222222";

export function createStoryTestDom(): { document: Document; window: Window & typeof globalThis; root: HTMLElement } {
  const { document, window } = parseHTML("<body><div id=app></div></body>");
  const root = document.querySelector<HTMLElement>("#app");
  if (!root) throw new Error("Quiet Leaf test fixture root is missing.");
  return { document, window: window as unknown as Window & typeof globalThis, root };
}

type TurnControlStyle = CampaignSummary["turnControlStyle"];

function campaignSummary(turnControlStyle: TurnControlStyle = "action_only"): CampaignSummary {
  return {
    id: campaignId,
    title: "Campaign under test",
    status: "active",
    activeTurnNumber: 1,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    storyLengthProfile: "standard",
    storyContextBudgetTokens: 32_000,
    turnControlStyle,
    selectedCharacterId: null,
    selectedCharacterName: null,
    worldId: "33333333-3333-4333-8333-333333333333",
    worldTitle: "World under test",
    worldVersionId,
    textProviderProfileId: "44444444-4444-4444-8444-444444444444",
    imageProviderProfileId: null,
    worldVersionNumber: 1,
    latestWorldVersionNumber: 1,
    worldUpdateAvailable: false,
    costInformation: []
  };
}

function sync(
  choices: readonly string[] = ["Open the door", "Open the door"],
  turnControlStyle: TurnControlStyle = "action_only"
): CampaignSyncStatus {
  const campaign = {
    id: campaignId,
    title: "Campaign under test",
    activeTurnNumber: 1,
    worldVersionId,
    storyLengthProfile: "standard",
    storyContextBudgetTokens: 32_000,
    turnControlStyle,
    updatedAt: "2026-08-18T00:00:00.000Z",
    selectedCharacterId: null,
    selectedCharacterName: "",
    characterSnapshot: null,
    characterProfile: null,
    characterProfileRevision: 0,
    status: "active"
  };
  return campaignSyncStatusSchema.parse({
    ...campaign,
    campaign,
    world: {
      id: "33333333-3333-4333-8333-333333333333",
      title: "World under test",
      versionNumber: 1,
      genre: "",
      tone: "",
      premise: "A real world premise.",
      backgroundStory: "A real world background.",
      character: "",
      firstAction: "Take the real first action.",
      rules: "",
      playableCharacters: []
    },
    playerConfig: {
      selectedCharacterId: null,
      selectedCharacterName: "",
      characterSnapshot: null,
      characterProfile: null,
      characterProfileRevision: 0,
      rpgStats: [], trackers: [], eventTriggers: [], useRpgStats: false, suppressEventTriggers: false
    },
    pendingGeneration: null,
    generationRecovery: null,
    syncToken: "sync-test",
    turnWindowMode: "replace",
    turns: {
      campaignId,
      nextCursor: null,
      turns: [{
        id: "66666666-6666-4666-8666-666666666666",
        turnNumber: 1,
        action: "Proceed.", inputMode: "action", inputModeSource: "explicit",
        narration: "The story continues.", choices: [...choices], customActionSuggestion: "", imagePrompt: "", imageUrl: null,
        acceptedAt: "2026-08-18T00:00:00.000Z", chronicleRetrieval: null, reportedCost: null
      }]
    }
  });
}

export function createStoryTestComposition(options: {
  turnControlStyle?: TurnControlStyle;
  autoSubmitTurnChoices?: boolean;
  classifyTurnInput?: ReturnType<typeof vi.fn>;
} = {}): StoryPlayerComposition {
  return {
    api: {
      campaigns: {
        list: vi.fn().mockResolvedValue({ campaigns: [campaignSummary(options.turnControlStyle)] }),
        classifyTurnInput: options.classifyTurnInput ?? vi.fn(),
        turns: vi.fn(), state: vi.fn()
      },
      generation: { syncStatus: vi.fn().mockResolvedValue(sync(undefined, options.turnControlStyle)) },
      session: { get: vi.fn().mockResolvedValue({ user: { settings: { autoSubmitTurnChoices: options.autoSubmitTurnChoices === true } } }) }
    },
    campaignStore: createCampaignStore(),
    workflow: {
      submit: vi.fn(async () => ({
        campaignId,
        jobId: "55555555-5555-4555-8555-555555555555",
        operationKind: "append" as const,
        replacementTurnId: null,
        async *watch() { yield { type: "settled" as const, outcome: "discarded" as const, error: new Error("test discard") }; },
        async *retryGeneration() {},
        cancelGeneration: vi.fn(), discardGeneration: vi.fn(), fetchResult: vi.fn()
      })),
      resume: vi.fn(async () => null)
    },
    illustrations: {}, idFactory: { create: () => "quiet-leaf-idempotency-key" }, clock: {}, delay: {}
  } as unknown as StoryPlayerComposition;
}

export async function settleStoryTest(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
