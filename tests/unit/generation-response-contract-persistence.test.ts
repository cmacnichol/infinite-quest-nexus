import { describe, expect, it } from "vitest";
import { frozenResponseContractsSelectionHash, readAttemptResponseContractAudit, readFrozenResponseContracts, readQueuedResponsePolicy, readResponseContractInvocationAudit, responseContractInvocationAuditId } from "../../packages/contracts/src/index.js";

const hash = "a".repeat(64);
const jobId = "22222222-2222-4222-8222-222222222222";
const logicalAttemptId = "33333333-3333-4333-8333-333333333333";
const queued = { version: 1, policy: "auto", providerProfileId: "11111111-1111-4111-8111-111111111111", model: "model-a", endpointIdentity: "endpoint-a", providerConfigurationHash: hash, verificationRegistryHash: hash, operationClosureVersion: 1, invocationKeys: ["story:nonstream"] } as const;

describe("durable response-contract persistence contracts", () => {
  it("keeps an absent legacy envelope absent and rejects an unknown present version", () => {
    expect(readQueuedResponsePolicy(undefined)).toBeUndefined();
    expect(() => readQueuedResponsePolicy({ ...queued, version: 2 })).toThrow("Queued response policy");
  });

  it("accepts only a queued policy whose invocation keys are unique and versioned", () => {
    expect(readQueuedResponsePolicy(queued)).toEqual(queued);
    expect(() => readQueuedResponsePolicy({ ...queued, invocationKeys: ["story:nonstream", "story:nonstream"] })).toThrow();
  });

  it("binds frozen contracts to their exact queued policy and selection hashes", () => {
    const selection = { version: 1 as const, queuedPolicy: queued, selectedAt: "2026-09-18T00:00:00.000Z", capabilityEvidenceHash: hash, contracts: { "story:nonstream": { version: 1 as const, mode: "json_object" as const, operation: "story" as const, streaming: false, forbidFormatFallback: true as const } } };
    const frozen = { ...selection, selectionHash: frozenResponseContractsSelectionHash(selection) };
    expect(readFrozenResponseContracts(frozen)).toEqual(frozen);
    expect(() => readFrozenResponseContracts({ ...frozen, contracts: { "story:stream": frozen.contracts["story:nonstream"] } })).toThrow();
    expect(() => readFrozenResponseContracts({ ...frozen, queuedPolicy: { ...queued, policy: "required" } })).toThrow();
  });

  it("accepts only finite diagnostic provenance and produces a stable concrete operation id", () => {
    expect(readAttemptResponseContractAudit({ version: 1, selectionHash: hash, invocationKey: "story:nonstream", mode: "json_schema", schemaVersion: "story-v1", schemaHash: hash, requestedModel: "model-a", providerRoutingSlugs: ["route-a"], returnedModel: null, returnedProviderRoute: null, diagnosticCode: "provider_refusal" }).diagnosticCode).toBe("provider_refusal");
    expect(() => readAttemptResponseContractAudit({ version: 1, selectionHash: hash, invocationKey: "story:nonstream", mode: "json_object", schemaVersion: null, schemaHash: null, requestedModel: "model-a", providerRoutingSlugs: [], returnedModel: null, returnedProviderRoute: null, diagnosticCode: "unbounded" })).toThrow();
    expect(() => readAttemptResponseContractAudit({ version: 1, selectionHash: hash, invocationKey: "story:nonstream", mode: "json_object", schemaVersion: "unexpected", schemaHash: null, requestedModel: "model-a", providerRoutingSlugs: [], returnedModel: null, returnedProviderRoute: null, diagnosticCode: null })).toThrow();
    expect(responseContractInvocationAuditId(jobId, logicalAttemptId, "story:nonstream", "story_generation", hash)).toBe(responseContractInvocationAuditId(jobId, logicalAttemptId, "story:nonstream", "story_generation", hash));
    expect(responseContractInvocationAuditId(jobId, logicalAttemptId, "story:nonstream", "story_generation", hash)).not.toBe(responseContractInvocationAuditId(jobId, logicalAttemptId, "story:nonstream", "event_extension", hash));
  });

  it("rejects an invocation whose immutable operation, request hash, state, or response shape is inconsistent", () => {
    const request = { version: 1, selectionHash: hash, invocationKey: "story:nonstream", mode: "json_object", schemaVersion: null, schemaHash: null, requestedModel: "model-a", providerRoutingSlugs: [], returnedModel: null, returnedProviderRoute: null, diagnosticCode: null } as const;
    const reserved = { version: 1, id: responseContractInvocationAuditId(jobId, logicalAttemptId, "story:nonstream", "story_generation", hash), logicalAttemptId, invocationKey: "story:nonstream", operation: "story_generation", requestPayloadHash: hash, request, status: "reserved", reservedAt: "2026-09-18T00:00:00.000Z", dispatchedAt: null, completedAt: null, response: null } as const;
    expect(readResponseContractInvocationAudit(reserved)).toEqual(reserved);
    expect(() => readResponseContractInvocationAudit({ ...reserved, request: { ...request, invocationKey: "choices:nonstream" } })).toThrow();
    expect(() => readResponseContractInvocationAudit({ ...reserved, status: "dispatched", dispatchedAt: null })).toThrow();
    expect(() => readResponseContractInvocationAudit({ ...reserved, response: { returnedModel: null, returnedProviderRoute: null, diagnosticCode: null } })).toThrow();
  });
});
