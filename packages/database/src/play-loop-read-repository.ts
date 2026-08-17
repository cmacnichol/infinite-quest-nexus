import { z } from "zod";
import { parseStoredChronicleRetrievalAudit, type ChronicleRetrievalAudit } from "../../contracts/src/memory.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";

const cursorSchema = z.object({
  campaignId: z.uuid(),
  turnNumber: z.number().int().positive(),
  id: z.uuid(),
  historyVersion: z.string().min(1)
});

export type TurnPageRow = {
  id: string;
  turnNumber: number;
  action: string;
  inputMode: string;
  inputModeSource: string;
  narration: string;
  choices: string[];
  customActionSuggestion: string;
  imagePrompt: string;
  imageUrl: string | null;
  acceptedAt: Date | string;
  chronicleRetrieval: ChronicleRetrievalAudit | null;
};

type TurnPageQueryRow = Omit<TurnPageRow, "chronicleRetrieval"> & {
  storedChronicleRetrieval: unknown;
};

export type TurnPage = { turns: TurnPageRow[]; nextCursor: string | null };

function encodeCursor(cursor: z.output<typeof cursorSchema>): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string, campaignId: string, historyVersion: string) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw Object.assign(new Error("The turn cursor is malformed."), { statusCode: 400 });
  }
  const cursor = cursorSchema.safeParse(decoded);
  if (!cursor.success || cursor.data.campaignId !== campaignId) {
    throw Object.assign(new Error("The turn cursor is invalid for this campaign."), { statusCode: 400 });
  }
  if (cursor.data.historyVersion !== historyVersion) {
    throw Object.assign(new Error("The campaign history changed; reload before requesting older turns."), {
      statusCode: 409,
      details: { code: "turn_history_changed" }
    });
  }
  return cursor.data;
}

async function currentHistoryVersion(client: DatabaseClient, ownerUserId: string, campaignId: string): Promise<string> {
  const result = await client.query<{ historyVersion: string }>(
    `SELECT COUNT(*)::integer::text || ':' || COALESCE(MAX(turn_number), 0)::text || ':' || COALESCE((
              SELECT latest_turn.id::text
                FROM turns latest_turn
               WHERE latest_turn.owner_user_id = $1 AND latest_turn.campaign_id = $2
               ORDER BY latest_turn.turn_number DESC, latest_turn.id DESC
               LIMIT 1
            ), '') || ':' || COALESCE((
              SELECT COUNT(*)::text || ':' || COALESCE(MAX(correction.revision), 0)::text
                FROM turn_narration_corrections correction
               WHERE correction.owner_user_id = $1 AND correction.campaign_id = $2
            ), '0:0') AS "historyVersion"
       FROM turns history_turn
      WHERE history_turn.owner_user_id = $1 AND history_turn.campaign_id = $2`,
    [ownerUserId, campaignId]
  );
  return result.rows[0]?.historyVersion || "0:0:";
}

async function withTurnPageSnapshot<T>(pool: DatabasePool, read: (client: DatabaseClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const value = await read(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function readTurnPage(
  pool: DatabasePool,
  ownerUserId: string,
  campaignId: string,
  before: string | undefined,
  limit: number
): Promise<TurnPage> {
  return withTurnPageSnapshot(pool, async (client) => {
    const historyVersion = await currentHistoryVersion(client, ownerUserId, campaignId);
    const cursor = before === undefined ? null : decodeCursor(before, campaignId, historyVersion);
    const result = await client.query<TurnPageQueryRow>(
      `SELECT effective.turn_id AS id, effective.turn_number AS "turnNumber", turn_row.action,
              COALESCE(turn_row.input_mode, 'action') AS "inputMode",
              COALESCE(turn_row.input_mode_source, 'explicit') AS "inputModeSource",
              effective.effective_narration AS narration, turn_row.choices,
              turn_row.custom_action_suggestion AS "customActionSuggestion",
              turn_row.image_prompt AS "imagePrompt", turn_row.image_url AS "imageUrl",
              turn_row.accepted_at AS "acceptedAt",
              turn_row.model_metadata -> 'chronicleRetrieval' AS "storedChronicleRetrieval"
         FROM effective_turn_narrations effective
         JOIN turns turn_row
           ON turn_row.id = effective.turn_id
          AND turn_row.campaign_id = effective.campaign_id
          AND turn_row.owner_user_id = effective.owner_user_id
        WHERE effective.owner_user_id = $1 AND effective.campaign_id = $2
          AND ($3::integer IS NULL OR (effective.turn_number, effective.turn_id) < ($3, $4::uuid))
        ORDER BY effective.turn_number DESC, effective.turn_id DESC
        LIMIT $5`,
      [ownerUserId, campaignId, cursor?.turnNumber ?? null, cursor?.id ?? null, limit + 1]
    );
    const hasMore = result.rows.length > limit;
    const selected = result.rows.slice(0, limit).reverse();
    const earliest = selected[0];
    const turns = selected.map(({ storedChronicleRetrieval, ...turn }) => ({
      ...turn,
      chronicleRetrieval: parseStoredChronicleRetrievalAudit(storedChronicleRetrieval)
    }));
    return {
      turns,
      nextCursor: hasMore && earliest ? encodeCursor({ campaignId, turnNumber: earliest.turnNumber, id: earliest.id, historyVersion }) : null
    };
  });
}
