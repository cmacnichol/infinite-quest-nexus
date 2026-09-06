import { describe, expect, it } from "vitest";
// @ts-expect-error The executable repository checker is intentionally plain ESM.
import * as compositionParityBoundaries from "../../scripts/check-private-composition-parity-boundaries.mjs";

type Source = Readonly<{ file: string; text: string }>;

const {
  collectPrivateCompositionParityViolations,
  collectPrivateCompositionCapacityViolations,
  readPrivateCompositionCapacitySources,
  readPrivateCompositionParitySources,
} = compositionParityBoundaries as unknown as Readonly<{
  collectPrivateCompositionCapacityViolations: (sources: readonly Source[]) => readonly string[];
  collectPrivateCompositionParityViolations: (sources: readonly Source[]) => readonly string[];
  readPrivateCompositionCapacitySources: (root: string) => readonly Source[];
  readPrivateCompositionParitySources: (root: string) => readonly Source[];
}>;

const check = collectPrivateCompositionParityViolations;
const checkCapacity = collectPrivateCompositionCapacityViolations;

function sources(overrides: Readonly<Record<string, string>> = {}): readonly Source[] {
  const shared = `
    export async function createAssetImportStorageComposition() { return {}; }
    export async function createPrivateNormalizedAssetPublicationComposition() { return {}; }
    export async function createPrivatePortableNormalizedAssetPublicationComposition() { return {}; }
    export async function createPrivateIllustrationAssetPublicationComposition() { return {}; }
    export async function createPortableImportExportComposition() { return {}; }
    export async function createPrivateAssetMetadataBackfillComposition() { return {}; }
    export async function createPrivateFilesystemRecoveryComposition() { return {}; }
    export function createPrivateAssetMaintenanceScheduler() { return {}; }
    export async function createPrivateAssetMaintenanceComposition() { return {}; }
  `;
  const base: Record<string, string> = {
    "services/runtime/src/asset-import-composition.ts": shared,
    "services/runtime/src/normalized-asset-publication-composition.ts": `
      import { createAssetImportStorageComposition } from "./asset-import-composition.js";
      export async function createPrivateNormalizedAssetPublicationComposition() {
        return createAssetImportStorageComposition();
      }
    `,
    "services/runtime/src/illustration-asset-publication-composition.ts": `
      import { createPrivateNormalizedAssetPublicationComposition } from "./normalized-asset-publication-composition.js";
      export async function createPrivateIllustrationAssetPublicationComposition() {
        return createPrivateNormalizedAssetPublicationComposition();
      }
    `,
    "services/runtime/src/portable-normalized-asset-publication-composition.ts": `
      import { createPrivateNormalizedAssetPublicationComposition } from "./normalized-asset-publication-composition.js";
      export async function createPrivatePortableNormalizedAssetPublicationComposition() {
        return createPrivateNormalizedAssetPublicationComposition();
      }
    `,
    "services/runtime/src/portable-import-export-composition.ts": `
      import { createPrivatePortableNormalizedAssetPublicationComposition } from "./portable-normalized-asset-publication-composition.js";
      export async function createPortableImportExportComposition() {
        return createPrivatePortableNormalizedAssetPublicationComposition();
      }
    `,
    "services/runtime/src/api-asset-composition.ts": `
      import { createAssetImportStorageComposition } from "./asset-import-composition.js";
      export async function createApiAssetComposition() {
        return createAssetImportStorageComposition();
      }
    `,
    "services/runtime/src/api-portable-import-export-composition.ts": `
      import { createPortableImportExportComposition } from "./portable-import-export-composition.js";
      export async function createApiPortableImportExportComposition() {
        return createPortableImportExportComposition();
      }
    `,
    "services/runtime/src/system-archive-composition.ts": `
      import type { ApiAssetComposition } from "./api-asset-composition.js";
      export function createApiSystemArchiveComposition(
        options: { storage: Pick<ApiAssetComposition["storage"], "adapter"> },
      ) {
        return options.storage;
      }
    `,
    "services/runtime/src/private-asset-metadata-backfill-composition.ts": `
      import { createAssetImportStorageComposition } from "./asset-import-composition.js";
      export async function createPrivateAssetMetadataBackfillComposition() {
        return createAssetImportStorageComposition();
      }
    `,
    "services/runtime/src/private-filesystem-recovery-composition.ts": `
      import { createAssetImportStorageComposition } from "./asset-import-composition.js";
      import { createPrivateNormalizedAssetPublicationComposition } from "./normalized-asset-publication-composition.js";
      import { createPrivatePortableNormalizedAssetPublicationComposition } from "./portable-normalized-asset-publication-composition.js";
      export async function createPrivateFilesystemRecoveryComposition() {
        await createAssetImportStorageComposition();
        await createPrivateNormalizedAssetPublicationComposition();
        return createPrivatePortableNormalizedAssetPublicationComposition();
      }
    `,
    "packages/application/src/assets/private-asset-maintenance-scheduler.ts": `
      export function createPrivateAssetMaintenanceScheduler() { return {}; }
    `,
    "services/runtime/src/private-asset-maintenance-composition.ts": `
      import { createPrivateAssetMaintenanceScheduler } from "../../../packages/application/src/assets/private-asset-maintenance-scheduler.js";
      import { createPrivateAssetMetadataBackfillComposition } from "./private-asset-metadata-backfill-composition.js";
      import { createPrivateFilesystemRecoveryComposition } from "./private-filesystem-recovery-composition.js";
      export async function createPrivateAssetMaintenanceComposition() {
        createPrivateAssetMaintenanceScheduler();
        await createPrivateAssetMetadataBackfillComposition();
        return createPrivateFilesystemRecoveryComposition();
      }
    `,
    "services/api/src/server.ts": "export function server() {}",
    "services/worker/src/worker.ts": `
      import { createPrivateIllustrationAssetPublicationComposition } from "../../runtime/src/illustration-asset-publication-composition.js";
      import { createPrivateAssetMaintenanceComposition } from "../../runtime/src/private-asset-maintenance-composition.js";
      export async function worker() {
        await createPrivateIllustrationAssetPublicationComposition();
        return createPrivateAssetMaintenanceComposition();
      }
    `,
    "services/runtime/src/main.ts": "export function main() {}",
    "services/runtime/src/index.ts": "export const runtime = {};",
    "packages/application/src/index.ts": "export const application = {};",
    "packages/application/src/assets/index.ts": "export const assets = {};",
    "packages/application/src/imports/index.ts": "export const imports = {};",
    "packages/application/src/illustration/index.ts": "export const illustration = {};",
    "packages/contracts/src/index.ts": "export const contracts = {};",
    "packages/domain/src/index.ts": "export const domain = {};",
  };
  return Object.entries({ ...base, ...overrides }).map(([file, text]) => ({ file, text }));
}

describe("Task 14e3e8 private composition parity boundaries", () => {
  it("accepts exactly the frozen private composition/scheduler consumer graph", () => {
    expect(check(sources())).toEqual([]);
  });

  it("rejects a live or public consumer in static, re-export, CommonJS, and dynamic-import forms", () => {
    const cases = [
      ["services/api/src/server.ts", `import { createPrivateIllustrationAssetPublicationComposition } from "../../runtime/src/illustration-asset-publication-composition.js";`],
      ["services/worker/src/worker.ts", `export { createPortableImportExportComposition } from "../../runtime/src/portable-import-export-composition.js";`],
      ["services/runtime/src/main.ts", `const maintenance = require("./private-asset-maintenance-composition.js");`],
      ["packages/application/src/index.ts", `const privateRecovery = await import("../../../services/runtime/src/private-filesystem-recovery-composition.js");`],
      ["services/api/src/server.ts", `const privateRecovery = require("../../runtime/src/private-filesystem-recovery-composition");`],
      ["services/worker/src/worker.ts", `const privatePortable = await import("../../runtime/src/portable-import-export-composition");`],
      ["services/api/src/server.ts", `import { createPrivateFilesystemRecoveryComposition } from "../../runtime/src/private-filesystem-recovery-composition";`],
      ["services/worker/src/worker.ts", `export { createPortableImportExportComposition } from "../../runtime/src/portable-import-export-composition";`],
    ] as const;

    for (const [file, text] of cases) {
      expect(check(sources({ [file]: text })), text).toEqual(expect.arrayContaining([
        expect.stringContaining("must not bypass its named e3g composition consumer")
      ]));
    }
  });

  it("rejects transitive API/worker authority, legacy writers, and private-contract barrel leaks", () => {
    expect(check(sources({
      "services/runtime/src/private-filesystem-recovery-composition.ts": `
        import { createPrivateNormalizedAssetPublicationComposition } from "./normalized-asset-publication-composition.js";
        import "../../api/src/asset-service.js";
        export async function createPrivateFilesystemRecoveryComposition() {
          return createPrivateNormalizedAssetPublicationComposition();
        }
      `,
    }))).toEqual(expect.arrayContaining([
      expect.stringContaining("must not reach services/api/src")
    ]));
    expect(check(sources({
      "services/runtime/src/portable-normalized-asset-publication-composition.ts": `
        import { createPrivateNormalizedAssetPublicationComposition } from "./normalized-asset-publication-composition.js";
        export async function createPrivatePortableNormalizedAssetPublicationComposition() {
          persistTurnImage();
          return createPrivateNormalizedAssetPublicationComposition();
        }
      `,
    }))).toEqual(expect.arrayContaining([
      expect.stringContaining("prohibits legacy writer")
    ]));
    expect(check(sources({
      "packages/application/src/assets/index.ts": `export * from "./private-metadata-backfill.js";`,
    }))).toEqual(expect.arrayContaining([
      expect.stringContaining("private contract must not escape")
    ]));
    expect(check(sources({
      "services/runtime/src/index.ts": `export * from "./private-filesystem-recovery.js";`,
    }))).toEqual(expect.arrayContaining([
      expect.stringContaining("private contract must not escape")
    ]));
  });

  it("rejects a replacement composition that creates a second database pool", () => {
    expect(check(sources({
      "services/runtime/src/private-asset-metadata-backfill-composition.ts": `
        import { createAssetImportStorageComposition } from "./asset-import-composition.js";
        import { createDatabasePool } from "../../../packages/database/src/pool.js";
        export async function createPrivateAssetMetadataBackfillComposition() {
          createDatabasePool("postgresql://unexpected", 99);
          return createAssetImportStorageComposition();
        }
      `,
    }))).toEqual(expect.arrayContaining([
      expect.stringContaining("must not create an additional database pool")
    ]));
  });

  it("scans the secure-storage root itself for legacy writers and pool construction", () => {
    expect(check(sources({
      "services/runtime/src/asset-import-composition.ts": `
        export async function createAssetImportStorageComposition() {
          writeContentAddressed();
          createDatabasePool("postgresql://unexpected", 99);
          return {};
        }
      `,
    }))).toEqual(expect.arrayContaining([
      expect.stringContaining("prohibits legacy writer writeContentAddressed"),
      expect.stringContaining("must not create an additional database pool"),
    ]));
  });

  it("allows only the named e3g API composition to consume portable authority", () => {
    expect(check(readPrivateCompositionParitySources(process.cwd()))).toEqual([]);
  });

  it("rejects System Archive bypassing the named e3g asset composition even for a type-only dependency", () => {
    expect(check(sources({
      "services/runtime/src/system-archive-composition.ts": `
        import type { AssetImportStorageComposition } from "./asset-import-composition.js";
        export function createApiSystemArchiveComposition(
          options: { storage: Pick<AssetImportStorageComposition, "adapter"> },
        ) {
          return options.storage;
        }
      `,
    }))).toEqual(expect.arrayContaining([
      expect.stringContaining("must not bypass its named e3g composition consumer"),
    ]));
  });

  it("freezes generation + 4/+8 capacity and excludes private maintenance from manifests", () => {
    const capacitySources: readonly Source[] = [
      { file: "packages/database/src/config.ts", text: "const requiredWorkerConnections = roleValue === 'worker' ? workerGenerationConcurrency + 4 : roleValue === 'all' ? workerGenerationConcurrency + 8 : 0;" },
      { file: "services/worker/src/worker.ts", text: "export function runWorker() {}" },
      { file: "compose.yaml", text: "APP_ROLE: all\nDATABASE_MAX_CONNECTIONS: \${DATABASE_MAX_CONNECTIONS:-12}\nWORKER_GENERATION_CONCURRENCY: \${WORKER_GENERATION_CONCURRENCY:-1}" },
      { file: "deploy/swarm/stack.yaml", text: "APP_ROLE: worker\nDATABASE_MAX_CONNECTIONS: \${DATABASE_MAX_CONNECTIONS:-8}\nWORKER_GENERATION_CONCURRENCY: \${WORKER_GENERATION_CONCURRENCY:-1}" },
    ];
    expect(checkCapacity(capacitySources)).toEqual([]);
    expect(checkCapacity(capacitySources.map((source) => source.file === "packages/database/src/config.ts"
      ? { ...source, text: "// workerGenerationConcurrency + 4; workerGenerationConcurrency + 8\nconst requiredWorkerConnections = roleValue === 'worker' ? workerGenerationConcurrency + 5 : roleValue === 'all' ? workerGenerationConcurrency + 9 : 0;" }
      : source))).toEqual(expect.arrayContaining([
      expect.stringContaining("generation + 4"),
      expect.stringContaining("generation + 8"),
    ]));
    expect(checkCapacity(capacitySources.map((source) => source.file === "deploy/swarm/stack.yaml"
      ? { ...source, text: "createPrivateAssetMaintenanceComposition" }
      : source))).toEqual(expect.arrayContaining([
      expect.stringContaining("must not enter a deployment manifest"),
    ]));
    expect(checkCapacity(readPrivateCompositionCapacitySources(process.cwd()))).toEqual([]);
  });
});
