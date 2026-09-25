import { describe, expect, it } from "vitest";
import { applicationMetadata } from "../../services/api/src/app-metadata.js";

describe("application metadata", () => {
  it("uses explicit build metadata", () => {
    expect(applicationMetadata({
      NEXUS_VERSION: "0.1.0",
      NEXUS_BUILD_COMMIT: "9b9c8cf",
      NEXUS_BUILD_DATE: "2026-07-22T12:00:00Z",
      NEXUS_BUILD_DIRTY: "false"
    })).toEqual({
      name: "Infinite Quest Nexus",
      version: "0.1.0",
      commit: "9b9c8cf",
      builtAt: "2026-07-22T12:00:00Z",
      dirty: false
    });
  });

  it("reports a dirty build when the build was made from an uncommitted tree", () => {
    expect(applicationMetadata({
      NEXUS_VERSION: "0.1.0",
      NEXUS_BUILD_COMMIT: "9b9c8cf",
      NEXUS_BUILD_DATE: "2026-07-22T12:00:00Z",
      NEXUS_BUILD_DIRTY: "true"
    }).dirty).toBe(true);
  });

  it("falls back to the package-script version and omits unavailable build details", () => {
    expect(applicationMetadata({ npm_package_version: "0.1.0" })).toEqual({
      name: "Infinite Quest Nexus",
      version: "0.1.0",
      commit: null,
      builtAt: null,
      dirty: null
    });
  });

  it("uses the repository's initial version when no build environment is available", () => {
    expect(applicationMetadata({}).version).toBe("0.1.0");
  });
});
