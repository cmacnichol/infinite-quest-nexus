import { z } from "zod";
import { castBoundarySchema } from "./campaign-cast.js";
import { castDiscoveryStatusSchema } from "./campaign-cast-discovery.js";

export const characterFilterSchema = z.enum(["all", "main", "recent", "pinned", "needs_review", "conflicts", "ignored"]);
export type CharacterFilter = z.infer<typeof characterFilterSchema>;
export const castNarratorStateSchema = z.enum(["installation_disabled", "enrollment_missing", "capability_insufficient", "discovery_off", "ready"]);
export type CastNarratorState = z.infer<typeof castNarratorStateSchema>;
export const charactersWorkspaceStatusSchema = z.object({
  revision: z.number().int().nonnegative(), boundary: castBoundarySchema,
  capabilities: z.object({ editing: z.boolean().nullable(), discovery: z.boolean().nullable(), autoMatch: z.boolean().nullable(), backfill: z.boolean().nullable(), context: z.boolean().nullable() }),
  contextDisabledReason: z.string().nullable(), narratorState: castNarratorStateSchema.optional(),
  counts: z.object({ identities: z.number().int().nonnegative().nullable(), details: z.number().int().nonnegative().nullable(), conflicts: z.number().int().nonnegative().nullable() }),
  reviewDecisions: z.object({ identities: z.number().int().min(0).max(10000), confirmed: z.number().int().min(0).max(10000), dismissed: z.number().int().min(0).max(10000) }).optional(),
  changeToken: z.string().optional(),
  legacyServer: z.boolean().optional(),
  recovery: z.object({ kind: z.enum(["forward", "scan", "manual", "none"]), turnNumber: z.number().int().positive(),
    jobId: z.uuid().nullable(), scanId: z.uuid().nullable(), scanStatus: z.enum(["queued", "running", "paused", "complete", "failed", "cancelled"]).nullable() }).optional(),
  tracking: castDiscoveryStatusSchema.nullable()
});
export type CharactersWorkspaceStatus = z.infer<typeof charactersWorkspaceStatusSchema>;
