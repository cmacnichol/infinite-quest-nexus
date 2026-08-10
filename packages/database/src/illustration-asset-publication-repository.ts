import type {
  PrivateNormalizedAssetFinalizationHandle,
  PrivateNormalizedAssetRequestChildBindingsInput,
  SafeNormalizedAssetPublicationResult
} from "../../application/src/assets/private-normalized-asset-publication.js";
import type { PrivatePublishedIllustrationAsset } from "../../application/src/illustration/private-illustration-asset-publication.js";
import type { DatabaseClient, DatabasePool } from "./pool.js";

const ACTIVE_PARENT_STATUSES = ["assessing", "generating", "validating", "committing"] as const;
const FINALIZATION_LOCATOR_PATTERN = /^narp1\.([0-9a-f]{64})\.([0-9a-f]{64})$/u;

type ImageJobRow = Readonly<{
  id: string;
  owner_user_id: string;
  campaign_id: string | null;
  turn_id: string | null;
  world_id: string | null;
  world_version_id: string | null;
  target_type: "turn_illustration" | "world_cover" | "streaming_illustration";
  segment_id: string | null;
  generation_job_id: string | null;
  image_count: 1 | 2;
  provider_profile_id: string;
  requested_model: string;
  prompt: string;
  prompt_hash: string;
  provider_type: string;
  generation_revision: number;
  remote_job_id: string | null;
  provider_request_metadata: Record<string, unknown>;
  size: string;
  aspect_ratio: string;
  quality: string;
  output_format: string;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  status: string;
}>;

export type PrivateIllustrationPublicationJob = Readonly<{
  id: string;
  ownerUserId: string;
  campaignId: string | null;
  turnId: string | null;
  worldId: string | null;
  worldVersionId: string | null;
  targetType: "turn_illustration" | "world_cover" | "streaming_illustration";
  segmentId: string | null;
  generationJobId: string | null;
  imageCount: 1 | 2;
  providerProfileId: string;
  requestedModel: string;
  prompt: string;
  promptHash: string;
  providerType: string;
  generationRevision: number;
  remoteJobId: string | null;
  providerRequestMetadata: Readonly<Record<string, unknown>>;
  size: string;
  aspectRatio: string;
  quality: string;
  outputFormat: string;
}>;

export type PrivateIllustrationAttachedPublication = Readonly<{
  variantIndex: number;
  result: SafeNormalizedAssetPublicationResult;
  finalization: PrivateNormalizedAssetFinalizationHandle;
}>;

export type PrivateIllustrationCompletionMetadata = Readonly<{
  usage: Readonly<Record<string, unknown>>;
  reportedCost: Readonly<{ amount: string; currency: string }> | null;
  providerMetadata: Readonly<Record<string, unknown>>;
  providerResponseId: string;
  primaryMimeType: string;
  primaryByteLength: number;
}>;

export type PrivatePendingIllustrationFinalization = Readonly<{
  ownerUserId: string;
  imageJobId: string;
  variantIndex: number;
  finalization: PrivateNormalizedAssetFinalizationHandle;
  result: SafeNormalizedAssetPublicationResult;
  publicationState: "committed_finalization_pending" | "published";
}>;

function stableError(code: string): Error {
  return new Error(code);
}

function publicJob(row: ImageJobRow): PrivateIllustrationPublicationJob {
  return Object.freeze({
    id: row.id,
    ownerUserId: row.owner_user_id,
    campaignId: row.campaign_id,
    turnId: row.turn_id,
    worldId: row.world_id,
    worldVersionId: row.world_version_id,
    targetType: row.target_type,
    segmentId: row.segment_id,
    generationJobId: row.generation_job_id,
    imageCount: row.image_count,
    providerProfileId: row.provider_profile_id,
    requestedModel: row.requested_model,
    prompt: row.prompt,
    promptHash: row.prompt_hash,
    providerType: row.provider_type,
    generationRevision: row.generation_revision,
    remoteJobId: row.remote_job_id,
    providerRequestMetadata: Object.freeze({ ...row.provider_request_metadata }),
    size: row.size,
    aspectRatio: row.aspect_ratio,
    quality: row.quality,
    outputFormat: row.output_format
  });
}

const JOB_COLUMNS = `
  job.id,job.owner_user_id,job.campaign_id,job.turn_id,
  COALESCE(job.world_id,world_version.world_id) AS world_id,
  campaign.world_version_id,job.target_type,job.segment_id,job.generation_job_id,
  job.image_count,job.provider_profile_id,job.requested_model,job.prompt,job.prompt_hash,
  job.provider_type,job.generation_revision,job.remote_job_id,job.provider_request_metadata,
  job.size,job.aspect_ratio,job.quality,job.output_format,job.lease_owner,
  job.lease_expires_at,job.status`;

const JOB_OWNER_JOINS = `
  LEFT JOIN campaigns campaign
    ON campaign.id=job.campaign_id AND campaign.owner_user_id=job.owner_user_id
  LEFT JOIN world_versions world_version
    ON world_version.id=campaign.world_version_id
   AND world_version.owner_user_id=job.owner_user_id`;

async function activeParent(
  database: DatabaseClient,
  ownerUserId: string,
  generationJobId: string | null,
): Promise<boolean> {
  if (!generationJobId) return true;
  const parent = await database.query<{ status: string }>(
    "SELECT status FROM generation_jobs WHERE id=$1 AND owner_user_id=$2 FOR UPDATE",
    [generationJobId, ownerUserId],
  );
  return Boolean(parent.rows[0]
    && (ACTIVE_PARENT_STATUSES as readonly string[]).includes(parent.rows[0].status));
}

export type PostgresIllustrationAssetPublicationRepository = Readonly<{
  loadClaimedPublication(input: Readonly<{ imageJobId: string; workerId: string }>): Promise<PrivateIllustrationPublicationJob | null>;
  lockCompletionInTransaction(
    database: DatabaseClient,
    input: Readonly<{
      job: PrivateIllustrationPublicationJob;
      workerId: string;
    }>,
  ): Promise<PrivateIllustrationPublicationJob | null>;
  attachChildrenInTransaction(
    database: DatabaseClient,
    job: PrivateIllustrationPublicationJob,
    variantIndex: number,
    result: SafeNormalizedAssetPublicationResult,
  ): Promise<PrivateNormalizedAssetRequestChildBindingsInput>;
  recordMappingInTransaction(
    database: DatabaseClient,
    job: PrivateIllustrationPublicationJob,
    publication: PrivateIllustrationAttachedPublication,
  ): Promise<void>;
  completeInTransaction(
    database: DatabaseClient,
    job: PrivateIllustrationPublicationJob,
    workerId: string,
    publications: readonly PrivateIllustrationAttachedPublication[],
    metadata: PrivateIllustrationCompletionMetadata,
  ): Promise<void>;
  loadFinalizations(imageJobId: string): Promise<readonly PrivatePendingIllustrationFinalization[]>;
  findPendingFinalization(): Promise<Readonly<{ imageJobId: string }> | null>;
  recordFinalizationRecoverable(input: PrivatePendingIllustrationFinalization): Promise<void>;
  markFinalizationPublished(input: PrivatePendingIllustrationFinalization): Promise<void>;
  readPublishedAssets(imageJobId: string): Promise<readonly PrivatePublishedIllustrationAsset[] | null>;
}>;

export function createPostgresIllustrationAssetPublicationRepository(
  pool: DatabasePool,
): PostgresIllustrationAssetPublicationRepository {
  return Object.freeze({
    async loadClaimedPublication({ imageJobId, workerId }) {
      const candidate = await pool.query<ImageJobRow>(
        `SELECT ${JOB_COLUMNS}
           FROM image_jobs job
           ${JOB_OWNER_JOINS}
          WHERE job.id=$1 AND job.lease_owner=$2
            AND job.lease_expires_at>clock_timestamp()
            AND job.status IN ('generating','provider_pending','downloading')
            AND (
              job.generation_job_id IS NULL
              OR EXISTS (
                SELECT 1
                  FROM generation_jobs parent
                 WHERE parent.id=job.generation_job_id
                   AND parent.owner_user_id=job.owner_user_id
                   AND parent.status IN ('assessing','generating','validating','committing')
              )
            )`,
        [imageJobId, workerId],
      );
      return candidate.rows[0] ? publicJob(candidate.rows[0]) : null;
    },

    async lockCompletionInTransaction(database, { job, workerId }) {
      if (!(await activeParent(database, job.ownerUserId, job.generationJobId))) return null;
      const locked = await database.query<ImageJobRow>(
        `SELECT ${JOB_COLUMNS}
           FROM image_jobs job
           ${JOB_OWNER_JOINS}
          WHERE job.id=$1 AND job.owner_user_id=$2 AND job.lease_owner=$3
            AND job.lease_expires_at>clock_timestamp()
            AND job.status IN ('generating','provider_pending','downloading')
            AND job.generation_revision=$4
          FOR UPDATE OF job`,
        [job.id, job.ownerUserId, workerId, job.generationRevision],
      );
      return locked.rows[0] ? publicJob(locked.rows[0]) : null;
    },

    async attachChildrenInTransaction(database, job, variantIndex, result) {
      const contextIntentKey = `illustration-context-${variantIndex}`;
      const context = await database.query<{ id: string }>(
        `INSERT INTO asset_generation_contexts (
           owner_user_id,asset_id,created_by_user_id,image_job_id,world_id,world_version_id,
           campaign_id,turn_id,target_type,variant_index,fiction_prompt,provider_profile_id,
           provider_type,model,generation_parameters
         ) VALUES ($1,$2,$1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
         RETURNING id`,
        [
          job.ownerUserId,
          result.assetId,
          job.id,
          job.worldId ?? (job.campaignId ? job.worldId : null),
          job.worldVersionId,
          job.campaignId,
          job.turnId,
          job.targetType,
          variantIndex,
          job.prompt,
          job.providerProfileId,
          job.providerType,
          job.requestedModel,
          JSON.stringify({
            size: job.size,
            aspectRatio: job.aspectRatio,
            quality: job.quality,
            outputFormat: job.outputFormat,
            generationRevision: job.generationRevision
          })
        ],
      );
      const references: Array<Readonly<{ intentKey: string; referenceId: string }>> = [];
      if (job.campaignId) {
        const reference = await database.query<{ id: string }>(
          `INSERT INTO asset_references (
             owner_user_id,asset_id,campaign_id,turn_id,asset_role
           ) VALUES ($1,$2,$3,$4,'turn_illustration')
           ON CONFLICT (asset_id,campaign_id,turn_id,asset_role)
           DO UPDATE SET owner_user_id=EXCLUDED.owner_user_id
           RETURNING id`,
          [job.ownerUserId, result.assetId, job.campaignId, job.turnId],
        );
        references.push({
          intentKey: `illustration-reference-${variantIndex}`,
          referenceId: reference.rows[0]!.id
        });
      }
      return Object.freeze({
        contexts: Object.freeze([{
          intentKey: contextIntentKey,
          contextId: context.rows[0]!.id
        }]),
        references: Object.freeze(references)
      });
    },

    async recordMappingInTransaction(database, job, publication) {
      const match = FINALIZATION_LOCATOR_PATTERN.exec(publication.finalization);
      if (!match?.[1] || !match[2]) {
        throw stableError("illustration_publication_locator_invalid");
      }
      const inserted = await database.query<{ request_id: string }>(
        `INSERT INTO image_job_asset_publications (
           image_job_id,owner_user_id,request_id,variant_index,finalization_locator,safe_result
         )
         SELECT $1,$2,request.id,$3,$4,$5::jsonb
           FROM asset_publication_requests request
          WHERE request.owner_user_id=$2
            AND request.request_fingerprint=$6
            AND request.idempotency_key_hash=$7
            AND request.lifecycle IN ('attached','published')
         RETURNING request_id`,
        [
          job.id,
          job.ownerUserId,
          publication.variantIndex,
          publication.finalization,
          JSON.stringify(publication.result),
          match[1],
          match[2]
        ],
      );
      if (!inserted.rows[0]) throw stableError("illustration_publication_mapping_unavailable");
    },

    async completeInTransaction(database, job, workerId, publications, metadata) {
      const ordered = [...publications].sort((left, right) => left.variantIndex - right.variantIndex);
      const primary = ordered[0];
      if (!primary || ordered.length !== job.imageCount) {
        throw stableError("illustration_artifact_count_invalid");
      }
      const usageQuantity = Number(metadata.usage.quantity
        ?? metadata.usage.images
        ?? metadata.usage.image_count);
      const persistedUsageQuantity = Number.isFinite(usageQuantity) && usageQuantity >= 0
        ? usageQuantity
        : ordered.length;
      const usageUnit = String(metadata.usage.unit ?? "image").slice(0, 100);
      const assetIds = ordered.map(({ result }) => result.assetId);
      const completed = await database.query<{ id: string }>(
        `UPDATE image_jobs
            SET status='completed',provider_status='completed',asset_id=$3,
                provider_response_id=COALESCE(NULLIF($4,''),remote_job_id,provider_response_id),
                response_metadata=$5::jsonb,provider_result_metadata=$6::jsonb,provider_progress=100,
                usage_quantity=$7,usage_unit=$8,reported_cost=$9,reported_currency=$10,
                completed_at=now(),updated_at=now(),lease_owner=NULL,lease_expires_at=NULL,
                next_poll_at=NULL,error_code=NULL,error_message=NULL
          WHERE id=$1 AND owner_user_id=$2 AND lease_owner=$11
            AND lease_expires_at>clock_timestamp()
            AND status IN ('generating','provider_pending','downloading')
          RETURNING id`,
        [
          job.id,
          job.ownerUserId,
          primary.result.assetId,
          metadata.providerResponseId,
          JSON.stringify({
            usage: metadata.usage,
            provider: metadata.providerMetadata,
            mimeType: metadata.primaryMimeType,
            byteLength: metadata.primaryByteLength,
            assetIds
          }),
          JSON.stringify({ ...metadata.providerMetadata, artifactCount: ordered.length, assetIds }),
          persistedUsageQuantity,
          usageUnit,
          metadata.reportedCost?.amount ?? null,
          metadata.reportedCost?.currency ?? null,
          workerId
        ],
      );
      if (!completed.rows[0]) throw stableError("illustration_publication_lease_lost");

      if (job.segmentId) {
        for (const publication of ordered) {
          const bound = await database.query<{ segment_id: string }>(
            `INSERT INTO turn_illustration_segment_assets (
               segment_id,owner_user_id,asset_id,image_job_id,variant_index
             )
             SELECT segment.id,$2,$3,$1,$4
               FROM turn_illustration_segments segment
              WHERE segment.id=$5 AND segment.owner_user_id=$2
                AND segment.campaign_id=$6
                AND segment.turn_id IS NOT DISTINCT FROM $7::uuid
             ON CONFLICT (segment_id,variant_index)
             DO UPDATE SET asset_id=EXCLUDED.asset_id,image_job_id=EXCLUDED.image_job_id
             RETURNING segment_id`,
            [
              job.id,
              job.ownerUserId,
              publication.result.assetId,
              publication.variantIndex,
              job.segmentId,
              job.campaignId,
              job.turnId
            ],
          );
          if (!bound.rows[0]) throw stableError("illustration_segment_provenance_lost");
        }
      }

      if (job.campaignId && metadata.reportedCost) {
        await database.query(
          `INSERT INTO provider_cost_events (
             owner_user_id,campaign_id,turn_id,provider_profile_id,generation_job_id,image_job_id,
             local_call_id,provider_type,provider_response_id,category,operation,requested_model,
             resolved_model,amount,currency,usage_metadata
           ) VALUES ($1,$2,$3,$4,$5,$6,$6,$7,NULLIF($8,''),'image','illustration',$9,$9,$10,$11,$12::jsonb)
           ON CONFLICT DO NOTHING`,
          [
            job.ownerUserId,
            job.campaignId,
            job.turnId,
            job.providerProfileId,
            job.generationJobId,
            job.id,
            job.providerType,
            metadata.providerResponseId,
            job.requestedModel,
            metadata.reportedCost.amount,
            metadata.reportedCost.currency,
            JSON.stringify(metadata.usage)
          ],
        );
      }
      if (job.targetType === "world_cover") {
        await database.query(
          "UPDATE worlds SET cover_asset_id=$3,updated_at=now() WHERE id=$1 AND owner_user_id=$2",
          [job.worldId, job.ownerUserId, primary.result.assetId],
        );
      } else if (!job.segmentId && job.turnId) {
        await database.query(
          "UPDATE turns SET image_url=$3 WHERE id=$1 AND owner_user_id=$2",
          [job.turnId, job.ownerUserId, `/api/v1/assets/${primary.result.assetId}`],
        );
      }
      if (job.segmentId) {
        await database.query(
          "UPDATE turn_illustration_segments SET status='completed',updated_at=now() WHERE id=$1 AND owner_user_id=$2",
          [job.segmentId, job.ownerUserId],
        );
        await database.query(
          `UPDATE turn_illustration_sets sets
              SET status=CASE
                    WHEN NOT EXISTS (
                      SELECT 1 FROM turn_illustration_segments segment
                       WHERE segment.illustration_set_id=sets.id AND segment.status<>'completed'
                    ) THEN 'completed'
                    WHEN EXISTS (
                      SELECT 1 FROM turn_illustration_segments segment
                       WHERE segment.illustration_set_id=sets.id AND segment.status='completed'
                    ) THEN 'partial'
                    ELSE 'generating'
                  END,
                  completed_at=CASE WHEN NOT EXISTS (
                    SELECT 1 FROM turn_illustration_segments segment
                     WHERE segment.illustration_set_id=sets.id AND segment.status<>'completed'
                  ) THEN now() ELSE NULL END
            WHERE sets.id=(SELECT illustration_set_id FROM turn_illustration_segments WHERE id=$1)
              AND sets.owner_user_id=$2`,
          [job.segmentId, job.ownerUserId],
        );
      }
      await database.query(
        `UPDATE illustration_resolution_jobs
            SET status='completed',reason_code='generated',completed_at=now(),updated_at=now()
          WHERE image_job_id=$1 AND owner_user_id=$2 AND status='generation_queued'`,
        [job.id, job.ownerUserId],
      );
    },

    async loadFinalizations(imageJobId) {
      const result = await pool.query<Readonly<{
        owner_user_id: string;
        image_job_id: string;
        variant_index: number;
        finalization_locator: string;
        safe_result: SafeNormalizedAssetPublicationResult;
        publication_state: "committed_finalization_pending" | "published";
      }>>(
        `SELECT mapping.owner_user_id,mapping.image_job_id,mapping.variant_index,
                mapping.finalization_locator,mapping.safe_result,mapping.publication_state
           FROM image_job_asset_publications mapping
           JOIN image_jobs job
             ON job.id=mapping.image_job_id AND job.owner_user_id=mapping.owner_user_id
          WHERE mapping.image_job_id=$1 AND job.status='completed'
          ORDER BY mapping.variant_index`,
        [imageJobId],
      );
      return Object.freeze(result.rows.map((row) => Object.freeze({
        ownerUserId: row.owner_user_id,
        imageJobId: row.image_job_id,
        variantIndex: row.variant_index,
        finalization: row.finalization_locator as PrivateNormalizedAssetFinalizationHandle,
        result: Object.freeze(row.safe_result),
        publicationState: row.publication_state
      })));
    },

    async findPendingFinalization() {
      const result = await pool.query<Readonly<{ image_job_id: string }>>(
        `SELECT mapping.image_job_id
           FROM image_job_asset_publications mapping
           JOIN image_jobs job
             ON job.id=mapping.image_job_id AND job.owner_user_id=mapping.owner_user_id
          WHERE job.status='completed'
            AND mapping.publication_state='committed_finalization_pending'
          ORDER BY mapping.last_attempt_at NULLS FIRST,mapping.created_at,mapping.image_job_id
          LIMIT 1`,
      );
      const row = result.rows[0];
      return row ? Object.freeze({ imageJobId: row.image_job_id }) : null;
    },

    async recordFinalizationRecoverable(input) {
      await pool.query(
        `UPDATE image_job_asset_publications
            SET finalization_attempts=finalization_attempts+1,
                last_diagnostic='asset_publication_finalization_recoverable',last_attempt_at=now()
          WHERE image_job_id=$1 AND owner_user_id=$2 AND variant_index=$3
            AND publication_state='committed_finalization_pending'`,
        [input.imageJobId, input.ownerUserId, input.variantIndex],
      );
    },

    async markFinalizationPublished(input) {
      const updated = await pool.query<{ publication_state: string }>(
        `UPDATE image_job_asset_publications
            SET publication_state='published',finalization_attempts=finalization_attempts+1,
                last_diagnostic=NULL,last_attempt_at=now(),published_at=now()
          WHERE image_job_id=$1 AND owner_user_id=$2 AND variant_index=$3
            AND publication_state='committed_finalization_pending'
          RETURNING publication_state`,
        [input.imageJobId, input.ownerUserId, input.variantIndex],
      );
      if (updated.rows[0]) return;
      const replay = await pool.query<{ publication_state: string }>(
        `SELECT publication_state
           FROM image_job_asset_publications
          WHERE image_job_id=$1 AND owner_user_id=$2 AND variant_index=$3
            AND publication_state='published'
            AND finalization_locator=$4
            AND safe_result=$5::jsonb`,
        [
          input.imageJobId,
          input.ownerUserId,
          input.variantIndex,
          input.finalization,
          JSON.stringify(input.result)
        ],
      );
      if (!replay.rows[0]) throw stableError("illustration_finalization_mapping_unavailable");
    },

    async readPublishedAssets(imageJobId) {
      const result = await pool.query<Readonly<{
        image_count: number;
        variant_index: number | null;
        publication_state: string | null;
        safe_result: SafeNormalizedAssetPublicationResult | null;
      }>>(
        `SELECT job.image_count,mapping.variant_index,mapping.publication_state,mapping.safe_result
           FROM image_jobs job
           LEFT JOIN image_job_asset_publications mapping
             ON mapping.image_job_id=job.id AND mapping.owner_user_id=job.owner_user_id
          WHERE job.id=$1 AND job.status='completed'
          ORDER BY mapping.variant_index`,
        [imageJobId],
      );
      const expected = result.rows[0]?.image_count;
      if (!expected
        || result.rows.length !== expected
        || result.rows.some((row) => row.publication_state !== "published" || !row.safe_result)) {
        return null;
      }
      return Object.freeze(result.rows.map((row) => Object.freeze({
        variantIndex: row.variant_index!,
        assetId: row.safe_result!.assetId,
        contentHash: row.safe_result!.contentHash
      })));
    }
  });
}
