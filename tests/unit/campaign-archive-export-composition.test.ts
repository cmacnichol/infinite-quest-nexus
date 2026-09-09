import { describe, expect, it } from "vitest";
import { z } from "zod";
import { campaignArchivePayloads } from "../../services/runtime/src/campaign-archive-export-composition.js";
import type { CampaignArchiveExportSnapshot } from "../../packages/database/src/campaign-archive-export-repository.js";
import { worldContentSchema } from "../../packages/contracts/src/world-library.js";
import { portableAcceptedGenerationPolicyProvenanceSchema } from "../../packages/contracts/src/campaign-generation-policy.js";

const runtimePolicy = {
  version: 1, playMode: "story_only", turnControlStyle: "flexible_scene", protocolVersion: "story-only-v1",
  prompts: { systemSupplement: "Private narrative supplement sentinel", systemSupplementHash: "a".repeat(64), choiceRepairSystem: "Private choice repair sentinel", choiceRepairSystemHash: "b".repeat(64) }
};

const snapshot: CampaignArchiveExportSnapshot = {
  ownerUserId: "55555555-5555-4555-8555-555555555555",
  campaign: {
    id: "11111111-1111-4111-8111-111111111111",
    world_id: "22222222-2222-4222-8222-222222222222",
    world_version_id: "33333333-3333-4333-8333-333333333333",
    version_number: 1,
    title: "Story archive",
    content: worldContentSchema.parse({ world: { title: "Story world" } }),
    character_profile: null,
    character_snapshot: null,
    selected_character_id: null,
    character_profile_revision: 0,
    revision: 0,
    legacy_settings: {},
    story_length_profile: "standard",
    story_context_budget_tokens: 32_000,
    turn_control_style: "flexible_scene",
    rpg_stats: [{ id: "dormant" }],
    default_triggers: [], event_triggers: [], pending_event_triggers: [{ id: "pending" }], trackers: [], scratchpad_private: ""
  },
  turns: [{
    id: "44444444-4444-4444-8444-444444444444", turn_number: 1, action: "Continue.", input_mode: "scene",
    input_mode_source: "explicit", narration: "The lamp brightens.", choices: [], custom_action_suggestion: "Wait.",
    image_prompt: "", image_url: "", mechanics_private: null, state_snapshot_private: {},
    model_metadata: { generationPolicy: runtimePolicy, providerType: "lm_studio", model: "synthetic-story-model" },
    generation_policy: runtimePolicy,
    accepted_at: new Date("2026-09-09T00:00:00.000Z")
  }],
  profileEdits: [], stateEdits: [], narrationCorrections: [], migrations: [], illustrationConfig: null,
  illustrationSets: [], illustrationSegments: [], costs: [], memories: [], summaries: [], legacyHistory: null, assets: { records: [], uniqueOriginals: [] }
};

const exportedPolicyFieldsSchema = z.object({
  formatVersion: z.literal(4),
  generationPolicyVersion: z.literal(1),
  settings: z.object({ turnControlStyle: z.literal("flexible_scene") }),
  turns: z.array(z.object({
    portableAcceptedGenerationPolicyProvenance: portableAcceptedGenerationPolicyProvenanceSchema,
    llmModelInfo: z.record(z.string(), z.unknown())
  })).length(1)
});

describe("campaign archive policy projection", () => {
  it("writes v4 with the retained setting and safe accepted policy provenance", () => {
    const original = structuredClone(snapshot);
    const payload = campaignArchivePayloads(snapshot).campaign;
    const campaign = exportedPolicyFieldsSchema.parse(payload);
    expect(campaign.formatVersion).toBe(4);
    expect(campaign.generationPolicyVersion).toBe(1);
    expect(campaign.settings.turnControlStyle).toBe("flexible_scene");
    expect(campaign.turns[0]?.portableAcceptedGenerationPolicyProvenance).toEqual({
      version: 1, playMode: "story_only", turnControlStyle: "flexible_scene", protocolVersion: "story-only-v1"
    });
    expect(campaign.turns[0]?.llmModelInfo).toEqual({ providerType: "lm_studio", model: "synthetic-story-model" });
    expect(JSON.stringify(payload)).not.toContain("systemSupplement");
    expect(JSON.stringify(payload)).not.toContain(runtimePolicy.prompts.systemSupplement);
    expect(JSON.stringify(payload)).not.toContain(runtimePolicy.prompts.choiceRepairSystem);
    expect(snapshot).toEqual(original);
  });
});
