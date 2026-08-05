import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createProviderApplication,
  toSafeProviderConfiguration,
  type CharacterOrganizationCostPort,
  type CharacterOrganizationPromptPort,
  type ChronicleCostPort,
  type ChroniclePromptPort,
  type CreateProviderProfileCommand,
  type DirectProviderResolution,
  type EmbeddingProviderResolution,
  type GenerationCostPort,
  type GenerationPromptPort,
  type ProviderIllustrationCostPort,
  type IllustrationPromptPort,
  type InfiniteWorldsCostPort,
  type InfiniteWorldsPromptPort,
  type ImmutablePromptSnapshot,
  type ProviderApplicationDependencies,
  type ProviderProfileChanges,
  type ProviderProfileView,
  type ProviderHealthDiagnosticCode,
  type ProviderRuntimeLeasePort,
  type SafeProviderConfiguration,
  type TurnCostScope,
  type WorldGenerationCostPort,
  type WorldGenerationPromptPort
} from "../../packages/application/src/providers/index.js";

const owner = { ownerUserId: "00000000-0000-4000-8000-000000000001" } as const;

const textProfile: ProviderProfileView = {
  id: "00000000-0000-4000-8000-000000000010",
  name: "Local text",
  providerType: "lmstudio",
  providerRole: "text",
  capability: "text_generation",
  baseUrl: "http://model.internal/v1",
  defaultModel: "story-model",
  contextWindowTokens: 32_768,
  maxOutputTokens: 4_096,
  temperature: 0.8,
  requestTimeoutMs: 300_000,
  configuration: toSafeProviderConfiguration({ streaming: true }),
  enabled: true,
  isDefault: true,
  hasCredential: false,
  health: {
    status: "healthy",
    consecutiveFailures: 0,
    lastCheckedAt: "2026-08-05T12:00:00.000Z"
  },
  createdAt: "2026-08-05T12:00:00.000Z",
  updatedAt: "2026-08-05T12:00:00.000Z"
};

function dependencies(): ProviderApplicationDependencies {
  return {
    profiles: {
      listProfiles: vi.fn(async () => [textProfile]),
      createProfile: vi.fn(async () => textProfile),
      updateProfile: vi.fn(async () => textProfile),
      deleteProfile: vi.fn(async () => ({
        id: textProfile.id,
        name: textProfile.name,
        providerRole: textProfile.providerRole,
        deleted: true as const
      })),
      setDefaultProfile: vi.fn(async () => textProfile)
    },
    inventory: {
      listModels: vi.fn(async (request) => ({
        providerProfileId: request.providerProfileId,
        providerRole: request.providerRole,
        models: [{ id: "story-model", name: "Story model" }]
      })),
      discoverCandidateModels: vi.fn(async (candidate) => ({
        providerProfileId: null,
        providerRole: candidate.providerRole,
        models: []
      }))
    },
    health: {
      recordHealth: vi.fn(async () => undefined)
    },
    resolution: {
      resolveDirect: vi.fn(async (request) => ({
        status: "resolved" as const,
        requestedRole: request.providerRole,
        resolvedRole: request.providerRole,
        providerProfileId: textProfile.id,
        providerType: textProfile.providerType,
        model: request.model || textProfile.defaultModel
      })),
      resolveEmbedding: vi.fn(async () => ({
        status: "resolved" as const,
        requestedRole: "embedding" as const,
        resolvedRole: "text" as const,
        source: "text_fallback" as const,
        providerProfileId: textProfile.id,
        providerType: textProfile.providerType,
        model: "embedding-model"
      }))
    },
    prompts: {
      listPromptLibrary: vi.fn(async () => ({
        catalogVersion: "prompt-library-v1",
        campaignId: null,
        templates: []
      })),
      previewPrompt: vi.fn(async (request) => ({
        sections: [{ label: "System", role: "system" as const, content: request.content }],
        estimatedTokens: 1,
        unresolvedVariables: []
      })),
      savePromptOverride: vi.fn(async () => ({
        catalogVersion: "prompt-library-v1",
        campaignId: null,
        templates: []
      })),
      resetPromptOverride: vi.fn(async () => ({
        catalogVersion: "prompt-library-v1",
        campaignId: null,
        templates: []
      })),
      loadPromptSnapshot: vi.fn(async () => ({
        catalogVersion: "prompt-library-v1",
        protocolVersion: "prompt-library-v1-example",
        snapshot: {
          story_system: { content: "Write fiction.", hash: "abc", source: "shipped" as const }
        } as unknown as ImmutablePromptSnapshot
      }))
    },
    intent: {
      classifyTurnIntent: vi.fn(async () => ({
        classificationId: "00000000-0000-4000-8000-000000000020",
        classification: "action" as const,
        resolvedMode: "action" as const,
        confidenceBand: "clear" as const,
        providerSource: "intent_default" as const,
        expiresAt: "2026-08-05T12:10:00.000Z"
      }))
    },
    costs: {
      recordCost: vi.fn(async () => "00000000-0000-4000-8000-000000000030"),
      attributeGenerationCostsToTurn: vi.fn(async () => undefined),
      getTurnCosts: vi.fn(async () => new Map()),
      getCampaignCostSummary: vi.fn(async (_scope) => ({
        campaignId: "00000000-0000-4000-8000-000000000040",
        hasReportedCosts: false,
        totals: []
      }))
    }
  };
}

describe("provider application contracts", () => {
  it("keeps owner authority explicit while delegating profile operations", async () => {
    const ports = dependencies();
    const application = createProviderApplication(ports);

    await application.listProfiles(owner);
    await application.setDefaultProfile({
      ...owner,
      providerProfileId: textProfile.id,
      providerRole: "text"
    });

    expect(ports.profiles.listProfiles).toHaveBeenCalledWith(owner);
    expect(ports.profiles.setDefaultProfile).toHaveBeenCalledWith({
      ...owner,
      providerProfileId: textProfile.id,
      providerRole: "text"
    });
  });

  it("delegates every owner-scoped inventory, health, prompt, intent, and cost use case", async () => {
    const ports = dependencies();
    const application = createProviderApplication(ports);
    const campaignScope = { ...owner, campaignId: "00000000-0000-4000-8000-000000000040" };
    const transaction = {};

    await application.deleteProfile({ ...owner, providerProfileId: textProfile.id });
    await application.listModels({ ...owner, providerProfileId: textProfile.id, providerRole: "text" });
    await application.discoverCandidateModels({
      ...owner,
      name: "Candidate image",
      providerType: "openai_compatible",
      providerRole: "image",
      baseUrl: "http://image.internal/v1",
      defaultModel: "image-model",
      contextWindowTokens: 32_768,
      maxOutputTokens: 4_096,
      temperature: 0.8,
      requestTimeoutMs: 300_000,
      configuration: toSafeProviderConfiguration({}),
      enabled: true,
      isDefault: false
    });
    await application.recordHealth({
      ...owner,
      providerProfileId: textProfile.id,
      outcome: "failed",
      diagnosticCode: "transport_failure"
    });
    await application.listPromptLibrary({ ...owner, scope: "application" });
    await application.previewPrompt({ ...owner, key: "story_system", content: "Write fiction." });
    await application.savePromptOverride({
      ...owner,
      scope: "campaign",
      campaignId: campaignScope.campaignId,
      key: "story_system",
      content: "Write restrained fiction."
    });
    await application.resetPromptOverride({
      ...owner,
      scope: "campaign",
      campaignId: campaignScope.campaignId,
      key: "story_system"
    });
    await application.classifyTurnIntent({ ...campaignScope, text: "Open the gate." });
    await application.recordCost(transaction, {
      ...campaignScope,
      providerProfileId: textProfile.id,
      providerType: "lmstudio",
      requestedModel: "story-model",
      category: "story",
      operation: "story_generation",
      usage: { inputTokens: 10, outputTokens: 20 },
      reportedCost: { amount: "0.01", currency: "USD" }
    });
    await application.attributeGenerationCostsToTurn(transaction, {
      ...campaignScope,
      generationJobId: "00000000-0000-4000-8000-000000000050",
      turnId: "00000000-0000-4000-8000-000000000060"
    });
    await application.getTurnCosts({
      ...campaignScope,
      turnIds: ["00000000-0000-4000-8000-000000000060"]
    });
    await application.getCampaignCostSummary(campaignScope);

    expect(ports.profiles.deleteProfile).toHaveBeenCalledWith({ ...owner, providerProfileId: textProfile.id });
    expect(ports.inventory.listModels).toHaveBeenCalledOnce();
    expect(ports.inventory.discoverCandidateModels).toHaveBeenCalledOnce();
    expect(ports.health.recordHealth).toHaveBeenCalledWith({
      ...owner,
      providerProfileId: textProfile.id,
      outcome: "failed",
      diagnosticCode: "transport_failure"
    });
    expect(ports.prompts.listPromptLibrary).toHaveBeenCalledOnce();
    expect(ports.prompts.previewPrompt).toHaveBeenCalledOnce();
    expect(ports.prompts.savePromptOverride).toHaveBeenCalledOnce();
    expect(ports.prompts.resetPromptOverride).toHaveBeenCalledOnce();
    expect(ports.intent.classifyTurnIntent).toHaveBeenCalledWith({
      ...campaignScope,
      text: "Open the gate."
    });
    expect(ports.costs.recordCost).toHaveBeenCalledOnce();
    expect(ports.costs.attributeGenerationCostsToTurn).toHaveBeenCalledOnce();
    expect(ports.costs.getTurnCosts).toHaveBeenCalledOnce();
    expect(ports.costs.getCampaignCostSummary).toHaveBeenCalledWith(campaignScope);
  });

  it("marks only configuration supplied by the same mutation as echoable", async () => {
    const ports = dependencies();
    const application = createProviderApplication(ports);
    const create: CreateProviderProfileCommand = {
      ...owner,
      name: "Local text",
      providerType: "lmstudio",
      providerRole: "text",
      baseUrl: "http://model.internal/v1",
      defaultModel: "story-model",
      contextWindowTokens: 32_768,
      maxOutputTokens: 4_096,
      temperature: 0.8,
      requestTimeoutMs: 300_000,
      configuration: toSafeProviderConfiguration({ streaming: true }),
      enabled: true,
      isDefault: true
    };

    const created = await application.createProfile(create);
    const updatedWithConfiguration = await application.updateProfile({
      ...owner,
      providerProfileId: textProfile.id,
      changes: { configuration: toSafeProviderConfiguration({ streaming: false }) }
    });
    const updatedWithoutConfiguration = await application.updateProfile({
      ...owner,
      providerProfileId: textProfile.id,
      changes: { name: "Renamed" }
    });

    expect(created.configurationProjection).toEqual({
      kind: "same_request_echo",
      configuration: { streaming: true }
    });
    expect(updatedWithConfiguration.configurationProjection).toEqual({
      kind: "same_request_echo",
      configuration: { streaming: false }
    });
    expect(updatedWithoutConfiguration.configurationProjection).toEqual({ kind: "sanitized_read" });
  });

  it("freezes prompt snapshots and their protocol version projection", async () => {
    const application = createProviderApplication(dependencies());
    const result = await application.loadPromptSnapshot({ ...owner, scope: "application" });

    expect(result.protocolVersion).toBe("prompt-library-v1-example");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.snapshot.story_system)).toBe(true);
  });

  it("constructs safe configuration by retaining only reviewed keys and value shapes", () => {
    const configuration = toSafeProviderConfiguration({
      streaming: true,
      maximumAttempts: 3,
      apiKey: "must-not-cross",
      credentialNonce: "must-not-cross",
      lastHealthError: "raw provider failure"
    });

    expect(configuration).toEqual({ streaming: true, maximumAttempts: 3 });
    expect(Object.isFrozen(configuration)).toBe(true);
  });

  it("models embedding text fallback explicitly while direct roles cannot cross roles", async () => {
    const application = createProviderApplication(dependencies());
    const image = await application.resolveDirect({ ...owner, providerRole: "image" });
    const embedding = await application.resolveEmbedding({ ...owner });

    expect(image).toMatchObject({
      status: "resolved",
      requestedRole: "image",
      resolvedRole: "image"
    });
    expect(embedding).toMatchObject({
      status: "resolved",
      requestedRole: "embedding",
      resolvedRole: "text",
      source: "text_fallback"
    });
  });
});

type ProhibitedPublicKey = Extract<
  keyof ProviderProfileView,
  "apiKey" | "credential" | "credentialReference" | "encryptedApiKey" | "nonce" | "authTag"
>;

expectTypeOf<ProhibitedPublicKey>().toEqualTypeOf<never>();

type ProhibitedCreateCommandKey = Extract<
  keyof CreateProviderProfileCommand,
  "apiKey" | "credential" | "credentialReference" | "encryptedApiKey" | "credentialSecret"
>;
type ProhibitedUpdateKey = Extract<
  keyof ProviderProfileChanges,
  "apiKey" | "credential" | "credentialReference" | "encryptedApiKey" | "credentialSecret"
>;

expectTypeOf<ProhibitedCreateCommandKey>().toEqualTypeOf<never>();
expectTypeOf<ProhibitedUpdateKey>().toEqualTypeOf<never>();

type ProhibitedSafeConfigurationKey = Extract<
  "apiKey" | "secret" | "token" | "encryptedApiKey" | "credentialNonce" |
  "credentialAuthTag" | "credentialKeyVersion" | "lastHealthError",
  keyof SafeProviderConfiguration
>;
type ArbitraryConfigurationKeyIsRepresentable =
  "unreviewedProviderSetting" extends keyof SafeProviderConfiguration ? true : false;
type StoredConfigurationRecordIsRepresentable =
  Readonly<Record<string, unknown>> extends SafeProviderConfiguration ? true : false;
type ArbitraryDiagnosticIsRepresentable = string extends ProviderHealthDiagnosticCode ? true : false;

expectTypeOf<ProhibitedSafeConfigurationKey>().toEqualTypeOf<never>();
expectTypeOf<ArbitraryConfigurationKeyIsRepresentable>().toEqualTypeOf<false>();
expectTypeOf<StoredConfigurationRecordIsRepresentable>().toEqualTypeOf<false>();
expectTypeOf<ArbitraryDiagnosticIsRepresentable>().toEqualTypeOf<false>();

// @ts-expect-error Turn-cost reads are always campaign-scoped as well as owner-scoped.
const invalidTurnCostScope: TurnCostScope = { ...owner, turnIds: [] };
void invalidTurnCostScope;

const imageResolution: DirectProviderResolution<"image"> = {
  status: "resolved",
  requestedRole: "image",
  resolvedRole: "image",
  providerProfileId: textProfile.id,
  providerType: "openai_compatible",
  model: "image-model"
};
void imageResolution;

const embeddingFallback: EmbeddingProviderResolution = {
  status: "resolved",
  requestedRole: "embedding",
  resolvedRole: "text",
  source: "text_fallback",
  providerProfileId: textProfile.id,
  providerType: "lmstudio",
  model: "embedding-model"
};
void embeddingFallback;

// @ts-expect-error Image resolution is role-pinned and cannot use a text profile.
const invalidImageFallback: DirectProviderResolution<"image"> = { ...imageResolution, resolvedRole: "text" };
void invalidImageFallback;

const invalidIntentSource: Awaited<ReturnType<ProviderApplicationDependencies["intent"]["classifyTurnIntent"]>> = {
  classificationId: "00000000-0000-4000-8000-000000000020",
  classification: "action",
  resolvedMode: "action",
  confidenceBand: "clear",
  // @ts-expect-error Intent classification cannot report an implicit story-text fallback.
  providerSource: "story_text",
  expiresAt: "2026-08-05T12:10:00.000Z"
};
void invalidIntentSource;

// The runtime-only lease is distinct from all public/application views.
expectTypeOf<ProviderRuntimeLeasePort>().toBeObject();
expectTypeOf<GenerationPromptPort>().toBeObject();
expectTypeOf<GenerationCostPort>().toBeObject();
expectTypeOf<IllustrationPromptPort>().toBeObject();
expectTypeOf<ProviderIllustrationCostPort>().toBeObject();
expectTypeOf<ChroniclePromptPort>().toBeObject();
expectTypeOf<ChronicleCostPort>().toBeObject();
expectTypeOf<WorldGenerationPromptPort>().toBeObject();
expectTypeOf<WorldGenerationCostPort>().toBeObject();
expectTypeOf<CharacterOrganizationPromptPort>().toBeObject();
expectTypeOf<CharacterOrganizationCostPort>().toBeObject();
expectTypeOf<InfiniteWorldsPromptPort>().toBeObject();
expectTypeOf<InfiniteWorldsCostPort>().toBeObject();
