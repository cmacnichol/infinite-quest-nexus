import { z } from "zod";
import { castCharacterSchema, castFieldSchema, castScopeSchema } from "./campaign-cast.js";

export const CAST_DISCOVERY_PROTOCOL = "cast-discovery-v1";
const evidence = z.object({ paragraphId: z.string().min(1).max(200), quote: z.string().min(1).max(1000) }).strict();
export const castDiscoveryCandidateSchema = z.object({
  localKey: z.string().min(1).max(100), name: z.string().trim().min(1).max(200),
  aliases: z.array(z.string().trim().min(1).max(200)).max(20), existingCharacterId: z.uuid().nullable(),
  identityEvidence: z.array(evidence).min(1).max(8),
  observations: z.array(evidence.extend({ field: castFieldSchema, value: z.string().min(1).max(2000),
    mode: z.enum(["fact", "claim"]), speakerCharacterId: z.uuid().nullable() }).strict()).max(20)
}).strict();
export const castDiscoveryOutputSchema = z.object({ version: z.literal(1), characters: z.array(castDiscoveryCandidateSchema).max(20) }).strict()
  .refine((value) => new Set(value.characters.map((person) => person.localKey)).size === value.characters.length, "Duplicate local character keys.");
export const castDiscoverySourceSchema = z.object({
  scope: castScopeSchema, turnId: z.uuid(), turnNumber: z.number().int().positive(), narrationRevision: z.number().int().nonnegative(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u), timelineRevision: z.number().int().nonnegative(),
  paragraphs: z.array(z.object({ id: z.string().min(1).max(200), text: z.string().min(1) }).strict()).min(1)
}).strict().refine((value) => new Set(value.paragraphs.map((paragraph) => paragraph.id)).size === value.paragraphs.length,
  "Duplicate source paragraph IDs.");
export type CastDiscoveryCandidate = z.infer<typeof castDiscoveryCandidateSchema>;
export type CastDiscoveryOutput = z.infer<typeof castDiscoveryOutputSchema>;
export type CastDiscoverySource = z.infer<typeof castDiscoverySourceSchema>;

export const castDiscoveryIdentitySnapshotSchema = z.object({
  revision: z.number().int().nonnegative(), characters: z.array(castCharacterSchema), worldVersionId: z.uuid(),
  worldCharacters: z.array(z.object({ entityId: z.string().min(1).max(200), name: z.string().min(1).max(200),
    aliases: z.array(z.string().min(1).max(200)).max(20), identityHints: z.array(z.string().min(1).max(2000)).max(20).optional() }).strict())
}).strict();
export type CastDiscoveryIdentitySnapshot = z.infer<typeof castDiscoveryIdentitySnapshotSchema>;
