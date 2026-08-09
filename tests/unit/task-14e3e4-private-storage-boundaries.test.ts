import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error The executable repository checker is intentionally plain ESM.
import * as privateStorageBoundaries from "../../scripts/check-private-storage-boundaries.mjs";

type Source = Readonly<{ file: string; text: string }>;

const {
  checkAssetImportStorageCompositionInventory,
  checkPrivateStorageBoundaries
} = privateStorageBoundaries as unknown as Readonly<{
  checkAssetImportStorageCompositionInventory(sources: readonly Source[]): readonly string[];
  checkPrivateStorageBoundaries(file: string, text: string): readonly string[];
}>;

const runtimeRoot = new URL("../../services/runtime/src/", import.meta.url);
const databaseRoot = new URL("../../packages/database/src/", import.meta.url);

function source(file: string): string {
  return readFileSync(new URL(file, runtimeRoot), "utf8");
}

describe("Task 14e3e4 private normalized portable writer boundary", () => {
  it("replaces the portable writer's legacy 0060 publisher dependency with the e4 coordinator", () => {
    const portable = source("portable-import-export-composition.ts");

    expect(portable).toContain("createPrivatePortableNormalizedAssetPublicationComposition");
    expect(portable).not.toContain("createAssetPublicationComposition");
    expect(portable).not.toContain("transactionalPublisher");
    expect(portable).not.toContain("reserveImportedAssets");
    expect(portable).not.toContain("attachImportedAssets");
    expect(portable).not.toContain("finalizeImportedAssets");
  });

  it("keeps the additive e4 graph dependent on e2 normalized authority only", () => {
    const coordinator = source("portable-normalized-asset-publication-composition.ts");

    expect(coordinator).toContain("./normalized-asset-publication-composition.js");
    expect(coordinator).not.toContain("./asset-import-composition.js");
    expect(coordinator).not.toMatch(/transactionalPublisher|writeContentAddressed|persist\w*Image/u);
  });

  it("keeps retirement recovery on the operation-to-filesystem lock order", () => {
    const repository = readFileSync(
      new URL("portable-normalized-asset-publication-repository.ts", databaseRoot),
      "utf8",
    );
    const start = repository.indexOf("const reconcileRetirementsWithDatabase");
    const lockOrder = [
      "FROM portable_import_operations operation",
      "FROM portable_import_work",
      "FROM portable_import_normalized_asset_publications",
      "FROM asset_publication_requests",
      "FROM asset_publication_identities",
      "FROM durable_filesystem_operations"
    ].map((clause) => repository.indexOf(clause, start));

    expect(start).toBeGreaterThanOrEqual(0);
    expect(lockOrder.every((index) => index >= start)).toBe(true);
    expect(lockOrder).toEqual([...lockOrder].sort((left, right) => left - right));
    expect(repository.slice(start, lockOrder.at(-1)!)).not.toContain(
      "FOR UPDATE OF mapping,operation,work",
    );
  });

  it("allows only the private portable composition to consume the e4 coordinator", () => {
    expect(checkPrivateStorageBoundaries(
      "services/runtime/src/portable-import-export-composition.ts",
      `import { createPrivatePortableNormalizedAssetPublicationComposition }
         from "./portable-normalized-asset-publication-composition.js";`,
    )).toEqual([]);
    expect(checkPrivateStorageBoundaries(
      "services/worker/src/worker.ts",
      `import { createPrivatePortableNormalizedAssetPublicationComposition }
         from "../../runtime/src/portable-normalized-asset-publication-composition.js";`,
    )).toEqual(expect.arrayContaining([
      expect.stringContaining("may be consumed only by services/runtime/src/portable-import-export-composition.ts")
    ]));
  });

  it("rejects direct legacy publication authority from the e4 coordinator", () => {
    for (const text of [
      `import { createAssetPublicationComposition } from "./asset-import-composition.js";`,
      `export function publish() { return transactionalPublisher.attachImportedAssets(); }`,
      `export function write() { return writeContentAddressed(store, hash, extension, bytes); }`,
      `export function persist() { return persistImportedImage(bytes); }`,
      `import { persistOriginalImage } from "../../api/src/asset-service.js";`
    ]) {
      expect(checkPrivateStorageBoundaries(
        "services/runtime/src/portable-normalized-asset-publication-composition.ts",
        text,
      ), text).not.toEqual([]);
    }
  });

  it("rejects transitive API, legacy import, and legacy writer authority before the e2 seam", () => {
    const root: Source = {
      file: "services/runtime/src/portable-normalized-asset-publication-composition.ts",
      text: `
        import { createPrivateNormalizedAssetPublicationComposition } from "./normalized-asset-publication-composition.js";
        import "./portable-normalized-helper.js";
        export function createPrivatePortableNormalizedAssetPublicationComposition() {
          return createPrivateNormalizedAssetPublicationComposition(pool, roots);
        }
      `
    };
    const normalized: Source = {
      file: "services/runtime/src/normalized-asset-publication-composition.ts",
      text: "export function createPrivateNormalizedAssetPublicationComposition() { return {}; }"
    };
    const cases = [
      {
        text: `import { persistOriginalImage } from "../../api/src/asset-service.js";`,
        message: "must not reach services/api/src"
      },
      {
        text: `import type { PrivateCallerTransactionAssetPublisher } from "../../../packages/application/src/imports/private-portable-composition.js";`,
        message: "must not reach legacy authority"
      },
      {
        text: `export function publish() { return transactionalPublisher.finalizeImportedAssets(); }`,
        message: "prohibits legacy writer"
      },
      {
        text: `export function publish() { return persistImportedImage(); }`,
        message: "prohibits legacy writer"
      }
    ] as const;

    for (const candidate of cases) {
      expect(checkAssetImportStorageCompositionInventory([
        root,
        normalized,
        {
          file: "services/runtime/src/portable-normalized-helper.ts",
          text: candidate.text
        }
      ]), candidate.text).toEqual(expect.arrayContaining([
        expect.stringContaining(candidate.message)
      ]));
    }
  });
});
