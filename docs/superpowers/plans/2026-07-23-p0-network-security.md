# P0 Network Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Infinite Quest Nexus same-origin by default, constrain provider egress, enforce strict CSP and request limits, and coordinate expensive-route admission through PostgreSQL.

**Architecture:** Add pure security modules for exact origins, CSP, and provider destinations; integrate them through Fastify request hooks and the shared provider transport. Add owner-scoped admission buckets and expiring leases so all API replicas enforce the same limits. Preserve localhost providers by default and configure all other private destinations through environment variables.

**Tech Stack:** Node.js 22.13+, TypeScript 7, Fastify 5, PostgreSQL 18, node-pg-migrate, Undici 7, Vitest 4, vanilla HTML/CSS/JavaScript, Docker Compose, Docker Swarm

## Global Constraints

- Use **Infinite Quest Nexus** for the platform and **Infinite Quest** for the player-facing story experience.
- Preserve the database-backed `initial-owner`; browser-supplied identity is never authorization.
- Text and image providers remain independently configured and credentialed.
- API replicas remain stateless; cross-replica coordination uses PostgreSQL.
- Compose and Swarm use the same runtime configuration contract and application image.
- Use two-space indentation and TypeScript for new application services and shared packages.
- Validate every untrusted browser, provider, database, and model boundary.
- Never log credentials, private reasoning, prompt bodies, unnecessary story content, or complete provider URLs.
- Every changed file receives associated test review and behavior changes receive tests.
- Use test-driven development: observe each targeted test fail before adding its implementation.
- Run `git diff --check` and review the complete diff before every commit.

---

## File and interface map

### New shared security files

- `packages/security/src/exact-origins.ts` — parse exact browser origins and decide same-origin/configured-origin access.
- `packages/security/src/content-security-policy.ts` — build the enforced CSP header from validated image origins.
- `packages/security/src/provider-network-policy.ts` — classify addresses, parse hostname/IP/CIDR allowlist entries, resolve provider destinations, and produce pinned destinations.
- `packages/story-engine/src/provider-transport.ts` — perform bounded manual redirects through pinned Undici dispatchers.

### New API and database files

- `database/migrations/0040_api_admission_control.sql` — owner-scoped fixed-window buckets and expiring concurrency leases.
- `services/api/src/admission-service.ts` — transactional acquire/release and fail-closed errors.
- `services/api/src/request-security.ts` — Fastify origin, security-header, admission, and release hooks.

### New tests

- `tests/unit/security-config.test.ts`
- `tests/unit/request-security.test.ts`
- `tests/unit/provider-network-policy.test.ts`
- `tests/unit/provider-transport-security.test.ts`
- `tests/unit/csp-ui.test.ts`
- `tests/integration/admission-control.integration.test.ts`
- `tests/integration/network-security.integration.test.ts`

### Modified runtime files

- `packages/database/src/config.ts`
- `packages/database/src/index.ts`
- `packages/story-engine/src/providers.ts`
- `packages/story-engine/src/providers/illustration/sogni/index.ts`
- `packages/story-engine/src/providers/illustration/sogni-sdk/index.ts`
- `services/runtime/src/main.ts`
- `services/api/src/server.ts`

### Modified UI files

- `apps/web/public/index.html`
- `apps/web/public/nexus.css`
- `apps/web/public/story.html`
- `apps/web/public/story.js`
- `apps/web/public/story.css`
- `apps/web/public/story-print.css`

### Modified deployment and documentation files

- `.env.example`
- `compose.yaml`
- `deploy/swarm/stack.yaml`
- `docs/installation/environment-configuration.md`
- `docs/installation/network-access.md`
- `docs/installation/provider-configuration.md`
- `docs/operations/security.md`
- `docs/operations/swarm/secrets-and-configs.md`
- `README.md`

### Core interfaces

```ts
export type RuntimeSecurityConfig = {
  corsAllowedOrigins: string[];
  providerNetworkAllowlist: string[];
  cspImageAllowedOrigins: string[];
  apiDefaultBodyLimitBytes: number;
  apiImportBodyLimitBytes: number;
  apiAssetBodyLimitBytes: number;
  apiRateLimitWindowSeconds: number;
  apiRateLimitProviderRequests: number;
  apiRateLimitGenerationRequests: number;
  apiRateLimitImportRequests: number;
  apiConcurrencyProviderRequests: number;
  apiConcurrencyImportRequests: number;
  trustProxyHops: number;
};

export type ApprovedProviderDestination = {
  url: URL;
  origin: string;
  address: string;
  family: 4 | 6;
  port: number;
  servername: string;
};

export type ProviderNetworkPolicy = {
  approve(url: URL, operation: string): Promise<ApprovedProviderDestination>;
};

export type ProviderTransportOptions = {
  policy: ProviderNetworkPolicy;
  fetcher?: typeof fetch;
  dispatcherFactory?: (destination: ApprovedProviderDestination) => Dispatcher;
};

export type ProviderTransport = {
  fetch(
    profile: TextProviderProfile,
    operation: string,
    url: string,
    init: RequestInit
  ): Promise<Response>;
  validateSdkEndpoint(profile: TextProviderProfile): Promise<void>;
  close(): Promise<void>;
};

export type AdmissionPolicy = {
  key: "provider" | "generation" | "import";
  windowSeconds: number;
  maxRequests: number;
  maxConcurrent: number | null;
  leaseSeconds: number;
};

export type AdmissionDecision =
  | { allowed: true; leaseId: string | null; remaining: number; expiresAt: Date }
  | { allowed: false; retryAfterSeconds: number };
```

---

### Task 1: Strict runtime security configuration

**Files:**
- Create: `packages/security/src/exact-origins.ts`
- Create: `tests/unit/security-config.test.ts`
- Modify: `packages/database/src/config.ts`
- Modify: `packages/database/src/index.ts`
- Modify: `tests/unit/server-security.test.ts`
- Modify: `tests/unit/user-profile.test.ts`
- Modify: `tests/integration/dashboard-stats.integration.test.ts`
- Modify: `tests/integration/gameplay.integration.test.ts`

**Interfaces:**
- Produces: `parseExactOriginList(value: string | undefined, settingName: string): string[]`
- Produces: `parseProviderAllowlist(value: string | undefined): string[]`
- Produces: `RuntimeConfig.security: RuntimeSecurityConfig`
- Consumes later: Tasks 2, 4, 7, and 8 use `config.security`.

- [ ] **Step 1: Write failing configuration tests**

```ts
import { afterEach, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../packages/database/src/config.js";

const originalEnvironment = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnvironment };
});

function minimumEnvironment(): void {
  process.env.DATABASE_URL = "postgresql://test@localhost/test";
  delete process.env.CORS_ALLOWED_ORIGINS;
  delete process.env.PROVIDER_NETWORK_ALLOWLIST;
  delete process.env.CSP_IMAGE_ALLOWED_ORIGINS;
}

describe("runtime security configuration", () => {
  it("defaults browser access to same-origin and provider access to localhost", () => {
    minimumEnvironment();
    const config = loadRuntimeConfig();
    expect(config.security.corsAllowedOrigins).toEqual([]);
    expect(config.security.providerNetworkAllowlist).toEqual([
      "localhost",
      "127.0.0.0/8",
      "::1/128"
    ]);
    expect(config.security.cspImageAllowedOrigins).toEqual([]);
    expect(config.security.apiDefaultBodyLimitBytes).toBe(1_048_576);
    expect(config.security.trustProxyHops).toBe(0);
  });

  it("rejects wildcard and path-bearing origins", () => {
    minimumEnvironment();
    process.env.CORS_ALLOWED_ORIGINS = "*";
    expect(() => loadRuntimeConfig()).toThrow("CORS_ALLOWED_ORIGINS");
    process.env.CORS_ALLOWED_ORIGINS = "https://nexus.example/path";
    expect(() => loadRuntimeConfig()).toThrow("CORS_ALLOWED_ORIGINS");
  });

  it("extends localhost with configured provider destinations", () => {
    minimumEnvironment();
    process.env.PROVIDER_NETWORK_ALLOWLIST = "host.docker.internal,10.20.0.0/16";
    expect(loadRuntimeConfig().security.providerNetworkAllowlist).toEqual([
      "localhost",
      "127.0.0.0/8",
      "::1/128",
      "host.docker.internal",
      "10.20.0.0/16"
    ]);
  });

  it("fails instead of clamping invalid security limits", () => {
    minimumEnvironment();
    process.env.API_CONCURRENCY_IMPORT_REQUESTS = "0";
    expect(() => loadRuntimeConfig()).toThrow("API_CONCURRENCY_IMPORT_REQUESTS");
  });
});
```

- [ ] **Step 2: Run the focused test and confirm the missing security object**

Run:

```powershell
pnpm exec vitest run tests/unit/security-config.test.ts
```

Expected: FAIL because `RuntimeConfig.security` and strict parsing do not exist.

- [ ] **Step 3: Implement exact-origin and strict integer parsing**

```ts
// packages/security/src/exact-origins.ts
export function normalizeExactOrigin(value: string, settingName: string): string {
  if (value === "*") throw new Error(`${settingName} does not allow wildcard origins.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${settingName} contains an invalid origin '${value}'.`);
  }
  if (!["http:", "https:"].includes(url.protocol)
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash) {
    throw new Error(`${settingName} entries must be exact HTTP(S) origins without credentials, paths, queries, or fragments.`);
  }
  return url.origin;
}

export function parseExactOriginList(value: string | undefined, settingName: string): string[] {
  const entries = value?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
  return [...new Set(entries.map((entry) => normalizeExactOrigin(entry, settingName)))];
}
```

```ts
// packages/database/src/config.ts
export type RuntimeSecurityConfig = {
  corsAllowedOrigins: string[];
  providerNetworkAllowlist: string[];
  cspImageAllowedOrigins: string[];
  apiDefaultBodyLimitBytes: number;
  apiImportBodyLimitBytes: number;
  apiAssetBodyLimitBytes: number;
  apiRateLimitWindowSeconds: number;
  apiRateLimitProviderRequests: number;
  apiRateLimitGenerationRequests: number;
  apiRateLimitImportRequests: number;
  apiConcurrencyProviderRequests: number;
  apiConcurrencyImportRequests: number;
  trustProxyHops: number;
};

function requiredIntegerSetting(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

const BUILT_IN_PROVIDER_ALLOWLIST = ["localhost", "127.0.0.0/8", "::1/128"] as const;

function normalizeProviderAllowlistEntry(value: string): string {
  const entry = value.trim().toLowerCase();
  const [address, prefixText] = entry.split("/");
  if (prefixText !== undefined) {
    const family = isIP(address);
    const prefix = Number(prefixText);
    const maximum = family === 4 ? 32 : family === 6 ? 128 : -1;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > maximum) {
      throw new Error(`PROVIDER_NETWORK_ALLOWLIST contains an invalid CIDR '${value}'.`);
    }
    return `${address}/${prefix}`;
  }
  if (isIP(entry)) return entry;
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(entry)) {
    throw new Error(`PROVIDER_NETWORK_ALLOWLIST contains an invalid hostname '${value}'.`);
  }
  return entry;
}

function parseProviderAllowlist(value: string | undefined): string[] {
  const configured = value?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
  return [...new Set([...BUILT_IN_PROVIDER_ALLOWLIST, ...configured.map(normalizeProviderAllowlistEntry)])];
}
```

Import `isIP` from `node:net`. Add `security` to `RuntimeConfig`, remove the top-level `corsAllowedOrigins`, and construct:

```ts
security: {
  corsAllowedOrigins: parseExactOriginList(process.env.CORS_ALLOWED_ORIGINS, "CORS_ALLOWED_ORIGINS"),
  providerNetworkAllowlist: parseProviderAllowlist(process.env.PROVIDER_NETWORK_ALLOWLIST),
  cspImageAllowedOrigins: parseExactOriginList(process.env.CSP_IMAGE_ALLOWED_ORIGINS, "CSP_IMAGE_ALLOWED_ORIGINS"),
  apiDefaultBodyLimitBytes: requiredIntegerSetting("API_DEFAULT_BODY_LIMIT_BYTES", 1_048_576, 65_536, 67_108_864),
  apiImportBodyLimitBytes: requiredIntegerSetting("API_IMPORT_BODY_LIMIT_BYTES", 16_777_216, 1_048_576, 67_108_864),
  apiAssetBodyLimitBytes: requiredIntegerSetting("API_ASSET_BODY_LIMIT_BYTES", 33_554_432, 1_048_576, 67_108_864),
  apiRateLimitWindowSeconds: requiredIntegerSetting("API_RATE_LIMIT_WINDOW_SECONDS", 60, 1, 3_600),
  apiRateLimitProviderRequests: requiredIntegerSetting("API_RATE_LIMIT_PROVIDER_REQUESTS", 10, 1, 10_000),
  apiRateLimitGenerationRequests: requiredIntegerSetting("API_RATE_LIMIT_GENERATION_REQUESTS", 12, 1, 10_000),
  apiRateLimitImportRequests: requiredIntegerSetting("API_RATE_LIMIT_IMPORT_REQUESTS", 4, 1, 10_000),
  apiConcurrencyProviderRequests: requiredIntegerSetting("API_CONCURRENCY_PROVIDER_REQUESTS", 2, 1, 1_000),
  apiConcurrencyImportRequests: requiredIntegerSetting("API_CONCURRENCY_IMPORT_REQUESTS", 1, 1, 1_000),
  trustProxyHops: requiredIntegerSetting("TRUST_PROXY_HOPS", 0, 0, 16)
}
```

- [ ] **Step 4: Update test runtime configurations**

Replace each test fixture's `corsAllowedOrigins: ["*"]` with:

```ts
security: {
  corsAllowedOrigins: [],
  providerNetworkAllowlist: ["localhost", "127.0.0.0/8", "::1/128"],
  cspImageAllowedOrigins: [],
  apiDefaultBodyLimitBytes: 1_048_576,
  apiImportBodyLimitBytes: 16_777_216,
  apiAssetBodyLimitBytes: 33_554_432,
  apiRateLimitWindowSeconds: 60,
  apiRateLimitProviderRequests: 10,
  apiRateLimitGenerationRequests: 12,
  apiRateLimitImportRequests: 4,
  apiConcurrencyProviderRequests: 2,
  apiConcurrencyImportRequests: 1,
  trustProxyHops: 0
}
```

- [ ] **Step 5: Run configuration and type tests**

Run:

```powershell
pnpm exec vitest run tests/unit/security-config.test.ts tests/unit/server-security.test.ts tests/unit/user-profile.test.ts
pnpm check
```

Expected: PASS.

- [ ] **Step 6: Commit the configuration contract**

```powershell
git add packages/security/src/exact-origins.ts packages/database/src/config.ts packages/database/src/index.ts tests/unit/security-config.test.ts tests/unit/server-security.test.ts tests/unit/user-profile.test.ts tests/integration/dashboard-stats.integration.test.ts tests/integration/gameplay.integration.test.ts
git diff --cached --check
git commit -m "Harden runtime security configuration"
```

---

### Task 2: Browser origin gate and enforced security headers

**Files:**
- Create: `packages/security/src/content-security-policy.ts`
- Create: `services/api/src/request-security.ts`
- Create: `tests/unit/request-security.test.ts`
- Modify: `services/api/src/server.ts`
- Modify: `tests/unit/server-security.test.ts`

**Interfaces:**
- Consumes: `RuntimeConfig.security` from Task 1.
- Produces: `evaluateRequestOrigin(origin, effectiveOrigin, allowedOrigins): OriginDecision`
- Produces: `buildContentSecurityPolicy(imageOrigins): string`
- Produces: `installRequestSecurity(app, config): void`

- [ ] **Step 1: Replace permissive security expectations with failing exact-origin tests**

```ts
it("allows origin-less and exact same-origin requests", async () => {
  const app = await buildServer({ config: makeConfig(), pool: mockPool });
  expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
  const sameOrigin = await app.inject({
    method: "GET",
    url: "/health/live",
    headers: { host: "localhost:8080", origin: "http://localhost:8080" }
  });
  expect(sameOrigin.statusCode).toBe(200);
  expect(sameOrigin.headers["access-control-allow-origin"]).toBe("http://localhost:8080");
  expect(sameOrigin.headers["access-control-allow-credentials"]).toBeUndefined();
});

it("rejects hostile origins and hostile preflights", async () => {
  const app = await buildServer({ config: makeConfig(), pool: mockPool });
  for (const method of ["GET", "OPTIONS"] as const) {
    const response = await app.inject({
      method,
      url: "/health/live",
      headers: { host: "nexus.test", origin: "https://evil.test" }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "OriginNotAllowedError" });
  }
});

it("rejects DNS-rebinding requests whose hostile Origin matches a hostile Host", async () => {
  const app = await buildServer({ config: makeConfig(), pool: mockPool });
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/providers/discover-models",
    headers: { host: "evil.test", origin: "http://evil.test", "content-type": "application/json" },
    payload: {}
  });
  expect(response.statusCode).toBe(403);
});

it("sends the enforced CSP without unsafe-inline", async () => {
  const app = await buildServer({ config: makeConfig(), pool: mockPool });
  const response = await app.inject({ method: "GET", url: "/health/live" });
  expect(response.headers["content-security-policy"]).toBe(
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  );
  expect(response.headers["strict-transport-security"]).toBeUndefined();
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
});

it("adds only validated external image origins to CSP", () => {
  expect(buildContentSecurityPolicy(["https://images.example"])).toContain(
    "img-src 'self' data: blob: https://images.example"
  );
  expect(buildContentSecurityPolicy(["https://images.example"])).not.toContain("connect-src https://images.example");
});

it("sends HSTS only for direct or explicitly trusted HTTPS", async () => {
  const directHttp = await buildServer({ config: makeConfig(), pool: mockPool });
  expect((await directHttp.inject({ method: "GET", url: "/health/live" })).headers["strict-transport-security"]).toBeUndefined();
  await directHttp.close();

  const proxied = await buildServer({
    config: makeConfig({ security: { ...makeConfig().security, trustProxyHops: 1 } }),
    pool: mockPool
  });
  const response = await proxied.inject({
    method: "GET",
    url: "/health/live",
    headers: { "x-forwarded-proto": "https", host: "localhost:8080" }
  });
  expect(response.headers["strict-transport-security"]).toContain("max-age=31536000");
  await proxied.close();
});
```

- [ ] **Step 2: Run the focused server tests and observe the hostile origin succeed**

Run:

```powershell
pnpm exec vitest run tests/unit/server-security.test.ts tests/unit/request-security.test.ts
```

Expected: FAIL because hostile origins currently reach handlers and CSP contains `unsafe-inline`.

- [ ] **Step 3: Implement origin decisions and CSP construction**

```ts
// packages/security/src/exact-origins.ts
export type OriginDecision =
  | { allowed: true; responseOrigin: string | null }
  | { allowed: false };

export function evaluateRequestOrigin(
  requestOrigin: string | undefined,
  effectiveOrigin: string,
  allowedOrigins: readonly string[]
): OriginDecision {
  if (!requestOrigin) return { allowed: true, responseOrigin: null };
  let normalized: string;
  try {
    normalized = normalizeExactOrigin(requestOrigin, "Origin");
  } catch {
    return { allowed: false };
  }
  const effective = new URL(effectiveOrigin);
  const localSameOrigin = normalized === effective.origin
    && (effective.hostname === "localhost"
      || effective.hostname === "127.0.0.1"
      || effective.hostname === "[::1]");
  if (localSameOrigin || allowedOrigins.includes(normalized)) {
    return { allowed: true, responseOrigin: normalized };
  }
  return { allowed: false };
}
```

Only localhost/loopback receives implicit same-origin treatment. Every LAN or public browser origin must appear exactly in `CORS_ALLOWED_ORIGINS`; this prevents a DNS-rebinding attacker from making an arbitrary hostile `Origin` appear valid merely by sending the same value in `Host`.

```ts
// packages/security/src/content-security-policy.ts
export function buildContentSecurityPolicy(imageOrigins: readonly string[]): string {
  const imgSources = ["'self'", "data:", "blob:", ...imageOrigins];
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `img-src ${imgSources.join(" ")}`,
    "connect-src 'self'",
    "font-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'"
  ].join("; ");
}
```

- [ ] **Step 4: Install the Fastify request-security hook**

```ts
// services/api/src/request-security.ts
export class OriginNotAllowedError extends Error {
  readonly statusCode = 403;
  readonly code = "ORIGIN_NOT_ALLOWED";
  constructor() {
    super("The browser origin is not allowed.");
    this.name = "OriginNotAllowedError";
  }
}

export function installRequestSecurity(app: FastifyInstance, config: RuntimeConfig): void {
  const csp = buildContentSecurityPolicy(config.security.cspImageAllowedOrigins);
  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    reply.header("Content-Security-Policy", csp);
    if (request.protocol === "https") {
      reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    if (request.url.startsWith("/api/v1/")) reply.header("Cache-Control", "no-store");

    const host = request.headers.host;
    if (!host) throw new OriginNotAllowedError();
    const decision = evaluateRequestOrigin(
      request.headers.origin,
      new URL(`${request.protocol}://${host}`).origin,
      config.security.corsAllowedOrigins
    );
    if (!decision.allowed) throw new OriginNotAllowedError();
    if (decision.responseOrigin) {
      reply.header("Access-Control-Allow-Origin", decision.responseOrigin);
      reply.header("Vary", "Origin");
      reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Correlation-Id");
    }
  });
}
```

Set Fastify `trustProxy` from `config.security.trustProxyHops`, set the global `bodyLimit` from `apiDefaultBodyLimitBytes`, call `installRequestSecurity`, and retain `app.options("*")` only after the origin hook.

Preserve typed security codes in the API envelope:

```ts
function errorDetails(error: unknown): { name: string; message: string; code?: string; issues?: unknown; details?: unknown } {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
    const issues = "issues" in error ? (error as Error & { issues?: unknown }).issues : undefined;
    const details = "details" in error ? (error as Error & { details?: unknown }).details : undefined;
    return {
      name: error.name || "Error",
      message: error.message,
      ...(code ? { code } : {}),
      ...(issues === undefined ? {} : { issues }),
      ...(details === undefined ? {} : { details })
    };
  }
  return { name: "Error", message: String(error) };
}
```

- [ ] **Step 5: Run focused and full unit validation**

Run:

```powershell
pnpm exec vitest run tests/unit/request-security.test.ts tests/unit/server-security.test.ts
pnpm test:unit
pnpm check
```

Expected: PASS.

- [ ] **Step 6: Commit the browser boundary**

```powershell
git add packages/security/src/exact-origins.ts packages/security/src/content-security-policy.ts services/api/src/request-security.ts services/api/src/server.ts tests/unit/request-security.test.ts tests/unit/server-security.test.ts
git diff --cached --check
git commit -m "Enforce the browser request boundary"
```

---

### Task 3: Remove active inline UI constructs

**Files:**
- Create: `apps/web/public/story-print.css`
- Create: `tests/unit/csp-ui.test.ts`
- Modify: `apps/web/public/index.html`
- Modify: `apps/web/public/nexus.css`
- Modify: `apps/web/public/story.html`
- Modify: `apps/web/public/story.js`
- Modify: `apps/web/public/story.css`
- Modify: `tests/unit/story-player-ui.test.ts`
- Modify: `tests/unit/management-ui.test.ts`

**Interfaces:**
- Consumes: strict `style-src 'self'` and `script-src 'self'` from Task 2.
- Produces: active HTML/JS with no inline style attributes, event handlers, or generated style blocks.

- [ ] **Step 1: Add a failing source-level CSP compatibility test**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const activeFiles = [
  "apps/web/public/index.html",
  "apps/web/public/story.html",
  "apps/web/public/nexus.js",
  "apps/web/public/story.js"
];

describe("active UI CSP compatibility", () => {
  it("contains no inline styles, event handlers, or generated style blocks", () => {
    for (const file of activeFiles) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/\sstyle\s*=/i);
      expect(source, file).not.toMatch(/\son[a-z]+\s*=/i);
      expect(source, file).not.toMatch(/<style\b/i);
      expect(source, file).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    }
  });
});
```

- [ ] **Step 2: Run the CSP UI test and confirm it reports the 28 styles and one handler**

Run:

```powershell
pnpm exec vitest run tests/unit/csp-ui.test.ts
```

Expected: FAIL on `style=`, `onclick=`, and the generated print `<style>`.

- [ ] **Step 3: Replace static inline styles with semantic classes**

Add these rules to the existing CSS files and use the class names in HTML and generated markup:

```css
/* nexus.css */
.provider-dialog-heading { padding: 24px 24px 0; }

/* story.css */
.preserve-whitespace { white-space: pre-wrap; }
.story-empty-icon { margin-bottom: 10px; font-size: 3rem; }
.story-empty-title { margin: 0 0 8px; color: #fff; }
.story-empty-copy { max-width: 620px; margin: 0 auto; line-height: 1.55; }
.story-empty-character { max-width: 620px; margin: 4px auto; line-height: 1.55; }
.story-empty-character strong { color: var(--gold); }
.story-empty-guidance { max-width: 620px; margin: 8px auto 0; color: var(--dim); line-height: 1.55; }
.dialog-actions-spaced { margin-top: 6px; }
.turn-history-state-panel { margin-top: 12px; }
.retry-prompt-editor { min-height: 140px; }
.action-tag-event { border-color: rgba(116,228,255,.3); color: var(--accent2); }
.setup-stat-label { color: var(--text-heading); font-weight: 600; }
.setup-stat-note { grid-column: span 2; }
```

Replace the provider button with:

```html
<a id="btnGettingConfigureProviders" class="buttonish accent grow" href="/nexus/">Open Provider Management in Nexus</a>
```

- [ ] **Step 4: Replace the dynamic bar with semantic progress**

```js
progressEl.innerHTML = `
  <div class="turn-progress-head">
    <strong>${escapeHtml(currentStep.label)}</strong>
    <span class="turn-progress-step">Step ${currentIndex + 1} of ${steps.length}</span>
  </div>
  <progress class="turn-progress-meter" max="100" value="${percent}" aria-label="${escapeHtml(currentStep.label)}">${percent}%</progress>
  <div class="turn-progress-detail">${escapeHtml(detailText)}</div>
`;
```

```css
.turn-progress-meter { width: 100%; height: 4px; margin: 8px 0; accent-color: var(--accent); }
```

Remove `.turn-progress-track` and `.turn-progress-fill` after confirming they have no other caller.

- [ ] **Step 5: Move print rules to a served stylesheet**

Create `story-print.css` with the exact rules currently embedded in `story.js`. Change generated markup to:

```js
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="stylesheet" href="/nexus/story-print.css"></head><body><h1>${title}</h1>${turns || "<p>No accepted story turns are available yet.</p>"}</body></html>`;
```

- [ ] **Step 6: Update UI contract tests and run them**

Assert the provider navigation is an anchor, the progress element has `max` and `value`, and the print document links `story-print.css`.

Run:

```powershell
pnpm exec vitest run tests/unit/csp-ui.test.ts tests/unit/story-player-ui.test.ts tests/unit/management-ui.test.ts
node --check apps/web/public/nexus.js
node --check apps/web/public/story.js
```

Expected: PASS.

- [ ] **Step 7: Commit CSP-compatible UI**

```powershell
git add apps/web/public/index.html apps/web/public/nexus.css apps/web/public/story.html apps/web/public/story.js apps/web/public/story.css apps/web/public/story-print.css tests/unit/csp-ui.test.ts tests/unit/story-player-ui.test.ts tests/unit/management-ui.test.ts
git diff --cached --check
git commit -m "Make the active UI strict-CSP compatible"
```

---

### Task 4: Provider destination classification and DNS approval

**Files:**
- Create: `packages/security/src/provider-network-policy.ts`
- Create: `tests/unit/provider-network-policy.test.ts`

**Interfaces:**
- Consumes: normalized `providerNetworkAllowlist` from Task 1.
- Produces: `createProviderNetworkPolicy(options): ProviderNetworkPolicy`
- Produces: `approve(url, operation): Promise<ApprovedProviderDestination>`
- Produces: `ProviderDestinationNotAllowedError` with status 422 and code `PROVIDER_DESTINATION_NOT_ALLOWED`.
- Consumed by: Task 5 provider transport.

- [ ] **Step 1: Write failing policy tests with an injected DNS resolver**

```ts
const resolver = vi.fn(async (hostname: string) => {
  const records: Record<string, Array<{ address: string; family: 4 | 6 }>> = {
    "localhost": [{ address: "127.0.0.1", family: 4 }],
    "public.test": [{ address: "8.8.8.8", family: 4 }],
    "private.test": [{ address: "10.20.30.40", family: 4 }],
    "mixed.test": [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 }
    ]
  };
  return records[hostname] ?? [];
});

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
});

it("rejects public HTTP, mixed answers, metadata, and private destinations", async () => {
  const policy = createProviderNetworkPolicy({ allowlist: ["localhost", "127.0.0.0/8", "::1/128"], resolver });
  await expect(policy.approve(new URL("http://public.test/v1"), "discovery")).rejects.toMatchObject({ code: "PROVIDER_DESTINATION_NOT_ALLOWED" });
  await expect(policy.approve(new URL("https://mixed.test/v1"), "discovery")).rejects.toMatchObject({ code: "PROVIDER_DESTINATION_NOT_ALLOWED" });
  await expect(policy.approve(new URL("http://169.254.169.254/latest/meta-data"), "discovery")).rejects.toMatchObject({ code: "PROVIDER_DESTINATION_NOT_ALLOWED" });
  await expect(policy.approve(new URL("http://10.1.2.3/v1"), "discovery")).rejects.toMatchObject({ code: "PROVIDER_DESTINATION_NOT_ALLOWED" });
});
```

- [ ] **Step 2: Run the policy test and confirm the module is absent**

Run:

```powershell
pnpm exec vitest run tests/unit/provider-network-policy.test.ts
```

Expected: FAIL because `provider-network-policy.ts` does not exist.

- [ ] **Step 3: Implement address and allowlist classification with Node BlockList**

```ts
import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";

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
```

Normalize IPv4-mapped IPv6 answers before checking:

```ts
function normalizeResolvedAddress(value: { address: string; family: 4 | 6 }): { address: string; family: 4 | 6 } {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value.address);
  return mapped ? { address: mapped[1]!, family: 4 } : value;
}
```

Parse IP/CIDR entries into an allowlist `BlockList`; exact hostname entries match only the normalized hostname. Resolve with:

```ts
const defaultResolver = (hostname: string) => lookup(hostname, { all: true, verbatim: true }) as Promise<Array<{ address: string; family: 4 | 6 }>>;
```

Require all DNS answers to pass. Pick the first approved answer deterministically after preserving resolver order. For literal IP hosts, skip DNS but run the same classification.

At the start of `approve`, normalize and reject ambiguous URLs:

```ts
const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
if (!["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.hash) {
  throw new ProviderDestinationNotAllowedError("url");
}
```

After address approval, reject `http:` unless the exact hostname or selected address matched the configured allowlist. Public destinations therefore require HTTPS.

- [ ] **Step 4: Implement approved destination and safe errors**

```ts
export class ProviderDestinationNotAllowedError extends Error {
  readonly statusCode = 422;
  readonly code = "PROVIDER_DESTINATION_NOT_ALLOWED";
  readonly expose = true;
  constructor(readonly stage: "url" | "dns" | "address" | "redirect") {
    super("The provider destination is not allowed by the server network policy.");
    this.name = "ProviderDestinationNotAllowedError";
  }
}
```

The returned `ApprovedProviderDestination` retains only the normalized URL, origin, selected address/family, port, and TLS server name. Do not attach the complete allowlist or DNS answer set to the error.

- [ ] **Step 5: Run policy tests and type checking**

Run:

```powershell
pnpm exec vitest run tests/unit/provider-network-policy.test.ts
pnpm check
```

Expected: PASS.

- [ ] **Step 6: Commit destination policy**

```powershell
git add packages/security/src/provider-network-policy.ts tests/unit/provider-network-policy.test.ts
git diff --cached --check
git commit -m "Restrict provider network destinations"
```

---

### Task 5: Pinned provider transport and adapter integration

**Files:**
- Create: `packages/story-engine/src/provider-transport.ts`
- Create: `tests/unit/provider-transport-security.test.ts`
- Modify: `packages/story-engine/src/providers.ts`
- Modify: `packages/story-engine/src/providers/illustration/sogni/index.ts`
- Modify: `packages/story-engine/src/providers/illustration/sogni-sdk/index.ts`
- Modify: `services/runtime/src/main.ts`
- Modify: `tests/unit/providers.test.ts`
- Modify: `tests/unit/sogni-sdk-provider.test.ts`

**Interfaces:**
- Consumes: `ProviderNetworkPolicy` from Task 4 and runtime allowlist from Task 1.
- Produces: `createProviderTransport(options): ProviderTransport`
- Produces: `configureDefaultProviderTransport(transport): void`
- Provider functions accept `transport: ProviderTransport = defaultProviderTransport()`.

- [ ] **Step 1: Write failing transport tests**

```ts
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
      url,
      origin: url.origin,
      address: "8.8.8.8",
      family: 4,
      port: 443,
      servername: "provider.test"
    }))
  };
  const transport = createProviderTransport({
    policy,
    fetcher,
    dispatcherFactory
  });
  await transport.fetch(profile, "model discovery", "https://provider.test/v1/models", {});
  expect(dispatcherFactory).toHaveBeenCalledWith(expect.objectContaining({ address: "8.8.8.8", family: 4 }));
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("rejects cross-origin redirects before forwarding authorization", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "https://other.test/v1" } }));
  const policy: ProviderNetworkPolicy = {
    approve: vi.fn(async (url: URL) => ({
      url,
      origin: url.origin,
      address: "8.8.8.8",
      family: 4,
      port: 443,
      servername: url.hostname
    }))
  };
  const transport = createProviderTransport({ policy, fetcher });
  await expect(transport.fetch(
    { ...profile, apiKey: "secret" },
    "story generation",
    "https://provider.test/v1/chat",
    { method: "POST", headers: { authorization: "Bearer secret" } }
  )).rejects.toMatchObject({ code: "PROVIDER_DESTINATION_NOT_ALLOWED" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run the transport test and observe the missing module**

Run:

```powershell
pnpm exec vitest run tests/unit/provider-transport-security.test.ts
```

Expected: FAIL because the secure provider transport does not exist.

- [ ] **Step 3: Implement pinned Undici dispatchers and manual redirects**

```ts
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
```

`ProviderTransport.fetch` must:

1. call `policy.approve`;
2. issue `fetch` with `redirect: "manual"` and the pinned dispatcher;
3. return non-redirect responses unchanged;
4. resolve at most three same-origin redirects;
5. cancel the previous response body before following;
6. preserve GET/HEAD for 301/302/303;
7. permit non-GET redirects only for 307/308;
8. reject every cross-origin redirect before a second request;
9. reuse cached agents keyed by origin/address/family and close them during runtime shutdown.

- [ ] **Step 4: Route provider adapters through the transport**

Change provider signatures from raw `Fetch` injection to `ProviderTransport` injection:

```ts
export async function callTextProvider(
  profile: TextProviderProfile,
  request: ProviderRequest,
  transport: ProviderTransport = defaultProviderTransport()
): Promise<ProviderResult>
```

Apply the same last parameter to embedding, discovery, image submit/poll/cancel, and model-loading functions. Pass:

```ts
const fetcher: typeof fetch = (url, init) => transport.fetch(profile, operation, String(url), init || {});
```

to the Sogni REST adapter.

The Sogni SDK does not expose a custom DNS dispatcher for all of its HTTP/socket operations. In `submitImageProvider`, `pollImageProvider`, `cancelImageProvider`, and `discoverImageModels`, call `transport.validateSdkEndpoint(profile)` before dispatching to the SDK adapter. In the SDK adapter's `session` function, enforce the same origin again before creating or reusing a client:

```ts
const SOGNI_SDK_ORIGIN = "https://api.sogni.ai";
if (new URL(profile.baseUrl).origin !== SOGNI_SDK_ORIGIN) {
  throw new ProviderDestinationNotAllowedError("url");
}
await transport.validateSdkEndpoint(profile);
```

The adapter-level check omits the final line because `session` does not receive a transport. This allows only the official public SDK origin; configurable Sogni REST continues through the fully pinned transport.

- [ ] **Step 5: Configure and close the default transport in runtime**

```ts
const providerTransport = createProviderTransport({
  policy: createProviderNetworkPolicy({ allowlist: config.security.providerNetworkAllowlist })
});
configureDefaultProviderTransport(providerTransport);
```

Create it before migration/API/worker role dispatch. In `finally`, close it before closing the database pool:

```ts
await providerTransport.close();
await pool.end();
```

- [ ] **Step 6: Update provider tests to inject a test transport**

Replace raw `fetcher as typeof fetch` arguments with:

```ts
const transport = createTestProviderTransport(fetcher);
await callTextProvider(profile, request, transport);
```

The helper uses a deterministic fake policy and never performs real DNS. Add assertions that transport errors still redact tokens and preserve timeout diagnostics.

- [ ] **Step 7: Run provider validation**

Run:

```powershell
pnpm exec vitest run tests/unit/provider-network-policy.test.ts tests/unit/provider-transport-security.test.ts tests/unit/providers.test.ts tests/unit/sogni-sdk-provider.test.ts
pnpm check
```

Expected: PASS.

- [ ] **Step 8: Commit secure provider transport**

```powershell
git add packages/story-engine/src/provider-transport.ts packages/story-engine/src/providers.ts packages/story-engine/src/providers/illustration/sogni/index.ts packages/story-engine/src/providers/illustration/sogni-sdk/index.ts packages/security/src/provider-network-policy.ts services/runtime/src/main.ts tests/unit/provider-transport-security.test.ts tests/unit/providers.test.ts tests/unit/sogni-sdk-provider.test.ts
git diff --cached --check
git commit -m "Pin outbound provider connections"
```

---

### Task 6: PostgreSQL admission schema and transactional service

**Files:**
- Create: `database/migrations/0040_api_admission_control.sql`
- Create: `services/api/src/admission-service.ts`
- Create: `tests/integration/admission-control.integration.test.ts`
- Modify: `tests/integration/migrations.integration.test.ts`

**Interfaces:**
- Produces: `acquireAdmission(pool, ownerUserId, requestId, policy, now?): Promise<AdmissionDecision>`
- Produces: `releaseAdmission(pool, leaseId): Promise<void>`
- Produces: `AdmissionControlUnavailableError`
- Consumed by: Task 7 request hooks.

- [ ] **Step 1: Write failing migration and two-replica admission tests**

```ts
it("coordinates rate and concurrency limits through PostgreSQL", async () => {
  const secondPool = createDatabasePool(process.env.TEST_DATABASE_URL!, 2);
  const ownerUserId = await initialOwnerId(pool);
  const policy: AdmissionPolicy = {
    key: "provider",
    windowSeconds: 60,
    maxRequests: 2,
    maxConcurrent: 1,
    leaseSeconds: 30
  };
  const first = await acquireAdmission(pool, ownerUserId, "request-1", policy, new Date("2026-07-23T12:00:00Z"));
  expect(first).toMatchObject({ allowed: true, remaining: 1 });

  const concurrent = await acquireAdmission(secondPool, ownerUserId, "request-2", policy, new Date("2026-07-23T12:00:01Z"));
  expect(concurrent).toMatchObject({ allowed: false });

  if (first.allowed && first.leaseId) await releaseAdmission(pool, first.leaseId);
  const second = await acquireAdmission(secondPool, ownerUserId, "request-2", policy, new Date("2026-07-23T12:00:02Z"));
  expect(second).toMatchObject({ allowed: true, remaining: 0 });

  if (second.allowed && second.leaseId) await releaseAdmission(secondPool, second.leaseId);
  const exhausted = await acquireAdmission(pool, ownerUserId, "request-3", policy, new Date("2026-07-23T12:00:03Z"));
  expect(exhausted).toMatchObject({ allowed: false });
  await secondPool.end();
});
```

Add tests for idempotent release, duplicate request IDs, expired-lease recovery, window rollover, rate-only generation policies, and absence of IP/story/provider data in both tables.

- [ ] **Step 2: Run the integration test and observe missing relations**

Run with `TEST_DATABASE_URL` set:

```powershell
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/admission-control.integration.test.ts
```

Expected: FAIL because migration 0040 and admission service do not exist.

- [ ] **Step 3: Add the online migration**

```sql
CREATE TABLE api_admission_buckets (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (char_length(operation) BETWEEN 1 AND 100),
  window_started_at timestamptz NOT NULL,
  window_expires_at timestamptz NOT NULL,
  accepted_count integer NOT NULL CHECK (accepted_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, operation, window_started_at),
  CHECK (window_expires_at > window_started_at)
);

CREATE INDEX api_admission_buckets_expiry_idx
  ON api_admission_buckets (window_expires_at);

CREATE TABLE api_admission_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (char_length(operation) BETWEEN 1 AND 100),
  request_id text NOT NULL CHECK (char_length(request_id) BETWEEN 1 AND 200),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, operation, request_id)
);

CREATE INDEX api_admission_leases_scope_expiry_idx
  ON api_admission_leases (owner_user_id, operation, expires_at);
```

- [ ] **Step 4: Implement transactional acquire/release**

Use one checked-out client, `BEGIN`, and:

```sql
SELECT pg_advisory_xact_lock(hashtextextended($1, 0));
DELETE FROM api_admission_leases
 WHERE owner_user_id = $2 AND operation = $3 AND expires_at <= $4;
```

Check concurrency before consuming rate quota. Upsert the bucket only when `accepted_count < maxRequests`:

```sql
INSERT INTO api_admission_buckets (
  owner_user_id, operation, window_started_at, window_expires_at, accepted_count
) VALUES ($1,$2,$3,$4,1)
ON CONFLICT (owner_user_id, operation, window_started_at)
DO UPDATE SET accepted_count = api_admission_buckets.accepted_count + 1, updated_at = now()
WHERE api_admission_buckets.accepted_count < $5
RETURNING accepted_count, window_expires_at;
```

Insert a lease only for policies with `maxConcurrent`. Roll back on rejection so a denied concurrency attempt does not consume rate quota. Convert unexpected database errors to:

```ts
export class AdmissionControlUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = "ADMISSION_CONTROL_UNAVAILABLE";
  readonly expose = true;
}
```

After a successful acquisition, delete no more than 100 stale rows without extending the transaction's lock scope:

```sql
DELETE FROM api_admission_buckets
 WHERE ctid IN (
   SELECT ctid
     FROM api_admission_buckets
    WHERE window_expires_at < $1 - interval '1 hour'
    ORDER BY window_expires_at
    LIMIT 100
 );
```

Use the injected `now` value for window calculation, lease expiry, retry time, and cleanup so integration tests remain deterministic.

- [ ] **Step 5: Verify migration and service behavior**

Run:

```powershell
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/admission-control.integration.test.ts tests/integration/migrations.integration.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit admission persistence**

```powershell
git add database/migrations/0040_api_admission_control.sql services/api/src/admission-service.ts tests/integration/admission-control.integration.test.ts tests/integration/migrations.integration.test.ts
git diff --cached --check
git commit -m "Add shared API admission control"
```

---

### Task 7: Route body limits and admission hooks

**Files:**
- Create: `tests/integration/network-security.integration.test.ts`
- Modify: `services/api/src/request-security.ts`
- Modify: `services/api/src/server.ts`
- Modify: `tests/unit/server-security.test.ts`

**Interfaces:**
- Consumes: admission service from Task 6 and runtime limits from Task 1.
- Produces: `createAdmissionHooks(pool, policies)` with route `onRequest` guards and global release hooks.
- Produces: route options for `provider`, `generation`, and `import`.

- [ ] **Step 1: Write failing body-limit and cross-replica HTTP tests**

```ts
it("enforces import and default body policies before handlers", async () => {
  const defaultTooLarge = await app.inject({
    method: "POST",
    url: "/api/v1/providers/discover-models",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ padding: "x".repeat(1_048_577) })
  });
  expect(defaultTooLarge.statusCode).toBe(413);

  const importWithinLimit = await app.inject({
    method: "POST",
    url: "/api/v1/imports/infinite-worlds/preview",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({
      sourceName: "bounded-world.txt",
      sourceKind: "world_text",
      sourceText: "x".repeat(2_000_000)
    })
  });
  expect(importWithinLimit.statusCode).not.toBe(413);
});

it("returns shared 429 and Retry-After across API instances", async () => {
  const request = {
    method: "POST" as const,
    url: "/api/v1/providers/discover-models",
    headers: { "content-type": "application/json" },
    payload: {}
  };
  const responses = [];
  for (let index = 0; index < 3; index += 1) {
    responses.push(await (index % 2 ? secondApp : app).inject(request));
  }
  expect(responses.filter((response) => response.statusCode === 429)).toHaveLength(1);
  expect(responses.at(-1)?.headers["retry-after"]).toMatch(/^\d+$/);
  expect(responses.at(-1)?.json()).toMatchObject({ error: "RequestLimitExceededError" });
});
```

Configure both test servers with `apiRateLimitProviderRequests: 2`. The first two invalid discovery requests stop at schema validation after acquiring admission; the third is rejected by shared admission before validation, and no provider network call occurs.

- [ ] **Step 2: Run the security integration test and confirm limits are absent**

Run:

```powershell
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/network-security.integration.test.ts
```

Expected: FAIL because route overrides and admission hooks are not wired.

- [ ] **Step 3: Implement admission hooks with idempotent release**

```ts
const leases = new WeakMap<FastifyRequest, string>();

export class RequestLimitExceededError extends Error {
  readonly statusCode = 429;
  readonly code = "REQUEST_LIMIT_EXCEEDED";
  readonly expose = true;
  constructor(readonly retryAfterSeconds: number) {
    super("The request limit for this operation has been reached.");
    this.name = "RequestLimitExceededError";
  }
}

export function createAdmissionHooks(pool: DatabasePool, policies: Record<AdmissionPolicy["key"], AdmissionPolicy>) {
  async function guard(key: AdmissionPolicy["key"], request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const ownerUserId = await initialOwnerId(pool);
    const decision = await acquireAdmission(pool, ownerUserId, request.id, policies[key]);
    if (!decision.allowed) {
      reply.header("Retry-After", String(decision.retryAfterSeconds));
      throw new RequestLimitExceededError(decision.retryAfterSeconds);
    }
    if (decision.leaseId) leases.set(request, decision.leaseId);
  }

  async function release(request: FastifyRequest): Promise<void> {
    const leaseId = leases.get(request);
    if (!leaseId) return;
    leases.delete(request);
    await releaseAdmission(pool, leaseId);
  }

  return {
    provider: (request: FastifyRequest, reply: FastifyReply) => guard("provider", request, reply),
    generation: (request: FastifyRequest, reply: FastifyReply) => guard("generation", request, reply),
    import: (request: FastifyRequest, reply: FastifyReply) => guard("import", request, reply),
    release
  };
}
```

Install global `onResponse`, `onError`, and `onRequestAbort` release hooks. `releaseAdmission` is idempotent, so double lifecycle notification is safe.

- [ ] **Step 4: Attach explicit route policies**

Use Fastify route options, not URL matching:

```ts
const importOptions = {
  bodyLimit: config.security.apiImportBodyLimitBytes,
  onRequest: admission.import
};
const providerOptions = { onRequest: admission.provider };
const generationOptions = { onRequest: admission.generation };
```

Attach:

- `importOptions` to all legacy/world/Infinite Worlds preview and commit routes;
- `providerOptions` to unsaved/saved discovery, generic provider text, world/character generation, organization, and import routes that call a provider;
- `generationOptions` to generation enqueue, retry, replacement, and illustration generation submissions.

When a route needs import body size and provider admission, use:

```ts
{ bodyLimit: config.security.apiImportBodyLimitBytes, onRequest: admission.provider }
```

because the provider policy is stricter than the import-only policy for synchronous provider work.

- [ ] **Step 5: Verify error envelopes and body limits**

Ensure `statusCode`, `errorDetails`, and `exposeError` produce the approved codes:

```json
{
  "error": "RequestLimitExceededError",
  "message": "The request limit for this operation has been reached.",
  "code": "REQUEST_LIMIT_EXCEEDED"
}
```

Add `REQUEST_TOO_LARGE` normalization for Fastify's parser error without exposing internals:

```ts
if (typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
  return {
    name: "RequestTooLargeError",
    message: "The request exceeds the size limit for this operation.",
    code: "REQUEST_TOO_LARGE"
  };
}
```

- [ ] **Step 6: Run HTTP and complete database integration tests**

Run:

```powershell
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/network-security.integration.test.ts tests/integration/admission-control.integration.test.ts
pnpm test:integration
```

Expected: PASS with actual database tests executed.

- [ ] **Step 7: Commit route protection**

```powershell
git add services/api/src/request-security.ts services/api/src/server.ts tests/unit/server-security.test.ts tests/integration/network-security.integration.test.ts
git diff --cached --check
git commit -m "Limit expensive API requests"
```

---

### Task 8: Deployment configuration and operator documentation

**Files:**
- Modify: `.env.example`
- Modify: `compose.yaml`
- Modify: `deploy/swarm/stack.yaml`
- Modify: `docs/installation/environment-configuration.md`
- Modify: `docs/installation/network-access.md`
- Modify: `docs/installation/provider-configuration.md`
- Modify: `docs/operations/security.md`
- Modify: `docs/operations/swarm/secrets-and-configs.md`
- Modify: `README.md`
- Modify: `tests/unit/server-security.test.ts`

**Interfaces:**
- Consumes: all environment variables and failure behavior from Tasks 1–7.
- Produces: identical Compose/Swarm runtime contract and pre-upgrade checklist.

- [ ] **Step 1: Add a failing manifest/configuration contract test**

Extend `tests/unit/server-security.test.ts` or create a focused deployment test:

```ts
it("passes the security contract through Compose and Swarm", () => {
  const compose = readFileSync("compose.yaml", "utf8");
  const swarm = readFileSync("deploy/swarm/stack.yaml", "utf8");
  for (const setting of [
    "CORS_ALLOWED_ORIGINS",
    "PROVIDER_NETWORK_ALLOWLIST",
    "CSP_IMAGE_ALLOWED_ORIGINS",
    "API_RATE_LIMIT_WINDOW_SECONDS",
    "TRUST_PROXY_HOPS"
  ]) {
    expect(compose).toContain(setting);
    expect(swarm).toContain(setting);
  }
  expect(compose).toContain("host.docker.internal");
});
```

- [ ] **Step 2: Run the deployment contract test**

Run:

```powershell
pnpm exec vitest run tests/unit/server-security.test.ts
```

Expected: FAIL because the manifests do not pass the new settings.

- [ ] **Step 3: Wire all settings into Compose and Swarm**

Compose must include:

```yaml
CORS_ALLOWED_ORIGINS: ${CORS_ALLOWED_ORIGINS:-}
PROVIDER_NETWORK_ALLOWLIST: ${PROVIDER_NETWORK_ALLOWLIST:-host.docker.internal}
CSP_IMAGE_ALLOWED_ORIGINS: ${CSP_IMAGE_ALLOWED_ORIGINS:-}
API_DEFAULT_BODY_LIMIT_BYTES: ${API_DEFAULT_BODY_LIMIT_BYTES:-1048576}
API_IMPORT_BODY_LIMIT_BYTES: ${API_IMPORT_BODY_LIMIT_BYTES:-16777216}
API_ASSET_BODY_LIMIT_BYTES: ${API_ASSET_BODY_LIMIT_BYTES:-33554432}
API_RATE_LIMIT_WINDOW_SECONDS: ${API_RATE_LIMIT_WINDOW_SECONDS:-60}
API_RATE_LIMIT_PROVIDER_REQUESTS: ${API_RATE_LIMIT_PROVIDER_REQUESTS:-10}
API_RATE_LIMIT_GENERATION_REQUESTS: ${API_RATE_LIMIT_GENERATION_REQUESTS:-12}
API_RATE_LIMIT_IMPORT_REQUESTS: ${API_RATE_LIMIT_IMPORT_REQUESTS:-4}
API_CONCURRENCY_PROVIDER_REQUESTS: ${API_CONCURRENCY_PROVIDER_REQUESTS:-2}
API_CONCURRENCY_IMPORT_REQUESTS: ${API_CONCURRENCY_IMPORT_REQUESTS:-1}
TRUST_PROXY_HOPS: ${TRUST_PROXY_HOPS:-0}
```

Swarm uses the same names but no private-provider default. Its deployment environment must supply `PROVIDER_NETWORK_ALLOWLIST`.

- [ ] **Step 4: Rewrite security and installation guidance**

Document:

- implicit loopback same-origin access, explicit LAN/public origins, and exact-origin syntax;
- origin-less administrative clients;
- why wildcard origins are rejected;
- localhost defaults and explicit `host.docker.internal` Compose behavior;
- Swarm private inference DNS/CIDR configuration;
- public HTTPS versus allowlisted private HTTP;
- strict external-image origins;
- trusted proxy hop semantics;
- body and admission defaults;
- `403`, `413`, `422`, `429`, and `503` operator diagnostics;
- pre-upgrade inventory of private providers and remote images;
- rollback behavior and additive admission tables;
- Sogni SDK's official-origin restriction versus configurable Sogni REST.

Remove statements that describe wildcard CORS or permissive CSP as the current state.

- [ ] **Step 5: Validate rendered manifests and documentation**

Run:

```powershell
docker compose --env-file .env.example config
docker stack config -c deploy/swarm/stack.yaml
pnpm --dir docs build
pnpm exec vitest run tests/unit/server-security.test.ts
```

Expected: both manifests render, VitePress builds, and the contract test passes.

- [ ] **Step 6: Commit deployment and documentation**

```powershell
git add .env.example compose.yaml deploy/swarm/stack.yaml docs/installation/environment-configuration.md docs/installation/network-access.md docs/installation/provider-configuration.md docs/operations/security.md docs/operations/swarm/secrets-and-configs.md README.md tests/unit/server-security.test.ts
git diff --cached --check
git commit -m "Document secure network configuration"
```

---

### Task 9: Full verification and implementation handoff

**Files:**
- Modify only files required to correct failures discovered by the commands below.

**Interfaces:**
- Consumes: completed Tasks 1–8.
- Produces: verified P0 network-security branch ready for review.

- [ ] **Step 1: Run repository and unit validation**

Run:

```powershell
pnpm check
pnpm test:unit
pnpm build
```

Expected: PASS with no skipped unit tests.

- [ ] **Step 2: Run PostgreSQL integration validation**

Run with `TEST_DATABASE_URL` set to a disposable PostgreSQL 18 + pgvector 0.8.5 database:

```powershell
pnpm test:integration
```

Expected: PASS with the integration file/test count reported and only explicitly intentional skips.

- [ ] **Step 3: Run deployment and documentation validation**

```powershell
docker compose --env-file .env.example config
docker stack config -c deploy/swarm/stack.yaml
pnpm --dir docs build
```

Expected: PASS. A VitePress chunk-size warning is acceptable if unchanged; any new warning is investigated.

- [ ] **Step 4: Review security invariants directly**

```powershell
rg -n --pcre2 -g '*.html' -g '*.js' "<script(?![^>]*\\bsrc=)|\\son[a-z]+\\s*=|style=" apps/web/public
rg -n "unsafe-inline|img-src \\*|connect-src \\*|Access-Control-Allow-Credentials|X-User-Id" services packages apps/web/public
git diff origin/main...HEAD --check
git status --short
```

Expected:

- the active UI scan prints no inline constructs;
- the insecure-header scan prints no active implementation occurrence;
- `git diff --check` is silent;
- the worktree is clean after any final commit.

- [ ] **Step 5: Review the complete branch diff**

```powershell
git diff --stat origin/main...HEAD
git diff origin/main...HEAD
```

Confirm the diff contains only the audit/spec/plan and P0 network-security work. Verify that no API key, private campaign, generated asset, local database value, or test secret is present.

- [ ] **Step 6: Return failures to their owning task**

If any command fails, stop Task 9, mark the task that owns the failing file or behavior `in_progress`, repeat that task's failing-test, implementation, passing-test, staged-diff review, and exact-file commit cycle, then restart Task 9 from Step 1. Do not create a catch-all verification commit.

- [ ] **Step 7: Transition to branch completion**

Announce:

```text
I'm using the finishing-a-development-branch skill to complete this work.
```

Invoke `superpowers:finishing-a-development-branch`, present its integration choices, and wait for the user's selection before merging, pushing, or opening a pull request.
