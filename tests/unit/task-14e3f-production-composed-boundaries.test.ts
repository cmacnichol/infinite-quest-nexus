import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
// @ts-expect-error The executable repository checker is intentionally plain ESM.
import * as productionParityBoundaries from "../../scripts/check-production-composed-parity-boundaries.mjs";
// @ts-expect-error Task e3f makes the e8 pool/manifest boundary a required parity prerequisite.
import * as privateParityBoundaries from "../../scripts/check-private-composition-parity-boundaries.mjs";

type ProductionParitySource = Readonly<{ file: string; text: string }>;

const { collectProductionComposedParityViolations } = productionParityBoundaries as unknown as Readonly<{
  collectProductionComposedParityViolations: (sources: readonly ProductionParitySource[]) => readonly string[];
}>;

const { collectPrivateCompositionCapacityViolations } = privateParityBoundaries as unknown as Readonly<{
  collectPrivateCompositionCapacityViolations: (sources: readonly ProductionParitySource[]) => readonly string[];
}>;

function activeSources(overrides: Partial<Record<string, string>> = {}): readonly ProductionParitySource[] {
  const source = {
    "services/api/src/server.ts": `
      import { queryAssets, readAsset } from "./asset-service.js";
      import { previewLegacyStoryImport } from "./import-service.js";
      import { importInfiniteWorlds } from "./infinite-worlds-import-service.js";
      import { registerArchiveRoutes } from "./archive-routes.js";
      export async function buildServer() { await registerArchiveRoutes(); return [queryAssets, readAsset, previewLegacyStoryImport, importInfiniteWorlds]; }
    `,
    "services/api/src/archive-routes.ts": `
      import { exportCampaign } from "./campaign-archive-service.js";
      import { importCampaignArchive, importLegacyStory } from "./import-service.js";
      export function registerArchiveRoutes() { return [exportCampaign, importCampaignArchive, importLegacyStory]; }
    `,
    "services/api/src/campaign-archive-service.ts": `
      import { validateArchiveAssets } from "./asset-archive-service.js";
      export function exportCampaign() { return validateArchiveAssets; }
    `,
    "services/worker/src/worker.ts": `
      import { runAssetMetadataBackfill } from "../../api/src/asset-service.js";
      export function defaultOptionalLanes() { return { asset: () => runAssetMetadataBackfill() }; }
      const lanes = [{ name: "illustration" }, { name: "chronicle" }, { name: "asset" }];
      export function runWorker() { return [defaultOptionalLanes(), lanes]; }
    `,
    "services/runtime/src/main.ts": `export const main = "production";`,
    "services/runtime/src/runtime-role.ts": `export const dispatchRuntimeRole = () => undefined;`,
    "services/runtime/src/illustration-composition.ts": `export const createIllustrationWorkerPorts = () => undefined;`,
    "services/runtime/src/illustration-platform-adapter.ts": `export const createIllustrationPlatformAdapter = () => undefined;`,
    "services/runtime/src/illustration-platform-bindings.ts": `export const createIllustrationPlatformBindings = () => undefined;`,
  } as Record<string, string>;
  return Object.freeze(Object.entries({ ...source, ...overrides }).map(([file, text]) => Object.freeze({ file, text: text ?? "" })));
}

describe("Task 14e3f production-composed boundary inventory", () => {
  it("records the exact historical-guard delta after the e3g switch and e3h authority removal", async () => {
    const files = [
      "services/api/src/server.ts",
      "services/api/src/archive-routes.ts",
      "services/worker/src/worker.ts",
      "services/runtime/src/main.ts",
      "services/runtime/src/runtime-role.ts",
      "services/runtime/src/illustration-composition.ts",
      "services/runtime/src/illustration-platform-adapter.ts",
      "services/runtime/src/illustration-platform-bindings.ts",
    ];
    const sources = await Promise.all(files.map(async (file) => Object.freeze({
      file,
      text: await readFile(file, "utf8"),
    })));

    expect(collectProductionComposedParityViolations(sources)).toEqual([
      "services/api/src/archive-routes.ts: private composition factory must not enter a live binding before e3g",
      "services/api/src/archive-routes.ts: required active legacy import is missing: ./campaign-archive-service.js",
      "services/api/src/archive-routes.ts: required active legacy import is missing: ./import-service.js",
      "services/api/src/server.ts: private composition factory must not enter a live binding before e3g",
      "services/api/src/server.ts: required active legacy import is missing: ./asset-service.js",
      "services/api/src/server.ts: required active legacy import is missing: ./import-service.js",
      "services/api/src/server.ts: required active legacy import is missing: ./infinite-worlds-import-service.js",
      "services/worker/src/worker.ts: active worker asset lane must retain runAssetMetadataBackfill until e3g",
      "services/worker/src/worker.ts: private composition factory must not enter a live binding before e3g",
      "services/worker/src/worker.ts: required active legacy import is missing: ../../api/src/asset-service.js",
    ]);
  });

  it("accepts the frozen legacy active graph before e3g", () => {
    expect(collectProductionComposedParityViolations(activeSources())).toEqual([]);
  });

  it("rejects a private composition factory entering a live Fastify binding", () => {
    const violations = collectProductionComposedParityViolations(activeSources({
      "services/api/src/server.ts": `
        import { createPrivateAssetMaintenanceComposition } from "../runtime/src/private-asset-maintenance-composition.js";
        import { queryAssets, readAsset } from "./asset-service.js";
        import { previewLegacyStoryImport } from "./import-service.js";
        import { importInfiniteWorlds } from "./infinite-worlds-import-service.js";
        import { registerArchiveRoutes } from "./archive-routes.js";
        export async function buildServer() { return createPrivateAssetMaintenanceComposition; }
      `,
    }));

    expect(violations).toContain(
      "services/api/src/server.ts: private composition factory must not enter a live binding before e3g",
    );
  });

  it("rejects CommonJS and dynamic private-composition imports entering a live binding", () => {
    for (const text of [
      `const privateRecovery = require("../runtime/private-filesystem-recovery-composition.js");`,
      `const privateRecovery = await import("../runtime/private-filesystem-recovery-composition.js");`,
    ]) {
      expect(collectProductionComposedParityViolations(activeSources({
        "services/api/src/server.ts": `
          import { queryAssets } from "./asset-service.js";
          import { previewLegacyStoryImport } from "./import-service.js";
          import { importInfiniteWorlds } from "./infinite-worlds-import-service.js";
          import { registerArchiveRoutes } from "./archive-routes.js";
          ${text}
          export async function buildServer() { return queryAssets; }
        `,
      }))).toEqual(expect.arrayContaining([
        "services/api/src/server.ts: private composition factory must not enter a live binding before e3g",
      ]));
    }
  });

  it("rejects a private composition entering every e3g-owned illustration platform binding", () => {
    const violations = collectProductionComposedParityViolations(activeSources({
      "services/runtime/src/illustration-platform-bindings.ts": `
        import { createPrivateAssetMaintenanceComposition } from "./private-asset-maintenance-composition.js";
        export const createIllustrationPlatformBindings = () => createPrivateAssetMaintenanceComposition;
      `,
    }));

    expect(violations).toContain(
      "services/runtime/src/illustration-platform-bindings.ts: private composition factory must not enter a live binding before e3g",
    );
  });

  it("rejects loss of the legacy worker asset authority before e3g", () => {
    const violations = collectProductionComposedParityViolations(activeSources({
      "services/worker/src/worker.ts": `
        export function defaultOptionalLanes() { return { asset: () => false }; }
        export function runWorker() { return defaultOptionalLanes(); }
      `,
    }));

    expect(violations).toContain(
      "services/worker/src/worker.ts: active worker asset lane must retain runAssetMetadataBackfill until e3g",
    );
  });

  it("rejects an extra live worker lane before the production switch", () => {
    const violations = collectProductionComposedParityViolations(activeSources({
      "services/worker/src/worker.ts": `
        import { runAssetMetadataBackfill } from "../../api/src/asset-service.js";
        const lanes = [{ name: "illustration" }, { name: "chronicle" }, { name: "asset" }, { name: "maintenance" }];
        export function runWorker() { return [runAssetMetadataBackfill, lanes]; }
      `,
    }));
    expect(violations).toContain(
      "services/worker/src/worker.ts: active worker lanes must remain exactly illustration, chronicle, and asset until e3g",
    );
  });

  it("makes e8 pool and deployment-budget probes a required parity dependency", () => {
    const sources: readonly ProductionParitySource[] = [
      { file: "packages/database/src/config.ts", text: "const requiredWorkerConnections = roleValue === 'worker' ? workerGenerationConcurrency + 4 : roleValue === 'all' ? workerGenerationConcurrency + 8 : 0;" },
      { file: "services/worker/src/worker.ts", text: "export function runWorker() {}" },
      { file: "compose.yaml", text: "APP_ROLE: all\nDATABASE_MAX_CONNECTIONS: \${DATABASE_MAX_CONNECTIONS:-12}\nWORKER_GENERATION_CONCURRENCY: \${WORKER_GENERATION_CONCURRENCY:-1}" },
      { file: "deploy/swarm/stack.yaml", text: "APP_ROLE: worker\nDATABASE_MAX_CONNECTIONS: \${DATABASE_MAX_CONNECTIONS:-8}\nWORKER_GENERATION_CONCURRENCY: \${WORKER_GENERATION_CONCURRENCY:-1}" },
    ];
    expect(collectPrivateCompositionCapacityViolations(sources)).toEqual([]);
    expect(collectPrivateCompositionCapacityViolations(sources.map((source) => (
      source.file === "packages/database/src/config.ts"
        ? { ...source, text: "const requiredWorkerConnections = roleValue === 'worker' ? workerGenerationConcurrency + 5 : roleValue === 'all' ? workerGenerationConcurrency + 9 : 0;" }
        : source
    )))).toEqual(expect.arrayContaining([
      "packages/database/src/config.ts: worker pool budget must remain executable generation + 4",
      "packages/database/src/config.ts: all-process pool budget must remain executable generation + 8",
    ]));
    expect(collectPrivateCompositionCapacityViolations(sources.map((source) => (
      source.file === "services/worker/src/worker.ts"
        ? { ...source, text: "import { createPrivateAssetMaintenanceComposition } from '../runtime/private-asset-maintenance-composition.js';" }
        : source
    )))).not.toContain(
      "services/worker/src/worker.ts: e8 private maintenance must not create a live worker lane",
    );
    expect(collectPrivateCompositionCapacityViolations(sources.map((source) => (
      source.file === "compose.yaml"
        ? { ...source, text: "APP_ROLE: all\nDATABASE_MAX_CONNECTIONS: \${DATABASE_MAX_CONNECTIONS:-8}\nWORKER_GENERATION_CONCURRENCY: \${WORKER_GENERATION_CONCURRENCY:-1}" }
        : source
    )))).toEqual(expect.arrayContaining([
      "compose.yaml: all-process manifest capacity must remain executable generation + 8 or greater",
    ]));
    expect(collectPrivateCompositionCapacityViolations(sources.map((source) => (
      source.file === "deploy/swarm/stack.yaml"
        ? { ...source, text: "APP_ROLE: worker\nDATABASE_MAX_CONNECTIONS: \${DATABASE_MAX_CONNECTIONS:-4}\nWORKER_GENERATION_CONCURRENCY: \${WORKER_GENERATION_CONCURRENCY:-1}" }
        : source
    )))).toEqual(expect.arrayContaining([
      "deploy/swarm/stack.yaml: worker manifest capacity must remain executable generation + 4 or greater",
    ]));
  });

  it("runs the live e8 graph and capacity guard before the e8 integration prerequisite", async () => {
    const runner = await readFile("scripts/run-e3f-isolated-integration.mjs", "utf8");

    expect(runner).toContain('"tests/unit/task-14e3e8-composition-parity-boundaries.test.ts"');
    expect(runner.indexOf('"tests/unit/task-14e3e8-composition-parity-boundaries.test.ts"')).toBeLessThan(
      runner.indexOf('["test:e8:integration"]'),
    );
  });
});
