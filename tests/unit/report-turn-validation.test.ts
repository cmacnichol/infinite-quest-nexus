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

  it("uses durable completion, output presence, and validation errors rather than response IDs or finish limits", async () => {
    const jobs = [
      { id: "null-id", status: "completed", createdAt: "2026-09-18T00:00:00.000Z", promptProtocol: "story-v1",
        requestedModel: "", errorCode: null, failureDiagnostic: null, contextOptions: null, generationPolicy: null },
      { id: "length", status: "recoverable", createdAt: "2026-09-18T00:00:00.000Z", promptProtocol: "story-v1",
        requestedModel: "configured", errorCode: "generation_failed", failureDiagnostic: {
          version: 1, category: "output_incomplete", code: "output_limit", phase: "story_validation", attemptNumber: 1,
          occurredAt: "2026-09-18T00:00:02.000Z", privateMessage: "provider body was cut off"
        }, contextOptions: null, generationPolicy: null },
      { id: "invalid", status: "failed", createdAt: "2026-09-18T00:00:00.000Z", promptProtocol: "story-v2",
        requestedModel: "configured-repair", errorCode: "generation_failed", failureDiagnostic: {
          version: 1, category: "format", code: "invalid_schema", phase: "story_validation", attemptNumber: 1,
          occurredAt: "2026-09-18T00:00:02.000Z", privateMessage: "raw parser detail"
        }, contextOptions: { budgetTokens: 64_000 }, generationPolicy: { playMode: "story_only" } },
      { id: "incomplete", status: "discarded", createdAt: "2026-09-18T00:00:00.000Z", promptProtocol: "protocol\nMODEL_SECRET",
        requestedModel: "configured\nMODEL_SECRET", errorCode: "MODEL_SECRET=raw_provider_code", failureDiagnostic: null, contextOptions: { storyMemoryPolicy: { policy: null } }, generationPolicy: null }
    ];
    const query = vi.fn(async (text: string) => {
      if (text.includes("FROM generation_jobs")) return { rows: jobs };
      if (text.includes("FROM generation_attempts")) return { rows: [
        { jobId: "null-id", attemptNumber: 1, recoveryKind: "initial", providerResponseId: null, completedAt: "2026-09-18T00:00:01.000Z", hasOutput: true, validationErrors: [], requestMetadata: { model: "frozen-default-model" }, responseMetadata: { outputLimited: false, modelInstanceId: "returned-null-id" } },
        { jobId: "length", attemptNumber: 1, recoveryKind: "initial", providerResponseId: "response", completedAt: "2026-09-18T00:00:01.000Z", hasOutput: true, validationErrors: [], responseMetadata: { outputLimited: true, modelInstanceId: "returned-length" } },
        { jobId: "invalid", attemptNumber: 1, recoveryKind: "initial", providerResponseId: "response", completedAt: "2026-09-18T00:00:01.000Z", hasOutput: true, validationErrors: ["canonical_facts missing"], responseMetadata: { outputLimited: false, modelInstanceId: "returned-invalid" } },
        { jobId: "invalid", attemptNumber: 2, recoveryKind: "repair", providerResponseId: "response-repair", completedAt: "2026-09-18T00:00:02.000Z", hasOutput: true, validationErrors: [], responseMetadata: { outputLimited: false, modelInstanceId: "returned-repair" } },
        { jobId: "incomplete", attemptNumber: 1, recoveryKind: "initial", providerResponseId: "response", completedAt: null, hasOutput: true, validationErrors: [], responseMetadata: { outputLimited: false, modelInstanceId: "returned\nMODEL_SECRET" } }
      ] };
      return { rows: [] };
    });

    const report = await readTurnValidationReport({ query } as any, { limit: 50, since: null, format: "json" });
    expect(report.metrics).toMatchObject({ jobsWithInitialResponse: 3, initialValid: 2, initialInvalid: 1, initialUnknown: 1,
      repairResponses: 1, validRepairResponses: 1 });
    expect(report.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: "null-id", finalStatus: "completed", initialOutcome: "valid", configuredModel: "frozen-default-model", actualReturnedModel: "returned-null-id" }),
      expect.objectContaining({ jobId: "length", finalStatus: "recoverable", failureDiagnostic: { code: "output_limit", message: "The provider output was incomplete." } }),
      expect.objectContaining({ jobId: "invalid", finalStatus: "failed", initialOutcome: "invalid", configuredModel: "configured-repair", actualReturnedModel: "returned-invalid",
        finalErrorCode: "generation_failed", failureDiagnostic: null }),
      expect.objectContaining({ jobId: "incomplete", finalStatus: "discarded", initialOutcome: "unknown", finalErrorCode: "generation_failed",
        configuredModel: "unknown", actualReturnedModel: "unknown" })
    ]));
    expect(report.cohorts).toEqual(expect.arrayContaining([
      expect.objectContaining({ configuredModel: "frozen-default-model", promptProtocol: "story-v1", metrics: expect.objectContaining({ jobs: 1, initialValid: 1 }) }),
      expect.objectContaining({ configuredModel: "configured-repair", promptProtocol: "story-v2", playMode: "story_only", contextBucket: "32k-127k",
        metrics: expect.objectContaining({ jobs: 1, initialInvalid: 1, validRepairResponses: 1 }) })
    ]));
    expect(JSON.stringify(report)).not.toContain("MODEL_SECRET");
  });
});
