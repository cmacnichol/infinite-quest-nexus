import { describe, expect, it, vi } from "vitest";
import { createGenerationExecutionCollaborators } from "../../services/runtime/src/generation-worker-composition.js";

describe("generation worker provider composition", () => {
  it("forwards only the stored story-text plan to shared execution", async () => {
    const ownerUserId = "00000000-0000-4000-8000-000000000001";
    const providerProfileId = "00000000-0000-4000-8000-000000000002";
    const routing = {
      requestedModel: "story-primary",
      configuredModels: ["story-primary", "story-fallback"],
      routingSource: "models" as const,
      presetSlug: null,
      presetVersion: null,
      presetConfigHash: null,
      providerPolicy: {},
      providerPolicyHash: "policy-hash",
      providerType: "openai_compatible"
    };
    const execution = { text: vi.fn(async () => ({ execute: vi.fn() })) };
    const providers = {
      resolution: { resolveDirect: vi.fn() },
      execution,
      promptTools: { content: vi.fn() },
      costs: { recordGenerationCost: vi.fn() },
      costContext: vi.fn(),
      attributeCosts: { attributeGenerationCostsToTurn: vi.fn() }
    };
    const collaborators = createGenerationExecutionCollaborators(
      {} as never,
      { generation: {} } as never,
      { generation: {} } as never,
      providers as never,
    );

    await collaborators.loadTextExecution(ownerUserId, providerProfileId, routing);

    expect(providers.resolution.resolveDirect).not.toHaveBeenCalled();
    expect(execution.text).toHaveBeenCalledWith({ ownerUserId }, expect.objectContaining({
      providerProfileId,
      providerType: "openai_compatible",
      model: "story-primary",
      fallbackModels: ["story-fallback"],
      routingSource: "models"
    }));
  });
});
