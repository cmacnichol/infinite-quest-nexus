import { describe, expect, it } from "vitest";
import {
  providerProfileInputSchema,
  providerProfileUpdateSchema,
  providerTextRequestSchema,
  generationRequestSchema,
  illustrationConfigSchema,
  storyTurnOutputSchema
} from "../../packages/contracts/src/generation.js";

describe("generation contracts", () => {
  describe("providerProfileInputSchema", () => {
    it("accepts valid input with minimum required fields and applies defaults", () => {
      const input = {
        name: "My Provider",
        providerType: "openai_compatible",
        baseUrl: "https://api.openai.com/v1"
      };

      const parsed = providerProfileInputSchema.parse(input);

      expect(parsed.name).toBe("My Provider");
      expect(parsed.providerType).toBe("openai_compatible");
      expect(parsed.providerRole).toBe("text"); // Default
      expect(parsed.enabled).toBe(true); // Default
      expect(parsed.contextWindowTokens).toBe(32768); // Default
    });

    it("rejects text providers where maxOutputTokens is too close to contextWindowTokens", () => {
      const input = {
        name: "My Provider",
        providerType: "lmstudio",
        baseUrl: "http://localhost:1234/v1",
        providerRole: "text",
        contextWindowTokens: 4000,
        maxOutputTokens: 3500 // 3500 + 512 = 4012 >= 4000 -> Should fail
      };

      const result = providerProfileInputSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("Text output reserve must leave at least 512 tokens");
      }
    });

    it("accepts text providers with sufficient context window", () => {
      const input = {
        name: "My Provider",
        providerType: "lmstudio",
        baseUrl: "http://localhost:1234/v1",
        providerRole: "text",
        contextWindowTokens: 4000,
        maxOutputTokens: 2000
      };

      const result = providerProfileInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("rejects invalid URLs", () => {
      const input = {
        name: "My Provider",
        providerType: "openai_compatible",
        baseUrl: "ftp://invalid-url.com" // Must be http or https
      };

      const result = providerProfileInputSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("Base URL must use HTTP or HTTPS");
      }
    });
  });

  describe("providerProfileUpdateSchema", () => {
    it("requires at least one field to update", () => {
      const result = providerProfileUpdateSchema.safeParse({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("At least one provider field is required");
      }
    });

    it("accepts a single field update", () => {
      const result = providerProfileUpdateSchema.safeParse({ name: "New Name" });
      expect(result.success).toBe(true);
    });
  });

  describe("illustrationConfigSchema", () => {
    it("applies defaults when empty", () => {
      const parsed = illustrationConfigSchema.parse({});
      expect(parsed.enabled).toBe(false);
      expect(parsed.size).toBe("1024x1024");
      expect(parsed.outputFormat).toBe("png");
    });

    it("requires providerProfileId when enabled", () => {
      const input = {
        enabled: true,
        model: "dall-e-3"
      };

      const result = illustrationConfigSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some(i => i.message.includes("Select an image provider"))).toBe(true);
      }
    });

    it("requires model when enabled", () => {
      const input = {
        enabled: true,
        providerProfileId: "123e4567-e89b-12d3-a456-426614174000"
      };

      const result = illustrationConfigSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some(i => i.message.includes("Select an image model"))).toBe(true);
      }
    });

    it("accepts valid enabled config", () => {
      const input = {
        enabled: true,
        providerProfileId: "123e4567-e89b-12d3-a456-426614174000",
        model: "dall-e-3"
      };

      const result = illustrationConfigSchema.safeParse(input);
      expect(result.success).toBe(true);
    });
  });

  describe("providerTextRequestSchema", () => {
    it("requires at least one message", () => {
      const result = providerTextRequestSchema.safeParse({ messages: [] });
      expect(result.success).toBe(false);
    });

    it("accepts valid text request", () => {
      const result = providerTextRequestSchema.safeParse({
        messages: [{ role: "user", content: "Hello" }]
      });
      expect(result.success).toBe(true);
    });
  });

  describe("generationRequestSchema", () => {
    it("applies defaults to context", () => {
      const input = {
        action: "generate_story",
        idempotencyKey: "1234567890"
      };

      const parsed = generationRequestSchema.parse(input);
      expect(parsed.context.budgetTokens).toBe(32000);
      expect(parsed.context.compression).toBe("auto");
      expect(parsed.context.recentTurns).toBe(8);
    });
  });

  describe("storyTurnOutputSchema", () => {
    it("requires exactly 4 choices", () => {
      const input = {
        narration: "The story continues...",
        choices: ["Choice 1", "Choice 2", "Choice 3"], // Only 3 choices
        custom_action_suggestion: "Do something else",
        continuity_summary: "Summary",
        canonical_facts: [],
        superseded_facts: [],
        open_threads: []
      };

      const result = storyTurnOutputSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("accepts valid story turn output", () => {
      const input = {
        narration: "The story continues...",
        choices: ["Choice 1", "Choice 2", "Choice 3", "Choice 4"],
        custom_action_suggestion: "Do something else",
        continuity_summary: "Summary",
        canonical_facts: [],
        superseded_facts: [],
        open_threads: []
      };

      const result = storyTurnOutputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });
  });
});
