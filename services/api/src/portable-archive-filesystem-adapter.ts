import { createHash } from "node:crypto";
import { constants as filesystemConstants } from "node:fs";
import { lstat, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
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
  DurableFilesystemTransactionContext,
  PrivateStorageDescriptor,
  ReservedFilesystemOperation
} from "../../../packages/application/src/assets/private-storage-lifecycle.js";
import {
  bindPrivatePrewriteNodeAuthority,
  bindPrivatePrewriteTargetAuthority
} from "../../../packages/application/src/assets/private-secure-storage.js";
import {
  bindPrivateFilesystemCandidateAttachment,
  type PrivateFilesystemCandidatePersistencePort
} from "../../../packages/application/src/assets/private-filesystem-repository.js";
import type { FinalizedAssetDeliveryResolverPort } from "../../../packages/application/src/assets/private-finalized-delivery.js";
import type { AssetDeliveryRequest, AssetScope } from "../../../packages/application/src/assets/types.js";
import type {
  PrivatePortableExportCleanupPreparation,
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
import type { PortableArchiveExportRetrieval } from "../../../packages/application/src/imports/types.js";
import type { ImportOwnerScope, PortableStagedInput } from "../../../packages/application/src/imports/types.js";

const READ_FLAGS = filesystemConstants.O_RDONLY | filesystemConstants.O_NOFOLLOW;
const DIRECTORY_FLAGS = READ_FLAGS | filesystemConstants.O_DIRECTORY;
const CREATE_FLAGS = filesystemConstants.O_WRONLY
  | filesystemConstants.O_CREAT
  | filesystemConstants.O_EXCL
  | filesystemConstants.O_NOFOLLOW;

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
  delivery?: FinalizedAssetDeliveryResolverPort;
  journal?: DurableFilesystemJournalPort;
  candidates?: PrivateFilesystemCandidatePersistencePort;
  atomicPortable?: PrivateAtomicPortableIssuancePort;
  prewrite?: PrivatePrewriteNodeRepositoryPort;
  expiry?: PrivatePortableExpiryRecoveryPort;
  transactions: SecureFilesystemTransactionRunner;
}>;

export type SecureFilesystemAdapter = Readonly<{
  prepareAssetPublication: PrivateAssetPublicationFilesystemPort["prepareAssetPublication"];
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
        position += bytesRead;
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
      if (hash.digest("hex") !== input.descriptor.contentHash) {
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
  const closePortableHandles = async (operationId: string): Promise<void> => {
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
    byteLength: number;
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  }>) => {
    requireAdapterOpen();
    if (!options.journal || !options.prewrite || !options.candidates) {
      throw new Error("portable_publication_repository_unavailable");
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
      const contentHash = await writeExactContent(
        handle,
        input.source,
        input.byteLength,
        input.expiresAt,
      );
      const value = descriptorFromStat(
        relativePath,
        await handle.stat({ bigint: true }) as BigIntStat,
        contentHash,
        input.byteLength,
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

  const reapExpiredPortable: SecureFilesystemAdapter["reapExpiredPortable"] = async (input) => {
    requireAdapterOpen();
    if (!options.expiry || !options.portable || !options.prewrite || !options.journal) {
      throw new Error("portable_reaper_repository_unavailable");
    }
    const recoveries = await options.expiry.claimExpiredPortableWork(input);
    let cleaned = 0;
    let pending = 0;
    for (const recovery of recoveries) {
      try {
        await closePortableHandles(recovery.operation.operationId);
        const portable = await options.transactions.run(
          (database) => options.portable!.prepareRecoveryCleanup(database, recovery),
        );
        if (portable.outcome === "cleanup_required") {
          for (const value of portable.descriptors) {
            await identitySafeDelete(archiveRoot, value);
          }
          const acknowledged = portable.identity.portableKind === "staged_input"
            ? await options.transactions.run((database) => options.portable!.acknowledgeStagedCleanup(
              database,
              portable as PrivatePortableStagedCleanupPreparation,
            ))
            : await options.transactions.run((database) => options.portable!.acknowledgeExportCleanup(
              database,
              portable as PrivatePortableExportCleanupPreparation,
            ));
          if (!["cleaned", "already_cleaned"].includes(acknowledged.outcome)) {
            throw new Error(`portable_reaper_ack_${acknowledged.outcome}`);
          }
          cleaned += 1;
          continue;
        }
        const prewrite = await options.transactions.run(
          (database) => options.prewrite!.preparePrewriteCleanup(database, recovery),
        );
        if (prewrite.outcome !== "cleanup_required") {
          pending += 1;
          continue;
        }
        await identitySafeDeletePrewrite(
          archiveRoot,
          prewrite.relativePath,
          prewrite.identity,
        );
        const completed = await options.journal.completeCleanup(prewrite.operation, prewrite.claim);
        if (!["cleaned", "already_cleaned"].includes(completed.outcome)) {
          throw new Error(`portable_reaper_complete_${completed.outcome}`);
        }
        cleaned += 1;
      } catch {
        pending += 1;
      }
    }
    return Object.freeze({ claimed: recoveries.length, cleaned, pending });
  };

  let closed: Promise<void> | undefined;
  return Object.freeze({
    prepareAssetPublication,
    finalizeAssetPublication,
    stagePortableInput,
    publishPortableExport,
    openExportSession,
    openAssetSession,
    openLegacyPathV1Preview,
    reapExpiredPortable,
    close() {
      closing = true;
      const streamHandles = [...activeStreamHandles];
      const pendingOpens = [...inFlightOpens];
      activeStreamHandles.clear();
      activePortableHandles.clear();
      closed ??= (async () => {
        const streamResults = await Promise.allSettled(
          streamHandles.map((handle) => handle.close()),
        );
        await Promise.all(pendingOpens);
        const rootResults = await Promise.allSettled([
          archiveRoot.handle.close(),
          assetRoot.handle.close()
        ]);
        const rejected = [...streamResults, ...rootResults]
          .find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (rejected) throw rejected.reason;
      })();
      return closed;
    }
  });
}
