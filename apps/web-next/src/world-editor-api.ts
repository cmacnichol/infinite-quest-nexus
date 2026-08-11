import {
  parseWorldAggregate,
  type EditableWorldDraft,
  type WorldAggregate
} from "./world-editor-model";

export type WorldEditorApiErrorKind =
  | "conflict"
  | "not_found"
  | "invalid_response"
  | "network"
  | "request_failed";

export class WorldEditorApiError extends Error {
  readonly kind: WorldEditorApiErrorKind;
  readonly status: number | null;
  readonly details: unknown;

  constructor(
    kind: WorldEditorApiErrorKind,
    message: string,
    status: number | null,
    details?: unknown
  ) {
    super(message);
    this.name = "WorldEditorApiError";
    this.kind = kind;
    this.status = status;
    this.details = details;
  }
}

export interface WorldDraftSaveResponse {
  worldId: string;
  title: string;
  revision: number;
  content: EditableWorldDraft;
  updatedAt: string;
}

export interface WorldCoverAssetResponse {
  assetUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function isEditableWorldDraft(value: unknown): value is EditableWorldDraft {
  if (!isRecord(value) || !isPositiveInteger(value.schemaVersion) || !isRecord(value.world) ||
      !isRecord(value.defaults)) {
    return false;
  }
  const world = value.world;
  const overviewFields = ["title", "genre", "tone", "premise", "backgroundStory", "firstAction", "rules"];
  const collectionFields = [
    "playableCharacters",
    "entities",
    "relationships",
    "rpgStats",
    "defaultTriggers",
    "eventTriggers",
    "assets"
  ];
  return overviewFields.every((field) => typeof world[field] === "string") &&
    collectionFields.every((field) => Array.isArray(value[field]));
}

function parseDraftSaveResponse(value: unknown): WorldDraftSaveResponse {
  if (!isRecord(value) || typeof value.worldId !== "string" || typeof value.title !== "string" ||
      !isPositiveInteger(value.revision) || !isEditableWorldDraft(value.content) ||
      typeof value.updatedAt !== "string") {
    throw new Error("The World Editor returned an unexpected draft response.");
  }
  return {
    worldId: value.worldId,
    title: value.title,
    revision: value.revision,
    content: value.content,
    updatedAt: value.updatedAt
  };
}

function parseCoverAssetResponse(value: unknown): WorldCoverAssetResponse {
  if (!isRecord(value) || typeof value.assetUrl !== "string") {
    throw new Error("The World Editor returned an unexpected cover response.");
  }
  return { assetUrl: value.assetUrl };
}

async function fetchJson(url: string, init: RequestInit): Promise<{ response: Response; value: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new WorldEditorApiError(
      "network",
      error instanceof Error ? error.message : "The World Editor request failed.",
      null
    );
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    if (response.ok) {
      throw new WorldEditorApiError(
        "invalid_response",
        "The World Editor returned an unexpected response.",
        response.status
      );
    }
    value = null;
  }

  if (!response.ok) {
    const body = isRecord(value) ? value : {};
    const kind: WorldEditorApiErrorKind = response.status === 409
      ? "conflict"
      : response.status === 404
        ? "not_found"
        : "request_failed";
    throw new WorldEditorApiError(
      kind,
      typeof body.message === "string" ? body.message : `Request failed with status ${response.status}.`,
      response.status,
      body.details
    );
  }

  return { response, value };
}

function invalidSuccessResponse(response: Response, error: unknown): never {
  throw new WorldEditorApiError(
    "invalid_response",
    error instanceof Error ? error.message : "The World Editor returned an unexpected response.",
    response.status
  );
}

export async function loadWorld(worldId: string, signal?: AbortSignal): Promise<WorldAggregate> {
  const { response, value } = await fetchJson(`/api/v1/worlds/${encodeURIComponent(worldId)}`, {
    headers: { Accept: "application/json" },
    signal
  });
  try {
    return parseWorldAggregate(value);
  } catch (error) {
    return invalidSuccessResponse(response, error);
  }
}

export async function saveWorldDraft(
  worldId: string,
  expectedRevision: number,
  draft: EditableWorldDraft,
  signal?: AbortSignal
): Promise<WorldDraftSaveResponse> {
  const { response, value } = await fetchJson(`/api/v1/worlds/${encodeURIComponent(worldId)}/draft`, {
    method: "PUT",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision, title: draft.world.title, content: draft }),
    signal
  });
  try {
    return parseDraftSaveResponse(value);
  } catch (error) {
    return invalidSuccessResponse(response, error);
  }
}

export async function setWorldCoverAsset(
  worldId: string,
  assetId: string | null,
  signal?: AbortSignal
): Promise<WorldCoverAssetResponse> {
  const { response, value } = await fetchJson(`/api/v1/worlds/${encodeURIComponent(worldId)}/cover-asset`, {
    method: "PUT",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ assetId }),
    signal
  });
  try {
    return parseCoverAssetResponse(value);
  } catch (error) {
    return invalidSuccessResponse(response, error);
  }
}
