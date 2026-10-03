import { expect, it } from "vitest";
import { activityEventSchema, activityDiagnosticSchema } from "../../packages/contracts/src/activity.js";
import { projectActivityDiagnostic } from "../../packages/domain/src/activity.js";
const id = "00000000-0000-4000-8000-000000000001";
const event = { version: 1, eventId: id, sequence: "9007199254740993", occurredAt: "2026-10-03T00:00:00Z", publishedAt: "2026-10-03T00:00:00Z", campaignId: id, source: "generation", kind: "generation.failed", severity: "error", status: "failed", jobId: null, generationJobId: null, segmentId: null, turnId: null, turnNumber: null, attemptNumber: null, diagnostic: null };
it("acceptsSafeProviderFailure", () => {
  const diagnostic = projectActivityDiagnostic({ code: "provider_request_timeout" });
  expect(diagnostic?.message).toBe("The provider request timed out.");
  expect(activityEventSchema.parse({ ...event, diagnostic }).sequence).toBe("9007199254740993");
});
it("rejectsPrivatePayloads", () => {
  for (const extra of [{ details: "PRIVATE" }, { source: "image" }, { sequence: 9007199254740993 }]) expect(activityEventSchema.safeParse({ ...event, ...extra }).success).toBe(false);
  expect(activityDiagnosticSchema.safeParse({ code: "generation_failed", message: "PRIVATE" }).success).toBe(false);
});

it("validates boundaries and rejects oversized serialized events", () => {
  expect(activityEventSchema.safeParse({ ...event, sequence: "9223372036854775808" }).success).toBe(false);
  expect(activityEventSchema.safeParse({ ...event, sequence: "01" }).success).toBe(false);
  expect(activityEventSchema.safeParse({ ...event, diagnostic: { code: "generation_failed", message: "The generation could not be completed.", correlationId: "a".repeat(129) } }).success).toBe(false);
  expect(activityEventSchema.safeParse({ ...event, diagnostic: { code: "generation_failed", message: "The generation could not be completed.", modelId: "a".repeat(201) } }).success).toBe(false);
  expect(activityEventSchema.safeParse({ ...event, diagnostic: { code: "generation_failed", message: "The generation could not be completed.", details: "x".repeat(4096) } }).success).toBe(false);
});

it("requires monitoring interruption to remain a browser warning", async () => {
  const { browserActivityObservationSchema } = await import("../../packages/contracts/src/activity.js");
  const observation = { version: 1, observationId: id, sequence: "1", observedAt: event.occurredAt, campaignId: id, kind: "browser.monitoring_degraded", severity: "error", jobId: null, generationJobId: null, segmentId: null, turnId: null, diagnostic: null };
  expect(browserActivityObservationSchema.safeParse(observation).success).toBe(false);
  expect(browserActivityObservationSchema.safeParse({ ...observation, severity: "warning" }).success).toBe(true);
});

it("keeps pagination and UTF-8 size contracts strict", async () => {
  const { activityPageQuerySchema, activitySerializedSize, activityScopeSchema } = await import("../../packages/contracts/src/activity.js");
  expect(activityPageQuerySchema.parse({}).limit).toBe(100);
  expect(activityPageQuerySchema.safeParse({ before: "a", after: "b" }).success).toBe(false);
  expect(activityPageQuerySchema.safeParse({ limit: 201 }).success).toBe(false);
  expect(activityPageQuerySchema.safeParse({ before: "x".repeat(513) }).success).toBe(false);
  expect(activityScopeSchema.safeParse({ ownerUserId: id, campaignId: id, callerOwner: id }).success).toBe(false);
  expect(activitySerializedSize("😀")).toBe(6);
});
