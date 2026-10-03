import { randomUUID } from "node:crypto";
import { ACTIVITY_DIAGNOSTIC_MESSAGES, type ActivityEventDraft } from "../../contracts/src/activity.js";
import { projectGenerationFailureDiagnostic, type GenerationFailureDiagnostic } from "../../contracts/src/generation-review.js";
import { captureActivity } from "./activity-repository.js";
import type { DatabaseClient } from "./pool.js";

type GenerationKind = Extract<ActivityEventDraft, { source: "generation" }>["kind"];

/** Call only after a successful authoritative mutation, on its transaction client. */
export async function captureGenerationActivity(client: DatabaseClient, jobId: string, ownerUserId: string, kinds: readonly GenerationKind[], currentFailureDiagnostic?: GenerationFailureDiagnostic): Promise<void> {
  const result = await client.query<{
    campaign_id: string; status: Extract<ActivityEventDraft, { source: "generation" }>["status"];
    activity_revision: string; attempts: number; expected_turn_number: number; result_turn_id: string | null;
    error_code: string | null; occurred_at: Date;
  }>(`UPDATE generation_jobs SET activity_revision = activity_revision + 1
      WHERE id = $1 AND owner_user_id = $2
      RETURNING campaign_id, status, activity_revision::text, attempts, expected_turn_number, result_turn_id,
        error_code, updated_at AS occurred_at`, [jobId, ownerUserId]);
  const row = result.rows[0];
  if (!row) throw new Error("Activity source disappeared in its mutation transaction.");
  // Only this invocation may supply structured cause evidence; stored failures may describe an earlier attempt.
  const failure = projectGenerationFailureDiagnostic(currentFailureDiagnostic) ?? projectGenerationFailureDiagnostic({ version: 1, category: "unknown", code: row.error_code,
    phase: "activity", attemptNumber: row.attempts, occurredAt: row.occurred_at.toISOString() })
    ?? { code: "generation_failed" as const, message: ACTIVITY_DIAGNOSTIC_MESSAGES.generation_failed! };
  for (const [ordinal, kind] of kinds.entries()) {
    await captureActivity(client, {
      scope: { ownerUserId, campaignId: row.campaign_id }, sourceId: jobId, revision: row.activity_revision, ordinal,
      draft: { version: 1, eventId: randomUUID(), occurredAt: row.occurred_at.toISOString(), campaignId: row.campaign_id,
        source: "generation", kind, status: row.status, jobId, generationJobId: jobId, segmentId: null,
        turnId: row.result_turn_id, turnNumber: row.expected_turn_number, attemptNumber: row.attempts,
        severity: kind === "generation.completed" ? "success" : kind === "generation.failed" ? "error"
          : ["generation.recoverable", "generation.review_required"].includes(kind) ? "warning" : "info",
        diagnostic: kind === "generation.review_required"
          ? { code: "review_required", message: ACTIVITY_DIAGNOSTIC_MESSAGES.review_required! }
          : kind === "generation.failed" || kind === "generation.recoverable" ? failure : null }
    });
  }
}

/** Cancellation snapshots remain independent of later source/asset deletion. */
export async function captureCancelledIllustrationActivity(client: DatabaseClient, source: "image" | "illustration_segment", sourceId: string, ownerUserId: string): Promise<void> {
  const table = source === "image" ? "image_jobs" : "turn_illustration_segments";
  const result = await client.query<{ campaign_id: string; generation_job_id: string | null; turn_id: string | null; activity_revision: string; occurred_at: Date }>(
    `UPDATE ${table} SET activity_revision = activity_revision + 1 WHERE id = $1 AND owner_user_id = $2
      RETURNING campaign_id, generation_job_id, turn_id, activity_revision::text, updated_at AS occurred_at`, [sourceId, ownerUserId]);
  const row = result.rows[0];
  if (!row) throw new Error("Cancelled illustration source disappeared.");
  const common = { version: 1 as const, eventId: randomUUID(), occurredAt: row.occurred_at.toISOString(), campaignId: row.campaign_id,
    generationJobId: row.generation_job_id, turnId: row.turn_id, turnNumber: null, attemptNumber: null, diagnostic: null };
  const draft: ActivityEventDraft = source === "image"
    ? { ...common, source, kind: "image.cancelled", status: "cancelled", severity: "info", jobId: sourceId, segmentId: null }
    : { ...common, source, kind: "illustration_segment.failed", status: "failed", severity: "error", jobId: null, segmentId: sourceId };
  await captureActivity(client, { scope: { ownerUserId, campaignId: row.campaign_id }, sourceId, revision: row.activity_revision, draft });
}
