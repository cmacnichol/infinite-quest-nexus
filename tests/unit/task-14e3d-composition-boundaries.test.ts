import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as portableCompositionBoundaries from "../../scripts/check-portable-composition-boundaries.mjs";
// @ts-expect-error The executable repository checker is intentionally plain ESM.
import { checkPrivateStorageBoundaries } from "../../scripts/check-private-storage-boundaries.mjs";

const { checkPortableCompositionBoundaries, checkPortableCompositionInventory } = portableCompositionBoundaries as unknown as Readonly<{
  checkPortableCompositionBoundaries(file: string, text: string): readonly string[];
  checkPortableCompositionInventory(sources: readonly Readonly<{ file: string; text: string }>[]): readonly string[];
}>;

describe("Task 14e3d portable composition boundaries", () => {
  it("rejects legacy authority, buffered exports, process-local progress, and early consumers", () => {
    const composition = "services/runtime/src/portable-import-export-composition.ts";
    expect(checkPortableCompositionBoundaries(composition, "const x = activeProgressMap;")).not.toEqual([]);
    expect(checkPortableCompositionBoundaries(composition, "type X = PortableArchiveDownloadView;")).not.toEqual([]);
    expect(checkPortableCompositionBoundaries(composition, "import './import-service.js';")).not.toEqual([]);
    expect(checkPortableCompositionBoundaries(
      "services/api/src/server.ts",
      "import { createPortableImportExportComposition } from '../../runtime/src/portable-import-export-composition.js';",
    )).not.toEqual([]);
  });

  it("rejects aliased, namespace, computed, require, dynamic, and re-export consumers", () => {
    const prohibited = [
      `import { createPortableImportExportComposition as compose } from "../../runtime/src/portable-import-export-composition.js"; compose();`,
      `import compose from "../../runtime/src/portable-import-export-composition.js"; compose();`,
      `import * as portable from "../../runtime/src/portable-import-export-composition.js"; portable.createPortableImportExportComposition();`,
      `export { createPortableImportExportComposition as compose } from "../../runtime/src/portable-import-export-composition.js";`,
      `export * from "../../runtime/src/portable-import-export-composition.js";`,
      `export * as portable from "../../runtime/src/portable-import-export-composition.js";`,
      `const portable = require("../../runtime/src/portable-import-export-composition.js"); portable["createPortableImportExportComposition"]();`,
      `const portable = await import("../../runtime/src/portable-import-export-composition.js"); portable[("createPortableImportExportComposition" as const)]();`,
      `const { createPortableImportExportComposition: compose } = require("../../runtime/src/portable-import-export-composition.js"); compose();`
    ];
    for (const text of prohibited) {
      expect(checkPortableCompositionBoundaries("services/api/src/evasion.ts", text), text).not.toEqual([]);
    }
  });

  it("rejects forbidden authorities through imported aliases and static members", () => {
    const composition = "services/runtime/src/portable-import-export-composition.ts";
    for (const text of [
      `import { PortableArchiveDownloadView as Buffered } from "./archive.js";`,
      `import * as legacy from "../api/src/import-service.js"; legacy.commit();`,
      `const legacy = require("../api/src/campaign-archive-service.js");`,
      `const legacy = await import("../api/src/infinite-worlds-import-service.js");`,
      `archive["downloadPortableExport"]();`,
      `state[("activeProgressMap" as const)].set(key, value);`
    ]) {
      expect(checkPortableCompositionBoundaries(composition, text), text).not.toEqual([]);
    }
  });

  it("rejects legacy service imports from the rich caller-client repository through every import form", () => {
    const repository = "packages/database/src/portable-import-family-repository.ts";
    for (const text of [
      `import { importCampaignArchive } from "../../../services/api/src/import-service.js";`,
      `import * as legacy from "../../../services/api/src/campaign-archive-service.js"; legacy.decode();`,
      `const legacy = require("../../../services/api/src/import-service.js");`,
      `const legacy = await import("../../../services/api/src/campaign-archive-service.js");`,
      `export * from "../../../services/api/src/infinite-worlds-import-service.js";`
    ]) {
      expect(checkPortableCompositionBoundaries(repository, text), text).not.toEqual([]);
    }
  });

  it("rejects raw-path aliases and member forms on the private contract", () => {
    const contract = "packages/application/src/imports/private-portable-composition.ts";
    for (const text of [
      `export type Unsafe = { relativePath: string };`,
      `const { storagePath: path } = value;`,
      `value["rawPath"];`,
      `interface Unsafe { ["relativePath"]: string }`
    ]) {
      expect(checkPortableCompositionBoundaries(contract, text), text).not.toEqual([]);
    }
  });

  it("uses the shared production AST inventory for every JavaScript and TypeScript extension", () => {
    const canonical = {
      file: "services/runtime/src/portable-import-export-composition.ts",
      text: "export function createPortableImportExportComposition() { return {}; }"
    };
    for (const extension of ["cjs", "cts", "js", "jsx", "mjs", "mts", "ts", "tsx"]) {
      const file = `services/api/src/evasion.${extension}`;
      expect(checkPortableCompositionInventory([
        canonical,
        {
          file,
          text: `const portable = require("../../runtime/src/portable-import-export-composition.js"); portable["createPortableImportExportComposition"]();`
        }
      ]), file).not.toEqual([]);
    }
    expect(checkPortableCompositionInventory([
      canonical,
      {
        file: "tests/unit/not-production.ts",
        text: `require("../../services/runtime/src/portable-import-export-composition.js");`
      },
      { file: "apps/web/public/index.html", text: "<script>ignored</script>" }
    ])).toEqual([]);
  });

  it("inventory independently rejects all module exposure forms and duplicate definitions", () => {
    const canonical = {
      file: "services/runtime/src/portable-import-export-composition.ts",
      text: "export function createPortableImportExportComposition() { return {}; }"
    };
    for (const text of [
      `import compose from "../../runtime/src/portable-import-export-composition.js";`,
      `import * as portable from "../../runtime/src/portable-import-export-composition.js";`,
      `export { createPortableImportExportComposition as compose } from "../../runtime/src/portable-import-export-composition.js";`,
      `export * from "../../runtime/src/portable-import-export-composition.js";`,
      `const portable = require("../../runtime/src/portable-import-export-composition.js");`,
      `const portable = import("../../runtime/src/portable-import-export-composition.js");`
    ]) {
      expect(checkPortableCompositionInventory([
        canonical,
        { file: "services/api/src/inventory-evasion.ts", text }
      ]), text).not.toEqual([]);
    }
    expect(checkPortableCompositionInventory([
      canonical,
      {
        file: "services/worker/src/duplicate.ts",
        text: "export function createPortableImportExportComposition() { return {}; }"
      }
    ])).toEqual(expect.arrayContaining([
      expect.stringContaining("exactly one canonical production definition")
    ]));
  });

  it("keeps the shipped composition private and free of forbidden authority", async () => {
    const files = [
      "services/runtime/src/portable-import-export-composition.ts",
      "packages/database/src/portable-import-family-repository.ts",
      "packages/application/src/imports/private-portable-composition.ts",
      "packages/application/src/imports/index.ts"
    ] as const;
    for (const file of files) {
      const source = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
      expect(checkPortableCompositionBoundaries(file, source)).toEqual([]);
    }
  });

  it("allows the asset publisher only in the named portable composition consumer", () => {
    const source = `import { createAssetPublicationComposition } from "./asset-import-composition.js";\n
      export async function factory(pool, roots) { return createAssetPublicationComposition(pool, roots); }`;
    expect(checkPrivateStorageBoundaries(
      "services/runtime/src/portable-import-export-composition.ts",
      source,
    )).toEqual([]);
    expect(checkPrivateStorageBoundaries("services/api/src/server.ts", source))
      .toEqual(expect.arrayContaining([expect.stringContaining("must remain unconsumed")]));
  });
});
