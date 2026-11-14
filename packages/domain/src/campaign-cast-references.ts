import type {
  CastAttachment, CastBatchReceipt, CastCommand, CastEvidence, CastObservation,
  CastOrigin, PortableCampaignCast
} from "../../contracts/src/campaign-cast.js";

type TurnEvidence = Extract<CastEvidence, { kind: "turn" }>;
type WorldEvidence = Extract<CastEvidence, { kind: "world" | "historical_world" }>;
type StoredCommand = PortableCampaignCast["events"][number]["commands"][number];
type CastReferenceEvent = Pick<PortableCampaignCast["events"][number], "id" | "commands" | "receipt" | "attachment">;
type ReceiptCharacter = NonNullable<CastBatchReceipt["result"]>["character"];

export type CastReferenceMaps = {
  characters: ReadonlyMap<string, string>;
  events: ReadonlyMap<string, string>;
  observations: ReadonlyMap<string, string>;
  turns: ReadonlyMap<string, string>;
};

/** Workflows decide which records survive and what their evidence means at the destination. */
export type CastReferenceRules = {
  origin(source: CastOrigin): CastOrigin;
  turnEvidence(source: TurnEvidence): TurnEvidence;
  worldEvidence(source: WorldEvidence): WorldEvidence;
  invalidReference(field: string): Error;
};

/** Translate typed references only. Authored text and profile extensions are opaque. */
export function createCastReferenceTranslator(maps: CastReferenceMaps, rules: CastReferenceRules) {
  function requireId(map: ReadonlyMap<string, string>, id: string, field: string): string {
    const mapped = map.get(id);
    if (!mapped) throw rules.invalidReference(field);
    return mapped;
  }
  const characterId = (id: string) => requireId(maps.characters, id, "characterId");
  const eventId = (id: string) => requireId(maps.events, id, "eventId");
  const observationId = (id: string) => requireId(maps.observations, id, "observationId");
  const turnId = (id: string) => requireId(maps.turns, id, "turnId");

  function evidence(source: CastEvidence): CastEvidence {
    switch (source.kind) {
      case "turn": return rules.turnEvidence(source);
      case "user": return { ...source, editId: eventId(source.editId) };
      case "world":
      case "historical_world": return rules.worldEvidence(source);
    }
  }

  function observation<T extends Omit<CastObservation, "id">>(source: T): T {
    return { ...source, characterId: characterId(source.characterId), evidence: evidence(source.evidence),
      speakerCharacterId: source.speakerCharacterId === null ? null : characterId(source.speakerCharacterId),
      supersedesObservationId: source.supersedesObservationId === null ? null : observationId(source.supersedesObservationId) };
  }

  function command(source: CastCommand): CastCommand {
    switch (source.kind) {
      case "create": return { ...source, origin: rules.origin(source.origin),
        ...(source.evidence ? { evidence: evidence(source.evidence) } : {}) };
      case "observe": return observation(source);
      case "mention": {
        const translatedEvidence = rules.turnEvidence(source.evidence);
        return { ...source, characterId: characterId(source.characterId), evidence: translatedEvidence,
          ...(source.sourceRange ? { sourceRange: { ...source.sourceRange,
            // Preserve mismatches for destination validation; never repair untrusted evidence.
            turnId: translatedEvidence.invalidated ? source.sourceRange.turnId : turnId(source.sourceRange.turnId) } } : {}) };
      }
      case "seed_profile": {
        const translatedEvidence = rules.worldEvidence(source.evidence);
        return { ...source, characterId: characterId(source.characterId), evidence: translatedEvidence,
          worldVersionId: translatedEvidence.kind === "world" ? translatedEvidence.worldVersionId : translatedEvidence.sourceWorldVersionId };
      }
      case "edit_authored_profile": return { ...source, characterId: characterId(source.characterId), seedEventId: eventId(source.seedEventId) };
      case "detach": return { ...source, characterId: characterId(source.characterId), eventId: eventId(source.eventId) };
      case "merge": return { ...source, characterId: characterId(source.characterId), sourceCharacterId: characterId(source.sourceCharacterId) };
      case "unmerge": return { ...source, characterId: characterId(source.characterId), mergeEventId: eventId(source.mergeEventId) };
      case "override":
      case "clear_override":
      case "identity":
      case "remove":
      case "restore":
      case "pin":
      case "ignore": return { ...source, characterId: characterId(source.characterId) };
    }
  }

  function storedCommand(source: StoredCommand): StoredCommand {
    return { ...source, command: command(source.command),
      ...(source.characterId ? { characterId: characterId(source.characterId) } : {}),
      ...(source.observationId ? { observationId: observationId(source.observationId) } : {}) };
  }

  function character(source: ReceiptCharacter): ReceiptCharacter {
    const seed = source.originProfile;
    const seedEvidence = seed && rules.worldEvidence(seed.evidence);
    return { ...source, id: characterId(source.id), origin: rules.origin(source.origin),
      ...(source.mergedIntoCharacterId ? { mergedIntoCharacterId: characterId(source.mergedIntoCharacterId) } : {}),
      ...(source.activeMerges ? { activeMerges: source.activeMerges.map(merge => ({ ...merge,
        mergeEventId: eventId(merge.mergeEventId), sourceCharacterId: characterId(merge.sourceCharacterId) })) } : {}),
      ...(seed && seedEvidence ? { originProfile: { ...seed, seedEventId: eventId(seed.seedEventId), evidence: seedEvidence,
        worldVersionId: seedEvidence.kind === "world" ? seedEvidence.worldVersionId : seedEvidence.sourceWorldVersionId } } : {}) };
  }

  function receipt(source: CastBatchReceipt): CastBatchReceipt {
    return { ...source, eventId: eventId(source.eventId), characterIds: source.characterIds.map(characterId),
      observationIds: source.observationIds.map(observationId),
      ...(source.result ? { result: { ...source.result, character: character(source.result.character) } } : {}) };
  }

  function attachment(source: CastAttachment): CastAttachment {
    return { ...source, eventId: eventId(source.eventId), characterId: characterId(source.characterId),
      observationIds: source.observationIds.map(observationId),
      sourceRanges: source.sourceRanges.map(range => ({ ...range, turnId: turnId(range.turnId) })) };
  }

  return {
    event<T extends CastReferenceEvent>(source: T): T {
      return { ...source, id: eventId(source.id), commands: source.commands.map(storedCommand),
        ...(source.receipt ? { receipt: receipt(source.receipt) } : {}),
        ...(source.attachment ? { attachment: attachment(source.attachment) } : {}) };
    },
    observation(source: CastObservation): CastObservation {
      return { ...observation(source), id: observationId(source.id) };
    }
  };
}
