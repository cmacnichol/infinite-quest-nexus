import { describe, expect, it } from "vitest";
import { ApiContractError, NexusApiError } from "../../../packages/client-core/src/index.js";

describe("NexusApiError", () => {
  it("preserves stable class identity and normalizes optional transport metadata", () => {
    const error = new NexusApiError("The campaign is unavailable.", {
      statusCode: 429,
      errorName: "RateLimitError",
      domainCode: "campaign_throttled",
      correlationId: "corr-123",
      details: { code: "campaign_throttled", limit: 12 },
      issues: [{ path: ["campaignId"] }],
      retryAfter: " 120 "
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("NexusApiError");
    expect(error.errorName).toBe("RateLimitError");
    expect(error.statusCode).toBe(429);
    expect(error.correlationId).toBe("corr-123");
    expect(error.domainCode).toBe("campaign_throttled");
    expect(error.details).toEqual({ code: "campaign_throttled", limit: 12 });
    expect(error.issues).toEqual([{ path: ["campaignId"] }]);
    expect(error.retryAfter).toBe("120");
  });

  it("normalizes missing metadata to null without conflating server error identity", () => {
    const error = new NexusApiError("Request failed with HTTP 502.", { statusCode: 502 });

    expect(error.name).toBe("NexusApiError");
    expect(error.errorName).toBe("NexusApiError");
    expect(error.correlationId).toBeNull();
    expect(error.domainCode).toBeNull();
    expect(error.details).toBeNull();
    expect(error.issues).toBeNull();
    expect(error.retryAfter).toBeNull();
  });
});

describe("ApiContractError", () => {
  it("retains request or response contract context and the inherited cause", () => {
    const cause = new SyntaxError("Unexpected token <");
    const error = new ApiContractError("The API returned invalid JSON.", {
      phase: "response",
      kind: "malformed_json",
      method: "GET",
      path: "/campaigns/campaign-1/turns",
      statusCode: 200,
      correlationId: "corr-456",
      issues: [{ code: "invalid_type" }],
      cause
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ApiContractError");
    expect(error.phase).toBe("response");
    expect(error.kind).toBe("malformed_json");
    expect(error.method).toBe("GET");
    expect(error.path).toBe("/campaigns/campaign-1/turns");
    expect(error.statusCode).toBe(200);
    expect(error.correlationId).toBe("corr-456");
    expect(error.issues).toEqual([{ code: "invalid_type" }]);
    expect(error.cause).toBe(cause);
  });

  it("normalizes absent optional context to null", () => {
    const error = new ApiContractError("The request does not match its schema.", {
      phase: "request",
      kind: "request_schema_mismatch",
      method: "POST",
      path: "/campaigns/campaign-1/generations"
    });

    expect(error.statusCode).toBeNull();
    expect(error.correlationId).toBeNull();
    expect(error.issues).toBeNull();
  });
});
