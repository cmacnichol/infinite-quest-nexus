import { describe, expect, it } from "vitest";
// @ts-expect-error The executable repository checker is intentionally plain ESM.
import * as privateStorageBoundaries from "../../scripts/check-private-storage-boundaries.mjs";

type Source = Readonly<{ file: string; text: string }>;

const FACTORY_FIXTURES: readonly Source[] = [
  {
    file: "packages/database/src/durable-filesystem-repository.ts",
    text: "export function createPostgresDurableFilesystemRepository() { return {}; }"
  },
  {
    file: "packages/database/src/asset-publication-repository.ts",
    text: "export function createPostgresAssetPublicationRepository() { return {}; }"
  },
  {
    file: "packages/database/src/secure-storage-repository.ts",
    text: "export function createPostgresSecureStorageRepository() { return {}; }"
  },
  {
    file: "packages/database/src/import-repository.ts",
    text: "export function createPostgresImportRepository() { return {}; }"
  },
  {
    file: "packages/database/src/finalized-asset-delivery-repository.ts",
    text: "export function createPostgresFinalizedAssetDeliveryRepository() { return {}; }"
  },
  {
    file: "services/runtime/src/secure-filesystem-adapter.ts",
    text: "export function createSecureFilesystemAdapter() { return {}; }"
  },
  {
    file: "services/runtime/src/asset-import-composition.ts",
    text: `
      import { createPostgresDurableFilesystemRepository } from "../../../packages/database/src/durable-filesystem-repository.js";
      import { createPostgresAssetPublicationRepository } from "../../../packages/database/src/asset-publication-repository.js";
      import { createPostgresSecureStorageRepository } from "../../../packages/database/src/secure-storage-repository.js";
      import { createPostgresImportRepository } from "../../../packages/database/src/import-repository.js";
      import { createPostgresFinalizedAssetDeliveryRepository } from "../../../packages/database/src/finalized-asset-delivery-repository.js";
      import { createSecureFilesystemAdapter } from "./secure-filesystem-adapter.js";
      export function createAssetImportStorageComposition() {
        createPostgresDurableFilesystemRepository();
        createPostgresAssetPublicationRepository();
        createPostgresSecureStorageRepository();
        createPostgresImportRepository();
        createPostgresFinalizedAssetDeliveryRepository();
        createSecureFilesystemAdapter();
      }
      export function createAssetPublicationComposition() { return {}; }
    `
  },
  {
    file: "services/runtime/src/portable-import-export-composition.ts",
    text: `
      import { createPrivatePortableNormalizedAssetPublicationComposition } from "./portable-normalized-asset-publication-composition.js";
      export function createPortableImportExportComposition() {
        return createPrivatePortableNormalizedAssetPublicationComposition(pool, roots);
      }
    `
  },
  {
    file: "packages/database/src/portable-normalized-asset-publication-repository.ts",
    text: "export function createPostgresPortableNormalizedAssetPublicationRepository() { return {}; }"
  },
  {
    file: "services/runtime/src/normalized-asset-publication-composition.ts",
    text: `
      import { createAssetImportStorageComposition } from "./asset-import-composition.js";
      export function createPrivateNormalizedAssetPublicationComposition() {
        return createAssetImportStorageComposition(pool, roots);
      }
    `
  },
  {
    file: "services/runtime/src/private-asset-metadata-backfill-composition.ts",
    text: `
      import { createAssetImportStorageComposition } from "./asset-import-composition.js";
      export function createPrivateAssetMetadataBackfillComposition() {
        return createAssetImportStorageComposition(pool, roots);
      }
    `
  },
  {
    file: "services/runtime/src/private-filesystem-recovery-composition.ts",
    text: `
      import { createAssetImportStorageComposition } from "./asset-import-composition.js";
      import { createPrivateNormalizedAssetPublicationComposition } from "./normalized-asset-publication-composition.js";
      import { createPrivatePortableNormalizedAssetPublicationComposition } from "./portable-normalized-asset-publication-composition.js";
      export function createPrivateFilesystemRecoveryComposition() {
        createAssetImportStorageComposition(pool, roots);
        createPrivateNormalizedAssetPublicationComposition(pool, roots);
        createPrivatePortableNormalizedAssetPublicationComposition(pool, roots);
      }
    `
  },
  {
    file: "services/runtime/src/portable-normalized-asset-publication-composition.ts",
    text: `
      import { createPostgresPortableNormalizedAssetPublicationRepository } from "../../../packages/database/src/portable-normalized-asset-publication-repository.js";
      import { createPrivateNormalizedAssetPublicationComposition } from "./normalized-asset-publication-composition.js";
      export function createPrivatePortableNormalizedAssetPublicationComposition() {
        createPostgresPortableNormalizedAssetPublicationRepository(pool);
        return createPrivateNormalizedAssetPublicationComposition(pool, roots);
      }
    `
  },
  {
    file: "services/runtime/src/illustration-asset-publication-composition.ts",
    text: `
      import { createPrivateNormalizedAssetPublicationComposition } from "./normalized-asset-publication-composition.js";
      export function createPrivateIllustrationAssetPublicationComposition() {
        return createPrivateNormalizedAssetPublicationComposition(pool, roots);
      }
    `
  }
];

const checkInventory = (privateStorageBoundaries as unknown as Readonly<{
  checkAssetImportStorageCompositionInventory(sources: readonly Source[]): readonly string[];
}>).checkAssetImportStorageCompositionInventory;
const isInventorySource = (privateStorageBoundaries as unknown as Readonly<{
  isPrivateStorageInventorySource(file: string): boolean;
}>).isPrivateStorageInventorySource;

describe("Task 14e3b5 storage composition inventory", () => {
  it("rejects concrete storage factory consumption outside the named composition", () => {
    const violations = privateStorageBoundaries.checkPrivateStorageBoundaries(
      "services/api/src/asset-service.ts",
      `import { createPostgresImportRepository } from "../../../packages/database/src/import-repository.js";
       export const repository = createPostgresImportRepository(pool);`,
    );

    expect(violations).toEqual([
      expect.stringContaining("concrete storage factory createPostgresImportRepository")
    ]);
  });

  it("rejects composition consumers and private contracts imported through public barrels", () => {
    expect(privateStorageBoundaries.checkPrivateStorageBoundaries(
      "services/runtime/src/main.ts",
      `import { createAssetImportStorageComposition } from "./asset-import-composition.js";`,
    )).toEqual([
      expect.stringContaining("private storage composition must remain unconsumed")
    ]);
    expect(privateStorageBoundaries.checkPrivateStorageBoundaries(
      "services/runtime/src/example.ts",
      `import type { PrivatePortableRepositoryPort } from "../../../packages/application/src/imports/index.js";`,
    )).toEqual([
      expect.stringContaining("private storage contracts must use their defining module")
    ]);
  });

  it("rejects every static and dynamic concrete-factory or composition importer form", () => {
    const prohibited = [
      `import createImports from "../../../packages/database/src/import-repository.js";
       createImports(pool);`,
      `import { createPostgresImportRepository as createImports } from "../../../packages/database/src/import-repository.js";
       createImports(pool);`,
      `import * as imports from "../../../packages/database/src/import-repository.js";
       imports.createPostgresImportRepository(pool);`,
      `import * as imports from "../../../packages/database/src/import-repository.js";
       const { createPostgresImportRepository: createImports } = imports;
       createImports(pool);`,
      `export { createPostgresImportRepository as createImports } from "../../../packages/database/src/import-repository.js";`,
      `export * from "../../../packages/database/src/import-repository.js";`,
      `export * as imports from "../../../packages/database/src/import-repository.js";`,
      `const imports = require("../../../packages/database/src/import-repository.js");
       imports["createPostgresImportRepository"](pool);`,
      `const imports = await import("../../../packages/database/src/import-repository.js");
       imports[("createPostgresImportRepository" as const)](pool);`,
      `const { createPostgresImportRepository: createImports } = require("../../../packages/database/src/import-repository.js");
       createImports(pool);`,
      `export { createAssetImportStorageComposition } from "../../runtime/src/asset-import-composition.js";`,
      `import composeStorage from "../../runtime/src/asset-import-composition.js";
       composeStorage(pool, roots);`,
      `export * as storageComposition from "../../runtime/src/asset-import-composition.js";`,
      `const composition = await import("../../runtime/src/asset-import-composition.js");
       composition[(` + "`createAssetImportStorageComposition`" + ` satisfies string)](pool, roots);`,
      `const composition = require("../../runtime/src/asset-import-composition.js");
       composition.createAssetImportStorageComposition(pool, roots);`
    ];

    for (const source of prohibited) {
      expect(privateStorageBoundaries.checkPrivateStorageBoundaries(
        "services/api/src/example.ts",
        source,
      ), source).not.toEqual([]);
    }
  });

  it("rejects aliases inside the canonical composition so the call inventory cannot be evaded", () => {
    const aliased = FACTORY_FIXTURES.map((source) => source.file === "services/runtime/src/asset-import-composition.ts"
      ? {
        ...source,
        text: source.text
          .replaceAll("createPostgresImportRepository", "createImports")
          .replace(
            "import { createImports }",
            "import { createPostgresImportRepository as createImports }",
          )
      }
      : source);

    expect(checkInventory(aliased)).toEqual(expect.arrayContaining([
      expect.stringContaining("createPostgresImportRepository must be imported directly")
    ]));
  });

  it("inventory independently rejects every concrete-factory exposure and call form", () => {
    const prohibited = [
      `import createImports from "../../../packages/database/src/import-repository.js";
       createImports(pool);`,
      `import { createPostgresImportRepository } from "../../../packages/database/src/import-repository.js";`,
      `import { createPostgresImportRepository as createImports } from "../../../packages/database/src/import-repository.js";
       createImports(pool);`,
      `import * as imports from "../../../packages/database/src/import-repository.js";
       imports.createPostgresImportRepository(pool);`,
      `export { createPostgresImportRepository as createImports } from "../../../packages/database/src/import-repository.js";`,
      `export * from "../../../packages/database/src/import-repository.js";`,
      `export * as imports from "../../../packages/database/src/import-repository.js";`,
      `const imports = require("../../../packages/database/src/import-repository.js");
       imports["createPostgresImportRepository"](pool);`,
      `const imports = await import("../../../packages/database/src/import-repository.js");
       imports[("createPostgresImportRepository" as const)](pool);`,
      `const { createPostgresImportRepository: createImports } = require("../../../packages/database/src/import-repository.js");
       createImports(pool);`,
      `const { createPostgresImportRepository: createImports } = await import("../../../packages/database/src/import-repository.js");
       createImports(pool);`,
      `const imports = require("../../../packages/database/src/import-repository.js");
       (imports[(` + "`createPostgresImportRepository`" + ` satisfies string)] as Function)(pool);`
    ];

    for (const text of prohibited) {
      expect(checkInventory([
        ...FACTORY_FIXTURES,
        { file: "services/api/src/inventory-evasion.ts", text }
      ]), text).not.toEqual([]);
    }
  });

  it("inventory independently rejects every composition consumer form", () => {
    const prohibited = [
      `import composeStorage from "../../runtime/src/asset-import-composition.js";
       composeStorage(pool, roots);`,
      `import { createAssetImportStorageComposition } from "../../runtime/src/asset-import-composition.js";`,
      `import { createAssetImportStorageComposition as composeStorage } from "../../runtime/src/asset-import-composition.js";
       composeStorage(pool, roots);`,
      `import * as storage from "../../runtime/src/asset-import-composition.js";
       storage.createAssetImportStorageComposition(pool, roots);`,
      `import * as storage from "../../runtime/src/asset-import-composition.js";
       const storageAlias = storage;
       const { createAssetImportStorageComposition: composeStorage } = storageAlias;
       composeStorage(pool, roots);`,
      `export { createAssetImportStorageComposition as composeStorage } from "../../runtime/src/asset-import-composition.js";`,
      `export * from "../../runtime/src/asset-import-composition.js";`,
      `export * as storage from "../../runtime/src/asset-import-composition.js";`,
      `const storage = require("../../runtime/src/asset-import-composition.js");
       storage["createAssetImportStorageComposition"](pool, roots);`,
      `const storage = await import("../../runtime/src/asset-import-composition.js");
       storage[("createAssetImportStorageComposition" as const)](pool, roots);`,
      `const { createAssetImportStorageComposition: composeStorage } = require("../../runtime/src/asset-import-composition.js");
       composeStorage(pool, roots);`,
      `const { createAssetImportStorageComposition: composeStorage } = await import("../../runtime/src/asset-import-composition.js");
       composeStorage(pool, roots);`
    ];

    for (const text of prohibited) {
      expect(checkInventory([
        ...FACTORY_FIXTURES,
        { file: "services/api/src/inventory-consumer.ts", text }
      ]), text).toEqual(expect.arrayContaining([
        expect.stringContaining("createAssetImportStorageComposition must be consumed directly")
      ]));
    }
  });

  it("uses one repository-wrapper source predicate for every supported AST mode", () => {
    for (const file of [
      "services/api/src/example.cjs",
      "services/api/src/example.js",
      "services/api/src/example.jsx",
      "services/api/src/example.mjs",
      "services/api/src/example.mts",
      "services/api/src/example.ts",
      "services/api/src/example.tsx"
    ]) {
      expect(isInventorySource(file), file).toBe(true);
    }
    expect(isInventorySource("services/api/src/index.html")).toBe(false);
    expect(isInventorySource("tests/unit/example.tsx")).toBe(false);
  });

  it("requires each concrete factory exactly once in its definition and composition", () => {
    expect(typeof checkInventory).toBe("function");
    expect(checkInventory([
      ...FACTORY_FIXTURES,
      { file: "apps/web/public/index.html", text: "<!doctype html>" }
    ])).toEqual([]);
    expect(checkInventory([
      ...FACTORY_FIXTURES,
      {
        file: "services/worker/src/worker.ts",
        text: `import { createPostgresImportRepository } from "../../../packages/database/src/import-repository.js";
               createPostgresImportRepository(pool);`
      }
    ])).toEqual(expect.arrayContaining([
      expect.stringContaining("createPostgresImportRepository must be called only once")
    ]));
  });
});
