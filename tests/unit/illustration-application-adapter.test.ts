import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient, DatabasePool } from "../../packages/database/src/pool.js";
import {
  createIllustrationArtifactDownloadAdapter,
  createIllustrationImageProviderAdapter,
  createIllustrationPromptRefinementAdapter
} from "../../services/runtime/src/illustration-platform-adapter.js";
import { createIllustrationPlatformBindings } from "../../services/runtime/src/illustration-platform-bindings.js";
import { createIllustrationGenerationTransactionPort } from "../../services/runtime/src/illustration-repository-bindings.js";
import { runIllustrationPromptJob } from "../../services/runtime/src/illustration-segment-job-adapter.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const campaignId = "33333333-3333-4333-8333-333333333333";
const segmentId = "44444444-4444-4444-8444-444444444444";
const providerProfileId = "55555555-5555-4555-8555-555555555555";

describe("illustration provider adapters", () => {
  it("does not bind provider or asset business services inside the runtime platform adapter", async () => {
    const source = await readFile(
      new URL("../../services/runtime/src/illustration-platform-adapter.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain('from "./provider-service.js"');
    expect(source).not.toContain('from "./asset-service.js"');
  });

  it("keeps image submission and remote polling on the image-provider path", async () => {
    const provider = {
      id: providerProfileId,
      name: "Image provider",
      providerRole: "image" as const,
      providerType: "openai_compatible" as const,
      model: "image-model",
      contextWindowTokens: 0,
      maxOutputTokens: 0,
      temperature: 0,
      requestTimeoutMs: 30_000,
      configuration: {},
      submit: vi.fn(),
      poll: vi.fn(),
    };
    const loadImageExecution = vi.fn(async () => provider);
    const submitImageProvider = vi.fn(async () => ({
      mode: "pending" as const,
      remoteJobId: "remote-1",
      pollAfterMs: 2_000,
      progress: 10,
      queuePosition: 3,
      etaSeconds: 20,
      providerMetadata: { status: "queued", temporaryUrl: "https://temporary.invalid" }
    }));
    const pollImageProvider = vi.fn(async () => ({
      status: "completed" as const,
      artifacts: [{ source: "base64" as const, base64: "iVBORw0KGgo=", mimeType: "image/png" }],
      usage: { images: 1 },
      reportedCost: { amount: "0.04", currency: "USD" },
      providerMetadata: { responseId: "provider-response-1" }
    }));
    const recordProviderHealth = vi.fn(async () => undefined);
    const adapter = createIllustrationImageProviderAdapter(
      {} as DatabasePool,
      {
        loadImageExecution: loadImageExecution as never,
        recordProviderHealth: recordProviderHealth as never
      }
    );
    provider.submit.mockImplementation(submitImageProvider);
    provider.poll.mockImplementation(pollImageProvider as never);
    const baseRequest = {
      ownerUserId,
      jobId,
      providerProfileId,
      model: "image-model",
      prompt: "A moonlit observatory.",
      generationRevision: 2,
      idempotencyKey: `${jobId}:2`,
      imageCount: 1 as const,
      size: "1024x1024",
      aspectRatio: "1:1",
      quality: "auto" as const,
      outputFormat: "png" as const
    };

    await expect(adapter.executeImage({ ...baseRequest, remoteJobId: null })).resolves.toEqual({
      providerRole: "image",
      providerProfileId,
      model: "image-model",
      status: "pending",
      remoteJobId: "remote-1",
      pollAfterMs: 2_000,
      progress: 10,
      queuePosition: 3,
      etaSeconds: 20,
      metadata: { status: "queued" },
      artifactDownloadTimeoutMs: 30_000,
      allowPrivateArtifactHosts: false,
      generationTimeoutMs: 180_000
    });
    expect(loadImageExecution).toHaveBeenCalledWith(ownerUserId, providerProfileId, "image-model");
    expect(submitImageProvider).toHaveBeenCalledWith({
      prompt: "A moonlit observatory.",
      size: "1024x1024",
      aspectRatio: "1:1",
      quality: "auto",
      outputFormat: "png",
      idempotencyKey: `${jobId}:2`,
      imageCount: 1
    });
    expect(pollImageProvider).not.toHaveBeenCalled();

    await expect(adapter.executeImage({ ...baseRequest, remoteJobId: "remote-1" })).resolves.toEqual({
      providerRole: "image",
      providerProfileId,
      model: "image-model",
      status: "completed",
      artifacts: [{ source: "base64", base64: "iVBORw0KGgo=", mimeType: "image/png" }],
      usage: { images: 1 },
      reportedCost: { amount: "0.04", currency: "USD" },
      metadata: { responseId: "provider-response-1" },
      artifactDownloadTimeoutMs: 30_000,
      allowPrivateArtifactHosts: false,
      generationTimeoutMs: 180_000
    });
    expect(pollImageProvider).toHaveBeenCalledWith("remote-1");
    expect(recordProviderHealth).toHaveBeenCalledTimes(2);
    expect(recordProviderHealth).toHaveBeenLastCalledWith(
      expect.anything(), ownerUserId, providerProfileId, true
    );
  });

  it("keeps fiction refinement on the text-provider path with the configured system prompt", async () => {
    const textResolution = {
      status: "resolved" as const,
      requestedRole: "text" as const,
      resolvedRole: "text" as const,
      providerProfileId,
      providerType: "openai_compatible" as const,
      routingSource: "models" as const,
      model: "text-model",
      fallbackModels: [],
      preset: null,
      providerPolicy: {}
    };
    const provider = { id: providerProfileId, model: "text-model", execute: vi.fn() };
    const loadTextExecution = vi.fn(async () => provider);
    const callTextProvider = vi.fn(async () => ({
      content: "Moonlit observatory, silver lens, cinematic fantasy illustration",
      responseId: "text-response-1",
      finishReason: "stop",
      usage: { total_tokens: 42 },
      reportedCost: null
    }));
    const recordProviderHealth = vi.fn(async () => undefined);
    const buildRefinementInput = vi.fn((fictionText: string, storyContext: string) => (
      `${fictionText}\n${storyContext}`
    ));
    const parseRefinedPrompt = vi.fn((content: string) => content);
    const adapter = createIllustrationPromptRefinementAdapter(
      {} as DatabasePool,
      {
        loadTextExecution: loadTextExecution as never,
        recordProviderHealth: recordProviderHealth as never,
        buildRefinementInput,
        parseRefinedPrompt
      }
    );
    provider.execute.mockImplementation(callTextProvider);

    await expect(adapter.refinePrompt({
      ownerUserId,
      campaignId,
      turnId: null,
      segmentId,
      providerProfileId,
      model: "text-model",
      textResolution,
      systemPrompt: "Return only a fiction-only visual prompt.",
      fictionText: "Moonlight fills the observatory.",
      storyContext: "A quiet night beneath a violet sky."
    })).resolves.toMatchObject({
      providerRole: "text",
      providerProfileId,
      model: "text-model",
      prompt: "Moonlit observatory, silver lens, cinematic fantasy illustration"
    });
    expect(loadTextExecution).toHaveBeenCalledWith(ownerUserId, textResolution);
    expect(callTextProvider).toHaveBeenCalledWith({
      systemPrompt: "Return only a fiction-only visual prompt.",
      input: expect.stringContaining("Moonlight fills the observatory.")
    });
    const refinementCall = callTextProvider.mock.calls[0] as unknown as [{ input: string }];
    expect(refinementCall[0].input).toContain("A quiet night beneath a violet sky.");
    expect(buildRefinementInput).toHaveBeenCalledWith(
      "Moonlight fills the observatory.",
      "A quiet night beneath a violet sky.",
    );
    expect(parseRefinedPrompt).toHaveBeenCalledWith(
      "Moonlit observatory, silver lens, cinematic fantasy illustration",
    );
    expect(recordProviderHealth).toHaveBeenCalledWith(
      expect.anything(), ownerUserId, providerProfileId, true
    );
  });

  it("forwards the supplied text plan for prompt refinement while preserving the independent image path", async () => {
    const textPlan = {
      status: "resolved" as const,
      requestedRole: "text" as const,
      resolvedRole: "text" as const,
      providerProfileId,
      providerType: "openai_compatible" as const,
      routingSource: "models" as const,
      model: "text-primary",
      fallbackModels: ["text-fallback"],
      preset: null,
      providerPolicy: {}
    };
    const execution = {
      text: vi.fn(async () => ({ execute: vi.fn() })),
      image: vi.fn(async () => ({ submit: vi.fn(), poll: vi.fn() }))
    };
    const providers = {
      resolution: { resolveDirect: vi.fn(async () => textPlan) },
      execution,
      health: { recordHealth: vi.fn() },
      costs: { recordIllustrationCost: vi.fn() },
      costContext: vi.fn()
    };
    const bindings = createIllustrationPlatformBindings({} as DatabasePool, providers as never);

    await bindings.promptRefinement.loadTextExecution(ownerUserId, textPlan);
    await bindings.imageProvider.loadImageExecution(ownerUserId, providerProfileId, "image-model");

    expect(providers.resolution.resolveDirect).not.toHaveBeenCalled();
    expect(execution.text).toHaveBeenCalledWith({ ownerUserId }, textPlan);
    expect(execution.image).toHaveBeenCalledWith({ ownerUserId }, providerProfileId, "image-model");
  });

  it("uses one current text descriptor for queued refinement execution and attribution after a profile plan changes", async () => {
    const currentPlan = {
      status: "resolved" as const,
      requestedRole: "text" as const,
      resolvedRole: "text" as const,
      providerProfileId,
      providerType: "openai_compatible" as const,
      routingSource: "models" as const,
      model: "current-primary",
      fallbackModels: ["current-fallback"],
      preset: null,
      providerPolicy: {}
    };
    const execution = {
      text: vi.fn(async (_scope, resolution) => ({
        id: resolution.providerProfileId,
        providerType: resolution.providerType,
        model: resolution.model,
        maxOutputTokens: 256,
        execute: vi.fn(async () => ({
          content: "Moonlit observatory, silver lens, cinematic fantasy illustration",
          responseId: "text-response-2",
          finishReason: "stop",
          usage: { total_tokens: 42 },
          reportedCost: null
        }))
      }))
    };
    const providers = {
      resolution: { resolveDirect: vi.fn(async () => currentPlan) },
      execution,
      health: { recordHealth: vi.fn(async () => undefined) },
      costs: { recordIllustrationCost: vi.fn() },
      costContext: vi.fn()
    };
    const bindings = createIllustrationPlatformBindings({} as DatabasePool, providers as never);
    const adapter = createIllustrationPromptRefinementAdapter({} as DatabasePool, bindings.promptRefinement);

    await expect(adapter.refinePrompt({
      ownerUserId,
      campaignId,
      turnId: null,
      segmentId,
      providerProfileId,
      model: "stale-primary",
      textResolution: currentPlan,
      systemPrompt: "Return only a fiction-only visual prompt.",
      fictionText: "Moonlight fills the observatory.",
      storyContext: "A quiet night beneath a violet sky."
    } as never)).resolves.toMatchObject({ model: "current-primary" });

    expect(providers.resolution.resolveDirect).not.toHaveBeenCalled();
    expect(execution.text).toHaveBeenCalledWith({ ownerUserId }, currentPlan);
  });

  it("uses the resolved queued text plan for prompt-job cost attribution instead of its stale requested model", async () => {
    const currentPlan = {
      status: "resolved" as const,
      requestedRole: "text" as const,
      resolvedRole: "text" as const,
      providerProfileId,
      providerType: "openai_compatible" as const,
      routingSource: "models" as const,
      model: "current-primary",
      fallbackModels: ["current-fallback"],
      preset: null,
      providerPolicy: {}
    };
    const claimed = {
      id: jobId,
      owner_user_id: ownerUserId,
      campaign_id: campaignId,
      turn_id: null,
      segment_id: segmentId,
      provider_profile_id: providerProfileId,
      requested_model: "stale-primary",
      prompt_snapshot: { illustration_refinement: { content: "Return only fiction." }, illustration_character_reference: { content: "" } },
      attempts: 1,
      max_attempts: 2
    };
    const config = {
      enabled: true,
      source_policy: "library_only",
      matching_scope: "campaign",
      confidence_profile: "balanced",
      repetition_window: 3,
      provider_profile_id: null,
      model: "image-model",
      size: "1024x1024",
      aspect_ratio: "1:1",
      quality: "standard",
      output_format: "png",
      max_attempts: 2,
      segment_word_count: 500,
      images_per_segment: 1,
      segment_prompt_mode: "ai_refined",
      refinement_prompt: "Return only fiction.",
      updated_at: new Date("2026-08-22T16:00:00.000Z"),
      campaign_image_provider_id: null,
      campaign_text_provider_id: providerProfileId
    };
    const segment = {
      id: segmentId,
      owner_user_id: ownerUserId,
      campaign_id: campaignId,
      turn_id: null,
      generation_job_id: null,
      illustration_set_id: "66666666-6666-4666-8666-666666666666",
      source_text: "Moonlight fills the observatory.",
      direct_prompt: "Moonlit observatory",
      resolved_prompt: "",
      character_visual_reference: ""
    };
    const query = vi.fn(async (statement: string) => {
      if (statement.includes("WITH candidate AS")) return { rows: [claimed], rowCount: 1 };
      if (statement.includes("FROM turn_illustration_segments segments")) return { rows: [segment], rowCount: 1 };
      if (statement.includes("SELECT campaigns.title")) return { rows: [], rowCount: 0 };
      if (statement.startsWith("SELECT id FROM campaigns")) return { rows: [{ id: campaignId }], rowCount: 1 };
      if (statement.includes("FROM campaign_illustration_configs config")) return { rows: [config], rowCount: 1 };
      if (statement.includes("SELECT provider_type FROM provider_profiles")) {
        return { rows: [{ provider_type: "openai_compatible" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() };
    const pool = {
      query,
      connect: vi.fn(async () => client),
      totalCount: 1
    } as never;
    const refinement = { refinePrompt: vi.fn(async () => ({
      providerRole: "text" as const,
      providerProfileId,
      model: "current-primary",
      prompt: "Moonlit observatory, silver lens, cinematic fantasy illustration",
      metadata: { responseId: "text-response-3", usage: { total_tokens: 42 }, reportedCost: null }
    })) };
    const costPort = { recordIllustrationCost: vi.fn(async () => null) };
    const providers = {
      resolution: { resolveDirect: vi.fn(async () => currentPlan) },
      prompts: { loadIllustrationPromptSnapshot: vi.fn() },
      promptTools: { content: vi.fn() }
    };

    await expect(runIllustrationPromptJob(pool, "worker-1", 30, refinement as never, costPort as never, providers as never))
      .resolves.toBe(true);

    expect(refinement.refinePrompt).toHaveBeenCalledWith(expect.objectContaining({
      model: "current-primary",
      textResolution: currentPlan
    }));
    expect(costPort.recordIllustrationCost).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      requestedModel: "current-primary"
    }));
  });
});

describe("illustration artifact download adapter", () => {
  it("forwards URL/base64 variants and security policy while enforcing the caller byte ceiling", async () => {
    const download = vi.fn()
      .mockResolvedValueOnce({ bytes: Buffer.from([1, 2, 3]), mimeType: "image/png" })
      .mockResolvedValueOnce({ bytes: Buffer.from([1, 2, 3, 4]), mimeType: "image/png" });
    const adapter = createIllustrationArtifactDownloadAdapter({ downloadArtifact: download as never });

    await expect(adapter.downloadArtifact({
      ownerUserId,
      imageJobId: jobId,
      artifact: { source: "url", url: "https://images.example.test/a.png", mimeType: "image/png" },
      timeoutMs: 5_000,
      allowPrivateHosts: false,
      maximumBytes: 3
    })).resolves.toEqual({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" });
    expect(download).toHaveBeenNthCalledWith(
      1,
      { source: "url", url: "https://images.example.test/a.png", mimeType: "image/png" },
      5_000,
      false
    );

    await expect(adapter.downloadArtifact({
      ownerUserId,
      imageJobId: jobId,
      artifact: { source: "base64", base64: "iVBORw0KGgo=", mimeType: "image/png" },
      timeoutMs: 5_000,
      allowPrivateHosts: true,
      maximumBytes: 3
    })).rejects.toMatchObject({ code: "image_too_large", permanent: true });
  });
});

describe("illustration generation transaction adapter", () => {
  it("uses the caller-owned transaction for streaming configuration rather than opening another pool transaction", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: campaignId }] })
      .mockResolvedValueOnce({
        rows: [{
        enabled: true,
        source_policy: "generate_only",
        matching_scope: "world",
        confidence_profile: "balanced",
        repetition_window: 5,
        provider_profile_id: providerProfileId,
        model: "image-model",
        size: "1024x1024",
        aspect_ratio: "1:1",
        quality: "auto",
        output_format: "png",
        max_attempts: 3,
        segment_word_count: 500,
        images_per_segment: 1,
        segment_prompt_mode: "direct",
        refinement_prompt: "",
        updated_at: new Date("2026-08-04T12:00:00.000Z"),
        campaign_image_provider_id: providerProfileId,
        campaign_text_provider_id: null
        }]
      });
    const database = { query } as unknown as DatabaseClient;
    const adapter = createIllustrationGenerationTransactionPort({} as never);

    await expect(adapter.loadStreamingIllustrationConfig(database, { ownerUserId, campaignId }))
      .resolves.toMatchObject({
        enabled: true,
        providerProfileId,
        campaignImageProviderProfileId: providerProfileId,
        campaignTextProviderProfileId: null
    });
    expect(query).toHaveBeenCalledTimes(2);
    const [statement, parameters] = query.mock.calls[1] as unknown as [string, unknown[]];
    expect(statement).toContain("FROM campaign_illustration_configs");
    expect(parameters).toEqual([campaignId, ownerUserId]);
  });
});
