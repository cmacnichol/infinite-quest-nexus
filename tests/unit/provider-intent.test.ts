import { describe, expect, it } from "vitest";
import { providerProfileInputSchema } from "../../packages/contracts/src/generation.js";
import type { ProviderResolutionRequest } from "../../packages/application/src/providers/index.js";

describe("turn intent provider role", () => {
  it("accepts an independently configured intent profile", () => {
    const profile = providerProfileInputSchema.parse({
      name: "Small classifier",
      providerType: "lmstudio",
      providerRole: "intent",
      baseUrl: "http://classifier.test",
      defaultModel: "small-model",
      contextWindowTokens: 8192,
      maxOutputTokens: 256,
      temperature: 0
    });
    expect(profile.providerRole).toBe("intent");
  });

  it("requires intent resolution to name the intent role explicitly", () => {
    const request: ProviderResolutionRequest<"intent"> = {
      ownerUserId: "owner-1",
      providerRole: "intent",
    };
    expect(request).toEqual({ ownerUserId: "owner-1", providerRole: "intent" });
  });
});
