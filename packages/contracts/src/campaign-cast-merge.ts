import { z } from "zod";
import { castDetailSchema, castFieldSchema, castAuthoredPathSchema, castWriteBase, castWriteResultSchema } from "./campaign-cast.js";

const ordinal = z.number().int().nonnegative();
export const castMergePathSchema = z.enum([...new Set([...castFieldSchema.options, ...castAuthoredPathSchema.options])]);
export const castMergeChoicesSchema = z.partialRecord(castMergePathSchema, z.enum(["source", "target"]));
export const castMergeRequestSchema = z.object({ ...castWriteBase, sourceCharacterId: z.uuid(),
  expectedCharacterRevision: ordinal, expectedSourceCharacterRevision: ordinal,
  reviewedAliases: z.array(z.string().trim().min(1).max(200)).max(20), choices: castMergeChoicesSchema }).strict();
export const castUnmergeRequestSchema = z.object({ ...castWriteBase, expectedCharacterRevision: ordinal,
  expectedSourceCharacterRevision: ordinal, mergeEventId: z.uuid() }).strict();
export const castMergePreviewSchema = z.object({ target: castDetailSchema, source: castDetailSchema,
  aliasCandidates: z.array(z.string()), fields: z.array(z.object({ path: castMergePathSchema,
    target: z.union([z.string(), z.array(z.string())]).nullable(), source: z.union([z.string(), z.array(z.string())]).nullable(), choiceRequired: z.boolean(),
    defaultChoice: z.enum(["source", "target"]).nullable(), allowedChoices: z.array(z.enum(["source", "target"])).max(2) }).strict()) }).strict();
export const castMergeResultSchema = castWriteResultSchema;
export type CastMergeRequest = z.infer<typeof castMergeRequestSchema>;
export type CastUnmergeRequest = z.infer<typeof castUnmergeRequestSchema>;
export type CastMergePreview = z.infer<typeof castMergePreviewSchema>;
