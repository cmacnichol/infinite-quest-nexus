import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  CharacterOrganizationCostPort,
  CharacterOrganizationPromptPort,
  ChronicleCostPort,
  ChroniclePromptPort,
  GenerationCostPort,
  GenerationPromptPort,
  IllustrationPromptPort,
  InfiniteWorldsCostPort,
  InfiniteWorldsPromptPort,
  ProviderApplication,
  ProviderCostPort,
  ProviderIllustrationCostPort,
  ProviderResolutionPort,
  ProviderRuntimeLeasePort,
  Task14dCharacterProfileOrganizerBridgePort,
  Task14dWorldGenerationBridgePort,
  TurnIntentClassificationPort,
  WorldGenerationCostPort,
  WorldGenerationPromptPort
} from "../../packages/application/src/providers/index.js";

const repositoryRoot = join(import.meta.dirname, "../..");
const servicesRoot = join(repositoryRoot, "services");
const legacyModules = [
  "provider-service",
  "prompt-library-service",
  "turn-intent-service",
  "cost-service"
] as const;

type LegacyModule = (typeof legacyModules)[number];
type FuturePortCatalog = Readonly<{
  CharacterOrganizationCostPort: CharacterOrganizationCostPort;
  CharacterOrganizationPromptPort: CharacterOrganizationPromptPort;
  ChronicleCostPort: ChronicleCostPort;
  ChroniclePromptPort: ChroniclePromptPort;
  GenerationCostPort: GenerationCostPort;
  GenerationPromptPort: GenerationPromptPort;
  IllustrationPromptPort: IllustrationPromptPort;
  InfiniteWorldsCostPort: InfiniteWorldsCostPort;
  InfiniteWorldsPromptPort: InfiniteWorldsPromptPort;
  ProviderApplication: ProviderApplication;
  ProviderCostPort: ProviderCostPort;
  ProviderIllustrationCostPort: ProviderIllustrationCostPort;
  ProviderResolutionPort: ProviderResolutionPort;
  ProviderRuntimeLeasePort: ProviderRuntimeLeasePort;
  Task14dCharacterProfileOrganizerBridgePort: Task14dCharacterProfileOrganizerBridgePort;
  Task14dWorldGenerationBridgePort: Task14dWorldGenerationBridgePort;
  TurnIntentClassificationPort: TurnIntentClassificationPort;
  WorldGenerationCostPort: WorldGenerationCostPort;
  WorldGenerationPromptPort: WorldGenerationPromptPort;
}>;
type FuturePortName = keyof FuturePortCatalog;
type OwnershipEntry = Readonly<{
  authority: "api" | "worker" | "composition";
  consumer: string;
  futurePorts: readonly FuturePortName[];
  legacyModules: readonly LegacyModule[];
}>;

/**
 * Task 14d1 cutover inventory. This is intentionally an exact snapshot of
 * production imports; 14d3 must update it as each named composition replaces
 * the corresponding legacy module rather than adding an anonymous bridge.
 */
const ownershipInventory: Readonly<Record<string, OwnershipEntry>> = {
  "services/api/src/infinite-worlds-import-service.ts": {
    authority: "api",
    consumer: "infinite-worlds-import",
    futurePorts: ["InfiniteWorldsPromptPort", "InfiniteWorldsCostPort", "ProviderResolutionPort"],
    legacyModules: ["provider-service", "prompt-library-service"]
  },
  "services/api/src/server.ts": {
    authority: "api",
    consumer: "provider-prompt-intent-cost-routes",
    futurePorts: ["ProviderApplication"],
    legacyModules: ["provider-service", "prompt-library-service", "turn-intent-service", "cost-service"]
  },
  "services/api/src/task-14d-character-profile-organizer-bridge.ts": {
    authority: "composition",
    consumer: "temporary-14c-character-profile-organizer-bridge",
    futurePorts: ["Task14dCharacterProfileOrganizerBridgePort"],
    legacyModules: ["provider-service", "prompt-library-service"]
  },
  "services/api/src/task-14d-world-generation-bridge.ts": {
    authority: "composition",
    consumer: "temporary-14c-world-generation-bridge",
    futurePorts: ["Task14dWorldGenerationBridgePort"],
    legacyModules: ["provider-service", "prompt-library-service"]
  },
  "services/api/src/turn-intent-service.ts": {
    authority: "api",
    consumer: "turn-intent-classification",
    futurePorts: ["TurnIntentClassificationPort", "ProviderResolutionPort", "ProviderCostPort"],
    legacyModules: ["provider-service", "prompt-library-service", "cost-service"]
  },
  "services/runtime/src/chronicle-platform-bindings.ts": {
    authority: "worker",
    consumer: "chronicle-worker",
    futurePorts: ["ChroniclePromptPort", "ChronicleCostPort", "ProviderResolutionPort"],
    legacyModules: ["provider-service", "cost-service"]
  },
  "services/runtime/src/generation-api-composition.ts": {
    authority: "api",
    consumer: "generation-api",
    futurePorts: ["GenerationPromptPort", "GenerationCostPort"],
    legacyModules: ["prompt-library-service", "cost-service"]
  },
  "services/runtime/src/generation-worker-composition.ts": {
    authority: "worker",
    consumer: "generation-worker",
    futurePorts: ["GenerationPromptPort", "GenerationCostPort", "ProviderResolutionPort"],
    legacyModules: ["provider-service", "prompt-library-service", "cost-service"]
  },
  "services/runtime/src/illustration-image-job-adapter.ts": {
    authority: "worker",
    consumer: "illustration-image-worker",
    futurePorts: ["IllustrationPromptPort", "ProviderIllustrationCostPort", "ProviderResolutionPort"],
    legacyModules: ["provider-service", "prompt-library-service", "cost-service"]
  },
  "services/runtime/src/illustration-platform-bindings.ts": {
    authority: "composition",
    consumer: "illustration-platform",
    futurePorts: ["ProviderIllustrationCostPort", "ProviderRuntimeLeasePort"],
    legacyModules: ["provider-service", "cost-service"]
  },
  "services/runtime/src/illustration-segment-job-adapter.ts": {
    authority: "worker",
    consumer: "illustration-prompt-worker",
    futurePorts: ["IllustrationPromptPort", "ProviderIllustrationCostPort", "ProviderResolutionPort"],
    legacyModules: ["provider-service", "prompt-library-service", "cost-service"]
  },
  "services/runtime/src/world-campaign-composition.ts": {
    authority: "composition",
    consumer: "world-campaign-temporary-14d-bindings",
    futurePorts: [
      "Task14dCharacterProfileOrganizerBridgePort",
      "Task14dWorldGenerationBridgePort",
      "ProviderCostPort"
    ],
    legacyModules: ["provider-service", "cost-service"]
  }
};

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
  it("assigns every current production legacy import to one named consumer", () => {
    const actual = currentLegacyImports();
    const expected = Object.fromEntries(Object.entries(ownershipInventory).map(([path, entry]) => [
      path,
      [...entry.legacyModules].sort()
    ]));

    expect(actual).toEqual(expected);
    for (const entry of Object.values(ownershipInventory)) {
      expect(entry.consumer).not.toBe("");
      expect(entry.futurePorts.length).toBeGreaterThan(0);
    }
  });
});
