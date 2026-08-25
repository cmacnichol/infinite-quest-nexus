import { describe, expect, it } from "vitest";
import {
  systemArchiveJobViewSchema,
  systemArchivePayloadSchema
} from "../../packages/contracts/src/system-archives.js";

const sourceOwnerId = "11111111-1111-4111-8111-111111111111";
const providerId = "22222222-2222-4222-8222-222222222222";
const campaignId = "33333333-3333-4333-8333-333333333333";
const chronicleId = "44444444-4444-4444-8444-444444444444";
const worldId = "77777777-7777-4777-8777-777777777777";
const worldVersionId = "88888888-8888-4888-8888-888888888888";
const worldDraftId = "99999999-9999-4999-8999-999999999999";

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

const validWorldContent = {
  schemaVersion: 5,
  world: {
    title: "The Observatory",
    genre: "Fantasy",
    tone: "Mysterious",
    premise: "An old observatory awakens.",
    backgroundStory: "It has watched the valley for centuries.",
    firstAction: "Enter the observatory.",
    rules: "Magic has consequences."
  },
  playableCharacters: [{ id: "scholar", name: "Nia", characterText: "A determined scholar.", rpgStats: [], defaultTriggers: [] }],
  entities: [{ id: "observatory", name: "The Observatory", kind: "location", description: "A moonlit tower.", tags: ["ruin"], facts: [{ key: "door", value: "sealed" }] }],
  relationships: [{ id: "observatory-valley", fromEntityId: "observatory", toEntityId: "valley", kind: "overlooks", description: "The tower overlooks the valley." }],
  rpgStats: [{ id: "resolve", name: "Resolve", value: 4, note: "Stand against fear." }],
  defaultTriggers: [{ id: "arrival", name: "Arrival", condition: "Enter a location", effect: "Describe the scene." }],
  eventTriggers: [{ id: "bell", label: "Bell toll", timing: "after", condition: "The bell rings", effect: "Advance the mystery.", addTextAfter: false, triggeredCount: 0, lastTriggeredTurn: null, lastTriggeredAt: null }],
  assets: [{ assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "world_cover" }],
  defaults: { selectedCharacterId: "scholar", initialLocation: "The Observatory" }
};

const validCampaignState = {
  continuitySummary: "The party has entered the observatory.",
  openThreads: ["Why is the door sealed?"],
  canonicalFacts: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", content: "The observatory door is sealed." }],
  scratchpad: "Watch the bell.",
  trackers: [{ id: "danger", name: "Danger", value: "2", rules: "Increase after loud noise." }],
  rpgStats: [{ id: "resolve", name: "Resolve", value: 4, note: "Stand against fear." }],
  defaultTriggers: [{ id: "arrival", name: "Arrival", condition: "Enter a location", effect: "Describe the scene." }],
  eventTriggers: [{ id: "bell", label: "Bell toll", timing: "after", condition: "The bell rings", effect: "Advance the mystery.", addTextAfter: false, triggeredCount: 0, lastTriggeredTurn: null, lastTriggeredAt: null }],
  pendingEventTriggers: [{ id: "bell-pending", sourceTriggerId: "bell", name: "Bell toll", timing: "after", condition: "", effect: "", instructions: "Advance the mystery.", reason: "Awaiting narration.", sourceTurn: 4 }]
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
    },
    {
      domain: "world-versions",
      formatVersion: 1,
      sourceId: worldVersionId,
      record: {
        sourceId: worldVersionId,
        worldId,
        versionNumber: 3,
        title: "The Observatory",
        content: validWorldContent,
        contentFingerprint: "c".repeat(64),
        releaseNotes: "Expanded observatory lore.",
        createdFromRevision: 2,
        publishedAt: "2026-08-25T12:00:00.000Z"
      }
    },
    {
      domain: "world-drafts",
      formatVersion: 1,
      sourceId: worldDraftId,
      record: {
        sourceId: worldDraftId,
        worldId,
        basedOnWorldVersionId: worldVersionId,
        title: "The Observatory",
        revision: 4,
        content: validWorldContent,
        createdAt: "2026-08-25T12:00:00.000Z",
        updatedAt: "2026-08-25T12:00:00.000Z"
      }
    },
    {
      domain: "campaign-state",
      formatVersion: 1,
      sourceId: campaignId,
      record: {
        sourceId: campaignId,
        campaignId,
        revision: 6,
        state: validCampaignState,
        updatedAt: "2026-08-25T12:00:00.000Z"
      }
    }
  ]
};

describe("System Archive contracts", () => {
  it("round-trips complete logical world and campaign-state authority", () => {
    const parsed = systemArchivePayloadSchema.parse(validPayload);
    expect(parsed.sourceOwnerCount).toBe(1);
    expect(parsed.records[3]).toMatchObject({ record: { content: { world: { title: "The Observatory" }, entities: [{ id: "observatory" }] } } });
    expect(parsed.records[4]).toMatchObject({ record: { content: { playableCharacters: [{ id: "scholar" }] } } });
    expect(parsed.records[5]).toMatchObject({ record: { state: { trackers: [{ id: "danger", value: "2" }], canonicalFacts: [{ content: "The observatory door is sealed." }] } } });
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

  it.each([
    [3, { ...validPayload.records[3]!.record, content: { ...validWorldContent, assetPath: "C:/private/world.json" } }],
    [4, { ...validPayload.records[4]!.record, content: { ...validWorldContent, providerToken: "secret" } }],
    [5, { ...validPayload.records[5]!.record, state: { ...validCampaignState, chronicleChunk: "derived" } }]
  ])("rejects excluded authority field at record %i", (recordIndex, record) => {
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
