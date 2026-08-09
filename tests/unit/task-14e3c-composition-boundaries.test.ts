import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as storageComposition from "../../services/runtime/src/asset-import-composition.js";
import * as assetPublication from "../../packages/application/src/assets/private-asset-publication.js";
import type { PrivateAssetPublicationCommand } from "../../packages/application/src/assets/private-asset-publication.js";
import { toAssetMutationIdempotencyKey } from "../../packages/application/src/assets/types.js";
// @ts-expect-error The executable repository checker is intentionally plain ESM.
import * as privateStorageBoundaries from "../../scripts/check-private-storage-boundaries.mjs";

describe("Task 14e3c asset-publication composition boundary", () => {
  it("adds an unconsumed named composition instead of extending the legacy writers", () => {
    expect(typeof (
      storageComposition as typeof storageComposition & Readonly<{
        createAssetPublicationComposition?: unknown;
      }>
    ).createAssetPublicationComposition).toBe("function");
  });

  it("rejects asset-publication factory and composition imports from future consumers", () => {
    expect(privateStorageBoundaries.checkPrivateStorageBoundaries(
      "services/api/src/server.ts",
      `import { createAssetPublicationComposition } from "../../runtime/src/asset-import-composition.js";
       createAssetPublicationComposition(pool, roots);`,
    )).toEqual([
      expect.stringContaining("private storage composition must remain unconsumed")
    ]);
    expect(privateStorageBoundaries.checkPrivateStorageBoundaries(
      "services/worker/src/worker.ts",
      `import { createPostgresAssetPublicationRepository }
         from "../../../packages/database/src/asset-publication-repository.js";
       createPostgresAssetPublicationRepository(pool, candidates);`,
    )).toEqual([
      expect.stringContaining("concrete storage factory createPostgresAssetPublicationRepository")
    ]);
  });

  it("keeps the normalized request repository private until its neutral seam exists", () => {
    expect(privateStorageBoundaries.checkPrivateStorageBoundaries(
      "services/worker/src/worker.ts",
      `import { createPostgresNormalizedAssetPublicationRepository }
         from "../../../packages/database/src/normalized-asset-publication-repository.js";
       createPostgresNormalizedAssetPublicationRepository(pool);`,
    )).toEqual([
      expect.stringContaining("private normalized publication repository must remain unconsumed")
    ]);
  });

  it("snapshots verified artifact bytes before asynchronous publication work", () => {
    const original = new Uint8Array([1, 2, 3]);
    const snapshot = (
      assetPublication as typeof assetPublication & Readonly<{
        snapshotPrivateAssetPublicationCommand?: (input: unknown) => Readonly<{
          original: Readonly<{ bytes: Uint8Array }>;
        }>;
      }>
    ).snapshotPrivateAssetPublicationCommand;
    expect(typeof snapshot).toBe("function");
    const command = snapshot!({
      owner: { ownerUserId: "owner-1" },
      idempotencyKey: toAssetMutationIdempotencyKey("snapshot"),
      leaseOwner: "unit-test",
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      original: {
        mimeType: "image/png",
        bytes: original,
        byteLength: 3,
        contentHash: createHash("sha256").update(original).digest("hex")
      },
      derivatives: [],
      provenance: { origin: "imported" }
    });
    assetPublication.verifyPrivateAssetPublicationContentHashes(
      command as unknown as PrivateAssetPublicationCommand,
      (bytes) => createHash("sha256").update(bytes).digest("hex"),
    );
    original[0] = 9;
    expect(command.original.bytes).toEqual(new Uint8Array([1, 2, 3]));
    assetPublication.verifyPrivateAssetPublicationContentHashes(
      command as unknown as PrivateAssetPublicationCommand,
      (bytes) => createHash("sha256").update(bytes).digest("hex"),
    );
  });
});
