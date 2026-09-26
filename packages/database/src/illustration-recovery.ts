import { sha256 } from "../../domain/src/text.js";
import { withTransaction, type DatabasePool } from "./pool.js";

export interface IllustrationRecoveryResult {
  setId: string;
  turnId: string | null;
  outcome: "eligible" | "recovered" | "skipped";
  reason?: string;
}

/** Operator-only repair. Never creates jobs, dispatches providers or edits accepted fiction. */
export async function recoverUnattachedIllustrations(
  pool: DatabasePool,
  scope: { ownerUserId: string; campaignId: string; apply?: boolean }
): Promise<IllustrationRecoveryResult[]> {
  return withTransaction(pool, async (client) => {
    // Run with workers stopped. Serialize repairs and protect the accepted ledger.
    const campaign = await client.query(
      "SELECT id FROM campaigns WHERE id=$1 AND owner_user_id=$2 FOR UPDATE",
      [scope.campaignId, scope.ownerUserId]
    );
    if (!campaign.rowCount) return [];
    const candidates = await client.query<{
      id: string; generation_job_id: string | null; status: string; is_active: boolean;
    }>(
      `SELECT id,generation_job_id,status,is_active FROM turn_illustration_sets
        WHERE campaign_id=$1 AND owner_user_id=$2 AND turn_id IS NULL ORDER BY created_at,id FOR UPDATE`,
      [scope.campaignId, scope.ownerUserId]
    );
    const results: IllustrationRecoveryResult[] = [];
    for (const set of candidates.rows) {
      const parent = await client.query<{ result_turn_id: string; narration: string }>(
        `SELECT g.result_turn_id,t.narration FROM generation_jobs g
         JOIN turns t ON t.id=g.result_turn_id AND t.owner_user_id=g.owner_user_id AND t.campaign_id=g.campaign_id
         WHERE g.id=$1 AND g.owner_user_id=$2 AND g.campaign_id=$3 AND g.status='completed'
           AND g.expected_turn_number=t.turn_number FOR UPDATE OF g,t`,
        [set.generation_job_id, scope.ownerUserId, scope.campaignId]
      );
      const turn = parent.rows[0];
      const result: IllustrationRecoveryResult = { setId: set.id, turnId: turn?.result_turn_id ?? null, outcome: "skipped" };
      results.push(result);
      if (!set.is_active || ["orphaned", "superseded"].includes(set.status)) { result.reason = "inactive_set"; continue; }
      if (!turn) { result.reason = "accepted_parent_unavailable"; continue; }
      const conflicts = await client.query(
        `SELECT id FROM turn_illustration_sets WHERE turn_id=$1 AND is_active
         UNION ALL SELECT id FROM turn_narration_corrections WHERE turn_id=$1`, [turn.result_turn_id]
      );
      if (conflicts.rowCount) { result.reason = "existing_set_or_corrected_narration"; continue; }
      const segments = await client.query<{
        id: string; source_text: string; start_offset: number; end_offset: number; turn_id: string | null;
      }>(
        `SELECT id,source_text,start_offset,end_offset,turn_id FROM turn_illustration_segments
          WHERE illustration_set_id=$1 AND owner_user_id=$2 AND campaign_id=$3 ORDER BY ordinal FOR UPDATE`,
        [set.id, scope.ownerUserId, scope.campaignId]
      );
      if (!segments.rowCount || segments.rows.some(segment => segment.turn_id !== null
        || !segment.source_text.trim() || segment.end_offset > turn.narration.length
        || turn.narration.slice(segment.start_offset, segment.end_offset) !== segment.source_text)) {
        result.reason = "source_mismatch"; continue;
      }
      const ids = segments.rows.map(segment => segment.id);
      const active = await client.query(
        `SELECT id FROM image_jobs WHERE segment_id=ANY($1::uuid[]) AND status IN ('queued','generating','provider_pending','downloading')
         UNION ALL SELECT id FROM illustration_prompt_jobs WHERE segment_id=ANY($1::uuid[]) AND status IN ('queued','refining','recoverable')`, [ids]
      );
      if (active.rowCount) { result.reason = "active_children"; continue; }
      result.outcome = scope.apply ? "recovered" : "eligible";
      if (!scope.apply) continue;
      await client.query(
        `UPDATE turn_illustration_sets SET turn_id=$2,source_text_hash=$3,
           status=CASE WHEN status='provisional' THEN 'partial' ELSE status END WHERE id=$1`,
        [set.id, turn.result_turn_id, sha256(turn.narration)]
      );
      await client.query("UPDATE turn_illustration_segments SET turn_id=$2 WHERE id=ANY($1::uuid[])", [ids, turn.result_turn_id]);
      await client.query(
        `UPDATE image_jobs SET turn_id=$2,target_type='turn_illustration'
          WHERE segment_id=ANY($1::uuid[]) AND owner_user_id=$3 AND campaign_id=$4 AND turn_id IS NULL
            AND generation_job_id=$5 AND target_type='streaming_illustration'`,
        [ids, turn.result_turn_id, scope.ownerUserId, scope.campaignId, set.generation_job_id]
      );
      await client.query(
        "UPDATE illustration_prompt_jobs SET turn_id=$2 WHERE segment_id=ANY($1::uuid[]) AND owner_user_id=$3 AND turn_id IS NULL",
        [ids, turn.result_turn_id, scope.ownerUserId]
      );
      await client.query(
        `INSERT INTO activity_events(owner_user_id,campaign_id,event_type,details)
         VALUES($1,$2,'illustration_attachment_recovered',$3::jsonb)`,
        [scope.ownerUserId, scope.campaignId, JSON.stringify({ setId: set.id, turnId: turn.result_turn_id, segmentCount: ids.length })]
      );
    }
    return results;
  });
}
