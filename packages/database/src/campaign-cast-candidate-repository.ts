import { z } from "zod";
import { castScopeSchema, type CastScope, type CastEvidence } from "../../contracts/src/campaign-cast.js";
import { castCandidateQuerySchema, castCandidateListSchema, castCandidateResolutionSchema, castDiscoverySourceSchema,
  resolveCastCandidateSchema, type CastCandidateQuery, type ResolveCastCandidate } from "../../contracts/src/campaign-cast-discovery.js";
import { CampaignCastError } from "../../application/src/campaign-cast/ports.js";
import { resolveCastDiscoveryEvidence } from "../../domain/src/campaign-cast-discovery.js";
import { sha256, stableStringify } from "../../domain/src/text.js";
import { initializeCastWithClient, applyCastBatchWithClient } from "./campaign-cast-repository.js";
import { withTransaction, type DatabasePool } from "./pool.js";

export function createCastCandidateRepository(pool: DatabasePool, editingEnabled: boolean) {
  return {
    async candidates(rawScope: CastScope, input: Partial<CastCandidateQuery> = {}) {
      const scope = castScopeSchema.parse(rawScope), query = castCandidateQuerySchema.parse(input);
      return withTransaction(pool, async (client) => {
        const cast = await initializeCastWithClient(client, scope);
        const rows = (await client.query(`SELECT p.id,p.reason,p.proposal,p.source,p.resolution_receipt FROM campaign_cast_discovery_candidates p
          JOIN effective_turn_narrations n ON n.turn_id=(p.source->>'turnId')::uuid AND n.campaign_id=p.campaign_id AND n.owner_user_id=p.owner_user_id
          WHERE p.campaign_id=$1 AND p.owner_user_id=$2 AND p.status='pending' AND ($3::uuid IS NULL OR p.id>$3)
            AND ($7::boolean=false OR (p.resolution_receipt IS NULL
              AND NOT (COALESCE(p.proposal->>'existingCharacterId','')=ANY($8::text[]))))
            AND (p.source->>'timelineRevision')::integer=$4 AND n.turn_number<=$5
            AND n.correction_revision=(p.source->>'narrationRevision')::integer
            AND encode(digest(n.effective_narration,'sha256'),'hex')=p.source->>'sourceHash'
          ORDER BY p.id LIMIT $6`, [scope.campaignId, scope.ownerUserId, query.cursor ?? null, cast.boundary.timelineRevision,
          cast.boundary.turnNumber, query.limit + 1, query.view === "matches", cast.characters.filter(person => person.ignored).map(person => person.id)])).rows;
        const candidates = rows.slice(0, query.limit).map((row) => {
          const saved = row.resolution_receipt ? castCandidateResolutionSchema.parse(row.resolution_receipt.result) : null;
          const pending = saved?.pendingObservations;
          return { id: row.id, reason: row.reason,
            proposal: pending ? { ...row.proposal, observations: pending.map(item => row.proposal.observations[item.index]) } : row.proposal,
            ...(saved ? { resolvedCharacterId: saved.character.id } : {}),
            source: { turnId: row.source.turnId, turnNumber: row.source.turnNumber, narrationRevision: row.source.narrationRevision } };
        });
        return castCandidateListSchema.parse({ revision: cast.revision, boundary: cast.boundary, candidates,
          nextCursor: rows.length > query.limit ? candidates.at(-1)!.id : null });
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
        await client.query("UPDATE campaign_cast_discovery_candidates SET status=$3,resolution_receipt=$2 WHERE id=$1",
          [id, JSON.stringify({ idempotencyKey: request.idempotencyKey, requestHash, result }), validated.pendingObservations.length ? "pending" : "resolved"]);
        return result;
      });
    }
  };
}
