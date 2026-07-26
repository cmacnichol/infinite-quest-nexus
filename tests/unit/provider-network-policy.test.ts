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

function resolverFor(records: Record<string, Array<{ address: string; family: 4 | 6 }>>) {
  return async (hostname: string) => records[hostname] ?? [];
}

const nonPublicBoundaryCases = [
  { range: "0.0.0.0/8", url: "https://0.255.255.255/v1" },
  { range: "10.0.0.0/8", url: "https://10.255.255.255/v1" },
  { range: "100.64.0.0/10", url: "https://100.127.255.255/v1" },
  { range: "127.0.0.0/8", url: "https://127.255.255.255/v1" },
  { range: "169.254.0.0/16", url: "https://169.254.255.255/v1" },
  { range: "172.16.0.0/12", url: "https://172.31.255.255/v1" },
  { range: "192.0.0.0/24", url: "https://192.0.0.255/v1" },
  { range: "192.0.2.0/24", url: "https://192.0.2.255/v1" },
  { range: "192.168.0.0/16", url: "https://192.168.255.255/v1" },
  { range: "198.18.0.0/15", url: "https://198.19.255.255/v1" },
  { range: "198.51.100.0/24", url: "https://198.51.100.255/v1" },
  { range: "203.0.113.0/24", url: "https://203.0.113.255/v1" },
  { range: "224.0.0.0/4", url: "https://239.255.255.255/v1" },
  { range: "240.0.0.0/4", url: "https://255.255.255.255/v1" },
  { range: "::/128", url: "https://[::]/v1" },
  { range: "::1/128", url: "https://[::1]/v1" },
  { range: "100::/64", url: "https://[100::ffff:ffff:ffff:ffff]/v1" },
  { range: "2001:db8::/32", url: "https://[2001:db8:ffff:ffff:ffff:ffff:ffff:ffff]/v1" },
  { range: "2001:10::/28", url: "https://[2001:1f:ffff:ffff:ffff:ffff:ffff:ffff]/v1" },
  { range: "fc00::/7", url: "https://[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]/v1" },
  { range: "fe80::/10", url: "https://[febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff]/v1" },
  { range: "ff00::/8", url: "https://[ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]/v1" }
] as const;

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

  it("normalizes canonical IPv4-mapped literals before allowlist matching and connection approval", async () => {
    const policy = createProviderNetworkPolicy({ allowlist: ["10.20.30.40"] });

    const destination = await policy.approve(new URL("http://[::ffff:10.20.30.40]:8080/v1"), "discovery");

    expect(destination).toMatchObject({
      origin: "http://10.20.30.40:8080",
      address: "10.20.30.40",
      family: 4,
      port: 8080,
      servername: "10.20.30.40"
    });
    expect(destination.url.hostname).toBe("10.20.30.40");
  });

  it("normalizes canonical IPv4-mapped DNS answers into IPv4 connection data", async () => {
    const policy = createProviderNetworkPolicy({
      allowlist: ["10.20.30.40"],
      resolver: resolverFor({
        "canonical-mapped.test": [{ address: "::ffff:a14:1e28", family: 6 }]
      })
    });

    await expect(policy.approve(new URL("http://canonical-mapped.test/v1"), "discovery"))
      .resolves.toMatchObject({ address: "10.20.30.40", family: 4, servername: "canonical-mapped.test" });
  });

  it("approves native public IPv6 answers and retains their connection family", async () => {
    const policy = createProviderNetworkPolicy({
      allowlist: [],
      resolver: resolverFor({
        "public-v6.test": [{ address: "2606:4700:4700::1111", family: 6 }]
      })
    });

    await expect(policy.approve(new URL("https://public-v6.test/v1"), "discovery"))
      .resolves.toMatchObject({ address: "2606:4700:4700::1111", family: 6 });
  });

  it("rejects native private IPv6 answers without an allowlist match", async () => {
    const policy = createProviderNetworkPolicy({
      allowlist: [],
      resolver: resolverFor({
        "private-v6.test": [{ address: "fd12:3456::1", family: 6 }]
      })
    });

    await expect(policy.approve(new URL("https://private-v6.test/v1"), "discovery"))
      .rejects.toMatchObject({ code: "PROVIDER_DESTINATION_NOT_ALLOWED", stage: "address" });
  });

  it("uses exact address entries to authorize a resolved private address", async () => {
    const policy = createProviderNetworkPolicy({
      allowlist: ["10.20.30.40"],
      resolver: resolverFor({
        "exact-address.test": [{ address: "10.20.30.40", family: 4 }]
      })
    });

    await expect(policy.approve(new URL("http://exact-address.test/v1"), "discovery"))
      .resolves.toMatchObject({ address: "10.20.30.40", family: 4 });
  });

  it.each([
    { label: "IPv4", allowlist: ["10.20.0.0/16"], allowed: "http://10.20.255.255/v1", denied: "https://10.21.0.0/v1" },
    { label: "IPv6", allowlist: ["fd00::/8"], allowed: "http://[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]/v1", denied: "https://[fc00::1]/v1" }
  ])("enforces $label CIDR boundaries", async ({ allowlist, allowed, denied }) => {
    const policy = createProviderNetworkPolicy({ allowlist });

    await expect(policy.approve(new URL(allowed), "discovery")).resolves.toBeDefined();
    await expect(policy.approve(new URL(denied), "discovery"))
      .rejects.toMatchObject({ code: "PROVIDER_DESTINATION_NOT_ALLOWED", stage: "address" });
  });

  it.each([
    { label: "IPv4", allowlist: "10.20.30.40", url: "http://10.20.30.40/v1", address: "10.20.30.40", family: 4 },
    { label: "IPv6", allowlist: "fd12::7", url: "http://[fd12::7]/v1", address: "fd12::7", family: 6 }
  ])("approves exact allowlisted $label literal IP endpoints without DNS", async ({ allowlist, url, address, family }) => {
    const literalResolver = vi.fn(async () => []);
    const policy = createProviderNetworkPolicy({ allowlist: [allowlist], resolver: literalResolver });

    await expect(policy.approve(new URL(url), "discovery"))
      .resolves.toMatchObject({ address, family });
    expect(literalResolver).not.toHaveBeenCalled();
  });

  it("selects the first approved DNS answer in resolver order", async () => {
    const policy = createProviderNetworkPolicy({
      allowlist: [],
      resolver: resolverFor({
        "multiple-public.test": [
          { address: "2606:4700:4700::1111", family: 6 },
          { address: "8.8.8.8", family: 4 }
        ]
      })
    });

    await expect(policy.approve(new URL("https://multiple-public.test/v1"), "discovery"))
      .resolves.toMatchObject({ address: "2606:4700:4700::1111", family: 6 });
  });

  it("requires every private DNS answer to match the allowlist", async () => {
    const policy = createProviderNetworkPolicy({
      allowlist: ["10.20.0.0/16"],
      resolver: resolverFor({
        "multiple-private.test": [
          { address: "10.20.30.40", family: 4 },
          { address: "10.21.30.40", family: 4 }
        ]
      })
    });

    await expect(policy.approve(new URL("https://multiple-private.test/v1"), "discovery"))
      .rejects.toMatchObject({ code: "PROVIDER_DESTINATION_NOT_ALLOWED", stage: "address" });
  });

  it.each(nonPublicBoundaryCases)("rejects the $range boundary literal", async ({ url }) => {
    const policy = createProviderNetworkPolicy({ allowlist: [] });

    await expect(policy.approve(new URL(url), "discovery"))
      .rejects.toMatchObject({ code: "PROVIDER_DESTINATION_NOT_ALLOWED", stage: "address" });
  });
});
