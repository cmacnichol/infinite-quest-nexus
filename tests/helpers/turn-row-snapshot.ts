import type { DatabaseClient, DatabasePool } from "../../packages/database/src/pool.js";

export type TurnRowSnapshot = Readonly<{
  id: string;
  data: Readonly<Record<string, unknown>>;
  xmin: string;
}>;

type TurnSnapshotDatabase = Pick<DatabasePool, "query"> | Pick<DatabaseClient, "query">;

export async function snapshotTurnRows(
  database: TurnSnapshotDatabase,
  ownerUserId: string,
  campaignId: string,
): Promise<readonly TurnRowSnapshot[]> {
  const result = await database.query<TurnRowSnapshot>(
    `SELECT turn_row.id, to_jsonb(turn_row) AS data, turn_row.xmin::text AS xmin
       FROM turns turn_row
      WHERE owner_user_id = $1 AND campaign_id = $2
      ORDER BY turn_number, id`,
    [ownerUserId, campaignId]
  );
  return result.rows;
}
