import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

describe("legacy browser network boundary", () => {
  test("rejects a network call in unallowlisted public JavaScript", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "legacy-boundary-"));
    const fixtureRelativePath = `apps/web/public/unallowlisted-${randomUUID()}.js`;
    const fixturePath = join(fixtureRoot, fixtureRelativePath);
    const checkerPath = resolve("scripts/check-repository-boundaries.mjs");

    try {
      expect(spawnSync("git", ["init", "--quiet"], { cwd: fixtureRoot }).status).toBe(0);
      mkdirSync(join(fixtureRoot, "apps/web/public"), { recursive: true });
      writeFileSync(fixturePath, 'fetch("https://untrusted.example/data");\n');

      const result = spawnSync(process.execPath, [checkerPath], {
        cwd: fixtureRoot,
        encoding: "utf8"
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `${fixtureRelativePath}:1: browser fetch must use the Nexus API`
      );
    } finally {
      if (existsSync(fixtureRoot)) rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 20000);
});