import { createProviderNetworkPolicy, type ProviderNetworkResolver } from "../../packages/security/src/provider-network-policy.js";
import { configureDefaultProviderTransport, createProviderTransport } from "../../packages/story-engine/src/provider-transport.js";

const TEST_HOSTS = new Set(["embedding.test"]);

const integrationResolver: ProviderNetworkResolver = async (hostname) => {
  if (TEST_HOSTS.has(hostname.toLowerCase())) return [{ address: "127.0.0.1", family: 4 }];
  return [];
};

export function installIntegrationProviderTransport(allowlist = ["127.0.0.0/8"]) {
  const transport = createProviderTransport({
    policy: createProviderNetworkPolicy({ allowlist, resolver: integrationResolver }),
    fetcher: (input, init) => globalThis.fetch(input, init)
  });
  configureDefaultProviderTransport(transport);
  return transport;
}
