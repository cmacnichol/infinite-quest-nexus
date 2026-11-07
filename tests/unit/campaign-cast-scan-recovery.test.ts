import { describe, expect, it } from "vitest";
import { castScanRecovery } from "../../apps/web/src/campaign-cast-scan-panel.js";
import { castScanRecovery as nextRecovery } from "../../apps/web-next/src/campaign-cast-scan-panel.js";

for (const recovery of [castScanRecovery, nextRecovery]) describe("cast scan recovery", () => {
  const status = { enabled: true, activeTurnNumber: 12, coverageStartTurn: 5, trackedThroughTurn: 8, state: "failed" as const,
    unresolvedCount: 0, firstGap: { turnNumber: 9, jobId: null, status: "failed" as const, diagnosticCode: "provider_timeout" as const } };
  it("recommends the missing gap through the current boundary without including completed turns", () => {
    expect(recovery(status, 12)).toMatchObject({ fromTurn: 9, throughTurn: 12, diagnostic: "The text provider timed out." });
  });
  it("recommends earlier history when current coverage is complete", () => {
    expect(recovery({ ...status, trackedThroughTurn: 12, firstGap: null, state: "complete" }, 12)).toMatchObject({ fromTurn: 1, throughTurn: 4 });
  });
  it("does not recommend a scan when everything is tracked", () => {
    expect(recovery({ ...status, coverageStartTurn: 1, trackedThroughTurn: 12, firstGap: null, state: "complete" }, 12).fromTurn).toBeNull();
  });
  it("distinguishes an oversized turn from a provider failure", () => {
    expect(recovery({ ...status, firstGap: { ...status.firstGap, diagnosticCode: "source_requires_manual_scan" } }, 12).diagnostic).toContain("manual");
  });
});
