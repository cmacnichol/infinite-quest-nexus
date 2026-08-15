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
  it("installs the package-manager-pinned pnpm without relying on bundled Corepack", () => {
    const packageManifest = JSON.parse(readFileSync("package.json", "utf8")) as { packageManager?: string };
    const dockerfile = readFileSync("Dockerfile", "utf8");

    expect(packageManifest.packageManager).toBe("pnpm@11.18.0");
    expect(dockerfile).toContain("RUN npm install --global pnpm@11.18.0");
    expect(dockerfile).not.toContain("corepack enable");
  });

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

  it("retains the compiled contracts workspace package after production pruning", () => {
    const rootPackage = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const contractsPackage = JSON.parse(readFileSync("packages/contracts/package.json", "utf8")) as {
      exports?: Record<string, { default?: string; types?: string }>;
    };
    const dockerfile = readFileSync("Dockerfile", "utf8");

    expect(rootPackage.dependencies?.["@infinite-quest/contracts"]).toBe("workspace:*");
    expect(rootPackage.devDependencies?.["@infinite-quest/contracts"]).toBeUndefined();
    expect(contractsPackage.exports?.["."]).toEqual({
      types: "./src/index.ts",
      default: "./src/index.js"
    });
    expect(dockerfile).toContain("/app/packages/contracts/package.json ./packages/contracts/package.json");
    expect(dockerfile).toContain("/app/dist/packages/contracts/src ./packages/contracts/src");
  });

  it("provides durable asset and archive roots to every filesystem-consuming runtime role", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    const compose = serviceEnvironment(readFileSync("compose.yaml", "utf8"), "infinitequest-app");
    const stack = readFileSync("deploy/swarm/stack.yaml", "utf8");
    const api = serviceEnvironment(stack, "infinitequest-api");
    const worker = serviceEnvironment(stack, "infinitequest-worker");

    expect(dockerfile).toContain("ARCHIVE_STORAGE_ROOT=/var/lib/infinitequest/archives");
    expect(dockerfile).toContain("/var/lib/infinitequest/assets /var/lib/infinitequest/archives");
    for (const service of [compose, api, worker]) {
      expect(service).toContain("ASSET_STORAGE_ROOT: /var/lib/infinitequest/assets");
      expect(service).toContain("ARCHIVE_STORAGE_ROOT: /var/lib/infinitequest/archives");
      expect(service).toContain("target: /var/lib/infinitequest/archives");
    }
  });

  it("documents both built web roots in the example environment", () => {
    const environment = readFileSync(".env.example", "utf8");

    expect(environment).toContain("LEGACY_WEB_ROOT=/app/apps/web/dist");
    expect(environment).toContain("NEXT_WEB_ROOT=/app/apps/web-next/dist");
    expect(environment).not.toMatch(/^WEB_ROOT=/mu);
  });

  it.each([
    ["Compose combined app", "compose.yaml", "infinitequest-app", "12"],
    ["Swarm worker", "deploy/swarm/stack.yaml", "infinitequest-worker", "8"]
  ])("configures bounded generation concurrency and pool capacity for %s", (
    _name,
    path,
    service,
    defaultConnections
  ) => {
    const source = readFileSync(path, "utf8");
    const environment = serviceEnvironment(source, service);

    expect(environment).toContain("WORKER_GENERATION_CONCURRENCY: ${WORKER_GENERATION_CONCURRENCY:-1}");
    expect(environment).toContain(`DATABASE_MAX_CONNECTIONS: \${DATABASE_MAX_CONNECTIONS:-${defaultConnections}}`);
    expect(environment).toContain("stop_grace_period: 10m");
  });

  it("documents worker concurrency and role-safe pool capacity in the example environment", () => {
    const environment = readFileSync(".env.example", "utf8");

    expect(environment).toContain("WORKER_GENERATION_CONCURRENCY=1");
    expect(environment).toContain("DATABASE_MAX_CONNECTIONS=12");
  });

  it("bootstraps a persistent local credential key without changing the Swarm secret contract", () => {
    const compose = serviceEnvironment(readFileSync("compose.yaml", "utf8"), "infinitequest-app");
    const stack = readFileSync("deploy/swarm/stack.yaml", "utf8");
    const dockerfile = readFileSync("Dockerfile", "utf8");

    expect(compose).toContain("CREDENTIAL_ENCRYPTION_KEY_FILE: /var/lib/infinitequest/secrets/credential-encryption-key");
    expect(compose).toContain("node /app/scripts/ensure-local-credential-encryption-key.mjs");
    expect(compose).toContain("infinitequest-secrets:/var/lib/infinitequest/secrets");
    expect(dockerfile).toContain("/var/lib/infinitequest/secrets");
    expect(dockerfile).toContain("/app/scripts ./scripts");
    expect(stack).toContain("CREDENTIAL_ENCRYPTION_KEY_FILE: /run/secrets/infinitequest_credential_encryption_key");
    expect(stack).not.toContain("ensure-local-credential-encryption-key");
  });

  it("documents that local Compose generates the key once while production requires an operator secret", () => {
    const exampleEnvironment = readFileSync(".env.example", "utf8");
    const readme = readFileSync("README.md", "utf8");
    const composeGuide = readFileSync("docs/installation/docker-compose.md", "utf8");

    expect(exampleEnvironment).toContain("Local Docker Compose generates and persists this key on first start when left empty.");
    expect(readme).toContain("Docker Compose generates and persists a local credential-encryption key on its first start.");
    expect(composeGuide).toContain("Docker Compose generates and persists a local credential-encryption key on first start.");
  });
});
