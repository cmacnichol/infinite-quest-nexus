import { describe, expect, it } from "vitest";
// @ts-expect-error The source inventory is an executable ESM guard.
import * as legacyAuthorityGuard from "../../scripts/check-legacy-authority-removal.mjs";

const { checkLegacyAuthorityRemoval, readLegacyAuthoritySources } = legacyAuthorityGuard as unknown as Readonly<{
  checkLegacyAuthorityRemoval(
    sources: readonly Readonly<{ file: string; text: string }>[],
  ): readonly string[];
  readLegacyAuthoritySources(root: string): readonly Readonly<{ file: string; text: string }>[];
}>;

describe("Task 14e3h legacy authority removal", () => {
  it("keeps every production graph free of the retired API authority modules", () => {
    expect(checkLegacyAuthorityRemoval(readLegacyAuthoritySources(process.cwd()))).toEqual([]);
  });

  it("rejects a retired authority even when nothing imports it", () => {
    expect(checkLegacyAuthorityRemoval([{
      file: "services/api/src/asset-service.ts",
      text: "export function queryAssets() {}",
    }])).toEqual([
      "services/api/src/asset-service.ts: retired API authority must be deleted from the production tree",
    ]);
  });
});
