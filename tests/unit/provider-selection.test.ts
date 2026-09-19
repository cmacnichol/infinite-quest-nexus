import { describe, expect, test } from "vitest";
import {
  normalizeTextSelection,
  selectionCompatibilityId
} from "../../packages/contracts/src/provider-selection.js";

describe("text model selection compatibility", () => {
  test("normalizes an exact OpenRouter preset alias for a text profile", () => {
    expect(normalizeTextSelection({
      providerType: "openrouter",
      providerRole: "text",
      defaultModel: "@preset/nexus-nsfw"
    })).toEqual({ kind: "openrouter_preset", slug: "nexus-nsfw" });
  });

  test("rejects an OpenRouter preset alias for an embedding profile", () => {
    expect(() => normalizeTextSelection({
      providerType: "openrouter",
      providerRole: "embedding",
      defaultModel: "@preset/nexus-nsfw"
    })).toThrow(/preset/i);
  });

  test("preserves a plain or empty model selection", () => {
    expect(normalizeTextSelection({ providerType: "openrouter", providerRole: "text", defaultModel: "openai/gpt-4o" }))
      .toEqual({ kind: "model", modelId: "openai/gpt-4o" });
    expect(normalizeTextSelection({ providerType: "openrouter", providerRole: "text", defaultModel: "" }))
      .toEqual({ kind: "model", modelId: "" });
  });

  test("preserves an invalid legacy alias for display and rejects a combined model/preset value", () => {
    expect(normalizeTextSelection({ providerType: "openrouter", providerRole: "text", defaultModel: "@preset/" }))
      .toEqual({ kind: "model", modelId: "@preset/" });
    expect(() => normalizeTextSelection({ providerType: "openrouter", providerRole: "text", defaultModel: "model@preset/nexus" }))
      .toThrow(/unsupported/i);
    expect(() => normalizeTextSelection({
      providerType: "openrouter", providerRole: "text", defaultModel: "openai/gpt-4o",
      textSelection: { kind: "openrouter_preset", slug: "nexus-nsfw" }
    })).toThrow(/contradict/i);
  });

  test("projects typed selections through the legacy compatibility ID", () => {
    expect(selectionCompatibilityId({ kind: "model", modelId: "openai/gpt-4o" })).toBe("openai/gpt-4o");
    expect(selectionCompatibilityId({ kind: "openrouter_preset", slug: "nexus-nsfw" })).toBe("@preset/nexus-nsfw");
  });
});
