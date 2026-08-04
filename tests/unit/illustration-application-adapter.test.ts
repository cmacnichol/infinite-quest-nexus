import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient, DatabasePool } from "../../packages/database/src/pool.js";
import {
  createIllustrationArtifactDownloadAdapter,
  createIllustrationAssetAdapter,
  createIllustrationImageProviderAdapter,
  createIllustrationPromptRefinementAdapter
} from "../../services/api/src/illustration-application-adapter.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const campaignId = "33333333-3333-4333-8333-333333333333";
const segmentId = "44444444-4444-4444-8444-444444444444";
const providerProfileId = "55555555-5555-4555-8555-555555555555";

describe("illustration provider adapters", () => {
  it("keeps image submission and remote polling on the image-provider path", async () => {
    const provider = { id: providerProfileId, providerRole: "image", providerType: "openai_compatible" };
    const loadImageProvider = vi.fn(async () => provider);
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
      "credential-secret",
      {
        loadImageProvider: loadImageProvider as never,
        submitImageProvider: submitImageProvider as never,
        pollImageProvider: pollImageProvider as never,
        recordProviderHealth: recordProviderHealth as never
      }
    );
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
      metadata: { status: "queued" }
    });
    expect(loadImageProvider).toHaveBeenCalledWith(
      expect.anything(), ownerUserId, providerProfileId, "credential-secret", "image-model"
    );
    expect(submitImageProvider).toHaveBeenCalledWith(provider, {
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
      metadata: { responseId: "provider-response-1" }
    });
    expect(pollImageProvider).toHaveBeenCalledWith(provider, { remoteJobId: "remote-1" });
    expect(recordProviderHealth).toHaveBeenCalledTimes(2);
    expect(recordProviderHealth).toHaveBeenLastCalledWith(
      expect.anything(), ownerUserId, providerProfileId, true
    );
  });

  it("keeps fiction refinement on the text-provider path with the configured system prompt", async () => {
    const provider = { id: providerProfileId, providerRole: "text", providerType: "openai_compatible" };
    const loadTextProvider = vi.fn(async () => provider);
    const callTextProvider = vi.fn(async () => ({
      content: "Moonlit observatory, silver lens, cinematic fantasy illustration",
      responseId: "text-response-1",
      finishReason: "stop",
      usage: { total_tokens: 42 },
      reportedCost: null
    }));
    const recordProviderHealth = vi.fn(async () => undefined);
    const adapter = createIllustrationPromptRefinementAdapter(
      {} as DatabasePool,
      "credential-secret",
      {
        loadTextProvider: loadTextProvider as never,
        callTextProvider: callTextProvider as never,
        recordProviderHealth: recordProviderHealth as never
      }
    );

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
    expect(loadTextProvider).toHaveBeenCalledWith(
      expect.anything(), ownerUserId, providerProfileId, "credential-secret", "text-model"
    );
    expect(callTextProvider).toHaveBeenCalledWith(provider, {
      systemPrompt: "Return only a fiction-only visual prompt.",
      input: expect.stringContaining("Moonlight fills the observatory.")
    });
    const refinementCall = callTextProvider.mock.calls[0] as unknown as [unknown, { input: string }];
    expect(refinementCall[1].input).toContain("A quiet night beneath a violet sky.");
    expect(recordProviderHealth).toHaveBeenCalledWith(
      expect.anything(), ownerUserId, providerProfileId, true
    );
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

describe("illustration asset adapter", () => {
  it("persists provisional assets and binds them with owner/campaign/turn scope", async () => {
    const assetId = "66666666-6666-4666-8666-666666666666";
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        campaign_id: campaignId,
        turn_id: null,
        world_id: null,
        target_type: "streaming_illustration",
        prompt: "A moonlit observatory.",
        provider_profile_id: providerProfileId,
        provider_type: "openai_compatible",
        requested_model: "image-model",
        size: "1024x1024",
        aspect_ratio: "1:1",
        quality: "auto",
        output_format: "png"
      }] })
      .mockResolvedValueOnce({ rows: [{ bound: true }] });
    const client = { query } as unknown as DatabaseClient;
    const transaction = vi.fn(async (_pool, work: (database: DatabaseClient) => Promise<unknown>) => work(client));
    const persistTurnImage = vi.fn(async () => ({ id: assetId }));
    const persistWorldCover = vi.fn(async () => ({ id: assetId }));
    const store = { root: "/tmp/illustration-assets" };
    const adapter = createIllustrationAssetAdapter(
      {} as DatabasePool,
      store,
      {
        transaction: transaction as never,
        persistTurnImage: persistTurnImage as never,
        persistWorldCover: persistWorldCover as never
      }
    );

    await expect(adapter.persistTurnIllustration({
      ownerUserId,
      campaignId,
      turnId: null,
      imageJobId: jobId,
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png"
    })).resolves.toEqual({ assetId });
    expect(persistTurnImage).toHaveBeenCalledWith(
      client,
      store,
      ownerUserId,
      campaignId,
      null,
      Buffer.from([1, 2, 3]),
      "image/png",
      {
        attachReference: false,
        generationContext: {
          imageJobId: jobId,
          targetType: "streaming_illustration",
          variantIndex: 0,
          prompt: "A moonlit observatory.",
          providerProfileId,
          providerType: "openai_compatible",
          model: "image-model",
          generationParameters: {
            size: "1024x1024",
            aspectRatio: "1:1",
            quality: "auto",
            outputFormat: "png"
          }
        }
      }
    );

    await expect(adapter.bindSegmentAsset({
      ownerUserId,
      campaignId,
      turnId: null,
      segmentId,
      imageJobId: jobId,
      assetId,
      variantIndex: 0
    })).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("IS NOT DISTINCT FROM $4::uuid"), [
      segmentId,
      ownerUserId,
      campaignId,
      null,
      assetId,
      jobId,
      0
    ]);
  });

  it("rejects asset provenance when the image job belongs to another campaign", async () => {
    const foreignCampaignId = "77777777-7777-4777-8777-777777777777";
    const client = { query: vi.fn(async () => ({ rows: [{
      campaign_id: foreignCampaignId,
      turn_id: null,
      world_id: null,
      target_type: "streaming_illustration",
      prompt: "A moonlit observatory.",
      provider_profile_id: providerProfileId,
      provider_type: "openai_compatible",
      requested_model: "image-model",
      size: "1024x1024",
      aspect_ratio: "1:1",
      quality: "auto",
      output_format: "png"
    }] })) } as unknown as DatabaseClient;
    const persistTurnImage = vi.fn(async () => ({ id: crypto.randomUUID() }));
    const adapter = createIllustrationAssetAdapter(
      {} as DatabasePool,
      { root: "/tmp/illustration-assets" },
      {
        transaction: (async (
          _pool: DatabasePool,
          work: (database: DatabaseClient) => Promise<unknown>,
        ) => work(client)) as never,
        persistTurnImage: persistTurnImage as never,
        persistWorldCover: vi.fn() as never
      }
    );

    await expect(adapter.persistTurnIllustration({
      ownerUserId,
      campaignId,
      turnId: null,
      imageJobId: jobId,
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png"
    })).rejects.toMatchObject({ statusCode: 404 });
    expect(persistTurnImage).not.toHaveBeenCalled();
  });
});
