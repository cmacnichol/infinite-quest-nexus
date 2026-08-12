import {
  WORLD_CONTENT_SCHEMA_VERSION,
  canonicalizeWorldContent,
  playableCharacterGenerationPreviewResponseSchema,
  playableCharacterSchema
} from "../../../packages/contracts/src/world-library.js";
import { parseEditableWorldDraft, type EditableWorldDraft } from "./world-editor-model.js";

export interface WorldGenerationProgressResponse {
  status: "processing" | "completed" | "failed" | "unknown";
  phase: string;
  progressPercent: number;
  message: string;
  errorMessage?: string;
}

export type CharacterWorkspaceApiErrorKind =
  | "network"
  | "unavailable"
  | "invalid_response"
  | "request_failed";

export class CharacterWorkspaceApiError extends Error {
  readonly kind: CharacterWorkspaceApiErrorKind;
  readonly status: number | null;
  readonly details: unknown;

  constructor(
    kind: CharacterWorkspaceApiErrorKind,
    message: string,
    status: number | null,
    details?: unknown
  ) {
    super(message);
    this.name = "CharacterWorkspaceApiError";
    this.kind = kind;
    this.status = status;
    this.details = details;
  }
}

export interface CharacterGenerationPreviewRequest {
  content: EditableWorldDraft;
  prompt: string;
  characterId?: string;
  progressKey: string;
}

const PROHIBITED_ROOT_KEYS = new Set(["user_id", "userId", "owner_user_id", "ownerUserId"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripProhibitedRootKeys(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !PROHIBITED_ROOT_KEYS.has(key)));
}

function clone<T>(value: T): T {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as T;
}

export function sanitizeCharacterGenerationContent(draft: EditableWorldDraft): EditableWorldDraft {
  const parsed = clone(parseEditableWorldDraft(draft));
  const content = stripProhibitedRootKeys(parsed);
  content.schemaVersion = WORLD_CONTENT_SCHEMA_VERSION;
  content.world = stripProhibitedRootKeys(parsed.world);
  content.playableCharacters = parsed.playableCharacters.map((character) => (
    isRecord(character) ? stripProhibitedRootKeys(character) : character
  ));
  return parseEditableWorldDraft(canonicalizeWorldContent(content));
}

async function fetchJson(url: string, init: RequestInit): Promise<{ response: Response; value: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new CharacterWorkspaceApiError(
      "network",
      error instanceof Error ? error.message : "The character preview request failed.",
      null
    );
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    if (response.ok) {
      throw new CharacterWorkspaceApiError(
        "invalid_response",
        "Character preview returned an unexpected response.",
        response.status
      );
    }
    value = null;
  }

  if (!response.ok) {
    const body = isRecord(value) ? value : {};
    const details = body.details;
    const unavailable = response.status === 503 || (
      isRecord(details) && details.code === "default_text_provider_unavailable"
    );
    throw new CharacterWorkspaceApiError(
      unavailable ? "unavailable" : "request_failed",
      typeof body.message === "string" ? body.message : `Request failed with status ${response.status}.`,
      response.status,
      details
    );
  }

  return { response, value };
}

function invalidSuccessResponse(response: Response, error?: unknown): never {
  throw new CharacterWorkspaceApiError(
    "invalid_response",
    error instanceof Error ? error.message : "Character preview returned an unexpected response.",
    response.status
  );
}

function parsePreview(value: unknown) {
  const parsed = playableCharacterGenerationPreviewResponseSchema.parse(value);
  const character = stripProhibitedRootKeys(clone(parsed.character) as Record<string, unknown>);
  return { character: playableCharacterSchema.parse(character) };
}

function parseProgress(value: unknown): WorldGenerationProgressResponse {
  if (!isRecord(value) || Object.keys(value).some((key) => ![
    "status", "phase", "progressPercent", "message", "errorMessage"
  ].includes(key)) || typeof value.status !== "string" ||
      !["processing", "completed", "failed", "unknown"].includes(value.status) ||
      typeof value.phase !== "string" || typeof value.progressPercent !== "number" ||
      !Number.isFinite(value.progressPercent) || value.progressPercent < 0 || value.progressPercent > 100 ||
      typeof value.message !== "string" ||
      !(value.errorMessage === undefined || typeof value.errorMessage === "string")) {
    throw new Error("Character generation returned unexpected progress.");
  }
  return {
    status: value.status as WorldGenerationProgressResponse["status"],
    phase: value.phase,
    progressPercent: value.progressPercent,
    message: value.message,
    ...(typeof value.errorMessage === "string" ? { errorMessage: value.errorMessage } : {})
  };
}

export async function generateCharacterPreview(
  request: CharacterGenerationPreviewRequest,
  signal?: AbortSignal
) {
  const body = {
    content: sanitizeCharacterGenerationContent(request.content),
    prompt: request.prompt,
    ...(request.characterId === undefined ? {} : { characterId: request.characterId }),
    progressKey: request.progressKey
  };
  const { response, value } = await fetchJson("/api/v1/worlds/playable-characters/generate-preview", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal
  } as RequestInit);
  try {
    return parsePreview(value);
  } catch (error) {
    return invalidSuccessResponse(response, error);
  }
}

export async function loadCharacterGenerationProgress(
  progressKey: string,
  signal?: AbortSignal
): Promise<WorldGenerationProgressResponse> {
  const { response, value } = await fetchJson(
    `/api/v1/worlds/generate-progress?key=${encodeURIComponent(progressKey)}`,
    { headers: { Accept: "application/json" }, signal } as RequestInit
  );
  try {
    return parseProgress(value);
  } catch (error) {
    return invalidSuccessResponse(response, error);
  }
}
