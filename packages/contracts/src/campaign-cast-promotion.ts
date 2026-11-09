import { z } from "zod";
import { castBoundarySchema } from "./campaign-cast.js";
const revision = z.number().int().nonnegative();
const path = z.string().min(1).max(200);
const candidate = z.object({ sourcePath: path, value: z.union([z.string(), z.array(z.string())]), unselectableReason: z.literal("mechanics_language").optional() }).strict();
export const castPromotionPreviewSchema = z.object({ worldId: z.uuid(), draftRevision: revision, characterRevision: revision,
  castRevision: revision, boundary: castBoundarySchema, destinations: z.array(z.object({ path, candidates: z.array(candidate),
    tickedByDefault: z.boolean(), requiredOnAdd: z.boolean() }).strict()), matches: z.array(z.object({ characterId: path, name: z.string() }).strict()) }).strict();
export const castPromoteSchema = z.object({ worldId: z.uuid(), expectedDraftRevision: revision, expectedCastRevision: revision,
  expectedBoundary: castBoundarySchema, expectedCharacterRevision: revision, mode: z.enum(["add", "replace"]),
  targetCharacterId: path.optional(), selections: z.array(z.object({ destinationPath: path, sourcePath: path }).strict()).min(1).max(40),
  idempotencyKey: z.string().min(1).max(200) }).strict().superRefine((value, ctx) => {
    if ((value.mode === "replace") !== (value.targetCharacterId !== undefined)) ctx.addIssue({ code: "custom", message: "Replace requires a target; add must not specify one." });
    if (new Set(value.selections.map(item => item.destinationPath)).size !== value.selections.length) ctx.addIssue({ code: "custom", message: "Duplicate destination." });
    if (value.mode === "add" && !value.selections.some(item => item.destinationPath === "name")) ctx.addIssue({ code: "custom", message: "Add requires a name." });
  });
export const castPromoteResultSchema = z.object({ worldId: z.uuid(), draftRevision: revision, characterId: path }).strict();
export type CastPromotionPreview = z.infer<typeof castPromotionPreviewSchema>;
export type CastPromote = z.infer<typeof castPromoteSchema>;
export type CastPromoteResult = z.infer<typeof castPromoteResultSchema>;
