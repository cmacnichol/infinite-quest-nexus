import { describe, expect, it, vi } from "vitest";
import type { GenerationExecutionPayload } from "../../packages/database/src/generation-execution-repository.js";
import { sha256 } from "../../packages/domain/src/index.js";
import { serializeProviderRequest } from "../../packages/story-engine/src/index.js";
import { getProviderOutputSchema } from "../../packages/story-engine/src/provider-output-schema.js";
import { getProviderOutputSchemaV2 } from "../../packages/contracts/src/provider-output-schema.js";
import {
  bindCampaignResponseContract,
  callCampaignTextProvider,
  responseContractInvocationDetails
} from "../../services/runtime/src/generation-executor-adapter.js";

const hash = "a".repeat(64);
const scope = {
  jobId: "00000000-0000-4000-8000-000000000001",
  ownerUserId: "00000000-0000-4000-8000-000000000002",
  workerId: "worker"
};

function job(): GenerationExecutionPayload {
  const contract = (operation: "story" | "choices" | "continuity_review", streaming: boolean) => {
    const schema = getProviderOutputSchema(operation);
    return {
      version: 1 as const, mode: "json_schema" as const, operation, streaming,
      schemaVersion: schema.version, schemaHash: schema.schemaHash, schemaName: schema.name, schema: schema.schema,
      providerRoutingSlugs: ["strict-route"], routeConfigHash: hash, adapterProtocol: "text-schema-adapter-v1" as const,
      forbidFormatFallback: true as const
    };
  };
  return {
    id: scope.jobId,
    owner_user_id: scope.ownerUserId,
    campaign_id: "00000000-0000-4000-8000-000000000003",
    provider_profile_id: "00000000-0000-4000-8000-000000000004",
    expected_turn_number: 1,
    attempts: 1,
    operation_kind: "append",
    action: "Continue.",
    context_options: {},
    orchestration_private: {
      logicalAttempt: { version: 1, id: "00000000-0000-4000-8000-000000000005", semanticRepairsConsumed: 0, reviewsConsumed: 0, automaticRepairsConsumed: 0, choiceRepairsConsumed: 0, eventCoverageRepairsConsumed: 0 },
      frozenResponseContracts: {
        selectionHash: hash,
        contracts: {
          "story:nonstream": contract("story", false),
          "story:stream": contract("story", true),
          "choices:nonstream": contract("choices", false),
          "continuity_review:nonstream": contract("continuity_review", false)
        }
      }
    }
  } as never;
}

function provider(execute = vi.fn()) {
  return {
    id: "provider", providerType: "openrouter", model: "model-a", endpointIdentity: "endpoint-a",
    contextWindowTokens: 16_384, maxOutputTokens: 1_024, temperature: 0, requestTimeoutMs: 30_000,
    configuration: {}, execute
  } as never;
}

function request(streaming = false) {
  return {
    systemPrompt: "System instruction.", input: "Player intent.", budgetOutput: { kind: "story_append" as const },
    ...(streaming ? { onChunk: vi.fn() } : {})
  };
}

function auditLedger() {
  let status: "reserved" | "dispatched" | "completed" = "reserved";
  let invocation: any;
  const reserve = vi.fn(async (_scope, input) => {
    invocation = input;
    return { id: "audit", ...input, status };
  });
  const dispatch = vi.fn(async (_scope, id, requestPayloadHash) => {
    if (id !== "audit" || requestPayloadHash !== invocation.requestPayloadHash || status !== "reserved") return null;
    status = "dispatched";
    return { id, ...invocation, status };
  });
  const complete = vi.fn(async (_scope, id, response) => {
    if (id !== "audit" || status !== "dispatched") return null;
    status = "completed";
    return { id, ...invocation, status, response };
  });
  return { reserve, dispatch, complete };
}

function dependencies(ledger: ReturnType<typeof auditLedger>) {
  return {
    pool: {}, responseContractScope: scope,
    repository: {
      reserveResponseContractInvocation: ledger.reserve,
      markResponseContractInvocationDispatched: ledger.dispatch,
      completeResponseContractInvocation: ledger.complete
    },
    collaborators: { recordProfileCost: vi.fn(async () => undefined) }
  } as never;
}

describe("generation response-contract executor operation matrix", () => {
  it("preserves historical v1 event coverage without a contract", () => {
    const legacy = job();
    expect(bindCampaignResponseContract(legacy, "event_coverage_validation", request()).responseContract).toBeUndefined();
  });
  it.each([
    ["RPG assessment", "rpg_assessment", "rpg_assessment:nonstream"],
    ["before trigger", "event_trigger_before", "event_trigger_before:nonstream"],
    ["after trigger", "event_trigger_after", "event_trigger_after:nonstream"],
    ["scene coverage", "scene_coverage_validation", "scene_coverage:nonstream"],
    ["event coverage", "event_coverage_validation", "event_coverage:nonstream"]
  ] as const)("binds v2 %s calls to their distinct frozen closure key", (_name, operation, key) => {
    const schemaOperation = key.split(":")[0] as Parameters<typeof getProviderOutputSchemaV2>[0];
    const schema = getProviderOutputSchemaV2(schemaOperation);
    const v2Job = job();
    v2Job.orchestration_private.frozenResponseContracts = {
      version: 2,
      selectionHash: hash,
      contracts: {
        [key]: { version: 2, mode: "json_schema", operation: schemaOperation, streaming: false,
          schemaVersion: schema.version, schemaHash: schema.schemaHash, schemaName: schema.name, schema: schema.schema,
          admission: { mode: "json_schema", basis: "model_verified", verification: {
            version: 2, providerType: "openrouter", endpointIdentity: "endpoint", model: "model-a", routeConfigHash: hash,
            adapterProtocol: "text-schema-adapter-v2", operation: schemaOperation, schemaHash: schema.schemaHash, streaming: false,
            verifiedAt: "2026-09-18T00:00:00.000Z", expiresAt: "2026-09-20T00:00:00.000Z", providerRoutingSlugs: [], nativeOpenTrackerObjects: schemaOperation === "story"
          } },
          authority: { kind: "model_verified", providerProfileId: "00000000-0000-4000-8000-000000000004", providerType: "openrouter", endpointIdentity: "endpoint", model: "model-a", providerConfigurationHash: hash, routeConfigHash: hash, verificationRegistryHash: hash }, forbidFormatFallback: true }
      }
    } as never;

    expect(bindCampaignResponseContract(v2Job, operation, request()).responseContract)
      .toMatchObject({ version: 2, operation: schemaOperation, schemaHash: schema.schemaHash });
  });

  it.each([
    ["primary", "story_generation", false, "story:nonstream", "story"],
    ["primary stream", "story_generation", true, "story:stream", "story"],
    ["choice repair", "story_choice_repair", false, "choices:nonstream", "choices"],
    ["continuity review", "story_continuity_review", false, "continuity_review:nonstream", "continuity_review"],
    ["semantic repair", "story_continuity_repair", false, "story:nonstream", "story"],
    ["extension", "event_extension", false, "story:nonstream", "story"],
    ["scene rewrite", "scene_coverage_rewrite", false, "story:nonstream", "story"]
  ] as const)("binds %s to its frozen schema operation without format redispatch", (_name, operation, streaming, key, schemaOperation) => {
    const schemaVersion = getProviderOutputSchema(schemaOperation).version;
    const bound = bindCampaignResponseContract(job(), operation, request(streaming));
    expect(bound.responseContract).toMatchObject({ mode: "json_schema", schemaVersion, forbidFormatFallback: true });
    expect(responseContractInvocationDetails(job(), operation, streaming, hash, { model: "model-a" } as never))
      .toMatchObject({ invocationKey: key, request: { invocationKey: key, schemaVersion, providerRoutingSlugs: ["strict-route"] } });
  });

  it("uses the exact checked schema body and hash for reservation, dispatch, and completion", async () => {
    const ledger = auditLedger();
    let providerPrepared: { body: string; payloadHash: string } | undefined;
    const execute = vi.fn(async (dispatchedRequest: any) => {
      const preparedRequest = serializeProviderRequest(provider(), dispatchedRequest);
      providerPrepared = preparedRequest;
      return { content: "{}", responseId: "response", finishReason: "stop", outputLimited: false,
        modelInstanceId: "instance", usage: {}, reportedCost: null, rawMetadata: {}, returnedModel: "model-a",
        returnedProviderRoute: "strict-route", preparedRequest };
    });
    const textProvider = provider(execute);
    const result = await callCampaignTextProvider(dependencies(ledger), textProvider, job(), "story_generation", request());
    expect(result.responseId).toBe("response");
    const reserved = ledger.reserve.mock.calls[0]![1];
    const dispatchedHash = ledger.dispatch.mock.calls[0]![2];
    expect(reserved.requestPayloadHash).toBe(dispatchedHash);
    expect(providerPrepared).toBeDefined();
    expect(reserved.requestPayloadHash).toBe(providerPrepared!.payloadHash);
    expect(reserved.requestPayloadHash).toBe(sha256(providerPrepared!.body));
    expect(ledger.complete.mock.calls[0]![2]).toEqual({ returnedModel: "model-a", returnedProviderRoute: "strict-route", diagnosticCode: null });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not redispatch when a captured response loses completion and a worker reclaims it", async () => {
    const ledger = auditLedger();
    const originalComplete = ledger.complete;
    ledger.complete = vi.fn(async () => null);
    const execute = vi.fn(async (dispatchedRequest: any) => ({ content: "{}", responseId: "response", finishReason: "stop",
      outputLimited: false, modelInstanceId: "instance", usage: {}, reportedCost: null, rawMetadata: {},
      preparedRequest: serializeProviderRequest(provider(), dispatchedRequest) }));
    const textProvider = provider(execute);
    await expect(callCampaignTextProvider(dependencies(ledger), textProvider, job(), "story_generation", request()))
      .rejects.toMatchObject({ code: "lease_lost" });
    expect(execute).toHaveBeenCalledOnce();
    ledger.complete = originalComplete;
    await expect(callCampaignTextProvider(dependencies(ledger), textProvider, job(), "story_generation", request()))
      .rejects.toMatchObject({ code: "response_contract_unavailable" });
    expect(execute).toHaveBeenCalledOnce();
  });
});
