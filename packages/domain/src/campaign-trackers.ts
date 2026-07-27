import type { CampaignTracker } from "../../contracts/src/generation.js";

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, maximumLength: number): string {
  return String(value ?? "").trim().slice(0, maximumLength);
}

function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const marker = `-${suffix}`;
    const candidate = `${base.slice(0, 200 - marker.length)}${marker}`;
    if (!used.has(candidate)) return candidate;
  }
}

export function normalizeCampaignTrackers(value: unknown): CampaignTracker[] {
  if (!Array.isArray(value)) return [];
  const used = new Set<string>();
  return value.flatMap((entry, index) => {
    const source = objectValue(entry);
    const name = text(source.name || source.label || source.title, 300);
    if (!name) return [];
    const baseId = text(source.id || source.name || name || `tracker-${index + 1}`, 200)
      || `tracker-${index + 1}`;
    const id = uniqueId(baseId, used);
    used.add(id);
    return [{
      id,
      name,
      value: String(source.value ?? source.currentValue ?? "").slice(0, 10_000),
      rules: String(source.rules ?? source.updateRules ?? "").slice(0, 4_000)
    }];
  });
}

export function normalizeCampaignStateSnapshot(value: unknown): Record<string, unknown> {
  const source = objectValue(value);
  return {
    ...source,
    trackers: normalizeCampaignTrackers(source.trackers)
  };
}
