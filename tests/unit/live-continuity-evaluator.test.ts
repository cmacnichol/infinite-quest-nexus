import { expect, it, vi } from "vitest";
import { evaluateLiveCopiedRequest } from "../../scripts/lib/live-continuity-evaluator.js";
import { serializeProviderRequest } from "../../packages/story-engine/src/provider-request.js";
import type { RuntimeTextExecution } from "../../services/runtime/src/provider-credential-transport-adapter.js";

function fixture() {
  const configuration = { explicitLive: true as const, providerId: "provider", providerModel: "model", scenarioVersion: "heldout-v1", sourceCampaignId: "source", copiedCampaignId: "copy", maxCalls: 2, maxInputTokens: 100_000, maxOutputTokens: 2000, maxCostUsd: 0 };
  const profile = { id: "provider", name: "fixture", providerRole: "text" as const, providerType: "openai_compatible" as const, model: "model", contextWindowTokens: 65_536, maxOutputTokens: 1000, temperature: 0, configuration: {}, requestTimeoutMs: 1000 };
  const prepared = serializeProviderRequest({ ...profile, baseUrl: "" }, { systemPrompt: "Return a story.", input: "Continue the copied story." });
  const execute = vi.fn(async () => ({ content: JSON.stringify({ narration: "The lantern glows.", choices: ["Wait.", "Look.", "Listen.", "Leave."], custom_action_suggestion: "Observe.", scratchpad: "", continuity_summary: "The lantern glows.", canonical_facts: [], canonical_fact_updates: [], superseded_facts: [], open_threads: [] }), responseId: "response", finishReason: "stop", outputLimited: false, modelInstanceId: "model", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, reportedCost: null, rawMetadata: {}, preparedRequest: prepared }));
  const provider: RuntimeTextExecution = { ...profile, execute };
  const source = { campaignId: "copy", sourceCampaignId: "source", providerId: "provider", providerModel: "model", requestBody: prepared.body, requestPayloadHash: prepared.payloadHash };
  return { configuration, provider, source, execute };
}

it("executes explicitly pinned copied requests within pre-dispatch ceilings and leaves acceptance to later review", async () => {
  const input = fixture();
  const result = await evaluateLiveCopiedRequest({ ...input.configuration, maxInputTokens: Buffer.byteLength(input.source.requestBody) }, input.source, input.provider, { inputUsdPerMillion: 0, outputUsdPerMillion: 0 });
  expect(input.execute).toHaveBeenCalledTimes(1);
  expect(result.report).toMatchObject({ attempts: 1, valid: 1, acceptedStateMutation: false, adjudication: "pending_blinded_review" });
  expect(JSON.stringify(result.report)).not.toContain("The lantern");
});

it("rejects source-campaign execution, changed provider settings and unknown prices before any provider call", async () => {
  const input = fixture();
  const price = { inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
  await expect(evaluateLiveCopiedRequest(input.configuration, { ...input.source, campaignId: "source" }, input.provider, price)).rejects.toThrow(/copied campaign/);
  await expect(evaluateLiveCopiedRequest(input.configuration, input.source, { ...input.provider, temperature: 0.5 }, price)).rejects.toThrow(/settings/);
  await expect(evaluateLiveCopiedRequest(input.configuration, input.source, input.provider, { ...price, outputUsdPerMillion: Number.NaN })).rejects.toThrow(/prices/);
  expect(input.execute).not.toHaveBeenCalled();
});

it("counts unavailable attempts and charges their full reservation instead of silently retrying", async () => {
  const input = fixture(); input.execute.mockRejectedValue(new Error("private provider failure"));
  const result = await evaluateLiveCopiedRequest(input.configuration, input.source, input.provider, { inputUsdPerMillion: 0, outputUsdPerMillion: 0 });
  expect(input.execute).toHaveBeenCalledTimes(2);
  expect(result.report).toMatchObject({ attempts: 2, unavailable: 2, valid: 0 });
  expect(JSON.stringify(result)).not.toContain("private provider failure");
});

it("counts a replayed v3 paragraph-wire capture as valid instead of failing schema on the unmerged array", async () => {
  const input = fixture();
  const original = await input.execute();
  input.execute.mockClear();
  input.execute.mockResolvedValue({ ...original, content: JSON.stringify({ narration_paragraphs: ["The lantern glows.", "It flickers once."], choices: ["Wait.", "Look.", "Listen.", "Leave."], custom_action_suggestion: "Observe.", scratchpad: "", continuity_summary: "The lantern glows.", canonical_facts: [], canonical_fact_updates: [], superseded_facts: [], open_threads: [] }) });
  const result = await evaluateLiveCopiedRequest(input.configuration, input.source, input.provider, { inputUsdPerMillion: 0, outputUsdPerMillion: 0 });
  expect(input.execute).toHaveBeenCalledTimes(2);
  expect(result.report).toMatchObject({ attempts: 2, valid: 2 });
});

it("stops after a wire mismatch or usage exceeding the reservation", async () => {
  for (const reason of ["wire", "usage"] as const) {
    const input = fixture();
    const original = await input.execute();
    input.execute.mockClear();
    input.execute.mockResolvedValue({ ...original, ...(reason === "wire"
      ? { preparedRequest: { ...original.preparedRequest!, payloadHash: "0".repeat(64) } }
      : { usage: { inputTokens: 1, outputTokens: 1001, totalTokens: 1002 } }) });
    await expect(evaluateLiveCopiedRequest(input.configuration, input.source, input.provider,
      { inputUsdPerMillion: 0, outputUsdPerMillion: 0 })).rejects.toThrow(/reserved|reservation/);
    expect(input.execute).toHaveBeenCalledTimes(1);
  }
});
