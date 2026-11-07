import { describe, expect, it } from "vitest";
import { archivePolicySnapshotSchema, historicalArchivePolicy, stricterArchiveLimits, requireCompatibleArchivePreview } from "../../packages/contracts/src/archive-policy.js";
import { settingsFixture } from "../fixtures/instance-settings.js";
describe("archive policy retention", () => {
  it("validates installation-only snapshots and combines all seven safety limits without changing session contracts", () => {
    const baseline = historicalArchivePolicy("system");
    const current = { ...baseline, settingsRevision: "2", uploadTtlSeconds: 300, chunkBytes: 1024, limits: settingsFixture().systemArchiveLimits };
    for (const key of Object.keys(baseline.limits) as (keyof typeof baseline.limits)[]) {
      const tightened = { ...current, limits: { ...current.limits, [key]: 1 } };
      expect(stricterArchiveLimits(baseline, tightened)[key]).toBe(1);
      expect(() => requireCompatibleArchivePreview(baseline, tightened)).toThrow("archive-preview-policy-changed");
      expect(() => requireCompatibleArchivePreview(tightened, baseline)).not.toThrow();
    }
    expect(archivePolicySnapshotSchema.safeParse({ ...baseline, secret: "forbidden" }).success).toBe(false);
    expect(baseline.uploadTtlSeconds).toBe(86400);
    expect(baseline.previewTtlSeconds).toBe(1800);
  });
});
