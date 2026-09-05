import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createProviderTransport,
  sendPreparedProviderRequest,
  type ProviderTransport,
  type TextProviderProfile
} from "../../packages/story-engine/src/providers.js";
import { serializeProviderRequest } from "../../packages/story-engine/src/provider-request.js";

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
    const request = {
      systemPrompt: "Rules: use \"quotes\" and \\slashes.\nUnicode: \u96ea",
      input: "Authoritative state\nwith a newline.",
      previousResponseId: "remote-history-must-not-be-sent",
      recoveryInput: "Return complete JSON.",
      rejectedResponse: "{\"narration\":\"A complete rejected draft\\nwith \\slashes and \u96ea.\"}",
      onChunk: vi.fn()
    };
    const expectedPayload = {
      model: "loaded-instance-id",
      input: "Authoritative state\nwith a newline.\n\nREJECTED RESPONSE TO REWRITE:\n{\"narration\":\"A complete rejected draft\\nwith \\slashes and \u96ea.\"}\n\nRECOVERY REQUIREMENT:\nReturn complete JSON.",
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

  it("prepares OpenAI-compatible framing and reserve fields without serializing callbacks", () => {
    const openAiProfile: TextProviderProfile = {
      ...profile,
      providerType: "openai_compatible",
      baseUrl: "https://api.openai.com/v1"
    };
    const onChunk = vi.fn();
    const prepared = serializeProviderRequest(openAiProfile, {
      systemPrompt: "system\n\"quoted\"",
      input: "input \\ \u96ea",
      recoveryInput: "repair",
      rejectedResponse: "complete draft",
      onChunk
    });

    expect(JSON.parse(prepared.body)).toEqual({
      model: "loaded-instance-id",
      messages: [
        { role: "system", content: "system\n\"quoted\"" },
        { role: "user", content: "input \\ \u96ea" },
        { role: "assistant", content: "complete draft" },
        { role: "user", content: "repair" }
      ],
      temperature: 0.2,
      max_tokens: 4_096,
      response_format: { type: "json_object" },
      stream: true,
      stream_options: { include_usage: true }
    });
    expect(prepared.body).not.toContain("onChunk");
  });
});
