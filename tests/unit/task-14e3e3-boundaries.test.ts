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

function replacementSources(helperText: string): readonly Source[] {
  return [{
    file: "services/runtime/src/illustration-asset-publication-composition.ts",
    text: `
      import { createPrivateNormalizedAssetPublicationComposition } from "./normalized-asset-publication-composition.js";
      import "./illustration-publication-helper.js";
      export function createPrivateIllustrationAssetPublicationComposition() {
        return createPrivateNormalizedAssetPublicationComposition(pool, roots);
      }
    `
  }, {
    file: "services/runtime/src/normalized-asset-publication-composition.ts",
    text: "export function createPrivateNormalizedAssetPublicationComposition() { return {}; }"
  }, {
    file: "services/runtime/src/illustration-publication-helper.ts",
    text: helperText
  }];
}

describe("Task 14e3e3 illustration replacement boundaries", () => {
  it("allows the illustration composition only in the named worker consumer for every module-loading form", () => {
    const prohibited = [
      `import { createPrivateIllustrationAssetPublicationComposition } from "../../runtime/src/illustration-asset-publication-composition.js";`,
      `export { createPrivateIllustrationAssetPublicationComposition } from "../../runtime/src/illustration-asset-publication-composition.js";`,
      `export * from "../../runtime/src/illustration-asset-publication-composition.js";`,
      `const composition = require("../../runtime/src/illustration-asset-publication-composition.js");`,
      `const composition = await import("../../runtime/src/illustration-asset-publication-composition.js");`
    ];

    for (const source of prohibited) {
      expect(checkPrivateStorageBoundaries(
        "services/worker/src/replacement-publication.ts",
        source,
      ), source).toEqual(expect.arrayContaining([
        expect.stringContaining("illustration publication composition may be consumed only by services/worker/src/worker.ts")
      ]));
    }
  });

  it("sole-consumer guards the private illustration completion repository", () => {
    const prohibited = [
      `import { createPostgresIllustrationAssetPublicationRepository } from "../../../packages/database/src/illustration-asset-publication-repository.js";`,
      `export { createPostgresIllustrationAssetPublicationRepository } from "../../../packages/database/src/illustration-asset-publication-repository.js";`,
      `export * from "../../../packages/database/src/illustration-asset-publication-repository.js";`,
      `const repository = require("../../../packages/database/src/illustration-asset-publication-repository.js");`,
      `const repository = await import("../../../packages/database/src/illustration-asset-publication-repository.js");`
    ];

    for (const source of prohibited) {
      expect(checkPrivateStorageBoundaries(
        "services/worker/src/replacement-publication.ts",
        source,
      ), source).toEqual(expect.arrayContaining([
        expect.stringContaining("private illustration publication repository may be consumed only")
      ]));
    }
    expect(checkPrivateStorageBoundaries(
      "services/runtime/src/illustration-asset-publication-composition.ts",
      `import { createPostgresIllustrationAssetPublicationRepository } from "../../../packages/database/src/illustration-asset-publication-repository.js";`,
    )).toEqual([]);
  });

  it("blocks the private illustration coordinator contract from public barrels", () => {
    const prohibited = [
      `export { type PrivateIllustrationAssetPublicationCoordinator } from "./private-illustration-asset-publication.js";`,
      `export * from "./private-illustration-asset-publication.js";`,
      `const privateIllustration = require("./private-illustration-asset-publication.js");`,
      `const privateIllustration = await import("./private-illustration-asset-publication.js");`
    ];

    for (const source of prohibited) {
      expect(checkPrivateStorageBoundaries(
        "packages/application/src/illustration/index.ts",
        source,
      ), source).toEqual([
        expect.stringContaining("must not leak through an application public barrel")
      ]);
    }
  });

  it("rejects transitive API asset authority across static, re-export, CommonJS, and dynamic edges", () => {
    const prohibited = [
      `import { createAssetService } from "../../api/src/asset-service.js";`,
      `export { createAssetService } from "../../api/src/asset-service.js";`,
      `export * from "../../api/src/asset-service.js";`,
      `const assets = require("../../api/src/asset-service.js");`,
      `const assets = await import("../../api/src/asset-service.js");`
    ];

    for (const helperText of prohibited) {
      expect(
        checkAssetImportStorageCompositionInventory(replacementSources(helperText)),
        helperText,
      ).toEqual(expect.arrayContaining([
        expect.stringContaining("illustration publication replacement graph must not reach services/api/src")
      ]));
    }
  });

  it("rejects transitive legacy illustration modules and writer authority", () => {
    expect(checkAssetImportStorageCompositionInventory(replacementSources(
      `import { completePortImageJob } from "./illustration-image-job-adapter.js";`,
    ))).toEqual(expect.arrayContaining([
      expect.stringContaining("must not reach legacy runtime module")
    ]));

    for (const helperText of [
      `export function publish() { return persistTurnImage(); }`,
      `export function publish(writer: object) { return writer["persistWorldCover"](); }`,
      `export function publish(writer: object) { return writer.lockOriginalImages(); }`,
      `export function publish() { return completePortImageJob(); }`
    ]) {
      expect(
        checkAssetImportStorageCompositionInventory(replacementSources(helperText)),
        helperText,
      ).toEqual(expect.arrayContaining([
        expect.stringContaining("illustration publication replacement graph prohibits legacy writer")
      ]));
    }
  });
});
