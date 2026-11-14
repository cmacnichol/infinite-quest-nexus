import { describe, expect, it } from "vitest";
import { castBatchReceiptSchema, castCommandSchema, castObservationSchema, type CastCommand } from "../../packages/contracts/src/campaign-cast.js";
import { createCastReferenceTranslator, type CastReferenceMaps, type CastReferenceRules } from "../../packages/domain/src/campaign-cast-references.js";

const ids = {
  character: "10000000-0000-4000-8000-000000000001", other: "10000000-0000-4000-8000-000000000002",
  event: "10000000-0000-4000-8000-000000000003", seed: "10000000-0000-4000-8000-000000000004",
  observation: "10000000-0000-4000-8000-000000000005", priorObservation: "10000000-0000-4000-8000-000000000006",
  turn: "10000000-0000-4000-8000-000000000007", world: "10000000-0000-4000-8000-000000000008"
};
const target = {
  character: "20000000-0000-4000-8000-000000000001", other: "20000000-0000-4000-8000-000000000002",
  event: "20000000-0000-4000-8000-000000000003", seed: "20000000-0000-4000-8000-000000000004",
  observation: "20000000-0000-4000-8000-000000000005", priorObservation: "20000000-0000-4000-8000-000000000006",
  turn: "20000000-0000-4000-8000-000000000007", world: "20000000-0000-4000-8000-000000000008"
};
const maps: CastReferenceMaps = {
  characters: new Map([[ids.character, target.character], [ids.other, target.other]]),
  events: new Map([[ids.event, target.event], [ids.seed, target.seed]]),
  observations: new Map([[ids.observation, target.observation], [ids.priorObservation, target.priorObservation]]),
  turns: new Map([[ids.turn, target.turn]])
};
const rules: CastReferenceRules = {
  origin: source => source.kind === "world" ? { ...source, worldVersionId: target.world } : source,
  worldEvidence: source => source.kind === "world" ? { ...source, worldVersionId: target.world } : source,
  turnEvidence: source => source.invalidated ? source : { ...source, turnId: target.turn },
  invalidReference: field => new Error(`Missing ${field}`)
};
const turnEvidence = { kind: "turn" as const, turnId: ids.turn, turnNumber: 1, narrationRevision: 0,
  sourceHash: "a".repeat(64), paragraphId: "p1", quote: "Mara" };
const range = { turnId: ids.turn, narrationRevision: 0, sourceHash: turnEvidence.sourceHash, paragraphId: "p1", start: 0, end: 4 };
const worldEvidence = { kind: "world" as const, worldVersionId: ids.world, sourcePath: "/playableCharacters/0" };

describe("campaign cast reference translation", () => {
  it("translates nested receipts and attachments while preserving literal profile data and the source event", () => {
    const profile = { identity: { characterId: ids.character }, eventId: ids.event, story: { background: ids.turn } };
    const receipt = castBatchReceiptSchema.parse({ eventId: ids.event, revision: 4, characterIds: [ids.character], observationIds: [ids.observation],
      result: { revision: 4, boundary: { turnNumber: 1, timelineRevision: 0 }, character: {
        id: ids.character, name: "Mara", aliases: [], origin: { kind: "world", worldVersionId: ids.world, entityId: "mara" },
        profile: { "story.background": ids.character }, campaignProfile: profile,
        originProfile: { seedEventId: ids.seed, worldVersionId: ids.world, entityId: "mara", rosterName: "Mara",
          rosterAliases: [], legacyCharacterText: ids.event, profile, evidence: worldEvidence },
        pinned: false, ignored: false, revision: 4, firstObservedTurn: 1, lastObservedTurn: 1,
        mergedIntoCharacterId: ids.other, activeMerges: [{ mergeEventId: ids.event, sourceCharacterId: ids.other, sourceName: "Mary", canUndo: true }]
      } } });
    const source = { id: ids.event, receipt, commands: [{ characterId: ids.character, observationId: ids.observation,
      command: castCommandSchema.parse({ kind: "edit_authored_profile", characterId: ids.character, seedEventId: ids.seed,
        set: { "story.background": ids.event }, reset: [] }) }],
      attachment: { eventId: ids.event, characterId: ids.character, basis: "unique_name" as const, sourceRanges: [range], observationIds: [ids.observation] } };
    const original = structuredClone(source);
    const translated = createCastReferenceTranslator(maps, rules).event(source);
    expect(translated).toMatchObject({ id: target.event,
      commands: [{ characterId: target.character, observationId: target.observation,
        command: { characterId: target.character, seedEventId: target.seed, set: { "story.background": ids.event } } }],
      receipt: { eventId: target.event, characterIds: [target.character], observationIds: [target.observation], result: { character: {
        id: target.character, origin: { worldVersionId: target.world }, mergedIntoCharacterId: target.other,
        activeMerges: [{ mergeEventId: target.event, sourceCharacterId: target.other }],
        originProfile: { seedEventId: target.seed, worldVersionId: target.world, evidence: { worldVersionId: target.world } }
      } } },
      attachment: { eventId: target.event, characterId: target.character, observationIds: [target.observation], sourceRanges: [{ turnId: target.turn }] } });
    expect(translated.receipt.result!.character.profile).toEqual(original.receipt.result!.character.profile);
    expect(translated.receipt.result!.character.campaignProfile).toEqual(original.receipt.result!.character.campaignProfile);
    expect(translated.receipt.result!.character.originProfile!.profile).toEqual(original.receipt.result!.character.originProfile!.profile);
    expect(source).toEqual(original);
  });

  it.each([false, true])("keeps lexical ranges consistent when evidence is invalidated=%s", invalidated => {
    const source = { id: ids.event, commands: [{ command: castCommandSchema.parse({ kind: "mention", characterId: ids.character,
      kindOfMention: "lexical", evidence: { ...turnEvidence, ...(invalidated ? { invalidated: true } : {}) }, sourceRange: range }) }] };
    const result = createCastReferenceTranslator(maps, rules).event(source);
    const expectedTurn = invalidated ? ids.turn : target.turn;
    expect(result.commands[0]!.command).toMatchObject({ characterId: target.character, evidence: { turnId: expectedTurn }, sourceRange: { turnId: expectedTurn } });
    expect(result).not.toHaveProperty("receipt");
  });

  it("preserves invalid evidence without a destination turn and leaves a forged range visible to validation", () => {
    const source = { id: ids.event, commands: [{ command: castCommandSchema.parse({ kind: "mention", characterId: ids.character,
      kindOfMention: "lexical", evidence: { ...turnEvidence, invalidated: true }, sourceRange: { ...range, turnId: ids.other } }) }] };
    const result = createCastReferenceTranslator({ ...maps, turns: new Map() }, rules).event(source);
    expect(result.commands[0]!.command).toMatchObject({ evidence: { turnId: ids.turn, invalidated: true }, sourceRange: { turnId: ids.other } });
  });

  it("uses the workflow's world provenance for both the seed and its evidence", () => {
    const command = castCommandSchema.parse({ kind: "seed_profile", characterId: ids.character, worldVersionId: ids.world,
      entityId: "mara", rosterName: "Mara", rosterAliases: [], legacyCharacterText: ids.seed, profile: {}, evidence: worldEvidence });
    const source = { id: ids.event, commands: [{ command }] };
    expect(createCastReferenceTranslator(maps, rules).event(source).commands[0]!.command).toMatchObject({
      worldVersionId: target.world, evidence: { kind: "world", worldVersionId: target.world }, legacyCharacterText: ids.seed });
    const historical = createCastReferenceTranslator(maps, { ...rules,
      worldEvidence: evidence => evidence.kind === "world"
        ? { kind: "historical_world", sourceWorldVersionId: evidence.worldVersionId, sourcePath: evidence.sourcePath } : evidence });
    expect(historical.event(source).commands[0]!.command).toMatchObject({ worldVersionId: ids.world,
      evidence: { kind: "historical_world", sourceWorldVersionId: ids.world } });
  });

  it("translates observation identity, speaker, supersession and user evidence together", () => {
    const source = castObservationSchema.parse({ id: ids.observation, characterId: ids.character, field: "story.role", value: ids.other, mode: "claim",
      speakerCharacterId: ids.other, supersedesObservationId: ids.priorObservation,
      evidence: { kind: "user", editId: ids.event, effectiveTurnNumber: 1 } });
    const translator = createCastReferenceTranslator(maps, rules);
    expect(translator.observation(source)).toEqual({ ...source, id: target.observation, characterId: target.character,
      speakerCharacterId: target.other, supersedesObservationId: target.priorObservation,
      evidence: { kind: "user", editId: target.event, effectiveTurnNumber: 1 } });
    const { id, ...command } = source;
    expect(translator.event({ id: ids.event, commands: [{ observationId: id, command: { ...command, kind: "observe" as const } }] }).commands[0]).toMatchObject({
      observationId: target.observation, command: { characterId: target.character, speakerCharacterId: target.other, supersedesObservationId: target.priorObservation } });
    expect(translator.observation({ ...source, speakerCharacterId: null, supersedesObservationId: null })).toMatchObject({ speakerCharacterId: null, supersedesObservationId: null });
  });

  const commands: Array<{ source: CastCommand; expected: object }> = [
    { source: { kind: "create", name: "Mara", aliases: [], origin: { kind: "world", worldVersionId: ids.world, entityId: "mara" }, evidence: worldEvidence },
      expected: { origin: { worldVersionId: target.world }, evidence: { worldVersionId: target.world } } },
    { source: { kind: "merge", characterId: ids.character, sourceCharacterId: ids.other, reviewedAliases: [], choices: {}, aliasChanges: { priorTargetAliases: [], added: [], removed: [] } },
      expected: { characterId: target.character, sourceCharacterId: target.other } },
    { source: { kind: "unmerge", characterId: ids.character, mergeEventId: ids.event }, expected: { characterId: target.character, mergeEventId: target.event } },
    { source: { kind: "detach", characterId: ids.character, eventId: ids.seed }, expected: { characterId: target.character, eventId: target.seed } },
    { source: { kind: "override", characterId: ids.character, field: "story.role", value: ids.other }, expected: { characterId: target.character, value: ids.other } },
    { source: { kind: "clear_override", characterId: ids.character, field: "story.role" }, expected: { characterId: target.character } },
    { source: { kind: "identity", characterId: ids.character, name: "Mara", aliases: [ids.other] }, expected: { characterId: target.character, aliases: [ids.other] } },
    { source: { kind: "remove", characterId: ids.character }, expected: { characterId: target.character } },
    { source: { kind: "restore", characterId: ids.character }, expected: { characterId: target.character } },
    { source: { kind: "pin", characterId: ids.character, value: true }, expected: { characterId: target.character } },
    { source: { kind: "ignore", characterId: ids.character, value: true }, expected: { characterId: target.character } }
  ];
  it.each(commands)("translates $source.kind references", ({ source, expected }) => {
    const translated = createCastReferenceTranslator(maps, rules).event({ id: ids.event, commands: [{ command: source }] });
    expect(translated.commands[0]!.command).toMatchObject(expected);
  });

  it.each(["characters", "events", "observations", "turns"] as const)("rejects missing %s mappings", missing => {
    const source = { id: ids.event, commands: [], attachment: { eventId: ids.event, characterId: ids.character,
      basis: "unique_name" as const, observationIds: [ids.observation], sourceRanges: [range] } };
    expect(() => createCastReferenceTranslator({ ...maps, [missing]: new Map() }, rules).event(source)).toThrow("Missing");
  });
});
