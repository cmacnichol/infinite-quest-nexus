import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bindPrivateBoundedStreamLimits } from "../../packages/application/src/assets/private-secure-storage.js";
import type {
  AttachedFilesystemOperation,
  DurableFilesystemRecoveryClaim,
  PrivateStorageDescriptor
} from "../../packages/application/src/assets/private-storage-lifecycle.js";
import { bindPrivatePortablePreviewRehydration } from "../../packages/application/src/imports/private-portable-repository.js";
import { toPortablePreviewHandle } from "../../packages/application/src/imports/types.js";
import { createSecureFilesystemAdapter } from "../../services/api/src/portable-archive-filesystem-adapter.js";

const FUTURE = new Date(Date.now() + 60_000).toISOString();

async function fixture() {
  const archiveRoot = await mkdtemp(join(tmpdir(), "iqn-14e3d-preview-"));
  const assetRoot = await mkdtemp(join(tmpdir(), "iqn-14e3d-assets-"));
  await mkdir(join(archiveRoot, "staging"));
  const content = Buffer.from("anchored portable preview bytes");
  const relativePath = "staging/preview.pending";
  const path = join(archiveRoot, relativePath);
  await writeFile(path, content);
  const value = await stat(path, { bigint: true });
  const descriptor: PrivateStorageDescriptor = {
    relativePath,
    identity: {
      deviceId: value.dev.toString(),
      fileId: value.ino.toString(),
      changeToken: `${value.mtimeNs}:${value.ctimeNs}`
    },
    contentHash: createHash("sha256").update(content).digest("hex"),
    byteLength: content.byteLength
  };
  const operation = {
    resourceKind: "portable",
    ownerUserId: "owner-1",
    operationScopeId: "preview-scope",
    operationId: "00000000-0000-4000-8000-000000000041",
    purpose: "portable_staging"
  } as AttachedFilesystemOperation;
  const claim = {
    operationId: operation.operationId,
    leaseId: "00000000-0000-4000-8000-000000000042",
    leaseOwner: "preview-test",
    workVersion: 2,
    leaseExpiresAt: FUTURE
  } as DurableFilesystemRecoveryClaim;
  const rehydration = bindPrivatePortablePreviewRehydration(
    { ownerUserId: "owner-1", kind: "campaign_zip" },
    operation,
    claim,
    descriptor,
  );
  const destination = { kind: "embedded", operation: "create_world" } as const;
  const handle = toPortablePreviewHandle("preview-handle", destination);
  const adapter = await createSecureFilesystemAdapter({
    archiveRoot,
    assetRoot,
    platform: "linux",
    portablePreview: {
      async rehydratePreviewInput(owner, kind, previewHandle) {
        return owner.ownerUserId === "owner-1"
          && kind === "campaign_zip"
          && previewHandle.token === handle.token ? rehydration : null;
      }
    },
    transactions: { async run(work) { return work({}); } }
  });
  return { adapter, archiveRoot, assetRoot, content, handle, path };
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe("Task 14e3d preview-handle staged session", () => {
  it("anchors the exact descriptor and close does not consume preview staging", async () => {
    const value = await fixture();
    const session = await value.adapter.openPreviewInputSession({
      owner: { ownerUserId: "owner-1" },
      kind: "campaign_zip",
      previewHandle: value.handle,
      claim: { leaseOwner: "preview-test", leaseSeconds: 30 },
      limits: bindPrivateBoundedStreamLimits({ maximumBytes: 1024, chunkBytes: 128, deadlineAt: FUTURE })
    });
    expect(await collect(session.chunks)).toEqual(value.content);
    await session.finalize("eof");
    await expect(stat(value.path)).resolves.toMatchObject({ size: value.content.byteLength });
    await value.adapter.close();
  });

  it("denies descriptor substitution and leaves the replacement unconsumed", async () => {
    const value = await fixture();
    await rename(value.path, `${value.path}.original`);
    const replacement = Buffer.from("replacement must not gain authority");
    await writeFile(value.path, replacement);
    await expect(value.adapter.openPreviewInputSession({
      owner: { ownerUserId: "owner-1" },
      kind: "campaign_zip",
      previewHandle: value.handle,
      claim: { leaseOwner: "preview-test", leaseSeconds: 30 },
      limits: bindPrivateBoundedStreamLimits({ maximumBytes: 1024, chunkBytes: 128, deadlineAt: FUTURE })
    })).rejects.toThrow("filesystem_identity_mismatch");
    await expect(stat(value.path)).resolves.toMatchObject({ size: replacement.byteLength });
    await value.adapter.close();
  });

  it("denies a foreign owner without opening or consuming the staged file", async () => {
    const value = await fixture();
    await expect(value.adapter.openPreviewInputSession({
      owner: { ownerUserId: "foreign-owner" },
      kind: "campaign_zip",
      previewHandle: value.handle,
      claim: { leaseOwner: "preview-test", leaseSeconds: 30 },
      limits: bindPrivateBoundedStreamLimits({ maximumBytes: 1024, chunkBytes: 128, deadlineAt: FUTURE })
    })).rejects.toThrow("portable_preview_input_unavailable");
    await expect(stat(value.path)).resolves.toMatchObject({ size: value.content.byteLength });
    await value.adapter.close();
  });
});
