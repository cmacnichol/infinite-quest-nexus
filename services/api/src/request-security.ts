import type { FastifyInstance } from "fastify";
import type { RuntimeConfig } from "../../../packages/database/src/config.js";
import { buildContentSecurityPolicy } from "../../../packages/security/src/content-security-policy.js";
import { evaluateRequestOrigin } from "../../../packages/security/src/exact-origins.js";

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
    reply.header("x-correlation-id", request.id);
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
    let effectiveOrigin: string;
    try {
      effectiveOrigin = new URL(`${request.protocol}://${host}`).origin;
    } catch {
      throw new OriginNotAllowedError();
    }
    const decision = evaluateRequestOrigin(
      request.headers.origin,
      effectiveOrigin,
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
