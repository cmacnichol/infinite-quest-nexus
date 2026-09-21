import { describe, expect, test } from "vitest";
import { projectGenerationResponseFormat } from "../../packages/contracts/src/generation-response-format-projection.js";

describe("generation response-format public projection", () => {
  test("projects only finite saved selection and latest invocation audit", () => {
    const privateCanary = "PRIVATE_PROMPT_ROUTE_CREDENTIAL_CANARY";
    expect(projectGenerationResponseFormat({
      queuedResponsePolicy: { version: 1, policy: "required", model: "model-a", endpointIdentity: privateCanary },
      frozenResponseContracts: { version: 1, contracts: {
        "story:stream": { version: 1, mode: "json_schema", operation: "story", streaming: true, schemaVersion: "story-native-v1", schemaHash: "a".repeat(64), schema: { private: privateCanary } }
      } },
      responseContractInvocations: [{ version: 1, invocationKey: "story:stream", request: {
        mode: "json_schema", requestedModel: "model-a", schemaVersion: "story-native-v1", schemaHash: "a".repeat(64), private: privateCanary
      }, response: { returnedModel: "model-b", returnedProviderRoute: "route-a", diagnosticCode: null }, private: privateCanary }]
    })).toEqual({
      version: 1, savedPolicy: "required", effectiveMode: "json_schema", schemaVersion: "story-native-v1", schemaHash: "a".repeat(64),
      operation: "story", streaming: true, requestedModel: "model-a", returnedModel: "model-b", returnedRoute: "route-a", preflight: "selected", preflightDiagnostic: null, diagnosticCode: null
    });
    expect(JSON.stringify(projectGenerationResponseFormat({ queuedResponsePolicy: { version: 1, policy: "required", endpointIdentity: privateCanary } }))).not.toContain(privateCanary);
  });

  test("keeps absent legacy markers legacy and maps saved preflight failures without current-profile inference", () => {
    expect(projectGenerationResponseFormat({})).toEqual({
      version: 1, savedPolicy: "legacy", effectiveMode: "legacy", schemaVersion: null, schemaHash: null,
      operation: null, streaming: null, requestedModel: null, returnedModel: null, returnedRoute: null, preflight: "unknown", preflightDiagnostic: null, diagnosticCode: null
    });
    expect(projectGenerationResponseFormat({ queuedResponsePolicy: { version: 1, policy: "required" }, errorCode: "response_contract_unavailable" }))
      .toMatchObject({ savedPolicy: "required", effectiveMode: "unavailable", preflight: "unavailable" });
    expect(projectGenerationResponseFormat({ queuedResponsePolicy: { version: 1, policy: "required" }, errorCode: "response_contract_unsupported_adapter" }))
      .toMatchObject({ preflight: "unavailable", preflightDiagnostic: "unsupported_adapter" });
  });

  test("keeps malformed or future durable markers unknown rather than relabeling them as legacy or selected", () => {
    expect(projectGenerationResponseFormat({ queuedResponsePolicy: { version: 3, policy: "future" } }))
      .toMatchObject({ savedPolicy: "unknown", effectiveMode: "unknown", preflight: "unknown" });
    expect(projectGenerationResponseFormat({ queuedResponsePolicy: { version: 1, policy: "auto" }, frozenResponseContracts: { version: 2 } }))
      .toMatchObject({ savedPolicy: "auto", effectiveMode: "unknown", preflight: "unknown" });
  });

  test("projects v2 requested Preset selection separately from unknown actual serving identity", () => {
    const privateCanary = "PRIVATE_V2_PROMPT_PLAN_CREDENTIAL_CANARY";
    const projected = projectGenerationResponseFormat({
      queuedResponsePolicy: {
        version: 2, policy: "required", admission: { mode: "json_schema", basis: "preset_trusted" },
        authority: { kind: "preset_trusted", selection: { kind: "openrouter_preset", slug: "night-shift" }, endpointReference: privateCanary, credentialReference: privateCanary }
      },
      frozenResponseContracts: { version: 2, contracts: {
        "story:stream": { mode: "json_schema", operation: "story", streaming: true, schemaVersion: "story-v2", schemaHash: "b".repeat(64), schema: { private: privateCanary } }
      } },
      responseContractInvocations: [{ version: 2, invocationKey: "story:stream", request: { requestedModel: "requested-route" }, response: { returnedModel: null, returnedProviderRoute: null, diagnosticCode: null } }]
    });

    expect(projected).toEqual({
      version: 2, savedPolicy: "required", effectiveMode: "json_schema", schemaVersion: "story-v2", schemaHash: "b".repeat(64),
      operation: "story", streaming: true, requestedSelection: { kind: "openrouter_preset", slug: "night-shift" }, assurance: "trusted_preset",
      actualServedIdentity: { status: "unknown", model: null, providerRoute: null }, preflight: "selected", preflightDiagnostic: null, diagnosticCode: null
    });
    expect(JSON.stringify(projected)).not.toContain(privateCanary);
    expect(JSON.stringify(projected)).not.toContain("requested-route");
  });

  test("projects v2 actual served identity only from supplied response evidence", () => {
    expect(projectGenerationResponseFormat({
      queuedResponsePolicy: { version: 2, policy: "required", admission: { mode: "json_schema", basis: "model_verified" }, authority: { kind: "model_verified", model: "requested-model" } },
      frozenResponseContracts: { version: 2, contracts: { "story:nonstream": { mode: "json_schema", operation: "story", streaming: false, schemaVersion: "story-v2", schemaHash: "c".repeat(64) } } },
      responseContractInvocations: [{ version: 2, invocationKey: "story:nonstream", request: { requestedModel: "different-request-field" }, response: { returnedModel: "served-model", returnedProviderRoute: "served-route", diagnosticCode: null } }]
    })).toMatchObject({
      version: 2, requestedSelection: { kind: "model", modelId: "requested-model" }, assurance: "verified_model",
      actualServedIdentity: { status: "known", model: "served-model", providerRoute: "served-route" }
    });
  });

  test("retains bounded 500-character v2 actual served identity fields", () => {
    const returnedModel = "m".repeat(500);
    const returnedProviderRoute = "r".repeat(500);
    const projected = projectGenerationResponseFormat({
      queuedResponsePolicy: {
        version: 2, policy: "required", admission: { mode: "json_schema", basis: "preset_trusted" },
        authority: { kind: "preset_trusted", selection: { kind: "openrouter_preset", slug: "night-shift" } }
      },
      responseContractInvocations: [{
        version: 2, invocationKey: "story:stream", response: { returnedModel, returnedProviderRoute }
      }]
    });
    expect(projected.version).toBe(2);
    if (projected.version !== 2) throw new Error("Expected a v2 projection.");
    expect(projected.actualServedIdentity).toEqual({ status: "known", model: returnedModel, providerRoute: returnedProviderRoute });
  });
});
