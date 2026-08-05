import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const inventoryUrl = new URL("../../docs/review/2026-08-05-task-14b-memory-inventory.md", import.meta.url);

describe("Task 14b Chronicle inventory", () => {
  it("assigns every direct memory persistence and callback consumer before adapter cutover", async () => {
    const inventory = await readFile(fileURLToPath(inventoryUrl), "utf8");
    for (const expected of [
      "memory-service.ts",
      "generation-worker-composition.ts",
      "generation-executor-adapter.ts",
      "generation-execution-repository.ts",
      "generation-service.ts",
      "campaign-state-service.ts",
      "campaign-transfer-service.ts",
      "import-service.ts",
      "world-service.ts",
      "provider-service.ts",
      "campaign-archive-service.ts",
      "asset-archive-service.ts",
      "illustration-resolution-job-adapter.ts",
      "autoEnableCampaignEmbeddingIfAvailable",
      "buildContextPreview",
      "enqueueEmbeddingReindex",
      "rebuildCampaignMemories",
      "storeDerivedTurnMemories",
      "accepted-turn fiction write"
    ]) {
      expect(inventory).toContain(expected);
    }
    expect(inventory).toContain("14b2");
    expect(inventory).toContain("14b3");
    expect(inventory).not.toContain("TBD");
  });

  it("enumerates the exact six memory handlers, generic Chronicle job read, and six generation callbacks", async () => {
    const inventory = await readFile(fileURLToPath(inventoryUrl), "utf8");
    const memoryRoutes = [
      "GET /api/v1/campaigns/:campaignId/memory/metrics",
      "GET /api/v1/campaigns/:campaignId/memory/context-preview",
      "POST /api/v1/campaigns/:campaignId/memory/reindex",
      "GET /api/v1/campaigns/:campaignId/memory/embedding-config",
      "PUT /api/v1/campaigns/:campaignId/memory/embedding-config",
      "POST /api/v1/campaigns/:campaignId/memory/embeddings/reindex"
    ];
    const callbacks = [
      "autoEnableCampaignEmbeddingIfAvailable",
      "buildContextPreview",
      "enqueueEmbeddingReindex",
      "rebuildCampaignMemories",
      "storeDerivedTurnMemories",
      "accepted-turn fiction write"
    ];

    expect(memoryRoutes).toHaveLength(6);
    expect(callbacks).toHaveLength(6);
    for (const route of memoryRoutes) expect(inventory).toContain("`" + route + "`");
    for (const callback of callbacks) expect(inventory).toContain("`" + callback + "`");
    expect(inventory).toContain("`GET /api/v1/jobs/:jobId`");
  });
});
