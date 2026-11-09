import { createHash, randomUUID } from "node:crypto";
import type { CastCommand, PortableCampaignCast } from "../../packages/contracts/src/campaign-cast.js";
import { characterProfileSchema } from "../../packages/contracts/src/world-library.js";

export const invalidCastArchiveSequences = ["undo-removed", "detach-merged-seed", "undo-before-restore", "detach-before-undo"] as const;

export function castArchiveLifecycle(
  sequence: typeof invalidCastArchiveSequences[number] | "restore-undo-detach" | "late-mention",
  { worldVersionId, rosterId, turnId, narration, narrationRevision }: {
    worldVersionId: string; rosterId: string; turnId: string; narration: string; narrationRevision: number;
  },
): PortableCampaignCast {
  const target = randomUUID(), source = randomUUID(), seed = randomUUID(), merge = randomUUID();
  const origin = { kind: "manual" } as const;
  const range = { turnId, narrationRevision, sourceHash: createHash("sha256").update(narration).digest("hex"),
    paragraphId: "p1", start: 0, end: narration.length };
  const events: PortableCampaignCast["events"] = [
    ...[target, source].map((characterId, index) => ({
      id: randomUUID(), effectiveTurnNumber: 1, revision: index + 1,
      commands: [{ characterId, command: { kind: "create" as const, name: "Guide", aliases: [], origin } }],
    })),
    { id: seed, effectiveTurnNumber: 1, revision: 3,
      attachment: { eventId: seed, characterId: target, basis: "unique_world_name", observationIds: [],
        sourceRanges: [range] },
      commands: [{ command: { kind: "mention", characterId: target,
        evidence: { kind: "turn", turnId, turnNumber: 1, narrationRevision, sourceHash: range.sourceHash, paragraphId: range.paragraphId, quote: narration } } },
      { command: { kind: "seed_profile", characterId: target, entityId: rosterId, rosterName: "Guide", rosterAliases: [],
        legacyCharacterText: "", profile: characterProfileSchema.parse({}), worldVersionId,
        evidence: { kind: "world", worldVersionId, sourcePath: "/playableCharacters/0" } } }] },
    { id: merge, effectiveTurnNumber: 1, revision: 4, commands: [
      { command: { kind: "merge", characterId: target, sourceCharacterId: source, reviewedAliases: [], choices: {},
        aliasChanges: { priorTargetAliases: [], added: [], removed: [] } } },
      { command: { kind: "identity", characterId: target, name: "Guide", aliases: [] } },
    ] },
  ];
  function append(command: CastCommand, effectiveTurnNumber = 1) {
    events.push({ id: randomUUID(), effectiveTurnNumber, revision: events.length + 1, commands: [{ command }] });
  }
  const remove = { kind: "remove", characterId: target } as const;
  const restore = { kind: "restore", characterId: target } as const;
  const undo = { kind: "unmerge", characterId: target, mergeEventId: merge } as const;
  const detach = { kind: "detach", characterId: target, eventId: seed } as const;
  switch (sequence) {
    case "undo-removed": append(remove); append(undo); break;
    case "detach-merged-seed": append(detach); break;
    case "undo-before-restore": append(remove); append(restore, 3); append(undo, 2); break;
    case "detach-before-undo": append(undo, 3); append(detach, 2); break;
    case "restore-undo-detach": append(remove); append(restore); append(undo); append(detach); break;
    case "late-mention":
      append(undo, 3);
      append({ kind: "mention", characterId: source, evidence: { kind: "turn", turnId, turnNumber: 1,
        narrationRevision, sourceHash: range.sourceHash, paragraphId: range.paragraphId, quote: narration } });
      break;
  }
  return { formatVersion: 4, revision: events.length, events, characters: [target, source].map(id => ({ id, origin, firstObservedTurn: 1 })) };
}
