import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverIntegrationTestFiles,
  integrationTestCommand,
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

  it("runs one shell-free Vitest process for exactly one integration file", () => {
    const command = integrationTestCommand("tests/integration/example.integration.test.ts");
    const vitestCli = command.arguments[0];

    expect(command.executable).toBe(process.execPath);
    expect(vitestCli).toMatch(/[\\/]vitest[\\/]vitest\.mjs$/u);
    expect(command.arguments.slice(1)).toEqual([
      "run",
      "--config",
      "vitest.integration.config.ts",
      "tests/integration/example.integration.test.ts",
    ]);
    if (!vitestCli) throw new Error("The Vitest JS CLI was not resolved.");
    expect(execFileSync(command.executable, [vitestCli, "--version"], {
      encoding: "utf8",
    })).toMatch(/^vitest\/4\./u);
  });
});
