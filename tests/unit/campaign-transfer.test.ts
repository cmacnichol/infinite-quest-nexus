import { describe, expect, it } from "vitest";
import { worldContentSchema } from "../../packages/contracts/src/world-library.js";
import { assessCampaignTransferCompatibility } from "../../packages/domain/src/campaign-transfer.js";

function world(characterId: string, schemaVersion = 4) {
  return worldContentSchema.parse({
    schemaVersion,
    world: {
      title: "Transfer Test",
      genre: "fantasy",
      tone: "hopeful",
      premise: "A test premise.",
      backgroundStory: "A test history.",
      firstAction: "Begin.",
      rules: "Stay in character."
    },
    playableCharacters: [{ id: characterId, name: `Character ${characterId}`, characterText: "A complete character." }],
    rpgStats: [{ id: "resolve", value: 20 }],
    defaultTriggers: [{ id: "torch", value: "lit" }],
    eventTriggers: []
  });
}

describe("campaign transfer compatibility", () => {
  it("blocks same-world transfers and active jobs", () => {
    const content = world("hero");
    const findings = assessCampaignTransferCompatibility({
      sourceWorldId: "world-one",
      targetWorldId: "world-one",
      targetWorldStatus: "active",
      sourceContent: content,
      targetContent: content,
      selectedCharacterId: "hero",
      characterSnapshot: content.playableCharacters[0]!,
      campaignState: { rpgStats: [], defaultTriggers: [], eventTriggers: [] },
      activeGenerationJobs: 1,
      activeImageJobs: 1
    });
    expect(findings.filter((finding) => finding.severity === "blocking").map((finding) => finding.code)).toEqual([
      "same_world_use_version_migration",
      "active_generation_job",
      "active_image_job"
    ]);
  });

  it("preserves an unmatched source character and warns about conflicting state", () => {
    const source = world("source-hero");
    const target = world("target-hero");
    const findings = assessCampaignTransferCompatibility({
      sourceWorldId: "world-one",
      targetWorldId: "world-two",
      targetWorldStatus: "active",
      sourceContent: source,
      targetContent: target,
      selectedCharacterId: "source-hero",
      characterSnapshot: source.playableCharacters[0]!,
      campaignState: {
        rpgStats: [{ id: "resolve", value: 99 }],
        defaultTriggers: [{ id: "torch", value: "spent" }],
        eventTriggers: []
      }
    });
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "source_character_preserved_outside_target_roster", severity: "info" }),
      expect.objectContaining({ code: "conflicting_rpg_stats", severity: "warning" }),
      expect.objectContaining({ code: "conflicting_default_triggers", severity: "warning" })
    ]));
    expect(findings.some((finding) => finding.severity === "blocking")).toBe(false);
  });
});
