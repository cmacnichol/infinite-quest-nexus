import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  PrivateCompletedIllustrationImageExecutionResult,
  PrivateIllustrationAssetPublicationCoordinator
} from "../../packages/application/src/illustration/private-illustration-asset-publication.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  createDatabasePool,
  initialOwnerId,
  type DatabasePool
} from "../../packages/database/src/pool.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

type TestComposition = Readonly<{
  coordinator: PrivateIllustrationAssetPublicationCoordinator;
  close(): Promise<void>;
}>;

type CampaignScope = Readonly<{
  ownerUserId: string;
  providerProfileId: string;
  worldId: string;
  worldVersionId: string;
  campaignId: string;
  turnId: string;
}>;

function randomHash(): string {
  return crypto.randomUUID().replaceAll("-", "").padEnd(64, "0");
}

function completedResult(
  providerProfileId: string,
  artifactCount: number,
  reportedCost: Readonly<{ amount: string; currency: string }> | null = null,
): PrivateCompletedIllustrationImageExecutionResult {
  return Object.freeze({
    status: "completed" as const,
    providerRole: "image" as const,
    providerProfileId,
    model: "e3-matrix-image",
    metadata: Object.freeze({
      responseId: `e3-matrix-response-${crypto.randomUUID()}`,
      temporaryUrl: "https://provider.invalid/temporary-artifact",
      nested: Object.freeze({ bearerToken: "must-not-persist", safe: true })
    }),
    artifactDownloadTimeoutMs: 5_000,
    allowPrivateArtifactHosts: false,
    generationTimeoutMs: 60_000,
    artifacts: Object.freeze(Array.from({ length: artifactCount }, (_, index) => Object.freeze({
      source: "base64" as const,
      base64: `ignored-${index}`,
      mimeType: "image/png"
    }))),
    usage: Object.freeze({ quantity: artifactCount, unit: "image", cached: false }),
    reportedCost
  });
}

integration("Task 14e3e3 illustration publication matrix", () => {
  let pool: DatabasePool;
  let initialUserId = "";
  let archiveRoot = "";
  let assetRoot = "";
  const compositions = new Set<TestComposition>();

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 8);
    await migrateDatabase(pool, resolve("database/migrations"));
    initialUserId = await initialOwnerId(pool);
    archiveRoot = await mkdtemp(join(tmpdir(), "iqn-e3-matrix-archive-"));
    assetRoot = await mkdtemp(join(tmpdir(), "iqn-e3-matrix-assets-"));
    await mkdir(join(assetRoot, "assets"));
  });

  afterEach(async () => {
    await Promise.all([...compositions].map((composition) => composition.close().catch(() => undefined)));
    compositions.clear();
  });

  afterAll(async () => {
    await pool.end();
    await rm(archiveRoot, { recursive: true, force: true });
    await rm(assetRoot, { recursive: true, force: true });
  });

  async function createProvider(ownerUserId: string): Promise<string> {
    const provider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (
         owner_user_id,name,provider_type,provider_role,base_url,default_model
       ) VALUES ($1,$2,'openai_compatible','image','http://provider.invalid','e3-matrix-image')
       RETURNING id`,
      [ownerUserId, `e3-matrix-provider-${crypto.randomUUID()}`],
    );
    return provider.rows[0]!.id;
  }

  async function createCampaignScope(
    ownerUserId = initialUserId,
    turnNumber = 1,
  ): Promise<CampaignScope> {
    const providerProfileId = await createProvider(ownerUserId);
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title) VALUES ($1,$2) RETURNING id",
      [ownerUserId, `e3-matrix-world-${crypto.randomUUID()}`],
    );
    const worldVersion = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id,owner_user_id,version_number,content)
       VALUES ($1,$2,1,'{}'::jsonb) RETURNING id`,
      [world.rows[0]!.id, ownerUserId],
    );
    const campaign = await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id,world_version_id,title) VALUES ($1,$2,$3) RETURNING id",
      [ownerUserId, worldVersion.rows[0]!.id, `e3-matrix-campaign-${crypto.randomUUID()}`],
    );
    const turn = await pool.query<{ id: string }>(
      `INSERT INTO turns (owner_user_id,campaign_id,turn_number,narration,image_prompt)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [
        ownerUserId,
        campaign.rows[0]!.id,
        turnNumber,
        "The accepted narration remains authoritative.",
        "A quiet observatory beyond the pines"
      ],
    );
    return Object.freeze({
      ownerUserId,
      providerProfileId,
      worldId: world.rows[0]!.id,
      worldVersionId: worldVersion.rows[0]!.id,
      campaignId: campaign.rows[0]!.id,
      turnId: turn.rows[0]!.id
    });
  }

  async function png(red: number, green: number, blue: number): Promise<Buffer> {
    return sharp({
      create: {
        width: 32,
        height: 18,
        channels: 3,
        background: { r: red, g: green, b: blue }
      }
    }).png().toBuffer();
  }

  async function compose(
    download: (input: Readonly<{ ownerUserId: string; imageJobId: string; artifact: unknown }>) => Promise<Readonly<{
      bytes: Uint8Array;
      mimeType: string;
    }>>,
  ): Promise<TestComposition> {
    const module = await import(
      "../../services/runtime/src/illustration-asset-publication-composition.js"
    );
    const composition = await module.createPrivateIllustrationAssetPublicationComposition(
      pool,
      { archiveRoot, assetRoot },
      { downloadArtifact: download },
    );
    compositions.add(composition);
    return composition;
  }

  async function insertTurnImageJob(
    scope: CampaignScope,
    workerId: string,
    input: Readonly<{
      imageCount?: 1 | 2;
      segmentId?: string | null;
      generationJobId?: string | null;
      targetType?: "turn_illustration" | "streaming_illustration";
      turnId?: string | null;
    }> = {},
  ): Promise<string> {
    const imageJob = await pool.query<{ id: string }>(
      `INSERT INTO image_jobs (
         owner_user_id,campaign_id,turn_id,provider_profile_id,requested_model,prompt,prompt_hash,
         provider_type,target_type,segment_id,generation_job_id,status,lease_owner,
         lease_expires_at,image_count
       ) VALUES ($1,$2,$3,$4,'e3-matrix-image','A quiet observatory beyond the pines',$5,
                 'openai_compatible',$6,$7,$8,'generating',$9,now()+interval '2 minutes',$10)
       RETURNING id`,
      [
        scope.ownerUserId,
        scope.campaignId,
        input.turnId === undefined ? scope.turnId : input.turnId,
        scope.providerProfileId,
        randomHash(),
        input.targetType ?? "turn_illustration",
        input.segmentId ?? null,
        input.generationJobId ?? null,
        workerId,
        input.imageCount ?? 1
      ],
    );
    return imageJob.rows[0]!.id;
  }

  async function insertWorldImageJob(
    ownerUserId: string,
    providerProfileId: string,
    worldId: string,
    workerId: string,
  ): Promise<string> {
    const imageJob = await pool.query<{ id: string }>(
      `INSERT INTO image_jobs (
         owner_user_id,provider_profile_id,requested_model,prompt,prompt_hash,provider_type,
         world_id,target_type,status,lease_owner,lease_expires_at,image_count
       ) VALUES ($1,$2,'e3-matrix-image','A moonlit world atlas',$3,'openai_compatible',
                 $4,'world_cover','generating',$5,now()+interval '2 minutes',1)
       RETURNING id`,
      [ownerUserId, providerProfileId, randomHash(), worldId, workerId],
    );
    return imageJob.rows[0]!.id;
  }

  it("atomically publishes one- and two-variant segments with contexts, references, cost, and resolution state", async () => {
    const scope = await createCampaignScope();
    const set = await pool.query<{ id: string }>(
      `INSERT INTO turn_illustration_sets (
         owner_user_id,campaign_id,turn_id,source_text_hash,segment_word_count,
         images_per_segment,prompt_mode,status
       ) VALUES ($1,$2,$3,$4,500,2,'direct','generating') RETURNING id`,
      [scope.ownerUserId, scope.campaignId, scope.turnId, randomHash()],
    );
    const segmentIds: string[] = [];
    for (const ordinal of [0, 1]) {
      const segment = await pool.query<{ id: string }>(
        `INSERT INTO turn_illustration_segments (
           owner_user_id,illustration_set_id,campaign_id,turn_id,ordinal,start_offset,end_offset,
           start_word,end_word,source_text,source_text_hash,direct_prompt,resolved_prompt,status
         ) VALUES ($1,$2,$3,$4,$5,0,20,0,4,'Accepted scene text',$6,
                   'A calm painted scene','A calm painted scene','generating') RETURNING id`,
        [scope.ownerUserId, set.rows[0]!.id, scope.campaignId, scope.turnId, ordinal, randomHash()],
      );
      segmentIds.push(segment.rows[0]!.id);
    }
    const firstWorker = `e3-segment-one-${crypto.randomUUID()}`;
    const secondWorker = `e3-segment-two-${crypto.randomUUID()}`;
    const firstJobId = await insertTurnImageJob(scope, firstWorker, {
      imageCount: 1,
      segmentId: segmentIds[0]!
    });
    const secondJobId = await insertTurnImageJob(scope, secondWorker, {
      imageCount: 2,
      segmentId: segmentIds[1]!
    });
    for (const [segmentId, imageJobId] of [[segmentIds[0]!, firstJobId], [segmentIds[1]!, secondJobId]]) {
      await pool.query(
        `INSERT INTO illustration_resolution_jobs (
           owner_user_id,campaign_id,turn_id,segment_id,source_policy,matching_scope,
           confidence_profile,status,image_job_id
         ) VALUES ($1,$2,$3,$4,'library_then_generate','campaign','balanced','generation_queued',$5)`,
        [scope.ownerUserId, scope.campaignId, scope.turnId, segmentId, imageJobId],
      );
    }
    const images = [await png(10, 20, 30), await png(40, 50, 60), await png(70, 80, 90)];
    let nextImage = 0;
    const composition = await compose(async () => ({
      bytes: images[nextImage++]!,
      mimeType: "image/png"
    }));

    const first = await composition.coordinator.completeClaimedImageJob({
      imageJobId: firstJobId,
      workerId: firstWorker,
      result: completedResult(scope.providerProfileId, 1, { amount: "0.10", currency: "USD" })
    });
    const second = await composition.coordinator.completeClaimedImageJob({
      imageJobId: secondJobId,
      workerId: secondWorker,
      result: completedResult(scope.providerProfileId, 2, { amount: "0.20", currency: "USD" })
    });
    expect(first).toMatchObject({ outcome: "published", assets: [{ variantIndex: 0 }] });
    expect(second).toMatchObject({
      outcome: "published",
      assets: [{ variantIndex: 0 }, { variantIndex: 1 }]
    });

    await expect(pool.query(
      `SELECT sets.status,
              (SELECT count(*)::integer FROM turn_illustration_segments segment
                WHERE segment.illustration_set_id=sets.id AND segment.status='completed') AS completed_segments,
              (SELECT count(*)::integer FROM turn_illustration_segment_assets binding
                JOIN turn_illustration_segments segment ON segment.id=binding.segment_id
                WHERE segment.illustration_set_id=sets.id) AS segment_assets,
              (SELECT count(*)::integer FROM asset_generation_contexts context
                WHERE context.image_job_id IN ($2,$3) AND context.world_id=$4
                  AND context.world_version_id=$5) AS contexts,
              (SELECT count(*)::integer FROM asset_references reference
                WHERE reference.campaign_id=$6 AND reference.turn_id=$7) AS references,
              (SELECT count(*)::integer FROM provider_cost_events cost
                WHERE cost.image_job_id IN ($2,$3)) AS costs,
              (SELECT count(*)::integer FROM illustration_resolution_jobs resolution
                WHERE resolution.image_job_id IN ($2,$3)
                  AND resolution.status='completed' AND resolution.reason_code='generated') AS resolutions
         FROM turn_illustration_sets sets WHERE sets.id=$1`,
      [
        set.rows[0]!.id,
        firstJobId,
        secondJobId,
        scope.worldId,
        scope.worldVersionId,
        scope.campaignId,
        scope.turnId
      ],
    )).resolves.toMatchObject({ rows: [{
      status: "completed",
      completed_segments: 2,
      segment_assets: 3,
      contexts: 3,
      references: 3,
      costs: 2,
      resolutions: 2
    }] });
    await expect(composition.coordinator.completeClaimedImageJob({
      imageJobId: secondJobId,
      workerId: secondWorker,
      result: completedResult(scope.providerProfileId, 2, { amount: "0.20", currency: "USD" })
    })).resolves.toEqual({ outcome: "noop" });
    await expect(pool.query(
      "SELECT count(*)::integer AS costs FROM provider_cost_events WHERE image_job_id IN ($1,$2)",
      [firstJobId, secondJobId],
    )).resolves.toMatchObject({ rows: [{ costs: 2 }] });
  });

  it("publishes a legacy turn, conditionally references it, and reuses same-owner content", async () => {
    const scope = await createCampaignScope();
    const secondTurn = await pool.query<{ id: string }>(
      `INSERT INTO turns (owner_user_id,campaign_id,turn_number,narration,image_prompt)
       VALUES ($1,$2,2,'A second accepted narration','A quiet observatory') RETURNING id`,
      [scope.ownerUserId, scope.campaignId],
    );
    const firstWorker = `e3-turn-first-${crypto.randomUUID()}`;
    const secondWorker = `e3-turn-second-${crypto.randomUUID()}`;
    const firstJobId = await insertTurnImageJob(scope, firstWorker);
    const secondJobId = await insertTurnImageJob(scope, secondWorker, { turnId: secondTurn.rows[0]!.id });
    const sharedBytes = await png(90, 30, 15);
    const composition = await compose(async () => ({ bytes: sharedBytes, mimeType: "image/png" }));

    const first = await composition.coordinator.completeClaimedImageJob({
      imageJobId: firstJobId,
      workerId: firstWorker,
      result: completedResult(scope.providerProfileId, 1)
    });
    const second = await composition.coordinator.completeClaimedImageJob({
      imageJobId: secondJobId,
      workerId: secondWorker,
      result: completedResult(scope.providerProfileId, 1)
    });
    expect(first).toMatchObject({ outcome: "published" });
    expect(second).toMatchObject({ outcome: "published" });
    if (first.outcome !== "published" || second.outcome !== "published") return;
    expect(second.assets[0]!.assetId).toBe(first.assets[0]!.assetId);
    await expect(pool.query(
      `SELECT
         (SELECT count(*)::integer FROM asset_generation_contexts context
           WHERE context.image_job_id IN ($1,$2)) AS contexts,
         (SELECT count(*)::integer FROM asset_references reference
           WHERE reference.asset_id=$3 AND reference.campaign_id=$4) AS references,
         (SELECT count(*)::integer FROM turns turn_record
           WHERE turn_record.id IN ($5,$6) AND turn_record.image_url=$7) AS linked_turns`,
      [
        firstJobId,
        secondJobId,
        first.assets[0]!.assetId,
        scope.campaignId,
        scope.turnId,
        secondTurn.rows[0]!.id,
        `/api/v1/assets/${first.assets[0]!.assetId}`
      ],
    )).resolves.toMatchObject({ rows: [{ contexts: 2, references: 2, linked_turns: 2 }] });
  });

  it("no-ops when the parent is inactive or becomes inactive before the caller transaction", async () => {
    const scope = await createCampaignScope();
    const generation = await pool.query<{ id: string }>(
      `INSERT INTO generation_jobs (
         owner_user_id,campaign_id,provider_profile_id,idempotency_key,expected_turn_number,
         action,status,requested_model
       ) VALUES ($1,$2,$3,$4,2,'continue','completed','e3-matrix-image') RETURNING id`,
      [scope.ownerUserId, scope.campaignId, scope.providerProfileId, `e3-parent-${crypto.randomUUID()}`],
    );
    const inactiveWorker = `e3-parent-inactive-${crypto.randomUUID()}`;
    const inactiveJobId = await insertTurnImageJob(scope, inactiveWorker, {
      generationJobId: generation.rows[0]!.id,
      targetType: "streaming_illustration",
      turnId: null
    });
    let downloads = 0;
    const image = await png(25, 50, 75);
    const composition = await compose(async () => {
      downloads += 1;
      return { bytes: image, mimeType: "image/png" };
    });
    await expect(composition.coordinator.completeClaimedImageJob({
      imageJobId: inactiveJobId,
      workerId: inactiveWorker,
      result: completedResult(scope.providerProfileId, 1)
    })).resolves.toEqual({ outcome: "noop" });
    expect(downloads).toBe(0);

    await pool.query("UPDATE generation_jobs SET status='generating' WHERE id=$1", [generation.rows[0]!.id]);
    const racingWorker = `e3-parent-race-${crypto.randomUUID()}`;
    const racingJobId = await insertTurnImageJob(scope, racingWorker, {
      generationJobId: generation.rows[0]!.id,
      targetType: "streaming_illustration",
      turnId: null
    });
    let raced = false;
    const racing = await compose(async () => {
      if (!raced) {
        raced = true;
        await pool.query("UPDATE generation_jobs SET status='completed' WHERE id=$1", [generation.rows[0]!.id]);
      }
      return { bytes: image, mimeType: "image/png" };
    });
    await expect(racing.coordinator.completeClaimedImageJob({
      imageJobId: racingJobId,
      workerId: racingWorker,
      result: completedResult(scope.providerProfileId, 1)
    })).resolves.toEqual({ outcome: "noop" });
    await expect(pool.query(
      `SELECT job.status,
              (SELECT count(*)::integer FROM image_job_asset_publications mapping
                WHERE mapping.image_job_id=job.id) AS mappings,
              (SELECT count(*)::integer FROM asset_generation_contexts context
                WHERE context.image_job_id=job.id) AS contexts
         FROM image_jobs job WHERE job.id IN ($1,$2) ORDER BY job.id`,
      [inactiveJobId, racingJobId],
    )).resolves.toMatchObject({ rows: [
      expect.objectContaining({ status: "generating", mappings: 0, contexts: 0 }),
      expect.objectContaining({ status: "generating", mappings: 0, contexts: 0 })
    ] });
  });

  it("rechecks lease freshness after waiting for the parent lock", async () => {
    const scope = await createCampaignScope();
    const generation = await pool.query<{ id: string }>(
      `INSERT INTO generation_jobs (
         owner_user_id,campaign_id,provider_profile_id,idempotency_key,expected_turn_number,
         action,status,requested_model
       ) VALUES ($1,$2,$3,$4,2,'continue','generating','e3-matrix-image') RETURNING id`,
      [scope.ownerUserId, scope.campaignId, scope.providerProfileId, `e3-lease-parent-${crypto.randomUUID()}`],
    );
    const workerId = `e3-expiring-lease-${crypto.randomUUID()}`;
    const imageJobId = await insertTurnImageJob(scope, workerId, {
      generationJobId: generation.rows[0]!.id,
      targetType: "streaming_illustration",
      turnId: null
    });
    const blocker = await pool.connect();
    let blockerOpen = false;
    try {
      await blocker.query("BEGIN");
      blockerOpen = true;
      const blockerBackend = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await blocker.query(
        "SELECT id FROM generation_jobs WHERE id=$1 FOR UPDATE",
        [generation.rows[0]!.id],
      );
      const expiry = await pool.query<{ lease_expires_at: Date }>(
        `UPDATE image_jobs
            SET lease_expires_at=clock_timestamp()+interval '2 seconds'
          WHERE id=$1
          RETURNING lease_expires_at`,
        [imageJobId],
      );
      const image = await png(11, 22, 33);
      const composition = await compose(async () => ({ bytes: image, mimeType: "image/png" }));
      const completion = composition.coordinator.completeClaimedImageJob({
        imageJobId,
        workerId,
        result: completedResult(scope.providerProfileId, 1)
      });

      let blocked = false;
      for (let attempt = 0; attempt < 500 && !blocked; attempt += 1) {
        const activity = await pool.query<{ blocked: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
              WHERE datname=current_database()
                AND $1::int=ANY(pg_blocking_pids(pid))
                AND state='active'
                AND wait_event_type='Lock'
           ) AS blocked`,
          [blockerBackend.rows[0]!.pid],
        );
        blocked = activity.rows[0]!.blocked;
        if (!blocked) await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
      }
      expect(blocked).toBe(true);
      await blocker.query(
        `SELECT pg_sleep(
           GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.05
         )`,
        [expiry.rows[0]!.lease_expires_at],
      );
      await blocker.query("COMMIT");
      blockerOpen = false;

      await expect(completion).resolves.toEqual({ outcome: "noop" });
      await expect(pool.query(
        `SELECT job.status,
                (SELECT count(*)::integer FROM image_job_asset_publications mapping
                  WHERE mapping.image_job_id=job.id) AS mappings,
                (SELECT count(*)::integer FROM asset_generation_contexts context
                  WHERE context.image_job_id=job.id) AS contexts
           FROM image_jobs job WHERE job.id=$1`,
        [imageJobId],
      )).resolves.toMatchObject({ rows: [{ status: "generating", mappings: 0, contexts: 0 }] });
    } finally {
      if (blockerOpen) await blocker.query("ROLLBACK");
      blocker.release();
    }
  });

  it("rolls back attachments when the lease expires before the final completion fence", async () => {
    const scope = await createCampaignScope();
    const workerId = `e3-expiring-completion-${crypto.randomUUID()}`;
    const imageJobId = await insertTurnImageJob(scope, workerId);
    const expiry = await pool.query<{ lease_expires_at: Date }>(
      `UPDATE image_jobs
          SET lease_expires_at=clock_timestamp()+interval '2 seconds'
        WHERE id=$1
        RETURNING lease_expires_at`,
      [imageJobId],
    );
    await pool.query(
      `CREATE FUNCTION task_14e3e3_completion_lease_gate() RETURNS trigger
       LANGUAGE plpgsql AS $gate$
       BEGIN
         PERFORM pg_advisory_xact_lock(hashtext(NEW.image_job_id::text));
         RETURN NEW;
       END;
       $gate$`,
    );
    await pool.query(
      `CREATE TRIGGER task_14e3e3_completion_lease_gate_trigger
       BEFORE INSERT ON image_job_asset_publications
       FOR EACH ROW EXECUTE FUNCTION task_14e3e3_completion_lease_gate()`,
    );
    const blocker = await pool.connect();
    let blockerOpen = false;
    try {
      await blocker.query("BEGIN");
      blockerOpen = true;
      const blockerBackend = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [imageJobId]);
      const image = await png(19, 29, 39);
      const composition = await compose(async () => ({ bytes: image, mimeType: "image/png" }));
      const completion = composition.coordinator.completeClaimedImageJob({
        imageJobId,
        workerId,
        result: completedResult(scope.providerProfileId, 1, { amount: "0.10", currency: "USD" })
      });

      let blocked = false;
      for (let attempt = 0; attempt < 500 && !blocked; attempt += 1) {
        const activity = await pool.query<{ blocked: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
              WHERE datname=current_database()
                AND $1::int=ANY(pg_blocking_pids(pid))
                AND state='active'
                AND wait_event_type='Lock'
                AND query LIKE '%INSERT INTO image_job_asset_publications%'
           ) AS blocked`,
          [blockerBackend.rows[0]!.pid],
        );
        blocked = activity.rows[0]!.blocked;
        if (!blocked) await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
      }
      expect(blocked).toBe(true);
      await blocker.query(
        `SELECT pg_sleep(
           GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.05
         )`,
        [expiry.rows[0]!.lease_expires_at],
      );
      await blocker.query("COMMIT");
      blockerOpen = false;

      await expect(completion).rejects.toThrow("illustration_publication_lease_lost");
      await expect(pool.query(
        `SELECT job.status,turn.image_url,
                (SELECT count(*)::integer FROM image_job_asset_publications mapping
                  WHERE mapping.image_job_id=job.id) AS mappings,
                (SELECT count(*)::integer FROM asset_generation_contexts context
                  WHERE context.image_job_id=job.id) AS contexts,
                (SELECT count(*)::integer FROM asset_references reference
                  WHERE reference.owner_user_id=job.owner_user_id
                    AND reference.campaign_id=job.campaign_id
                    AND reference.turn_id=job.turn_id) AS references,
                (SELECT count(*)::integer FROM provider_cost_events cost
                  WHERE cost.image_job_id=job.id) AS costs
           FROM image_jobs job
           JOIN turns turn ON turn.id=job.turn_id AND turn.owner_user_id=job.owner_user_id
          WHERE job.id=$1`,
        [imageJobId],
      )).resolves.toMatchObject({ rows: [{
        status: "generating",
        image_url: "",
        mappings: 0,
        contexts: 0,
        references: 0,
        costs: 0
      }] });
    } finally {
      if (blockerOpen) await blocker.query("ROLLBACK");
      blocker.release();
      await pool.query(
        "DROP TRIGGER IF EXISTS task_14e3e3_completion_lease_gate_trigger ON image_job_asset_publications",
      );
      await pool.query("DROP FUNCTION IF EXISTS task_14e3e3_completion_lease_gate()");
    }
  });

  it("rolls back every attachment and preserves cross-owner published content when the second mapping fails", async () => {
    const firstScope = await createCampaignScope();
    const sharedBytes = await png(120, 40, 10);
    const firstWorker = `e3-retained-owner-${crypto.randomUUID()}`;
    const firstJobId = await insertWorldImageJob(
      firstScope.ownerUserId,
      firstScope.providerProfileId,
      firstScope.worldId,
      firstWorker,
    );
    const firstComposition = await compose(async () => ({ bytes: sharedBytes, mimeType: "image/png" }));
    const published = await firstComposition.coordinator.completeClaimedImageJob({
      imageJobId: firstJobId,
      workerId: firstWorker,
      result: completedResult(firstScope.providerProfileId, 1)
    });
    expect(published).toMatchObject({ outcome: "published" });
    if (published.outcome !== "published") return;
    const retained = await pool.query<{ storage_path: string }>(
      "SELECT storage_path FROM assets WHERE id=$1 AND owner_user_id=$2",
      [published.assets[0]!.assetId, firstScope.ownerUserId],
    );

    const secondOwner = await pool.query<{ id: string }>(
      "INSERT INTO users (display_name,status) VALUES ($1,'active') RETURNING id",
      [`e3-matrix-second-owner-${crypto.randomUUID()}`],
    );
    const secondScope = await createCampaignScope(secondOwner.rows[0]!.id);
    const secondWorker = `e3-rollback-owner-${crypto.randomUUID()}`;
    const secondJobId = await insertTurnImageJob(secondScope, secondWorker, { imageCount: 2 });
    await pool.query(
      `CREATE FUNCTION task_14e3e3_mapping_fault() RETURNS trigger
       LANGUAGE plpgsql AS $fault$
       BEGIN
         RAISE EXCEPTION 'task_14e3e3_mapping_fault';
       END;
       $fault$`,
    );
    await pool.query(
      `CREATE TRIGGER task_14e3e3_mapping_fault_trigger
       BEFORE INSERT ON image_job_asset_publications
       FOR EACH ROW WHEN (NEW.variant_index=1)
       EXECUTE FUNCTION task_14e3e3_mapping_fault()`,
    );
    const uniqueBytes = await png(20, 80, 140);
    const pendingDownloads = [sharedBytes, uniqueBytes];
    const secondComposition = await compose(async () => ({
      bytes: pendingDownloads.shift()!,
      mimeType: "image/png"
    }));
    try {
      await expect(secondComposition.coordinator.completeClaimedImageJob({
        imageJobId: secondJobId,
        workerId: secondWorker,
        result: completedResult(secondScope.providerProfileId, 2, { amount: "0.20", currency: "USD" })
      })).rejects.toThrow("task_14e3e3_mapping_fault");
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS task_14e3e3_mapping_fault_trigger ON image_job_asset_publications");
      await pool.query("DROP FUNCTION IF EXISTS task_14e3e3_mapping_fault()");
    }
    await expect(pool.query(
      `SELECT job.status,turn.image_url,
              (SELECT count(*)::integer FROM image_job_asset_publications mapping
                WHERE mapping.image_job_id=job.id) AS mappings,
              (SELECT count(*)::integer FROM asset_generation_contexts context
                WHERE context.image_job_id=job.id) AS contexts,
              (SELECT count(*)::integer FROM asset_references reference
                WHERE reference.owner_user_id=job.owner_user_id
                  AND reference.campaign_id=job.campaign_id
                  AND reference.turn_id=job.turn_id) AS references,
              (SELECT count(*)::integer FROM assets asset
                JOIN asset_publication_requests request
                  ON request.canonical_asset_id=asset.id AND request.owner_user_id=asset.owner_user_id
                WHERE request.provenance_snapshot->>'imageJobId'=job.id::text) AS assets,
              (SELECT count(*)::integer FROM provider_cost_events cost
                WHERE cost.image_job_id=job.id) AS costs
         FROM image_jobs job
         JOIN turns turn ON turn.id=job.turn_id AND turn.owner_user_id=job.owner_user_id
        WHERE job.id=$1`,
      [secondJobId],
    )).resolves.toMatchObject({ rows: [{
      status: "generating",
      image_url: "",
      mappings: 0,
      contexts: 0,
      references: 0,
      assets: 0,
      costs: 0
    }] });
    await expect(readFile(join(assetRoot, retained.rows[0]!.storage_path))).resolves.toEqual(sharedBytes);
  });

  it("keeps a committed finalization fault durable and recovers after module reset without downloading", async () => {
    const scope = await createCampaignScope();
    const workerId = `e3-finalization-${crypto.randomUUID()}`;
    const imageJobId = await insertWorldImageJob(
      scope.ownerUserId,
      scope.providerProfileId,
      scope.worldId,
      workerId,
    );
    const image = await png(15, 75, 130);
    let downloads = 0;
    const first = await compose(async () => {
      downloads += 1;
      return { bytes: image, mimeType: "image/png" };
    });
    await pool.query(
      `CREATE FUNCTION task_14e3e3_finalize_fault() RETURNS trigger
       LANGUAGE plpgsql AS $fault$
       BEGIN
         RAISE EXCEPTION 'task_14e3e3_finalize_fault';
       END;
       $fault$`,
    );
    await pool.query(
      `CREATE TRIGGER task_14e3e3_finalize_fault_trigger
       BEFORE UPDATE ON durable_filesystem_operations
       FOR EACH ROW WHEN (NEW.lifecycle='finalized')
       EXECUTE FUNCTION task_14e3e3_finalize_fault()`,
    );
    let pending;
    try {
      pending = await first.coordinator.completeClaimedImageJob({
        imageJobId,
        workerId,
        result: completedResult(scope.providerProfileId, 1)
      });
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS task_14e3e3_finalize_fault_trigger ON durable_filesystem_operations");
      await pool.query("DROP FUNCTION IF EXISTS task_14e3e3_finalize_fault()");
    }
    expect(pending).toEqual({
      outcome: "committed_finalization_pending",
      diagnostic: "asset_publication_finalization_recoverable"
    });
    expect(downloads).toBe(1);
    await expect(pool.query(
      `SELECT job.status,world.cover_asset_id,mapping.publication_state,
              mapping.finalization_attempts,request.lifecycle AS request_lifecycle
         FROM image_jobs job
         JOIN worlds world ON world.id=job.world_id AND world.owner_user_id=job.owner_user_id
         JOIN image_job_asset_publications mapping
           ON mapping.image_job_id=job.id AND mapping.owner_user_id=job.owner_user_id
         JOIN asset_publication_requests request
           ON request.id=mapping.request_id AND request.owner_user_id=mapping.owner_user_id
        WHERE job.id=$1`,
      [imageJobId],
    )).resolves.toMatchObject({ rows: [{
      status: "completed",
      cover_asset_id: expect.any(String),
      publication_state: "committed_finalization_pending",
      finalization_attempts: 1,
      request_lifecycle: "attached"
    }] });

    await first.close();
    compositions.delete(first);
    vi.resetModules();
    let recoveryDownloads = 0;
    const restarted = await compose(async () => {
      recoveryDownloads += 1;
      throw new Error("provider_must_not_rerun");
    });
    await pool.query(
      `CREATE FUNCTION task_14e3e3_mapping_promote_gate() RETURNS trigger
       LANGUAGE plpgsql AS $gate$
       BEGIN
         PERFORM pg_advisory_xact_lock(hashtext(NEW.image_job_id::text));
         RETURN NEW;
       END;
       $gate$`,
    );
    await pool.query(
      `CREATE TRIGGER task_14e3e3_mapping_promote_gate_trigger
       BEFORE UPDATE ON image_job_asset_publications
       FOR EACH ROW WHEN (NEW.publication_state='published')
       EXECUTE FUNCTION task_14e3e3_mapping_promote_gate()`,
    );
    const blocker = await pool.connect();
    let blockerOpen = false;
    try {
      await blocker.query("BEGIN");
      blockerOpen = true;
      await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [imageJobId]);
      const recoveries = [0, 1].map((ordinal) => restarted.coordinator.recoverFinalization({
        imageJobId,
        workerId: `e3-recovery-${ordinal}-${crypto.randomUUID()}`,
        leaseSeconds: 30
      }));
      let blockedRecoveries = 0;
      for (let attempt = 0; attempt < 500 && blockedRecoveries < 2; attempt += 1) {
        const activity = await pool.query<{ blocked_recoveries: number }>(
          `SELECT count(*)::integer AS blocked_recoveries
             FROM pg_stat_activity
            WHERE datname=current_database()
              AND state='active'
              AND wait_event_type='Lock'
              AND query LIKE '%UPDATE image_job_asset_publications%'`,
        );
        blockedRecoveries = activity.rows[0]!.blocked_recoveries;
        if (blockedRecoveries < 2) {
          await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
        }
      }
      expect(blockedRecoveries).toBe(2);
      await blocker.query("COMMIT");
      blockerOpen = false;
      await expect(Promise.all(recoveries)).resolves.toEqual([
        expect.objectContaining({
          outcome: "published",
          assets: [expect.objectContaining({ variantIndex: 0 })]
        }),
        expect.objectContaining({
          outcome: "published",
          assets: [expect.objectContaining({ variantIndex: 0 })]
        })
      ]);
    } finally {
      if (blockerOpen) await blocker.query("ROLLBACK");
      blocker.release();
      await pool.query(
        "DROP TRIGGER IF EXISTS task_14e3e3_mapping_promote_gate_trigger ON image_job_asset_publications",
      );
      await pool.query("DROP FUNCTION IF EXISTS task_14e3e3_mapping_promote_gate()");
    }
    expect(recoveryDownloads).toBe(0);
    expect(downloads).toBe(1);
  });

  it("discovers and recovers a completed job's pending finalization after restart", async () => {
    const scope = await createCampaignScope();
    const workerId = `e3-sweep-finalization-${crypto.randomUUID()}`;
    const imageJobId = await insertWorldImageJob(
      scope.ownerUserId,
      scope.providerProfileId,
      scope.worldId,
      workerId,
    );
    const image = await png(25, 95, 145);
    let downloads = 0;
    const first = await compose(async () => {
      downloads += 1;
      return { bytes: image, mimeType: "image/png" };
    });
    await pool.query(
      `CREATE FUNCTION task_14e3e3_sweep_finalize_fault() RETURNS trigger
       LANGUAGE plpgsql AS $fault$
       BEGIN
         RAISE EXCEPTION 'task_14e3e3_sweep_finalize_fault';
       END;
       $fault$`,
    );
    await pool.query(
      `CREATE TRIGGER task_14e3e3_sweep_finalize_fault_trigger
       BEFORE UPDATE ON durable_filesystem_operations
       FOR EACH ROW WHEN (NEW.lifecycle='finalized')
       EXECUTE FUNCTION task_14e3e3_sweep_finalize_fault()`,
    );
    try {
      await expect(first.coordinator.completeClaimedImageJob({
        imageJobId,
        workerId,
        result: completedResult(scope.providerProfileId, 1)
      })).resolves.toEqual({
        outcome: "committed_finalization_pending",
        diagnostic: "asset_publication_finalization_recoverable"
      });
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS task_14e3e3_sweep_finalize_fault_trigger ON durable_filesystem_operations",
      );
      await pool.query("DROP FUNCTION IF EXISTS task_14e3e3_sweep_finalize_fault()");
    }
    await first.close();
    compositions.delete(first);
    vi.resetModules();

    const restarted = await compose(async () => {
      throw new Error("provider_must_not_rerun");
    });
    await expect(restarted.coordinator.recoverNextFinalization({
      workerId: `e3-sweep-recovery-${crypto.randomUUID()}`,
      leaseSeconds: 30
    })).resolves.toMatchObject({
      outcome: "published",
      assets: [{ variantIndex: 0 }]
    });
    expect(downloads).toBe(1);
    await expect(pool.query(
      `SELECT mapping.publication_state,request.lifecycle
         FROM image_job_asset_publications mapping
         JOIN asset_publication_requests request
           ON request.id=mapping.request_id AND request.owner_user_id=mapping.owner_user_id
        WHERE mapping.image_job_id=$1`,
      [imageJobId],
    )).resolves.toMatchObject({ rows: [{
      publication_state: "published",
      lifecycle: "published"
    }] });
  });

  it("returns a safe no-op when finalization recovery finds no committed mapping", async () => {
    const composition = await compose(async () => {
      throw new Error("recovery_must_not_download");
    });
    await expect(composition.coordinator.recoverFinalization({
      imageJobId: crypto.randomUUID(),
      workerId: `e3-uncommitted-recovery-${crypto.randomUUID()}`,
      leaseSeconds: 30
    })).resolves.toEqual({ outcome: "noop" });
  });

  it("keeps post-commit mapping-finalization repository faults recoverable without a provider retry", async () => {
    const scope = await createCampaignScope();
    const workerId = `e3-postcommit-fault-${crypto.randomUUID()}`;
    const imageJobId = await insertWorldImageJob(
      scope.ownerUserId,
      scope.providerProfileId,
      scope.worldId,
      workerId,
    );
    const image = await png(180, 25, 90);
    let downloads = 0;
    const composition = await compose(async () => {
      downloads += 1;
      return { bytes: image, mimeType: "image/png" };
    });
    await pool.query(
      `CREATE FUNCTION task_14e3e3_mapping_postcommit_fault() RETURNS trigger
       LANGUAGE plpgsql AS $fault$
       BEGIN
         RAISE EXCEPTION 'task_14e3e3_mapping_postcommit_fault';
       END;
       $fault$`,
    );
    await pool.query(
      `CREATE TRIGGER task_14e3e3_mapping_postcommit_fault_trigger
       BEFORE UPDATE ON image_job_asset_publications
       FOR EACH ROW WHEN (NEW.publication_state='published')
       EXECUTE FUNCTION task_14e3e3_mapping_postcommit_fault()`,
    );
    try {
      await expect(composition.coordinator.completeClaimedImageJob({
        imageJobId,
        workerId,
        result: completedResult(scope.providerProfileId, 1)
      })).resolves.toEqual({
        outcome: "committed_finalization_pending",
        diagnostic: "asset_publication_finalization_recoverable"
      });
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS task_14e3e3_mapping_postcommit_fault_trigger ON image_job_asset_publications",
      );
      await pool.query("DROP FUNCTION IF EXISTS task_14e3e3_mapping_postcommit_fault()");
    }
    expect(downloads).toBe(1);
    await expect(composition.coordinator.recoverFinalization({
      imageJobId,
      workerId: `e3-postcommit-recovery-${crypto.randomUUID()}`,
      leaseSeconds: 30
    })).resolves.toMatchObject({ outcome: "published", assets: [{ variantIndex: 0 }] });
    expect(downloads).toBe(1);
  });

  it("does not begin downloads after ingress waits beyond the claimed lease", async () => {
    const scope = await createCampaignScope();
    const workerId = `e3-ingress-lease-${crypto.randomUUID()}`;
    const imageJobId = await insertTurnImageJob(scope, workerId);
    const expiry = await pool.query<{ lease_expires_at: Date }>(
      `UPDATE image_jobs
          SET lease_expires_at=clock_timestamp()+interval '2 seconds'
        WHERE id=$1
        RETURNING lease_expires_at`,
      [imageJobId],
    );
    const blocker = await pool.connect();
    let blockerOpen = false;
    let downloads = 0;
    try {
      await blocker.query("BEGIN");
      blockerOpen = true;
      const blockerBackend = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await blocker.query("LOCK TABLE image_jobs IN ACCESS EXCLUSIVE MODE");
      const image = await png(44, 55, 66);
      const composition = await compose(async () => {
        downloads += 1;
        return { bytes: image, mimeType: "image/png" };
      });
      const completion = composition.coordinator.completeClaimedImageJob({
        imageJobId,
        workerId,
        result: completedResult(scope.providerProfileId, 1)
      });
      let blocked = false;
      for (let attempt = 0; attempt < 500 && !blocked; attempt += 1) {
        const activity = await pool.query<{ blocked: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
              WHERE datname=current_database()
                AND $1::int=ANY(pg_blocking_pids(pid))
                AND state='active'
                AND wait_event_type='Lock'
           ) AS blocked`,
          [blockerBackend.rows[0]!.pid],
        );
        blocked = activity.rows[0]!.blocked;
        if (!blocked) await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
      }
      expect(blocked).toBe(true);
      await blocker.query(
        `SELECT pg_sleep(
           GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.05
         )`,
        [expiry.rows[0]!.lease_expires_at],
      );
      await blocker.query("COMMIT");
      blockerOpen = false;
      await expect(completion).resolves.toEqual({ outcome: "noop" });
      expect(downloads).toBe(0);
    } finally {
      if (blockerOpen) await blocker.query("ROLLBACK");
      blocker.release();
    }
  });

  it("holds a released variant's exact content lock through paused rollback deletion", async () => {
    let releaseDelete!: () => void;
    let signalDelete!: () => void;
    const deletePaused = new Promise<void>((resolve) => { signalDelete = resolve; });
    const allowDelete = new Promise<void>((resolve) => { releaseDelete = resolve; });
    let pauseDelete = false;
    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return {
        ...actual,
        async unlink(path: Parameters<typeof actual.unlink>[0]) {
          // The descriptor-anchored adapter deletes through /proc/self/fd,
          // so the concrete syscall path is not rooted at assetRoot.
          if (pauseDelete) {
            pauseDelete = false;
            signalDelete();
            await allowDelete;
          }
          return actual.unlink(path);
        }
      };
    });
    const firstScope = await createCampaignScope();
    const firstWorker = `e3-paused-rollback-a-${crypto.randomUUID()}`;
    const firstJobId = await insertTurnImageJob(firstScope, firstWorker, { imageCount: 2 });
    const sharedBytes = await png(90, 40, 20);
    const uniqueBytes = await png(20, 40, 90);
    const firstDownloads = [sharedBytes, uniqueBytes];
    const firstWithSequence = await compose(async () => ({
      bytes: firstDownloads.shift()!,
      mimeType: "image/png"
    }));
    await pool.query(
      `CREATE FUNCTION task_14e3e3_partial_attach_fault() RETURNS trigger
       LANGUAGE plpgsql AS $fault$
       BEGIN
         IF NEW.image_job_id::text=TG_ARGV[0] AND NEW.variant_index=0 THEN
           RAISE EXCEPTION 'task_14e3e3_partial_attach_fault';
         END IF;
         RETURN NEW;
       END;
       $fault$`,
    );
    await pool.query(
      `CREATE TRIGGER task_14e3e3_partial_attach_fault_trigger
       BEFORE INSERT ON image_job_asset_publications
       FOR EACH ROW EXECUTE FUNCTION task_14e3e3_partial_attach_fault('${firstJobId}')`,
    );
    pauseDelete = true;
    const firstCompletion = firstWithSequence.coordinator.completeClaimedImageJob({
      imageJobId: firstJobId,
      workerId: firstWorker,
      result: completedResult(firstScope.providerProfileId, 2)
    });
    try {
      await deletePaused;
      await pool.query("DROP TRIGGER task_14e3e3_partial_attach_fault_trigger ON image_job_asset_publications");
      await pool.query("DROP FUNCTION task_14e3e3_partial_attach_fault()");
      const otherOwner = await pool.query<{ id: string }>(
        "INSERT INTO users (display_name,status) VALUES ($1,'active') RETURNING id",
        [`e3-paused-rollback-owner-${crypto.randomUUID()}`],
      );
      const secondScope = await createCampaignScope(otherOwner.rows[0]!.id);
      const secondWorker = `e3-paused-rollback-b-${crypto.randomUUID()}`;
      const secondJobId = await insertTurnImageJob(secondScope, secondWorker);
      const second = await compose(async () => ({ bytes: sharedBytes, mimeType: "image/png" }));
      const secondCompletion = second.coordinator.completeClaimedImageJob({
        imageJobId: secondJobId,
        workerId: secondWorker,
        result: completedResult(secondScope.providerProfileId, 1)
      });
      await expect(Promise.race([
        secondCompletion.then(() => "completed"),
        new Promise<string>((resolveWait) => setTimeout(() => resolveWait("blocked"), 250))
      ])).resolves.toBe("blocked");
      releaseDelete();
      await expect(firstCompletion).rejects.toThrow("task_14e3e3_partial_attach_fault");
      const published = await secondCompletion;
      expect(published).toMatchObject({ outcome: "published" });
      if (published.outcome !== "published") return;
      const stored = await pool.query<{ storage_path: string }>(
        "SELECT storage_path FROM assets WHERE id=$1 AND owner_user_id=$2",
        [published.assets[0]!.assetId, secondScope.ownerUserId],
      );
      await expect(readFile(join(assetRoot, stored.rows[0]!.storage_path))).resolves.toEqual(sharedBytes);
    } finally {
      releaseDelete();
      await pool.query("DROP TRIGGER IF EXISTS task_14e3e3_partial_attach_fault_trigger ON image_job_asset_publications");
      await pool.query("DROP FUNCTION IF EXISTS task_14e3e3_partial_attach_fault()");
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("isolates provider-result, identity, download, signature, decode, and MIME failures from accepted narration", async () => {
    const cases = [
      {
        label: "provider_pending",
        download: async () => ({ bytes: await png(1, 2, 3), mimeType: "image/png" }),
        mutateResult: (result: PrivateCompletedIllustrationImageExecutionResult) => ({
          ...result,
          status: "pending"
        }) as unknown as PrivateCompletedIllustrationImageExecutionResult,
        expected: "illustration_provider_result_not_completed"
      },
      {
        label: "provider_identity",
        download: async () => ({ bytes: await png(1, 2, 3), mimeType: "image/png" }),
        mutateResult: (result: PrivateCompletedIllustrationImageExecutionResult) => ({
          ...result,
          providerProfileId: crypto.randomUUID()
        }),
        expected: "illustration_artifact_count_invalid"
      },
      {
        label: "download",
        download: async () => { throw new Error("artifact_download_failed"); },
        mutateResult: (result: PrivateCompletedIllustrationImageExecutionResult) => result,
        expected: "artifact_download_failed"
      },
      {
        label: "signature",
        download: async () => ({ bytes: new TextEncoder().encode("not-an-image"), mimeType: "image/png" }),
        mutateResult: (result: PrivateCompletedIllustrationImageExecutionResult) => result,
        expected: "illustration_artifact_signature_invalid"
      },
      {
        label: "decode",
        download: async () => ({
          bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          mimeType: "image/png"
        }),
        mutateResult: (result: PrivateCompletedIllustrationImageExecutionResult) => result,
        expected: "illustration_artifact_dimensions_invalid"
      },
      {
        label: "mime",
        download: async () => ({ bytes: await png(4, 5, 6), mimeType: "image/jpeg" }),
        mutateResult: (result: PrivateCompletedIllustrationImageExecutionResult) => result,
        expected: "illustration_artifact_mime_mismatch"
      }
    ] as const;

    for (const failure of cases) {
      const scope = await createCampaignScope();
      const workerId = `e3-failure-${failure.label}-${crypto.randomUUID()}`;
      const imageJobId = await insertTurnImageJob(scope, workerId);
      const composition = await compose(failure.download);
      await expect(composition.coordinator.completeClaimedImageJob({
        imageJobId,
        workerId,
        result: failure.mutateResult(completedResult(scope.providerProfileId, 1))
      })).rejects.toThrow(failure.expected);
      await expect(pool.query(
        `SELECT job.status,job.provider_status,turn_record.narration,turn_record.image_url,
                (SELECT count(*)::integer FROM image_job_asset_publications mapping
                  WHERE mapping.image_job_id=job.id) AS mappings,
                (SELECT count(*)::integer FROM asset_generation_contexts context
                  WHERE context.image_job_id=job.id) AS contexts
           FROM image_jobs job
           JOIN turns turn_record ON turn_record.id=job.turn_id AND turn_record.owner_user_id=job.owner_user_id
          WHERE job.id=$1`,
        [imageJobId],
      )).resolves.toMatchObject({ rows: [{
        status: "generating",
        provider_status: null,
        narration: "The accepted narration remains authoritative.",
        image_url: "",
        mappings: 0,
        contexts: 0
      }] });
    }
  });
});
