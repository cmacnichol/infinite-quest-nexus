import { editAuthoredCastProfileSchema, castFromWorldPreviewQuerySchema, castFromWorldSchema, type EditAuthoredCastProfile, type CastFromWorld, type CastFromWorldPreviewQuery, type CastFromWorldPreview } from "../../contracts/src/campaign-cast-authored.js";
import { detachCastAttachmentSchema } from "../../contracts/src/campaign-cast.js";
import { resolveCastContextGoal } from "../../domain/src/campaign-cast-context.js";
import { buildCastDiscoverySource } from "../../domain/src/campaign-cast-discovery.js";
import { castRangesOverlap, projectCastAttachments } from "../../domain/src/campaign-cast-attachments.js";
import { randomUUID } from "node:crypto";
import { refreshCastChronicleMetadata } from "./campaign-cast-chronicle-metadata.js";
import { castGenerationSnapshotSchema, castGenerationSnapshotFingerprint, type CastGenerationSnapshot } from "../../contracts/src/campaign-cast-context.js";
import { readCastDiscoveryStatus } from "./campaign-cast-status-repository.js";
import { pendingCastDetailSql } from "./campaign-cast-review-sql.js";
import { createCastCandidateRepository } from "./campaign-cast-candidate-repository.js";
import { z } from "zod";
import {
  castBatchSchema, castBatchReceiptSchema, castBoundarySchema, castCharacterSchema,
  castAuthoredPathSchema, castCommandSchema, castAttachmentSchema, castObservationSchema, castOriginSchema, castScopeSchema, castSnapshotSchema,
  type CastBatch, type CastBatchReceipt, type CastBoundary, type CastCharacter, type CastCommand,
  type CastDetail, type CastEvidence, type CastObservation, type CastOverride, type CastProfile, type CastScope, type CastSnapshot
} from "../../contracts/src/campaign-cast.js";
import { createCastCharacterSchema, editCastCharacterSchema, type CreateCastCharacter, type EditCastCharacter, type CastWriteResult } from "../../contracts/src/campaign-cast.js";
import { CampaignCastError, type CampaignCastRepositoryPort, type CampaignCastWritePort } from "../../application/src/campaign-cast/index.js";
import { castEvidenceOrder, isSeededFixedCandidateHidden, projectCastProfile, resolveSeededCastProfile, validateCastFiction } from "../../domain/src/campaign-cast.js";
import { characterProfileSchema, worldContentSchema } from "../../contracts/src/world-library.js";
import { characterFictionAuthority, projectCastFictionText } from "../../domain/src/character-fiction-authority.js";
import { normalizeEntityTerm } from "../../domain/src/entity-references.js";
import { buildScopedEntityCatalog } from "../../domain/src/entity-references.js";
import { castDiscoveryWorldIdentities } from "../../domain/src/campaign-cast-world-identities.js";
import { sha256, stableStringify, truncateAtBoundary } from "../../domain/src/text.js";
import { withTransaction, type DatabaseClient, type DatabasePool } from "./pool.js";

const ordinal = z.number().int().nonnegative();
const campaignSchema = z.object({ active_turn_number: ordinal, world_version_id: z.uuid(),
  selected_character_id: z.string().nullable(), selected_character_world_id: z.uuid().nullable(), character_profile: z.unknown(), character_snapshot: z.unknown() });
type Campaign = z.infer<typeof campaignSchema>;
const stateSchema = z.object({ revision: ordinal, timeline_revision: ordinal });
type State = z.infer<typeof stateSchema>;
const storedCommandSchema = z.object({ command: castCommandSchema, characterId: z.uuid().optional(), observationId: z.uuid().optional() }).strict();
type StoredCommand = z.infer<typeof storedCommandSchema>;
const eventSchema = z.object({ id: z.uuid(), effective_turn_number: ordinal,
  payload: z.array(storedCommandSchema), receipt: castBatchReceiptSchema, attachment: castAttachmentSchema.nullable().optional() });
const characterRowSchema = z.object({ id: z.uuid(), origin: castOriginSchema, first_observed_turn: ordinal });

async function lockCampaign(client: DatabaseClient, scope: CastScope): Promise<Campaign> {
  const result = await client.query(`SELECT active_turn_number,world_version_id,selected_character_id,selected_character_world_id,character_profile,character_snapshot
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
async function snapshotProjection(client: DatabaseClient, scope: CastScope, campaign: Campaign, state: State | null, boundary: CastBoundary): Promise<{
  snapshot: CastSnapshot; details: CastGenerationSnapshot["details"]; authoredEvidenceByCharacter: Map<string, Map<string, string>>;
}> {
  assertBoundary(campaign, state, boundary);
  const characterRows = (await client.query("SELECT id,origin,first_observed_turn FROM campaign_cast_characters WHERE campaign_id=$1 AND owner_user_id=$2 ORDER BY created_at,id", [scope.campaignId, scope.ownerUserId])).rows.map((row) => characterRowSchema.parse(row));
  const events = (await client.query("SELECT id,effective_turn_number,payload,receipt,attachment FROM campaign_cast_events WHERE campaign_id=$1 AND owner_user_id=$2 ORDER BY sequence", [scope.campaignId, scope.ownerUserId])).rows.map((row) => eventSchema.parse(row));
  const attachmentProjection = projectCastAttachments(events, boundary.turnNumber);
  const observations = (await client.query(`SELECT id,character_id AS "characterId",field,value,mode,
    speaker_character_id AS "speakerCharacterId",evidence,supersedes_observation_id AS "supersedesObservationId"
    FROM campaign_cast_observations WHERE campaign_id=$1 AND owner_user_id=$2 ORDER BY sequence`, [scope.campaignId, scope.ownerUserId])).rows.map((row) => castObservationSchema.parse(row));
  const current: CastObservation[] = [];
  for (const observation of observations) {
    if (!attachmentProjection.suppressedObservationIds.has(observation.id) && castEvidenceOrder(observation.evidence)[0] <= boundary.turnNumber && await evidenceIsCurrent(client, scope, campaign, observation.evidence)) current.push(observation);
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
  const mentions: { characterId: string; turnNumber: number; lexical: boolean }[] = [];
  for (const event of events) for (const { command } of event.payload) if (!attachmentProjection.detachedEventIds.has(event.id) && event.effective_turn_number <= boundary.turnNumber && command.kind === "mention"
    && command.evidence.turnNumber <= boundary.turnNumber && await evidenceIsCurrent(client, scope, campaign, command.evidence)) {
    if (command.kindOfMention === "lexical" && command.sourceRange && attachmentProjection.detached.some((attachment) =>
      attachment.characterId === command.characterId && attachment.sourceRanges.some((range) => castRangesOverlap(range, command.sourceRange!)))) continue;
    mentions.push({ characterId: command.characterId, turnNumber: command.evidence.turnNumber, lexical: command.kindOfMention === "lexical" });
  }
  const overrides = new Map<string, Map<string, CastOverride>>();
  const goalCutoffs = new Map<string, number>();
  const authoredEvidenceByCharacter = new Map<string, Map<string, string>>();
  const authoredEditsByCharacter = new Map<string, Set<string>>();
  for (const row of characterRows) {
    if (row.origin.kind !== "protagonist") continue;
    people.set(row.id, { id: row.id, origin: row.origin, ...protagonistProfile(campaign), pinned: false, ignored: false,
      revision: 0, firstObservedTurn: 0, lastObservedTurn: 0 });
  }
  for (const event of events) for (const stored of event.payload) {
    const command = stored.command;
    if (command.kind === "detach") {
      if (event.effective_turn_number <= boundary.turnNumber) {
        const person = people.get(command.characterId);
        if (person) person.revision++;
      }
      continue;
    }
    if (command.kind === "observe" || command.kind === "mention") continue;
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
        supportingTurns.push(...mentions.filter((item) => item.characterId === row.id && !item.lexical).map((item) => item.turnNumber));
        for (const edit of events) if (edit.effective_turn_number <= boundary.turnNumber && edit.payload.some((item) =>
          item.command.kind !== "create" && item.command.kind !== "observe" && item.command.kind !== "mention" && item.command.kind !== "detach" && item.command.kind !== "seed_profile" && item.command.kind !== "edit_authored_profile" && item.command.characterId === row.id
          && !(item.command.kind === "pin" && edit.payload.some((entry) => entry.command.kind === "seed_profile" && entry.command.characterId === row.id)))) supportingTurns.push(edit.effective_turn_number);
        if (!supportingTurns.length) continue;
        firstTurn = Math.min(...supportingTurns);
      }
      if (firstTurn > boundary.turnNumber) continue;
      people.set(row.id, castCharacterSchema.parse({ id: row.id, name: command.name, aliases: command.aliases,
        origin: row.origin, profile: {}, pinned: false, ignored: false, revision: 1, firstObservedTurn: firstTurn, lastObservedTurn: firstTurn }));
      continue;
    }
    const sameEventCreate = command.kind === "seed_profile" && event.payload.some((item) => item.command.kind === "create" && item.characterId === command.characterId);
    if (event.effective_turn_number > boundary.turnNumber && !sameEventCreate) continue;
    const person = people.get(command.characterId);
    if (!person) continue;
    if (command.kind === "seed_profile") {
      if (attachmentProjection.detachedEventIds.has(event.id)) continue;
      const { kind: _kind, characterId: _characterId, ...seed } = command;
      person.originProfile = { ...seed, seedEventId: event.id };
      person.campaignProfile = structuredClone(command.profile);
      goalCutoffs.delete(person.id);
      const paths = [...castAuthoredPathSchema.options, "story.goals", "appearance.summary", "identity.aliases", "name"];
      authoredEvidenceByCharacter.set(person.id, new Map(paths.map(path => [path, event.id])));
      authoredEditsByCharacter.set(person.id, new Set());
      person.revision++;
      continue;
    }
    if (command.kind === "edit_authored_profile") {
      if (!person.originProfile || person.originProfile.seedEventId !== command.seedEventId || !person.campaignProfile) continue;
      const updated = structuredClone(person.campaignProfile) as Record<string, any>;
      const original = person.originProfile.profile as Record<string, any>;
      const sources = authoredEvidenceByCharacter.get(person.id)!;
      const editedPaths = authoredEditsByCharacter.get(person.id)!;
      for (const path of command.reset) {
        editedPaths.delete(path);
        sources.set(path, command.seedEventId);
        const [section, key] = path.split(".");
        if (key) updated[section!][key] = structuredClone(original[section!][key]);
        else updated[section!] = structuredClone(original[section!]);
      }
      for (const [path, value] of Object.entries(command.set)) {
        // The iteration order retains the most recently edited appearance component for the joined summary.
        sources.delete(path);
        editedPaths.add(path);
        sources.set(path, event.id);
        const [section, key] = path.split(".");
        if (key) updated[section!][key] = value; else updated[section!] = value;
      }
      person.campaignProfile = characterProfileSchema.parse(updated);
      const latestAppearanceEdit = [...sources].filter(([path]) => path.startsWith("appearance.") && editedPaths.has(path)).at(-1);
      sources.set("appearance.summary", latestAppearanceEdit?.[1] ?? command.seedEventId);
      if (command.restoreAuthoredGoals) {
        goalCutoffs.set(person.id, event.effective_turn_number);
        overrides.get(person.id)?.delete("story.goals");
      }
      person.revision++;
      continue;
    }
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
  const details: CastGenerationSnapshot["details"] = [];
  for (const person of people.values()) {
    const own = current.filter((observation) => observation.characterId === person.id && validIds.has(observation.id));
    const ownMentions = mentions.filter((item) => item.characterId === person.id && !item.lexical);
    const lexicalMentions = mentions.filter((item) => item.characterId === person.id && item.lexical);
    person.lastMentionedTurn = lexicalMentions.length ? Math.max(...lexicalMentions.map((item) => item.turnNumber)) : null;
    person.lastObservedTurn = Math.max(person.firstObservedTurn, ...own.map((observation) => castEvidenceOrder(observation.evidence)[0]), ...ownMentions.map((item) => item.turnNumber));
    person.revision += own.length + ownMentions.length;
    details.push({ characterId: person.id, observations: own, overrides: [...(overrides.get(person.id)?.values() ?? [])] });
    if (person.origin.kind === "protagonist") continue;
    const ownOverrides = [...(overrides.get(person.id)?.values() ?? [])];
    if (person.campaignProfile) {
      const resolved = resolveSeededCastProfile({ profile: characterProfileSchema.parse(person.campaignProfile), observations: own, overrides: ownOverrides,
        ...(goalCutoffs.has(person.id) ? { restoreGoalsAfterTurn: goalCutoffs.get(person.id)! } : {}) });
      person.profile = resolved.profile; person.fieldSources = resolved.sources;
      for (const path of castAuthoredPathSchema.options) {
        const [section, key] = path.split(".");
        const raw = key ? (person.campaignProfile[section!] as Record<string, unknown>)[key] : person.campaignProfile[section!];
        if ((typeof raw === "string" && raw.trim()) || (Array.isArray(raw) && raw.length)) {
          person.fieldSources[path] = authoredEditsByCharacter.get(person.id)?.has(path) ? "campaign_edit" : "authored";
        } else person.fieldSources[path] ??= "none";
      }
    } else person.profile = projectCastProfile({ observations: own, overrides: ownOverrides });
    validateCastFiction(person.name);
    person.aliases.forEach(validateCastFiction);
  }
  return { snapshot: castSnapshotSchema.parse({ revision: state?.revision ?? 0, boundary, characters: [...people.values()] }), details, authoredEvidenceByCharacter };
}

async function snapshot(client: DatabaseClient, scope: CastScope, campaign: Campaign, state: State | null, boundary: CastBoundary): Promise<CastSnapshot> {
  return (await snapshotProjection(client, scope, campaign, state, boundary)).snapshot;
}

/** Caller owns the transaction. Lock and read retained authority without initializing cast rows. */
export async function captureCastGenerationSnapshotWithClient(client: DatabaseClient, rawScope: CastScope,
  options: { discoveryEnabled: boolean; boundary?: CastBoundary; turnNumber?: number; version?: "cast-context-v1" | "cast-context-v2" }): Promise<{ snapshot: CastGenerationSnapshot; fingerprint: string }> {
  const scope = castScopeSchema.parse(rawScope);
  const campaign = await lockCampaign(client, scope), state = await readState(client, scope);
  const boundary = options.boundary ?? { turnNumber: options.turnNumber ?? campaign.active_turn_number, timelineRevision: state?.timeline_revision ?? 0 };
  const projected = await snapshotProjection(client, scope, campaign, state, boundary);
  const status = await readCastDiscoveryStatus(client, scope, options.discoveryEnabled);
  const coverageStartTurn = status.coverageStartTurn !== null && status.coverageStartTurn <= boundary.turnNumber ? status.coverageStartTurn : null;
  const trackedThroughTurn = coverageStartTurn === null || status.trackedThroughTurn === null ? null : Math.min(status.trackedThroughTurn, boundary.turnNumber);
  const modern = options.version === "cast-context-v2";
  const fiction = modern ? projected.snapshot.characters.map(person => {
    const detail = projected.details.find(item => item.characterId === person.id)!;
    const authoredEvidence = projected.authoredEvidenceByCharacter.get(person.id);
    const authoredSource = (path: string) => (path === "appearance.summary"
      ? Object.entries(person.fieldSources ?? {}).some(([key, source]) => key.startsWith("appearance.") && source === "campaign_edit")
      : person.fieldSources?.[path as keyof typeof person.fieldSources] === "campaign_edit") ? "campaign_edit" : "authored";
    const sourceId = (id: string | undefined, path: string) => id ? `${id}:${path}` : undefined;
    const fields: { field: string; value: string; source: string; evidenceKind?: "turn" | "user" | "world" | "historical_world"; evidenceId?: string; effectiveTurn?: number }[] = [];
    const add = (field: string, raw: unknown, source: string, evidenceId?: string, effectiveTurn?: number, evidenceKind?: "turn" | "user" | "world" | "historical_world") => {
      const value = projectCastFictionText(raw);
      if (value && evidenceId) fields.push({ field, value, source, ...(evidenceKind ? { evidenceKind } : {}), ...(evidenceId ? { evidenceId } : {}), ...(effectiveTurn !== undefined ? { effectiveTurn } : {}) });
    };
    for (const [field, raw] of Object.entries(person.profile)) {
      const override = detail.overrides.find(item => item.field === field);
      let source: string = person.fieldSources?.[field as keyof typeof person.fieldSources] ?? (override ? "override" : "observation");
      let value = raw;
      if (field === "story.goals" && person.campaignProfile) {
        const goal = resolveCastContextGoal({ value: raw, source, authored: person.campaignProfile.story.goals,
          discoveryEnabled: options.discoveryEnabled, coverageCurrent: trackedThroughTurn === boundary.turnNumber });
        value = goal.value;
        source = goal.source === "authored" ? authoredSource(field) : goal.source;
      }
      const observation = detail.observations.filter(item => item.field === field && item.value === value && item.mode === "fact")
        .sort((a, b) => castEvidenceOrder(b.evidence)[0] - castEvidenceOrder(a.evidence)[0])[0];
      const evidence = source === "override" ? override?.evidence : source === "observation" ? observation?.evidence : undefined;
      const evidenceId = sourceId(evidence?.kind === "user" ? evidence.editId : source === "observation" ? observation?.id : authoredEvidence?.get(field), field);
      add(field, value, source, evidenceId, evidence ? castEvidenceOrder(evidence)[0] : undefined, evidence?.kind);
    }
    if (person.campaignProfile) {
      const profile = person.campaignProfile;
      const appearance = ["ancestryOrSpecies", "apparentAge", "genderPresentation", "build", "skinOrComplexion", "face", "eyes", "hair", "distinguishingFeatures", "clothing", "equipmentAndAccessories", "otherVisualDetails"].flatMap(key => { const value = profile.appearance[key]; return Array.isArray(value) ? value : [value]; }).map(value => projectCastFictionText(value, 20_000)).filter(Boolean).join(", ");
      add("appearance.summary", appearance, authoredSource("appearance.summary"), sourceId(authoredEvidence?.get("appearance.summary"), "appearance.summary"));
      for (const key of ["keyRelationships", "fearsAndConflicts", "narrativeHooks"] as const)
        add(`story.${key}`, profile.story[key], authoredSource(`story.${key}`), sourceId(authoredEvidence?.get(`story.${key}`), `story.${key}`));
      add("story.otherGuidance", profile.story.otherGuidance, authoredSource("story.otherGuidance"), sourceId(authoredEvidence?.get("story.otherGuidance"), "story.otherGuidance"));
      add("legacyGuidance", person.originProfile?.legacyCharacterText, "authored", sourceId(person.originProfile?.seedEventId, "legacyGuidance"));
      add("unclassifiedNotes", profile.unclassifiedNotes, authoredSource("unclassifiedNotes"), sourceId(authoredEvidence?.get("unclassifiedNotes"), "unclassifiedNotes"));
    } else if (person.originProfile?.legacyCharacterText) add("legacyGuidance", person.originProfile.legacyCharacterText, "authored", sourceId(person.originProfile.seedEventId, "legacyGuidance"));
    return { characterId: person.id, fields };
  }) : undefined;
  const characters = modern ? projected.snapshot.characters.map(person => {
    const { originProfile: _origin, campaignProfile: _profile, ...rest } = person;
    const profile = Object.fromEntries(Object.entries(person.profile).map(([key, value]) => [key, projectCastFictionText(value)]).filter(([, value]) => value));
    const origin = person.origin.kind === "world" || person.origin.kind === "historical_world"
      ? { ...person.origin, entityId: projectCastFictionText(person.origin.entityId, 200) || "unknown" }
      : person.origin.kind === "protagonist" ? { ...person.origin, selectedCharacterId: person.origin.selectedCharacterId === null ? null : projectCastFictionText(person.origin.selectedCharacterId, 200) || "unknown" }
        : person.origin;
    return { ...rest, origin, name: projectCastFictionText(person.name, 200) || "Unnamed character", aliases: person.aliases.map(alias => projectCastFictionText(alias, 200)).filter(Boolean), profile };
  }) : projected.snapshot.characters;
  const value = castGenerationSnapshotSchema.parse({ ...projected.snapshot, characters, ...(fiction ? { fiction } : {}), version: options.version ?? "cast-context-v1", scope,
    worldVersionId: campaign.world_version_id, coverageStartTurn, trackedThroughTurn,
    discoveryStatus: !options.discoveryEnabled ? "off" : trackedThroughTurn === boundary.turnNumber ? "current"
      : status.state === "failed" && status.firstGap && status.firstGap.turnNumber <= boundary.turnNumber ? "failed" : "pending",
    details: projected.details.map((detail) => modern ? { characterId: detail.characterId, observations: [], overrides: [] } : ({ ...detail, observations: detail.observations.map((observation) => ({ ...observation,
      evidence: observation.evidence.kind === "world" && observation.evidence.worldVersionId !== campaign.world_version_id
        ? { kind: "historical_world", sourceWorldVersionId: observation.evidence.worldVersionId, sourcePath: observation.evidence.sourcePath }
        : observation.evidence })) })) });
  return { snapshot: value, fingerprint: castGenerationSnapshotFingerprint(value) };
}

async function cacheSnapshot(client: DatabaseClient, scope: CastScope, value: CastSnapshot): Promise<void> {
  await client.query("DELETE FROM campaign_cast_profiles WHERE campaign_id=$1 AND owner_user_id=$2", [scope.campaignId, scope.ownerUserId]);
  for (const person of value.characters) if (person.origin.kind !== "protagonist") {
    await client.query(`INSERT INTO campaign_cast_profiles(owner_user_id,campaign_id,character_id,revision,profile)
      VALUES($1,$2,$3,$4,$5)`, [scope.ownerUserId, scope.campaignId, person.id, value.revision, JSON.stringify(person.profile)]);
  }
}

/** Lifecycle callers already own a transaction; never open a nested pool transaction. */
export async function initializeCastWithClient(client: DatabaseClient, rawScope: CastScope): Promise<CastSnapshot> {
  const scope = castScopeSchema.parse(rawScope), campaign = await lockCampaign(client, scope);
  const state = await initialize(client, scope, campaign);
  return snapshot(client, scope, campaign, state, { turnNumber: campaign.active_turn_number, timelineRevision: state.timeline_revision });
}

export async function rebuildCastWithClient(client: DatabaseClient, scope: CastScope, turnNumber?: number): Promise<CastSnapshot> {
  const campaign = await lockCampaign(client, scope), state = await readState(client, scope);
  const value = await snapshot(client, scope, campaign, state,
    { turnNumber: turnNumber ?? campaign.active_turn_number, timelineRevision: state?.timeline_revision ?? 0 });
  if (turnNumber === undefined) {
    await cacheSnapshot(client, scope, value);
    await refreshCastChronicleMetadata(client, scope, value);
  }
  return value;
}

async function assertSupportingCharacter(client: DatabaseClient, scope: CastScope, id: string, allowProtagonistEvidence = false): Promise<void> {
  const result = await client.query("SELECT origin FROM campaign_cast_characters WHERE id=$1 AND campaign_id=$2 AND owner_user_id=$3", [id, scope.campaignId, scope.ownerUserId]);
  if (!result.rows[0]) throw new Error("Cast character not found.");
  if (!allowProtagonistEvidence && castOriginSchema.parse(result.rows[0].origin).kind === "protagonist") throw new Error("Use the existing protagonist profile authority.");
}

async function applyCommand(client: DatabaseClient, scope: CastScope, campaign: Campaign, eventId: string, boundary: CastBoundary, stored: StoredCommand, trustedAuthored = false): Promise<void> {
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
      const entityId = command.origin.entityId;
      if (!buildScopedEntityCatalog({ worldContent: world }).some((entity) => entity.id === `world:${entityId}`)
        && !castDiscoveryWorldIdentities(world).some((person) => person.entityId === entityId)) throw new Error("World identity not found.");
    }
    const first = command.evidence?.kind === "turn" ? command.evidence.turnNumber : boundary.turnNumber;
    await client.query("INSERT INTO campaign_cast_characters(id,owner_user_id,campaign_id,origin,first_observed_turn) VALUES($1,$2,$3,$4,$5)",
      [stored.characterId, scope.ownerUserId, scope.campaignId, JSON.stringify(command.origin), first]);
    return;
  }
  await assertSupportingCharacter(client, scope, command.characterId, command.kind === "observe" || command.kind === "mention");
  // Seed and authored-profile writes require the dedicated fenced workflow (3E).
  // Until that workflow is installed, generic batch callers cannot create authority.
  if (!trustedAuthored && (command.kind === "seed_profile" || command.kind === "edit_authored_profile")) throw new Error("Authored cast writes require the dedicated workflow.");
  if (command.kind === "detach") {
    const target = (await client.query(`SELECT attachment FROM campaign_cast_events WHERE id=$1 AND campaign_id=$2 AND owner_user_id=$3 AND id<>$4`,
      [command.eventId, scope.campaignId, scope.ownerUserId, eventId])).rows[0];
    const attachment = target?.attachment && castAttachmentSchema.parse(target.attachment);
    if (!attachment || attachment.characterId !== command.characterId) throw new Error("Invalid cast attachment target.");
    const prior = (await client.query(`SELECT 1 FROM campaign_cast_events WHERE campaign_id=$1 AND owner_user_id=$2 AND id<>$3
      AND payload @> $4::jsonb LIMIT 1`, [scope.campaignId, scope.ownerUserId, eventId,
      JSON.stringify([{ command: { kind: "detach", characterId: command.characterId, eventId: command.eventId } }])])).rows[0];
    if (prior) throw new Error("Cast attachment already detached.");
    return;
  }
  if (command.kind === "mention") {
    if (command.kindOfMention === "lexical") {
      const range = command.sourceRange!;
      const source = (await client.query(`SELECT turn_number,correction_revision,effective_narration FROM effective_turn_narrations
        WHERE turn_id=$1 AND campaign_id=$2 AND owner_user_id=$3`, [range.turnId, scope.campaignId, scope.ownerUserId])).rows[0];
      if (!source || range.turnId !== command.evidence.turnId || range.narrationRevision !== command.evidence.narrationRevision
        || range.sourceHash !== command.evidence.sourceHash || range.paragraphId !== command.evidence.paragraphId) throw new Error("Invalid lexical cast mention.");
      const parsed = buildCastDiscoverySource({ scope, timelineRevision: boundary.timelineRevision, turnId: range.turnId,
        turnNumber: source.turn_number, narrationRevision: source.correction_revision, narration: source.effective_narration });
      if (parsed.paragraphs.find((item) => item.id === range.paragraphId)?.text.slice(range.start, range.end) !== command.evidence.quote) throw new Error("Invalid lexical cast range.");
    }
    if (!await evidenceIsCurrent(client, scope, campaign, command.evidence)) throw new Error("Invalid cast mention evidence.");
    return;
  }
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
  batch: CastBatch, requestHash: string, publicCharacterId?: string, deferMetadataRefresh = false, attachmentInput?: { characterId: string; basis: "unique_name" | "unique_world_name"; sourceRanges: import("../../contracts/src/campaign-cast.js").CastSourceRange[] }, trustedAuthored = false, eventId = randomUUID()): Promise<CastBatchReceipt> {
  const payload: StoredCommand[] = batch.commands.map((command) => ({ command,
    ...(command.kind === "create" ? { characterId: publicCharacterId ?? randomUUID() } : {}),
    ...(command.kind === "observe" ? { observationId: randomUUID() } : {}) }));
  const receipt: CastBatchReceipt = { eventId, revision: state.revision + 1,
    characterIds: payload.flatMap((item) => item.characterId ? [item.characterId] : []),
    observationIds: payload.flatMap((item) => item.observationId ? [item.observationId] : []) };
  await client.query(`INSERT INTO campaign_cast_events(id,owner_user_id,campaign_id,effective_turn_number,timeline_revision,idempotency_key,request_hash,payload,receipt)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [receipt.eventId, scope.ownerUserId, scope.campaignId, batch.boundary.turnNumber,
    batch.boundary.timelineRevision, batch.idempotencyKey, requestHash, JSON.stringify(payload), JSON.stringify(receipt)]);
  for (const stored of payload) await applyCommand(client, scope, campaign, receipt.eventId, batch.boundary, stored, trustedAuthored);
  if (attachmentInput) {
    const attachment = castAttachmentSchema.parse({ ...attachmentInput, eventId: receipt.eventId, observationIds: receipt.observationIds });
    if (batch.commands.some((command) => command.kind !== "create" && command.characterId !== attachment.characterId)
      || payload.some((item) => item.command.kind === "create" && item.characterId !== attachment.characterId)) throw new Error("Invalid cast attachment scope.");
    for (const range of attachment.sourceRanges) {
      const row = (await client.query(`SELECT turn_number,correction_revision,effective_narration FROM effective_turn_narrations
        WHERE turn_id=$1 AND campaign_id=$2 AND owner_user_id=$3`, [range.turnId, scope.campaignId, scope.ownerUserId])).rows[0];
      if (!row || row.correction_revision !== range.narrationRevision || sha256(row.effective_narration) !== range.sourceHash) throw new Error("Invalid cast attachment source.");
      const source = buildCastDiscoverySource({ scope, timelineRevision: batch.boundary.timelineRevision, turnId: range.turnId, turnNumber: row.turn_number, narrationRevision: range.narrationRevision, narration: row.effective_narration });
      const paragraph = source.paragraphs.find((item) => item.id === range.paragraphId)?.text;
      const quote = paragraph?.slice(range.start, range.end);
      if (!quote || !batch.commands.some((command) => (command.kind === "create" || command.kind === "observe" || command.kind === "mention")
        && command.evidence?.kind === "turn" && command.evidence.turnId === range.turnId
        && command.evidence.narrationRevision === range.narrationRevision && command.evidence.sourceHash === range.sourceHash
        && command.evidence.paragraphId === range.paragraphId && command.evidence.quote === quote)) throw new Error("Invalid cast attachment range.");
    }
    await client.query("UPDATE campaign_cast_events SET attachment=$2 WHERE id=$1", [receipt.eventId, JSON.stringify(attachment)]);
  }
  await client.query("UPDATE campaign_cast_state SET revision=$3 WHERE campaign_id=$1 AND owner_user_id=$2", [scope.campaignId, scope.ownerUserId, receipt.revision]);
  const value = await snapshot(client, scope, campaign, { ...state, revision: receipt.revision }, batch.boundary);
  await cacheSnapshot(client, scope, value);
  if (!deferMetadataRefresh && batch.commands.some((command) => command.kind === "create" || command.kind === "identity")) {
    await refreshCastChronicleMetadata(client, scope, value);
  }
  if (publicCharacterId) {
    receipt.result = { character: value.characters.find((person) => person.id === publicCharacterId)!, revision: value.revision, boundary: value.boundary };
    await client.query("UPDATE campaign_cast_events SET receipt=$2 WHERE id=$1", [receipt.eventId, JSON.stringify(receipt)]);
  }
  return receipt;
}

/** Discovery publication and its receipt share the caller's transaction. */
export async function applyCastBatchWithClient(client: DatabaseClient, rawScope: CastScope, rawBatch: CastBatch,
  options: { deferMetadataRefresh?: boolean; attachment?: { characterId: string; basis: "unique_name" | "unique_world_name"; sourceRanges: import("../../contracts/src/campaign-cast.js").CastSourceRange[] } } = {}): Promise<CastBatchReceipt> {
  const scope = castScopeSchema.parse(rawScope), batch = castBatchSchema.parse(rawBatch);
  const campaign = await lockCampaign(client, scope);
  const state = await initialize(client, scope, campaign);
  const requestHash = sha256(stableStringify(options.attachment ? { batch, attachment: options.attachment } : batch));
  const prior = (await client.query("SELECT request_hash,receipt FROM campaign_cast_events WHERE campaign_id=$1 AND owner_user_id=$2 AND idempotency_key=$3", [scope.campaignId, scope.ownerUserId, batch.idempotencyKey])).rows[0];
  if (prior) {
    if (prior.request_hash !== requestHash) throw new Error("Cast idempotency key reused with different content.");
    return castBatchReceiptSchema.parse(prior.receipt);
  }
  assertBoundary(campaign, state, batch.boundary, true);
  return persistBatch(client, scope, campaign, state, batch, requestHash, undefined, options.deferMetadataRefresh, options.attachment);
}

export function createPostgresCampaignCastRepository(pool: DatabasePool, options: { castPresetsEnabled?: boolean; editingEnabled?: boolean; discoveryEnabled?: boolean; backfillEnabled?: boolean; castAutoMatchEnabled?: boolean; castContextEnabled?: boolean; storyMemoryCapability?: "r1" | "r2" | "r3" | null } = {}): CampaignCastRepositoryPort & CampaignCastWritePort {
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
        if (person.originProfile) {
          const invalid = [...Object.keys(edit.setOverrides ?? {}), ...(edit.clearOverrides ?? [])].filter(field =>
            !["story.goals", "state.location", "state.condition", "state.clothing", "appearance.description"].includes(field));
          if (invalid.length) throw new CampaignCastError("cast_fixed_field_override", invalid.map(path => ({ path, code: "fixed_field" })));
        }
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
  async function editAuthoredProfile(rawScope: CastScope, rawId: string, rawRequest: EditAuthoredCastProfile): Promise<CastWriteResult> {
    const scope = castScopeSchema.parse(rawScope), id = z.uuid().parse(rawId), request = editAuthoredCastProfileSchema.parse(rawRequest);
    return withTransaction(pool, async (client) => {
      const campaign = await lockCampaign(client, scope);
      if (!options.editingEnabled) throw new CampaignCastError("cast_editing_disabled");
      const state = await initialize(client, scope, campaign), hash = sha256(stableStringify({ operation: "authored-profile", id, request }));
      const prior = (await client.query("SELECT request_hash,receipt FROM campaign_cast_events WHERE campaign_id=$1 AND owner_user_id=$2 AND idempotency_key=$3", [scope.campaignId, scope.ownerUserId, request.idempotencyKey])).rows[0];
      if (prior) {
        if (prior.request_hash !== hash) throw new CampaignCastError("cast_idempotency_conflict");
        const receipt = castBatchReceiptSchema.parse(prior.receipt);
        if (!receipt.result) throw new CampaignCastError("cast_idempotency_conflict");
        return receipt.result;
      }
      if (state.revision !== request.expectedCastRevision || state.timeline_revision !== request.expectedBoundary.timelineRevision
        || campaign.active_turn_number !== request.expectedBoundary.turnNumber) throw new CampaignCastError("cast_revision_conflict");
      if ((await client.query(`SELECT id FROM generation_jobs WHERE campaign_id=$1 AND owner_user_id=$2
        AND status IN ('queued','replacement_queued','assessing','generating','validating','committing','recoverable') LIMIT 1`, [scope.campaignId, scope.ownerUserId])).rows.length) throw new CampaignCastError("cast_generation_active");
      const person = (await snapshot(client, scope, campaign, state, request.expectedBoundary)).characters.find((item) => item.id === id);
      if (!person) throw new CampaignCastError("cast_not_found");
      if (person.origin.kind === "protagonist") throw new CampaignCastError("cast_protagonist_read_only");
      if (person.revision !== request.expectedCharacterRevision) throw new CampaignCastError("cast_revision_conflict");
      if (!person.originProfile || !person.campaignProfile) throw new CampaignCastError("cast_not_seeded");
      const allowed = ["story.goals", "state.location", "state.condition", "state.clothing", "appearance.description"];
      const invalidOverrides = [...Object.keys(request.setOverrides ?? {}), ...(request.clearOverrides ?? [])].filter(path => !allowed.includes(path));
      if (invalidOverrides.length) throw new CampaignCastError("cast_invalid_field_class", invalidOverrides.map(path => ({ path, code: "invalid_field_class" })));
      const updated = structuredClone(person.campaignProfile) as Record<string, any>;
      for (const [path, value] of Object.entries(request.set ?? {})) {
        try {
          const [section, key] = path.split(".");
          const old = key ? updated[section!][key] : updated[section!];
          if (path === "appearance.distinguishingFeatures" ? !Array.isArray(value) : typeof value !== "string") throw new Error("Invalid authored field type.");
          const limit = path === "unclassifiedNotes" ? 200_000 : path === "identity.pronouns" || ["appearance.ancestryOrSpecies", "appearance.apparentAge", "appearance.genderPresentation", "appearance.build", "appearance.skinOrComplexion", "appearance.eyes"].includes(path) ? 2_000 : 20_000;
          if (typeof value === "string" && value.length > limit) throw new Error("Invalid authored field length.");
          const values = Array.isArray(value) ? value : [value];
          values.forEach(validateCastFiction);
          if ((typeof old === "string" && old.trim() || Array.isArray(old) && old.length) && (Array.isArray(value) ? !value.length : !value.trim())) throw new Error("Cannot blank an authored field.");
          if (key) updated[section!][key] = value; else updated[section!] = value;
        } catch { throw new CampaignCastError("cast_invalid_request", [{ path, code: "invalid_value" }]); }
      }
      try { characterProfileSchema.parse(updated); } catch { throw new CampaignCastError("cast_invalid_request"); }
      for (const [path, value] of Object.entries(request.setOverrides ?? {})) {
        try { validateCastFiction(value); } catch { throw new CampaignCastError("cast_invalid_request", [{ path, code: "invalid_fiction" }]); }
      }
      try { if (request.name) validateCastFiction(request.name); } catch { throw new CampaignCastError("cast_invalid_request", [{ path: "name", code: "invalid_fiction" }]); }
      try { request.aliases?.forEach(validateCastFiction); } catch { throw new CampaignCastError("cast_invalid_request", [{ path: "identity.aliases", code: "invalid_fiction" }]); }
      const commands: CastCommand[] = [];
      if (Object.keys(request.set ?? {}).length || request.reset?.length || request.restoreAuthoredGoals) commands.push({ kind: "edit_authored_profile", characterId: id,
        seedEventId: person.originProfile.seedEventId, set: request.set ?? {}, reset: request.reset ?? [], ...(request.restoreAuthoredGoals ? { restoreAuthoredGoals: true } : {}) });
      if (request.resetIdentity || request.name !== undefined || request.aliases !== undefined) commands.push({ kind: "identity", characterId: id,
        name: request.resetIdentity ? person.originProfile.rosterName : request.name ?? person.name,
        aliases: request.resetIdentity ? person.originProfile.rosterAliases : request.aliases ?? person.aliases });
      for (const [field, value] of Object.entries(request.setOverrides ?? {})) commands.push(castCommandSchema.parse(
        value === "" && field !== "appearance.description" ? { kind: "clear_override", characterId: id, field }
          : { kind: "override", characterId: id, field, value }));
      for (const field of request.clearOverrides ?? []) commands.push({ kind: "clear_override", characterId: id, field });
      if (request.pinned !== undefined) commands.push({ kind: "pin", characterId: id, value: request.pinned });
      if (request.ignored !== undefined) commands.push({ kind: "ignore", characterId: id, value: request.ignored });
      return (await persistBatch(client, scope, campaign, state, { boundary: request.expectedBoundary, idempotencyKey: request.idempotencyKey, commands }, hash, id, false, undefined, true)).result!;
    });
  }
  async function worldPreviewWithClient(client: DatabaseClient, scope: CastScope, campaign: Campaign, state: State, input: CastFromWorldPreviewQuery) {
    const row = (await client.query("SELECT world_id,content FROM world_versions WHERE id=$1 AND owner_user_id=$2", [campaign.world_version_id, scope.ownerUserId])).rows[0];
    if (!row) throw new CampaignCastError("cast_not_found");
    const content = worldContentSchema.parse(row.content), index = content.playableCharacters.findIndex((item) => item.id === input.characterId);
    const entry = content.playableCharacters[index];
    if (!entry || entry.id === campaign.selected_character_id && (campaign.selected_character_world_id === null || campaign.selected_character_world_id === row.world_id) || !["supporting", "both"].includes(entry.campaignUse)) throw new CampaignCastError("cast_world_character_unavailable");
    const boundary = { turnNumber: campaign.active_turn_number, timelineRevision: state.timeline_revision };
    const projected = await snapshotProjection(client, scope, campaign, state, boundary);
    const seededVersions = projected.snapshot.characters.flatMap(({ originProfile }) =>
      originProfile?.evidence.kind === "world" && originProfile.entityId === entry.id ? [originProfile.worldVersionId] : []);
    if (seededVersions.length && (await client.query(
      "SELECT 1 FROM world_versions WHERE owner_user_id=$1 AND world_id=$2 AND id=ANY($3::uuid[]) LIMIT 1",
      [scope.ownerUserId, row.world_id, seededVersions])).rowCount) throw new CampaignCastError("cast_world_character_unavailable");
    const matches = projected.snapshot.characters.filter((person) => person.origin.kind !== "protagonist" && !person.originProfile &&
      [person.name, ...person.aliases].some((name) => normalizeEntityTerm(name) === normalizeEntityTerm(entry.name)));
    const target = input.targetCastCharacterId ? projected.snapshot.characters.find((person) => person.id === input.targetCastCharacterId) : undefined;
    if (input.targetCastCharacterId && (!target || !matches.some((person) => person.id === target.id))) throw new CampaignCastError("cast_world_character_unavailable");
    const profile = structuredClone(entry.profile ?? characterProfileSchema.parse({ unclassifiedNotes: entry.characterText }));
    try { validateCastFiction(entry.name); } catch { throw new CampaignCastError("cast_world_character_unavailable"); }
    profile.identity.aliases = profile.identity.aliases.filter((alias) => { try { validateCastFiction(alias); return true; } catch { return false; } });
    const overrides = target ? projected.details.find((detail) => detail.characterId === target.id)?.overrides ?? [] : [];
    const handEdits: Record<string, string> = {};
    const changes: CastFromWorldPreview["changes"] = [];
    for (const field of ["identity.pronouns", "story.role", "story.background", "story.personality", "story.motivations", "story.voiceAndMannerisms"] as const) {
      const [section, key] = field.split(".") as ["identity" | "story", string];
      const proposed = (profile[section] as Record<string, unknown>)[key] as string;
      const override = overrides.find((item) => item.field === field)?.value;
      if (!proposed.trim() && override?.trim()) handEdits[field] = override;
      changes.push({ path: field, old: target?.profile[field] ?? null, proposed: proposed.trim() ? proposed : override ?? "", effect: proposed.trim() ? "world" : override?.trim() ? "preserve_edit" : "discoverable" });
    }
    changes.push({ path: "authoredProfile", old: target?.campaignProfile ?? null, proposed: profile, effect: "apply" });
    changes.push({ path: "overrides", old: overrides, proposed: overrides, effect: "preserve" });
    changes.push({ path: "identity", old: target ? { name: target.name, aliases: target.aliases } : null, proposed: { name: target?.name ?? entry.name, aliases: target?.aliases ?? profile.identity.aliases }, effect: target ? "preserve" : "create" });
    const core = { worldVersionId: campaign.world_version_id, characterId: entry.id, ...(target ? { targetCastCharacterId: target.id, characterRevision: target.revision } : {}),
      eligibleTargets: matches.map(({ id, name, revision }) => ({ id, name, revision })), castRevision: state.revision, boundary, choices: [], changes };
    return { preview: { ...core, previewFingerprint: sha256(stableStringify(core)) } satisfies CastFromWorldPreview, entry, index, profile, target, handEdits };
  }
  async function fromWorldPreview(rawScope: CastScope, rawInput: CastFromWorldPreviewQuery): Promise<CastFromWorldPreview> {
    const scope = castScopeSchema.parse(rawScope), input = castFromWorldPreviewQuerySchema.parse(rawInput);
    return withTransaction(pool, async (client) => { const campaign = await lockCampaign(client, scope), state = await initialize(client, scope, campaign); return (await worldPreviewWithClient(client, scope, campaign, state, input)).preview; });
  }
  async function fromWorld(rawScope: CastScope, rawInput: CastFromWorld): Promise<CastWriteResult> {
    const scope = castScopeSchema.parse(rawScope), request = castFromWorldSchema.parse(rawInput);
    return withTransaction(pool, async (client) => {
      const campaign = await lockCampaign(client, scope);
      if (!options.editingEnabled) throw new CampaignCastError("cast_editing_disabled");
      const state = await initialize(client, scope, campaign), hash = sha256(stableStringify({ operation: "from-world", request }));
      const prior = (await client.query("SELECT request_hash,receipt FROM campaign_cast_events WHERE campaign_id=$1 AND owner_user_id=$2 AND idempotency_key=$3", [scope.campaignId, scope.ownerUserId, request.idempotencyKey])).rows[0];
      if (prior) { if (prior.request_hash !== hash) throw new CampaignCastError("cast_idempotency_conflict"); const receipt = castBatchReceiptSchema.parse(prior.receipt); if (!receipt.result) throw new CampaignCastError("cast_idempotency_conflict"); return receipt.result; }
      if (!options.castPresetsEnabled) throw new CampaignCastError("cast_presets_disabled");
      if (state.revision !== request.expectedCastRevision || state.timeline_revision !== request.expectedBoundary.timelineRevision || campaign.active_turn_number !== request.expectedBoundary.turnNumber || campaign.world_version_id !== request.expectedWorldVersionId) throw new CampaignCastError("cast_world_preview_changed");
      if ((await client.query(`SELECT id FROM generation_jobs WHERE campaign_id=$1 AND owner_user_id=$2 AND status IN ('queued','replacement_queued','assessing','generating','validating','committing','recoverable') LIMIT 1`, [scope.campaignId, scope.ownerUserId])).rows.length) throw new CampaignCastError("cast_generation_active");
      let recomputed: Awaited<ReturnType<typeof worldPreviewWithClient>>;
      try { recomputed = await worldPreviewWithClient(client, scope, campaign, state, { characterId: request.characterId, ...(request.targetCastCharacterId ? { targetCastCharacterId: request.targetCastCharacterId } : {}) }); }
      catch (error) { if (error instanceof CampaignCastError && error.code === "cast_world_character_unavailable") throw new CampaignCastError("cast_world_preview_changed"); throw error; }
      const { preview, entry, index, profile, target, handEdits } = recomputed;
      if (preview.previewFingerprint !== request.previewFingerprint || target?.revision !== request.expectedCharacterRevision || !target && preview.eligibleTargets.length) throw new CampaignCastError("cast_world_preview_changed");
      const id = target?.id ?? randomUUID(), eventId = randomUUID();
      const aliases = profile.identity.aliases.filter((alias) => { try { validateCastFiction(alias); return true; } catch { return false; } });
      profile.identity.aliases = aliases;
      // Preserve authored World text in full; provider-bound capture applies its own fiction projection.
      const evidence = { kind: "world" as const, worldVersionId: campaign.world_version_id, sourcePath: `/playableCharacters/${index}` };
      const commands: CastCommand[] = [];
      if (!target) commands.push({ kind: "create", name: entry.name, aliases, origin: { kind: "world", worldVersionId: campaign.world_version_id, entityId: entry.id }, evidence });
      commands.push({ kind: "seed_profile", characterId: id, worldVersionId: campaign.world_version_id, entityId: entry.id, rosterName: entry.name, rosterAliases: aliases, legacyCharacterText: entry.characterText, profile, evidence });
      if (Object.keys(handEdits).length) commands.push(castCommandSchema.parse({ kind: "edit_authored_profile", characterId: id, seedEventId: eventId, set: handEdits, reset: [] }));
      if (request.alwaysInContext) commands.push({ kind: "pin", characterId: id, value: true });
      return (await persistBatch(client, scope, campaign, state, { boundary: request.expectedBoundary, idempotencyKey: request.idempotencyKey, commands }, hash, id, false, undefined, true, eventId)).result!;
    });
  }
  const statusCache = new Map<string, { fingerprint: string; value: Awaited<ReturnType<NonNullable<CampaignCastWritePort["workspaceRead"]>>> }>();
  return {
    editAuthoredProfile, fromWorldPreview, fromWorld,
    async detachAttachment(rawScope, rawCharacterId, rawEventId, rawRequest) {
      const scope = castScopeSchema.parse(rawScope), characterId = z.uuid().parse(rawCharacterId), eventId = z.uuid().parse(rawEventId);
      const request = detachCastAttachmentSchema.parse(rawRequest);
      return withTransaction(pool, async (client) => {
        const campaign = await lockCampaign(client, scope);
        if (!options.editingEnabled) throw new CampaignCastError("cast_editing_disabled");
        const state = await initialize(client, scope, campaign);
        const hash = sha256(stableStringify({ characterId, eventId, request }));
        const prior = (await client.query("SELECT request_hash,receipt FROM campaign_cast_events WHERE campaign_id=$1 AND owner_user_id=$2 AND idempotency_key=$3", [scope.campaignId, scope.ownerUserId, request.idempotencyKey])).rows[0];
        if (prior) {
          if (prior.request_hash !== hash) throw new CampaignCastError("cast_idempotency_conflict");
          const receipt = castBatchReceiptSchema.parse(prior.receipt);
          if (!receipt.result) throw new CampaignCastError("cast_idempotency_conflict");
          return { ...receipt.result, detachedEventId: eventId };
        }
        if (state.revision !== request.expectedCastRevision || state.timeline_revision !== request.expectedBoundary.timelineRevision
          || campaign.active_turn_number !== request.expectedBoundary.turnNumber) throw new CampaignCastError("cast_revision_conflict");
        if ((await client.query(`SELECT id FROM generation_jobs WHERE campaign_id=$1 AND owner_user_id=$2
          AND status IN ('queued','replacement_queued','assessing','generating','validating','committing','recoverable') LIMIT 1`, [scope.campaignId, scope.ownerUserId])).rows.length) throw new CampaignCastError("cast_generation_active");
        const current = await snapshot(client, scope, campaign, state, request.expectedBoundary);
        const person = current.characters.find((item) => item.id === characterId);
        if (!person) throw new CampaignCastError("cast_not_found");
        if (person.origin.kind === "protagonist") throw new CampaignCastError("cast_protagonist_read_only");
        if (person.revision !== request.expectedCharacterRevision) throw new CampaignCastError("cast_revision_conflict");
        const target = (await client.query("SELECT attachment FROM campaign_cast_events WHERE id=$1 AND campaign_id=$2 AND owner_user_id=$3", [eventId, scope.campaignId, scope.ownerUserId])).rows[0];
        if (!target?.attachment || castAttachmentSchema.parse(target.attachment).characterId !== characterId) throw new CampaignCastError("cast_invalid_request");
        for (const range of castAttachmentSchema.parse(target.attachment).sourceRanges) {
          const source = (await client.query(`SELECT correction_revision,effective_narration FROM effective_turn_narrations
            WHERE turn_id=$1 AND campaign_id=$2 AND owner_user_id=$3`, [range.turnId, scope.campaignId, scope.ownerUserId])).rows[0];
          if (!source || source.correction_revision !== range.narrationRevision || sha256(source.effective_narration) !== range.sourceHash)
            throw new CampaignCastError("cast_revision_conflict");
        }
        try {
          const receipt = await persistBatch(client, scope, campaign, state, { boundary: request.expectedBoundary,
            idempotencyKey: request.idempotencyKey, commands: [{ kind: "detach", characterId, eventId }] }, hash, characterId);
          // Reconstruct identity-only review from retained current source; the candidate is operational,
          // while the event and its receipt remain the durable undo authority.
          const attachment = castAttachmentSchema.parse(target.attachment);
          const range = attachment.sourceRanges[0]!;
          const row = (await client.query(`SELECT turn_number,correction_revision,effective_narration FROM effective_turn_narrations
            WHERE turn_id=$1 AND campaign_id=$2 AND owner_user_id=$3`, [range.turnId, scope.campaignId, scope.ownerUserId])).rows[0];
          if (row && row.correction_revision === range.narrationRevision && sha256(row.effective_narration) === range.sourceHash) {
            const source = buildCastDiscoverySource({ scope, timelineRevision: state.timeline_revision, turnId: range.turnId,
              turnNumber: row.turn_number, narrationRevision: range.narrationRevision, narration: row.effective_narration });
            const quote = source.paragraphs.find((item) => item.id === range.paragraphId)?.text.slice(range.start, range.end);
            if (quote) await client.query(`INSERT INTO campaign_cast_discovery_candidates(owner_user_id,campaign_id,job_id,chunk_ordinal,local_key,source,proposal,reason)
              VALUES($1,$2,NULL,0,$3,$4,$5,'detached_attachment') ON CONFLICT DO NOTHING`, [scope.ownerUserId, scope.campaignId,
              `detach:${eventId}`, JSON.stringify(source), JSON.stringify({ localKey: `detach:${eventId}`, name: person.name,
                aliases: person.aliases, existingCharacterId: null, identityEvidence: [{ paragraphId: range.paragraphId, quote }], observations: [] })]);
          }
          return { ...receipt.result!, detachedEventId: eventId };
        } catch (error) {
          if (error instanceof Error && error.message === "Cast attachment already detached.") throw new CampaignCastError("cast_invalid_request");
          throw error;
        }
      });
    },
    create: (scope, request) => write(scope, null, request),
    edit: (scope, id, request) => write(scope, z.uuid().parse(id), request),
    discoveryStatus: (scope) => readCastDiscoveryStatus(pool, scope, options.discoveryEnabled === true),
    ...createCastCandidateRepository(pool, options.editingEnabled === true),
    async workspaceRead(rawScope, statusOnly = false) {
      const scope = castScopeSchema.parse(rawScope);
      return withTransaction(pool, async (client) => {
        const cacheKey = `${scope.ownerUserId}:${scope.campaignId}`;
        // Poll unchanged workspaces with indexed scope reads only. Triggers bump
        // operational revision; authority and source changes retain their own fences.
        const readFingerprint = async () => {
          const row = (await client.query(`SELECT c.active_turn_number,c.world_version_id,c.character_profile_revision,
            c.selected_character_id,s.revision,s.timeline_revision,s.workspace_revision,e.capability
            FROM campaigns c LEFT JOIN campaign_cast_state s ON s.campaign_id=c.id AND s.owner_user_id=c.owner_user_id
            LEFT JOIN campaign_story_memory_enrollments e ON e.campaign_id=c.id AND e.owner_user_id=c.owner_user_id
            WHERE c.id=$1 AND c.owner_user_id=$2`, [scope.campaignId, scope.ownerUserId])).rows[0];
          if (!row) throw new CampaignCastError("cast_not_found");
          return stableStringify(row);
        };
        const fastFingerprint = await readFingerprint(), cached = statusCache.get(cacheKey);
        if (statusOnly && cached?.fingerprint === fastFingerprint) return cached.value;
        const campaign = await lockCampaign(client, scope), state = await initialize(client, scope, campaign);
        const fingerprint = await readFingerprint();
        const boundary = { turnNumber: campaign.active_turn_number, timelineRevision: state.timeline_revision };
        const tracking = await readCastDiscoveryStatus(client, scope, options.discoveryEnabled === true);
        const gap = tracking.firstGap;
        const recoveryJob = gap?.jobId ? (await client.query(`SELECT j.scan_id,s.status AS scan_status FROM campaign_cast_discovery_jobs j
          LEFT JOIN campaign_cast_scans s ON s.id=j.scan_id AND s.campaign_id=j.campaign_id AND s.owner_user_id=j.owner_user_id
          WHERE j.id=$1 AND j.campaign_id=$2 AND j.owner_user_id=$3`, [gap.jobId, scope.campaignId, scope.ownerUserId])).rows[0] : null;
        const recovery = gap ? { kind: gap.diagnosticCode === "source_requires_manual_scan" ? "manual" as const
          : gap.status !== "failed" || !recoveryJob ? "none" as const : recoveryJob.scan_id ? "scan" as const : "forward" as const,
          turnNumber: gap.turnNumber, jobId: gap.jobId, scanId: recoveryJob?.scan_id ?? null, scanStatus: recoveryJob?.scan_status ?? null } : undefined;
        const enrollment = (await client.query("SELECT capability FROM campaign_story_memory_enrollments WHERE campaign_id=$1 AND owner_user_id=$2", [scope.campaignId, scope.ownerUserId])).rows[0];
        const projected = await snapshotProjection(client, scope, campaign, state, boundary);
        const rows = (await client.query(`SELECT p.proposal,p.resolution_receipt,p.detail_decisions,
          ARRAY(SELECT (pending.item->>'index')::integer FROM (${pendingCastDetailSql}) pending) AS pending_indexes FROM campaign_cast_discovery_candidates p
          JOIN effective_turn_narrations n ON n.turn_id=(p.source->>'turnId')::uuid AND n.campaign_id=p.campaign_id AND n.owner_user_id=p.owner_user_id
          WHERE p.campaign_id=$1 AND p.owner_user_id=$2 AND p.status='pending'
            AND (p.source->>'timelineRevision')::integer=$3 AND n.turn_number<=$4
            AND n.correction_revision=(p.source->>'narrationRevision')::integer
            AND encode(digest(n.effective_narration,'sha256'),'hex')=p.source->>'sourceHash'`,
        [scope.campaignId, scope.ownerUserId, boundary.timelineRevision, boundary.turnNumber])).rows;
        const reviewIds = new Set<string>(), conflictIds = new Set<string>();
        const attentionCounts: Record<string, { review: number; conflict: number }> = {};
        const addAttention = (id: string, review: number, conflict = 0) => {
          const count = attentionCounts[id] ??= { review: 0, conflict: 0 };
          count.review += review; count.conflict += conflict;
        };
        let identities = 0, details = 0, conflicts = 0;
        const ignoredTargets = new Set(projected.snapshot.characters.filter(person => person.ignored).map(person => person.id));
        for (const row of rows) {
          const id = row.resolution_receipt?.result?.character?.id ?? row.proposal?.existingCharacterId;
          const person = projected.snapshot.characters.find((item) => item.id === id);
          const pendingIndexes = row.pending_indexes.filter((index: number) => !isSeededFixedCandidateHidden(
            person?.campaignProfile && characterProfileSchema.parse(person.campaignProfile), row.proposal.observations[index].field));
          // Count the same actionable identity proposals that the review list returns.
          if (!row.resolution_receipt && ignoredTargets.has(id)) continue;
          if (id && (!row.resolution_receipt || pendingIndexes.length) && projected.snapshot.characters.some(person => person.id === id)) {
            reviewIds.add(id);
            addAttention(id, row.resolution_receipt ? pendingIndexes.length : 1);
          }
          if (!row.resolution_receipt) identities++;
          else {
            details += pendingIndexes.length;
          }
        }
        const decisionCounts = (await client.query(`SELECT
          LEAST(10000,count(*) FILTER (WHERE p.resolution_receipt IS NOT NULL))::integer AS identities,
          LEAST(10000,COALESCE(sum((SELECT count(*) FROM jsonb_array_elements(p.detail_decisions) d WHERE d->'result'->>'disposition' IN ('confirm','accept'))),0))::integer AS confirmed,
          LEAST(10000,COALESCE(sum((SELECT count(*) FROM jsonb_array_elements(p.detail_decisions) d WHERE d->'result'->>'disposition'='dismiss')),0))::integer AS dismissed
          FROM campaign_cast_discovery_candidates p JOIN effective_turn_narrations n
            ON n.turn_id=(p.source->>'turnId')::uuid AND n.campaign_id=p.campaign_id AND n.owner_user_id=p.owner_user_id
          WHERE p.campaign_id=$1 AND p.owner_user_id=$2 AND p.status<>'cancelled'
            AND (p.source->>'timelineRevision')::integer=$3 AND n.turn_number<=$4
            AND n.correction_revision=(p.source->>'narrationRevision')::integer
            AND encode(digest(n.effective_narration,'sha256'),'hex')=p.source->>'sourceHash'`,
        [scope.campaignId, scope.ownerUserId, boundary.timelineRevision, boundary.turnNumber])).rows[0];
        for (const detail of projected.details) {
          const superseded = new Set(detail.observations.map(item => item.supersedesObservationId).filter(Boolean));
          const fields = new Map<string, Set<string>>();
          for (const item of detail.observations) {
            if (item.mode !== "fact" || superseded.has(item.id) || item.field.startsWith("state.") || item.field === "story.goals") continue;
            const values = fields.get(item.field) ?? new Set<string>(); values.add(item.value); fields.set(item.field, values);
          }
          const seeded = projected.snapshot.characters.find((person) => person.id === detail.characterId)?.campaignProfile;
          for (const [field, values] of fields) {
            if (seeded && field === "appearance.description") continue;
            if (seeded && field !== "story.goals") {
              const [section, key] = field.split(".");
              const authored = (seeded as Record<string, any>)[section!]?.[key!];
              if (typeof authored === "string" && authored.trim()) continue;
            }
            if (values.size > 1 && !detail.overrides.some(item => item.field === field)) { conflicts++; reviewIds.add(detail.characterId); conflictIds.add(detail.characterId); addAttention(detail.characterId, 1, 1); }
          }
        }
        const levels = ["r1", "r2", "r3"];
        const context = options.castContextEnabled === true && !!enrollment && !!options.storyMemoryCapability
          && levels.indexOf(options.storyMemoryCapability) >= levels.indexOf(enrollment.capability);
        const value = { snapshot: projected.snapshot, reviewIds: [...reviewIds], conflictIds: [...conflictIds], attentionCounts, status: {
          revision: state.revision, boundary, capabilities: { editing: options.editingEnabled === true,
            discovery: options.discoveryEnabled === true, autoMatch: options.castAutoMatchEnabled === true && options.discoveryEnabled === true && options.editingEnabled === true, backfill: options.backfillEnabled === true,
            context }, contextDisabledReason: context ? null : "Story Memory or character context is unavailable.",
          counts: { identities, details, conflicts }, reviewDecisions: decisionCounts, changeToken: sha256(fingerprint), tracking, recovery } };
        statusCache.delete(cacheKey);
        statusCache.set(cacheKey, { fingerprint, value });
        if (statusCache.size > 32) statusCache.delete(statusCache.keys().next().value!);
        return value;
      });
    },
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
        const projected = await snapshotProjection(client, scope, campaign, state, boundary);
        const observations = projected.details.find((item) => item.characterId === id)?.observations ?? [];
        /* Retained events provide identity and attachment provenance. */
        const overrides = new Map<string, CastOverride>();
        const identityEvents: CastDetail["identityEvents"] = [];
        const events = (await client.query("SELECT id,effective_turn_number,payload,receipt,attachment FROM campaign_cast_events WHERE campaign_id=$1 AND owner_user_id=$2 AND effective_turn_number <= $3 ORDER BY sequence", [scope.campaignId, scope.ownerUserId, boundary.turnNumber])).rows.map((row) => eventSchema.parse(row));
        const attachmentProjection = projectCastAttachments(events, boundary.turnNumber);
        const autoMatches: CastDetail["autoMatches"] = [];
        for (const attachment of attachmentProjection.active.filter((item) => item.characterId === id)) {
          let validSource = true;
          for (const sourceRange of attachment.sourceRanges) {
            const sourceRow = (await client.query(`SELECT correction_revision,effective_narration FROM effective_turn_narrations
              WHERE turn_id=$1 AND campaign_id=$2 AND owner_user_id=$3`, [sourceRange.turnId, scope.campaignId, scope.ownerUserId])).rows[0];
            if (!sourceRow || sourceRow.correction_revision !== sourceRange.narrationRevision || sha256(sourceRow.effective_narration) !== sourceRange.sourceHash) validSource = false;
          }
          if (!validSource) continue;
          const range = attachment.sourceRanges[0]!;
          const row = (await client.query(`SELECT turn_number,correction_revision,effective_narration FROM effective_turn_narrations
            WHERE turn_id=$1 AND campaign_id=$2 AND owner_user_id=$3`, [range.turnId, scope.campaignId, scope.ownerUserId])).rows[0];
          if (!row || row.correction_revision !== range.narrationRevision || sha256(row.effective_narration) !== range.sourceHash) continue;
          const source = buildCastDiscoverySource({ scope, timelineRevision: boundary.timelineRevision, turnId: range.turnId, turnNumber: row.turn_number, narrationRevision: range.narrationRevision, narration: row.effective_narration });
          const quote = source.paragraphs.find((item) => item.id === range.paragraphId)?.text.slice(range.start, range.end);
          if (quote) autoMatches.push({ ...attachment, turnNumber: row.turn_number, quote });
        }
        for (const event of events) for (const { command, characterId } of event.payload) {
          if (command.kind === "mention" && command.kindOfMention !== "lexical" && command.characterId === id && !attachmentProjection.detachedEventIds.has(event.id)) {
            identityEvents.push({ eventId: event.id, effectiveTurnNumber: event.effective_turn_number,
              name: character.name, aliases: character.aliases, evidence: command.evidence });
          }
          if (command.kind === "create" && characterId === id || command.kind === "identity" && command.characterId === id) {
            identityEvents.push({ eventId: event.id, effectiveTurnNumber: event.effective_turn_number,
              name: command.name, aliases: command.aliases,
              evidence: command.kind === "create" && command.evidence ? command.evidence
                : { kind: "user", editId: event.id, effectiveTurnNumber: event.effective_turn_number } });
          }
          if (command.kind === "override" && command.characterId === id) overrides.set(command.field, { field: command.field, value: command.value, evidence: { kind: "user", editId: event.id, effectiveTurnNumber: event.effective_turn_number } });
          if (command.kind === "clear_override" && command.characterId === id) overrides.delete(command.field);
          if (command.kind === "edit_authored_profile" && command.characterId === id && command.restoreAuthoredGoals
            && character.originProfile?.seedEventId === command.seedEventId) overrides.delete("story.goals");
        }
        return { character, revision: value.revision, boundary, observations, overrides: [...overrides.values()], autoMatches, identityEvents, unresolvedCandidateIds: [],
          editorDestination: character.origin.kind === "protagonist" ? `/api/v1/campaigns/${scope.campaignId}/character-profile` : null };
      });
    },
    async initialize(rawScope) {
      return withTransaction(pool, (client) => initializeCastWithClient(client, rawScope));
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
        await refreshCastChronicleMetadata(client, scope, value);
        return value;
      });
    },
    async applyBatch(rawScope, rawBatch) {
      return withTransaction(pool, (client) => applyCastBatchWithClient(client, rawScope, rawBatch));
    }
  };
}
