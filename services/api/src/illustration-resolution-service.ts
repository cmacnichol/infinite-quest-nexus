import type { DatabaseClient, DatabasePool } from "../../../packages/database/src/pool.js";
import { initialOwnerId, withTransaction } from "../../../packages/database/src/pool.js";
import { logger } from "../../../packages/logger/src/index.js";
import { containsMechanicsLanguage } from "../../../packages/story-engine/src/index.js";
import { enqueueIllustration } from "./image-service.js";
import { enqueueSegmentProviderImage } from "./segmented-illustration-service.js";

const MATCH_ALGORITHM_VERSION = "library-match-v1";
const THRESHOLDS = { strict: 0.68, balanced: 0.52, broad: 0.38 } as const;
const STOP_WORDS = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "into", "is", "of", "on", "or", "the", "to", "with"]);

type ResolutionRow = {
  id: string;
  owner_user_id: string;
  campaign_id: string;
  turn_id: string;
  segment_id: string | null;
  source_policy: "library_only" | "library_then_generate";
  matching_scope: "campaign" | "world" | "owner_library" | "shared";
  confidence_profile: keyof typeof THRESHOLDS;
  repetition_window: number;
  query_context_snapshot: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
};

type MatchCandidateRow = {
  asset_id: string;
  title: string;
  caption: string;
  tags: string[];
  fiction_prompt: string;
  entities: unknown;
  characters: unknown;
  locations: unknown;
  campaign_id: string | null;
  world_id: string | null;
  recent_uses: number;
};

export type MatchScore = {
  score: number;
  components: Record<string, number | boolean>;
  rejectionReasons: string[];
};

function tokens(value: string): Set<string> {
  return new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)?.filter((token) => token.length > 1 && !STOP_WORDS.has(token)) || []);
}

function stringValues(value: unknown): Set<string> {
  const output = new Set<string>();
  const visit = (item: unknown) => {
    if (typeof item === "string" && item.trim()) output.add(item.trim().toLocaleLowerCase());
    else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === "object") Object.values(item).forEach(visit);
  };
  visit(value);
  return output;
}

function overlapRatio(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / Math.max(left.size, right.size);
}

function queryCoverage(query: Set<string>, candidate: Set<string>): number {
  if (!query.size || !candidate.size) return 0;
  let intersection = 0;
  for (const value of query) if (candidate.has(value)) intersection += 1;
  return intersection / query.size;
}

export function scoreLibraryCandidate(
  query: { imagePrompt: string; entities: unknown; campaignId: string; worldId: string },
  candidate: MatchCandidateRow
): MatchScore {
  const queryTokens = tokens(query.imagePrompt);
  const candidateTokens = tokens([candidate.title, candidate.caption, candidate.fiction_prompt, ...(candidate.tags || [])].join(" "));
  const textOverlap = queryCoverage(queryTokens, candidateTokens);
  const queryEntities = stringValues(query.entities);
  const candidateEntities = stringValues([candidate.entities, candidate.characters, candidate.locations]);
  const entityOverlap = overlapRatio(queryEntities, candidateEntities);
  const sameCampaign = candidate.campaign_id === query.campaignId;
  const sameWorld = candidate.world_id === query.worldId;
  const repetitionPenalty = candidate.recent_uses > 0 ? Math.min(0.28, 0.12 + (candidate.recent_uses - 1) * 0.04) : 0;
  const entityMismatchPenalty = queryEntities.size > 0 && candidateEntities.size > 0 && entityOverlap === 0 ? 0.16 : 0;
  const raw = textOverlap * 0.55 + entityOverlap * 0.25 + (sameCampaign ? 0.18 : 0) + (sameWorld ? 0.12 : 0)
    - repetitionPenalty - entityMismatchPenalty;
  const score = Math.max(0, Math.min(1, Number(raw.toFixed(6))));
  return {
    score,
    components: { textOverlap, entityOverlap, sameCampaign, sameWorld, repetitionPenalty, entityMismatchPenalty },
    rejectionReasons: entityMismatchPenalty ? ["canonical_entity_mismatch"] : []
  };
}

async function claimResolutionJob(pool: DatabasePool, workerId: string, leaseSeconds: number): Promise<ResolutionRow | null> {
  return withTransaction(pool, async (client) => {
    const result = await client.query<ResolutionRow>(
      `SELECT id, owner_user_id, campaign_id, turn_id, segment_id, source_policy, matching_scope, confidence_profile,
              repetition_window, query_context_snapshot, attempts, max_attempts
         FROM illustration_resolution_jobs
        WHERE (status IN ('queued', 'recoverable') AND next_attempt_at <= now())
           OR (status = 'matching' AND lease_expires_at < now())
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED LIMIT 1`
    );
    const row = result.rows[0];
    if (!row) return null;
    await client.query(
      `UPDATE illustration_resolution_jobs
          SET status = 'matching', attempts = attempts + 1, lease_owner = $2,
              lease_expires_at = now() + ($3::text || ' seconds')::interval, updated_at = now(),
              reason_code = NULL
        WHERE id = $1`,
      [row.id, workerId, leaseSeconds]
    );
    return { ...row, attempts: row.attempts + 1 };
  });
}

async function resolutionContext(client: DatabaseClient, job: ResolutionRow) {
  const result = await client.query<{
    image_prompt: string;
    world_id: string;
    world_version_id: string;
    entities: string[];
  }>(
    `SELECT COALESCE(NULLIF(segments.resolved_prompt, ''), turns.image_prompt) AS image_prompt,
            world_versions.world_id, campaigns.world_version_id,
            COALESCE(ARRAY(
              SELECT DISTINCT unnest(memories.entities)
                FROM chronicle_memories memories
               WHERE memories.turn_id = turns.id AND memories.owner_user_id = turns.owner_user_id
            ), '{}') AS entities
       FROM turns
       JOIN campaigns ON campaigns.id = turns.campaign_id AND campaigns.owner_user_id = turns.owner_user_id
       JOIN world_versions ON world_versions.id = campaigns.world_version_id
        AND world_versions.owner_user_id = turns.owner_user_id
       LEFT JOIN turn_illustration_segments segments
         ON segments.id = $4 AND segments.owner_user_id = turns.owner_user_id
      WHERE turns.id = $1 AND turns.campaign_id = $2 AND turns.owner_user_id = $3`,
    [job.turn_id, job.campaign_id, job.owner_user_id, job.segment_id]
  );
  const row = result.rows[0];
  if (!row) throw Object.assign(new Error("Resolution turn no longer exists."), { code: "turn_missing", permanent: true });
  if (!row.image_prompt.trim() || containsMechanicsLanguage(row.image_prompt)) {
    throw Object.assign(new Error("Resolution prompt failed the fiction-only boundary."), { code: "unsafe_prompt", permanent: true });
  }
  return row;
}

async function candidates(client: DatabaseClient, job: ResolutionRow, context: Awaited<ReturnType<typeof resolutionContext>>) {
  const excluded = Array.isArray(job.query_context_snapshot.excludedAssetIds)
    ? job.query_context_snapshot.excludedAssetIds.filter((value): value is string => typeof value === "string")
    : [];
  return client.query<MatchCandidateRow>(
    `SELECT assets.id AS asset_id, library.title, library.caption, library.tags,
            COALESCE(context.fiction_prompt, '') AS fiction_prompt,
            COALESCE(context.entities, '[]'::jsonb) AS entities,
            COALESCE(context.characters, '[]'::jsonb) AS characters,
            COALESCE(context.locations, '[]'::jsonb) AS locations,
            context.campaign_id, context.world_id,
            COALESCE((
              SELECT count(*)::int FROM asset_references recent_refs
              JOIN turns recent_turn ON recent_turn.id = recent_refs.turn_id AND recent_turn.owner_user_id = recent_refs.owner_user_id
              WHERE recent_refs.asset_id = assets.id AND recent_refs.owner_user_id = assets.owner_user_id
                AND recent_refs.campaign_id = $2
                AND recent_turn.turn_number > (SELECT turn_number FROM turns WHERE id = $3) - $7
            ), 0) AS recent_uses
       FROM assets
       JOIN asset_library_entries library ON library.asset_id = assets.id AND library.owner_user_id = assets.owner_user_id
       LEFT JOIN LATERAL (
         SELECT generation.fiction_prompt, generation.entities, generation.characters, generation.locations,
                generation.campaign_id, generation.world_id
           FROM asset_generation_contexts generation
          WHERE generation.asset_id = assets.id AND generation.owner_user_id = assets.owner_user_id
          ORDER BY generation.created_at DESC, generation.id DESC LIMIT 1
       ) context ON true
      WHERE assets.owner_user_id = $1
        AND library.automatic_reuse_enabled = true
        AND library.review_status = 'eligible'
        AND library.archived_at IS NULL
        AND assets.mime_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')
        AND NOT (assets.id = ANY($6::uuid[]))
        AND $5 <> 'shared'
        AND (
          (library.reuse_scope = 'campaign' AND context.campaign_id = $2)
          OR (library.reuse_scope = 'world' AND context.world_id = $4)
          OR library.reuse_scope = 'owner_library'
          OR ($5 = 'shared' AND library.reuse_scope = 'shared')
        )
        AND ($5 <> 'campaign' OR context.campaign_id = $2)
        AND ($5 NOT IN ('campaign', 'world') OR context.world_id = $4)
      ORDER BY ts_rank_cd(
        to_tsvector('simple', concat_ws(' ', library.title, library.caption, array_to_string(library.tags, ' '), COALESCE(context.fiction_prompt, ''))),
        websearch_to_tsquery('simple', $8)
      ) DESC, assets.created_at DESC
      LIMIT 100`,
    [job.owner_user_id, job.campaign_id, job.turn_id, context.world_id, job.matching_scope, excluded,
      job.repetition_window, context.image_prompt]
  );
}

async function attachMatch(client: DatabaseClient, job: ResolutionRow, assetId: string) {
  if (job.segment_id) {
    await client.query(
      `INSERT INTO turn_illustration_segment_assets (
         segment_id, owner_user_id, asset_id, variant_index
       ) VALUES ($1,$2,$3,0)
       ON CONFLICT (segment_id, variant_index)
       DO UPDATE SET asset_id = EXCLUDED.asset_id, image_job_id = NULL, created_at = now()`,
      [job.segment_id, job.owner_user_id, assetId]
    );
    await client.query(
      `UPDATE turn_illustration_segments
          SET status = 'completed', updated_at = now()
        WHERE id = $1 AND owner_user_id = $2`,
      [job.segment_id, job.owner_user_id]
    );
    await client.query(
      `UPDATE turn_illustration_sets sets
          SET status = CASE WHEN NOT EXISTS (
            SELECT 1 FROM turn_illustration_segments segments
             WHERE segments.illustration_set_id = sets.id AND segments.status <> 'completed'
          ) THEN 'completed' ELSE 'partial' END,
          completed_at = CASE WHEN NOT EXISTS (
            SELECT 1 FROM turn_illustration_segments segments
             WHERE segments.illustration_set_id = sets.id AND segments.status <> 'completed'
          ) THEN now() ELSE NULL END
        WHERE sets.id = (
          SELECT illustration_set_id FROM turn_illustration_segments WHERE id = $1
        ) AND sets.owner_user_id = $2`,
      [job.segment_id, job.owner_user_id]
    );
    await client.query(
      `INSERT INTO asset_references (owner_user_id, asset_id, campaign_id, turn_id, asset_role)
       VALUES ($1,$2,$3,$4,'turn_illustration') ON CONFLICT DO NOTHING`,
      [job.owner_user_id, assetId, job.campaign_id, job.turn_id]
    );
    return;
  }
  await client.query("UPDATE turns SET image_url = $3 WHERE id = $1 AND owner_user_id = $2", [job.turn_id, job.owner_user_id, `/api/v1/assets/${assetId}`]);
  await client.query(
    `DELETE FROM asset_references
      WHERE owner_user_id = $1 AND campaign_id = $2 AND turn_id = $3 AND asset_role = 'turn_illustration'`,
    [job.owner_user_id, job.campaign_id, job.turn_id]
  );
  await client.query(
    `INSERT INTO asset_references (owner_user_id, asset_id, campaign_id, turn_id, asset_role)
     VALUES ($1,$2,$3,$4,'turn_illustration') ON CONFLICT DO NOTHING`,
    [job.owner_user_id, assetId, job.campaign_id, job.turn_id]
  );
}

async function markResolutionFailure(pool: DatabasePool, job: ResolutionRow, workerId: string, error: unknown) {
  const details = error as { message?: string; code?: string; permanent?: boolean };
  const terminal = details.permanent === true || job.attempts >= job.max_attempts;
  await withTransaction(pool, async (client) => {
    await client.query(
      `UPDATE illustration_resolution_jobs
          SET status = $3, reason_code = $4, lease_owner = NULL, lease_expires_at = NULL,
              next_attempt_at = now() + (LEAST(attempts, 6)::text || ' minutes')::interval,
              updated_at = now(), completed_at = CASE WHEN $3 = 'failed' THEN now() ELSE NULL END
        WHERE id = $1 AND lease_owner = $2`,
      [job.id, workerId, terminal ? "failed" : "recoverable", String(details.code || details.message || "matcher_failed").slice(0, 200)]
    );
    if (job.segment_id) {
      await client.query(
        `UPDATE turn_illustration_segments
            SET status = $3, updated_at = now()
          WHERE id = $1 AND owner_user_id = $2`,
        [job.segment_id, job.owner_user_id, terminal ? "failed" : "queued"]
      );
      await client.query(
        `UPDATE turn_illustration_sets
            SET status = CASE
              WHEN EXISTS (
                SELECT 1 FROM turn_illustration_segments
                 WHERE illustration_set_id = turn_illustration_sets.id AND status = 'completed'
              ) THEN 'partial'
              WHEN $3 THEN 'failed'
              ELSE 'generating'
            END
          WHERE id = (SELECT illustration_set_id FROM turn_illustration_segments WHERE id = $1)
            AND owner_user_id = $2`,
        [job.segment_id, job.owner_user_id, terminal]
      );
    }
  });
}

export async function runIllustrationResolutionJob(pool: DatabasePool, workerId: string, leaseSeconds: number): Promise<boolean> {
  const job = await claimResolutionJob(pool, workerId, leaseSeconds);
  if (!job) return false;
  const startedAt = Date.now();
  try {
    const outcome = await withTransaction(pool, async (client) => {
      const context = await resolutionContext(client, job);
      const result = await candidates(client, job, context);
      const scored = result.rows
        .map((candidate) => ({ candidate, ...scoreLibraryCandidate({
          imagePrompt: context.image_prompt,
          entities: context.entities,
          campaignId: job.campaign_id,
          worldId: context.world_id
        }, candidate) }))
        .sort((left, right) => right.score - left.score || left.candidate.asset_id.localeCompare(right.candidate.asset_id));
      await client.query("DELETE FROM illustration_match_candidates WHERE resolution_job_id = $1 AND owner_user_id = $2", [job.id, job.owner_user_id]);
      for (const [index, candidate] of scored.slice(0, 10).entries()) {
        await client.query(
          `INSERT INTO illustration_match_candidates (
             resolution_job_id, owner_user_id, asset_id, rank, score, score_components, rejection_reasons
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [job.id, job.owner_user_id, candidate.candidate.asset_id, index + 1, candidate.score,
            JSON.stringify(candidate.components), candidate.rejectionReasons]
        );
      }
      const threshold = THRESHOLDS[job.confidence_profile];
      const best = scored[0];
      const snapshot = { imagePrompt: context.image_prompt, entities: context.entities, worldId: context.world_id, worldVersionId: context.world_version_id,
        excludedAssetIds: job.query_context_snapshot.excludedAssetIds || [] };
      if (best && best.score >= threshold) {
        await attachMatch(client, job, best.candidate.asset_id);
        await client.query(
          `UPDATE illustration_resolution_jobs
              SET status = 'completed', selected_asset_id = $3, selected_score = $4,
                  matching_algorithm_version = $5, resolved_threshold = $6, reason_code = 'matched',
                  query_context_snapshot = $7, lease_owner = NULL, lease_expires_at = NULL,
                  completed_at = now(), updated_at = now()
            WHERE id = $1 AND lease_owner = $2`,
          [job.id, workerId, best.candidate.asset_id, best.score, MATCH_ALGORITHM_VERSION, threshold, JSON.stringify(snapshot)]
        );
        return { kind: "matched" as const, candidateCount: scored.length, selectedAssetId: best.candidate.asset_id, selectedScore: best.score, threshold };
      }
      if (job.source_policy === "library_only") {
        await client.query(
          `UPDATE illustration_resolution_jobs
              SET status = 'no_match', selected_asset_id = NULL, selected_score = NULL,
                  matching_algorithm_version = $3, resolved_threshold = $4, reason_code = 'below_threshold',
                  query_context_snapshot = $5, lease_owner = NULL, lease_expires_at = NULL,
                  completed_at = now(), updated_at = now()
            WHERE id = $1 AND lease_owner = $2`,
          [job.id, workerId, MATCH_ALGORITHM_VERSION, threshold, JSON.stringify(snapshot)]
        );
        if (job.segment_id) {
          await client.query(
            `UPDATE turn_illustration_segments
                SET status = 'failed', updated_at = now()
              WHERE id = $1 AND owner_user_id = $2`,
            [job.segment_id, job.owner_user_id]
          );
          await client.query(
            `UPDATE turn_illustration_sets
                SET status = CASE WHEN EXISTS (
                  SELECT 1 FROM turn_illustration_segments
                   WHERE illustration_set_id = turn_illustration_sets.id AND status = 'completed'
                ) THEN 'partial' ELSE 'failed' END
              WHERE id = (SELECT illustration_set_id FROM turn_illustration_segments WHERE id = $1)
                AND owner_user_id = $2`,
            [job.segment_id, job.owner_user_id]
          );
        }
        return { kind: "no_match" as const, candidateCount: scored.length, selectedAssetId: null, selectedScore: best?.score ?? null, threshold };
      }
      await client.query(
        `UPDATE illustration_resolution_jobs
            SET matching_algorithm_version = $3, resolved_threshold = $4, reason_code = 'generation_required',
                query_context_snapshot = $5, updated_at = now()
          WHERE id = $1 AND lease_owner = $2`,
        [job.id, workerId, MATCH_ALGORITHM_VERSION, threshold, JSON.stringify(snapshot)]
      );
      return { kind: "generate" as const, candidateCount: scored.length, selectedAssetId: null, selectedScore: best?.score ?? null, threshold };
    });
    if (outcome.kind === "generate") {
      const imageJob = job.segment_id
        ? await enqueueSegmentProviderImage(pool, job.segment_id)
        : await enqueueIllustration(pool, job.turn_id, { replace: false });
      await pool.query(
        `UPDATE illustration_resolution_jobs
            SET status = 'generation_queued', image_job_id = $3, reason_code = 'generation_queued',
                lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
          WHERE id = $1 AND lease_owner = $2`,
        [job.id, workerId, imageJob.id]
      );
    }
    logger.info({
      event: "illustration_resolution_completed",
      resolutionJobId: job.id,
      campaignId: job.campaign_id,
      turnId: job.turn_id,
      sourcePolicy: job.source_policy,
      matchingScope: job.matching_scope,
      confidenceProfile: job.confidence_profile,
      algorithmVersion: MATCH_ALGORITHM_VERSION,
      candidateCount: outcome.candidateCount,
      selectedAssetId: outcome.selectedAssetId,
      selectedScore: outcome.selectedScore,
      threshold: outcome.threshold,
      decision: outcome.kind,
      durationMs: Date.now() - startedAt
    });
    return true;
  } catch (error) {
    await markResolutionFailure(pool, job, workerId, error);
    const details = error as { message?: string; code?: string };
    logger.warn({
      event: "illustration_resolution_failed",
      resolutionJobId: job.id,
      campaignId: job.campaign_id,
      turnId: job.turn_id,
      sourcePolicy: job.source_policy,
      matchingScope: job.matching_scope,
      confidenceProfile: job.confidence_profile,
      algorithmVersion: MATCH_ALGORITHM_VERSION,
      reasonCode: details.code || details.message || "matcher_failed",
      durationMs: Date.now() - startedAt
    });
    return true;
  }
}

export async function getTurnIllustrationResolution(pool: DatabasePool, turnId: string) {
  const ownerUserId = await initialOwnerId(pool);
  const result = await pool.query(
    `SELECT jobs.id, jobs.campaign_id AS "campaignId", jobs.turn_id AS "turnId",
            jobs.source_policy AS "sourcePolicy", jobs.matching_scope AS "matchingScope",
            jobs.confidence_profile AS "confidenceProfile", jobs.status,
            jobs.selected_asset_id AS "selectedAssetId", jobs.selected_score::float8 AS "selectedScore",
            jobs.resolved_threshold::float8 AS "resolvedThreshold", jobs.matching_algorithm_version AS "algorithmVersion",
            jobs.image_job_id AS "imageJobId", jobs.reason_code AS "reasonCode",
            jobs.created_at AS "createdAt", jobs.updated_at AS "updatedAt", jobs.completed_at AS "completedAt",
            COALESCE((SELECT jsonb_agg(jsonb_build_object(
              'assetId', candidates.asset_id, 'rank', candidates.rank, 'score', candidates.score::float8,
              'scoreComponents', candidates.score_components, 'rejectionReasons', candidates.rejection_reasons
            ) ORDER BY candidates.rank) FROM illustration_match_candidates candidates
              WHERE candidates.resolution_job_id = jobs.id AND candidates.owner_user_id = jobs.owner_user_id), '[]') AS candidates
       FROM illustration_resolution_jobs jobs
      WHERE jobs.turn_id = $1 AND jobs.owner_user_id = $2`,
    [turnId, ownerUserId]
  );
  if (!result.rows[0]) return null;
  return result.rows[0];
}

export async function rematchTurnIllustration(pool: DatabasePool, turnId: string) {
  const ownerUserId = await initialOwnerId(pool);
  const result = await pool.query<{ id: string }>(
    `UPDATE illustration_resolution_jobs
        SET status = 'queued', selected_asset_id = NULL, selected_score = NULL, image_job_id = NULL,
            query_context_snapshot = jsonb_set(
              query_context_snapshot,
              '{excludedAssetIds}',
              COALESCE(query_context_snapshot->'excludedAssetIds', '[]'::jsonb)
                || CASE WHEN selected_asset_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(selected_asset_id) END,
              true
            ),
            attempts = 0, next_attempt_at = now(), reason_code = 'manual_rematch', completed_at = NULL, updated_at = now()
      WHERE turn_id = $1 AND owner_user_id = $2 AND status IN ('completed', 'no_match', 'failed')
      RETURNING id`,
    [turnId, ownerUserId]
  );
  if (!result.rows[0]) throw Object.assign(new Error("This illustration cannot be rematched in its current state."), { statusCode: 409 });
  return { id: result.rows[0].id, status: "queued" };
}
