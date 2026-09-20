import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  authoringResponseContractIdentity,
  getProviderOutputSchemaV2
} from "@infinite-quest/contracts";
import {
  prepareAuthoringResponseContractExecution,
  serializePreparedAuthoringRequest
} from "../../services/runtime/src/authoring-text-execution-preparation.js";

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const operations = {
  sourceExtraction: "Extract cited facts.",
  sourceExtractionRepair: "Repair cited facts.",
  sourceSynthesis: "Synthesize the world.",
  sourceSynthesisRepair: "Repair world synthesis.",
  sourceCharacter: "Synthesize one character.",
  sourceCharacterRepair: "Repair character synthesis.",
  illustrationPromptRefinement: "Return one fiction-only image prompt."
} as const;

describe("durable authoring response contracts", () => {
  it("freezes every source and illustration contract and serializes the checked schema-bearing body", async () => {
    const prepared = await prepareAuthoringResponseContractExecution({
      ownerUserId: "owner-1",
      execution: {
        id: PROFILE_ID, name: "Text", providerRole: "text", providerType: "openrouter",
        model: "fallback-model", contextWindowTokens: 16_384, maxOutputTokens: 2_048,
        temperature: 0.3, requestTimeoutMs: 30_000, endpointIdentity: "endpoint-1",
        configuration: {}, executionRevision: "profile-1", authorityRevision: "authority-1",
        textSelection: { kind: "openrouter_preset", slug: "authoring" },
        execute: vi.fn(async () => { throw new Error("legacy execution must not run"); })
      },
      operationPrompts: operations,
      ports: {
        resolvePreset: async () => ({
          slug: "authoring", name: "Authoring", versionId: "v1", version: 1,
          configHash: "a".repeat(64), config: { models: ["preset-model"] },
          systemPrompt: "Preset contract instructions."
        }),
        discoverModels: async () => [{ id: "preset-model", contextWindowTokens: 16_384, maxOutputTokens: 2_048 }]
      }
    });

    expect(Object.keys(prepared.frozenResponseContracts.contracts).sort()).toEqual([
      "illustration_prompt_refinement:nonstream", "source_character:nonstream",
      "source_extraction:nonstream", "source_synthesis:nonstream"
    ]);
    const identity = authoringResponseContractIdentity("sourceExtraction");
    const request = serializePreparedAuthoringRequest({
      execution: {
        providerType: "openrouter", configuration: {}
      },
      prepared,
      operation: "sourceExtraction",
      request: { systemPrompt: "ignored", input: "SOURCE CANARY" }
    });
    const body = JSON.parse(request.body);
    expect(body.response_format.json_schema.name).toBe(getProviderOutputSchemaV2(identity.schemaOperation).name);
    expect(request.body.match(/Preset contract instructions\./g)).toHaveLength(1);
    expect(request.body).toContain("SOURCE CANARY");
    expect(request.payloadHash).toBe(createHash("sha256").update(request.body).digest("hex"));
    expect(request.budgetAudit).toMatchObject({ countMode: "estimated", outputReserveTokens: 2_048 });
  });
});
