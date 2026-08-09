import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Task 14e3e3 private illustration publication contracts", () => {
  it("names a private coordinator whose ingress cannot supply owner authority", async () => {
    const source = await readFile(resolve(
      "packages/application/src/illustration/private-illustration-asset-publication.ts",
    ), "utf8");

    expect(source).toContain("interface PrivateIllustrationAssetPublicationCoordinator");
    expect(source).toContain("completeClaimedImageJob(");
    expect(source).toContain("recoverFinalization(");
    const completionCommand = source.match(
      /type PrivateIllustrationCompletionCommand[\s\S]*?export type PrivateIllustrationFinalizationRecoveryCommand/u,
    )?.[0] ?? "";
    expect(completionCommand).toContain("imageJobId: string");
    expect(completionCommand).toContain("workerId: string");
    expect(completionCommand).not.toContain("ownerUserId");
  });

  it("keeps pending finalization distinct from safe published results", async () => {
    const source = await readFile(resolve(
      "packages/application/src/illustration/private-illustration-asset-publication.ts",
    ), "utf8");

    expect(source).toContain('outcome: "committed_finalization_pending"');
    expect(source).toContain('diagnostic: "asset_publication_finalization_recoverable"');
    expect(source).toContain('outcome: "published"');
    expect(source).toContain('outcome: "noop"');
  });

  it("does not re-export the replacement seam from the illustration barrel", async () => {
    const barrel = await readFile(resolve("packages/application/src/illustration/index.ts"), "utf8");
    expect(barrel).not.toContain("private-illustration-asset-publication");
    expect(barrel).not.toContain("PrivateIllustrationAssetPublicationCoordinator");
  });
});
