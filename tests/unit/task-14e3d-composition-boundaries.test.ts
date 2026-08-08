import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { checkPortableCompositionBoundaries } from "../../scripts/check-portable-composition-boundaries.mjs";
// @ts-expect-error The executable repository checker is intentionally plain ESM.
import { checkPrivateStorageBoundaries } from "../../scripts/check-private-storage-boundaries.mjs";

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

  it("keeps the shipped composition private and free of forbidden authority", async () => {
    const files = [
      "services/runtime/src/portable-import-export-composition.ts",
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
