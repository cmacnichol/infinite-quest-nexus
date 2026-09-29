import { playerEventTriggerSchema } from "../../contracts/src/generation.js";

export type CampaignEventRuleIssue = Readonly<{
  code: "invalid-event-rule";
  message: string;
  eventIndex?: number;
  field?: string;
}>;

const RULE_FIELDS = new Set(["id", "label", "timing", "condition", "effect", "addTextAfter", "triggeredCount", "lastTriggeredTurn", "lastTriggeredAt"]);

export function validateCampaignEventTriggers(value: readonly unknown[]) {
  const parsed = playerEventTriggerSchema.array().max(200).safeParse(normalizeCampaignEventTriggers(value));
  if (parsed.success) return { rules: parsed.data, issues: [] as CampaignEventRuleIssue[] };
  const issues = parsed.error.issues.slice(0, 5).map((issue): CampaignEventRuleIssue => {
    const eventIndex = typeof issue.path[0] === "number" ? issue.path[0] : undefined;
    const field = typeof issue.path[1] === "string" && RULE_FIELDS.has(issue.path[1]) ? issue.path[1] : undefined;
    return {
      code: "invalid-event-rule",
      message: eventIndex === undefined
        ? "This world version has too many event rules (maximum 200)."
        : `Event rule ${eventIndex + 1}${field ? ` needs a valid ${field}` : " is invalid"}.`,
      ...(eventIndex === undefined ? {} : { eventIndex }),
      ...(field ? { field } : {})
    };
  });
  return { rules: null, issues };
}

/** Retain a text rule as both condition and effect rather than guessing how to split it.
 * Unsupported entries remain visible to the caller's validation boundary.
 */
export function normalizeCampaignEventTriggers(value: readonly unknown[]): unknown[] {
  const usedIds = new Set(value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || !("id" in entry) || typeof entry.id !== "string") return [];
    return [entry.id.trim()];
  }));
  return value.map((entry, index) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const rule = entry as Record<string, unknown>;
      if ("name" in rule || "trigger_condition" in rule) {
        const { name, trigger_condition: legacyCondition, ...rest } = rule;
        return {
          ...rest,
          label: rule.label ?? name,
          condition: rule.condition ?? legacyCondition,
          timing: rule.timing ?? "before"
        };
      }
      return entry;
    }
    if (typeof entry !== "string") return entry;
    const baseId = `world-event-${index + 1}`;
    let id = baseId;
    for (let suffix = 2; usedIds.has(id); suffix += 1) id = `${baseId}-${suffix}`;
    usedIds.add(id);
    return {
      id, label: `World event ${index + 1}`, timing: "before",
      condition: entry.trim(), effect: entry.trim(), addTextAfter: false,
      triggeredCount: 0, lastTriggeredTurn: null, lastTriggeredAt: null
    };
  });
}
