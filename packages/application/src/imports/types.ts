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
export type PortablePreviewHandle = string & Readonly<{
  [portablePreviewHandleBrand]: true;
}>;

export type PortableImportKind = "campaign_zip" | "legacy_story" | "infinite_worlds" | "cyoa";
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

export type PortableImportPreviewCommand = ImportOwnerScope & Readonly<{
  kind: PortableImportKind;
  sourceInstallationId?: PortableSourceInstallationId;
  importedRecordId?: PortableImportedRecordId;
}>;

export type PortableImportPreviewView = Readonly<{
  previewHandle: PortablePreviewHandle;
  kind: PortableImportKind;
  expiresAt: string;
  cleanupOwner: "application";
  diagnostics: readonly PortableArchiveDiagnosticCode[];
}>;

export type PortableImportCommitCommand = ImportOwnerScope & Readonly<{
  campaignId: string;
  previewHandle: PortablePreviewHandle;
  idempotencyKey: string;
}>;

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
  archiveId: string;
  contentType: "application/zip" | "application/json";
  byteLength: number;
}>;

export type WorldJsonExportCommand = ImportOwnerScope & Readonly<{
  worldId: string;
  worldVersionId?: string;
}>;

export type WorldJsonPreviewCommand = ImportOwnerScope & Readonly<{
  request: WorldImportRequest;
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

export function toPortablePreviewHandle(value: string): PortablePreviewHandle {
  return opaque(value, "portable_preview_handle_invalid") as PortablePreviewHandle;
}
