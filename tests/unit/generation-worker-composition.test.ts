import { describe, expect, it, vi } from "vitest";
import { createGenerationExecutionCollaborators } from "../../services/runtime/src/generation-worker-composition.js";

describe("generation worker provider composition", () => {
  it("resolves and forwards the complete stored story-text plan to shared execution", async () => {
    const ownerUserId = "00000000-0000-4000-8000-000000000001";
    const providerProfileId = "00000000-0000-4000-8000-000000000002";
    const resolution = {
      status: "resolved" as const,
      requestedRole: "text" as const,
      resolvedRole: "text" as const,
      providerProfileId,
      providerType: "openai_compatible" as const,
      routingSource: "models" as const,
      model: "story-primary",
      fallbackModels: ["story-fallback"],
      preset: null,
      providerPolicy: {}
    };
    const execution = { text: vi.fn(async () => ({ execute: vi.fn() })) };
    const providers = {
      resolution: { resolveDirect: vi.fn(async () => resolution) },
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

    await collaborators.loadTextExecution(ownerUserId, providerProfileId);

    expect(providers.resolution.resolveDirect).toHaveBeenCalledWith({
      ownerUserId,
      providerRole: "text",
      selectedProviderProfileId: providerProfileId
    });
    expect(execution.text).toHaveBeenCalledWith({ ownerUserId }, resolution);
  });
});
