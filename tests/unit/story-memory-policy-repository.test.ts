import { describe, expect, it } from "vitest";
import { resolveStoryMemoryPolicySnapshot, type StoryMemoryOperatorConfig } from "../../packages/database/src/story-memory-policy-repository.js";

describe("Story Memory new-job enrollment", () => {
  it("captures V3 history for a newly eligible cast-enabled snapshot", async () => {
    const client = {
      query: async () => ({ rows: [{
        capability: "r2", review_mode: "off", model: "writer", provider_type: "openai_compatible",
        base_url: "http://provider.example", context_window_tokens: 32_000, max_output_tokens: 4_096,
        temperature: 0, request_timeout_ms: 30_000, configuration: {}
      }] })
    };

    await expect(resolveStoryMemoryPolicySnapshot(client as never, {
      ownerUserId: "00000000-0000-4000-8000-000000000001",
      campaignId: "00000000-0000-4000-8000-000000000002",
      providerProfileId: "00000000-0000-4000-8000-000000000003",
      requestedModel: ""
    }, { installedCapability: "r3", enforceEnabled: false, castContextEnabled: true }))
      .resolves.toMatchObject({ castContext: true, contextProtocol: "current-continuity-v9", promptProtocol: "story-v19-state-edit-precedence" });
  });

  it("uses V3 cast context when history coverage is disabled without rewriting a captured V3 history snapshot", async () => {
    const client = {
      query: async () => ({ rows: [{
        capability: "r2", review_mode: "off", model: "writer", provider_type: "openai_compatible",
        base_url: "http://provider.example", context_window_tokens: 32_000, max_output_tokens: 4_096,
        temperature: 0, request_timeout_ms: 30_000, configuration: {}
      }] })
    };
    const scope = {
      ownerUserId: "00000000-0000-4000-8000-000000000001",
      campaignId: "00000000-0000-4000-8000-000000000002",
      providerProfileId: "00000000-0000-4000-8000-000000000003",
      requestedModel: ""
    };
    const historyConfig = { installedCapability: "r3", enforceEnabled: false, castContextEnabled: true } satisfies StoryMemoryOperatorConfig;
    const castOnlyConfig = { ...historyConfig, historyCoverageEnabled: false } satisfies StoryMemoryOperatorConfig;

    const history = await resolveStoryMemoryPolicySnapshot(client as never, scope, historyConfig);
    const castOnly = await resolveStoryMemoryPolicySnapshot(client as never, scope, castOnlyConfig);

    expect(history).toMatchObject({ contextProtocol: "current-continuity-v9" });
    expect(castOnly).toMatchObject({ castContext: true, contextProtocol: "current-continuity-v8", promptProtocol: "story-v19-state-edit-precedence" });
    expect(history).toMatchObject({ contextProtocol: "current-continuity-v9" });
  });
});
