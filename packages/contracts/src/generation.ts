import { z } from "zod";

export const providerTypeSchema = z.enum(["lmstudio", "openrouter", "manifest", "openai_compatible", "sogni"]);
export const providerRoleSchema = z.enum(["text", "image", "embedding", "intent"]);

export const turnInputModeSchema = z.enum(["action", "scene"]);
export const turnInputSelectionSchema = z.enum(["auto", "action", "scene"]);
export const turnInputModeSourceSchema = z.enum(["explicit", "auto", "generated_choice", "opening_action", "fallback"]);
export const turnIntentClassificationSchema = z.enum(["action", "scene", "mixed", "uncertain"]);
export const turnIntentConfidenceBandSchema = z.enum(["clear", "probable", "ambiguous"]);

export const turnInputClassificationRequestSchema = z.object({
  text: z.string().trim().min(1).max(12_000),
  preferredFallback: turnInputModeSchema.optional()
});

export const providerProfileInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  providerType: providerTypeSchema,
  providerRole: providerRoleSchema.default("text"),
  baseUrl: z.url().refine((value) => value.startsWith("http://") || value.startsWith("https://"), "Base URL must use HTTP or HTTPS."),
  defaultModel: z.string().trim().max(500).default(""),
  contextWindowTokens: z.coerce.number().int().min(1024).max(4_000_000).default(32768),
  maxOutputTokens: z.coerce.number().int().min(128).max(262144).default(4096),
  temperature: z.coerce.number().min(0).max(2).default(0.8),
  requestTimeoutMs: z.coerce.number().int().min(5_000).max(3_600_000).default(300_000),
  apiKey: z.string().trim().max(16_384).optional(),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  configuration: z.record(z.string(), z.unknown()).default({})
}).superRefine((value, context) => {
  if (value.providerRole === "text" && value.maxOutputTokens + 512 >= value.contextWindowTokens) {
    context.addIssue({ code: "custom", path: ["maxOutputTokens"], message: "Text output reserve must leave at least 512 tokens for input context." });
  }
  if (value.providerType === "sogni") {
    const result = sogniIllustrationProviderConfigSchema.safeParse(value.configuration);
    if (!result.success) {
      for (const issue of result.error.issues) context.addIssue({ ...issue, path: ["configuration", ...issue.path] });
    }
  }
});

export const providerProfileUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  baseUrl: z.url().refine((value) => value.startsWith("http://") || value.startsWith("https://"), "Base URL must use HTTP or HTTPS.").optional(),
  defaultModel: z.string().trim().max(500).optional(),
  contextWindowTokens: z.coerce.number().int().min(1024).max(4_000_000).optional(),
  maxOutputTokens: z.coerce.number().int().min(128).max(262144).optional(),
  temperature: z.coerce.number().min(0).max(2).optional(),
  requestTimeoutMs: z.coerce.number().int().min(5_000).max(3_600_000).optional(),
  apiKey: z.string().trim().max(16_384).optional(),
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  configuration: z.record(z.string(), z.unknown()).optional()
}).refine((value) => Object.values(value).some((item) => item !== undefined), "At least one provider field is required.");

export const providerTextRequestSchema = z.object({
  providerProfileId: z.uuid().optional(),
  model: z.string().trim().max(500).optional(),
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string().min(1).max(200_000)
  })).min(1).max(30)
});

export const generationRequestSchema = z.object({
  action: z.string().trim().min(1).max(12_000),
  requestedInputMode: turnInputSelectionSchema.default("action"),
  resolvedInputMode: turnInputModeSchema.default("action"),
  inputModeSource: turnInputModeSourceSchema.default("explicit"),
  classificationId: z.uuid().optional(),
  providerProfileId: z.uuid().optional(),
  model: z.string().trim().max(500).optional(),
  idempotencyKey: z.string().trim().min(8).max(200),
  context: z.object({
    budgetTokens: z.coerce.number().int().min(512).max(1_000_000).default(32000),
    compression: z.enum(["auto", "full", "balanced", "compact", "summary"]).default("auto"),
    recentTurns: z.coerce.number().int().min(1).max(100).default(8),
    modelContextWindowTokens: z.coerce.number().int().min(1024).max(4_000_000).optional()
  }).default({ budgetTokens: 32000, compression: "auto", recentTurns: 8 })
});

export const generationRetryLatestRequestSchema = generationRequestSchema.extend({
  expectedCurrentTurnNumber: z.coerce.number().int().min(1)
});

export const campaignRewindSchema = z.object({
  targetTurnNumber: z.coerce.number().int().min(0),
  expectedCurrentTurnNumber: z.coerce.number().int().min(1).optional()
});

export const campaignBranchSchema = z.object({
  targetTurnNumber: z.coerce.number().int().min(0),
  title: z.string().trim().min(1).max(200).optional(),
  expectedCurrentTurnNumber: z.coerce.number().int().min(1).optional()
});

export const illustrationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  providerProfileId: z.uuid().nullable().default(null),
  model: z.string().trim().max(500).default(""),
  size: z.string().trim().regex(/^\d{2,5}x\d{2,5}$/).default("1024x1024"),
  aspectRatio: z.string().trim().regex(/^\d{1,3}:\d{1,3}$/).default("1:1"),
  quality: z.enum(["auto", "low", "medium", "high"]).default("auto"),
  outputFormat: z.enum(["png", "jpeg", "webp"]).default("png"),
  maxAttempts: z.coerce.number().int().min(1).max(10).default(3)
}).superRefine((value, context) => {
  if (value.enabled && !value.providerProfileId) context.addIssue({ code: "custom", path: ["providerProfileId"], message: "Select an image provider when illustrations are enabled." });
  if (value.enabled && !value.model) context.addIssue({ code: "custom", path: ["model"], message: "Select an image model when illustrations are enabled." });
});

export const illustrationRequestSchema = z.object({
  providerProfileId: z.uuid().optional(),
  model: z.string().trim().max(500).optional(),
  prompt: z.string().trim().min(1).max(20_000).optional(),
  replace: z.boolean().default(false)
});

export const worldCoverRequestSchema = z.object({
  prompt: z.string().trim().max(20_000).default(""),
  size: z.string().trim().regex(/^\d{2,5}x\d{2,5}$/).default("1024x1536"),
  aspectRatio: z.string().trim().min(1).max(20).default("2:3"),
  quality: z.enum(["auto", "low", "medium", "high"]).default("auto"),
  outputFormat: z.enum(["png", "jpeg", "webp"]).default("png"),
  replace: z.boolean().default(false)
}).strict();

export const sensitiveContentFilterSchema = z.enum(["provider-default", "enabled", "disabled"]);

export const sogniIllustrationProviderConfigSchema = z.object({
  modelDiscoveryEnabled: z.boolean().default(true),
  network: z.enum(["fast", "relaxed"]).default("fast"),
  tokenType: z.enum(["auto", "sogni", "spark"]).default("auto"),
  defaultWidth: z.coerce.number().int().min(256).max(8_192).default(1_280),
  defaultHeight: z.coerce.number().int().min(256).max(8_192).default(720),
  defaultAspectRatio: z.string().trim().regex(/^\d{1,3}:\d{1,3}$/).default("16:9"),
  defaultOutputFormat: z.enum(["png", "jpeg"]).default("png"),
  defaultQuality: z.enum(["auto", "low", "medium", "high"]).default("auto"),
  pollIntervalMs: z.coerce.number().int().min(1_000).max(30_000).default(2_000),
  maximumPollIntervalMs: z.coerce.number().int().min(1_000).max(30_000).default(10_000),
  generationTimeoutMs: z.coerce.number().int().min(30_000).max(600_000).default(180_000),
  maximumAttempts: z.coerce.number().int().min(1).max(5).default(3),
  defaultImageCount: z.coerce.number().int().min(1).max(2).default(1),
  sensitiveContentFilter: sensitiveContentFilterSchema.default("provider-default"),
  workflowSafeContentFilterSupported: z.boolean().default(false),
  allowPrivateArtifactHosts: z.boolean().default(false)
}).superRefine((value, context) => {
  if (value.maximumPollIntervalMs < value.pollIntervalMs) {
    context.addIssue({
      code: "custom",
      path: ["maximumPollIntervalMs"],
      message: "Maximum poll interval must be greater than or equal to the initial poll interval."
    });
  }
  if (value.defaultWidth * value.defaultHeight > 40_000_000) {
    context.addIssue({ code: "custom", path: ["defaultWidth"], message: "Default image dimensions exceed the 40 megapixel limit." });
  }
});

export const illustrationGenerationRequestSchema = z.object({
  jobId: z.string().trim().min(1).max(200),
  campaignId: z.uuid().optional(),
  acceptedTurnId: z.uuid().optional(),
  idempotencyKey: z.string().trim().min(8).max(192),
  prompt: z.string().trim().min(1).max(20_000),
  negativePrompt: z.string().trim().max(20_000).optional(),
  modelId: z.string().trim().min(1).max(500),
  imageCount: z.coerce.number().int().min(1).max(2).default(1),
  width: z.coerce.number().int().min(256).max(8_192).optional(),
  height: z.coerce.number().int().min(256).max(8_192).optional(),
  aspectRatio: z.string().trim().regex(/^\d{1,3}:\d{1,3}$/).optional(),
  outputFormat: z.enum(["png", "jpeg", "webp"]).default("png"),
  seed: z.coerce.number().int().min(0).max(4_294_967_295).optional(),
  steps: z.coerce.number().int().min(1).max(500).optional(),
  guidance: z.coerce.number().min(0).max(100).optional(),
  scheduler: z.string().trim().min(1).max(100).optional(),
  sensitiveContentFilter: sensitiveContentFilterSchema.default("provider-default")
}).superRefine((value, context) => {
  if ((value.width === undefined) !== (value.height === undefined)) {
    context.addIssue({ code: "custom", path: ["width"], message: "Width and height must be configured together." });
  }
  if (value.width && value.height && value.width * value.height > 40_000_000) {
    context.addIssue({ code: "custom", path: ["width"], message: "Requested image dimensions exceed the 40 megapixel limit." });
  }
});

export const playerRpgStatSchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  value: z.coerce.number().int().min(1).max(99),
  note: z.string().trim().max(2000).default("")
});

export const playerEventTriggerSchema = z.object({
  id: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(300),
  timing: z.enum(["before", "after"]),
  condition: z.string().trim().min(1).max(4000),
  effect: z.string().trim().min(1).max(4000),
  addTextAfter: z.boolean().default(false),
  triggeredCount: z.coerce.number().int().min(0).max(999999).default(0),
  lastTriggeredTurn: z.coerce.number().int().min(1).nullable().default(null),
  lastTriggeredAt: z.string().trim().max(100).nullable().default(null)
});

export const pendingEventTriggerSchema = z.object({
  id: z.string().trim().min(1).max(200),
  sourceTriggerId: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(300),
  timing: z.enum(["before", "after"]),
  condition: z.string().trim().max(4000).default(""),
  effect: z.string().trim().max(4000).default(""),
  instructions: z.string().trim().min(1).max(4000),
  reason: z.string().trim().max(2000).default(""),
  sourceTurn: z.coerce.number().int().min(1).nullable().default(null)
});

export const playerCampaignConfigSchema = z.object({
  expectedTurnNumber: z.coerce.number().int().min(0),
  useRpgStats: z.boolean().default(false),
  suppressEventTriggers: z.boolean().default(false),
  rpgStats: z.array(playerRpgStatSchema).max(100).default([]),
  eventTriggers: z.array(playerEventTriggerSchema).max(200).default([]),
  pendingEventTriggers: z.array(pendingEventTriggerSchema).max(200).default([])
});

export const campaignTrackerSchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(300),
  value: z.string().max(10_000).default(""),
  rules: z.string().max(4000).default("")
});

export const campaignRuntimeStateUpdateSchema = z.object({
  expectedTurnNumber: z.coerce.number().int().min(0),
  expectedRevision: z.coerce.number().int().min(0),
  scratchpad: z.string().max(100_000),
  trackers: z.array(campaignTrackerSchema).max(200)
});

export const campaignRuntimeStateSchema = z.object({
  campaignId: z.uuid(),
  activeTurnNumber: z.coerce.number().int().min(0),
  viewedTurnNumber: z.coerce.number().int().min(0),
  isCurrent: z.boolean(),
  revision: z.coerce.number().int().min(0),
  updatedAt: z.union([z.string(), z.date()]),
  scratchpad: z.string(),
  trackers: z.array(campaignTrackerSchema),
  rpgStats: z.array(z.unknown()),
  eventTriggers: z.array(z.unknown()),
  pendingEventTriggers: z.array(z.unknown()),
  continuitySummary: z.string(),
  canonicalFacts: z.array(z.string()),
  openThreads: z.array(z.string())
});

export const rpgAssessmentOutputSchema = z.object({
  stat_id: z.string().trim().min(1).max(200),
  difficulty_modifier: z.coerce.number().int().min(-50).max(40),
  rationale: z.string().trim().min(1).max(2000),
  favorable_outcome: z.string().trim().min(1).max(3000),
  setback_outcome: z.string().trim().min(1).max(3000)
});

export const eventTriggerDecisionOutputSchema = z.object({
  activated_trigger_ids: z.array(z.string().trim().min(1).max(200)).max(200).default([]),
  reasons: z.record(z.string(), z.string().trim().max(2000)).default({})
});

export const eventExtensionOutputSchema = z.object({
  additional_text: z.string().trim().min(1).max(20_000),
  scratchpad: z.string().max(100_000).optional(),
  tracker_updates: z.array(z.record(z.string(), z.unknown())).max(200).default([])
});

export const canonicalFactUpdateSchema = z.object({
  content: z.string().trim().min(1).max(4000),
  supersedes_fact_ids: z.array(z.uuid()).max(100).default([])
});

export const storyTurnOutputSchema = z.object({
  narration: z.string().trim().min(1).max(200_000),
  choices: z.array(z.string().trim().min(1).max(2000)).length(4),
  custom_action_suggestion: z.string().trim().min(1).max(2000),
  scratchpad: z.string().max(100_000),
  tracker_updates: z.array(z.record(z.string(), z.unknown())).max(200).default([]),
  image_prompt: z.string().max(20_000).default(""),
  continuity_summary: z.string().trim().min(1).max(20_000),
  canonical_facts: z.array(z.string().trim().min(1).max(4000)).max(100),
  superseded_facts: z.array(z.string().trim().min(1).max(4000)).max(100),
  canonical_fact_updates: z.array(canonicalFactUpdateSchema).max(100).default([]),
  open_threads: z.array(z.string().trim().min(1).max(4000)).max(100)
});

export const generationJobStatusSchema = z.object({
  id: z.string().uuid(),
  campaignId: z.string().uuid(),
  providerProfileId: z.string().uuid().nullable().optional(),
  expectedTurnNumber: z.coerce.number().int().min(1),
  action: z.string(),
  requestedInputMode: turnInputSelectionSchema.default("action"),
  resolvedInputMode: turnInputModeSchema.default("action"),
  inputModeSource: turnInputModeSourceSchema.default("explicit"),
  operationKind: z.enum(["append", "replace_latest"]).default("append"),
  replacementTurnId: z.string().uuid().nullable().optional(),
  baseTurnNumber: z.coerce.number().int().min(0).nullable().optional(),
  status: z.enum(["queued", "replacement_queued", "assessing", "generating", "validating", "committing", "completed", "recoverable", "failed", "discarded"]),
  attempts: z.coerce.number().int().min(0),
  requestedModel: z.string().optional(),
  providerResponseId: z.string().nullable().optional(),
  providerFinishReason: z.string().nullable().optional(),
  resultTurnId: z.string().uuid().nullable().optional(),
  errorCode: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  recoveryMetadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.union([z.string(), z.date()]),
  updatedAt: z.union([z.string(), z.date()]),
  completedAt: z.union([z.string(), z.date()]).nullable().optional(),
  partialOutput: z.string().nullable().optional(),
  partialNarration: z.string().nullable().optional()
});

export type ProviderProfileInput = z.infer<typeof providerProfileInputSchema>;
export type ProviderProfileUpdate = z.infer<typeof providerProfileUpdateSchema>;
export type ProviderTextRequest = z.infer<typeof providerTextRequestSchema>;
export type ProviderType = z.infer<typeof providerTypeSchema>;
export type TurnInputMode = z.infer<typeof turnInputModeSchema>;
export type TurnInputSelection = z.infer<typeof turnInputSelectionSchema>;
export type TurnInputModeSource = z.infer<typeof turnInputModeSourceSchema>;
export type TurnIntentClassification = z.infer<typeof turnIntentClassificationSchema>;
export type TurnIntentConfidenceBand = z.infer<typeof turnIntentConfidenceBandSchema>;
export type TurnInputClassificationRequest = z.infer<typeof turnInputClassificationRequestSchema>;
export type GenerationRequest = z.infer<typeof generationRequestSchema>;
export type GenerationRetryLatestRequest = z.infer<typeof generationRetryLatestRequestSchema>;
export type CampaignRewindRequest = z.infer<typeof campaignRewindSchema>;
export type CampaignBranchRequest = z.infer<typeof campaignBranchSchema>;
export type IllustrationConfig = z.infer<typeof illustrationConfigSchema>;
export type IllustrationRequest = z.infer<typeof illustrationRequestSchema>;
export type WorldCoverRequest = z.infer<typeof worldCoverRequestSchema>;
export type SensitiveContentFilter = z.infer<typeof sensitiveContentFilterSchema>;
export type SogniIllustrationProviderConfig = z.infer<typeof sogniIllustrationProviderConfigSchema>;
export type IllustrationGenerationRequest = z.infer<typeof illustrationGenerationRequestSchema>;
export type StoryTurnOutput = z.infer<typeof storyTurnOutputSchema>;
export type PlayerCampaignConfig = z.infer<typeof playerCampaignConfigSchema>;
export type CampaignRuntimeStateUpdate = z.infer<typeof campaignRuntimeStateUpdateSchema>;
export type CampaignRuntimeState = z.infer<typeof campaignRuntimeStateSchema>;
export type CampaignTracker = z.infer<typeof campaignTrackerSchema>;
export type PlayerRpgStat = z.infer<typeof playerRpgStatSchema>;
export type PlayerEventTrigger = z.infer<typeof playerEventTriggerSchema>;
export type PendingEventTrigger = z.infer<typeof pendingEventTriggerSchema>;
export type RpgAssessmentOutput = z.infer<typeof rpgAssessmentOutputSchema>;
export type GenerationJobStatus = z.infer<typeof generationJobStatusSchema>;
