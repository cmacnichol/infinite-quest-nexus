import { createHash, randomUUID } from "node:crypto";
import { constants as filesystemConstants } from "node:fs";
import {
  link,
  lstat,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { Readable } from "node:stream";
import sharp from "sharp";
import type { ArchiveEntry, ArchiveManifest, ArchiveType } from "../../../packages/contracts/src/archives.js";
import type {
  AssetFilesystemDiagnosticCode,
  AssetLibraryItemView
} from "../../../packages/application/src/assets/types.js";
import type {
  ImportOwnerScope,
  PortableArchiveDiagnosticCode,
  PortableArchiveExportRetrieval,
  PortableArchiveExportView,
  PortableStagedInput
} from "../../../packages/application/src/imports/types.js";
import {
  toPortableArchiveExportRetrieval,
  toPortableStagedInput
} from "../../../packages/application/src/imports/types.js";
import type {
  PortableArchiveStagingPort,
  PortableArchiveUploadCapability
} from "../../../packages/application/src/imports/portable-archive-staging.js";
import {
  ArchiveError,
  inspectArchive,
  inspectArchiveContainer,
  releaseAnchoredStagedArchive,
  readVerifiedContainerEntry,
  readVerifiedEntry,
  stageAnchoredArchiveUpload,
  stagedArchiveIdentity,
  writeArchiveArtifact,
  type ArchiveFileIdentity,
  type ArchiveArtifactEntry,
  type ArchiveLimits,
  type CompletedArchiveArtifact,
  type InspectedArchive,
  type InspectedArchiveContainer,
  type StagedArchive
} from "./archive-io.js";

type SafeDiagnosticCode = PortableArchiveDiagnosticCode | AssetFilesystemDiagnosticCode;

export type SafeFilesystemCapabilityFailure = Readonly<{
  code: SafeDiagnosticCode;
}>;

export type PortableArchiveInspectionView = Readonly<{
  archiveType: ArchiveType | "container";
  entries: readonly Readonly<{
    path: string;
    mediaType: string | null;
    compressedBytes: number;
    uncompressedBytes: number;
    sha256: string | null;
  }>[];
  uncompressedBytes: number;
}>;

export type ExtractedPortableArchiveEntry = Readonly<{
  content: Uint8Array;
  byteLength: number;
  sha256: string;
}>;

export type VerifiedFilesystemAsset = Readonly<{
  content: Uint8Array;
  mimeType: AssetLibraryItemView["mimeType"];
  byteLength: number;
  contentHash: string;
  width: number;
  height: number;
  format: string;
  pages: number;
  orientation: number | null;
}>;

export type VerifiedAssetRead = Readonly<{
  relativePath: string;
  mimeType: AssetLibraryItemView["mimeType"];
  expectedByteLength: number;
  expectedContentHash: string;
  maximumBytes: number;
}>;

export type PortableArchiveFilesystemAdapter = Readonly<{
  stagingPort: PortableArchiveStagingPort;
  issueOwnerBoundUpload(
    owner: ImportOwnerScope,
    source: NodeJS.ReadableStream,
    byteLength: number
  ): PortableArchiveUploadCapability;
  inspectPortableArchive(
    owner: ImportOwnerScope,
    stagedInput: PortableStagedInput,
    expectedType: ArchiveType | "container"
  ): Promise<PortableArchiveInspectionView>;
  extractVerifiedEntry(
    owner: ImportOwnerScope,
    stagedInput: PortableStagedInput,
    path: string,
    maximumBytes: number
  ): Promise<ExtractedPortableArchiveEntry>;
  cleanupStagedInput(owner: ImportOwnerScope, stagedInput: PortableStagedInput): Promise<void>;
  publishArchiveArtifact(
    owner: ImportOwnerScope,
    entries: readonly ArchiveArtifactEntry[],
    buildManifest: (entries: readonly ArchiveEntry[]) => ArchiveManifest
  ): Promise<PortableArchiveExportView>;
  readExportArtifact(
    owner: ImportOwnerScope,
    retrieval: PortableArchiveExportRetrieval,
    maximumBytes: number
  ): Promise<Readonly<{
    content: Uint8Array;
    contentType: "application/zip";
    byteLength: number;
    sha256: string;
  }>>;
  cleanupExportArtifact(owner: ImportOwnerScope, retrieval: PortableArchiveExportRetrieval): Promise<void>;
  readVerifiedAsset(input: VerifiedAssetRead): Promise<VerifiedFilesystemAsset>;
}>;

export type PortableArchiveFilesystemOptions = Readonly<{
  archiveRoot: string;
  assetRoot: string;
  limits: ArchiveLimits;
  platform?: NodeJS.Platform;
  maxImagePixels?: number;
  maxImagePages?: number;
}>;

type FileIdentity = Readonly<ArchiveFileIdentity>;

type UploadRecord = Readonly<{
  ownerUserId: string;
  source: NodeJS.ReadableStream;
  byteLength: number;
}>;

type StagedRecord = {
  ownerUserId: string;
  staged: StagedArchive;
  identity: FileIdentity;
  inspection?: InspectedArchive | InspectedArchiveContainer;
  inspectionKind?: ArchiveType | "container";
};

type ArtifactRecord = Readonly<{
  ownerUserId: string;
  relativePath: string;
  identity: FileIdentity;
  byteLength: number;
  sha256: string;
}>;

class CapabilityFault extends Error {
  constructor(readonly code: SafeDiagnosticCode) {
    super(code);
  }
}

const ALLOWED_IMAGE_SIGNATURES: Readonly<Record<AssetLibraryItemView["mimeType"], (bytes: Buffer) => boolean>> = {
  "image/png": (bytes) => bytes.byteLength >= 8
    && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (bytes) => bytes.byteLength >= 3
    && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "image/webp": (bytes) => bytes.byteLength >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP",
  "image/gif": (bytes) => bytes.byteLength >= 6
    && (bytes.subarray(0, 6).toString("ascii") === "GIF87a"
      || bytes.subarray(0, 6).toString("ascii") === "GIF89a")
};
const IMAGE_FORMATS: Readonly<Record<AssetLibraryItemView["mimeType"], string>> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
  "image/gif": "gif"
};
const DEFAULT_MAX_IMAGE_PIXELS = 40_000_000;
const DEFAULT_MAX_IMAGE_PAGES = 100;

function safeFailure(code: SafeDiagnosticCode): SafeFilesystemCapabilityFailure {
  return Object.freeze({ code });
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function requireOwner(owner: ImportOwnerScope): string {
  if (!owner || typeof owner.ownerUserId !== "string" || owner.ownerUserId.trim().length === 0) {
    throw new CapabilityFault("archive_unavailable");
  }
  return owner.ownerUserId;
}

function identityOf(value: Awaited<ReturnType<FileHandle["stat"]>>): FileIdentity {
  const stat = value as Awaited<ReturnType<FileHandle["stat"]>> & {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  };
  return {
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    modifiedNanoseconds: stat.mtimeNs,
    changedNanoseconds: stat.ctimeNs
  };
}

function sameObject(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return sameObject(left, right)
    && left.size === right.size
    && left.modifiedNanoseconds === right.modifiedNanoseconds
    && left.changedNanoseconds === right.changedNanoseconds;
}

function sameRenamedIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return sameObject(left, right)
    && left.size === right.size
    && left.modifiedNanoseconds === right.modifiedNanoseconds;
}

function validateRelativePath(relativePath: string): readonly string[] {
  if (typeof relativePath !== "string"
    || relativePath.length === 0
    || isAbsolute(relativePath)
    || relativePath.startsWith("/")
    || /^[A-Za-z]:/.test(relativePath)
    || relativePath.includes("\\")
    || /\p{Cc}/u.test(relativePath)) {
    throw new CapabilityFault("filesystem_path_invalid");
  }
  const segments = relativePath.normalize("NFC").split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new CapabilityFault("filesystem_path_invalid");
  }
  return segments;
}

async function closeHandle(handle: FileHandle | undefined): Promise<void> {
  if (!handle) return;
  try {
    await handle.close();
  } catch {
    // A prior capability failure remains authoritative and contains no raw I/O detail.
  }
}

function descriptorPath(handle: FileHandle, child: string): string {
  return `/proc/self/fd/${handle.fd}/${child}`;
}

async function openDirectoryAnchor(path: string): Promise<FileHandle> {
  let handle: FileHandle | undefined;
  try {
    const before = await lstat(path, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new CapabilityFault("filesystem_link_denied");
    }
    handle = await open(
      path,
      filesystemConstants.O_RDONLY | filesystemConstants.O_DIRECTORY | filesystemConstants.O_NOFOLLOW
    );
    const opened = await handle.stat({ bigint: true });
    const after = await lstat(path, { bigint: true });
    if (!opened.isDirectory()
      || after.isSymbolicLink()
      || !after.isDirectory()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.dev !== after.dev
      || opened.ino !== after.ino) {
      throw new CapabilityFault("filesystem_race_detected");
    }
    return handle;
  } catch (error) {
    await closeHandle(handle);
    if (error instanceof CapabilityFault) throw error;
    throw new CapabilityFault("asset_storage_unavailable");
  }
}

async function openAnchoredParent(rootPath: string, segments: readonly string[]): Promise<{
  parent: FileHandle;
  filename: string;
}> {
  if (segments.length === 0) throw new CapabilityFault("filesystem_path_invalid");
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(resolve(rootPath));
  } catch {
    throw new CapabilityFault("asset_storage_unavailable");
  }

  let current = await openDirectoryAnchor(canonicalRoot);
  try {
    const anchoredRoot = await realpath(`/proc/self/fd/${current.fd}`);
    if (anchoredRoot !== canonicalRoot) throw new CapabilityFault("filesystem_race_detected");
    for (const segment of segments.slice(0, -1)) {
      const next = await openDirectoryAnchor(descriptorPath(current, segment));
      await closeHandle(current);
      current = next;
    }
    return { parent: current, filename: segments[segments.length - 1]! };
  } catch (error) {
    await closeHandle(current);
    throw error;
  }
}

async function openAnchoredRegularFile(rootPath: string, relativePath: string): Promise<{
  handle: FileHandle;
  identity: FileIdentity;
}> {
  const segments = validateRelativePath(relativePath);
  const { parent, filename } = await openAnchoredParent(rootPath, segments);
  let handle: FileHandle | undefined;
  try {
    const path = descriptorPath(parent, filename);
    const before = await lstat(path, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new CapabilityFault("filesystem_link_denied");
    }
    handle = await open(path, filesystemConstants.O_RDONLY | filesystemConstants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    const after = await lstat(path, { bigint: true });
    const openedIdentity = identityOf(opened);
    const beforeIdentity = identityOf(before as never);
    const afterIdentity = identityOf(after as never);
    if (!opened.isFile()
      || after.isSymbolicLink()
      || !after.isFile()
      || !sameIdentity(openedIdentity, beforeIdentity)
      || !sameIdentity(openedIdentity, afterIdentity)) {
      throw new CapabilityFault("filesystem_race_detected");
    }
    return { handle, identity: openedIdentity };
  } catch (error) {
    await closeHandle(handle);
    if (error instanceof CapabilityFault) throw error;
    throw new CapabilityFault("asset_storage_unavailable");
  } finally {
    await closeHandle(parent);
  }
}

async function readStableFile(
  rootPath: string,
  relativePath: string,
  maximumBytes: number,
  expectedIdentity?: FileIdentity
): Promise<{ bytes: Buffer; identity: FileIdentity }> {
  if (!safeInteger(maximumBytes)) throw new CapabilityFault("asset_too_large");
  const opened = await openAnchoredRegularFile(rootPath, relativePath);
  try {
    if (expectedIdentity && !sameIdentity(opened.identity, expectedIdentity)) {
      throw new CapabilityFault("filesystem_race_detected");
    }
    if (opened.identity.size > BigInt(maximumBytes)) throw new CapabilityFault("asset_too_large");
    const chunks: Buffer[] = [];
    let position = 0;
    while (true) {
      const remainingWithSentinel = maximumBytes + 1 - position;
      if (remainingWithSentinel <= 0) throw new CapabilityFault("asset_too_large");
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remainingWithSentinel));
      const read = await opened.handle.read(buffer, 0, buffer.byteLength, position);
      if (read.bytesRead === 0) break;
      position += read.bytesRead;
      if (position > maximumBytes) throw new CapabilityFault("asset_too_large");
      chunks.push(buffer.subarray(0, read.bytesRead));
    }
    const bytes = Buffer.concat(chunks, position);
    const finalIdentity = identityOf(await opened.handle.stat({ bigint: true }));
    if (!sameIdentity(opened.identity, finalIdentity) || bytes.byteLength !== Number(finalIdentity.size)) {
      throw new CapabilityFault("filesystem_race_detected");
    }
    return { bytes, identity: finalIdentity };
  } catch (error) {
    if (error instanceof CapabilityFault) throw error;
    throw new CapabilityFault("asset_storage_unavailable");
  } finally {
    await closeHandle(opened.handle);
  }
}

async function restoreQuarantinedReplacement(
  quarantinePath: string,
  originalPath: string
): Promise<void> {
  try {
    await link(quarantinePath, originalPath);
    await unlink(quarantinePath);
  } catch {
    // Preserve the quarantined replacement when its original name was reused.
  }
}

async function cleanupIdentitySafely(
  rootPath: string,
  relativePath: string,
  expectedIdentity: FileIdentity
): Promise<void> {
  const segments = validateRelativePath(relativePath);
  const { parent, filename } = await openAnchoredParent(rootPath, segments);
  const targetPath = descriptorPath(parent, filename);
  const quarantinePath = descriptorPath(parent, `.cleanup-${randomUUID()}`);
  try {
    let current;
    try {
      current = await lstat(targetPath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (current.isSymbolicLink() || !current.isFile()) {
      throw new CapabilityFault("filesystem_link_denied");
    }
    if (!sameRenamedIdentity(identityOf(current as never), expectedIdentity)) {
      throw new CapabilityFault("filesystem_race_detected");
    }

    await rename(targetPath, quarantinePath);
    const quarantined = await lstat(quarantinePath, { bigint: true });
    if (quarantined.isSymbolicLink()
      || !quarantined.isFile()
      || !sameRenamedIdentity(identityOf(quarantined as never), expectedIdentity)) {
      await restoreQuarantinedReplacement(quarantinePath, targetPath);
      throw new CapabilityFault("filesystem_race_detected");
    }
    await unlink(quarantinePath);
  } catch (error) {
    if (error instanceof CapabilityFault) throw error;
    throw new CapabilityFault("filesystem_race_detected");
  } finally {
    await closeHandle(parent);
  }
}

function rawSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function measureHandleContent(
  handle: FileHandle,
  expectedSize: bigint
): Promise<{ byteLength: number; sha256: string; signature: Uint8Array }> {
  if (expectedSize > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CapabilityFault("archive_size_limit_exceeded");
  }
  const hash = createHash("sha256");
  const signature = Buffer.alloc(4);
  let signatureBytes = 0;
  let position = 0;
  const maximum = Number(expectedSize);
  while (position < maximum) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximum - position));
    const read = await handle.read(buffer, 0, buffer.byteLength, position);
    if (read.bytesRead === 0) throw new CapabilityFault("archive_truncated");
    const bytes = buffer.subarray(0, read.bytesRead);
    hash.update(bytes);
    if (signatureBytes < signature.byteLength) {
      const copied = bytes.copy(signature, signatureBytes, 0, signature.byteLength - signatureBytes);
      signatureBytes += copied;
    }
    position += read.bytesRead;
  }
  return {
    byteLength: position,
    sha256: hash.digest("hex"),
    signature: signature.subarray(0, signatureBytes)
  };
}

function matchesZipSignature(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  const signature = (bytes[2]! << 8) | bytes[3]!;
  return signature === 0x0304 || signature === 0x0506 || signature === 0x0708;
}

function legacyAssetSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes.toString("base64")).digest("hex");
}

function mapArchiveFailure(error: unknown, fallback: PortableArchiveDiagnosticCode): SafeFilesystemCapabilityFailure {
  if (error instanceof CapabilityFault) {
    if (error.code.startsWith("archive_")) return safeFailure(error.code as PortableArchiveDiagnosticCode);
    if (error.code === "filesystem_link_denied") return safeFailure("archive_link_denied");
    if (error.code === "filesystem_path_invalid") return safeFailure("archive_path_invalid");
    if (error.code === "filesystem_containment_denied" || error.code === "filesystem_race_detected") {
      return safeFailure("archive_containment_denied");
    }
    return safeFailure("archive_unavailable");
  }
  if (!(error instanceof ArchiveError)) return safeFailure(fallback);
  if (error.code === "archive-limit-exceeded") return safeFailure("archive_size_limit_exceeded");
  if (error.code === "archive-entry-missing") return safeFailure("archive_format_invalid");
  if (error.code === "archive-checksum-mismatch") return safeFailure("archive_truncated");
  if (error.code === "archive-entry-unsafe") {
    if (/changed|identity|storage directory|intended storage path|outside the configured storage root/i.test(error.message)) {
      return safeFailure("archive_containment_denied");
    }
    return safeFailure(/link|symbolic|junction|non-regular/i.test(error.message)
      ? "archive_link_denied"
      : "archive_path_invalid");
  }
  if (error.code === "archive-format-unrecognized"
    || error.code === "archive-version-unsupported"
    || error.code === "archive-json-invalid"
    || error.code === "archive-entry-duplicate") {
    return safeFailure("archive_format_invalid");
  }
  return safeFailure(fallback);
}

function mapAssetFailure(error: unknown): SafeFilesystemCapabilityFailure {
  if (error instanceof CapabilityFault) {
    if (error.code.startsWith("asset_") || error.code.startsWith("filesystem_")) {
      return safeFailure(error.code as AssetFilesystemDiagnosticCode);
    }
    if (error.code === "archive_containment_denied") return safeFailure("filesystem_containment_denied");
    return safeFailure("asset_storage_unavailable");
  }
  return safeFailure("asset_metadata_unavailable");
}

function assertLinux(platform: NodeJS.Platform): void {
  if (platform !== "linux" || process.platform !== "linux") {
    throw new CapabilityFault("archive_containment_denied");
  }
}

function ownedStagedRecord(
  records: ReadonlyMap<PortableStagedInput, StagedRecord>,
  owner: ImportOwnerScope,
  stagedInput: PortableStagedInput
): StagedRecord {
  const record = records.get(stagedInput);
  if (!record || record.ownerUserId !== requireOwner(owner)) {
    throw new CapabilityFault("archive_unavailable");
  }
  return record;
}

function ownedArtifactRecord(
  records: ReadonlyMap<PortableArchiveExportRetrieval, ArtifactRecord>,
  owner: ImportOwnerScope,
  retrieval: PortableArchiveExportRetrieval
): ArtifactRecord {
  const record = records.get(retrieval);
  if (!record || record.ownerUserId !== requireOwner(owner)) {
    throw new CapabilityFault("archive_unavailable");
  }
  return record;
}

export function createPortableArchiveFilesystemAdapter(
  options: PortableArchiveFilesystemOptions
): PortableArchiveFilesystemAdapter {
  const platform = options.platform ?? process.platform;
  const maxImagePixels = options.maxImagePixels ?? DEFAULT_MAX_IMAGE_PIXELS;
  const maxImagePages = options.maxImagePages ?? DEFAULT_MAX_IMAGE_PAGES;
  if (!safeInteger(maxImagePixels) || maxImagePixels === 0
    || !safeInteger(maxImagePages) || maxImagePages === 0) {
    throw new Error("Portable archive image decode limits must be positive safe integers.");
  }
  const uploads = new WeakMap<object, UploadRecord>();
  const stagedRecords = new Map<PortableStagedInput, StagedRecord>();
  const artifactRecords = new Map<PortableArchiveExportRetrieval, ArtifactRecord>();

  const issueOwnerBoundUpload = (
    owner: ImportOwnerScope,
    source: NodeJS.ReadableStream,
    byteLength: number
  ): PortableArchiveUploadCapability => {
    try {
      const ownerUserId = requireOwner(owner);
      if (!safeInteger(byteLength) || byteLength > options.limits.maxCompressedBytes) {
        throw new CapabilityFault("archive_size_limit_exceeded");
      }
      if (!source || typeof (source as Readable).pipe !== "function") {
        throw new CapabilityFault("archive_unavailable");
      }
      const upload = Object.freeze({ byteLength }) as PortableArchiveUploadCapability;
      uploads.set(upload, { ownerUserId, source, byteLength });
      return upload;
    } catch (error) {
      throw mapArchiveFailure(error, "archive_unavailable");
    }
  };

  const stagingPort: PortableArchiveStagingPort = {
    async stagePortableArchive(upload) {
      const issued = uploads.get(upload);
      uploads.delete(upload);
      try {
        assertLinux(platform);
        if (!issued || upload.byteLength !== issued.byteLength) {
          throw new CapabilityFault("archive_unavailable");
        }
        const staged = await stageAnchoredArchiveUpload(issued.source, options.archiveRoot, options.limits);
        const identity = stagedArchiveIdentity(staged);
        if (staged.compressedBytes !== issued.byteLength) {
          try {
            await cleanupIdentitySafely(options.archiveRoot, staged.relativePath, identity);
            await releaseAnchoredStagedArchive(staged);
          } catch {
            // The safe diagnostic remains archive_truncated; a later reaper can retry cleanup.
          }
          throw new CapabilityFault("archive_truncated");
        }
        const stagedInput = toPortableStagedInput(randomUUID());
        stagedRecords.set(stagedInput, {
          ownerUserId: issued.ownerUserId,
          staged,
          identity
        });
        return stagedInput;
      } catch (error) {
        throw mapArchiveFailure(error, "archive_unavailable");
      }
    }
  };

  return {
    stagingPort,
    issueOwnerBoundUpload,

    async inspectPortableArchive(owner, stagedInput, expectedType) {
      try {
        assertLinux(platform);
        const record = ownedStagedRecord(stagedRecords, owner, stagedInput);
        const current = await openAnchoredRegularFile(options.archiveRoot, record.staged.relativePath);
        await closeHandle(current.handle);
        if (!sameIdentity(record.identity, current.identity)) throw new CapabilityFault("filesystem_race_detected");

        if (expectedType === "container") {
          const inspection = await inspectArchiveContainer(record.staged, options.limits);
          record.inspection = inspection;
          record.inspectionKind = "container";
          return {
            archiveType: "container",
            entries: [...inspection.entries.values()].map((entry) => ({
              path: entry.path,
              mediaType: null,
              compressedBytes: entry.compressedBytes,
              uncompressedBytes: entry.uncompressedBytes,
              sha256: null
            })),
            uncompressedBytes: inspection.uncompressedBytes
          };
        }

        const inspection = await inspectArchive(record.staged, options.limits, expectedType);
        record.inspection = inspection;
        record.inspectionKind = expectedType;
        return {
          archiveType: inspection.manifest.archiveType,
          entries: [...inspection.entries.values()].map((entry) => ({
            path: entry.path,
            mediaType: entry.mediaType,
            compressedBytes: entry.compressedBytes,
            uncompressedBytes: entry.uncompressedBytes,
            sha256: entry.sha256
          })),
          uncompressedBytes: inspection.uncompressedBytes
        };
      } catch (error) {
        throw mapArchiveFailure(error, "archive_format_invalid");
      }
    },

    async extractVerifiedEntry(owner, stagedInput, path, maximumBytes) {
      try {
        assertLinux(platform);
        if (!safeInteger(maximumBytes)) throw new CapabilityFault("archive_entry_limit_exceeded");
        const record = ownedStagedRecord(stagedRecords, owner, stagedInput);
        if (!record.inspection || !record.inspectionKind) {
          throw new CapabilityFault("archive_format_invalid");
        }
        const content = record.inspectionKind === "container"
          ? await readVerifiedContainerEntry(record.inspection as InspectedArchiveContainer, path, maximumBytes)
          : await readVerifiedEntry(record.inspection as InspectedArchive, path, maximumBytes);
        return {
          content: new Uint8Array(content),
          byteLength: content.byteLength,
          sha256: rawSha256(content)
        };
      } catch (error) {
        if (error instanceof ArchiveError && error.code === "archive-limit-exceeded") {
          throw safeFailure("archive_entry_limit_exceeded");
        }
        throw mapArchiveFailure(error, "archive_format_invalid");
      }
    },

    async cleanupStagedInput(owner, stagedInput) {
      try {
        assertLinux(platform);
        const record = ownedStagedRecord(stagedRecords, owner, stagedInput);
        await cleanupIdentitySafely(options.archiveRoot, record.staged.relativePath, record.identity);
        await releaseAnchoredStagedArchive(record.staged);
        stagedRecords.delete(stagedInput);
      } catch {
        throw safeFailure("archive_cleanup_required");
      }
    },

    async publishArchiveArtifact(owner, entries, buildManifest) {
      let artifact: CompletedArchiveArtifact | undefined;
      try {
        assertLinux(platform);
        const ownerUserId = requireOwner(owner);
        artifact = await writeArchiveArtifact(
          options.archiveRoot,
          entries,
          buildManifest,
          options.limits
        );
        const opened = await openAnchoredRegularFile(options.archiveRoot, artifact.relativePath);
        let measurement: Awaited<ReturnType<typeof measureHandleContent>>;
        try {
          if (!sameIdentity(opened.identity, artifact.identity)) {
            throw new CapabilityFault("filesystem_race_detected");
          }
          measurement = await measureHandleContent(opened.handle, opened.identity.size);
          const finalIdentity = identityOf(await opened.handle.stat({ bigint: true }));
          if (!sameIdentity(opened.identity, finalIdentity)
            || measurement.byteLength !== artifact.byteLength
            || measurement.sha256 !== artifact.sha256) {
            throw new CapabilityFault("filesystem_race_detected");
          }
        } finally {
          await closeHandle(opened.handle);
        }
        if (!matchesZipSignature(measurement.signature)) {
          throw new CapabilityFault("archive_format_invalid");
        }
        const retrieval = toPortableArchiveExportRetrieval(randomUUID());
        artifactRecords.set(retrieval, {
          ownerUserId,
          relativePath: artifact.relativePath,
          identity: artifact.identity,
          byteLength: artifact.byteLength,
          sha256: artifact.sha256
        });
        return {
          retrieval,
          contentType: "application/zip",
          byteLength: artifact.byteLength
        };
      } catch (error) {
        if (artifact) {
          try {
            await cleanupIdentitySafely(options.archiveRoot, artifact.relativePath, artifact.identity);
          } catch {
            // A later owner-scoped reaper can retry without weakening the safe failure.
          }
        }
        throw mapArchiveFailure(error, "archive_unavailable");
      }
    },

    async readExportArtifact(owner, retrieval, maximumBytes) {
      try {
        assertLinux(platform);
        if (!safeInteger(maximumBytes)) throw new CapabilityFault("archive_size_limit_exceeded");
        const record = ownedArtifactRecord(artifactRecords, owner, retrieval);
        const read = await readStableFile(
          options.archiveRoot,
          record.relativePath,
          maximumBytes,
          record.identity
        );
        const hash = rawSha256(read.bytes);
        if (read.bytes.byteLength !== record.byteLength
          || hash !== record.sha256
          || !matchesZipSignature(read.bytes)) {
          throw new CapabilityFault("archive_format_invalid");
        }
        return {
          content: new Uint8Array(read.bytes),
          contentType: "application/zip",
          byteLength: read.bytes.byteLength,
          sha256: hash
        };
      } catch (error) {
        throw mapArchiveFailure(error, "archive_format_invalid");
      }
    },

    async cleanupExportArtifact(owner, retrieval) {
      try {
        assertLinux(platform);
        const record = ownedArtifactRecord(artifactRecords, owner, retrieval);
        await cleanupIdentitySafely(options.archiveRoot, record.relativePath, record.identity);
        artifactRecords.delete(retrieval);
      } catch {
        throw safeFailure("archive_cleanup_required");
      }
    },

    async readVerifiedAsset(input) {
      try {
        assertLinux(platform);
        if (!safeInteger(input.expectedByteLength)
          || !safeInteger(input.maximumBytes)
          || input.expectedByteLength > input.maximumBytes
          || input.maximumBytes > options.limits.maxOriginalImageBytes) {
          throw new CapabilityFault("asset_too_large");
        }
        if (!/^[a-f0-9]{64}$/.test(input.expectedContentHash)) {
          throw new CapabilityFault("asset_hash_mismatch");
        }
        const signature = ALLOWED_IMAGE_SIGNATURES[input.mimeType];
        if (!signature) throw new CapabilityFault("asset_unsupported_media");
        const read = await readStableFile(options.assetRoot, input.relativePath, input.maximumBytes);
        if (read.bytes.byteLength !== input.expectedByteLength) {
          throw new CapabilityFault("asset_content_invalid");
        }
        if (!signature(read.bytes)) throw new CapabilityFault("asset_content_invalid");
        const contentHash = legacyAssetSha256(read.bytes);
        if (contentHash !== input.expectedContentHash) throw new CapabilityFault("asset_hash_mismatch");

        let metadata;
        try {
          metadata = await sharp(read.bytes, {
            animated: true,
            failOn: "error",
            limitInputPixels: maxImagePixels
          }).metadata();
        } catch {
          throw new CapabilityFault("asset_content_invalid");
        }
        if (!metadata.width
          || !metadata.height
          || !metadata.format
          || metadata.format !== IMAGE_FORMATS[input.mimeType]) {
          throw new CapabilityFault("asset_content_invalid");
        }
        const pages = metadata.pages ?? 1;
        const pageHeight = metadata.pageHeight ?? metadata.height;
        const decodedPixels = BigInt(metadata.width) * BigInt(pageHeight) * BigInt(pages);
        if (!safeInteger(pages)
          || pages === 0
          || pages > maxImagePages
          || decodedPixels > BigInt(maxImagePixels)) {
          throw new CapabilityFault("asset_content_invalid");
        }
        try {
          await sharp(read.bytes, {
            animated: true,
            failOn: "error",
            limitInputPixels: maxImagePixels
          }).raw().toBuffer();
        } catch {
          throw new CapabilityFault("asset_content_invalid");
        }
        const rotated = [5, 6, 7, 8].includes(metadata.orientation ?? 0);
        return {
          content: new Uint8Array(read.bytes),
          mimeType: input.mimeType,
          byteLength: read.bytes.byteLength,
          contentHash,
          width: rotated ? metadata.height : metadata.width,
          height: rotated ? metadata.width : metadata.height,
          format: metadata.format,
          pages,
          orientation: metadata.orientation ?? null
        };
      } catch (error) {
        throw mapAssetFailure(error);
      }
    }
  };
}
