import type { Dispatcher } from "undici";
import { Agent } from "undici";
import {
  ProviderDestinationNotAllowedError,
  type ApprovedProviderDestination,
  type ProviderNetworkPolicy
} from "../../security/src/provider-network-policy.js";

export type ProviderTransportProfile = {
  providerType: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
};

export type ProviderTransport = {
  fetch(
    profile: ProviderTransportProfile,
    operation: string,
    url: string,
    init: RequestInit
  ): Promise<Response>;
  validateSdkEndpoint(profile: ProviderTransportProfile): Promise<void>;
  close(): Promise<void>;
};

export type ProviderDispatcherFactory = (destination: ApprovedProviderDestination) => Dispatcher;

export type CreateProviderTransportOptions = {
  policy: ProviderNetworkPolicy;
  fetcher?: typeof fetch;
  dispatcherFactory?: ProviderDispatcherFactory;
};

const MAX_REQUEST_TIMEOUT_MS = 3_600_000;
const MAX_REDIRECTS = 3;
const SOGNI_SDK_ORIGIN = "https://api.sogni.ai";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function pinnedAgent(destination: ApprovedProviderDestination): Agent {
  return new Agent({
    headersTimeout: MAX_REQUEST_TIMEOUT_MS,
    bodyTimeout: MAX_REQUEST_TIMEOUT_MS,
    connectTimeout: MAX_REQUEST_TIMEOUT_MS,
    connect: {
      servername: destination.servername,
      lookup(_hostname, _options, callback) {
        callback(null, destination.address, destination.family);
      }
    }
  });
}

function dispatcherKey(destination: ApprovedProviderDestination): string {
  return `${destination.origin}|${destination.address}|${destination.family}`;
}

function requestMethod(init: RequestInit): string {
  return String(init.method || "GET").toUpperCase();
}

function redirectPermitted(status: number, method: string): boolean {
  return status === 307 || status === 308 || method === "GET" || method === "HEAD";
}

export function createProviderTransport(options: CreateProviderTransportOptions): ProviderTransport {
  const fetcher = options.fetcher ?? fetch;
  const dispatcherFactory = options.dispatcherFactory ?? pinnedAgent;
  const dispatchers = new Map<string, Dispatcher>();

  function dispatcher(destination: ApprovedProviderDestination): Dispatcher {
    const key = dispatcherKey(destination);
    let existing = dispatchers.get(key);
    if (!existing) {
      existing = dispatcherFactory(destination);
      dispatchers.set(key, existing);
    }
    return existing;
  }

  return {
    async fetch(profile, operation, url, init) {
      let requestedUrl = new URL(url);
      let initialOrigin = "";
      const method = requestMethod(init);
      let redirectCount = 0;

      while (true) {
        const destination = await options.policy.approve(requestedUrl, operation);
        if (!initialOrigin) initialOrigin = destination.origin;
        const response = await fetcher(destination.url.toString(), {
          ...init,
          method,
          redirect: "manual",
          dispatcher: dispatcher(destination)
        } as RequestInit);
        const location = REDIRECT_STATUSES.has(response.status)
          ? response.headers.get("location")
          : null;
        if (!location) return response;

        await response.body?.cancel();
        if (!redirectPermitted(response.status, method) || redirectCount >= MAX_REDIRECTS) {
          throw new ProviderDestinationNotAllowedError("redirect");
        }

        let redirectUrl: URL;
        try {
          redirectUrl = new URL(location, destination.url);
        } catch {
          throw new ProviderDestinationNotAllowedError("redirect");
        }
        if (redirectUrl.origin !== initialOrigin) {
          throw new ProviderDestinationNotAllowedError("redirect");
        }

        redirectCount += 1;
        requestedUrl = redirectUrl;
      }
    },

    async validateSdkEndpoint(profile) {
      let url: URL;
      try {
        url = new URL(profile.baseUrl);
      } catch {
        throw new ProviderDestinationNotAllowedError("url");
      }
      if (url.origin !== SOGNI_SDK_ORIGIN) {
        throw new ProviderDestinationNotAllowedError("url");
      }
      const destination = await options.policy.approve(url, "Sogni SDK endpoint validation");
      if (destination.origin !== SOGNI_SDK_ORIGIN) {
        throw new ProviderDestinationNotAllowedError("url");
      }
    },

    async close() {
      const closing = [...dispatchers.values()].map((value) => value.close());
      dispatchers.clear();
      await Promise.all(closing);
    }
  };
}

let configuredDefaultTransport: ProviderTransport | null = null;

export function configureDefaultProviderTransport(transport: ProviderTransport): void {
  configuredDefaultTransport = transport;
}

export function defaultProviderTransport(): ProviderTransport {
  if (!configuredDefaultTransport) {
    throw new Error("The default provider transport has not been configured.");
  }
  return configuredDefaultTransport;
}
