import { type CastScope, type CastSnapshot } from "../../contracts/src/campaign-cast.js";
import { isSeededFixedCandidateHidden } from "../../domain/src/campaign-cast.js";
import { characterProfileSchema } from "../../contracts/src/world-library.js";
import { pendingCastDetailSql } from "./campaign-cast-review-sql.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";

/** Read only actionable candidates against their retained, current narration evidence. */
export async function currentCastReviewCandidates(client: DatabaseClient | DatabasePool, scope: CastScope, snapshot: CastSnapshot, jobsOnly = false) {
  const rows = (await client.query(`SELECT p.id,p.proposal,p.resolution_receipt,
    ARRAY(SELECT (pending.item->>'index')::integer FROM (${pendingCastDetailSql}) pending) AS pending_indexes
    FROM campaign_cast_discovery_candidates p
    JOIN effective_turn_narrations n ON n.turn_id=(p.source->>'turnId')::uuid AND n.campaign_id=p.campaign_id AND n.owner_user_id=p.owner_user_id
    LEFT JOIN campaign_cast_discovery_jobs j ON j.id=p.job_id AND j.campaign_id=p.campaign_id AND j.owner_user_id=p.owner_user_id
    WHERE p.campaign_id=$1 AND p.owner_user_id=$2 AND p.status='pending'
      AND ($5::boolean=false OR (j.id IS NOT NULL AND j.status<>'cancelled' AND j.turn_id=n.turn_id
        AND j.timeline_revision=$3 AND j.turn_number=n.turn_number AND j.narration_revision=n.correction_revision
        AND j.source_hash=encode(digest(n.effective_narration,'sha256'),'hex')))
      AND (p.source->>'timelineRevision')::integer=$3 AND n.turn_number=(p.source->>'turnNumber')::integer AND n.turn_number<=$4
      AND n.correction_revision=(p.source->>'narrationRevision')::integer
      AND encode(digest(n.effective_narration,'sha256'),'hex')=p.source->>'sourceHash'`,
  [scope.campaignId, scope.ownerUserId, snapshot.boundary.timelineRevision, snapshot.boundary.turnNumber, jobsOnly])).rows;
  return rows.flatMap(row => {
    const originalId = row.resolution_receipt?.result?.character?.id ?? row.proposal?.existingCharacterId;
    const original = snapshot.characters.find(person => person.id === originalId);
    const person = snapshot.characters.find(item => item.id === (original?.mergedIntoCharacterId ?? original?.id));
    const pending = (row.pending_indexes as number[]).filter(index => !isSeededFixedCandidateHidden(
      person?.campaignProfile && characterProfileSchema.parse(person.campaignProfile), row.proposal.observations[index].field));
    if (person?.removed || row.resolution_receipt && !pending.length) return [];
    return [{ id: row.id as string, characterId: person?.id as string | undefined }];
  });
}
