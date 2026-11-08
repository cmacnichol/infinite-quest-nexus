import type { CastScope } from "../../contracts/src/campaign-cast.js";
import { firstAppearanceDecision } from "../../domain/src/campaign-cast-first-appearance.js";
import { worldContentSchema } from "../../contracts/src/world-library.js";
import type { DatabaseClient } from "./pool.js";

/** Read under the campaign lock in the transaction which will publish a seed. */
export async function readFirstAppearanceDecision(client: DatabaseClient, scope: CastScope, input: {
  frozenPermission: boolean; livePermission: boolean; sourceWorldId: string; rosterCharacterId: string;
  identityStillSupported: boolean; unique: boolean; detached: boolean;
}) {
  const row = (await client.query<{ first_appearance_eligible: boolean; world_id: string; selected_character_id: string | null; selected_character_world_id: string | null; content: unknown }>(
    `SELECT c.first_appearance_eligible, w.world_id, c.selected_character_id, c.selected_character_world_id, w.content
       FROM campaigns c JOIN world_versions w ON w.id=c.world_version_id AND w.owner_user_id=c.owner_user_id
      WHERE c.id=$1 AND c.owner_user_id=$2 FOR UPDATE OF c`, [scope.campaignId, scope.ownerUserId]
  )).rows[0];
  if (!row) throw new Error("Campaign not found.");
  const roster = worldContentSchema.parse(row.content).playableCharacters.find((character) => character.id === input.rosterCharacterId);
  if (!roster) return "review" as const;
  return firstAppearanceDecision({ ...input, firstAppearanceEligible: row.first_appearance_eligible,
    pinnedWorldId: row.world_id, selectedCharacterId: row.selected_character_id, selectedCharacterWorldId: row.selected_character_world_id, campaignUse: roster.campaignUse });
}
