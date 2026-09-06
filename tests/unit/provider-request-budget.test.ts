import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createProviderTransport,
  callTextProvider,
  sendPreparedProviderRequest,
  type ProviderTransport,
  type TextProviderProfile
} from "../../packages/story-engine/src/providers.js";
import {
  serializeCheckedProviderRequest,
  serializeProviderRequest,
  validateCompleteRejectedDraft
} from "../../packages/story-engine/src/provider-request.js";
import { planContext } from "../../packages/story-engine/src/context-budget.js";
import { parseEventExtension } from "../../packages/story-engine/src/mechanics.js";

const profile: TextProviderProfile = {
  providerType: "lmstudio",
  baseUrl: "http://lmstudio.test/v1",
  model: "loaded-instance-id",
  contextWindowTokens: 131_072,
  maxOutputTokens: 4_096,
  temperature: 0.8
};

function createTestProviderTransport(fetcher: typeof fetch): ProviderTransport {
  return createProviderTransport({
    fetcher,
    policy: {
      async approve(url) {
        return {
          url,
          origin: url.origin,
          address: "127.0.0.1",
          family: 4,
          port: url.port ? Number(url.port) : 80,
          servername: url.hostname
        };
      }
    }
  });
}

describe("provider request serialization", () => {
  it("prepares the complete self-contained LM Studio recovery body before transport", async () => {
    const rejectedContent = JSON.stringify({ narration: "A complete rejected draft\nwith \\slashes and 雪." });
    const completeRejectedDraft = validateCompleteRejectedDraft(rejectedContent);
    expect(completeRejectedDraft).not.toBeNull();
    const request = {
      systemPrompt: "Rules: use \"quotes\" and \\slashes.\nUnicode: \u96ea",
      input: "Authoritative state\nwith a newline.",
      previousResponseId: "remote-history-must-not-be-sent",
      recoveryInput: "Return complete JSON.",
      completeRejectedDraft: completeRejectedDraft!,
      onChunk: vi.fn()
    };
    const expectedPayload = {
      model: "loaded-instance-id",
      input: `Authoritative state\nwith a newline.\n\nREJECTED RESPONSE TO REWRITE:\n${rejectedContent}\n\nRECOVERY REQUIREMENT:\nReturn complete JSON.`,
      store: true,
      stream: true,
      temperature: 0.2,
      max_output_tokens: 4_096,
      system_prompt: "Rules: use \"quotes\" and \\slashes.\nUnicode: \u96ea"
    };
    const prepared = serializeProviderRequest(profile, request);
    let capturedBody = "";
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/v1/models")) {
        return new Response(JSON.stringify({ models: [{ key: "loaded-instance-id", loaded_instances: [{ id: "loaded-instance-id" }] }] }), { status: 200 });
      }
      capturedBody = String(init?.body);
      return new Response(JSON.stringify({ output: [{ type: "message", content: "{}" }], stats: {} }), { status: 200 });
    });

    expect(prepared.operation).toBe("story generation");
    expect(prepared.payloadHash).toBe(createHash("sha256").update(prepared.body).digest("hex"));
    expect(prepared.body).not.toContain("remote-history-must-not-be-sent");
    expect(prepared.body).not.toContain("onChunk");

    await sendPreparedProviderRequest(profile, prepared, createTestProviderTransport(fetcher as typeof fetch));
    expect(capturedBody).toBe(prepared.body);
    expect(JSON.parse(capturedBody)).toEqual(expectedPayload);
  });

  it("sends OpenAI-compatible prepared bodies verbatim, including response-format retry", async () => {
    const openAiProfile: TextProviderProfile = {
      ...profile,
      providerType: "openai_compatible",
      baseUrl: "https://api.openai.com/v1"
    };
    const onChunk = vi.fn();
    const completeRejectedDraft = validateCompleteRejectedDraft("{\"narration\":\"complete draft\"}");
    expect(completeRejectedDraft).not.toBeNull();
    const prepared = serializeProviderRequest(openAiProfile, {
      systemPrompt: "system\n\"quoted\"",
      input: "input \\ \u96ea",
      recoveryInput: "repair",
      completeRejectedDraft: completeRejectedDraft!,
      onChunk
    });
    const retryPrepared = serializeProviderRequest(openAiProfile, {
      systemPrompt: "system\n\"quoted\"",
      input: "input \\ \u96ea",
      recoveryInput: "repair",
      completeRejectedDraft: completeRejectedDraft!,
      onChunk
    }, { responseFormat: false });
    const capturedBodies: string[] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBodies.push(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }], usage: {} }), { status: 200 });
    });

    expect(JSON.parse(prepared.body)).toEqual({
      model: "loaded-instance-id",
      messages: [
        { role: "system", content: "system\n\"quoted\"" },
        { role: "user", content: "input \\ \u96ea" },
        { role: "assistant", content: "{\"narration\":\"complete draft\"}" },
        { role: "user", content: "repair" }
      ],
      temperature: 0.2,
      max_tokens: 4_096,
      response_format: { type: "json_object" },
      stream: true,
      stream_options: { include_usage: true }
    });
    expect(prepared.body).not.toContain("onChunk");
    expect(JSON.parse(retryPrepared.body).response_format).toBeUndefined();

    const transport = createTestProviderTransport(fetcher as typeof fetch);
    await sendPreparedProviderRequest(openAiProfile, prepared, transport);
    await sendPreparedProviderRequest(openAiProfile, retryPrepared, transport);
    expect(capturedBodies).toEqual([prepared.body, retryPrepared.body]);
  });

  it("omits partial or forged rejected drafts from both canonical recovery payloads", () => {
    expect(validateCompleteRejectedDraft("{\"narration\":\"truncated")).toBeNull();
    const forgedPartialDraft = { content: "{\"narration\":\"truncated", complete: true } as never;
    const request = {
      systemPrompt: "system",
      input: "authoritative input",
      recoveryInput: "repair",
      completeRejectedDraft: forgedPartialDraft
    };
    const openAiProfile: TextProviderProfile = { ...profile, providerType: "openai_compatible" };

    const lmStudioPayload = JSON.parse(serializeProviderRequest(profile, request).body);
    const openAiPayload = JSON.parse(serializeProviderRequest(openAiProfile, request).body);
    expect(lmStudioPayload.input).not.toContain("REJECTED RESPONSE TO REWRITE");
    expect(openAiPayload.messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "authoritative input" },
      { role: "user", content: "repair" }
    ]);
  });

  it("copies and freezes the checked budget audit at preparation", () => {
    const budgetAudit = {
      countMode: "exact" as const,
      requestTokens: 1_200,
      inputLimit: 2_000,
      outputReserveTokens: 800,
      safetyAllowanceTokens: 256
    };
    const prepared = serializeProviderRequest(profile, {
      systemPrompt: "system",
      input: "input"
    }, { budgetAudit });
    budgetAudit.requestTokens = 1;

    expect(prepared.budgetAudit).toEqual({
      countMode: "exact",
      requestTokens: 1_200,
      inputLimit: 2_000,
      outputReserveTokens: 800,
      safetyAllowanceTokens: 256
    });
    expect(Object.isFrozen(prepared.budgetAudit)).toBe(true);
  });

  it("preserves a planner-produced request measurement without serializing its audit", () => {
    const plan = planContext({
      blocks: [{ id: "latest", revision: "1", content: "authoritative state", protected: true, priority: 0, ordinal: 1 }],
      contextLimit: 500,
      inputLimit: 1_000,
      count: (value) => value.length,
      serializeContext: (blocks) => JSON.stringify(blocks),
      serializeRequest: (blocks) => JSON.stringify({ context: blocks, system: "story rules" })
    });
    const prepared = serializeProviderRequest(profile, {
      systemPrompt: "story rules",
      input: plan.serializedContext
    }, {
      budgetAudit: {
        countMode: "exact",
        requestTokens: plan.requestTokens,
        inputLimit: 1_000,
        outputReserveTokens: profile.maxOutputTokens,
        safetyAllowanceTokens: plan.safetyAllowanceTokens
      }
    });

    expect(prepared.budgetAudit?.requestTokens).toBe(plan.requestTokens);
    expect(prepared.body).not.toContain("budgetAudit");
  });

  it("measures the exact escaped canonical body before transport and rejects an oversized request", async () => {
    const request = {
      systemPrompt: "rules with \\\\ and \"quotes\"",
      input: "action with 雪 and a newline\n",
      recoveryInput: "return every replacement field",
      completeRejectedDraft: validateCompleteRejectedDraft('{"narration":"draft"}')!,
      onChunk: vi.fn()
    };
    const checked = serializeCheckedProviderRequest(profile, request, {
      inputLimit: 10_000,
      count: (value) => value.length,
      output: { kind: "story_append" }
    });
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      new Response(JSON.stringify({ output: [{ type: "message", content: "{}" }], stats: {} }), { status: 200 })
    );

    await sendPreparedProviderRequest(profile, checked, createTestProviderTransport(fetcher as typeof fetch));
    expect(checked.budgetAudit?.requestTokens).toBe(checked.body.length);
    expect(String((fetcher.mock.calls[0]?.[1] as RequestInit).body)).toBe(checked.body);
    try {
      serializeCheckedProviderRequest(profile, request, {
        inputLimit: 10,
        count: (value) => value.length,
        output: { kind: "story_append" }
      });
      throw new Error("Expected the provider request budget to fail.");
    } catch (error) {
      expect(error).toMatchObject({ code: "context_budget_exceeded", scope: "provider_request" });
    }
  });

  it("records body-length canonical guards as estimated rather than tokenizer-exact", () => {
    const prepared = serializeCheckedProviderRequest(profile, {
      systemPrompt: "rules",
      input: "authoritative state"
    }, {
      inputLimit: 10_000,
      count: (value) => value.length,
      countMode: "estimated",
      output: { kind: "story_append" }
    });

    expect(prepared.budgetAudit?.countMode).toBe("estimated");
  });

  it("rejects an oversized canonical request before it calls provider transport", async () => {
    const fetcher = vi.fn();
    await expect(callTextProvider({
      ...profile,
      contextWindowTokens: 3_000,
      maxOutputTokens: 1_024
    }, {
      systemPrompt: "rules",
      input: "x".repeat(3_000),
      canonicalBudgeting: true
    }, createTestProviderTransport(fetcher as typeof fetch))).rejects.toMatchObject({
      code: "context_budget_exceeded",
      scope: "provider_request"
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses a smaller snapshotted job window instead of the provider window for canonical requests", async () => {
    const fetcher = vi.fn();
    await expect(callTextProvider({
      ...profile,
      contextWindowTokens: 16_000,
      maxOutputTokens: 1_000
    }, {
      systemPrompt: "rules",
      input: "x".repeat(1_500),
      canonicalBudgeting: true,
      effectiveContextWindowTokens: 2_000
    }, createTestProviderTransport(fetcher as typeof fetch))).rejects.toMatchObject({
      code: "context_budget_exceeded",
      scope: "provider_request"
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([0, 2_000.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects an invalid snapshotted job window (%s) before transport", async (effectiveContextWindowTokens) => {
    const fetcher = vi.fn();
    await expect(callTextProvider(profile, {
      systemPrompt: "rules",
      input: "authoritative state",
      canonicalBudgeting: true,
      effectiveContextWindowTokens
    }, createTestProviderTransport(fetcher as typeof fetch))).rejects.toMatchObject({
      code: "context_budget_invalid"
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reserves the documented estimated-input safety allowance before canonical transport", async () => {
    const fetcher = vi.fn();
    await expect(callTextProvider({
      ...profile,
      contextWindowTokens: 16_000,
      maxOutputTokens: 1_000
    }, {
      systemPrompt: "rules",
      input: "x".repeat(1_000),
      canonicalBudgeting: true,
      effectiveContextWindowTokens: 2_400
    }, createTestProviderTransport(fetcher as typeof fetch))).rejects.toMatchObject({
      code: "context_budget_exceeded",
      scope: "provider_request"
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("omits an oversized complete rejected draft and sends a clean recovery from protected authority", async () => {
    const authorityCanary = `AUTHORITATIVE_CANARY ${"a".repeat(1_000)}`;
    const rejectedCanary = `REJECTED_CANARY ${"r".repeat(12_000)}`;
    let transportedBody = "";
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/v1/models")) {
        return new Response(JSON.stringify({ models: [{ key: "loaded-instance-id", loaded_instances: [{ id: "loaded-instance-id" }] }] }), { status: 200 });
      }
      transportedBody = String(init?.body);
      return new Response(JSON.stringify({ output: [{ type: "message", content: "{}" }], stats: {} }), { status: 200 });
    });

    await callTextProvider({
      ...profile,
      contextWindowTokens: 12_000,
      maxOutputTokens: 1_024
    }, {
      systemPrompt: "scene rewrite rules",
      input: authorityCanary,
      recoveryInput: "rewrite every uncovered beat",
      rejectedResponse: JSON.stringify({ narration: rejectedCanary }),
      canonicalBudgeting: true
    }, createTestProviderTransport(fetcher as typeof fetch));

    expect(transportedBody).toContain(authorityCanary);
    expect(transportedBody).not.toContain(rejectedCanary);
    expect(transportedBody).toContain("CLEAN REGENERATION REQUIREMENT");
  });

  it("rejects before transport when protected recovery input still cannot fit without its rejected draft", async () => {
    const fetcher = vi.fn();
    await expect(callTextProvider({
      ...profile,
      contextWindowTokens: 3_000,
      maxOutputTokens: 1_024
    }, {
      systemPrompt: "scene rewrite rules",
      input: "x".repeat(2_000),
      recoveryInput: "rewrite every uncovered beat",
      rejectedResponse: JSON.stringify({ narration: "y".repeat(2_000) }),
      canonicalBudgeting: true
    }, createTestProviderTransport(fetcher as typeof fetch))).rejects.toMatchObject({
      code: "context_budget_exceeded",
      scope: "provider_request"
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects an event extension whose preserved narration cannot fit the output reserve before transport", async () => {
    const fetcher = vi.fn();
    await expect(callTextProvider({
      ...profile,
      contextWindowTokens: 100_000,
      maxOutputTokens: 256
    }, {
      systemPrompt: "event extension rules",
      input: "extend the validated story",
      canonicalBudgeting: true,
      budgetOutput: {
        kind: "event_extension",
        protectedStory: {
          narration: "n".repeat(66_000),
          scratchpad: "unchanged scratchpad",
          continuitySummary: "unchanged continuity",
          openThreads: ["unchanged thread"]
        },
        narrationCharacterLimit: 200_000
      }
    }, createTestProviderTransport(fetcher as typeof fetch))).rejects.toMatchObject({
      code: "continuity_output_budget_exceeded",
      scope: "output_skeleton"
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts a one-character event suffix at the 200,000-character narration limit", () => {
    expect(() => serializeCheckedProviderRequest({
      ...profile,
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 1_000_000
    }, {
      systemPrompt: "event extension rules",
      input: "extend the validated story"
    }, {
      inputLimit: 1_000_000,
      count: () => 0,
      output: {
        kind: "event_extension",
        protectedStory: {
          narration: "n".repeat(199_999),
          scratchpad: "",
          continuitySummary: "",
          openThreads: []
        },
        narrationCharacterLimit: 200_000
      }
    })).not.toThrow();
  });

  it("rejects a one-character event suffix one character over the 200,000-character narration limit", () => {
    expect(() => serializeCheckedProviderRequest({
      ...profile,
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 1_000_000
    }, {
      systemPrompt: "event extension rules",
      input: "extend the validated story"
    }, {
      inputLimit: 1_000_000,
      count: () => 0,
      output: {
        kind: "event_extension",
        protectedStory: {
          narration: "n".repeat(200_000),
          scratchpad: "",
          continuitySummary: "",
          openThreads: []
        },
        narrationCharacterLimit: 200_000
      }
    })).toThrow(expect.objectContaining({ code: "extension_narration_limit_exceeded" }));
  });

  it("accepts the guard's one-character suffix through the event-extension parser", () => {
    const mainNarration = "The main narration remains unchanged.";
    const parsed = parseEventExtension(JSON.stringify({
      narration: `${mainNarration}x`,
      choices: ["one", "two", "three", "four"],
      custom_action_suggestion: "Continue onward.",
      scratchpad: "complete continuity",
      tracker_updates: [],
      image_prompt: "",
      continuity_summary: "complete summary",
      canonical_facts: [],
      superseded_facts: [],
      canonical_fact_updates: [],
      open_threads: []
    }), mainNarration);

    expect(parsed.narration).toBe(`${mainNarration}x`);
  });

  it("rejects escaped replacement continuity that makes the complete event output exceed its reserve", () => {
    expect(() => serializeCheckedProviderRequest({
      ...profile,
      contextWindowTokens: 100_000,
      maxOutputTokens: 256
    }, {
      systemPrompt: "event extension rules",
      input: "extend the validated story"
    }, {
      inputLimit: 99_744,
      count: (value) => value.length,
      output: {
        kind: "event_extension",
        protectedStory: {
          narration: "Brief narration.",
          scratchpad: "\\\"\n".repeat(2_000),
          continuitySummary: "",
          openThreads: []
        },
        narrationCharacterLimit: 200_000
      }
    })).toThrow(expect.objectContaining({ code: "continuity_output_budget_exceeded", scope: "output_skeleton" }));
  });

  it("accepts a complete event output exactly at its serialized token reserve and rejects one token over", () => {
    const protectedStory = {
      narration: "N",
      scratchpad: "S",
      continuitySummary: "C",
      openThreads: ["T"]
    };
    const exactReserve = JSON.stringify({
      narration: "Nx",
      choices: ["x", "x", "x", "x"],
      custom_action_suggestion: "x",
      scratchpad: "S",
      tracker_updates: [],
      image_prompt: "",
      continuity_summary: "C",
      canonical_facts: [],
      superseded_facts: [],
      canonical_fact_updates: [],
      open_threads: ["T"]
    }).length;
    const request = { systemPrompt: "event extension rules", input: "extend the validated story" };
    const options = {
      inputLimit: 1_000_000,
      count: (value: string) => value.length,
      output: { kind: "event_extension" as const, protectedStory, narrationCharacterLimit: 200_000 }
    };

    expect(() => serializeCheckedProviderRequest({ ...profile, contextWindowTokens: 1_000_000, maxOutputTokens: exactReserve }, request, options)).not.toThrow();
    expect(() => serializeCheckedProviderRequest({ ...profile, contextWindowTokens: 1_000_000, maxOutputTokens: exactReserve - 1 }, request, options)).toThrow(expect.objectContaining({ code: "continuity_output_budget_exceeded" }));
  });
});
