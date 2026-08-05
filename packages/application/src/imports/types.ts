import type { WorldImportRequest } from "@infinite-quest/contracts";
import type { OwnerScope } from "../generation/types.js";

export type ImportOwnerScope = OwnerScope;
export type CampaignArchiveScope = ImportOwnerScope & Readonly<{
  campaignId: string;
  worldId: string;
  worldVersionId: string;
}>;
export type ImportRecordScope = ImportOwnerScope & Readonly<{ importId: string }>;

/** Opaque portable provenance; it is informative only and cannot authorize a local operation. */
declare const portableSourceInstallationIdBrand: unique symbol;
export type PortableSourceInstallationId = string & Readonly<{
  [portableSourceInstallationIdBrand]: true;
}>;

/** Opaque source-record provenance, not a local foreign key or a local authority token. */
declare const portableImportedRecordIdBrand: unique symbol;
export type PortableImportedRecordId = string & Readonly<{
  [portableImportedRecordIdBrand]: true;
}>;

/** A validated handle never contains a staging path or archive filename. */
declare const portablePreviewHandleBrand: unique symbol;

/** Opaque repository-issued staged input handle. It cannot be typed as a filesystem path. */
declare const portableStagedInputBrand: unique symbol;
export type PortableStagedInput = string & Readonly<{
  [portableStagedInputBrand]: true;
}>;

/** Opaque export capability; transport can redeem it without learning a private archive path. */
declare const portableArchiveExportRetrievalBrand: unique symbol;
export type PortableArchiveExportRetrieval = string & Readonly<{
  [portableArchiveExportRetrievalBrand]: true;
}>;

export type PortableImportKind =
  | "campaign_zip"
  | "legacy_story"
  | "infinite_worlds"
  | "cyoa"
  | "world_json"
  | "world_text"
  | "story_text";
export type PortableArchiveDiagnosticCode =
  | "archive_cleanup_required"
  | "archive_containment_denied"
  | "archive_entry_limit_exceeded"
  | "archive_expired"
  | "archive_format_invalid"
  | "archive_link_denied"
  | "archive_path_invalid"
  | "archive_size_limit_exceeded"
  | "archive_truncated"
  | "archive_unavailable"
  | "import_conflict"
  | "import_idempotency_mismatch"
  | "import_invalid"
  | "transaction_unavailable";

export type CampaignZipPreviewDestination =
  | Readonly<{ kind: "embedded"; operation: "create_world" }>
  | Readonly<{ kind: "existing_world_version"; worldId: string; worldVersionId: string }>;

export type ExistingWorldVersionPreviewDestination = Readonly<{
  kind: "existing_world_version";
  worldId: string;
  worldVersionId: string;
}>;

/** Explicitly has no existing IDs: these flows always create an owner-scoped world. */
export type CreateWorldPreviewDestination = Readonly<{ kind: "create_world" }>;

export type PortablePreviewDestination =
  | CampaignZipPreviewDestination
  | ExistingWorldVersionPreviewDestination
  | CreateWorldPreviewDestination;

/** The generic destination is compile-time bound to the opaque token that was issued for its preview. */
export type PortablePreviewHandle<Destination extends PortablePreviewDestination = PortablePreviewDestination> =
  string & Readonly<{ [portablePreviewHandleBrand]: Destination }>;

type PortableImportPreviewBase<Destination extends PortablePreviewDestination> = ImportOwnerScope & Readonly<{
  stagedInput: PortableStagedInput;
  destination: Destination;
  sourceInstallationId?: PortableSourceInstallationId;
  importedRecordId?: PortableImportedRecordId;
}>;

export type PortableImportPreviewCommand =
  | (PortableImportPreviewBase<CampaignZipPreviewDestination> & Readonly<{ kind: "campaign_zip" }>)
  | (PortableImportPreviewBase<ExistingWorldVersionPreviewDestination> & Readonly<{ kind: "legacy_story" | "story_text" }>)
  | (PortableImportPreviewBase<CreateWorldPreviewDestination> & Readonly<{ kind: "infinite_worlds" | "cyoa" | "world_json" | "world_text" }>);

export type PortableImportPreviewView<Command extends PortableImportPreviewCommand = PortableImportPreviewCommand> = Readonly<{
  previewHandle: PortablePreviewHandle<Command["destination"]>;
  kind: Command["kind"];
  /** Echoed safe destination permits a commit to prove it is redeeming the same preview binding. */
  destination: Command["destination"];
  expiresAt: string;
  cleanupOwner: "application";
  diagnostics: readonly PortableArchiveDiagnosticCode[];
}>;

export type CampaignImportDestination = Readonly<{
  kind: "campaign";
  campaignId: string;
}>;

export type WorldImportDestination = Readonly<{
  kind: "world";
  worldId: string;
}>;

export type WorldVersionImportDestination = Readonly<{
  kind: "world_version";
  worldId: string;
  worldVersionId: string;
}>;

type PortableImportCommitBase = ImportOwnerScope & Readonly<{
  previewHandle: PortablePreviewHandle;
  idempotencyKey: string;
}>;

/** Each family names a local, owner-scoped destination; portable provenance never selects local records. */
export type PortableImportCommitCommand =
  | (PortableImportCommitBase & Readonly<{ kind: "legacy_story"; destination: CampaignImportDestination }>)
  | (PortableImportCommitBase & Readonly<{ kind: "campaign_zip"; destination: CampaignImportDestination }>)
  | (PortableImportCommitBase & Readonly<{ kind: "infinite_worlds"; destination: WorldImportDestination }>)
  | (PortableImportCommitBase & Readonly<{ kind: "cyoa"; destination: WorldVersionImportDestination }>);

export type PortableImportCommitView = Readonly<{
  importedRecordId: PortableImportedRecordId;
  duplicate: boolean;
  diagnostics: readonly PortableArchiveDiagnosticCode[];
}>;

export type PortablePreviewCleanupCommand = ImportOwnerScope & Readonly<{
  previewHandle: PortablePreviewHandle;
}>;

/** Opaque caller-owned database context; preview/commit adapters must use it rather than open another transaction. */
export type ImportTransactionContext = object;

/** Safe download projection; adapter-private staging/final paths and errors are intentionally absent. */
export type PortableArchiveExportView = Readonly<{
  retrieval: PortableArchiveExportRetrieval;
  contentType: "application/zip" | "application/json";
  byteLength: number;
}>;

export type PortableArchiveDownloadView = Readonly<{
  content: Uint8Array;
  contentType: PortableArchiveExportView["contentType"];
}>;

export type WorldJsonExportCommand = ImportOwnerScope & Readonly<{
  worldId: string;
  worldVersionId?: string;
}>;

export type WorldJsonPreviewCommand = ImportOwnerScope & Readonly<{
  request: WorldImportRequest;
  destination: CreateWorldPreviewDestination;
}>;

export type WorldJsonCommitCommand = ImportOwnerScope & Readonly<{
  request: WorldImportRequest;
  idempotencyKey: string;
}>;

function opaque(value: string, errorCode: string): string {
  if (value.trim().length === 0) throw new Error(errorCode);
  return value;
}

export function toPortableSourceInstallationId(value: string): PortableSourceInstallationId {
  return opaque(value, "portable_source_installation_id_invalid") as PortableSourceInstallationId;
}

export function toPortableImportedRecordId(value: string): PortableImportedRecordId {
  return opaque(value, "portable_imported_record_id_invalid") as PortableImportedRecordId;
}

export function toPortablePreviewHandle<Destination extends PortablePreviewDestination = PortablePreviewDestination>(
  value: string,
  _destination?: Destination,
): PortablePreviewHandle<Destination> {
  return opaque(value, "portable_preview_handle_invalid") as PortablePreviewHandle<Destination>;
}

export function toPortableStagedInput(value: string): PortableStagedInput {
  return opaque(value, "portable_staged_input_invalid") as PortableStagedInput;
}

export function toPortableArchiveExportRetrieval(value: string): PortableArchiveExportRetrieval {
  return opaque(value, "portable_archive_export_retrieval_invalid") as PortableArchiveExportRetrieval;
}
