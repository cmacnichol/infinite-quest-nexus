import { castDiscoveryIdentitySnapshotSchema, type CastDiscoveryIdentitySnapshot } from "../../contracts/src/campaign-cast-discovery.js";
import type { CastCharacter, CastEvidence, CastScope } from "../../contracts/src/campaign-cast.js";
import { buildCastDiscoverySource, validateCastDiscovery } from "../../domain/src/campaign-cast-discovery.js";
import { castDiscoveryCharacterHints, castDiscoveryWorldIdentities } from "../../domain/src/campaign-cast-world-identities.js";
import { projectCastFictionText } from "../../domain/src/character-fiction-authority.js";
import { normalizeEntityTerm } from "../../domain/src/entity-references.js";
import { stableStringify } from "../../domain/src/text.js";
import { randomUUID } from "node:crypto";
import { playableCharacterSchema } from "../../contracts/src/world-library.js";
import { readFirstAppearanceDecision } from "./campaign-cast-first-appearance.js";
import { applyCastBatchWithClient, initializeCastWithClient, seedCampaignCastWithClient } from "./campaign-cast-repository.js";
import { refreshCastChronicleMetadata } from "./campaign-cast-chronicle-metadata.js";
import type { CastDiscoveryClaim } from "./campaign-cast-job-repository.js";
import type { DatabaseClient } from "./pool.js";

export function compactCastDiscoveryCharacters(cast: CastCharacter[]) {
  const seedActivations = cast.flatMap(person => person.originProfile ? [{ characterId: person.id,
    seedEventId: person.originProfile.seedEventId, worldVersionId: person.originProfile.worldVersionId, entityId: person.originProfile.entityId }] : []);
  const characters = cast.map(({ originProfile: _origin, campaignProfile: _campaign, fieldSources: _sources, ...person }) => ({ ...person,
    name: projectCastFictionText(person.name, 200) || "Unnamed character",
    aliases: person.aliases.map(alias => projectCastFictionText(alias, 200)).filter(Boolean),
    profile: Object.fromEntries(Object.entries(person.profile).filter(([field]) => ["identity.pronouns", "story.role", "appearance.description"].includes(field))
      .map(([field, value]) => [field, projectCastFictionText(value)]).filter(([, value]) => value && !/\b(?:score|modifier|difficulty|target)\s*:?\s*[+-]?\d/iu.test(value))) }));
  return { characters, identityHints: castDiscoveryCharacterHints(cast), seedActivations };
}

/** Capture once per chunk, before the first physical extraction attempt. */
export async function captureCastDiscoveryIdentities(client: DatabaseClient, scope: CastScope): Promise<CastDiscoveryIdentitySnapshot> {
  const cast = await initializeCastWithClient(client, scope);
  const world = (await client.query(`SELECT c.world_version_id,c.selected_character_id,c.selected_character_world_id,w.world_id,w.content FROM campaigns c JOIN world_versions w ON w.id=c.world_version_id AND w.owner_user_id=c.owner_user_id
    WHERE c.id=$1 AND c.owner_user_id=$2`, [scope.campaignId, scope.ownerUserId])).rows[0];
  const origins = cast.characters.flatMap(person => [
    ...(person.origin.kind === "world" ? [{ characterId: person.id, worldVersionId: person.origin.worldVersionId, entityId: person.origin.entityId }] : []),
    ...(person.originProfile ? [{ characterId: person.id, worldVersionId: person.originProfile.worldVersionId, entityId: person.originProfile.entityId }] : []),
    ...(person.origin.kind === "protagonist" && (world.selected_character_world_id === null || world.selected_character_world_id === world.world_id) && world.selected_character_id
      ? [{ characterId: person.id, worldVersionId: world.world_version_id as string, entityId: world.selected_character_id as string }] : [])
  ]);
  const versions = [...new Set(origins.map(origin => origin.worldVersionId))];
  const scopedVersions = versions.length ? (await client.query<{ id: string }>(
    "SELECT id FROM world_versions WHERE owner_user_id=$1 AND world_id=$2 AND id=ANY($3::uuid[])",
    [scope.ownerUserId, world.world_id, versions])).rows : [];
  const sameWorldVersions = new Set(scopedVersions.map(version => version.id));
  const represented = origins.filter(origin => sameWorldVersions.has(origin.worldVersionId));
  const allWorldCharacters = castDiscoveryWorldIdentities(world.content);
  const worldCharacters = allWorldCharacters.filter(person => !represented.some(origin => origin.entityId === person.entityId));
  const representedWorldCharacters = allWorldCharacters.flatMap(person => [...new Set(represented.filter(origin => origin.entityId === person.entityId).map(origin => origin.characterId))]
    .map(characterId => ({ ...person, characterId })));
  return castDiscoveryIdentitySnapshotSchema.parse({ revision: cast.revision, ...compactCastDiscoveryCharacters(cast.characters), worldVersionId: world.world_version_id, worldCharacters, representedWorldCharacters });
}

export async function applyValidatedCastDiscovery(client: DatabaseClient, claim: CastDiscoveryClaim, livePresetsEnabled = false) {
  if (!claim.output) throw new Error("Discovery output is missing.");
  const row = (await client.query("SELECT effective_narration,correction_revision FROM effective_turn_narrations WHERE turn_id=$1 AND campaign_id=$2 AND owner_user_id=$3", [claim.source.turnId, claim.scope.campaignId, claim.scope.ownerUserId])).rows[0];
  if (!row || row.correction_revision !== claim.source.narrationRevision) throw new Error("Discovery source changed.");
  const fullSource = buildCastDiscoverySource({ ...claim.source, narration: row.effective_narration });
  if (fullSource.sourceHash !== claim.source.sourceHash) throw new Error("Discovery source changed.");
  const sourceParagraphId = (id: string) => id.replace(/\.s\d+$/u, "");
  const captured = claim.identities;
  const identityPolicy = claim.execution.admission?.identityPolicy ?? "strict";
  const validationWorldCharacters = [...captured.worldCharacters, ...(captured.representedWorldCharacters ?? [])];
  const first = validateCastDiscovery({ source: claim.source, output: claim.output, knownCharacters: captured.characters,
    worldCharacters: validationWorldCharacters, worldVersionId: captured.worldVersionId, identityPolicy, identityHints: captured.identityHints });
  let current = await initializeCastWithClient(client, claim.scope);
  const pinned = (await client.query(`SELECT c.world_version_id,w.world_id,w.content FROM campaigns c JOIN world_versions w ON w.id=c.world_version_id AND w.owner_user_id=c.owner_user_id WHERE c.id=$1 AND c.owner_user_id=$2`, [claim.scope.campaignId, claim.scope.ownerUserId])).rows[0];
  const capturedWorld = (await client.query("SELECT world_id FROM world_versions WHERE id=$1 AND owner_user_id=$2", [captured.worldVersionId, claim.scope.ownerUserId])).rows[0];
  const roster = (Array.isArray(pinned.content?.playableCharacters) ? pinned.content.playableCharacters : []).map((entry: unknown) => playableCharacterSchema.safeParse(entry)).map((entry: ReturnType<typeof playableCharacterSchema.safeParse>) => entry.success ? entry.data : null);
  const currentWorldIdentities = castDiscoveryWorldIdentities(pinned.content);
  const rejected = [...first.rejected], unresolved = [...first.unresolved];
  const characterIds: string[] = [], observationIds: string[] = [];
  let accepted = 0;
  const evidence = (citation: { paragraphId: string; quote: string }): Extract<CastEvidence, { kind: "turn" }> => ({ kind: "turn", turnId: claim.source.turnId,
    turnNumber: claim.source.turnNumber, narrationRevision: claim.source.narrationRevision, sourceHash: claim.source.sourceHash,
    paragraphId: sourceParagraphId(citation.paragraphId), quote: citation.quote });
  for (const candidate of first.accepted) {
    const { resolvedOrigin, identityBasis, ...proposal } = candidate;
    const representedId = resolvedOrigin.kind === "world" ? captured.representedWorldCharacters?.find(person => person.entityId === resolvedOrigin.entityId)?.characterId : undefined;
    if (resolvedOrigin.kind === "world" && captured.worldVersionId !== pinned.world_version_id) {
      const before = validationWorldCharacters.filter(person => person.entityId === resolvedOrigin.entityId).map(person => ({ entityId: person.entityId, name: person.name, aliases: person.aliases, ...(person.identityHints ? { identityHints: person.identityHints } : {}) }));
      const after = currentWorldIdentities.filter(person => person.entityId === resolvedOrigin.entityId);
      const terms = [candidate.name, ...candidate.aliases].map(normalizeEntityTerm);
      const collisions = currentWorldIdentities.filter(person => [person.name, ...person.aliases].some(name => terms.includes(normalizeEntityTerm(name))));
      if (capturedWorld?.world_id !== pinned.world_id || before.length !== 1 || after.length !== 1 || collisions.length !== 1 || stableStringify(before[0]) !== stableStringify(after[0])) {
        unresolved.push({ candidate: proposal, code: "identity_changed" }); continue;
      }
    }
    const matchedId = candidate.existingCharacterId ?? representedId;
    const prior = captured.characters.find((person) => person.id === matchedId);
    const now = current.characters.find((person) => person.id === matchedId);
    const capturedSeed = captured.seedActivations?.find(item => item.characterId === prior?.id)?.seedEventId ?? prior?.originProfile?.seedEventId;
    if (prior && (!now || stableStringify([prior.name, prior.aliases, prior.origin, capturedSeed]) !== stableStringify([now.name, now.aliases, now.origin, now.originProfile?.seedEventId]))) {
      unresolved.push({ candidate: proposal, code: "identity_changed" }); continue;
    }
    // Manual value overrides do not erase old evidence or turn an identity hint into a new model assertion.
    // Recheck identity collisions against today's roster, retaining the captured hint values for the same IDs.
    const reconciled = current.characters.map((person) => ({ ...person,
      profile: captured.characters.find((old) => old.id === person.id)?.profile ?? person.profile }));
    const checked = validateCastDiscovery({ source: claim.source, output: { version: 1, characters: [proposal] }, knownCharacters: reconciled,
      worldCharacters: validationWorldCharacters, worldVersionId: captured.worldVersionId, identityPolicy, identityHints: captured.identityHints });
    if (!checked.accepted.length) { rejected.push(...checked.rejected); unresolved.push(...checked.unresolved); continue; }
    let characterId = candidate.existingCharacterId;
    if (!characterId && resolvedOrigin.kind === "world") {
      characterId = current.characters.find((person) => person.id === representedId || (person.origin.kind === "world"
        && person.origin.worldVersionId === resolvedOrigin.worldVersionId && person.origin.entityId === resolvedOrigin.entityId))?.id ?? null;
    }
    const automatic = identityBasis === "unique_name" || identityBasis === "unique_world_name";
    const sourceRanges = candidate.identityEvidence.flatMap((citation) => {
      const paragraph = fullSource.paragraphs.find((item) => item.id === sourceParagraphId(citation.paragraphId));
      const start = paragraph?.text.indexOf(citation.quote) ?? -1;
      if (!paragraph || start < 0 || paragraph.text.indexOf(citation.quote, start + 1) !== -1) return [];
      return [{ turnId: claim.source.turnId, narrationRevision: claim.source.narrationRevision,
        sourceHash: claim.source.sourceHash, paragraphId: sourceParagraphId(citation.paragraphId), start, end: start + citation.quote.length }];
    });
    if (automatic && sourceRanges.length !== candidate.identityEvidence.length) {
      unresolved.push({ candidate: proposal, code: "identity_changed" }); continue;
    }
    const key = `discovery:${claim.id}:${claim.chunkOrdinal}:${candidate.localKey}`;
    if (!characterId && resolvedOrigin.kind === "world") {
      const index = roster.findIndex((entry: ReturnType<typeof playableCharacterSchema.parse> | null) => entry?.id === resolvedOrigin.entityId), entry = roster[index];
      if (entry) {
        const old = validationWorldCharacters.filter(person => person.entityId === entry.id);
        const nowIdentities = currentWorldIdentities.filter(person => person.entityId === entry.id);
        const detached = Boolean((await client.query(`SELECT 1 FROM campaign_cast_events seed JOIN campaign_cast_events undo ON undo.campaign_id=seed.campaign_id AND undo.owner_user_id=seed.owner_user_id
          WHERE seed.campaign_id=$1 AND seed.owner_user_id=$2 AND seed.attachment IS NOT NULL
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(seed.payload) p WHERE p->'command'->>'kind'='seed_profile' AND p->'command'->>'entityId'=$3)
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(undo.payload) p WHERE p->'command'->>'kind'='detach' AND p->'command'->>'eventId'=seed.id::text) LIMIT 1`, [claim.scope.campaignId, claim.scope.ownerUserId, entry.id])).rowCount);
        const decision = await readFirstAppearanceDecision(client, claim.scope, { frozenPermission: claim.execution.admission?.castPresetsEnabled === true,
          livePermission: livePresetsEnabled, sourceWorldId: capturedWorld?.world_id ?? "", rosterCharacterId: entry.id,
          identityStillSupported: old.length === 1 && nowIdentities.length === 1 && stableStringify(old[0]) === stableStringify(nowIdentities[0]),
          unique: nowIdentities.length === 1, detached });
        if (decision === "review") { unresolved.push({ candidate: proposal, code: "identity_changed" }); continue; }
        if (decision === "protagonist") { characterId = current.characters.find(person => person.origin.kind === "protagonist")?.id ?? null; if (!characterId) { unresolved.push({ candidate: proposal, code: "identity_changed" }); continue; } }
        if (decision === "seed") {
          if (sourceRanges.length !== candidate.identityEvidence.length) { unresolved.push({ candidate: proposal, code: "identity_changed" }); continue; }
          characterId = randomUUID();
          const receipt = await seedCampaignCastWithClient(client, claim.scope, { characterId, worldVersionId: pinned.world_version_id, entry, index, boundary: current.boundary,
            idempotencyKey: `${key}:seed`, narrationAlias: candidate.name,
            attachment: { basis: "unique_world_name", sourceRanges }, evidenceCommands: [
              { kind: "mention", characterId, evidence: evidence(candidate.identityEvidence[0]!) },
              ...candidate.observations.map(observation => ({ kind: "observe" as const, characterId: characterId!, field: observation.field, value: observation.value,
                mode: observation.mode, speakerCharacterId: observation.speakerCharacterId, evidence: evidence(observation), supersedesObservationId: null }))
            ] });
          characterIds.push(characterId); observationIds.push(...receipt.observationIds); accepted++;
          current = await initializeCastWithClient(client, claim.scope); continue;
        }
      } else if (livePresetsEnabled && claim.execution.admission?.castPresetsEnabled) { unresolved.push({ candidate: proposal, code: "identity_changed" }); continue; }
    }
    if (!characterId) {
      const receipt = await applyCastBatchWithClient(client, claim.scope, { boundary: current.boundary, idempotencyKey: `${key}:identity`,
        commands: [{ kind: "create", name: candidate.name, aliases: candidate.aliases, origin: resolvedOrigin, evidence: evidence(candidate.identityEvidence[0]!) }] },
      { deferMetadataRefresh: true });
      characterId = receipt.characterIds[0]!; characterIds.push(characterId);
    }
    const receipt = await applyCastBatchWithClient(client, claim.scope, { boundary: current.boundary, idempotencyKey: `${key}:observations`, commands: [
      { kind: "mention", characterId, evidence: evidence(candidate.identityEvidence[0]!) },
      ...candidate.observations.map((observation) => ({ kind: "observe" as const, characterId: characterId!, field: observation.field, value: observation.value,
        mode: observation.mode, speakerCharacterId: observation.speakerCharacterId, evidence: evidence(observation), supersedesObservationId: null }))
    ] }, automatic ? { attachment: { characterId, basis: identityBasis, sourceRanges } } : {});
    observationIds.push(...receipt.observationIds);
    accepted++;
    current = await initializeCastWithClient(client, claim.scope);
  }
  // Refresh once using the complete roster, so shared aliases remain ambiguous.
  if (characterIds.length) await refreshCastChronicleMetadata(client, claim.scope, current);
  for (const item of unresolved) {
    await client.query(`INSERT INTO campaign_cast_discovery_candidates(owner_user_id,campaign_id,job_id,chunk_ordinal,local_key,source,proposal,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(job_id,chunk_ordinal,local_key) DO NOTHING`,
    [claim.scope.ownerUserId, claim.scope.campaignId, claim.id, claim.chunkOrdinal, item.candidate.localKey, JSON.stringify(claim.source), JSON.stringify(item.candidate), item.code]);
  }
  return { characterIds, observationIds, validationSummary: { accepted, unresolved: unresolved.length, rejected,
    worldIdentitySnapshot: { worldVersionId: captured.worldVersionId, identities: validationWorldCharacters.map(person => ({ entityId: person.entityId,
      name: person.name, aliases: person.aliases, ...(person.identityHints ? { identityHints: person.identityHints } : {}) })) } } };
}
