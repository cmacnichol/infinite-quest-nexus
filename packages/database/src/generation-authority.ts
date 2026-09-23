import { sha256, stableStringify } from "../../domain/src/index.js";
import { sanitizeChronicleFictionString } from "../../domain/src/chronicle-memory-helpers.js";
import { campaignCharacterProfileSchema } from "../../contracts/src/world-library.js";
import { effectiveCampaignCharacter } from "../../domain/src/world-characters.js";
import type { DatabaseClient } from "./pool.js";
import { captureCastGenerationSnapshotWithClient } from "./campaign-cast-repository.js";
import type { CastGenerationSnapshot } from "../../contracts/src/campaign-cast-context.js";

import type {
  GenerationBaseIdentityV3,
  GenerationBaseIdentityV4,
  LegacyGenerationBaseIdentity
} from "../../application/src/memory/generation-context.js";
import type { GenerationRecentTurn } from "../../application/src/memory/generation-context.js";
export type GenerationBaseIdentity = LegacyGenerationBaseIdentity | GenerationBaseIdentityV3 | GenerationBaseIdentityV4;

export type ResolvedGenerationAuthority = Readonly<{
  ownerUserId: string;
  campaignId: string;
  worldVersionId: string;
  baseIdentity: GenerationBaseIdentity;
  recentTurns?: readonly GenerationRecentTurn[];
  castSnapshot?: CastGenerationSnapshot;
}>;

type ResolveRequest = Readonly<{
  ownerUserId: string;
  campaignId: string;
  operationKind: "append" | "replace_latest";
  expectedTurnNumber: number;
  /** Policy attempts bind effective character authority; historical jobs retain their stored legacy shape. */
  baseIdentityVersion?: "legacy" | "generation-base-v3" | "generation-base-v4";
  captureRecentWindow?: boolean;
}>;

function characterAuthorityIdentity(
  selectedCharacterId: string | null,
  campaignProfile: unknown,
  snapshot: unknown,
  profileRevision: number
): Pick<GenerationBaseIdentityV3, "characterProfileRevision" | "characterProfileFingerprint"> {
  if (campaignProfile !== null && !campaignCharacterProfileSchema.safeParse(campaignProfile).success) {
    throw Object.assign(new Error("The persisted campaign character profile is invalid."), {
      code: "authoritative_context_invalid",
      field: "character_profile"
    });
  }
  const effective = effectiveCampaignCharacter(campaignProfile, snapshot);
  const source = campaignProfile !== null
    ? "campaign_profile"
    : effective.profile !== null
      ? "origin_snapshot"
      : effective.name || effective.legacyGuidance
        ? "legacy_guidance"
        : "none";
  // Profile-based rendering excludes the old character text; including it here
  // would spuriously stale an attempt when unused legacy guidance changes.
  const fictionAuthority = {
    selectedCharacterId,
    source,
    name: effective.name,
    profile: effective.profile,
    characterText: effective.profile === null ? effective.legacyGuidance : ""
  };
  return {
    characterProfileRevision: profileRevision,
    characterProfileFingerprint: sha256(stableStringify(fictionAuthority))
  };
}

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
    selected_character_id: string | null;
    character_profile: unknown;
    character_profile_revision: number;
    character_snapshot: unknown;
  }>(
    `SELECT campaign.active_turn_number, campaign.world_version_id, state.revision,
            campaign.selected_character_id, campaign.character_profile,
            campaign.character_profile_revision, campaign.character_snapshot
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
  const modern = request.baseIdentityVersion === "generation-base-v3" || request.baseIdentityVersion === "generation-base-v4";
  const recentRows = request.captureRecentWindow && modern
    ? (await client.query<{ turn_id: string; turn_number: number; action: string; input_mode: "action" | "scene";
      effective_narration: string; correction_revision: number }>(
      `SELECT t.id AS turn_id,t.turn_number,t.action,t.input_mode,e.effective_narration,e.correction_revision
       FROM turns t JOIN effective_turn_narrations e ON e.turn_id=t.id AND e.campaign_id=t.campaign_id AND e.owner_user_id=t.owner_user_id
       JOIN campaigns c ON c.id=t.campaign_id AND c.owner_user_id=t.owner_user_id
       WHERE t.owner_user_id=$1 AND t.campaign_id=$2 AND c.world_version_id=$3
         AND t.turn_number >= $4 AND t.turn_number < $5 ORDER BY t.turn_number`,
      [request.ownerUserId, request.campaignId, campaign.world_version_id, Math.max(1, baseTurnNumber - 2), baseTurnNumber]
    )).rows : undefined;
  const recentTurns = recentRows?.map((row): GenerationRecentTurn => {
    const source = { turnId: row.turn_id, turnNumber: row.turn_number, inputMode: row.input_mode,
      action: sanitizeChronicleFictionString(row.action, Number.MAX_SAFE_INTEGER),
      narration: sanitizeChronicleFictionString(row.effective_narration, Number.MAX_SAFE_INTEGER),
      narrationCorrectionRevision: row.correction_revision };
    return { ...source, sourceHash: sha256(stableStringify(source)) };
  });
  const legacyIdentity: LegacyGenerationBaseIdentity = {
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
  };
  const characterBase: GenerationBaseIdentity = modern
    ? {
      ...legacyIdentity,
      version: "generation-base-v3",
      ...(recentRows ? { recentWindowFingerprint: sha256(stableStringify(recentRows)) } : {}),
      ...characterAuthorityIdentity(
        campaign.selected_character_id,
        campaign.character_profile,
        campaign.character_snapshot,
        campaign.character_profile_revision
      )
    }
    : legacyIdentity;
  const cast = request.baseIdentityVersion === "generation-base-v4" ? await captureCastGenerationSnapshotWithClient(client,
    { ownerUserId: request.ownerUserId, campaignId: request.campaignId }, { discoveryEnabled: true, turnNumber: baseTurnNumber }) : undefined;
  const baseIdentity: GenerationBaseIdentity = cast ? {
    ...characterBase as GenerationBaseIdentityV3, version: "generation-base-v4",
    castRevision: cast.snapshot.revision, castTimelineRevision: cast.snapshot.boundary.timelineRevision,
    castFingerprint: cast.fingerprint, castCoverageStartTurn: cast.snapshot.coverageStartTurn, castTrackedThroughTurn: cast.snapshot.trackedThroughTurn
  } : characterBase;
  return {
    ownerUserId: request.ownerUserId,
    campaignId: request.campaignId,
    worldVersionId: campaign.world_version_id,
    baseIdentity,
    ...(cast ? { castSnapshot: cast.snapshot } : {}),
    ...(recentTurns ? { recentTurns } : {})
  };
}
