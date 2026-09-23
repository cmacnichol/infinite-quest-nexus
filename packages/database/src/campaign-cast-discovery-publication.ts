import { castDiscoveryIdentitySnapshotSchema, type CastDiscoveryIdentitySnapshot } from "../../contracts/src/campaign-cast-discovery.js";
import type { CastEvidence, CastScope } from "../../contracts/src/campaign-cast.js";
import { validateCastDiscovery } from "../../domain/src/campaign-cast-discovery.js";
import { castDiscoveryWorldIdentities } from "../../domain/src/campaign-cast-world-identities.js";
import { stableStringify } from "../../domain/src/text.js";
import { applyCastBatchWithClient, initializeCastWithClient } from "./campaign-cast-repository.js";
import type { CastDiscoveryClaim } from "./campaign-cast-job-repository.js";
import type { DatabaseClient } from "./pool.js";

/** Capture once per chunk, before the first physical extraction attempt. */
export async function captureCastDiscoveryIdentities(client: DatabaseClient, scope: CastScope): Promise<CastDiscoveryIdentitySnapshot> {
  const cast = await initializeCastWithClient(client, scope);
  const world = (await client.query(`SELECT c.world_version_id,w.content FROM campaigns c JOIN world_versions w ON w.id=c.world_version_id AND w.owner_user_id=c.owner_user_id
    WHERE c.id=$1 AND c.owner_user_id=$2`, [scope.campaignId, scope.ownerUserId])).rows[0];
  const worldCharacters = castDiscoveryWorldIdentities(world.content);
  return castDiscoveryIdentitySnapshotSchema.parse({ revision: cast.revision, characters: cast.characters, worldVersionId: world.world_version_id, worldCharacters });
}

export async function applyValidatedCastDiscovery(client: DatabaseClient, claim: CastDiscoveryClaim) {
  if (!claim.output) throw new Error("Discovery output is missing.");
  const captured = claim.identities;
  const first = validateCastDiscovery({ source: claim.source, output: claim.output, knownCharacters: captured.characters,
    worldCharacters: captured.worldCharacters, worldVersionId: captured.worldVersionId });
  let current = await initializeCastWithClient(client, claim.scope);
  const rejected = [...first.rejected], unresolved = [...first.unresolved];
  const characterIds: string[] = [], observationIds: string[] = [];
  let accepted = 0;
  const evidence = (citation: { paragraphId: string; quote: string }): Extract<CastEvidence, { kind: "turn" }> => ({ kind: "turn", turnId: claim.source.turnId,
    turnNumber: claim.source.turnNumber, narrationRevision: claim.source.narrationRevision, sourceHash: claim.source.sourceHash,
    paragraphId: citation.paragraphId, quote: citation.quote });
  for (const candidate of first.accepted) {
    const { resolvedOrigin, ...proposal } = candidate;
    const prior = captured.characters.find((person) => person.id === candidate.existingCharacterId);
    const now = current.characters.find((person) => person.id === candidate.existingCharacterId);
    if (prior && (!now || stableStringify([prior.name, prior.aliases, prior.origin]) !== stableStringify([now.name, now.aliases, now.origin]))) {
      unresolved.push({ candidate: proposal, code: "identity_changed" }); continue;
    }
    // Manual value overrides do not erase old evidence or turn an identity hint into a new model assertion.
    // Recheck identity collisions against today's roster, retaining the captured hint values for the same IDs.
    const reconciled = current.characters.map((person) => ({ ...person,
      profile: captured.characters.find((old) => old.id === person.id)?.profile ?? person.profile }));
    const checked = validateCastDiscovery({ source: claim.source, output: { version: 1, characters: [proposal] }, knownCharacters: reconciled,
      worldCharacters: captured.worldCharacters, worldVersionId: captured.worldVersionId });
    if (!checked.accepted.length) { rejected.push(...checked.rejected); unresolved.push(...checked.unresolved); continue; }
    let characterId = candidate.existingCharacterId;
    if (!characterId && resolvedOrigin.kind === "world") {
      characterId = current.characters.find((person) => person.origin.kind === "world"
        && person.origin.worldVersionId === resolvedOrigin.worldVersionId && person.origin.entityId === resolvedOrigin.entityId)?.id ?? null;
    }
    const key = `discovery:${claim.id}:${claim.chunkOrdinal}:${candidate.localKey}`;
    if (!characterId) {
      const receipt = await applyCastBatchWithClient(client, claim.scope, { boundary: current.boundary, idempotencyKey: `${key}:identity`,
        commands: [{ kind: "create", name: candidate.name, aliases: candidate.aliases, origin: resolvedOrigin, evidence: evidence(candidate.identityEvidence[0]!) }] });
      characterId = receipt.characterIds[0]!; characterIds.push(characterId);
    }
    const receipt = await applyCastBatchWithClient(client, claim.scope, { boundary: current.boundary, idempotencyKey: `${key}:observations`, commands: [
      { kind: "mention", characterId, evidence: evidence(candidate.identityEvidence[0]!) },
      ...candidate.observations.map((observation) => ({ kind: "observe" as const, characterId: characterId!, field: observation.field, value: observation.value,
        mode: observation.mode, speakerCharacterId: observation.speakerCharacterId, evidence: evidence(observation), supersedesObservationId: null }))
    ] });
    observationIds.push(...receipt.observationIds);
    accepted++;
    current = await initializeCastWithClient(client, claim.scope);
  }
  for (const item of unresolved) {
    await client.query(`INSERT INTO campaign_cast_discovery_candidates(owner_user_id,campaign_id,job_id,chunk_ordinal,local_key,source,proposal,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(job_id,chunk_ordinal,local_key) DO NOTHING`,
    [claim.scope.ownerUserId, claim.scope.campaignId, claim.id, claim.chunkOrdinal, item.candidate.localKey, JSON.stringify(claim.source), JSON.stringify(item.candidate), item.code]);
  }
  return { characterIds, observationIds, validationSummary: { accepted, unresolved: unresolved.length, rejected } };
}
