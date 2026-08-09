import { describe, expect, it } from "vitest";
// @ts-expect-error The executable repository checker is intentionally plain ESM.
import { checkPrivateStorageBoundaries } from "../../scripts/check-private-storage-boundaries.mjs";

type Source = Readonly<{ file: string; text: string }>;

// @ts-expect-error The executable repository checker is intentionally plain ESM.
import { checkAssetImportStorageCompositionInventory } from "../../scripts/check-private-storage-boundaries.mjs";

describe("Task 14e3e2 neutral publication boundaries", () => {
  it("rejects every production import form that reaches the API filesystem compatibility module", () => {
    const prohibited = [
      `import { createSecureFilesystemAdapter } from "../../api/src/portable-archive-filesystem-adapter.js";`,
      `export { createSecureFilesystemAdapter } from "../../api/src/portable-archive-filesystem-adapter.js";`,
      `export * from "../../api/src/portable-archive-filesystem-adapter.js";`,
      `const adapter = require("../../api/src/portable-archive-filesystem-adapter.js");`,
      `const adapter = await import("../../api/src/portable-archive-filesystem-adapter.js");`
    ];

    for (const source of prohibited) {
      expect(checkPrivateStorageBoundaries(
        "services/worker/src/replacement-publication.ts",
        source,
      ), source).toEqual(expect.arrayContaining([
        expect.stringContaining("API filesystem compatibility module")
      ]));
    }
  });

  it("rejects transitive replacement-graph edges to every API implementation import form", () => {
    const apiEdges = [
      `import { inspectArchive } from "../../api/src/archive-io.js";`,
      `export { inspectArchive } from "../../api/src/archive-io.js";`,
      `export * from "../../api/src/archive-io.js";`,
      `const archive = require("../../api/src/archive-io.js");`,
      `const archive = await import("../../api/src/archive-io.js");`
    ];

    for (const edge of apiEdges) {
      const sources: readonly Source[] = [{
        file: "services/runtime/src/normalized-asset-publication-composition.ts",
        text: `import "./normalized-publication-helper";`
      }, {
        file: "services/runtime/src/normalized-publication-helper.ts",
        text: edge
      }, {
        file: "services/api/src/archive-io.ts",
        text: "export const inspectArchive = () => undefined;"
      }];
      expect(checkAssetImportStorageCompositionInventory(sources), edge).toEqual(
        expect.arrayContaining([
          expect.stringContaining("normalized publication replacement graph must not reach services/api/src")
        ]),
      );
    }
  });

  it("allows only the neutral seam to consume normalized request authority and keeps the seam unconsumed", () => {
    expect(checkPrivateStorageBoundaries(
      "services/runtime/src/normalized-asset-publication-composition.ts",
      `import { createPostgresNormalizedAssetPublicationRepository } from "../../../packages/database/src/normalized-asset-publication-repository.js";`,
    )).toEqual([]);

    for (const source of [
      `import { createPrivateNormalizedAssetPublicationComposition } from "../../runtime/src/normalized-asset-publication-composition.js";`,
      `export { createPrivateNormalizedAssetPublicationComposition } from "../../runtime/src/normalized-asset-publication-composition.js";`,
      `export * from "../../runtime/src/normalized-asset-publication-composition.js";`,
      `const publication = require("../../runtime/src/normalized-asset-publication-composition.js");`,
      `const publication = await import("../../runtime/src/normalized-asset-publication-composition.js");`
    ]) {
      expect(checkPrivateStorageBoundaries(
        "services/worker/src/replacement-publication.ts",
        source,
      ), source).toEqual([
        expect.stringContaining("normalized publication seam must remain unconsumed")
      ]);
    }
  });

  it("keeps the API adapter as an exact compatibility re-export and blocks private contract barrel leaks", () => {
    expect(checkPrivateStorageBoundaries(
      "services/api/src/portable-archive-filesystem-adapter.ts",
      `export * from "../../runtime/src/secure-filesystem-adapter.js";`,
    )).toEqual([]);
    expect(checkPrivateStorageBoundaries(
      "services/api/src/portable-archive-filesystem-adapter.ts",
      `export * from "../../runtime/src/secure-filesystem-adapter.js";
       export const extraCompatibilityAuthority = true;`,
    )).toEqual([
      expect.stringContaining("must be an exact re-export")
    ]);

    for (const source of [
      `export { type PrivateNormalizedAssetPublicationPort } from "./private-normalized-asset-publication.js";`,
      `export * from "./private-normalized-asset-publication.js";`,
      `const privatePublication = require("./private-normalized-asset-publication.js");`,
      `const privatePublication = await import("./private-normalized-asset-publication.js");`
    ]) {
      expect(checkPrivateStorageBoundaries(
        "packages/application/src/assets/index.ts",
        source,
      ), source).toEqual([
        expect.stringContaining("must not leak through an application public barrel")
      ]);
    }
  });
});
