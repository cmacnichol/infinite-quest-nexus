import { sha256Hex } from "./hash.js";

/**
 * Stable serialization deliberately shared by the phase-03 planner and the
 * phase-04 receipt validator. Key ordering uses the established locale order;
 * it is intentionally distinct from canonicalEvidenceJson.
 */
export function factFormatRepairStableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(factFormatRepairStableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${factFormatRepairStableJson(entry)}`).join(",")}}`;
}

/** Hash used only for phase-03 fact-format planner fields. */
export function factFormatRepairHash(value: unknown): string {
  return sha256Hex(factFormatRepairStableJson(value));
}
