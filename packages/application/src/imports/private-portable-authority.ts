import type { ImportOwnerScope, PortableArchiveExportRetrieval, PortableStagedInput } from "./types.js";
import type { PrivateFilesystemCandidateAuthority } from "../assets/private-storage-lifecycle.js";

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
  reservation: PrivateFilesystemCandidateAuthority["reservation"];
  candidate: PrivateFilesystemCandidateAuthority["candidate"];
  descriptor: PrivateFilesystemCandidateAuthority["descriptor"];
  expiresAt: string;
  [privatePortableStagedIssuanceBrand]: true;
}>;

export type PrivatePortableExportIssuance = PrivatePortableStagedIssuance & Readonly<{
  exportScope: PortableExportScope;
  [privatePortableExportIssuanceBrand]: true;
}>;

/** Secure adapter seam: issuance always consumes a fully validated authority. */
export interface PrivatePortableCapabilityIssuancePort {
  issueStagedInput(issuance: PrivatePortableStagedIssuance): Promise<PortableStagedInput>;
  issueExportRetrieval(issuance: PrivatePortableExportIssuance): Promise<PortableArchiveExportRetrieval>;
}

function nonBlank(value: string): boolean {
  return value.trim().length > 0;
}

function requirePortableAuthority(
  owner: ImportOwnerScope,
  authority: PrivateFilesystemCandidateAuthority,
  purpose: "portable_staging" | "portable_export",
): void {
  if (!nonBlank(owner.ownerUserId)
    || authority.reservation.ownerUserId !== owner.ownerUserId
    || authority.reservation.resourceKind !== "portable") {
    throw new Error("filesystem_scope_invalid");
  }
  if (authority.reservation.purpose !== purpose) {
    throw new Error("filesystem_purpose_invalid");
  }
}

function snapshotIssuance(
  owner: ImportOwnerScope,
  authority: PrivateFilesystemCandidateAuthority,
): PrivatePortableStagedIssuance {
  return Object.freeze({
    owner: Object.freeze({ ownerUserId: owner.ownerUserId }),
    reservation: authority.reservation,
    candidate: authority.candidate,
    descriptor: authority.descriptor,
    expiresAt: authority.expiresAt
  }) as PrivatePortableStagedIssuance;
}

export function bindPrivatePortableStagedIssuance(
  owner: ImportOwnerScope,
  authority: PrivateFilesystemCandidateAuthority,
): PrivatePortableStagedIssuance {
  requirePortableAuthority(owner, authority, "portable_staging");
  return snapshotIssuance(owner, authority);
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

export function bindPrivatePortableExportIssuance(
  exportScope: PortableExportScope,
  authority: PrivateFilesystemCandidateAuthority,
): PrivatePortableExportIssuance {
  requireExportScope(exportScope);
  requirePortableAuthority({ ownerUserId: exportScope.ownerUserId }, authority, "portable_export");
  const issuance = snapshotIssuance({ ownerUserId: exportScope.ownerUserId }, authority);
  return Object.freeze({
    ...issuance,
    exportScope: Object.freeze({ ...exportScope })
  }) as PrivatePortableExportIssuance;
}
