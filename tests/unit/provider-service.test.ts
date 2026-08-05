import { describe, expect, it } from "vitest";
import { toSafeProviderConfiguration } from "../../packages/application/src/providers/index.js";

describe("safe provider configuration", () => {
  it("drops arbitrary provider settings so secret-bearing fields are unrepresentable", () => {
    const configuration = toSafeProviderConfiguration({
      apiKey: "secondary-secret",
      nested: { accessToken: "nested-secret", apiUrl: "https://api.sogni.ai" },
      projectId: "sogni-project",
    });

    expect(configuration).toEqual({});
    expect(JSON.stringify(configuration)).not.toContain("secret");
  });
});
