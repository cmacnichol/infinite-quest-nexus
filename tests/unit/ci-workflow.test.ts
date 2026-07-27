import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("GitHub CI test workflow", () => {
  it("runs only database-independent unit tests", async () => {
    const workflow = await readFile(resolve(".github/workflows/ci.yml"), "utf8");

    expect(workflow).toMatch(/name: Test unit suite\r?\n\s+run: pnpm test:unit/u);
    expect(workflow).not.toMatch(/services:\r?\n\s+postgres:/u);
    expect(workflow).not.toContain("TEST_DATABASE_URL:");
    expect(workflow).not.toMatch(/run: pnpm test\r?\n/u);
  });
});
