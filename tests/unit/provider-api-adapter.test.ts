import { describe, expect, it, vi } from "vitest";
import { createProviderApplicationAdapter } from "../../services/api/src/provider-application-adapter.js";
import { providerEndpointIdentity } from "../../services/runtime/src/provider-capability-cache.js";

const owner = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000002";
const input = {
  name: "Text", providerType: "openrouter", providerRole: "text", baseUrl: "https://openrouter.example/api/v1",
  defaultModel: "model", contextWindowTokens: 8192, maxOutputTokens: 1024, temperature: 0.5, requestTimeoutMs: 60_000,
  configuration: {}, enabled: true, isDefault: false
};

function adapter(responseFormatCapabilities?: object) {
  const application = {
    createProfile: vi.fn(), updateProfile: vi.fn(), listProfiles: vi.fn(), listModels: vi.fn()
  };
  const runtime = { storeCredential: vi.fn(), discoverCandidateModelsWithCredential: vi.fn(),
    resolveCandidatePresetWithCredential: vi.fn(async (_candidate: { baseUrl: string }, _slug: string, _credential: string | null) => ({ preset: {} })),
    presetSaveAuthoritySnapshot: vi.fn(async (_ownerUserId: string, _providerProfileId: string, _lock: boolean, _includeCredential: boolean): Promise<Readonly<{ candidate: unknown; credential?: string | null; revision: string }> | null> => null) };
  return { application, runtime, adapter: createProviderApplicationAdapter({ application, runtime, responseFormatCapabilities, transaction: async (work: (binding: never) => Promise<unknown>) => work({ application, runtime } as never) } as never) };
}

describe("provider API configuration boundary", () => {
  it.each([
    [{ kind: "openrouter_preset", slug: "night-shift" }, "legacy"],
    [{ kind: "model", modelId: "model" }, "required"]
  ] as const)("rejects generic text generation without an operation contract for %j", async (selection, policy) => {
    const value = adapter();
    const execute = vi.fn();
    (value.application as never as { resolveDirect: ReturnType<typeof vi.fn> }).resolveDirect = vi.fn(async () => ({
      status: "resolved", providerProfileId: id, model: selection.kind === "model" ? selection.modelId : `@preset/${selection.slug}`
    }));
    value.application.listProfiles.mockResolvedValue([{ ...input, id, textSelection: selection,
      configuration: { textResponseFormatPolicy: policy } }]);
    (value.runtime as never as { execution: unknown }).execution = { text: vi.fn(async () => ({ model: "model", execute })) };
    await expect(value.adapter.generateText(owner, { messages: [{ role: "user", content: "Hello" }] } as never))
      .rejects.toMatchObject({ code: "unsupported_operation", statusCode: 409 });
    expect(execute).not.toHaveBeenCalled();
  });

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

  it.each(["create", "update", "candidate"] as const)("rejects malformed text execution overrides for %s before safe projection", async (operation) => {
    const value = adapter();
    const invalid = { ...input, configuration: { textExecutionOverrides: { parameters: { temperature: 99 } }, ignoredClaim: true } };
    const call = operation === "create" ? () => value.adapter.create(owner, invalid as never)
      : operation === "update" ? () => value.adapter.update(owner, id, { configuration: invalid.configuration } as never)
        : () => value.adapter.discoverModels(owner, invalid as never);
    await expect(call()).rejects.toMatchObject({ statusCode: 400 });
    expect(value.application.createProfile).not.toHaveBeenCalled();
    expect(value.application.updateProfile).not.toHaveBeenCalled();
    expect(value.runtime.discoverCandidateModelsWithCredential).not.toHaveBeenCalled();
  });

  it.each(["image", "embedding"] as const)("rejects text execution overrides for a %s profile", async (providerRole) => {
    const value = adapter();
    await expect(value.adapter.create(owner, {
      ...input,
      providerRole,
      configuration: { textExecutionOverrides: { parameters: { temperature: 0.4 } } }
    } as never)).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/text execution overrides/i) });
    expect(value.application.createProfile).not.toHaveBeenCalled();
  });

  it("returns the repository Required default on create while retaining safe same-request fields", async () => {
    const value = adapter();
    value.application.createProfile.mockResolvedValue({
      profile: {
        ...input, id,
        configuration: {
          textResponseFormatPolicy: "required",
          textExecutionOverrides: { parameters: { temperature: 0.2 } }
        },
        hasCredential: false,
        health: { status: "unknown", consecutiveFailures: 0, lastCheckedAt: null },
        createdAt: "now", updatedAt: "now"
      },
      configurationProjection: {
        kind: "same_request_echo",
        configuration: { textExecutionOverrides: { parameters: { temperature: 0.2 } } }
      }
    });

    const result = await value.adapter.create(owner, {
      ...input,
      configuration: { textExecutionOverrides: { parameters: { temperature: 0.2 } } }
    } as never);

    expect(result.configuration).toEqual({
      textResponseFormatPolicy: "required",
      textExecutionOverrides: { parameters: { temperature: 0.2 } }
    });
  });

  it("accepts a native OpenRouter preset and derives its legacy default model", async () => {
    const value = adapter();
    const textSelection = { kind: "openrouter_preset" as const, slug: "nexus-nsfw" };
    value.application.createProfile.mockResolvedValue({
      profile: {
        ...input, id, defaultModel: "@preset/nexus-nsfw", textSelection,
        configuration: { textResponseFormatPolicy: "required" }, hasCredential: false,
        health: { status: "unknown", consecutiveFailures: 0, lastCheckedAt: null }, createdAt: "now", updatedAt: "now"
      },
      configurationProjection: { kind: "same_request_echo", configuration: { textResponseFormatPolicy: "required" } }
    });

    const result = await value.adapter.create(owner, { ...input, defaultModel: "", textSelection } as never);

    expect(value.application.createProfile).toHaveBeenCalledWith(expect.objectContaining({
      defaultModel: "@preset/nexus-nsfw", textSelection
    }));
    expect(result).toMatchObject({ defaultModel: "@preset/nexus-nsfw", textSelection });
  });

  it.each(["create", "candidate"] as const)("rejects a supplied text selection for an image profile at %s", async (operation) => {
    const value = adapter();
    const image = {
      ...input, providerRole: "image", textSelection: { kind: "openrouter_preset", slug: "nexus-nsfw" }
    };
    const call = operation === "create"
      ? () => value.adapter.create(owner, image as never)
      : () => value.adapter.discoverModels(owner, image as never);
    await expect(call()).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/text selection/i) });
    expect(value.application.createProfile).not.toHaveBeenCalled();
    expect(value.runtime.discoverCandidateModelsWithCredential).not.toHaveBeenCalled();
  });

  it("preserves an explicit compatibility policy when a rename-only patch omits it", async () => {
    const value = adapter();
    value.application.listProfiles.mockResolvedValue([{ ...input, id, configuration: { textResponseFormatPolicy: "legacy" },
      textSelection: { kind: "model", modelId: "model" } }]);
    value.application.updateProfile.mockResolvedValue({
      profile: {
        ...input, id, name: "Renamed", configuration: { textResponseFormatPolicy: "legacy" },
        textSelection: { kind: "model", modelId: "model" }, hasCredential: false,
        health: { status: "unknown", consecutiveFailures: 0, lastCheckedAt: null }, createdAt: "now", updatedAt: "now"
      }, configurationProjection: { kind: "sanitized_read" }
    });
    const result = await value.adapter.update(owner, id, { name: "Renamed" } as never);
    expect(value.application.updateProfile).toHaveBeenCalledWith(expect.objectContaining({ changes: { name: "Renamed" } }));
    expect(result.configuration).toEqual({ textResponseFormatPolicy: "legacy" });
  });

  it("validates a preset PATCH from one authority snapshot when the profile changes after the initial list read", async () => {
    const value = adapter();
    const staleProfile = { ...input, id, baseUrl: "https://endpoint-a.example/v1", textSelection: { kind: "model" as const, modelId: "model" } };
    const authorityProfile = {
      ...input, id, baseUrl: "https://endpoint-b.example/v1", textSelection: { kind: "model" as const, modelId: "model" },
      hasCredential: true, health: { status: "unknown" as const, consecutiveFailures: 0, lastCheckedAt: null }, createdAt: "now", updatedAt: "later"
    };
    value.application.listProfiles.mockResolvedValue([staleProfile]);
    value.runtime.presetSaveAuthoritySnapshot.mockResolvedValue({
      candidate: authorityProfile, credential: "rotated-secret", revision: "authority-b"
    });
    value.runtime.resolveCandidatePresetWithCredential.mockImplementation(async (candidate, _slug, credential) => {
      if (candidate.baseUrl !== authorityProfile.baseUrl || credential !== "rotated-secret") {
        throw new Error("preset validation mixed endpoint and credential authority");
      }
      return { preset: {} };
    });
    value.application.updateProfile.mockResolvedValue({
      profile: { ...authorityProfile, defaultModel: "@preset/night-shift", textSelection: { kind: "openrouter_preset" as const, slug: "night-shift" } },
      configurationProjection: { kind: "sanitized_read" }
    });

    const result = await value.adapter.update(owner, id, {
      defaultModel: "@preset/night-shift", textSelection: { kind: "openrouter_preset", slug: "night-shift" }
    } as never);

    expect(result).toMatchObject({ baseUrl: authorityProfile.baseUrl, textSelection: { kind: "openrouter_preset", slug: "night-shift" } });
  });

  it("does not expose text response-format metadata through image inventory or a text embedding fallback", async () => {
    const value = adapter();
    const metadata = { supportedParameters: ["response_format"], discoveredAt: "2026-09-18T00:00:00.000Z" };
    const profile = { ...input, id, hasCredential: false, health: { status: "unknown", consecutiveFailures: 0, lastCheckedAt: null }, createdAt: "now", updatedAt: "now" };
    value.application.listModels.mockResolvedValue({ models: [{ id: "model", name: "Model", contextWindowTokens: 8192, responseFormatAdvertisement: { supportedParameters: ["response_format"], discoveredAt: "2026-09-18T00:00:00.000Z" } }] });
    value.application.listProfiles.mockResolvedValue([{ ...profile, providerRole: "image" }]);
    const image = await value.adapter.models(owner, id, "image");
    expect(image[0]).not.toHaveProperty("responseFormatAdvertisement");
    expect(image[0]).not.toHaveProperty("responseFormatRegistryDigest");

    value.application.listProfiles.mockResolvedValue([profile]);
    const embedding = await value.adapter.models(owner, id, "embedding");
    expect(embedding[0]).not.toHaveProperty("responseFormatAdvertisement");
    expect(embedding[0]).not.toHaveProperty("responseFormatRegistryDigest");
  });

  it("projects text-model capability only from server inventory and verification state", async () => {
    const capabilities = { registryDigest: "a".repeat(64), now: () => "2026-09-18T12:00:00.000Z", eligibility: vi.fn(() => ({ status: "verified", reason: "verified", verification: { verifiedAt: "2026-09-18T00:00:00.000Z", expiresAt: "2026-09-19T00:00:00.000Z" } })) };
    const value = adapter(capabilities);
    const profile = { ...input, id, configuration: { textResponseFormatPolicy: "auto" }, hasCredential: false, health: { status: "unknown", consecutiveFailures: 0, lastCheckedAt: null }, createdAt: "now", updatedAt: "now" };
    value.application.listProfiles.mockResolvedValue([profile]);
    value.application.listModels.mockResolvedValue({ models: [{ id: "model", name: "Model", responseFormatAdvertisement: { supportedParameters: ["response_format", "structured_outputs"], discoveredAt: "2026-09-18T00:00:00.000Z" } }] });
    const [model] = await value.adapter.models(owner, id, "text");
    expect(model).toBeDefined();
    expect(model!.responseFormatCapability).toMatchObject({ model: "model", expectedRegistryDigest: "a".repeat(64), advertisedAt: "2026-09-18T00:00:00.000Z" });
    const capability = model!.responseFormatCapability!;
    expect(capability.operations).toEqual(expect.arrayContaining([expect.objectContaining({ operation: "story", streaming: true, status: "verified" })]));
    expect(capabilities.eligibility).toHaveBeenCalledWith(expect.objectContaining({ now: "2026-09-18T12:00:00.000Z", endpointIdentity: providerEndpointIdentity(input.baseUrl) }));
    expect(JSON.stringify(model!.responseFormatCapability)).not.toContain("browserProof");
  });
});
