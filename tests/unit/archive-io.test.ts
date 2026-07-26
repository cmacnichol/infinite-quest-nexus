import { ZipArchive } from "archiver";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { Open } from "unzipper";
import {
  ArchiveError,
  inspectArchive,
  readVerifiedEntry,
  removeArchivePath,
  stageArchiveUpload,
  writeArchiveArtifact,
  type ArchiveArtifactEntry,
  type ArchiveLimits,
  type StagedArchive
} from "../../services/api/src/archive-io.js";
import { loadRuntimeConfig } from "../../packages/database/src/config.js";
import type { ArchiveEntry, ArchiveManifest } from "../../packages/contracts/src/archives.js";

const originalEnvironment = { ...process.env };
const temporaryRoots: string[] = [];
const DEFAULT_LIMITS: ArchiveLimits = {
  maxCompressedBytes: 10_000_000,
  maxUncompressedBytes: 10_000_000,
  maxEntries: 100,
  maxExpansionRatio: 1_000,
  maxManifestBytes: 5 * 1024 * 1024,
  maxJsonEntryBytes: 1024 * 1024
};

afterEach(async () => {
  process.env = { ...originalEnvironment };
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "infinite-quest-archive-io-"));
  temporaryRoots.push(root);
  return root;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function archiveEntry(path: string, content: Buffer, mediaType = "application/json"): ArchiveEntry {
  return {
    path,
    logicalType: "records",
    mediaType,
    byteLength: content.byteLength,
    sha256: sha256(content)
  };
}

function systemManifest(entries: readonly ArchiveEntry[]): ArchiveManifest {
  return {
    format: "infinite-quest-archive",
    formatVersion: 1,
    archiveType: "system",
    createdAt: "2026-07-26T00:00:00.000Z",
    contentFingerprint: "1".repeat(64),
    entries: [...entries],
    payloads: entries.map((entry) => ({
      kind: "records" as const,
      path: entry.path,
      formatVersion: 1
    })),
    assets: []
  };
}

async function writeZip(
  path: string,
  entries: readonly { name: string; content: Buffer; store?: boolean; mode?: number }[]
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const output = createWriteStream(path, { flags: "wx" });
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const completed = once(output, "close");
  archive.on("warning", (error) => {
    throw error;
  });
  archive.pipe(output);
  for (const entry of entries) {
    archive.append(entry.content, {
      name: entry.name,
      ...(entry.store === undefined ? {} : { store: entry.store }),
      ...(entry.mode === undefined ? {} : { mode: entry.mode })
    });
  }
  await archive.finalize();
  await completed;
}

async function writeManifestZip(
  path: string,
  files: readonly { name: string; content: Buffer; mediaType?: string; store?: boolean }[],
  manifestEntries: readonly ArchiveEntry[] = files.map((file) => archiveEntry(file.name, file.content, file.mediaType))
): Promise<void> {
  const manifest = systemManifest(manifestEntries);
  await writeZip(path, [
    ...files,
    { name: "manifest.json", content: Buffer.from(JSON.stringify(manifest), "utf8"), store: true }
  ]);
}

async function stagedFixture(root: string, zipPath: string, limits = DEFAULT_LIMITS): Promise<StagedArchive> {
  return stageArchiveUpload(createReadStream(zipPath), root, limits);
}

function centralDirectoryOffsets(buffer: Buffer): number[] {
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const offsets: number[] = [];
  let offset = 0;
  while ((offset = buffer.indexOf(signature, offset)) !== -1) {
    offsets.push(offset);
    offset += signature.byteLength;
  }
  return offsets;
}

async function patchSingleEntryCentralDirectory(
  zipPath: string,
  patch: (buffer: Buffer, centralOffset: number) => void
): Promise<void> {
  const buffer = await readFile(zipPath);
  const offsets = centralDirectoryOffsets(buffer);
  expect(offsets).toHaveLength(1);
  patch(buffer, offsets[0]!);
  await writeFile(zipPath, buffer);
}

async function unsafePathFixture(root: string, unsafePath: string): Promise<StagedArchive> {
  const safeName = "x".repeat(Buffer.byteLength(unsafePath, "utf8"));
  const zipPath = join(root, `${crypto.randomUUID()}.zip`);
  await writeZip(zipPath, [{ name: safeName, content: Buffer.from("unsafe") }]);
  await patchSingleEntryCentralDirectory(zipPath, (buffer, offset) => {
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    expect(fileNameLength).toBe(Buffer.byteLength(unsafePath, "utf8"));
    buffer.write(unsafePath, offset + 46, fileNameLength, "utf8");
  });
  return stagedFixture(root, zipPath);
}

async function expectArchiveError(
  operation: Promise<unknown>,
  code: ArchiveError["code"]
): Promise<ArchiveError> {
  try {
    await operation;
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveError);
    expect((error as ArchiveError).code).toBe(code);
    return error as ArchiveError;
  }
}

describe("archive runtime configuration", () => {
  it("loads the approved campaign and system defaults", () => {
    process.env.DATABASE_URL = "postgresql://test@localhost/test";
    for (const name of Object.keys(process.env)) {
      if (name.startsWith("CAMPAIGN_ARCHIVE_") || name.startsWith("SYSTEM_ARCHIVE_") || name === "ARCHIVE_STORAGE_ROOT") {
        delete process.env[name];
      }
    }

    const config = loadRuntimeConfig();

    expect(config.archiveStorageRoot).toBe(resolve("local-data/archives"));
    expect(config.archivePreviewTtlSeconds).toBe(1_800);
    expect(config.systemArchiveArtifactTtlSeconds).toBe(86_400);
    expect(config.campaignArchiveLimits).toEqual({
      maxCompressedBytes: 2_147_483_648,
      maxUncompressedBytes: 21_474_836_480,
      maxEntries: 100_000,
      maxExpansionRatio: 100,
      maxManifestBytes: 5_242_880,
      maxJsonEntryBytes: 1_073_741_824
    });
    expect(config.systemArchiveLimits).toEqual({
      maxCompressedBytes: 53_687_091_200,
      maxUncompressedBytes: 214_748_364_800,
      maxEntries: 1_000_000,
      maxExpansionRatio: 100,
      maxManifestBytes: 5_242_880,
      maxJsonEntryBytes: 1_073_741_824
    });
  });

  it("permits lower archive limits and caps higher operator values", () => {
    process.env.DATABASE_URL = "postgresql://test@localhost/test";
    process.env.CAMPAIGN_ARCHIVE_MAX_COMPRESSED_BYTES = "1048576";
    process.env.SYSTEM_ARCHIVE_MAX_ENTRIES = "999999999";
    process.env.ARCHIVE_PREVIEW_TTL_SECONDS = "1";
    process.env.SYSTEM_ARCHIVE_ARTIFACT_TTL_SECONDS = "999999999";

    const config = loadRuntimeConfig();

    expect(config.campaignArchiveLimits.maxCompressedBytes).toBe(1_048_576);
    expect(config.systemArchiveLimits.maxEntries).toBe(1_000_000);
    expect(config.archivePreviewTtlSeconds).toBe(60);
    expect(config.systemArchiveArtifactTtlSeconds).toBe(604_800);
  });
});

describe("staged archive uploads", () => {
  it("enforces the compressed-byte limit and removes the partial staging file", async () => {
    const root = await temporaryRoot();

    await expectArchiveError(
      stageArchiveUpload(Readable.from(Buffer.alloc(11, 1)), root, { ...DEFAULT_LIMITS, maxCompressedBytes: 10 }),
      "archive-limit-exceeded"
    );

    expect(await readdir(join(root, "staging"))).toEqual([]);
  });

  it("removes a partial staging file when the source stream fails", async () => {
    const root = await temporaryRoot();
    const source = new Readable({
      read() {
        this.push(Buffer.from("partial"));
        this.destroy(new Error("fixture stream failure"));
      }
    });

    await expect(stageArchiveUpload(source, root, DEFAULT_LIMITS)).rejects.toThrow("fixture stream failure");
    expect(await readdir(join(root, "staging"))).toEqual([]);
  });

  it("uses a generated root-relative staging path and reports compressed bytes", async () => {
    const root = await temporaryRoot();
    const staged = await stageArchiveUpload(Readable.from(Buffer.from("PK fixture")), root, DEFAULT_LIMITS);

    expect(staged.relativePath).toMatch(/^staging\/[0-9a-f-]+\.zip$/);
    expect(staged.absolutePath).toBe(resolve(root, ...staged.relativePath.split("/")));
    expect(staged.compressedBytes).toBe(10);
    expect(basename(staged.absolutePath)).not.toContain("fixture");
  });
});

describe("central-directory safety validation", () => {
  it.each([
    ["../bad!", "traversal"],
    ["C:/bad!", "drive path"],
    ["a\\b.txt", "backslash"],
    ["a\u0001b.txt", "control character"],
    ["a\0b.txt", "NUL"]
  ])("rejects %s as an unsafe archive path (%s)", async (unsafePath) => {
    const root = await temporaryRoot();
    const staged = await unsafePathFixture(root, unsafePath);

    await expectArchiveError(inspectArchive(staged, DEFAULT_LIMITS), "archive-entry-unsafe");
  });

  it("rejects duplicate file names after case folding", async () => {
    const root = await temporaryRoot();
    const zipPath = join(root, "case-duplicate.zip");
    await writeZip(zipPath, [
      { name: "Data.json", content: Buffer.from("{}") },
      { name: "data.json", content: Buffer.from("{}") }
    ]);

    await expectArchiveError(
      inspectArchive(await stagedFixture(root, zipPath), DEFAULT_LIMITS),
      "archive-entry-duplicate"
    );
  });

  it("rejects duplicate file names after Unicode NFC normalization", async () => {
    const root = await temporaryRoot();
    const zipPath = join(root, "unicode-duplicate.zip");
    await writeZip(zipPath, [
      { name: "caf\u00e9.json", content: Buffer.from("{}") },
      { name: "cafe\u0301.json", content: Buffer.from("{}") }
    ]);

    await expectArchiveError(
      inspectArchive(await stagedFixture(root, zipPath), DEFAULT_LIMITS),
      "archive-entry-duplicate"
    );
  });

  it("rejects a file that collides with a required directory path", async () => {
    const root = await temporaryRoot();
    const zipPath = join(root, "directory-collision.zip");
    await writeZip(zipPath, [
      { name: "records", content: Buffer.from("file") },
      { name: "records/data.json", content: Buffer.from("{}") }
    ]);

    await expectArchiveError(
      inspectArchive(await stagedFixture(root, zipPath), DEFAULT_LIMITS),
      "archive-entry-duplicate"
    );
  });

  it("rejects encrypted central-directory entries", async () => {
    const root = await temporaryRoot();
    const zipPath = join(root, "encrypted.zip");
    await writeZip(zipPath, [{ name: "data.json", content: Buffer.from("{}") }]);
    await patchSingleEntryCentralDirectory(zipPath, (buffer, offset) => {
      buffer.writeUInt16LE(buffer.readUInt16LE(offset + 8) | 0x0001, offset + 8);
    });

    await expectArchiveError(
      inspectArchive(await stagedFixture(root, zipPath), DEFAULT_LIMITS),
      "archive-entry-unsafe"
    );
  });

  it("rejects symlink central-directory entries", async () => {
    const root = await temporaryRoot();
    const zipPath = join(root, "symlink.zip");
    await writeZip(zipPath, [{ name: "data.json", content: Buffer.from("target") }]);
    await patchSingleEntryCentralDirectory(zipPath, (buffer, offset) => {
      buffer.writeUInt16LE(0x0314, offset + 4);
      buffer.writeUInt32LE((0o120777 << 16) >>> 0, offset + 38);
    });

    await expectArchiveError(
      inspectArchive(await stagedFixture(root, zipPath), DEFAULT_LIMITS),
      "archive-entry-unsafe"
    );
  });

  it("rejects unsupported compression methods", async () => {
    const root = await temporaryRoot();
    const zipPath = join(root, "unsupported-compression.zip");
    await writeZip(zipPath, [{ name: "data.json", content: Buffer.from("{}") }]);
    await patchSingleEntryCentralDirectory(zipPath, (buffer, offset) => {
      buffer.writeUInt16LE(99, offset + 10);
    });

    await expectArchiveError(
      inspectArchive(await stagedFixture(root, zipPath), DEFAULT_LIMITS),
      "archive-entry-unsafe"
    );
  });
});

describe("bounded manifest and entry verification", () => {
  it("enforces the manifest byte limit before parsing JSON", async () => {
    const root = await temporaryRoot();
    const zipPath = join(root, "large-manifest.zip");
    await writeZip(zipPath, [{ name: "manifest.json", content: Buffer.alloc(11, 0x20), store: true }]);

    await expectArchiveError(
      inspectArchive(await stagedFixture(root, zipPath), { ...DEFAULT_LIMITS, maxManifestBytes: 10 }),
      "archive-limit-exceeded"
    );
  });

  it("rejects a UTF-8 BOM in manifest.json", async () => {
    const root = await temporaryRoot();
    const zipPath = join(root, "bom-manifest.zip");
    const manifest = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(JSON.stringify(systemManifest([])), "utf8")
    ]);
    await writeZip(zipPath, [{ name: "manifest.json", content: manifest, store: true }]);

    await expectArchiveError(
      inspectArchive(await stagedFixture(root, zipPath), DEFAULT_LIMITS),
      "archive-json-invalid"
    );
  });

  it("enforces the central-directory entry-count limit", async () => {
    const root = await temporaryRoot();
    const zipPath = join(root, "entry-count.zip");
    await writeZip(zipPath, [
      { name: "one.txt", content: Buffer.from("1") },
      { name: "two.txt", content: Buffer.from("2") }
    ]);

    await expectArchiveError(
      inspectArchive(await stagedFixture(root, zipPath), { ...DEFAULT_LIMITS, maxEntries: 1 }),
      "archive-limit-exceeded"
    );
  });

  it("enforces the declared total-uncompressed-byte limit before opening entries", async () => {
    const root = await temporaryRoot();
    const zipPath = join(root, "uncompressed-limit.zip");
    await writeZip(zipPath, [{ name: "data.bin", content: Buffer.alloc(11, 1), store: true }]);

    await expectArchiveError(
      inspectArchive(await stagedFixture(root, zipPath), { ...DEFAULT_LIMITS, maxUncompressedBytes: 10 }),
      "archive-limit-exceeded"
    );
  });

  it("enforces the per-entry expansion ratio before opening entries", async () => {
    const root = await temporaryRoot();
    const zipPath = join(root, "expansion-limit.zip");
    await writeZip(zipPath, [{ name: "data.bin", content: Buffer.alloc(10_000, 0x41) }]);

    await expectArchiveError(
      inspectArchive(await stagedFixture(root, zipPath), { ...DEFAULT_LIMITS, maxExpansionRatio: 2 }),
      "archive-limit-exceeded"
    );
  });

  it("enforces the JSON entry byte limit from the validated manifest", async () => {
    const root = await temporaryRoot();
    const zipPath = join(root, "json-limit.zip");
    const data = Buffer.from(JSON.stringify({ value: "too large" }), "utf8");
    await writeManifestZip(zipPath, [{ name: "data.json", content: data }]);

    await expectArchiveError(
      inspectArchive(await stagedFixture(root, zipPath), { ...DEFAULT_LIMITS, maxJsonEntryBytes: 10 }),
      "archive-limit-exceeded"
    );
  });

  it("rejects archive files that are not declared by the manifest", async () => {
    const root = await temporaryRoot();
    const zipPath = join(root, "undeclared.zip");
    const data = Buffer.from("{}");
    await writeManifestZip(zipPath, [
      { name: "data.json", content: data },
      { name: "extra.bin", content: Buffer.from("unexpected"), mediaType: "application/octet-stream" }
    ], [archiveEntry("data.json", data)]);

    await expectArchiveError(
      inspectArchive(await stagedFixture(root, zipPath), DEFAULT_LIMITS),
      "archive-entry-unsafe"
    );
  });

  it("rejects manifest entries that are missing from the archive", async () => {
    const root = await temporaryRoot();
    const zipPath = join(root, "missing.zip");
    const missing = Buffer.from("{}");
    await writeManifestZip(zipPath, [], [archiveEntry("missing.json", missing)]);

    await expectArchiveError(
      inspectArchive(await stagedFixture(root, zipPath), DEFAULT_LIMITS),
      "archive-entry-missing"
    );
  });

  it("rejects an entry whose streamed length differs from the manifest", async () => {
    const root = await temporaryRoot();
    const zipPath = join(root, "wrong-length.zip");
    const data = Buffer.from('{"ok":true}');
    const declared = { ...archiveEntry("data.json", data), byteLength: data.byteLength + 1 };
    await writeManifestZip(zipPath, [{ name: "data.json", content: data }], [declared]);

    await expectArchiveError(
      inspectArchive(await stagedFixture(root, zipPath), DEFAULT_LIMITS),
      "archive-checksum-mismatch"
    );
  });

  it("rejects an entry whose streamed checksum differs from the manifest", async () => {
    const root = await temporaryRoot();
    const zipPath = join(root, "wrong-checksum.zip");
    const data = Buffer.from('{"ok":true}');
    const declared = { ...archiveEntry("data.json", data), sha256: "0".repeat(64) };
    await writeManifestZip(zipPath, [{ name: "data.json", content: data }], [declared]);

    await expectArchiveError(
      inspectArchive(await stagedFixture(root, zipPath), DEFAULT_LIMITS),
      "archive-checksum-mismatch"
    );
  });

  it("rejects an archive type other than the expected type", async () => {
    const root = await temporaryRoot();
    const zipPath = join(root, "wrong-type.zip");
    await writeManifestZip(zipPath, []);

    await expectArchiveError(
      inspectArchive(await stagedFixture(root, zipPath), DEFAULT_LIMITS, "campaign"),
      "archive-format-unrecognized"
    );
  });

  it("inspects and bounded-reads a valid verified archive", async () => {
    const root = await temporaryRoot();
    const zipPath = join(root, "valid.zip");
    const data = Buffer.from('{"answer":42}', "utf8");
    await writeManifestZip(zipPath, [{ name: "data.json", content: data }]);
    const staged = await stagedFixture(root, zipPath);

    const inspected = await inspectArchive(staged, DEFAULT_LIMITS, "system");
    const result = await readVerifiedEntry(inspected, "DATA.json", data.byteLength);

    expect(inspected.manifest.archiveType).toBe("system");
    expect(inspected.entries.has("data.json")).toBe(true);
    expect(inspected.uncompressedBytes).toBeGreaterThan(data.byteLength);
    expect(result).toEqual(data);
    await expectArchiveError(
      readVerifiedEntry(inspected, "data.json", data.byteLength - 1),
      "archive-limit-exceeded"
    );
  });
});

describe("archive artifact writing and cleanup", () => {
  it("streams caller-ordered entries, appends manifest last, and atomically publishes the ZIP", async () => {
    const root = await temporaryRoot();
    const first = Buffer.from('{"first":true}');
    const second = Buffer.from("second");
    const sources: ArchiveArtifactEntry[] = [
      { path: "first.json", logicalType: "records", mediaType: "application/json", source: Readable.from(first) },
      { path: "assets/second.bin", logicalType: "asset", mediaType: "application/octet-stream", source: Readable.from(second) }
    ];

    const completed = await writeArchiveArtifact(root, sources, (entries) => systemManifest(entries));
    const directory = await Open.file(completed.absolutePath);
    const manifestFile = directory.files.at(-1);
    const manifest = JSON.parse((await manifestFile!.buffer()).toString("utf8")) as ArchiveManifest;

    expect(directory.files.map((file) => file.path)).toEqual([
      "first.json",
      "assets/second.bin",
      "manifest.json"
    ]);
    expect(manifest.entries).toEqual([
      archiveEntry("first.json", first),
      {
        ...archiveEntry("assets/second.bin", second, "application/octet-stream"),
        logicalType: "asset"
      }
    ]);
    expect(completed.relativePath).toMatch(/^artifacts\/[0-9a-f-]+\.zip$/);
    expect(completed.absolutePath.endsWith(".zip")).toBe(true);
    expect(completed.byteLength).toBe((await readFile(completed.absolutePath)).byteLength);
    expect(completed.contentFingerprint).toBe(manifest.contentFingerprint);
    expect((await readdir(join(root, "artifacts"))).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("removes a failed writer temporary file and throws a typed error", async () => {
    const root = await temporaryRoot();
    const failingSource = new Readable({
      read() {
        this.push(Buffer.from("partial"));
        this.destroy(new Error("artifact source failed"));
      }
    });

    await expectArchiveError(
      writeArchiveArtifact(
        root,
        [{ path: "data.bin", logicalType: "asset", mediaType: "application/octet-stream", source: failingSource }],
        (entries) => systemManifest(entries)
      ),
      "archive-export-inconsistent"
    );

    expect(await readdir(join(root, "artifacts"))).toEqual([]);
  });

  it("removes only a root-relative file beneath the configured archive root", async () => {
    const root = await temporaryRoot();
    const artifactPath = join(root, "artifacts", "safe.zip");
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, "safe");

    await removeArchivePath(root, "artifacts/safe.zip");

    await expect(readFile(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["../outside.zip", resolve("outside.zip")])("refuses cleanup outside the configured root: %s", async (path) => {
    const root = await temporaryRoot();
    const outside = join(dirname(root), "outside.zip");
    await writeFile(outside, "outside");
    temporaryRoots.push(outside);

    await expectArchiveError(removeArchivePath(root, path), "archive-entry-unsafe");

    expect(await readFile(outside, "utf8")).toBe("outside");
  });
});
