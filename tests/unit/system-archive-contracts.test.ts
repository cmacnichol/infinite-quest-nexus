import { describe, expect, it } from "vitest";
import {
  systemArchiveJobViewSchema,
  systemArchivePayloadSchema,
  systemChronicleRecordSchema,
  systemPortableProviderSchema
} from "../../packages/contracts/src/system-archives.js";

const sourceOwnerId = "11111111-1111-4111-8111-111111111111";

describe("System Archive contracts", () => {
  it("accepts one-owner logical payloads while refusing provider secrets and Chronicle vectors", () => {
    const validPayload = {
      formatVersion: 1,
      sourceInstallationId: "22222222-2222-4222-8222-222222222222",
      sourceOwnerCount: 1,
      sourceOwner: { sourceId: sourceOwnerId, displayName: "Archive owner" },
      records: []
    };

    expect(systemArchivePayloadSchema.parse(validPayload).sourceOwnerCount).toBe(1);
    expect(() => systemPortableProviderSchema.parse({ encryptedApiKey: "secret" })).toThrow();
    expect(() => systemChronicleRecordSchema.parse({ embedding: [0.1] })).toThrow();
  });

  it("accepts a queued job view without leaking an operational capability", () => {
    const job = {
      id: "33333333-3333-4333-8333-333333333333",
      kind: "export",
      status: "queued",
      createdAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-25T12:00:00.000Z",
      report: null
    };

    expect(systemArchiveJobViewSchema.parse(job).status).toBe("queued");
  });
});
