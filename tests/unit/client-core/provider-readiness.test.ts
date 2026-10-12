import { CURRENT_STORY_RESPONSE_FORMAT_CAPABILITY_IDENTITY, safeProviderProfileViewSchema, type SafeProviderProfileView } from "@infinite-quest/contracts";
import { describe, expect, it, vi } from "vitest";
import { providerReadinessForRole, type ProviderInventoryObservation } from "../../../packages/client-core/src/provider-readiness.js";

const now = Date.parse("2026-10-03T12:00:00.000Z");
const textProfileId = "11111111-1111-4111-8111-111111111111";
const storyCapability = {
  version: 1 as const,
  model: "vendor/story-model",
  expectedRegistryDigest: "synthetic-registry-v1",
  advertisedAt: "2026-10-03T10:00:00.000Z",
  operations: [{ operation: "story" as const, streaming: false, status: "verified" as const, reason: null, schemaVersion: CURRENT_STORY_RESPONSE_FORMAT_CAPABILITY_IDENTITY.schemaVersion, schemaHash: CURRENT_STORY_RESPONSE_FORMAT_CAPABILITY_IDENTITY.schemaHash, verifiedAt: "2026-10-03T10:00:00.000Z", expiresAt: "2026-10-04T10:00:00.000Z" }]
};
const storyOperation = storyCapability.operations[0];
if (!storyOperation) throw new Error("The typed Story capability fixture must include its operation.");

function profile(overrides: Partial<SafeProviderProfileView> = {}): SafeProviderProfileView {
  return safeProviderProfileViewSchema.parse({
    id: textProfileId, name: "Synthetic text", providerType: "openrouter", providerRole: "text", baseUrl: "https://text.example.test/v1", defaultModel: "vendor/story-model", textSelection: { kind: "model", modelId: "vendor/story-model" }, contextWindowTokens: 32768, maxOutputTokens: 4096, temperature: 0.8, requestTimeoutMs: 300000, configuration: { textResponseFormatPolicy: "required" }, enabled: true, isDefault: true, healthStatus: "healthy", consecutiveFailures: 0, lastHealthCheckAt: "2026-10-03T11:00:00.000Z", lastHealthError: null, hasApiKey: true, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-03T11:00:00.000Z", responseFormatCapability: storyCapability, ...overrides
  });
}

function inventory(overrides: Partial<ProviderInventoryObservation> = {}): ProviderInventoryObservation {
  return { profileId: textProfileId, role: "text", providerType: "openrouter", baseUrl: "https://text.example.test/v1", modelId: "vendor/story-model", status: "available", modelIds: ["vendor/story-model"], checkedAt: "2026-10-03T11:30:00.000Z", ...overrides };
}

const assess = (candidate = profile(), evidence: readonly ProviderInventoryObservation[] = [inventory()]) => providerReadinessForRole("text", [candidate], evidence, now, Date.parse);

describe("provider readiness", () => {
  it("reports ready only from healthy, selected-model inventory and current exact schema evidence", () => {
    expect(assess().state).toBe("ready");
    expect(assess().capability).toBe("verified");
  });

  it("keeps unconfigured roles independent", () => {
    expect(providerReadinessForRole("image", [profile()], [], now, Date.parse)).toMatchObject({ state: "not-configured", health: "not-configured", inventory: "not-configured", capability: "not-applicable" });
  });

  it.each([
    ["unknown", { advertisedAt: null, operations: [{ ...storyOperation, status: "unknown" }] }, "unknown"],
    ["expired", { operations: [{ ...storyOperation, verifiedAt: "2026-10-01T10:00:00.000Z", expiresAt: "2026-10-02T10:00:00.000Z" }] }, "expired"],
    ["malformed", { operations: [{ ...storyOperation, expiresAt: "not-a-time" }] }, "malformed"],
    ["wrong schema identity", { operations: [{ ...storyOperation, schemaHash: "0".repeat(64) }] }, "identity-mismatch"],
    ["wrong model identity", { model: "vendor/other-model" }, "identity-mismatch"]
  ] as const)("does not mark %s capability ready", (_name, patch, expectedCapability) => {
    const capability = { ...storyCapability, ...patch } as unknown as NonNullable<SafeProviderProfileView["responseFormatCapability"]>;
    const candidate = expectedCapability === "malformed"
      ? { ...profile(), responseFormatCapability: capability } as SafeProviderProfileView
      : profile({ responseFormatCapability: capability });
    expect(assess(candidate).state).toBe("unavailable");
    expect(assess(candidate).capability).toBe(expectedCapability);
  });
  it("rejects an impossible advertised operation status at the untrusted boundary", () => {
    const malformed = { ...storyCapability, operations: [{ ...storyOperation, status: "advertised" }] } as unknown as NonNullable<SafeProviderProfileView["responseFormatCapability"]>;
    const candidate = { ...profile(), responseFormatCapability: malformed } as SafeProviderProfileView;
    expect(assess(candidate)).toMatchObject({ state: "unavailable", capability: "malformed" });
  });

  it("uses the newest matching inventory observation so failure or checking supersedes older success", () => {
    expect(assess(profile(), [inventory(), inventory({ status: "unavailable", modelIds: [], checkedAt: "2026-10-03T11:45:00.000Z" })])).toMatchObject({ state: "unavailable", inventory: "unavailable" });
    expect(assess(profile(), [inventory({ status: "unavailable", modelIds: [], checkedAt: "2026-10-03T11:15:00.000Z" }), inventory()])).toMatchObject({ state: "ready", inventory: "available" });
    expect(assess(profile(), [inventory(), inventory({ status: "checking", modelIds: [], checkedAt: null })])).toMatchObject({ state: "checking", inventory: "checking" });
  });

  it("requires the capability operation to match streaming and reject unsupported or invalid times", () => {
    const wrongStreaming = profile({ configuration: { streaming: true } });
    expect(assess(wrongStreaming)).toMatchObject({ state: "unavailable", capability: "identity-mismatch" });
    const unsupported = { ...storyCapability, operations: [{ ...storyOperation, status: "unsupported" as const }] };
    expect(assess(profile({ responseFormatCapability: unsupported }))).toMatchObject({ state: "unavailable", capability: "unsupported" });
    const futureVerified = { ...storyCapability, operations: [{ ...storyOperation, verifiedAt: "2026-10-04T10:00:00.000Z" }] };
    expect(assess(profile({ responseFormatCapability: futureVerified }))).toMatchObject({ state: "unavailable", capability: "malformed" });
    const inverted = { ...storyCapability, operations: [{ ...storyOperation, verifiedAt: "2026-10-03T11:00:00.000Z", expiresAt: "2026-10-03T10:00:00.000Z" }] };
    expect(assess(profile({ responseFormatCapability: inverted }))).toMatchObject({ state: "unavailable", capability: "malformed" });
  });

  it("keeps image and embedding readiness independent of text schema capability", () => {
    const image = profile({ id: "22222222-2222-4222-8222-222222222222", name: "Synthetic image", providerType: "openai_compatible", providerRole: "image", baseUrl: "https://image.example.test/v1", defaultModel: "vendor/image-model", textSelection: { kind: "model", modelId: "vendor/image-model" }, responseFormatCapability: undefined, configuration: {} });
    const embedding = profile({ id: "33333333-3333-4333-8333-333333333333", name: "Synthetic embedding", providerRole: "embedding", defaultModel: "vendor/embedding-model", textSelection: { kind: "model", modelId: "vendor/embedding-model" }, responseFormatCapability: undefined, configuration: {} });
    const imageInventory: ProviderInventoryObservation = { profileId: image.id, role: "image", providerType: image.providerType, baseUrl: image.baseUrl, modelId: image.defaultModel, status: "available", modelIds: [image.defaultModel], checkedAt: "2026-10-03T11:30:00.000Z" };
    const embeddingInventory: ProviderInventoryObservation = { profileId: embedding.id, role: "embedding", providerType: embedding.providerType, baseUrl: embedding.baseUrl, modelId: embedding.defaultModel, status: "available", modelIds: [embedding.defaultModel], checkedAt: "2026-10-03T11:30:00.000Z" };
    expect(providerReadinessForRole("image", [profile(), image], [inventory(), imageInventory], now, Date.parse)).toMatchObject({ state: "ready", capability: "not-applicable" });
    expect(providerReadinessForRole("embedding", [profile(), embedding], [inventory(), embeddingInventory], now, Date.parse)).toMatchObject({ state: "ready", capability: "not-applicable" });
    expect(providerReadinessForRole("text", [profile()], [inventory()], now, Date.parse)).toMatchObject({ state: "ready", capability: "verified" });
    expect(providerReadinessForRole("image", [profile(), { ...image, healthStatus: "unavailable" }], [inventory(), imageInventory], now, Date.parse).state).toBe("unavailable");
  });

  it("uses an enabled non-default profile when the default is disabled and rejects only-disabled roles", () => {
    const disabledDefault = profile({ enabled: false });
    const alternate = profile({ id: "44444444-4444-4444-8444-444444444444", name: "Alternate text", isDefault: false, defaultModel: "vendor/alternate-model", textSelection: { kind: "model", modelId: "vendor/alternate-model" }, responseFormatCapability: { ...storyCapability, model: "vendor/alternate-model" } });
    const alternateInventory = inventory({ profileId: alternate.id, modelId: alternate.defaultModel, modelIds: [alternate.defaultModel] });
    expect(providerReadinessForRole("text", [disabledDefault, alternate], [inventory(), alternateInventory], now, Date.parse)).toMatchObject({ state: "ready", profileId: alternate.id });
    expect(providerReadinessForRole("text", [disabledDefault], [inventory()], now, Date.parse)).toMatchObject({ state: "unavailable", profileId: disabledDefault.id });
  });
  it("classifies a contract-valid advertised-at but unverified story capability as not ready", () => {
    const capability = { ...storyCapability, operations: [{ ...storyOperation, status: "unknown" as const, verifiedAt: null, expiresAt: null }] };
    expect(assess(profile({ responseFormatCapability: capability }))).toMatchObject({ state: "unavailable", capability: "advertised" });
  });
  it("does not let stale inventory identity or absent selected models establish readiness", () => {
    expect(assess(profile(), [inventory({ baseUrl: "https://other.example.test/v1" })])).toMatchObject({ state: "unavailable", inventory: "unknown" });
    expect(assess(profile(), [inventory({ modelIds: ["vendor/other-model"] })])).toMatchObject({ state: "unavailable", inventory: "unavailable" });
  });

  it("does not treat unknown or stale health as ready", () => {
    expect(assess(profile({ healthStatus: "unknown", lastHealthCheckAt: null })).state).toBe("unavailable");
    expect(assess(profile({ healthStatus: "healthy", lastHealthCheckAt: "2026-10-04T11:00:00.000Z" })).health).toBe("unknown");
  });

  it("rejects future evidence clocks", () => {
    expect(providerReadinessForRole("text", [profile()], [inventory({ checkedAt: "2026-10-04T11:00:00.000Z" })], now, Date.parse)).toMatchObject({ state: "unavailable", inventory: "unavailable" });
    expect(providerReadinessForRole("text", [profile()], [inventory()], Number.NaN, Date.parse).state).toBe("unavailable");
  });
  it("requires current model inventory evidence and exposes an actual pending check", () => {
    expect(assess(profile(), []).inventory).toBe("unknown");
    expect(assess(profile(), [inventory({ status: "checking", checkedAt: null, modelIds: [] })]).state).toBe("checking");
  });
  it("uses the supplied parser for each observation and verified capability timestamp", () => {
    const candidate = profile();
    const observation = inventory();
    const parser = vi.fn((value: string) => Date.parse(value));
    expect(providerReadinessForRole("text", [candidate], [observation], now, parser).state).toBe("ready");
    expect(parser.mock.calls.map(([value]) => value)).toEqual([
      candidate.lastHealthCheckAt,
      observation.checkedAt,
      storyOperation.verifiedAt,
      storyOperation.expiresAt
    ]);
    parser.mockClear();
    const advertised = profile({ responseFormatCapability: { ...storyCapability, operations: [{ ...storyOperation, status: "unknown", verifiedAt: null, expiresAt: null }] } });
    expect(providerReadinessForRole("text", [advertised], [observation], now, parser).capability).toBe("advertised");
    expect(parser).toHaveBeenCalledWith(storyCapability.advertisedAt);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("rejects nonfinite parser results (%s) without marking a role ready", (invalid) => {
    const parser = () => invalid;
    expect(providerReadinessForRole("text", [profile()], [inventory()], now, parser)).toMatchObject({
      state: "unavailable", health: "unknown", inventory: "unavailable", capability: "malformed"
    });
  });
});
