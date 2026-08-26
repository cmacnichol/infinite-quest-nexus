import { describe, expect, it } from "vitest";
import {
  SYSTEM_ARCHIVE_DOMAINS,
  systemArchiveImportReportSchema,
  systemArchiveManifestSchema,
  systemArchiveJobViewSchema,
  systemArchivePayloadSchema,
  systemCampaignHistoryDetailsSchema,
  systemImportPreviewViewSchema,
  systemRecordEnvelopeSchema
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
  turnId: null,
  memoryKind: "legacy_summary",
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
  selectedCharacterId: null,
  characterSnapshot: null,
  characterProfile: null,
  characterProfileRevision: 0,
  createdAt: "2026-08-25T12:00:00.000Z",
  updatedAt: "2026-08-25T12:00:00.000Z"
};

const validCharacterProfile = {
  identity: {
    aliases: ["The Star Reader"],
    pronouns: "she/her"
  },
  story: {
    role: "Scholar of impossible skies",
    background: "Nia learned to read the observatory's forgotten instruments.",
    personality: "Patient and determined.",
    motivations: "Restore the observatory's purpose.",
    goals: "Translate its final star chart.",
    fearsAndConflicts: "Fears waking what the observatory watches.",
    keyRelationships: "Trusts the valley archivist.",
    narrativeHooks: "Carries a lens cut from fallen starlight.",
    voiceAndMannerisms: "Speaks precisely and sketches while thinking.",
    otherGuidance: "Protects discoveries from reckless use."
  },
  appearance: {
    ancestryOrSpecies: "Human",
    apparentAge: "32",
    genderPresentation: "Woman",
    build: "Lean",
    skinOrComplexion: "Warm brown",
    face: "Angular features",
    eyes: "Dark amber",
    hair: "Black curls pinned with brass clips",
    distinguishingFeatures: ["Star-shaped scar on her left palm"],
    clothing: "Ink-stained indigo coat",
    equipmentAndAccessories: "Brass astrolabe and field journal",
    otherVisualDetails: "Silver dust gathers at her cuffs."
  },
  unclassifiedNotes: "Refuses to abandon an unfinished question."
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
  playableCharacters: [{
    id: "scholar",
    name: "Nia",
    characterText: "A determined scholar.",
    profile: validCharacterProfile,
    rpgStats: [],
    defaultTriggers: [{ id: "scholar-lens", name: "Star lens", value: "Clouded", rules: "Update when Nia deciphers a star chart." }]
  }],
  entities: [{ id: "observatory", name: "The Observatory", kind: "location", description: "A moonlit tower.", tags: ["ruin"], facts: [{ key: "door", value: "sealed" }] }],
  relationships: [{ id: "observatory-valley", fromEntityId: "observatory", toEntityId: "valley", kind: "overlooks", description: "The tower overlooks the valley." }],
  rpgStats: [{ id: "resolve", name: "Resolve", value: 4, note: "Stand against fear." }],
  defaultTriggers: [{ id: "arrival", name: "Arrival", value: "Awaiting entry", rules: "Update when the party enters a new location." }],
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
  defaultTriggers: [{ id: "arrival", name: "Arrival", value: "Entered observatory", rules: "Update when the party enters a new location." }],
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
  it("accepts only field-complete version-two portable authority records", () => {
    const exact = "  \n# Authority sentinel\n\n```text\n  exact bytes  \n```\n  ";
    const createdAt = "2026-08-25T12:00:00.123Z";
    const updatedAt = "2026-08-25T12:00:01.456Z";
    const records = [
      {
        domain: "providers", formatVersion: 2, sourceId: providerId,
        record: {
          ...validProviderRecord,
          kind: "intent",
          authority: {
            providerType: "openrouter", providerRole: "intent", defaultModel: "intent-model",
            contextWindowTokens: 12_345, maxOutputTokens: 678, temperature: 0.37,
            configuration: { modelDiscoveryEnabled: true, maximumAttempts: 4 },
            requestTimeoutMs: 45_678, enabled: true, isDefault: true, createdAt, updatedAt
          }
        }
      },
      {
        domain: "campaigns", formatVersion: 2, sourceId: campaignId,
        record: {
          ...validCampaignRecord,
          authority: {
            textProviderProfileId: providerId, imageProviderProfileId: null,
            storyLengthProfile: "extended", turnControlStyle: "flexible_scene",
            legacySettings: { exact }
          }
        }
      },
      {
        domain: "turns", formatVersion: 2, sourceId: chronicleId,
        record: {
          sourceId: chronicleId, campaignId, turnNumber: 4, action: exact,
          narration: exact, choices: [exact], imagePrompt: exact,
          stateSnapshotPrivate: {}, acceptedAt: updatedAt,
          authority: {
            sourceTurnId: "legacy-turn-4", customActionSuggestion: exact, imageUrl: null,
            mechanicsPrivate: { roll: 17 }, modelMetadata: { model: "story-model" },
            importMetadata: { source: "sentinel" }, createdAt, inputMode: "scene",
            inputModeSource: "explicit"
          }
        }
      },
      {
        domain: "chronicle", formatVersion: 2, sourceId: chronicleId,
        record: {
          sourceId: chronicleId, campaignId, kind: "memory", turnId: null,
          memoryKind: "campaign_summary", content: exact,
          authority: {
            worldVersionId, ordinal: 27, tokenEstimate: 83, importance: 0.73,
            entities: ["  Nia  "], metadata: { markdown: exact }, entityIds: [],
            contentHash: "e".repeat(64), createdAt, updatedAt
          }
        }
      },
      {
        domain: "imports", formatVersion: 2, sourceId: worldDraftId,
        record: {
          sourceId: worldDraftId, campaignId, sourceType: "legacy_story",
          sourceName: exact, sourceHash: "f".repeat(64), completedAt: updatedAt,
          authority: {
            status: "completed", worldId, worldVersionId, stats: { imported: 9 },
            errorMessage: null, createdAt
          }
        }
      }
    ];

    const parsed = records.map((record) => systemRecordEnvelopeSchema.parse(record));
    expect(parsed.map((entry) => entry.formatVersion)).toEqual([2, 2, 2, 2, 2]);
    expect((parsed[2]!.record as { action: string }).action).toBe(exact);
    expect((parsed[3]!.record as { authority: { ordinal: number } }).authority.ordinal).toBe(27);
    expect(() => systemRecordEnvelopeSchema.parse({
      ...records[3],
      record: { ...records[3]!.record, authority: undefined }
    })).toThrow();
  });
  it("validates authoritative prose without transforming exact bytes", () => {
    const exact = "  \n# Exact Markdown\n\n```text\n  keep leading spaces  \n```\n  ";
    const promptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa90";
    const parsed = systemRecordEnvelopeSchema.parse({
      domain: "prompts",
      formatVersion: 1,
      sourceId: promptId,
      record: {
        sourceId: promptId,
        campaignId,
        templateKey: "story_system",
        overrideText: exact,
        updatedAt: "2026-08-25T12:00:00.000Z"
      }
    });

    expect(parsed.domain).toBe("prompts");
    if (parsed.domain !== "prompts") throw new Error("Expected a prompt record.");
    expect(parsed.record.overrideText).toBe(exact);
    expect(() => systemRecordEnvelopeSchema.parse({
      ...parsed,
      record: { ...parsed.record, templateKey: " \r\n\t " }
    })).toThrow();
  });
  it("preserves distinct global and campaign-scoped prompt override authority", () => {
    const globalPromptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    const campaignPromptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
    const records = [
      ...validPayload.records,
      {
        domain: "prompts",
        formatVersion: 1,
        sourceId: globalPromptId,
        record: {
          sourceId: globalPromptId,
          campaignId: null,
          templateKey: "story_system",
          overrideText: "Global story guidance.",
          updatedAt: "2026-08-25T12:00:00.000Z"
        }
      },
      {
        domain: "prompts",
        formatVersion: 1,
        sourceId: campaignPromptId,
        record: {
          sourceId: campaignPromptId,
          campaignId,
          templateKey: "story_system",
          overrideText: "Campaign story guidance.",
          updatedAt: "2026-08-25T12:00:01.000Z"
        }
      }
    ];

    const parsed = systemArchivePayloadSchema.parse({ ...validPayload, records });

    expect(parsed.records.slice(-2).map((entry) => entry.record)).toEqual([
      expect.objectContaining({ sourceId: globalPromptId, campaignId: null, templateKey: "story_system" }),
      expect.objectContaining({ sourceId: campaignPromptId, campaignId, templateKey: "story_system" })
    ]);
  });

  it("requires exact narration-correction revision authority", () => {
    const correctionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
    const turnId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
    const parsed = systemRecordEnvelopeSchema.parse({
      domain: "turn-corrections",
      formatVersion: 1,
      sourceId: correctionId,
      record: {
        sourceId: correctionId,
        turnId,
        revision: 7,
        narration: "The seventh accepted correction.",
        previousEffectiveNarrationHash: "d".repeat(64),
        reason: "Restore exact accepted history.",
        source: "user_edit",
        correctedAt: "2026-08-25T12:00:07.000Z"
      }
    });

    expect(parsed.record).toMatchObject({
      revision: 7,
      previousEffectiveNarrationHash: "d".repeat(64),
      reason: "Restore exact accepted history.",
      source: "user_edit"
    });
  });

  it("requires portable campaign, turn, canonical-fact, import, and world-fork authority", () => {
    const turnId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
    const stateEditId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7";
    const factId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8";
    const importedId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9";
    const snapshot = {
      id: "scholar",
      name: "Nia",
      characterText: "A determined scholar.",
      profile: validCharacterProfile,
      rpgStats: [],
      defaultTriggers: [],
      source: { type: "world-version", revision: 3 }
    };
    const records = [
      {
        domain: "worlds", formatVersion: 1, sourceId: worldId,
        record: {
          sourceId: worldId,
          title: "The Observatory",
          status: "active",
          forkedFromWorldId: null,
          forkedFromWorldVersionId: null,
          createdAt: "2026-08-25T12:00:00.000Z",
          updatedAt: "2026-08-25T12:00:00.000Z"
        }
      },
      {
        domain: "campaigns", formatVersion: 1, sourceId: campaignId,
        record: {
          ...validCampaignRecord,
          selectedCharacterId: "scholar",
          characterSnapshot: snapshot,
          characterProfile: { name: "Nia", profile: validCharacterProfile },
          characterProfileRevision: 3
        }
      },
      {
        domain: "turns", formatVersion: 1, sourceId: turnId,
        record: {
          sourceId: turnId,
          campaignId,
          turnNumber: 4,
          action: "Open the door.",
          narration: "The door opens.",
          choices: [],
          imagePrompt: "An opening observatory door.",
          stateSnapshotPrivate: validCampaignState,
          acceptedAt: "2026-08-25T12:00:04.000Z"
        }
      },
      {
        domain: "canonical-facts", formatVersion: 1, sourceId: factId,
        record: {
          sourceId: factId,
          campaignId,
          worldVersionId,
          sourceTurnId: turnId,
          sourceStateEditId: null,
          sourceTurnNumber: 4,
          sourceFactIndex: 7,
          subject: "observatory door",
          predicate: "status",
          object: "open",
          validFromTurn: 4,
          validUntilTurn: 6,
          supersededByFactId: null,
          createdAt: "2026-08-25T12:00:04.000Z",
          updatedAt: "2026-08-25T12:00:06.000Z"
        }
      },
      {
        domain: "imports", formatVersion: 1, sourceId: importedId,
        record: {
          sourceId: importedId,
          campaignId,
          sourceType: "campaign_archive",
          sourceName: "Observatory campaign",
          sourceHash: "e".repeat(64),
          completedAt: "2026-08-25T12:00:07.000Z"
        }
      }
    ] as const;

    for (const record of records) {
      expect(systemRecordEnvelopeSchema.parse(record)).toEqual(record);
    }
  });

  it("rejects nested secret and operational fields from portable state and character authority", () => {
    const snapshot = {
      id: "scholar",
      name: "Nia",
      characterText: "A determined scholar.",
      profile: validCharacterProfile,
      rpgStats: [],
      defaultTriggers: [],
      source: { type: "world-version", revision: 3 }
    };
    const invalidRecords = [
      {
        domain: "turns", formatVersion: 1, sourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
        record: {
          sourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4", campaignId, turnNumber: 4,
          action: "Open.", narration: "Opened.", choices: [], imagePrompt: "Door.",
          stateSnapshotPrivate: {
            ...validCampaignState,
            trackers: [{ ...validCampaignState.trackers[0], credentials: { token: "must-reject" } }]
          },
          acceptedAt: "2026-08-25T12:00:04.000Z"
        }
      },
      {
        domain: "campaigns", formatVersion: 1, sourceId: campaignId,
        record: {
          ...validCampaignRecord,
          selectedCharacterId: "scholar",
          characterSnapshot: {
            ...snapshot,
            source: { ...snapshot.source, nonce: "must-reject" }
          }
        }
      },
      {
        domain: "campaigns", formatVersion: 1, sourceId: campaignId,
        record: {
          ...validCampaignRecord,
          selectedCharacterId: "scholar",
          characterSnapshot: snapshot,
          characterProfile: {
            name: "Nia",
            profile: {
              ...validCharacterProfile,
              story: { ...validCharacterProfile.story, modelChain: { previousResponseId: "must-reject" } }
            }
          },
          characterProfileRevision: 3
        }
      }
    ] as const;

    for (const record of invalidRecords) {
      expect(systemRecordEnvelopeSchema.safeParse(record).success).toBe(false);
    }
  });

  it("requires every declared v1 authority key instead of synthesizing import defaults", () => {
    const turn = {
      domain: "turns", formatVersion: 1, sourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
      record: {
        sourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4", campaignId, turnNumber: 4,
        action: "Open.", narration: "Opened.", choices: [], imagePrompt: "Door.",
        stateSnapshotPrivate: validCampaignState,
        acceptedAt: "2026-08-25T12:00:04.000Z"
      }
    } as const;
    const world = {
      domain: "worlds", formatVersion: 1, sourceId: worldId,
      record: {
        sourceId: worldId, title: "The Observatory", status: "active",
        forkedFromWorldId: null, forkedFromWorldVersionId: null,
        createdAt: "2026-08-25T12:00:00.000Z", updatedAt: "2026-08-25T12:00:00.000Z"
      }
    } as const;

    expect(systemRecordEnvelopeSchema.safeParse({
      ...turn, record: { ...turn.record, stateSnapshotPrivate: undefined }
    }).success).toBe(false);
    expect(systemRecordEnvelopeSchema.safeParse({
      ...world, record: { ...world.record, forkedFromWorldId: undefined }
    }).success).toBe(false);
    for (const key of [
      "selectedCharacterId", "characterSnapshot", "characterProfile", "characterProfileRevision",
    ] as const) {
      const record = { ...validCampaignRecord } as Record<string, unknown>;
      delete record[key];
      expect(systemRecordEnvelopeSchema.safeParse({
        domain: "campaigns", formatVersion: 1, sourceId: campaignId, record,
      }).success).toBe(false);
    }
    expect(systemCampaignHistoryDetailsSchema.safeParse({
      eventType: "memory-config",
      details: {
        embeddingEnabled: false, embeddingProviderProfileId: null,
        embeddingModel: "", embeddingBatchSize: 16,
      }
    }).success).toBe(false);
    expect(systemCampaignHistoryDetailsSchema.safeParse({
      eventType: "illustration-config",
      details: {
        enabled: false, providerProfileId: null, model: "", size: "1024x1024",
        aspectRatio: "1:1", quality: "auto", outputFormat: "png", maxAttempts: 3,
        segmentWordCount: 500, imagesPerSegment: 1, segmentPromptMode: "direct",
        refinementPrompt: "",
      }
    }).success).toBe(false);
  });

  it("validates exact campaign history and portable configuration authority", () => {
    const providerProfileId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa10";
    const records = [
      {
        eventType: "character-profile-edit",
        details: {
          revision: 3,
          previousProfile: { name: "Nia", profile: validCharacterProfile },
          nextProfile: { name: "Nia Vale", profile: validCharacterProfile },
          editSource: "manual"
        }
      },
      {
        eventType: "campaign-state-edit",
        details: {
          effectiveTurnNumber: 4,
          revision: 6,
          stateSnapshot: validCampaignState,
          changedFields: ["canonicalFacts", "trackers"]
        }
      },
      {
        eventType: "memory-config",
        details: {
          embeddingEnabled: true,
          embeddingProviderProfileId: providerProfileId,
          embeddingModel: "embed-model",
          embeddingBatchSize: 24,
          embeddingDocumentPrefix: "search_document: ",
          embeddingQueryPrefix: "search_query: ",
          retrievalImplementation: "chunked_hybrid",
          retrievalShadowEnabled: true,
          createdAt: "2026-08-25T12:00:00.000Z",
          updatedAt: "2026-08-25T12:01:00.000Z"
        }
      },
      {
        eventType: "illustration-config",
        details: {
          enabled: true,
          providerProfileId,
          model: "image-model",
          size: "1536x1024",
          aspectRatio: "3:2",
          quality: "high",
          outputFormat: "webp",
          maxAttempts: 4,
          sourcePolicy: "library_then_generate",
          matchingScope: "campaign",
          confidenceProfile: "strict",
          repetitionWindow: 9,
          segmentWordCount: 250,
          imagesPerSegment: 2,
          segmentPromptMode: "ai_refined",
          refinementPrompt: "Preserve the fiction-only aesthetic.",
          createdAt: "2026-08-25T12:00:00.000Z",
          updatedAt: "2026-08-25T12:01:00.000Z"
        }
      },
      {
        eventType: "world-migration",
        details: {
          fromWorldVersionId: worldVersionId,
          toWorldVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa12",
          note: "Advance the campaign."
        }
      },
      {
        eventType: "world-transfer",
        details: {
          sourceCampaignId: campaignId,
          targetCampaignId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa13",
          fromWorldVersionId: worldVersionId,
          toWorldVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa12",
          characterStrategy: "preserve_source",
          stateStrategy: "preserve",
          targetDefaultsPolicy: "retain_source",
          sourceFingerprint: "f".repeat(64),
          warnings: ["Review imported provider assignments."],
          note: "Transfer the campaign."
        }
      }
    ] as const;

    for (const record of records) {
      expect(systemCampaignHistoryDetailsSchema.parse(record)).toEqual(record);
    }
    expect(systemCampaignHistoryDetailsSchema.safeParse({
      eventType: "campaign-state-edit",
      details: { ...records[1].details, stateSnapshot: undefined }
    }).success).toBe(false);
    expect(systemCampaignHistoryDetailsSchema.safeParse({
      eventType: "illustration-config",
      details: { ...records[3].details, sourcePolicy: "off" }
    }).success).toBe(false);
  });

  it("requires event-specific version-two campaign-history authority", () => {
    const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa14";
    const turnId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa15";
    const illustrationSetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa16";
    const exactSource = "  \n# Segment source\n\n```text\n exact bytes \n```\n  ";
    const record = {
      domain: "campaign-history",
      formatVersion: 2,
      sourceId,
      record: {
        sourceId,
        campaignId,
        eventType: "illustration-segment",
        content: JSON.stringify({
          illustrationSetId,
          turnId,
          ordinal: 0,
          startOffset: 0,
          endOffset: exactSource.length,
          startWord: 0,
          endWord: 4,
          directPrompt: "Exact segment.",
          resolvedPrompt: "Exact segment.",
          promptSource: "direct",
          status: "completed",
        }),
        occurredAt: "2026-08-25T12:00:00.000Z",
        authority: {
          sourceText: exactSource,
          sourceTextHash: "d".repeat(64),
          updatedAt: "2026-08-25T12:01:00.000Z",
        },
      },
    } as const;

    expect(systemRecordEnvelopeSchema.parse(record).record).toMatchObject(record.record);
    expect(systemRecordEnvelopeSchema.safeParse({
      ...record,
      record: { ...record.record, authority: {} },
    }).success).toBe(false);
  });

  it("requires Chronicle memories to carry their authoritative turn and memory kind", () => {
    const turnId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5";
    const parsed = systemRecordEnvelopeSchema.parse({
      domain: "chronicle",
      formatVersion: 1,
      sourceId: chronicleId,
      record: {
        ...validChronicleRecord,
        turnId,
        memoryKind: "open_thread"
      }
    });

    expect(parsed.record).toMatchObject({
      kind: "memory",
      turnId,
      memoryKind: "open_thread"
    });
  });

  it("requires Chronicle summary checkpoints to carry exact checkpoint authority", () => {
    const checkpoint = {
      domain: "chronicle",
      formatVersion: 1,
      sourceId: chronicleId,
      record: {
        sourceId: chronicleId,
        campaignId,
        kind: "summary-checkpoint",
        throughTurn: 4,
        summaryKind: "legacy_full_history",
        content: "The complete accepted story through turn four.",
        occurredAt: "2026-08-25T12:00:00.000Z",
        metadata: {
          entityNames: ["observatory"],
          openThreadIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6"]
        }
      }
    } as const;

    expect(systemRecordEnvelopeSchema.parse(checkpoint).record).toMatchObject({
      kind: "summary-checkpoint",
      throughTurn: 4,
      summaryKind: "legacy_full_history",
      metadata: { openThreadIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6"] }
    });
    expect(systemRecordEnvelopeSchema.safeParse({
      ...checkpoint,
      record: { ...checkpoint.record, throughTurn: undefined }
    }).success).toBe(false);
    expect(systemRecordEnvelopeSchema.safeParse({
      ...checkpoint,
      record: { ...checkpoint.record, summaryKind: "worker_private_summary" }
    }).success).toBe(false);
    expect(systemRecordEnvelopeSchema.safeParse({
      ...checkpoint,
      record: {
        ...checkpoint.record,
        metadata: { ...checkpoint.record.metadata, openThreadIds: ["not-a-uuid"] }
      }
    }).success).toBe(false);
  });

  it("requires source-installation and current-owner provenance on the root manifest", () => {
    const manifest = {
      format: "infinite-quest-archive",
      formatVersion: 1,
      archiveType: "system",
      createdAt: "2026-08-25T12:00:00.000Z",
      contentFingerprint: "a".repeat(64),
      sourceApplication: "0.1.0",
      sourceMigration: "0079_resumable_system_archive_uploads",
      sourceInstallationId: validPayload.sourceInstallationId,
      sourceOwnerCount: 1,
      sourceOwner: validPayload.sourceOwner,
      omittedOperationalRows: 7,
      operationalOmissions: {
        generation: 2,
        illustration: 1,
        chronicle: 3,
        imports: 0,
        "system-archive": 1
      },
      entries: [],
      payloads: [],
      assets: []
    };

    expect(systemArchiveManifestSchema.parse(manifest)).toMatchObject({
      sourceInstallationId: validPayload.sourceInstallationId,
      sourceApplication: "0.1.0",
      sourceMigration: "0079_resumable_system_archive_uploads",
      sourceOwnerCount: 1,
      sourceOwner: validPayload.sourceOwner,
      omittedOperationalRows: 7,
      operationalOmissions: manifest.operationalOmissions
    });
    expect(systemArchiveManifestSchema.safeParse({
      ...manifest,
      sourceInstallationId: undefined
    }).success).toBe(false);
    expect(systemArchiveManifestSchema.safeParse({
      ...manifest,
      sourceMigration: undefined
    }).success).toBe(false);
    expect(systemArchiveManifestSchema.safeParse({
      ...manifest,
      sourceOwner: undefined
    }).success).toBe(false);
    expect(systemArchiveManifestSchema.safeParse({
      ...manifest,
      operationalOmissions: { ...manifest.operationalOmissions, generation: 1 }
    }).success).toBe(false);
  });

  it("requires the durable Import Report to disclose normalization and reconciliation", () => {
    const report = {
      completedAt: "2026-08-25T12:05:00.000Z",
      archiveFingerprint: "a".repeat(64),
      recordsByDomain: Object.fromEntries(SYSTEM_ARCHIVE_DOMAINS.map((domain) => [domain, 0])),
      assetCount: 3,
      assetBytes: 4_096,
      omittedOperationalRows: 7,
      operationalOmissions: {
        generation: 2,
        illustration: 1,
        chronicle: 3,
        imports: 0,
        "system-archive": 1
      },
      warnings: ["Provider credentials must be re-entered."],
      errors: [],
      versions: {
        archiveFormat: 1,
        sourceApplication: "0.1.0",
        sourceMigration: "0079_resumable_system_archive_uploads",
        destinationApplication: "0.1.0",
        destinationMigration: "0079_resumable_system_archive_uploads"
      },
      sourceOwnerCount: 1,
      ownerMapping: { sourceOwnerId, destinationOwnerId: sourceOwnerId },
      disabledProviders: 1,
      normalization: ["map-source-owner-to-initial-owner", "disable-provider-profiles"],
      invalidatedAccess: ["share-links", "sessions", "oidc-identities", "external-authorizations"],
      integrityReconciliation: {
        archiveFingerprintVerified: true,
        recordsMatched: true,
        assetsMatched: true
      },
      rebuildState: {
        chronicleIndex: { category: "chronicle-index", status: "pending", itemCount: 2 },
        assetThumbnails: { category: "asset-thumbnails", status: "pending", itemCount: 3 }
      }
    };

    expect(systemArchiveImportReportSchema.parse(report)).toEqual(report);
    expect(systemArchiveImportReportSchema.safeParse({
      ...report,
      integrityReconciliation: { ...report.integrityReconciliation, recordsMatched: false }
    }).success).toBe(false);
    expect(systemArchiveImportReportSchema.safeParse({
      ...report,
      operationalOmissions: { ...report.operationalOmissions, chronicle: 2 }
    }).success).toBe(false);
    expect(systemArchiveImportReportSchema.safeParse({
      ...report,
      versions: undefined
    }).success).toBe(false);
    expect(systemArchiveJobViewSchema.safeParse({
      id: "66666666-6666-4666-8666-666666666666",
      kind: "import",
      status: "authoritative_committed",
      createdAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-25T12:05:00.000Z",
      report: {
        completedAt: report.completedAt,
        archiveFingerprint: report.archiveFingerprint,
        recordsByDomain: report.recordsByDomain,
        assetCount: report.assetCount,
        assetBytes: report.assetBytes,
        omittedOperationalRows: report.omittedOperationalRows,
        operationalOmissions: report.operationalOmissions,
        warnings: report.warnings,
        errors: []
      }
    }).success).toBe(false);
  });

  it("round-trips complete logical world and campaign-state authority", () => {
    const parsed = systemArchivePayloadSchema.parse(validPayload);
    expect(parsed.sourceOwnerCount).toBe(1);
    expect(parsed.records[3]).toMatchObject({ record: { content: {
      world: { title: "The Observatory" },
      playableCharacters: [{
        id: "scholar",
        profile: {
          story: { motivations: "Restore the observatory's purpose." },
          appearance: { distinguishingFeatures: ["Star-shaped scar on her left palm"] }
        },
        defaultTriggers: [{ id: "scholar-lens", value: "Clouded", rules: "Update when Nia deciphers a star chart." }]
      }],
      entities: [{ id: "observatory" }],
      defaultTriggers: [{ id: "arrival", value: "Awaiting entry", rules: "Update when the party enters a new location." }]
    } } });
    expect(parsed.records[4]).toMatchObject({ record: { content: { playableCharacters: [{ id: "scholar", profile: { identity: { pronouns: "she/her" } } }] } } });
    expect(parsed.records[5]).toMatchObject({ record: { state: {
      trackers: [{ id: "danger", value: "2" }],
      defaultTriggers: [{ id: "arrival", value: "Entered observatory", rules: "Update when the party enters a new location." }],
      canonicalFacts: [{ content: "The observatory door is sealed." }]
    } } });
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
    ["world asset path", 3, { ...validPayload.records[3]!.record, content: { ...validWorldContent, assetPath: "C:/private/world.json" } }],
    ["profile provider token", 3, { ...validPayload.records[3]!.record, content: {
      ...validWorldContent,
      playableCharacters: [{
        ...validWorldContent.playableCharacters[0]!,
        profile: { ...validCharacterProfile, story: { ...validCharacterProfile.story, providerToken: "secret" } }
      }]
    } }],
    ["default-trigger job", 3, { ...validPayload.records[3]!.record, content: {
      ...validWorldContent,
      defaultTriggers: [{ ...validWorldContent.defaultTriggers[0]!, generationJob: { status: "queued" } }]
    } }],
    ["draft provider token", 4, { ...validPayload.records[4]!.record, content: { ...validWorldContent, providerToken: "secret" } }],
    ["campaign-state Chronicle chunk", 5, { ...validPayload.records[5]!.record, state: { ...validCampaignState, chronicleChunk: "derived" } }]
  ])("rejects excluded %s at record %i", (_label, recordIndex, record) => {
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

  it("requires a complete safe Import Preview and rejects local storage details", () => {
    const recordsByDomain = Object.fromEntries([
      "providers", "prompts", "worlds", "world-versions", "world-drafts",
      "campaigns", "turns", "turn-corrections", "campaign-state",
      "campaign-history", "canonical-facts", "chronicle", "illustrations",
      "imports", "cost-events", "activity-events"
    ].map((domain) => [domain, domain === "campaigns" ? 2 : 0]));
    const preview = {
      valid: true,
      previewHandle: "p".repeat(43),
      versions: {
        archiveFormat: 1,
        sourceApplication: "0.1.0",
        sourceMigration: "0079_resumable_system_archive_uploads",
        destinationApplication: "0.1.0",
        destinationMigration: "0079_resumable_system_archive_uploads"
      },
      sourceOwnerCount: 1,
      archiveFingerprint: "a".repeat(64),
      recordsByDomain,
      assets: { originalCount: 3, totalBytes: 4_096 },
      destinationEmpty: true,
      ownerMapping: { sourceOwnerId, destinationOwnerId: sourceOwnerId },
      disabledProviders: 1,
      omittedOperationalRows: 7,
      operationalOmissions: {
        generation: 2,
        illustration: 1,
        chronicle: 3,
        imports: 0,
        "system-archive": 1
      },
      invalidatedAccess: ["share-links", "sessions", "oidc-identities", "external-authorizations"],
      normalization: ["map-source-owner-to-initial-owner", "disable-provider-profiles"],
      rebuilds: {
        chronicleIndex: { category: "chronicle-index", status: "pending", itemCount: 2 },
        assetThumbnails: { category: "asset-thumbnails", status: "pending", itemCount: 3 }
      },
      space: {
        staging: { requiredBytes: 8_192, availableBytes: 16_384, verified: true, sufficient: true, overrideUsed: false },
        assetRoot: { requiredBytes: 4_096, availableBytes: 8_192, verified: true, sufficient: true, overrideUsed: false }
      },
      warnings: [],
      errors: [],
      expiresAt: "2026-08-25T12:30:00.000Z"
    };

    expect(systemImportPreviewViewSchema.parse(preview)).toEqual(preview);
    expect(systemImportPreviewViewSchema.safeParse({ ...preview, localPath: "C:/private/system.zip" }).success).toBe(false);
    expect(systemImportPreviewViewSchema.safeParse({
      ...preview,
      versions: { ...preview.versions, sourceMigration: undefined }
    }).success).toBe(false);
    expect(systemImportPreviewViewSchema.safeParse({
      ...preview,
      omittedOperationalRows: 6
    }).success).toBe(false);
    expect(systemImportPreviewViewSchema.safeParse({
      ...preview,
      space: { ...preview.space, staging: { ...preview.space.staging, availableBytes: null } }
    }).success).toBe(false);
    expect(systemImportPreviewViewSchema.safeParse({
      ...preview,
      space: {
        ...preview.space,
        staging: {
          ...preview.space.staging,
          availableBytes: null,
          verified: false,
          sufficient: true,
          overrideUsed: false
        }
      }
    }).success).toBe(false);
    expect(systemImportPreviewViewSchema.safeParse({
      ...preview,
      space: {
        ...preview.space,
        staging: { ...preview.space.staging, overrideUsed: true }
      }
    }).success).toBe(false);
  });
});
