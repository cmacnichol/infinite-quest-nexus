import { describe, expect, it, vi } from "vitest";
import { prepareCastDiscoveryExecution, createCastDiscoveryExtractor } from "../../services/runtime/src/campaign-cast-discovery-adapter.js";
import { buildCastDiscoverySource } from "../../packages/domain/src/campaign-cast-discovery.js";
import { CAST_DISCOVERY_SYSTEM_PROMPT } from "../../packages/contracts/src/prompt-library.js";
import type { RuntimeTextExecution } from "../../services/runtime/src/provider-credential-transport-adapter.js";
import type { CastDiscoveryClaim } from "../../packages/application/src/campaign-cast/discovery.js";
import type { PreparedAuthoringTextExecutor } from "../../services/runtime/src/authoring-text-execution-preparation.js";
import { createProviderResponseFormatCapabilities } from "../../services/runtime/src/provider-response-format-capabilities.js";
import { capabilityRouteConfigHash } from "../../services/runtime/src/provider-capability-cache.js";
import { getProviderOutputSchemaV2 } from "../../packages/contracts/src/provider-output-schema.js";
import { deriveTextExecutionPlan } from "../../packages/contracts/src/text-execution-plan.js";
import { PreparedRouteTerminalError } from "../../packages/story-engine/src/preset-route-execution.js";

const id = "11111111-1111-4111-8111-111111111111";
const result = { content: '{"version":1,"characters":[]}', responseId: "fixture", finishReason: "stop", outputLimited: false,
  modelInstanceId: "fixture", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, reportedCost: null, rawMetadata: {} };
function fixture() {
  const execution: RuntimeTextExecution = { id, name: "Fixture", providerRole: "text", providerType: "openrouter", model: "fixture",
    contextWindowTokens: 32768, maxOutputTokens: 2048, temperature: 0.2, requestTimeoutMs: 120000, configuration: {},
    executionRevision: "revision", authorityRevision: "authority", endpointIdentity: "endpoint",
    textSelection: { kind: "openrouter_preset", slug: "fixture" }, execute: vi.fn(async () => result) };
  const ports = { resolvePreset: vi.fn(async () => ({ slug: "fixture", name: "Fixture", versionId: "v1", version: 1,
    configHash: "a".repeat(64), config: { model: "frozen-model" }, systemPrompt: "Frozen preset." })),
    discoverModels: vi.fn(async () => [{ id: "frozen-model", contextWindowTokens: 32768, maxOutputTokens: 2048 }]) };
  return { execution, ports };
}
async function claim(narration = "Mara waits.") {
  const f = fixture(), scope = { ownerUserId: id, campaignId: id };
  const frozen = await prepareCastDiscoveryExecution({ ownerUserId: id, ...f });
  const value: CastDiscoveryClaim = { id, scope, execution: frozen, chunkOrdinal: 0, chunkCount: 1, attempt: 1, leaseToken: id, output: null,
    source: buildCastDiscoverySource({ scope, turnId: id, turnNumber: 1, narrationRevision: 0, timelineRevision: 0, narration }),
    identities: { revision: 0, characters: [], worldVersionId: id, worldCharacters: [] } };
  return { ...f, value };
}
describe("cast discovery runtime execution", () => {
  it("requires exact direct-model schema verification and freezes its checked request", async () => {
    const f = fixture();
    const execution = { ...f.execution, model: "frozen-model", textSelection: { kind: "model" as const, modelId: "frozen-model" } };
    const ports = { ...f.ports, async discoverModels() { return [{ id: "frozen-model", contextWindowTokens: 32768, maxOutputTokens: 2048,
      responseFormatAdvertisement: { supportedParameters: ["response_format", "structured_outputs"], discoveredAt: "2026-09-20T00:00:00.000Z" } }]; } };
    await expect(prepareCastDiscoveryExecution({ ownerUserId: id, execution, ports })).rejects.toThrow();
    const responseFormatCapabilities = createProviderResponseFormatCapabilities({ now: () => Date.parse("2026-09-20T00:00:00.000Z"), records: [{
      version: 2, providerType: "openrouter", endpointIdentity: "endpoint", model: "frozen-model", routeConfigHash: capabilityRouteConfigHash({}),
      adapterProtocol: "text-schema-adapter-v2", operation: "cast_discovery", schemaHash: getProviderOutputSchemaV2("cast_discovery").schemaHash,
      streaming: false, verifiedAt: "2026-09-19T00:00:00.000Z", expiresAt: "2027-09-19T00:00:00.000Z", providerRoutingSlugs: [], nativeOpenTrackerObjects: true
    }] });
    const saved = await prepareCastDiscoveryExecution({ ownerUserId: id, execution, ports, responseFormatCapabilities });
    const c = await claim(); c.value.execution = saved;
    const execute = vi.fn<PreparedAuthoringTextExecutor["execute"]>(async () => result);
    await createCastDiscoveryExtractor({ executor: { execute } }).extract(c.value);
    expect(execute.mock.calls[0]![0].preparedRequest?.body).toContain("infinite_quest_cast_discovery_v1");
    expect(f.ports.resolvePreset).not.toHaveBeenCalled();
    execute.mockClear();
    c.value.execution.plan = deriveTextExecutionPlan(saved.admission!.routeBasis, "Changed prompt with a valid new hash.");
    await expect(createCastDiscoveryExtractor({ executor: { execute } }).extract(c.value)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  it("freezes a distinct nonstream discovery plan before dispatch", async () => {
    const f = fixture();
    const saved = await prepareCastDiscoveryExecution({ ownerUserId: id, ...f });
    expect(saved.plan).toMatchObject({ protocolVersion: "cast-discovery-v1", requestTimeoutMs: 120000,
      candidates: [{ modelId: "frozen-model", maxOutputTokens: 2048 }] });
    expect(saved.plan.prompt).toContain(CAST_DISCOVERY_SYSTEM_PROMPT);
    expect(saved.admission?.frozenResponseContracts.contracts["cast_discovery:nonstream"]).toBeDefined();
    expect(f.execution.execute).not.toHaveBeenCalled(); expect(f.ports.resolvePreset).toHaveBeenCalledTimes(1);
  });
  it("caps large profile and preset output allowances before freezing the request", async () => {
    const f = fixture();
    const execution = { ...f.execution, maxOutputTokens: 48000, contextWindowTokens: 163840 };
    f.ports.discoverModels.mockResolvedValue([{ id: "frozen-model", contextWindowTokens: 163840, maxOutputTokens: 48000 }]);
    const ports = { ...f.ports, resolvePreset: async () => ({ ...(await f.ports.resolvePreset()), config: { model: "frozen-model", max_tokens: 48000 } }) };
    const saved = await prepareCastDiscoveryExecution({ ownerUserId: id, execution, ports });
    expect(saved.plan.candidates[0]?.maxOutputTokens).toBe(4096);
    const c = await claim(); c.value.execution = saved;
    const execute = vi.fn<PreparedAuthoringTextExecutor["execute"]>(async () => result);
    await createCastDiscoveryExtractor({ executor: { execute } }).extract(c.value);
    expect(JSON.parse(execute.mock.calls[0]![0].preparedRequest!.body).max_tokens).toBe(4096);
  });
  it.each([0, 2])("dispatches checked frozen bytes with retry generation %i and bounded fiction input", async (retryGeneration) => {
    const f = await claim();
    f.value.retryGeneration = retryGeneration;
    const execute = vi.fn<PreparedAuthoringTextExecutor["execute"]>(async () => result);
    const extractor = createCastDiscoveryExtractor({ executor: { execute } });
    expect(await extractor.extract(f.value)).toEqual({ version: 1, characters: [] });
    const call = execute.mock.calls[0]![0];
    expect(call.logicalReservation).toEqual({ kind: "cast_discovery", ownerUserId: id, jobId: id, chunkOrdinal: 0, claimAttempt: 1,
      ...(retryGeneration ? { retryGeneration } : {}), leaseToken: id });
    expect(call.operation).toBe("cast_discovery"); expect(call.invocationKey).toBe("cast_discovery:nonstream");
    expect(call.preparedRequest?.body).toContain('"response_format"');
    expect(call.preparedRequest?.body).toContain("Mara waits.");
    expect(call.request.input).not.toContain(id);
    expect(f.execution.execute).not.toHaveBeenCalled(); expect(f.ports.resolvePreset).toHaveBeenCalledTimes(1);
  });
  it("refuses an oversized complete request before a paid call", async () => {
    const f = await claim("Mara waits. ".repeat(30000));
    const execute = vi.fn<PreparedAuthoringTextExecutor["execute"]>(async () => result);
    await expect(createCastDiscoveryExtractor({ executor: { execute } }).extract(f.value)).rejects.toMatchObject({ diagnostic: "source_requires_manual_scan" });
    expect(execute).not.toHaveBeenCalled();
  });
  it("rejects incomplete provider output instead of accepting empty coverage", async () => {
    const f = await claim();
    const execute = vi.fn<PreparedAuthoringTextExecutor["execute"]>(async () => ({ ...result, outputLimited: true }));
    expect(await createCastDiscoveryExtractor({ executor: { execute } }).extract(f.value)).toBeNull();
  });
  it("fails closed for snapshots without frozen admission", async () => {
    const f = await claim(); delete f.value.execution.admission;
    const execute = vi.fn<PreparedAuthoringTextExecutor["execute"]>(async () => result);
    await expect(createCastDiscoveryExtractor({ executor: { execute } }).extract(f.value)).rejects.toMatchObject({ diagnostic: "provider_failed" });
    expect(execute).not.toHaveBeenCalled();
  });
  it("reports a capacity deadline as provider_timeout", async () => {
    const f = await claim();
    const execute = vi.fn<PreparedAuthoringTextExecutor["execute"]>(async () => {
      throw new PreparedRouteTerminalError("prepared_route_deadline_exceeded", "deadline", "Capacity deadline exceeded");
    });
    await expect(createCastDiscoveryExtractor({ executor: { execute } }).extract(f.value)).rejects.toMatchObject({ diagnostic: "provider_timeout" });
  });
});
