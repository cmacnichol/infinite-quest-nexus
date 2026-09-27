import { describe, expect, it } from "vitest";
import { continuityReviewExecutionPolicySchema } from "../../packages/contracts/src/continuity-review-execution.js";
import { prepareFrozenContinuityReviewRequest, resolveContinuityReviewExecution } from "../../services/runtime/src/continuity-review-execution.js";
import { resolveGenerationResponseContractsV2 } from "../../services/runtime/src/generation-response-contract.js";
import { queuedResponsePolicyV2Schema } from "../../packages/contracts/src/generation-response-contract.js";

function testContract(routeBasis: Parameters<Parameters<typeof resolveContinuityReviewExecution>[0]["prepareResponseContracts"]>[0]) {
  const queuedPolicy = queuedResponsePolicyV2Schema.parse({
    version: 2, policy: "required", providerProfileId: directProfile.providerProfileId,
    admission: { mode: "json_schema", basis: "preset_trusted" },
    authority: { kind: "preset_trusted", routeBasisHash: routeBasis.routeBasisHash,
      selection: { kind: "openrouter_preset", slug: "reviewer" }, endpointReference: "endpoint-a",
      credentialReference: directProfile.providerProfileId, authorityRevision: "authority-3", profileRevision: "profile-7" },
    operationClosureVersion: 2, invocationKeys: ["continuity_review:nonstream"]
  });
  return resolveGenerationResponseContractsV2({ queuedPolicy, capabilityEvidenceHash: "a".repeat(64) });
}

const directProfile = {
  ownerUserId: "00000000-0000-4000-8000-000000000001",
  providerProfileId: "00000000-0000-4000-8000-000000000002",
  profileRevision: "profile-7",
  authorityRevision: "authority-3",
  providerType: "openrouter",
  selection: { kind: "model" as const, modelId: "writer-model" },
  contextWindowTokens: 32_000,
  maxOutputTokens: 4_000,
  endpointReference: "endpoint-a",
  credentialReference: "00000000-0000-4000-8000-000000000002",
  protocolVersion: "text-execution-route-basis-v2"
};

describe("continuity review execution", () => {
  it("leaves the writer selection and parameters intact while resolving the reviewer selection", async () => {
    const policy = continuityReviewExecutionPolicySchema.parse({
      version: 1,
      primary: { selection: { kind: "model", modelId: "review-model" }, overrides: { parameters: { temperature: 0.1 } } },
      maximumAutomaticFallbacks: 0
    });
    const snapshot = await resolveContinuityReviewExecution({
      profile: directProfile,
      policy,
      ports: {
        resolvePreset: async () => { throw new Error("direct models do not resolve presets"); },
        discoverModels: async ({ modelIds }) => modelIds.map((id) => ({ id, contextWindowTokens: 16_000, maxOutputTokens: 2_000 }))
      },
      prepareResponseContracts: async (basis) => testContract(basis)
    });

    expect(directProfile.selection.modelId).toBe("writer-model");
    expect(snapshot.primary!.routeBasis.selection).toEqual({ kind: "model", modelId: "review-model" });
    expect(snapshot.primary!.routeBasis.parameters.temperature).toBe(0.1);
    expect(snapshot.primary!.routeBasis.candidates[0]?.modelId).toBe("review-model");
  });

  it("preserves remote preset identity in the frozen reviewer route", async () => {
    const policy = continuityReviewExecutionPolicySchema.parse({
      version: 1,
      primary: { selection: { kind: "openrouter_preset", slug: "reviewer" } },
      maximumAutomaticFallbacks: 0
    });
    const snapshot = await resolveContinuityReviewExecution({
      profile: directProfile,
      policy,
      ports: {
        resolvePreset: async ({ slug }) => ({ slug, name: "Reviewer", versionId: "preset-version-9", version: 1, systemPrompt: "review instructions", config: { model: "vendor/reviewer" }, configHash: "b".repeat(64) }),
        discoverModels: async ({ modelIds }) => modelIds.map((id) => ({ id, contextWindowTokens: 16_000, maxOutputTokens: 2_000 }))
      },
      prepareResponseContracts: async (basis) => testContract(basis)
    });

    expect(snapshot.primary!.routeBasis.selection).toEqual({ kind: "openrouter_preset", slug: "reviewer" });
    expect(snapshot.primary!.routeBasis.candidates[0]?.modelId).toBe("@preset/reviewer");
  });

  it("serializes the reviewer preset with its frozen review contract and output budget", async () => {
    const snapshot = await resolveContinuityReviewExecution({
      profile: directProfile,
      policy: continuityReviewExecutionPolicySchema.parse({
        version: 1, primary: { selection: { kind: "openrouter_preset", slug: "reviewer" } }, maximumAutomaticFallbacks: 0
      }),
      ports: {
        resolvePreset: async ({ slug }) => ({ slug, name: "Reviewer", versionId: "preset-version-9", version: 1, systemPrompt: "review instructions", config: { model: "vendor/reviewer" }, configHash: "b".repeat(64) }),
        discoverModels: async ({ modelIds }) => modelIds.map((id) => ({ id, contextWindowTokens: 16_000, maxOutputTokens: 2_000 }))
      },
      prepareResponseContracts: async (basis) => testContract(basis)
    });

    const prepared = prepareFrozenContinuityReviewRequest(snapshot.primary!, {
      systemPrompt: "Assess the candidate.", input: "{\"candidate\":\"safe\"}", budgetOutput: { kind: "continuity_review" }
    });

    expect(prepared.preparedRequest.body).toContain('"model":"@preset/reviewer"');
    expect(prepared.preparedRequest.body).toContain('"response_format":{"type":"json_schema"');
    expect(prepared.preparedRequest.payloadHash).toHaveLength(64);
    expect(prepared.request.responseContract).toMatchObject({ operation: "continuity_review", streaming: false });
  });

  it("rejects unsupported execution parameters before provider preparation", () => {
    expect(() => continuityReviewExecutionPolicySchema.parse({
      version: 1,
      primary: { selection: { kind: "model", modelId: "review-model" }, overrides: { parameters: { unsupported_knob: 7 } } },
      maximumAutomaticFallbacks: 0
    })).toThrow();
  });

  it("freezes the policy decision as queue-time data rather than consulting later settings", async () => {
    const policy = continuityReviewExecutionPolicySchema.parse({
      version: 1,
      primary: { selection: { kind: "model", modelId: "review-model" } },
      maximumAutomaticFallbacks: 0
    });
    const snapshot = await resolveContinuityReviewExecution({
      profile: directProfile,
      policy,
      ports: {
        resolvePreset: async () => { throw new Error("unused"); },
        discoverModels: async ({ modelIds }) => modelIds.map((id) => ({ id, contextWindowTokens: 16_000, maxOutputTokens: 2_000 }))
      },
      prepareResponseContracts: async (basis) => testContract(basis)
    });

    expect(snapshot.primary!.routeBasis.selection).toEqual({ kind: "model", modelId: "review-model" });
    expect(snapshot.primary!.routeBasis.routeBasisHash).toHaveLength(64);
  });
});
