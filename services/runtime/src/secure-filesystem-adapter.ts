// Role-neutral private adapter. API compatibility is a re-export only.
import { createHash } from "node:crypto";
import { constants as filesystemConstants } from "node:fs";
import { lstat, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import type {
  PrivateBoundedStreamLimits,
  PrivateBoundedStreamSession,
  PrivatePrewriteNodeRepositoryPort,
  PrivatePortableExpiryRecoveryPort,
  PrivateStreamTerminalReason,
  LegacyPathV1PreviewDescriptor
} from "../../../packages/application/src/assets/private-secure-storage.js";
export { bindLegacyPathV1PreviewDescriptor } from "../../../packages/application/src/assets/private-secure-storage.js";
import type {
  DurableFilesystemJournalPort,
  DurableFilesystemRecoveryClaim,
  DurableFilesystemRecoveryRecord,
  DurableFilesystemTransactionContext,
  PrivateStorageDescriptor,
  ReservedFilesystemOperation
} from "../../../packages/application/src/assets/private-storage-lifecycle.js";
import type { PrivateFilesystemRecoveryOutcome } from "../../../packages/application/src/assets/private-filesystem-recovery.js";
import {
  bindPrivatePrewriteNodeAuthority,
  bindPrivatePrewriteTargetAuthority
} from "../../../packages/application/src/assets/private-secure-storage.js";
import {
  bindPrivateFilesystemCandidateAttachment,
  type PrivateFilesystemCandidatePersistencePort,
  type PrivateFilesystemPublicationCleanupPort
} from "../../../packages/application/src/assets/private-filesystem-repository.js";
import type { FinalizedAssetDeliveryResolverPort } from "../../../packages/application/src/assets/private-finalized-delivery.js";
import type { AssetDeliveryRequest, AssetFilesystemDiagnosticCode, AssetScope } from "../../../packages/application/src/assets/types.js";
import type {
  PrivateMetadataBackfillThumbnailPreparation,
  PrivatePreparedMetadataBackfillThumbnail
} from "../../../packages/application/src/assets/private-metadata-backfill.js";
import type {
  PrivatePortableExportCleanupPreparation,
  PrivatePortablePreviewRepositoryPort,
  PrivatePortableStagedCleanupPreparation,
  PrivatePortableRepositoryPort
} from "../../../packages/application/src/imports/private-portable-repository.js";
import type {
  PrivateAssetPublicationCommand,
  PrivateAssetPublicationFilesystemPort,
  PrivateAssetPublicationIdentity,
  PrivatePreparedAssetPublication,
  PrivatePreparedAssetPublicationArtifact
} from "../../../packages/application/src/assets/private-asset-publication.js";
import {
  snapshotPrivateAssetPublicationCommand,
  validatePrivateAssetPublicationCommand,
  verifyPrivateAssetPublicationContentHashes
} from "../../../packages/application/src/assets/private-asset-publication.js";
import {
  bindPrivateAtomicExportIssuance,
  bindPrivateAtomicStagedIssuance,
  type PortableExportScope,
  type PrivateAtomicPortableIssuancePort
} from "../../../packages/application/src/imports/private-portable-authority.js";
import type {
  ImportOwnerScope,
  PortableArchiveExportRetrieval,
  PortableImportKind,
  PortablePreviewDestination,
  PortablePreviewHandle,
  PortableStagedInput
} from "../../../packages/application/src/imports/types.js";
import type { SystemArchivePrivateStorageRepositoryPort } from "../../../packages/application/src/system-archives/private-storage.js";

const READ_FLAGS = filesystemConstants.O_RDONLY | filesystemConstants.O_NOFOLLOW;
const DIRECTORY_FLAGS = READ_FLAGS | filesystemConstants.O_DIRECTORY;
const CREATE_FLAGS = filesystemConstants.O_WRONLY
  | filesystemConstants.O_CREAT
  | filesystemConstants.O_EXCL
  | filesystemConstants.O_NOFOLLOW;
const UPDATE_FLAGS = filesystemConstants.O_RDWR | filesystemConstants.O_NOFOLLOW;
// Do not begin a read at the database/reaper boundary. The claim is the last
// durable authority known locally, so a stalled renewal must fail closed.
const PORTABLE_READ_LEASE_SAFETY_MARGIN_MILLISECONDS = 50;

export interface SecureFilesystemTransactionRunner {
  run<Result>(
    work: (database: DurableFilesystemTransactionContext) => Promise<Result>,
  ): Promise<Result>;
}

export type SecureFilesystemAdapterOptions = Readonly<{
  archiveRoot: string;
  assetRoot: string;
  platform?: NodeJS.Platform;
  portable?: PrivatePortableRepositoryPort;
  portablePreview?: PrivatePortablePreviewRepositoryPort;
  delivery?: FinalizedAssetDeliveryResolverPort;
  journal?: DurableFilesystemJournalPort;
  candidates?: PrivateFilesystemCandidatePersistencePort;
  publicationCleanup?: PrivateFilesystemPublicationCleanupPort;
  atomicPortable?: PrivateAtomicPortableIssuancePort;
  prewrite?: PrivatePrewriteNodeRepositoryPort;
  expiry?: PrivatePortableExpiryRecoveryPort;
  systemArchiveStorage?: SystemArchivePrivateStorageRepositoryPort;
  /** Private recovery seam used to coordinate an in-process filesystem drain. */
  recoveryHooks?: Readonly<{
    beforePhysicalDelete?(input: Readonly<{
      recovery: DurableFilesystemRecoveryRecord;
      descriptor: PrivateStorageDescriptor;
    }>): Promise<void> | void;
  }>;
  transactions: SecureFilesystemTransactionRunner;
}>;

export type SecureFilesystemAdapter = Readonly<{
  prepareAssetPublication: PrivateAssetPublicationFilesystemPort["prepareAssetPublication"];
  prepareMetadataBackfillThumbnail(
    input: PrivateMetadataBackfillThumbnailPreparation,
  ): Promise<PrivatePreparedMetadataBackfillThumbnail>;
  discardPreparedAssetPublication(prepared: PrivatePreparedAssetPublication): Promise<void>;
  finalizeAssetPublication: PrivateAssetPublicationFilesystemPort["finalizeAssetPublication"];
  stagePortableInput(input: Readonly<{
    owner: ImportOwnerScope;
    operationScopeId: string;
    leaseOwner: string;
    expiresAt: string;
    byteLength: number;
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  }>): Promise<Readonly<{
    stagedInput: PortableStagedInput;
    operation: import("../../../packages/application/src/assets/private-storage-lifecycle.js").AttachedFilesystemOperation;
    claim: import("../../../packages/application/src/assets/private-storage-lifecycle.js").DurableFilesystemRecoveryClaim;
  }>>;
  /** Internal bounded staging for generated portable artifacts whose exact size is known only after streaming. */
  stagePortableScratch(input: Readonly<{
    owner: ImportOwnerScope;
    operationScopeId: string;
    leaseOwner: string;
    expiresAt: string;
    maximumBytes: number;
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  }>): Promise<Readonly<{
    stagedInput: PortableStagedInput;
    operation: import("../../../packages/application/src/assets/private-storage-lifecycle.js").AttachedFilesystemOperation;
    claim: import("../../../packages/application/src/assets/private-storage-lifecycle.js").DurableFilesystemRecoveryClaim;
    byteLength: number;
    contentHash: string;
  }>>;
  prepareSystemArchiveUpload(input: Readonly<{
    ownerUserId: string;
    operationScopeId: string;
    leaseOwner: string;
    expiresAt: string;
  }>): Promise<Readonly<{
    filesystemOperationId: string;
    rollback(): Promise<void>;
  }>>;
  publishSystemArchiveUploadChunk<Result>(input: Readonly<{
    ownerUserId: string;
    uploadId: string;
    filesystemOperationId: string;
    leaseOwner: string;
    leaseSeconds: number;
    offset: number;
    bytes: Uint8Array;
    sha256: string;
  }>, persist: () => Promise<Result>): Promise<Result>;
  assembleSystemArchiveUpload(input: Readonly<{
    ownerUserId: string;
    uploadId: string;
    filesystemOperationId: string;
    leaseOwner: string;
    leaseSeconds: number;
    byteLength: number;
    sha256: string;
  }>): Promise<Readonly<{
    stagedInputId: string;
    byteLength: number;
    sha256: string;
    rollback(): Promise<void>;
  }>>;
  discardPortableStagedInput(input: Readonly<{
    owner: ImportOwnerScope;
    stagedInput: PortableStagedInput;
    claim: Readonly<{ leaseOwner: string; leaseSeconds: number }>;
  }>): Promise<void>;
  publishPortableExport(input: Readonly<{
    exportScope: PortableExportScope;
    operationScopeId: string;
    leaseOwner: string;
    expiresAt: string;
    contentType: "application/zip" | "application/json";
    byteLength: number;
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  }>): Promise<Readonly<{
    retrieval: PortableArchiveExportRetrieval;
    operation: import("../../../packages/application/src/assets/private-storage-lifecycle.js").AttachedFilesystemOperation;
    claim: import("../../../packages/application/src/assets/private-storage-lifecycle.js").DurableFilesystemRecoveryClaim;
  }>>;
  openStagedInputSession(input: Readonly<{
    owner: ImportOwnerScope;
    stagedInput: PortableStagedInput;
    claim: Readonly<{ leaseOwner: string; leaseSeconds: number }>;
    limits: PrivateBoundedStreamLimits;
  }>): Promise<PrivateBoundedStreamSession>;
  openPreviewInputSession<Destination extends PortablePreviewDestination>(input: Readonly<{
    owner: ImportOwnerScope;
    kind: PortableImportKind;
    previewHandle: PortablePreviewHandle<Destination>;
    claim: Readonly<{ leaseOwner: string; leaseSeconds: number }>;
    limits: PrivateBoundedStreamLimits;
  }>): Promise<PrivateBoundedStreamSession>;
  openExportSession(input: Readonly<{
    scope: PortableExportScope;
    retrieval: PortableArchiveExportRetrieval;
    claim: Readonly<{ leaseOwner: string; leaseSeconds: number }>;
    limits: PrivateBoundedStreamLimits;
  }>): Promise<PrivateBoundedStreamSession>;
  openAssetSession(input: Readonly<{
    scope: AssetScope;
    request: AssetDeliveryRequest;
    limits: PrivateBoundedStreamLimits;
  }>): Promise<PrivateBoundedStreamSession | null>;
  openLegacyPathV1Preview(input: Readonly<{
    descriptor: LegacyPathV1PreviewDescriptor;
    limits: PrivateBoundedStreamLimits;
  }>): Promise<PrivateBoundedStreamSession>;
  reapExpiredPortable(input: Readonly<{
    leaseOwner: string;
    leaseSeconds: number;
    limit: number;
  }>): Promise<Readonly<{ claimed: number; cleaned: number; pending: number }>>;
  /** e6 obtains portable recovery evidence here, then owns its renewable claim loop. */
  claimExpiredPortableRecoveries(input: Readonly<{
    leaseOwner: string;
    leaseSeconds: number;
    limit: number;
  }>): Promise<readonly DurableFilesystemRecoveryRecord[]>;
  /** e6-only execution of database-derived recovery evidence. */
  recoverFilesystemOperation(
    recovery: DurableFilesystemRecoveryRecord,
    currentRecovery?: () => DurableFilesystemRecoveryRecord | null,
  ): Promise<PrivateFilesystemRecoveryOutcome>;
  close(): Promise<void>;
}>;

type BigIntStat = Awaited<ReturnType<FileHandle["stat"]>> & Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

type RootHandle = Readonly<{
  handle: FileHandle;
  rootPath: string;
}>;

function requireRelativePath(relativePath: string): readonly string[] {
  const segments = relativePath.split("/");
  if (relativePath.length === 0
    || relativePath.startsWith("/")
    || /^[A-Za-z]:/u.test(relativePath)
    || relativePath.includes("\\")
    || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error("filesystem_path_invalid");
  }
  return segments;
}

function procPath(handle: FileHandle, segment?: string): string {
  return segment === undefined
    ? `/proc/self/fd/${handle.fd}`
    : `/proc/self/fd/${handle.fd}/${segment}`;
}

function isMissingNode(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function recoveryDiagnostic(error: unknown): AssetFilesystemDiagnosticCode {
  const message = error instanceof Error ? error.message : "";
  if (/hash|content_hash|stream_hash/u.test(message)) return "asset_hash_mismatch";
  if (/size|byte|too_large|limit/u.test(message)) return "asset_too_large";
  if (/signature|mime|decode|dimensions|unsupported/u.test(message)) return "asset_unsupported_media";
  if (/containment|link|path|identity|race/u.test(message)) return "filesystem_containment_denied";
  if (/delivery|storage|stream|filesystem/u.test(message)) return "asset_storage_unavailable";
  return "asset_metadata_unavailable";
}

async function openRoot(rootPath: string): Promise<RootHandle> {
  if (!isAbsolute(rootPath)) throw new Error("filesystem_root_invalid");
  const handle = await open(rootPath, DIRECTORY_FLAGS);
  const value = await handle.stat({ bigint: true });
  if (!value.isDirectory()) {
    await handle.close();
    throw new Error("filesystem_root_invalid");
  }
  return { handle, rootPath };
}

async function openAnchored(
  root: RootHandle,
  relativePath: string,
  flags = READ_FLAGS,
  mode?: number,
): Promise<FileHandle> {
  const segments = requireRelativePath(relativePath);
  const directories: FileHandle[] = [];
  let parent = root.handle;
  try {
    for (const segment of segments.slice(0, -1)) {
      const directory = await open(procPath(parent, segment), DIRECTORY_FLAGS);
      const value = await directory.stat({ bigint: true });
      if (!value.isDirectory()) {
        await directory.close();
        throw new Error("filesystem_path_invalid");
      }
      directories.push(directory);
      parent = directory;
    }
    return await open(procPath(parent, segments[segments.length - 1]!), flags, mode);
  } finally {
    await Promise.allSettled(directories.map((directory) => directory.close()));
  }
}

async function ensureAnchoredDirectory(root: RootHandle, relativePath: string): Promise<void> {
  const segments = requireRelativePath(relativePath);
  const directories: FileHandle[] = [];
  let parent = root.handle;
  try {
    for (const segment of segments) {
      try {
        await mkdir(procPath(parent, segment), { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const directory = await open(procPath(parent, segment), DIRECTORY_FLAGS);
      const value = await directory.stat({ bigint: true });
      if (!value.isDirectory()) {
        await directory.close();
        throw new Error("filesystem_path_invalid");
      }
      directories.push(directory);
      parent = directory;
    }
  } finally {
    await Promise.allSettled(directories.map((directory) => directory.close()));
  }
}

function statIdentity(value: BigIntStat): Readonly<{
  deviceId: string;
  fileId: string;
  changeToken: string;
  byteLength: number;
}> {
  const byteLength = Number(value.size);
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error("filesystem_length_invalid");
  }
  return {
    deviceId: value.dev.toString(),
    fileId: value.ino.toString(),
    changeToken: `${value.mtimeNs}:${value.ctimeNs}`,
    byteLength
  };
}

function requireDescriptorIdentity(value: BigIntStat, descriptor: PrivateStorageDescriptor): void {
  const identity = statIdentity(value);
  if (!value.isFile()
    || identity.deviceId !== descriptor.identity.deviceId
    || identity.fileId !== descriptor.identity.fileId
    || identity.changeToken !== descriptor.identity.changeToken
    || identity.byteLength !== descriptor.byteLength) {
    throw new Error("filesystem_identity_mismatch");
  }
}

function descriptorFromStat(
  relativePath: string,
  value: BigIntStat,
  contentHash: string,
  byteLength: number,
): PrivateStorageDescriptor {
  const identity = statIdentity(value);
  if (!value.isFile() || identity.byteLength !== byteLength) {
    throw new Error("filesystem_identity_mismatch");
  }
  return Object.freeze({
    relativePath,
    identity: Object.freeze({
      deviceId: identity.deviceId,
      fileId: identity.fileId,
      changeToken: identity.changeToken
    }),
    contentHash,
    byteLength
  });
}

async function writeExactContent(
  handle: FileHandle,
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  byteLength: number,
  expiresAt: string,
): Promise<string> {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error("filesystem_length_invalid");
  }
  const hash = createHash("sha256");
  let position = 0;
  for await (const value of source) {
    if (Date.now() >= Date.parse(expiresAt)) throw new Error("filesystem_write_expired");
    const chunk = Buffer.from(value);
    if (position + chunk.byteLength > byteLength) throw new Error("filesystem_write_oversized");
    let offset = 0;
    while (offset < chunk.byteLength) {
      const result = await handle.write(chunk, offset, chunk.byteLength - offset, position + offset);
      if (result.bytesWritten <= 0) throw new Error("filesystem_write_partial");
      offset += result.bytesWritten;
    }
    hash.update(chunk);
    position += chunk.byteLength;
  }
  if (position !== byteLength) throw new Error("filesystem_write_partial");
  await handle.sync();
  return hash.digest("hex");
}

async function writeBoundedContent(
  handle: FileHandle,
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  maximumBytes: number,
  expiresAt: string,
): Promise<Readonly<{ contentHash: string; byteLength: number }>> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error("filesystem_length_invalid");
  }
  const hash = createHash("sha256");
  let position = 0;
  for await (const value of source) {
    if (Date.now() >= Date.parse(expiresAt)) throw new Error("filesystem_write_expired");
    const chunk = Buffer.from(value);
    if (!Number.isSafeInteger(position + chunk.byteLength)
      || position + chunk.byteLength > maximumBytes) {
      throw new Error("filesystem_write_oversized");
    }
    let offset = 0;
    while (offset < chunk.byteLength) {
      const result = await handle.write(chunk, offset, chunk.byteLength - offset, position + offset);
      if (result.bytesWritten <= 0) throw new Error("filesystem_write_partial");
      offset += result.bytesWritten;
    }
    hash.update(chunk);
    position += chunk.byteLength;
  }
  await handle.sync();
  return Object.freeze({ contentHash: hash.digest("hex"), byteLength: position });
}

async function verifyContentAddressedFile(
  handle: FileHandle,
  relativePath: string,
  expectedHash: string,
  byteLength: number,
  expiresAt: string,
): Promise<PrivateStorageDescriptor> {
  const initial = descriptorFromStat(
    relativePath,
    await handle.stat({ bigint: true }) as BigIntStat,
    expectedHash,
    byteLength,
  );
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, byteLength)));
  let position = 0;
  while (position < byteLength) {
    if (Date.now() >= Date.parse(expiresAt)) throw new Error("filesystem_write_expired");
    const size = Math.min(buffer.byteLength, byteLength - position);
    const result = await handle.read(buffer, 0, size, position);
    if (result.bytesRead <= 0) throw new Error("filesystem_read_partial");
    hash.update(buffer.subarray(0, result.bytesRead));
    position += result.bytesRead;
  }
  if (hash.digest("hex") !== expectedHash) throw new Error("asset_publication_hash_mismatch");
  requireDescriptorIdentity(
    await handle.stat({ bigint: true }) as BigIntStat,
    initial,
  );
  return initial;
}

function requireLimits(limits: PrivateBoundedStreamLimits, byteLength: number): void {
  if (!Number.isSafeInteger(limits.maximumBytes)
    || limits.maximumBytes < byteLength
    || !Number.isSafeInteger(limits.chunkBytes)
    || limits.chunkBytes <= 0
    || !Number.isFinite(Date.parse(limits.deadlineAt))
    || Date.parse(limits.deadlineAt) <= Date.now()) {
    throw new Error("filesystem_stream_limits_invalid");
  }
}

async function identitySafeDelete(root: RootHandle, descriptor: PrivateStorageDescriptor): Promise<void> {
  try {
    const handle = await openAnchored(root, descriptor.relativePath);
    try {
      requireDescriptorIdentity(
        await handle.stat({ bigint: true }) as BigIntStat,
        descriptor,
      );
    } finally {
      await handle.close();
    }
    const segments = requireRelativePath(descriptor.relativePath);
    const directories: FileHandle[] = [];
    let parent = root.handle;
    try {
      for (const segment of segments.slice(0, -1)) {
        const directory = await open(procPath(parent, segment), DIRECTORY_FLAGS);
        directories.push(directory);
        parent = directory;
      }
      const current = await lstat(procPath(parent, segments[segments.length - 1]!), { bigint: true }) as BigIntStat;
      requireDescriptorIdentity(current, descriptor);
      await unlink(procPath(parent, segments[segments.length - 1]!));
    } finally {
      await Promise.allSettled(directories.map((directory) => directory.close()));
    }
  } catch (error) {
    if (!isMissingNode(error)) throw error;
  }
}

async function identitySafeDeletePrewrite(
  root: RootHandle,
  relativePath: string,
  identity: Readonly<{ deviceId: string; fileId: string }>,
): Promise<void> {
  try {
    const handle = await openAnchored(root, relativePath);
    try {
      const value = statIdentity(await handle.stat({ bigint: true }) as BigIntStat);
      if (value.deviceId !== identity.deviceId || value.fileId !== identity.fileId) {
        throw new Error("filesystem_identity_mismatch");
      }
    } finally {
      await handle.close();
    }
    const segments = requireRelativePath(relativePath);
    const directories: FileHandle[] = [];
    let parent = root.handle;
    try {
      for (const segment of segments.slice(0, -1)) {
        const directory = await open(procPath(parent, segment), DIRECTORY_FLAGS);
        directories.push(directory);
        parent = directory;
      }
      const current = statIdentity(
        await lstat(procPath(parent, segments[segments.length - 1]!), { bigint: true }) as BigIntStat,
      );
      if (current.deviceId !== identity.deviceId || current.fileId !== identity.fileId) {
        throw new Error("filesystem_identity_mismatch");
      }
      await unlink(procPath(parent, segments[segments.length - 1]!));
    } finally {
      await Promise.allSettled(directories.map((directory) => directory.close()));
    }
  } catch (error) {
    if (!isMissingNode(error)) throw error;
  }
}

function boundedReadSession(input: Readonly<{
  handle: FileHandle;
  contentType: string;
  descriptor: Readonly<{ contentHash: string; byteLength: number }>;
  initialStat: BigIntStat;
  limits: PrivateBoundedStreamLimits;
  allowLegacyBase64Hash?: boolean;
  authorityCurrent?: () => boolean;
  onClosed?: () => void;
  afterClose: (reason: PrivateStreamTerminalReason) => Promise<void>;
}>): PrivateBoundedStreamSession {
  requireLimits(input.limits, input.descriptor.byteLength);
  let finalization: Promise<void> | undefined;
  let terminalReason: PrivateStreamTerminalReason | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const finalize = (reason: PrivateStreamTerminalReason): Promise<void> => {
    terminalReason ??= reason;
    if (deadlineTimer) {
      clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
    }
    finalization ??= (async () => {
      let closeError: unknown;
      try {
        await input.handle.close();
      } catch (error) {
        closeError = error;
      } finally {
        input.onClosed?.();
      }
      await input.afterClose(terminalReason!);
      if (closeError) throw closeError;
    })();
    return finalization;
  };
  const throwIfTerminated = (): void => {
    if (terminalReason === "timeout") throw new Error("filesystem_stream_timeout");
    if (terminalReason) throw new Error("filesystem_stream_closed");
    if (input.authorityCurrent?.() === false) throw new Error("filesystem_stream_lease_lost");
  };
  const timeoutMilliseconds = Math.min(
    2_147_483_647,
    Math.max(0, Date.parse(input.limits.deadlineAt) - Date.now()),
  );
  deadlineTimer = setTimeout(() => {
    void finalize("timeout").catch(() => undefined);
  }, timeoutMilliseconds);
  deadlineTimer.unref?.();
  const chunks = (async function* (): AsyncGenerator<Uint8Array> {
    let reason: PrivateStreamTerminalReason = "abort";
    const hash = createHash("sha256");
    const legacyHash = input.allowLegacyBase64Hash ? createHash("sha256") : undefined;
    let legacyRemainder = Buffer.alloc(0);
    let position = 0;
    try {
      while (position < input.descriptor.byteLength) {
        throwIfTerminated();
        if (Date.now() >= Date.parse(input.limits.deadlineAt)) {
          reason = "timeout";
          throw new Error("filesystem_stream_timeout");
        }
        const requested = Math.min(
          input.limits.chunkBytes,
          input.descriptor.byteLength - position,
        );
        const buffer = Buffer.allocUnsafe(requested);
        const { bytesRead } = await input.handle.read(buffer, 0, requested, position);
        throwIfTerminated();
        if (bytesRead !== requested) throw new Error("filesystem_stream_partial");
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        if (legacyHash) {
          const pending = legacyRemainder.byteLength === 0
            ? chunk
            : Buffer.concat([legacyRemainder, chunk]);
          const completeLength = pending.byteLength - (pending.byteLength % 3);
          if (completeLength > 0) {
            legacyHash.update(pending.subarray(0, completeLength).toString("base64"));
          }
          legacyRemainder = Buffer.from(pending.subarray(completeLength));
        }
        position += bytesRead;
        throwIfTerminated();
        yield Uint8Array.from(chunk);
      }
      throwIfTerminated();
      const sentinel = Buffer.allocUnsafe(1);
      const sentinelRead = await input.handle.read(sentinel, 0, 1, position);
      throwIfTerminated();
      if (sentinelRead.bytesRead !== 0) {
        throw new Error("filesystem_stream_grew");
      }
      const finalStat = await input.handle.stat({ bigint: true }) as BigIntStat;
      throwIfTerminated();
      const initial = statIdentity(input.initialStat);
      const final = statIdentity(finalStat);
      if (!finalStat.isFile()
        || final.deviceId !== initial.deviceId
        || final.fileId !== initial.fileId
        || final.changeToken !== initial.changeToken
        || final.byteLength !== input.descriptor.byteLength) {
        throw new Error("filesystem_stream_identity_changed");
      }
      const rawDigest = hash.digest("hex");
      if (legacyHash && legacyRemainder.byteLength > 0) {
        legacyHash.update(legacyRemainder.toString("base64"));
      }
      const legacyDigest = legacyHash?.digest("hex");
      if (rawDigest !== input.descriptor.contentHash
        && legacyDigest !== input.descriptor.contentHash) {
        throw new Error("filesystem_stream_hash_mismatch");
      }
      reason = "eof";
    } catch (error) {
      if (terminalReason === "timeout") {
        reason = "timeout";
        throw new Error("filesystem_stream_timeout");
      }
      if (reason !== "timeout") reason = "read_failure";
      throw error;
    } finally {
      await finalize(reason);
    }
  })();
  return Object.freeze({
    contentType: input.contentType,
    byteLength: input.descriptor.byteLength,
    chunks,
    finalize
  });
}

export async function createSecureFilesystemAdapter(
  options: SecureFilesystemAdapterOptions,
): Promise<SecureFilesystemAdapter> {
  if ((options.platform ?? process.platform) !== "linux") {
    throw new Error("filesystem_platform_unsupported");
  }
  const archiveRoot = await openRoot(options.archiveRoot);
  let assetRoot: RootHandle;
  try {
    assetRoot = await openRoot(options.assetRoot);
  } catch (error) {
    await archiveRoot.handle.close();
    throw error;
  }
  const activeStreamHandles = new Set<FileHandle>();
  const activePortableHandles = new Map<string, Set<FileHandle>>();
  type PortableReadLease = Readonly<{
    current(): boolean;
    stop(): Promise<void>;
  }>;
  const activePortableReadLeases = new Map<string, Set<PortableReadLease>>();
  const inFlightOpens = new Set<Promise<void>>();
  let closing = false;
  const requireAdapterOpen = (): void => {
    if (closing) throw new Error("filesystem_adapter_closed");
  };
  const registerStreamHandle = (handle: FileHandle): (() => void) => {
    requireAdapterOpen();
    activeStreamHandles.add(handle);
    return () => activeStreamHandles.delete(handle);
  };
  const trackOpen = <Result>(work: () => Promise<Result>): Promise<Result> => {
    requireAdapterOpen();
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    inFlightOpens.add(completion);
    const finish = (): void => {
      inFlightOpens.delete(completion);
      resolveCompletion();
    };
    try {
      return work().finally(finish);
    } catch (error) {
      finish();
      throw error;
    }
  };
  const registerPortableHandle = (operationId: string, handle: FileHandle): (() => void) => {
    const unregisterStream = registerStreamHandle(handle);
    const handles = activePortableHandles.get(operationId) ?? new Set<FileHandle>();
    handles.add(handle);
    activePortableHandles.set(operationId, handles);
    return () => {
      unregisterStream();
      handles.delete(handle);
      if (handles.size === 0) activePortableHandles.delete(operationId);
    };
  };
  const registerPortableReadLease = (
    operationId: string,
    lease: PortableReadLease,
  ): (() => void) => {
    const leases = activePortableReadLeases.get(operationId) ?? new Set<PortableReadLease>();
    leases.add(lease);
    activePortableReadLeases.set(operationId, leases);
    return () => {
      leases.delete(lease);
      if (leases.size === 0) activePortableReadLeases.delete(operationId);
    };
  };
  const startPortableReadLease = async (
    operationId: string,
    initialClaim: DurableFilesystemRecoveryClaim,
    leaseSeconds: number,
  ): Promise<PortableReadLease> => {
    if (!options.journal) throw new Error("portable_repository_unavailable");
    // The immutable portable-content expiry remains the cleanup deadline. A
    // database-backed operation lease is the restart-safe fence that proves a
    // bounded reader is still active beyond that original deadline.
    let claim = initialClaim;
    let lost = false;
    let stopped = false;
    let monotonicLeaseDeadlineMilliseconds = Number.NEGATIVE_INFINITY;
    let activeHeartbeat: Promise<void> | undefined;
    let unregister = (): void => undefined;
    const current = (): boolean => !lost
      && !stopped
      && performance.now() < monotonicLeaseDeadlineMilliseconds;
    const pulse = (): Promise<void> => {
      if (activeHeartbeat) return activeHeartbeat;
      // PostgreSQL cannot grant this renewal before the request begins. A
      // monotonic deadline derived from that lower bound therefore cannot
      // outlive the database lease even when the host wall clock lags the DB.
      const requestedAtMilliseconds = performance.now();
      activeHeartbeat = options.journal!.heartbeatRecoveryClaim(claim, leaseSeconds)
        .then((renewed) => {
          if (!renewed) {
            if (!stopped) lost = true;
            return;
          }
          claim = renewed;
          monotonicLeaseDeadlineMilliseconds = requestedAtMilliseconds
            + leaseSeconds * 1_000
            - PORTABLE_READ_LEASE_SAFETY_MARGIN_MILLISECONDS;
        })
        .catch(() => { if (!stopped) lost = true; })
        .finally(() => { activeHeartbeat = undefined; });
      return activeHeartbeat;
    };
    await pulse();
    if (!current()) throw new Error("portable_staged_input_lease_lost");
    const interval = setInterval(() => { void pulse(); }, Math.max(50, Math.floor(leaseSeconds * 333)));
    interval.unref?.();
    let stopPromise: Promise<void> | undefined;
    const lease: PortableReadLease = Object.freeze({
      current,
      stop() {
        stopPromise ??= (async () => {
          stopped = true;
          clearInterval(interval);
          await activeHeartbeat;
          unregister();
        })();
        return stopPromise;
      }
    });
    unregister = registerPortableReadLease(operationId, lease);
    return lease;
  };
  const closePortableHandles = async (operationId: string): Promise<void> => {
    const leases = activePortableReadLeases.get(operationId);
    activePortableReadLeases.delete(operationId);
    if (leases) await Promise.allSettled([...leases].map((lease) => lease.stop()));
    const handles = activePortableHandles.get(operationId);
    if (!handles) return;
    activePortableHandles.delete(operationId);
    for (const handle of handles) activeStreamHandles.delete(handle);
    const results = await Promise.allSettled([...handles].map((handle) => handle.close()));
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejected) throw rejected.reason;
  };

  const preparePortableFile = async (input: Readonly<{
    ownerUserId: string;
    operationScopeId: string;
    leaseOwner: string;
    expiresAt: string;
    purpose: "portable_staging" | "portable_export";
    directory: "staging" | "exports";
    byteLength?: number;
    maximumBytes?: number;
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  }>) => {
    requireAdapterOpen();
    if (!options.journal || !options.prewrite || !options.candidates) {
      throw new Error("portable_publication_repository_unavailable");
    }
    if ((input.byteLength === undefined) === (input.maximumBytes === undefined)) {
      throw new Error("filesystem_length_invalid");
    }
    const reserved = await options.journal.reserve(
      {
        resourceKind: "portable",
        ownerUserId: input.ownerUserId,
        operationScopeId: input.operationScopeId
      },
      { purpose: input.purpose, leaseOwner: input.leaseOwner, expiresAt: input.expiresAt },
    );
    const operation = reserved.operation;
    if (operation.resourceKind !== "portable"
      || operation.ownerUserId !== input.ownerUserId
      || operation.operationScopeId !== input.operationScopeId
      || operation.purpose !== input.purpose
      || operation.expiresAt !== input.expiresAt
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(operation.operationId)) {
      throw new Error("filesystem_reservation_mismatch");
    }
    const relativePath = `${input.directory}/${operation.operationId}.pending`;
    let handle: FileHandle | undefined;
    let nodeIdentity: Readonly<{ deviceId: string; fileId: string }> | undefined;
    let nodeAuthorityPersisted = false;
    let rollbackPromise: Promise<void> | undefined;
    const rollback = (): Promise<void> => {
      rollbackPromise ??= (async () => {
        const cleanup = await options.journal!.markCleanup(
          operation,
          reserved.claim,
          { cause: "rollback" },
        );
        if (cleanup.outcome !== "cleanup_pending") return;
        // A target-only row has no durable inode identity. Leave it pending for
        // fail-closed quarantine instead of deleting or declaring it cleaned.
        if (!nodeIdentity || !nodeAuthorityPersisted) return;
        await identitySafeDeletePrewrite(archiveRoot, relativePath, nodeIdentity);
        const completed = await options.journal!.completeCleanup(operation, reserved.claim);
        if (!["cleaned", "already_cleaned"].includes(completed.outcome)) {
          throw new Error(`filesystem_cleanup_${completed.outcome}`);
        }
      })();
      return rollbackPromise;
    };
    try {
      await ensureAnchoredDirectory(archiveRoot, input.directory);
      await options.prewrite.recordPrewriteTarget(
        bindPrivatePrewriteTargetAuthority(operation, relativePath),
      );
      handle = await openAnchored(archiveRoot, relativePath, CREATE_FLAGS, 0o600);
      const created = statIdentity(await handle.stat({ bigint: true }) as BigIntStat);
      nodeIdentity = { deviceId: created.deviceId, fileId: created.fileId };
      await options.prewrite.recordPrewriteNode(
        bindPrivatePrewriteNodeAuthority(operation, relativePath, nodeIdentity),
      );
      nodeAuthorityPersisted = true;
      const written = input.byteLength === undefined
        ? await writeBoundedContent(handle, input.source, input.maximumBytes!, input.expiresAt)
        : Object.freeze({
          contentHash: await writeExactContent(handle, input.source, input.byteLength, input.expiresAt),
          byteLength: input.byteLength,
        });
      const value = descriptorFromStat(
        relativePath,
        await handle.stat({ bigint: true }) as BigIntStat,
        written.contentHash,
        written.byteLength,
      );
      await handle.close();
      handle = undefined;
      const candidate = await options.candidates.issuePublicationCandidate(operation, {
        deliveryRelativePath: relativePath,
        cleanupDescriptors: [value]
      });
      await options.candidates.completePublicationCandidate(operation, candidate, value);
      return {
        operation,
        claim: reserved.claim,
        attachment: bindPrivateFilesystemCandidateAttachment(
          operation,
          candidate,
          value,
          reserved.claim,
        ),
        byteLength: written.byteLength,
        contentHash: written.contentHash,
        rollback
      };
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await rollback().catch(() => undefined);
      throw error;
    }
  };

  const prepareAssetPublication: SecureFilesystemAdapter["prepareAssetPublication"] = async (
    command: PrivateAssetPublicationCommand,
    publicationIdentity: PrivateAssetPublicationIdentity,
  ): Promise<PrivatePreparedAssetPublication> => {
    requireAdapterOpen();
    const snapshot = snapshotPrivateAssetPublicationCommand(command);
    validatePrivateAssetPublicationCommand(snapshot);
    verifyPrivateAssetPublicationContentHashes(
      snapshot,
      (bytes) => createHash("sha256").update(bytes).digest("hex"),
    );
    const journal = options.journal;
    const prewrite = options.prewrite;
    const candidates = options.candidates;
    if (!journal || !prewrite || !candidates
      || publicationIdentity.ownerUserId !== snapshot.owner.ownerUserId) {
      throw new Error("asset_publication_repository_unavailable");
    }
    const prepareArtifact = async (
      artifact: PrivateAssetPublicationCommand["original"],
      purpose: "asset_original" | "asset_derivative",
      derivativeIndex: number | null,
    ): Promise<PrivatePreparedAssetPublicationArtifact> => {
      const reserved = await journal.reserve(
        {
          resourceKind: "asset",
          ownerUserId: snapshot.owner.ownerUserId,
          assetId: publicationIdentity.assetId
        },
        { purpose, leaseOwner: snapshot.leaseOwner, expiresAt: snapshot.expiresAt },
      );
      const operation = reserved.operation;
      if (operation.resourceKind !== "asset"
        || operation.ownerUserId !== snapshot.owner.ownerUserId
        || operation.assetId !== publicationIdentity.assetId
        || operation.purpose !== purpose
        || operation.expiresAt !== snapshot.expiresAt
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(operation.operationId)) {
        throw new Error("asset_publication_reservation_mismatch");
      }
      const relativePath = `assets/content/${artifact.contentHash}`;
      let handle: FileHandle | undefined;
      let nodeIdentity: Readonly<{ deviceId: string; fileId: string }> | undefined;
      let nodeAuthorityPersisted = false;
      let rollbackPromise: Promise<void> | undefined;
      const rollback = (): Promise<void> => {
        rollbackPromise ??= (async () => {
          const cleanup = await journal.markCleanup(
            operation,
            reserved.claim,
            { cause: "rollback" },
          );
          if (cleanup.outcome !== "cleanup_pending") return;
          // A target-only prewrite record is not enough authority to delete
          // content-addressed bytes or to report cleanup complete. It may be
          // an EEXIST shared node or a crash before durable inode capture.
          if (!nodeIdentity || !nodeAuthorityPersisted) return;
          await identitySafeDeletePrewrite(assetRoot, relativePath, nodeIdentity);
          const completed = await journal.completeCleanup(operation, reserved.claim);
          if (!["cleaned", "already_cleaned"].includes(completed.outcome)) {
            throw new Error(`filesystem_cleanup_${completed.outcome}`);
          }
        })();
        return rollbackPromise;
      };
      try {
        await ensureAnchoredDirectory(assetRoot, "assets/content");
        await prewrite.recordPrewriteTarget(
          bindPrivatePrewriteTargetAuthority(operation, relativePath),
        );
        let descriptor: PrivateStorageDescriptor;
        try {
          handle = await openAnchored(assetRoot, relativePath, CREATE_FLAGS, 0o600);
          const created = statIdentity(await handle.stat({ bigint: true }) as BigIntStat);
          nodeIdentity = { deviceId: created.deviceId, fileId: created.fileId };
          await prewrite.recordPrewriteNode(
            bindPrivatePrewriteNodeAuthority(operation, relativePath, nodeIdentity),
          );
          nodeAuthorityPersisted = true;
          const contentHash = await writeExactContent(
            handle,
            [artifact.bytes],
            artifact.byteLength,
            snapshot.expiresAt,
          );
          if (contentHash !== artifact.contentHash) throw new Error("asset_publication_hash_mismatch");
          descriptor = descriptorFromStat(
            relativePath,
            await handle.stat({ bigint: true }) as BigIntStat,
            contentHash,
            artifact.byteLength,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          handle = await openAnchored(assetRoot, relativePath);
          descriptor = await verifyContentAddressedFile(
            handle,
            relativePath,
            artifact.contentHash,
            artifact.byteLength,
            snapshot.expiresAt,
          );
        }
        await handle.close();
        handle = undefined;
        const candidate = await candidates.issuePublicationCandidate(operation, {
          deliveryRelativePath: relativePath,
          cleanupDescriptors: [descriptor]
        });
        await candidates.completePublicationCandidate(operation, candidate, descriptor);
        return Object.freeze({
          kind: purpose === "asset_original" ? "original" as const : "derivative" as const,
          derivativeIndex,
          attachment: bindPrivateFilesystemCandidateAttachment(
            operation,
            candidate,
            descriptor,
            reserved.claim,
          ),
          rollback
        });
      } catch (error) {
        if (handle) await handle.close().catch(() => undefined);
        await rollback().catch(() => undefined);
        throw error;
      }
    };

    const original = await prepareArtifact(snapshot.original, "asset_original", null);
    const derivatives: PrivatePreparedAssetPublicationArtifact[] = [];
    try {
      for (const [index, derivative] of snapshot.derivatives.entries()) {
        derivatives.push(await prepareArtifact(derivative, "asset_derivative", index));
      }
      return Object.freeze({ original, derivatives: Object.freeze(derivatives) });
    } catch (error) {
      await Promise.allSettled([original.rollback(), ...derivatives.map((derivative) => derivative.rollback())]);
      throw error;
    }
  };

  /**
   * e5's deliberately narrow alternative to the legacy 0060 whole-asset
   * publisher. The caller supplies an already claimed existing asset and this
   * routine reserves only its thumbnail derivative.
   */
  const prepareMetadataBackfillThumbnail: SecureFilesystemAdapter["prepareMetadataBackfillThumbnail"] = async (
    input,
  ) => {
    requireAdapterOpen();
    const { claim, thumbnail } = input;
    if (!/^[0-9a-f]{64}$/u.test(thumbnail.contentHash)
      || thumbnail.bytes.byteLength !== thumbnail.byteLength
      || thumbnail.byteLength < 1
      || thumbnail.mimeType !== "image/webp"
      || thumbnail.transformVersion !== 1
      || thumbnail.pixelWidth < 1
      || thumbnail.pixelHeight < 1
      || Date.parse(input.expiresAt) <= Date.now()) {
      throw new Error("asset_metadata_backfill_thumbnail_invalid");
    }
    if (createHash("sha256").update(thumbnail.bytes).digest("hex") !== thumbnail.contentHash) {
      throw new Error("asset_metadata_backfill_thumbnail_hash_mismatch");
    }
    const journal = options.journal;
    const prewrite = options.prewrite;
    const candidates = options.candidates;
    const cleanupRepository = options.publicationCleanup;
    if (!journal || !prewrite || !candidates || !cleanupRepository) {
      throw new Error("asset_metadata_backfill_repository_unavailable");
    }
    const reserved = await journal.reserve(
      { resourceKind: "asset", ownerUserId: claim.ownerUserId, assetId: claim.assetId },
      { purpose: "asset_derivative", leaseOwner: claim.leaseOwner, expiresAt: input.expiresAt },
    );
    const operation = reserved.operation;
    if (operation.resourceKind !== "asset"
      || operation.ownerUserId !== claim.ownerUserId
      || operation.assetId !== claim.assetId
      || operation.purpose !== "asset_derivative"
      || operation.expiresAt !== input.expiresAt) {
      throw new Error("asset_metadata_backfill_reservation_mismatch");
    }
    const relativePath = `assets/content/${thumbnail.contentHash}`;
    let handle: FileHandle | undefined;
    let candidateCompleted = false;
    let rollbackPromise: Promise<void> | undefined;
    const rollback = (): Promise<void> => {
      rollbackPromise ??= (async () => {
        const cleanup = await journal.markCleanup(operation, reserved.claim, { cause: "rollback" });
        if (cleanup.outcome !== "cleanup_pending") return;
        // Before a candidate persists a descriptor, target-only evidence is
        // intentionally left for fail-closed durable recovery. After that
        // point cleanup must use the global-reference projection: a
        // content-addressed thumbnail can be retained by another owner.
        if (!candidateCompleted) return;
        const preparedCleanup = await cleanupRepository.preparePublicationCleanup(operation, reserved.claim);
        if (preparedCleanup.outcome === "already_cleaned") return;
        if (preparedCleanup.outcome !== "cleanup_required") {
          throw new Error(`asset_metadata_backfill_cleanup_${preparedCleanup.outcome}`);
        }
        for (const cleanupDescriptor of preparedCleanup.descriptors) {
          await identitySafeDelete(assetRoot, cleanupDescriptor);
        }
        const completed = await journal.completeCleanup(operation, reserved.claim);
        if (!['cleaned', 'already_cleaned'].includes(completed.outcome)) {
          throw new Error(`filesystem_cleanup_${completed.outcome}`);
        }
      })();
      return rollbackPromise;
    };
    try {
      await ensureAnchoredDirectory(assetRoot, "assets/content");
      await prewrite.recordPrewriteTarget(bindPrivatePrewriteTargetAuthority(operation, relativePath));
      let descriptor: PrivateStorageDescriptor;
      try {
        handle = await openAnchored(assetRoot, relativePath, CREATE_FLAGS, 0o600);
        const created = statIdentity(await handle.stat({ bigint: true }) as BigIntStat);
        await prewrite.recordPrewriteNode(bindPrivatePrewriteNodeAuthority(operation, relativePath, {
          deviceId: created.deviceId,
          fileId: created.fileId
        }));
        const contentHash = await writeExactContent(handle, [thumbnail.bytes], thumbnail.byteLength, input.expiresAt);
        if (contentHash !== thumbnail.contentHash) throw new Error("asset_metadata_backfill_thumbnail_hash_mismatch");
        descriptor = descriptorFromStat(
          relativePath,
          await handle.stat({ bigint: true }) as BigIntStat,
          contentHash,
          thumbnail.byteLength,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        handle = await openAnchored(assetRoot, relativePath);
        descriptor = await verifyContentAddressedFile(
          handle,
          relativePath,
          thumbnail.contentHash,
          thumbnail.byteLength,
          input.expiresAt,
        );
      }
      await handle.close();
      handle = undefined;
      const candidate = await candidates.issuePublicationCandidate(operation, {
        deliveryRelativePath: relativePath,
        cleanupDescriptors: [descriptor]
      });
      await candidates.completePublicationCandidate(operation, candidate, descriptor);
      candidateCompleted = true;
      return Object.freeze({
        attachment: bindPrivateFilesystemCandidateAttachment(operation, candidate, descriptor, reserved.claim),
        rollback
      });
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await rollback().catch(() => undefined);
      throw error;
    }
  };

  const finalizeAssetPublication: SecureFilesystemAdapter["finalizeAssetPublication"] = async (finalization) => {
    if (!options.journal) throw new Error("asset_publication_repository_unavailable");
    for (const artifact of finalization) {
      const finalized = await options.journal.finalizeAfterCommit(
        artifact.operation,
        artifact.claim,
      );
      if (!["finalized", "already_finalized"].includes(finalized.outcome)) {
        throw new Error(`asset_publication_finalize_${finalized.outcome}`);
      }
    }
  };

  const discardPreparedAssetPublication: SecureFilesystemAdapter["discardPreparedAssetPublication"] = async (
    prepared,
  ) => {
    const journal = options.journal;
    const cleanupRepository = options.publicationCleanup;
    if (!journal || !cleanupRepository) {
      throw new Error("asset_publication_cleanup_repository_unavailable");
    }
    for (const artifact of [prepared.original, ...prepared.derivatives]) {
      const operation = artifact.attachment.operation;
      const claim = artifact.attachment.claim;
      const marked = await journal.markCleanup(operation, claim, { cause: "rollback" });
      if (marked.outcome === "already_cleaned") continue;
      if (marked.outcome !== "cleanup_pending") {
        throw new Error(`asset_publication_cleanup_${marked.outcome}`);
      }
      const cleanup = await cleanupRepository.preparePublicationCleanup(operation, claim);
      if (cleanup.outcome === "already_cleaned") continue;
      if (cleanup.outcome !== "cleanup_required") {
        throw new Error(`asset_publication_cleanup_${cleanup.outcome}`);
      }
      for (const descriptor of cleanup.descriptors) {
        await identitySafeDelete(assetRoot, descriptor);
      }
      const completed = await journal.completeCleanup(operation, claim);
      if (!["cleaned", "already_cleaned"].includes(completed.outcome)) {
        throw new Error(`asset_publication_cleanup_${completed.outcome}`);
      }
    }
  };

  const stagePortableInput: SecureFilesystemAdapter["stagePortableInput"] = async (input) => {
    if (!options.atomicPortable || !options.journal) {
      throw new Error("portable_publication_repository_unavailable");
    }
    const prepared = await preparePortableFile({
      ownerUserId: input.owner.ownerUserId,
      operationScopeId: input.operationScopeId,
      leaseOwner: input.leaseOwner,
      expiresAt: input.expiresAt,
      purpose: "portable_staging",
      directory: "staging",
      byteLength: input.byteLength,
      source: input.source
    });
    let issued;
    try {
      issued = await options.transactions.run((database) => options.atomicPortable!.issueStagedInput(
        database,
        bindPrivateAtomicStagedIssuance(input.owner, prepared.attachment),
      ));
    } catch (error) {
      await prepared.rollback().catch(() => undefined);
      throw error;
    }
    const finalized = await options.journal.finalizeAfterCommit(issued.operation, issued.claim);
    if (!["finalized", "already_finalized"].includes(finalized.outcome)) {
      throw new Error(`portable_staging_finalize_${finalized.outcome}`);
    }
    return issued;
  };

  const stagePortableScratch: SecureFilesystemAdapter["stagePortableScratch"] = async (input) => {
    if (!options.atomicPortable || !options.journal) {
      throw new Error("portable_publication_repository_unavailable");
    }
    const prepared = await preparePortableFile({
      ownerUserId: input.owner.ownerUserId,
      operationScopeId: input.operationScopeId,
      leaseOwner: input.leaseOwner,
      expiresAt: input.expiresAt,
      purpose: "portable_staging",
      directory: "staging",
      maximumBytes: input.maximumBytes,
      source: input.source
    });
    let issued;
    try {
      issued = await options.transactions.run((database) => options.atomicPortable!.issueStagedInput(
        database,
        bindPrivateAtomicStagedIssuance(input.owner, prepared.attachment),
      ));
    } catch (error) {
      await prepared.rollback().catch(() => undefined);
      throw error;
    }
    const finalized = await options.journal.finalizeAfterCommit(issued.operation, issued.claim);
    if (!["finalized", "already_finalized"].includes(finalized.outcome)) {
      throw new Error(`portable_staging_finalize_${finalized.outcome}`);
    }
    return Object.freeze({
      ...issued,
      byteLength: prepared.byteLength,
      contentHash: prepared.contentHash,
    });
  };

  const discardPortableStagedInput: SecureFilesystemAdapter["discardPortableStagedInput"] = (input) => trackOpen(async () => {
    if (!options.portable) throw new Error("portable_repository_unavailable");
    const rehydration = await options.portable.rehydrateStagedInput(
      input.owner,
      input.stagedInput,
      input.claim,
    );
    if (!rehydration) return;
    await closePortableHandles(rehydration.operation.operationId);
    const preparation = await options.transactions.run(
      (database) => options.portable!.prepareStagedCleanup(database, rehydration),
    );
    if (preparation.outcome === "already_cleaned") return;
    if (preparation.outcome !== "cleanup_required") {
      throw new Error(`portable_staging_${preparation.outcome}`);
    }
    for (const descriptor of preparation.descriptors) {
      await identitySafeDelete(archiveRoot, descriptor);
    }
    const result = await options.transactions.run(
      (database) => options.portable!.acknowledgeStagedCleanup(database, preparation),
    );
    if (!["cleaned", "already_cleaned"].includes(result.outcome)) {
      throw new Error(`portable_staging_cleanup_${result.outcome}`);
    }
  });

  const prepareSystemArchiveUpload: SecureFilesystemAdapter["prepareSystemArchiveUpload"] = async (input) => {
    requireAdapterOpen();
    if (!options.journal || !options.prewrite) {
      throw new Error("system_archive_storage_repository_unavailable");
    }
    const reserved = await options.journal.reserve(
      {
        resourceKind: "portable",
        ownerUserId: input.ownerUserId,
        operationScopeId: input.operationScopeId,
      },
      { purpose: "portable_staging", leaseOwner: input.leaseOwner, expiresAt: input.expiresAt },
    );
    const operation = reserved.operation;
    if (operation.resourceKind !== "portable"
      || operation.ownerUserId !== input.ownerUserId
      || operation.operationScopeId !== input.operationScopeId
      || operation.purpose !== "portable_staging"
      || operation.expiresAt !== input.expiresAt) {
      throw new Error("system_archive_storage_reservation_mismatch");
    }
    const relativePath = `staging/${operation.operationId}.pending`;
    let handle: FileHandle | undefined;
    let identity: Readonly<{ deviceId: string; fileId: string }> | undefined;
    let identityPersisted = false;
    let rollbackPromise: Promise<void> | undefined;
    const rollback = (): Promise<void> => {
      rollbackPromise ??= (async () => {
        const cleanup = await options.journal!.markCleanup(operation, reserved.claim, { cause: "rollback" });
        if (cleanup.outcome !== "cleanup_pending" || !identity || !identityPersisted) return;
        await identitySafeDeletePrewrite(archiveRoot, relativePath, identity);
        const completed = await options.journal!.completeCleanup(operation, reserved.claim);
        if (!["cleaned", "already_cleaned"].includes(completed.outcome)) {
          throw new Error(`system_archive_storage_cleanup_${completed.outcome}`);
        }
      })();
      return rollbackPromise;
    };
    try {
      await ensureAnchoredDirectory(archiveRoot, "staging");
      await options.prewrite.recordPrewriteTarget(
        bindPrivatePrewriteTargetAuthority(operation, relativePath),
      );
      handle = await openAnchored(archiveRoot, relativePath, CREATE_FLAGS, 0o600);
      const created = statIdentity(await handle.stat({ bigint: true }) as BigIntStat);
      identity = Object.freeze({ deviceId: created.deviceId, fileId: created.fileId });
      await options.prewrite.recordPrewriteNode(
        bindPrivatePrewriteNodeAuthority(operation, relativePath, identity),
      );
      identityPersisted = true;
      await handle.sync();
      await handle.close();
      handle = undefined;
      return Object.freeze({ filesystemOperationId: operation.operationId, rollback });
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rollback().catch(() => undefined);
      throw error;
    }
  };

  const publishSystemArchiveUploadChunk: SecureFilesystemAdapter["publishSystemArchiveUploadChunk"] = async (
    input,
    persist,
  ) => {
    requireAdapterOpen();
    if (!options.systemArchiveStorage) throw new Error("system_archive_storage_repository_unavailable");
    if (!Number.isSafeInteger(input.offset) || input.offset < 0
      || input.bytes.byteLength < 1
      || createHash("sha256").update(input.bytes).digest("hex") !== input.sha256) {
      throw new Error("system_archive_chunk_invalid");
    }
    return options.systemArchiveStorage.withUploadLock({
      ownerUserId: input.ownerUserId,
      uploadId: input.uploadId,
      filesystemOperationId: input.filesystemOperationId,
      leaseOwner: input.leaseOwner,
      leaseSeconds: input.leaseSeconds,
    }, async (authority) => {
      if (authority.state !== "assembling") throw new Error("system_archive_upload_already_staged");
      const handle = await openAnchored(archiveRoot, authority.relativePath, UPDATE_FLAGS);
      let originalSize = 0;
      let previous = Buffer.alloc(0);
      try {
        const before = await handle.stat({ bigint: true }) as BigIntStat;
        const beforeIdentity = statIdentity(before);
        if (!before.isFile()
          || beforeIdentity.deviceId !== authority.identity.deviceId
          || beforeIdentity.fileId !== authority.identity.fileId) {
          throw new Error("system_archive_upload_identity_mismatch");
        }
        originalSize = beforeIdentity.byteLength;
        const overlap = Math.max(0, Math.min(input.bytes.byteLength, originalSize - input.offset));
        if (overlap > 0) {
          previous = Buffer.allocUnsafe(overlap);
          const read = await handle.read(previous, 0, overlap, input.offset);
          if (read.bytesRead !== overlap) throw new Error("system_archive_upload_read_partial");
        }
        let written = 0;
        while (written < input.bytes.byteLength) {
          const result = await handle.write(
            input.bytes,
            written,
            input.bytes.byteLength - written,
            input.offset + written,
          );
          if (result.bytesWritten <= 0) throw new Error("system_archive_upload_write_partial");
          written += result.bytesWritten;
        }
        await handle.sync();
        const after = statIdentity(await handle.stat({ bigint: true }) as BigIntStat);
        if (after.deviceId !== authority.identity.deviceId || after.fileId !== authority.identity.fileId) {
          throw new Error("system_archive_upload_identity_mismatch");
        }
        try {
          return await persist();
        } catch (error) {
          let restored = 0;
          while (restored < previous.byteLength) {
            const result = await handle.write(
              previous,
              restored,
              previous.byteLength - restored,
              input.offset + restored,
            );
            if (result.bytesWritten <= 0) throw new Error("system_archive_upload_rollback_partial");
            restored += result.bytesWritten;
          }
          await handle.truncate(originalSize);
          await handle.sync();
          throw error;
        }
      } finally {
        await handle.close();
      }
    });
  };

  const assembleSystemArchiveUpload: SecureFilesystemAdapter["assembleSystemArchiveUpload"] = async (input) => {
    requireAdapterOpen();
    if (!options.systemArchiveStorage || !options.candidates || !options.atomicPortable || !options.journal) {
      throw new Error("system_archive_storage_repository_unavailable");
    }
    return options.systemArchiveStorage.withUploadLock({
      ownerUserId: input.ownerUserId,
      uploadId: input.uploadId,
      filesystemOperationId: input.filesystemOperationId,
      leaseOwner: input.leaseOwner,
      leaseSeconds: input.leaseSeconds,
    }, async (authority) => {
      if (authority.state === "staged") {
        return Object.freeze({
          stagedInputId: authority.stagedInputId,
          byteLength: authority.descriptor.byteLength,
          sha256: authority.descriptor.contentHash,
          async rollback() {},
        });
      }
      const handle = await openAnchored(archiveRoot, authority.relativePath);
      let descriptor: PrivateStorageDescriptor;
      try {
        const initial = await handle.stat({ bigint: true }) as BigIntStat;
        const initialIdentity = statIdentity(initial);
        if (!initial.isFile()
          || initialIdentity.deviceId !== authority.identity.deviceId
          || initialIdentity.fileId !== authority.identity.fileId
          || initialIdentity.byteLength !== input.byteLength) {
          throw new Error("system_archive_upload_identity_mismatch");
        }
        const hash = createHash("sha256");
        const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, input.byteLength)));
        let position = 0;
        while (position < input.byteLength) {
          const requested = Math.min(buffer.byteLength, input.byteLength - position);
          const read = await handle.read(buffer, 0, requested, position);
          if (read.bytesRead !== requested) throw new Error("system_archive_upload_read_partial");
          hash.update(buffer.subarray(0, read.bytesRead));
          position += read.bytesRead;
        }
        const contentHash = hash.digest("hex");
        if (contentHash !== input.sha256) throw new Error("system_archive_upload_hash_mismatch");
        descriptor = descriptorFromStat(
          authority.relativePath,
          await handle.stat({ bigint: true }) as BigIntStat,
          contentHash,
          input.byteLength,
        );
      } finally {
        await handle.close();
      }
      const candidate = await options.candidates!.issuePublicationCandidate(authority.operation, {
        deliveryRelativePath: authority.relativePath,
        cleanupDescriptors: [descriptor],
      });
      await options.candidates!.completePublicationCandidate(authority.operation, candidate, descriptor);
      const attachment = bindPrivateFilesystemCandidateAttachment(
        authority.operation,
        candidate,
        descriptor,
        authority.claim,
      );
      const issued = await options.transactions.run((database) => options.atomicPortable!.issueStagedInput(
        database,
        bindPrivateAtomicStagedIssuance({ ownerUserId: input.ownerUserId }, attachment),
      ));
      const finalized = await options.journal!.finalizeAfterCommit(issued.operation, issued.claim);
      if (!["finalized", "already_finalized"].includes(finalized.outcome)) {
        throw new Error(`system_archive_storage_finalize_${finalized.outcome}`);
      }
      const stagedInputId = await options.systemArchiveStorage!.stagedInputIdForOperation(
        input.ownerUserId,
        input.filesystemOperationId,
      );
      return Object.freeze({
        stagedInputId,
        byteLength: descriptor.byteLength,
        sha256: descriptor.contentHash,
        rollback: () => discardPortableStagedInput({
          owner: { ownerUserId: input.ownerUserId },
          stagedInput: issued.stagedInput,
          claim: { leaseOwner: input.leaseOwner, leaseSeconds: input.leaseSeconds },
        }),
      });
    });
  };

  const publishPortableExport: SecureFilesystemAdapter["publishPortableExport"] = async (input) => {
    if (!options.atomicPortable || !options.journal) {
      throw new Error("portable_publication_repository_unavailable");
    }
    const prepared = await preparePortableFile({
      ownerUserId: input.exportScope.ownerUserId,
      operationScopeId: input.operationScopeId,
      leaseOwner: input.leaseOwner,
      expiresAt: input.expiresAt,
      purpose: "portable_export",
      directory: "exports",
      byteLength: input.byteLength,
      source: input.source
    });
    let issued;
    try {
      issued = await options.transactions.run((database) => options.atomicPortable!.issueExportRetrieval(
        database,
        bindPrivateAtomicExportIssuance(input.exportScope, input.contentType, prepared.attachment),
      ));
    } catch (error) {
      await prepared.rollback().catch(() => undefined);
      throw error;
    }
    const finalized = await options.journal.finalizeAfterCommit(issued.operation, issued.claim);
    if (!["finalized", "already_finalized"].includes(finalized.outcome)) {
      throw new Error(`portable_export_finalize_${finalized.outcome}`);
    }
    return issued;
  };

  const openStagedInputSession: SecureFilesystemAdapter["openStagedInputSession"] = (input) => trackOpen(async () => {
    if (!options.portable || !options.journal) throw new Error("portable_repository_unavailable");
    const rehydration = await options.portable.rehydrateStagedInput(
      input.owner,
      input.stagedInput,
      input.claim,
    );
    if (!rehydration) throw new Error("portable_staged_input_unavailable");
    const readLease = await startPortableReadLease(
      rehydration.operation.operationId,
      rehydration.claim,
      input.claim.leaseSeconds,
    );
    let handle: FileHandle | undefined;
    let unregister: () => void = () => undefined;
    try {
      handle = await openAnchored(archiveRoot, rehydration.descriptor.relativePath);
      const initialStat = await handle.stat({ bigint: true }) as BigIntStat;
      requireDescriptorIdentity(initialStat, rehydration.descriptor);
      unregister = registerPortableHandle(rehydration.operation.operationId, handle);
      return boundedReadSession({
        handle,
        contentType: "application/octet-stream",
        descriptor: rehydration.descriptor,
        initialStat,
        limits: input.limits,
        authorityCurrent: readLease.current,
        onClosed: unregister,
        // Preview reads never consume or delete staging authority. Commit or
        // durable expiry/reaping owns that lifecycle separately.
        afterClose: async () => readLease.stop()
      });
    } catch (error) {
      unregister();
      await handle?.close().catch(() => undefined);
      await readLease.stop();
      throw error;
    }
  });

  const openPreviewInputSession: SecureFilesystemAdapter["openPreviewInputSession"] = (input) => trackOpen(async () => {
    if (!options.portablePreview) throw new Error("portable_preview_repository_unavailable");
    const rehydration = await options.portablePreview.rehydratePreviewInput(
      input.owner,
      input.kind,
      input.previewHandle,
      input.claim,
    );
    if (!rehydration) throw new Error("portable_preview_input_unavailable");
    const handle = await openAnchored(archiveRoot, rehydration.descriptor.relativePath);
    let unregister: () => void = () => undefined;
    try {
      const initialStat = await handle.stat({ bigint: true }) as BigIntStat;
      requireDescriptorIdentity(initialStat, rehydration.descriptor);
      unregister = registerPortableHandle(rehydration.operation.operationId, handle);
      return boundedReadSession({
        handle,
        contentType: "application/octet-stream",
        descriptor: rehydration.descriptor,
        initialStat,
        limits: input.limits,
        onClosed: unregister,
        afterClose: async () => undefined
      });
    } catch (error) {
      unregister();
      await handle.close().catch(() => undefined);
      throw error;
    }
  });

  const openExportSession: SecureFilesystemAdapter["openExportSession"] = (input) => trackOpen(async () => {
    if (!options.portable) throw new Error("portable_repository_unavailable");
    const rehydration = await options.portable.rehydrateExportArtifact(
      input.scope,
      input.retrieval,
      input.claim,
    );
    if (!rehydration) throw new Error("portable_export_unavailable");
    const preparation = await options.transactions.run(
      (database) => options.portable!.prepareExportCleanup(database, rehydration),
    );
    if (preparation.outcome !== "cleanup_required") {
      throw new Error(`portable_export_${preparation.outcome}`);
    }
    let handle: FileHandle | undefined;
    let unregister: () => void = () => undefined;
    const acknowledge = async (): Promise<void> => {
      for (const descriptor of preparation.descriptors) {
        await identitySafeDelete(archiveRoot, descriptor);
      }
      const result = await options.transactions.run(
        (database) => options.portable!.acknowledgeExportCleanup(database, preparation),
      );
      if (!["cleaned", "already_cleaned"].includes(result.outcome)) {
        throw new Error(`portable_export_cleanup_${result.outcome}`);
      }
    };
    try {
      handle = await openAnchored(archiveRoot, rehydration.descriptor.relativePath);
      const initialStat = await handle.stat({ bigint: true }) as BigIntStat;
      requireDescriptorIdentity(initialStat, rehydration.descriptor);
      unregister = registerPortableHandle(rehydration.operation.operationId, handle);
      return boundedReadSession({
        handle,
        contentType: rehydration.identity.contentType,
        descriptor: rehydration.descriptor,
        initialStat,
        limits: input.limits,
        onClosed: unregister,
        afterClose: acknowledge
      });
    } catch (error) {
      unregister();
      if (handle) await handle.close().catch(() => undefined);
      await acknowledge();
      throw error;
    }
  });

  const openAssetSession: SecureFilesystemAdapter["openAssetSession"] = (input) => trackOpen(async () => {
    if (!options.delivery) throw new Error("asset_delivery_repository_unavailable");
    const resolution = await options.delivery.resolveFinalizedAssetDelivery(input.scope, input.request);
    if (!resolution) return null;
    const value = resolution.kind === "durable_finalized"
      ? await options.delivery.redeemFinalizedDeliveryGrant(input.scope, input.request, resolution.grant)
      : await options.delivery.redeemLegacyAnchoredRead(input.scope, input.request, resolution.anchoredRead);
    if (!value) throw new Error("asset_delivery_unavailable");
    const handle = await openAnchored(assetRoot, value.relativePath);
    let unregister: () => void = () => undefined;
    try {
      const initialStat = await handle.stat({ bigint: true }) as BigIntStat;
      if (resolution.kind === "durable_finalized") {
        requireDescriptorIdentity(initialStat, value as PrivateStorageDescriptor);
      } else if (!initialStat.isFile() || statIdentity(initialStat).byteLength !== value.byteLength) {
        throw new Error("filesystem_identity_mismatch");
      }
      unregister = registerStreamHandle(handle);
      return boundedReadSession({
        handle,
        contentType: resolution.descriptor.mimeType,
        descriptor: value,
        initialStat,
        limits: input.limits,
        allowLegacyBase64Hash: resolution.kind === "legacy_retained",
        onClosed: unregister,
        afterClose: async () => undefined
      });
    } catch (error) {
      unregister();
      await handle.close().catch(() => undefined);
      throw error;
    }
  });

  const openLegacyPathV1Preview: SecureFilesystemAdapter["openLegacyPathV1Preview"] = (input) => trackOpen(async () => {
    if (input.descriptor.kind !== "legacy_path_v1") {
      throw new Error("legacy_path_v1_descriptor_invalid");
    }
    const handle = await openAnchored(archiveRoot, input.descriptor.relativePath);
    let unregister: () => void = () => undefined;
    try {
      const initialStat = await handle.stat({ bigint: true }) as BigIntStat;
      if (!initialStat.isFile() || statIdentity(initialStat).byteLength !== input.descriptor.byteLength) {
        throw new Error("filesystem_identity_mismatch");
      }
      unregister = registerStreamHandle(handle);
      return boundedReadSession({
        handle,
        contentType: input.descriptor.contentType,
        descriptor: input.descriptor,
        initialStat,
        limits: input.limits,
        onClosed: unregister,
        afterClose: async () => undefined
      });
    } catch (error) {
      unregister();
      await handle.close().catch(() => undefined);
      throw error;
    }
  });

  const claimExpiredPortableRecoveries: SecureFilesystemAdapter["claimExpiredPortableRecoveries"] = async (input) => {
    requireAdapterOpen();
    if (!options.expiry) {
      throw new Error("portable_reaper_repository_unavailable");
    }
    return options.expiry.claimExpiredPortableWork(input);
  };

  const reapExpiredPortable: SecureFilesystemAdapter["reapExpiredPortable"] = async (input) => {
    requireAdapterOpen();
    if (!options.journal) throw new Error("portable_reaper_repository_unavailable");
    const recoveries = await claimExpiredPortableRecoveries(input);
    let cleaned = 0;
    let pending = 0;
    for (const initialRecovery of recoveries) {
      const renewed = await options.journal.heartbeatRecoveryClaim(initialRecovery.claim, input.leaseSeconds);
      if (!renewed) {
        pending += 1;
        continue;
      }
      let recovery = Object.freeze({ ...initialRecovery, claim: renewed }) as DurableFilesystemRecoveryRecord;
      let heartbeatLost = false;
      let terminal = false;
      let activeHeartbeat: Promise<void> | undefined;
      const pulse = (): Promise<void> => {
        activeHeartbeat ??= options.journal!.heartbeatRecoveryClaim(recovery.claim, input.leaseSeconds)
          .then((next) => {
            if (!next) {
              if (!terminal) heartbeatLost = true;
              return;
            }
            recovery = Object.freeze({ ...recovery, claim: next }) as DurableFilesystemRecoveryRecord;
          })
          .catch(() => { if (!terminal) heartbeatLost = true; })
          .finally(() => { activeHeartbeat = undefined; });
        return activeHeartbeat;
      };
      const interval = setInterval(() => { void pulse(); }, Math.max(50, Math.floor(input.leaseSeconds * 333)));
      try {
        const outcome = await recoverFilesystemOperation(
          recovery,
          () => heartbeatLost ? null : recovery,
        );
        terminal = ["cleaned", "quarantined", "finalized"].includes(outcome.outcome);
        if (outcome.outcome === "cleaned") {
          cleaned += 1;
        } else {
          pending += 1;
        }
      } catch {
        pending += 1;
      } finally {
        clearInterval(interval);
        await activeHeartbeat;
      }
    }
    return Object.freeze({ claimed: recoveries.length, cleaned, pending });
  };

  const recoverFilesystemOperation: SecureFilesystemAdapter["recoverFilesystemOperation"] = async (
    recovery,
    currentRecovery = () => recovery,
  ) => {
    requireAdapterOpen();
    const journal = options.journal;
    if (!journal || !options.prewrite) {
      throw new Error("filesystem_recovery_repository_unavailable");
    }
    const latest = (): DurableFilesystemRecoveryRecord | null => {
      const current = currentRecovery();
      if (!current) return null;
      // Portable recovery makes a second record authoritative during expiry
      // claim preparation. Never let a stale worker borrow a rotated claim.
      if (recovery.operation.resourceKind !== "portable") return current;
      if (current.action !== recovery.action
        || current.operation.operationId !== recovery.operation.operationId
        || current.operation.resourceKind !== recovery.operation.resourceKind
        || current.claim.leaseId !== recovery.claim.leaseId
        || current.claim.leaseOwner !== recovery.claim.leaseOwner
        || current.claim.workVersion !== recovery.claim.workVersion) return null;
      return current;
    };
    const cleanupDiagnostic = async (code: NonNullable<PrivateFilesystemRecoveryOutcome["diagnosticCode"]>): Promise<void> => {
      const current = latest();
      if (!current) return;
      await journal.markCleanup(current.operation, current.claim, { cause: "recovery", diagnosticCode: code }).catch(() => undefined);
    };
    try {
      const initial = latest();
      if (!initial) return Object.freeze({ outcome: "lease_lost" });
      if (initial.action === "finalize") {
        const finalized = await journal.finalizeAfterCommit(initial.operation, initial.claim);
        return Object.freeze({ outcome: finalized.outcome === "already_finalized" ? "finalized" : finalized.outcome });
      }
      if (initial.operation.resourceKind === "portable") {
        await closePortableHandles(initial.operation.operationId);
        const preparedRecovery = latest();
        if (!preparedRecovery) return Object.freeze({ outcome: "lease_lost" });
        if (Object.hasOwn(preparedRecovery.operation, "expiresAt")) {
          const prewrite = await options.transactions.run(
            (database) => options.prewrite!.preparePrewriteCleanup(database, preparedRecovery),
          );
          if (prewrite.outcome === "quarantined") return Object.freeze({ outcome: "quarantined" });
          if (prewrite.outcome !== "cleanup_required") {
            return Object.freeze({ outcome: prewrite.outcome === "already_cleaned" ? "cleaned" : prewrite.outcome });
          }
          if (!latest()) return Object.freeze({ outcome: "lease_lost" });
          await identitySafeDeletePrewrite(archiveRoot, prewrite.relativePath, prewrite.identity);
          const completionRecovery = latest();
          if (!completionRecovery) return Object.freeze({ outcome: "lease_lost" });
          const completed = await journal.completeCleanup(prewrite.operation, completionRecovery.claim);
          return Object.freeze({ outcome: completed.outcome === "already_cleaned" ? "cleaned" : completed.outcome });
        }
        if (!options.portable) throw new Error("portable_reaper_repository_unavailable");
        const portable = await options.transactions.run(
          (database) => options.portable!.prepareRecoveryCleanup(database, preparedRecovery),
        );
        if (portable.outcome !== "cleanup_required") {
          return Object.freeze({ outcome: portable.outcome === "already_cleaned" ? "cleaned" : portable.outcome });
        }
        for (const descriptor of portable.descriptors) {
          const current = latest();
          if (!current) return Object.freeze({ outcome: "lease_lost" });
          await options.recoveryHooks?.beforePhysicalDelete?.({ recovery: current, descriptor });
          if (!latest()) return Object.freeze({ outcome: "lease_lost" });
          await identitySafeDelete(archiveRoot, descriptor);
          if (!latest()) return Object.freeze({ outcome: "lease_lost" });
        }
        const acknowledgementRecovery = latest();
        if (!acknowledgementRecovery) return Object.freeze({ outcome: "lease_lost" });
        // A heartbeat changes the exact expiry-bearing claim. Re-prepare using
        // that latest claim, then fence the acknowledgement with it as well.
        const acknowledgementPreparation = await options.transactions.run(
          (database) => options.portable!.prepareRecoveryCleanup(database, acknowledgementRecovery),
        );
        if (acknowledgementPreparation.outcome !== "cleanup_required") {
          return Object.freeze({ outcome: acknowledgementPreparation.outcome === "already_cleaned"
            ? "cleaned"
            : acknowledgementPreparation.outcome });
        }
        if (!latest()) return Object.freeze({ outcome: "lease_lost" });
        const acknowledged = acknowledgementPreparation.identity.portableKind === "staged_input"
          ? await options.transactions.run((database) => options.portable!.acknowledgeStagedCleanup(
            database,
            acknowledgementPreparation as PrivatePortableStagedCleanupPreparation,
          ))
          : await options.transactions.run((database) => options.portable!.acknowledgeExportCleanup(
            database,
            acknowledgementPreparation as PrivatePortableExportCleanupPreparation,
          ));
        return Object.freeze({ outcome: acknowledged.outcome === "already_cleaned" ? "cleaned" : acknowledged.outcome });
      }
      if (initial.operation.resourceKind !== "asset") {
        return Object.freeze({ outcome: "recoverable", diagnosticCode: "asset_storage_unavailable" });
      }
      if (!options.publicationCleanup) throw new Error("filesystem_recovery_repository_unavailable");
      const marked = await journal.markCleanup(initial.operation, initial.claim, { cause: "recovery" });
      if (marked.outcome === "already_cleaned") return Object.freeze({ outcome: "cleaned" });
      if (marked.outcome !== "cleanup_pending") return Object.freeze({ outcome: marked.outcome });

      const preparedRecovery = latest();
      if (!preparedRecovery) return Object.freeze({ outcome: "lease_lost" });
      if (Object.hasOwn(preparedRecovery.operation, "expiresAt")) {
        const prewrite = await options.transactions.run(
          (database) => options.prewrite!.preparePrewriteCleanup(database, preparedRecovery),
        );
        if (prewrite.outcome === "quarantined") return Object.freeze({ outcome: "quarantined" });
        if (prewrite.outcome === "cleanup_required") {
          if (!latest()) return Object.freeze({ outcome: "lease_lost" });
          await identitySafeDeletePrewrite(assetRoot, prewrite.relativePath, prewrite.identity);
          const completionRecovery = latest();
          if (!completionRecovery) return Object.freeze({ outcome: "lease_lost" });
          const completed = await journal.completeCleanup(prewrite.operation, completionRecovery.claim);
          return Object.freeze({ outcome: completed.outcome === "already_cleaned" ? "cleaned" : completed.outcome });
        }
        return Object.freeze({ outcome: prewrite.outcome === "already_cleaned" ? "cleaned" : prewrite.outcome });
      }

      const cleanup = await options.publicationCleanup.preparePublicationCleanup(preparedRecovery.operation, preparedRecovery.claim);
      if (cleanup.outcome === "cleanup_required") {
        if (!latest()) return Object.freeze({ outcome: "lease_lost" });
        for (const descriptor of cleanup.descriptors) {
          await identitySafeDelete(assetRoot, descriptor);
        }
        const completionRecovery = latest();
        if (!completionRecovery) return Object.freeze({ outcome: "lease_lost" });
        const completed = await journal.completeCleanup(preparedRecovery.operation, completionRecovery.claim);
        return Object.freeze({ outcome: completed.outcome === "already_cleaned" ? "cleaned" : completed.outcome });
      }
      return Object.freeze({ outcome: cleanup.outcome === "already_cleaned" ? "cleaned" : cleanup.outcome });
    } catch (error) {
      const diagnosticCode: AssetFilesystemDiagnosticCode = recoveryDiagnostic(error);
      // An attached operation selected for post-commit finalization already
      // has a durable asset reference. A transient finalization fault must
      // leave that attached state available to a fresh fenced recovery; only
      // cleanup recovery may convert an operation into cleanup_pending.
      if (recovery.action === "cleanup") await cleanupDiagnostic(diagnosticCode);
      return Object.freeze({ outcome: "recoverable", diagnosticCode });
    }
  };

  let closed: Promise<void> | undefined;
  return Object.freeze({
    prepareAssetPublication,
    prepareMetadataBackfillThumbnail,
    discardPreparedAssetPublication,
    finalizeAssetPublication,
    stagePortableInput,
    stagePortableScratch,
    prepareSystemArchiveUpload,
    publishSystemArchiveUploadChunk,
    assembleSystemArchiveUpload,
    discardPortableStagedInput,
    publishPortableExport,
    openStagedInputSession,
    openPreviewInputSession,
    openExportSession,
    openAssetSession,
    openLegacyPathV1Preview,
    reapExpiredPortable,
    claimExpiredPortableRecoveries,
    recoverFilesystemOperation,
    close() {
      closing = true;
      const streamHandles = [...activeStreamHandles];
      const portableReadLeases = [...activePortableReadLeases.values()].flatMap((leases) => [...leases]);
      const pendingOpens = [...inFlightOpens];
      activeStreamHandles.clear();
      activePortableHandles.clear();
      activePortableReadLeases.clear();
      closed ??= (async () => {
        const leaseResults = await Promise.allSettled(
          portableReadLeases.map((lease) => lease.stop()),
        );
        const streamResults = await Promise.allSettled(
          streamHandles.map((handle) => handle.close()),
        );
        await Promise.all(pendingOpens);
        const rootResults = await Promise.allSettled([
          archiveRoot.handle.close(),
          assetRoot.handle.close()
        ]);
        const rejected = [...leaseResults, ...streamResults, ...rootResults]
          .find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (rejected) throw rejected.reason;
      })();
      return closed;
    }
  });
}
