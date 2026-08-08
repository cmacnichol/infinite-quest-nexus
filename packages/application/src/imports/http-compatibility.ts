import type {
  CampaignArchivePreviewResponse,
  ImportProgressReport,
  ImportProgressNotFoundResponse
} from "@infinite-quest/contracts";
import {
  importProgressQuerySchema,
  importProgressResponseSchema
} from "@infinite-quest/contracts";
import type {
  CampaignZipPreviewDestination,
  CampaignArchiveScope,
  ImportOwnerScope,
  PortableImportCommitView,
  PortableImportKind,
  PortableImportPreviewProjectionByKind,
  PortablePreviewDestination,
  PortablePreviewHandle,
  WorldJsonExportCommand
} from "./types.js";

declare const portableImportIdempotencyKeyBrand: unique symbol;
declare const serverStableReplayKeyBrand: unique symbol;

export type PortableImportIdempotencyKey = string & Readonly<{
  [portableImportIdempotencyKeyBrand]: true;
}>;

/**
 * A compatibility replay key is created by trusted server code from the
 * validated request and server-resolved owner/scope. It is idempotency input,
 * never authorization and never portable source provenance.
 */
export type ServerStableReplayKey = string & Readonly<{
  [serverStableReplayKeyBrand]: true;
}>;

export const PORTABLE_IMPORT_IDEMPOTENCY_HEADER = "idempotency-key" as const;

export type PortableImportCommitIngressRequest<Destination extends PortablePreviewDestination = PortablePreviewDestination> = Readonly<{
  owner: ImportOwnerScope;
  kind: PortableImportKind;
  destination: Destination;
  serverStableReplayKey: ServerStableReplayKey;
  idempotencyHeader?: string;
  previewHandle?: PortablePreviewHandle<Destination>;
}>;

export type PortableImportCommitIngress<Destination extends PortablePreviewDestination = PortablePreviewDestination> = Readonly<{
  owner: ImportOwnerScope;
  kind: PortableImportKind;
  destination: Destination;
  idempotency:
    | Readonly<{ source: "idempotency_header"; key: PortableImportIdempotencyKey }>
    | Readonly<{ source: "server_stable_compatibility"; key: PortableImportIdempotencyKey }>;
  choreography:
    | Readonly<{
      kind: "durable_preview";
      previewHandle: PortablePreviewHandle<Destination>;
    }>
    | Readonly<{
      kind: "atomic_repreview";
      transactionBoundary: "preview_and_commit";
      replayKey: ServerStableReplayKey;
    }>;
}>;

export type ImportProgressLookup = Readonly<{
  owner: ImportOwnerScope;
  key: string;
  disposition: "owner_scoped_bounded_status";
  authority: "none";
}>;

export type ImportProgressHttpResult =
  | Readonly<{ statusCode: 200; body: ImportProgressReport }>
  | Readonly<{ statusCode: 404; body: ImportProgressNotFoundResponse }>;

function requireOwner(owner: ImportOwnerScope): void {
  if (owner.ownerUserId.trim().length === 0) throw new Error("owner_scope_required");
}

function validateReplayKey(value: string, errorCode: string): string {
  if (value.length < 1 || value.length > 200 || !/^[!-~]+$/u.test(value)) {
    throw new Error(errorCode);
  }
  return value;
}

export function toPortableImportIdempotencyKey(value: string): PortableImportIdempotencyKey {
  return validateReplayKey(value, "portable_import_idempotency_key_invalid") as PortableImportIdempotencyKey;
}

export function toServerStableReplayKey(value: string): ServerStableReplayKey {
  return validateReplayKey(value, "server_stable_replay_key_invalid") as ServerStableReplayKey;
}

function requireResourceIds(values: readonly string[], errorCode: string): void {
  if (values.some((value) => value.trim().length === 0)) throw new Error(errorCode);
}

export function bindCampaignArchiveExportScope(
  owner: ImportOwnerScope,
  resource: Readonly<{ campaignId: string; worldId: string; worldVersionId: string }>,
): CampaignArchiveScope {
  requireOwner(owner);
  requireResourceIds(
    [resource.campaignId, resource.worldId, resource.worldVersionId],
    "portable_export_scope_invalid",
  );
  return { ...owner, ...resource };
}

export function bindWorldJsonExportScope(
  owner: ImportOwnerScope,
  resource: Readonly<{ worldId: string; worldVersionId?: string }>,
): WorldJsonExportCommand {
  requireOwner(owner);
  requireResourceIds(
    [resource.worldId, ...(resource.worldVersionId === undefined ? [] : [resource.worldVersionId])],
    "portable_export_scope_invalid",
  );
  return { ...owner, ...resource };
}

function isExistingDestination(
  destination: PortablePreviewDestination,
): destination is Extract<PortablePreviewDestination, { kind: "existing_world_version" }> {
  return destination.kind === "existing_world_version"
    && destination.worldId.trim().length > 0
    && destination.worldVersionId.trim().length > 0;
}

function isCreateWorldDestination(
  destination: PortablePreviewDestination,
): destination is Extract<PortablePreviewDestination, { kind: "create_world" }> {
  return destination.kind === "create_world";
}

function isEmbeddedCampaignDestination(
  destination: PortablePreviewDestination,
): destination is Extract<CampaignZipPreviewDestination, { kind: "embedded" }> {
  return destination.kind === "embedded" && destination.operation === "create_world";
}

function destinationMatches(
  left: PortablePreviewDestination,
  right: PortablePreviewDestination,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "existing_world_version" && right.kind === "existing_world_version") {
    return left.worldId === right.worldId && left.worldVersionId === right.worldVersionId;
  }
  return left.kind !== "embedded"
    || (right.kind === "embedded" && left.operation === right.operation);
}

function requireKindDestination(kind: PortableImportKind, destination: PortablePreviewDestination): void {
  if (kind === "campaign_zip") {
    if (isEmbeddedCampaignDestination(destination) || isExistingDestination(destination)) return;
    throw new Error("portable_import_scope_invalid");
  }
  if (kind === "legacy_story" || kind === "story_text") {
    if (isExistingDestination(destination)) return;
    throw new Error("portable_import_scope_invalid");
  }
  if (isCreateWorldDestination(destination)) return;
  throw new Error("portable_import_scope_invalid");
}

/**
 * Freezes the source-compatible commit bridge. Campaign ZIP already carries a
 * server-issued durable handle. Existing handle-less bodies are staged,
 * re-previewed, and committed within one caller-owned transaction using a
 * server-stable replay key. Neither replay key can grant authority.
 */
export function bindPortableImportCommitIngress<Destination extends PortablePreviewDestination>(
  request: PortableImportCommitIngressRequest<Destination>,
): PortableImportCommitIngress<Destination>;
export function bindPortableImportCommitIngress<Destination extends PortablePreviewDestination>(
  request: PortableImportCommitIngressRequest<Destination>,
): PortableImportCommitIngress<Destination> {
  requireOwner(request.owner);
  requireKindDestination(request.kind, request.destination);
  const compatibilityKey = toPortableImportIdempotencyKey(request.serverStableReplayKey);
  const idempotency = request.idempotencyHeader === undefined
    ? { source: "server_stable_compatibility" as const, key: compatibilityKey }
    : { source: "idempotency_header" as const, key: toPortableImportIdempotencyKey(request.idempotencyHeader) };

  if (request.kind === "campaign_zip") {
    if (request.previewHandle === undefined) throw new Error("portable_preview_handle_required");
    if (!destinationMatches(request.destination, request.previewHandle.destination)) {
      throw new Error("portable_preview_destination_mismatch");
    }
    return {
      owner: request.owner,
      kind: request.kind,
      destination: request.destination,
      idempotency,
      choreography: {
        kind: "durable_preview",
        previewHandle: request.previewHandle
      }
    };
  }

  if (request.previewHandle !== undefined) throw new Error("portable_preview_handle_unexpected");
  return {
    owner: request.owner,
    kind: request.kind,
    destination: request.destination,
    idempotency,
    choreography: {
      kind: "atomic_repreview",
      transactionBoundary: "preview_and_commit",
      replayKey: request.serverStableReplayKey
    }
  };
}

export function mapCampaignArchivePreviewHttpResult(
  view: Readonly<{
    projection: PortableImportPreviewProjectionByKind["campaign_zip"];
    previewHandle: Readonly<{ token: string }>;
    expiresAt: string;
  }>,
): CampaignArchivePreviewResponse {
  return {
    ...view.projection,
    previewToken: view.previewHandle.token,
    expiresAt: view.expiresAt
  };
}

export function mapHandlelessPortablePreviewHttpResult<Projection>(
  view: Readonly<{ projection: Projection }>,
): Projection {
  return view.projection;
}

export function mapPortableImportCommitHttpResult<Kind extends PortableImportKind>(
  view: PortableImportCommitView<Kind>,
): Readonly<{ statusCode: 200 | 201; body: PortableImportCommitView<Kind>["result"] }> {
  return {
    statusCode: view.duplicate ? 200 : 201,
    body: view.result
  };
}

export function bindImportProgressLookup(owner: ImportOwnerScope, key: string): ImportProgressLookup {
  requireOwner(owner);
  const parsed = importProgressQuerySchema.parse({ key });
  return {
    owner,
    key: parsed.key,
    disposition: "owner_scoped_bounded_status",
    authority: "none"
  };
}

export function parseImportProgressProjection(value: unknown): ImportProgressReport {
  return importProgressResponseSchema.parse(value);
}

export function mapImportProgressHttpResult(
  value: ImportProgressReport | null,
): ImportProgressHttpResult {
  if (value === null) {
    return {
      statusCode: 404,
      body: { error: "No active import found for the provided key." }
    };
  }
  return { statusCode: 200, body: parseImportProgressProjection(value) };
}
