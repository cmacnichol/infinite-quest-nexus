import { describe, expect, it } from "vitest";
import { createLegacyIllustrationApi } from "../../apps/web/src/legacy-illustration-api.js";

const session = { authorization: async () => ({ authorization: "Bearer test" }), onUnauthorized: async () => false };
const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";
const TURN_ID = "22222222-2222-4222-8222-222222222222";
const SEGMENT_ID = "33333333-3333-4333-8333-333333333333";
const JOB_ID = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-08-02T12:00:00.000Z";

const config = {
  enabled: false,
  sourcePolicy: "off",
  matchingScope: "owner_library",
  confidenceProfile: "balanced",
  repetitionWindow: 5,
  providerProfileId: null,
  model: "",
  size: "1024x1024",
  aspectRatio: "1:1",
  quality: "auto",
  outputFormat: "png",
  maxAttempts: 3,
  segmentWordCount: 500,
  imagesPerSegment: 1,
  segmentPromptMode: "direct",
  refinementPrompt: "Refine safely.",
  defaultRefinementPrompt: "Refine safely.",
  updatedAt: null
};

const imageJob = {
  id: JOB_ID,
  campaignId: CAMPAIGN_ID,
  turnId: TURN_ID,
  worldId: null,
  targetType: "turn_illustration",
  segmentId: SEGMENT_ID,
  generationJobId: null,
  imageCount: 1,
  providerProfileId: null,
  model: "image-model",
  status: "queued",
  attempts: 0,
  maxAttempts: 3,
  size: "1024x1024",
  aspectRatio: "1:1",
  quality: "auto",
  outputFormat: "png",
  assetId: null,
  assetUrl: "",
  providerType: null,
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
  createdAt: NOW,
  updatedAt: NOW,
  completedAt: null
};

const segment = {
  setId: "55555555-5555-4555-8555-555555555555",
  turnId: TURN_ID,
  setStatus: "queued",
  segmentWordCount: 500,
  imagesPerSegment: 1,
  promptMode: "direct",
  id: SEGMENT_ID,
  ordinal: 0,
  startOffset: 0,
  endOffset: 12,
  startWord: 0,
  endWord: 2,
  text: "A quiet road.",
  status: "queued",
  promptSource: "direct",
  directPrompt: "A quiet road",
  resolvedPrompt: "A quiet road",
  variants: [],
  imageJobId: JOB_ID,
  imageJobStatus: "queued",
  providerStatus: null,
  providerProgress: null,
  errorMessage: null,
  promptJobStatus: null
};

const resolution = {
  id: "66666666-6666-4666-8666-666666666666",
  campaignId: CAMPAIGN_ID,
  turnId: TURN_ID,
  sourcePolicy: "library_only",
  matchingScope: "world",
  confidenceProfile: "balanced",
  status: "completed",
  selectedAssetId: null,
  selectedScore: null,
  resolvedThreshold: 0.8,
  algorithmVersion: "v1",
  imageJobId: null,
  reasonCode: "no_match",
  createdAt: NOW,
  updatedAt: NOW,
  completedAt: NOW,
  candidates: []
};

describe("legacy illustration API adapter", () => {
  it("maps all eight concrete methods to the allowlist and attaches session headers", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const responses = [
      config,
      { segments: [segment] },
      { jobs: [imageJob] },
      imageJob,
      { id: JOB_ID, duplicate: false, segmentId: SEGMENT_ID, variantIndex: 0, status: "queued" },
      { setId: segment.setId, duplicate: false, segmentCount: 1 },
      resolution,
      { id: resolution.id, status: "queued" }
    ];
    const api = createLegacyIllustrationApi({
      basePath: "/api/v1",
      session,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return new Response(JSON.stringify(responses.shift()), { status: 200 });
      }
    });
    await api.config(CAMPAIGN_ID);
    await api.segments(CAMPAIGN_ID);
    await api.imageJobs(CAMPAIGN_ID);
    await api.retryImageJob(JOB_ID);
    await api.regenerateSegmentImage(SEGMENT_ID, { prompt: "A quiet road", variantIndex: 0 });
    await api.generateTurnSegments(TURN_ID, { mode: "missing", idempotencyKey: JOB_ID });
    await api.resolution(TURN_ID);
    await api.rematch(TURN_ID);
    expect(calls.map(({ url }) => url)).toEqual([
      `/api/v1/campaigns/${CAMPAIGN_ID}/illustration-config`,
      `/api/v1/campaigns/${CAMPAIGN_ID}/illustration-segments`,
      `/api/v1/campaigns/${CAMPAIGN_ID}/image-jobs`,
      `/api/v1/image-jobs/${JOB_ID}/retry`,
      `/api/v1/illustration-segments/${SEGMENT_ID}/images`,
      `/api/v1/turns/${TURN_ID}/illustration-segments`,
      `/api/v1/turns/${TURN_ID}/illustration-resolution`,
      `/api/v1/turns/${TURN_ID}/illustration-match`
    ]);
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer test");
    expect(calls.map(({ init }) => init.method)).toEqual(["GET", "GET", "GET", "POST", "POST", "POST", "GET", "POST"]);
  });

  it("parses the standard error envelope and retains its correlation ID", async () => {
    const api = createLegacyIllustrationApi({
      basePath: "/api/v1",
      session,
      fetchImpl: async () => new Response(JSON.stringify({
        error: "Service unavailable",
        message: "Unavailable",
        correlationId: "corr-envelope",
        details: { code: "image_provider_unavailable" }
      }), {
        status: 503,
        headers: { "x-correlation-id": "corr-header" }
      })
    });
    await expect(api.config(CAMPAIGN_ID)).rejects.toMatchObject({
      message: "Unavailable",
      statusCode: 503,
      correlationId: "corr-envelope",
      domainCode: "image_provider_unavailable"
    });
  });

  it.each([
    "config",
    "segments",
    "imageJobs",
    "retryImageJob",
    "regenerateSegmentImage",
    "generateTurnSegments",
    "resolution",
    "rematch"
  ])("rejects a malformed %s response with correlation context", async (method) => {
    const api = createLegacyIllustrationApi({
      basePath: "/api/v1",
      session,
      fetchImpl: async () => new Response(JSON.stringify({ unexpected: true }), {
        status: 200,
        headers: { "x-correlation-id": "corr-malformed" }
      })
    });
    const invoke = {
      config: () => api.config(CAMPAIGN_ID),
      segments: () => api.segments(CAMPAIGN_ID),
      imageJobs: () => api.imageJobs(CAMPAIGN_ID),
      retryImageJob: () => api.retryImageJob(JOB_ID),
      regenerateSegmentImage: () => api.regenerateSegmentImage(SEGMENT_ID, { prompt: "A quiet road", variantIndex: 0 }),
      generateTurnSegments: () => api.generateTurnSegments(TURN_ID, { mode: "missing", idempotencyKey: JOB_ID }),
      resolution: () => api.resolution(TURN_ID),
      rematch: () => api.rematch(TURN_ID)
    }[method];
    if (!invoke) throw new Error(`Missing test invocation for ${method}.`);
    await expect(invoke()).rejects.toMatchObject({
      name: "ApiContractError",
      kind: "response_schema_mismatch",
      correlationId: "corr-malformed"
    });
  });
});
