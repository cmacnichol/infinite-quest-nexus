import { z } from "zod";
import { castAuthoredValuesSchema, castAuthoredPathSchema, castBoundarySchema, castFieldSchema, castOverrideProfileSchema, castOverrideSchema, castWriteBase } from "./campaign-cast.js";

import { characterProfileSchema } from "./world-library.js";

export const editAuthoredCastProfileSchema = z.object({ ...castWriteBase, expectedCharacterRevision: z.number().int().nonnegative(),
  set: castAuthoredValuesSchema.optional(), reset: z.array(castAuthoredPathSchema).max(30).optional(), restoreAuthoredGoals: z.literal(true).optional(),
  setOverrides: castOverrideProfileSchema.optional(), clearOverrides: z.array(castFieldSchema).max(11).optional(),
  name: z.string().trim().min(1).max(200).optional(), aliases: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  resetIdentity: z.literal(true).optional(), pinned: z.boolean().optional(), ignored: z.boolean().optional()
}).strict().superRefine((value, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  if (value.resetIdentity && (value.name !== undefined || value.aliases !== undefined)) issue("Reset identity cannot be combined with identity edits.");
  if (value.reset?.some((path) => Object.hasOwn(value.set ?? {}, path))) issue("Cannot set and reset the same field.");
  if (value.clearOverrides?.some((path) => Object.hasOwn(value.setOverrides ?? {}, path))) issue("Cannot set and clear the same override.");
  if (value.restoreAuthoredGoals && (Object.hasOwn(value.setOverrides ?? {}, "story.goals") || value.clearOverrides?.includes("story.goals"))) issue("Restore goals cannot be combined with another goals action.");
  if (!Object.keys(value.set ?? {}).length && !value.reset?.length && !value.restoreAuthoredGoals && !Object.keys(value.setOverrides ?? {}).length
    && !value.clearOverrides?.length && value.name === undefined && value.aliases === undefined && !value.resetIdentity
    && value.pinned === undefined && value.ignored === undefined) issue("An edit must change at least one field.");
});
export type EditAuthoredCastProfile = z.infer<typeof editAuthoredCastProfileSchema>;
export const castWorldChoicesSchema = z.object({ characters: z.array(z.object({
  characterId: z.string(), name: z.string(), alwaysInContext: z.boolean()
}).strict()) }).strict();
export type CastWorldChoices = z.infer<typeof castWorldChoicesSchema>;
export const castFromWorldPreviewQuerySchema = z.object({ characterId: z.string().trim().min(1).max(200), targetCastCharacterId: z.uuid().optional() }).strict();
export const castFromWorldSchema = z.object({ ...castWriteBase, characterId: z.string().trim().min(1).max(200), expectedWorldVersionId: z.uuid(),
  previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/u), targetCastCharacterId: z.uuid().optional(), expectedCharacterRevision: z.number().int().nonnegative().optional(), alwaysInContext: z.boolean().optional()
}).strict().refine((value) => (value.targetCastCharacterId === undefined) === (value.expectedCharacterRevision === undefined));
export const castFromWorldPreviewSchema = z.object({ worldVersionId: z.uuid(), characterId: z.string(), targetCastCharacterId: z.uuid().optional(),
  eligibleTargets: z.array(z.object({ id: z.uuid(), name: z.string(), revision: z.number().int().nonnegative() }).strict()),
  castRevision: z.number().int().nonnegative(), boundary: castBoundarySchema, characterRevision: z.number().int().nonnegative().optional(),
  choices: z.array(z.never()), changes: z.array(z.discriminatedUnion("path", [
    z.object({ path: z.enum(["identity.pronouns", "story.role", "story.background", "story.personality", "story.motivations", "story.voiceAndMannerisms"]), old: z.string().nullable(), proposed: z.string(), effect: z.enum(["world", "preserve_edit", "discoverable"]) }).strict(),
    z.object({ path: z.literal("authoredProfile"), old: characterProfileSchema.nullable(), proposed: characterProfileSchema, effect: z.literal("apply") }).strict(),
    z.object({ path: z.literal("overrides"), old: z.array(castOverrideSchema), proposed: z.array(castOverrideSchema), effect: z.literal("preserve") }).strict(),
    z.object({ path: z.literal("identity"), old: z.object({ name: z.string(), aliases: z.array(z.string()) }).nullable(), proposed: z.object({ name: z.string(), aliases: z.array(z.string()) }), effect: z.enum(["preserve", "create"]) }).strict()
  ])), previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict();
export type CastFromWorldPreviewQuery = z.infer<typeof castFromWorldPreviewQuerySchema>;
export type CastFromWorld = z.infer<typeof castFromWorldSchema>;
export type CastFromWorldPreview = z.infer<typeof castFromWorldPreviewSchema>;
