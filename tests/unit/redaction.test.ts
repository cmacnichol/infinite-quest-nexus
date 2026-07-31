import { describe, expect, it } from "vitest";
import { sanitizeSensitiveConfiguration } from "../../packages/domain/src/redaction.js";

describe("sensitive configuration redaction", () => {
  it("removes credential-like keys while preserving non-secret provider settings", () => {
    expect(sanitizeSensitiveConfiguration({
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
      privateKey: "private-key",
      credential: "credential",
      awsCredentials: { accessKeyId: "nested-access-key", secretAccessKey: "nested-secret-key" },
      secretAccessKey: "secret-access-key",
      accessKeyId: "access-key-id",
      nested: {
        bearerToken: "bearer-token",
        webhookSecret: "webhook-secret",
        tokenType: "spark",
        credentialMode: "api-key",
        privateKeyAlgorithm: "ed25519",
        awsRegion: "us-east-1",
        accessKeyRotationDays: 30,
        modelDiscoveryEnabled: true
      }
    })).toEqual({
      nested: {
        tokenType: "spark",
        credentialMode: "api-key",
        privateKeyAlgorithm: "ed25519",
        awsRegion: "us-east-1",
        accessKeyRotationDays: 30,
        modelDiscoveryEnabled: true
      }
    });
  });
});
