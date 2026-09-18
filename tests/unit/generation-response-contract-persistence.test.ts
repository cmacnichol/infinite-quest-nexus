import { describe, expect, it } from "vitest";
import { readAttemptResponseContractAudit, readFrozenResponseContracts, readQueuedResponsePolicy, responseContractInvocationAuditId } from "../../packages/contracts/src/index.js";

const hash = "a".repeat(64);
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
    const frozen = { version: 1, queuedPolicy: queued, selectedAt: "2026-09-18T00:00:00.000Z", capabilityEvidenceHash: hash, contracts: { "story:nonstream": { version: 1, mode: "json_object", operation: "story", streaming: false, forbidFormatFallback: true } }, selectionHash: hash } as const;
    expect(readFrozenResponseContracts(frozen)).toEqual(frozen);
    expect(() => readFrozenResponseContracts({ ...frozen, contracts: { "story:stream": frozen.contracts["story:nonstream"] } })).toThrow();
  });

  it("accepts only finite diagnostic provenance and produces a stable logical operation id", () => {
    expect(readAttemptResponseContractAudit({ version: 1, selectionHash: hash, invocationKey: "story:nonstream", mode: "json_schema", schemaVersion: "story-v1", schemaHash: hash, requestedModel: "model-a", providerRoutingSlugs: ["route-a"], returnedModel: null, returnedProviderRoute: null, diagnosticCode: "provider_refusal" }).diagnosticCode).toBe("provider_refusal");
    expect(() => readAttemptResponseContractAudit({ version: 1, selectionHash: hash, invocationKey: "story:nonstream", mode: "json_object", schemaVersion: null, schemaHash: null, requestedModel: "model-a", providerRoutingSlugs: [], returnedModel: null, returnedProviderRoute: null, diagnosticCode: "unbounded" })).toThrow();
    expect(responseContractInvocationAuditId("job-a", "story:nonstream", 1)).toBe(responseContractInvocationAuditId("job-a", "story:nonstream", 1));
  });
});
