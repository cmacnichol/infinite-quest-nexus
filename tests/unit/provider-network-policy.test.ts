import { describe, expect, it, vi } from "vitest";
import { createProviderNetworkPolicy } from "../../packages/security/src/provider-network-policy.js";

const resolver = vi.fn(async (hostname: string) => {
  const records: Record<string, Array<{ address: string; family: 4 | 6 }>> = {
    "localhost": [{ address: "127.0.0.1", family: 4 }],
    "public.test": [{ address: "8.8.8.8", family: 4 }],
    "private.test": [{ address: "10.20.30.40", family: 4 }],
    "mapped.test": [{ address: "::ffff:10.20.30.40", family: 6 }],
    "missing.test": [],
    "mixed.test": [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 }
    ]
  };
  return records[hostname] ?? [];
});

describe("provider network policy", () => {
  it("allows localhost defaults and configured private networks", async () => {
    const policy = createProviderNetworkPolicy({
      allowlist: ["localhost", "127.0.0.0/8", "::1/128", "10.20.0.0/16"],
      resolver
    });

    await expect(policy.approve(new URL("http://localhost:1234/v1"), "discovery"))
      .resolves.toMatchObject({ address: "127.0.0.1", family: 4 });
    await expect(policy.approve(new URL("http://private.test/v1"), "discovery"))
      .resolves.toMatchObject({ address: "10.20.30.40", family: 4 });
    await expect(policy.approve(new URL("https://public.test/v1"), "discovery"))
      .resolves.toMatchObject({ address: "8.8.8.8", family: 4 });
    await expect(policy.approve(new URL("http://mapped.test/v1"), "discovery"))
      .resolves.toMatchObject({ address: "10.20.30.40", family: 4 });
  });

  it("rejects public HTTP, mixed answers, metadata, and private destinations", async () => {
    const policy = createProviderNetworkPolicy({
      allowlist: ["localhost", "127.0.0.0/8", "::1/128"],
      resolver
    });

    await expect(policy.approve(new URL("http://public.test/v1"), "discovery"))
      .rejects.toMatchObject({ code: "PROVIDER_DESTINATION_NOT_ALLOWED" });
    await expect(policy.approve(new URL("https://mixed.test/v1"), "discovery"))
      .rejects.toMatchObject({ code: "PROVIDER_DESTINATION_NOT_ALLOWED" });
    await expect(policy.approve(new URL("http://169.254.169.254/latest/meta-data"), "discovery"))
      .rejects.toMatchObject({ code: "PROVIDER_DESTINATION_NOT_ALLOWED" });
    await expect(policy.approve(new URL("http://10.1.2.3/v1"), "discovery"))
      .rejects.toMatchObject({ code: "PROVIDER_DESTINATION_NOT_ALLOWED" });
  });

  it("rejects ambiguous URLs and missing DNS answers without disclosing policy details", async () => {
    const policy = createProviderNetworkPolicy({ allowlist: ["localhost", "127.0.0.0/8", "::1/128"], resolver });

    for (const url of [
      new URL("ftp://public.test/v1"),
      new URL("https://user:password@public.test/v1"),
      new URL("https://public.test/v1#fragment")
    ]) {
      await expect(policy.approve(url, "discovery")).rejects.toMatchObject({
        code: "PROVIDER_DESTINATION_NOT_ALLOWED",
        stage: "url",
        statusCode: 422,
        expose: true,
        message: "The provider destination is not allowed by the server network policy."
      });
    }

    await expect(policy.approve(new URL("https://missing.test/v1"), "discovery")).rejects.toMatchObject({
      code: "PROVIDER_DESTINATION_NOT_ALLOWED",
      stage: "dns"
    });
  });

  it("converts DNS resolution failures into the safe destination error", async () => {
    const policy = createProviderNetworkPolicy({
      allowlist: ["localhost", "127.0.0.0/8", "::1/128"],
      resolver: async () => {
        throw new Error("internal resolver failure");
      }
    });

    await expect(policy.approve(new URL("https://public.test/v1"), "discovery")).rejects.toMatchObject({
      code: "PROVIDER_DESTINATION_NOT_ALLOWED",
      stage: "dns",
      message: "The provider destination is not allowed by the server network policy."
    });
  });
});
