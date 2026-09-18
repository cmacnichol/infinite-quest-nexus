import { describe, expect, it, vi } from "vitest";
import { createProviderApplicationAdapter } from "../../services/api/src/provider-application-adapter.js";

const owner = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000002";
const input = {
  name: "Text", providerType: "openrouter", providerRole: "text", baseUrl: "https://openrouter.example/api/v1",
  defaultModel: "model", contextWindowTokens: 8192, maxOutputTokens: 1024, temperature: 0.5, requestTimeoutMs: 60_000,
  configuration: {}, enabled: true, isDefault: false
};

function adapter() {
  const application = {
    createProfile: vi.fn(), updateProfile: vi.fn(), listProfiles: vi.fn(), listModels: vi.fn()
  };
  const runtime = { storeCredential: vi.fn(), discoverCandidateModelsWithCredential: vi.fn() };
  return { application, runtime, adapter: createProviderApplicationAdapter({ application, runtime, transaction: async (work: (binding: never) => Promise<unknown>) => work({ application, runtime } as never) } as never) };
}

describe("provider API configuration boundary", () => {
  it.each(["create", "update", "candidate"] as const)("rejects an invalid raw response format policy for %s before safe projection", async (operation) => {
    const value = adapter();
    const invalid = { ...input, configuration: { textResponseFormatPolicy: "schema", ignoredClaim: true } };
    const call = operation === "create" ? () => value.adapter.create(owner, invalid as never)
      : operation === "update" ? () => value.adapter.update(owner, id, { configuration: invalid.configuration } as never)
        : () => value.adapter.discoverModels(owner, invalid as never);
    await expect(call()).rejects.toMatchObject({ statusCode: 400 });
    expect(value.application.createProfile).not.toHaveBeenCalled();
    expect(value.application.updateProfile).not.toHaveBeenCalled();
    expect(value.runtime.discoverCandidateModelsWithCredential).not.toHaveBeenCalled();
  });

  it("allows closed policy values while ignoring unknown raw configuration claims", async () => {
    const value = adapter();
    value.application.createProfile.mockResolvedValue({ profile: { ...input, id, hasCredential: false, health: { status: "unknown", consecutiveFailures: 0, lastCheckedAt: null }, createdAt: "now", updatedAt: "now" }, configurationProjection: { kind: "same_request_echo", configuration: { textResponseFormatPolicy: "auto" } } });
    await value.adapter.create(owner, { ...input, configuration: { textResponseFormatPolicy: "auto", browserProof: true } } as never);
    expect(value.application.createProfile.mock.calls[0]?.[0].configuration).toEqual({ textResponseFormatPolicy: "auto" });
  });
});
