import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  castBatchSchema, castBatchReceiptSchema, castBoundarySchema, castCharacterSchema,
  castCommandSchema, castObservationSchema, castOriginSchema, castScopeSchema, castSnapshotSchema,
  type CastBatch, type CastBatchReceipt, type CastBoundary, type CastCharacter, type CastCommand,
  type CastDetail, type CastEvidence, type CastObservation, type CastOverride, type CastProfile, type CastScope, type CastSnapshot
} from "../../contracts/src/campaign-cast.js";
import { createCastCharacterSchema, editCastCharacterSchema, type CreateCastCharacter, type EditCastCharacter, type CastWriteResult } from "../../contracts/src/campaign-cast.js";
import { CampaignCastError, type CampaignCastRepositoryPort, type CampaignCastWritePort } from "../../application/src/campaign-cast/index.js";
import { castEvidenceOrder, projectCastProfile, validateCastFiction } from "../../domain/src/campaign-cast.js";
import { characterFictionAuthority } from "../../domain/src/character-fiction-authority.js";
import { sha256, stableStringify, truncateAtBoundary } from "../../domain/src/text.js";
import { withTransaction, type DatabaseClient, type DatabasePool } from "./pool.js";

const ordinal = z.number().int().nonnegative();
const campaignSchema = z.object({ active_turn_number: ordinal, world_version_id: z.uuid(),
  selected_character_id: z.string().nullable(), character_profile: z.unknown(), character_snapshot: z.unknown() });
type Campaign = z.infer<typeof campaignSchema>;
const stateSchema = z.object({ revision: ordinal, timeline_revision: ordinal });
type State = z.infer<typeof stateSchema>;
const storedCommandSchema = z.object({ command: castCommandSchema, characterId: z.uuid().optional(), observationId: z.uuid().optional() }).strict();
type StoredCommand = z.infer<typeof storedCommandSchema>;
const eventSchema = z.object({ id: z.uuid(), effective_turn_number: ordinal,
  payload: z.array(storedCommandSchema), receipt: castBatchReceiptSchema });
const characterRowSchema = z.object({ id: z.uuid(), origin: castOriginSchema, first_observed_turn: ordinal });

async function lockCampaign(client: DatabaseClient, scope: CastScope): Promise<Campaign> {
  const result = await client.query(`SELECT active_turn_number,world_version_id,selected_character_id,character_profile,character_snapshot
    FROM campaigns WHERE id=$1 AND owner_user_id=$2 FOR UPDATE`, [scope.campaignId, scope.ownerUserId]);
  if (!result.rows[0]) throw new CampaignCastError("cast_not_found");
  return campaignSchema.parse(result.rows[0]);
}

async function readState(client: DatabaseClient, scope: CastScope): Promise<State | null> {
  const result = await client.query("SELECT revision,timeline_revision FROM campaign_cast_state WHERE campaign_id=$1 AND owner_user_id=$2", [scope.campaignId, scope.ownerUserId]);
  return result.rows[0] ? stateSchema.parse(result.rows[0]) : null;
}

async function initialize(client: DatabaseClient, scope: CastScope, campaign: Campaign): Promise<State> {
  await client.query("INSERT INTO campaign_cast_state(owner_user_id,campaign_id) VALUES($1,$2) ON CONFLICT(campaign_id) DO NOTHING", [scope.ownerUserId, scope.campaignId]);
  await client.query(`INSERT INTO campaign_cast_characters(owner_user_id,campaign_id,origin,first_observed_turn)
    VALUES($1,$2,$3,0) ON CONFLICT(campaign_id) WHERE origin->>'kind'='protagonist' DO NOTHING`,
  [scope.ownerUserId, scope.campaignId, JSON.stringify({ kind: "protagonist", selectedCharacterId: campaign.selected_character_id })]);
  return (await readState(client, scope))!;
}

function assertBoundary(campaign: Campaign, state: State | null, boundary: CastBoundary, writing = false): void {
  if (boundary.timelineRevision !== (state?.timeline_revision ?? 0) || boundary.turnNumber > campaign.active_turn_number
    || (writing && boundary.turnNumber !== campaign.active_turn_number)) throw new Error("Cast boundary changed.");
}

async function evidenceIsCurrent(client: DatabaseClient, scope: CastScope, campaign: Campaign, evidence: CastEvidence): Promise<boolean> {
  if (evidence.kind === "user") return false;
  if (evidence.kind === "historical_world") return true;
  if (evidence.kind === "turn") {
    if (evidence.invalidated) return false;
    const result = await client.query(`SELECT turn_number,correction_revision,effective_narration FROM effective_turn_narrations
      WHERE turn_id=$1 AND campaign_id=$2 AND owner_user_id=$3`, [evidence.turnId, scope.campaignId, scope.ownerUserId]);
    const row = result.rows[0];
    return Boolean(row && row.turn_number === evidence.turnNumber && row.turn_number <= campaign.active_turn_number
      && row.correction_revision === evidence.narrationRevision && sha256(row.effective_narration) === evidence.sourceHash
      && row.effective_narration.includes(evidence.quote));
  }
  // Retained evidence can refer to an earlier immutable version after transfer.
  // New observations are restricted to the pinned version at the write boundary.
  const result = await client.query("SELECT content FROM world_versions WHERE id=$1 AND owner_user_id=$2", [evidence.worldVersionId, scope.ownerUserId]);
  let value: unknown = result.rows[0]?.content;
  for (const key of evidence.sourcePath.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return false;
    value = (value as Record<string, unknown>)[key];
  }
  return value !== undefined && value !== null;
}

function protagonistProfile(campaign: Campaign): { name: string; aliases: string[]; profile: CastProfile } {
  const authority = characterFictionAuthority(campaign.character_profile, campaign.character_snapshot);
  const profile: CastProfile = {};
  if (authority.profile) {
    const source = authority.profile;
    const fields = ["role", "background", "personality", "motivations", "goals", "voiceAndMannerisms"] as const;
    for (const field of fields) if (source.story[field]) profile[`story.${field}`] = truncateAtBoundary(source.story[field], 2000);
    if (source.identity.pronouns) profile["identity.pronouns"] = truncateAtBoundary(source.identity.pronouns, 2000);
    const appearance = Object.values(source.appearance).flat().filter(Boolean).join("; ");
    if (appearance) profile["appearance.description"] = truncateAtBoundary(appearance, 2000);
  }
  return { name: truncateAtBoundary(authority.name || "Main character", 200),
    aliases: (authority.profile?.identity.aliases ?? []).slice(0, 20).map((alias) => truncateAtBoundary(alias, 200)), profile };
}

/** Always projects retained authority. A cached profile never hides a corrected source. */
async function snapshot(client: DatabaseClient, scope: CastScope, campaign: Campaign, state: State | null, boundary: CastBoundary): Promise<CastSnapshot> {
  assertBoundary(campaign, state, boundary);
  const characterRows = (await client.query("SELECT id,origin,first_observed_turn FROM campaign_cast_characters WHERE campaign_id=$1 AND owner_user_id=$2 ORDER BY created_at,id", [scope.campaignId, scope.ownerUserId])).rows.map((row) => characterRowSchema.parse(row));
  const events = (await client.query("SELECT id,effective_turn_number,payload,receipt FROM campaign_cast_events WHERE campaign_id=$1 AND owner_user_id=$2 ORDER BY sequence", [scope.campaignId, scope.ownerUserId])).rows.map((row) => eventSchema.parse(row));
  const observations = (await client.query(`SELECT id,character_id AS "characterId",field,value,mode,
    speaker_character_id AS "speakerCharacterId",evidence,supersedes_observation_id AS "supersedesObservationId"
    FROM campaign_cast_observations WHERE campaign_id=$1 AND owner_user_id=$2 ORDER BY sequence`, [scope.campaignId, scope.ownerUserId])).rows.map((row) => castObservationSchema.parse(row));
  const current: CastObservation[] = [];
  for (const observation of observations) {
    if (castEvidenceOrder(observation.evidence)[0] <= boundary.turnNumber && await evidenceIsCurrent(client, scope, campaign, observation.evidence)) current.push(observation);
  }
  // A correction invalidates a dependent supersession chain, not user edits.
  const validIds = new Set(current.map((observation) => observation.id));
  for (let changed = true; changed;) {
    changed = false;
    for (const observation of current) if (validIds.has(observation.id) && observation.supersedesObservationId && !validIds.has(observation.supersedesObservationId)) {
      validIds.delete(observation.id); changed = true;
    }
  }
  const people = new Map<string, CastCharacter>();
  const overrides = new Map<string, Map<string, CastOverride>>();
  for (const row of characterRows) {
    if (row.origin.kind !== "protagonist") continue;
    people.set(row.id, { id: row.id, origin: row.origin, ...protagonistProfile(campaign), pinned: false, ignored: false,
      revision: 0, firstObservedTurn: 0, lastObservedTurn: 0 });
  }
  for (const event of events) for (const stored of event.payload) {
    const command = stored.command;
    if (command.kind === "observe") continue;
    if (command.kind === "create") {
      const evidence = command.evidence;
      const row = characterRows.find((row) => row.id === stored.characterId);
      if (!row || row.origin.kind === "protagonist") throw new Error("Invalid persisted cast identity.");
      let firstTurn = row.first_observed_turn;
      if (evidence && !await evidenceIsCurrent(client, scope, campaign, evidence)) {
        // A later explicit correction or fresh observation can independently
        // retain the same identity. Do not resurrect the invalid earlier source.
        const supportingTurns = current.filter((item) => item.characterId === row.id && validIds.has(item.id))
          .map((item) => castEvidenceOrder(item.evidence)[0]);
        for (const edit of events) if (edit.effective_turn_number <= boundary.turnNumber && edit.payload.some((item) =>
          item.command.kind !== "create" && item.command.kind !== "observe" && item.command.characterId === row.id)) supportingTurns.push(edit.effective_turn_number);
        if (!supportingTurns.length) continue;
        firstTurn = Math.min(...supportingTurns);
      }
      if (firstTurn > boundary.turnNumber) continue;
      people.set(row.id, castCharacterSchema.parse({ id: row.id, name: command.name, aliases: command.aliases,
        origin: row.origin, profile: {}, pinned: false, ignored: false, revision: 1, firstObservedTurn: firstTurn, lastObservedTurn: firstTurn }));
      continue;
    }
    if (event.effective_turn_number > boundary.turnNumber) continue;
    const person = people.get(command.characterId);
    if (!person) continue;
    const fields = overrides.get(person.id) ?? new Map<string, CastOverride>();
    if (command.kind === "override") fields.set(command.field, { field: command.field, value: command.value,
      evidence: { kind: "user", editId: event.id, effectiveTurnNumber: event.effective_turn_number } });
    if (command.kind === "clear_override") fields.delete(command.field);
    if (command.kind === "identity") { person.name = command.name; person.aliases = command.aliases; }
    if (command.kind === "pin") person.pinned = command.value;
    if (command.kind === "ignore") person.ignored = command.value;
    overrides.set(person.id, fields);
    person.revision++;
  }
  for (const person of people.values()) {
    if (person.origin.kind === "protagonist") continue;
    const own = current.filter((observation) => observation.characterId === person.id && validIds.has(observation.id));
    person.profile = projectCastProfile({ observations: own, overrides: [...(overrides.get(person.id)?.values() ?? [])] });
    person.lastObservedTurn = Math.max(person.firstObservedTurn, ...own.map((observation) => castEvidenceOrder(observation.evidence)[0]));
    person.revision += own.length;
    validateCastFiction(person.name);
    person.aliases.forEach(validateCastFiction);
  }
  return castSnapshotSchema.parse({ revision: state?.revision ?? 0, boundary, characters: [...people.values()],
    trackedThroughTurn: 0, coverageStartTurn: 0, discoveryStatus: "off" });
}

async function cacheSnapshot(client: DatabaseClient, scope: CastScope, value: CastSnapshot): Promise<void> {
  await client.query("DELETE FROM campaign_cast_profiles WHERE campaign_id=$1 AND owner_user_id=$2", [scope.campaignId, scope.ownerUserId]);
  for (const person of value.characters) if (person.origin.kind !== "protagonist") {
    await client.query(`INSERT INTO campaign_cast_profiles(owner_user_id,campaign_id,character_id,revision,profile)
      VALUES($1,$2,$3,$4,$5)`, [scope.ownerUserId, scope.campaignId, person.id, value.revision, JSON.stringify(person.profile)]);
  }
}

/** Lifecycle callers already own a transaction; never open a nested pool transaction. */
export async function rebuildCastWithClient(client: DatabaseClient, scope: CastScope, turnNumber?: number): Promise<CastSnapshot> {
  const campaign = await lockCampaign(client, scope), state = await readState(client, scope);
  const value = await snapshot(client, scope, campaign, state,
    { turnNumber: turnNumber ?? campaign.active_turn_number, timelineRevision: state?.timeline_revision ?? 0 });
  if (turnNumber === undefined) await cacheSnapshot(client, scope, value);
  return value;
}

async function assertSupportingCharacter(client: DatabaseClient, scope: CastScope, id: string): Promise<void> {
  const result = await client.query("SELECT origin FROM campaign_cast_characters WHERE id=$1 AND campaign_id=$2 AND owner_user_id=$3", [id, scope.campaignId, scope.ownerUserId]);
  if (!result.rows[0]) throw new Error("Cast character not found.");
  if (castOriginSchema.parse(result.rows[0].origin).kind === "protagonist") throw new Error("Use the existing protagonist profile authority.");
}

async function applyCommand(client: DatabaseClient, scope: CastScope, campaign: Campaign, eventId: string, boundary: CastBoundary, stored: StoredCommand): Promise<void> {
  const command = stored.command;
  if (command.kind === "create") {
    if (command.origin.kind === "historical_world" || command.evidence?.kind === "historical_world") throw new Error("Historical provenance is import-only.");
    if (command.origin.kind === "protagonist") throw new Error("Protagonist identity is initialized by the server.");
    validateCastFiction(command.name); command.aliases.forEach(validateCastFiction);
    if (command.origin.kind === "manual" && command.evidence) throw new Error("Manual identity evidence is the server event.");
    if (command.origin.kind === "discovered" && command.evidence?.kind !== "turn") throw new Error("Discovered identity requires accepted turn evidence.");
    if (command.origin.kind !== "manual" && (!command.evidence || !await evidenceIsCurrent(client, scope, campaign, command.evidence))) throw new Error("Invalid cast identity evidence.");
    if (command.origin.kind === "world") {
      if (command.origin.worldVersionId !== campaign.world_version_id) throw new Error("Invalid cast world origin.");
      const world = (await client.query("SELECT content FROM world_versions WHERE id=$1 AND owner_user_id=$2", [campaign.world_version_id, scope.ownerUserId])).rows[0]?.content;
      if (!Array.isArray(world?.entities) || !world.entities.some((item: Record<string, unknown>) => (item?.id ?? item?.key) === (command.origin.kind === "world" ? command.origin.entityId : null))) throw new Error("World identity not found.");
    }
    const first = command.evidence?.kind === "turn" ? command.evidence.turnNumber : boundary.turnNumber;
    await client.query("INSERT INTO campaign_cast_characters(id,owner_user_id,campaign_id,origin,first_observed_turn) VALUES($1,$2,$3,$4,$5)",
      [stored.characterId, scope.ownerUserId, scope.campaignId, JSON.stringify(command.origin), first]);
    return;
  }
  await assertSupportingCharacter(client, scope, command.characterId);
  if (command.kind === "identity") { validateCastFiction(command.name); command.aliases.forEach(validateCastFiction); }
  if (command.kind === "override") validateCastFiction(command.value);
  if (command.kind !== "observe") return;
  if (command.evidence.kind === "historical_world") throw new Error("Historical provenance is import-only.");
  validateCastFiction(command.value);
  if (command.evidence.kind === "world" && command.evidence.worldVersionId !== campaign.world_version_id) throw new Error("Invalid cast world evidence.");
  if (!await evidenceIsCurrent(client, scope, campaign, command.evidence)) throw new Error("Invalid or stale cast observation evidence.");
  if (command.speakerCharacterId) {
    const speaker = await client.query("SELECT id FROM campaign_cast_characters WHERE id=$1 AND campaign_id=$2 AND owner_user_id=$3", [command.speakerCharacterId, scope.campaignId, scope.ownerUserId]);
    if (!speaker.rows[0]) throw new Error("Cast speaker not found.");
  }
  const existing = (await client.query(`SELECT id,character_id AS "characterId",field,value,mode,speaker_character_id AS "speakerCharacterId",
    evidence,supersedes_observation_id AS "supersedesObservationId" FROM campaign_cast_observations
    WHERE character_id=$1 AND campaign_id=$2 AND owner_user_id=$3 ORDER BY sequence`, [command.characterId, scope.campaignId, scope.ownerUserId])).rows.map((row) => castObservationSchema.parse(row));
  const { kind: _kind, ...fields } = command;
  const observation = castObservationSchema.parse({ ...fields, id: stored.observationId });
  if (observation.supersedesObservationId) {
    const prior = existing.find((item) => item.id === observation.supersedesObservationId);
    if (!prior || !await evidenceIsCurrent(client, scope, campaign, prior.evidence)) throw new Error("Invalid cast supersession evidence.");
  }
  projectCastProfile({ observations: [...existing, observation], overrides: [] });
  await client.query(`INSERT INTO campaign_cast_observations(id,owner_user_id,campaign_id,character_id,event_id,field,value,mode,speaker_character_id,evidence,supersedes_observation_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [observation.id, scope.ownerUserId, scope.campaignId, observation.characterId,
    eventId, observation.field, observation.value, observation.mode, observation.speakerCharacterId, JSON.stringify(observation.evidence), observation.supersedesObservationId]);
}

async function persistBatch(client: DatabaseClient, scope: CastScope, campaign: Campaign, state: State,
  batch: CastBatch, requestHash: string, publicCharacterId?: string): Promise<CastBatchReceipt> {
  const payload: StoredCommand[] = batch.commands.map((command) => ({ command,
    ...(command.kind === "create" ? { characterId: publicCharacterId ?? randomUUID() } : {}),
    ...(command.kind === "observe" ? { observationId: randomUUID() } : {}) }));
  const receipt: CastBatchReceipt = { eventId: randomUUID(), revision: state.revision + 1,
    characterIds: payload.flatMap((item) => item.characterId ? [item.characterId] : []),
    observationIds: payload.flatMap((item) => item.observationId ? [item.observationId] : []) };
  await client.query(`INSERT INTO campaign_cast_events(id,owner_user_id,campaign_id,effective_turn_number,timeline_revision,idempotency_key,request_hash,payload,receipt)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [receipt.eventId, scope.ownerUserId, scope.campaignId, batch.boundary.turnNumber,
    batch.boundary.timelineRevision, batch.idempotencyKey, requestHash, JSON.stringify(payload), JSON.stringify(receipt)]);
  for (const stored of payload) await applyCommand(client, scope, campaign, receipt.eventId, batch.boundary, stored);
  await client.query("UPDATE campaign_cast_state SET revision=$3 WHERE campaign_id=$1 AND owner_user_id=$2", [scope.campaignId, scope.ownerUserId, receipt.revision]);
  const value = await snapshot(client, scope, campaign, { ...state, revision: receipt.revision }, batch.boundary);
  await cacheSnapshot(client, scope, value);
  if (publicCharacterId) {
    receipt.result = { character: value.characters.find((person) => person.id === publicCharacterId)!, revision: value.revision, boundary: value.boundary };
    await client.query("UPDATE campaign_cast_events SET receipt=$2 WHERE id=$1", [receipt.eventId, JSON.stringify(receipt)]);
  }
  return receipt;
}

/** Discovery publication and its receipt share the caller's transaction. */
export async function applyCastBatchWithClient(client: DatabaseClient, rawScope: CastScope, rawBatch: CastBatch): Promise<CastBatchReceipt> {
  const scope = castScopeSchema.parse(rawScope), batch = castBatchSchema.parse(rawBatch);
  const campaign = await lockCampaign(client, scope);
  const state = await initialize(client, scope, campaign);
  const requestHash = sha256(stableStringify(batch));
  const prior = (await client.query("SELECT request_hash,receipt FROM campaign_cast_events WHERE campaign_id=$1 AND owner_user_id=$2 AND idempotency_key=$3", [scope.campaignId, scope.ownerUserId, batch.idempotencyKey])).rows[0];
  if (prior) {
    if (prior.request_hash !== requestHash) throw new Error("Cast idempotency key reused with different content.");
    return castBatchReceiptSchema.parse(prior.receipt);
  }
  assertBoundary(campaign, state, batch.boundary, true);
  return persistBatch(client, scope, campaign, state, batch, requestHash);
}

export function createPostgresCampaignCastRepository(pool: DatabasePool, options: { editingEnabled?: boolean } = {}): CampaignCastRepositoryPort & CampaignCastWritePort {
  async function write(rawScope: CastScope, characterId: string | null, raw: CreateCastCharacter | EditCastCharacter): Promise<CastWriteResult> {
    const scope = castScopeSchema.parse(rawScope);
    const request = characterId ? editCastCharacterSchema.parse(raw) : createCastCharacterSchema.parse(raw);
    return withTransaction(pool, async (client) => {
      const campaign = await lockCampaign(client, scope);
      if (!options.editingEnabled) throw new CampaignCastError("cast_editing_disabled");
      const state = await initialize(client, scope, campaign);
      const requestHash = sha256(stableStringify({ characterId, request }));
      const prior = (await client.query("SELECT request_hash,receipt FROM campaign_cast_events WHERE campaign_id=$1 AND owner_user_id=$2 AND idempotency_key=$3", [scope.campaignId, scope.ownerUserId, request.idempotencyKey])).rows[0];
      if (prior) {
        if (prior.request_hash !== requestHash) throw new CampaignCastError("cast_idempotency_conflict");
        const receipt = castBatchReceiptSchema.parse(prior.receipt);
        if (!receipt.result) throw new CampaignCastError("cast_idempotency_conflict");
        return receipt.result;
      }
      if (state.revision !== request.expectedCastRevision || state.timeline_revision !== request.expectedBoundary.timelineRevision
        || campaign.active_turn_number !== request.expectedBoundary.turnNumber) throw new CampaignCastError("cast_revision_conflict");
      const active = await client.query(`SELECT id FROM generation_jobs WHERE campaign_id=$1 AND owner_user_id=$2
        AND status IN ('queued','replacement_queued','assessing','generating','validating','committing','recoverable') LIMIT 1`, [scope.campaignId, scope.ownerUserId]);
      if (active.rows.length) throw new CampaignCastError("cast_generation_active");
      const commands: CastCommand[] = [];
      const targetId = characterId ?? randomUUID();
      if (characterId) {
        const edit = request as EditCastCharacter;
        const current = await snapshot(client, scope, campaign, state, request.expectedBoundary);
        const person = current.characters.find((person) => person.id === characterId);
        if (!person) throw new CampaignCastError("cast_not_found");
        if (person.origin.kind === "protagonist") throw new CampaignCastError("cast_protagonist_read_only");
        if (person.revision !== edit.expectedCharacterRevision) throw new CampaignCastError("cast_revision_conflict");
        if (edit.name !== undefined || edit.aliases !== undefined) commands.push({ kind: "identity", characterId, name: edit.name ?? person.name, aliases: edit.aliases ?? person.aliases });
        for (const field of edit.clearOverrides ?? []) commands.push({ kind: "clear_override", characterId, field });
        if (edit.pinned !== undefined) commands.push({ kind: "pin", characterId, value: edit.pinned });
        if (edit.ignored !== undefined) commands.push({ kind: "ignore", characterId, value: edit.ignored });
      } else {
        const create = request as CreateCastCharacter;
        commands.push({ kind: "create", name: create.name, aliases: create.aliases, origin: { kind: "manual" } });
      }
      for (const [field, value] of Object.entries(characterId ? (request as EditCastCharacter).setOverrides ?? {} : (request as CreateCastCharacter).profile)) {
        commands.push(castCommandSchema.parse({ kind: "override", characterId: targetId, field, value }));
      }
      try {
        for (const command of commands) {
          if (command.kind === "create" || command.kind === "identity") { validateCastFiction(command.name); command.aliases.forEach(validateCastFiction); }
          if (command.kind === "override") validateCastFiction(command.value);
        }
      } catch { throw new CampaignCastError("cast_invalid_request"); }
      return (await persistBatch(client, scope, campaign, state, { boundary: request.expectedBoundary,
        idempotencyKey: request.idempotencyKey, commands }, requestHash, targetId)).result!;
    });
  }
  return {
    create: (scope, request) => write(scope, null, request),
    edit: (scope, id, request) => write(scope, z.uuid().parse(id), request),
    async current(rawScope) {
      const scope = castScopeSchema.parse(rawScope);
      return withTransaction(pool, async (client) => {
        const campaign = await lockCampaign(client, scope), state = await initialize(client, scope, campaign);
        return snapshot(client, scope, campaign, state, { turnNumber: campaign.active_turn_number, timelineRevision: state.timeline_revision });
      });
    },
    async detail(rawScope, rawId) {
      const scope = castScopeSchema.parse(rawScope), id = z.uuid().parse(rawId);
      return withTransaction(pool, async (client) => {
        const campaign = await lockCampaign(client, scope), state = await initialize(client, scope, campaign);
        const boundary = { turnNumber: campaign.active_turn_number, timelineRevision: state.timeline_revision };
        const value = await snapshot(client, scope, campaign, state, boundary);
        const character = value.characters.find((person) => person.id === id);
        if (!character) throw new CampaignCastError("cast_not_found");
        const observations = (await client.query(`SELECT id,character_id AS "characterId",field,value,mode,
          speaker_character_id AS "speakerCharacterId",evidence,supersedes_observation_id AS "supersedesObservationId"
          FROM campaign_cast_observations WHERE campaign_id=$1 AND owner_user_id=$2 AND character_id=$3 ORDER BY sequence`, [scope.campaignId, scope.ownerUserId, id])).rows.map((row) => castObservationSchema.parse(row));
        const overrides = new Map<string, CastOverride>();
        const identityEvents: CastDetail["identityEvents"] = [];
        const events = (await client.query("SELECT id,effective_turn_number,payload,receipt FROM campaign_cast_events WHERE campaign_id=$1 AND owner_user_id=$2 AND effective_turn_number <= $3 ORDER BY sequence", [scope.campaignId, scope.ownerUserId, boundary.turnNumber])).rows.map((row) => eventSchema.parse(row));
        for (const event of events) for (const { command, characterId } of event.payload) {
          if (command.kind === "create" && characterId === id || command.kind === "identity" && command.characterId === id) {
            identityEvents.push({ eventId: event.id, effectiveTurnNumber: event.effective_turn_number,
              name: command.name, aliases: command.aliases,
              evidence: command.kind === "create" && command.evidence ? command.evidence
                : { kind: "user", editId: event.id, effectiveTurnNumber: event.effective_turn_number } });
          }
          if (command.kind === "override" && command.characterId === id) overrides.set(command.field, { field: command.field, value: command.value, evidence: { kind: "user", editId: event.id, effectiveTurnNumber: event.effective_turn_number } });
          if (command.kind === "clear_override" && command.characterId === id) overrides.delete(command.field);
        }
        return { character, revision: value.revision, boundary, observations, overrides: [...overrides.values()], identityEvents, unresolvedCandidateIds: [],
          editorDestination: character.origin.kind === "protagonist" ? `/api/v1/campaigns/${scope.campaignId}/character-profile` : null };
      });
    },
    async initialize(rawScope) {
      const scope = castScopeSchema.parse(rawScope);
      return withTransaction(pool, async (client) => {
        const campaign = await lockCampaign(client, scope);
        const state = await initialize(client, scope, campaign);
        return snapshot(client, scope, campaign, state, { turnNumber: campaign.active_turn_number, timelineRevision: state.timeline_revision });
      });
    },
    async loadSnapshot(rawScope, rawBoundary) {
      const scope = castScopeSchema.parse(rawScope), boundary = castBoundarySchema.parse(rawBoundary);
      return withTransaction(pool, async (client) => snapshot(client, scope, await lockCampaign(client, scope), await readState(client, scope), boundary));
    },
    async rebuild(rawScope) {
      const scope = castScopeSchema.parse(rawScope);
      return withTransaction(pool, async (client) => {
        const campaign = await lockCampaign(client, scope);
        const state = await readState(client, scope);
        const value = await snapshot(client, scope, campaign, state, { turnNumber: campaign.active_turn_number, timelineRevision: state?.timeline_revision ?? 0 });
        await cacheSnapshot(client, scope, value);
        return value;
      });
    },
    async applyBatch(rawScope, rawBatch) {
      return withTransaction(pool, (client) => applyCastBatchWithClient(client, rawScope, rawBatch));
    }
  };
}
