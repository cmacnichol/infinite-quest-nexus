import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("database migration ordering", () => {
  it("uses a unique numeric prefix for every migration", async () => {
    const files = (await readdir(resolve("database/migrations")))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    const prefixes = files.map((file) => file.match(/^(\d+)_/)?.[1]).filter((prefix): prefix is string => prefix !== undefined);

    expect(prefixes).toHaveLength(files.length);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("places campaign Story context persistence immediately after migration 0077", async () => {
    const files = (await readdir(resolve("database/migrations"))).filter((file) => file.endsWith(".sql")).sort();

    expect(files.at(-1)).toBe("0078_campaign_story_context_budget.sql");
  });
});
