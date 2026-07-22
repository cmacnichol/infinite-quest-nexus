import { describe, expect, it } from "vitest";
import { providerProfileInputSchema } from "../../packages/contracts/src/generation.js";
import { resolveDefaultIntentProviderId } from "../../services/api/src/provider-service.js";

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

  it("uses only an explicitly enabled default intent profile", async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const pool = {
      query: async (sql: string, values: unknown[]) => {
        queries.push({ sql, values });
        return { rows: [] };
      }
    };
    await expect(resolveDefaultIntentProviderId(pool as never, "owner-1")).resolves.toBeNull();
    expect(queries[0]?.sql).toContain("provider_role = 'intent'");
    expect(queries[0]?.sql).toContain("is_default = true");
  });
});
