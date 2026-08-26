import { ZipArchive, type Archiver } from "archiver";
import { createHash, randomUUID } from "node:crypto";
import { constants as filesystemConstants, type BigIntStats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { PassThrough, Readable, Transform, Writable, type TransformCallback } from "node:stream";
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
const STAGED_ANCHOR = Symbol("stagedArchiveAnchor");
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

function baseManifestAssets(manifest: ArchiveManifest): readonly unknown[] {
  if (manifest.archiveType !== "system") return manifest.assets;
  return manifest.assets.map((asset) => {
    const { authority: _systemAuthority, ...baseAsset } = asset as typeof asset & {
      authority?: unknown;
    };
    const bindings = asset.bindings.map((binding) => {
      if (binding.role === "illustration_segment_variant") {
        const { createdAt: _systemCreatedAt, ...baseBinding } = binding as typeof binding & {
          createdAt?: unknown;
        };
        return baseBinding;
      }
      if (binding.role === "generation_context") {
        const { authority: _systemBindingAuthority, ...baseBinding } = binding as typeof binding & {
          authority?: unknown;
        };
        return baseBinding;
      }
      return binding;
    });
    return { ...baseAsset, bindings };
  });
}

export function supportsSecureGeneratedArchiveStaging(
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === "linux";
}

export type ArchiveLimits = RuntimeArchiveLimits;

export type StagedArchive = {
  relativePath: string;
  absolutePath: string;
  compressedBytes: number;
};

export type PersistedStagedArchiveInput = {
  archiveRoot: string;
  relativePath: string;
  compressedBytes: number;
};

export type PersistedAnchoredStagedArchiveInput = PersistedStagedArchiveInput & {
  maximumCompressedBytes: number;
  sha256: string;
  identity: ArchiveFileIdentity;
};

export type ArchiveStagingDirectory = {
  absolutePath: string;
  operationPath: string;
  assertStable(): Promise<void>;
  cleanup(): Promise<void>;
};

export type ArchiveFileIdentity = {
  device: bigint;
  inode: bigint;
  size: bigint;
  modifiedNanoseconds: bigint;
  changedNanoseconds: bigint;
};

type InternalStagedArchive = StagedArchive & {
  [STAGED_IDENTITY]: ArchiveFileIdentity;
  [STAGED_ANCHOR]?: Readonly<{
    directory: StableDirectory;
    filename: string;
  }>;
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
  [INSPECTED_IDENTITY]: ArchiveFileIdentity;
  [INSPECTED_LIMITS]: ArchiveLimits;
};

/**
 * A verified ZIP container without a manifest. This is deliberately limited
 * to compatibility adapters: callers still need to define and validate their
 * own payload contract before accepting its contents.
 */
export type InspectedArchiveContainerEntry = {
  path: string;
  compressedBytes: number;
  uncompressedBytes: number;
};

export type InspectedArchiveContainer = {
  staged: StagedArchive;
  entries: ReadonlyMap<string, InspectedArchiveContainerEntry>;
  uncompressedBytes: number;
};

type InternalInspectedArchiveContainer = InspectedArchiveContainer & {
  [INSPECTED_IDENTITY]: ArchiveFileIdentity;
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
  sha256: string;
  identity: ArchiveFileIdentity;
};

export class ArchiveError extends Error {
  readonly expose = true;

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

function fileIdentity(value: BigIntStats): ArchiveFileIdentity {
  return {
    device: value.dev,
    inode: value.ino,
    size: value.size,
    modifiedNanoseconds: value.mtimeNs,
    changedNanoseconds: value.ctimeNs
  };
}

function sameFileIdentity(left: ArchiveFileIdentity, right: ArchiveFileIdentity): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.modifiedNanoseconds === right.modifiedNanoseconds
    && left.changedNanoseconds === right.changedNanoseconds;
}

function sameFileObject(left: ArchiveFileIdentity, right: ArchiveFileIdentity): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.modifiedNanoseconds === right.modifiedNanoseconds;
}

function sameFilesystemNode(left: ArchiveFileIdentity, right: ArchiveFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

async function openedFileIdentityAtIntendedPath(
  handle: FileHandle,
  intendedPath: string,
  expectedIdentity?: ArchiveFileIdentity
): Promise<ArchiveFileIdentity> {
  let opened: ArchiveFileIdentity;
  let linked: ArchiveFileIdentity;
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

async function removeStableDirectoryContents(directory: StableDirectory): Promise<void> {
  if (!directory.anchor) {
    throw archiveError(
      "archive-entry-unsafe",
      "This platform cannot safely clean generated archive staging."
    );
  }
  const entries = await readdir(stableChildPath(directory, "."), { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "." || entry.name === ".." || basename(entry.name) !== entry.name) {
      throw archiveError("archive-entry-unsafe", "Archive staging contains an unsafe cleanup entry.");
    }
    await rm(stableChildPath(directory, entry.name), { recursive: true, force: true });
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

export async function createArchiveStagingDirectory(
  archiveRoot: string,
  prefix: string
): Promise<ArchiveStagingDirectory> {
  if (!/^[a-z0-9-]+$/i.test(prefix)) {
    throw archiveError("archive-entry-unsafe", "Archive staging requires a safe directory prefix.");
  }
  if (!supportsSecureGeneratedArchiveStaging()) {
    throw archiveError(
      "archive-entry-unsafe",
      "This platform cannot safely stage generated archive assets."
    );
  }
  const { root, directory, stable } = await prepareRootDirectory(archiveRoot, "staging");
  let directoryName: string | undefined;
  let childStable: StableDirectory | undefined;
  let cleaned = false;
  try {
    await assertDirectoryStable(stable);
    const createdPath = await mkdtemp(stableChildPath(stable, prefix));
    directoryName = basename(createdPath);
    const absolutePath = resolve(directory, directoryName);
    assertUnderRoot(root, absolutePath);
    const stabilizedChild = await stabilizeDirectory(root, absolutePath);
    childStable = stabilizedChild;
    const assertStable = async () => {
      await assertDirectoryStable(stable);
      await assertDirectoryStable(stabilizedChild);
    };
    await assertStable();
    return {
      absolutePath,
      operationPath: stableChildPath(stabilizedChild, "."),
      assertStable,
      cleanup: async () => {
        if (cleaned) return;
        try {
          await assertStable();
          const operationPath = stableChildPath(stable, directoryName!);
          const current = await lstat(operationPath, { bigint: true });
          if (!current.isDirectory() || current.isSymbolicLink() || !sameDirectoryIdentity(stabilizedChild, current)) {
            throw archiveError("archive-entry-unsafe", "Archive staging changed during cleanup.");
          }
          await removeStableDirectoryContents(stabilizedChild);
          await assertDirectoryStable(stable);
          const linked = await lstat(operationPath, { bigint: true });
          if (!linked.isDirectory() || linked.isSymbolicLink() || !sameDirectoryIdentity(stabilizedChild, linked)) {
            throw archiveError("archive-entry-unsafe", "Archive staging changed during cleanup.");
          }
          cleaned = true;
        } finally {
          await closeHandle(stabilizedChild.anchor);
          await closeHandle(stable.anchor);
        }
      }
    };
  } catch (error) {
    await closeHandle(childStable?.anchor);
    await closeHandle(stable.anchor);
    throw error;
  }
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

type FileHandleWritable = {
  output: Writable;
  settleActiveWrite(): Promise<void>;
};

function fileHandleWritable(handle: FileHandle, maximumBytes?: number): FileHandleWritable {
  let position = 0;
  let activeWrite = Promise.resolve();
  const output = new Writable({
    write(chunk: Buffer | string, encoding: BufferEncoding, callback) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      const nextPosition = position + value.byteLength;
      if (!Number.isSafeInteger(nextPosition)
        || (maximumBytes !== undefined && nextPosition > maximumBytes)) {
        callback(archiveError("archive-limit-exceeded", "The compressed archive exceeds the configured byte limit."));
        return;
      }
      const operation = (async () => {
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
      })();
      activeWrite = operation.then(() => undefined, () => undefined);
      void operation.then(() => callback(), callback);
    }
  });
  return {
    output,
    settleActiveWrite: () => activeWrite
  };
}

async function stageArchiveUploadInternal(
  source: NodeJS.ReadableStream,
  archiveRoot: string,
  limits: ArchiveLimits,
  retainAnchor: boolean
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
  let settleActiveWrite: (() => Promise<void>) | undefined;
  let identity: ArchiveFileIdentity | undefined;
  let anchorRetained = false;

  try {
    await assertDirectoryStable(stable);
    handle = await open(operationPath, "wx", 0o640);
    identity = await openedFileIdentityAtIntendedPath(handle, absolutePath);
    await assertDirectoryStable(stable);
    ({ output, settleActiveWrite } = fileHandleWritable(handle));
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
      [STAGED_IDENTITY]: identity,
      ...(retainAnchor ? { [STAGED_ANCHOR]: { directory: stable, filename } } : {})
    };
    await closeHandle(handle);
    handle = undefined;
    anchorRetained = retainAnchor;
    return staged;
  } catch (error) {
    output?.destroy();
    await settleActiveWrite?.();
    if (handle) {
      identity = await closeAndRefreshOwnedIdentity(handle, operationPath, identity);
      handle = undefined;
    }
    if (identity) await removePathWithIdentity(operationPath, identity);
    throw error;
  } finally {
    if (!anchorRetained) await closeHandle(stable.anchor);
  }
}

export async function stageArchiveUpload(
  source: NodeJS.ReadableStream,
  archiveRoot: string,
  limits: ArchiveLimits
): Promise<StagedArchive> {
  return stageArchiveUploadInternal(source, archiveRoot, limits, false);
}

/**
 * Stage an upload while retaining a descriptor capability for its parent.
 * Callers must release the capability after identity-safe cleanup.
 */
export async function stageAnchoredArchiveUpload(
  source: NodeJS.ReadableStream,
  archiveRoot: string,
  limits: ArchiveLimits
): Promise<StagedArchive> {
  if (!supportsSecureGeneratedArchiveStaging()) {
    throw archiveError("archive-entry-unsafe", "This platform cannot pin staged archive storage.");
  }
  return stageArchiveUploadInternal(source, archiveRoot, limits, true);
}

export async function releaseAnchoredStagedArchive(staged: StagedArchive): Promise<void> {
  const internal = staged as InternalStagedArchive;
  const anchored = internal[STAGED_ANCHOR];
  if (!anchored) return;
  delete internal[STAGED_ANCHOR];
  await closeHandle(anchored.directory.anchor);
}

export function stagedArchiveIdentity(staged: StagedArchive): ArchiveFileIdentity {
  const identity = (staged as InternalStagedArchive)[STAGED_IDENTITY];
  if (!identity) {
    throw archiveError("archive-checksum-mismatch", "The staged archive is missing its original file identity.");
  }
  return { ...identity };
}

export async function rehydratePersistedStagedArchive(
  input: PersistedStagedArchiveInput
): Promise<StagedArchive> {
  const relativePath = input.relativePath.replaceAll("\\", "/");
  const pathSegments = relativePath.split("/");
  if (!relativePath
    || relativePath.includes("\0")
    || relativePath.startsWith("/")
    || /^[A-Za-z]:/.test(relativePath)
    || isAbsolute(relativePath)
    || pathSegments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw archiveError("archive-entry-unsafe", "The persisted staged archive path is invalid.");
  }
  if (!safeInteger(input.compressedBytes)) {
    throw archiveError("archive-checksum-mismatch", "The persisted staged archive size is invalid.");
  }

  let root: string;
  let absolutePath: string;
  let value: BigIntStats;
  try {
    root = await realpath(resolve(input.archiveRoot));
    absolutePath = resolve(root, ...pathSegments);
    assertUnderRoot(root, absolutePath);
    const resolvedPath = await realpath(absolutePath);
    assertUnderRoot(root, resolvedPath);
    if (resolvedPath !== absolutePath) {
      throw archiveError("archive-entry-unsafe", "The persisted staged archive path uses filesystem indirection.");
    }
    value = await stat(absolutePath, { bigint: true });
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw archiveError("archive-checksum-mismatch", "The persisted staged archive could not be reopened.");
  }

  if (!value.isFile()) {
    throw archiveError("archive-entry-unsafe", "The persisted staged archive is not a regular file.");
  }
  if (value.size !== BigInt(input.compressedBytes)) {
    throw archiveError("archive-checksum-mismatch", "The persisted staged archive compressed size changed.");
  }

  return {
    relativePath,
    absolutePath,
    compressedBytes: input.compressedBytes,
    [STAGED_IDENTITY]: fileIdentity(value)
  } as InternalStagedArchive;
}

/** Private persisted-capability reopen that retains the verified parent descriptor. */
export async function rehydratePersistedAnchoredStagedArchive(
  input: PersistedAnchoredStagedArchiveInput
): Promise<StagedArchive> {
  const relativePath = input.relativePath.replaceAll("\\", "/");
  const pathSegments = relativePath.split("/");
  if (!relativePath
    || relativePath.includes("\0")
    || relativePath.startsWith("/")
    || /^[A-Za-z]:/.test(relativePath)
    || isAbsolute(relativePath)
    || pathSegments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw archiveError("archive-entry-unsafe", "The persisted staged archive path is invalid.");
  }
  if (!safeInteger(input.compressedBytes)
    || !safeInteger(input.maximumCompressedBytes)
    || input.compressedBytes > input.maximumCompressedBytes
    || !/^[a-f0-9]{64}$/.test(input.sha256)) {
    throw archiveError("archive-checksum-mismatch", "The persisted staged archive size is invalid.");
  }

  let stable: StableDirectory | undefined;
  let handle: FileHandle | undefined;
  try {
    const root = await realpath(resolve(input.archiveRoot));
    const filename = pathSegments.at(-1)!;
    const parentPath = resolve(root, ...pathSegments.slice(0, -1));
    const absolutePath = resolve(parentPath, filename);
    assertUnderRoot(root, absolutePath);
    stable = await stabilizeDirectory(root, parentPath);
    const operationPath = stableChildPath(stable, filename);
    await assertDirectoryStable(stable);
    const beforeOpen = await lstat(operationPath, { bigint: true });
    if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink()) {
      throw archiveError("archive-entry-unsafe", "The persisted staged archive is not a regular file.");
    }
    handle = await open(
      operationPath,
      filesystemConstants.O_RDONLY | filesystemConstants.O_NOFOLLOW
    );
    const identity = fileIdentity(await handle.stat({ bigint: true }));
    if (!sameFileIdentity(identity, input.identity)
      || identity.size !== BigInt(input.compressedBytes)) {
      throw archiveError("archive-checksum-mismatch", "The persisted staged archive identity changed.");
    }
    await openedFileIdentityAtIntendedPath(handle, operationPath, input.identity);
    await assertDirectoryStable(stable);
    const sha256 = await hashFileHandle(handle, input.compressedBytes);
    const finalIdentity = fileIdentity(await handle.stat({ bigint: true }));
    if (sha256 !== input.sha256 || !sameFileIdentity(identity, finalIdentity)) {
      throw archiveError("archive-checksum-mismatch", "The persisted staged archive content changed.");
    }
    await openedFileIdentityAtIntendedPath(handle, operationPath, finalIdentity);
    await assertDirectoryStable(stable);
    const staged: InternalStagedArchive = {
      relativePath,
      absolutePath,
      compressedBytes: input.compressedBytes,
      [STAGED_IDENTITY]: finalIdentity,
      [STAGED_ANCHOR]: { directory: stable, filename }
    };
    stable = undefined;
    return staged;
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw archiveError("archive-checksum-mismatch", "The persisted staged archive could not be reopened.");
  } finally {
    await closeHandle(handle);
    await closeHandle(stable?.anchor);
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
    const hasAssetIssue = parsed.error.issues.some((issue) => issue.path[0] === "assets");
    throw archiveError(
      hasAssetIssue ? "archive-asset-invalid" : "archive-json-invalid",
      hasAssetIssue
        ? "manifest.json contains invalid archive asset metadata."
        : "manifest.json does not satisfy the archive schema."
    );
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
  expectedIdentity: ArchiveFileIdentity | undefined,
  operation: (handle: FileHandle, identity: ArchiveFileIdentity, archiveSize: number) => Promise<T>
): Promise<T> {
  const stagedIdentity = (staged as InternalStagedArchive)[STAGED_IDENTITY];
  const anchored = (staged as InternalStagedArchive)[STAGED_ANCHOR];
  if (!stagedIdentity) {
    throw archiveError("archive-checksum-mismatch", "The staged archive is missing its original file identity.");
  }

  let handle: FileHandle | undefined;
  let operationError: unknown;
  let result: T | undefined;
  let initialIdentity: ArchiveFileIdentity | undefined;
  try {
    if (anchored) await assertDirectoryStable(anchored.directory);
    const operationPath = anchored
      ? stableChildPath(anchored.directory, anchored.filename)
      : staged.absolutePath;
    handle = await open(
      operationPath,
      anchored
        ? filesystemConstants.O_RDONLY | filesystemConstants.O_NOFOLLOW
        : "r"
    );
    initialIdentity = fileIdentity(await handle.stat({ bigint: true }));
    if (!sameFileIdentity(initialIdentity, stagedIdentity)
      || (expectedIdentity !== undefined && !sameFileIdentity(initialIdentity, expectedIdentity))
      || initialIdentity.size !== BigInt(staged.compressedBytes)
      || initialIdentity.size > BigInt(limits.maxCompressedBytes)) {
      throw archiveError("archive-checksum-mismatch", "The staged archive file identity or compressed size changed.");
    }
    if (anchored) {
      await openedFileIdentityAtIntendedPath(handle, operationPath, stagedIdentity);
      await assertDirectoryStable(anchored.directory);
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
      if (anchored) {
        await openedFileIdentityAtIntendedPath(
          handle,
          stableChildPath(anchored.directory, anchored.filename),
          initialIdentity
        );
        await assertDirectoryStable(anchored.directory);
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

/**
 * Inspect a manifest-less ZIP with the same structural checks as a portable
 * archive. Compatibility importers must use this instead of opening ZIP files
 * directly so legacy support cannot bypass archive safety limits.
 */
export async function inspectArchiveContainer(
  staged: StagedArchive,
  limits: ArchiveLimits
): Promise<InspectedArchiveContainer> {
  if (!safeInteger(staged.compressedBytes) || staged.compressedBytes > limits.maxCompressedBytes) {
    throw archiveError("archive-limit-exceeded", "The compressed archive exceeds the configured byte limit.");
  }

  return withVerifiedStagedArchive(staged, limits, undefined, async (handle, identity, archiveSize) => {
    const directory = await openArchiveFromHandle(handle, archiveSize, limits);
    const central = inspectCentralDirectory(directory.files, limits);
    await inspectLocalHeaders(handle, directory.files, archiveSize);
    const entries = new Map<string, InspectedArchiveContainerEntry>();
    for (const [path, file] of central.filesByPath) {
      entries.set(path, {
        path,
        compressedBytes: file.compressedSize,
        uncompressedBytes: file.uncompressedSize
      });
    }
    return {
      staged,
      entries,
      uncompressedBytes: central.uncompressedBytes,
      [INSPECTED_IDENTITY]: identity,
      [INSPECTED_LIMITS]: limits
    } as InternalInspectedArchiveContainer;
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

/**
 * Read one entry from a structurally verified manifest-less ZIP with bounded
 * decompression and a second identity/metadata verification pass.
 */
export async function readVerifiedContainerEntry(
  archive: InspectedArchiveContainer,
  path: string,
  maximumBytes: number
): Promise<Buffer> {
  if (!safeInteger(maximumBytes)) {
    throw archiveError("archive-limit-exceeded", "The requested archive read limit is invalid.");
  }
  const normalized = normalizeArchivePath(path);
  const entry = archive.entries.get(normalized.comparisonPath);
  const internal = archive as InternalInspectedArchiveContainer;
  const identity = internal[INSPECTED_IDENTITY];
  const limits = internal[INSPECTED_LIMITS];
  if (!entry || !identity || !limits) {
    throw archiveError("archive-entry-missing", "The requested archive entry does not exist.", {
      path: normalized.comparisonPath
    });
  }
  if (entry.uncompressedBytes > maximumBytes) {
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
    const measurement = await measureEntry(file, Math.min(maximumBytes, entry.uncompressedBytes), true);
    if (measurement.byteLength !== entry.uncompressedBytes) {
      throw archiveError("archive-checksum-mismatch", "The requested archive entry could not be read completely.", {
        path: normalized.comparisonPath
      });
    }
    return measurement.buffer!;
  });
}

export type VerifiedContainerEntryConsumption<Value> = Readonly<{
  value: Value;
  byteLength: number;
  sha256: string;
}>;

/**
 * Consume one verified container entry without collecting its body. The
 * consumer must drain the supplied source; returning early fails closed so a
 * checksum cannot describe bytes that the consumer never inspected.
 */
export async function consumeVerifiedContainerEntry<Value>(
  archive: InspectedArchiveContainer,
  path: string,
  maximumBytes: number,
  consume: (source: AsyncIterable<Uint8Array>) => Promise<Value>
): Promise<VerifiedContainerEntryConsumption<Value>> {
  if (!safeInteger(maximumBytes)) {
    throw archiveError("archive-limit-exceeded", "The requested archive read limit is invalid.");
  }
  const normalized = normalizeArchivePath(path);
  const entry = archive.entries.get(normalized.comparisonPath);
  const internal = archive as InternalInspectedArchiveContainer;
  const identity = internal[INSPECTED_IDENTITY];
  const limits = internal[INSPECTED_LIMITS];
  if (!entry || !identity || !limits) {
    throw archiveError("archive-entry-missing", "The requested archive entry does not exist.", {
      path: normalized.comparisonPath
    });
  }
  if (entry.uncompressedBytes > maximumBytes) {
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

    const hash = createHash("sha256");
    let byteLength = 0;
    const source: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const chunk of file.stream()) {
            const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const nextLength = byteLength + value.byteLength;
            if (!Number.isSafeInteger(nextLength) || nextLength > maximumBytes) {
              throw archiveError("archive-limit-exceeded", "An archive entry exceeds its configured byte limit.");
            }
            byteLength = nextLength;
            hash.update(value);
            yield value;
          }
        } catch (error) {
          if (error instanceof ArchiveError) throw error;
          throw archiveError("archive-checksum-mismatch", "An archive entry could not be decoded and verified.");
        }
      }
    };
    const value = await consume(source);
    if (byteLength !== entry.uncompressedBytes) {
      throw archiveError("archive-checksum-mismatch", "The requested archive entry was not consumed completely.", {
        path: normalized.comparisonPath
      });
    }
    return Object.freeze({ value, byteLength, sha256: hash.digest("hex") });
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

function measuringTransform(
  maximumBytes: number,
  reserveAggregateBytes: (byteLength: number) => void
): {
  transform: Transform;
  measurement: () => Pick<ArchiveEntry, "byteLength" | "sha256">;
} {
  const hash = createHash("sha256");
  let byteLength = 0;
  const transform = new Transform({
    writableHighWaterMark: 1,
    readableHighWaterMark: 1,
    transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      const nextLength = byteLength + value.byteLength;
      if (!Number.isSafeInteger(nextLength) || nextLength > maximumBytes) {
        callback(archiveError("archive-limit-exceeded", "An archive artifact entry exceeds its configured byte limit."));
        return;
      }
      try {
        reserveAggregateBytes(value.byteLength);
      } catch (error) {
        callback(error as Error);
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

async function closeAndRefreshOwnedIdentity(
  handle: FileHandle,
  operationPath: string,
  knownIdentity: ArchiveFileIdentity | undefined,
): Promise<ArchiveFileIdentity | undefined> {
  let pinnedIdentity = knownIdentity;
  try {
    pinnedIdentity = fileIdentity(await handle.stat({ bigint: true }));
  } catch {
    // The last known descriptor identity still fences the path reacquisition.
  }
  await closeHandle(handle);
  if (!pinnedIdentity) return undefined;
  try {
    const value = await lstat(operationPath, { bigint: true });
    const current = fileIdentity(value);
    return value.isFile()
      && !value.isSymbolicLink()
      && sameFilesystemNode(current, pinnedIdentity)
      ? current
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function restoreQuarantinedPath(quarantinePath: string, originalPath: string): Promise<void> {
  try {
    await link(quarantinePath, originalPath);
    await unlink(quarantinePath);
  } catch {
    // Retain the quarantine when the original name was reused concurrently.
  }
}

async function removePathWithIdentity(path: string, identity: ArchiveFileIdentity): Promise<void> {
  const quarantinePath = resolve(dirname(path), `.cleanup-${randomUUID()}`);
  try {
    const value = await lstat(path, { bigint: true });
    const current = fileIdentity(value);
    if (!value.isFile() || value.isSymbolicLink() || !sameFileIdentity(current, identity)) {
      return;
    }
    await rename(path, quarantinePath);
    const quarantinedValue = await lstat(quarantinePath, { bigint: true });
    const quarantined = fileIdentity(quarantinedValue);
    if (!quarantinedValue.isFile()
      || quarantinedValue.isSymbolicLink()
      || !sameFileObject(quarantined, identity)) {
      await restoreQuarantinedPath(quarantinePath, path);
      return;
    }
    await unlink(quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function hashFileHandle(handle: FileHandle, expectedSize: number): Promise<string> {
  const hash = createHash("sha256");
  let position = 0;
  while (position < expectedSize) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, expectedSize - position));
    const read = await handle.read(buffer, 0, buffer.byteLength, position);
    if (read.bytesRead === 0) {
      throw archiveError("archive-export-inconsistent", "The archive artifact became truncated before publication.");
    }
    hash.update(buffer.subarray(0, read.bytesRead));
    position += read.bytesRead;
  }
  const extra = Buffer.allocUnsafe(1);
  if ((await handle.read(extra, 0, 1, position)).bytesRead !== 0) {
    throw archiveError("archive-export-inconsistent", "The archive artifact grew before publication.");
  }
  return hash.digest("hex");
}

async function writeArchiveArtifactStream(
  output: Writable,
  entries: readonly ArchiveArtifactEntry[],
  buildManifest: (entries: readonly ArchiveEntry[]) => ArchiveManifest,
  limits: ArchiveLimits | undefined,
  parseBuiltManifest: (value: unknown) => ArchiveManifest,
): Promise<void> {
  assertWriterEntries(entries);
  if (limits && entries.length + 1 > limits.maxEntries) {
    throw archiveError("archive-limit-exceeded", "The archive contains too many entries.");
  }
  let archive: Archiver | undefined;
  let activeSource: Readable | undefined;
  let activeTransform: Transform | undefined;
  const outputCompleted = finished(output);
  const outputFailed = new Promise<never>((_resolve, reject) => {
    output.once("error", (error) => {
      activeSource?.destroy(error);
      activeTransform?.destroy(error);
      archive?.abort();
      reject(error);
    });
  });
  void outputFailed.catch(() => undefined);
  try {
    archive = new ZipArchive({ forceLocalTime: false, zlib: { level: 9 } });
    archive.on("warning", (error) => output.destroy(error));
    archive.on("error", (error) => output.destroy(error));
    archive.pipe(output);

    const measuredEntries: ArchiveEntry[] = [];
    let uncompressedBytes = 0;
    for (const entry of entries) {
      const normalized = normalizeArchivePath(entry.path);
      const mediaType = entry.mediaType.toLocaleLowerCase("en-US");
      const jsonEntry = mediaType === "application/json"
        || mediaType === "application/x-ndjson"
        || mediaType.endsWith("+json")
        || normalized.logicalPath.toLocaleLowerCase("en-US").endsWith(".json")
        || normalized.logicalPath.toLocaleLowerCase("en-US").endsWith(".ndjson");
      const entryMaximum = limits
        ? Math.min(
          limits.maxUncompressedBytes,
          ...(jsonEntry ? [limits.maxJsonEntryBytes] : []),
          ...(mediaType.startsWith("image/") ? [limits.maxOriginalImageBytes] : [])
        )
        : Number.MAX_SAFE_INTEGER;
      const measured = measuringTransform(entryMaximum, (byteLength) => {
        const nextTotal = uncompressedBytes + byteLength;
        if (!Number.isSafeInteger(nextTotal)
          || (limits !== undefined && nextTotal > limits.maxUncompressedBytes)) {
          throw archiveError("archive-limit-exceeded", "The archive exceeds the configured uncompressed byte limit.");
        }
        uncompressedBytes = nextTotal;
      });
      archive.append(measured.transform, {
        name: normalized.logicalPath,
        date: FIXED_ZIP_DATE,
        mode: 0o100640,
      });
      activeSource = entry.source as Readable;
      activeTransform = measured.transform;
      const entryPipeline = pipeline(activeSource, activeTransform);
      try {
        await Promise.race([entryPipeline, outputFailed]);
      } catch (error) {
        measured.transform.destroy();
        (entry.source as Readable).destroy?.();
        await entryPipeline.catch(() => undefined);
        throw error;
      }
      activeSource = undefined;
      activeTransform = undefined;
      const measurement = measured.measurement();
      measuredEntries.push({
        path: normalized.logicalPath,
        logicalType: entry.logicalType,
        mediaType: entry.mediaType,
        ...measurement,
      });
    }

    const manifest = parseBuiltManifest(buildManifest(measuredEntries));
    archiveManifestSchema.parse({
      format: manifest.format,
      formatVersion: manifest.formatVersion,
      archiveType: manifest.archiveType,
      createdAt: manifest.createdAt,
      contentFingerprint: manifest.contentFingerprint,
      campaignId: manifest.campaignId,
      worldId: manifest.worldId,
      worldVersionId: manifest.worldVersionId,
      entries: manifest.entries,
      payloads: manifest.payloads,
      assets: baseManifestAssets(manifest),
    });
    if (canonicalArchiveJson(manifest.entries) !== canonicalArchiveJson(measuredEntries)) {
      throw archiveError("archive-export-inconsistent", "The archive manifest entries do not match the streamed artifact entries.");
    }
    const manifestBytes = Buffer.from(canonicalArchiveJson(manifest), "utf8");
    if (limits && manifestBytes.byteLength > limits.maxManifestBytes) {
      throw archiveError("archive-limit-exceeded", "manifest.json exceeds the configured byte limit.");
    }
    if (limits && (!Number.isSafeInteger(uncompressedBytes + manifestBytes.byteLength)
      || uncompressedBytes + manifestBytes.byteLength > limits.maxUncompressedBytes)) {
      throw archiveError("archive-limit-exceeded", "The archive exceeds the configured uncompressed byte limit.");
    }
    archive.append(manifestBytes, {
      name: "manifest.json",
      date: FIXED_ZIP_DATE,
      mode: 0o100640,
      store: true,
    });
    await archive.finalize();
    await outputCompleted;
  } catch (error) {
    activeSource?.destroy();
    activeTransform?.destroy();
    archive?.unpipe(output);
    archive?.abort();
    output.destroy(error instanceof Error ? error : undefined);
    await outputCompleted.catch(() => undefined);
    if (error instanceof ArchiveError && error.code === "archive-limit-exceeded") throw error;
    if (error instanceof ArchiveError) throw error;
    throw archiveError("archive-export-inconsistent", "The archive artifact could not be completed.");
  }
}

/**
 * Produces a deterministic validated ZIP stream without creating an unmanaged
 * filesystem artifact. The caller supplies the durable bounded sink.
 */
export function createArchiveArtifactSource(
  entries: readonly ArchiveArtifactEntry[],
  buildManifest: (entries: readonly ArchiveEntry[]) => ArchiveManifest,
  limits?: ArchiveLimits,
  parseBuiltManifest: (value: unknown) => ArchiveManifest = (value) => archiveManifestSchema.parse(value),
): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      const output = new PassThrough({ highWaterMark: 64 * 1024 });
      const writing = writeArchiveArtifactStream(output, entries, buildManifest, limits, parseBuiltManifest);
      void writing.catch(() => undefined);
      try {
        for await (const chunk of output) yield new Uint8Array(chunk);
        await writing;
      } finally {
        if (!output.destroyed) output.destroy();
        await writing.catch(() => undefined);
      }
    },
  };
}

export async function writeArchiveArtifact(
  archiveRoot: string,
  entries: readonly ArchiveArtifactEntry[],
  buildManifest: (entries: readonly ArchiveEntry[]) => ArchiveManifest,
  limits?: ArchiveLimits,
  parseBuiltManifest: (value: unknown) => ArchiveManifest = (value) => archiveManifestSchema.parse(value)
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
  let identity: ArchiveFileIdentity | undefined;
  let output: Writable | undefined;
  let settleActiveWrite: (() => Promise<void>) | undefined;
  let outputCompleted: Promise<void> | undefined;
  let archive: Archiver | undefined;
  let activeSource: Readable | undefined;
  let activeTransform: Transform | undefined;
  let published = false;

  try {
    await assertDirectoryStable(stable);
    handle = await open(temporaryOperationPath, "wx+", 0o640);
    identity = await openedFileIdentityAtIntendedPath(handle, temporaryPath);
    await assertDirectoryStable(stable);
    ({ output, settleActiveWrite } = fileHandleWritable(handle, limits?.maxCompressedBytes));
    outputCompleted = finished(output);
    const outputFailed = new Promise<never>((_resolve, reject) => {
      output!.once("error", (error) => {
        activeSource?.destroy(error);
        activeTransform?.destroy(error);
        archive?.abort();
        reject(error);
      });
    });
    void outputFailed.catch(() => undefined);
    archive = new ZipArchive({ forceLocalTime: false, zlib: { level: 9 } });
    archive.on("warning", (error) => output?.destroy(error));
    archive.on("error", (error) => output?.destroy(error));
    archive.pipe(output);

    const measuredEntries: ArchiveEntry[] = [];
    let uncompressedBytes = 0;
    for (const entry of entries) {
      const normalized = normalizeArchivePath(entry.path);
      const mediaType = entry.mediaType.toLocaleLowerCase("en-US");
      const jsonEntry = mediaType === "application/json"
        || mediaType === "application/x-ndjson"
        || mediaType.endsWith("+json")
        || normalized.logicalPath.toLocaleLowerCase("en-US").endsWith(".json")
        || normalized.logicalPath.toLocaleLowerCase("en-US").endsWith(".ndjson");
      const entryMaximum = limits
        ? Math.min(
          limits.maxUncompressedBytes,
          ...(jsonEntry ? [limits.maxJsonEntryBytes] : []),
          ...(mediaType.startsWith("image/") ? [limits.maxOriginalImageBytes] : [])
        )
        : Number.MAX_SAFE_INTEGER;
      const measured = measuringTransform(entryMaximum, (byteLength) => {
        const nextTotal = uncompressedBytes + byteLength;
        if (!Number.isSafeInteger(nextTotal)
          || (limits !== undefined && nextTotal > limits.maxUncompressedBytes)) {
          throw archiveError("archive-limit-exceeded", "The archive exceeds the configured uncompressed byte limit.");
        }
        uncompressedBytes = nextTotal;
      });
      archive.append(measured.transform, {
        name: normalized.logicalPath,
        date: FIXED_ZIP_DATE,
        mode: 0o100640
      });
      activeSource = entry.source as Readable;
      activeTransform = measured.transform;
      const entryPipeline = pipeline(activeSource, activeTransform);
      try {
        await Promise.race([entryPipeline, outputFailed]);
      } catch (error) {
        measured.transform.destroy();
        (entry.source as Readable).destroy?.();
        await entryPipeline.catch(() => undefined);
        throw error;
      }
      activeSource = undefined;
      activeTransform = undefined;
      const measurement = measured.measurement();
      measuredEntries.push({
        path: normalized.logicalPath,
        logicalType: entry.logicalType,
        mediaType: entry.mediaType,
        ...measurement
      });
    }

    const manifest = parseBuiltManifest(buildManifest(measuredEntries));
    archiveManifestSchema.parse({
      format: manifest.format,
      formatVersion: manifest.formatVersion,
      archiveType: manifest.archiveType,
      createdAt: manifest.createdAt,
      contentFingerprint: manifest.contentFingerprint,
      campaignId: manifest.campaignId,
      worldId: manifest.worldId,
      worldVersionId: manifest.worldVersionId,
      entries: manifest.entries,
      payloads: manifest.payloads,
      assets: baseManifestAssets(manifest)
    });
    if (canonicalArchiveJson(manifest.entries) !== canonicalArchiveJson(measuredEntries)) {
      throw archiveError("archive-export-inconsistent", "The archive manifest entries do not match the streamed artifact entries.");
    }
    const manifestBytes = Buffer.from(canonicalArchiveJson(manifest), "utf8");
    if (limits && manifestBytes.byteLength > limits.maxManifestBytes) {
      throw archiveError("archive-limit-exceeded", "manifest.json exceeds the configured byte limit.");
    }
    if (limits && (!Number.isSafeInteger(uncompressedBytes + manifestBytes.byteLength)
      || uncompressedBytes + manifestBytes.byteLength > limits.maxUncompressedBytes)) {
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
    await handle.chmod(0o440);
    await handle.sync();
    identity = fileIdentity(await handle.stat({ bigint: true }));
    await openedFileIdentityAtIntendedPath(handle, absolutePath, identity);
    const sha256 = await hashFileHandle(handle, Number(identity.size));
    const finalIdentity = fileIdentity(await handle.stat({ bigint: true }));
    if (!sameFileIdentity(identity, finalIdentity)) {
      throw archiveError("archive-export-inconsistent", "The archive artifact changed while its publication hash was measured.");
    }
    await closeHandle(handle);
    handle = undefined;

    return {
      relativePath: `artifacts/${id}.zip`,
      absolutePath,
      byteLength: Number(identity.size),
      contentFingerprint: manifest.contentFingerprint,
      sha256,
      identity
    };
  } catch (error) {
    activeSource?.destroy();
    activeTransform?.destroy();
    archive?.unpipe(output);
    archive?.abort();
    output?.destroy();
    await outputCompleted?.catch(() => undefined);
    await settleActiveWrite?.();
    if (handle) {
      identity = await closeAndRefreshOwnedIdentity(
        handle,
        published ? finalOperationPath : temporaryOperationPath,
        identity,
      );
      handle = undefined;
    }
    if (identity) {
      await removePathWithIdentity(
        published ? finalOperationPath : temporaryOperationPath,
        identity
      ).catch(() => undefined);
    }
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
