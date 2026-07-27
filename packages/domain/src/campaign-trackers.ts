import type { CampaignTracker } from "../../contracts/src/generation.js";

const MAXIMUM_TRACKERS = 200;

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, maximumLength: number): string {
  return String(value ?? "").trim().slice(0, maximumLength);
}

function firstText(values: unknown[], maximumLength: number): string {
  for (const value of values) {
    const candidate = text(value, maximumLength);
    if (candidate) return candidate;
  }
  return "";
}

function uniqueId(base: string, blocked: ReadonlySet<string>): string {
  if (!blocked.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const marker = `-${suffix}`;
    const candidate = `${base.slice(0, 200 - marker.length)}${marker}`;
    if (!blocked.has(candidate)) return candidate;
  }
}

export function normalizeCampaignTrackers(value: unknown): CampaignTracker[] {
  if (!Array.isArray(value)) return [];
  const normalized: Array<{
    derivedId: string;
    explicitId: string;
    id?: string;
    name: string;
    rules: string;
    value: string;
  }> = [];
  for (const [index, entry] of value.entries()) {
    const source = objectValue(entry);
    const name = firstText([source.name, source.label, source.title], 300);
    if (!name) continue;
    normalized.push({
      explicitId: text(source.id, 200),
      derivedId: firstText([source.name, name, `tracker-${index + 1}`], 200),
      name,
      value: String(source.value ?? source.currentValue ?? "").slice(0, 10_000),
      rules: String(source.rules ?? source.updateRules ?? "").slice(0, 4_000)
    });
    if (normalized.length === MAXIMUM_TRACKERS) break;
  }

  const reservedExplicitIds = new Set(
    normalized.map((tracker) => tracker.explicitId).filter(Boolean)
  );
  const used = new Set<string>();
  for (const tracker of normalized) {
    if (!tracker.explicitId) continue;
    tracker.id = used.has(tracker.explicitId)
      ? uniqueId(tracker.explicitId, new Set([...used, ...reservedExplicitIds]))
      : tracker.explicitId;
    used.add(tracker.id);
  }
  for (const tracker of normalized) {
    if (tracker.id) continue;
    tracker.id = uniqueId(tracker.derivedId, used);
    used.add(tracker.id);
  }
  return normalized.map(({ id, name, value: trackerValue, rules }) => ({
    id: id!,
    name,
    value: trackerValue,
    rules
  }));
}

export function normalizeCampaignStateSnapshot(value: unknown): Record<string, unknown> {
  const source = objectValue(value);
  return {
    ...source,
    trackers: normalizeCampaignTrackers(source.trackers)
  };
}
