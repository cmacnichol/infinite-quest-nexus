import type { CampaignWorldVersionMemoryScope } from "../../application/src/memory/index.js";
import { currentContinuitySchema, type CurrentContinuity } from "../../contracts/src/memory.js";
import type { DatabaseClient } from "./pool.js";

/**
 * Loads the complete user correction that applies to precisely one generation
 * base turn. Empty fields are a saved authority, not a missing correction.
 */
export async function loadCurrentContinuityCorrection(
  client: DatabaseClient,
  scope: CampaignWorldVersionMemoryScope,
  baseTurnNumber: number,
): Promise<CurrentContinuity | null> {
  const result = await client.query<{ state_snapshot_private: unknown }>(
    `SELECT edit.state_snapshot_private
       FROM campaigns campaign
       JOIN campaign_state_edits edit
         ON edit.campaign_id = campaign.id
        AND edit.owner_user_id = campaign.owner_user_id
      WHERE campaign.id = $2
        AND campaign.owner_user_id = $1
        AND campaign.world_version_id = $3
        AND edit.effective_turn_number = $4
      ORDER BY edit.revision DESC
      LIMIT 1`,
    [scope.ownerUserId, scope.campaignId, scope.worldVersionId, baseTurnNumber]
  );
  const row = result.rows[0];
  return row ? currentContinuitySchema.parse(row.state_snapshot_private) : null;
}
