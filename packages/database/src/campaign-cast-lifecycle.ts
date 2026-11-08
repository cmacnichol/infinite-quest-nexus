import { randomUUID } from "node:crypto";
import { castCommandSchema, castBatchReceiptSchema, castOriginSchema, type CastScope } from "../../contracts/src/campaign-cast.js";
import type { DatabaseClient } from "./pool.js";
import { rebuildCastWithClient } from "./campaign-cast-repository.js";
import { sha256, stableStringify } from "../../domain/src/text.js";
import { reconcileCastDiscoveryBoundary } from "./campaign-cast-job-repository.js";
import { cancelCastScansWithClient } from "./campaign-cast-backfill-repository.js";

export async function applyCastBoundaryChange(client: DatabaseClient, scope: CastScope,
  boundary: { turnNumber: number; changeKey: string }): Promise<void> {
  await client.query("SELECT id FROM campaigns WHERE id=$1 AND owner_user_id=$2 FOR UPDATE", [scope.campaignId, scope.ownerUserId]);
  const state = (await client.query("SELECT last_boundary_change_key FROM campaign_cast_state WHERE campaign_id=$1 AND owner_user_id=$2", [scope.campaignId, scope.ownerUserId])).rows[0];
  if (state?.last_boundary_change_key === boundary.changeKey) return;
  await cancelCastScansWithClient(client, scope);
  if (!state) return;
  // Match the campaign history lifecycle: discarded future user edits cannot reappear
  // when a new timeline reaches the same turn number.
  const events = (await client.query("SELECT id,payload FROM campaign_cast_events WHERE campaign_id=$1 AND owner_user_id=$2 AND effective_turn_number>$3", [scope.campaignId, scope.ownerUserId, boundary.turnNumber])).rows;
  for (const event of events) {
    const retainedCreateIds = new Set(event.payload.filter((item: { command: unknown; characterId?: string }) => {
      const command = castCommandSchema.parse(item.command);
      return command.kind === "create" && command.evidence?.kind === "turn" && command.evidence.turnNumber <= boundary.turnNumber;
    }).map((item: { characterId?: string }) => item.characterId));
    const retained = event.payload.filter((item: { command: unknown }) => {
      const command = castCommandSchema.parse(item.command);
      return command.kind === "seed_profile" && retainedCreateIds.has(command.characterId)
        || command.kind === "create" && command.evidence?.kind === "turn" && command.evidence.turnNumber <= boundary.turnNumber
        || (command.kind === "observe" || command.kind === "mention") && command.evidence.kind === "turn" && command.evidence.turnNumber <= boundary.turnNumber;
    });
    if (retained.length) await client.query("UPDATE campaign_cast_events SET payload=$2,receipt=receipt-'result',effective_turn_number=$3 WHERE id=$1", [event.id, JSON.stringify(retained), boundary.turnNumber]);
    else await client.query("DELETE FROM campaign_cast_events WHERE id=$1", [event.id]);
  }
  await client.query("DELETE FROM campaign_cast_characters WHERE campaign_id=$1 AND owner_user_id=$2 AND first_observed_turn>$3", [scope.campaignId, scope.ownerUserId, boundary.turnNumber]);
  await client.query(`UPDATE campaign_cast_state SET timeline_revision=timeline_revision+1,revision=revision+1,last_boundary_change_key=$3
    WHERE campaign_id=$1 AND owner_user_id=$2`, [scope.campaignId, scope.ownerUserId, boundary.changeKey]);
  await client.query(`UPDATE campaign_cast_state SET coverage_start_turn=NULL
    WHERE campaign_id=$1 AND owner_user_id=$2 AND coverage_start_turn>$3`, [scope.campaignId, scope.ownerUserId, boundary.turnNumber]);
  await rebuildCastWithClient(client, scope);
  await reconcileCastDiscoveryBoundary(client, scope, boundary.turnNumber);
}

/** Copy only retained authority, using explicit mappings supplied by the caller. */
export async function copyCampaignCast(client: DatabaseClient, source: CastScope, destination: CastScope,
  throughTurn: number, turnIds: ReadonlyMap<string, string>, crossWorld = false): Promise<void> {
  const state = (await client.query("SELECT revision,coverage_start_turn FROM campaign_cast_state WHERE campaign_id=$1 AND owner_user_id=$2", [source.campaignId, source.ownerUserId])).rows[0];
  if (!state) return;
  await rebuildCastWithClient(client, source, throughTurn);
  // Keep historical identities used by claims even when their introduction no
  // longer makes them visible in the current cast projection.
  const people = (await client.query(`SELECT id,origin,first_observed_turn AS "firstObservedTurn"
    FROM campaign_cast_characters WHERE campaign_id=$1 AND owner_user_id=$2 AND first_observed_turn <= $3 ORDER BY created_at,id`,
    [source.campaignId, source.ownerUserId, throughTurn])).rows;
  const characterIds = new Map<string, string>(people.map((person) => [person.id, randomUUID()]));
  // A transfer's raw turn copies alone are insufficient: cast hashes and
  // revisions refer to effective narration, including retained corrections.
  for (const [sourceTurnId, targetTurnId] of turnIds) {
    await client.query(`INSERT INTO turn_narration_corrections(owner_user_id,campaign_id,turn_id,revision,narration,
      previous_effective_narration_hash,reason,source,created_by_user_id,created_at)
      SELECT $1,$2,$3,correction.revision,correction.narration,correction.previous_effective_narration_hash,
        correction.reason,correction.source,$1,correction.created_at
      FROM turn_narration_corrections correction WHERE correction.owner_user_id=$4 AND correction.campaign_id=$5 AND correction.turn_id=$6
        AND NOT EXISTS(SELECT 1 FROM turn_narration_corrections existing WHERE existing.turn_id=$3 AND existing.revision=correction.revision)
      ORDER BY correction.revision`, [destination.ownerUserId, destination.campaignId, targetTurnId,
      source.ownerUserId, source.campaignId, sourceTurnId]);
  }
  const events = (await client.query("SELECT * FROM campaign_cast_events WHERE campaign_id=$1 AND owner_user_id=$2 ORDER BY sequence", [source.campaignId, source.ownerUserId])).rows;
  const observations = (await client.query("SELECT * FROM campaign_cast_observations WHERE campaign_id=$1 AND owner_user_id=$2 ORDER BY sequence", [source.campaignId, source.ownerUserId])).rows
    .filter((row) => characterIds.has(row.character_id) && (!row.source_turn_id || turnIds.has(row.source_turn_id))
      && (!row.speaker_character_id || characterIds.has(row.speaker_character_id)));
  const observationIds = new Map(observations.map((row) => [row.id, randomUUID()]));
  const eventIds = new Map(events.map((row) => [row.id, randomUUID()]));
  const remap = (value: any, key = ""): any => {
    if (["profile", "campaignProfile", "set"].includes(key)) return value;
    if (crossWorld && value?.kind === "world" && key === "evidence")
      return { kind: "historical_world", sourceWorldVersionId: value.worldVersionId, sourcePath: value.sourcePath };
    if (crossWorld && value?.kind === "world" && key === "origin")
      return { kind: "historical_world", sourceWorldVersionId: value.worldVersionId, entityId: value.entityId };
    if (key === "evidence" && value?.kind === "turn" && (value.invalidated || !turnIds.has(value.turnId))) return { ...value, invalidated: true };
    if (Array.isArray(value)) return value.map((item) => remap(item, key === "characterIds" ? "characterId" : key === "observationIds" ? "observationId" : key));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, remap(item, name)]));
    if (typeof value !== "string") return value;
    const mapping = ["characterId", "speakerCharacterId"].includes(key) ? characterIds
      : ["observationId", "supersedesObservationId"].includes(key) ? observationIds
      : ["eventId", "editId", "seedEventId"].includes(key) ? eventIds : key === "turnId" ? turnIds : null;
    if (!mapping) return value;
    const mapped = mapping.get(value);
    if (!mapped) throw new Error(`Invalid retained cast reference: ${key}`);
    return mapped;
  };
  // Inherit forward enrollment, never operational jobs or an assertion that copied history was scanned.
  await client.query("INSERT INTO campaign_cast_state(owner_user_id,campaign_id,revision,coverage_start_turn) VALUES($1,$2,$3,$4)",
    [destination.ownerUserId, destination.campaignId, state.revision, state.coverage_start_turn === null ? null : throughTurn + 1]);
  for (const person of people) {
    let origin = castOriginSchema.parse(remap(person.origin, "origin"));
    if (origin.kind === "protagonist") {
      const row = (await client.query("SELECT selected_character_id FROM campaigns WHERE id=$1 AND owner_user_id=$2", [destination.campaignId, destination.ownerUserId])).rows[0];
      origin = { kind: "protagonist", selectedCharacterId: row.selected_character_id };
    }
    await client.query("INSERT INTO campaign_cast_characters(id,owner_user_id,campaign_id,origin,first_observed_turn) VALUES($1,$2,$3,$4,$5)",
      [characterIds.get(person.id), destination.ownerUserId, destination.campaignId, JSON.stringify(origin), person.firstObservedTurn]);
  }
  const copiedEvents = new Set<string>();
  const copyableAttachments = new Set(events.filter((event) => event.attachment
    && event.attachment.sourceRanges.every((range: { turnId: string }) => turnIds.has(range.turnId))
    && event.attachment.observationIds.every((id: string) => observationIds.has(id))).map((event) => event.id));
  for (const event of events) {
    const payload = event.payload.filter((item: { command: unknown; characterId?: string; observationId?: string }) => {
      const command = castCommandSchema.parse(item.command);
      if (command.kind === "create") return characterIds.has(item.characterId!);
      if (command.kind === "observe") return observationIds.has(item.observationId!);
      if (command.kind === "mention") return characterIds.has(command.characterId) && turnIds.has(command.evidence.turnId);
      if (command.kind === "seed_profile") return characterIds.has(command.characterId) && (event.effective_turn_number <= throughTurn
        || event.payload.some((entry: { command: { kind: string }; characterId?: string }) => entry.command.kind === "create" && entry.characterId === command.characterId));
      if (command.kind === "detach") return event.effective_turn_number <= throughTurn && characterIds.has(command.characterId) && copyableAttachments.has(command.eventId);
      return event.effective_turn_number <= throughTurn && characterIds.has(command.characterId);
    });
    if (!payload.length) continue;
    if (payload.some((item: { command: { kind: string; eventId?: string } }) => item.command.kind === "detach" && !copiedEvents.has(item.command.eventId!)))
      throw new Error("Invalid retained cast detach reference.");
    const attachment = copyableAttachments.has(event.id) ? remap(event.attachment) : null;
    const receipt = castBatchReceiptSchema.parse(event.receipt);
    if (event.effective_turn_number > throughTurn || payload.length !== event.payload.length) delete receipt.result;
    else if (receipt.result) receipt.result.character.id = characterIds.get(receipt.result.character.id)!;
    receipt.characterIds = receipt.characterIds.filter((id) => characterIds.has(id));
    receipt.observationIds = receipt.observationIds.filter((id) => observationIds.has(id));
    const mapped = remap(payload);
    await client.query(`INSERT INTO campaign_cast_events(id,owner_user_id,campaign_id,effective_turn_number,timeline_revision,idempotency_key,request_hash,payload,receipt,attachment)
      VALUES($1,$2,$3,$4,0,$5,$6,$7,$8,$9)`, [eventIds.get(event.id), destination.ownerUserId, destination.campaignId,
      Math.min(event.effective_turn_number, throughTurn), `copy:${eventIds.get(event.id)}`, sha256(stableStringify(mapped)), JSON.stringify(mapped), JSON.stringify(remap(receipt)), attachment ? JSON.stringify(attachment) : null]);
    copiedEvents.add(event.id);
  }
  for (const row of observations) {
    if (!copiedEvents.has(row.event_id)) continue;
    await client.query(`INSERT INTO campaign_cast_observations(id,owner_user_id,campaign_id,character_id,event_id,field,value,mode,speaker_character_id,evidence,supersedes_observation_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [observationIds.get(row.id), destination.ownerUserId, destination.campaignId,
      characterIds.get(row.character_id), eventIds.get(row.event_id), row.field, row.value, row.mode,
      row.speaker_character_id ? characterIds.get(row.speaker_character_id) : null, JSON.stringify(remap(row.evidence, "evidence")),
      row.supersedes_observation_id ? observationIds.get(row.supersedes_observation_id) : null]);
  }
  await rebuildCastWithClient(client, destination);
}
