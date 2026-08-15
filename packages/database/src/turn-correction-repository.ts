import type { MemoryGenerationTransactionPort } from "../../application/src/memory/index.js";
import type {
  AcceptedTurnCorrectionView,
  TurnCorrectionFailureReason,
  TurnCorrectionRepositoryPort,
  TurnCorrectionRepositoryResult,
  TurnCorrectionScope
} from "../../application/src/turn-corrections/index.js";
import { acceptedTurnCorrectionRequestSchema } from "../../contracts/src/turn-corrections.js";
import { containsMechanicsLanguage, sha256 } from "../../domain/src/text.js";
import { formatNarrationParagraphs } from "../../story-engine/src/narration-formatting.js";
import { readEffectiveTurnNarration } from "./effective-turn-narration.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";
import { withTransaction } from "./pool.js";

type CampaignRow = Readonly<{
  activeTurnNumber: number;
  worldVersionId: string;
}>;

type LockedTurnRow = Readonly<{
  id: string;
  turnNumber: number;
}>;

function success<T>(value: T): TurnCorrectionRepositoryResult<T> {
  return { ok: true, value };
}

function failure(
  reason: TurnCorrectionFailureReason,
  details?: Readonly<Record<string, unknown>>,
): TurnCorrectionRepositoryResult<never> {
  return details === undefined
    ? { ok: false, failure: { reason } }
    : { ok: false, failure: { reason, details } };
}

export type PostgresTurnCorrectionCollaborators = Readonly<{
  memory: Pick<MemoryGenerationTransactionPort, "rebuildCampaignMemories">;
}>;

async function loadCampaignForUpdate(
  client: DatabaseClient,
  scope: TurnCorrectionScope,
): Promise<CampaignRow | null> {
  const result = await client.query<CampaignRow>(
    `SELECT active_turn_number AS "activeTurnNumber", world_version_id AS "worldVersionId"
       FROM campaigns
      WHERE id = $1 AND owner_user_id = $2
      FOR UPDATE`,
    [scope.campaignId, scope.ownerUserId]
  );
  return result.rows[0] ?? null;
}

export function createPostgresTurnCorrectionRepository(
  pool: DatabasePool,
  collaborators: PostgresTurnCorrectionCollaborators,
): TurnCorrectionRepositoryPort {
  return {
    async correctNarration(scope, request) {
      const parsed = acceptedTurnCorrectionRequestSchema.safeParse(request);
      if (!parsed.success) return failure("invalid_request");
      const narration = formatNarrationParagraphs(parsed.data.narration);
      if (!narration || containsMechanicsLanguage(narration)) return failure("mechanics_leak");

      return withTransaction(pool, async (client) => {
        const campaign = await loadCampaignForUpdate(client, scope);
        if (!campaign) return failure("campaign_not_found", { campaignId: scope.campaignId });
        if (campaign.activeTurnNumber !== parsed.data.expectedActiveTurnNumber) {
          return failure("active_turn_changed", {
            campaignId: scope.campaignId,
            expectedActiveTurnNumber: parsed.data.expectedActiveTurnNumber,
            actualActiveTurnNumber: campaign.activeTurnNumber
          });
        }

        const turnResult = await client.query<LockedTurnRow>(
          `SELECT id, turn_number AS "turnNumber"
             FROM turns
            WHERE id = $1 AND campaign_id = $2 AND owner_user_id = $3
            FOR UPDATE`,
          [parsed.data.turnId, scope.campaignId, scope.ownerUserId]
        );
        const turn = turnResult.rows[0];
        if (!turn) return failure("turn_not_found", { turnId: parsed.data.turnId });

        const activeJob = await client.query(
          `SELECT 1 FROM generation_jobs
            WHERE campaign_id = $1 AND owner_user_id = $2
              AND status IN (
                'queued','replacement_queued','assessing','generating',
                'validating','committing','recoverable'
              )
            LIMIT 1`,
          [scope.campaignId, scope.ownerUserId]
        );
        if (activeJob.rowCount) return failure("generation_active", { campaignId: scope.campaignId });

        const current = await readEffectiveTurnNarration(client, scope, turn.id);
        if (!current) return failure("turn_not_found", { turnId: turn.id });
        if (current.correctionRevision !== parsed.data.expectedCorrectionRevision) {
          return failure("correction_revision_changed", {
            turnId: turn.id,
            expectedCorrectionRevision: parsed.data.expectedCorrectionRevision,
            actualCorrectionRevision: current.correctionRevision
          });
        }
        if (current.effectiveNarration === narration) return failure("invalid_request", { turnId: turn.id });

        const nextRevision = current.correctionRevision + 1;
        await client.query(
          `INSERT INTO turn_narration_corrections (
             owner_user_id, campaign_id, turn_id, revision, narration,
             previous_effective_narration_hash, reason, source, created_by_user_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$1)`,
          [
            scope.ownerUserId,
            scope.campaignId,
            turn.id,
            nextRevision,
            narration,
            sha256(current.effectiveNarration),
            parsed.data.reason ?? null,
            parsed.data.source
          ]
        );

        await collaborators.memory.rebuildCampaignMemories(client, {
          ownerUserId: scope.ownerUserId,
          campaignId: scope.campaignId,
          worldVersionId: campaign.worldVersionId
        });
        await client.query(
          "DELETE FROM model_chains WHERE campaign_id = $1 AND owner_user_id = $2",
          [scope.campaignId, scope.ownerUserId]
        );
        await client.query(
          `INSERT INTO activity_events (owner_user_id, campaign_id, event_type, details)
           VALUES ($1,$2,'turn_narration_corrected',$3)`,
          [scope.ownerUserId, scope.campaignId, JSON.stringify({
            turnId: turn.id,
            turnNumber: turn.turnNumber,
            fromRevision: current.correctionRevision,
            toRevision: nextRevision,
            previousEffectiveNarrationHash: sha256(current.effectiveNarration),
            source: parsed.data.source,
            illustrationsMayBeStale: current.illustrationsMayBeStale
          })]
        );
        const corrected = await readEffectiveTurnNarration(client, scope, turn.id);
        if (!corrected) return failure("turn_not_found", { turnId: turn.id });
        return success(corrected);
      });
    },

    getEffectiveNarration(scope, turnId): Promise<AcceptedTurnCorrectionView | null> {
      return readEffectiveTurnNarration(pool, scope, turnId);
    }
  };
}
