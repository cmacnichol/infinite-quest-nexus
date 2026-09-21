import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { getProviderOutputSchemaV2, type SchemaVerificationV2 } from "@infinite-quest/contracts";
import { bindFrozenResponseContractInvocationV2 } from "../../packages/contracts/src/generation-response-contract.js";
import { estimatedInputSafetyAllowanceTokens } from "../../packages/story-engine/src/provider-request.js";
import { estimateStoryTokens } from "../../packages/story-engine/src/token-estimate.js";
import { capabilityRouteConfigHash } from "../../services/runtime/src/provider-capability-cache.js";
import { createProviderResponseFormatCapabilities } from "../../services/runtime/src/provider-response-format-capabilities.js";
import { prepareDirectAuthoringTextExecution } from "../../services/runtime/src/authoring-text-execution-preparation.js";
import type { ProviderResult } from "../../packages/story-engine/src/providers.js";

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const ENDPOINT_ID = "endpoint-identity";
const MODEL_ID = "openai/test-model";
const REGISTRY_DIGEST = createHash("sha256").update("direct-authoring-verifications").digest("hex");
const CONFIGURATION = { providerRouting: { only: ["openai"] } };
const ROUTE_CONFIG_HASH = capabilityRouteConfigHash(CONFIGURATION);
const ADVERTISEMENT = {
  supportedParameters: ["response_format", "structured_outputs"],
  discoveredAt: "2026-09-20T00:00:00.000Z"
} as const;

const operationCases = [
  ["worldOutline", "world_outline", "world_outline", "infinite_quest_world_outline_v1"],
  ["worldOutlineRepair", "world_outline_repair", "world_outline", "infinite_quest_world_outline_v1"],
  ["seedCharacter", "world_seed_character", "world_seed_character", "infinite_quest_world_seed_character_v1"],
  ["seedCharacterRepair", "world_seed_character_repair", "world_seed_character", "infinite_quest_world_seed_character_v1"],
  ["standaloneCharacter", "standalone_character", "standalone_character", "infinite_quest_standalone_character_v1"],
  ["standaloneCharacterRepair", "standalone_character_repair", "standalone_character", "infinite_quest_standalone_character_v1"],
  ["organizer", "character_organizer", "character_organizer", "infinite_quest_character_organizer_v1"],
  ["organizerRepair", "character_organizer_repair", "character_organizer", "infinite_quest_character_organizer_v1"]
] as const;

function providerResult(): ProviderResult {
  return {
    content: "{}", responseId: "response", finishReason: "stop", outputLimited: false,
    modelInstanceId: MODEL_ID, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    reportedCost: null, rawMetadata: {}
  };
}

function execution(selection: { kind: "model"; modelId: string } | { kind: "openrouter_preset"; slug: string } | undefined,
  limits: Readonly<{ contextWindowTokens: number; maxOutputTokens: number }> = { contextWindowTokens: 16_384, maxOutputTokens: 2_048 }) {
  return {
    id: PROFILE_ID, name: "Text", providerRole: "text" as const, providerType: "openrouter" as const,
    model: MODEL_ID, ...limits, temperature: 0.4,
    requestTimeoutMs: 30_000, endpointIdentity: ENDPOINT_ID, configuration: CONFIGURATION,
    executionRevision: "profile-revision", authorityRevision: "authority-revision",
    ...(selection === undefined ? {} : { textSelection: selection }),
    execute: vi.fn(async () => { throw new Error("legacy execution must not run"); })
  };
}

function verification(operation: Parameters<typeof getProviderOutputSchemaV2>[0]): SchemaVerificationV2 {
  return {
    version: 2, providerType: "openrouter", endpointIdentity: ENDPOINT_ID, model: MODEL_ID,
    routeConfigHash: ROUTE_CONFIG_HASH, adapterProtocol: "text-schema-adapter-v2", operation,
    schemaHash: getProviderOutputSchemaV2(operation).schemaHash, streaming: false,
    verifiedAt: "2026-09-19T00:00:00.000Z", expiresAt: "2027-09-19T00:00:00.000Z",
    providerRoutingSlugs: ["openai"], nativeOpenTrackerObjects: true
  };
}

function directCapabilities() {
  return createProviderResponseFormatCapabilities({
    records: [...new Set(operationCases.map(([, , schemaOperation]) => schemaOperation))].map(verification),
    registryDigest: REGISTRY_DIGEST,
    now: () => Date.parse("2026-09-20T00:00:00.000Z")
  });
}

function operationPrompts() {
  return Object.fromEntries(operationCases.map(([operation]) => [operation, `Operation prompt for ${operation}.`]));
}

function discoveryPorts(preset = false,
  limits: Readonly<{ contextWindowTokens: number; maxOutputTokens: number }> = { contextWindowTokens: 16_384, maxOutputTokens: 2_048 }) {
  return {
    resolvePreset: vi.fn(async () => ({
      slug: "authoring", name: "Authoring", versionId: "preset-v1", version: 1,
      configHash: "a".repeat(64), config: { models: [MODEL_ID] }, systemPrompt: "Preset instructions."
    })),
    discoverModels: vi.fn(async () => [{
      id: MODEL_ID, ...limits,
      ...(preset ? {} : { responseFormatAdvertisement: ADVERTISEMENT })
    }])
  };
}

describe("direct authoring v2 response contracts", () => {
  it("rejects a preset when native preparation is unavailable, including an explicit alias override", async () => {
    const provider = execution({ kind: "openrouter_preset", slug: "authoring" });
    await expect(prepareDirectAuthoringTextExecution({
      ownerUserId: "owner-1", execution: provider, operationPrompts: { organizer: "Organize." }
    })).rejects.toMatchObject({ code: "native_text_execution_unavailable" });
    await expect(prepareDirectAuthoringTextExecution({
      ownerUserId: "owner-1", execution: execution(undefined),
      selectionOverride: { kind: "openrouter_preset", slug: "authoring" },
      operationPrompts: { organizer: "Organize." }
    })).rejects.toMatchObject({ code: "native_text_execution_unavailable" });
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it("reports a finite native-unavailable conflict when the executor is absent despite admission", async () => {
    const provider = execution({ kind: "openrouter_preset", slug: "authoring" });
    await expect(prepareDirectAuthoringTextExecution({
      ownerUserId: "owner-1", execution: provider, operationPrompts: { organizer: "Organize." },
      options: { nativePresetPlansEnabled: true, ports: discoveryPorts() }
    })).rejects.toMatchObject({ code: "native_text_execution_unavailable", statusCode: 409 });
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["inherited concrete Model", undefined],
    ["explicit concrete Model", { kind: "model" as const, modelId: MODEL_ID }]
  ])("requires exact schemas for every %s operation and passes the canonical body unchanged", async (_label, selectionOverride) => {
    const execute = vi.fn(async (_input: unknown) => providerResult());
    const provider = execution(selectionOverride === undefined ? undefined : { kind: "openrouter_preset", slug: "ignored" });
    const ports = discoveryPorts();
    const prepared = await prepareDirectAuthoringTextExecution({
      ownerUserId: "owner-1", execution: provider, operationPrompts: operationPrompts(),
      ...(selectionOverride === undefined ? {} : { selectionOverride }),
      options: {
        nativePresetPlansEnabled: true, preparedExecutor: { execute },
        loadAuthority: async () => ({ id: PROFILE_ID, providerRole: "text", authorityRevision: "authority-revision", endpointIdentity: ENDPOINT_ID }),
        ports, responseFormatCapabilities: directCapabilities()
      } as never
    });

    expect(prepared).not.toBeNull();
    for (const [operation, semanticOperation, schemaOperation, schemaName] of operationCases) {
      await prepared!.execute({ operation, request: { systemPrompt: "untrusted", input: `input:${operation}`, responseFormatFallback: "forbid" } });
      const invocation = execute.mock.calls.at(-1)![0] as any;
      const body = JSON.parse(invocation.preparedRequest.body);
      expect(invocation.operation).toBe(semanticOperation);
      expect(invocation.invocationKey).toBe(`${schemaOperation}:nonstream`);
      expect(invocation.frozenResponseContracts.contracts[`${schemaOperation}:nonstream`]).toMatchObject({
        operation: schemaOperation, admission: { basis: "model_verified" }
      });
      expect(invocation.frozenResponseContracts.queuedPolicy.authority.routeBasisHash)
        .toBe(invocation.routeBasis.routeBasisHash);
      expect(body.response_format).toEqual({
        type: "json_schema",
        json_schema: { name: schemaName, strict: true, schema: getProviderOutputSchemaV2(schemaOperation).schema }
      });
      expect(invocation.preparedRequest.payloadHash).toBe(createHash("sha256").update(invocation.preparedRequest.body).digest("hex"));
      const requestTokens = estimateStoryTokens(invocation.preparedRequest.body);
      expect(invocation.preparedRequest.budgetAudit).toEqual({
        countMode: "estimated", requestTokens, inputLimit: 14_336, outputReserveTokens: 2_048,
        safetyAllowanceTokens: estimatedInputSafetyAllowanceTokens(requestTokens)
      });
      expect(invocation.request.systemPrompt).toBe(`Operation prompt for ${operation}.`);
    }
    expect(provider.execute).not.toHaveBeenCalled();
    expect(ports.resolvePreset).not.toHaveBeenCalled();
  });

  it("trusts every preset schema without consulting the direct capability gate and composes each prompt once", async () => {
    const execute = vi.fn(async (_input: unknown) => providerResult());
    const eligibilityV2 = vi.fn(() => { throw new Error("preset capability gate must not run"); });
    const ports = discoveryPorts(true);
    const prepared = await prepareDirectAuthoringTextExecution({
      ownerUserId: "owner-1", execution: execution({ kind: "openrouter_preset", slug: "authoring" }),
      operationPrompts: operationPrompts(),
      options: {
        nativePresetPlansEnabled: true, preparedExecutor: { execute },
        loadAuthority: async () => ({ id: PROFILE_ID, providerRole: "text", authorityRevision: "authority-revision", endpointIdentity: ENDPOINT_ID }),
        ports,
        responseFormatCapabilities: { ...directCapabilities(), eligibilityV2 }
      } as never
    });

    for (const [operation, semanticOperation, schemaOperation, schemaName] of operationCases) {
      await prepared!.execute({ operation, request: { systemPrompt: "untrusted", input: `input:${operation}`, responseFormatFallback: "forbid" } });
      const invocation = execute.mock.calls.at(-1)![0] as any;
      const bodyText = invocation.preparedRequest.body as string;
      const body = JSON.parse(bodyText);
      expect(invocation.operation).toBe(semanticOperation);
      expect(invocation.invocationKey).toBe(`${schemaOperation}:nonstream`);
      expect(invocation.frozenResponseContracts.contracts[`${schemaOperation}:nonstream`].admission).toEqual({ mode: "json_schema", basis: "preset_trusted" });
      expect(body.response_format.json_schema.name).toBe(schemaName);
      expect(bodyText.match(/Preset instructions\./g)).toHaveLength(1);
      expect(bodyText.match(new RegExp(`Operation prompt for ${operation}\\.`, "g"))).toHaveLength(1);
      const requestTokens = estimateStoryTokens(bodyText);
      expect(invocation.preparedRequest.budgetAudit).toEqual({
        countMode: "estimated", requestTokens, inputLimit: 14_336, outputReserveTokens: 2_048,
        safetyAllowanceTokens: estimatedInputSafetyAllowanceTokens(requestTokens)
      });
    }
    await prepared!.execute({ operation: "seedCharacter", request: { systemPrompt: "untrusted", input: "input:second-seed", responseFormatFallback: "forbid" } });
    await prepared!.execute({ operation: "seedCharacterRepair", request: { systemPrompt: "untrusted", input: "input:second-seed", recoveryInput: "repair", rejectedResponse: "{}", responseFormatFallback: "forbid" } });
    expect(eligibilityV2).not.toHaveBeenCalled();
    expect(ports.resolvePreset).toHaveBeenCalledTimes(1);
    expect(ports.discoverModels).toHaveBeenCalledTimes(1);

    const invocation = execute.mock.calls[0]![0] as any;
    expect(() => bindFrozenResponseContractInvocationV2({
      frozen: { ...invocation.frozenResponseContracts, contracts: {} },
      routeBasis: invocation.routeBasis, plan: invocation.plan,
      invocationKey: invocation.invocationKey, operation: invocation.operation,
      trustedOperationPrompt: invocation.trustedOperationPrompt
    })).toThrow(/invalid|unavailable/i);
    expect(() => bindFrozenResponseContractInvocationV2({
      frozen: invocation.frozenResponseContracts, routeBasis: invocation.routeBasis,
      plan: { ...invocation.plan, prompt: "tampered" },
      invocationKey: invocation.invocationKey, operation: invocation.operation,
      trustedOperationPrompt: invocation.trustedOperationPrompt
    })).toThrow(/basis or plan identity changed|invalid/i);
    await expect(prepared!.execute({
      operation: "unknown" as never,
      request: { systemPrompt: "untrusted", input: "{}", responseFormatFallback: "forbid" }
    })).rejects.toBeTruthy();
    expect(execute).toHaveBeenCalledTimes(operationCases.length + 2);
    const reservations = execute.mock.calls.map(([call]) => (call as any).logicalReservation);
    expect(reservations.map((reservation) => reservation.operation)).toEqual([
      "initial", "repair", "initial", "repair", "initial", "repair", "initial", "repair", "initial", "repair"
    ]);
    expect(new Set(reservations.map((reservation) => reservation.requestScopeId)).size).toBe(1);
    for (const [initialIndex, repairIndex] of [[0, 1], [2, 3], [4, 5], [6, 7], [8, 9]] as const) {
      expect(reservations[initialIndex].invocationId).toBe(reservations[repairIndex].invocationId);
    }
    expect(new Set([reservations[0], reservations[2], reservations[4], reservations[6], reservations[8]]
      .map((reservation) => reservation.invocationId)).size).toBe(5);
    expect(reservations.every((reservation) => reservation.kind === "direct" && reservation.ownerUserId === "owner-1")).toBe(true);
  });

  it("keeps concurrent prepared requests in distinct parent scopes", async () => {
    const execute = vi.fn(async (_input: unknown) => providerResult());
    const options = {
      nativePresetPlansEnabled: true,
      preparedExecutor: { execute },
      loadAuthority: async () => ({ id: PROFILE_ID, providerRole: "text" as const, authorityRevision: "authority-revision", endpointIdentity: ENDPOINT_ID }),
      ports: discoveryPorts(true),
      responseFormatCapabilities: directCapabilities()
    } as never;
    const [first, second] = await Promise.all([
      prepareDirectAuthoringTextExecution({
        ownerUserId: "owner-1", execution: execution({ kind: "openrouter_preset", slug: "authoring" }),
        operationPrompts: { worldOutline: "Create the world." }, options
      }),
      prepareDirectAuthoringTextExecution({
        ownerUserId: "owner-1", execution: execution({ kind: "openrouter_preset", slug: "authoring" }),
        operationPrompts: { worldOutline: "Create the world." }, options
      })
    ]);

    await Promise.all([first!.execute({
      operation: "worldOutline", request: { systemPrompt: "untrusted", input: "same input", responseFormatFallback: "forbid" }
    }), second!.execute({
      operation: "worldOutline", request: { systemPrompt: "untrusted", input: "same input", responseFormatFallback: "forbid" }
    })]);

    const reservations = execute.mock.calls.map(([call]) => (call as any).logicalReservation);
    expect(reservations).toHaveLength(2);
    expect(reservations[0].requestScopeId).not.toBe(reservations[1].requestScopeId);
    expect(reservations[0].invocationId).not.toBe(reservations[1].invocationId);
  });

  it("blocks an unsupported inherited Model before either execution seam runs", async () => {
    const preparedExecute = vi.fn(async () => providerResult());
    const provider = execution(undefined);
    const ports = discoveryPorts();
    ports.discoverModels.mockResolvedValue([{ id: MODEL_ID, contextWindowTokens: 16_384, maxOutputTokens: 2_048,
      responseFormatAdvertisement: { supportedParameters: ["response_format"], discoveredAt: ADVERTISEMENT.discoveredAt } }] as never);

    await expect(prepareDirectAuthoringTextExecution({
      ownerUserId: "owner-1", execution: provider, operationPrompts: { worldOutline: "Create a world." },
      options: {
        nativePresetPlansEnabled: true, preparedExecutor: { execute: preparedExecute },
        loadAuthority: async () => ({ id: PROFILE_ID, providerRole: "text", authorityRevision: "authority-revision", endpointIdentity: ENDPOINT_ID }),
        ports, responseFormatCapabilities: directCapabilities()
      } as never
    })).rejects.toThrow(/verified response contract|required response contract/i);
    expect(preparedExecute).not.toHaveBeenCalled();
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["Model", { kind: "model" as const, modelId: MODEL_ID }, false],
    ["Preset", { kind: "openrouter_preset" as const, slug: "authoring" }, true]
  ])("checks complete rejected-response bytes and forwards the exact audited %s repair", async (_label, selection, preset) => {
    const execute = vi.fn(async (_input: unknown) => providerResult());
    const ports = discoveryPorts(preset);
    const prepared = await prepareDirectAuthoringTextExecution({
      ownerUserId: "owner-1", execution: execution(selection),
      operationPrompts: { worldOutlineRepair: "Repair the world." },
      options: {
        nativePresetPlansEnabled: true, preparedExecutor: { execute },
        loadAuthority: async () => ({ id: PROFILE_ID, providerRole: "text", authorityRevision: "authority-revision", endpointIdentity: ENDPOINT_ID }),
        ports, responseFormatCapabilities: directCapabilities()
      } as never
    });
    const rejectedCanary = `REJECTED-${"x".repeat(80_000)}`;

    await prepared!.execute({
      operation: "worldOutlineRepair",
      request: {
        systemPrompt: "untrusted", input: "protected input", recoveryInput: "repair the response",
        rejectedResponse: JSON.stringify({ rejectedCanary }), responseFormatFallback: "forbid"
      }
    });

    const invocation = execute.mock.calls[0]![0] as any;
    expect(invocation.preparedRequest.body).not.toContain("REJECTED-");
    expect(invocation.preparedRequest.body).toContain("CLEAN REGENERATION REQUIREMENT");
    expect(invocation.preparedRequest.body.match(/Repair the world\./g)).toHaveLength(1);
    expect(invocation.preparedRequest.body.match(/Preset instructions\./g) ?? []).toHaveLength(preset ? 1 : 0);
    expect(JSON.parse(invocation.preparedRequest.body).response_format.json_schema.name)
      .toBe("infinite_quest_world_outline_v1");
    expect(invocation.preparedRequest.payloadHash)
      .toBe(createHash("sha256").update(invocation.preparedRequest.body).digest("hex"));
    expect(invocation.preparedRequest.budgetAudit).toMatchObject({
      countMode: "estimated", inputLimit: 14_336, outputReserveTokens: 2_048
    });
  });

  it.each([
    ["Model", { kind: "model" as const, modelId: MODEL_ID }, false],
    ["Preset", { kind: "openrouter_preset" as const, slug: "authoring" }, true]
  ])("blocks over-budget %s initial and repair bodies before prepared execution", async (_label, selection, preset) => {
    const limits = { contextWindowTokens: 512, maxOutputTokens: 128 };
    const execute = vi.fn(async (_input: unknown) => providerResult());
    const prepared = await prepareDirectAuthoringTextExecution({
      ownerUserId: "owner-1", execution: execution(selection, limits),
      operationPrompts: { worldOutline: "Create the world.", worldOutlineRepair: "Repair the world." },
      options: {
        nativePresetPlansEnabled: true, preparedExecutor: { execute },
        loadAuthority: async () => ({ id: PROFILE_ID, providerRole: "text", authorityRevision: "authority-revision", endpointIdentity: ENDPOINT_ID }),
        ports: discoveryPorts(preset, limits), responseFormatCapabilities: directCapabilities()
      } as never
    });

    await expect(prepared!.execute({
      operation: "worldOutline",
      request: { systemPrompt: "untrusted", input: "small input", responseFormatFallback: "forbid" }
    })).rejects.toMatchObject({ code: "context_budget_exceeded", scope: "provider_request" });
    await expect(prepared!.execute({
      operation: "worldOutlineRepair",
      request: {
        systemPrompt: "untrusted", input: "small input", recoveryInput: "repair",
        rejectedResponse: JSON.stringify({ rejected: "x".repeat(4_000) }), responseFormatFallback: "forbid"
      }
    })).rejects.toMatchObject({ code: "context_budget_exceeded", scope: "provider_request" });
    expect(execute).not.toHaveBeenCalled();
  });
});
