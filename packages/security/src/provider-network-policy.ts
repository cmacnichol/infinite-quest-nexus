import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

type AddressFamily = 4 | 6;

export type ProviderNetworkResolver = (hostname: string) => Promise<Array<{
  address: string;
  family: AddressFamily;
}>>;

export type ApprovedProviderDestination = {
  url: URL;
  origin: string;
  address: string;
  family: AddressFamily;
  port: number;
  servername: string;
};

export type ProviderNetworkPolicy = {
  approve(url: URL, operation: string): Promise<ApprovedProviderDestination>;
};

export type CreateProviderNetworkPolicyOptions = {
  allowlist: readonly string[];
  resolver?: ProviderNetworkResolver;
};

export class ProviderDestinationNotAllowedError extends Error {
  readonly statusCode = 422;
  readonly code = "PROVIDER_DESTINATION_NOT_ALLOWED";
  readonly expose = true;
  readonly permanent = true;
  readonly retryable = false;

  constructor(readonly stage: "url" | "dns" | "address" | "redirect") {
    super("The provider destination is not allowed by the server network policy.");
    this.name = "ProviderDestinationNotAllowedError";
  }
}

const nonPublic = new BlockList();
for (const [network, prefix, family] of [
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
  ["100::", 64, "ipv6"],
  ["2001:db8::", 32, "ipv6"],
  ["2001:10::", 28, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"]
] as const) {
  nonPublic.addSubnet(network, prefix, family);
}

type ResolvedAddress = {
  address: string;
  family: AddressFamily;
};

type ParsedAllowlist = {
  hostnames: Set<string>;
  addresses: BlockList;
};

function addressFamilyName(family: AddressFamily): "ipv4" | "ipv6" {
  return family === 4 ? "ipv4" : "ipv6";
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function normalizeMappedIpv6(value: string): string | null {
  const mappedIpv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mappedIpv4) return mappedIpv4[1]!;
  if (isIP(value) !== 6) return null;

  const canonical = normalizeHostname(new URL(`http://[${value}]`).hostname);
  const mappedIpv4Hextets = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(canonical);
  if (!mappedIpv4Hextets) return null;

  const high = Number.parseInt(mappedIpv4Hextets[1]!, 16);
  const low = Number.parseInt(mappedIpv4Hextets[2]!, 16);
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function normalizeResolvedAddress(value: ResolvedAddress): ResolvedAddress {
  const mapped = normalizeMappedIpv6(value.address);
  return mapped ? { address: mapped, family: 4 } : value;
}

function parseAllowlist(entries: readonly string[]): ParsedAllowlist {
  const hostnames = new Set<string>();
  const addresses = new BlockList();

  for (const entry of entries) {
    const [address, prefixText, unexpectedSuffix] = entry.split("/");
    if (unexpectedSuffix !== undefined || !address) {
      throw new Error("Provider network allowlist contains an invalid entry.");
    }

    const family = isIP(address);
    if (!family) {
      if (prefixText !== undefined) throw new Error("Provider network allowlist contains an invalid entry.");
      hostnames.add(normalizeHostname(address));
      continue;
    }

    const normalizedFamily = family as AddressFamily;
    if (prefixText === undefined) {
      addresses.addAddress(address, addressFamilyName(normalizedFamily));
      continue;
    }

    const prefix = Number(prefixText);
    const maximumPrefix = normalizedFamily === 4 ? 32 : 128;
    if (!/^\d+$/.test(prefixText) || !Number.isInteger(prefix) || prefix > maximumPrefix) {
      throw new Error("Provider network allowlist contains an invalid entry.");
    }
    addresses.addSubnet(address, prefix, addressFamilyName(normalizedFamily));
  }

  return { hostnames, addresses };
}

const defaultResolver: ProviderNetworkResolver = (hostname) => lookup(hostname, {
  all: true,
  verbatim: true
}) as Promise<ResolvedAddress[]>;

function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function isAddressAllowed(address: ResolvedAddress, hostnameAllowed: boolean, allowlist: BlockList): boolean {
  const family = isIP(address.address);
  if (family !== address.family) return false;
  if (!nonPublic.check(address.address, addressFamilyName(address.family))) return true;
  return hostnameAllowed || allowlist.check(address.address, addressFamilyName(address.family));
}

export function createProviderNetworkPolicy(options: CreateProviderNetworkPolicyOptions): ProviderNetworkPolicy {
  const allowlist = parseAllowlist(options.allowlist);
  const resolver = options.resolver ?? defaultResolver;

  return {
    async approve(url: URL, _operation: string): Promise<ApprovedProviderDestination> {
      const normalizedUrl = new URL(url.toString());
      let hostname = normalizeHostname(normalizedUrl.hostname);
      if (!["http:", "https:"].includes(normalizedUrl.protocol)
        || normalizedUrl.username
        || normalizedUrl.password
        || normalizedUrl.hash) {
        throw new ProviderDestinationNotAllowedError("url");
      }

      const originalLiteralFamily = isIP(hostname);
      if (originalLiteralFamily) {
        const normalizedLiteral = normalizeResolvedAddress({
          address: hostname,
          family: originalLiteralFamily as AddressFamily
        });
        if (normalizedLiteral.family !== originalLiteralFamily) {
          normalizedUrl.hostname = normalizedLiteral.address;
          hostname = normalizedLiteral.address;
        }
      }

      const literalFamily = isIP(hostname);
      let answers: ResolvedAddress[];
      if (literalFamily) {
        answers = [{ address: hostname, family: literalFamily as AddressFamily }];
      } else {
        try {
          answers = await resolver(hostname);
        } catch {
          throw new ProviderDestinationNotAllowedError("dns");
        }
      }
      const resolved = answers.map(normalizeResolvedAddress);
      if (resolved.length === 0 || resolved.some((answer) => isIP(answer.address) !== answer.family)) {
        throw new ProviderDestinationNotAllowedError("dns");
      }

      const hostnameAllowed = allowlist.hostnames.has(hostname);
      if (!resolved.every((answer) => isAddressAllowed(answer, hostnameAllowed, allowlist.addresses))) {
        throw new ProviderDestinationNotAllowedError("address");
      }

      const includesPublic = resolved.some((answer) => !nonPublic.check(answer.address, addressFamilyName(answer.family)));
      const includesNonPublic = resolved.some((answer) => nonPublic.check(answer.address, addressFamilyName(answer.family)));
      if (includesPublic && includesNonPublic) {
        throw new ProviderDestinationNotAllowedError("address");
      }

      const selected = resolved[0]!;
      const selectedAddressAllowed = allowlist.addresses.check(selected.address, addressFamilyName(selected.family));
      if (normalizedUrl.protocol === "http:" && !hostnameAllowed && !selectedAddressAllowed) {
        throw new ProviderDestinationNotAllowedError("address");
      }

      return {
        url: normalizedUrl,
        origin: normalizedUrl.origin,
        address: selected.address,
        family: selected.family,
        port: effectivePort(normalizedUrl),
        servername: hostname
      };
    }
  };
}
