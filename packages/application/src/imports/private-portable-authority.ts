import type { ImportOwnerScope, PortableArchiveExportRetrieval, PortableStagedInput } from "./types.js";
import type {
  AttachedFilesystemOperation,
  DurableFilesystemRecoveryClaim,
  DurableFilesystemTransactionContext
} from "../assets/private-storage-lifecycle.js";
import type { PrivateFilesystemCandidateAttachment } from "../assets/private-filesystem-repository.js";

declare const privatePortableStagedIssuanceBrand: unique symbol;
declare const privatePortableExportIssuanceBrand: unique symbol;

export type PortableExportScope = Readonly<{
  ownerUserId: string;
  exportKind: "campaign_zip" | "world_json";
  campaignId: string | null;
  worldId: string;
  worldVersionId: string;
}>;

export type PrivatePortableStagedIssuance = Readonly<{
  owner: ImportOwnerScope;
  attachment: PrivateFilesystemCandidateAttachment;
  expiresAt: string;
  [privatePortableStagedIssuanceBrand]: true;
}>;

export type PrivatePortableExportIssuance = PrivatePortableStagedIssuance & Readonly<{
  exportScope: PortableExportScope;
  contentType: "application/zip" | "application/json";
  [privatePortableExportIssuanceBrand]: true;
}>;

export type PrivateAtomicStagedIssuanceResult = Readonly<{
  stagedInput: PortableStagedInput;
  operation: AttachedFilesystemOperation;
  claim: DurableFilesystemRecoveryClaim;
}>;

export type PrivateAtomicExportIssuanceResult = Readonly<{
  retrieval: PortableArchiveExportRetrieval;
  operation: AttachedFilesystemOperation;
  claim: DurableFilesystemRecoveryClaim;
}>;

/**
 * Adapter-private atomic issuance. The caller owns the database transaction;
 * the repository inserts the portable row and exact-attaches its candidate in
 * that same transaction or returns no authority at all.
 */
export interface PrivateAtomicPortableIssuancePort {
  issueStagedInput(
    database: DurableFilesystemTransactionContext,
    issuance: PrivatePortableStagedIssuance,
  ): Promise<PrivateAtomicStagedIssuanceResult>;
  issueExportRetrieval(
    database: DurableFilesystemTransactionContext,
    issuance: PrivatePortableExportIssuance,
  ): Promise<PrivateAtomicExportIssuanceResult>;
}

function nonBlank(value: string): boolean {
  return value.trim().length > 0;
}

function requirePortableAttachment(
  owner: ImportOwnerScope,
  attachment: PrivateFilesystemCandidateAttachment,
  purpose: "portable_staging" | "portable_export",
): void {
  if (!nonBlank(owner.ownerUserId)
    || attachment.operation.ownerUserId !== owner.ownerUserId
    || attachment.operation.resourceKind !== "portable") {
    throw new Error("filesystem_scope_invalid");
  }
  if (attachment.operation.purpose !== purpose) {
    throw new Error("filesystem_purpose_invalid");
  }
  if (!nonBlank(attachment.operation.operationScopeId)
    || !nonBlank(attachment.operation.expiresAt)
    || !Number.isFinite(Date.parse(attachment.operation.expiresAt))
    || Date.parse(attachment.operation.expiresAt) <= Date.now()) {
    throw new Error("filesystem_scope_invalid");
  }
}

function snapshotIssuance(
  owner: ImportOwnerScope,
  attachment: PrivateFilesystemCandidateAttachment,
): PrivatePortableStagedIssuance {
  return Object.freeze({
    owner: Object.freeze({ ownerUserId: owner.ownerUserId }),
    attachment,
    expiresAt: attachment.operation.expiresAt
  }) as PrivatePortableStagedIssuance;
}

export function bindPrivateAtomicStagedIssuance(
  owner: ImportOwnerScope,
  attachment: PrivateFilesystemCandidateAttachment,
): PrivatePortableStagedIssuance {
  requirePortableAttachment(owner, attachment, "portable_staging");
  return snapshotIssuance(owner, attachment);
}

function requireExportScope(scope: PortableExportScope): void {
  const baseIsInvalid = !nonBlank(scope.ownerUserId)
    || !nonBlank(scope.worldId)
    || !nonBlank(scope.worldVersionId);
  const kindIsInvalid = !["campaign_zip", "world_json"].includes(scope.exportKind)
    || (scope.exportKind === "campaign_zip" && (scope.campaignId === null || !nonBlank(scope.campaignId)))
    || (scope.exportKind === "world_json" && scope.campaignId !== null);
  if (baseIsInvalid || kindIsInvalid) throw new Error("portable_export_scope_invalid");
}

export function bindPrivateAtomicExportIssuance(
  exportScope: PortableExportScope,
  contentType: "application/zip" | "application/json",
  attachment: PrivateFilesystemCandidateAttachment,
): PrivatePortableExportIssuance {
  requireExportScope(exportScope);
  const expectedContentType = exportScope.exportKind === "campaign_zip"
    ? "application/zip"
    : "application/json";
  if (contentType !== expectedContentType) throw new Error("portable_export_content_type_invalid");
  requirePortableAttachment({ ownerUserId: exportScope.ownerUserId }, attachment, "portable_export");
  const issuance = snapshotIssuance({ ownerUserId: exportScope.ownerUserId }, attachment);
  return Object.freeze({
    ...issuance,
    exportScope: Object.freeze({ ...exportScope }),
    contentType
  }) as PrivatePortableExportIssuance;
}
