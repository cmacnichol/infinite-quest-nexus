import { describe, expect, it } from "vitest";
import { resolveStoryMemoryPolicySnapshot, type StoryMemoryOperatorConfig } from "../../packages/database/src/story-memory-policy-repository.js";

describe("Story Memory new-job enrollment", () => {
  it("captures v7 only for a newly eligible cast-enabled snapshot", async () => {
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
      .resolves.toMatchObject({ castContext: true, contextProtocol: "current-continuity-v7", promptProtocol: "story-v18-fiction-cast" });
  });

  it("uses v6 when history coverage is disabled without rewriting a captured v7 snapshot", async () => {
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
    const v5Config = { installedCapability: "r3", enforceEnabled: false, castContextEnabled: true } satisfies StoryMemoryOperatorConfig;
    const v4DefaultConfig = { ...v5Config, historyCoverageEnabled: false } satisfies StoryMemoryOperatorConfig;

    const v5 = await resolveStoryMemoryPolicySnapshot(client as never, scope, v5Config);
    const v4 = await resolveStoryMemoryPolicySnapshot(client as never, scope, v4DefaultConfig);

    expect(v5).toMatchObject({ contextProtocol: "current-continuity-v7" });
    expect(v4).toMatchObject({ castContext: true, contextProtocol: "current-continuity-v6", promptProtocol: "story-v18-fiction-cast" });
    expect(v5).toMatchObject({ contextProtocol: "current-continuity-v7" });
  });
});
