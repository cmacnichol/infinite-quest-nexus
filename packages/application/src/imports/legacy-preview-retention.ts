export type ArchivePreviewStorageSecurityState = "legacy_path_v1" | "identity_bound_v2";
export type ArchivePreviewLegacyDrainPolicy =
  | "retain_until_secure_cleanup"
  | "live_path_cleanup_compatibility";

export type ArchivePreviewRetentionRecord = Readonly<{
  storageSecurityState: ArchivePreviewStorageSecurityState;
  secureStagedInputId: string | null;
  legacyDrainPolicy: ArchivePreviewLegacyDrainPolicy;
}>;

export type ArchivePreviewExpiryDisposition =
  | Readonly<{
    kind: "legacy_retained";
    expiryDisposition: "retain_bytes";
    cleanupAuthority: "none";
  }>
  | Readonly<{
    kind: "durable_staged_input";
    secureStagedInputId: string;
    expiryDisposition: "cleanup_with_identity_fence";
    cleanupAuthority: "durable_staged_input";
  }>;

/**
 * Path-only preview rows are never cleanup authority, including rows written
 * under the old live-path compatibility label immediately before cutover.
 */
export function resolveArchivePreviewExpiryDisposition(
  record: ArchivePreviewRetentionRecord,
): ArchivePreviewExpiryDisposition {
  if (record.storageSecurityState === "legacy_path_v1") {
    if (record.secureStagedInputId !== null) throw new Error("archive_preview_retention_state_invalid");
    return {
      kind: "legacy_retained",
      expiryDisposition: "retain_bytes",
      cleanupAuthority: "none"
    };
  }

  if (record.secureStagedInputId === null || record.secureStagedInputId.trim().length === 0) {
    throw new Error("archive_preview_retention_state_invalid");
  }
  return {
    kind: "durable_staged_input",
    secureStagedInputId: record.secureStagedInputId,
    expiryDisposition: "cleanup_with_identity_fence",
    cleanupAuthority: "durable_staged_input"
  };
}
