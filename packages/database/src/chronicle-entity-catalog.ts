import type { CampaignWorldVersionMemoryScope } from "../../application/src/memory/index.js";
import { requireCampaignWorldVersionScope } from "../../application/src/memory/helpers.js";
import { buildChronicleEntityCatalog } from "../../domain/src/chronicle-memory-helpers.js";
import { rebuildCastWithClient } from "./campaign-cast-repository.js";
import type { DatabaseClient } from "./pool.js";

/** Current derived-index identities; generation still uses its captured historical catalog. */
export async function loadChronicleEntityCatalog(client: DatabaseClient, scope: CampaignWorldVersionMemoryScope) {
  const result = await client.query<{
    id: string; world_version_id: string; active_turn_number: number; cast_revision: number | null; world_content: Record<string, unknown>;
    character_snapshot: Record<string, unknown> | null; character_profile: Record<string, unknown> | null;
  }>(`SELECT c.id,c.world_version_id,c.active_turn_number,cs.revision AS cast_revision,wv.content AS world_content,c.character_snapshot,c.character_profile
    FROM campaigns c JOIN world_versions wv ON wv.id=c.world_version_id AND wv.owner_user_id=c.owner_user_id
    LEFT JOIN campaign_cast_state cs ON cs.campaign_id=c.id AND cs.owner_user_id=c.owner_user_id
    WHERE c.id=$1 AND c.owner_user_id=$2 FOR UPDATE OF c`, [scope.campaignId, scope.ownerUserId]);
  const campaign = requireCampaignWorldVersionScope(scope, result.rows[0]);
  // Explicit boundary projects retained authority without updating the cast cache or indexes.
  const characters = campaign.cast_revision == null ? []
    : (await rebuildCastWithClient(client, scope, campaign.active_turn_number)).characters;
  return buildChronicleEntityCatalog({ worldContent: campaign.world_content, worldVersionId: campaign.world_version_id,
    characterSnapshot: campaign.character_snapshot, characterProfile: campaign.character_profile, campaignCharacters: characters });
}
