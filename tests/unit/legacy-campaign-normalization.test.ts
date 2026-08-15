import { describe, expect, it } from "vitest";
import { legacyStorySchema } from "../../packages/contracts/src/imports.js";
import { canonicalizeWorldContent } from "../../packages/contracts/src/world-library.js";
import { normalizeLegacyCampaign } from "../../packages/domain/src/legacy-campaign-normalization.js";

describe("normalizeLegacyCampaign", () => {
  it("binds a create-world import to its converted character and translates campaign settings", () => {
    const story = legacyStorySchema.parse({
      world: {
        title: "The Glass March",
        character: "Mara Vale\nAn exiled cartographer.",
        suppressTriggers: true
      },
      turns: [],
      settings: {
        storyLength: "long",
        turnControlStyle: "flexible_scene",
        useRpgStats: true,
        memoryManagementMode: "scheduled",
        storyHistoryTokenLimit: 128_000,
        apiKey: "must-not-survive"
      },
      rpgStats: [{ name: "Resolve", value: 71 }],
      defaultTriggers: [{ name: "Map fragments", value: "0" }]
    });

    const normalized = normalizeLegacyCampaign({
      story,
      destination: { kind: "create_world" }
    });

    expect(normalized.worldContent?.playableCharacters).toHaveLength(1);
    expect(normalized.campaignSeed).toMatchObject({
      title: "The Glass March",
      selectedCharacterId: normalized.worldContent?.playableCharacters[0]?.id,
      characterSnapshot: {
        name: "Mara Vale",
        characterText: "Mara Vale\nAn exiled cartographer."
      },
      storyLengthProfile: "long",
      turnControlStyle: "flexible_scene",
      legacySettings: {
        storyLength: "long",
        turnControlStyle: "flexible_scene",
        useRpgStats: true,
        suppressEventTriggers: true,
        apiKey: ""
      }
    });
    expect(normalized.currentState.rpgStats).toEqual([{ name: "Resolve", value: 71 }]);
    expect(normalized.currentState.defaultTriggers).toEqual([{ id: "Map fragments", name: "Map fragments", value: "0", rules: "" }]);
    expect(normalized.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("Chronicle replaces legacy memory management mode"),
      expect.stringContaining("provider context window replaces legacy story history token limit")
    ]));
  });

  it("preserves structured turn state while filling absent fields from legacy fallback snapshots", () => {
    const story = legacyStorySchema.parse({
      world: { title: "Snapshot Test", character: "Aster" },
      turns: [{
        id: "legacy-turn-7",
        turnNumber: 7,
        action: "Open the door",
        inputMode: "scene",
        inputModeSource: "generated_choice",
        narration: "The bronze door opens.",
        choices: ["Enter", "Wait"],
        custom_action_suggestion: "Listen first",
        imagePrompt: "A bronze door",
        roll: { total: 63, target: 70 },
        worldStateSnapshot: {
          continuitySummary: "Aster reached the sealed archive.",
          pendingEventTriggers: [{ name: "Bell", timing: "after" }]
        },
        scratchpadSnapshot: "The key is warm.",
        trackersSnapshot: [{ name: "Door", value: "open" }],
        llmModelInfo: { model: "local-model" },
        importedFrom: { source: "legacy-browser" },
        createdAt: "2025-01-02T03:04:05.000Z"
      }]
    });

    const normalized = normalizeLegacyCampaign({ story, destination: { kind: "create_world" } });

    expect(normalized.turns).toEqual([expect.objectContaining({
      turnNumber: 1,
      sourceTurnNumber: 7,
      sourceTurnId: "legacy-turn-7",
      inputMode: "scene",
      inputModeSource: "generated_choice",
      customActionSuggestion: "Listen first",
      mechanicsPrivate: { total: 63, target: 70 },
      stateSnapshotPrivate: {
        continuitySummary: "Aster reached the sealed archive.",
        pendingEventTriggers: [{ name: "Bell", timing: "after" }],
        scratchpad: "The key is warm.",
        trackers: [{ id: "Door", name: "Door", value: "open", rules: "" }]
      },
      modelMetadata: { model: "local-model" },
      importMetadata: {
        importedFrom: { source: "legacy-browser" },
        sourceTurnId: "legacy-turn-7",
        sourceTurnNumber: 7,
        legacyCreatedAt: "2025-01-02T03:04:05.000Z"
      },
      acceptedAt: "2025-01-02T03:04:05.000Z"
    })]);
  });

  it("maps or preserves character authority when attaching to an existing world version", () => {
    const targetWorldContent = canonicalizeWorldContent({
      world: { title: "Target" },
      playableCharacters: [{
        id: "target-hero",
        name: "Target Hero",
        characterText: "The target-world hero."
      }]
    });
    const story = legacyStorySchema.parse({
      format: "infinite-quest-campaign",
      world: { title: "Source", character: "Source Hero\nThe original protagonist." },
      campaign: {
        title: "Portable campaign",
        selectedCharacterId: "source-hero",
        characterSnapshot: {
          id: "source-hero",
          name: "Source Hero",
          characterText: "The original protagonist."
        }
      },
      turns: []
    });

    const mapped = normalizeLegacyCampaign({
      story,
      destination: { kind: "existing_world_version", worldContent: targetWorldContent },
      selectedCharacterId: "target-hero",
      characterStrategy: "map_to_target"
    });
    const preserved = normalizeLegacyCampaign({
      story,
      destination: { kind: "existing_world_version", worldContent: targetWorldContent },
      characterStrategy: "preserve_source"
    });

    expect(mapped.campaignSeed).toMatchObject({
      selectedCharacterId: "target-hero",
      characterSnapshot: { id: "target-hero", name: "Target Hero" },
      characterStrategy: "map_to_target"
    });
    expect(preserved.campaignSeed).toMatchObject({
      selectedCharacterId: "source-hero",
      characterSnapshot: { id: "source-hero", name: "Source Hero" },
      characterStrategy: "preserve_source"
    });
  });

  it("sanitizes fullHistory into a bounded continuity seed with truthful coverage", () => {
    const story = legacyStorySchema.parse({
      world: { title: "Summary", character: "Aster" },
      turns: [
        { narration: "Aster arrived." },
        { narration: "The archive opened." }
      ],
      fullHistory: {
        plotDetails: "Aster found the archive. DC 15 Wisdom check succeeded.",
        otherImportantNotes: "The bronze key remains important."
      },
      fullHistoryCompressedThroughTurn: 1
    });

    const normalized = normalizeLegacyCampaign({ story, destination: { kind: "create_world" } });

    expect(normalized.continuitySeed).toEqual({
      content: "Plot: Aster found the archive.\n\nImportant notes: The bronze key remains important.",
      throughTurn: 1,
      sanitized: true
    });
    expect(normalized.stats).toMatchObject({
      importedSummary: true,
      summaryThroughTurn: 1,
      preservedTurnStateCount: 2
    });
  });
});
