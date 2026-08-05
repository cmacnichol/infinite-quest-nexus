import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../..", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

describe("Task 14b3 Chronicle consumer cutover", () => {
  it("removes the retired API memory implementation from live worker and generation composition", async () => {
    const [worker, generationComposition] = await Promise.all([
      source("services/worker/src/worker.ts"),
      source("services/runtime/src/generation-worker-composition.ts")
    ]);

    expect(worker).not.toContain("../../api/src/memory-service.js");
    expect(generationComposition).not.toContain("../../api/src/memory-service.js");
  });

  it("has no Chronicle worker-to-API boundary exception", async () => {
    const boundaries = await source("scripts/check-client-boundaries.mjs");

    expect(boundaries).not.toContain("memory-service.js");
  });
});
