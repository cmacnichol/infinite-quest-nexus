import type { AcceptedTurnCorrectionView } from "../../contracts/src/turn-corrections.js";
import type { TurnCorrectionScope } from "../../application/src/turn-corrections/index.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";

type EffectiveNarrationRow = Readonly<{
  turnId: string;
  turnNumber: number;
  originalNarration: string;
  effectiveNarration: string;
  correctionRevision: number;
  correctedAt: Date | string | null;
  illustrationsMayBeStale: boolean;
}>;

export async function readEffectiveTurnNarration(
  database: DatabaseClient | DatabasePool,
  scope: TurnCorrectionScope,
  turnId: string,
): Promise<AcceptedTurnCorrectionView | null> {
  const result = await database.query<EffectiveNarrationRow>(
    `SELECT effective.turn_id AS "turnId", effective.turn_number AS "turnNumber",
            effective.original_narration AS "originalNarration",
            effective.effective_narration AS "effectiveNarration",
            effective.correction_revision AS "correctionRevision",
            effective.corrected_at AS "correctedAt",
            (
              turn_row.image_url <> ''
              OR EXISTS (
                SELECT 1 FROM assets asset
                 WHERE asset.owner_user_id = effective.owner_user_id
                   AND asset.campaign_id = effective.campaign_id
                   AND asset.turn_id = effective.turn_id
              )
              OR EXISTS (
                SELECT 1
                  FROM turn_illustration_segments segment
                  JOIN turn_illustration_segment_assets segment_asset
                    ON segment_asset.segment_id = segment.id
                   AND segment_asset.owner_user_id = segment.owner_user_id
                 WHERE segment.owner_user_id = effective.owner_user_id
                   AND segment.campaign_id = effective.campaign_id
                   AND segment.turn_id = effective.turn_id
              )
            ) AS "illustrationsMayBeStale"
       FROM effective_turn_narrations effective
       JOIN turns turn_row
         ON turn_row.id = effective.turn_id
        AND turn_row.campaign_id = effective.campaign_id
        AND turn_row.owner_user_id = effective.owner_user_id
      WHERE effective.owner_user_id = $1
        AND effective.campaign_id = $2
        AND effective.turn_id = $3`,
    [scope.ownerUserId, scope.campaignId, turnId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    ownerUserId: scope.ownerUserId,
    campaignId: scope.campaignId,
    turnId: row.turnId,
    turnNumber: row.turnNumber,
    correctionRevision: row.correctionRevision,
    originalNarration: row.originalNarration,
    effectiveNarration: row.effectiveNarration,
    correctedAt: row.correctedAt === null ? null : new Date(row.correctedAt).toISOString(),
    illustrationsMayBeStale: row.illustrationsMayBeStale
  };
}
