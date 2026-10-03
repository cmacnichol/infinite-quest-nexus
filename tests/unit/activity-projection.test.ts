import { expect, it } from "vitest";
import { projectActivityDiagnostic, projectBrowserActivityError, activityPresentation } from "../../packages/domain/src/activity.js";
it("rejectsPrivatePayloads", () => {
  const input = { code: "unknown", message: "PRIVATE", details: "PRIVATE", cause: "PRIVATE", stack: "PRIVATE", prompt: "PRIVATE", action: "PRIVATE", url: "PRIVATE", correlationId: "x".repeat(129), modelId: "x".repeat(201), phase: "PRIVATE" };
  const projected = projectActivityDiagnostic(input);
  expect(projected?.code).toBe("generation_failed");
  expect(JSON.stringify(projected)).not.toContain("PRIVATE");
  expect(projected).toMatchObject({ metadataTruncated: true });
  expect(projected).not.toHaveProperty("correlationId");
  expect(projected).not.toHaveProperty("modelId");
  expect(projectBrowserActivityError({ ...input, status: 503 })?.httpStatus).toBe(503);
});
it("separatesMonitoringFromFailure", () => {
  expect(activityPresentation({ kind: "browser.monitoring_degraded", diagnostic: null } as never).message).toContain("does not establish");
  expect(activityPresentation({ kind: "generation.review_required", diagnostic: null } as never).recovery).toContain("review");
});

it("projects bounded metadata without parsing exception text", () => {
  expect(projectActivityDiagnostic(new Error("provider_request_timeout PRIVATE"))?.code).toBe("generation_failed");
  expect(projectActivityDiagnostic(null)).toBeNull();
  expect(projectActivityDiagnostic({ code: "provider_request_timeout", correlationId: "a".repeat(128), modelId: "a".repeat(200), httpStatus: 599, durationMs: 0, phase: "generating" })).toMatchObject({ phase: "generating", httpStatus: 599, durationMs: 0 });
  expect(projectActivityDiagnostic({ code: "provider_request_timeout", httpStatus: 600, durationMs: -1, modelId: "https://provider.example/?token=PRIVATE", correlationId: "PRIVATE secret" })).not.toHaveProperty("httpStatus");
  expect(projectBrowserActivityError({ status: 500, url: "PRIVATE", method: "POST", routeTemplate: "/api/v1/campaigns/:campaignId/generations" })).toMatchObject({ method: "POST", routeTemplate: "/api/v1/campaigns/:campaignId/generations" });
  expect(projectBrowserActivityError({ status: 500, routeTemplate: "/api/v1/campaigns/PRIVATE?token=PRIVATE" })).not.toHaveProperty("routeTemplate");
  const hostile = Object.defineProperty({}, "code", { get() { throw new Error("PRIVATE"); } });
  expect(projectActivityDiagnostic(hostile)?.code).toBe("generation_failed");
});


it("omits provider URLs from model diagnostics, presentation, and serialized export", async () => {
  const { activityDiagnosticSchema } = await import("../../packages/contracts/src/activity.js");
  for (const modelId of ["https://private-provider.example/tokenSECRET", "HTTP://private-provider.example/tokenSECRET", "ftp://private-provider.example/tokenSECRET", "custom+provider://private-provider.example/tokenSECRET", "//private-provider.example/tokenSECRET", "https:private-provider.example/tokenSECRET", "file:/private/tokenSECRET"]) {
    const diagnostic = { code: "provider_request_timeout", message: "The provider request timed out.", modelId };
    expect(activityDiagnosticSchema.safeParse(diagnostic).success).toBe(false);
    const projected = projectActivityDiagnostic(diagnostic);
    expect(projected).not.toHaveProperty("modelId");
    expect(JSON.stringify(projected)).not.toContain("tokenSECRET");
    const presentation = activityPresentation({ kind: "generation.failed", diagnostic } as never);
    expect(presentation.fields.some(field => field.label === "Model")).toBe(false);
    expect(JSON.stringify(presentation)).not.toContain("tokenSECRET");
  }
  for (const modelId of ["openai/gpt-4.1", "llama3:latest", "Qwen/Qwen3-30B-A3B", "model@revision", "provider/model:v1.2"]) {
    expect(projectActivityDiagnostic({ code: "provider_request_timeout", modelId })?.modelId).toBe(modelId);
  }
});
