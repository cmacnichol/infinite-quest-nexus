import { describe, expect, it } from "vitest";
import {
  illustrationConfigResponseSchema,
  illustrationSegmentsResponseSchema,
  imageJobsResponseSchema
} from "../../packages/contracts/src/index.js";

const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";
const TURN_ID = "22222222-2222-4222-8222-222222222222";
const SEGMENT_ID = "33333333-3333-4333-8333-333333333333";
const JOB_ID = "44444444-4444-4444-8444-444444444444";
const SET_ID = "55555555-5555-4555-8555-555555555555";
const NOW = "2026-08-02T12:00:00.000Z";

const persistedSegment = {
  setId: SET_ID,
  turnId: TURN_ID,
  setStatus: "queued",
  segmentWordCount: 500,
  imagesPerSegment: 2,
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
  variants: [{
    assetId: "66666666-6666-4666-8666-666666666666",
    url: "/assets/quiet-road.png",
    variantIndex: 1,
    prompt: "A quiet road",
    providerType: null,
    model: null,
    createdAt: NOW,
    selectionReason: null,
    matchScore: null,
    matchThreshold: null,
    matchingAlgorithm: null
  }],
  imageJobId: JOB_ID,
  imageJobStatus: "queued",
  providerStatus: null,
  providerProgress: null,
  errorMessage: null,
  promptJobStatus: null
};

const imageJob = {
  id: JOB_ID,
  campaignId: CAMPAIGN_ID,
  turnId: TURN_ID,
  worldId: null,
  targetType: "turn_illustration",
  segmentId: SEGMENT_ID,
  generationJobId: null,
  imageCount: 2,
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
  providerProgress: 0.5,
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

describe("illustration client contracts", () => {
  it("accepts persisted segments and configuration with the supported illustration cardinality", () => {
    const config = illustrationConfigResponseSchema.safeParse({
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
      imagesPerSegment: 2,
      segmentPromptMode: "direct",
      refinementPrompt: "Refine safely.",
      defaultRefinementPrompt: "Refine safely.",
      updatedAt: null
    });
    const segments = illustrationSegmentsResponseSchema.safeParse({ segments: [persistedSegment] });

    expect(config.success).toBe(true);
    expect(segments.success).toBe(true);
  });

  it("rejects malformed image-job UUIDs, timestamps, and provider progress", () => {
    expect(imageJobsResponseSchema.safeParse({ jobs: [imageJob] }).success).toBe(true);
    expect(imageJobsResponseSchema.safeParse({ jobs: [{ ...imageJob, id: "not-a-uuid" }] }).success).toBe(false);
    expect(imageJobsResponseSchema.safeParse({ jobs: [{ ...imageJob, createdAt: "not-a-timestamp" }] }).success).toBe(false);
    expect(imageJobsResponseSchema.safeParse({ jobs: [{ ...imageJob, providerProgress: "not-a-number" }] }).success).toBe(false);
  });
});
