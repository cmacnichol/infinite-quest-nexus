import { describe, expect, it } from "vitest";
// @ts-expect-error Repository check scripts intentionally have no declaration files.
import { legacyMigrationBoundaryViolations } from "../../scripts/legacy-migration-boundary.mjs";

describe("legacy migration boundary", () => {
  it("permits the reviewed campaign normalizer without permitting unreviewed compatibility code", () => {
    expect(legacyMigrationBoundaryViolations(
      "packages/domain/src/legacy-campaign-normalization.ts",
      'import type { LegacyStory } from "./legacy-story-world.js";'
    )).toEqual([]);

    expect(legacyMigrationBoundaryViolations(
      "packages/domain/src/unreviewed-legacy-converter.ts",
      'import type { LegacyStory } from "./legacy-story-world.js";'
    )).toEqual([
      "packages/domain/src/unreviewed-legacy-converter.ts: legacy client compatibility must remain inside the reviewed migration boundary"
    ]);
  });
});
