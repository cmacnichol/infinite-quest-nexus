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
      operation: "story", streaming: true, requestedModel: "model-a", returnedModel: "model-b", returnedRoute: "route-a", preflight: "selected", diagnosticCode: null
    });
    expect(JSON.stringify(projectGenerationResponseFormat({ queuedResponsePolicy: { version: 1, policy: "required", endpointIdentity: privateCanary } }))).not.toContain(privateCanary);
  });

  test("keeps absent legacy markers legacy and maps saved preflight failures without current-profile inference", () => {
    expect(projectGenerationResponseFormat({})).toEqual({
      version: 1, savedPolicy: "legacy", effectiveMode: "legacy", schemaVersion: null, schemaHash: null,
      operation: null, streaming: null, requestedModel: null, returnedModel: null, returnedRoute: null, preflight: "unknown", diagnosticCode: null
    });
    expect(projectGenerationResponseFormat({ queuedResponsePolicy: { version: 1, policy: "required" }, errorCode: "response_contract_unavailable" }))
      .toMatchObject({ savedPolicy: "required", effectiveMode: "unavailable", preflight: "unavailable" });
  });

  test("keeps malformed or future durable markers unknown rather than relabeling them as legacy or selected", () => {
    expect(projectGenerationResponseFormat({ queuedResponsePolicy: { version: 2, policy: "future" } }))
      .toMatchObject({ savedPolicy: "legacy", effectiveMode: "unknown", preflight: "unknown" });
    expect(projectGenerationResponseFormat({ queuedResponsePolicy: { version: 1, policy: "auto" }, frozenResponseContracts: { version: 2 } }))
      .toMatchObject({ savedPolicy: "auto", effectiveMode: "unknown", preflight: "unknown" });
  });
});
