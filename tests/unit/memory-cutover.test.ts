import { access, readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../..", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

async function productionTypeScript(directory: string): Promise<readonly Readonly<{ path: string; source: string }>[]> {
  const files: Array<Readonly<{ path: string; source: string }>> = [];
  const visit = async (relative: string): Promise<void> => {
    for (const entry of await readdir(new URL(relative, root), { withFileTypes: true })) {
      const path = `${relative}${entry.name}`;
      if (entry.isDirectory()) await visit(`${path}/`);
      else if (entry.isFile() && path.endsWith(".ts")) files.push({ path, source: await source(path) });
    }
  };
  await visit(`${directory}/`);
  return files;
}

describe("Task 14b3 Chronicle consumer cutover", () => {
  it("leaves no production or test path to the retired Chronicle implementations", async () => {
    const scanned = (await Promise.all([
      productionTypeScript("services/api/src"),
      productionTypeScript("services/runtime/src"),
      productionTypeScript("services/worker/src")
    ])).flat();
    const forbidden = [
      "memoryApplication" + "ForPool",
      "runChronicle" + "Job",
      "runClaimedChronicle" + "Job",
      "chronicle-platform" + "-service",
      "api/src/memory" + "-service",
      "ChronicleCompatibility" + "RunClaim",
      "WorkerMemoryCompositionFactories",
      "createRepositoryBackedChronicleExecutor",
      "createLiveWorkerMemoryApplication",
      "unavailableMemoryGenerationPort"
    ];
    const violations = scanned.flatMap((file) => forbidden
      .filter((value) => file.source.includes(value))
      .map((value) => `${file.path}: ${value}`));

    expect(violations).toEqual([]);
    await expect(access(new URL("services/api/src/memory" + "-service.ts", root))).rejects.toThrow();
    await expect(access(new URL("services/runtime/src/chronicle-platform" + "-service.ts", root))).rejects.toThrow();
  });

  it("requires memory applications structurally at every production composition boundary", async () => {
    const scanned = (await Promise.all([
      productionTypeScript("services/api/src"),
      productionTypeScript("services/runtime/src"),
      productionTypeScript("services/worker/src")
    ])).flat();
    const optionalMemory = /\b(?:memory|createApiMemory|createWorkerMemory)\?\s*(?::|\()/u;
    const throwingFallback = /requires a Chronicle memory application/u;

    expect(scanned.flatMap((file) => [
      ...(optionalMemory.test(file.source) ? [`${file.path}: optional memory`] : []),
      ...(throwingFallback.test(file.source) ? [`${file.path}: throwing memory fallback`] : [])
    ])).toEqual([]);
  });

  it("has no Chronicle worker-to-API boundary exception", async () => {
    const boundaries = await source("scripts/check-client-boundaries.mjs");

    expect(boundaries).not.toContain("memory-service.js");
  });
});
