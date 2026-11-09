import { reviewCastDetailSchema, reviewCastDetailResultSchema, type ReviewCastDetail } from "../../contracts/src/campaign-cast-discovery.js";
import { isSeededFixedCandidateHidden, validateCastFiction } from "../../domain/src/campaign-cast.js";
import { z } from "zod";
import { characterProfileSchema, playableCharacterSchema } from "../../contracts/src/world-library.js";
import { randomUUID } from "node:crypto";
import { castDiscoveryWorldIdentities } from "../../domain/src/campaign-cast-world-identities.js";
import { readFirstAppearanceDecision } from "./campaign-cast-first-appearance.js";
import { castFieldSchema, castScopeSchema, type CastScope, type CastEvidence } from "../../contracts/src/campaign-cast.js";
import { castCandidateQuerySchema, castCandidateListSchema, castCandidateResolutionSchema, castDiscoverySourceSchema,
  resolveCastCandidateSchema, type CastCandidateQuery, type ResolveCastCandidate } from "../../contracts/src/campaign-cast-discovery.js";
import { CampaignCastError } from "../../application/src/campaign-cast/ports.js";
import { buildCastDiscoverySource, canAcceptReviewedCastObservation, resolveCastDiscoveryEvidence } from "../../domain/src/campaign-cast-discovery.js";
import { normalizeEntityTerm } from "../../domain/src/entity-references.js";
import { sha256, stableStringify } from "../../domain/src/text.js";
import { initializeCastWithClient, applyCastBatchWithClient, seedCampaignCastWithClient } from "./campaign-cast-repository.js";
import { withTransaction, type DatabasePool } from "./pool.js";
import { pendingCastDetailSql } from "./campaign-cast-review-sql.js";

export function createCastCandidateRepository(pool: DatabasePool, editingEnabled: boolean, castPresetsEnabled = false) {
  return {
    async candidates(rawScope: CastScope, input: Partial<CastCandidateQuery> = {}) {
      const scope = castScopeSchema.parse(rawScope), query = castCandidateQuerySchema.parse(input);
      return withTransaction(pool, async (client) => {
        const cast = await initializeCastWithClient(client, scope);
        const hiddenFields: Record<string, string[]> = {};
        for (const person of cast.characters) {
          if (!person.campaignProfile) continue;
          const profile = characterProfileSchema.parse(person.campaignProfile);
          hiddenFields[person.id] = castFieldSchema.options.filter(field => isSeededFixedCandidateHidden(profile, field));
        }
        const visiblePending = `${pendingCastDetailSql} AND NOT COALESCE(
          ($11::jsonb -> (p.resolution_receipt #>> '{result,character,id}'))
          ? (p.proposal->'observations'->((item.value->>'index')::integer)->>'field'), false)`;
        const rows = (await client.query(`SELECT p.id,p.reason,p.proposal,p.source,p.resolution_receipt,p.detail_decisions,n.effective_narration,
          ARRAY(SELECT (pending.item->>'index')::integer FROM (${visiblePending}) pending) AS pending_indexes FROM campaign_cast_discovery_candidates p
          JOIN effective_turn_narrations n ON n.turn_id=(p.source->>'turnId')::uuid AND n.campaign_id=p.campaign_id AND n.owner_user_id=p.owner_user_id
          WHERE p.campaign_id=$1 AND p.owner_user_id=$2 AND p.status='pending' AND ($3::uuid IS NULL OR p.id>$3)
            AND (p.resolution_receipt IS NULL OR EXISTS (${visiblePending}))
            AND ($7::boolean=false OR (p.resolution_receipt IS NULL
              AND NOT (COALESCE(p.proposal->>'existingCharacterId','')=ANY($8::text[]))))
            AND ($9::boolean=false OR (p.resolution_receipt IS NOT NULL AND EXISTS (${visiblePending})))
            AND ($10::boolean=false OR p.resolution_receipt IS NOT NULL OR NOT (COALESCE(p.proposal->>'existingCharacterId','')=ANY($8::text[])))
            AND (p.source->>'timelineRevision')::integer=$4 AND n.turn_number<=$5
            AND n.correction_revision=(p.source->>'narrationRevision')::integer
            AND encode(digest(n.effective_narration,'sha256'),'hex')=p.source->>'sourceHash'
          ORDER BY p.id LIMIT $6`, [scope.campaignId, scope.ownerUserId, query.cursor ?? null, cast.boundary.timelineRevision,
          cast.boundary.turnNumber, query.limit + 1, query.view === "matches", cast.characters.filter(person => person.ignored).map(person => person.id), query.view === "details", query.view === "review", JSON.stringify(hiddenFields)])).rows;
        const candidates = rows.slice(0, query.limit).map((row) => {
          const saved = row.resolution_receipt ? castCandidateResolutionSchema.parse(row.resolution_receipt.result) : null;
          const pending = saved?.pendingObservations?.filter(item => row.pending_indexes.includes(item.index));
          const currentCharacter = saved ? cast.characters.find(person => person.id === saved.character.id) : undefined;
          const exactMatches = query.view === "review" && !saved ? cast.characters.filter(person =>
            [person.name, ...person.aliases].some(name => normalizeEntityTerm(name) === normalizeEntityTerm(row.proposal.name))) : [];
          const suggested = exactMatches.length === 1 && !exactMatches[0]!.ignored
            && (!row.proposal.existingCharacterId || row.proposal.existingCharacterId === exactMatches[0]!.id) ? exactMatches[0]!.id : undefined;
          return { id: row.id, reason: row.reason, ...(suggested ? { suggestedCharacterId: suggested } : {}),
            proposal: pending ? { ...row.proposal, observations: pending.map(item => row.proposal.observations[item.index]) } : row.proposal,
            ...(saved ? { resolvedCharacterId: saved.character.id, details: pending?.map(item => ({ observationIndex: item.index,
              field: row.proposal.observations[item.index].field, value: row.proposal.observations[item.index].value,
              quote: row.proposal.observations[item.index].quote, reason: item.reason,
              allowedActions: currentCharacter?.originProfile && !["story.goals", "state.location", "state.condition", "state.clothing", "appearance.description"].includes(row.proposal.observations[item.index].field)
                ? ["dismiss"] : currentCharacter?.origin.kind === "protagonist" ? ["dismiss"]
                : ["dismiss", "confirm", ...(canAcceptReviewedCastObservation(castDiscoverySourceSchema.parse(row.source), row.effective_narration, row.proposal.observations[item.index], item.reason) ? ["accept"] : [])], ...(query.view === "review" ? { canAcceptObservation: cast.characters.find(person => person.id === saved.character.id)?.origin.kind !== "protagonist" && canAcceptReviewedCastObservation(castDiscoverySourceSchema.parse(row.source), row.effective_narration, row.proposal.observations[item.index], item.reason) } : {}), sourceHash: row.source.sourceHash })) ?? [] } : {}),
            source: { turnId: row.source.turnId, turnNumber: row.source.turnNumber, narrationRevision: row.source.narrationRevision, ...(query.view === "review" ? { sourceHash: row.source.sourceHash } : {}) } };
        });
        return castCandidateListSchema.parse({ revision: cast.revision, boundary: cast.boundary, candidates,
          nextCursor: rows.length > query.limit ? candidates.at(-1)!.id : null });
      });
    },
    async resolveDetail(rawScope: CastScope, rawId: string, rawRequest: ReviewCastDetail) {
      const scope = castScopeSchema.parse(rawScope), id = z.uuid().parse(rawId), request = reviewCastDetailSchema.parse(rawRequest);
      return withTransaction(pool, async client => {
        let cast = await initializeCastWithClient(client, scope);
        if (!editingEnabled) throw new CampaignCastError("cast_editing_disabled");
        const row = (await client.query("SELECT * FROM campaign_cast_discovery_candidates WHERE id=$1 AND campaign_id=$2 AND owner_user_id=$3 FOR UPDATE", [id, scope.campaignId, scope.ownerUserId])).rows[0];
        if (!row) throw new CampaignCastError("cast_not_found");
        const source = castDiscoverySourceSchema.parse(row.source);
        const turn = (await client.query("SELECT turn_number,correction_revision,effective_narration FROM effective_turn_narrations WHERE turn_id=$1 AND campaign_id=$2 AND owner_user_id=$3", [source.turnId, scope.campaignId, scope.ownerUserId])).rows[0];
        if (row.status === "cancelled" || !turn || source.scope.campaignId !== scope.campaignId || source.scope.ownerUserId !== scope.ownerUserId
          || source.timelineRevision !== cast.boundary.timelineRevision || source.turnNumber > cast.boundary.turnNumber
          || turn.turn_number !== source.turnNumber || turn.correction_revision !== source.narrationRevision || sha256(turn.effective_narration) !== source.sourceHash || request.sourceHash !== source.sourceHash) throw new CampaignCastError("cast_revision_conflict");
        const requestHash = sha256(stableStringify({ id, request }));
        const decisions = row.detail_decisions as { observationIndex: number; idempotencyKey: string; requestHash: string; result: unknown }[];
        const prior = decisions.find(item => item.idempotencyKey === request.idempotencyKey);
        if (prior) {
          if (prior.requestHash !== requestHash) throw new CampaignCastError("cast_idempotency_conflict");
          return reviewCastDetailResultSchema.parse(prior.result);
        }
        const resolution = row.resolution_receipt ? castCandidateResolutionSchema.parse(row.resolution_receipt.result) : null;
        const character = cast.characters.find(item => item.id === resolution?.character.id);
        if (!character || !resolution?.pendingObservations?.some(item => item.index === request.observationIndex)
          || decisions.some(item => item.observationIndex === request.observationIndex)) throw new CampaignCastError("cast_invalid_request");
        if (character.origin.kind === "protagonist" && request.action !== "dismiss") throw new CampaignCastError("cast_protagonist_read_only");
        if (row.status !== "pending" || character.revision !== request.expectedCharacterRevision || cast.revision !== request.expectedCastRevision
          || stableStringify(cast.boundary) !== stableStringify(request.expectedBoundary)) throw new CampaignCastError("cast_revision_conflict");
        const stillPending = await client.query(`SELECT 1 FROM campaign_cast_discovery_candidates p
          WHERE p.id=$1 AND EXISTS (SELECT 1 FROM (${pendingCastDetailSql}) pending WHERE (pending.item->>'index')::integer=$2)`, [id, request.observationIndex]);
        if (!stillPending.rowCount) throw new CampaignCastError("cast_invalid_request");
        if ((await client.query("SELECT id FROM generation_jobs WHERE campaign_id=$1 AND owner_user_id=$2 AND status IN ('queued','replacement_queued','assessing','generating','validating','committing','recoverable') LIMIT 1", [scope.campaignId, scope.ownerUserId])).rows.length) throw new CampaignCastError("cast_generation_active");
        const observation = row.proposal.observations[request.observationIndex];
        if (isSeededFixedCandidateHidden(character.campaignProfile && characterProfileSchema.parse(character.campaignProfile), observation.field)) throw new CampaignCastError("cast_fixed_field_override", [{ path: observation.field, code: "fixed_field" }]);
        if (character.originProfile && request.action !== "dismiss" && !["story.goals", "state.location", "state.condition", "state.clothing", "appearance.description"].includes(observation.field)) throw new CampaignCastError("cast_fixed_field_override", [{ path: observation.field, code: "fixed_field" }]);
        let observationId: string | undefined;
        if (request.action === "accept") {
          const reason = resolution.pendingObservations.find(item => item.index === request.observationIndex)!.reason;
          if (!canAcceptReviewedCastObservation(source, turn.effective_narration, observation, reason)) throw new CampaignCastError("cast_invalid_request");
          const receipt = await applyCastBatchWithClient(client, scope, { boundary: cast.boundary, idempotencyKey: `detail:${id}:${sha256(request.idempotencyKey)}`,
            commands: [{ kind: "observe", characterId: character.id, field: observation.field, value: observation.value,
              mode: "fact", speakerCharacterId: null, supersedesObservationId: null,
              evidence: { kind: "turn", turnId: source.turnId, turnNumber: source.turnNumber, narrationRevision: source.narrationRevision,
                sourceHash: source.sourceHash, paragraphId: observation.paragraphId, quote: observation.quote } }] });
          observationId = receipt.observationIds[0];
          cast = await initializeCastWithClient(client, scope);
        }
        if (request.action === "confirm") {
          const value = request.confirmedValue ?? observation.value;
          try { validateCastFiction(value); } catch { throw new CampaignCastError("cast_invalid_request"); }
          await applyCastBatchWithClient(client, scope, { boundary: cast.boundary, idempotencyKey: `detail:${id}:${sha256(request.idempotencyKey)}`,
            commands: [{ kind: "override", characterId: character.id, field: observation.field, value }] });
          cast = await initializeCastWithClient(client, scope);
        }
        const result = reviewCastDetailResultSchema.parse({ character: cast.characters.find(item => item.id === character.id), revision: cast.revision,
          boundary: cast.boundary, candidateId: id, observationIndex: request.observationIndex, disposition: request.action, ...(observationId ? { observationId } : {}) });
        decisions.push({ observationIndex: request.observationIndex, idempotencyKey: request.idempotencyKey, requestHash, result });
        await client.query("UPDATE campaign_cast_discovery_candidates SET detail_decisions=$2,status=$3 WHERE id=$1 AND campaign_id=$4 AND owner_user_id=$5", [id, JSON.stringify(decisions),
          decisions.length >= resolution.pendingObservations.length ? "resolved" : "pending", scope.campaignId, scope.ownerUserId]);
        return result;
      });
    },
    async resolveCandidate(rawScope: CastScope, rawId: string, rawRequest: ResolveCastCandidate) {
      const scope = castScopeSchema.parse(rawScope), id = z.uuid().parse(rawId), request = resolveCastCandidateSchema.parse(rawRequest);
      return withTransaction(pool, async (client) => {
        let cast = await initializeCastWithClient(client, scope);
        if (!editingEnabled) throw new CampaignCastError("cast_editing_disabled");
        const row = (await client.query("SELECT * FROM campaign_cast_discovery_candidates WHERE id=$1 AND campaign_id=$2 AND owner_user_id=$3 FOR UPDATE",
          [id, scope.campaignId, scope.ownerUserId])).rows[0];
        if (!row) throw new CampaignCastError("cast_not_found");
        const source = castDiscoverySourceSchema.parse(row.source);
        const turn = (await client.query("SELECT turn_number,correction_revision,effective_narration FROM effective_turn_narrations WHERE turn_id=$1 AND campaign_id=$2 AND owner_user_id=$3",
          [source.turnId, scope.campaignId, scope.ownerUserId])).rows[0];
        if (row.status === "cancelled" || source.scope.campaignId !== scope.campaignId || source.scope.ownerUserId !== scope.ownerUserId
          || source.timelineRevision !== cast.boundary.timelineRevision || !turn || turn.turn_number !== source.turnNumber
          || source.turnNumber > cast.boundary.turnNumber || turn.correction_revision !== source.narrationRevision
          || sha256(turn.effective_narration) !== source.sourceHash) throw new CampaignCastError("cast_revision_conflict");
        const requestHash = sha256(stableStringify({ id, request }));
        if (row.resolution_receipt) {
          if (row.resolution_receipt.idempotencyKey !== request.idempotencyKey || row.resolution_receipt.requestHash !== requestHash) {
            throw new CampaignCastError("cast_idempotency_conflict");
          }
          return castCandidateResolutionSchema.parse(row.resolution_receipt.result);
        }
        if (row.status !== "pending" || cast.revision !== request.expectedCastRevision
          || stableStringify(cast.boundary) !== stableStringify(request.expectedBoundary)) throw new CampaignCastError("cast_revision_conflict");
        if ((await client.query(`SELECT id FROM generation_jobs WHERE campaign_id=$1 AND owner_user_id=$2
          AND status IN ('queued','replacement_queued','assessing','generating','validating','committing','recoverable') LIMIT 1`,
        [scope.campaignId, scope.ownerUserId])).rows.length) throw new CampaignCastError("cast_generation_active");
        const validated = resolveCastDiscoveryEvidence({ source, candidate: row.proposal, knownCharacters: cast.characters,
          characterId: request.action === "attach" ? request.characterId : null });
        const candidate = validated.candidate;
        if (!candidate) throw new CampaignCastError("cast_invalid_request");
        const evidence = (quote: { paragraphId: string; quote: string }): Extract<CastEvidence, { kind: "turn" }> => ({ kind: "turn",
          turnId: source.turnId, turnNumber: source.turnNumber, narrationRevision: source.narrationRevision, sourceHash: source.sourceHash, ...quote });
        const key = `candidate:${id}:${sha256(request.idempotencyKey)}`;
        let characterId = request.action === "attach" ? request.characterId : null;
        if (!characterId) {
          const pinned = (await client.query(`SELECT c.world_version_id,w.world_id,w.content FROM campaigns c JOIN world_versions w ON w.id=c.world_version_id AND w.owner_user_id=c.owner_user_id WHERE c.id=$1 AND c.owner_user_id=$2`, [scope.campaignId, scope.ownerUserId])).rows[0];
          const terms = [candidate.name, ...candidate.aliases].map(normalizeEntityTerm);
          const matches = castDiscoveryWorldIdentities(pinned.content).filter(person => [person.name, ...person.aliases].some(name => terms.includes(normalizeEntityTerm(name))));
          const roster = (Array.isArray(pinned.content?.playableCharacters) ? pinned.content.playableCharacters : []).map((entry: unknown) => playableCharacterSchema.safeParse(entry)).map((entry: ReturnType<typeof playableCharacterSchema.safeParse>) => entry.success ? entry.data : null);
          if (matches.length > 1 && castPresetsEnabled) throw new CampaignCastError("cast_invalid_request");
          const match = matches[0], index = match ? roster.findIndex((entry: ReturnType<typeof playableCharacterSchema.parse> | null) => entry?.id === match.entityId) : -1, entry = roster[index];
          if (entry) {
            const captured = row.job_id ? (await client.query("SELECT validation_summary->'worldIdentitySnapshot' AS snapshot FROM campaign_cast_discovery_receipts WHERE job_id=$1 AND chunk_ordinal=$2 AND campaign_id=$3 AND owner_user_id=$4", [row.job_id, row.chunk_ordinal, scope.campaignId, scope.ownerUserId])).rows[0]?.snapshot : null;
            const oldIdentities = Array.isArray(captured?.identities) ? captured.identities.filter((person: { entityId?: unknown }) => person.entityId === entry.id) : [];
            const sourceWorld = captured?.worldVersionId ? (await client.query("SELECT world_id FROM world_versions WHERE id=$1 AND owner_user_id=$2", [captured.worldVersionId, scope.ownerUserId])).rows[0]?.world_id : undefined;
            const decision = await readFirstAppearanceDecision(client, scope, { frozenPermission: true, livePermission: castPresetsEnabled,
              sourceWorldId: sourceWorld ?? "", rosterCharacterId: entry.id,
              identityStillSupported: oldIdentities.length === 1 && stableStringify(oldIdentities[0]) === stableStringify(match),
              unique: matches.length === 1, detached: row.reason === "detached_attachment" });
            if (decision === "review") throw new CampaignCastError("cast_invalid_request");
            if (decision === "protagonist") characterId = cast.characters.find(person => person.origin.kind === "protagonist")?.id ?? null;
            if (decision === "seed") {
              const represented = cast.characters.filter(person => person.origin.kind === "world" && person.origin.entityId === entry.id || person.originProfile?.evidence.kind === "world" && person.originProfile.entityId === entry.id);
              if (represented.length) throw new CampaignCastError("cast_invalid_request");
              characterId = randomUUID();
              const citation = candidate.identityEvidence[0]!;
              const narrated = buildCastDiscoverySource({ scope, timelineRevision: source.timelineRevision, turnId: source.turnId, turnNumber: source.turnNumber,
                narrationRevision: source.narrationRevision, narration: turn.effective_narration }).paragraphs.find(item => item.id === citation.paragraphId);
              const start = narrated?.text.indexOf(citation.quote) ?? -1;
              if (start < 0) throw new CampaignCastError("cast_invalid_request");
              const receipt = await seedCampaignCastWithClient(client, scope, { characterId, worldVersionId: pinned.world_version_id, entry, index,
                boundary: cast.boundary, idempotencyKey: `${key}:seed`, narrationAlias: candidate.name,
                attachment: { basis: "unique_world_name", sourceRanges: [{ turnId: source.turnId, narrationRevision: source.narrationRevision, sourceHash: source.sourceHash, paragraphId: citation.paragraphId, start, end: start + citation.quote.length }] }, evidenceCommands: [
                  { kind: "mention", characterId, evidence: evidence(candidate.identityEvidence[0]!) },
                  ...candidate.observations.map(observation => ({ kind: "observe" as const, characterId: characterId!, field: observation.field,
                    value: observation.value, mode: observation.mode, speakerCharacterId: observation.speakerCharacterId,
                    evidence: evidence({ paragraphId: observation.paragraphId, quote: observation.quote }), supersedesObservationId: null }))
                ] });
              cast = await initializeCastWithClient(client, scope);
              const result = castCandidateResolutionSchema.parse({ candidateId: id, character: cast.characters.find(person => person.id === characterId),
                revision: cast.revision, boundary: cast.boundary, observationIds: receipt.observationIds, pendingObservations: validated.pendingObservations });
              await client.query("UPDATE campaign_cast_discovery_candidates SET status=$3,resolution_receipt=$2 WHERE id=$1 AND campaign_id=$4 AND owner_user_id=$5",
                [id, JSON.stringify({ idempotencyKey: request.idempotencyKey, requestHash, result }), validated.pendingObservations.length ? "pending" : "resolved", scope.campaignId, scope.ownerUserId]);
              return result;
            }
          }
        }
        if (!characterId) {
          const receipt = await applyCastBatchWithClient(client, scope, { boundary: cast.boundary, idempotencyKey: `${key}:create`,
            commands: [{ kind: "create", name: candidate.name, aliases: candidate.aliases, origin: { kind: "discovered" }, evidence: evidence(candidate.identityEvidence[0]!) }] });
          characterId = receipt.characterIds[0]!;
        }
        const receipt = await applyCastBatchWithClient(client, scope, { boundary: cast.boundary, idempotencyKey: `${key}:evidence`, commands: [
          { kind: "mention", characterId, evidence: evidence(candidate.identityEvidence[0]!) },
          ...candidate.observations.map((observation) => ({ kind: "observe" as const, characterId: characterId!, field: observation.field,
            value: observation.value, mode: observation.mode, speakerCharacterId: observation.speakerCharacterId,
            evidence: evidence({ paragraphId: observation.paragraphId, quote: observation.quote }), supersedesObservationId: null }))
        ] });
        cast = await initializeCastWithClient(client, scope);
        const result = castCandidateResolutionSchema.parse({ candidateId: id, character: cast.characters.find((person) => person.id === characterId),
          revision: cast.revision, boundary: cast.boundary, observationIds: receipt.observationIds, pendingObservations: validated.pendingObservations });
        await client.query("UPDATE campaign_cast_discovery_candidates SET status=$3,resolution_receipt=$2 WHERE id=$1 AND campaign_id=$4 AND owner_user_id=$5",
          [id, JSON.stringify({ idempotencyKey: request.idempotencyKey, requestHash, result }), validated.pendingObservations.length ? "pending" : "resolved", scope.campaignId, scope.ownerUserId]);
        return result;
      });
    }
  };
}
