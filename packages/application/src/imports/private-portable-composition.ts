import type { PrivateBoundedStreamSession } from "../assets/private-secure-storage.js";
import type {
  PrivateAssetPublicationCommand,
  PrivateAssetPublicationFinalization,
  PrivateAssetPublicationIdentity,
  PrivateAssetPublicationResult
} from "../assets/private-asset-publication.js";
import type {
  ImportOwnerScope,
  PortableArchiveDiagnosticCode,
  PortableArchiveExportRetrieval,
  PortableArchiveExportView,
  PortableImportCommitCommand,
  PortableImportCommitView,
  PortableImportKind,
  PortableImportPreviewCommand,
  PortableImportPreviewView,
  PortablePreviewDestination,
  PortableStagedInput
} from "./types.js";
import type { ArchiveAssetRecord } from "@infinite-quest/contracts";

export const PORTABLE_IMPORT_FAMILIES = Object.freeze([
  "campaign_zip",
  "legacy_story",
  "infinite_worlds",
  "cyoa",
  "world_json",
  "world_text",
  "story_text"
] as const satisfies readonly PortableImportKind[]);

export type PortableJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly PortableJsonValue[]
  | Readonly<{ [key: string]: PortableJsonValue }>;

export type PortableCanonicalImportAuthority = Readonly<{
  kind: PortableImportKind;
  destination: PortablePreviewDestination;
  normalizedPayload: Readonly<{ [key: string]: PortableJsonValue }>;
  sourceInstallationId: string | null;
  sourceRecordId: string | null;
  selectedCharacterId: string | null;
  providerConfigurationFingerprint: string | null;
}>;

/** Opaque caller-owned transaction; only the database adapter may interpret it. */
export type PrivatePortableTransactionContext = object;

function canonicalJson(value: PortableJsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson((value as Readonly<Record<string, PortableJsonValue>>)[key]!)}`
  )).join(",")}}`;
}

/** Exact replay preimage; hashing remains the responsibility of a private runtime/repository adapter. */
export function canonicalPortableImportAuthority(value: PortableCanonicalImportAuthority): string {
  return canonicalJson(value as unknown as PortableJsonValue);
}

export function canonicalPortableAssetReservationCommand(value: Readonly<{
  operationId: string;
  ownerUserId: string;
  kind: "campaign_zip" | "legacy_story";
  authorityFingerprint: string;
  commitIdempotencyKeyHash: string;
}>): string {
  return canonicalJson(value as unknown as PortableJsonValue);
}

export type PortableImportProgressPhase =
  | "staged"
  | "decoding"
  | "previewed"
  | "claiming"
  | "mutating"
  | "publishing_assets"
  | "committing"
  | "finalizing"
  | "completed";

export type PortableImportProgressStatus =
  | "running"
  | "recoverable"
  | "aborted"
  | "completed"
  | "expired";

export type PrivatePortableImportProgressRecord = Readonly<{
  operationId: string;
  ownerUserId: string;
  phase: PortableImportProgressPhase;
  percentage: number;
  diagnosticCode: PortableArchiveDiagnosticCode | null;
  workVersion: number;
  status: PortableImportProgressStatus;
  leaseOwner: string | null;
  leaseId: string | null;
  leaseExpiresAt: string | null;
  updatedAt: string;
}>;

export type PortableImportProgressView = Readonly<Pick<
  PrivatePortableImportProgressRecord,
  "phase" | "percentage" | "diagnosticCode" | "workVersion" | "status" | "updatedAt"
>>;

export function safePortableImportProgress(record: PrivatePortableImportProgressRecord): PortableImportProgressView {
  if (!Number.isInteger(record.percentage)
    || record.percentage < 0
    || record.percentage > 100
    || !Number.isInteger(record.workVersion)
    || record.workVersion < 1
    || !Number.isFinite(Date.parse(record.updatedAt))) {
    throw new Error("portable_import_progress_invalid");
  }
  return Object.freeze({
    phase: record.phase,
    percentage: record.percentage,
    diagnosticCode: record.diagnosticCode,
    workVersion: record.workVersion,
    status: record.status,
    updatedAt: record.updatedAt
  });
}

export type PrivatePortableImportWorkClaim = Readonly<{
  operationId: string;
  ownerUserId: string;
  workVersion: number;
  leaseId: string;
  leaseOwner: string;
  leaseExpiresAt: string;
}>;

export interface PrivatePortableImportAuthorityPort {
  readPreviewAuthority(input: Readonly<{
    command: PortableImportCommitCommand;
  }>): Promise<Readonly<{
    operationId: string;
    authority: PortableCanonicalImportAuthority;
    authorityFingerprint: string;
  }> | null>;
  persistPreviewAuthority<Command extends PortableImportPreviewCommand>(input: Readonly<{
    command: Command;
    authority: PortableCanonicalImportAuthority;
    authorityFingerprint: string;
    projection: PortableImportPreviewView<Command>["projection"];
    diagnostics: readonly PortableArchiveDiagnosticCode[];
    expiresAt: string;
  }>): Promise<PortableImportPreviewView<Command>>;
  claimPreviewAuthority(database: PrivatePortableTransactionContext, input: Readonly<{
    command: PortableImportCommitCommand;
    leaseOwner: string;
    leaseSeconds: number;
  }>): Promise<Readonly<{
    outcome: "ready";
    authority: PortableCanonicalImportAuthority;
    claim: PrivatePortableImportWorkClaim;
    commitClaim: unknown;
  }> | Readonly<{ outcome: "replay"; view: PortableImportCommitView }>>;
  updateProgress(database: PrivatePortableTransactionContext, claim: PrivatePortableImportWorkClaim, input: Readonly<{
    phase: PortableImportProgressPhase;
    percentage: number;
    diagnosticCode: PortableArchiveDiagnosticCode | null;
  }>): Promise<PrivatePortableImportWorkClaim>;
  lockAssetReservationIntentAuthority(database: PrivatePortableTransactionContext, input: Readonly<{
    operationId: string;
    owner: ImportOwnerScope;
    authorityFingerprint: string;
  }>): Promise<void>;
  recordAssetReservationIntents(database: PrivatePortableTransactionContext, input: Readonly<{
    operationId: string;
    owner: ImportOwnerScope;
    authorityFingerprint: string;
    commitIdempotencyKeyHash: string;
    commandFingerprint: string;
    assetIds: readonly string[];
  }>): Promise<void>;
  releaseAssetReservationIntents(database: PrivatePortableTransactionContext, input: Readonly<{
    operationId: string;
    owner: ImportOwnerScope;
    assetIds: readonly string[];
  }>): Promise<void>;
  recordAssetPublications(
    database: PrivatePortableTransactionContext,
    claim: PrivatePortableImportWorkClaim,
    importId: string,
    assetIds: readonly string[],
  ): Promise<void>;
  readCommittedAssetPublicationIds(
    owner: ImportOwnerScope,
    previewToken: string,
  ): Promise<readonly string[]>;
  completeProgress(database: PrivatePortableTransactionContext, claim: PrivatePortableImportWorkClaim): Promise<void>;
  readProgress(owner: ImportOwnerScope, previewToken: string): Promise<PortableImportProgressView | null>;
  abort(owner: ImportOwnerScope, previewToken: string): Promise<PortableImportProgressView | null>;
}

export type PrivateImportedAssetAttachment = Readonly<{
  identity: PrivateAssetPublicationIdentity;
  result: PrivateAssetPublicationResult;
  finalization: readonly PrivateAssetPublicationFinalization[];
  rollback(): Promise<void>;
}>;

export type PrivateReservedImportedAsset = Readonly<{
  command: PrivateAssetPublicationCommand;
  identity: PrivateAssetPublicationIdentity;
}>;

export interface PrivateCallerTransactionAssetPublisher {
  reserveImportedAssets(
    commands: readonly PrivateAssetPublicationCommand[],
  ): Promise<readonly PrivateReservedImportedAsset[]>;
  reserveImportedAssetsInTransaction(
    database: PrivatePortableTransactionContext,
    commands: readonly PrivateAssetPublicationCommand[],
  ): Promise<readonly PrivateReservedImportedAsset[]>;
  attachImportedAssets(
    database: PrivatePortableTransactionContext,
    reservations: readonly PrivateReservedImportedAsset[],
  ): Promise<readonly PrivateImportedAssetAttachment[]>;
  discardPreparedImportedAssets(
    database: PrivatePortableTransactionContext,
    reservations: readonly PrivateReservedImportedAsset[],
  ): Promise<void>;
  recoverImportedAssets(
    owner: ImportOwnerScope,
    assetIds: readonly string[],
    recovery: Readonly<{ leaseOwner: string; leaseSeconds: number }>,
  ): Promise<void>;
  finalizeImportedAssets(attachments: readonly PrivateImportedAssetAttachment[]): Promise<void>;
}

export type PrivatePortableFamilyMutationResult = Readonly<{
  importId: string;
  importedRecordId: string;
  worldId: string;
  worldVersionId: string;
  campaignId: string | null;
  duplicate: boolean;
  result: Readonly<Record<string, PortableJsonValue>>;
}>;

export type PrivatePortableAssetInventoryItem = Readonly<{
  sourceAssetIds: readonly string[];
  sourceKeys?: readonly string[];
  records: readonly ArchiveAssetRecord[];
  artifact: PrivateAssetPublicationCommand["original"];
}>;

export type PrivatePortableSourceAssetRecord = Readonly<Omit<ArchiveAssetRecord, "archivePath">>;

export type PrivatePortablePublishedAsset = Readonly<{
  sourceAssetIds: readonly string[];
  sourceKeys?: readonly string[];
  records: readonly PrivatePortableSourceAssetRecord[];
  result: PrivateAssetPublicationResult;
}>;

export type PrivateLegacyStoryCompanionAsset = Readonly<{
  sourceKey: string;
  artifact: PrivateAssetPublicationCommand["original"];
}>;

/** Private binary inputs already validated by the unbound transport/test seam. */
export type PrivatePortableImportArtifacts = Readonly<{
  legacyStoryCompanions?: readonly PrivateLegacyStoryCompanionAsset[];
}>;

/** Named caller-client authority. No loose callback can substitute for domain persistence. */
export interface PrivatePortableFamilyMutationPort {
  findCampaignDuplicate(database: PrivatePortableTransactionContext, input: Readonly<{
    owner: ImportOwnerScope;
    kind: "campaign_zip" | "legacy_story" | "story_text";
    authorityFingerprint: string;
  }>): Promise<PrivatePortableFamilyMutationResult | null>;
  commitCampaignZip(database: PrivatePortableTransactionContext, input: Readonly<{
    owner: ImportOwnerScope;
    destination: PortablePreviewDestination;
    authorityFingerprint: string;
    payload: Readonly<Record<string, PortableJsonValue>>;
    publishedAssets: readonly (PrivatePortablePublishedAsset | PrivateAssetPublicationResult)[];
  }>): Promise<PrivatePortableFamilyMutationResult>;
  commitLegacyStory(database: PrivatePortableTransactionContext, input: Readonly<{
    owner: ImportOwnerScope;
    destination: PortablePreviewDestination;
    authorityFingerprint: string;
    payload: Readonly<Record<string, PortableJsonValue>>;
    publishedAssets?: readonly PrivatePortablePublishedAsset[];
  }>): Promise<PrivatePortableFamilyMutationResult>;
  commitWorld(database: PrivatePortableTransactionContext, input: Readonly<{
    owner: ImportOwnerScope;
    kind: "infinite_worlds" | "cyoa" | "world_json" | "world_text";
    authorityFingerprint: string;
    payload: Readonly<Record<string, PortableJsonValue>>;
  }>): Promise<PrivatePortableFamilyMutationResult>;
  commitStoryText(database: PrivatePortableTransactionContext, input: Readonly<{
    owner: ImportOwnerScope;
    destination: PortablePreviewDestination;
    authorityFingerprint: string;
    payload: Readonly<Record<string, PortableJsonValue>>;
  }>): Promise<PrivatePortableFamilyMutationResult>;
}

export interface PrivatePortableFamilyPreviewPort {
  extractCampaignZipAssets(
    bytes: AsyncIterable<Uint8Array>,
    authority: PortableCanonicalImportAuthority,
  ): Promise<readonly PrivatePortableAssetInventoryItem[]>;
  extractLegacyStoryAssets(
    bytes: AsyncIterable<Uint8Array>,
    authority: PortableCanonicalImportAuthority,
    companions?: readonly PrivateLegacyStoryCompanionAsset[],
  ): Promise<readonly PrivatePortableAssetInventoryItem[]>;
  previewCampaignZip(bytes: AsyncIterable<Uint8Array>, command: Extract<PortableImportPreviewCommand, { kind: "campaign_zip" }>): Promise<Readonly<{ authority: PortableCanonicalImportAuthority; projection: PortableImportPreviewView["projection"] }>>;
  previewLegacyStory(bytes: AsyncIterable<Uint8Array>, command: Extract<PortableImportPreviewCommand, { kind: "legacy_story" }>, companions?: readonly PrivateLegacyStoryCompanionAsset[]): Promise<Readonly<{ authority: PortableCanonicalImportAuthority; projection: PortableImportPreviewView["projection"] }>>;
  previewInfiniteWorlds(bytes: AsyncIterable<Uint8Array>, command: Extract<PortableImportPreviewCommand, { kind: "infinite_worlds" }>): Promise<Readonly<{ authority: PortableCanonicalImportAuthority; projection: PortableImportPreviewView["projection"] }>>;
  previewCyoa(bytes: AsyncIterable<Uint8Array>, command: Extract<PortableImportPreviewCommand, { kind: "cyoa" }>): Promise<Readonly<{ authority: PortableCanonicalImportAuthority; projection: PortableImportPreviewView["projection"] }>>;
  previewWorldJson(bytes: AsyncIterable<Uint8Array>, command: Extract<PortableImportPreviewCommand, { kind: "world_json" }>): Promise<Readonly<{ authority: PortableCanonicalImportAuthority; projection: PortableImportPreviewView["projection"] }>>;
  previewWorldText(bytes: AsyncIterable<Uint8Array>, command: Extract<PortableImportPreviewCommand, { kind: "world_text" }>): Promise<Readonly<{ authority: PortableCanonicalImportAuthority; projection: PortableImportPreviewView["projection"] }>>;
  previewStoryText(bytes: AsyncIterable<Uint8Array>, command: Extract<PortableImportPreviewCommand, { kind: "story_text" }>): Promise<Readonly<{ authority: PortableCanonicalImportAuthority; projection: PortableImportPreviewView["projection"] }>>;
}

export type PortableExportSessionCommand = Readonly<{
  owner: ImportOwnerScope;
  exportKind: "campaign_zip" | "world_json";
  campaignId: string | null;
  worldId: string;
  worldVersionId: string;
  retrieval: PortableArchiveExportRetrieval;
}>;

export type PrivatePortableExportArtifact = Readonly<{
  exportScope: Readonly<{
    ownerUserId: string;
    exportKind: "campaign_zip" | "world_json";
    campaignId: string | null;
    worldId: string;
    worldVersionId: string;
  }>;
  contentType: "application/zip" | "application/json";
  byteLength: number;
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
}>;

/** Named export authority; implementations must owner-scope reads and bound output. */
export interface PrivatePortableExportBuilderPort {
  buildCampaignArchive(input: Readonly<{
    owner: ImportOwnerScope;
    campaignId: string;
  }>): Promise<PrivatePortableExportArtifact>;
  buildWorldJson(input: Readonly<{
    owner: ImportOwnerScope;
    worldId: string;
    worldVersionId: string;
  }>): Promise<PrivatePortableExportArtifact>;
}

/** Additive private graph. It is deliberately not exported from the public imports barrel. */
export interface PortableImportExportComposition {
  stageInput: (input: Readonly<{
    owner: ImportOwnerScope;
    operationScopeId: string;
    leaseOwner: string;
    expiresAt: string;
    byteLength: number;
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  }>) => Promise<Readonly<{ stagedInput: PortableStagedInput }>>;
  previewCampaignZip<Command extends Extract<PortableImportPreviewCommand, { kind: "campaign_zip" }>>(
    command: Command,
  ): Promise<PortableImportPreviewView<Command>>;
  previewLegacyStory(command: Extract<PortableImportPreviewCommand, { kind: "legacy_story" }>, artifacts?: PrivatePortableImportArtifacts): Promise<PortableImportPreviewView<Extract<PortableImportPreviewCommand, { kind: "legacy_story" }>>>;
  previewInfiniteWorlds(command: Extract<PortableImportPreviewCommand, { kind: "infinite_worlds" }>): Promise<PortableImportPreviewView<Extract<PortableImportPreviewCommand, { kind: "infinite_worlds" }>>>;
  previewCyoa(command: Extract<PortableImportPreviewCommand, { kind: "cyoa" }>): Promise<PortableImportPreviewView<Extract<PortableImportPreviewCommand, { kind: "cyoa" }>>>;
  previewWorldJson(command: Extract<PortableImportPreviewCommand, { kind: "world_json" }>): Promise<PortableImportPreviewView<Extract<PortableImportPreviewCommand, { kind: "world_json" }>>>;
  previewWorldText(command: Extract<PortableImportPreviewCommand, { kind: "world_text" }>): Promise<PortableImportPreviewView<Extract<PortableImportPreviewCommand, { kind: "world_text" }>>>;
  previewStoryText(command: Extract<PortableImportPreviewCommand, { kind: "story_text" }>): Promise<PortableImportPreviewView<Extract<PortableImportPreviewCommand, { kind: "story_text" }>>>;
  commit(command: PortableImportCommitCommand, artifacts?: PrivatePortableImportArtifacts): Promise<PortableImportCommitView>;
  createCampaignExport(input: Readonly<{ owner: ImportOwnerScope; campaignId: string }>): Promise<PortableArchiveExportView>;
  createWorldExport(input: Readonly<{ owner: ImportOwnerScope; worldId: string; worldVersionId: string }>): Promise<PortableArchiveExportView>;
  openExportSession(command: PortableExportSessionCommand): Promise<PrivateBoundedStreamSession>;
  progress(owner: ImportOwnerScope, previewToken: string): Promise<PortableImportProgressView | null>;
  abort(owner: ImportOwnerScope, previewToken: string): Promise<PortableImportProgressView | null>;
  reap(input: Readonly<{ leaseOwner: string; leaseSeconds: number; limit: number }>): Promise<Readonly<{ claimed: number; cleaned: number; pending: number }>>;
  close(): Promise<void>;
}
