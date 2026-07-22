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
    expect(source).toContain('numberSetting(provider, "defaultImageCount", 1, 1, 2)');
    expect(source).toContain("sensitiveContentFilterSetting(provider)");
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
});
