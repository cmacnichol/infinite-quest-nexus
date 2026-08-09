import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  createDatabasePool,
  initialOwnerId,
  type DatabasePool
} from "../../packages/database/src/pool.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

function randomHash(): string {
  return crypto.randomUUID().replaceAll("-", "").padEnd(64, "0");
}

integration("Task 14e3e3 illustration publication", () => {
  let pool: DatabasePool;
  let ownerUserId = "";
  let archiveRoot = "";
  let assetRoot = "";

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
    archiveRoot = await mkdtemp(join(tmpdir(), "iqn-e3-archive-"));
    assetRoot = await mkdtemp(join(tmpdir(), "iqn-e3-assets-"));
    await mkdir(join(assetRoot, "assets"));
  });

  afterAll(async () => {
    await pool.end();
    await rm(archiveRoot, { recursive: true, force: true });
    await rm(assetRoot, { recursive: true, force: true });
  });

  it("records a committed image-job variant as finalization-pending without path or bearer authority", async () => {
    const requestFingerprint = randomHash();
    const idempotencyKeyHash = randomHash();
    const contentHash = randomHash();
    const finalizationLocator = `narp1.${requestFingerprint}.${idempotencyKeyHash}`;
    const provider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (
         owner_user_id,name,provider_type,provider_role,base_url,default_model
       ) VALUES ($1,$2,'openai_compatible','image','http://provider.invalid','test-image')
       RETURNING id`,
      [ownerUserId, `14e3e3-provider-${crypto.randomUUID()}`],
    );
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title) VALUES ($1,$2) RETURNING id",
      [ownerUserId, `14e3e3-world-${crypto.randomUUID()}`],
    );
    const imageJob = await pool.query<{ id: string }>(
      `INSERT INTO image_jobs (
         owner_user_id,provider_profile_id,requested_model,prompt,prompt_hash,
         provider_type,world_id,target_type,status,lease_owner
       ) VALUES ($1,$2,'test-image','A quiet painted observatory',$3,
                 'openai_compatible',$4,'world_cover','downloading','worker-e3')
       RETURNING id`,
      [ownerUserId, provider.rows[0]!.id, requestFingerprint, world.rows[0]!.id],
    );
    const assetId = crypto.randomUUID();
    const safeResult = { assetId, contentHash };
    await pool.query(
      `INSERT INTO asset_publication_identities (
         asset_id,owner_user_id,idempotency_key_hash,request_fingerprint,lifecycle,result,pending_finalization
       ) VALUES ($1,$2,$3,$4,'attached',$5::jsonb,'{}'::jsonb)`,
      [assetId, ownerUserId, idempotencyKeyHash, requestFingerprint, JSON.stringify(safeResult)],
    );
    await pool.query(
      `INSERT INTO asset_publication_content_arbitrations (
         owner_user_id,content_hash,canonical_asset_id,verification_state
       ) VALUES ($1,$2,$3,'verified')`,
      [ownerUserId, contentHash, assetId],
    );
    const request = await pool.query<{ id: string }>(
      `INSERT INTO asset_publication_requests (
         owner_user_id,idempotency_key_hash,request_fingerprint,canonical_content_hash,
         canonical_asset_id,lifecycle,provenance_snapshot,result
       ) VALUES ($1,$2,$3,$4,$5,'attached',$6::jsonb,$7::jsonb)
       RETURNING id`,
      [
        ownerUserId,
        idempotencyKeyHash,
        requestFingerprint,
        contentHash,
        assetId,
        JSON.stringify({ kind: "illustration", imageJobId: imageJob.rows[0]!.id, variantIndex: 0 }),
        JSON.stringify(safeResult),
      ],
    );
    await pool.query(
      `INSERT INTO asset_publication_request_results (request_id,owner_user_id,result)
       VALUES ($1,$2,$3::jsonb)`,
      [request.rows[0]!.id, ownerUserId, JSON.stringify(safeResult)],
    );

    const mapping = await pool.query<{
      image_job_id: string;
      owner_user_id: string;
      request_id: string;
      variant_index: number;
      publication_state: string;
      finalization_locator: string;
    }>(
      `INSERT INTO image_job_asset_publications (
         image_job_id,owner_user_id,request_id,variant_index,finalization_locator,safe_result
       ) VALUES ($1,$2,$3,0,$4,$5::jsonb)
       RETURNING image_job_id,owner_user_id,request_id,variant_index,
                 publication_state,finalization_locator`,
      [
        imageJob.rows[0]!.id,
        ownerUserId,
        request.rows[0]!.id,
        finalizationLocator,
        JSON.stringify(safeResult),
      ],
    );

    expect(mapping.rows).toEqual([{
      image_job_id: imageJob.rows[0]!.id,
      owner_user_id: ownerUserId,
      request_id: request.rows[0]!.id,
      variant_index: 0,
      publication_state: "committed_finalization_pending",
      finalization_locator: finalizationLocator
    }]);
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='image_job_asset_publications'
        ORDER BY column_name`,
    );
    expect(columns.rows.map((row) => row.column_name)).not.toEqual(
      expect.arrayContaining(["path", "storage_path", "descriptor", "bearer", "provider_response_url"]),
    );
    await expect(pool.query(
      `INSERT INTO image_job_asset_publications (
         image_job_id,owner_user_id,request_id,variant_index,finalization_locator,safe_result
       ) VALUES ($1,$2,$3,0,$4,$5::jsonb)`,
      [
        imageJob.rows[0]!.id,
        ownerUserId,
        request.rows[0]!.id,
        finalizationLocator,
        JSON.stringify(safeResult),
      ],
    )).rejects.toMatchObject({ code: "23505" });
    await expect(pool.query(
      `DELETE FROM image_job_asset_publications
        WHERE image_job_id=$1 AND owner_user_id=$2 AND variant_index=0`,
      [imageJob.rows[0]!.id, ownerUserId],
    )).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(
      `UPDATE image_job_asset_publications
          SET variant_index=1
        WHERE image_job_id=$1 AND owner_user_id=$2 AND variant_index=0`,
      [imageJob.rows[0]!.id, ownerUserId],
    )).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(
      `UPDATE image_job_asset_publications
          SET publication_state='published',published_at=clock_timestamp()
        WHERE image_job_id=$1 AND owner_user_id=$2 AND variant_index=0
        RETURNING publication_state`,
      [imageJob.rows[0]!.id, ownerUserId],
    )).rejects.toMatchObject({ code: "23514" });
    await pool.query(
      `UPDATE asset_publication_requests
          SET lifecycle='published',published_at=clock_timestamp()
        WHERE id=$1 AND owner_user_id=$2`,
      [request.rows[0]!.id, ownerUserId],
    );
    await expect(pool.query(
      `UPDATE image_job_asset_publications
          SET publication_state='published',published_at=clock_timestamp()
        WHERE image_job_id=$1 AND owner_user_id=$2 AND variant_index=0
        RETURNING publication_state`,
      [imageJob.rows[0]!.id, ownerUserId],
    )).resolves.toMatchObject({ rows: [{ publication_state: "published" }] });
    await expect(pool.query(
      `UPDATE image_job_asset_publications
          SET finalization_locator=$3
        WHERE image_job_id=$1 AND owner_user_id=$2 AND variant_index=0`,
      [imageJob.rows[0]!.id, ownerUserId, `narp1.${"d".repeat(64)}.${idempotencyKeyHash}`],
    )).rejects.toMatchObject({ code: "23514" });
  });

  it("publishes a claimed world-cover artifact through the normalized private composition", async () => {
    const provider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (
         owner_user_id,name,provider_type,provider_role,base_url,default_model
       ) VALUES ($1,$2,'openai_compatible','image','http://provider.invalid','e3-image')
       RETURNING id`,
      [ownerUserId, `14e3e3-world-provider-${crypto.randomUUID()}`],
    );
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title) VALUES ($1,$2) RETURNING id",
      [ownerUserId, `14e3e3-published-world-${crypto.randomUUID()}`],
    );
    const workerId = `14e3e3-worker-${crypto.randomUUID()}`;
    const promptHash = randomHash();
    const imageJob = await pool.query<{ id: string }>(
      `INSERT INTO image_jobs (
         owner_user_id,provider_profile_id,requested_model,prompt,prompt_hash,
         provider_type,world_id,target_type,status,lease_owner,lease_expires_at,image_count
       ) VALUES ($1,$2,'e3-image','A storm-lit observatory',$3,
                 'openai_compatible',$4,'world_cover','generating',$5,now()+interval '1 minute',1)
       RETURNING id`,
      [ownerUserId, provider.rows[0]!.id, promptHash, world.rows[0]!.id, workerId],
    );
    const imageBytes = await sharp({
      create: {
        width: 24,
        height: 12,
        channels: 3,
        background: { r: 40, g: 60, b: 90 }
      }
    }).png().toBuffer();
    const downloads: string[] = [];
    const module = await import(
      "../../services/runtime/src/illustration-asset-publication-composition.js"
    );
    const composition = await module.createPrivateIllustrationAssetPublicationComposition(
      pool,
      { archiveRoot, assetRoot },
      {
        async downloadArtifact(input: Readonly<{ imageJobId: string }>) {
          downloads.push(input.imageJobId);
          return { bytes: imageBytes, mimeType: "image/png; source=provider" };
        }
      },
    );
    try {
      const outcome = await composition.coordinator.completeClaimedImageJob({
        imageJobId: imageJob.rows[0]!.id,
        workerId,
        result: {
          status: "completed",
          providerRole: "image",
          providerProfileId: provider.rows[0]!.id,
          model: "e3-image",
          metadata: { responseId: `e3-response-${crypto.randomUUID()}`, temporaryUrl: "https://invalid/artifact" },
          artifactDownloadTimeoutMs: 5_000,
          allowPrivateArtifactHosts: false,
          generationTimeoutMs: 60_000,
          artifacts: [{ source: "base64", base64: "ignored", mimeType: "image/png" }],
          usage: { quantity: 1, unit: "image" },
          reportedCost: null
        }
      });

      expect(outcome).toMatchObject({
        outcome: "published",
        assets: [{ variantIndex: 0, contentHash: expect.stringMatching(/^[0-9a-f]{64}$/u) }]
      });
      expect(downloads).toEqual([imageJob.rows[0]!.id]);
      const stored = await pool.query<{
        status: string;
        asset_id: string;
        cover_asset_id: string;
        publication_state: string;
        request_lifecycle: string;
        contexts: number;
        references: number;
        derivatives: number;
        response_metadata: Record<string, unknown>;
        provider_result_metadata: Record<string, unknown>;
      }>(
        `SELECT job.status,job.asset_id,world.cover_asset_id,mapping.publication_state,
                request.lifecycle AS request_lifecycle,
                (SELECT count(*)::integer FROM asset_generation_contexts context
                  WHERE context.image_job_id=job.id AND context.owner_user_id=job.owner_user_id) AS contexts,
                (SELECT count(*)::integer FROM asset_references reference
                  WHERE reference.asset_id=job.asset_id AND reference.owner_user_id=job.owner_user_id) AS references,
                (SELECT count(*)::integer FROM asset_derivatives derivative
                  WHERE derivative.source_asset_id=job.asset_id AND derivative.owner_user_id=job.owner_user_id) AS derivatives,
                job.response_metadata,job.provider_result_metadata
           FROM image_jobs job
           JOIN worlds world ON world.id=job.world_id AND world.owner_user_id=job.owner_user_id
           JOIN image_job_asset_publications mapping
             ON mapping.image_job_id=job.id AND mapping.owner_user_id=job.owner_user_id
           JOIN asset_publication_requests request
             ON request.id=mapping.request_id AND request.owner_user_id=mapping.owner_user_id
          WHERE job.id=$1`,
        [imageJob.rows[0]!.id],
      );
      expect(stored.rows).toEqual([expect.objectContaining({
        status: "completed",
        asset_id: outcome.outcome === "published" ? outcome.assets[0]!.assetId : "",
        cover_asset_id: outcome.outcome === "published" ? outcome.assets[0]!.assetId : "",
        publication_state: "published",
        request_lifecycle: "published",
        contexts: 1,
        references: 0,
        derivatives: 1
      })]);
      expect(stored.rows[0]!.response_metadata).toMatchObject({ mimeType: "image/png" });
      expect(JSON.stringify(stored.rows[0]!.provider_result_metadata)).not.toMatch(/url|token|secret/iu);
    } finally {
      await composition.close();
    }
  });

  it("does not download or mutate a job when the caller does not hold its lease", async () => {
    const provider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (
         owner_user_id,name,provider_type,provider_role,base_url,default_model
       ) VALUES ($1,$2,'openai_compatible','image','http://provider.invalid','e3-image')
       RETURNING id`,
      [ownerUserId, `14e3e3-noop-provider-${crypto.randomUUID()}`],
    );
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title) VALUES ($1,$2) RETURNING id",
      [ownerUserId, `14e3e3-noop-world-${crypto.randomUUID()}`],
    );
    const imageJob = await pool.query<{ id: string }>(
      `INSERT INTO image_jobs (
         owner_user_id,provider_profile_id,requested_model,prompt,prompt_hash,
         provider_type,world_id,target_type,status,lease_owner,lease_expires_at,image_count
       ) VALUES ($1,$2,'e3-image','Quiet mountain observatory',$3,
                 'openai_compatible',$4,'world_cover','generating','actual-worker',now()+interval '1 minute',1)
       RETURNING id`,
      [ownerUserId, provider.rows[0]!.id, randomHash(), world.rows[0]!.id],
    );
    let downloads = 0;
    const module = await import(
      "../../services/runtime/src/illustration-asset-publication-composition.js"
    );
    const composition = await module.createPrivateIllustrationAssetPublicationComposition(
      pool,
      { archiveRoot, assetRoot },
      {
        async downloadArtifact() {
          downloads += 1;
          throw new Error("should_not_download");
        }
      },
    );
    try {
      await expect(composition.coordinator.completeClaimedImageJob({
        imageJobId: imageJob.rows[0]!.id,
        workerId: "wrong-worker",
        result: {
          status: "completed",
          providerRole: "image",
          providerProfileId: provider.rows[0]!.id,
          model: "e3-image",
          metadata: {},
          artifactDownloadTimeoutMs: 5_000,
          allowPrivateArtifactHosts: false,
          generationTimeoutMs: 60_000,
          artifacts: [{ source: "base64", base64: "ignored", mimeType: "image/png" }],
          usage: {},
          reportedCost: null
        }
      })).resolves.toEqual({ outcome: "noop" });
      expect(downloads).toBe(0);
      await expect(pool.query(
        "SELECT status,lease_owner FROM image_jobs WHERE id=$1",
        [imageJob.rows[0]!.id],
      )).resolves.toMatchObject({ rows: [{ status: "generating", lease_owner: "actual-worker" }] });
    } finally {
      await composition.close();
    }
  });

  it("rejects an artifact-count mismatch without mutating the claimed job", async () => {
    const provider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (
         owner_user_id,name,provider_type,provider_role,base_url,default_model
       ) VALUES ($1,$2,'openai_compatible','image','http://provider.invalid','e3-image')
       RETURNING id`,
      [ownerUserId, `14e3e3-count-provider-${crypto.randomUUID()}`],
    );
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title) VALUES ($1,$2) RETURNING id",
      [ownerUserId, `14e3e3-count-world-${crypto.randomUUID()}`],
    );
    const workerId = `count-worker-${crypto.randomUUID()}`;
    const imageJob = await pool.query<{ id: string }>(
      `INSERT INTO image_jobs (
         owner_user_id,provider_profile_id,requested_model,prompt,prompt_hash,
         provider_type,world_id,target_type,status,lease_owner,lease_expires_at,image_count
       ) VALUES ($1,$2,'e3-image','Two impossible observatories',$3,
                 'openai_compatible',$4,'world_cover','generating',$5,now()+interval '1 minute',2)
       RETURNING id`,
      [ownerUserId, provider.rows[0]!.id, randomHash(), world.rows[0]!.id, workerId],
    );
    let downloads = 0;
    const module = await import(
      "../../services/runtime/src/illustration-asset-publication-composition.js"
    );
    const composition = await module.createPrivateIllustrationAssetPublicationComposition(
      pool,
      { archiveRoot, assetRoot },
      {
        async downloadArtifact() {
          downloads += 1;
          throw new Error("should_not_download");
        }
      },
    );
    try {
      await expect(composition.coordinator.completeClaimedImageJob({
        imageJobId: imageJob.rows[0]!.id,
        workerId,
        result: {
          status: "completed",
          providerRole: "image",
          providerProfileId: provider.rows[0]!.id,
          model: "e3-image",
          metadata: {},
          artifactDownloadTimeoutMs: 5_000,
          allowPrivateArtifactHosts: false,
          generationTimeoutMs: 60_000,
          artifacts: [{ source: "base64", base64: "ignored", mimeType: "image/png" }],
          usage: {},
          reportedCost: null
        }
      })).rejects.toThrow("illustration_artifact_count_invalid");
      expect(downloads).toBe(0);
      await expect(pool.query(
        `SELECT job.status,job.provider_status,
                (SELECT count(*)::integer FROM image_job_asset_publications mapping
                  WHERE mapping.image_job_id=job.id) AS mappings
           FROM image_jobs job WHERE job.id=$1`,
        [imageJob.rows[0]!.id],
      )).resolves.toMatchObject({ rows: [{
        status: "generating",
        provider_status: null,
        mappings: 0
      }] });
    } finally {
      await composition.close();
    }
  });
});
