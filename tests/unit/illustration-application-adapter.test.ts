import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { getProviderOutputSchemaV2 } from "@infinite-quest/contracts";
import type { SchemaVerificationV2 } from "../../packages/contracts/src/text-response-format.js";
import type { DatabaseClient, DatabasePool } from "../../packages/database/src/pool.js";
import {
  createIllustrationArtifactDownloadAdapter,
  createIllustrationImageProviderAdapter,
  createIllustrationPromptRefinementAdapter
} from "../../services/runtime/src/illustration-platform-adapter.js";
import { parseRefinedPrompt } from "../../services/runtime/src/illustration-segment-job-adapter.js";
import { prepareAuthoringResponseContractExecution } from "../../services/runtime/src/authoring-text-execution-preparation.js";
import { createIllustrationGenerationTransactionPort } from "../../services/runtime/src/illustration-repository-bindings.js";
import { capabilityRouteConfigHash } from "../../services/runtime/src/provider-capability-cache.js";
import { createProviderResponseFormatCapabilities } from "../../services/runtime/src/provider-response-format-capabilities.js";

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
    const provider = { execute: vi.fn() };
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
      systemPrompt: "Return only a fiction-only visual prompt.",
      fictionText: "Moonlight fills the observatory.",
      storyContext: "A quiet night beneath a violet sky."
    })).resolves.toMatchObject({
      providerRole: "text",
      providerProfileId,
      model: "text-model",
      prompt: "Moonlit observatory, silver lens, cinematic fantasy illustration"
    });
    expect(loadTextExecution).toHaveBeenCalledWith(ownerUserId, providerProfileId, "text-model");
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

  it("dispatches a frozen refinement plan through the prepared text executor without loading mutable text execution", async () => {
    const legacyExecution = vi.fn(async () => {
      throw new Error("legacy text execution must not receive a frozen refinement plan");
    });
    const preparedExecute = vi.fn(async () => ({
      content: "Moonlit observatory, silver lens, cinematic fantasy illustration",
      responseId: "prepared-response-1",
      finishReason: "stop",
      outputLimited: false,
      modelInstanceId: "prepared-model",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      reportedCost: null,
      rawMetadata: {}
    }));
    const adapter = createIllustrationPromptRefinementAdapter(
      {} as DatabasePool,
      {
        loadTextExecution: legacyExecution as never,
        preparedTextExecutor: { execute: preparedExecute },
        recordProviderHealth: vi.fn(async () => undefined) as never,
        buildRefinementInput: (fictionText, storyContext) => `${fictionText}\n${storyContext}`,
        parseRefinedPrompt: (content) => content
      }
    );

    await expect(adapter.refinePrompt({
      ownerUserId,
      campaignId,
      turnId: "33333333-3333-4333-8333-333333333333",
      segmentId: "44444444-4444-4444-8444-444444444444",
      providerProfileId,
      model: "text-model",
      systemPrompt: "Return only a fiction-only visual prompt.",
      fictionText: "Moonlight fills the observatory.",
      storyContext: "A quiet night beneath a violet sky.",
      textExecutionPlan: {
        version: 2,
        selection: { kind: "openrouter_preset", slug: "illustration" },
        preset: { slug: "illustration", versionId: "v1", configHash: "a".repeat(64) },
        candidates: [{ modelId: "prepared-model", providerPolicy: {}, contextWindowTokens: 8192, maxOutputTokens: 1024 }],
        presetSystemPrompt: "Preset instructions.",
        parameters: { temperature: 0.2 },
        prompt: "Preset instructions.\n\nReturn only a fiction-only visual prompt.",
        promptHash: "b".repeat(64),
        endpointReference: "endpoint-1",
        credentialReference: providerProfileId,
        profileRevision: "profile-1",
        authorityRevision: "authority-1",
        requestTimeoutMs: 30_000,
        protocolVersion: "illustration-refinement-v2",
        routeBasisHash: "c".repeat(64),
        planHash: "d".repeat(64)
      }
    })).resolves.toMatchObject({ prompt: "Moonlit observatory, silver lens, cinematic fantasy illustration" });

    expect(legacyExecution).not.toHaveBeenCalled();
    expect(preparedExecute).toHaveBeenCalledWith(expect.objectContaining({
      operation: "illustration_prompt_refinement",
      ownerUserId,
      providerProfileId,
      request: {
        systemPrompt: "Preset instructions.\n\nReturn only a fiction-only visual prompt.",
        input: expect.stringContaining("Moonlight fills the observatory.")
      }
    }));
  });

  it.each(["preset", "model"] as const)("dispatches the full frozen %s illustration contract with a typed one-field envelope and preserves local fiction validation", async (routeKind) => {
    const provider = {
      id: providerProfileId, name: "Illustration text", providerRole: "text" as const,
      providerType: "openrouter" as const, model: "illustration-model", contextWindowTokens: 8192,
      maxOutputTokens: 1024, temperature: 0.4, requestTimeoutMs: 30_000,
      endpointIdentity: "endpoint-illustration", executionRevision: "profile-1", authorityRevision: "authority-1",
      textSelection: routeKind === "preset" ? { kind: "openrouter_preset" as const, slug: "illustration" } : { kind: "model" as const, modelId: "illustration-model" }, configuration: {},
      execute: vi.fn(async () => { throw new Error("legacy execution must not run"); })
    };
    const verification: SchemaVerificationV2 = {
      version: 2, providerType: "openrouter", endpointIdentity: "endpoint-illustration", model: "illustration-model",
      routeConfigHash: capabilityRouteConfigHash({}), adapterProtocol: "text-schema-adapter-v2",
      operation: "illustration_prompt_refinement", schemaHash: getProviderOutputSchemaV2("illustration_prompt_refinement").schemaHash,
      streaming: false, verifiedAt: "2026-09-19T00:00:00.000Z", expiresAt: "2027-09-19T00:00:00.000Z",
      providerRoutingSlugs: [], nativeOpenTrackerObjects: true
    };
    const resolvePreset = vi.fn(async () => ({
      slug: "illustration", name: "Illustration", versionId: "v1", version: 1,
      configHash: "a".repeat(64), config: { models: ["illustration-model"] },
      systemPrompt: "Frozen illustration instructions."
    }));
    const prepared = await prepareAuthoringResponseContractExecution({
      ownerUserId, execution: provider,
      operationPrompts: { illustrationPromptRefinement: "Return one fiction-only image prompt." },
      ports: {
        resolvePreset,
        discoverModels: async () => [{ id: "illustration-model", contextWindowTokens: 8192, maxOutputTokens: 1024,
          ...(routeKind === "model" ? { responseFormatAdvertisement: { supportedParameters: ["response_format", "structured_outputs"], discoveredAt: "2026-09-20T00:00:00.000Z" } } : {}) }]
      },
      ...(routeKind === "model" ? { responseFormatCapabilities: createProviderResponseFormatCapabilities({ records: [verification], now: () => Date.parse("2026-09-20T00:00:00.000Z") }) } : {})
    });
    const outputs = [
      '{"image_prompt":"Moonlit observatory, silver lens, cinematic fantasy illustration"}',
      "Moonlit observatory, silver lens",
      '{"prompt":"Moonlit observatory, silver lens"}',
      '{"image_prompt":"A hero succeeds on a d20 roll of 19"}'
    ];
    const preparedExecute = vi.fn(async () => ({
      content: outputs.shift()!, responseId: "prepared-response", finishReason: "stop", outputLimited: false,
      modelInstanceId: "illustration-model", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      reportedCost: null, rawMetadata: {}
    }));
    const adapter = createIllustrationPromptRefinementAdapter({} as DatabasePool, {
      loadTextExecution: provider.execute as never,
      preparedTextExecutor: { execute: preparedExecute },
      recordProviderHealth: vi.fn(async () => undefined) as never,
      buildRefinementInput: (fictionText, storyContext) => `${fictionText}\n${storyContext}`,
      parseRefinedPrompt
    });
    const request = {
      ownerUserId, campaignId, turnId: null, segmentId, providerProfileId,
      model: "illustration-model", systemPrompt: "untrusted mutable prompt",
      fictionText: "Moonlight fills the observatory.", storyContext: "A quiet night beneath a violet sky.",
      textExecutionPlan: prepared.plans.illustrationPromptRefinement!,
      textExecutionContract: {
        providerType: provider.providerType, requestConfiguration: {}, routeBasis: prepared.routeBasis,
        frozenResponseContracts: prepared.frozenResponseContracts,
        trustedOperationPrompt: prepared.trustedOperationPrompts.illustrationPromptRefinement!
      }
    };

    await expect(adapter.refinePrompt(request)).resolves.toMatchObject({
      prompt: "Moonlit observatory, silver lens, cinematic fantasy illustration"
    });
    const invocation = (preparedExecute.mock.calls as unknown as any[][])[0]![0];
    const body = JSON.parse(invocation.preparedRequest.body);
    expect(invocation).toMatchObject({
      operation: "illustration_prompt_refinement", invocationKey: "illustration_prompt_refinement:nonstream",
      trustedOperationPrompt: "Return one fiction-only image prompt."
    });
    expect(body.response_format.json_schema.name).toBe(getProviderOutputSchemaV2("illustration_prompt_refinement").name);
    expect(body.messages[0].content).toBe(routeKind === "preset" ? "Frozen illustration instructions.\n\nReturn one fiction-only image prompt." : "Return one fiction-only image prompt.");
    expect(invocation.preparedRequest.budgetAudit).toMatchObject({ countMode: "estimated", outputReserveTokens: 1024 });
    expect(invocation.frozenResponseContracts.contracts["illustration_prompt_refinement:nonstream"].admission.basis).toBe(routeKind === "model" ? "model_verified" : "preset_trusted");
    expect(resolvePreset).toHaveBeenCalledTimes(routeKind === "preset" ? 1 : 0);
    expect(provider.execute).not.toHaveBeenCalled();

    await expect(adapter.refinePrompt(request)).rejects.toThrow(/JSON envelope/i);
    await expect(adapter.refinePrompt(request)).rejects.toThrow(/image_prompt envelope/i);
    await expect(adapter.refinePrompt(request)).rejects.toThrow(/fiction-only boundary/i);
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
