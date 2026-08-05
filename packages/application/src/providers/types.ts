import type {
  PromptTemplateKey,
  ProviderType,
  TurnInputMode,
  TurnIntentClassification,
  TurnIntentConfidenceBand
} from "@infinite-quest/contracts";
import type { OwnerScope } from "../generation/types.js";

/** Resolved by Fastify or loaded from a claimed job; never accepted from a browser as authority. */
export type ProviderRole = "text" | "image" | "embedding" | "intent";
export type DirectProviderRole = Exclude<ProviderRole, "embedding">;
export type ProviderHealthStatus = "unknown" | "healthy" | "degraded" | "unavailable";

export type SafeProviderConfigurationValue =
  | string
  | number
  | boolean
  | null
  | readonly SafeProviderConfigurationValue[]
  | Readonly<{ [key: string]: SafeProviderConfigurationValue }>;

/**
 * Configuration admitted to application contracts has already crossed a
 * sanitizer/validator boundary. Credentials and encrypted credential fields
 * are never configuration values.
 */
export type SafeProviderConfiguration = Readonly<Record<string, SafeProviderConfigurationValue>>;

export type ProviderHealthView = Readonly<{
  status: ProviderHealthStatus;
  consecutiveFailures: number;
  lastCheckedAt: string | null;
}>;

type ProviderProfileViewBase = Readonly<{
  id: string;
  name: string;
  providerType: ProviderType;
  baseUrl: string;
  defaultModel: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  temperature: number;
  requestTimeoutMs: number;
  configuration: SafeProviderConfiguration;
  enabled: boolean;
  isDefault: boolean;
  /** Presence only. Credential material and references are runtime-private. */
  hasCredential: boolean;
  health: ProviderHealthView;
  createdAt: string;
  updatedAt: string;
}>;

export type TextProviderProfileView = ProviderProfileViewBase & Readonly<{
  providerRole: "text";
  capability: "text_generation";
}>;

export type ImageProviderProfileView = ProviderProfileViewBase & Readonly<{
  providerRole: "image";
  capability: "image_generation";
}>;

export type EmbeddingProviderProfileView = ProviderProfileViewBase & Readonly<{
  providerRole: "embedding";
  capability: "embedding_generation";
}>;

export type IntentProviderProfileView = ProviderProfileViewBase & Readonly<{
  providerRole: "intent";
  capability: "intent_classification";
}>;

/** Role is a required discriminator so text/image settings cannot be reused implicitly. */
export type ProviderProfileView =
  | TextProviderProfileView
  | ImageProviderProfileView
  | EmbeddingProviderProfileView
  | IntentProviderProfileView;

export type ProviderProfileWriteFields<R extends ProviderRole = ProviderRole> = Readonly<{
  name: string;
  providerType: ProviderType;
  providerRole: R;
  baseUrl: string;
  defaultModel: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  temperature: number;
  requestTimeoutMs: number;
  configuration: SafeProviderConfiguration;
  enabled: boolean;
  isDefault: boolean;
}>;

/** Credential input is deliberately absent; runtime credential handling is a separate port. */
export type CreateProviderProfileCommand<R extends ProviderRole = ProviderRole> =
  OwnerScope & ProviderProfileWriteFields<R>;

export type ProviderProfileChanges = Readonly<{
  name?: string;
  baseUrl?: string;
  defaultModel?: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  temperature?: number;
  requestTimeoutMs?: number;
  configuration?: SafeProviderConfiguration;
  enabled?: boolean;
  isDefault?: boolean;
}>;

export type UpdateProviderProfileCommand = OwnerScope & Readonly<{
  providerProfileId: string;
  changes: ProviderProfileChanges;
}>;

export type DeleteProviderProfileCommand = OwnerScope & Readonly<{
  providerProfileId: string;
}>;

export type SetDefaultProviderCommand = OwnerScope & Readonly<{
  providerProfileId: string;
  providerRole: ProviderRole;
}>;

export type DeleteProviderProfileResult = Readonly<{
  id: string;
  name: string;
  providerRole: ProviderRole;
  deleted: true;
}>;

/**
 * A transport adapter may echo a sanitized configuration supplied in this
 * exact request. Persisted reads and omitted-update fields always stay on the
 * sanitized-read branch.
 */
export type ProviderConfigurationProjection =
  | Readonly<{ kind: "same_request_echo"; configuration: SafeProviderConfiguration }>
  | Readonly<{ kind: "sanitized_read" }>;

export type ProviderProfileMutationResult = Readonly<{
  profile: ProviderProfileView;
  configurationProjection: ProviderConfigurationProjection;
}>;

export type ProviderModel = Readonly<{
  id: string;
  name: string;
  contextWindowTokens?: number;
}>;

export type ProviderModelInventory = Readonly<{
  providerProfileId: string | null;
  providerRole: ProviderRole;
  models: readonly ProviderModel[];
}>;

export type ProviderModelInventoryRequest = OwnerScope & Readonly<{
  providerProfileId: string;
  providerRole: ProviderRole;
}>;

/** Safe, unsaved provider metadata; transient credentials remain outside the application call. */
export type ProviderCandidate = OwnerScope & ProviderProfileWriteFields;

export type ProviderResolutionRequest<R extends DirectProviderRole = DirectProviderRole> = OwnerScope & Readonly<{
  providerRole: R;
  selectedProviderProfileId?: string | null;
  model?: string;
}>;

export type EmbeddingResolutionRequest = OwnerScope & Readonly<{
  selectedProviderProfileId?: string | null;
  model?: string;
  allowTextFallback?: boolean;
}>;

export type DirectProviderResolution<R extends DirectProviderRole = DirectProviderRole> =
  | Readonly<{
      status: "resolved";
      requestedRole: R;
      resolvedRole: R;
      providerProfileId: string;
      providerType: ProviderType;
      model: string;
    }>
  | Readonly<{
      status: "unconfigured";
      requestedRole: R;
      resolvedRole: null;
    }>;

/** The only cross-role resolution: a caller must observe and accept the explicit source. */
export type EmbeddingProviderResolution =
  | Readonly<{
      status: "resolved";
      requestedRole: "embedding";
      resolvedRole: "embedding";
      source: "dedicated_embedding";
      providerProfileId: string;
      providerType: ProviderType;
      model: string;
    }>
  | Readonly<{
      status: "resolved";
      requestedRole: "embedding";
      resolvedRole: "text";
      source: "text_fallback";
      providerProfileId: string;
      providerType: ProviderType;
      model: string;
    }>
  | Readonly<{
      status: "unconfigured";
      requestedRole: "embedding";
      resolvedRole: null;
      source: "none";
    }>;

export type ProviderHealthRecord = OwnerScope & Readonly<{
  providerProfileId: string;
  outcome: "healthy" | "failed";
  /** Stable private diagnostic category, never a raw provider error or endpoint. */
  diagnosticCode?: string;
}>;

export type ApplicationPromptScope = OwnerScope & Readonly<{
  scope: "application";
}>;

export type CampaignPromptScope = OwnerScope & Readonly<{
  scope: "campaign";
  campaignId: string;
}>;

export type PromptScope = ApplicationPromptScope | CampaignPromptScope;

export type PromptSnapshotEntry = Readonly<{
  content: string;
  hash: string;
  source: "shipped" | "application" | "campaign";
}>;

export type ImmutablePromptSnapshot = Readonly<Record<PromptTemplateKey, PromptSnapshotEntry>>;

export type PromptSnapshotVersion = Readonly<{
  catalogVersion: string;
  /** Included in model-chain compatibility keys. */
  protocolVersion: string;
  snapshot: ImmutablePromptSnapshot;
}>;

export type PromptTemplateView = Readonly<{
  key: PromptTemplateKey;
  title: string;
  category: "Story Engine" | "World authoring" | "Imports" | "Illustrations";
  description: string;
  campaignOverrideAllowed: boolean;
  maxLength: number;
  variables: readonly string[];
  sampleValues: Readonly<Record<string, string | number>>;
  defaultContent: string;
  effectiveContent: string;
  effectiveSource: "shipped" | "application" | "campaign";
  contentHash: string;
}>;

export type PromptLibraryView = Readonly<{
  catalogVersion: string;
  campaignId: string | null;
  templates: readonly PromptTemplateView[];
}>;

export type PromptPreviewRequest = OwnerScope & Readonly<{
  key: PromptTemplateKey;
  content: string;
}>;

export type PromptPreviewView = Readonly<{
  sections: readonly Readonly<{
    label: string;
    role: "system" | "input" | "recovery" | "image";
    content: string;
  }>[];
  estimatedTokens: number;
  unresolvedVariables: readonly string[];
}>;

export type SavePromptOverrideCommand = PromptScope & Readonly<{
  key: PromptTemplateKey;
  content: string;
}>;

export type ResetPromptOverrideCommand = PromptScope & Readonly<{
  key: PromptTemplateKey;
}>;

export type TurnIntentClassificationCommand = OwnerScope & Readonly<{
  campaignId: string;
  text: string;
  preferredFallback?: TurnInputMode;
}>;

export type TurnIntentClassificationView = Readonly<{
  classificationId: string;
  classification: TurnIntentClassification;
  resolvedMode: TurnInputMode;
  confidenceBand: TurnIntentConfidenceBand;
  /** Text-profile fallback is intentionally not representable. */
  providerSource: "intent_default" | "campaign_fallback";
  expiresAt: string;
}>;

export type CostCategory = "story" | "image" | "memory";

export type ReportedProviderCost = Readonly<{
  amount: string;
  currency: string;
}>;

export type ProviderUsage = Readonly<{
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  images?: number;
}>;

export type ProviderCostRecordCommand = OwnerScope & Readonly<{
  campaignId: string;
  turnId?: string | null;
  providerProfileId: string;
  providerType: ProviderType;
  requestedModel: string;
  resolvedModel?: string;
  providerResponseId?: string;
  generationJobId?: string | null;
  imageJobId?: string | null;
  chronicleJobId?: string | null;
  category: CostCategory;
  operation: string;
  usage: ProviderUsage;
  reportedCost: ReportedProviderCost | null;
  localCallId?: string;
}>;

export type ReportedCostView = Readonly<{
  amount: string;
  currency: string;
  byCategory: Readonly<Record<CostCategory, string>>;
}>;

export type CampaignCostSummaryView = Readonly<{
  campaignId: string;
  hasReportedCosts: boolean;
  totals: readonly Readonly<{
    currency: string;
    amount: string;
    turnAttributed: string;
    historicalAndUnattributedOperations: string;
    otherCampaignOperations: string;
    byCategory: Readonly<Record<CostCategory, string>>;
    lastReportedAt: string;
  }>[];
}>;

export type CampaignCostScope = OwnerScope & Readonly<{ campaignId: string }>;
export type TurnCostScope = OwnerScope & Readonly<{ turnIds: readonly string[] }>;
export type GenerationCostAttributionScope = OwnerScope & Readonly<{
  campaignId: string;
  generationJobId: string;
  turnId: string;
}>;

/** Opaque transaction carrier for cost writes owned by a surrounding domain. */
export type ProviderCostTransactionContext = object;
