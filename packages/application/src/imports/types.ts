import type {
  CampaignArchivePreviewResponse,
  CyoaImportPreviewResult,
  StoryImportResult,
  WorldImportRequest
} from "@infinite-quest/contracts";
import type { OwnerScope } from "../generation/types.js";
import type { WorldImportPreviewView, WorldImportResultView } from "../world-campaign/types.js";

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
declare const portablePreviewTokenBrand: unique symbol;

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

/** Owner-scoped durable result capability; it contains no path or transport state. */
declare const portableImportResultRetrievalBrand: unique symbol;
declare const portableImportResultKindBrand: unique symbol;
export type PortableImportResultRetrieval<Kind extends PortableImportKind = PortableImportKind> = string & Readonly<{
  [portableImportResultRetrievalBrand]: true;
  [portableImportResultKindBrand]: (kind: Kind) => Kind;
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

/**
 * The opaque token and its safe destination binding are inseparable. The
 * destination parameter prevents a preview handle from being redeemed for a
 * different family or target, while the token itself remains opaque.
 */
export type PortablePreviewHandle<Destination extends PortablePreviewDestination> = Readonly<{
  token: string & Readonly<{ [portablePreviewTokenBrand]: true }>;
  destination: Destination;
  [portablePreviewHandleBrand]: (destination: Destination) => Destination;
}>;

type PortableImportPreviewBase<Destination extends PortablePreviewDestination> = ImportOwnerScope & Readonly<{
  stagedInput: PortableStagedInput;
  destination: Destination;
  sourceInstallationId?: PortableSourceInstallationId;
  importedRecordId?: PortableImportedRecordId;
}>;

export type PortableImportPreviewCommand =
  | (PortableImportPreviewBase<Extract<CampaignZipPreviewDestination, { kind: "embedded" }>> & Readonly<{ kind: "campaign_zip" }>)
  | (PortableImportPreviewBase<ExistingWorldVersionPreviewDestination> & Readonly<{ kind: "campaign_zip" }>)
  | (PortableImportPreviewBase<ExistingWorldVersionPreviewDestination> & Readonly<{ kind: "legacy_story" }>)
  | (PortableImportPreviewBase<ExistingWorldVersionPreviewDestination> & Readonly<{ kind: "story_text" }>)
  | (PortableImportPreviewBase<CreateWorldPreviewDestination> & Readonly<{ kind: "infinite_worlds" }>)
  | (PortableImportPreviewBase<CreateWorldPreviewDestination> & Readonly<{ kind: "cyoa" }>)
  | (PortableImportPreviewBase<CreateWorldPreviewDestination> & Readonly<{ kind: "world_json" }>)
  | (PortableImportPreviewBase<CreateWorldPreviewDestination> & Readonly<{ kind: "world_text" }>);

/** Reuses the live route schema while replacing its raw token with our opaque handle. */
export type CampaignZipPreviewProjection = Readonly<
  Omit<CampaignArchivePreviewResponse, "previewToken" | "expiresAt">
>;

export type LegacyStoryPreviewProjection = Readonly<{
  kind: "campaign";
  title: string;
  duplicate: boolean;
  existingCampaignId: string | null;
  valid: boolean;
  counts: Readonly<{
    turns: number;
    completeHistoryCharacters: number;
    estimatedHistoryTokens: number;
  }>;
  warnings: readonly string[];
}>;

export type InfiniteWorldsJsonPreviewProjection = Readonly<Omit<WorldImportPreviewView, "kind"> & {
  kind: "world_json";
  valid: boolean;
  characters: readonly Readonly<{ index: number; name: string }>[];
}>;

export type CyoaPreviewProjection = Readonly<CyoaImportPreviewResult>;

export type WorldTextPreviewProjection = Readonly<{
  kind: "world_text";
  valid: boolean;
  requiresProvider: true;
  warnings: readonly string[];
  counts: Readonly<{ sourceCharacters: number; sourceWords: number }>;
}>;

export type StoryTextPreviewProjection = Readonly<{
  kind: "story_text";
  title: string;
  duplicate: boolean;
  existingCampaignId: string | null;
  targetWorldId: string;
  diagnostics: readonly string[];
  characters: readonly Readonly<{ id: string; name: string }>[];
  selectedCharacterId: string | null;
  valid: boolean;
  counts: LegacyStoryPreviewProjection["counts"];
  warnings: readonly string[];
}>;

export type PortableImportPreviewProjectionFor<Kind extends PortableImportKind> =
  Kind extends "campaign_zip" ? CampaignZipPreviewProjection
    : Kind extends "legacy_story" ? LegacyStoryPreviewProjection
      : Kind extends "infinite_worlds" | "world_json" ? InfiniteWorldsJsonPreviewProjection
        : Kind extends "cyoa" ? CyoaPreviewProjection
          : Kind extends "world_text" ? WorldTextPreviewProjection
            : Kind extends "story_text" ? StoryTextPreviewProjection
              : never;

export type PortableImportPreviewView<Command extends PortableImportPreviewCommand = PortableImportPreviewCommand> = Readonly<{
  previewHandle: PortablePreviewHandle<Command["destination"]>;
  kind: Command["kind"];
  /** Echoed safe destination permits a commit to prove it is redeeming the same preview binding. */
  destination: Command["destination"];
  expiresAt: string;
  cleanupOwner: "application";
  diagnostics: readonly PortableArchiveDiagnosticCode[];
  projection: PortableImportPreviewProjectionFor<Command["kind"]>;
}>;

type PortableImportCommitBase<Preview extends PortableImportPreviewCommand> = ImportOwnerScope & Readonly<{
  kind: Preview["kind"];
  destination: Preview["destination"];
  previewHandle: PortablePreviewHandle<Preview["destination"]>;
  idempotencyKey: string;
}>;

/** A commit can redeem only the exact destination-bearing handle issued by its preview. */
export type PortableImportCommitCommandFor<Preview extends PortableImportPreviewCommand> =
  Preview extends PortableImportPreviewCommand ? PortableImportCommitBase<Preview> : never;

export type PortableImportCommitCommand<Preview extends PortableImportPreviewCommand = PortableImportPreviewCommand> =
  PortableImportCommitCommandFor<Preview>;

export type CampaignArchiveImportResultProjection = Readonly<{
  importId: string;
  worldId: string;
  worldVersionId: string;
  campaignId: string;
  duplicate: boolean;
  stats: Readonly<{
    turnCount: number;
    memoryCount: number;
    summaryCount: number;
    assetCount: number;
    assetBytes: number;
  }>;
}>;

export type LegacyStoryImportResultProjection = Readonly<StoryImportResult>;

export type PortableWorldImportResultProjection = WorldImportResultView & Readonly<{
  kind: "world";
}>;

export type PortableStoryImportResultProjection = LegacyStoryImportResultProjection & Readonly<{
  kind: "campaign";
}>;

export type PortableImportResultProjectionFor<Kind extends PortableImportKind> =
  Kind extends "campaign_zip" ? CampaignArchiveImportResultProjection
    : Kind extends "legacy_story" ? LegacyStoryImportResultProjection
      : Kind extends "story_text" ? PortableStoryImportResultProjection
        : Kind extends "infinite_worlds" | "cyoa" | "world_json" | "world_text" ? PortableWorldImportResultProjection
          : never;

export type PortableImportCommitView<Kind extends PortableImportKind = PortableImportKind> = Readonly<{
  importedRecordId: PortableImportedRecordId;
  retrieval: PortableImportResultRetrieval<Kind>;
  kind: Kind;
  duplicate: boolean;
  diagnostics: readonly PortableArchiveDiagnosticCode[];
  result: PortableImportResultProjectionFor<Kind>;
}>;

export type PortableImportResultView<Kind extends PortableImportKind = PortableImportKind> = Readonly<{
  kind: Kind;
  result: PortableImportResultProjectionFor<Kind>;
  diagnostics: readonly PortableArchiveDiagnosticCode[];
}>;

export type PortablePreviewCleanupCommand<Destination extends PortablePreviewDestination> = ImportOwnerScope & Readonly<{
  previewHandle: PortablePreviewHandle<Destination>;
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

export function toPortablePreviewHandle<Destination extends PortablePreviewDestination>(
  value: string,
  destination: Destination,
): PortablePreviewHandle<Destination> {
  return {
    token: opaque(value, "portable_preview_handle_invalid") as PortablePreviewHandle<Destination>["token"],
    destination
  } as PortablePreviewHandle<Destination>;
}

export function toPortableStagedInput(value: string): PortableStagedInput {
  return opaque(value, "portable_staged_input_invalid") as PortableStagedInput;
}

export function toPortableArchiveExportRetrieval(value: string): PortableArchiveExportRetrieval {
  return opaque(value, "portable_archive_export_retrieval_invalid") as PortableArchiveExportRetrieval;
}

export function toPortableImportResultRetrieval<Kind extends PortableImportKind = PortableImportKind>(
  value: string,
): PortableImportResultRetrieval<Kind> {
  return opaque(value, "portable_import_result_retrieval_invalid") as PortableImportResultRetrieval<Kind>;
}
