import { randomUUID } from "node:crypto";
import { ACTIVITY_DIAGNOSTIC_MESSAGES, type ActivityDiagnostic, type ActivityEventDraft } from "../../contracts/src/activity.js";
import { projectGenerationFailureDiagnostic, type GenerationFailureDiagnostic } from "../../contracts/src/generation-review.js";
import { captureActivity } from "./activity-repository.js";
import type { DatabaseClient } from "./pool.js";

type ImageDraft = Extract<ActivityEventDraft, { source: "image" }>;
type SegmentDraft = Extract<ActivityEventDraft, { source: "illustration_segment" }>;
export type ImageActivityKind = ImageDraft["kind"];
export type SegmentActivityKind = SegmentDraft["kind"];

/** Only current typed evidence is eligible; arbitrary provider text and saved failures are excluded. */
export function illustrationActivityDiagnostic(kind: ImageActivityKind | SegmentActivityKind, currentFailure?: GenerationFailureDiagnostic | string): ActivityDiagnostic | null {
  if (!["image.failed", "image.recoverable", "image.expired", "illustration_segment.failed", "illustration_segment.direct_fallback"].includes(kind)) return null;
  if (kind === "image.expired") return { code: "image_expired", message: ACTIVITY_DIAGNOSTIC_MESSAGES.image_expired! };
  return projectGenerationFailureDiagnostic(typeof currentFailure === "string" ? { version: 1, category: "unknown", code: currentFailure, phase: "activity", attemptNumber: 0, occurredAt: new Date().toISOString() } : currentFailure) ?? { code: "image_failed", message: ACTIVITY_DIAGNOSTIC_MESSAGES.image_failed! };
}

/** Caller must first win its fenced source mutation, using this same transaction client. */
export async function captureImageActivity(client: DatabaseClient, sourceId: string, ownerUserId: string, kind: ImageActivityKind, currentFailure?: GenerationFailureDiagnostic | string): Promise<void> {
  const source = await client.query<{ campaign_id: string | null; generation_job_id: string | null; segment_id: string | null; turn_id: string | null; status: ImageDraft["status"]; attempts: number; updated_at: Date }>(
    "SELECT campaign_id,generation_job_id,segment_id,turn_id,status,attempts,updated_at FROM image_jobs WHERE id=$1 AND owner_user_id=$2 FOR UPDATE", [sourceId, ownerUserId]);
  const row = source.rows[0];
  if (!row) throw new Error("Illustration activity source disappeared in its transaction.");
  if (!row.campaign_id) return;
  const revision = await client.query<{ revision: string }>("UPDATE image_jobs SET activity_revision=activity_revision+1 WHERE id=$1 AND owner_user_id=$2 RETURNING activity_revision::text AS revision", [sourceId, ownerUserId]);
  const draft: ImageDraft = { version: 1, eventId: randomUUID(), occurredAt: row.updated_at.toISOString(), campaignId: row.campaign_id, source: "image", kind, status: row.status,
    jobId: sourceId, generationJobId: row.generation_job_id, segmentId: row.segment_id, turnId: row.turn_id, turnNumber: null, attemptNumber: row.attempts,
    severity: kind === "image.completed" ? "success" : ["image.failed", "image.expired"].includes(kind) ? "error" : kind === "image.recoverable" ? "warning" : "info",
    diagnostic: illustrationActivityDiagnostic(kind, currentFailure) };
  await captureActivity(client, { scope: { ownerUserId, campaignId: row.campaign_id }, sourceId, revision: revision.rows[0]!.revision, draft });
}

/** Prompt and matching jobs map to their segment source; they have no independent catalog. */
export async function captureSegmentActivity(client: DatabaseClient, sourceId: string, ownerUserId: string, kind: SegmentActivityKind): Promise<void> {
  const result = await client.query<{ campaign_id: string; generation_job_id: string | null; turn_id: string | null; status: SegmentDraft["status"]; revision: string; occurred_at: Date }>(
    `UPDATE turn_illustration_segments SET activity_revision=activity_revision+1 WHERE id=$1 AND owner_user_id=$2
      RETURNING campaign_id,generation_job_id,turn_id,status,activity_revision::text AS revision,clock_timestamp() AS occurred_at`, [sourceId, ownerUserId]);
  const row = result.rows[0];
  if (!row) throw new Error("Illustration segment activity source disappeared in its transaction.");
  const draft: SegmentDraft = { version: 1, eventId: randomUUID(), occurredAt: row.occurred_at.toISOString(), campaignId: row.campaign_id, source: "illustration_segment", kind, status: row.status,
    jobId: null, generationJobId: row.generation_job_id, segmentId: sourceId, turnId: row.turn_id, turnNumber: null, attemptNumber: null,
    severity: kind === "illustration_segment.completed" ? "success" : kind === "illustration_segment.failed" ? "error" : kind === "illustration_segment.direct_fallback" ? "warning" : "info",
    diagnostic: illustrationActivityDiagnostic(kind) };
  await captureActivity(client, { scope: { ownerUserId, campaignId: row.campaign_id }, sourceId, revision: row.revision, draft });
}
