import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildTemplateWorldPrompt, extractCyoaLayers, parseCyoaExport } from "../../packages/domain/src/world-template.js";
import { playableCharacterGenerationPreviewRequestSchema, worldGenerationPreviewRequestSchema } from "../../packages/contracts/src/world-library.js";

describe("CYOA and Modular Template World creation", () => {
  it("parses valid writing.com CYOA JSON export and validates root structure", () => {
    const fixturePath = path.resolve(__dirname, "../fixtures/cyoa_writing_com_sample.json");
    const rawText = fs.readFileSync(fixturePath, "utf8");
    const parsed = parseCyoaExport(rawText);

    expect(parsed.info?.pretty_title).toBe("The Mystery of the Sunken Citadel");
    expect(parsed.chapters?.["1"]?.title).toBe("The Submerged Entrance");
    expect(parsed.chapters?.["1-1"]?.title).toBe("The Glowing Runes");
  });

  it("extracts top-level description and exactly 1 layer deep into top-level choices", () => {
    const fixturePath = path.resolve(__dirname, "../fixtures/cyoa_writing_com_sample.json");
    const rawText = fs.readFileSync(fixturePath, "utf8");
    const parsed = parseCyoaExport(rawText);
    const extracted = extractCyoaLayers(parsed, "cyoa_writing_com_sample.json");

    expect(extracted.sourceName).toBe("cyoa_writing_com_sample.json");
    expect(extracted.sourceKind).toBe("cyoa_json");
    expect(extracted.title).toBe("The Mystery of the Sunken Citadel");
    expect(extracted.summary).toContain("An interactive fantasy adventure");
    expect(extracted.keywords).toEqual(["fantasy", "exploration", "underwater", "magic"]);

    // Excerpts should contain top-level chapter "1" and layer-1 choices ("1-1", "1-2", "1-3"), but NOT "1-1-1"
    expect(extracted.excerpts.map((e) => e.chapterId)).toEqual(["1", "1-1", "1-2", "1-3"]);
    expect(extracted.excerpts.find((e) => e.chapterId === "1-1-1")).toBeUndefined();

    // Check stripped HTML tags in content
    const topLevelExcerpt = extracted.excerpts[0];
    expect(topLevelExcerpt?.content).not.toContain("<div>");
    expect(topLevelExcerpt?.content).toContain("Schools of bioluminescent tetra");
  });

  it("builds a modular prompt demanding 3-4 distinct playable characters without mechanics leakage", () => {
    const input = {
      sourceName: "test.json",
      sourceKind: "cyoa_json" as const,
      title: "Test CYOA",
      summary: "A test adventure summary.",
      keywords: ["test", "mystery"],
      excerpts: [
        { chapterId: "1", title: "Start", content: "You enter the dark cave.", choices: ["Go left", "Go right"] }
      ]
    };
    const prompt = buildTemplateWorldPrompt(input);

    expect(prompt.systemPrompt).toContain("exactly 3 or 4 distinct, fully fleshed out playable characters in playable_characters");
    expect(prompt.systemPrompt).toContain("Do not include credentials, model instructions, private reasoning, rolls, checks, dice results, or parser diagnostics in fictional fields");

    const payload = JSON.parse(prompt.input);
    expect(payload.task).toContain("3-4 identified or generated playable characters");
    expect(payload.title).toBe("Test CYOA");
    expect(payload.excerpts).toHaveLength(1);
  });

  it("builds modular prompt for direct user prompt input (New World from Prompt)", () => {
    const promptInput = {
      sourceName: "prompt-generation",
      sourceKind: "prompt" as const,
      title: "Cyberpunk Detectives",
      summary: "Neo-Tokyo 2099 cyberpunk investigation.",
      keywords: ["cyberpunk", "noir"],
      excerpts: [],
      prompt: "Create a cyberpunk detective world where androids and humans coexist."
    };
    const prompt = buildTemplateWorldPrompt(promptInput);

    const payload = JSON.parse(prompt.input);
    expect(payload.task).toContain("Create a new Story World with 3-4 playable characters from this concept prompt");
    expect(payload.prompt).toBe("Create a cyberpunk detective world where androids and humans coexist.");
  });

  it("validates side-effect-free world and character preview requests", () => {
    expect(worldGenerationPreviewRequestSchema.parse({ prompt: "Build a luminous mystery world." })).toEqual({
      title: "",
      prompt: "Build a luminous mystery world."
    });
    expect(() => worldGenerationPreviewRequestSchema.parse({ prompt: " " })).toThrow();
    expect(playableCharacterGenerationPreviewRequestSchema.parse({
      content: {
        world: {
          title: "Luminous Mystery",
          genre: "",
          tone: "",
          premise: "",
          backgroundStory: "",
          firstAction: "",
          rules: ""
        }
      },
      prompt: "Create a skeptical archivist."
    }).content.playableCharacters).toEqual([]);
  });
});
