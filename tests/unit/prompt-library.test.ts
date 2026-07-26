import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildPromptPreview,
  PROMPT_TEMPLATE_CATALOG,
  promptTemplateOverrideSchema,
  renderPromptTemplate,
  sampleValuesForPrompt
} from "../../packages/contracts/src/prompt-library.js";
import { composeIllustrationProviderPrompt, directIllustrationPrompt } from "../../packages/domain/src/illustrations.js";
import { buildTemplateWorldPrompt } from "../../packages/domain/src/world-template.js";
import { promptProtocolVersion, type PromptSnapshot } from "../../services/api/src/prompt-library-service.js";
import { infiniteWorldsPromptSet } from "../../services/api/src/infinite-worlds-import-service.js";

describe("Prompt Library catalog", () => {
  it("requires both narrative guidance and a structured profile for generated characters", () => {
    const generation = PROMPT_TEMPLATE_CATALOG.world_generation.defaultContent;
    const recovery = PROMPT_TEMPLATE_CATALOG.world_generation_recovery.defaultContent;
    const supplement = PROMPT_TEMPLATE_CATALOG.world_roster_supplement.defaultContent;

    for (const prompt of [generation, recovery, supplement]) {
      expect(prompt).toContain("character_text");
      expect(prompt).toContain("profile");
    }
    expect(generation).toContain("character_text must be non-empty");
    expect(generation).not.toContain("may be empty when profile is complete");
    expect(recovery).toContain("complete replacement");
  });

  it("spells out the JSON types for every generated character section", () => {
    const prompts = [
      PROMPT_TEMPLATE_CATALOG.world_generation.defaultContent,
      PROMPT_TEMPLATE_CATALOG.world_generation_recovery.defaultContent,
      PROMPT_TEMPLATE_CATALOG.world_roster_supplement.defaultContent
    ];

    for (const prompt of prompts) {
      expect(prompt).toContain('"profile":{"identity":{"aliases":[],"pronouns":""}');
      expect(prompt).toContain('"appearance":{"ancestryOrSpecies":""');
      expect(prompt).toContain('"unclassifiedNotes":""');
      expect(prompt).toContain('"rpg_statistics":[]');
      expect(prompt).toContain('"default_triggers":[]');
      expect(prompt).toContain("must be JSON objects, never strings, arrays, or null");
      expect(prompt).toContain("must be JSON arrays, never strings, objects, or null");
      expect(prompt).toContain("Use an empty string or empty array when a value is unknown");
    }
  });

  it("uses the same complete-character requirements in the fallback world prompt", () => {
    const prompt = buildTemplateWorldPrompt({
      sourceName: "test",
      sourceKind: "prompt",
      title: "The Moving Roads",
      summary: "Roads move beneath moonlight.",
      keywords: [],
      excerpts: []
    }).systemPrompt;

    expect(prompt).toContain("character_text must be non-empty");
    expect(prompt).toContain("profile with identity");
    expect(prompt).not.toContain("may be empty when profile is complete");
  });

  it("enforces campaign ownership with a composite database relationship", () => {
    const migration = readFileSync("database/migrations/0038_prompt_library_hardening.sql", "utf8");
    expect(migration).toContain("FOREIGN KEY (campaign_id, owner_user_id)");
    expect(migration).toContain("REFERENCES campaigns(id, owner_user_id)");
  });

  it("defines every core generation and illustration instruction with an owned default", () => {
    for (const key of ["story_system", "rpg_assessment", "event_trigger", "event_extension", "turn_intent", "scene_coverage", "world_generation", "character_generation", "infinite_worlds_conversion", "illustration_refinement", "illustration_direct"] as const) {
      expect(PROMPT_TEMPLATE_CATALOG[key].defaultContent.trim()).not.toBe("");
      expect(PROMPT_TEMPLATE_CATALOG[key].maxLength).toBeGreaterThan(0);
    }
  });

  it("allows only eligible campaign overrides", () => {
    expect(promptTemplateOverrideSchema.safeParse({ key: "story_system", scope: "campaign", campaignId: crypto.randomUUID(), content: "Write safely." }).success).toBe(true);
    expect(promptTemplateOverrideSchema.safeParse({ key: "world_generation", scope: "campaign", campaignId: crypto.randomUUID(), content: "Write safely." }).success).toBe(false);
    expect(promptTemplateOverrideSchema.safeParse({ key: "story_system", scope: "application", campaignId: crypto.randomUUID(), content: "Write safely." }).success).toBe(false);
  });

  it("renders only engine-supplied placeholder values", () => {
    expect(renderPromptTemplate("Aim for {{minWords}}-{{maxWords}}. {{unknown}}", { minWords: 200, maxWords: 350 }))
      .toBe("Aim for 200-350. {{unknown}}");
  });

  it("provides safe example values for every template variable", () => {
    for (const template of Object.values(PROMPT_TEMPLATE_CATALOG)) {
      const sample = sampleValuesForPrompt(template.key);
      expect(Object.keys(sample)).toEqual(template.variables);
    }
  });

  it("rejects unknown placeholders and missing required placeholders", () => {
    const campaignId = crypto.randomUUID();
    expect(promptTemplateOverrideSchema.safeParse({
      key: "story_system",
      scope: "campaign",
      campaignId,
      content: "Write fiction using {{uncontrolledStoryData}}."
    }).success).toBe(false);
    expect(promptTemplateOverrideSchema.safeParse({
      key: "story_recovery_output_limit",
      scope: "campaign",
      campaignId,
      content: "Keep narration above {{minWords}} words."
    }).success).toBe(false);
  });

  it("builds a complete safe provider-request preview for every catalog entry", () => {
    for (const template of Object.values(PROMPT_TEMPLATE_CATALOG)) {
      const preview = buildPromptPreview(template.key, template.defaultContent);
      expect(preview.sections.length).toBeGreaterThan(0);
      expect(preview.sections.every((section) => section.content.trim().length > 0)).toBe(true);
      expect(preview.unresolvedVariables).toEqual([]);
      expect(preview.estimatedTokens).toBeGreaterThan(0);
    }
  });

  it("changes the runtime protocol identity when any campaign-runtime prompt changes", () => {
    const snapshot = Object.fromEntries(Object.values(PROMPT_TEMPLATE_CATALOG).map((template) => [
      template.key,
      { content: template.defaultContent, hash: "ignored", source: "shipped" }
    ])) as PromptSnapshot;
    const original = promptProtocolVersion(snapshot);
    snapshot.event_trigger = { ...snapshot.event_trigger, content: `${snapshot.event_trigger.content}\nChanged.` };
    expect(promptProtocolVersion(snapshot)).not.toBe(original);
  });

  it("renders editable illustration wrappers after sanitizing structured values", () => {
    expect(directIllustrationPrompt("A lantern glows.", "DIRECT: {{segment}}"))
      .toBe("DIRECT: A lantern glows.");
    expect(composeIllustrationProviderPrompt(
      "A lantern glows.",
      "Mira wears a blue coat.",
      "SCENE={{scene}}\nCHARACTER={{character}}"
    )).toBe("SCENE=A lantern glows.\nCHARACTER=Mira wears a blue coat.");
  });

  it("routes every Infinite Worlds instruction through the effective snapshot", () => {
    const snapshot = {
      infinite_worlds_conversion: { content: "CONVERT", hash: "", source: "application" },
      infinite_worlds_recovery: { content: "RECOVER", hash: "", source: "application" },
      infinite_worlds_batch: { content: "{{base}} / BATCH {{batch}} OF {{total}}", hash: "", source: "application" },
      infinite_worlds_final_turn: { content: "FINAL", hash: "", source: "application" }
    } as unknown as PromptSnapshot;
    expect(infiniteWorldsPromptSet(snapshot, 2, 4)).toEqual({
      conversion: "CONVERT",
      recovery: "RECOVER",
      batch: "CONVERT / BATCH 2 OF 4",
      finalTurn: "FINAL"
    });
  });
});
