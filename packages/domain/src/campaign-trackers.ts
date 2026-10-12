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

export class CampaignTrackerUpdateError extends Error {
  readonly code = "tracker_update_identity_invalid";
  readonly reason: "ambiguous_name" | "conflicting_identity";

  constructor(reason: "ambiguous_name" | "conflicting_identity") {
    super("Campaign tracker update identity is invalid.");
    this.name = "CampaignTrackerUpdateError";
    this.reason = reason;
  }
}

function canonicalTrackerUpdate(update: Record<string, unknown>): {
  id: string;
  name: string;
  value?: string;
  rules?: string;
} {
  const rawValue = update.value ?? update.currentValue;
  const rawRules = update.rules ?? update.updateRules;
  return {
    id: text(update.id, 200),
    name: firstText([update.name, update.label, update.title], 300),
    ...(rawValue === undefined || rawValue === null
      ? {}
      : { value: String(rawValue).slice(0, 10_000) }),
    ...(rawRules === undefined || rawRules === null
      ? {}
      : { rules: String(rawRules).slice(0, 4_000) })
  };
}

export function applyCampaignTrackerUpdates(
  current: unknown,
  updates: readonly Record<string, unknown>[]
): CampaignTracker[] {
  let trackers = normalizeCampaignTrackers(current);

  for (const update of updates) {
    const patch = canonicalTrackerUpdate(update);
    const fields = {
      ...(patch.name ? { name: patch.name } : {}),
      ...(patch.value !== undefined ? { value: patch.value } : {}),
      ...(patch.rules !== undefined ? { rules: patch.rules } : {})
    };

    if (!patch.name && !patch.id) continue;

    let targetIndex = -1;
    if (patch.id) {
      targetIndex = trackers.findIndex((tracker) => tracker.id === patch.id);
      if (targetIndex < 0) {
        if (patch.name && trackers.some((tracker) => tracker.name === patch.name)) {
          throw new CampaignTrackerUpdateError("conflicting_identity");
        }
        if (!patch.name) continue;
        trackers = normalizeCampaignTrackers([
          ...trackers,
          {
            id: patch.id,
            name: patch.name,
            value: patch.value ?? "",
            rules: patch.rules ?? ""
          }
        ]);
        continue;
      }
    } else {
      const matches = trackers
        .map((tracker, index) => ({ tracker, index }))
        .filter(({ tracker }) => tracker.name === patch.name);
      if (matches.length === 1) {
        targetIndex = matches[0]!.index;
      } else if (matches.length > 1) {
        const legacyMatches = matches.filter(({ tracker }) => tracker.id === patch.name);
        if (legacyMatches.length !== 1) {
          throw new CampaignTrackerUpdateError("ambiguous_name");
        }
        targetIndex = legacyMatches[0]!.index;
      } else {
        trackers = normalizeCampaignTrackers([
          ...trackers,
          {
            name: patch.name,
            value: patch.value ?? "",
            rules: patch.rules ?? ""
          }
        ]);
        continue;
      }
    }

    const target = trackers[targetIndex]!;
    trackers = trackers.map((tracker, index) =>
      index === targetIndex ? { ...target, ...fields, id: target.id } : tracker
    );
  }

  return trackers;
}

export function normalizeCampaignStateSnapshot(value: unknown): Record<string, unknown> {
  const source = objectValue(value);
  return {
    ...source,
    trackers: normalizeCampaignTrackers(source.trackers)
  };
}
