import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildMetadataFromGit } from "../../scripts/build-metadata.mjs";

describe("build metadata", () => {
  it("marks an untracked build input dirty using the real Git reader", () => {
    const directory = mkdtempSync(join(tmpdir(), "nexus-build-metadata-"));
    const script = resolve("scripts/build-metadata.mjs");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, stdio: "pipe" });
    const metadata = () => execFileSync(process.execPath, [script], { cwd: directory, encoding: "utf8" });
    try {
      git("init");
      git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Baseline");
      expect(metadata()).toContain("NEXUS_BUILD_DIRTY=false");
      writeFileSync(join(directory, "new-source.ts"), "export const value = 1;\n");
      expect(metadata()).toContain("NEXUS_BUILD_DIRTY=true");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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
