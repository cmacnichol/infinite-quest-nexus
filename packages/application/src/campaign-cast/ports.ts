import type { ReviewCastDetail, ReviewCastDetailResult } from "@infinite-quest/contracts";
import type { CastScope, CastBoundary, CastSnapshot, CastBatch, CastBatchReceipt } from "./types.js";
import type { CreateCastCharacter, EditCastCharacter, CastWriteResult, CastDetail, CastDiscoveryStatus,
  CastCandidateList, CastCandidateQuery, ResolveCastCandidate, CastCandidateResolution } from "@infinite-quest/contracts";

export interface CampaignCastWritePort {
  promotionPreview?(scope: CastScope, id: string, worldId: string): Promise<import("@infinite-quest/contracts").CastPromotionPreview>;
  promote?(scope: CastScope, id: string, request: import("@infinite-quest/contracts").CastPromote): Promise<import("@infinite-quest/contracts").CastPromoteResult>;
  unmergePreview?(scope: CastScope, targetId: string, mergeEventId: string): Promise<{ target: import("@infinite-quest/contracts").CastCharacter; source: import("@infinite-quest/contracts").CastCharacter; revision: number; boundary: CastBoundary; expectedCharacterRevision: number; expectedSourceCharacterRevision: number }>;
  mergePreview?(scope: CastScope, targetId: string, sourceId: string): Promise<import("@infinite-quest/contracts").CastMergePreview>;
  merge?(scope: CastScope, targetId: string, request: import("@infinite-quest/contracts").CastMergeRequest): Promise<CastWriteResult>;
  unmerge?(scope: CastScope, targetId: string, request: import("@infinite-quest/contracts").CastUnmergeRequest): Promise<CastWriteResult>;
  changeRemoval?(scope: CastScope, id: string, action: "remove" | "restore", request: import("@infinite-quest/contracts").CastLifecycleChange): Promise<CastWriteResult>;
  draftPreviewContext?(scope: CastScope, id: string, input: import("@infinite-quest/contracts").CastDraftPreviewRequest): Promise<{ character: import("@infinite-quest/contracts").CastCharacter; boundary: CastBoundary; evidence: import("@infinite-quest/contracts").CastDraftPreviewResponse["evidence"]; observedPaths: string[]; textProviderProfileId: string | null; worldContent: unknown }>;
  worldChoices?(scope: CastScope): Promise<import("@infinite-quest/contracts").CastWorldChoices>;
  fromWorldPreview?(scope: CastScope, input: import("@infinite-quest/contracts").CastFromWorldPreviewQuery): Promise<import("@infinite-quest/contracts").CastFromWorldPreview>;
  fromWorld?(scope: CastScope, input: import("@infinite-quest/contracts").CastFromWorld): Promise<CastWriteResult>;
  editAuthoredProfile?(scope: CastScope, id: string, input: import("@infinite-quest/contracts").EditAuthoredCastProfile): Promise<CastWriteResult>;
  workspaceRead?(scope: CastScope, statusOnly?: boolean): Promise<{ snapshot: CastSnapshot; reviewIds: string[]; conflictIds: string[]; attentionCounts?: Record<string, { review: number; conflict: number }>; status: import("@infinite-quest/contracts").CharactersWorkspaceStatus }>;
  detachAttachment(scope: CastScope, characterId: string, eventId: string, request: import("@infinite-quest/contracts").DetachCastAttachment): Promise<import("@infinite-quest/contracts").DetachCastAttachmentResult>;
  resolveDetail?(scope: CastScope, id: string, request: ReviewCastDetail): Promise<ReviewCastDetailResult>;
  candidates(scope: CastScope, query: Partial<CastCandidateQuery>): Promise<CastCandidateList>;
  resolveCandidate(scope: CastScope, id: string, request: ResolveCastCandidate): Promise<CastCandidateResolution>;
  discoveryStatus(scope: CastScope): Promise<CastDiscoveryStatus>;
  create(scope: CastScope, request: CreateCastCharacter): Promise<CastWriteResult>;
  edit(scope: CastScope, id: string, request: EditCastCharacter): Promise<CastWriteResult>;
  current(scope: CastScope): Promise<CastSnapshot>;
  detail(scope: CastScope, id: string): Promise<CastDetail>;
}

export class CampaignCastError extends Error {
  constructor(readonly code: "cast_lifecycle_disabled" | "cast_character_removed" | "cast_character_merged" | "cast_not_found" | "cast_revision_conflict" | "cast_promotion_conflict" | "cast_generation_active"
    | "cast_idempotency_conflict" | "cast_invalid_request" | "cast_editing_disabled" | "cast_protagonist_read_only"
    | "cast_merge_invalid" | "cast_not_seeded" | "cast_invalid_field_class" | "cast_fixed_field_override" | "cast_world_character_unavailable"
    | "cast_presets_disabled" | "cast_world_preview_changed" | "cast_discovery_disabled" | "cast_discovery_admission_required" | "cast_discovery_unavailable" | "cast_draft_evidence_changed", readonly fields: { path: string; code: string }[] = []) {
    super(code.replaceAll("_", " "));
  }
}

export interface CampaignCastReadPort {
  loadSnapshot(scope: CastScope, boundary: CastBoundary): Promise<CastSnapshot>;
}

/** Internal foundation port. Callers must not expose writes before phase 02 gates. */
export interface CampaignCastRepositoryPort extends CampaignCastReadPort {
  initialize(scope: CastScope): Promise<CastSnapshot>;
  applyBatch(scope: CastScope, batch: CastBatch): Promise<CastBatchReceipt>;
  rebuild(scope: CastScope): Promise<CastSnapshot>;
}
