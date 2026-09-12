import { z } from "zod";

export const campaignTurnControlStyleSchema = z.enum([
  "action_only",
  "flexible_action",
  "flexible_scene"
]);

export const historicalCampaignTurnControlStyleSchema = z.enum([
  "action_only",
  "flexible_auto",
  "flexible_action",
  "flexible_scene"
]);

export const storyOnlyPromptSnapshotSchema = z.object({
  systemSupplement: z.string(),
  systemSupplementHash: z.string(),
  choiceRepairSystem: z.string(),
  choiceRepairSystemHash: z.string()
}).strict();

export const generationPolicySnapshotSchema = z.discriminatedUnion("playMode", [
  z.object({
    version: z.literal(1),
    playMode: z.literal("legacy"),
    turnControlStyle: z.enum(["action_only", "flexible_action"])
  }).strict(),
  z.object({
    version: z.literal(1),
    playMode: z.literal("story_only"),
    turnControlStyle: z.literal("flexible_scene"),
    protocolVersion: z.literal("story-only-v1"),
    prompts: storyOnlyPromptSnapshotSchema
  }).strict()
]);

/**
 * The small, safe record retained with an accepted turn in a portable archive.
 * This intentionally does not include the runtime policy's prompt snapshots.
 */
export const portableAcceptedGenerationPolicyProvenanceSchema = z.union([
  z.null(),
  z.object({
    version: z.literal(1),
    playMode: z.literal("legacy"),
    turnControlStyle: z.enum(["action_only", "flexible_action"]),
    protocolVersion: z.null()
  }).strict(),
  z.object({
    version: z.literal(1),
    playMode: z.literal("story_only"),
    turnControlStyle: z.literal("flexible_scene"),
    protocolVersion: z.literal("story-only-v1")
  }).strict()
]);

/** Redacts an accepted runtime snapshot, or validates the retained imported record. */
export function portableAcceptedGenerationPolicyProvenance(
  runtimePolicy: unknown,
  retainedProvenance: unknown = null,
): PortableAcceptedGenerationPolicyProvenance {
  if (runtimePolicy === null || runtimePolicy === undefined) {
    return portableAcceptedGenerationPolicyProvenanceSchema.parse(retainedProvenance);
  }
  const policy = generationPolicySnapshotSchema.parse(runtimePolicy);
  return portableAcceptedGenerationPolicyProvenanceSchema.parse({
    version: policy.version,
    playMode: policy.playMode,
    turnControlStyle: policy.turnControlStyle,
    protocolVersion: policy.playMode === "story_only" ? policy.protocolVersion : null
  });
}

/**
 * Retain accepted metadata without carrying a runtime generation snapshot into
 * a branch, transfer, or archive. The portable provenance is the sole policy
 * representation allowed outside the source runtime.
 */
export function portableAcceptedTurnModelMetadata(
  metadata: Record<string, unknown>,
  runtimePolicy: unknown,
): Record<string, unknown> {
  const { generationPolicy: _runtimePolicyMetadata, ...portableMetadata } = metadata;
  return {
    ...portableMetadata,
    portableAcceptedGenerationPolicyProvenance: portableAcceptedGenerationPolicyProvenance(
      runtimePolicy,
      metadata.portableAcceptedGenerationPolicyProvenance ?? null,
    ),
  };
}

export type CampaignPlayMode = "legacy" | "story_only";
export type CampaignTurnControlStyle = z.infer<typeof campaignTurnControlStyleSchema>;
export type HistoricalCampaignTurnControlStyle = z.infer<typeof historicalCampaignTurnControlStyleSchema>;
export type StoryOnlyPromptSnapshot = Readonly<z.infer<typeof storyOnlyPromptSnapshotSchema>>;
export type GenerationPolicySnapshot = Readonly<z.infer<typeof generationPolicySnapshotSchema>>;
export type PortableAcceptedGenerationPolicyProvenance = Readonly<z.infer<typeof portableAcceptedGenerationPolicyProvenanceSchema>>;
