# P0 Network Security Design

**Status:** Approved for implementation planning
**Date:** 2026-07-23
**Audit source:** `docs/architecture/codebase-audit-2026-07-23.md`
**Delivery position:** P0 deliverable 1 of 3, before generation durability and deployment correctness

## Purpose

Harden Infinite Quest Nexus at the application boundary so safe behavior is consistent in local Compose and replicated Swarm deployments. This design corrects:

- wildcard credentialed CORS;
- browser-based cross-origin mutation of the initial owner's data;
- unrestricted provider destinations and server-side request forgery;
- permissive content security policy;
- inline UI constructs that require `unsafe-inline`;
- the global 64 MiB request limit;
- uncoordinated access to expensive unauthenticated routes.

The application remains usable with local LM Studio and image endpoints. Private-network access becomes an explicit administrator decision expressed through environment variables. Localhost remains available by default.

## Scope

This deliverable includes:

1. Browser origin validation and preflight handling.
2. Provider destination validation, DNS pinning, and redirect control.
3. Strict CSP and supporting UI cleanup.
4. Route-specific request body limits.
5. PostgreSQL-backed rate and concurrency admission control.
6. Compose, Swarm, environment, and operator documentation.
7. Unit and integration tests for all security boundaries.

This deliverable does not include:

- interactive login, OIDC, sessions, or browser credentials;
- token-based CSRF, which is required when browser credentials are introduced;
- durable conversion of synchronous provider operations into worker jobs;
- generation-stream sanitization;
- image or prompt-refinement lease heartbeats;
- the corrected Swarm worker health command;
- broad Playwright infrastructure beyond any narrowly required security smoke test.

Those concerns remain in later P0/P1 deliverables.

## Architecture

Five focused components form the application security boundary:

1. **Request origin policy** validates browser origins before request bodies and route handlers run.
2. **Provider network policy** validates and pins every text, embedding, discovery, and image provider destination.
3. **Browser security policy** generates CSP and fixed security headers from validated configuration.
4. **Route request policy** assigns explicit body-size and admission policies to sensitive routes.
5. **PostgreSQL admission store** coordinates expensive-operation limits across all API replicas.

Each component is pure or dependency-injected at its boundary. Provider policy receives DNS and connection implementations so tests never depend on external networks. Admission control receives the database pool and clock so expiration behavior is deterministic.

## Configuration contract

The runtime configuration adds these variables:

```dotenv
CORS_ALLOWED_ORIGINS=
PROVIDER_NETWORK_ALLOWLIST=
CSP_IMAGE_ALLOWED_ORIGINS=
API_DEFAULT_BODY_LIMIT_BYTES=1048576
API_IMPORT_BODY_LIMIT_BYTES=16777216
API_ASSET_BODY_LIMIT_BYTES=33554432
API_RATE_LIMIT_WINDOW_SECONDS=60
API_RATE_LIMIT_PROVIDER_REQUESTS=10
API_RATE_LIMIT_GENERATION_REQUESTS=12
API_RATE_LIMIT_IMPORT_REQUESTS=4
API_CONCURRENCY_PROVIDER_REQUESTS=2
API_CONCURRENCY_IMPORT_REQUESTS=1
TRUST_PROXY_HOPS=0
```

### Parsing rules

- List values are comma-separated and whitespace-trimmed.
- `CORS_ALLOWED_ORIGINS` and `CSP_IMAGE_ALLOWED_ORIGINS` accept exact origins in `scheme://host[:port]` form.
- Wildcards, paths, queries, fragments, and embedded credentials are rejected.
- `PROVIDER_NETWORK_ALLOWLIST` accepts exact hostnames, IP addresses, and IPv4/IPv6 CIDR ranges.
- Provider allowlist configuration extends the built-in localhost entries rather than replacing them.
- Built-in entries are `localhost`, `127.0.0.0/8`, and `::1/128`.
- Numeric values are bounded positive integers. Startup fails rather than silently clamping invalid security settings.
- `TRUST_PROXY_HOPS=0` means forwarded headers are not trusted. A positive value is valid only when the operator controls that number of proxy hops.

Root Compose explicitly adds `host.docker.internal` to `PROVIDER_NETWORK_ALLOWLIST`. Swarm examples require operators to add the stable private inference hostname or network used by their deployment.

## Browser origin policy

Origin validation runs in an `onRequest` hook before body parsing.

### Decision algorithm

1. If the request has no `Origin` header, allow it. This preserves PowerShell, curl, health, migration, and smoke-test clients.
2. If the origin is the effective same origin and its hostname is localhost or loopback, allow it.
3. If the normalized origin exactly matches a configured `CORS_ALLOWED_ORIGINS` entry, allow it and return that exact value in `Access-Control-Allow-Origin`.
4. Otherwise return `403` with code `ORIGIN_NOT_ALLOWED`, including when an arbitrary hostile `Origin` matches an arbitrary hostile `Host`.

The effective same origin is derived from the direct request unless `TRUST_PROXY_HOPS` explicitly enables trusted forwarded protocol and host handling. LAN and public browser origins must be listed explicitly even when their `Origin` and `Host` values match. This prevents DNS rebinding from turning an attacker-controlled hostname into an implicitly trusted same origin.

### Response behavior

- Allowed cross-origin responses include `Vary: Origin`.
- Allowed methods are limited to the methods implemented by Nexus.
- Allowed request headers are `Content-Type`, `Authorization`, and `X-Correlation-Id`.
- `X-User-Id` is removed from the CORS contract.
- `Access-Control-Allow-Credentials` is not emitted because the pre-auth application uses no browser credentials.
- Preflight requests use the same origin decision; a disallowed preflight returns `403`, not an unconditional `204`.

During the pre-auth phase, origin enforcement is the browser CSRF boundary. Before cookie or other ambient browser credentials are introduced, authentication work must add a token-based CSRF defense and re-evaluate credentialed CORS.

## Provider network policy

The provider network policy applies to:

- saved and unsaved provider model discovery;
- text generation;
- embeddings;
- image submission and polling;
- provider health checks;
- world and character generation;
- import conversion or enrichment;
- any future outbound operation using a provider profile.

Temporary artifact downloads remain governed by their separate artifact policy and never inherit provider authorization headers.

### URL validation

Before DNS resolution:

- parse with the platform URL parser;
- reject embedded user information;
- reject fragments;
- permit only HTTP and HTTPS;
- normalize hostname, scheme, and effective port;
- reject malformed, ambiguous, or unsupported address syntax.

Public providers must use HTTPS. HTTP is allowed only when the hostname or every resolved address is explicitly trusted by the provider network allowlist.

### Address classification

Resolve all A and AAAA results. Every address must be either:

- globally routable; or
- matched by an explicit hostname, IP, or CIDR allowlist entry.

Reject the complete destination when any answer is loopback, private, link-local, multicast, unspecified, documentation-only, carrier-grade NAT, benchmarking, reserved, or otherwise non-public without an allowlist match. Mixed public/private answers are rejected rather than selecting only the public answer.

The built-in localhost entries make loopback destinations valid without additional configuration. Other private destinations, including `host.docker.internal`, require deployment configuration.

### Connection pinning

Validation returns an approved destination object containing:

- normalized origin and URL;
- approved address family and address;
- server name for TLS;
- effective port;
- policy classification.

The outbound client connects through a dispatcher/lookup implementation that uses the approved address while retaining the original hostname for TLS verification. It must not perform an uncontrolled second DNS resolution.

### Redirects and credentials

- Automatic redirects are disabled.
- Same-origin redirects are resolved, normalized, and revalidated before following.
- Cross-origin provider redirects are rejected.
- Provider authorization is never forwarded to another origin.
- The redirect count is bounded.

### Errors and logs

A policy rejection returns `422 PROVIDER_DESTINATION_NOT_ALLOWED`. Browser responses do not disclose resolved internal addresses, policy entries, credentials, or URL query strings.

Structured logs include:

- correlation ID;
- provider operation;
- normalized hostname;
- policy decision category;
- rejection stage.

Logs exclude embedded credentials, authorization headers, query strings, response bodies, and story content.

## Content security policy

Nexus sends this enforced policy:

```text
default-src 'none';
script-src 'self';
style-src 'self';
img-src 'self' data: blob: <configured image origins>;
connect-src 'self';
font-src 'self';
manifest-src 'self';
object-src 'none';
base-uri 'none';
frame-ancestors 'none';
form-action 'self';
```

`CSP_IMAGE_ALLOWED_ORIGINS` appends validated exact origins to `img-src`. Generated provider images should normally be downloaded into Nexus asset storage and served from the application origin. Legacy remote images remain blocked unless an administrator permits their origin.

Nexus also sends:

- `X-Content-Type-Options: nosniff`;
- `Referrer-Policy: no-referrer`;
- a restrictive `Permissions-Policy`;
- `Strict-Transport-Security` only when the effective original request is HTTPS.

The application does not use report-only CSP as a compatibility phase.

## Inline UI cleanup

The active web application currently contains 28 inline style attributes across 27 source lines, one inline event handler, and one generated print-document style block. It contains no inline application script blocks and no direct `element.style` or `cssText` assignments.

The cleanup preserves appearance and behavior:

- move the provider-dialog padding override into `nexus.css`;
- create reusable story CSS classes for empty-state typography, preserved whitespace, dialog alignment, spacing, retry editor sizing, event tags, stat labels, and grid placement;
- reuse the existing `.dialog-actions` behavior where it already matches;
- replace the provider navigation `onclick` with a normal link styled as a button;
- replace the turn progress width style with semantic `<progress max="100" value="…">`;
- move printable-story rules to `story-print.css` and link that stylesheet from the generated print document.

The progress change must preserve the current percentage display and add an accessible label/value relationship.

## Request body policies

The Fastify-wide default becomes 1 MiB.

Route classes override it only when necessary:

| Policy | Limit | Intended routes |
| --- | ---: | --- |
| Default JSON | 1 MiB | settings, providers, worlds, campaigns, generation commands, state edits |
| Import | 16 MiB | portable campaign/world and Infinite Worlds imports/previews |
| Asset | 32 MiB | explicitly designated asset upload payloads |

The route policy must be attached at route registration, not inferred from URL substrings. A request exceeding the route limit fails before schema parsing with `413 REQUEST_TOO_LARGE`.

## PostgreSQL admission control

Only expensive routes use database admission control. Ordinary reads and routine CRUD do not add database traffic beyond their existing queries.

### Tables

`api_admission_buckets` stores:

- `owner_user_id`;
- operation policy key;
- fixed-window start and expiry;
- accepted request count;
- created and updated timestamps;
- unique constraint on owner, operation, and window start.

`api_admission_leases` stores:

- lease UUID;
- `owner_user_id`;
- operation policy key;
- request/correlation ID;
- lease expiry;
- created timestamp;
- unique constraint preventing duplicate acquisition for one request and operation.

Both tables are owner-scoped. They contain no IP address, story content, prompt, provider URL, or credentials.

### Acquisition

Acquisition uses one transaction and an advisory lock derived from owner and operation:

1. Delete expired leases for that owner/operation.
2. Upsert the current fixed-window bucket only when the request limit permits an increment.
3. Count active leases and compare with the concurrency limit.
4. Insert a lease when both limits permit.
5. Return lease ID, expiry, remaining requests, and retry time.

If either limit is exhausted, roll back without consuming quota and return `429 REQUEST_LIMIT_EXCEEDED` with `Retry-After`.

### Release and recovery

- Route handlers release the lease in `finally`.
- Lease expiry recovers from API crashes and lost connections.
- Old buckets and expired leases are removed opportunistically under bounded batches.
- Admission-store failure causes protected expensive routes to fail closed with `503 ADMISSION_CONTROL_UNAVAILABLE`.

### Initial policies

| Operation | Requests/window | Concurrency |
| --- | ---: | ---: |
| Provider request/discovery | 10 | 2 |
| Generation submission | 12 | Existing durable-job constraints remain authoritative |
| Import/preview | 4 | 1 |

The configured rate window defaults to 60 seconds. These policies scope to the server-resolved owner, which is the initial owner until authentication is implemented.

## Error contract

Security errors use the existing API error envelope and correlation ID.

| HTTP | Code | Meaning |
| ---: | --- | --- |
| 403 | `ORIGIN_NOT_ALLOWED` | Browser origin is neither loopback same-origin nor explicitly configured |
| 413 | `REQUEST_TOO_LARGE` | Request exceeds its route policy |
| 422 | `PROVIDER_DESTINATION_NOT_ALLOWED` | Provider URL, address, or redirect violates outbound policy |
| 429 | `REQUEST_LIMIT_EXCEEDED` | Shared rate or concurrency limit is exhausted |
| 503 | `ADMISSION_CONTROL_UNAVAILABLE` | A protected operation cannot safely acquire shared admission |

No error includes internal addresses, allowlist contents, credentials, raw database errors, or provider response content.

## Testing strategy

### Unit tests

Test pure and dependency-injected components for:

- origin normalization, exact matches, wildcard rejection, scheme/port distinctions, and lookalike hosts;
- loopback same-origin and explicitly configured origin behavior with direct and trusted-proxy requests;
- CSP construction and rejection of invalid image origins;
- hostname, IPv4, IPv6, and CIDR matching;
- built-in localhost behavior;
- public HTTPS acceptance and public HTTP rejection;
- private, link-local, metadata, multicast, unspecified, and reserved address rejection;
- explicitly allowed private endpoints;
- mixed DNS answers;
- connection pinning;
- same-origin redirect revalidation and cross-origin redirect rejection;
- configuration defaults, bounds, and startup failures;
- static absence of inline styles, inline handlers, and active inline style/script blocks.

### Integration tests

Use Fastify injection and the real test database to cover:

- loopback same-origin, configured LAN/public, hostile, rebinding, and missing-origin requests;
- permitted and denied preflights;
- absence of credentialed CORS and `X-User-Id`;
- route-specific body limits;
- two API instances sharing rate and concurrency state;
- lease release, expiry, crash recovery, and bounded cleanup;
- fail-closed admission behavior;
- an allowed local provider mock;
- a blocked provider destination that receives no connection;
- CSP and security headers on Nexus, story, asset, and API responses;
- printable-story markup referencing `story-print.css`.

Tests for origin, destination policy, and admission control are written and observed failing before implementation.

## Deployment and rollout

The admission migration is additive and online. It does not alter authoritative world, campaign, turn, provider, or Chronicle data.

Before upgrading:

1. Compose users need no action for the documented `host.docker.internal` provider endpoint.
2. Swarm operators must populate `PROVIDER_NETWORK_ALLOWLIST` with their private inference hostname, IP, or CIDR.
3. Operators using remote browser images must populate `CSP_IMAGE_ALLOWED_ORIGINS`.
4. Operators behind a proxy must set `TRUST_PROXY_HOPS` to the exact controlled hop count.
5. Existing wildcard CORS configurations must be replaced with exact origins.

Configuration is identical in Compose and Swarm. The committed example environment file, root Compose manifest, Swarm config, and operations documentation expose the same names and semantics.

Rollback to the previous application version is safe because the new tables are additive. They may remain in the database unused. No rollback mode restores wildcard CORS, unrestricted private-network destinations, or `unsafe-inline` in the new version.

## Acceptance criteria

The deliverable is complete when:

1. A hostile browser origin cannot read or mutate any API resource.
2. Loopback browsers, configured LAN/public browser origins, and origin-less administrative clients continue to work.
3. Public HTTPS providers work without allowlist entries.
4. Localhost works by default; other private providers work only when configured.
5. Blocked, rebinding, mixed-answer, and cross-origin redirect destinations receive no authenticated request.
6. Every active page operates under enforced CSP without `unsafe-inline`.
7. Remote images render only from configured origins.
8. Oversized requests fail according to explicit route policy.
9. Multiple API replicas enforce one PostgreSQL-backed rate/concurrency limit.
10. Admission crashes recover through lease expiry and never bypass protection.
11. Compose and Swarm configuration validation and rendered manifests pass.
12. Unit, integration, repository, TypeScript, JavaScript syntax, application build, documentation build, and `git diff --check` validations pass.

## Follow-on sequence

After this deliverable is merged:

1. Design and plan P0 generation durability: narration-only streaming plus image/refinement lease heartbeat and fencing.
2. Design and plan P0 deployment correctness: supported worker health command and exact built-container health tests.
3. Continue with P1 durable provider work and architecture completion.
