import { describe, expect, it } from "vitest";
// @ts-expect-error The executable repository checker is intentionally plain ESM.
import * as boundaries from "../../scripts/check-private-asset-maintenance-boundaries.mjs";

type Source = Readonly<{ file: string; text: string }>;

const check = (boundaries as unknown as Readonly<{
  checkPrivateAssetMaintenanceBoundaries(sources: readonly Source[]): readonly string[];
}>).checkPrivateAssetMaintenanceBoundaries;

const valid: readonly Source[] = [
  {
    file: "packages/application/src/assets/private-asset-maintenance-scheduler.ts",
    text: "export function createPrivateAssetMaintenanceScheduler() { return {}; }",
  },
  {
    file: "services/runtime/src/private-asset-metadata-backfill-composition.ts",
    text: "export function createPrivateAssetMetadataBackfillComposition() { return {}; }",
  },
  {
    file: "services/runtime/src/private-filesystem-recovery-composition.ts",
    text: "export function createPrivateFilesystemRecoveryComposition() { return {}; }",
  },
  {
    file: "services/runtime/src/private-asset-maintenance-composition.ts",
    text: `
      import { createPrivateAssetMaintenanceScheduler } from "../../../packages/application/src/assets/private-asset-maintenance-scheduler.js";
      import { createPrivateAssetMetadataBackfillComposition } from "./private-asset-metadata-backfill-composition.js";
      import { createPrivateFilesystemRecoveryComposition } from "./private-filesystem-recovery-composition.js";
      export function createPrivateAssetMaintenanceComposition() {
        createPrivateAssetMaintenanceScheduler();
        createPrivateAssetMetadataBackfillComposition();
        createPrivateFilesystemRecoveryComposition();
      }
    `,
  },
  { file: "services/worker/src/worker.ts", text: "export function worker() {}" },
  { file: "services/runtime/src/main.ts", text: "export function main() {}" },
  { file: "services/runtime/src/generation-worker-composition.ts", text: "export function composeWorker() {}" },
  { file: "packages/application/src/assets/index.ts", text: "export const assets = {};" },
  { file: "packages/application/src/index.ts", text: "export const application = {};" },
  { file: "packages/contracts/src/index.ts", text: "export const contracts = {};" },
  { file: "packages/domain/src/index.ts", text: "export const domain = {};" },
];

describe("Task 14e3e7 maintenance boundaries", () => {
  it("accepts the named private e5/e6-only composition and its worker binding", () => {
    expect(check(valid)).toEqual([]);
  });

  it("requires both the named private scheduler contract and runtime composition", () => {
    expect(check(valid.filter((source) => source.file !== "services/runtime/src/private-asset-maintenance-composition.ts")))
      .toEqual(expect.arrayContaining([expect.stringContaining("runtime composition is missing")]));
    expect(check(valid.filter((source) => source.file !== "packages/application/src/assets/private-asset-maintenance-scheduler.ts")))
      .toEqual(expect.arrayContaining([expect.stringContaining("scheduler contract is missing")]));
  });

  it("rejects direct private scheduler and composition imports outside their named consumers", () => {
    const privateScheduler = "../../../packages/application/src/assets/private-asset-maintenance-scheduler.js";
    const privateComposition = "../../runtime/src/private-asset-maintenance-composition.js";
    const cases = [
      {
        file: "services/api/src/asset-service.ts",
        text: `import { createPrivateAssetMaintenanceScheduler } from "${privateScheduler}";`,
        message: "scheduler may be consumed only by the named private runtime composition",
      },
      {
        file: "services/worker/src/worker.ts",
        text: `import { createPrivateAssetMaintenanceScheduler } from "${privateScheduler}";`,
        message: "scheduler may be consumed only by the named private runtime composition",
      },
      {
        file: "services/runtime/src/main.ts",
        text: `const maintenance = await import("../../../packages/application/src/assets/private-asset-maintenance-scheduler.js");`,
        message: "scheduler may be consumed only by the named private runtime composition",
      },
      {
        file: "services/runtime/src/generation-worker-composition.ts",
        text: `const maintenance = require("../../../packages/application/src/assets/private-asset-maintenance-scheduler.js");`,
        message: "scheduler may be consumed only by the named private runtime composition",
      },
      {
        file: "packages/application/src/assets/index.ts",
        text: `export * from "./private-asset-maintenance-scheduler.js";`,
        message: "scheduler may be consumed only by the named private runtime composition",
      },
      {
        file: "packages/application/src/index.ts",
        text: `export * from "./assets/private-asset-maintenance-scheduler.js";`,
        message: "scheduler may be consumed only by the named private runtime composition",
      },
      {
        file: "packages/contracts/src/index.ts",
        text: `export * from "../../application/src/assets/private-asset-maintenance-scheduler.js";`,
        message: "scheduler may be consumed only by the named private runtime composition",
      },
      {
        file: "packages/domain/src/index.ts",
        text: `const maintenance = require("../../application/src/assets/private-asset-maintenance-scheduler.js");`,
        message: "scheduler may be consumed only by the named private runtime composition",
      },
      {
        file: "services/api/src/asset-service.ts",
        text: `import { createPrivateAssetMaintenanceComposition } from "${privateComposition}";`,
        message: "composition may be consumed only by services/worker/src/worker.ts",
      },
      {
        file: "services/runtime/src/generation-worker-composition.ts",
        text: `import { createPrivateAssetMaintenanceComposition } from "./private-asset-maintenance-composition.js";`,
        message: "composition may be consumed only by services/worker/src/worker.ts",
      },
      {
        file: "packages/application/src/index.ts",
        text: `export * from "../../../services/runtime/src/private-asset-maintenance-composition.js";`,
        message: "composition may be consumed only by services/worker/src/worker.ts",
      },
      {
        file: "services/runtime/src/private-asset-maintenance-composition.ts",
        text: `import { runAssetMetadataBackfill } from "../../api/src/asset-service.js"; runAssetMetadataBackfill();`,
        message: "must not reach services/api/src",
      },
      {
        file: "services/runtime/src/private-asset-maintenance-composition.ts",
        text: `import { createDatabasePool } from "../../../packages/database/src/pool.js"; createDatabasePool("postgres://unexpected", 99);`,
        message: "must not create an additional database pool",
      },
    ] as const;

    for (const candidate of cases) {
      expect(check([...valid, { file: candidate.file, text: candidate.text }]), candidate.text)
        .toEqual(expect.arrayContaining([expect.stringContaining(candidate.message)]));
    }
  });
});
