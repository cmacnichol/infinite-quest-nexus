import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "../..");
const servicesRoot = join(repositoryRoot, "services");
const legacyModules = [
  "provider-service",
  "prompt-library-service",
  "turn-intent-service",
  "cost-service"
] as const;

type LegacyModule = (typeof legacyModules)[number];
const removedLegacyFiles = [
  "services/api/src/provider-service.ts",
  "services/api/src/prompt-library-service.ts",
  "services/api/src/turn-intent-service.ts",
  "services/api/src/cost-service.ts",
  "services/api/src/task-14d-character-profile-organizer-bridge.ts",
  "services/api/src/task-14d-world-generation-bridge.ts"
] as const;

const namedCutoverFiles = [
  "services/api/src/provider-application-adapter.ts",
  "services/runtime/src/provider-application-composition.ts",
  "services/runtime/src/provider-character-organization-adapter.ts",
  "services/runtime/src/provider-world-generation-adapter.ts"
] as const;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

function currentLegacyImports(): Record<string, LegacyModule[]> {
  const output: Record<string, LegacyModule[]> = {};
  for (const path of sourceFiles(servicesRoot)) {
    const source = readFileSync(path, "utf8");
    const imported = legacyModules.filter((module) =>
      new RegExp(`from\\s+["'][^"']*${module}\\.js["']`).test(source)
    );
    if (imported.length) output[relative(repositoryRoot, path)] = [...imported].sort();
  }
  return output;
}

describe("Task 14d provider/prompt/intent/cost ownership inventory", () => {
  it("leaves zero production imports or callable files for legacy provider authority", () => {
    expect(currentLegacyImports()).toEqual({});
    for (const path of removedLegacyFiles) {
      expect(() => readFileSync(join(repositoryRoot, path), "utf8")).toThrow();
    }
  });

  it("has named API and worker provider cutover modules", () => {
    for (const path of namedCutoverFiles) {
      expect(readFileSync(join(repositoryRoot, path), "utf8")).not.toBe("");
    }
  });
});
