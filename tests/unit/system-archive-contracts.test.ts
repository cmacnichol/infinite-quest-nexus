import { describe, expect, it } from "vitest";
import {
  systemArchiveJobViewSchema,
  systemArchivePayloadSchema
} from "../../packages/contracts/src/system-archives.js";

const sourceOwnerId = "11111111-1111-4111-8111-111111111111";
const providerId = "22222222-2222-4222-8222-222222222222";
const campaignId = "33333333-3333-4333-8333-333333333333";
const chronicleId = "44444444-4444-4444-8444-444444444444";

const validProviderRecord = {
  sourceId: providerId,
  kind: "text",
  displayName: "Text provider",
  baseUrl: "https://models.example.test/v1",
  selectedModel: "story-model",
  contextWindow: 16_384,
  timeoutMs: 30_000,
  retryLimit: 2,
  enabled: false,
  health: "unknown"
};

const validChronicleRecord = {
  sourceId: chronicleId,
  campaignId,
  kind: "memory",
  content: "The party entered the old observatory.",
  occurredAt: "2026-08-25T12:00:00.000Z",
  metadata: { entityNames: ["party", "observatory"] }
};

const validCampaignRecord = {
  sourceId: campaignId,
  worldVersionId: "77777777-7777-4777-8777-777777777777",
  title: "Observatory",
  status: "active",
  activeTurnNumber: 4,
  settings: { turnControlStyle: "Auto" },
  createdAt: "2026-08-25T12:00:00.000Z",
  updatedAt: "2026-08-25T12:00:00.000Z"
};

const validPayload = {
  formatVersion: 1,
  sourceInstallationId: "55555555-5555-4555-8555-555555555555",
  sourceOwnerCount: 1,
  sourceOwner: { sourceId: sourceOwnerId, displayName: "Archive owner" },
  records: [
    { domain: "providers", formatVersion: 1, sourceId: providerId, record: validProviderRecord },
    { domain: "chronicle", formatVersion: 1, sourceId: chronicleId, record: validChronicleRecord },
    {
      domain: "campaigns",
      formatVersion: 1,
      sourceId: campaignId,
      record: validCampaignRecord
    }
  ]
};

describe("System Archive contracts", () => {
  it("accepts complete normalized provider and vector-free Chronicle records", () => {
    expect(systemArchivePayloadSchema.parse(validPayload).sourceOwnerCount).toBe(1);
  });

  it.each([
    ["provider credential", 0, { ...validProviderRecord, encryptedApiKey: "secret" }],
    ["Chronicle embedding", 1, { ...validChronicleRecord, embedding: [0.1] }],
    ["Chronicle chunk", 1, { ...validChronicleRecord, chunk: "raw chunk" }],
    ["Chronicle cache", 1, { ...validChronicleRecord, queryCache: { key: "value" } }],
    ["filesystem path", 2, { ...validCampaignRecord, assetPath: "C:/archive/private.zip" }],
    ["equivalent filesystem path", 2, { ...validCampaignRecord, localFile: "private.zip" }],
    ["access capability", 2, { ...validCampaignRecord, deliveryCapability: "opaque-token" }],
    ["provider token", 2, { ...validCampaignRecord, providerToken: "secret" }],
    ["equivalent secret", 2, { ...validCampaignRecord, authToken: "secret" }],
    ["active job", 2, { ...validCampaignRecord, generationJob: { status: "queued" } }],
    ["model chain", 2, { ...validCampaignRecord, modelChain: { previousResponseId: "response" } }]
  ])("rejects %s at the System Archive payload boundary", (_label, recordIndex, record) => {
    const records = validPayload.records.map((entry, index) => index === recordIndex ? { ...entry, record } : entry);
    expect(systemArchivePayloadSchema.safeParse({ ...validPayload, records }).success).toBe(false);
  });

  it("accepts a queued job view without leaking an operational capability", () => {
    const job = {
      id: "66666666-6666-4666-8666-666666666666",
      kind: "export",
      status: "queued",
      createdAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-25T12:00:00.000Z",
      report: null
    };

    expect(systemArchiveJobViewSchema.parse(job).status).toBe("queued");
  });
});
