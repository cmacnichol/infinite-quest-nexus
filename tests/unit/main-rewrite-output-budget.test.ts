import { describe, expect, it } from "vitest";
import { serializeCheckedProviderRequest } from "../../packages/story-engine/src/provider-request.js";
import type { TextProviderProfile } from "../../packages/story-engine/src/providers.js";

const profile: TextProviderProfile = {
  providerType: "lmstudio",
  baseUrl: "http://lmstudio.test/v1",
  model: "loaded-instance-id",
  contextWindowTokens: 1_000_000,
  maxOutputTokens: 300_000,
  temperature: 0
};

describe("main event-coverage rewrite output budget", () => {
  it("permits a complete replacement where prefix-preserving output cannot fit", () => {
    const request = {
      systemPrompt: "Rewrite the complete story.",
      input: "authoritative fiction context",
      recoveryInput: "Return a complete replacement JSON object.",
      completeRejectedDraft: { content: JSON.stringify({ narration: "N".repeat(200_000) }), complete: true as const }
    };
    const options = { inputLimit: 1_000_000, count: (body: string) => body.length };

    expect(() => serializeCheckedProviderRequest(profile, request, {
      ...options,
      output: { kind: "event_extension", protectedStory: {
        narration: "N".repeat(200_000), scratchpad: "", continuitySummary: "", openThreads: []
      }, narrationCharacterLimit: 200_000 }
    })).toThrow(expect.objectContaining({ code: "extension_narration_limit_exceeded" }));

    expect(() => serializeCheckedProviderRequest(profile, request, {
      ...options,
      output: { kind: "story_replace" }
    })).not.toThrow();
  });
});
