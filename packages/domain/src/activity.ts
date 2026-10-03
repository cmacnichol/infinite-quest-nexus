import { ACTIVITY_DIAGNOSTIC_MESSAGES, activityDiagnosticSchema, activityDiagnosticCodeSchema, type ActivityDiagnostic, type ActivityEvent, type BrowserActivityObservation, generationActivityKindSchema, imageActivityKindSchema, segmentActivityKindSchema, browserActivityKindSchema } from "../../contracts/src/activity.js";
import { projectGenerationFailureDiagnostic } from "../../contracts/src/generation-review.js";

/** Pick named structured fields only. Exceptions and nested details are never interpreted. */
export function projectActivityDiagnostic(input: unknown): ActivityDiagnostic | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  try {
    const source = input as Record<string, unknown>;
    const failure = projectGenerationFailureDiagnostic(source);
    const parsedCode = activityDiagnosticCodeSchema.safeParse(failure?.code ?? source.code);
    const code = parsedCode.success ? parsedCode.data : "generation_failed";
    const output: Record<string, unknown> = { code, message: ACTIVITY_DIAGNOSTIC_MESSAGES[code] };
    const fields = activityDiagnosticSchema.shape;
    for (const key of ["phase", "correlationId", "httpStatus", "providerProfileId", "modelId", "durationMs", "method", "routeTemplate"] as const) {
      const value = source[key];
      if (value === undefined || value === null) continue;
      const parsed = fields[key].safeParse(value);
      if (parsed.success) output[key] = parsed.data;
      else if ((key === "correlationId" && typeof value === "string" && value.length > 128) || (key === "modelId" && typeof value === "string" && value.length > 200)) output.metadataTruncated = true;
    }
    return activityDiagnosticSchema.parse(output);
  } catch { return { code: "generation_failed", message: ACTIVITY_DIAGNOSTIC_MESSAGES.generation_failed! }; }
}
export function projectBrowserActivityError(input: unknown): ActivityDiagnostic | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  try {
    const source = input as Record<string, unknown>;
    return projectActivityDiagnostic({ code: activityDiagnosticCodeSchema.safeParse(source.code).success ? source.code : "request_failed", httpStatus: source.httpStatus ?? source.status, correlationId: source.correlationId, method: source.method, routeTemplate: source.routeTemplate });
  } catch { return { code: "request_failed", message: ACTIVITY_DIAGNOSTIC_MESSAGES.request_failed! }; }
}
export interface ActivityPresentation { title: string; message: string; recovery: string | null; fields: ReadonlyArray<{ label: string; value: string }>; }
const titles: Readonly<Record<string, string>> = Object.freeze({
  "generation.queued": "Generation queued", "generation.claimed": "Generation claimed", "generation.generating": "Generating story", "generation.validating": "Validating story", "generation.committing": "Accepting turn", "generation.review_required": "Review required", "generation.review_decided": "Review decision recorded", "generation.retry_queued": "Generation retry queued", "generation.completed": "Turn accepted", "generation.recoverable": "Generation needs attention", "generation.failed": "Generation failed", "generation.cancelled": "Generation cancelled", "generation.discarded": "Generation discarded",
  "image.queued": "Illustration queued", "image.generating": "Generating illustration", "image.provider_pending": "Illustration provider pending", "image.downloading": "Downloading illustration", "image.retry_queued": "Illustration retry queued", "image.completed": "Illustration completed", "image.recoverable": "Illustration needs attention", "image.failed": "Illustration failed", "image.cancelled": "Illustration cancelled", "image.expired": "Illustration expired",
  "illustration_segment.refining": "Refining illustration prompt", "illustration_segment.direct_fallback": "Using direct illustration prompt", "illustration_segment.completed": "Illustration segment completed", "illustration_segment.failed": "Illustration segment failed",
  "browser.campaign_load": "Campaign load observation", "browser.submission_failed": "Submission failed", "browser.monitoring_degraded": "Monitoring interrupted", "browser.monitoring_restored": "Monitoring restored", "browser.monitoring_detached": "Monitoring detached", "browser.result_unavailable": "Result unavailable", "browser.recovery_command_failed": "Recovery command failed", "browser.history_page_failed": "History unavailable", "browser.undo_result": "Undo result", "browser.illustration_command_failed": "Illustration command failed"
});
export const ACTIVITY_PRESENTATION_KINDS = [...generationActivityKindSchema.options, ...imageActivityKindSchema.options, ...segmentActivityKindSchema.options, ...browserActivityKindSchema.options];
export function activityPresentation(event: ActivityEvent | BrowserActivityObservation): ActivityPresentation {
  const diagnostic = projectActivityDiagnostic(event.diagnostic);
  const title = titles[event.kind] ?? "Activity";
  const message = event.kind === "browser.monitoring_degraded" ? ACTIVITY_DIAGNOSTIC_MESSAGES.monitoring_degraded! : event.kind === "generation.review_required" ? ACTIVITY_DIAGNOSTIC_MESSAGES.review_required! : diagnostic?.message ?? title;
  const fields: Array<{ label: string; value: string }> = [];
  for (const [key, label] of [["jobId", "Job ID"], ["generationJobId", "Generation job ID"], ["segmentId", "Segment ID"], ["turnId", "Turn ID"]] as const) {
    if (event[key]) fields.push({ label, value: event[key] });
  }
  if ("attemptNumber" in event && event.attemptNumber !== null) fields.push({ label: "Attempt", value: String(event.attemptNumber) });
  if ("turnNumber" in event && event.turnNumber !== null) fields.push({ label: "Turn", value: String(event.turnNumber) });
  if (diagnostic) {
    for (const [key, label] of [["code", "Diagnostic code"], ["phase", "Phase"], ["correlationId", "Correlation ID"], ["httpStatus", "HTTP status"], ["providerProfileId", "Provider profile"], ["modelId", "Model"], ["durationMs", "Duration (ms)"], ["method", "HTTP method"], ["routeTemplate", "Route"]] as const) {
      if (diagnostic[key] !== undefined) fields.push({ label, value: String(diagnostic[key]) });
    }
  }
  return { title, message, recovery: event.kind === "generation.review_required" ? "View current review and recovery options." : ["generation.failed", "generation.recoverable", "image.failed", "image.recoverable"].includes(event.kind) ? "View current recovery options." : null, fields };
}

