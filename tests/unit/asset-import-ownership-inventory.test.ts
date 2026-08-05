import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "../..");

const productionCallerDisposition = [
  ["services/api/src/server.ts", "api_transport"],
  ["services/api/src/archive-routes.ts", "api_transport"],
  ["services/worker/src/worker.ts", "worker_scheduling"],
  ["services/runtime/src/illustration-composition.ts", "named_application_composition"],
  ["services/runtime/src/illustration-platform-bindings.ts", "named_application_composition"],
  ["services/runtime/src/runtime-role.ts", "named_application_composition"],
  ["services/runtime/src/illustration-image-job-adapter.ts", "named_application_composition"],
  ["services/api/src/asset-service.ts", "delete_in_14e3"],
  ["services/api/src/asset-archive-service.ts", "delete_in_14e3"],
  ["services/api/src/campaign-archive-service.ts", "delete_in_14e3"],
  ["services/api/src/import-service.ts", "delete_in_14e3"],
  ["services/api/src/infinite-worlds-import-service.ts", "delete_in_14e3"],
  ["services/api/src/archive-io.ts", "named_application_composition"],
  ["services/api/src/service-helpers.ts", "delete_in_14e3"]
] as const;

describe("Task 14e asset/import ownership inventory", () => {
  it("freezes every current production caller and its 14e disposition", () => {
    expect(productionCallerDisposition).toHaveLength(14);
    for (const [path, disposition] of productionCallerDisposition) {
      expect(readFileSync(join(repositoryRoot, path), "utf8"), path).not.toBe("");
      expect(["api_transport", "worker_scheduling", "named_application_composition", "delete_in_14e3"])
        .toContain(disposition);
    }
  });

  it("keeps additive application contracts free of API and worker implementation imports", () => {
    for (const path of [
      "packages/application/src/assets/types.ts",
      "packages/application/src/assets/ports.ts",
      "packages/application/src/assets/use-cases.ts",
      "packages/application/src/imports/types.ts",
      "packages/application/src/imports/ports.ts",
      "packages/application/src/imports/use-cases.ts"
    ]) {
      const source = readFileSync(join(repositoryRoot, path), "utf8");
      expect(source, path).not.toMatch(/from\s+["'][^"']*services\/(?:api|worker)\//u);
    }
  });
});
