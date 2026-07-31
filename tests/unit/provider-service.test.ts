import { describe, expect, it } from "vitest";
import { publicProvider } from "../../services/api/src/provider-service.js";

describe("publicProvider", () => {
  it("redacts nested provider configuration secrets without mutating stored configuration", () => {
    const configuration = {
      apiKey: "secondary-secret",
      nested: {
        accessToken: "nested-secret",
        apiUrl: "https://api.sogni.ai"
      },
      projectId: "sogni-project"
    };

    const provider = publicProvider({
      id: "provider-1",
      name: "Illustration provider",
      provider_type: "sogni",
      provider_role: "image",
      base_url: "https://images.example.test",
      default_model: "sogni-model",
      context_window_tokens: 8192,
      max_output_tokens: 1024,
      temperature: 0.7,
      request_timeout_ms: 300_000,
      configuration,
      encrypted_api_key: "encrypted-primary-secret",
      credential_nonce: "nonce",
      credential_auth_tag: "auth-tag",
      credential_key_version: 1,
      enabled: true,
      is_default: false,
      health_status: "healthy",
      consecutive_failures: 0,
      last_health_check_at: null,
      last_health_error: null,
      created_at: new Date("2026-01-01T00:00:00Z"),
      updated_at: new Date("2026-01-01T00:00:00Z")
    });

    expect(provider.configuration).toEqual({
      nested: { apiUrl: "https://api.sogni.ai" },
      projectId: "sogni-project"
    });
    expect(provider.hasApiKey).toBe(true);
    expect(configuration).toEqual({
      apiKey: "secondary-secret",
      nested: {
        accessToken: "nested-secret",
        apiUrl: "https://api.sogni.ai"
      },
      projectId: "sogni-project"
    });
  });
});
