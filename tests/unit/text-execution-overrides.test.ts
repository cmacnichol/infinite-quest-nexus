import { describe, expect, it } from "vitest";

describe("public text execution overrides", () => {
  it("reuses the strict generation parameter contract and requires a positive conservative cap", async () => {
    const contracts = await import("../../packages/contracts/src/text-execution-plan.js") as Record<string, unknown>;
    const schema = contracts.textExecutionOverridesSchema as {
      parse(value: unknown): unknown;
      safeParse(value: unknown): { success: boolean };
    } | undefined;

    expect(schema).toBeDefined();
    expect(schema!.parse({
      parameters: { temperature: 0.25, max_tokens: 777 },
      conservativeContextWindowTokens: 12_345
    })).toEqual({
      parameters: { temperature: 0.25, max_tokens: 777 },
      conservativeContextWindowTokens: 12_345
    });
    expect(schema!.safeParse({ parameters: { temperature: 3 } }).success).toBe(false);
    expect(schema!.safeParse({ conservativeContextWindowTokens: 0 }).success).toBe(false);
    expect(schema!.safeParse({ conservativeContextWindowTokens: 4_000_001 }).success).toBe(false);
    expect(schema!.safeParse({ privateClaim: true }).success).toBe(false);
  });

  it("accepts omission and explicit clear on public requests without coercing invalid intent", async () => {
    const generation = await import("../../packages/contracts/src/generation.js");
    const imports = await import("../../packages/contracts/src/imports.js");
    const baseGeneration = {
      action: "Continue.", idempotencyKey: "override-contract-1"
    };
    const baseImport = {
      sourceText: "A world.", sourceKind: "world_text"
    };

    expect(generation.generationRequestSchema.parse(baseGeneration)).not.toHaveProperty("textExecutionOverrides");
    expect(generation.generationRequestSchema.parse({ ...baseGeneration, textExecutionOverrides: null }))
      .toHaveProperty("textExecutionOverrides", null);
    expect(generation.generationRequestSchema.parse({
      ...baseGeneration,
      textExecutionOverrides: { parameters: { top_p: 0.4 }, conservativeContextWindowTokens: 9_000 }
    })).toHaveProperty("textExecutionOverrides.parameters.top_p", 0.4);
    expect(generation.generationRequestSchema.safeParse({
      ...baseGeneration,
      textExecutionOverrides: { parameters: { max_tokens: -1 } }
    }).success).toBe(false);

    expect(imports.infiniteWorldsImportRequestSchema.parse({ ...baseImport, textExecutionOverrides: null }))
      .toHaveProperty("textExecutionOverrides", null);
    expect(imports.infiniteWorldsImportRequestSchema.safeParse({
      ...baseImport,
      textExecutionOverrides: { conservativeContextWindowTokens: -1 }
    }).success).toBe(false);
  });

  it("accepts only strict text-role overrides in portable provider authority", async () => {
    const { systemRecordEnvelopeSchema } = await import("../../packages/contracts/src/system-archives.js");
    const authority = {
      providerType: "openrouter",
      providerRole: "text",
      defaultModel: "model",
      textSelection: { kind: "model", modelId: "model" },
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
      temperature: 0.7,
      configuration: { textExecutionOverrides: { parameters: { temperature: 0.2 }, conservativeContextWindowTokens: 16_000 } },
      requestTimeoutMs: 30_000,
      enabled: false,
      isDefault: false,
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z"
    };
    const envelope = {
      domain: "providers",
      formatVersion: 3,
      sourceId: "provider-archive-override",
      record: {
        sourceId: "00000000-0000-4000-8000-000000000063",
        kind: "text",
        displayName: "Portable text",
        baseUrl: "https://openrouter.ai/api/v1",
        selectedModel: "model",
        contextWindow: 32_000,
        timeoutMs: 30_000,
        retryLimit: 2,
        enabled: false,
        health: "unknown",
        authority
      }
    };

    expect(systemRecordEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(systemRecordEnvelopeSchema.safeParse({
      ...envelope,
      record: { ...envelope.record, kind: "image", authority: { ...authority, providerRole: "image", textSelection: null } }
    }).success).toBe(false);
    expect(systemRecordEnvelopeSchema.safeParse({
      ...envelope,
      record: { ...envelope.record, authority: { ...authority, configuration: { textExecutionOverrides: { privateKey: true } } } }
    }).success).toBe(false);
  });
});
