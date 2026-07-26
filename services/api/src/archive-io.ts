import { ZipArchive, type Archiver } from "archiver";
import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  stat,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Readable, Transform, Writable, type TransformCallback } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import unzipper, { type File as ZipFile } from "unzipper";
import {
  archiveManifestSchema,
  archivePathSchema,
  canonicalArchiveJson,
  type ArchiveEntry,
  type ArchiveErrorCode,
  type ArchiveManifest,
  type ArchiveType
} from "../../../packages/contracts/src/archives.js";
import type { ArchiveLimits as RuntimeArchiveLimits } from "../../../packages/database/src/config.js";

const STAGED_IDENTITY = Symbol("stagedArchiveIdentity");
const INSPECTED_IDENTITY = Symbol("inspectedArchiveIdentity");
const INSPECTED_LIMITS = Symbol("inspectedArchiveLimits");
const FIXED_ZIP_DATE = new Date("1980-01-01T00:00:00.000Z");
const UNIX_HOST = 3;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_DIRECTORY_TYPE = 0o040000;
const UNIX_REGULAR_FILE_TYPE = 0o100000;
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const EOCD_MINIMUM_BYTES = 22;
const EOCD_MAXIMUM_COMMENT_BYTES = 65_535;
const EOCD_TAIL_BYTES = EOCD_MINIMUM_BYTES + EOCD_MAXIMUM_COMMENT_BYTES;

export type ArchiveLimits = RuntimeArchiveLimits;

export type StagedArchive = {
  relativePath: string;
  absolutePath: string;
  compressedBytes: number;
};

type FileIdentity = {
  device: bigint;
  inode: bigint;
  size: bigint;
  modifiedNanoseconds: bigint;
  changedNanoseconds: bigint;
};

type InternalStagedArchive = StagedArchive & {
  [STAGED_IDENTITY]: FileIdentity;
};

export type InspectedArchiveEntry = ArchiveEntry & {
  compressedBytes: number;
  uncompressedBytes: number;
};

export type InspectedArchive = {
  manifest: ArchiveManifest;
  staged: StagedArchive;
  entries: ReadonlyMap<string, InspectedArchiveEntry>;
  uncompressedBytes: number;
};

type InternalInspectedArchive = InspectedArchive & {
  [INSPECTED_IDENTITY]: FileIdentity;
  [INSPECTED_LIMITS]: ArchiveLimits;
};

export type ArchiveArtifactEntry = {
  path: string;
  logicalType: string;
  mediaType: string;
  source: NodeJS.ReadableStream;
};

export type CompletedArchiveArtifact = {
  relativePath: string;
  absolutePath: string;
  byteLength: number;
  contentFingerprint: string;
};

export class ArchiveError extends Error {
  constructor(
    readonly code: ArchiveErrorCode,
    message: string,
    readonly statusCode = 400,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ArchiveError";
  }
}

type NormalizedArchivePath = {
  logicalPath: string;
  comparisonPath: string;
};

type StreamMeasurement = {
  byteLength: number;
  sha256: string;
  buffer?: Buffer;
};

type StableDirectory = {
  root: string;
  directory: string;
  device: bigint;
  inode: bigint;
  anchor?: FileHandle;
};

function archiveError(
  code: ArchiveErrorCode,
  message: string,
  details?: Record<string, unknown>
): ArchiveError {
  return details === undefined
    ? new ArchiveError(code, message)
    : new ArchiveError(code, message, 400, details);
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function normalizeArchivePath(path: string, directory = false): NormalizedArchivePath {
  if (typeof path !== "string" || !path || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)
    || /\p{Cc}/u.test(path)) {
    throw archiveError("archive-entry-unsafe", "The archive contains an unsafe entry path.");
  }

  const withoutDirectorySlash = directory && path.endsWith("/") ? path.slice(0, -1) : path;
  if (!withoutDirectorySlash || (!directory && path.endsWith("/"))) {
    throw archiveError("archive-entry-unsafe", "The archive contains an unsafe entry path.");
  }
  const normalized = withoutDirectorySlash.normalize("NFC");
  if (!archivePathSchema.safeParse(normalized).success) {
    throw archiveError("archive-entry-unsafe", "The archive contains an unsafe entry path.");
  }
  return {
    logicalPath: normalized,
    comparisonPath: normalized.toLocaleLowerCase("en-US")
  };
}

function assertUnderRoot(root: string, target: string): void {
  const pathFromRoot = relative(root, target);
  if (!pathFromRoot || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw archiveError("archive-entry-unsafe", "The archive path is outside the configured storage root.");
  }
}

function fileIdentity(value: BigIntStats): FileIdentity {
  return {
    device: value.dev,
    inode: value.ino,
    size: value.size,
    modifiedNanoseconds: value.mtimeNs,
    changedNanoseconds: value.ctimeNs
  };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.modifiedNanoseconds === right.modifiedNanoseconds
    && left.changedNanoseconds === right.changedNanoseconds;
}

function sameFileObject(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.modifiedNanoseconds === right.modifiedNanoseconds;
}

async function openedFileIdentityAtIntendedPath(
  handle: FileHandle,
  intendedPath: string,
  expectedIdentity?: FileIdentity
): Promise<FileIdentity> {
  let opened: FileIdentity;
  let linked: FileIdentity;
  let linkedStat: BigIntStats;
  try {
    opened = fileIdentity(await handle.stat({ bigint: true }));
    linkedStat = await lstat(intendedPath, { bigint: true });
    linked = fileIdentity(linkedStat);
  } catch {
    throw archiveError("archive-entry-unsafe", "The opened archive file is not present at its intended storage path.");
  }
  if (!linkedStat.isFile()
    || linkedStat.isSymbolicLink()
    || !sameFileIdentity(opened, linked)
    || (expectedIdentity !== undefined && !sameFileIdentity(opened, expectedIdentity))) {
    throw archiveError("archive-entry-unsafe", "The opened archive file identity does not match its intended storage path.");
  }
  return opened;
}

function sameDirectoryIdentity(
  directory: Pick<StableDirectory, "device" | "inode">,
  value: BigIntStats
): boolean {
  return directory.device === value.dev && directory.inode === value.ino;
}

async function assertNoSymlinkSegments(root: string, targetDirectory: string): Promise<void> {
  const pathFromRoot = relative(root, targetDirectory);
  if (!pathFromRoot) return;
  const segments = pathFromRoot.split(sep);
  let current = root;
  for (const segment of segments) {
    current = resolve(current, segment);
    const value = await lstat(current);
    if (value.isSymbolicLink() || !value.isDirectory()) {
      throw archiveError("archive-entry-unsafe", "Archive storage directories must not be symbolic links or junctions.");
    }
  }
}

async function stabilizeDirectory(root: string, directory: string): Promise<StableDirectory> {
  if (process.platform !== "linux" && process.platform !== "win32") {
    throw archiveError(
      "archive-entry-unsafe",
      "This platform does not provide the required stable archive-directory mutation semantics."
    );
  }
  await assertNoSymlinkSegments(root, directory);
  const resolvedDirectory = await realpath(directory);
  if (resolvedDirectory !== root) assertUnderRoot(root, resolvedDirectory);
  if (resolvedDirectory !== directory) {
    throw archiveError("archive-entry-unsafe", "Archive storage directories must resolve without indirection.");
  }
  const value = await stat(directory, { bigint: true });
  if (!value.isDirectory()) {
    throw archiveError("archive-entry-unsafe", "Archive storage requires a directory.");
  }

  let anchor: FileHandle | undefined;
  if (process.platform === "linux") {
    anchor = await open(directory, "r");
    const anchored = await anchor.stat({ bigint: true });
    if (!anchored.isDirectory() || anchored.dev !== value.dev || anchored.ino !== value.ino) {
      await closeHandle(anchor);
      throw archiveError("archive-entry-unsafe", "The archive storage directory changed during validation.");
    }
  }

  return {
    root,
    directory,
    device: value.dev,
    inode: value.ino,
    ...(anchor ? { anchor } : {})
  };
}

async function assertDirectoryStable(directory: StableDirectory): Promise<void> {
  let resolved: string;
  let value: BigIntStats;
  try {
    resolved = await realpath(directory.directory);
    value = await stat(directory.directory, { bigint: true });
  } catch {
    throw archiveError("archive-entry-unsafe", "The archive storage directory changed during the filesystem operation.");
  }
  if (resolved !== directory.root) assertUnderRoot(directory.root, resolved);
  if (resolved !== directory.directory || !value.isDirectory() || !sameDirectoryIdentity(directory, value)) {
    throw archiveError("archive-entry-unsafe", "The archive storage directory changed during the filesystem operation.");
  }
}

function stableChildPath(directory: StableDirectory, filename: string): string {
  if (directory.anchor) {
    return `/proc/self/fd/${directory.anchor.fd}/${filename}`;
  }
  return resolve(directory.directory, filename);
}

async function prepareRootDirectory(archiveRoot: string, child: "staging" | "artifacts"): Promise<{
  root: string;
  directory: string;
  stable: StableDirectory;
}> {
  const configuredRoot = resolve(archiveRoot);
  await mkdir(configuredRoot, { recursive: true });
  const root = await realpath(configuredRoot);
  const childPath = resolve(root, child);
  assertUnderRoot(root, childPath);
  await mkdir(childPath, { recursive: true });
  const stable = await stabilizeDirectory(root, childPath);
  return { root, directory: childPath, stable };
}

class CompressedByteCounter extends Transform {
  byteLength = 0;

  constructor(private readonly maximumBytes: number) {
    super();
  }

  override _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback): void {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    const nextLength = this.byteLength + value.byteLength;
    if (!Number.isSafeInteger(nextLength) || nextLength > this.maximumBytes) {
      callback(archiveError("archive-limit-exceeded", "The compressed archive exceeds the configured byte limit."));
      return;
    }
    this.byteLength = nextLength;
    callback(null, value);
  }
}

function fileHandleWritable(handle: FileHandle): Writable {
  let position = 0;
  return new Writable({
    write(chunk: Buffer | string, encoding: BufferEncoding, callback) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      void (async () => {
        let offset = 0;
        while (offset < value.byteLength) {
          const result = await handle.write(
            value,
            offset,
            value.byteLength - offset,
            position
          );
          if (result.bytesWritten === 0) throw new Error("The archive file write made no progress.");
          offset += result.bytesWritten;
          position += result.bytesWritten;
        }
      })().then(() => callback(), callback);
    }
  });
}

export async function stageArchiveUpload(
  source: NodeJS.ReadableStream,
  archiveRoot: string,
  limits: ArchiveLimits
): Promise<StagedArchive> {
  const { root, directory, stable } = await prepareRootDirectory(archiveRoot, "staging");
  const filename = `${randomUUID()}.zip`;
  const absolutePath = resolve(directory, filename);
  assertUnderRoot(root, absolutePath);
  const relativePath = `staging/${filename}`;
  const operationPath = stableChildPath(stable, filename);
  const counter = new CompressedByteCounter(limits.maxCompressedBytes);
  let handle: FileHandle | undefined;
  let output: Writable | undefined;
  let identity: FileIdentity | undefined;

  try {
    await assertDirectoryStable(stable);
    handle = await open(operationPath, "wx", 0o640);
    identity = await openedFileIdentityAtIntendedPath(handle, absolutePath);
    await assertDirectoryStable(stable);
    output = fileHandleWritable(handle);
    await pipeline(source as Readable, counter, output);
    if ((source as NodeJS.ReadableStream & { truncated?: boolean }).truncated === true) {
      throw archiveError("archive-limit-exceeded", "The compressed archive upload was truncated.");
    }
    await handle.sync();
    identity = fileIdentity(await handle.stat({ bigint: true }));
    if (identity.size !== BigInt(counter.byteLength)) {
      throw archiveError("archive-checksum-mismatch", "The staged archive size changed during upload.");
    }
    await assertDirectoryStable(stable);
    const staged: InternalStagedArchive = {
      relativePath,
      absolutePath,
      compressedBytes: counter.byteLength,
      [STAGED_IDENTITY]: identity
    };
    await closeHandle(handle);
    handle = undefined;
    return staged;
  } catch (error) {
    output?.destroy();
    if (identity) await removePathWithIdentity(operationPath, identity);
    await closeHandle(handle);
    throw error;
  } finally {
    await closeHandle(stable.anchor);
  }
}

function inspectUnixEntryType(file: ZipFile, directory: boolean, path: string): void {
  const host = file.versionMadeBy >>> 8;
  if (host !== UNIX_HOST) return;
  const mode = (file.externalFileAttributes >>> 16) & 0xffff;
  const fileType = mode & UNIX_FILE_TYPE_MASK;
  if (fileType === 0) return;
  const expectedType = directory ? UNIX_DIRECTORY_TYPE : UNIX_REGULAR_FILE_TYPE;
  if (fileType !== expectedType) {
    throw archiveError("archive-entry-unsafe", "The archive contains a non-regular filesystem entry.", { path });
  }
}

function inspectCentralDirectory(
  files: readonly ZipFile[],
  limits: ArchiveLimits
): {
  filesByPath: Map<string, ZipFile>;
  uncompressedBytes: number;
} {
  if (files.length > limits.maxEntries) {
    throw archiveError("archive-limit-exceeded", "The archive contains too many entries.");
  }

  const paths = new Map<string, "file" | "directory">();
  const filesByPath = new Map<string, ZipFile>();
  let uncompressedBytes = 0;

  for (const file of files) {
    const directory = file.type === "Directory" || file.path.endsWith("/");
    const normalized = normalizeArchivePath(file.path, directory);
    const path = normalized.comparisonPath;

    if ((file.flags & 0x0001) !== 0) {
      throw archiveError("archive-entry-unsafe", "Encrypted archive entries are not supported.", { path });
    }
    if (file.compressionMethod !== 0 && file.compressionMethod !== 8) {
      throw archiveError("archive-entry-unsafe", "The archive uses an unsupported compression method.", { path });
    }
    inspectUnixEntryType(file, directory, path);
    if (!safeInteger(file.compressedSize) || !safeInteger(file.uncompressedSize)) {
      throw archiveError("archive-limit-exceeded", "The archive declares an invalid entry size.", { path });
    }

    if (paths.has(path)) {
      throw archiveError("archive-entry-duplicate", "The archive contains duplicate normalized entry paths.", { path });
    }
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join("/");
      if (paths.get(ancestor) === "file") {
        throw archiveError("archive-entry-duplicate", "An archive file collides with a directory path.", { path });
      }
    }
    if (!directory) {
      for (const existing of paths.keys()) {
        if (existing.startsWith(`${path}/`)) {
          throw archiveError("archive-entry-duplicate", "An archive file collides with a directory path.", { path });
        }
      }
    }
    paths.set(path, directory ? "directory" : "file");

    const nextTotal = uncompressedBytes + file.uncompressedSize;
    if (!Number.isSafeInteger(nextTotal) || nextTotal > limits.maxUncompressedBytes) {
      throw archiveError("archive-limit-exceeded", "The archive exceeds the configured uncompressed byte limit.");
    }
    uncompressedBytes = nextTotal;

    if (file.uncompressedSize > 0) {
      if (file.compressedSize === 0 || file.uncompressedSize / file.compressedSize > limits.maxExpansionRatio) {
        throw archiveError("archive-limit-exceeded", "An archive entry exceeds the configured expansion ratio.", { path });
      }
    }

    if (!directory) {
      filesByPath.set(path, file);
    }
  }

  return { filesByPath, uncompressedBytes };
}

async function readExactRange(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  if (!safeInteger(position) || !safeInteger(length) || length === 0) {
    throw archiveError("archive-format-unrecognized", "The ZIP archive contains invalid bounded metadata.");
  }
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, position + offset);
    if (result.bytesRead === 0) {
      throw archiveError("archive-format-unrecognized", "The ZIP archive metadata is truncated.");
    }
    offset += result.bytesRead;
  }
  return buffer;
}

function checkedZipNumber(value: bigint, archiveSize: number): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER) || value > BigInt(archiveSize)) {
    throw archiveError("archive-format-unrecognized", "The ZIP archive declares an invalid metadata offset.");
  }
  return Number(value);
}

function assertEncodedRecordCount(recordCount: bigint, limits: ArchiveLimits): void {
  if (recordCount > BigInt(limits.maxEntries)) {
    throw archiveError("archive-limit-exceeded", "The archive contains too many encoded central-directory records.");
  }
}

async function preflightZipMetadata(
  handle: FileHandle,
  archiveSize: number,
  limits: ArchiveLimits
): Promise<void> {
  if (!safeInteger(archiveSize) || archiveSize < EOCD_MINIMUM_BYTES) {
    throw archiveError("archive-format-unrecognized", "The uploaded file is not a recognized ZIP archive.");
  }
  const tailLength = Math.min(archiveSize, EOCD_TAIL_BYTES);
  const tailStart = archiveSize - tailLength;
  const tail = await readExactRange(handle, tailStart, tailLength);
  const eocdSignature = Buffer.allocUnsafe(4);
  eocdSignature.writeUInt32LE(EOCD_SIGNATURE, 0);
  const relativeEocdOffset = tail.indexOf(eocdSignature);
  if (relativeEocdOffset < 0 || relativeEocdOffset + EOCD_MINIMUM_BYTES > tail.length) {
    throw archiveError("archive-format-unrecognized", "The ZIP end-of-central-directory record is missing or malformed.");
  }

  const eocd = tail.subarray(relativeEocdOffset, relativeEocdOffset + EOCD_MINIMUM_BYTES);
  const commentLength = eocd.readUInt16LE(20);
  if (relativeEocdOffset + EOCD_MINIMUM_BYTES + commentLength !== tail.length) {
    throw archiveError("archive-format-unrecognized", "The first ZIP end-of-central-directory record is malformed.");
  }
  const eocdOffset = tailStart + relativeEocdOffset;
  const diskNumber = eocd.readUInt16LE(4);
  const diskStart = eocd.readUInt16LE(6);
  const recordsOnDisk = eocd.readUInt16LE(8);
  const records = eocd.readUInt16LE(10);
  const centralSize = eocd.readUInt32LE(12);
  const centralOffset = eocd.readUInt32LE(16);
  const zip64 = diskNumber === 0xffff
    || diskStart === 0xffff
    || recordsOnDisk === 0xffff
    || records === 0xffff
    || centralSize === 0xffffffff
    || centralOffset === 0xffffffff;

  if (!zip64) {
    if (diskNumber !== 0 || diskStart !== 0 || recordsOnDisk !== records) {
      throw archiveError("archive-format-unrecognized", "Multi-disk ZIP archives are not supported.");
    }
    assertEncodedRecordCount(BigInt(records), limits);
    if (centralOffset + centralSize > eocdOffset) {
      throw archiveError("archive-format-unrecognized", "The ZIP central-directory bounds are invalid.");
    }
    if (tail.indexOf(eocdSignature, relativeEocdOffset + eocdSignature.byteLength) !== -1) {
      throw archiveError("archive-format-unrecognized", "The ZIP tail contains competing end-of-central-directory signatures.");
    }
    return;
  }

  const locatorOffset = eocdOffset - 20;
  if (locatorOffset < 0) {
    throw archiveError("archive-format-unrecognized", "The ZIP64 locator is missing.");
  }
  const locator = await readExactRange(handle, locatorOffset, 20);
  if (locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIGNATURE
    || locator.readUInt32LE(4) !== 0
    || locator.readUInt32LE(16) !== 1) {
    throw archiveError("archive-format-unrecognized", "The ZIP64 locator is invalid.");
  }
  const zip64Offset = checkedZipNumber(locator.readBigUInt64LE(8), archiveSize);
  if (zip64Offset + 56 > locatorOffset) {
    throw archiveError("archive-format-unrecognized", "The ZIP64 end-of-central-directory record is truncated.");
  }
  const zip64Record = await readExactRange(handle, zip64Offset, 56);
  if (zip64Record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) {
    throw archiveError("archive-format-unrecognized", "The ZIP64 end-of-central-directory signature is invalid.");
  }
  const zip64RecordSize = zip64Record.readBigUInt64LE(4);
  if (zip64RecordSize < 44n
    || BigInt(zip64Offset) + 12n + zip64RecordSize !== BigInt(locatorOffset)) {
    throw archiveError("archive-format-unrecognized", "The ZIP64 end-of-central-directory size is invalid.");
  }
  const zip64DiskNumber = zip64Record.readUInt32LE(16);
  const zip64DiskStart = zip64Record.readUInt32LE(20);
  const zip64RecordsOnDisk = zip64Record.readBigUInt64LE(24);
  const zip64Records = zip64Record.readBigUInt64LE(32);
  if (zip64DiskNumber !== 0 || zip64DiskStart !== 0 || zip64RecordsOnDisk !== zip64Records) {
    throw archiveError("archive-format-unrecognized", "Multi-disk ZIP64 archives are not supported.");
  }
  assertEncodedRecordCount(zip64Records, limits);
  const zip64CentralSize = checkedZipNumber(zip64Record.readBigUInt64LE(40), archiveSize);
  const zip64CentralOffset = checkedZipNumber(zip64Record.readBigUInt64LE(48), archiveSize);
  if (zip64CentralOffset + zip64CentralSize > zip64Offset) {
    throw archiveError("archive-format-unrecognized", "The ZIP64 central-directory bounds are invalid.");
  }
  if (tail.indexOf(eocdSignature, relativeEocdOffset + eocdSignature.byteLength) !== -1) {
    throw archiveError("archive-format-unrecognized", "The ZIP tail contains competing end-of-central-directory signatures.");
  }
}

function archiveHandleSource(handle: FileHandle, archiveSize: number): {
  size: () => Promise<number>;
  stream: (offset: number, length?: number) => Readable;
} {
  return {
    size: async () => archiveSize,
    stream: (offset, length) => {
      if (!safeInteger(offset) || offset >= archiveSize
        || (length !== undefined && (!safeInteger(length) || length === 0))) {
        return Readable.from((async function* invalidRange() {
          throw new Error("Invalid ZIP source range.");
        })());
      }
      const end = length === undefined
        ? archiveSize - 1
        : Math.min(archiveSize - 1, offset + length);
      let position = offset;
      let reading = false;
      return new Readable({
        read(requestedBytes) {
          if (reading) return;
          if (position > end) {
            this.push(null);
            return;
          }
          reading = true;
          const byteLength = Math.min(Math.max(1, requestedBytes), 64 * 1024, end - position + 1);
          const buffer = Buffer.allocUnsafe(byteLength);
          void handle.read(buffer, 0, byteLength, position).then((result) => {
            reading = false;
            if (result.bytesRead === 0) {
              this.push(null);
              return;
            }
            position += result.bytesRead;
            this.push(buffer.subarray(0, result.bytesRead));
          }, (error) => {
            reading = false;
            this.destroy(error);
          });
        }
      });
    }
  };
}

async function openArchiveFromHandle(
  handle: FileHandle,
  archiveSize: number,
  limits: ArchiveLimits
): Promise<unzipper.CentralDirectory> {
  await preflightZipMetadata(handle, archiveSize, limits);
  try {
    const customOpen = unzipper.Open.custom as unknown as (
      source: ReturnType<typeof archiveHandleSource>,
      options: { tailSize: number }
    ) => Promise<unzipper.CentralDirectory>;
    return await customOpen(archiveHandleSource(handle, archiveSize), {
      tailSize: Math.min(archiveSize, EOCD_TAIL_BYTES)
    });
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw archiveError("archive-format-unrecognized", "The uploaded file is not a recognized ZIP archive.");
  }
}

function zip64LocalSizes(
  extra: Buffer,
  needsUncompressed: boolean,
  needsCompressed: boolean
): { uncompressed?: number; compressed?: number } {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const signature = extra.readUInt16LE(offset);
    const length = extra.readUInt16LE(offset + 2);
    const end = offset + 4 + length;
    if (end > extra.length) break;
    if (signature === 0x0001) {
      let valueOffset = offset + 4;
      const result: { uncompressed?: number; compressed?: number } = {};
      if (needsUncompressed) {
        if (valueOffset + 8 > end) return {};
        const value = extra.readBigUInt64LE(valueOffset);
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) return {};
        result.uncompressed = Number(value);
        valueOffset += 8;
      }
      if (needsCompressed) {
        if (valueOffset + 8 > end) return {};
        const value = extra.readBigUInt64LE(valueOffset);
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) return {};
        result.compressed = Number(value);
      }
      return result;
    }
    offset = end;
  }
  return {};
}

async function inspectLocalHeaders(
  handle: FileHandle,
  files: readonly ZipFile[],
  archiveSize: number
): Promise<void> {
  for (const file of files) {
    if (!safeInteger(file.offsetToLocalFileHeader)
      || file.offsetToLocalFileHeader + 30 > archiveSize) {
      throw archiveError("archive-entry-unsafe", "An archive local-file-header offset is invalid.");
    }
    const header = await readExactRange(handle, file.offsetToLocalFileHeader, 30);
    if (header.readUInt32LE(0) !== LOCAL_FILE_HEADER_SIGNATURE) {
      throw archiveError("archive-entry-unsafe", "An archive local-file-header signature is invalid.");
    }
    const flags = header.readUInt16LE(6);
    const compressionMethod = header.readUInt16LE(8);
    const crc32 = header.readUInt32LE(14);
    const rawCompressedSize = header.readUInt32LE(18);
    const rawUncompressedSize = header.readUInt32LE(22);
    const fileNameLength = header.readUInt16LE(26);
    const extraFieldLength = header.readUInt16LE(28);
    if (file.offsetToLocalFileHeader + 30 + fileNameLength + extraFieldLength > archiveSize) {
      throw archiveError("archive-entry-unsafe", "An archive local-file-header is truncated.");
    }
    const variable = await readExactRange(
      handle,
      file.offsetToLocalFileHeader + 30,
      fileNameLength + extraFieldLength
    );
    const pathBuffer = variable.subarray(0, fileNameLength);
    const extra = variable.subarray(fileNameLength);
    const zip64Sizes = zip64LocalSizes(
      extra,
      rawUncompressedSize === 0xffffffff,
      rawCompressedSize === 0xffffffff
    );
    const compressedSize = rawCompressedSize === 0xffffffff ? zip64Sizes.compressed : rawCompressedSize;
    const uncompressedSize = rawUncompressedSize === 0xffffffff ? zip64Sizes.uncompressed : rawUncompressedSize;
    const usesDataDescriptor = (flags & 0x0008) !== 0;
    const sizesMatch = usesDataDescriptor
      ? (compressedSize === undefined || compressedSize === 0 || compressedSize === file.compressedSize)
        && (uncompressedSize === undefined || uncompressedSize === 0 || uncompressedSize === file.uncompressedSize)
        && (crc32 === 0 || crc32 === file.crc32)
      : compressedSize === file.compressedSize
        && uncompressedSize === file.uncompressedSize
        && crc32 === file.crc32;

    if (flags !== file.flags
      || compressionMethod !== file.compressionMethod
      || !pathBuffer.equals(file.pathBuffer)
      || !sizesMatch) {
      throw archiveError("archive-entry-unsafe", "An archive local header disagrees with its central-directory record.", {
        path: normalizeArchivePath(file.path, file.type === "Directory").comparisonPath
      });
    }
  }
}

async function measureEntry(file: ZipFile, maximumBytes: number, collect: boolean): Promise<StreamMeasurement> {
  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  let byteLength = 0;

  try {
    for await (const chunk of file.stream()) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const nextLength = byteLength + value.byteLength;
      if (!Number.isSafeInteger(nextLength) || nextLength > maximumBytes) {
        throw archiveError("archive-limit-exceeded", "An archive entry exceeds its configured byte limit.");
      }
      byteLength = nextLength;
      hash.update(value);
      if (collect) chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw archiveError("archive-checksum-mismatch", "An archive entry could not be decoded and verified.");
  }

  return {
    byteLength,
    sha256: hash.digest("hex"),
    ...(collect ? { buffer: Buffer.concat(chunks, byteLength) } : {})
  };
}

function parseManifest(buffer: Buffer): ArchiveManifest {
  if (buffer.byteLength >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    throw archiveError("archive-json-invalid", "manifest.json must be UTF-8 without a byte-order mark.");
  }

  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    value = JSON.parse(text);
  } catch {
    throw archiveError("archive-json-invalid", "manifest.json is not valid UTF-8 JSON.");
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)
    || (value as { format?: unknown }).format !== "infinite-quest-archive") {
    throw archiveError("archive-format-unrecognized", "The archive manifest format is not recognized.");
  }
  if ((value as { formatVersion?: unknown }).formatVersion !== 1) {
    throw archiveError("archive-version-unsupported", "The archive manifest version is not supported.");
  }

  const parsed = archiveManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw archiveError("archive-json-invalid", "manifest.json does not satisfy the archive schema.");
  }
  return parsed.data;
}

function isJsonEntry(entry: ArchiveEntry): boolean {
  const mediaType = entry.mediaType.toLocaleLowerCase("en-US");
  const path = entry.path.toLocaleLowerCase("en-US");
  return mediaType === "application/json"
    || mediaType === "application/x-ndjson"
    || mediaType.endsWith("+json")
    || path.endsWith(".json")
    || path.endsWith(".ndjson");
}

async function withVerifiedStagedArchive<T>(
  staged: StagedArchive,
  limits: ArchiveLimits,
  expectedIdentity: FileIdentity | undefined,
  operation: (handle: FileHandle, identity: FileIdentity, archiveSize: number) => Promise<T>
): Promise<T> {
  const stagedIdentity = (staged as InternalStagedArchive)[STAGED_IDENTITY];
  if (!stagedIdentity) {
    throw archiveError("archive-checksum-mismatch", "The staged archive is missing its original file identity.");
  }

  let handle: FileHandle | undefined;
  let operationError: unknown;
  let result: T | undefined;
  let initialIdentity: FileIdentity | undefined;
  try {
    handle = await open(staged.absolutePath, "r");
    initialIdentity = fileIdentity(await handle.stat({ bigint: true }));
    if (!sameFileIdentity(initialIdentity, stagedIdentity)
      || (expectedIdentity !== undefined && !sameFileIdentity(initialIdentity, expectedIdentity))
      || initialIdentity.size !== BigInt(staged.compressedBytes)
      || initialIdentity.size > BigInt(limits.maxCompressedBytes)) {
      throw archiveError("archive-checksum-mismatch", "The staged archive file identity or compressed size changed.");
    }
    result = await operation(handle, initialIdentity, Number(initialIdentity.size));
  } catch (error) {
    operationError = error instanceof ArchiveError
      ? error
      : archiveError("archive-checksum-mismatch", "The staged archive could not be opened and verified.");
  }

  if (handle && initialIdentity) {
    try {
      const finalIdentity = fileIdentity(await handle.stat({ bigint: true }));
      if (!sameFileIdentity(initialIdentity, finalIdentity)) {
        operationError = archiveError("archive-checksum-mismatch", "The staged archive changed while it was being read.");
      }
    } catch {
      operationError = archiveError("archive-checksum-mismatch", "The staged archive identity could not be reverified.");
    }
  }
  await closeHandle(handle);
  if (operationError !== undefined) throw operationError;
  return result!;
}

export async function inspectArchive(
  staged: StagedArchive,
  limits: ArchiveLimits,
  expectedType?: ArchiveType
): Promise<InspectedArchive> {
  if (!safeInteger(staged.compressedBytes) || staged.compressedBytes > limits.maxCompressedBytes) {
    throw archiveError("archive-limit-exceeded", "The compressed archive exceeds the configured byte limit.");
  }

  return withVerifiedStagedArchive(staged, limits, undefined, async (handle, identity, archiveSize) => {
    const directory = await openArchiveFromHandle(handle, archiveSize, limits);
    const central = inspectCentralDirectory(directory.files, limits);
    await inspectLocalHeaders(handle, directory.files, archiveSize);
    const manifestFile = central.filesByPath.get("manifest.json");
    if (!manifestFile) {
      throw archiveError("archive-entry-missing", "The archive is missing manifest.json.");
    }
    if (manifestFile.uncompressedSize > limits.maxManifestBytes) {
      throw archiveError("archive-limit-exceeded", "manifest.json exceeds the configured byte limit.");
    }

    const manifestMeasurement = await measureEntry(
      manifestFile,
      Math.min(limits.maxManifestBytes, manifestFile.uncompressedSize),
      true
    );
    const manifest = parseManifest(manifestMeasurement.buffer!);
    if (expectedType !== undefined && manifest.archiveType !== expectedType) {
      throw archiveError("archive-format-unrecognized", "The archive type does not match the requested operation.");
    }

    const declaredEntries = new Map<string, ArchiveEntry>();
    for (const entry of manifest.entries) {
      const normalized = normalizeArchivePath(entry.path);
      declaredEntries.set(normalized.comparisonPath, { ...entry, path: normalized.logicalPath });
    }

    for (const [path] of central.filesByPath) {
      if (path !== "manifest.json" && !declaredEntries.has(path)) {
        throw archiveError("archive-entry-unsafe", "The archive contains an undeclared file.", { path });
      }
    }

    const entries = new Map<string, InspectedArchiveEntry>();
    for (const [path, declared] of declaredEntries) {
      const file = central.filesByPath.get(path);
      if (!file) {
        throw archiveError("archive-entry-missing", "A manifest entry is missing from the archive.", { path });
      }
      if (isJsonEntry(declared)
        && (file.uncompressedSize > limits.maxJsonEntryBytes || declared.byteLength > limits.maxJsonEntryBytes)) {
        throw archiveError("archive-limit-exceeded", "A JSON archive entry exceeds the configured byte limit.", { path });
      }
      if (file.uncompressedSize !== declared.byteLength) {
        throw archiveError("archive-checksum-mismatch", "An archive entry length does not match its manifest.", { path });
      }

      const configuredMaximum = isJsonEntry(declared) ? limits.maxJsonEntryBytes : limits.maxUncompressedBytes;
      const maximumBytes = Math.min(configuredMaximum, declared.byteLength, file.uncompressedSize);
      const measurement = await measureEntry(file, maximumBytes, false);
      if (measurement.byteLength !== declared.byteLength || measurement.sha256 !== declared.sha256) {
        throw archiveError("archive-checksum-mismatch", "An archive entry does not match its manifest.", { path });
      }

      entries.set(path, {
        ...declared,
        compressedBytes: file.compressedSize,
        uncompressedBytes: file.uncompressedSize
      });
    }

    const inspected: InternalInspectedArchive = {
      manifest,
      staged,
      entries,
      uncompressedBytes: central.uncompressedBytes,
      [INSPECTED_IDENTITY]: identity,
      [INSPECTED_LIMITS]: limits
    };
    return inspected;
  });
}

export async function readVerifiedEntry(
  archive: InspectedArchive,
  path: string,
  maximumBytes: number
): Promise<Buffer> {
  if (!safeInteger(maximumBytes)) {
    throw archiveError("archive-limit-exceeded", "The requested archive read limit is invalid.");
  }
  const normalized = normalizeArchivePath(path);
  const entry = archive.entries.get(normalized.comparisonPath);
  const internal = archive as InternalInspectedArchive;
  const identity = internal[INSPECTED_IDENTITY];
  const limits = internal[INSPECTED_LIMITS];
  if (!entry || !identity || !limits) {
    throw archiveError("archive-entry-missing", "The requested archive entry does not exist.", {
      path: normalized.comparisonPath
    });
  }
  if (entry.byteLength > maximumBytes) {
    throw archiveError("archive-limit-exceeded", "The requested archive entry exceeds the configured byte limit.", {
      path: normalized.comparisonPath
    });
  }

  return withVerifiedStagedArchive(archive.staged, limits, identity, async (handle, _identity, archiveSize) => {
    const directory = await openArchiveFromHandle(handle, archiveSize, limits);
    const central = inspectCentralDirectory(directory.files, limits);
    await inspectLocalHeaders(handle, directory.files, archiveSize);
    const file = central.filesByPath.get(normalized.comparisonPath);
    if (!file
      || file.compressedSize !== entry.compressedBytes
      || file.uncompressedSize !== entry.uncompressedBytes) {
      throw archiveError("archive-checksum-mismatch", "The requested archive entry metadata changed.", {
        path: normalized.comparisonPath
      });
    }

    const streamMaximum = Math.min(maximumBytes, entry.byteLength, entry.uncompressedBytes);
    const measurement = await measureEntry(file, streamMaximum, true);
    if (measurement.byteLength !== entry.byteLength || measurement.sha256 !== entry.sha256) {
      throw archiveError("archive-checksum-mismatch", "The requested archive entry no longer matches its manifest.", {
        path: normalized.comparisonPath
      });
    }
    return measurement.buffer!;
  });
}

function assertWriterEntries(entries: readonly ArchiveArtifactEntry[]): void {
  const paths = new Set<string>();
  for (const entry of entries) {
    const normalized = normalizeArchivePath(entry.path);
    if (normalized.comparisonPath === "manifest.json" || paths.has(normalized.comparisonPath)) {
      throw archiveError("archive-export-inconsistent", "Archive artifact entries contain a reserved or duplicate path.");
    }
    for (const existing of paths) {
      if (existing.startsWith(`${normalized.comparisonPath}/`) || normalized.comparisonPath.startsWith(`${existing}/`)) {
        throw archiveError("archive-export-inconsistent", "Archive artifact entries contain a file/directory collision.");
      }
    }
    paths.add(normalized.comparisonPath);
  }
}

function measuringTransform(): {
  transform: Transform;
  measurement: () => Pick<ArchiveEntry, "byteLength" | "sha256">;
} {
  const hash = createHash("sha256");
  let byteLength = 0;
  const transform = new Transform({
    transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      const nextLength = byteLength + value.byteLength;
      if (!Number.isSafeInteger(nextLength)) {
        callback(archiveError("archive-export-inconsistent", "An archive artifact entry exceeded the safe byte range."));
        return;
      }
      byteLength = nextLength;
      hash.update(value);
      callback(null, value);
    }
  });
  return {
    transform,
    measurement: () => ({ byteLength, sha256: hash.digest("hex") })
  };
}

async function closeHandle(handle: FileHandle | undefined): Promise<void> {
  if (!handle) return;
  try {
    await handle.close();
  } catch {
    // Cleanup is best effort after an earlier failure.
  }
}

async function removePathWithIdentity(path: string, identity: FileIdentity): Promise<void> {
  try {
    const value = await lstat(path, { bigint: true });
    const current = fileIdentity(value);
    if (!value.isFile() || value.isSymbolicLink()
      || current.device !== identity.device || current.inode !== identity.inode) {
      return;
    }
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function writeArchiveArtifact(
  archiveRoot: string,
  entries: readonly ArchiveArtifactEntry[],
  buildManifest: (entries: readonly ArchiveEntry[]) => ArchiveManifest,
  limits?: ArchiveLimits
): Promise<CompletedArchiveArtifact> {
  assertWriterEntries(entries);
  if (limits && entries.length + 1 > limits.maxEntries) {
    throw archiveError("archive-limit-exceeded", "The archive contains too many entries.");
  }
  const { root, directory, stable } = await prepareRootDirectory(archiveRoot, "artifacts");
  const id = randomUUID();
  const temporaryPath = resolve(directory, `${id}.zip.tmp`);
  const absolutePath = resolve(directory, `${id}.zip`);
  assertUnderRoot(root, temporaryPath);
  assertUnderRoot(root, absolutePath);
  const temporaryOperationPath = stableChildPath(stable, `${id}.zip.tmp`);
  const finalOperationPath = stableChildPath(stable, `${id}.zip`);

  let handle: FileHandle | undefined;
  let identity: FileIdentity | undefined;
  let output: Writable | undefined;
  let outputCompleted: Promise<void> | undefined;
  let archive: Archiver | undefined;
  let published = false;

  try {
    await assertDirectoryStable(stable);
    handle = await open(temporaryOperationPath, "wx", 0o640);
    identity = await openedFileIdentityAtIntendedPath(handle, temporaryPath);
    await assertDirectoryStable(stable);
    output = fileHandleWritable(handle);
    outputCompleted = finished(output);
    archive = new ZipArchive({ forceLocalTime: false, zlib: { level: 9 } });
    archive.on("warning", (error) => output?.destroy(error));
    archive.on("error", (error) => output?.destroy(error));
    archive.pipe(output);

    const measuredEntries: ArchiveEntry[] = [];
    let uncompressedBytes = 0;
    for (const entry of entries) {
      const normalized = normalizeArchivePath(entry.path);
      const measured = measuringTransform();
      archive.append(measured.transform, {
        name: normalized.logicalPath,
        date: FIXED_ZIP_DATE,
        mode: 0o100640
      });
      await pipeline(entry.source as Readable, measured.transform);
      const measurement = measured.measurement();
      if (limits && entry.mediaType === "application/json" && measurement.byteLength > limits.maxJsonEntryBytes) {
        throw archiveError("archive-limit-exceeded", "A JSON archive entry exceeds the configured byte limit.", { path: normalized.logicalPath });
      }
      uncompressedBytes += measurement.byteLength;
      if (limits && uncompressedBytes > limits.maxUncompressedBytes) {
        throw archiveError("archive-limit-exceeded", "The archive exceeds the configured uncompressed byte limit.");
      }
      measuredEntries.push({
        path: normalized.logicalPath,
        logicalType: entry.logicalType,
        mediaType: entry.mediaType,
        ...measurement
      });
    }

    const manifest = archiveManifestSchema.parse(buildManifest(measuredEntries));
    if (canonicalArchiveJson(manifest.entries) !== canonicalArchiveJson(measuredEntries)) {
      throw archiveError("archive-export-inconsistent", "The archive manifest entries do not match the streamed artifact entries.");
    }
    const manifestBytes = Buffer.from(canonicalArchiveJson(manifest), "utf8");
    if (limits && manifestBytes.byteLength > limits.maxManifestBytes) {
      throw archiveError("archive-limit-exceeded", "manifest.json exceeds the configured byte limit.");
    }
    if (limits && uncompressedBytes + manifestBytes.byteLength > limits.maxUncompressedBytes) {
      throw archiveError("archive-limit-exceeded", "The archive exceeds the configured uncompressed byte limit.");
    }
    archive.append(manifestBytes, {
      name: "manifest.json",
      date: FIXED_ZIP_DATE,
      mode: 0o100640,
      store: true
    });

    await archive.finalize();
    await outputCompleted;
    await handle.sync();
    identity = fileIdentity(await handle.stat({ bigint: true }));
    if (limits && identity.size > BigInt(limits.maxCompressedBytes)) {
      throw archiveError("archive-limit-exceeded", "The compressed archive exceeds the configured byte limit.");
    }
    if (limits) {
      const directory = await openArchiveFromHandle(handle, Number(identity.size), limits);
      inspectCentralDirectory(directory.files, limits);
      await inspectLocalHeaders(handle, directory.files, Number(identity.size));
    }
    await assertDirectoryStable(stable);
    // Keep the source handle open while checking both child names around rename:
    // Windows prevents replacement of the opened file, while Linux uses the
    // stable directory descriptor path. Root ACLs must prevent replacement after
    // this handle closes; path identity checks cannot protect a later mutation.
    await openedFileIdentityAtIntendedPath(handle, temporaryPath, identity);
    await rename(temporaryOperationPath, finalOperationPath);
    published = true;
    await assertDirectoryStable(stable);
    const publishedIdentity = await openedFileIdentityAtIntendedPath(handle, absolutePath);
    if (!sameFileObject(identity, publishedIdentity)) {
      throw archiveError("archive-export-inconsistent", "The archive artifact changed during publication.");
    }
    identity = publishedIdentity;
    await closeHandle(handle);
    handle = undefined;

    return {
      relativePath: `artifacts/${id}.zip`,
      absolutePath,
      byteLength: Number(identity.size),
      contentFingerprint: manifest.contentFingerprint
    };
  } catch (error) {
    archive?.unpipe(output);
    archive?.abort();
    output?.destroy();
    await outputCompleted?.catch(() => undefined);
    if (identity) {
      await removePathWithIdentity(
        published ? finalOperationPath : temporaryOperationPath,
        identity
      ).catch(() => undefined);
    }
    await closeHandle(handle);
    if (error instanceof ArchiveError && error.code === "archive-limit-exceeded") throw error;
    throw archiveError("archive-export-inconsistent", "The archive artifact could not be completed.");
  } finally {
    await closeHandle(stable.anchor);
  }
}

export async function removeArchivePath(
  archiveRoot: string,
  relativePath: string
): Promise<void> {
  if (!(await preflightArchivePath(archiveRoot, relativePath))) return;
  if (isAbsolute(relativePath)) {
    throw archiveError("archive-entry-unsafe", "Archive cleanup requires a root-relative path.");
  }
  const normalized = normalizeArchivePath(relativePath);
  const configuredRoot = resolve(archiveRoot);
  const root = await realpath(configuredRoot);
  const pathSegments = normalized.logicalPath.split("/");
  const filename = pathSegments.pop()!;
  const parentPath = resolve(root, ...pathSegments);
  const target = resolve(parentPath, filename);
  assertUnderRoot(root, target);

  let stable: StableDirectory;
  try {
    stable = await stabilizeDirectory(root, parentPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const operationPath = stableChildPath(stable, filename);
  let handle: FileHandle | undefined;
  try {
    await assertDirectoryStable(stable);
    const beforeOpen = await lstat(operationPath, { bigint: true });
    if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink()) {
      throw archiveError("archive-entry-unsafe", "Archive cleanup can remove only regular files.");
    }
    handle = await open(operationPath, "r");
    const identity = fileIdentity(await handle.stat({ bigint: true }));
    if (!sameFileIdentity(identity, fileIdentity(beforeOpen)) || !beforeOpen.isFile()) {
      throw archiveError("archive-entry-unsafe", "The archive cleanup target changed during validation.");
    }
    await assertDirectoryStable(stable);
    await unlink(operationPath);
    await assertDirectoryStable(stable);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    await closeHandle(handle);
    await closeHandle(stable.anchor);
  }
}

/**
 * Validate an archive-relative file without creating directories or mutating
 * the target. A missing root, directory, or file is a safe no-op result;
 * symlinks, junctions, identity changes, and non-regular files fail closed.
 */
export async function preflightArchivePath(
  archiveRoot: string,
  relativePath: string
): Promise<boolean> {
  if (isAbsolute(relativePath)) {
    throw archiveError("archive-entry-unsafe", "Archive cleanup requires a root-relative path.");
  }
  const normalized = normalizeArchivePath(relativePath);
  const configuredRoot = resolve(archiveRoot);
  let root: string;
  try {
    root = await realpath(configuredRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const pathSegments = normalized.logicalPath.split("/");
  const filename = pathSegments.pop()!;
  const parentPath = resolve(root, ...pathSegments);
  assertUnderRoot(root, parentPath);

  let stable: StableDirectory | undefined;
  let handle: FileHandle | undefined;
  try {
    try {
      stable = await stabilizeDirectory(root, parentPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    const operationPath = stableChildPath(stable, filename);
    await assertDirectoryStable(stable);
    let beforeOpen: BigIntStats;
    try {
      beforeOpen = await lstat(operationPath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink()) {
      throw archiveError("archive-entry-unsafe", "Archive cleanup can remove only regular files.");
    }
    try {
      handle = await open(operationPath, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    await openedFileIdentityAtIntendedPath(handle, operationPath, fileIdentity(beforeOpen));
    await assertDirectoryStable(stable);
    return true;
  } finally {
    await closeHandle(handle);
    await closeHandle(stable?.anchor);
  }
}
