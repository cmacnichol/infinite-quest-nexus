import {
  campaignRuntimeStateUpdateRequestSchema,
  type CampaignRuntimeStateResponse,
  type CampaignRuntimeStateUpdate
} from "@infinite-quest/contracts";

export type CampaignContinuityDraft = {
  continuitySummary: string;
  scratchpad: string;
  openThreads: Array<{ key: string; content: string }>;
  canonicalFacts: Array<{ key: string; id: string | null; content: string }>;
};

type NormalizedContinuity = Pick<
  CampaignRuntimeStateUpdate,
  "continuitySummary" | "scratchpad" | "openThreads" | "canonicalFacts"
>;

function normalizeTextRows(rows: readonly { content: string }[]): string[] {
  return rows
    .map((row) => row.content.trim())
    .filter((content) => content.length > 0);
}

function normalizeCanonicalFacts(
  rows: readonly { id: string | null; content: string }[]
): CampaignRuntimeStateUpdate["canonicalFacts"] {
  const factIds = new Set<string>();
  const facts: CampaignRuntimeStateUpdate["canonicalFacts"] = [];

  for (const row of rows) {
    const content = row.content.trim();
    if (content.length === 0) continue;
    if (row.id !== null) {
      if (factIds.has(row.id)) {
        throw new Error("Campaign continuity cannot contain duplicate canonical fact IDs.");
      }
      factIds.add(row.id);
    }
    facts.push({ id: row.id, content });
  }

  return facts;
}

function normalizeDraft(draft: CampaignContinuityDraft): NormalizedContinuity {
  return {
    continuitySummary: draft.continuitySummary,
    scratchpad: draft.scratchpad,
    openThreads: normalizeTextRows(draft.openThreads),
    canonicalFacts: normalizeCanonicalFacts(draft.canonicalFacts)
  };
}

function normalizeBase(base: CampaignRuntimeStateResponse): NormalizedContinuity {
  return {
    continuitySummary: base.continuitySummary,
    scratchpad: base.scratchpad,
    openThreads: normalizeTextRows(base.openThreads.map((content) => ({ content }))),
    canonicalFacts: normalizeCanonicalFacts(base.canonicalFacts)
  };
}

function sameTextList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function sameFacts(
  left: readonly { id: string | null; content: string }[],
  right: readonly { id: string | null; content: string }[]
): boolean {
  return left.length === right.length && left.every((fact, index) => (
    fact.id === right[index]?.id && fact.content === right[index]?.content
  ));
}

function assertCurrentState(base: CampaignRuntimeStateResponse): void {
  if (!base.isCurrent || base.viewedTurnNumber !== base.activeTurnNumber) {
    throw new Error("Campaign continuity can only be saved for the current state.");
  }
}

export function createCampaignContinuityDraft(
  base: CampaignRuntimeStateResponse
): CampaignContinuityDraft {
  return {
    continuitySummary: base.continuitySummary,
    scratchpad: base.scratchpad,
    openThreads: base.openThreads.map((content, index) => ({
      key: `thread:${index}`,
      content
    })),
    canonicalFacts: base.canonicalFacts.map((fact, index) => ({
      key: fact.id === null ? `fact:new:${index}` : `fact:${fact.id}`,
      id: fact.id,
      content: fact.content
    }))
  };
}

export function buildCurrentStateUpdate(
  base: CampaignRuntimeStateResponse,
  draft: CampaignContinuityDraft,
  options?: Readonly<{ trackers?: CampaignRuntimeStateUpdate["trackers"] }>
): CampaignRuntimeStateUpdate {
  assertCurrentState(base);
  const continuity = normalizeDraft(draft);

  return campaignRuntimeStateUpdateRequestSchema.parse({
    ...continuity,
    expectedTurnNumber: base.activeTurnNumber,
    effectiveTurnNumber: base.activeTurnNumber,
    expectedRevision: base.revision,
    trackers: options?.trackers ?? base.trackers,
    rpgStats: base.rpgStats,
    eventTriggers: base.eventTriggers,
    pendingEventTriggers: base.pendingEventTriggers
  });
}

export function hasCampaignContinuityChanges(
  base: CampaignRuntimeStateResponse,
  draft: CampaignContinuityDraft
): boolean {
  const previous = normalizeBase(base);
  const next = normalizeDraft(draft);

  return previous.continuitySummary !== next.continuitySummary
    || previous.scratchpad !== next.scratchpad
    || !sameTextList(previous.openThreads, next.openThreads)
    || !sameFacts(previous.canonicalFacts, next.canonicalFacts);
}
