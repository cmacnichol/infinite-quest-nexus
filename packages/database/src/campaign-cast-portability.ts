import { buildCastDiscoverySource } from "../../domain/src/campaign-cast-discovery.js";
import { randomUUID } from "node:crypto";
import { castBatchReceiptSchema, castStoredCommandSchema, portableCampaignCastSchema, type CastScope, type PortableCampaignCast,
  type CastBatchReceipt } from "../../contracts/src/campaign-cast.js";
import type { DatabaseClient } from "./pool.js";
import { rebuildCastWithClient } from "./campaign-cast-repository.js";
import { sha256, stableStringify } from "../../domain/src/text.js";
import { createCastReferenceTranslator, type CastReferenceRules } from "../../domain/src/campaign-cast-references.js";
import { validateCastFiction } from "../../domain/src/campaign-cast.js";

export async function exportCampaignCast(client: DatabaseClient, scope: CastScope): Promise<PortableCampaignCast | undefined> {
  const state = (await client.query("SELECT revision FROM campaign_cast_state WHERE campaign_id=$1 AND owner_user_id=$2", [scope.campaignId, scope.ownerUserId])).rows[0];
  if (!state) return undefined;
  const characters = (await client.query(`SELECT id,origin,first_observed_turn AS "firstObservedTurn"
    FROM campaign_cast_characters WHERE campaign_id=$1 AND owner_user_id=$2 ORDER BY created_at,id`, [scope.campaignId, scope.ownerUserId])).rows;
  const events = (await client.query(`SELECT id,effective_turn_number AS "effectiveTurnNumber",(receipt->>'revision')::integer AS revision,payload AS commands,receipt,attachment
    FROM campaign_cast_events WHERE campaign_id=$1 AND owner_user_id=$2 ORDER BY sequence`, [scope.campaignId, scope.ownerUserId])).rows;
  const turnIds = new Set((await client.query("SELECT id FROM turns WHERE campaign_id=$1 AND owner_user_id=$2", [scope.campaignId, scope.ownerUserId])).rows.map((row) => row.id));
  const observationIds = new Set((await client.query("SELECT id FROM campaign_cast_observations WHERE campaign_id=$1 AND owner_user_id=$2", [scope.campaignId, scope.ownerUserId])).rows.map((row) => row.id));
  const sources = new Map((await client.query(`SELECT turn_id,correction_revision,effective_narration FROM effective_turn_narrations
    WHERE campaign_id=$1 AND owner_user_id=$2`, [scope.campaignId, scope.ownerUserId])).rows.map((row) => [row.turn_id, row]));
  const detachedSeeds = new Set(events.flatMap(event => event.commands.flatMap((item: ReturnType<typeof castStoredCommandSchema.parse>) => item.command.kind === "detach" ? [item.command.eventId] : []))
    .filter(id => events.some(event => event.id === id && event.commands.some((item: ReturnType<typeof castStoredCommandSchema.parse>) => item.command.kind === "seed_profile"))));
  const validAttachments = new Set(events.filter((event) => event.attachment && event.attachment.sourceRanges.every((range: any) => {
    const source: any = sources.get(range.turnId);
    return source && (detachedSeeds.has(event.id) || source.correction_revision === range.narrationRevision && sha256(source.effective_narration) === range.sourceHash);
  }) && event.attachment.observationIds.every((id: string) => observationIds.has(id))).map((event) => event.id));
  const active = (await client.query("SELECT active_turn_number FROM campaigns WHERE id=$1 AND owner_user_id=$2", [scope.campaignId, scope.ownerUserId])).rows[0].active_turn_number;
  const retained = events.map((event) => ({ ...event, attachment: validAttachments.has(event.id) ? event.attachment : undefined, effectiveTurnNumber: Math.min(event.effectiveTurnNumber, active),
    commands: event.commands.map((raw: unknown) => castStoredCommandSchema.parse(raw)).filter((item: ReturnType<typeof castStoredCommandSchema.parse>) => (item.command.kind !== "observe" || observationIds.has(item.observationId)) && (item.command.kind !== "detach" || validAttachments.has(item.command.eventId)))
      .map((item: ReturnType<typeof castStoredCommandSchema.parse>) => {
        const command = item.command;
        if ((command.kind === "create" || command.kind === "mention") && command.evidence?.kind === "turn") {
          const source: any = sources.get(command.evidence.turnId);
          const staleLexical = command.kind === "mention" && command.sourceRange && (!source
            || source.correction_revision !== command.evidence.narrationRevision
            || sha256(source.effective_narration) !== command.evidence.sourceHash);
          if (!turnIds.has(command.evidence.turnId) || staleLexical) {
            return { ...item, command: { ...command, evidence: { ...command.evidence, invalidated: true as const } } };
          }
        }
        return item;
      }) })).filter((event) => event.commands.length > 0);
  // Historical v2 omits receipts entirely. Determine compatibility before stripping them.
  const needsV3 = retained.some(event => {
    const person = castBatchReceiptSchema.parse(event.receipt).result?.character;
    return person?.originProfile !== undefined || person?.campaignProfile !== undefined
      || Object.values(person?.profile ?? {}).some(value => value.length > 2_000)
      || event.commands.some(({ command }: ReturnType<typeof castStoredCommandSchema.parse>) => command.kind === "seed_profile" || command.kind === "edit_authored_profile"
        || command.kind === "override" && command.value.length > 2_000);
  });
  const needsV4 = retained.some(event => event.commands.some(({ command }: ReturnType<typeof castStoredCommandSchema.parse>) => ["merge", "unmerge", "remove", "restore"].includes(command.kind) || command.kind === "identity" && command.aliasChanges));
  return portableCampaignCastSchema.parse({ formatVersion: needsV4 ? 4 : needsV3 ? 3 : 2, revision: state.revision, characters,
    events: needsV4 || needsV3 ? retained : retained.map(({ receipt, ...event }) => event) });
}

export async function importCampaignCast(client: DatabaseClient, scope: CastScope, raw: unknown,
  maps: { turns: ReadonlyMap<string, string>; worlds: ReadonlyMap<string, string> }): Promise<void> {
  if (raw === undefined || raw === null) return;
  if (typeof raw === "object" && "formatVersion" in raw && raw.formatVersion !== 1 && raw.formatVersion !== 2 && raw.formatVersion !== 3 && raw.formatVersion !== 4) throw new Error("cast_archive_version_unsupported");
  const payload = portableCampaignCastSchema.parse(raw);
  const characterIds = new Map(payload.characters.map((person) => [person.id, randomUUID()]));
  const eventIds = new Map(payload.events.map((event) => [event.id, randomUUID()]));
  const observationIds = new Map(payload.events.flatMap((event) => event.commands.flatMap((item) => item.observationId ? [[item.observationId, randomUUID()] as const] : [])));
  const requireId = (mapping: ReadonlyMap<string, string>, id: string) => {
    const mapped = mapping.get(id);
    if (!mapped) throw new Error("cast_archive_reference_invalid");
    return mapped;
  };
  const rules: CastReferenceRules = {
    origin: origin => origin.kind === "world" ? maps.worlds.has(origin.worldVersionId)
      ? { ...origin, worldVersionId: requireId(maps.worlds, origin.worldVersionId) }
      : { kind: "historical_world", sourceWorldVersionId: origin.worldVersionId, entityId: origin.entityId } : origin,
    worldEvidence: evidence => evidence.kind === "world" ? maps.worlds.has(evidence.worldVersionId)
      ? { ...evidence, worldVersionId: requireId(maps.worlds, evidence.worldVersionId) }
      : { kind: "historical_world", sourceWorldVersionId: evidence.worldVersionId, sourcePath: evidence.sourcePath } : evidence,
    turnEvidence: evidence => evidence.invalidated ? evidence : { ...evidence, turnId: requireId(maps.turns, evidence.turnId) },
    invalidReference: () => new Error("cast_archive_reference_invalid")
  };
  const people = payload.characters.map(person => ({ ...person, id: requireId(characterIds, person.id), origin: rules.origin(person.origin) }));
  const translator = createCastReferenceTranslator({ characters: characterIds, events: eventIds, observations: observationIds, turns: maps.turns }, rules);
  const events = payload.events.map(event => {
    for (const { command } of event.commands) {
      if (command.kind === "create" || command.kind === "identity") { validateCastFiction(command.name); command.aliases.forEach(validateCastFiction); }
      if (command.kind === "observe" || command.kind === "override") validateCastFiction(command.value);
      if (command.kind === "seed_profile") {
        validateCastFiction(command.rosterName);
        command.rosterAliases.forEach(validateCastFiction);
      }
      if (command.kind === "edit_authored_profile") {
        for (const value of Object.values(command.set)) (Array.isArray(value) ? value : [value]).forEach(validateCastFiction);
      }
      if ((command.kind === "create" || command.kind === "observe") && command.evidence?.kind === "user") {
        throw new Error("cast_archive_reference_invalid");
      }
    }
    const translated = translator.event(event);
    return { ...translated, commands: translated.commands.map(command => castStoredCommandSchema.parse(command)) };
  });
  // Validate all mapped sources against destination scope before the first cast write.
  const campaign = (await client.query("SELECT active_turn_number,selected_character_id FROM campaigns WHERE id=$1 AND owner_user_id=$2 FOR UPDATE", [scope.campaignId, scope.ownerUserId])).rows[0];
  if (!campaign) throw new Error("cast_archive_reference_invalid");
  if (people.some((person) => person.firstObservedTurn > campaign.active_turn_number)) throw new Error("cast_archive_boundary_invalid");
  const suppressedSeedEvents = new Set(events.flatMap(event => event.commands.flatMap(item => item.command.kind === "detach" ? [item.command.eventId] : []))
    .filter(id => events.some(event => event.id === id && event.commands.some(item => item.command.kind === "seed_profile"))));
  for (const event of events) {
    if (event.effectiveTurnNumber > campaign.active_turn_number) throw new Error("cast_archive_boundary_invalid");
    if (event.attachment) for (const range of event.attachment.sourceRanges) {
      const source = (await client.query(`SELECT turn_number,correction_revision,effective_narration FROM effective_turn_narrations
        WHERE turn_id=$1 AND campaign_id=$2 AND owner_user_id=$3`, [range.turnId, scope.campaignId, scope.ownerUserId])).rows[0];
      if (!source) throw new Error("cast_archive_reference_invalid");
      if (suppressedSeedEvents.has(event.id) && (source.correction_revision !== range.narrationRevision || sha256(source.effective_narration) !== range.sourceHash)) continue;
      if (source.correction_revision !== range.narrationRevision || sha256(source.effective_narration) !== range.sourceHash)
        throw new Error("cast_archive_reference_invalid");
      const parsed = buildCastDiscoverySource({ scope, turnId: range.turnId, turnNumber: source.turn_number,
        narrationRevision: range.narrationRevision, timelineRevision: 0, narration: source.effective_narration });
      const quote = parsed.paragraphs.find((paragraph) => paragraph.id === range.paragraphId)?.text.slice(range.start, range.end);
      if (!quote || !event.commands.some(({ command }) => (command.kind === "create" || command.kind === "observe" || command.kind === "mention")
        && command.evidence?.kind === "turn" && command.evidence.turnId === range.turnId
        && command.evidence.narrationRevision === range.narrationRevision && command.evidence.sourceHash === range.sourceHash
        && command.evidence.paragraphId === range.paragraphId && command.evidence.quote === quote)) throw new Error("cast_archive_reference_invalid");
    }
    for (const { command } of event.commands) {
      if (!((command.kind === "create" || command.kind === "observe" || command.kind === "mention" || command.kind === "seed_profile") && command.evidence)) continue;
      const source = command.evidence;
      if (command.kind === "mention" && command.sourceRange && source.kind === "turn") {
        const range = command.sourceRange;
        if (range.turnId !== source.turnId || range.narrationRevision !== source.narrationRevision
          || range.sourceHash !== source.sourceHash || range.paragraphId !== source.paragraphId) throw new Error("cast_archive_reference_invalid");
        if (source.invalidated) continue;
        const row = (await client.query(`SELECT turn_number,correction_revision,effective_narration FROM effective_turn_narrations
          WHERE turn_id=$1 AND campaign_id=$2 AND owner_user_id=$3`, [range.turnId, scope.campaignId, scope.ownerUserId])).rows[0];
        if (!row || row.correction_revision !== range.narrationRevision || sha256(row.effective_narration) !== range.sourceHash)
          throw new Error("cast_archive_reference_invalid");
        const parsed = buildCastDiscoverySource({ scope, turnId: range.turnId, turnNumber: row.turn_number,
          narrationRevision: range.narrationRevision, timelineRevision: 0, narration: row.effective_narration });
        if (parsed.paragraphs.find((paragraph) => paragraph.id === range.paragraphId)?.text.slice(range.start, range.end) !== source.quote)
          throw new Error("cast_archive_reference_invalid");
      }
      if (source.kind === "turn") {
        if (source.invalidated && (command.kind === "create" || command.kind === "mention")) continue;
        const turn = (await client.query("SELECT turn_number FROM turns WHERE id=$1 AND campaign_id=$2 AND owner_user_id=$3", [source.turnId, scope.campaignId, scope.ownerUserId])).rows[0];
        if (!turn || turn.turn_number !== source.turnNumber) throw new Error("cast_archive_reference_invalid");
      } else if (source.kind === "world") {
        const world = (await client.query("SELECT content FROM world_versions WHERE id=$1 AND owner_user_id=$2", [source.worldVersionId, scope.ownerUserId])).rows[0];
        let referenced: unknown = world?.content;
        for (const raw of source.sourcePath.slice(1).split("/")) {
          if (/~(?:[^01]|$)/u.test(raw)) throw new Error("cast_archive_reference_invalid");
          const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
          if (!referenced || typeof referenced !== "object" || !Object.hasOwn(referenced, key)) throw new Error("cast_archive_reference_invalid");
          referenced = (referenced as Record<string, unknown>)[key];
        }
        if (referenced === null || referenced === undefined || command.kind === "seed_profile"
          && (typeof referenced !== "object" || (referenced as { id?: unknown }).id !== command.entityId)) throw new Error("cast_archive_reference_invalid");
      }
    }
  }
  await client.query("INSERT INTO campaign_cast_state(owner_user_id,campaign_id,revision) VALUES($1,$2,$3)", [scope.ownerUserId, scope.campaignId, payload.revision]);
  for (const person of people) {
    const origin = person.origin.kind === "protagonist" ? { kind: "protagonist", selectedCharacterId: campaign.selected_character_id } : person.origin;
    await client.query("INSERT INTO campaign_cast_characters(id,owner_user_id,campaign_id,origin,first_observed_turn) VALUES($1,$2,$3,$4,$5)", [person.id, scope.ownerUserId, scope.campaignId, JSON.stringify(origin), person.firstObservedTurn]);
  }
  for (const event of events) {
    const receipt: CastBatchReceipt = event.receipt ?? { eventId: event.id, revision: event.revision,
      characterIds: event.commands.flatMap((item) => item.characterId ? [item.characterId] : []),
      observationIds: event.commands.flatMap((item) => item.observationId ? [item.observationId] : []) };
    await client.query(`INSERT INTO campaign_cast_events(id,owner_user_id,campaign_id,effective_turn_number,timeline_revision,idempotency_key,request_hash,payload,receipt,attachment)
      VALUES($1,$2,$3,$4,0,$5,$6,$7,$8,$9)`, [event.id, scope.ownerUserId, scope.campaignId, event.effectiveTurnNumber,
      `import:${event.id}`, sha256(stableStringify(event.commands)), JSON.stringify(event.commands), JSON.stringify(receipt), event.attachment ? JSON.stringify(event.attachment) : null]);
    for (const item of event.commands) if (item.command.kind === "observe") {
      const command = item.command;
      await client.query(`INSERT INTO campaign_cast_observations(id,owner_user_id,campaign_id,character_id,event_id,field,value,mode,speaker_character_id,evidence,supersedes_observation_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [item.observationId, scope.ownerUserId, scope.campaignId, command.characterId, event.id,
        command.field, command.value, command.mode, command.speakerCharacterId, JSON.stringify(command.evidence), command.supersedesObservationId]);
    }
  }
  await rebuildCastWithClient(client, scope);
}
