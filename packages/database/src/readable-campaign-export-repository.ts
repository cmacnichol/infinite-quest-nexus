import type { ReadableCampaignExport } from "../../story-engine/src/readable-campaign-export.js";
import type { DatabasePool } from "./pool.js";

type CampaignRow = Readonly<{
  title: string;
  world: Record<string, unknown>;
}>;

type TurnRow = Readonly<{
  turnNumber: number;
  action: string;
  narration: string;
  imageUrl: string | null;
}>;

export async function readReadableCampaignExport(
  pool: DatabasePool,
  ownerUserId: string,
  campaignId: string
): Promise<ReadableCampaignExport | null> {
  const campaign = await pool.query<CampaignRow>(
    `SELECT campaign.title,version.content->'world' AS world
       FROM campaigns campaign
       JOIN world_versions version
         ON version.id = campaign.world_version_id AND version.owner_user_id = campaign.owner_user_id
      WHERE campaign.id = $1 AND campaign.owner_user_id = $2`,
    [campaignId, ownerUserId]
  );
  const row = campaign.rows[0];
  if (!row) return null;
  const turns = await pool.query<TurnRow>(
    `SELECT effective.turn_number AS "turnNumber",turn_row.action,
            effective.effective_narration AS narration,turn_row.image_url AS "imageUrl"
       FROM effective_turn_narrations effective
       JOIN turns turn_row
         ON turn_row.id=effective.turn_id
        AND turn_row.campaign_id=effective.campaign_id
        AND turn_row.owner_user_id=effective.owner_user_id
      WHERE effective.campaign_id = $1 AND effective.owner_user_id = $2
      ORDER BY effective.turn_number`,
    [campaignId, ownerUserId]
  );
  return {
    title: row.title,
    world: {
      title: typeof row.world.title === "string" ? row.world.title : "Untitled World",
      ...(typeof row.world.genre === "string" ? { genre: row.world.genre } : {}),
      ...(typeof row.world.tone === "string" ? { tone: row.world.tone } : {}),
      ...(typeof row.world.backgroundStory === "string" ? { backgroundStory: row.world.backgroundStory } : {})
    },
    turns: turns.rows.map((turn) => ({
      turnNumber: turn.turnNumber,
      action: turn.action,
      narration: turn.narration,
      illustrations: turn.imageUrl ? [{ url: turn.imageUrl, alt: `Turn ${turn.turnNumber} illustration` }] : []
    }))
  };
}
