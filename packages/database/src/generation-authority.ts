import { sha256, stableStringify } from "../../domain/src/index.js";
import type { DatabaseClient } from "./pool.js";

export type GenerationBaseIdentity = Readonly<{
  operationKind: "append" | "replace_latest";
  expectedTurnNumber: number;
  baseTurnNumber: number;
  campaignActiveTurnNumber: number;
  campaignStateRevision: number;
  stateEditRevision: number | null;
  narrationCorrectionRevision: number | null;
  baseTurnId: string | null;
  stateFingerprint: string;
  narrationFingerprint: string | null;
}>;

export type ResolvedGenerationAuthority = Readonly<{
  ownerUserId: string;
  campaignId: string;
  worldVersionId: string;
  baseIdentity: GenerationBaseIdentity;
}>;

type ResolveRequest = Readonly<{
  ownerUserId: string;
  campaignId: string;
  operationKind: "append" | "replace_latest";
  expectedTurnNumber: number;
}>;

/**
 * Reads the authoritative base inside the enqueue/commit transaction. The
 * identity deliberately excludes derived-index timestamps so replay stays
 * stable until a campaign correction, narration correction, or turn changes.
 */
export async function resolveGenerationAuthoritySnapshot(
  client: DatabaseClient,
  request: ResolveRequest
): Promise<ResolvedGenerationAuthority> {
  const campaignResult = await client.query<{
    active_turn_number: number;
    world_version_id: string;
    revision: number;
  }>(
    `SELECT campaign.active_turn_number, campaign.world_version_id, state.revision
       FROM campaigns campaign
       JOIN campaign_state state ON state.campaign_id = campaign.id AND state.owner_user_id = campaign.owner_user_id
      WHERE campaign.id = $1 AND campaign.owner_user_id = $2
      FOR UPDATE OF campaign, state`,
    [request.campaignId, request.ownerUserId]
  );
  const campaign = campaignResult.rows[0];
  if (!campaign) throw new Error("Generation authority campaign was not found.");
  const baseTurnNumber = request.operationKind === "append"
    ? campaign.active_turn_number
    : request.expectedTurnNumber - 1;
  const stateEditResult = await client.query<{
    state_snapshot_private: Record<string, unknown>;
    revision: number;
  }>(
    `SELECT state_snapshot_private, revision
       FROM campaign_state_edits
      WHERE campaign_id = $1 AND owner_user_id = $2 AND effective_turn_number = $3
      ORDER BY revision DESC LIMIT 1`,
    [request.campaignId, request.ownerUserId, baseTurnNumber]
  );
  const stateEdit = stateEditResult.rows[0] ?? null;
  const baseTurnResult = baseTurnNumber === 0
    ? { rows: [] as Array<{ id: string; effective_narration: string; correction_revision: number }> }
    : await client.query<{
      id: string;
      effective_narration: string;
      correction_revision: number;
    }>(
      `SELECT turn_id AS id, effective_narration, correction_revision
         FROM effective_turn_narrations
        WHERE campaign_id = $1 AND owner_user_id = $2 AND turn_number = $3`,
      [request.campaignId, request.ownerUserId, baseTurnNumber]
    );
  const baseTurn = baseTurnResult.rows[0] ?? null;
  return {
    ownerUserId: request.ownerUserId,
    campaignId: request.campaignId,
    worldVersionId: campaign.world_version_id,
    baseIdentity: {
      operationKind: request.operationKind,
      expectedTurnNumber: request.expectedTurnNumber,
      baseTurnNumber,
      campaignActiveTurnNumber: campaign.active_turn_number,
      campaignStateRevision: campaign.revision,
      stateEditRevision: stateEdit?.revision ?? null,
      narrationCorrectionRevision: baseTurn?.correction_revision || null,
      baseTurnId: baseTurn?.id ?? null,
      stateFingerprint: sha256(stableStringify(stateEdit?.state_snapshot_private ?? {})),
      narrationFingerprint: baseTurn ? sha256(baseTurn.effective_narration) : null
    }
  };
}
