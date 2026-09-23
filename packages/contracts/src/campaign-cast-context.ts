import { z } from "zod";
import { sha256Hex } from "./hash.js";
import { castSnapshotSchema, castScopeSchema, castObservationSchema, castOverrideSchema } from "./campaign-cast.js";

/** Captured private authority, separate from the historical public cast-list contract. */
export const castGenerationSnapshotSchema = castSnapshotSchema.extend({
  version: z.literal("cast-context-v1"), scope: castScopeSchema, worldVersionId: z.uuid(),
  coverageStartTurn: z.number().int().positive().nullable(),
  trackedThroughTurn: z.number().int().nonnegative().nullable(),
  discoveryStatus: z.enum(["off", "current", "pending", "failed"]),
  details: z.array(z.object({ characterId: z.uuid(), observations: z.array(castObservationSchema),
    overrides: z.array(castOverrideSchema) }).strict())
}).strict().superRefine((snapshot, context) => {
  const invalid = (message: string) => context.addIssue({ code: "custom", message });
  const characters = new Set(snapshot.characters.map((character) => character.id));
  const details = new Set(snapshot.details.map((detail) => detail.characterId));
  if (characters.size !== snapshot.characters.length || details.size !== snapshot.details.length
    || characters.size !== details.size || [...details].some((id) => !characters.has(id))) invalid("Invalid cast detail scope");
  const observationIds = new Set<string>();
  if (snapshot.characters.some((character) => character.lastObservedTurn > snapshot.boundary.turnNumber)) invalid("Character exceeds captured turn");
  for (const detail of snapshot.details) {
    if (new Set(detail.overrides.map((override) => override.field)).size !== detail.overrides.length) invalid("Duplicate current override");
    for (const observation of detail.observations) {
      if (observation.characterId !== detail.characterId || observationIds.has(observation.id)) invalid("Invalid cast observation scope");
      if (observation.evidence.kind === "world" && observation.evidence.worldVersionId !== snapshot.worldVersionId) invalid("Foreign world evidence");
      observationIds.add(observation.id);
    }
  }
  if (snapshot.trackedThroughTurn !== null && snapshot.trackedThroughTurn > snapshot.boundary.turnNumber) invalid("Coverage exceeds captured turn");
  if (snapshot.coverageStartTurn === null && snapshot.trackedThroughTurn !== null
    || snapshot.coverageStartTurn !== null && snapshot.coverageStartTurn > snapshot.boundary.turnNumber) invalid("Invalid coverage enrollment");
  if (snapshot.discoveryStatus === "current" && (snapshot.coverageStartTurn === null
    || snapshot.trackedThroughTurn !== snapshot.boundary.turnNumber)) invalid("Current coverage must reach the captured turn");
});
export type CastGenerationSnapshot = z.infer<typeof castGenerationSnapshotSchema>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function castGenerationSnapshotFingerprint(value: unknown): string {
  return sha256Hex(canonicalJson(castGenerationSnapshotSchema.parse(value)));
}
