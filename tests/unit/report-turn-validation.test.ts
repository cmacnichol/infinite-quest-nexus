import { describe, expect, it, vi } from "vitest";
import { parseTurnValidationReportOptions, readTurnValidationReport } from "../../scripts/report-turn-validation.js";

describe("turn validation report", () => {
  it("rejects unsafe report limits and non-UTC since values", () => {
    expect(() => parseTurnValidationReportOptions(["--limit", "1001"])).toThrow("--limit must be between 1 and 1000");
    expect(() => parseTurnValidationReportOptions(["--since", "2026-09-18"])).toThrow("--since must be a UTC timestamp");
    expect(parseTurnValidationReportOptions(["--limit", "50", "--since", "2026-09-18T00:00:00.000Z", "--format", "json"]))
      .toEqual({ limit: 50, since: "2026-09-18T00:00:00.000Z", format: "json" });
  });

  it("uses a read-only transaction, bounded parameterized metadata queries, and rollback", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const client = { query, release: vi.fn() };
    const report = await readTurnValidationReport(client as any, { limit: 50, since: null, format: "json" });

    expect(query.mock.calls[0]).toEqual(["BEGIN READ ONLY"]);
    expect(query.mock.calls.at(-1)).toEqual(["ROLLBACK"]);
    expect(query.mock.calls[1]?.[0]).toContain("LIMIT $2");
    expect(query.mock.calls[1]?.[0]).not.toContain("raw_output");
    expect(query.mock.calls[1]?.[1]).toEqual([null, 50]);
    expect(report.metrics).toEqual(expect.objectContaining({ jobs: 0, initialValid: 0 }));
  });
});
