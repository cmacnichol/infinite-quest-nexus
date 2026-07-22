import { describe, expect, it } from "vitest";
import { safeTurnInput } from "../../services/api/src/generation-service.js";

describe("story generation turn input boundary", () => {
  it("accepts ordinary multiline fiction without treating formatting changes as mechanics removal", () => {
    expect(safeTurnInput("  I cross the courtyard.\nThen I knock on the door.  "))
      .toBe("I cross the courtyard.\nThen I knock on the door.");
  });

  it("reports every blocked mechanics fragment and its category", () => {
    expect(() => safeTurnInput("I roll a 17, then inspect the raw model response."))
      .toThrowError(/Blocked fragments: "roll a 17" \(dice\), "raw model response" \(engine metadata\)/);

    try {
      safeTurnInput("I roll a 17, then inspect the raw model response.");
      throw new Error("Expected unsafe input to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({
        statusCode: 400,
        code: "unsafe_turn_input",
        details: {
          code: "unsafe_turn_input",
          findings: [
            { category: "dice", text: "roll a 17", index: 2 },
            { category: "engine_metadata", text: "raw model response", index: 30 }
          ]
        }
      });
    }
  });
});
