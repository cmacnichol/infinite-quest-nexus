import type { ImportOwnerScope, PortableStagedInput } from "./types.js";

declare const portableArchiveUploadCapabilityBrand: unique symbol;

/**
 * Trusted transport mints this only after binding the server-resolved owner and
 * enforcing its upload limit. The owner binding is deliberately unobservable
 * to callers of the staging port.
 */
export type PortableArchiveUploadCapability = Readonly<{
  byteLength: number;
  readonly [portableArchiveUploadCapabilityBrand]: Readonly<{ ownerUserId: string }>;
}>;

/**
 * Adapter-private seam for archive ingestion. It takes neither an owner,
 * filesystem path, stream, nor error channel and returns only an opaque staged
 * input that can later be previewed through the public portable archive port.
 */
export interface PortableArchiveStagingPort {
  stagePortableArchive(upload: PortableArchiveUploadCapability): Promise<PortableStagedInput>;
}

/** Test-only issuer shape for pure adapter fakes; production issuers stay in future API adapters. */
export interface PortableArchiveUploadIssuer {
  issueOwnerBoundUpload(owner: ImportOwnerScope, byteLength: number): PortableArchiveUploadCapability;
}
