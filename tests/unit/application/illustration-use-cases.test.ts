import { describe, expect, expectTypeOf, test } from "vitest";
import {
  createIllustrationApplication,
  createIllustrationWorkerApplication,
  type IllustrationApplication,
  type IllustrationAssetPort,
  type IllustrationConfigRepository,
  type IllustrationImageProviderPort,
  type IllustrationJobRepository,
  type IllustrationPromptRefinementPort,
  type IllustrationResolutionRepository,
  type IllustrationSegmentRepository,
  type IllustrationStreamingRepository,
  type IllustrationWorkerExecutor
} from "../../../packages/application/src/index.js";
import type {
  IllustrationBackfillPreview,
  IllustrationBackfillRequest,
  IllustrationConfig,
  IllustrationRequest,
  IllustrationSegmentImageRequest,
  IllustrationSegmentRequest,
  WorldCoverRequest
} from "../../../packages/contracts/src/index.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const campaignId = "22222222-2222-4222-8222-222222222222";
const worldId = "33333333-3333-4333-8333-333333333333";
const turnId = "44444444-4444-4444-8444-444444444444";
const jobId = "55555555-5555-4555-8555-555555555555";
const segmentId = "66666666-6666-4666-8666-666666666666";
const generationJobId = "77777777-7777-4777-8777-777777777777";
const setId = "88888888-8888-4888-8888-888888888888";

declare const typeOnlyApplication: IllustrationApplication;

describe("illustration application use cases", () => {
  test("forwards every API and accepted-generation operation without dropping owner or resource scope", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const configResult = Object.freeze({
      enabled: false,
      sourcePolicy: "off" as const,
      matchingScope: "world" as const,
      confidenceProfile: "balanced" as const,
      repetitionWindow: 5,
      providerProfileId: null,
      model: "",
      size: "1024x1024",
      aspectRatio: "1:1",
      quality: "auto" as const,
      outputFormat: "png" as const,
      maxAttempts: 3,
      segmentWordCount: 500,
      imagesPerSegment: 1,
      segmentPromptMode: "direct" as const,
      refinementPrompt: "fiction only",
      defaultRefinementPrompt: "fiction only",
      updatedAt: null
    });
    const imageJob = Object.freeze({
      id: jobId,
      campaignId,
      turnId,
      worldId: null,
      targetType: "turn_illustration" as const,
      segmentId: null,
      generationJobId: null,
      imageCount: 1 as const,
      providerProfileId: "99999999-9999-4999-8999-999999999999",
      model: "image-model",
      status: "queued" as const,
      attempts: 0,
      maxAttempts: 3,
      size: "1024x1024",
      aspectRatio: "1:1",
      quality: "auto" as const,
      outputFormat: "png" as const,
      assetId: null,
      assetUrl: "",
      providerType: "openai_compatible",
      generationRevision: 0,
      remoteJobId: null,
      providerStatus: null,
      providerProgress: null,
      providerQueuePosition: null,
      providerEtaAt: null,
      submittedAt: null,
      lastPolledAt: null,
      nextPollAt: null,
      generationDeadline: null,
      errorCode: null,
      errorMessage: null,
      createdAt: "2026-08-04T12:00:00.000Z",
      updatedAt: "2026-08-04T12:00:00.000Z",
      completedAt: null
    });
    const queuedImageJob = Object.freeze({ ...imageJob, duplicate: false });
    const streamingConfig = Object.freeze({
      ...configResult,
      campaignImageProviderProfileId: null,
      campaignTextProviderProfileId: null
    });
    const segmentSet = Object.freeze({ setId, duplicate: false, segmentCount: 2 });
    const backfillPreview = Object.freeze({
      campaignId,
      mode: "missing" as const,
      turnCount: 1,
      segmentCount: 2,
      imageCount: 2,
      providerRequestCount: 2,
      refinementCallCount: 0,
      configUpdatedAt: "2026-08-04T12:00:00.000Z",
      totalCampaignTurns: 1,
      settings: Object.freeze({
        segmentWordCount: 500,
        imagesPerSegment: 1,
        segmentPromptMode: "direct" as const
      })
    });
    const backfill = Object.freeze({
      id: jobId,
      status: "completed",
      turnCount: 1,
      segmentCount: 2,
      imageCount: 2,
      queuedSets: 1,
      duplicate: false
    });
    const resolution = Object.freeze({ id: jobId, campaignId, turnId, status: "completed", candidates: [] });

    const config: IllustrationConfigRepository = {
      getIllustrationConfig: async (...args) => {
        calls.push({ method: "getIllustrationConfig", args });
        return configResult;
      },
      setIllustrationConfig: async (...args) => {
        calls.push({ method: "setIllustrationConfig", args });
        return configResult;
      }
    };
    const jobs: IllustrationJobRepository = {
      enqueueWorldCover: async (...args) => {
        calls.push({ method: "enqueueWorldCover", args });
        return queuedImageJob;
      },
      getLatestWorldCoverJob: async (...args) => {
        calls.push({ method: "getLatestWorldCoverJob", args });
        return imageJob;
      },
      enqueueAcceptedTurnIllustration: async (...args) => {
        calls.push({ method: "enqueueAcceptedTurnIllustration", args });
        return jobId;
      },
      enqueueIllustration: async (...args) => {
        calls.push({ method: "enqueueIllustration", args });
        return queuedImageJob;
      },
      getImageJob: async (...args) => {
        calls.push({ method: "getImageJob", args });
        return imageJob;
      },
      listCampaignImageJobs: async (...args) => {
        calls.push({ method: "listCampaignImageJobs", args });
        return [imageJob];
      },
      retryImageJob: async (...args) => {
        calls.push({ method: "retryImageJob", args });
        return imageJob;
      }
    };
    const segments: IllustrationSegmentRepository = {
      generateTurnIllustrationSegments: async (...args) => {
        calls.push({ method: "generateTurnIllustrationSegments", args });
        return segmentSet;
      },
      enqueueAcceptedTurnIllustrationSegments: async (...args) => {
        calls.push({ method: "enqueueAcceptedTurnIllustrationSegments", args });
        return segmentSet;
      },
      previewIllustrationBackfill: async (...args) => {
        calls.push({ method: "previewIllustrationBackfill", args });
        return backfillPreview;
      },
      enqueueIllustrationBackfill: async (...args) => {
        calls.push({ method: "enqueueIllustrationBackfill", args });
        return backfill;
      },
      listCampaignIllustrationSegments: async (...args) => {
        calls.push({ method: "listCampaignIllustrationSegments", args });
        return { segments: [] };
      },
      regenerateSegmentIllustration: async (...args) => {
        calls.push({ method: "regenerateSegmentIllustration", args });
        return { id: jobId, duplicate: false, segmentId, variantIndex: 0, status: "queued" };
      },
      removeSegmentIllustrationVariant: async (...args) => {
        calls.push({ method: "removeSegmentIllustrationVariant", args });
        return { segmentId, variantIndex: 0, removedAssetId: jobId, retainedInLibrary: true };
      }
    };
    const resolutions: IllustrationResolutionRepository = {
      getTurnIllustrationResolution: async (...args) => {
        calls.push({ method: "getTurnIllustrationResolution", args });
        return resolution;
      },
      rematchTurnIllustration: async (...args) => {
        calls.push({ method: "rematchTurnIllustration", args });
        return { id: jobId, status: "queued" };
      }
    };
    const streaming: IllustrationStreamingRepository = {
      loadStreamingIllustrationConfig: async (...args) => {
        calls.push({ method: "loadStreamingIllustrationConfig", args });
        return streamingConfig;
      },
      createProvisionalSet: async (...args) => {
        calls.push({ method: "createProvisionalSet", args });
        return setId;
      },
      createProvisionalSegment: async (...args) => {
        calls.push({ method: "createProvisionalSegment", args });
        return true;
      },
      promoteProvisionalSet: async (...args) => {
        calls.push({ method: "promoteProvisionalSet", args });
      },
      orphanProvisionalSet: async (...args) => {
        calls.push({ method: "orphanProvisionalSet", args });
      }
    };
    const application = createIllustrationApplication({
      config,
      jobs,
      segments,
      resolutions,
      streaming
    });

    const campaignScope = Object.freeze({ ownerUserId, campaignId });
    const worldScope = Object.freeze({ ownerUserId, worldId });
    const turnScope = Object.freeze({ ownerUserId, campaignId, turnId });
    const jobScope = Object.freeze({ ownerUserId, jobId });
    const segmentScope = Object.freeze({ ownerUserId, campaignId, turnId, segmentId });
    const generationScope = Object.freeze({ ownerUserId, campaignId, generationJobId });
    const provisionalSegmentScope = Object.freeze({ ...generationScope, setId });
    const promotedScope = Object.freeze({ ...generationScope, turnId });
    const illustrationConfig = Object.freeze({ ...configResult }) as IllustrationConfig;
    const coverRequest = Object.freeze({ replace: false }) as WorldCoverRequest;
    const illustrationRequest = Object.freeze({ replace: false }) as IllustrationRequest;
    const segmentRequest = Object.freeze({ mode: "missing" }) as IllustrationSegmentRequest;
    const segmentImageRequest = Object.freeze({ prompt: "Moonlit observatory", variantIndex: 0 }) as IllustrationSegmentImageRequest;
    const previewRequest = Object.freeze({ mode: "missing" }) as IllustrationBackfillPreview;
    const backfillRequest = Object.freeze({
      ...previewRequest,
      idempotencyKey: "backfill-request-0001",
      expectedConfigUpdatedAt: "2026-08-04T12:00:00.000Z",
      expectedTurnCount: 1
    }) as IllustrationBackfillRequest;
    const segment = Object.freeze({
      ordinal: 0,
      startOffset: 0,
      endOffset: 20,
      startWord: 0,
      endWord: 3,
      wordCount: 3,
      text: "Moonlight fills the observatory."
    });

    await expect(application.getIllustrationConfig(campaignScope)).resolves.toBe(configResult);
    await expect(application.setIllustrationConfig(campaignScope, illustrationConfig)).resolves.toBe(configResult);
    await expect(application.enqueueWorldCover(worldScope, coverRequest)).resolves.toBe(queuedImageJob);
    await expect(application.getLatestWorldCoverJob(worldScope)).resolves.toBe(imageJob);
    await expect(application.enqueueAcceptedTurnIllustration(turnScope, { imagePrompt: "Moonlit observatory" })).resolves.toBe(jobId);
    await expect(application.enqueueIllustration(turnScope, illustrationRequest)).resolves.toBe(queuedImageJob);
    await expect(application.getImageJob(jobScope)).resolves.toBe(imageJob);
    await expect(application.listCampaignImageJobs(campaignScope)).resolves.toEqual([imageJob]);
    await expect(application.retryImageJob(jobScope)).resolves.toBe(imageJob);
    await expect(application.generateTurnIllustrationSegments(turnScope, segmentRequest)).resolves.toBe(segmentSet);
    await expect(application.enqueueAcceptedTurnIllustrationSegments(turnScope)).resolves.toBe(segmentSet);
    await expect(application.previewIllustrationBackfill(campaignScope, previewRequest)).resolves.toBe(backfillPreview);
    await expect(application.enqueueIllustrationBackfill(campaignScope, backfillRequest)).resolves.toBe(backfill);
    await expect(application.listCampaignIllustrationSegments(campaignScope)).resolves.toEqual({ segments: [] });
    await expect(application.regenerateSegmentIllustration(segmentScope, segmentImageRequest)).resolves.toMatchObject({ id: jobId });
    await expect(application.removeSegmentIllustrationVariant(segmentScope, 0)).resolves.toMatchObject({ removedAssetId: jobId });
    await expect(application.getTurnIllustrationResolution(turnScope)).resolves.toBe(resolution);
    await expect(application.rematchTurnIllustration(turnScope)).resolves.toEqual({ id: jobId, status: "queued" });
    await expect(application.loadStreamingIllustrationConfig(campaignScope)).resolves.toBe(streamingConfig);
    await expect(application.createProvisionalSet(generationScope, { visualReference: "silver cloak" })).resolves.toBe(setId);
    await expect(application.createProvisionalSegment(provisionalSegmentScope, {
      segment,
      config: streamingConfig,
      visualReference: "silver cloak"
    })).resolves.toBe(true);
    await expect(application.promoteProvisionalSet(promotedScope, {
      finalNarration: segment.text,
      config: streamingConfig,
      visualReference: "silver cloak"
    })).resolves.toBeUndefined();
    await expect(application.orphanProvisionalSet(generationScope)).resolves.toBeUndefined();

    expect(calls).toEqual([
      { method: "getIllustrationConfig", args: [campaignScope] },
      { method: "setIllustrationConfig", args: [campaignScope, illustrationConfig] },
      { method: "enqueueWorldCover", args: [worldScope, coverRequest] },
      { method: "getLatestWorldCoverJob", args: [worldScope] },
      { method: "enqueueAcceptedTurnIllustration", args: [turnScope, { imagePrompt: "Moonlit observatory" }] },
      { method: "enqueueIllustration", args: [turnScope, illustrationRequest] },
      { method: "getImageJob", args: [jobScope] },
      { method: "listCampaignImageJobs", args: [campaignScope] },
      { method: "retryImageJob", args: [jobScope] },
      { method: "generateTurnIllustrationSegments", args: [turnScope, segmentRequest] },
      { method: "enqueueAcceptedTurnIllustrationSegments", args: [turnScope] },
      { method: "previewIllustrationBackfill", args: [campaignScope, previewRequest] },
      { method: "enqueueIllustrationBackfill", args: [campaignScope, backfillRequest] },
      { method: "listCampaignIllustrationSegments", args: [campaignScope] },
      { method: "regenerateSegmentIllustration", args: [segmentScope, segmentImageRequest] },
      { method: "removeSegmentIllustrationVariant", args: [segmentScope, 0] },
      { method: "getTurnIllustrationResolution", args: [turnScope] },
      { method: "rematchTurnIllustration", args: [turnScope] },
      { method: "loadStreamingIllustrationConfig", args: [campaignScope] },
      { method: "createProvisionalSet", args: [generationScope, { visualReference: "silver cloak" }] },
      { method: "createProvisionalSegment", args: [provisionalSegmentScope, {
        segment,
        config: streamingConfig,
        visualReference: "silver cloak"
      }] },
      { method: "promoteProvisionalSet", args: [promotedScope, {
        finalNarration: segment.text,
        config: streamingConfig,
        visualReference: "silver cloak"
      }] },
      { method: "orphanProvisionalSet", args: [generationScope] }
    ]);
  });

  test("keeps the worker application separate and exposes one illustration lane operation", async () => {
    const calls: unknown[] = [];
    const executor: IllustrationWorkerExecutor = {
      runNextIllustration: async (request) => {
        calls.push(request);
        return true;
      }
    };
    const application = createIllustrationWorkerApplication(executor);
    const request = Object.freeze({ workerId: "worker-a", leaseSeconds: 30 });

    await expect(application.runNextIllustration(request)).resolves.toBe(true);
    expect(calls).toEqual([request]);
  });

  test("requires owner-scoped resource inputs and keeps text refinement distinct from image execution", () => {
    if (false) {
      // @ts-expect-error campaign operations require server-resolved ownership.
      void typeOnlyApplication.getIllustrationConfig({ campaignId });
      // @ts-expect-error turn operations require campaign and owner scope.
      void typeOnlyApplication.getTurnIllustrationResolution({ turnId });
      // @ts-expect-error image jobs require owner scope.
      void typeOnlyApplication.getImageJob({ jobId });
      // @ts-expect-error segment commands require campaign, turn, and owner scope.
      void typeOnlyApplication.removeSegmentIllustrationVariant({ segmentId }, 0);
    }

    expectTypeOf<Parameters<IllustrationApplication["getIllustrationConfig"]>[0]>()
      .toMatchTypeOf<Readonly<{ ownerUserId: string; campaignId: string }>>();
    expectTypeOf<Parameters<IllustrationApplication["getLatestWorldCoverJob"]>[0]>()
      .toMatchTypeOf<Readonly<{ ownerUserId: string; worldId: string }>>();
    expectTypeOf<Parameters<IllustrationApplication["getTurnIllustrationResolution"]>[0]>()
      .toMatchTypeOf<Readonly<{ ownerUserId: string; campaignId: string; turnId: string }>>();
    expectTypeOf<Parameters<IllustrationApplication["getImageJob"]>[0]>()
      .toMatchTypeOf<Readonly<{ ownerUserId: string; jobId: string }>>();
    expectTypeOf<Awaited<ReturnType<IllustrationStreamingRepository["loadStreamingIllustrationConfig"]>>>()
      .toMatchTypeOf<Readonly<{
        campaignImageProviderProfileId: string | null;
        campaignTextProviderProfileId: string | null;
      }>>();

    const imagePort: IllustrationImageProviderPort = {
      executeImage: async (request) => ({
        providerRole: "image",
        providerProfileId: request.providerProfileId,
        model: request.model,
        artifacts: [],
        metadata: {}
      })
    };
    const refinementPort: IllustrationPromptRefinementPort = {
      refinePrompt: async (request) => ({
        providerRole: "text",
        providerProfileId: request.providerProfileId,
        model: request.model,
        prompt: request.fictionText,
        metadata: {}
      })
    };
    const provisionalRefinement: Parameters<IllustrationPromptRefinementPort["refinePrompt"]>[0] = {
      ownerUserId,
      campaignId,
      turnId: null,
      segmentId,
      providerProfileId: "99999999-9999-4999-8999-999999999999",
      model: "text-model",
      fictionText: "Moonlight fills the observatory.",
      storyContext: "A quiet night."
    };
    const provisionalBinding: Parameters<IllustrationAssetPort["bindSegmentAsset"]>[0] = {
      ownerUserId,
      campaignId,
      turnId: null,
      segmentId,
      imageJobId: jobId,
      assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      variantIndex: 0
    };
    const provisionalAsset: Parameters<IllustrationAssetPort["persistTurnIllustration"]>[0] = {
      ownerUserId,
      campaignId,
      turnId: null,
      imageJobId: jobId,
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png"
    };
    expectTypeOf(imagePort).not.toEqualTypeOf(refinementPort);
    expect(provisionalRefinement.turnId).toBeNull();
    expect(provisionalBinding.turnId).toBeNull();
    expect(provisionalAsset.turnId).toBeNull();
  });
});
