import { canonicalizeWorldCreationDraft, worldCreationSubmissionSnapshot } from "./world-creation-model";
import { parseEditableWorldDraft, type EditableWorldDraft } from "./world-editor-model";

export type WorldCreationApiErrorKind =
  | "network"
  | "unavailable"
  | "invalid_response"
  | "request_failed";

export class WorldCreationApiError extends Error {
  readonly kind: WorldCreationApiErrorKind;
  readonly status: number | null;
  readonly details: unknown;

  constructor(
    kind: WorldCreationApiErrorKind,
    message: string,
    status: number | null,
    details?: unknown
  ) {
    super(message);
    this.name = "WorldCreationApiError";
    this.kind = kind;
    this.status = status;
    this.details = details;
  }
}

export interface WorldGenerationPreviewRequest {
  title: string;
  prompt: string;
  progressKey: string;
}

export interface WorldGenerationPreviewResponse {
  title: string;
  content: EditableWorldDraft;
}

export interface WorldGenerationProgressResponse {
  status: "processing" | "completed" | "failed" | "unknown";
  phase: string;
  progressPercent: number;
  message: string;
  errorMessage?: string;
}

export interface CreatedWorldResponse {
  id: string;
  title: string;
  status: "draft";
  imageUrl: string;
  draftRevision: number;
  draftContent: EditableWorldDraft;
  draftBasedOnWorldVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreatedWorldCoverResponse {
  assetUrl: string;
}

export interface GeneratedWorldCoverResponse {
  id: string;
  worldId: string;
  targetType: "world_cover";
  status: "queued" | "generating" | "provider_pending" | "downloading" | "completed" | "recoverable" | "failed" | "cancelled" | "expired";
  duplicate: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function canonicalDraft(value: unknown): EditableWorldDraft {
  return canonicalizeWorldCreationDraft(parseEditableWorldDraft(value));
}

async function fetchJson(url: string, init: RequestInit): Promise<{ response: Response; value: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new WorldCreationApiError(
      "network",
      error instanceof Error ? error.message : "The world creation request failed.",
      null
    );
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    if (response.ok) {
      throw new WorldCreationApiError(
        "invalid_response",
        "World creation returned an unexpected response.",
        response.status
      );
    }
    value = null;
  }

  if (!response.ok) {
    const body = isRecord(value) ? value : {};
    throw new WorldCreationApiError(
      response.status === 503 ? "unavailable" : "request_failed",
      typeof body.message === "string" ? body.message : `Request failed with status ${response.status}.`,
      response.status,
      body.details
    );
  }

  return { response, value };
}

function invalidSuccessResponse(response: Response, error?: unknown): never {
  throw new WorldCreationApiError(
    "invalid_response",
    error instanceof Error ? error.message : "World creation returned an unexpected response.",
    response.status
  );
}

function parseGeneratedPreview(value: unknown): WorldGenerationPreviewResponse {
  if (!isRecord(value) || typeof value.title !== "string" || !value.title.trim()) {
    throw new Error("World generation returned an unexpected preview.");
  }
  return { title: value.title, content: canonicalDraft(value.content) };
}

function parseGenerationProgress(value: unknown): WorldGenerationProgressResponse {
  if (!isRecord(value) || typeof value.status !== "string" ||
      !["processing", "completed", "failed", "unknown"].includes(value.status) ||
      typeof value.phase !== "string" || typeof value.progressPercent !== "number" ||
      !Number.isFinite(value.progressPercent) || typeof value.message !== "string" ||
      !(value.errorMessage === undefined || typeof value.errorMessage === "string")) {
    throw new Error("World generation returned unexpected progress.");
  }
  return {
    status: value.status as WorldGenerationProgressResponse["status"],
    phase: value.phase,
    progressPercent: value.progressPercent,
    message: value.message,
    ...(typeof value.errorMessage === "string" ? { errorMessage: value.errorMessage } : {})
  };
}

function parseCreatedWorld(value: unknown): CreatedWorldResponse {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id ||
      typeof value.title !== "string" || !value.title.trim() || value.status !== "draft" ||
      typeof value.imageUrl !== "string" || !isPositiveInteger(value.draftRevision) ||
      !(value.draftBasedOnWorldVersionId === null || typeof value.draftBasedOnWorldVersionId === "string") ||
      typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    throw new Error("World creation returned an unexpected created world.");
  }
  return {
    id: value.id,
    title: value.title,
    status: "draft",
    imageUrl: value.imageUrl,
    draftRevision: value.draftRevision,
    draftContent: canonicalDraft(value.draftContent),
    draftBasedOnWorldVersionId: value.draftBasedOnWorldVersionId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function parseCoverResponse(value: unknown): CreatedWorldCoverResponse {
  if (!isRecord(value) || typeof value.assetUrl !== "string") {
    throw new Error("World creation returned an unexpected cover response.");
  }
  return { assetUrl: value.assetUrl };
}

function parseGeneratedCover(value: unknown): GeneratedWorldCoverResponse {
  const statuses = [
    "queued", "generating", "provider_pending", "downloading", "completed",
    "recoverable", "failed", "cancelled", "expired"
  ];
  if (!isRecord(value) || typeof value.id !== "string" || !value.id ||
      typeof value.worldId !== "string" || !value.worldId || value.targetType !== "world_cover" ||
      typeof value.status !== "string" || !statuses.includes(value.status) || typeof value.duplicate !== "boolean") {
    throw new Error("World creation returned an unexpected generated cover response.");
  }
  return {
    id: value.id,
    worldId: value.worldId,
    targetType: "world_cover",
    status: value.status as GeneratedWorldCoverResponse["status"],
    duplicate: value.duplicate
  };
}

export async function generateWorldPreview(
  request: WorldGenerationPreviewRequest,
  signal?: AbortSignal
): Promise<WorldGenerationPreviewResponse> {
  const { response, value } = await fetchJson("/api/v1/worlds/generate-preview", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal
  });
  try {
    return parseGeneratedPreview(value);
  } catch (error) {
    return invalidSuccessResponse(response, error);
  }
}

export async function loadWorldGenerationProgress(
  progressKey: string,
  signal?: AbortSignal
): Promise<WorldGenerationProgressResponse> {
  const { response, value } = await fetchJson(
    `/api/v1/worlds/generate-progress?key=${encodeURIComponent(progressKey)}`,
    { headers: { Accept: "application/json" }, signal }
  );
  try {
    return parseGenerationProgress(value);
  } catch (error) {
    return invalidSuccessResponse(response, error);
  }
}

export async function createWorld(
  draft: EditableWorldDraft,
  signal?: AbortSignal
): Promise<CreatedWorldResponse> {
  const content = canonicalDraft(worldCreationSubmissionSnapshot(draft));
  const { response, value } = await fetchJson("/api/v1/worlds", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ title: content.world.title, content }),
    signal
  });
  try {
    return parseCreatedWorld(value);
  } catch (error) {
    return invalidSuccessResponse(response, error);
  }
}

export async function attachCreatedWorldCover(
  worldId: string,
  assetId: string,
  signal?: AbortSignal
): Promise<CreatedWorldCoverResponse> {
  const { response, value } = await fetchJson(`/api/v1/worlds/${encodeURIComponent(worldId)}/cover-asset`, {
    method: "PUT",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ assetId }),
    signal
  });
  try {
    return parseCoverResponse(value);
  } catch (error) {
    return invalidSuccessResponse(response, error);
  }
}

export async function generateCreatedWorldCover(
  worldId: string,
  prompt: string,
  signal?: AbortSignal
): Promise<GeneratedWorldCoverResponse> {
  const { response, value } = await fetchJson(`/api/v1/worlds/${encodeURIComponent(worldId)}/cover`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
    signal
  });
  try {
    return parseGeneratedCover(value);
  } catch (error) {
    return invalidSuccessResponse(response, error);
  }
}
