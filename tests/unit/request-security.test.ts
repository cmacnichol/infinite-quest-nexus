import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy } from "../../packages/security/src/content-security-policy.js";
import { evaluateRequestOrigin } from "../../packages/security/src/exact-origins.js";

describe("request security helpers", () => {
  it("allows origin-less requests without a CORS response origin", () => {
    expect(evaluateRequestOrigin(undefined, "http://localhost:8080", [])).toEqual({ allowed: true, responseOrigin: null });
  });

  it("allows exact loopback same-origin requests", () => {
    expect(evaluateRequestOrigin("http://localhost:8080", "http://localhost:8080", [])).toEqual({
      allowed: true,
      responseOrigin: "http://localhost:8080"
    });
  });

  it("rejects non-local origins that only match the supplied host", () => {
    expect(evaluateRequestOrigin("https://evil.test", "https://evil.test", [])).toEqual({ allowed: false });
  });

  it("permits same-origin external scripts without allowing inline execution", () => {
    const policy = buildContentSecurityPolicy([]);

    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toContain("'unsafe-inline'");
  });

  it("adds only validated external image origins to CSP", () => {
    expect(buildContentSecurityPolicy(["https://images.example"])).toContain(
      "img-src 'self' data: blob: https://images.example"
    );
    expect(buildContentSecurityPolicy(["https://images.example"])).not.toContain("connect-src https://images.example");
  });
});
