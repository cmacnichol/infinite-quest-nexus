import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("durable asynchronous image jobs", () => {
  it("persists and resumes a provider workflow instead of submitting it twice", async () => {
    const source = await readFile(resolve("services/api/src/image-service.ts"), "utf8");

    expect(source).toContain("idempotencyKey: `${job.id}:${job.generation_revision}`");
    expect(source).toContain("generation_revision = generation_revision + 1");
    expect(source).toContain("if (job.remote_job_id)");
    expect(source).toContain("pollImageProvider(provider, { remoteJobId: job.remote_job_id })");
    expect(source).toContain("remote_job_id = $3");
    expect(source).toContain("response.error.retryable");
    expect(source).toContain("retryableRemoteFailure");
    expect(source).toContain("persistedSogniTerminalError");
    expect(source).toContain('["5001", "5002", "5003", "5005"]');
    expect(source).toContain("image_provider_remote_retry");
    expect(source).toContain("remote_job_id = NULL, provider_status = 'retrying'");
    expect(source).toContain("imageCount: job.image_count");
    expect(source).not.toContain("sensitiveContentFilterSetting(provider)");
  });

  it("persists SDK queue position and ETA while removing obsolete REST filter settings", async () => {
    const migration = await readFile(resolve("database/migrations/0032_sogni_sdk_provider.sql"), "utf8");
    expect(migration).toContain("'sogni_sdk'");
    expect(migration).toContain("configuration - 'sensitiveContentFilter' - 'workflowSafeContentFilterSupported'");
    expect(migration).toContain("provider_queue_position");
    expect(migration).toContain("provider_eta_at");
  });

  it("adds poll scheduling, deadlines, progress, and sanitized provider metadata", async () => {
    const migration = await readFile(resolve("database/migrations/0029_durable_image_provider_jobs.sql"), "utf8");

    for (const column of [
      "remote_job_id",
      "generation_revision",
      "provider_progress",
      "next_poll_at",
      "generation_deadline",
      "provider_request_metadata",
      "provider_result_metadata",
      "reported_cost"
    ]) expect(migration).toContain(column);
    expect(migration).toContain("image_jobs_remote_provider_job_idx");
  });

  it("extends the durable queue with an owner-scoped world-cover target", async () => {
    const migration = await readFile(resolve("database/migrations/0030_world_cover_image_jobs.sql"), "utf8");
    const source = await readFile(resolve("services/api/src/image-service.ts"), "utf8");

    expect(migration).toContain("target_type IN ('turn_illustration', 'world_cover')");
    expect(migration).toContain("image_jobs_one_active_world_cover_idx");
    expect(migration).toContain("worlds_cover_asset_owner_fk");
    expect(source).toContain("export async function enqueueWorldCover");
    expect(source).toContain("export async function getLatestWorldCoverJob");
    expect(source).toContain('targetType: "world_cover"');
    expect(source).toContain("persistWorldCover");
    expect(source).toContain("if (job.campaign_id)");
  });

  it("derives segment-scoped image work without mutating accepted turns", async () => {
    const migration = await readFile(resolve("database/migrations/0033_segmented_turn_illustrations.sql"), "utf8");
    const imageService = await readFile(resolve("services/api/src/image-service.ts"), "utf8");
    const segmentService = await readFile(resolve("services/api/src/segmented-illustration-service.ts"), "utf8");

    expect(migration).toContain("CREATE TABLE turn_illustration_sets");
    expect(migration).toContain("CREATE TABLE turn_illustration_segments");
    expect(migration).toContain("CREATE TABLE turn_illustration_segment_assets");
    expect(migration).toContain("CREATE TABLE illustration_prompt_jobs");
    expect(migration).toContain("image_jobs_one_active_segment_idx");
    expect(imageService).toContain("if (job.segment_id)");
    expect(segmentService).toContain("enqueueAcceptedTurnIllustrationSegments");
    expect(segmentService).toContain("illustration_prompt_refinement");
    expect(segmentService).toContain("export async function regenerateSegmentIllustration");
    expect(segmentService).toContain("export async function removeSegmentIllustrationVariant");
    expect(segmentService).toContain("turns.turn_number = campaigns.active_turn_number");
    expect(segmentService).toContain("targetVariantIndex: request.variantIndex");
    expect(imageService).toContain("hasRequestedVariant");
    expect(imageService).toContain("provider_request_metadata.targetVariantIndex");
    expect(segmentService).not.toContain("UPDATE turns SET");
  });

  it("preserves the applied refinement-instructions migration before renaming its column", async () => {
    const appliedMigration = await readFile(
      resolve("database/migrations/0034_campaign_illustration_refinement_instructions.sql"),
      "utf8"
    );
    const renameMigration = await readFile(
      resolve("database/migrations/0035_campaign_illustration_refinement_prompt.sql"),
      "utf8"
    );

    expect(appliedMigration).toContain("ADD COLUMN refinement_instructions");
    expect(renameMigration).toContain("RENAME COLUMN refinement_instructions TO refinement_prompt");
  });
});
