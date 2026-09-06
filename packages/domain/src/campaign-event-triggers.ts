/** Retain a text rule as both condition and effect rather than guessing how to split it.
 * Unsupported entries remain visible to the caller's validation boundary.
 */
export function normalizeCampaignEventTriggers(value: readonly unknown[]): unknown[] {
  const usedIds = new Set(value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || !("id" in entry) || typeof entry.id !== "string") return [];
    return [entry.id.trim()];
  }));
  return value.map((entry, index) => {
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
