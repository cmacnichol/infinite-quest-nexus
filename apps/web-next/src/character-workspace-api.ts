import { createNexusApiClient, createNoopSessionPort, NexusApiError, ApiContractError } from "@infinite-quest/client-web";
import {
  WORLD_CONTENT_SCHEMA_VERSION,
  canonicalizeWorldContent,
  type WorldContent
} from "../../../packages/contracts/src/world-library.js";
import { parseEditableWorldDraft, type EditableWorldDraft } from "./world-editor-model.js";
import { sanitizeCharacterWorkspaceValue } from "./character-workspace-sanitizer.js";
import { parseAuthoringFailure } from "./authoring-errors.js";
import type { AuthoringFailure } from "../../../packages/contracts/src/authoring.js";

import type { WorldGenerationProgressResponse } from "../../../packages/contracts/src/client-api.js";
export type { WorldGenerationProgressResponse } from "../../../packages/contracts/src/client-api.js";

export type CharacterWorkspaceApiErrorKind =
  | "network"
  | "unavailable"
  | "invalid_response"
  | "request_failed";

export class CharacterWorkspaceApiError extends Error {
  readonly kind: CharacterWorkspaceApiErrorKind;
  readonly status: number | null;
  readonly details: unknown;
  readonly authoringFailure: AuthoringFailure | null;

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
    this.authoringFailure = parseAuthoringFailure(details);
  }
}

export interface CharacterGenerationPreviewRequest {
  content: EditableWorldDraft;
  prompt: string;
  characterId?: string;
  progressKey?: string;
}

const PROHIBITED_ROOT_KEYS = new Set(["user_id", "userId", "owner_user_id", "ownerUserId"]);

function stripProhibitedRootKeys(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !PROHIBITED_ROOT_KEYS.has(key)));
}

function clone<T>(value: T): T {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as T;
}

export function sanitizeCharacterGenerationContent(draft: EditableWorldDraft): WorldContent {
  const parsed = clone(parseEditableWorldDraft(draft));
  const content = sanitizeCharacterWorkspaceValue(parsed) as Record<string, unknown>;
  content.schemaVersion = WORLD_CONTENT_SCHEMA_VERSION;
  return canonicalizeWorldContent(content);
}

function client() {
  return createNexusApiClient({ basePath: "/api/v1", session: createNoopSessionPort() });
}

function translateError(error: unknown): never {
  if (error instanceof Error && error.name === "AbortError") throw error;
  if (error instanceof NexusApiError) {
    const unavailable = error.statusCode === 503 || error.domainCode === "default_text_provider_unavailable";
    throw new CharacterWorkspaceApiError(unavailable ? "unavailable" : "request_failed", error.message, error.statusCode, error.details);
  }
  if (error instanceof ApiContractError) {
    throw new CharacterWorkspaceApiError(error.phase === "request" ? "request_failed" : "invalid_response", error.message, error.statusCode);
  }
  throw new CharacterWorkspaceApiError("network", error instanceof Error ? error.message : "The character preview request failed.", null);
}

export async function generateCharacterPreview(request: CharacterGenerationPreviewRequest, signal?: AbortSignal) {
  const content = sanitizeCharacterGenerationContent(request.content);
  try {
    const result = await client().worlds.generateCharacterPreview({
      content, prompt: request.prompt,
      ...(request.characterId === undefined ? {} : { characterId: request.characterId }),
      ...(request.progressKey === undefined ? {} : { progressKey: request.progressKey })
    }, signal);
    return { character: stripProhibitedRootKeys(result.character as Record<string, unknown>) as typeof result.character };
  } catch (error) { return translateError(error); }
}

export async function loadCharacterGenerationProgress(progressKey: string, signal?: AbortSignal): Promise<WorldGenerationProgressResponse> {
  try { return await client().worlds.loadCharacterGenerationProgress(progressKey, signal); }
  catch (error) { return translateError(error); }
}
