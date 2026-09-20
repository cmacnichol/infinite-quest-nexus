import { describe, expect, it } from "vitest";
import {
  bindFrozenResponseContractInvocationV2,
  assertFrozenPresetResponseContractRouteBasisAuthority,
  assertPresetResponseContractRouteBasisAuthority,
  frozenResponseContractsSelectionHash,
  frozenResponseContractsV2SelectionHash,
  readAttemptResponseContractAudit,
  readFrozenResponseContracts,
  readFrozenResponseContractsVersioned,
  readQueuedResponsePolicy,
  readQueuedResponsePolicyVersioned,
  readResponseContractInvocationAudit,
  readResponseContractInvocationAuditV2,
  responseContractInvocationAuditId,
  responseContractInvocationAuditIdV2
} from "../../packages/contracts/src/index.js";
import { getProviderOutputSchemaV2 } from "../../packages/contracts/src/provider-output-schema.js";
import { deriveTextExecutionPlan, textExecutionRouteBasisHash } from "../../packages/contracts/src/text-execution-plan.js";

const hash = "a".repeat(64);
const jobId = "22222222-2222-4222-8222-222222222222";
const logicalAttemptId = "33333333-3333-4333-8333-333333333333";
const queued = { version: 1, policy: "auto", providerProfileId: "11111111-1111-4111-8111-111111111111", model: "model-a", endpointIdentity: "endpoint-a", providerConfigurationHash: hash, verificationRegistryHash: hash, operationClosureVersion: 1, invocationKeys: ["story:nonstream"] } as const;

describe("durable response-contract persistence contracts", () => {
  it("keeps a v2 preset closure stable while binding distinct primary and repair plans", () => {
    const routeBasisDraft = {
      version: 2 as const, selection: { kind: "openrouter_preset" as const, slug: "night-route" },
      preset: { slug: "night-route", versionId: "preset-v1", configHash: hash },
      candidates: [{ modelId: "openai/gpt-5", providerPolicy: {}, contextWindowTokens: 128000, maxOutputTokens: 4096 }],
      presetSystemPrompt: "Preset instructions.", parameters: {}, endpointReference: "openrouter-main",
      credentialReference: "credential-ref", profileRevision: "profile-v1", authorityRevision: "authority-v1",
      requestTimeoutMs: 30000, protocolVersion: "text-schema-adapter-v2"
    };
    const routeBasis = { ...routeBasisDraft, routeBasisHash: textExecutionRouteBasisHash({ ...routeBasisDraft, routeBasisHash: hash }) };
    const policy = {
      version: 2 as const, policy: "required" as const, providerProfileId: "11111111-1111-4111-8111-111111111111",
      admission: { mode: "json_schema" as const, basis: "preset_trusted" as const },
      authority: { kind: "preset_trusted" as const, routeBasisHash: routeBasis.routeBasisHash, selection: { kind: "openrouter_preset" as const, slug: "night-route" }, endpointReference: "openrouter-main", credentialReference: "credential-ref", authorityRevision: "authority-v1", profileRevision: "profile-v1" },
      operationClosureVersion: 2 as const, invocationKeys: ["story:nonstream" as const]
    };
    const story = getProviderOutputSchemaV2("story");
    const selected = {
      version: 2 as const, queuedPolicy: policy, selectedAt: "2026-09-18T00:00:00.000Z", capabilityEvidenceHash: hash,
      contracts: { "story:nonstream": { version: 2 as const, mode: "json_schema" as const, admission: policy.admission, operation: "story" as const, streaming: false, forbidFormatFallback: true as const, schemaVersion: story.version, schemaHash: story.schemaHash, schemaName: story.name, schema: story.schema, authority: { kind: "preset_trusted" as const, routeBasisHash: routeBasis.routeBasisHash } } }
    };
    const frozen = { ...selected, selectionHash: frozenResponseContractsV2SelectionHash(selected) };
    const primary = deriveTextExecutionPlan(routeBasis, "Write the next turn.");
    const repair = deriveTextExecutionPlan(routeBasis, "Repair the rejected turn.");

    expect(readQueuedResponsePolicyVersioned(policy)).toEqual(policy);
    expect(readFrozenResponseContractsVersioned(frozen)).toEqual(frozen);
    expect(assertPresetResponseContractRouteBasisAuthority(policy, routeBasis)).toEqual(routeBasis);
    expect(assertFrozenPresetResponseContractRouteBasisAuthority(frozen, routeBasis)).toEqual(routeBasis);
    const alteredBasisDraft = { ...routeBasis, presetSystemPrompt: "A different but valid persisted instruction." };
    const alteredBasis = { ...alteredBasisDraft, routeBasisHash: textExecutionRouteBasisHash({ ...alteredBasisDraft, routeBasisHash: hash }) };
    expect(() => assertPresetResponseContractRouteBasisAuthority(policy, alteredBasis)).toThrow(/route basis identity changed/i);
    expect(bindFrozenResponseContractInvocationV2({ frozen, invocationKey: "story:nonstream", operation: "story_generation", routeBasis, plan: primary, trustedOperationPrompt: "Write the next turn." }).authority).toMatchObject({ planHash: primary.planHash });
    expect(bindFrozenResponseContractInvocationV2({ frozen, invocationKey: "story:nonstream", operation: "story_recovery", routeBasis, plan: repair, trustedOperationPrompt: "Repair the rejected turn." }).authority).toMatchObject({ planHash: repair.planHash });
    expect(primary.planHash).not.toBe(repair.planHash);
    expect(() => bindFrozenResponseContractInvocationV2({ frozen, invocationKey: "story:nonstream", operation: "story_recovery", routeBasis, plan: primary, trustedOperationPrompt: "Repair the rejected turn." })).toThrow(/basis or plan identity changed/i);
  });

  it("keeps v1 readers byte-compatible while rejecting unrecognized versioned records", () => {
    expect(readQueuedResponsePolicyVersioned(queued)).toEqual(queued);
    expect(() => readQueuedResponsePolicyVersioned({ version: 3 })).toThrow(/invalid or incompatible/i);
    expect(() => readFrozenResponseContractsVersioned({ version: 3 })).toThrow(/invalid or incompatible/i);
    expect(() => readResponseContractInvocationAuditV2({ version: 3 })).toThrow(/invalid or incompatible/i);
    expect(responseContractInvocationAuditId(jobId, logicalAttemptId, "story:nonstream", "story_generation", hash)).toBe(responseContractInvocationAuditId(jobId, logicalAttemptId, "story:nonstream", "story_generation", hash));
    expect(() => responseContractInvocationAuditIdV2(jobId, logicalAttemptId, "story:nonstream", "story_generation", "not-a-hash")).toThrow();
  });
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
