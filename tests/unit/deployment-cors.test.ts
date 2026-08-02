import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function serviceEnvironment(source: string, service: string): string {
  const serviceStart = source.indexOf(`  ${service}:`);
  expect(serviceStart, `${service} service`).toBeGreaterThanOrEqual(0);
  const remainder = source.slice(serviceStart + service.length + 3);
  const nextService = /\n  [a-zA-Z0-9_-]+:\n/.exec(remainder)?.index;
  return source.slice(serviceStart, nextService === undefined
    ? undefined
    : serviceStart + service.length + 3 + nextService);
}

describe("deployment security configuration", () => {
  it.each([
    ["Compose combined app", "compose.yaml", "infinitequest-app"],
    ["Swarm API", "deploy/swarm/stack.yaml", "infinitequest-api"]
  ])("forwards browser and provider network controls to the %s service", (_name, path, service) => {
    const environment = serviceEnvironment(readFileSync(path, "utf8"), service);

    expect(environment).toContain("CORS_ALLOWED_ORIGINS: ${CORS_ALLOWED_ORIGINS:-}");
    expect(environment).toContain("PROVIDER_NETWORK_ALLOWLIST: ${PROVIDER_NETWORK_ALLOWLIST:-}");
    expect(environment).toContain("CSP_IMAGE_ALLOWED_ORIGINS: ${CSP_IMAGE_ALLOWED_ORIGINS:-}");
  });

  it("forwards the provider network allowlist to Swarm workers", () => {
    const environment = serviceEnvironment(readFileSync("deploy/swarm/stack.yaml", "utf8"), "infinitequest-worker");

    expect(environment).toContain("PROVIDER_NETWORK_ALLOWLIST: ${PROVIDER_NETWORK_ALLOWLIST:-}");
  });

  it.each([
    ["Compose combined app", "compose.yaml", "infinitequest-app"],
    ["Swarm API", "deploy/swarm/stack.yaml", "infinitequest-api"]
  ])("uses the built legacy and replacement web roots in the %s service", (_name, path, service) => {
    const environment = serviceEnvironment(readFileSync(path, "utf8"), service);

    expect(environment).toContain("LEGACY_WEB_ROOT: /app/apps/web/dist");
    expect(environment).toContain("NEXT_WEB_ROOT: /app/apps/web-next/dist");
  });

  it("copies both built web roots into the runtime image", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");

    expect(dockerfile).toContain("COPY scripts ./scripts");
    expect(dockerfile).toContain("RUN CI=true pnpm prune --prod");
    expect(dockerfile).toContain("LEGACY_WEB_ROOT=/app/apps/web/dist");
    expect(dockerfile).toContain("NEXT_WEB_ROOT=/app/apps/web-next/dist");
    expect(dockerfile).toContain("/app/apps/web/dist ./apps/web/dist");
    expect(dockerfile).toContain("/app/apps/web-next/dist ./apps/web-next/dist");
  });

  it("documents both built web roots in the example environment", () => {
    const environment = readFileSync(".env.example", "utf8");

    expect(environment).toContain("LEGACY_WEB_ROOT=/app/apps/web/dist");
    expect(environment).toContain("NEXT_WEB_ROOT=/app/apps/web-next/dist");
    expect(environment).not.toMatch(/^WEB_ROOT=/mu);
  });
});
