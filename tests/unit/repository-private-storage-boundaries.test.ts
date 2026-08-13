import { describe, expect, it } from "vitest";
// @ts-expect-error The executable repository checker is intentionally plain ESM.
import { checkPrivateStorageBoundaries } from "../../scripts/check-private-storage-boundaries.mjs";

describe("private storage repository boundary guard", () => {
  it("rejects retired seam symbols and production imports of historical test helpers", () => {
    expect(checkPrivateStorageBoundaries(
      "services/api/src/example.ts",
      `import type { PrivateFilesystemCapabilityPersistencePort, PrivateFilesystemDeliveryGrantPersistencePort, DatabaseIssuedStorageLocator } from "../../../packages/application/src/assets/private-storage-lifecycle.js";
       export function redeem(value: PrivateFilesystemCapabilityPersistencePort, raw: PrivateFilesystemDeliveryGrantPersistencePort, locator: DatabaseIssuedStorageLocator) {
         void raw.issueDeliveryGrant;
         return value.redeemStorageLocator(scope, locator);
       }`,
    )).toEqual(expect.arrayContaining([
      expect.stringContaining("PrivateFilesystemCapabilityPersistencePort"),
      expect.stringContaining("PrivateFilesystemDeliveryGrantPersistencePort"),
      expect.stringContaining("DatabaseIssuedStorageLocator"),
      expect.stringContaining("issueDeliveryGrant"),
      expect.stringContaining("redeemStorageLocator")
    ]));
    expect(checkPrivateStorageBoundaries(
      "packages/application/src/example.ts",
      `import { helper } from "../../../tests/helpers/legacy-private-storage-lifecycle-contracts.js";`,
    )).toEqual([
      expect.stringContaining("production source must not import historical storage helpers")
    ]);
    for (const source of [
      `export * from "../../../tests/helpers/legacy-private-storage-lifecycle-contracts.js";`,
      `export { helper } from "../../../tests/helpers/legacy-portable-archive-filesystem-adapter.js";`,
      `export const helper = import("../../../tests/helpers/private-storage-lifecycle-fake.js");`,
      `export const helper = require("../../../tests/helpers/private-storage-lifecycle-fake.js");`
    ]) {
      expect(checkPrivateStorageBoundaries("services/api/src/example.ts", source)).toEqual([
        expect.stringContaining("production source must not import historical storage helpers")
      ]);
    }
    for (const source of [
      `export const value = repository["redeemStorageLocator"](scope, locator);`,
      "export const value = repository[`issueDeliveryGrant`](request);",
      `export const value = repository?.["redeemDeliveryGrant"](redemption);`,
      `export const value = repository[("redeemStorageLocator" as const)](scope, locator);`,
      `export const value = repository[(<const>"issueDeliveryGrant")](request);`,
      `export const value = repository[("redeemDeliveryGrant" satisfies string)](redemption);`,
      `export const value = repository[("redeemStorageLocator"!)](scope, locator);`,
      `export const value = repository[(("issueDeliveryGrant" as const) satisfies string)!](request);`
    ]) {
      expect(checkPrivateStorageBoundaries("services/api/src/example.ts", source)).toEqual([
        expect.stringContaining("retired private storage member")
      ]);
    }
  });

  it("allows the explicit new private ports and historical helpers inside tests", () => {
    expect(checkPrivateStorageBoundaries(
      "services/api/src/example.ts",
      `import type { PrivateAtomicPortableIssuancePort } from "../../../packages/application/src/imports/private-portable-authority.js";
       export const value = null as unknown as PrivateAtomicPortableIssuancePort;`,
    )).toEqual([]);
    expect(checkPrivateStorageBoundaries(
      "tests/helpers/example.ts",
      `export interface PrivateFilesystemCapabilityPersistencePort {}`,
    )).toEqual([]);
    for (const source of [
      `export const value = repository[memberName];`,
      "export const value = repository[`redeem${kind}`];",
      `export const value = repository[(memberName as string)];`,
      "export const value = repository[(`redeem${kind}` satisfies string)];",
      `export const redeemStorageLocatorForDiagnostics = () => undefined;`
    ]) {
      expect(checkPrivateStorageBoundaries("services/api/src/example.ts", source)).toEqual([]);
    }
  });

  it("preserves wrapped-member detection in TSX and JavaScript parser modes", () => {
    expect(checkPrivateStorageBoundaries(
      "services/api/src/example.tsx",
      `const view = <div />;
       export const value = repository[("issueDeliveryGrant" as const)](request);`,
    )).toEqual([
      expect.stringContaining("retired private storage member")
    ]);
    expect(checkPrivateStorageBoundaries(
      "services/api/src/example.tsx",
      `const view = <div />;
       export const value = repository[(memberName as string)];`,
    )).toEqual([]);
    expect(checkPrivateStorageBoundaries(
      "services/api/src/example.js",
      `const view = <div />;
       export const value = repository[(("redeemDeliveryGrant"))](request);`,
    )).toEqual([
      expect.stringContaining("retired private storage member")
    ]);
    expect(checkPrivateStorageBoundaries(
      "services/api/src/example.js",
      `const view = <div />;
       export const value = repository[("redeem" + kind)];`,
    )).toEqual([]);
  });
});
