import { z } from "zod";
import { castBoundarySchema, castCharacterSchema, castDetailSchema, castFieldSchema, castAuthoredPathSchema, castWriteBase, castWriteResultSchema } from "./campaign-cast.js";

const ordinal = z.number().int().nonnegative();
const reviewedAliases = castCharacterSchema.shape.aliases;
export const castMergePathSchema = z.enum([...new Set([...castFieldSchema.options, ...castAuthoredPathSchema.options])]);
export const castMergeChoicesSchema = z.partialRecord(castMergePathSchema, z.enum(["source", "target"]));
export const castMergeRequestSchema = z.object({ ...castWriteBase, sourceCharacterId: z.uuid(),
  expectedCharacterRevision: ordinal, expectedSourceCharacterRevision: ordinal,
  reviewedAliases, choices: castMergeChoicesSchema }).strict();
export const castUnmergeRequestSchema = z.object({ ...castWriteBase, expectedCharacterRevision: ordinal,
  expectedSourceCharacterRevision: ordinal, mergeEventId: z.uuid(), reviewedAliases: reviewedAliases.optional() }).strict();
// Undo previews expose every recoverable alias before the user resolves the capacity limit.
export const castUnmergePreviewSchema = z.object({
  target: castCharacterSchema.safeExtend({ aliases: z.array(reviewedAliases.element) }), source: castCharacterSchema,
  expectedCharacterRevision: ordinal, expectedSourceCharacterRevision: ordinal, revision: ordinal, boundary: castBoundarySchema
}).strict();
export const castMergePreviewSchema = z.object({ target: castDetailSchema, source: castDetailSchema,
  aliasCandidates: z.array(z.string()), fields: z.array(z.object({ path: castMergePathSchema,
    target: z.union([z.string(), z.array(z.string())]).nullable(), source: z.union([z.string(), z.array(z.string())]).nullable(), choiceRequired: z.boolean(),
    automaticValue: z.string().nullable().optional(),
    defaultChoice: z.enum(["source", "target"]).nullable(), allowedChoices: z.array(z.enum(["source", "target"])).max(2) }).strict()) }).strict();
export const castMergeResultSchema = castWriteResultSchema;
export type CastMergeRequest = z.infer<typeof castMergeRequestSchema>;
export type CastUnmergeRequest = z.infer<typeof castUnmergeRequestSchema>;
export type CastUnmergePreview = z.infer<typeof castUnmergePreviewSchema>;
export type CastMergePreview = z.infer<typeof castMergePreviewSchema>;
