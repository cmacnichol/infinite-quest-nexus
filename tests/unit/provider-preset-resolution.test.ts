import { describe, expect, it, vi } from "vitest";
import { resolveTextExecutionPlan, resolveTextExecutionPlans } from "../../services/runtime/src/provider-preset-resolution.js";
import {
  publicTextExecutionPlanSummary,
  textExecutionPlanSchema as applicationTextExecutionPlanSchema
} from "../../packages/application/src/providers/text-execution-plan.js";
import { textExecutionPlanSchema as contractsTextExecutionPlanSchema } from "../../packages/contracts/src/text-execution-plan.js";

const profile = {
  ownerUserId: "00000000-0000-4000-8000-000000000001",
  providerProfileId: "00000000-0000-4000-8000-000000000002",
  profileRevision: "2026-09-19T12:00:00.000Z",
  providerType: "openrouter",
  selection: { kind: "openrouter_preset" as const, slug: "night-shift" },
  contextWindowTokens: 16_000,
  maxOutputTokens: 2_000,
  parameters: { temperature: 0.2 },
  endpointReference: "endpoint-revision-3",
  credentialReference: "credential-revision-8",
  protocolVersion: "story-v7"
};

const preset = {
  slug: "night-shift",
  name: "Night Shift",
  versionId: "preset-version-4",
  version: 4,
  systemPrompt: "Use spare prose.",
  configHash: "a".repeat(64),
  config: {
    models: ["openai/gpt-4.1", "anthropic/claude-sonnet"],
    temperature: 0.7,
    top_p: 0.8,
    top_k: 20,
    frequency_penalty: 0.1,
    presence_penalty: 0.2,
    repetition_penalty: 1.1,
    min_p: 0.05,
    top_a: 0.1,
    seed: 42,
    max_tokens: 1_500,
    max_completion_tokens: 1_200,
    provider: { order: ["anthropic", "openai"], only: ["anthropic", "openai"], ignore: ["other"], allow_fallbacks: true, require_parameters: true, data_collection: "deny", quantizations: ["fp16"], enforce_distillable_text: true, preferred_min_throughput: 1, preferred_max_latency: 2, max_price: { prompt: 1, completion: 2 }, zdr: true }
  }
};

function input(overrides: Record<string, unknown> = {}) {
  return {
    profile,
    operationPrompt: "Return the required Story JSON.",
    ports: {
      resolvePreset: vi.fn(async () => preset),
      discoverModels: vi.fn(async () => [
        { id: "openai/gpt-4.1", contextWindowTokens: 32_000, maxOutputTokens: 1_400 },
        { id: "anthropic/claude-sonnet", contextWindowTokens: 24_000, maxOutputTokens: 1_000 }
      ])
    },
    ...overrides
  };
}

describe("preset execution-plan resolution", () => {
  it("resolves the ordered preset routing and applies hard output/context minima", async () => {
    const resolved = await resolveTextExecutionPlan(input());

    expect(resolved.candidates).toEqual([
      expect.objectContaining({ modelId: "openai/gpt-4.1", contextWindowTokens: 16_000, maxOutputTokens: 1_000, providerPolicy: preset.config.provider }),
      expect.objectContaining({ modelId: "anthropic/claude-sonnet", contextWindowTokens: 16_000, maxOutputTokens: 1_000, providerPolicy: preset.config.provider })
    ]);
    expect(resolved.parameters).toEqual(expect.objectContaining({
      temperature: 0.7, top_p: 0.8, top_k: 20, frequency_penalty: 0.1, presence_penalty: 0.2,
      repetition_penalty: 1.1, min_p: 0.05, top_a: 0.1, seed: 42, max_tokens: 1_000, max_completion_tokens: 1_000
    }));
    expect(resolved.preset).toEqual(expect.objectContaining({ slug: "night-shift", versionId: "preset-version-4", configHash: expect.stringMatching(/^[a-f0-9]{64}$/u) }));
    expect(resolved.prompt).toBe("Use spare prose.\n\nReturn the required Story JSON.");
    expect(resolved.planHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("uses explicit ordinary-parameter overrides without replacing the inherited provider policy", async () => {
    const resolved = await resolveTextExecutionPlan(input({ overrides: { parameters: { temperature: 0.3, top_p: 0.4 } } }));

    expect(resolved.parameters).toEqual(expect.objectContaining({ temperature: 0.3, top_p: 0.4, top_k: 20 }));
    expect(resolved.candidates[0]!.providerPolicy).toEqual(preset.config.provider);
  });

  it("replaces an inherited preset entirely for an explicit direct-model selection", async () => {
    const request = input({ overrides: { selection: { kind: "model", modelId: "openai/gpt-4.1-mini" } }, ports: { resolvePreset: vi.fn(async () => preset), discoverModels: vi.fn(async () => [{ id: "openai/gpt-4.1-mini", contextWindowTokens: 16_000, maxOutputTokens: 1_000 }]) } });
    const resolved = await resolveTextExecutionPlan(request);

    expect(request.ports.resolvePreset).not.toHaveBeenCalled();
    expect(resolved.selection).toEqual({ kind: "model", modelId: "openai/gpt-4.1-mini" });
    expect(resolved.preset).toBeNull();
    expect(resolved.presetSystemPrompt).toBe("");
    expect(resolved.prompt).toBe("Return the required Story JSON.");
  });

  it("rejects unsupported config and conflicting provider sort/order without silent drops", async () => {
    await expect(resolveTextExecutionPlan(input({ ports: { resolvePreset: vi.fn(async () => ({ ...preset, config: { models: ["openai/gpt-4.1"], stop: ["END"] } })), discoverModels: vi.fn(async () => [{ id: "openai/gpt-4.1", contextWindowTokens: 32_000, maxOutputTokens: 1_000 }]) } }))).rejects.toThrow("stop");
    await expect(resolveTextExecutionPlan(input({ ports: { resolvePreset: vi.fn(async () => ({ ...preset, config: { models: ["openai/gpt-4.1"], provider: { order: ["openai"], sort: "price" } } })), discoverModels: vi.fn(async () => [{ id: "openai/gpt-4.1", contextWindowTokens: 32_000, maxOutputTokens: 1_000 }]) } }))).rejects.toThrow("provider.sort");
  });

  it("requires an explicit conservative cap if discovered context capacity is unknown", async () => {
    const ports = { resolvePreset: vi.fn(async () => ({ ...preset, config: { models: ["openai/gpt-4.1"] } })), discoverModels: vi.fn(async () => [{ id: "openai/gpt-4.1" }]) };
    await expect(resolveTextExecutionPlan(input({ ports }))).rejects.toThrow("conservative context cap");
    await expect(resolveTextExecutionPlan(input({ profile: { ...profile, contextWindowTokens: undefined }, overrides: { conservativeContextWindowTokens: 8_000 }, ports }))).resolves.toMatchObject({ candidates: [expect.objectContaining({ contextWindowTokens: 8_000 })] });
  });

  it("always applies an explicit conservative context cap, including with known model capacity", async () => {
    const resolved = await resolveTextExecutionPlan(input({ overrides: { conservativeContextWindowTokens: 8_000 } }));

    expect(resolved.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ contextWindowTokens: 8_000 })]));
  });

  it("allows explicit output overrides up to hard profile and model ceilings", async () => {
    const resolved = await resolveTextExecutionPlan(input({
      profile: { ...profile, maxOutputTokens: 4_000 },
      overrides: { parameters: { max_tokens: 4_000, max_completion_tokens: 4_000 } },
      ports: {
        resolvePreset: vi.fn(async () => preset),
        discoverModels: vi.fn(async () => [
          { id: "openai/gpt-4.1", contextWindowTokens: 32_000, maxOutputTokens: 8_000 },
          { id: "anthropic/claude-sonnet", contextWindowTokens: 24_000, maxOutputTokens: 8_000 }
        ])
      }
    }));

    expect(resolved.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ maxOutputTokens: 4_000 })]));
    expect(resolved.parameters).toEqual(expect.objectContaining({ max_tokens: 4_000, max_completion_tokens: 4_000 }));
  });

  it("hashes canonical configuration and prompt identity deterministically", async () => {
    const first = await resolveTextExecutionPlan(input());
    const reordered = await resolveTextExecutionPlan(input({ ports: { resolvePreset: vi.fn(async () => ({ ...preset, config: { provider: preset.config.provider, max_completion_tokens: 1_200, max_tokens: 1_500, seed: 42, top_a: 0.1, min_p: 0.05, repetition_penalty: 1.1, presence_penalty: 0.2, frequency_penalty: 0.1, top_k: 20, top_p: 0.8, temperature: 0.7, models: preset.config.models } })), discoverModels: vi.fn(async () => [{ id: "openai/gpt-4.1", contextWindowTokens: 32_000, maxOutputTokens: 1_400 }, { id: "anthropic/claude-sonnet", contextWindowTokens: 24_000, maxOutputTokens: 1_000 }]) } }));
    const changed = await resolveTextExecutionPlan(input({ operationPrompt: "Return the revised Story JSON." }));

    expect(reordered.planHash).toBe(first.planHash);
    expect(changed.planHash).not.toBe(first.planHash);
    expect(changed.promptHash).not.toBe(first.promptHash);
    const changedVersion = await resolveTextExecutionPlan(input({ ports: { resolvePreset: vi.fn(async () => ({ ...preset, versionId: "preset-version-5", version: 5 })), discoverModels: vi.fn(async () => [{ id: "openai/gpt-4.1", contextWindowTokens: 32_000, maxOutputTokens: 1_400 }, { id: "anthropic/claude-sonnet", contextWindowTokens: 24_000, maxOutputTokens: 1_000 }]) } }));
    expect(changedVersion.planHash).not.toBe(first.planHash);
  });

  it("projects no prompt or endpoint and credential references to public state", async () => {
    const plan = await resolveTextExecutionPlan(input());
    const summary = publicTextExecutionPlanSummary(plan);

    expect(summary).not.toHaveProperty("prompt");
    expect(JSON.stringify(summary)).not.toContain(profile.endpointReference);
    expect(JSON.stringify(summary)).not.toContain(profile.credentialReference!);
  });

  it("deep-freezes the validated plan so its hash cannot diverge by mutation", async () => {
    const plan = await resolveTextExecutionPlan(input());

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.candidates)).toBe(true);
    expect(Object.isFrozen(plan.candidates[0]!)).toBe(true);
    expect(Object.isFrozen(plan.candidates[0]!.providerPolicy)).toBe(true);
    expect(Object.isFrozen(plan.candidates[0]!.providerPolicy.max_price!)).toBe(true);
    expect(Object.isFrozen(plan.parameters)).toBe(true);
    expect(Object.isFrozen(plan.selection)).toBe(true);
    expect(() => (plan.candidates as unknown as Array<unknown>).push({})).toThrow();
  });

  it("exports the one contracts-owned strict descriptor while keeping the application compatibility surface private", () => {
    expect(applicationTextExecutionPlanSchema).toBe(contractsTextExecutionPlanSchema);
    const summary = publicTextExecutionPlanSummary(contractsTextExecutionPlanSchema.parse({
      version: 2,
      selection: { kind: "model", modelId: "openai/gpt-4.1-mini" },
      preset: null,
      candidates: [{ modelId: "openai/gpt-4.1-mini", providerPolicy: {}, contextWindowTokens: 16_000, maxOutputTokens: 1_000 }],
      presetSystemPrompt: "private prompt",
      parameters: {},
      prompt: "private operation prompt",
      promptHash: "a".repeat(64),
      endpointReference: "private endpoint",
      credentialReference: "private credential",
      profileRevision: "revision",
      protocolVersion: "protocol",
      planHash: "b".repeat(64)
    }));
    expect(summary).not.toHaveProperty("prompt");
    expect(JSON.stringify(summary)).not.toContain("private");
  });

  it("resolves one immutable preset/configuration snapshot for the whole operation set", async () => {
    let version = 4;
    const ports = {
      resolvePreset: vi.fn(async () => ({ ...preset, versionId: `preset-version-${version++}` })),
      discoverModels: vi.fn(async () => [
        { id: "openai/gpt-4.1", contextWindowTokens: 32_000, maxOutputTokens: 1_400 },
        { id: "anthropic/claude-sonnet", contextWindowTokens: 24_000, maxOutputTokens: 1_000 }
      ])
    };

    const resolved = await resolveTextExecutionPlans({
      profile,
      operationPrompts: {
        worldOutline: "Return the world outline JSON.",
        worldOutlineRepair: "Repair the world outline JSON."
      },
      ports
    });

    expect(ports.resolvePreset).toHaveBeenCalledTimes(1);
    expect(ports.discoverModels).toHaveBeenCalledTimes(1);
    expect(resolved.plans.worldOutline!.preset).toEqual(expect.objectContaining({ versionId: "preset-version-4" }));
    expect(resolved.plans.worldOutlineRepair!.preset).toEqual(expect.objectContaining({ versionId: "preset-version-4" }));
    expect(resolved.plans.worldOutline!.prompt).toBe("Use spare prose.\n\nReturn the world outline JSON.");
    expect(resolved.plans.worldOutlineRepair!.prompt).toBe("Use spare prose.\n\nRepair the world outline JSON.");
    expect(resolved.plans.worldOutline!.promptHash).not.toBe(resolved.plans.worldOutlineRepair!.promptHash);
    expect(resolved.plans.worldOutline!.planHash).not.toBe(resolved.plans.worldOutlineRepair!.planHash);
    expect(resolved.plans.worldOutline!.candidates).toEqual(resolved.plans.worldOutlineRepair!.candidates);
    expect(resolved.plans.worldOutline!.parameters).toEqual(resolved.plans.worldOutlineRepair!.parameters);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.plans)).toBe(true);
  });

  it("resolves an explicit model override once without fetching its inherited preset", async () => {
    const ports = {
      resolvePreset: vi.fn(async () => preset),
      discoverModels: vi.fn(async () => [{ id: "openai/gpt-4.1-mini", contextWindowTokens: 16_000, maxOutputTokens: 1_000 }])
    };

    const resolved = await resolveTextExecutionPlans({
      profile,
      overrides: { selection: { kind: "model", modelId: "openai/gpt-4.1-mini" } },
      operationPrompts: { organizer: "Organize this character.", sourceExtraction: "Extract source facts." },
      ports
    });

    expect(ports.resolvePreset).not.toHaveBeenCalled();
    expect(ports.discoverModels).toHaveBeenCalledTimes(1);
    expect(Object.values(resolved.plans)).toEqual(expect.arrayContaining([
      expect.objectContaining({ selection: { kind: "model", modelId: "openai/gpt-4.1-mini" }, preset: null })
    ]));
  });

  it("fails the entire operation set before returning a partial snapshot when a prompt or preset configuration is invalid", async () => {
    const ports = input().ports;
    await expect(resolveTextExecutionPlans({
      profile,
      operationPrompts: { valid: "Return JSON.", invalid: "   " },
      ports
    })).rejects.toThrow("operation prompt");
    expect(ports.resolvePreset).not.toHaveBeenCalled();

    await expect(resolveTextExecutionPlans({
      profile,
      operationPrompts: { valid: "Return JSON.", repair: "Repair JSON." },
      ports: {
        resolvePreset: vi.fn(async () => ({ ...preset, config: { models: ["openai/gpt-4.1"], stop: ["END"] } })),
        discoverModels: vi.fn(async () => [{ id: "openai/gpt-4.1", contextWindowTokens: 32_000, maxOutputTokens: 1_000 }])
      }
    })).rejects.toThrow("stop");
  });
});
