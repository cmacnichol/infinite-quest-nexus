import type { Dispatcher } from "undici";
import { describe, expect, it, vi } from "vitest";
import {
  ProviderDestinationNotAllowedError,
  type ApprovedProviderDestination,
  type ProviderNetworkPolicy
} from "../../packages/security/src/provider-network-policy.js";
import {
  createProviderTransport,
  type ProviderTransportProfile
} from "../../packages/story-engine/src/provider-transport.js";

const profile: ProviderTransportProfile = {
  providerType: "openai_compatible",
  baseUrl: "https://provider.test/v1",
  model: "test-model"
};

function approved(url: URL): ApprovedProviderDestination {
  return {
    url,
    origin: url.origin,
    address: "8.8.8.8",
    family: 4,
    port: 443,
    servername: url.hostname
  };
}

function approvingPolicy(): ProviderNetworkPolicy {
  return {
    approve: vi.fn(async (url: URL) => approved(url))
  };
}

describe("provider transport destination security", () => {
  it("pins the approved DNS address in the dispatcher lookup", async () => {
    const dispatcher = { dispatch: vi.fn(), close: vi.fn(), destroy: vi.fn() } as unknown as Dispatcher;
    const dispatcherFactory = vi.fn(() => dispatcher);
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init as RequestInit & { dispatcher?: Dispatcher }).dispatcher).toBe(dispatcher);
      expect(init?.redirect).toBe("manual");
      return new Response("{}", { status: 200 });
    });
    const policy: ProviderNetworkPolicy = {
      approve: vi.fn(async (url: URL) => ({
        ...approved(url),
        servername: "provider.test"
      }))
    };
    const transport = createProviderTransport({
      policy,
      fetcher,
      dispatcherFactory
    });

    await transport.fetch(profile, "model discovery", "https://provider.test/v1/models", {});

    expect(dispatcherFactory).toHaveBeenCalledWith(expect.objectContaining({
      origin: "https://provider.test",
      address: "8.8.8.8",
      family: 4,
      port: 443,
      servername: "provider.test"
    }));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects cross-origin redirects before forwarding authorization", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("redirect", {
        status: 307,
        headers: { location: "https://other.test/v1" }
      }));
    const policy = approvingPolicy();
    const transport = createProviderTransport({ policy, fetcher });

    await expect(transport.fetch(
      { ...profile, apiKey: "secret" },
      "story generation",
      "https://provider.test/v1/chat",
      { method: "POST", headers: { authorization: "Bearer secret" } }
    )).rejects.toMatchObject({
      code: "PROVIDER_DESTINATION_NOT_ALLOWED",
      stage: "redirect"
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(policy.approve).toHaveBeenCalledTimes(1);
  });

  it("revalidates same-origin redirects and preserves non-GET requests only for 307 and 308", async () => {
    const first = new Response("redirect", {
      status: 307,
      headers: { location: "/v1/resumed" }
    });
    const cancel = vi.spyOn(first.body!, "cancel");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const policy = approvingPolicy();
    const transport = createProviderTransport({ policy, fetcher });
    const init = {
      method: "POST",
      headers: { authorization: "Bearer same-origin-secret" },
      body: JSON.stringify({ prompt: "fiction" })
    };

    await transport.fetch(profile, "story generation", "https://provider.test/v1/chat", init);

    expect(policy.approve).toHaveBeenCalledTimes(2);
    expect(policy.approve).toHaveBeenNthCalledWith(
      2,
      new URL("https://provider.test/v1/resumed"),
      "story generation"
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "https://provider.test/v1/resumed",
      expect.objectContaining({
        method: "POST",
        body: init.body,
        redirect: "manual",
        headers: init.headers
      })
    );
  });

  it("uses the policy-normalized initial origin when checking redirects", async () => {
    const normalizedUrl = new URL("http://10.20.30.40:8080/v1");
    const policy: ProviderNetworkPolicy = {
      approve: vi.fn(async (url: URL) => ({
        url: url.hostname.includes("ffff") ? normalizedUrl : url,
        origin: url.hostname.includes("ffff") ? normalizedUrl.origin : url.origin,
        address: "10.20.30.40",
        family: 4 as const,
        port: 8080,
        servername: "10.20.30.40"
      }))
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("redirect", { status: 307, headers: { location: "/next" } }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const transport = createProviderTransport({ policy, fetcher });

    await transport.fetch(
      profile,
      "model discovery",
      "http://[::ffff:10.20.30.40]:8080/v1",
      { method: "GET" }
    );

    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "http://10.20.30.40:8080/next",
      expect.objectContaining({ redirect: "manual" })
    );
  });

  it("rejects non-GET 301, 302, and 303 redirects", async () => {
    for (const status of [301, 302, 303]) {
      const fetcher = vi.fn(async () => new Response("redirect", {
        status,
        headers: { location: "/not-followed" }
      }));
      const transport = createProviderTransport({ policy: approvingPolicy(), fetcher });

      await expect(transport.fetch(
        profile,
        "story generation",
        "https://provider.test/v1/chat",
        { method: "POST", body: "{}" }
      )).rejects.toBeInstanceOf(ProviderDestinationNotAllowedError);
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it("converts malformed redirect locations into the safe destination error", async () => {
    const fetcher = vi.fn(async () => new Response("redirect", {
      status: 307,
      headers: { location: "http://[" }
    }));
    const transport = createProviderTransport({ policy: approvingPolicy(), fetcher });

    await expect(transport.fetch(
      profile,
      "story generation",
      "https://provider.test/v1/chat",
      { method: "POST", body: "{}" }
    )).rejects.toMatchObject({
      code: "PROVIDER_DESTINATION_NOT_ALLOWED",
      stage: "redirect"
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("preserves GET and HEAD methods across 301, 302, and 303 redirects", async () => {
    for (const [status, method] of [[301, "GET"], [302, "HEAD"], [303, "GET"]] as const) {
      const fetcher = vi.fn()
        .mockResolvedValueOnce(new Response("redirect", { status, headers: { location: "/next" } }))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      const transport = createProviderTransport({ policy: approvingPolicy(), fetcher });

      await transport.fetch(profile, "model discovery", "https://provider.test/v1/models", { method });

      expect(fetcher).toHaveBeenNthCalledWith(2, "https://provider.test/next", expect.objectContaining({ method }));
    }
  });

  it("stops after three redirects", async () => {
    const fetcher = vi.fn(async () => new Response("redirect", {
      status: 308,
      headers: { location: "/again" }
    }));
    const transport = createProviderTransport({ policy: approvingPolicy(), fetcher });

    await expect(transport.fetch(
      profile,
      "story generation",
      "https://provider.test/start",
      { method: "POST", body: "{}" }
    )).rejects.toMatchObject({
      code: "PROVIDER_DESTINATION_NOT_ALLOWED",
      stage: "redirect"
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("caches pinned dispatchers per destination and closes them", async () => {
    const dispatcher = { dispatch: vi.fn(), close: vi.fn(), destroy: vi.fn() } as unknown as Dispatcher;
    const dispatcherFactory = vi.fn(() => dispatcher);
    const transport = createProviderTransport({
      policy: approvingPolicy(),
      fetcher: vi.fn(async () => new Response("{}", { status: 200 })),
      dispatcherFactory
    });

    await transport.fetch(profile, "model discovery", "https://provider.test/v1/models", {});
    await transport.fetch(profile, "story generation", "https://provider.test/v1/chat", {});
    await transport.close();

    expect(dispatcherFactory).toHaveBeenCalledOnce();
    expect(dispatcher.close).toHaveBeenCalledOnce();
  });

  it("allows SDK validation only for the official Sogni origin", async () => {
    const policy = approvingPolicy();
    const transport = createProviderTransport({ policy });
    const official = { ...profile, providerType: "sogni_sdk" as const, baseUrl: "https://api.sogni.ai/v1" };

    await expect(transport.validateSdkEndpoint(official)).resolves.toBeUndefined();
    await expect(transport.validateSdkEndpoint({
      ...official,
      baseUrl: "https://sogni-proxy.test"
    })).rejects.toMatchObject({
      code: "PROVIDER_DESTINATION_NOT_ALLOWED",
      stage: "url"
    });
    expect(policy.approve).toHaveBeenCalledOnce();
  });
});
