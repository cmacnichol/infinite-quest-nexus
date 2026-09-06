import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ProviderDestinationNotAllowedError } from "../../packages/security/src/provider-network-policy.js";
import {
  ProviderHttpError,
  ProviderTransportError,
  type ProviderResult
} from "../../packages/story-engine/src/providers.js";
import { ProviderResponseTooLargeError } from "../../packages/story-engine/src/provider-response.js";
import { extractJsonObject } from "../../packages/story-engine/src/output.js";
import { characterProfileSchema } from "../../packages/contracts/src/world-library.js";
import { validateGeneratedCharacter } from "../../packages/domain/src/authoring-output.js";
import {
  AuthoringResponseError,
  runAuthoringResponse
} from "../../services/runtime/src/authoring-response-adapter.js";

function providerResult(content: string, outputLimited = false): ProviderResult {
  return {
    content,
    outputLimited,
    responseId: "response-id",
    finishReason: "stop",
    modelInstanceId: "model",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    reportedCost: null,
    rawMetadata: {}
  };
}

function timeoutError(): ProviderTransportError {
  return new ProviderTransportError("application-authored timeout", {
    providerType: "lmstudio",
    operation: "authoring",
    endpoint: "http://provider.test",
    model: "model",
    timeoutMs: 1_000,
    durationMs: 1_000,
    timedOut: true,
    transportCode: "timeout",
    causeCategory: "timeout",
    causeMessage: "The provider request timed out."
  });
}

function creativeCharacter(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-character",
    name: "Iris",
    characterText: "",
    profile: characterProfileSchema.parse({
      story: {
        role: "Cartographer",
        background: "Raised among shifting roads.",
        motivations: "Keep travelers safe."
      }
    }),
    ...overrides
  };
}

function parseCreativeCharacter(content: string) {
  return validateGeneratedCharacter(extractJsonObject(content), "creative");
}

describe("runAuthoringResponse", () => {
  it("renders fixed application failures without raw details", () => {
    const error = new AuthoringResponseError({
      code: "authoring_conflict",
      stage: "world",
      retryable: false,
      issues: []
    });

    expect(error.message).toBe("The authoring proposal changed. Refresh and try again.");
  });

  it("repairs malformed JSON with one complete replacement", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(providerResult("{"))
      .mockResolvedValueOnce(providerResult('{"value":1}'));

    const result = await runAuthoringResponse({
      stage: "character",
      request,
      parse: (text) => JSON.parse(text),
      delay: async () => undefined
    });

    expect(result).toEqual({ value: 1 });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[0]).toMatchObject({
      repair: true,
      issues: [{ path: "generatedCharacter", code: "invalid_json" }]
    });
  });

  it("uses the organizer candidate path for a malformed organizer response", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(providerResult("{"))
      .mockResolvedValueOnce(providerResult('{"value":1}'));

    await runAuthoringResponse({ stage: "organizer", request, parse: JSON.parse, delay: async () => undefined });

    expect(request.mock.calls[1]?.[0].issues).toMatchObject([{ path: "profile", code: "invalid_json" }]);
  });

  it("repairs a recognized schema failure with its safe issue", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(providerResult('{"value":"wrong"}'))
      .mockResolvedValueOnce(providerResult('{"value":1}'));
    const parse = (text: string) => z.object({ value: z.number() }).parse(JSON.parse(text));

    await expect(runAuthoringResponse({ stage: "world", request, parse, delay: async () => undefined }))
      .resolves.toEqual({ value: 1 });
    expect(request.mock.calls[1]?.[0].issues).toEqual([{
      path: "generatedWorld",
      code: "invalid_type",
      message: "Generated content has an invalid type."
    }]);
  });

  it("repairs a missing creative minimum through the actual parser and validator", async () => {
    const incomplete = creativeCharacter({
      profile: characterProfileSchema.parse({
        story: { role: "Cartographer", background: "Raised among shifting roads." }
      })
    });
    const request = vi.fn()
      .mockResolvedValueOnce(providerResult(JSON.stringify(incomplete)))
      .mockResolvedValueOnce(providerResult(JSON.stringify(creativeCharacter())));

    await expect(runAuthoringResponse({
      stage: "character", request, parse: parseCreativeCharacter, delay: async () => undefined
    })).resolves.toMatchObject({ name: "Iris" });
    expect(request.mock.calls[1]?.[0].issues).toContainEqual({
      path: "profile.story.motivations",
      code: "custom",
      message: "Generated character needs a motivation, goal, or narrative hook."
    });
  });

  it.each(["I should reason about this before responding.", ""])
  ("repairs reasoning-only or empty output through the actual JSON extractor", async (content) => {
    const request = vi.fn()
      .mockResolvedValueOnce(providerResult(content))
      .mockResolvedValueOnce(providerResult(JSON.stringify(creativeCharacter())));

    await expect(runAuthoringResponse({
      stage: "character", request, parse: parseCreativeCharacter, delay: async () => undefined
    })).resolves.toMatchObject({ name: "Iris" });
    expect(request.mock.calls[1]?.[0].issues).toContainEqual({
      path: "generatedCharacter",
      code: "invalid_json",
      message: "Generated authoring JSON is malformed."
    });
  });

  it("accepts a limited response only after parsing and semantic completion", async () => {
    await expect(runAuthoringResponse({
      stage: "character",
      request: async () => providerResult('{"value":1}', true),
      parse: (text) => z.object({ value: z.number() }).parse(JSON.parse(text)),
      delay: async () => undefined
    })).resolves.toEqual({ value: 1 });
  });

  it("repairs an incomplete limited response then returns a safe output-limit failure", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(providerResult('{"value":', true))
      .mockResolvedValueOnce(providerResult("", true));

    await expect(runAuthoringResponse({
      stage: "world", request, parse: (text) => JSON.parse(text), delay: async () => undefined
    })).rejects.toMatchObject({
      authoringFailure: { code: "authoring_output_limit", stage: "world", retryable: true }
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps limited-output repair diagnostics within the contract issue cap", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(providerResult("{}", true))
      .mockResolvedValueOnce(providerResult('{"value":1}'));
    let parses = 0;
    const parse = () => {
      parses += 1;
      if (parses === 2) return { value: 1 };
      throw new z.ZodError(Array.from({ length: 20 }, () => ({
        code: "custom",
        path: ["profile", "story", "role"],
        message: "untrusted"
      })));
    };

    await runAuthoringResponse({ stage: "character", request, parse, delay: async () => undefined });

    const issues = request.mock.calls[1]?.[0].issues;
    expect(issues).toHaveLength(20);
    expect(issues).toContainEqual(expect.objectContaining({ message: "Generated output was truncated before completion." }));
  });

  it("maps oversized provider responses to a nonretryable safe output-limit failure", async () => {
    const request = vi.fn().mockRejectedValue(new ProviderResponseTooLargeError(1));

    await expect(runAuthoringResponse({
      stage: "world", request, parse: JSON.parse, delay: async () => undefined
    })).rejects.toMatchObject({
      statusCode: 502,
      authoringFailure: { code: "authoring_output_limit", retryable: false }
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("projects an invalid repaired response without provider content or causes", async () => {
    const secret = "private-provider-output";
    const request = vi.fn()
      .mockResolvedValueOnce(providerResult("{}"))
      .mockResolvedValueOnce(providerResult(secret));

    let error: unknown;
    try {
      await runAuthoringResponse({
        stage: "organizer",
        request,
        parse: (text) => z.object({ complete: z.literal(true) }).parse(JSON.parse(text)),
        delay: async () => undefined
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AuthoringResponseError);
    expect(error).toMatchObject({
      authoringFailure: { code: "invalid_authoring_output", stage: "organizer", retryable: true }
    });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(error).not.toHaveProperty("cause");
  });

  it("does not retry authentication or network-policy failures", async () => {
    const authRequest = vi.fn().mockRejectedValue(new ProviderHttpError(401, null, "provider authentication failed"));
    await expect(runAuthoringResponse({
      stage: "character", request: authRequest, parse: JSON.parse, delay: async () => undefined
    })).rejects.toMatchObject({ authoringFailure: { code: "authoring_provider_rejected", retryable: false } });
    expect(authRequest).toHaveBeenCalledTimes(1);

    const blockedRequest = vi.fn().mockRejectedValue(new ProviderDestinationNotAllowedError("dns"));
    await expect(runAuthoringResponse({
      stage: "character", request: blockedRequest, parse: JSON.parse, delay: async () => undefined
    })).rejects.toMatchObject({ authoringFailure: { code: "authoring_provider_rejected", retryable: false } });
    expect(blockedRequest).toHaveBeenCalledTimes(1);
  });

  it("propagates programming errors without misclassifying them as model output", async () => {
    const bug = new TypeError("application bug");
    const request = vi.fn().mockRejectedValue(bug);

    await expect(runAuthoringResponse({
      stage: "character", request, parse: JSON.parse, delay: async () => undefined
    })).rejects.toBe(bug);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("retries a rate limit once using its typed retry-after delay", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new ProviderHttpError(429, 2_500, "rate limited"))
      .mockResolvedValueOnce(providerResult('{"value":1}'));
    const delay = vi.fn(async () => undefined);

    await expect(runAuthoringResponse({ stage: "world", request, parse: JSON.parse, delay }))
      .resolves.toEqual({ value: 1 });
    expect(delay).toHaveBeenCalledWith(2_500);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("uses the default delay when retry-after exceeds the bounded policy", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new ProviderHttpError(429, 8_000, "rate limited"))
      .mockResolvedValueOnce(providerResult('{"value":1}'));
    const delay = vi.fn(async () => undefined);

    await runAuthoringResponse({ stage: "world", request, parse: JSON.parse, delay });

    expect(delay).toHaveBeenCalledWith(1_000);
  });

  it("stops after two timeouts", async () => {
    const request = vi.fn().mockRejectedValue(timeoutError());

    await expect(runAuthoringResponse({ stage: "world", request, parse: JSON.parse, delay: async () => undefined }))
      .rejects.toMatchObject({ authoringFailure: { code: "authoring_provider_timeout", retryable: true } });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps malformed output plus repair transport failures inside four calls", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(providerResult("{"))
      .mockRejectedValueOnce(timeoutError())
      .mockRejectedValueOnce(timeoutError());

    await expect(runAuthoringResponse({ stage: "world", request, parse: JSON.parse, delay: async () => undefined }))
      .rejects.toMatchObject({ authoringFailure: { code: "authoring_provider_timeout" } });
    expect(request.mock.calls.length).toBeLessThanOrEqual(4);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("bounds rejected output by Unicode code points and labels diagnostic truncation", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(providerResult("😀".repeat(16_001)))
      .mockResolvedValueOnce(providerResult('{"value":1}'));

    await runAuthoringResponse({ stage: "world", request, parse: JSON.parse, delay: async () => undefined });

    const rejected = request.mock.calls[1]?.[0].rejectedResponse as string;
    expect(Array.from(rejected).length).toBeLessThanOrEqual(16_000);
    expect(rejected).toContain("[diagnostic truncated]");
  });
});
