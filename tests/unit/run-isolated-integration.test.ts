import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverIntegrationTestFiles,
  integrationTestArguments,
} from "../../scripts/run-isolated-integration.mjs";

describe("isolated integration runner", () => {
  it("discovers every integration test deterministically without setup modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "iqn-integration-runner-"));
    try {
      await mkdir(join(root, "nested"));
      await Promise.all([
        writeFile(join(root, "z.integration.test.ts"), ""),
        writeFile(join(root, "a.integration.test.ts"), ""),
        writeFile(join(root, "nested", "b.integration.test.ts"), ""),
        writeFile(join(root, "setup-isolated-database.ts"), ""),
      ]);

      await expect(discoverIntegrationTestFiles(root)).resolves.toEqual([
        "a.integration.test.ts",
        "nested/b.integration.test.ts",
        "z.integration.test.ts",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs one Vitest process for exactly one integration file", () => {
    expect(integrationTestArguments("tests/integration/example.integration.test.ts")).toEqual([
      "exec",
      "vitest",
      "run",
      "--config",
      "vitest.integration.config.ts",
      "tests/integration/example.integration.test.ts",
    ]);
  });
});
