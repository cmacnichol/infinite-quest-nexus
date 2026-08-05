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
});
