import { describe, expect, it, vi } from "vitest";
import { getProviderOutputSchemaV2, type SchemaVerificationV2 } from "@infinite-quest/contracts";
import { logger } from "../../packages/logger/src/index.js";
import { ProviderTransportError, type ProviderRequest, type ProviderResult } from "../../packages/story-engine/src/providers.js";
import { serializeLegacyProviderRequest } from "../../packages/story-engine/src/provider-request.js";
import { serializeProviderRequest } from "../../packages/story-engine/src/provider-request.js";
import { estimatedInputSafetyAllowanceTokens } from "../../packages/story-engine/src/provider-request.js";
import { estimateStoryTokens } from "../../packages/story-engine/src/token-estimate.js";
import { sourceDocumentFromNormalizedText } from "../../packages/domain/src/source-authoring.js";
import { planSourceChunks } from "../../packages/domain/src/source-authoring-budget.js";
import type { RuntimeTextExecution } from "../../services/runtime/src/provider-credential-transport-adapter.js";
import { renderSourceExtractionProviderRequest } from "../../services/runtime/src/source-authoring-adapter.js";
import {
  prepareAuthoringResponseContractExecution,
  renderPreparedAuthoringRequest,
  serializePreparedAuthoringRequest
} from "../../services/runtime/src/authoring-text-execution-preparation.js";
import { capabilityRouteConfigHash } from "../../services/runtime/src/provider-capability-cache.js";
import { createProviderResponseFormatCapabilities } from "../../services/runtime/src/provider-response-format-capabilities.js";
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
  it("plans chunks from the schema-bearing body and dispatches the identical checked body", async () => {
    const provider = execution({
      id: "11111111-1111-4111-8111-111111111111",
      providerType: "openrouter", contextWindowTokens: 4_000, maxOutputTokens: 256,
      endpointIdentity: "endpoint-1", executionRevision: "profile-1", authorityRevision: "authority-1",
      textSelection: { kind: "openrouter_preset", slug: "source-authoring" }
    });
    const prepared = await prepareAuthoringResponseContractExecution({
      ownerUserId: "owner-1", execution: provider,
      operationPrompts: {
        sourceExtraction: "Extract cited facts.",
        sourceExtractionRepair: "Repair cited facts."
      },
      ports: {
        resolvePreset: async () => ({
          slug: "source-authoring", name: "Source authoring", versionId: "v1", version: 1,
          configHash: "a".repeat(64), config: { models: ["authoring-model"] },
          systemPrompt: "Frozen source contract."
        }),
        discoverModels: async () => [{ id: "authoring-model", contextWindowTokens: 4_000, maxOutputTokens: 256 }]
      }
    });
    const dispatched: string[] = [];
    const requestBudget = createRuntimeSourceAuthoringRequestBudget(provider, undefined, undefined, {
      renderInitial: (request) => renderPreparedAuthoringRequest({ execution: provider, prepared, operation: "sourceExtraction", request }),
      renderRepair: (request) => renderPreparedAuthoringRequest({ execution: provider, prepared, operation: "sourceExtractionRepair", request }),
      prepareInitial: (request) => serializePreparedAuthoringRequest({ execution: provider, prepared, operation: "sourceExtraction", request }),
      prepareRepair: (request) => serializePreparedAuthoringRequest({ execution: provider, prepared, operation: "sourceExtractionRepair", request }),
      executeInitial: async (_request, checked) => {
        dispatched.push(checked.body);
        return { content: "{}", responseId: "initial", finishReason: "stop", outputLimited: false, modelInstanceId: "authoring-model", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, reportedCost: null, rawMetadata: {} };
      },
      executeRepair: async (_request, checked) => {
        dispatched.push(checked.body);
        return { content: "{}", responseId: "repair", finishReason: "stop", outputLimited: false, modelInstanceId: "authoring-model", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, reportedCost: null, rawMetadata: {} };
      }
    });
    const source = sourceDocumentFromNormalizedText(
      "source.txt",
      Array.from({ length: 12 }, (_, index) => `Paragraph ${index}: ${"source evidence ".repeat(18)}`).join("\n\n"),
      "source-1"
    );
    const render = (frame: Parameters<NonNullable<Parameters<typeof planSourceChunks>[0]["renderRequest"]>>[0]) => {
      const request = renderSourceExtractionProviderRequest({
        instructions: frame.instructions, sourceText: frame.sourceText,
        sourceRange: frame.sourceRange ?? { start: 0, end: 0 }, paragraphSpans: frame.paragraphSpans ?? [],
        mode: frame.mode ?? "faithful", repair: frame.repair, issues: []
      }, frame.repair ? prepared.plans.sourceExtractionRepair : prepared.plans.sourceExtraction);
      return requestBudget.render(request);
    };
    const chunks = planSourceChunks({
      source, boundaryParagraphId: source.paragraphs.at(-1)!.id,
      systemPrompt: "", instructions: "Keep exact evidence.", budget: requestBudget.budget,
      includeChunkCoordinates: true, mode: "faithful", renderRequest: render
    });
    const noSchemaChunks = planSourceChunks({
      source, boundaryParagraphId: source.paragraphs.at(-1)!.id,
      systemPrompt: "", instructions: "Keep exact evidence.", budget: requestBudget.budget,
      includeChunkCoordinates: true, mode: "faithful",
      renderRequest: (frame) => serializeProviderRequest({ ...provider, baseUrl: "https://source.test" }, renderSourceExtractionProviderRequest({
        instructions: frame.instructions, sourceText: frame.sourceText,
        sourceRange: frame.sourceRange ?? { start: 0, end: 0 }, paragraphSpans: frame.paragraphSpans ?? [],
        mode: frame.mode ?? "faithful", repair: frame.repair, issues: []
      }, frame.repair ? prepared.plans.sourceExtractionRepair : prepared.plans.sourceExtraction), { responseFormat: false }).body
    });

    expect(chunks[0]!.sourceRange.end).toBeLessThan(noSchemaChunks[0]!.sourceRange.end);
    const chunk = chunks[0]!;
    const request = renderSourceExtractionProviderRequest({
      instructions: "Keep exact evidence.",
      sourceText: Array.from(source.text).slice(chunk.sourceRange.start, chunk.sourceRange.end).join(""),
      sourceRange: chunk.sourceRange, paragraphSpans: chunk.spans, mode: "faithful", repair: false, issues: []
    }, prepared.plans.sourceExtraction);
    const measuredBody = requestBudget.render(request);
    const checked = requestBudget.prepareInitial(request);
    await requestBudget.executeInitial(request);
    expect(checked.body).toBe(measuredBody);
    expect(dispatched).toEqual([measuredBody]);
    expect(JSON.parse(measuredBody).response_format.json_schema.name).toBe(getProviderOutputSchemaV2("source_extraction").name);
    expect(measuredBody.match(/Frozen source contract\./g)).toHaveLength(1);
    const measuredTokens = estimateStoryTokens(measuredBody);
    expect(measuredTokens + estimatedInputSafetyAllowanceTokens(measuredTokens)).toBeLessThanOrEqual(requestBudget.inputLimit);

    const rejectedCanary = "REJECTED_SOURCE_DRAFT_CANARY";
    const repairRequest: ProviderRequest = {
      ...request,
      recoveryInput: "Correct the cited facts.",
      rejectedResponse: JSON.stringify({ facts: Array.from({ length: 500 }, () => rejectedCanary) })
    };
    const oversizedDiagnosticBody = requestBudget.render(repairRequest);
    const checkedRepair = requestBudget.prepareRepair(repairRequest);
    await requestBudget.executeRepair(repairRequest);
    expect(oversizedDiagnosticBody).toContain(rejectedCanary);
    expect(checkedRepair.droppedRejectedResponse).toBe(true);
    expect(checkedRepair.body).not.toContain(rejectedCanary);
    const repairBody = JSON.parse(checkedRepair.body);
    expect(repairBody.response_format.json_schema.name).toBe(getProviderOutputSchemaV2("source_extraction").name);
    expect(repairBody.messages[0].content).toBe("Frozen source contract.\n\nRepair cited facts.");
    expect(dispatched.at(-1)).toBe(checkedRepair.body);
  });

  it.each(["preset", "model"] as const)("rejects an oversized selected native %s chunk before prepared execution", async (routeKind) => {
    const provider = execution({
      id: "22222222-2222-4222-8222-222222222222",
      providerType: "openrouter", contextWindowTokens: 1_200, maxOutputTokens: 256,
      endpointIdentity: "oversize-endpoint", executionRevision: "oversize-profile", authorityRevision: "oversize-authority",
      textSelection: routeKind === "preset"
        ? { kind: "openrouter_preset", slug: "source-authoring" }
        : { kind: "model", modelId: "authoring-model" }
    });
    const schema = getProviderOutputSchemaV2("source_extraction");
    const verification: SchemaVerificationV2 = {
      version: 2, providerType: "openrouter", endpointIdentity: "oversize-endpoint", model: "authoring-model",
      routeConfigHash: capabilityRouteConfigHash({}), adapterProtocol: "text-schema-adapter-v2",
      operation: "source_extraction", schemaHash: schema.schemaHash, streaming: false,
      verifiedAt: "2026-09-19T00:00:00.000Z", expiresAt: "2027-09-19T00:00:00.000Z",
      providerRoutingSlugs: [], nativeOpenTrackerObjects: true
    };
    const prepared = await prepareAuthoringResponseContractExecution({
      ownerUserId: "owner-1", execution: provider,
      operationPrompts: { sourceExtraction: "Extract cited facts.", sourceExtractionRepair: "Repair cited facts." },
      ports: {
        resolvePreset: async () => ({ slug: "source-authoring", name: "Source authoring", versionId: "v1", version: 1, configHash: "e".repeat(64), config: { models: ["authoring-model"] }, systemPrompt: "Frozen source contract." }),
        discoverModels: async () => [{
          id: "authoring-model", contextWindowTokens: 1_200, maxOutputTokens: 256,
          ...(routeKind === "model" ? { responseFormatAdvertisement: { supportedParameters: ["response_format", "structured_outputs"], discoveredAt: "2026-09-20T00:00:00.000Z" } } : {})
        }]
      },
      ...(routeKind === "model" ? {
        responseFormatCapabilities: createProviderResponseFormatCapabilities({
          records: [verification], now: () => Date.parse("2026-09-20T00:00:00.000Z")
        })
      } : {})
    });
    const preparedExecutor = vi.fn(async () => ({ content: "{}", responseId: "must-not-run", finishReason: "stop", outputLimited: false, modelInstanceId: "authoring-model", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, reportedCost: null, rawMetadata: {} } satisfies ProviderResult));
    const requestBudget = createRuntimeSourceAuthoringRequestBudget(provider, undefined, undefined, {
      renderInitial: (request) => renderPreparedAuthoringRequest({ execution: provider, prepared, operation: "sourceExtraction", request }),
      renderRepair: (request) => renderPreparedAuthoringRequest({ execution: provider, prepared, operation: "sourceExtractionRepair", request }),
      prepareInitial: (request) => serializePreparedAuthoringRequest({ execution: provider, prepared, operation: "sourceExtraction", request }),
      prepareRepair: (request) => serializePreparedAuthoringRequest({ execution: provider, prepared, operation: "sourceExtractionRepair", request }),
      executeInitial: preparedExecutor,
      executeRepair: preparedExecutor
    });
    const oversizedSelectedChunk = {
      systemPrompt: prepared.plans.sourceExtraction!.prompt,
      input: "Selected source chunk: " + "oversized evidence ".repeat(300)
    };
    const uncheckedSearchBody = requestBudget.render(oversizedSelectedChunk);
    expect(JSON.parse(uncheckedSearchBody).response_format.json_schema.name).toBe(schema.name);
    const uncheckedTokens = estimateStoryTokens(uncheckedSearchBody);
    expect(uncheckedTokens + estimatedInputSafetyAllowanceTokens(uncheckedTokens)).toBeGreaterThan(requestBudget.inputLimit);
    await expect(requestBudget.executeInitial(oversizedSelectedChunk)).rejects.toThrow(/context|budget|requires/i);
    expect(preparedExecutor).not.toHaveBeenCalled();
  });
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
