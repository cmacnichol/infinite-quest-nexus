import { ZipArchive, type Archiver } from "archiver";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, type WriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
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

const INSPECTED_FILES = Symbol("inspectedArchiveFiles");
const FIXED_ZIP_DATE = new Date("1980-01-01T00:00:00.000Z");
const UNIX_HOST = 3;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_DIRECTORY_TYPE = 0o040000;
const UNIX_REGULAR_FILE_TYPE = 0o100000;

export type ArchiveLimits = RuntimeArchiveLimits;

export type StagedArchive = {
  relativePath: string;
  absolutePath: string;
  compressedBytes: number;
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
  [INSPECTED_FILES]: ReadonlyMap<string, ZipFile>;
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

async function prepareRootDirectory(archiveRoot: string, child: "staging" | "artifacts"): Promise<{
  root: string;
  directory: string;
}> {
  const configuredRoot = resolve(archiveRoot);
  await mkdir(configuredRoot, { recursive: true });
  const root = await realpath(configuredRoot);
  const childPath = resolve(root, child);
  assertUnderRoot(root, childPath);
  await mkdir(childPath, { recursive: true });
  const directory = await realpath(childPath);
  assertUnderRoot(root, directory);
  return { root, directory };
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

export async function stageArchiveUpload(
  source: NodeJS.ReadableStream,
  archiveRoot: string,
  limits: ArchiveLimits
): Promise<StagedArchive> {
  const { root, directory } = await prepareRootDirectory(archiveRoot, "staging");
  const filename = `${randomUUID()}.zip`;
  const absolutePath = resolve(directory, filename);
  assertUnderRoot(root, absolutePath);
  const relativePath = `staging/${filename}`;
  const counter = new CompressedByteCounter(limits.maxCompressedBytes);
  const output = (await open(absolutePath, "wx", 0o640)).createWriteStream();

  try {
    await pipeline(source as Readable, counter, output);
    if ((source as NodeJS.ReadableStream & { truncated?: boolean }).truncated === true) {
      throw archiveError("archive-limit-exceeded", "The compressed archive upload was truncated.");
    }
    return {
      relativePath,
      absolutePath,
      compressedBytes: counter.byteLength
    };
  } catch (error) {
    output.destroy();
    await rm(absolutePath, { force: true });
    throw error;
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
  normalizedEntries: Map<ZipFile, NormalizedArchivePath>;
  directories: Set<string>;
  uncompressedBytes: number;
} {
  if (files.length > limits.maxEntries) {
    throw archiveError("archive-limit-exceeded", "The archive contains too many entries.");
  }

  const paths = new Map<string, "file" | "directory">();
  const filesByPath = new Map<string, ZipFile>();
  const normalizedEntries = new Map<ZipFile, NormalizedArchivePath>();
  const directories = new Set<string>();
  let uncompressedBytes = 0;

  for (const file of files) {
    const directory = file.type === "Directory" || file.path.endsWith("/");
    const normalized = normalizeArchivePath(file.path, directory);
    const path = normalized.comparisonPath;
    normalizedEntries.set(file, normalized);

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
      directories.add(ancestor);
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

    if (directory) {
      directories.add(path);
    } else {
      filesByPath.set(path, file);
    }
  }

  return { filesByPath, normalizedEntries, directories, uncompressedBytes };
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

export async function inspectArchive(
  staged: StagedArchive,
  limits: ArchiveLimits,
  expectedType?: ArchiveType
): Promise<InspectedArchive> {
  if (!safeInteger(staged.compressedBytes) || staged.compressedBytes > limits.maxCompressedBytes) {
    throw archiveError("archive-limit-exceeded", "The compressed archive exceeds the configured byte limit.");
  }

  let directory: unzipper.CentralDirectory;
  try {
    directory = await unzipper.Open.file(staged.absolutePath);
  } catch {
    throw archiveError("archive-format-unrecognized", "The uploaded file is not a recognized ZIP archive.");
  }

  const central = inspectCentralDirectory(directory.files, limits);
  const manifestFile = central.filesByPath.get("manifest.json");
  if (!manifestFile) {
    throw archiveError("archive-entry-missing", "The archive is missing manifest.json.");
  }
  if (manifestFile.uncompressedSize > limits.maxManifestBytes) {
    throw archiveError("archive-limit-exceeded", "manifest.json exceeds the configured byte limit.");
  }

  const manifestMeasurement = await measureEntry(manifestFile, limits.maxManifestBytes, true);
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
  const inspectedFiles = new Map<string, ZipFile>();
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

    const maximumBytes = isJsonEntry(declared) ? limits.maxJsonEntryBytes : limits.maxUncompressedBytes;
    const measurement = await measureEntry(file, maximumBytes, false);
    if (measurement.byteLength !== declared.byteLength || measurement.sha256 !== declared.sha256) {
      throw archiveError("archive-checksum-mismatch", "An archive entry does not match its manifest.", { path });
    }

    entries.set(path, {
      ...declared,
      compressedBytes: file.compressedSize,
      uncompressedBytes: file.uncompressedSize
    });
    inspectedFiles.set(path, file);
  }

  const inspected: InternalInspectedArchive = {
    manifest,
    staged,
    entries,
    uncompressedBytes: central.uncompressedBytes,
    [INSPECTED_FILES]: inspectedFiles
  };
  return inspected;
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
  const file = (archive as InternalInspectedArchive)[INSPECTED_FILES]?.get(normalized.comparisonPath);
  if (!entry || !file) {
    throw archiveError("archive-entry-missing", "The requested archive entry does not exist.", {
      path: normalized.comparisonPath
    });
  }
  if (entry.byteLength > maximumBytes) {
    throw archiveError("archive-limit-exceeded", "The requested archive entry exceeds the configured byte limit.", {
      path: normalized.comparisonPath
    });
  }

  const measurement = await measureEntry(file, maximumBytes, true);
  if (measurement.byteLength !== entry.byteLength || measurement.sha256 !== entry.sha256) {
    throw archiveError("archive-checksum-mismatch", "The requested archive entry no longer matches its manifest.", {
      path: normalized.comparisonPath
    });
  }
  return measurement.buffer!;
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

export async function writeArchiveArtifact(
  archiveRoot: string,
  entries: readonly ArchiveArtifactEntry[],
  buildManifest: (entries: readonly ArchiveEntry[]) => ArchiveManifest
): Promise<CompletedArchiveArtifact> {
  assertWriterEntries(entries);
  const { root, directory } = await prepareRootDirectory(archiveRoot, "artifacts");
  const id = randomUUID();
  const temporaryPath = resolve(directory, `${id}.zip.tmp`);
  const absolutePath = resolve(directory, `${id}.zip`);
  assertUnderRoot(root, temporaryPath);
  assertUnderRoot(root, absolutePath);

  let handle: FileHandle | undefined;
  let output: WriteStream | undefined;
  let outputCompleted: Promise<void> | undefined;
  let archive: Archiver | undefined;
  let published = false;

  try {
    handle = await open(temporaryPath, "wx", 0o640);
    output = handle.createWriteStream({ autoClose: true, flush: true });
    outputCompleted = finished(output);
    handle = undefined;
    archive = new ZipArchive({ forceLocalTime: false, zlib: { level: 9 } });
    archive.on("warning", (error) => output?.destroy(error));
    archive.on("error", (error) => output?.destroy(error));
    archive.pipe(output);

    const measuredEntries: ArchiveEntry[] = [];
    for (const entry of entries) {
      const normalized = normalizeArchivePath(entry.path);
      const measured = measuringTransform();
      archive.append(measured.transform, {
        name: normalized.logicalPath,
        date: FIXED_ZIP_DATE,
        mode: 0o100640
      });
      await pipeline(entry.source as Readable, measured.transform);
      measuredEntries.push({
        path: normalized.logicalPath,
        logicalType: entry.logicalType,
        mediaType: entry.mediaType,
        ...measured.measurement()
      });
    }

    const manifest = archiveManifestSchema.parse(buildManifest(measuredEntries));
    if (canonicalArchiveJson(manifest.entries) !== canonicalArchiveJson(measuredEntries)) {
      throw archiveError("archive-export-inconsistent", "The archive manifest entries do not match the streamed artifact entries.");
    }
    const manifestBytes = Buffer.from(canonicalArchiveJson(manifest), "utf8");
    archive.append(manifestBytes, {
      name: "manifest.json",
      date: FIXED_ZIP_DATE,
      mode: 0o100640,
      store: true
    });

    await archive.finalize();
    await outputCompleted;
    await rename(temporaryPath, absolutePath);
    published = true;

    const archiveStat = await stat(absolutePath);
    return {
      relativePath: `artifacts/${id}.zip`,
      absolutePath,
      byteLength: archiveStat.size,
      contentFingerprint: manifest.contentFingerprint
    };
  } catch {
    archive?.unpipe(output);
    archive?.abort();
    output?.destroy();
    await outputCompleted?.catch(() => undefined);
    await closeHandle(handle);
    await rm(temporaryPath, { force: true });
    if (published) await rm(absolutePath, { force: true });
    throw archiveError("archive-export-inconsistent", "The archive artifact could not be completed.");
  }
}

export async function removeArchivePath(
  archiveRoot: string,
  relativePath: string
): Promise<void> {
  if (isAbsolute(relativePath)) {
    throw archiveError("archive-entry-unsafe", "Archive cleanup requires a root-relative path.");
  }
  const normalized = normalizeArchivePath(relativePath);
  const configuredRoot = resolve(archiveRoot);
  await mkdir(configuredRoot, { recursive: true });
  const root = await realpath(configuredRoot);
  const target = resolve(root, ...normalized.logicalPath.split("/"));
  assertUnderRoot(root, target);

  let targetStat: Awaited<ReturnType<typeof lstat>>;
  try {
    const parent = await realpath(resolve(target, ".."));
    assertUnderRoot(root, parent);
    targetStat = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
    throw archiveError("archive-entry-unsafe", "Archive cleanup can remove only regular files.");
  }
  await unlink(target);
}
