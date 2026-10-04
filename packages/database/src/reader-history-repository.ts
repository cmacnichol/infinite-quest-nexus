import { z } from "zod";
import { turnSummarySchema } from "../../contracts/src/client-api.js";
import { readerHistoryItemSchema } from "../../contracts/src/reader-history.js";
import type { ReaderSceneWindowRequest } from "../../contracts/src/reader-history.js";
import { parseStoredChronicleRetrievalAudit } from "../../contracts/src/memory.js";
import type {
  ReaderHistoryRepositoryPort,
  ReaderHistorySearchOptions,
  ReaderHistoryScope,
  ReaderSceneWindow
} from "../../application/src/reader-history/index.js";
import { sha256 } from "../../domain/src/text.js";
import { formatNarrationParagraphs } from "../../story-engine/src/narration-formatting.js";
import type { CampaignTurnReportedCostReader } from "./campaign-state-repository.js";
import { createProviderCostRepository } from "./cost-repository.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";

export type ReaderHistoryRepositoryCollaborators = Readonly<{
  turnReportedCosts: CampaignTurnReportedCostReader;
}>;

type EffectiveTurnRow = Readonly<{
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
  storedChronicleRetrieval: unknown;
}>;

type ReaderHistorySummaryRow = Readonly<{
  id: string;
  turnNumber: number;
  acceptedAt: Date | string;
  excerpt: string;
}>;

type SceneFingerprintRow = Readonly<{
  turnNumber: number;
  id: string;
  latestCorrectionId: string | null;
  latestCorrectionRevision: number;
}>;

const sceneHistoryTokenSchema = z.object({
  schemaVersion: z.literal(1),
  campaignId: z.uuid(),
  sceneFingerprint: z.string().regex(/^[0-9a-f]{64}$/u)
}).strict();

const historyCursorSchema = z.object({
  schemaVersion: z.literal(1),
  campaignId: z.uuid(),
  queryFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  historyVersion: z.string().min(1),
  turnNumber: z.number().int().positive(),
  id: z.uuid()
});

function queryFingerprint(q: string): string {
  return sha256(q.toLowerCase());
}

function encodeHistoryCursor(value: z.output<typeof historyCursorSchema>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function readerSceneWindowError(
  statusCode: 400 | 409,
  code: "invalid_history_token" | "reader_anchor_changed" | "reader_history_changed"
): Error {
  return Object.assign(new Error(code), { statusCode, details: { code } });
}

function encodeSceneHistoryToken(campaignId: string, sceneFingerprint: string): string {
  return Buffer.from(JSON.stringify({ schemaVersion: 1, campaignId, sceneFingerprint }), "utf8").toString("base64url");
}

function decodeSceneHistoryToken(value: string, campaignId: string): z.output<typeof sceneHistoryTokenSchema> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw readerSceneWindowError(400, "invalid_history_token");
  let decoded: unknown;
  try {
    const json = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(json, "utf8").toString("base64url") !== value) {
      throw new Error("non-canonical token");
    }
    decoded = JSON.parse(json);
  } catch {
    throw readerSceneWindowError(400, "invalid_history_token");
  }
  const token = sceneHistoryTokenSchema.safeParse(decoded);
  if (!token.success || token.data.campaignId !== campaignId) {
    throw readerSceneWindowError(400, "invalid_history_token");
  }
  return token.data;
}

async function currentSceneFingerprint(client: DatabaseClient, scope: ReaderHistoryScope): Promise<string> {
  const result = await client.query<SceneFingerprintRow>(
    `/* scene-window-fingerprint */
     SELECT turn_row.turn_number AS "turnNumber", turn_row.id,
            correction.id AS "latestCorrectionId", COALESCE(correction.revision, 0) AS "latestCorrectionRevision"
       FROM turns turn_row
       LEFT JOIN LATERAL (
         SELECT latest.id, latest.revision
           FROM turn_narration_corrections latest
          WHERE latest.owner_user_id = turn_row.owner_user_id
            AND latest.campaign_id = turn_row.campaign_id
            AND latest.turn_id = turn_row.id
          ORDER BY latest.revision DESC
          LIMIT 1
       ) correction ON true
      WHERE turn_row.owner_user_id = $1
        AND turn_row.campaign_id = $2
        AND turn_row.accepted_at IS NOT NULL
      ORDER BY turn_row.turn_number, turn_row.id`,
    [scope.ownerUserId, scope.campaignId]
  );
  const canonicalScenes = result.rows.map((row) => [
    row.turnNumber,
    row.id,
    row.latestCorrectionId,
    row.latestCorrectionRevision
  ]);
  return sha256(`scene-window-v1\n${JSON.stringify(canonicalScenes)}`);
}

function decodeHistoryCursor(
  value: string,
  campaignId: string,
  fingerprint: string,
  historyVersion: string
) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw Object.assign(new Error("The history cursor is malformed."), { statusCode: 400 });
  }
  const cursor = historyCursorSchema.safeParse(decoded);
  if (!cursor.success || cursor.data.campaignId !== campaignId || cursor.data.queryFingerprint !== fingerprint) {
    throw Object.assign(new Error("The history cursor is invalid for this campaign or query."), { statusCode: 400 });
  }
  if (cursor.data.historyVersion !== historyVersion) {
    throw Object.assign(new Error("The campaign history changed; reload before requesting older summaries."), {
      statusCode: 409,
      details: { code: "reader_history_changed" }
    });
  }
  return cursor.data;
}

async function currentHistoryVersion(client: DatabaseClient, scope: ReaderHistoryScope): Promise<string> {
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
    [scope.ownerUserId, scope.campaignId]
  );
  return result.rows[0]?.historyVersion || "0:0:";
}

async function withReaderHistorySnapshot<T>(pool: DatabasePool, read: (client: DatabaseClient) => Promise<T>): Promise<T> {
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

function escapeLikeQuery(q: string): string {
  return q.replace(/[\\%_]/gu, "\\$&");
}

function boundExcerpt(value: string): string {
  let excerpt = "";
  for (const character of value) {
    if (excerpt.length + character.length > 240) break;
    excerpt += character;
  }
  return excerpt;
}

export function createPostgresReaderHistoryRepository(
  pool: DatabasePool,
  collaborators: ReaderHistoryRepositoryCollaborators
): ReaderHistoryRepositoryPort {
  return {
    async getEffectiveTurn(scope, turnNumber) {
      const result = await pool.query<EffectiveTurnRow>(
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
          WHERE effective.owner_user_id = $1
            AND effective.campaign_id = $2
            AND effective.turn_number = $3
          ORDER BY effective.turn_id
          LIMIT 1`,
        [scope.ownerUserId, scope.campaignId, turnNumber]
      );
      const row = result.rows[0];
      if (!row) return null;

      const costs = await collaborators.turnReportedCosts(
        pool,
        scope.ownerUserId,
        scope.campaignId,
        [row.id]
      );
      const { storedChronicleRetrieval, ...turn } = row;
      return turnSummarySchema.parse({
        ...turn,
        narration: formatNarrationParagraphs(turn.narration),
        chronicleRetrieval: parseStoredChronicleRetrievalAudit(storedChronicleRetrieval),
        reportedCost: costs.get(turn.id) ?? null
      });
    },
    async getSceneWindow(scope, request: ReaderSceneWindowRequest): Promise<ReaderSceneWindow | null> {
      return withReaderHistorySnapshot(pool, async (client) => {
        const anchorResult = await client.query<{ id: string }>(
          `SELECT id
             FROM turns
            WHERE owner_user_id = $1 AND campaign_id = $2 AND turn_number = $3 AND accepted_at IS NOT NULL
            LIMIT 1`,
          [scope.ownerUserId, scope.campaignId, request.anchorTurnNumber]
        );
        const anchorId = anchorResult.rows[0]?.id;
        if (!anchorId) return null;
        if (anchorId !== request.anchorTurnId) throw readerSceneWindowError(409, "reader_anchor_changed");

        const sceneFingerprint = await currentSceneFingerprint(client, scope);
        if (request.historyToken !== undefined) {
          const token = decodeSceneHistoryToken(request.historyToken, scope.campaignId);
          if (token.sceneFingerprint !== sceneFingerprint) {
            throw readerSceneWindowError(409, "reader_history_changed");
          }
        }

        const comparison = request.direction === "older" ? "<" : ">";
        const order = request.direction === "older" ? "DESC" : "ASC";
        const result = await client.query<EffectiveTurnRow>(
          `/* scene-window-neighbors */
           SELECT effective.turn_id AS id, effective.turn_number AS "turnNumber", turn_row.action,
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
            WHERE effective.owner_user_id = $1
              AND effective.campaign_id = $2
              AND ((effective.turn_number, effective.turn_id) = ($3, $4::uuid)
                   OR (effective.turn_number, effective.turn_id) ${comparison} ($3, $4::uuid))
            ORDER BY effective.turn_number ${order}, effective.turn_id ${order}
            LIMIT $5`,
          [scope.ownerUserId, scope.campaignId, request.anchorTurnNumber, request.anchorTurnId, request.neighborLimit + 2]
        );
        const hasMore = result.rows.length > request.neighborLimit + 1;
        const selected = result.rows.slice(0, request.neighborLimit + 1);
        const anchorRow = selected.find((row) => row.id === request.anchorTurnId && row.turnNumber === request.anchorTurnNumber);
        if (!anchorRow) throw readerSceneWindowError(409, "reader_anchor_changed");
        const orderedRows = request.direction === "older" ? selected.reverse() : selected;
        const turnIds = orderedRows.map((row) => row.id);
        const costs = await createProviderCostRepository(client).getTurnCosts({
          ownerUserId: scope.ownerUserId,
          campaignId: scope.campaignId,
          turnIds
        });
        const turns = orderedRows.map((row) => {
          const { storedChronicleRetrieval, ...turn } = row;
          return turnSummarySchema.parse({
            ...turn,
            narration: formatNarrationParagraphs(turn.narration),
            chronicleRetrieval: parseStoredChronicleRetrievalAudit(storedChronicleRetrieval),
            reportedCost: costs.get(turn.id) ?? null
          });
        });
        return {
          anchor: { turnNumber: request.anchorTurnNumber, id: request.anchorTurnId },
          direction: request.direction,
          turns,
          hasMore,
          historyToken: encodeSceneHistoryToken(scope.campaignId, sceneFingerprint)
        };
      });
    },
    async searchHistory(scope, options: ReaderHistorySearchOptions) {
      return withReaderHistorySnapshot(pool, async (client) => {
        const historyVersion = await currentHistoryVersion(client, scope);
        const fingerprint = queryFingerprint(options.q);
        const cursor = options.before === undefined
          ? null
          : decodeHistoryCursor(options.before, scope.campaignId, fingerprint, historyVersion);
        const result = await client.query<ReaderHistorySummaryRow>(
          `WITH effective_history AS MATERIALIZED (
             SELECT turn_id, owner_user_id, campaign_id, turn_number, effective_narration
               FROM effective_turn_narrations
              WHERE owner_user_id = $1 AND campaign_id = $2
           )
           SELECT effective.turn_id AS id,
                  effective.turn_number AS "turnNumber",
                  turn_row.accepted_at AS "acceptedAt",
                  LEFT(effective.effective_narration, 240) AS excerpt
             FROM effective_history effective
             JOIN turns turn_row
               ON turn_row.id = effective.turn_id
              AND turn_row.campaign_id = effective.campaign_id
              AND turn_row.owner_user_id = effective.owner_user_id
            WHERE ($3::text = '' OR effective.effective_narration ILIKE '%' || $3 || '%' ESCAPE E'\\\\'
                   OR turn_row.action ILIKE '%' || $3 || '%' ESCAPE E'\\\\')
              AND ($4::integer IS NULL OR (effective.turn_number, effective.turn_id) < ($4, $5::uuid))
            ORDER BY effective.turn_number DESC, effective.turn_id DESC
            LIMIT $6`,
          [scope.ownerUserId, scope.campaignId, escapeLikeQuery(options.q), cursor?.turnNumber ?? null, cursor?.id ?? null, options.limit + 1]
        );
        const hasMore = result.rows.length > options.limit;
        const selected = result.rows.slice(0, options.limit);
        const items = selected.map((row) => readerHistoryItemSchema.parse({
          ...row,
          excerpt: boundExcerpt(row.excerpt),
          acceptedAt: row.acceptedAt instanceof Date ? row.acceptedAt.toISOString() : new Date(row.acceptedAt).toISOString()
        }));
        const last = selected.at(-1);
        return {
          items,
          nextCursor: hasMore && last
            ? encodeHistoryCursor({
                schemaVersion: 1,
                campaignId: scope.campaignId,
                queryFingerprint: fingerprint,
                historyVersion,
                turnNumber: last.turnNumber,
                id: last.id
              })
            : null
        };
      });
    }
  };
}
