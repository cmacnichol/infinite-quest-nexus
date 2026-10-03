import { turnSummarySchema } from "../../contracts/src/client-api.js";
import { parseStoredChronicleRetrievalAudit } from "../../contracts/src/memory.js";
import type { ReaderHistoryRepositoryPort } from "../../application/src/reader-history/index.js";
import { formatNarrationParagraphs } from "../../story-engine/src/narration-formatting.js";
import type { CampaignTurnReportedCostReader } from "./campaign-state-repository.js";
import type { DatabasePool } from "./pool.js";

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
    }
  };
}
