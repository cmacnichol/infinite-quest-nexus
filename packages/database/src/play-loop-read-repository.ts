import { z } from "zod";
import type { DatabasePool } from "./pool.js";

const cursorSchema = z.object({
  campaignId: z.uuid(),
  turnNumber: z.number().int().positive(),
  id: z.uuid()
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
};

export type TurnPage = { turns: TurnPageRow[]; nextCursor: string | null };

function encodeCursor(cursor: z.output<typeof cursorSchema>): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string, campaignId: string) {
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
  return cursor.data;
}

export async function readTurnPage(
  pool: DatabasePool,
  ownerUserId: string,
  campaignId: string,
  before: string | undefined,
  limit: number
): Promise<TurnPage> {
  const cursor = before === undefined ? null : decodeCursor(before, campaignId);
  const result = await pool.query<TurnPageRow>(
    `SELECT id, turn_number AS "turnNumber", action, COALESCE(input_mode, 'action') AS "inputMode",
            COALESCE(input_mode_source, 'explicit') AS "inputModeSource", narration, choices,
            custom_action_suggestion AS "customActionSuggestion", image_prompt AS "imagePrompt",
            image_url AS "imageUrl", accepted_at AS "acceptedAt"
       FROM turns
      WHERE owner_user_id = $1 AND campaign_id = $2
        AND ($3::integer IS NULL OR (turn_number, id) < ($3, $4::uuid))
      ORDER BY turn_number DESC, id DESC
      LIMIT $5`,
    [ownerUserId, campaignId, cursor?.turnNumber ?? null, cursor?.id ?? null, limit + 1]
  );
  const hasMore = result.rows.length > limit;
  const selected = result.rows.slice(0, limit).reverse();
  const earliest = selected[0];
  return {
    turns: selected,
    nextCursor: hasMore && earliest ? encodeCursor({ campaignId, turnNumber: earliest.turnNumber, id: earliest.id }) : null
  };
}
