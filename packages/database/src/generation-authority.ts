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
import { ledgerDirectionExcerpt, type StoryLedger } from "../../application/src/memory/story-history-ledger.js";
import { loadVerifiedProtectedFacts } from "./campaign-continuity-repository.js";
import type { ProtectedFact, ProtectedFactSourceCoverage } from "../../application/src/memory/story-history-facts.js";
export type GenerationBaseIdentity = LegacyGenerationBaseIdentity | GenerationBaseIdentityV3 | GenerationBaseIdentityV4;

export type ResolvedGenerationAuthority = Readonly<{
  ownerUserId: string;
  campaignId: string;
  worldVersionId: string;
  baseIdentity: GenerationBaseIdentity;
  recentTurns?: readonly GenerationRecentTurn[];
  storyLedger?: StoryLedger;
  protectedFacts?: readonly ProtectedFact[];
  protectedFactsOmitted?: number;
  protectedFactsCoverage?: ProtectedFactSourceCoverage;
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
  /** Explicit frozen v5 history window. Absence retains the historical two-turn reader. */
  recentWindowTurns?: 11;
  /** V5 only: bounded, transaction-scoped player-intent source projection. */
  captureStoryLedger?: boolean;
  /** V5 only: complete source-verified canonical facts for optional prompt use. */
  captureProtectedFacts?: boolean;
}>;

type RecentWindowRow = Readonly<{
  turn_id: string;
  turn_number: number;
  action: string;
  input_mode: "action" | "scene";
  effective_narration: string;
  correction_revision: number;
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
  const recentWindowTurns = request.recentWindowTurns ?? 2;
  const queriedRecentRows: readonly RecentWindowRow[] | undefined = request.captureRecentWindow && modern
    ? (await client.query<RecentWindowRow>(
      `SELECT t.id AS turn_id,t.turn_number,t.action,t.input_mode,e.effective_narration,e.correction_revision
       FROM turns t JOIN effective_turn_narrations e ON e.turn_id=t.id AND e.campaign_id=t.campaign_id AND e.owner_user_id=t.owner_user_id
       JOIN campaigns c ON c.id=t.campaign_id AND c.owner_user_id=t.owner_user_id
       WHERE t.owner_user_id=$1 AND t.campaign_id=$2 AND c.world_version_id=$3
         AND t.turn_number >= $4 AND t.turn_number < $5 ORDER BY t.turn_number`,
       [request.ownerUserId, request.campaignId, campaign.world_version_id, Math.max(1, baseTurnNumber - recentWindowTurns), baseTurnNumber]
    )).rows : undefined;
  // Historical v3/v4 captures preserve their raw bounded query exactly. V5
  // reserves only the newest contiguous suffix, so a missing predecessor is
  // neither fingerprinted nor withheld from later retrieval.
  const recentRows = queriedRecentRows && request.recentWindowTurns !== undefined
    ? (() => {
      let expectedTurnNumber = baseTurnNumber - 1;
      const newestFirst: RecentWindowRow[] = [];
      for (const row of [...queriedRecentRows].reverse()) {
        if (row.turn_number !== expectedTurnNumber) break;
        newestFirst.push(row);
        expectedTurnNumber--;
      }
      return newestFirst.reverse();
    })()
    : queriedRecentRows;
  const recentTurns = recentRows?.map((row): GenerationRecentTurn => {
    const source = { turnId: row.turn_id, turnNumber: row.turn_number, inputMode: row.input_mode,
      action: sanitizeChronicleFictionString(row.action, Number.MAX_SAFE_INTEGER),
      narration: sanitizeChronicleFictionString(row.effective_narration, Number.MAX_SAFE_INTEGER),
      narrationCorrectionRevision: row.correction_revision };
    return { ...source, sourceHash: sha256(stableStringify(source)) };
  });
  const ledgerRows = request.captureStoryLedger && modern && baseTurnNumber > 0 ? await (async () => {
    const rows: { turn_id: string; turn_number: number; input_mode: "action" | "scene"; action: string | null }[] = [];
    let cursor: { turnNumber: number; turnId: string } | null = null;
    // Four small keyset pages cap source materialization at 512 records even
    // for long-running campaigns, while retaining an honest lower omission.
    for (let page = 0; page < 4; page++) {
      const result: { rows: { turn_id: string; turn_number: number; input_mode: "action" | "scene"; action: string | null }[] } = await client.query<{ turn_id: string; turn_number: number; input_mode: "action" | "scene"; action: string | null }>(
        `SELECT t.id AS turn_id,t.turn_number,t.input_mode,
                CASE WHEN char_length(t.action) <= 12000 AND octet_length(t.action) <= 48000 THEN t.action ELSE NULL END AS action
           FROM turns t JOIN campaigns c ON c.id=t.campaign_id AND c.owner_user_id=t.owner_user_id
          WHERE t.owner_user_id=$1 AND t.campaign_id=$2 AND c.world_version_id=$3 AND t.turn_number < $4
            AND ($5::int IS NULL OR (t.turn_number,t.id) < ($5,$6))
          ORDER BY t.turn_number DESC,t.id DESC LIMIT 128`,
        [request.ownerUserId, request.campaignId, campaign.world_version_id, baseTurnNumber, cursor?.turnNumber ?? null, cursor?.turnId ?? null]
      );
      rows.push(...result.rows);
      const last: { turn_id: string; turn_number: number } | undefined = result.rows.at(-1);
      if (!last || result.rows.length < 128) break;
      cursor = { turnNumber: last.turn_number, turnId: last.turn_id };
    }
    return rows;
  })() : undefined;
  const storyLedger: StoryLedger | undefined = ledgerRows ? (() => {
    const entries = ledgerRows.flatMap((row) => {
      if (row.action === null) return [];
      const direction = ledgerDirectionExcerpt(row.action, 480);
      return direction ? [{ turnId: row.turn_id, turnNumber: row.turn_number, inputMode: row.input_mode, direction }] : [];
    }).sort((left, right) => left.turnNumber - right.turnNumber || left.turnId.localeCompare(right.turnId));
    const lowest = ledgerRows.at(-1)?.turn_number ?? null;
    const highest = ledgerRows[0]?.turn_number ?? null;
    const inspectedTurnCount = lowest === null || highest === null ? 0 : highest - lowest + 1;
    const missingTurnCount = Math.max(0, inspectedTurnCount - ledgerRows.length);
    const oversizedDirectionCount = ledgerRows.filter((row) => row.action === null).length;
    const filteredDirectionCount = ledgerRows.filter((row) => row.action !== null && !ledgerDirectionExcerpt(row.action, 480)).length;
    // Full source capacity leaves an unread prefix unless the inspected range
    // reaches turn one. This remains distinct from gaps inside that range.
    const unreadThroughTurn = ledgerRows.length === 512 && lowest !== null && lowest !== 1 ? lowest - 1 : null;
    const omittedThroughTurn = Math.max(unreadThroughTurn ?? 0,
      ...ledgerRows.filter((row) => row.action === null || !entries.some((entry) => entry.turnId === row.turn_id)).map((row) => row.turn_number)) || null;
    return { version: "story-ledger-v1", entries, omittedThroughTurn, coverage: {
      unreadThroughTurn, missingTurnCount, filteredDirectionCount, oversizedDirectionCount, loadedRows: ledgerRows.length
    } };
  })() : undefined;
  const protectedFactSource = request.captureProtectedFacts && modern
    ? await loadVerifiedProtectedFacts(client, {
      ownerUserId: request.ownerUserId, campaignId: request.campaignId, worldVersionId: campaign.world_version_id
    }, baseTurnNumber)
    : undefined;
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
      ...(recentRows ? { recentWindowFingerprint: sha256(stableStringify(recentRows)),
        ...(request.recentWindowTurns === undefined ? {} : { recentWindowTurns: request.recentWindowTurns }) } : {}),
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
    ...(recentTurns ? { recentTurns } : {}),
    ...(storyLedger ? { storyLedger } : {}),
    ...(protectedFactSource ? { protectedFacts: protectedFactSource.facts, protectedFactsOmitted: protectedFactSource.omittedCount,
      protectedFactsCoverage: protectedFactSource.coverage } : {})
  };
}
