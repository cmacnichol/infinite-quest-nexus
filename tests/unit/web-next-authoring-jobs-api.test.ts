import { describe, expect, it, vi } from "vitest";
import { createAuthoringJobsApi, AuthoringJobsApiError } from "../../apps/web-next/src/authoring-jobs-api.js";

const job = {
  id: "job-1", revision: 2, status: "awaiting_review", target: { kind: "new_world" },
  stages: [], expiresAt: "2026-09-13T00:00:00.000Z", canApply: true, incomplete: false,
  kind: "world_concept",
  result: { schemaVersion: 5, world: { title: "Atlas", genre: "fantasy", tone: "bright", premise: "p", backgroundStory: "b", firstAction: "a", rules: "r" }, playableCharacters: [], entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [], defaults: {}, preservedLore: {} }
};

describe("authoring jobs API", () => {
  it("P28-F3 carries the saved review subset through HTTP validation into the apply request", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const api = createAuthoringJobsApi(async (path, init) => {
      calls.push({ path: String(path), body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify(String(path).endsWith("/apply")
        ? { jobId: job.id, worldId: "world", draftRevision: 1 }
        : { ...job, reviewedContent: job.result, reviewedStageIds: ["current-selected"] }), { status: 200 });
    });
    const review = await api.saveAuthoringReview(job.id, { expectedRevision: 1, content: job.result, selectedStageIds: ["current-selected"] });
    await api.applyAuthoringJob(job.id, { expectedRevision: review.revision, idempotencyKey: "frozen-key", content: review.reviewedContent!, selectedStageIds: review.reviewedStageIds! });
    expect(calls[0]?.body).toMatchObject({ selectedStageIds: ["current-selected"] });
    expect(calls[1]?.body).toMatchObject({ expectedRevision: 2, selectedStageIds: ["current-selected"], idempotencyKey: "frozen-key", content: job.result });
  });

  it("validates a submitted job and every command response through the shared contracts", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify(job), { status: 202, headers: { "content-type": "application/json" } }));
    const api = createAuthoringJobsApi(fetch as typeof globalThis.fetch);

    await expect(api.submitAuthoringJob({ kind: "world_concept", idempotencyKey: "key-1", target: { kind: "new_world" }, prompt: "Create Atlas" })).resolves.toMatchObject({ id: "job-1" });
    expect(fetch).toHaveBeenCalledWith("/api/v1/authoring/jobs", expect.objectContaining({ method: "POST" }));
  });

  it("projects malformed and private server failures to a safe error", async () => {
    const api = createAuthoringJobsApi(async () => new Response(JSON.stringify({ message: "https://private.example/?token=secret" }), { status: 503, headers: { "content-type": "application/json" } }));

    await expect(api.loadAuthoringJob("job-1")).rejects.toMatchObject<Partial<AuthoringJobsApiError>>({ kind: "unavailable", message: "Authoring jobs are unavailable. Try again." });
  });

  it("rejects invalid list cursors and apply commands before issuing a request", async () => {
    const fetch = vi.fn();
    const api = createAuthoringJobsApi(fetch as typeof globalThis.fetch);

    await expect(api.listAuthoringJobs("x".repeat(2_001))).rejects.toThrow();
    await expect(api.applyAuthoringJob("job-1", { expectedRevision: 1, idempotencyKey: "key", selectedStageIds: [], content: {} } as never)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

it("uses validated envelopes for review, retry, cancel, discard and apply and rejects malformed success responses safely", async () => {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => init?.method === "DELETE" ? new Response(null, { status: 204 }) : new Response(JSON.stringify(url.endsWith("/apply") ? { jobId: "job-1", worldId: "world-1", draftRevision: 1 } : job), { status: 200 }));
  const api = createAuthoringJobsApi(fetch as typeof globalThis.fetch);
  await api.saveAuthoringReview("job-1", { expectedRevision: 2, content: job.result, selectedStageIds: [] });
  await api.retryAuthoringStage("job-1", { expectedRevision: 2, stageId: "stage" });
  await api.cancelAuthoringJob("job-1", { expectedRevision: 2 });
  await api.discardAuthoringJob("job-1", { expectedRevision: 2 });
  await expect(api.applyAuthoringJob("job-1", { expectedRevision: 2, idempotencyKey: "apply", content: job.result, selectedStageIds: [] })).resolves.toMatchObject({ worldId: "world-1" });
  expect(fetch.mock.calls.map(([url, init]) => [url.split("/").at(-1), init?.method])).toEqual([["review", "PUT"], ["retry", "POST"], ["cancel", "POST"], ["job-1", "DELETE"], ["apply", "POST"]]);
  const malformed = createAuthoringJobsApi(async () => new Response(JSON.stringify({ privateProvider: "SECRET" }), { status: 200 }));
  await expect(malformed.loadAuthoringJob("job-1")).rejects.toMatchObject({ kind: "request_failed" });
});

it("validates job identifiers before issuing any detail request", async () => {
  const fetch = vi.fn(); const api = createAuthoringJobsApi(fetch);
  await expect(api.loadAuthoringJob("")).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
});
