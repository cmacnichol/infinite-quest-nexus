import { ZipArchive } from "archiver";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import type { ArchiveEntry, ArchiveManifest } from "../../packages/contracts/src/archives.js";
import { createFakeDurableFilesystemLifecycle } from "../helpers/private-storage-lifecycle-fake.js";
import type { ArchiveLimits } from "../../services/api/src/archive-io.js";
import {
  createPortableArchiveFilesystemAdapter as createPersistedPortableArchiveFilesystemAdapter,
  type PortableArchiveFilesystemOptions,
  type SafeFilesystemCapabilityFailure
} from "../helpers/legacy-portable-archive-filesystem-adapter.js";

const owner = { ownerUserId: "11111111-1111-4111-8111-111111111111" };
const foreignOwner = { ownerUserId: "22222222-2222-4222-8222-222222222222" };
const limits: ArchiveLimits = {
  maxCompressedBytes: 1_000_000,
  maxUncompressedBytes: 1_000_000,
  maxEntries: 20,
  maxExpansionRatio: 100,
  maxManifestBytes: 100_000,
  maxJsonEntryBytes: 100_000,
  maxOriginalImageBytes: 25 * 1024 * 1024
};
const roots: string[] = [];

function createPortableArchiveFilesystemAdapter(
  options: Omit<PortableArchiveFilesystemOptions, "persistence">
) {
  return createPersistedPortableArchiveFilesystemAdapter({
    ...options,
    persistence: createFakeDurableFilesystemLifecycle()
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function legacyAssetDigest(bytes: Buffer): string {
  return createHash("sha256").update(bytes.toString("base64")).digest("hex");
}

function manifest(entries: readonly ArchiveEntry[]): ArchiveManifest {
  return {
    format: "infinite-quest-archive",
    formatVersion: 1,
    archiveType: "system",
    createdAt: "2026-08-05T00:00:00.000Z",
    contentFingerprint: "1".repeat(64),
    entries: [...entries],
    payloads: entries.map((entry) => ({ kind: "records", path: entry.path, formatVersion: 1 })),
    assets: []
  };
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function writeZip(
  path: string,
  entries: readonly { name: string; content?: Buffer; mode?: number; symlinkTarget?: string }[]
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const output = createWriteStream(path, { flags: "wx" });
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const completed = once(output, "close");
  archive.pipe(output);
  for (const entry of entries) {
    if (entry.symlinkTarget !== undefined) {
      archive.symlink(entry.name, entry.symlinkTarget, entry.mode);
    } else {
      archive.append(entry.content!, {
        name: entry.name,
        ...(entry.mode === undefined ? {} : { mode: entry.mode })
      });
    }
  }
  await archive.finalize();
  await completed;
}

async function portableZip(root: string, content = Buffer.from('{"safe":true}', "utf8")): Promise<string> {
  const path = join(root, "portable.zip");
  const entry: ArchiveEntry = {
    path: "records/data.json",
    logicalType: "records",
    mediaType: "application/json",
    byteLength: content.byteLength,
    sha256: digest(content)
  };
  await writeZip(path, [
    { name: entry.path, content },
    { name: "manifest.json", content: Buffer.from(JSON.stringify(manifest([entry])), "utf8") }
  ]);
  return path;
}

async function unsafePathZip(root: string, unsafePath: string, sequence: number): Promise<string> {
  const safePath = "x".repeat(Buffer.byteLength(unsafePath, "utf8"));
  const path = join(root, `unsafe-path-${sequence}.zip`);
  await writeZip(path, [{ name: safePath, content: Buffer.from("unsafe") }]);
  const bytes = await readFile(path);
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  expect(central).toBeGreaterThanOrEqual(0);
  expect(bytes.readUInt16LE(central + 28)).toBe(Buffer.byteLength(unsafePath, "utf8"));
  bytes.write(unsafePath, central + 46, Buffer.byteLength(unsafePath, "utf8"), "utf8");
  await writeFile(path, bytes);
  return path;
}

async function expectSafeFailure(
  operation: Promise<unknown>,
  code: SafeFilesystemCapabilityFailure["code"]
): Promise<void> {
  try {
    await operation;
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toEqual({ code });
    expect(error).not.toBeInstanceOf(Error);
    expect(Object.keys(error as object)).toEqual(["code"]);
  }
}

function expectSafeThrown(
  operation: () => unknown,
  code: SafeFilesystemCapabilityFailure["code"]
): void {
  try {
    operation();
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toEqual({ code });
    expect(error).not.toBeInstanceOf(Error);
    expect(Object.keys(error as object)).toEqual(["code"]);
  }
}

describe("portable archive filesystem adapter", () => {
  it("stages only an issued one-shot owner-bound upload and exposes no path or owner", async () => {
    const archiveRoot = await temporaryRoot("iq-portable-archive-");
    const sourcePath = await portableZip(archiveRoot);
    const sourceBytes = await readFile(sourcePath);
    const adapter = createPortableArchiveFilesystemAdapter({ archiveRoot, assetRoot: archiveRoot, limits });
    const upload = adapter.issueOwnerBoundUpload(owner, createReadStream(sourcePath), sourceBytes.byteLength);

    const stagedInput = await adapter.stagingPort.stagePortableArchive(upload);

    expect(typeof stagedInput).toBe("string");
    expect(JSON.stringify(stagedInput)).not.toContain(archiveRoot);
    expect(JSON.stringify(stagedInput)).not.toContain(owner.ownerUserId);
    await expectSafeFailure(adapter.stagingPort.stagePortableArchive(upload), "archive_unavailable");
    await expectSafeFailure(
      adapter.inspectPortableArchive(foreignOwner, stagedInput, "system"),
      "archive_unavailable"
    );
    await adapter.cleanupStagedInput(owner, stagedInput);
  });

  it("enforces claimed and configured upload bounds and removes partial uploads deterministically", async () => {
    const archiveRoot = await temporaryRoot("iq-portable-bounds-");
    const adapter = createPortableArchiveFilesystemAdapter({
      archiveRoot,
      assetRoot: archiveRoot,
      limits: { ...limits, maxCompressedBytes: 8 }
    });
    expectSafeThrown(
      () => adapter.issueOwnerBoundUpload(owner, Readable.from(Buffer.alloc(9)), 9),
      "archive_size_limit_exceeded"
    );
    const oversized = adapter.issueOwnerBoundUpload(owner, Readable.from(Buffer.alloc(9)), 8);
    await expectSafeFailure(adapter.stagingPort.stagePortableArchive(oversized), "archive_size_limit_exceeded");
    expect(await readdir(join(archiveRoot, "staging"))).toEqual([]);

    const truncated = adapter.issueOwnerBoundUpload(owner, Readable.from(Buffer.alloc(3)), 4);
    await expectSafeFailure(adapter.stagingPort.stagePortableArchive(truncated), "archive_truncated");
    expect(await readdir(join(archiveRoot, "staging"))).toEqual([]);

    const failing = new Readable({
      read() {
        this.push(Buffer.from("partial"));
        this.destroy(new Error(`private source failure at ${archiveRoot}`));
      }
    });
    const failed = adapter.issueOwnerBoundUpload(owner, failing, 7);
    await expectSafeFailure(adapter.stagingPort.stagePortableArchive(failed), "archive_unavailable");
    expect(await readdir(join(archiveRoot, "staging"))).toEqual([]);
  });

  it("fails closed without a descriptor-anchored platform primitive", async () => {
    const archiveRoot = await temporaryRoot("iq-portable-platform-");
    const adapter = createPortableArchiveFilesystemAdapter({
      archiveRoot,
      assetRoot: archiveRoot,
      limits,
      platform: "win32"
    });
    const upload = adapter.issueOwnerBoundUpload(owner, Readable.from("PK"), 2);

    await expectSafeFailure(adapter.stagingPort.stagePortableArchive(upload), "archive_containment_denied");
    expect(await readdir(archiveRoot)).toEqual([]);
  });

  it("reuses bounded archive inspection and extracts only a reverified entry", async () => {
    const archiveRoot = await temporaryRoot("iq-portable-inspect-");
    const sourcePath = await portableZip(archiveRoot);
    const sourceBytes = await readFile(sourcePath);
    const adapter = createPortableArchiveFilesystemAdapter({ archiveRoot, assetRoot: archiveRoot, limits });
    const upload = adapter.issueOwnerBoundUpload(owner, createReadStream(sourcePath), sourceBytes.byteLength);
    const stagedInput = await adapter.stagingPort.stagePortableArchive(upload);

    const inspected = await adapter.inspectPortableArchive(owner, stagedInput, "system");
    const extracted = await adapter.extractVerifiedEntry(owner, stagedInput, "records/data.json", 100);

    expect(inspected).toEqual({
      archiveType: "system",
      entries: [{
        path: "records/data.json",
        mediaType: "application/json",
        compressedBytes: expect.any(Number),
        uncompressedBytes: 13,
        sha256: digest(Buffer.from('{"safe":true}', "utf8"))
      }],
      uncompressedBytes: expect.any(Number)
    });
    expect(Buffer.from(extracted.content).toString("utf8")).toBe('{"safe":true}');
    expect(extracted.sha256).toBe(digest(Buffer.from('{"safe":true}', "utf8")));
    await expectSafeFailure(
      adapter.extractVerifiedEntry(owner, stagedInput, "records/data.json", 12),
      "archive_entry_limit_exceeded"
    );
    await adapter.cleanupStagedInput(owner, stagedInput);
  });

  it("rejects a staging-root alias installed before inspection", async () => {
    const archiveRoot = await temporaryRoot("iq-portable-root-before-");
    const sourcePath = await portableZip(archiveRoot);
    const sourceBytes = await readFile(sourcePath);
    const adapter = createPortableArchiveFilesystemAdapter({ archiveRoot, assetRoot: archiveRoot, limits });
    const upload = adapter.issueOwnerBoundUpload(owner, createReadStream(sourcePath), sourceBytes.byteLength);
    const stagedInput = await adapter.stagingPort.stagePortableArchive(upload);
    const movedRoot = `${archiveRoot}.moved`;
    roots.push(movedRoot);
    await rename(archiveRoot, movedRoot);
    await symlink(movedRoot, archiveRoot, "junction");

    await expectSafeFailure(
      adapter.inspectPortableArchive(owner, stagedInput, "system"),
      "archive_containment_denied"
    );
    await unlink(archiveRoot);
    await rename(movedRoot, archiveRoot);
    await adapter.cleanupStagedInput(owner, stagedInput);
  });

  it("rejects a staging-root alias installed between inspection and extraction", async () => {
    const archiveRoot = await temporaryRoot("iq-portable-root-between-");
    const sourcePath = await portableZip(archiveRoot);
    const sourceBytes = await readFile(sourcePath);
    const adapter = createPortableArchiveFilesystemAdapter({ archiveRoot, assetRoot: archiveRoot, limits });
    const upload = adapter.issueOwnerBoundUpload(owner, createReadStream(sourcePath), sourceBytes.byteLength);
    const stagedInput = await adapter.stagingPort.stagePortableArchive(upload);
    await adapter.inspectPortableArchive(owner, stagedInput, "system");
    const movedRoot = `${archiveRoot}.moved`;
    roots.push(movedRoot);
    await rename(archiveRoot, movedRoot);
    await symlink(movedRoot, archiveRoot, "junction");

    await expectSafeFailure(
      adapter.extractVerifiedEntry(owner, stagedInput, "records/data.json", 100),
      "archive_containment_denied"
    );
    await unlink(archiveRoot);
    await rename(movedRoot, archiveRoot);
    await adapter.cleanupStagedInput(owner, stagedInput);
  });

  it("maps traversal, links, and aggregate expansion failures to allowlisted diagnostics", async () => {
    const archiveRoot = await temporaryRoot("iq-portable-attacks-");
    const adapter = createPortableArchiveFilesystemAdapter({ archiveRoot, assetRoot: archiveRoot, limits });
    const zipPath = join(archiveRoot, "unsafe.zip");
    await writeZip(zipPath, [{ name: "link", symlinkTarget: "target", mode: 0o777 }]);
    const zipBytes = await readFile(zipPath);
    const upload = adapter.issueOwnerBoundUpload(owner, createReadStream(zipPath), zipBytes.byteLength);
    const staged = await adapter.stagingPort.stagePortableArchive(upload);
    await expectSafeFailure(adapter.inspectPortableArchive(owner, staged, "container"), "archive_link_denied");
    await adapter.cleanupStagedInput(owner, staged);

    for (const [index, unsafePath] of ["../bad!", "/bad!!!", "C:/bad!"].entries()) {
      const unsafeZip = await unsafePathZip(archiveRoot, unsafePath, index);
      const unsafeBytes = await readFile(unsafeZip);
      const unsafeUpload = adapter.issueOwnerBoundUpload(
        owner,
        createReadStream(unsafeZip),
        unsafeBytes.byteLength
      );
      const unsafeStaged = await adapter.stagingPort.stagePortableArchive(unsafeUpload);
      await expectSafeFailure(
        adapter.inspectPortableArchive(owner, unsafeStaged, "container"),
        "archive_path_invalid"
      );
      await adapter.cleanupStagedInput(owner, unsafeStaged);
    }

    const largeZip = join(archiveRoot, "aggregate.zip");
    await writeZip(largeZip, [
      { name: "one.txt", content: Buffer.alloc(6, 1) },
      { name: "two.txt", content: Buffer.alloc(6, 2) }
    ]);
    const largeBytes = await readFile(largeZip);
    const bounded = createPortableArchiveFilesystemAdapter({
      archiveRoot,
      assetRoot: archiveRoot,
      limits: { ...limits, maxUncompressedBytes: 10 }
    });
    const largeUpload = bounded.issueOwnerBoundUpload(owner, createReadStream(largeZip), largeBytes.byteLength);
    const largeStaged = await bounded.stagingPort.stagePortableArchive(largeUpload);
    await expectSafeFailure(
      bounded.inspectPortableArchive(owner, largeStaged, "container"),
      "archive_size_limit_exceeded"
    );
    await bounded.cleanupStagedInput(owner, largeStaged);
  });

  it("publishes a read-only verified artifact behind an opaque owner-bound retrieval and cleans it safely", async () => {
    const archiveRoot = await temporaryRoot("iq-portable-export-");
    const adapter = createPortableArchiveFilesystemAdapter({ archiveRoot, assetRoot: archiveRoot, limits });
    const content = Buffer.from('{"exported":true}', "utf8");
    const artifact = await adapter.publishArchiveArtifact(owner, [{
      path: "records/data.json",
      logicalType: "records",
      mediaType: "application/json",
      source: Readable.from(content)
    }], manifest);

    expect(JSON.stringify(artifact)).not.toContain(archiveRoot);
    expect(artifact).toMatchObject({ contentType: "application/zip", byteLength: expect.any(Number) });
    const artifactName = (await readdir(join(archiveRoot, "artifacts")))[0]!;
    expect((await stat(join(archiveRoot, "artifacts", artifactName))).mode & 0o222).toBe(0);
    const downloaded = await adapter.readExportArtifact(owner, artifact.retrieval, limits.maxCompressedBytes);
    expect(downloaded.content.subarray(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]));
    expect(downloaded.sha256).toBe(digest(Buffer.from(downloaded.content)));
    await expectSafeFailure(
      adapter.readExportArtifact(foreignOwner, artifact.retrieval, limits.maxCompressedBytes),
      "archive_unavailable"
    );

    await adapter.cleanupExportArtifact(owner, artifact.retrieval);
    expect(await readdir(join(archiveRoot, "artifacts"))).toEqual([]);
  });

  it("does not delete a substituted staged file during identity-safe cleanup", async () => {
    const archiveRoot = await temporaryRoot("iq-portable-cleanup-");
    const sourcePath = await portableZip(archiveRoot);
    const sourceBytes = await readFile(sourcePath);
    const adapter = createPortableArchiveFilesystemAdapter({ archiveRoot, assetRoot: archiveRoot, limits });
    const upload = adapter.issueOwnerBoundUpload(owner, createReadStream(sourcePath), sourceBytes.byteLength);
    const staged = await adapter.stagingPort.stagePortableArchive(upload);
    const stagedName = (await readdir(join(archiveRoot, "staging")))[0]!;
    const stagedPath = join(archiveRoot, "staging", stagedName);
    await rename(stagedPath, `${stagedPath}.original`);
    await writeFile(stagedPath, "replacement must survive");

    await expectSafeFailure(adapter.cleanupStagedInput(owner, staged), "archive_cleanup_required");

    expect(await readFile(stagedPath, "utf8")).toBe("replacement must survive");
    expect(await readFile(`${stagedPath}.original`)).toEqual(sourceBytes);
    await unlink(stagedPath);
    await rename(`${stagedPath}.original`, stagedPath);
    await adapter.cleanupStagedInput(owner, staged);
  });

  it("rejects a staging-parent junction replacement without touching the outside target", async () => {
    const archiveRoot = await temporaryRoot("iq-portable-parent-race-");
    const outside = await temporaryRoot("iq-portable-parent-outside-");
    const sourcePath = await portableZip(archiveRoot);
    const sourceBytes = await readFile(sourcePath);
    const adapter = createPortableArchiveFilesystemAdapter({ archiveRoot, assetRoot: archiveRoot, limits });
    const upload = adapter.issueOwnerBoundUpload(owner, createReadStream(sourcePath), sourceBytes.byteLength);
    const staged = await adapter.stagingPort.stagePortableArchive(upload);
    await writeFile(join(outside, "sentinel"), "preserve");
    await rename(join(archiveRoot, "staging"), join(archiveRoot, "staging.original"));
    await symlink(outside, join(archiveRoot, "staging"), "junction");

    await expectSafeFailure(adapter.cleanupStagedInput(owner, staged), "archive_cleanup_required");

    expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("preserve");
    expect(await readdir(join(archiveRoot, "staging.original"))).toHaveLength(1);
    await unlink(join(archiveRoot, "staging"));
    await rename(join(archiveRoot, "staging.original"), join(archiveRoot, "staging"));
    await adapter.cleanupStagedInput(owner, staged);
  });

  it("verifies bounded asset MIME, signature, decoder metadata, and legacy content hash through anchored segments", async () => {
    const archiveRoot = await temporaryRoot("iq-portable-assets-archive-");
    const assetRoot = await temporaryRoot("iq-portable-assets-");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    );
    await mkdir(join(assetRoot, "aa"));
    await writeFile(join(assetRoot, "aa", "original.png"), png);
    const adapter = createPortableArchiveFilesystemAdapter({ archiveRoot, assetRoot, limits });

    const verified = await adapter.readVerifiedAsset({
      relativePath: "aa/original.png",
      mimeType: "image/png",
      expectedByteLength: png.byteLength,
      expectedContentHash: legacyAssetDigest(png),
      maximumBytes: png.byteLength
    });

    expect(verified).toMatchObject({
      mimeType: "image/png",
      byteLength: png.byteLength,
      contentHash: legacyAssetDigest(png),
      width: 1,
      height: 1,
      format: "png"
    });
    expect(verified).not.toHaveProperty("path");

    await expectSafeFailure(adapter.readVerifiedAsset({
      relativePath: "aa/original.png",
      mimeType: "image/jpeg",
      expectedByteLength: png.byteLength,
      expectedContentHash: legacyAssetDigest(png),
      maximumBytes: png.byteLength
    }), "asset_content_invalid");
    await expectSafeFailure(adapter.readVerifiedAsset({
      relativePath: "aa/original.png",
      mimeType: "image/png",
      expectedByteLength: png.byteLength,
      expectedContentHash: "0".repeat(64),
      maximumBytes: png.byteLength
    }), "asset_hash_mismatch");
    await expectSafeFailure(adapter.readVerifiedAsset({
      relativePath: "../original.png",
      mimeType: "image/png",
      expectedByteLength: png.byteLength,
      expectedContentHash: legacyAssetDigest(png),
      maximumBytes: png.byteLength
    }), "filesystem_path_invalid");
  });

  it("rejects an image whose header parses but whose pixels cannot be fully decoded", async () => {
    const archiveRoot = await temporaryRoot("iq-portable-truncated-archive-");
    const assetRoot = await temporaryRoot("iq-portable-truncated-assets-");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    ).subarray(0, 41);
    await mkdir(join(assetRoot, "aa"));
    await writeFile(join(assetRoot, "aa", "truncated.png"), png);
    const adapter = createPortableArchiveFilesystemAdapter({ archiveRoot, assetRoot, limits });

    await expectSafeFailure(adapter.readVerifiedAsset({
      relativePath: "aa/truncated.png",
      mimeType: "image/png",
      expectedByteLength: png.byteLength,
      expectedContentHash: legacyAssetDigest(png),
      maximumBytes: png.byteLength
    }), "asset_content_invalid");
  });

  it("enforces decoded image pixel and page limits before accepting content", async () => {
    const archiveRoot = await temporaryRoot("iq-portable-image-limits-archive-");
    const assetRoot = await temporaryRoot("iq-portable-image-limits-assets-");
    const twoPixelPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADklEQVQImWP4z8DwH4QBEfcD/RSF9bkAAAAASUVORK5CYII=",
      "base64"
    );
    const twoPageGif = Buffer.from(
      "R0lGODlhAQABAIAAAExpcf8AACH/C05FVFNDQVBFMi4wAwEAAAAh+QQFCgAAACwAAAAAAQABAAACAkwBACH5BAUKAAAALAAAAAABAAEAgExpcQAA/wICTAEAOw==",
      "base64"
    );
    await mkdir(join(assetRoot, "aa"));
    await writeFile(join(assetRoot, "aa", "two-pixels.png"), twoPixelPng);
    await writeFile(join(assetRoot, "aa", "two-pages.gif"), twoPageGif);

    const pixelBounded = createPortableArchiveFilesystemAdapter({
      archiveRoot,
      assetRoot,
      limits,
      maxImagePixels: 1
    });
    await expectSafeFailure(pixelBounded.readVerifiedAsset({
      relativePath: "aa/two-pixels.png",
      mimeType: "image/png",
      expectedByteLength: twoPixelPng.byteLength,
      expectedContentHash: legacyAssetDigest(twoPixelPng),
      maximumBytes: twoPixelPng.byteLength
    }), "asset_content_invalid");

    const pageBounded = createPortableArchiveFilesystemAdapter({
      archiveRoot,
      assetRoot,
      limits,
      maxImagePages: 1
    });
    await expectSafeFailure(pageBounded.readVerifiedAsset({
      relativePath: "aa/two-pages.gif",
      mimeType: "image/gif",
      expectedByteLength: twoPageGif.byteLength,
      expectedContentHash: legacyAssetDigest(twoPageGif),
      maximumBytes: twoPageGif.byteLength
    }), "asset_content_invalid");
  });

  it("rejects symlink, directory, and post-publication artifact identity changes without leaking storage details", async () => {
    const archiveRoot = await temporaryRoot("iq-portable-identity-archive-");
    const assetRoot = await temporaryRoot("iq-portable-identity-assets-");
    const outside = await temporaryRoot("iq-portable-identity-outside-");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    );
    await writeFile(join(outside, "outside.png"), png);
    await symlink(outside, join(assetRoot, "linked"), "junction");
    const adapter = createPortableArchiveFilesystemAdapter({ archiveRoot, assetRoot, limits });
    await expectSafeFailure(adapter.readVerifiedAsset({
      relativePath: "linked/outside.png",
      mimeType: "image/png",
      expectedByteLength: png.byteLength,
      expectedContentHash: legacyAssetDigest(png),
      maximumBytes: png.byteLength
    }), "filesystem_link_denied");
    await expectSafeFailure(adapter.readVerifiedAsset({
      relativePath: "linked",
      mimeType: "image/png",
      expectedByteLength: 0,
      expectedContentHash: "0".repeat(64),
      maximumBytes: 1
    }), "filesystem_link_denied");

    const content = Buffer.from("export", "utf8");
    const artifact = await adapter.publishArchiveArtifact(owner, [{
      path: "records/data.json",
      logicalType: "records",
      mediaType: "application/json",
      source: Readable.from(content)
    }], manifest);
    const artifactName = (await readdir(join(archiveRoot, "artifacts")))[0]!;
    const artifactPath = join(archiveRoot, "artifacts", artifactName);
    await chmod(artifactPath, 0o640);
    await writeFile(artifactPath, "changed");

    await expectSafeFailure(
      adapter.readExportArtifact(owner, artifact.retrieval, limits.maxCompressedBytes),
      "archive_containment_denied"
    );
  });
});
