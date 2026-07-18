import { z } from "zod";

export const providerTypeSchema = z.enum(["lmstudio", "openrouter", "manifest", "openai_compatible"]);
export const providerRoleSchema = z.enum(["text", "image", "embedding"]);

export const providerProfileInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  providerType: providerTypeSchema,
  providerRole: providerRoleSchema.default("text"),
  baseUrl: z.url().refine((value) => value.startsWith("http://") || value.startsWith("https://"), "Base URL must use HTTP or HTTPS."),
  defaultModel: z.string().trim().max(500).default(""),
  contextWindowTokens: z.coerce.number().int().min(1024).max(4_000_000).default(32768),
  maxOutputTokens: z.coerce.number().int().min(128).max(262144).default(4096),
  temperature: z.coerce.number().min(0).max(2).default(0.8),
  apiKey: z.string().trim().max(16_384).optional(),
  enabled: z.boolean().default(true),
  configuration: z.record(z.string(), z.unknown()).default({})
});

export const generationRequestSchema = z.object({
  action: z.string().trim().min(1).max(12_000),
  providerProfileId: z.uuid(),
  model: z.string().trim().max(500).optional(),
  idempotencyKey: z.string().trim().min(8).max(200),
  context: z.object({
    budgetTokens: z.coerce.number().int().min(512).max(1_000_000).default(32000),
    compression: z.enum(["auto", "full", "balanced", "compact", "summary"]).default("auto"),
    recentTurns: z.coerce.number().int().min(1).max(100).default(8),
    modelContextWindowTokens: z.coerce.number().int().min(1024).max(4_000_000).optional()
  }).default({ budgetTokens: 32000, compression: "auto", recentTurns: 8 })
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

export const storyTurnOutputSchema = z.object({
  narration: z.string().trim().min(1).max(200_000),
  choices: z.array(z.string().trim().min(1).max(2000)).length(4),
  custom_action_suggestion: z.string().trim().min(1).max(2000),
  scratchpad: z.string().max(100_000).default(""),
  tracker_updates: z.array(z.record(z.string(), z.unknown())).max(200).default([]),
  image_prompt: z.string().max(20_000).default("")
});

export type ProviderProfileInput = z.infer<typeof providerProfileInputSchema>;
export type ProviderType = z.infer<typeof providerTypeSchema>;
export type GenerationRequest = z.infer<typeof generationRequestSchema>;
export type IllustrationConfig = z.infer<typeof illustrationConfigSchema>;
export type IllustrationRequest = z.infer<typeof illustrationRequestSchema>;
export type StoryTurnOutput = z.infer<typeof storyTurnOutputSchema>;
export type PlayerCampaignConfig = z.infer<typeof playerCampaignConfigSchema>;
export type PlayerRpgStat = z.infer<typeof playerRpgStatSchema>;
export type PlayerEventTrigger = z.infer<typeof playerEventTriggerSchema>;
export type PendingEventTrigger = z.infer<typeof pendingEventTriggerSchema>;
export type RpgAssessmentOutput = z.infer<typeof rpgAssessmentOutputSchema>;
