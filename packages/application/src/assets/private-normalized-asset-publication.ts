import type { AssetMutationIdempotencyKey, AssetOwnerScope } from "./types.js";
import type { DurableFilesystemTransactionContext } from "./private-storage-lifecycle.js";

export type PrivateNormalizedAssetMimeType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";
export type PrivateNormalizedAssetFormat = "png" | "jpeg" | "webp" | "gif";

export type PrivateVerifiedAssetTechnicalMetadata = Readonly<{
  state: "verified";
  pixelWidth: number;
  pixelHeight: number;
  format: PrivateNormalizedAssetFormat;
  pages: number;
  orientation: number | null;
}>;

/** Existing rows may remain readable without pretending missing decoder evidence was verified. */
export type PrivateLegacyIncompleteAssetTechnicalMetadata = Readonly<{
  state: "legacy_incomplete";
  pixelWidth: number | null;
  pixelHeight: number | null;
  format: PrivateNormalizedAssetFormat | null;
  pages: number | null;
  orientation: number | null;
}>;

export type PrivateCanonicalAssetTechnicalMetadata =
  | PrivateVerifiedAssetTechnicalMetadata
  | PrivateLegacyIncompleteAssetTechnicalMetadata;

export type PrivateNormalizedAssetArtifactInput = Readonly<{
  bytes: Uint8Array;
  mimeType: PrivateNormalizedAssetMimeType;
  byteLength: number;
  contentHash: string;
  technicalMetadata: Readonly<Omit<PrivateVerifiedAssetTechnicalMetadata, "orientation"> & {
    orientation?: number | null;
  }>;
}>;

export type PrivateNormalizedAssetArtifact = Readonly<{
  bytes: Uint8Array;
  mimeType: PrivateNormalizedAssetMimeType;
  byteLength: number;
  contentHash: string;
  technicalMetadata: PrivateVerifiedAssetTechnicalMetadata;
}>;

export type PrivateNormalizedDerivativeSlot = Readonly<{
  derivativeKind: "thumbnail";
  transformVersion: number;
  pixelWidth: number;
  pixelHeight: number;
}>;

export type PrivateNormalizedAssetDerivativeInput = Readonly<{
  slot: PrivateNormalizedDerivativeSlot;
  artifact: PrivateNormalizedAssetArtifactInput;
}>;

export type PrivateNormalizedAssetDerivative = Readonly<{
  slot: PrivateNormalizedDerivativeSlot;
  artifact: PrivateNormalizedAssetArtifact;
}>;

export type PrivateRequestedAssetLibrarySnapshotInput = Readonly<{
  title: string;
  caption: string;
  notes: string;
  tags: readonly string[];
  origin: "generated" | "imported" | "uploaded";
  reviewStatus: "unreviewed" | "eligible" | "restricted" | "blocked";
  reuseScope: "private" | "campaign" | "world" | "owner_library" | "shared";
  automaticReuseEnabled: boolean;
  contentCategories: readonly string[];
  favorite: boolean;
  archivedAt?: string | null;
}>;

export type PrivateRequestedAssetLibrarySnapshot = Readonly<
  Omit<PrivateRequestedAssetLibrarySnapshotInput, "archivedAt"> & { archivedAt: string | null }
>;

export type PrivateAssetPublicationSourceKind = "campaign_zip" | "legacy_story";

export type PrivateAssetPublicationSourceRecordInput = Readonly<{
  sourceKind: PrivateAssetPublicationSourceKind;
  sourceAssetId: string;
  sourceRecordId?: string | null;
  sourceKey?: string | null;
  requestedLibrary: PrivateRequestedAssetLibrarySnapshotInput;
  bindingIntentKeys: readonly string[];
}>;

export type PrivateAssetPublicationSourceRecord = Readonly<{
  sourceKind: PrivateAssetPublicationSourceKind;
  sourceAssetId: string;
  sourceRecordId: string | null;
  sourceKey: string | null;
  requestedLibrary: PrivateRequestedAssetLibrarySnapshot;
  bindingIntentKeys: readonly string[];
}>;

export type PrivateIllustrationAssetProvenanceInput = Readonly<{
  kind: "illustration";
  imageJobId: string;
  variantIndex: number;
  fictionPromptIdentity: string;
  providerProfileId: string;
  providerType: string;
  model: string;
  parameters: Readonly<{
    size: string;
    aspectRatio: string;
    quality: string;
    outputFormat: string;
  }>;
}>;

export type PrivateImportAssetProvenanceInput = Readonly<{
  kind: "import";
  importKind: PrivateAssetPublicationSourceKind;
  importOperationId: string;
  importId?: string | null;
  sourceInstallationId?: string | null;
}>;

export type PrivateUploadAssetProvenanceInput = Readonly<{
  kind: "upload";
  uploadId?: string | null;
}>;

export type PrivateNormalizedAssetPublicationProvenanceInput =
  | PrivateIllustrationAssetProvenanceInput
  | PrivateImportAssetProvenanceInput
  | PrivateUploadAssetProvenanceInput;

export type PrivateNormalizedAssetPublicationProvenance =
  | PrivateIllustrationAssetProvenanceInput
  | Readonly<Omit<PrivateImportAssetProvenanceInput, "importId" | "sourceInstallationId"> & {
    importId: string | null;
    sourceInstallationId: string | null;
  }>
  | Readonly<{ kind: "upload"; uploadId: string | null }>;

export type PrivateAssetPublicationContextIntentInput = Readonly<{
  intentKey: string;
  sourceContextId?: string | null;
  targetType: "world_cover" | "turn_illustration" | "streaming_illustration" | "other";
  variantIndex: number;
  worldId?: string | null;
  worldVersionId?: string | null;
  campaignId?: string | null;
  turnId?: string | null;
  fictionPromptIdentity?: string | null;
}>;

export type PrivateAssetPublicationContextIntent = Readonly<{
  intentKey: string;
  sourceContextId: string | null;
  targetType: PrivateAssetPublicationContextIntentInput["targetType"];
  variantIndex: number;
  worldId: string | null;
  worldVersionId: string | null;
  campaignId: string | null;
  turnId: string | null;
  fictionPromptIdentity: string | null;
}>;

export type PrivateAssetPublicationReferenceIntentInput = Readonly<{
  intentKey: string;
  assetRole: "turn_illustration" | "world_asset" | "import_attachment";
  sourceCampaignId?: string | null;
  sourceTurnId?: string | null;
  campaignId?: string | null;
  turnId?: string | null;
}>;

export type PrivateAssetPublicationReferenceIntent = Readonly<{
  intentKey: string;
  assetRole: PrivateAssetPublicationReferenceIntentInput["assetRole"];
  sourceCampaignId: string | null;
  sourceTurnId: string | null;
  campaignId: string | null;
  turnId: string | null;
}>;

export type PrivateAssetPublicationReferencePolicyInput =
  | Readonly<{ mode: "omit" }>
  | Readonly<{ mode: "attach"; intents: readonly PrivateAssetPublicationReferenceIntentInput[] }>;

export type PrivateAssetPublicationReferencePolicy =
  | Readonly<{ mode: "omit"; intents: readonly [] }>
  | Readonly<{ mode: "attach"; intents: readonly PrivateAssetPublicationReferenceIntent[] }>;

export type PrivateNormalizedAssetPublicationRequestInput = Readonly<{
  owner: AssetOwnerScope;
  idempotencyKey: AssetMutationIdempotencyKey;
  original: PrivateNormalizedAssetArtifactInput;
  derivatives: readonly PrivateNormalizedAssetDerivativeInput[];
  requestedLibrary: PrivateRequestedAssetLibrarySnapshotInput;
  sourceRecords: readonly PrivateAssetPublicationSourceRecordInput[];
  provenance: PrivateNormalizedAssetPublicationProvenanceInput;
  contextIntents: readonly PrivateAssetPublicationContextIntentInput[];
  referencePolicy: PrivateAssetPublicationReferencePolicyInput;
}>;

export type PrivateCanonicalLibraryInitialization = Readonly<{
  sourceAssetId: string | null;
  sourceRecordId: string | null;
  library: PrivateRequestedAssetLibrarySnapshot;
}>;

/** Request-owned intent is separate from both the canonical asset and 0060 publication result. */
export type PrivateNormalizedAssetPublicationRequest = Readonly<{
  owner: AssetOwnerScope;
  idempotencyKey: AssetMutationIdempotencyKey;
  original: PrivateNormalizedAssetArtifact;
  derivatives: readonly PrivateNormalizedAssetDerivative[];
  requestedLibrary: PrivateRequestedAssetLibrarySnapshot;
  sourceRecords: readonly PrivateAssetPublicationSourceRecord[];
  canonicalLibraryInitialization: PrivateCanonicalLibraryInitialization;
  provenance: PrivateNormalizedAssetPublicationProvenance;
  contextIntents: readonly PrivateAssetPublicationContextIntent[];
  referencePolicy: PrivateAssetPublicationReferencePolicy;
}>;

export type SafeNormalizedAssetPublicationResult = Readonly<{
  assetId: string;
  mimeType: PrivateNormalizedAssetMimeType;
  byteLength: number;
  contentHash: string;
  pixelWidth: number;
  pixelHeight: number;
  derivatives: readonly Readonly<{
    derivativeId: string;
    derivativeKind: "thumbnail";
    transformVersion: number;
    pixelWidth: number;
    pixelHeight: number;
  }>[];
}>;

export type PrivateNormalizedAssetRequestCoreAttachment = Readonly<{
  requestId: string;
  ownerUserId: string;
  assetId: string;
  requestFingerprint: string;
}>;

export type PrivateNormalizedAssetRequestChildBindingsInput = Readonly<{
  contexts: readonly Readonly<{ intentKey: string; contextId: string }>[];
  references: readonly Readonly<{ intentKey: string; referenceId: string }>[];
}>;

/** Private, caller-transaction attachment input; its result is safe but not public until finalization. */
export type PrivateNormalizedAssetRequestAttachmentInput = PrivateNormalizedAssetRequestChildBindingsInput & Readonly<{
  result: SafeNormalizedAssetPublicationResult;
}>;

export type PrivateNormalizedAssetRequestChildBindings = PrivateNormalizedAssetRequestCoreAttachment & Readonly<{
  contexts: readonly Readonly<{ intentKey: string; contextId: string }>[];
  references: readonly Readonly<{ intentKey: string; referenceId: string }>[];
}>;

declare const privateNormalizedAssetReservationHandleBrand: unique symbol;
declare const privateNormalizedAssetFinalizationHandleBrand: unique symbol;

/** Opaque pre-transaction authority. Runtime adapters retain all identifiers and filesystem evidence. */
export type PrivateNormalizedAssetReservationHandle = Readonly<{
  [privateNormalizedAssetReservationHandleBrand]: true;
}>;

/** Opaque post-commit locator. It exposes no owner, path, storage bearer, or mutable library authority. */
export type PrivateNormalizedAssetFinalizationHandle = string & Readonly<{
  [privateNormalizedAssetFinalizationHandleBrand]: true;
}>;

export type PrivateNormalizedAssetReservationCommand = Readonly<{
  request: PrivateNormalizedAssetPublicationRequest;
  leaseOwner: string;
  expiresAt: string;
}>;

export type PrivateNormalizedAssetFinalizationOutcome =
  | Readonly<{
    outcome: "published";
    result: SafeNormalizedAssetPublicationResult;
  }>
  | Readonly<{
    outcome: "recoverable";
    diagnostic: "asset_publication_finalization_recoverable";
  }>;

/**
 * Private normalized publication seam. The caller owns the parent transaction;
 * the port never exposes its concrete database context or filesystem authority.
 */
export interface PrivateNormalizedAssetPublicationPort {
  reserve(command: PrivateNormalizedAssetReservationCommand): Promise<PrivateNormalizedAssetReservationHandle>;
  attachInTransaction(
    database: DurableFilesystemTransactionContext,
    reservation: PrivateNormalizedAssetReservationHandle,
    attachChildren: (
      result: SafeNormalizedAssetPublicationResult,
    ) => Promise<PrivateNormalizedAssetRequestChildBindingsInput>,
  ): Promise<Readonly<{
    result: SafeNormalizedAssetPublicationResult;
    finalization: PrivateNormalizedAssetFinalizationHandle;
  }>>;
  discardAfterRollback(reservation: PrivateNormalizedAssetReservationHandle): Promise<void>;
  finalize(
    finalization: PrivateNormalizedAssetFinalizationHandle,
    recovery?: Readonly<{ leaseOwner: string; leaseSeconds: number }>,
  ): Promise<PrivateNormalizedAssetFinalizationOutcome>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((child) => stableStringify(child)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(record[key])}`
  )).join(",")}}`;
}

function validBoundedString(value: unknown, maximum: number, nullable = false): boolean {
  return (nullable && value === null)
    || (typeof value === "string" && value.length > 0 && value.length <= maximum);
}

function assertExactKeys(value: object, allowed: readonly string[], errorCode: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(errorCode);
}

function snapshotStringSet(
  values: readonly string[],
  maximumItems: number,
  maximumLength: number,
  normalizeCase: boolean,
): readonly string[] {
  if (!Array.isArray(values) || values.length > maximumItems
    || values.some((value) => typeof value !== "string" || value.trim().length === 0 || value.trim().length > maximumLength)) {
    throw new Error("asset_publication_library_invalid");
  }
  return Object.freeze([...new Set(values.map((value) => (
    normalizeCase ? value.trim().toLowerCase() : value.trim()
  )))].sort());
}

function snapshotLibrary(value: PrivateRequestedAssetLibrarySnapshotInput): PrivateRequestedAssetLibrarySnapshot {
  if (typeof value.title !== "string" || value.title.length > 300
    || typeof value.caption !== "string" || value.caption.length > 2_000
    || typeof value.notes !== "string" || value.notes.length > 10_000
    || !["generated", "imported", "uploaded"].includes(value.origin)
    || !["unreviewed", "eligible", "restricted", "blocked"].includes(value.reviewStatus)
    || !["private", "campaign", "world", "owner_library", "shared"].includes(value.reuseScope)
    || typeof value.automaticReuseEnabled !== "boolean"
    || typeof value.favorite !== "boolean"
    || (value.archivedAt !== undefined && value.archivedAt !== null && !Number.isFinite(Date.parse(value.archivedAt)))) {
    throw new Error("asset_publication_library_invalid");
  }
  return Object.freeze({
    title: value.title,
    caption: value.caption,
    notes: value.notes,
    tags: snapshotStringSet(value.tags, 100, 100, true),
    origin: value.origin,
    reviewStatus: value.reviewStatus,
    reuseScope: value.reuseScope,
    automaticReuseEnabled: value.automaticReuseEnabled,
    contentCategories: snapshotStringSet(value.contentCategories, 100, 100, false),
    favorite: value.favorite,
    archivedAt: value.archivedAt ?? null
  });
}

function validDimension(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function snapshotPrivateCanonicalAssetTechnicalMetadata(
  value: PrivateCanonicalAssetTechnicalMetadata,
): PrivateCanonicalAssetTechnicalMetadata {
  if (value.state === "verified") {
    if (!validDimension(value.pixelWidth) || !validDimension(value.pixelHeight)
      || !["png", "jpeg", "webp", "gif"].includes(value.format)
      || !validDimension(value.pages)
      || (value.orientation !== null
        && (!Number.isSafeInteger(value.orientation) || value.orientation < 1 || value.orientation > 8))) {
      throw new Error("asset_publication_technical_metadata_invalid");
    }
    return Object.freeze({ ...value });
  }
  if (value.state !== "legacy_incomplete"
    || (value.pixelWidth !== null && !validDimension(value.pixelWidth))
    || (value.pixelHeight !== null && !validDimension(value.pixelHeight))
    || (value.format !== null && !["png", "jpeg", "webp", "gif"].includes(value.format))
    || (value.pages !== null && !validDimension(value.pages))
    || (value.orientation !== null
      && (!Number.isSafeInteger(value.orientation) || value.orientation < 1 || value.orientation > 8))) {
    throw new Error("asset_publication_technical_metadata_invalid");
  }
  if (value.pixelWidth !== null && value.pixelHeight !== null && value.format !== null && value.pages !== null) {
    throw new Error("asset_publication_technical_metadata_invalid");
  }
  return Object.freeze({ ...value });
}

function snapshotArtifact(value: PrivateNormalizedAssetArtifactInput): PrivateNormalizedAssetArtifact {
  const technicalMetadata = snapshotPrivateCanonicalAssetTechnicalMetadata({
    ...value.technicalMetadata,
    orientation: value.technicalMetadata.orientation ?? null
  });
  if (technicalMetadata.state !== "verified"
    || !Object.hasOwn({ "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp", "image/gif": "gif" }, value.mimeType)
    || value.byteLength !== value.bytes.byteLength
    || !Number.isSafeInteger(value.byteLength)
    || value.byteLength < 0
    || !HASH_PATTERN.test(value.contentHash)
    || ({ "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp", "image/gif": "gif" } as const)[value.mimeType] !== technicalMetadata.format) {
    throw new Error("asset_publication_artifact_invalid");
  }
  return Object.freeze({
    bytes: new Uint8Array(value.bytes),
    mimeType: value.mimeType,
    byteLength: value.byteLength,
    contentHash: value.contentHash,
    technicalMetadata
  });
}

function snapshotSlot(value: PrivateNormalizedDerivativeSlot): PrivateNormalizedDerivativeSlot {
  if (value.derivativeKind !== "thumbnail"
    || !validDimension(value.transformVersion)
    || !validDimension(value.pixelWidth)
    || !validDimension(value.pixelHeight)) {
    throw new Error("asset_publication_derivative_slot_invalid");
  }
  return Object.freeze({ ...value });
}

function snapshotProvenance(
  value: PrivateNormalizedAssetPublicationProvenanceInput,
): PrivateNormalizedAssetPublicationProvenance {
  if (value.kind === "illustration") {
    assertExactKeys(value, ["kind", "imageJobId", "variantIndex", "fictionPromptIdentity", "providerProfileId", "providerType", "model", "parameters"], "asset_publication_provenance_invalid");
    assertExactKeys(value.parameters, ["size", "aspectRatio", "quality", "outputFormat"], "asset_publication_provenance_invalid");
    if (!UUID_PATTERN.test(value.imageJobId) || !UUID_PATTERN.test(value.providerProfileId)
      || !Number.isSafeInteger(value.variantIndex) || value.variantIndex < 0
      || !HASH_PATTERN.test(value.fictionPromptIdentity)
      || !validBoundedString(value.providerType, 200)
      || !validBoundedString(value.model, 500)
      || Object.values(value.parameters).some((setting) => !validBoundedString(setting, 500))) {
      throw new Error("asset_publication_provenance_invalid");
    }
    return Object.freeze({
      ...value,
      parameters: Object.freeze({ ...value.parameters })
    });
  }
  if (value.kind === "import") {
    assertExactKeys(value, ["kind", "importKind", "importOperationId", "importId", "sourceInstallationId"], "asset_publication_provenance_invalid");
    if (!["campaign_zip", "legacy_story"].includes(value.importKind)
      || !UUID_PATTERN.test(value.importOperationId)
      || (value.importId !== undefined && value.importId !== null && !UUID_PATTERN.test(value.importId))
      || (value.sourceInstallationId !== undefined && value.sourceInstallationId !== null
        && !validBoundedString(value.sourceInstallationId, 500))) {
      throw new Error("asset_publication_provenance_invalid");
    }
    return Object.freeze({
      kind: "import",
      importKind: value.importKind,
      importOperationId: value.importOperationId,
      importId: value.importId ?? null,
      sourceInstallationId: value.sourceInstallationId ?? null
    });
  }
  assertExactKeys(value, ["kind", "uploadId"], "asset_publication_provenance_invalid");
  if (value.uploadId !== undefined && value.uploadId !== null && !validBoundedString(value.uploadId, 500)) {
    throw new Error("asset_publication_provenance_invalid");
  }
  return Object.freeze({ kind: "upload", uploadId: value.uploadId ?? null });
}

function uniqueSortedByKey<T extends Readonly<{ intentKey: string }>>(
  values: readonly T[],
  errorCode: string,
): readonly T[] {
  if (values.some((value) => !validBoundedString(value.intentKey, 500))) throw new Error(errorCode);
  const sorted = [...values].sort((left, right) => compareOrdinal(left.intentKey, right.intentKey));
  if (sorted.some((value, index) => index > 0 && value.intentKey === sorted[index - 1]!.intentKey)) {
    throw new Error(errorCode);
  }
  return Object.freeze(sorted);
}

function snapshotContext(value: PrivateAssetPublicationContextIntentInput): PrivateAssetPublicationContextIntent {
  if (!Number.isSafeInteger(value.variantIndex) || value.variantIndex < 0
    || !["world_cover", "turn_illustration", "streaming_illustration", "other"].includes(value.targetType)) {
    throw new Error("asset_publication_context_intent_invalid");
  }
  const identifiers = [value.sourceContextId, value.worldId, value.worldVersionId, value.campaignId, value.turnId];
  if (identifiers.some((identifier) => identifier !== undefined && identifier !== null && !UUID_PATTERN.test(identifier))
    || (value.fictionPromptIdentity !== undefined && value.fictionPromptIdentity !== null
      && !HASH_PATTERN.test(value.fictionPromptIdentity))) {
    throw new Error("asset_publication_context_intent_invalid");
  }
  return Object.freeze({
    intentKey: value.intentKey,
    sourceContextId: value.sourceContextId ?? null,
    targetType: value.targetType,
    variantIndex: value.variantIndex,
    worldId: value.worldId ?? null,
    worldVersionId: value.worldVersionId ?? null,
    campaignId: value.campaignId ?? null,
    turnId: value.turnId ?? null,
    fictionPromptIdentity: value.fictionPromptIdentity ?? null
  });
}

function snapshotReference(value: PrivateAssetPublicationReferenceIntentInput): PrivateAssetPublicationReferenceIntent {
  const identifiers = [value.sourceCampaignId, value.sourceTurnId, value.campaignId, value.turnId];
  if (!["turn_illustration", "world_asset", "import_attachment"].includes(value.assetRole)
    || identifiers.some((identifier) => identifier !== undefined && identifier !== null && !UUID_PATTERN.test(identifier))) {
    throw new Error("asset_publication_reference_intent_invalid");
  }
  return Object.freeze({
    intentKey: value.intentKey,
    assetRole: value.assetRole,
    sourceCampaignId: value.sourceCampaignId ?? null,
    sourceTurnId: value.sourceTurnId ?? null,
    campaignId: value.campaignId ?? null,
    turnId: value.turnId ?? null
  });
}

function snapshotSources(
  values: readonly PrivateAssetPublicationSourceRecordInput[],
): readonly PrivateAssetPublicationSourceRecord[] {
  if (values.length > 1_000) throw new Error("asset_publication_sources_invalid");
  const sources = values.map((value): PrivateAssetPublicationSourceRecord => {
    if (!["campaign_zip", "legacy_story"].includes(value.sourceKind)
      || !validBoundedString(value.sourceAssetId, 500)
      || (value.sourceRecordId !== undefined && value.sourceRecordId !== null
        && !validBoundedString(value.sourceRecordId, 500))
      || (value.sourceKey !== undefined && value.sourceKey !== null && !validBoundedString(value.sourceKey, 1_000))) {
      throw new Error("asset_publication_sources_invalid");
    }
    const bindingIntentKeys = snapshotStringSet(value.bindingIntentKeys, 1_000, 500, false);
    return Object.freeze({
      sourceKind: value.sourceKind,
      sourceAssetId: value.sourceAssetId,
      sourceRecordId: value.sourceRecordId ?? null,
      sourceKey: value.sourceKey ?? null,
      requestedLibrary: snapshotLibrary(value.requestedLibrary),
      bindingIntentKeys
    });
  }).sort((left, right) => (
    compareOrdinal(left.sourceKind, right.sourceKind)
    || compareOrdinal(left.sourceAssetId, right.sourceAssetId)
    || compareOrdinal(left.sourceRecordId ?? "", right.sourceRecordId ?? "")
    || compareOrdinal(left.sourceKey ?? "", right.sourceKey ?? "")
  ));
  if (sources.some((source, index) => index > 0
    && source.sourceKind === sources[index - 1]!.sourceKind
    && source.sourceAssetId === sources[index - 1]!.sourceAssetId
    && source.sourceRecordId === sources[index - 1]!.sourceRecordId
    && source.sourceKey === sources[index - 1]!.sourceKey)) {
    throw new Error("asset_publication_sources_invalid");
  }
  return Object.freeze(sources);
}

export function bindPrivateNormalizedAssetPublicationRequest(
  input: PrivateNormalizedAssetPublicationRequestInput,
): PrivateNormalizedAssetPublicationRequest {
  if (!validBoundedString(input.owner.ownerUserId, 500)
    || !validBoundedString(input.idempotencyKey, 200)
    || input.derivatives.length > 100) {
    throw new Error("asset_publication_request_invalid");
  }
  const original = snapshotArtifact(input.original);
  const derivatives = input.derivatives.map((value) => {
    const slot = snapshotSlot(value.slot);
    const artifact = snapshotArtifact(value.artifact);
    if (slot.pixelWidth !== artifact.technicalMetadata.pixelWidth
      || slot.pixelHeight !== artifact.technicalMetadata.pixelHeight) {
      throw new Error("asset_publication_derivative_slot_invalid");
    }
    return Object.freeze({ slot, artifact });
  }).sort((left, right) => compareOrdinal(stableStringify(left.slot), stableStringify(right.slot)));
  if (derivatives.some((derivative, index) => index > 0
    && stableStringify(derivative.slot) === stableStringify(derivatives[index - 1]!.slot))) {
    throw new Error("asset_publication_derivative_slot_invalid");
  }
  const requestedLibrary = snapshotLibrary(input.requestedLibrary);
  const sourceRecords = snapshotSources(input.sourceRecords);
  const canonicalSource = sourceRecords[0];
  const contextIntents = uniqueSortedByKey(
    input.contextIntents.map(snapshotContext),
    "asset_publication_context_intent_invalid",
  );
  const referencePolicy: PrivateAssetPublicationReferencePolicy = input.referencePolicy.mode === "omit"
    ? Object.freeze({ mode: "omit", intents: Object.freeze([]) as readonly [] })
    : (() => {
      if (input.referencePolicy.intents.length === 0) {
        throw new Error("asset_publication_reference_intent_invalid");
      }
      return Object.freeze({
        mode: "attach",
        intents: uniqueSortedByKey(
          input.referencePolicy.intents.map(snapshotReference),
          "asset_publication_reference_intent_invalid",
        )
      });
    })();
  const validBindingIntentKeys = new Set([
    ...contextIntents.map((intent) => intent.intentKey),
    ...referencePolicy.intents.map((intent) => intent.intentKey)
  ]);
  if (sourceRecords.some((source) => source.bindingIntentKeys.some((key) => !validBindingIntentKeys.has(key)))) {
    throw new Error("asset_publication_sources_invalid");
  }
  return Object.freeze({
    owner: Object.freeze({ ownerUserId: input.owner.ownerUserId }),
    idempotencyKey: input.idempotencyKey,
    original,
    derivatives: Object.freeze(derivatives),
    requestedLibrary,
    sourceRecords,
    canonicalLibraryInitialization: Object.freeze({
      sourceAssetId: canonicalSource?.sourceAssetId ?? null,
      sourceRecordId: canonicalSource?.sourceRecordId ?? null,
      library: canonicalSource?.requestedLibrary ?? requestedLibrary
    }),
    provenance: snapshotProvenance(input.provenance),
    contextIntents,
    referencePolicy
  });
}

function artifactFingerprintValue(value: PrivateNormalizedAssetArtifact) {
  return {
    mimeType: value.mimeType,
    byteLength: value.byteLength,
    contentHash: value.contentHash,
    technicalMetadata: value.technicalMetadata
  };
}

/** Canonical preimage excludes bytes and the idempotency key, but includes every request-owned intent. */
export function canonicalPrivateNormalizedAssetPublicationRequest(
  request: PrivateNormalizedAssetPublicationRequest,
): string {
  return stableStringify({
    ownerUserId: request.owner.ownerUserId,
    original: artifactFingerprintValue(request.original),
    derivatives: request.derivatives.map((derivative) => ({
      slot: derivative.slot,
      artifact: artifactFingerprintValue(derivative.artifact)
    })),
    requestedLibrary: request.requestedLibrary,
    sourceRecords: request.sourceRecords,
    canonicalLibraryInitialization: request.canonicalLibraryInitialization,
    provenance: request.provenance,
    contextIntents: request.contextIntents,
    referencePolicy: request.referencePolicy
  });
}

export function fingerprintPrivateNormalizedAssetPublicationRequest(
  request: PrivateNormalizedAssetPublicationRequest,
  sha256: (canonicalRequest: string) => string,
): string {
  const fingerprint = sha256(canonicalPrivateNormalizedAssetPublicationRequest(request));
  if (!HASH_PATTERN.test(fingerprint)) throw new Error("asset_publication_fingerprint_invalid");
  return fingerprint;
}

function readRecord(value: unknown, errorCode: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(errorCode);
  return value as Record<string, unknown>;
}

export function projectSafeNormalizedAssetPublicationResult(
  value: unknown,
): SafeNormalizedAssetPublicationResult {
  const result = readRecord(value, "asset_publication_result_invalid");
  const derivatives = Array.isArray(result.derivatives) ? result.derivatives.map((entry) => {
    const derivative = readRecord(entry, "asset_publication_result_invalid");
    if (typeof derivative.derivativeId !== "string" || !UUID_PATTERN.test(derivative.derivativeId)
      || derivative.derivativeKind !== "thumbnail"
      || !validDimension(derivative.transformVersion)
      || !validDimension(derivative.pixelWidth)
      || !validDimension(derivative.pixelHeight)) {
      throw new Error("asset_publication_result_invalid");
    }
    return Object.freeze({
      derivativeId: derivative.derivativeId,
      derivativeKind: "thumbnail" as const,
      transformVersion: derivative.transformVersion,
      pixelWidth: derivative.pixelWidth,
      pixelHeight: derivative.pixelHeight
    });
  }) : null;
  if (typeof result.assetId !== "string" || !UUID_PATTERN.test(result.assetId)
    || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(String(result.mimeType))
    || !Number.isSafeInteger(result.byteLength) || (result.byteLength as number) < 0
    || typeof result.contentHash !== "string" || !HASH_PATTERN.test(result.contentHash)
    || !validDimension(result.pixelWidth) || !validDimension(result.pixelHeight)
    || derivatives === null) {
    throw new Error("asset_publication_result_invalid");
  }
  return Object.freeze({
    assetId: result.assetId,
    mimeType: result.mimeType as PrivateNormalizedAssetMimeType,
    byteLength: result.byteLength as number,
    contentHash: result.contentHash,
    pixelWidth: result.pixelWidth,
    pixelHeight: result.pixelHeight,
    derivatives: Object.freeze(derivatives)
  });
}

export function replayPrivateNormalizedAssetPublicationRequest(
  request: PrivateNormalizedAssetPublicationRequest,
  stored: Readonly<{ requestFingerprint: string; result: unknown }>,
  sha256: (canonicalRequest: string) => string,
): SafeNormalizedAssetPublicationResult {
  if (stored.requestFingerprint !== fingerprintPrivateNormalizedAssetPublicationRequest(request, sha256)) {
    throw new Error("asset_publication_idempotency_mismatch");
  }
  return projectSafeNormalizedAssetPublicationResult(stored.result);
}

function exactChildBindings(
  expected: readonly string[],
  values: readonly Readonly<{ intentKey: string; contextId?: string; referenceId?: string }>[],
  idKey: "contextId" | "referenceId",
): readonly Readonly<{ intentKey: string; contextId: string }>[]
  | readonly Readonly<{ intentKey: string; referenceId: string }>[] {
  const sorted = [...values].sort((left, right) => compareOrdinal(left.intentKey, right.intentKey));
  if (sorted.length !== expected.length
    || sorted.some((value, index) => value.intentKey !== expected[index]
      || typeof value[idKey] !== "string"
      || !UUID_PATTERN.test(value[idKey] as string))) {
    throw new Error("asset_publication_request_children_mismatch");
  }
  return Object.freeze(sorted.map((value) => Object.freeze({
    intentKey: value.intentKey,
    [idKey]: value[idKey]
  }))) as readonly Readonly<{ intentKey: string; contextId: string }>[]
    | readonly Readonly<{ intentKey: string; referenceId: string }>[];
}

/**
 * The repository calls this only after the request core and destination domain rows
 * exist in its caller-owned transaction. Exact intent coverage prevents a commit
 * from silently dropping a rich import or illustration binding.
 */
export function bindPrivateNormalizedAssetRequestChildren(
  request: PrivateNormalizedAssetPublicationRequest,
  attachment: PrivateNormalizedAssetRequestCoreAttachment,
  input: PrivateNormalizedAssetRequestChildBindingsInput,
): PrivateNormalizedAssetRequestChildBindings {
  if (!UUID_PATTERN.test(attachment.requestId)
    || attachment.ownerUserId !== request.owner.ownerUserId
    || !UUID_PATTERN.test(attachment.assetId)
    || !HASH_PATTERN.test(attachment.requestFingerprint)) {
    throw new Error("asset_publication_request_children_mismatch");
  }
  const contexts = exactChildBindings(
    request.contextIntents.map((intent) => intent.intentKey),
    input.contexts,
    "contextId",
  ) as readonly Readonly<{ intentKey: string; contextId: string }>[];
  const references = exactChildBindings(
    request.referencePolicy.intents.map((intent) => intent.intentKey),
    input.references,
    "referenceId",
  ) as readonly Readonly<{ intentKey: string; referenceId: string }>[];
  return Object.freeze({ ...attachment, contexts, references });
}
