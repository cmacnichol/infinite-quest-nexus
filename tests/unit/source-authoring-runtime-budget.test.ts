import { describe, expect, it, vi } from "vitest";
import { logger } from "../../packages/logger/src/index.js";
import { ProviderTransportError, type ProviderRequest, type ProviderResult } from "../../packages/story-engine/src/providers.js";
import { serializeLegacyProviderRequest } from "../../packages/story-engine/src/provider-request.js";
import type { RuntimeTextExecution } from "../../services/runtime/src/provider-credential-transport-adapter.js";
import {
  createRuntimeSourceAuthoringRequestBudget,
  resolveSourceAuthoringTextExecution,
  resolveAuthoringContextWindowTokens
} from "../../services/runtime/src/source-authoring-budget.js";

function execution(overrides: Partial<RuntimeTextExecution> = {}): RuntimeTextExecution {
  return {
    id: "text-profile",
    name: "Synthetic",
    providerRole: "text",
    providerType: "openai_compatible",
    model: "authoring-model",
    contextWindowTokens: 650,
    maxOutputTokens: 100,
    temperature: 0.2,
    requestTimeoutMs: 30_000,
    configuration: {},
    execute: vi.fn(async () => ({ content: "{}", responseId: "response", finishReason: "stop", outputLimited: false, modelInstanceId: "authoring-model", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, reportedCost: null, rawMetadata: {} } satisfies ProviderResult)),
    ...overrides
  };
}

const initialRequest: ProviderRequest = {
  systemPrompt: "Schema: {\"facts\": []}.",
  input: "Instructions: retain the source quote \"blue 😀 coat\"."
};

describe("runtime source authoring request budget", () => {
  it("records the completed response ID when the provider sends no generation header", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    try {
      await createRuntimeSourceAuthoringRequestBudget(execution(), undefined, { authoringJobId: "job", stageKey: "source:chunk:0" }).executeInitial(initialRequest);
      expect(info.mock.calls.map(([event]) => event)).toContainEqual(expect.objectContaining({ event: "authoring_provider_completed", providerResponseId: "response" }));
    } finally { info.mockRestore(); }
  });

  it.each([false, true])("records a timeout with headersReceived=%s without losing the original error", async (headersReceived) => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const error = new ProviderTransportError("PRIVATE ERROR", { providerType: "openrouter", operation: "source", endpoint: "https://private.test", model: "model", timeoutMs: 300_000, durationMs: 300_000, timedOut: true, transportCode: "UND_ERR_BODY_TIMEOUT", causeCategory: "timeout", causeMessage: "PRIVATE CAUSE" });
    const provider = execution({ execute: async (request) => {
      if (headersReceived) request.onResponseHeaders?.({ statusCode: 200, providerResponseId: "gen-timeout" });
      throw error;
    } });
    try {
      await expect(createRuntimeSourceAuthoringRequestBudget(provider, undefined, { authoringJobId: "job", stageKey: "source:chunk:0" }).executeInitial(initialRequest)).rejects.toBe(error);
      expect(warn.mock.calls.map(([event]) => event)).toContainEqual(expect.objectContaining({ event: "authoring_provider_failed", authoringJobId: "job", headersReceived, diagnosticCode: "provider_request_timeout", transportCode: "UND_ERR_BODY_TIMEOUT", timeoutMs: 300_000 }));
      expect(JSON.stringify([...warn.mock.calls, ...info.mock.calls])).not.toContain("PRIVATE");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("private.test");
    } finally { info.mockRestore(); warn.mockRestore(); }
  });

  it("logs request settings, headers and usage without changing the wire payload or exposing content", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const context = { authoringJobId: "job", stageKey: "source:chunk:0", stageGeneration: 2 };
    const provider = execution({ contextWindowTokens: 10_000, execute: async (request) => {
      request.onResponseHeaders?.({ statusCode: 200, providerResponseId: "gen-test" });
      expect(serializeLegacyProviderRequest(provider, request).body).toBe(serializeLegacyProviderRequest(provider, initialRequest).body);
      return { content: "PRIVATE OUTPUT", responseId: "gen-test", finishReason: "length", outputLimited: true, modelInstanceId: "model", usage: { inputTokens: 42, outputTokens: 100, totalTokens: 142 }, reportedCost: null, rawMetadata: { secret: "PRIVATE METADATA" } };
    } });
    try {
      await createRuntimeSourceAuthoringRequestBudget(provider, undefined, context).executeInitial(initialRequest);
      const events = info.mock.calls.map(([event]) => event);
      expect(events).toContainEqual(expect.objectContaining({ ...context, event: "authoring_provider_started", streaming: false, maxOutputTokens: 100, requestAttempt: 1 }));
      expect(events).toContainEqual(expect.objectContaining({ ...context, event: "authoring_provider_headers", statusCode: 200, providerResponseId: "gen-test" }));
      expect(events).toContainEqual(expect.objectContaining({ ...context, event: "authoring_provider_completed", finishReason: "length", outputLimited: true, outputTokens: 100 }));
      expect(JSON.stringify(events)).not.toContain("PRIVATE");
      expect(JSON.stringify(events)).not.toContain(initialRequest.input);
    } finally { info.mockRestore(); }
  });
  it("measures the exact escaped legacy initial request body", () => {
    const provider = execution();
    const budget = createRuntimeSourceAuthoringRequestBudget(provider);
    const prepared = budget.prepareInitial(initialRequest);
    const expected = serializeLegacyProviderRequest({
      providerType: provider.providerType,
      model: provider.model,
      maxOutputTokens: provider.maxOutputTokens,
      temperature: provider.temperature
    }, initialRequest);

    expect(prepared.body).toContain("\\\"facts\\\"");
    expect(prepared.body).toBe(expected.body);
    expect(prepared.byteLength).toBe(new TextEncoder().encode(prepared.body).length);
    expect(prepared.byteLength).toBeLessThanOrEqual(budget.inputLimit);
  });

  it("drops only the optional rejected-response diagnostic before sending an oversized repair", async () => {
    const provider = execution();
    const budget = createRuntimeSourceAuthoringRequestBudget(provider);
    const repair: ProviderRequest = {
      ...initialRequest,
      recoveryInput: "Correct the JSON evidence coordinates.",
      rejectedResponse: "x".repeat(2_000)
    };

    const prepared = budget.prepareRepair(repair);
    await budget.executeRepair(repair);
    const { rejectedResponse: _rejectedResponse, ...repairWithoutDiagnostic } = repair;
    const expected = serializeLegacyProviderRequest({
      providerType: provider.providerType,
      model: provider.model,
      maxOutputTokens: provider.maxOutputTokens,
      temperature: provider.temperature
    }, repairWithoutDiagnostic);

    expect(prepared.droppedRejectedResponse).toBe(true);
    expect(prepared.body).not.toContain("x".repeat(100));
    expect(prepared.body).toBe(expected.body);
    expect(prepared.byteLength).toBe(new TextEncoder().encode(prepared.body).length);
    expect(provider.execute).toHaveBeenCalledWith(expect.objectContaining({ recoveryInput: repair.recoveryInput }));
    expect((provider.execute as ReturnType<typeof vi.fn>).mock.calls[0]![0].rejectedResponse).toBeUndefined();
  });

  it("fails before provider execution when the fixed repair request cannot fit", async () => {
    const provider = execution({ contextWindowTokens: 250, maxOutputTokens: 100 });
    const budget = createRuntimeSourceAuthoringRequestBudget(provider);
    const repair: ProviderRequest = {
      systemPrompt: "Schema: {\"facts\": []}.",
      input: "Source ".repeat(100),
      recoveryInput: "Correct evidence."
    };

    await expect(budget.executeRepair(repair)).rejects.toMatchObject({ code: "authoring_context_exceeded" });
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it("rejects request modes that could serialize a different source body after budgeting", async () => {
    const provider = execution();
    const budget = createRuntimeSourceAuthoringRequestBudget(provider);

    await expect(budget.executeInitial({ ...initialRequest, canonicalBudgeting: true })).rejects.toMatchObject({ code: "authoring_context_exceeded" });
    await expect(budget.executeRepair({
      ...initialRequest,
      previousResponseId: "previous-response",
      recoveryInput: "Correct the evidence JSON."
    })).rejects.toMatchObject({ code: "authoring_context_exceeded" });
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it("uses a positive configured limit and clamps it only to a smaller verified model limit", () => {
    expect(resolveAuthoringContextWindowTokens(1_000)).toBe(1_000);
    expect(resolveAuthoringContextWindowTokens(1_000, 800)).toBe(800);
    expect(resolveAuthoringContextWindowTokens(1_000, 1_200)).toBe(1_000);
    expect(() => resolveAuthoringContextWindowTokens(0)).toThrow(/context/i);
    expect(() => resolveAuthoringContextWindowTokens(1_000, 0)).toThrow(/context/i);
  });

  it("projects a smaller matching selected-model inventory cap only for source authoring", async () => {
    const text = vi.fn(async (...args: unknown[]) => execution({ contextWindowTokens: args[4] as number ?? 1_000 }));
    const resolved = await resolveSourceAuthoringTextExecution({
      execution: { text } as never,
      inventory: { listModels: vi.fn(async () => ({
        models: [{ id: "other-model", name: "Other", contextWindowTokens: 256 }, { id: "authoring-model", name: "Authoring", contextWindowTokens: 400 }]
      })) },
      scope: { ownerUserId: "owner" },
      providerProfileId: "text-profile",
      model: "authoring-model"
    });

    expect(resolved.verifiedModelContextWindowTokens).toBe(400);
    expect(resolved.execution.contextWindowTokens).toBe(400);
    expect(text).toHaveBeenCalledWith({ ownerUserId: "owner" }, "text-profile", "text", "authoring-model", 400);
  });

  it("uses the configured cap when source inventory is unavailable or lacks the selected model", async () => {
    for (const inventory of [
      { listModels: vi.fn(async () => ({ models: [{ id: "other-model", name: "Other", contextWindowTokens: 256 }] })) },
      { listModels: vi.fn(async () => { throw new Error("inventory unavailable"); }) }
    ]) {
      const text = vi.fn(async () => execution({ contextWindowTokens: 1_000 }));
      const resolved = await resolveSourceAuthoringTextExecution({
        execution: { text } as never,
        inventory,
        scope: { ownerUserId: "owner" },
        providerProfileId: "text-profile",
        model: "authoring-model"
      });

      expect(resolved.verifiedModelContextWindowTokens).toBeUndefined();
      expect(resolved.execution.contextWindowTokens).toBe(1_000);
      expect(text).toHaveBeenCalledWith({ ownerUserId: "owner" }, "text-profile", "text", "authoring-model");
    }
  });
});
