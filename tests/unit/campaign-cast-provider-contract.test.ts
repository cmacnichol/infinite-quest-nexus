import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { castDiscoveryOutputSchema } from "../../packages/contracts/src/campaign-cast-discovery.js";
import { getProviderOutputSchemaV2, responseContractOperationV2Schema } from "../../packages/contracts/src/provider-output-schema.js";
import { responseInvocationKeyV2Schema } from "../../packages/contracts/src/text-response-format.js";
import { responseContractOperationV2MatchesInvocation } from "../../packages/contracts/src/generation-response-contract.js";

describe("cast discovery provider contract", () => {
  it("has a distinct nonstream invocation and never matches story generation", () => {
    expect(responseContractOperationV2Schema.safeParse("cast_discovery").success).toBe(true);
    expect(responseInvocationKeyV2Schema.safeParse("cast_discovery:nonstream").success).toBe(true);
    expect(responseInvocationKeyV2Schema.safeParse("cast_discovery:stream").success).toBe(false);
    expect(responseContractOperationV2MatchesInvocation("cast_discovery", "cast_discovery:nonstream")).toBe(true);
    expect(responseContractOperationV2MatchesInvocation("cast_discovery", "story:nonstream")).toBe(false);
    expect(responseContractOperationV2MatchesInvocation("story_generation", "cast_discovery:nonstream")).toBe(false);
  });
  it("bounds sparse evidence proposals and excludes authority fields at the wire and local boundaries", () => {
    const catalog = getProviderOutputSchemaV2("cast_discovery");
    expect(catalog?.version).toBe("cast-discovery-v1");
    const validate = new Ajv({ strict: false }).compile(catalog.schema);
    const person = { localKey: "mara", name: "Mara", aliases: [], existingCharacterId: null,
      identityEvidence: [{ paragraphId: "p1", quote: "Mara waits." }], observations: [] };
    expect(validate({ version: 1, characters: [person] })).toBe(true);
    expect(validate({ version: 1, characters: [] })).toBe(true);
    for (const value of [
      { version: 1, characters: [{ ...person, ownerUserId: "foreign" }] },
      { version: 1, characters: [{ ...person, identityEvidence: [] }] },
      { version: 1, characters: [{ ...person, observations: [{ paragraphId: "p1", quote: "Mara waits.",
        field: "relationship", value: "friend", mode: "fact", speakerCharacterId: null }] }] },
      { version: 1, characters: Array.from({ length: 21 }, (_, index) => ({ ...person, localKey: String(index) })) }
    ]) {
      expect(validate(value)).toBe(false);
      expect(castDiscoveryOutputSchema.safeParse(value).success).toBe(false);
    }
  });
});
