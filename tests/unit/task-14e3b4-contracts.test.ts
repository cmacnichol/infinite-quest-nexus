import { describe, expect, it } from "vitest";
import * as PrivatePortableAuthority from "../../packages/application/src/imports/private-portable-authority.js";
import * as PrivateSecureStorage from "../../packages/application/src/assets/private-secure-storage.js";

describe("Task 14e3b4 private secure-storage contracts", () => {
  it("exposes atomic portable issuance binders instead of loose bearer issuance", () => {
    expect(PrivatePortableAuthority).toHaveProperty("bindPrivateAtomicStagedIssuance");
    expect(PrivatePortableAuthority).toHaveProperty("bindPrivateAtomicExportIssuance");
  });

  it("exposes immutable pre-write and bounded-stream authority binders", () => {
    expect(PrivateSecureStorage).toHaveProperty("bindPrivatePrewriteNodeAuthority");
    expect(PrivateSecureStorage).toHaveProperty("bindPrivateBoundedStreamLimits");
  });
});
