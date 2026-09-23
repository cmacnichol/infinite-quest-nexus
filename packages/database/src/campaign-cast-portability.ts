import { randomUUID } from "node:crypto";
import { castStoredCommandSchema, portableCampaignCastSchema, type CastScope, type PortableCampaignCast,
  type CastEvidence, type CastBatchReceipt } from "../../contracts/src/campaign-cast.js";
import type { DatabaseClient } from "./pool.js";
import { rebuildCastWithClient } from "./campaign-cast-repository.js";
import { sha256, stableStringify } from "../../domain/src/text.js";
import { validateCastFiction } from "../../domain/src/campaign-cast.js";

export async function exportCampaignCast(client: DatabaseClient, scope: CastScope): Promise<PortableCampaignCast | undefined> {
  const state = (await client.query("SELECT revision FROM campaign_cast_state WHERE campaign_id=$1 AND owner_user_id=$2", [scope.campaignId, scope.ownerUserId])).rows[0];
  if (!state) return undefined;
  const characters = (await client.query(`SELECT id,origin,first_observed_turn AS "firstObservedTurn"
    FROM campaign_cast_characters WHERE campaign_id=$1 AND owner_user_id=$2 ORDER BY created_at,id`, [scope.campaignId, scope.ownerUserId])).rows;
  const events = (await client.query(`SELECT id,effective_turn_number AS "effectiveTurnNumber",(receipt->>'revision')::integer AS revision,payload AS commands
    FROM campaign_cast_events WHERE campaign_id=$1 AND owner_user_id=$2 ORDER BY sequence`, [scope.campaignId, scope.ownerUserId])).rows;
  const turnIds = new Set((await client.query("SELECT id FROM turns WHERE campaign_id=$1 AND owner_user_id=$2", [scope.campaignId, scope.ownerUserId])).rows.map((row) => row.id));
  const observationIds = new Set((await client.query("SELECT id FROM campaign_cast_observations WHERE campaign_id=$1 AND owner_user_id=$2", [scope.campaignId, scope.ownerUserId])).rows.map((row) => row.id));
  const active = (await client.query("SELECT active_turn_number FROM campaigns WHERE id=$1 AND owner_user_id=$2", [scope.campaignId, scope.ownerUserId])).rows[0].active_turn_number;
  const retained = events.map((event) => ({ ...event, effectiveTurnNumber: Math.min(event.effectiveTurnNumber, active),
    commands: event.commands.map((raw: unknown) => castStoredCommandSchema.parse(raw)).filter((item: ReturnType<typeof castStoredCommandSchema.parse>) => item.command.kind !== "observe" || observationIds.has(item.observationId))
      .map((item: ReturnType<typeof castStoredCommandSchema.parse>) => {
        const command = item.command;
        return command.kind === "create" && command.evidence?.kind === "turn" && !turnIds.has(command.evidence.turnId)
          ? { ...item, command: { ...command, evidence: { ...command.evidence, invalidated: true } } } : item;
      }) })).filter((event) => event.commands.length > 0);
  return portableCampaignCastSchema.parse({ formatVersion: 1, revision: state.revision, characters, events: retained });
}

export async function importCampaignCast(client: DatabaseClient, scope: CastScope, raw: unknown,
  maps: { turns: ReadonlyMap<string, string>; worlds: ReadonlyMap<string, string> }): Promise<void> {
  if (raw === undefined || raw === null) return;
  if (typeof raw === "object" && "formatVersion" in raw && raw.formatVersion !== 1) throw new Error("cast_archive_version_unsupported");
  const payload = portableCampaignCastSchema.parse(raw);
  const characterIds = new Map(payload.characters.map((person) => [person.id, randomUUID()]));
  const eventIds = new Map(payload.events.map((event) => [event.id, randomUUID()]));
  const observationIds = new Map(payload.events.flatMap((event) => event.commands.flatMap((item) => item.observationId ? [[item.observationId, randomUUID()] as const] : [])));
  const requireId = (mapping: ReadonlyMap<string, string>, id: string) => {
    const mapped = mapping.get(id);
    if (!mapped) throw new Error("cast_archive_reference_invalid");
    return mapped;
  };
  const evidence = (source: CastEvidence): CastEvidence => {
    if (source.kind === "turn") return source.invalidated ? source : { ...source, turnId: requireId(maps.turns, source.turnId) };
    if (source.kind === "world") return maps.worlds.has(source.worldVersionId)
      ? { ...source, worldVersionId: requireId(maps.worlds, source.worldVersionId) }
      : { kind: "historical_world", sourceWorldVersionId: source.worldVersionId, sourcePath: source.sourcePath };
    if (source.kind === "historical_world") return source;
    throw new Error("cast_archive_reference_invalid");
  };
  const people = payload.characters.map((person) => ({ ...person, id: requireId(characterIds, person.id),
    origin: person.origin.kind === "world" ? maps.worlds.has(person.origin.worldVersionId)
      ? { ...person.origin, worldVersionId: requireId(maps.worlds, person.origin.worldVersionId) }
      : { kind: "historical_world" as const, sourceWorldVersionId: person.origin.worldVersionId, entityId: person.origin.entityId }
      : person.origin }));
  const events = payload.events.map((event) => ({ ...event, id: requireId(eventIds, event.id), commands: event.commands.map((item) => {
    const command = item.command;
    if (command.kind === "create" || command.kind === "identity") { validateCastFiction(command.name); command.aliases.forEach(validateCastFiction); }
    if (command.kind === "observe" || command.kind === "override") validateCastFiction(command.value);
    return castStoredCommandSchema.parse({
      ...(item.characterId ? { characterId: requireId(characterIds, item.characterId) } : {}),
      ...(item.observationId ? { observationId: requireId(observationIds, item.observationId) } : {}),
      command: command.kind === "create" ? { ...command, origin: people.find((person) => person.id === requireId(characterIds, item.characterId!))!.origin,
        ...(command.evidence ? { evidence: evidence(command.evidence) } : {}) }
        : { ...command, characterId: requireId(characterIds, command.characterId), ...(command.kind === "observe" ? {
          evidence: evidence(command.evidence), speakerCharacterId: command.speakerCharacterId ? requireId(characterIds, command.speakerCharacterId) : null,
          supersedesObservationId: command.supersedesObservationId ? requireId(observationIds, command.supersedesObservationId) : null
        } : {}) }
    });
  }) }));
  // Validate all mapped sources against destination scope before the first cast write.
  const campaign = (await client.query("SELECT active_turn_number,selected_character_id FROM campaigns WHERE id=$1 AND owner_user_id=$2 FOR UPDATE", [scope.campaignId, scope.ownerUserId])).rows[0];
  if (!campaign) throw new Error("cast_archive_reference_invalid");
  if (people.some((person) => person.firstObservedTurn > campaign.active_turn_number)) throw new Error("cast_archive_boundary_invalid");
  for (const event of events) {
    if (event.effectiveTurnNumber > campaign.active_turn_number) throw new Error("cast_archive_boundary_invalid");
    for (const { command } of event.commands) {
      if (!((command.kind === "create" || command.kind === "observe") && command.evidence)) continue;
      const source = command.evidence;
      if (source.kind === "turn") {
        if (source.invalidated && command.kind === "create") continue;
        const turn = (await client.query("SELECT turn_number FROM turns WHERE id=$1 AND campaign_id=$2 AND owner_user_id=$3", [source.turnId, scope.campaignId, scope.ownerUserId])).rows[0];
        if (!turn || turn.turn_number !== source.turnNumber) throw new Error("cast_archive_reference_invalid");
      } else if (source.kind === "world") {
        if (!(await client.query("SELECT id FROM world_versions WHERE id=$1 AND owner_user_id=$2", [source.worldVersionId, scope.ownerUserId])).rows.length) throw new Error("cast_archive_reference_invalid");
      }
    }
  }
  await client.query("INSERT INTO campaign_cast_state(owner_user_id,campaign_id,revision) VALUES($1,$2,$3)", [scope.ownerUserId, scope.campaignId, payload.revision]);
  for (const person of people) {
    const origin = person.origin.kind === "protagonist" ? { kind: "protagonist", selectedCharacterId: campaign.selected_character_id } : person.origin;
    await client.query("INSERT INTO campaign_cast_characters(id,owner_user_id,campaign_id,origin,first_observed_turn) VALUES($1,$2,$3,$4,$5)", [person.id, scope.ownerUserId, scope.campaignId, JSON.stringify(origin), person.firstObservedTurn]);
  }
  for (const event of events) {
    const receipt: CastBatchReceipt = { eventId: event.id, revision: event.revision,
      characterIds: event.commands.flatMap((item) => item.characterId ? [item.characterId] : []),
      observationIds: event.commands.flatMap((item) => item.observationId ? [item.observationId] : []) };
    await client.query(`INSERT INTO campaign_cast_events(id,owner_user_id,campaign_id,effective_turn_number,timeline_revision,idempotency_key,request_hash,payload,receipt)
      VALUES($1,$2,$3,$4,0,$5,$6,$7,$8)`, [event.id, scope.ownerUserId, scope.campaignId, event.effectiveTurnNumber,
      `import:${event.id}`, sha256(stableStringify(event.commands)), JSON.stringify(event.commands), JSON.stringify(receipt)]);
    for (const item of event.commands) if (item.command.kind === "observe") {
      const command = item.command;
      await client.query(`INSERT INTO campaign_cast_observations(id,owner_user_id,campaign_id,character_id,event_id,field,value,mode,speaker_character_id,evidence,supersedes_observation_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [item.observationId, scope.ownerUserId, scope.campaignId, command.characterId, event.id,
        command.field, command.value, command.mode, command.speakerCharacterId, JSON.stringify(command.evidence), command.supersedesObservationId]);
    }
  }
  await rebuildCastWithClient(client, scope);
}
