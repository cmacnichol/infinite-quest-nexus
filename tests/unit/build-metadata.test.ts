import { describe, expect, it } from "vitest";
import { buildMetadataFromGit } from "../../scripts/build-metadata.mjs";

describe("build metadata", () => {
  it("marks a dirty tree and keeps the full commit", () => {
    const metadata = buildMetadataFromGit({
      revParse: () => "1ce3893c0000000000000000000000000000beef",
      statusPorcelain: () => " M packages/contracts/src/story-prompt.ts\n",
      now: () => new Date("2026-09-25T00:00:00Z")
    });
    expect(metadata).toEqual({ commit: "1ce3893c0000000000000000000000000000beef", dirty: true, date: "2026-09-25T00:00:00.000Z" });
  });

  it("reports a clean tree", () => {
    const metadata = buildMetadataFromGit({ revParse: () => "abc", statusPorcelain: () => "", now: () => new Date(0) });
    expect(metadata.dirty).toBe(false);
  });
});
