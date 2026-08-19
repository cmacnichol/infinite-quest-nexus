import { describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import type { IllustrationApi } from "../../packages/client-web/src/illustration-api.js";
import type {
  IllustrationConfigResponse,
  IllustrationSegmentsResponse
} from "../../packages/contracts/src/illustration-client.js";
import { createStoryIllustrationController } from "../../apps/web-next/src/story-player-illustrations.js";
import { renderIllustrationWing } from "../../apps/web-next/src/story-player-view.js";

const campaignId = "11111111-1111-4111-8111-111111111111";
const turnId = "22222222-2222-4222-8222-222222222222";
const anotherTurnId = "33333333-3333-4333-8333-333333333333";
const segmentId = "44444444-4444-4444-8444-444444444444";
const imageJobId = "55555555-5555-4555-8555-555555555555";

function config(overrides: Partial<IllustrationConfigResponse> = {}): IllustrationConfigResponse {
  return {
    enabled: true,
    sourcePolicy: "library_then_generate",
    matchingScope: "campaign",
    confidenceProfile: "balanced",
    repetitionWindow: 3,
    providerProfileId: null,
    model: "illustrator",
    size: "1024x1024",
    aspectRatio: "1:1",
    quality: "standard",
    outputFormat: "png",
    maxAttempts: 3,
    segmentWordCount: 300,
    imagesPerSegment: 2,
    segmentPromptMode: "direct",
    refinementPrompt: "Refine this image.",
    defaultRefinementPrompt: "Refine this image.",
    updatedAt: null,
    ...overrides
  };
}

function segments(turn = turnId, overrides: Record<string, unknown> = {}): IllustrationSegmentsResponse {
  return {
    segments: [{
      setId: "66666666-6666-4666-8666-666666666666",
      turnId: turn,
      setStatus: "completed",
      segmentWordCount: 300,
      imagesPerSegment: 2,
      promptMode: "direct",
      id: segmentId,
      ordinal: 0,
      startOffset: 0,
      endOffset: 24,
      startWord: 0,
      endWord: 4,
      text: "Rain crossed the observatory roof.",
      status: "completed",
      promptSource: "direct",
      directPrompt: "Rainy observatory",
      resolvedPrompt: "Rainy observatory",
      variants: [
        {
          assetId: "77777777-7777-4777-8777-777777777777",
          url: "/assets/one.png",
          variantIndex: 0,
          prompt: "Rainy observatory",
          providerType: "image",
          model: "illustrator",
          createdAt: "2026-08-18T00:00:00.000Z",
          selectionReason: null,
          matchScore: null,
          matchThreshold: null,
          matchingAlgorithm: null
        },
        {
          assetId: "88888888-8888-4888-8888-888888888888",
          url: "/assets/two.png",
          variantIndex: 1,
          prompt: "Rainy observatory at dawn",
          providerType: "image",
          model: "illustrator",
          createdAt: "2026-08-18T00:00:00.000Z",
          selectionReason: null,
          matchScore: null,
          matchThreshold: null,
          matchingAlgorithm: null
        }
      ],
      imageJobId,
      imageJobStatus: "failed",
      providerStatus: "completed",
      providerProgress: 100,
      errorMessage: null,
      promptJobStatus: null,
      ...overrides
    }]
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function illustrationApi(overrides: Partial<IllustrationApi> = {}): IllustrationApi {
  return {
    config: vi.fn().mockResolvedValue(config()),
    segments: vi.fn().mockResolvedValue(segments()),
    imageJobs: vi.fn().mockResolvedValue({ jobs: [] }),
    retryImageJob: vi.fn().mockResolvedValue({}),
    regenerateSegmentImage: vi.fn().mockResolvedValue({}),
    generateTurnSegments: vi.fn().mockResolvedValue({}),
    resolution: vi.fn().mockResolvedValue(null),
    rematch: vi.fn().mockResolvedValue({}),
    ...overrides
  } as unknown as IllustrationApi;
}

function controller(api: IllustrationApi) {
  return createStoryIllustrationController({
    illustrations: api,
    idFactory: { create: () => "99999999-9999-4999-8999-999999999999" },
    clock: { now: () => 0 },
    delay: { wait: vi.fn().mockResolvedValue(undefined) }
  });
}

describe("StoryIllustrationController", () => {
  it("does not request segments when illustrations are disabled", async () => {
    const api = illustrationApi({ config: vi.fn().mockResolvedValue(config({ enabled: false })) });
    const subject = controller(api);

    await subject.load(campaignId, turnId);

    expect(api.segments).not.toHaveBeenCalled();
    expect(subject.get().status).toBe("disabled");
    expect(subject.get().segments).toEqual([]);
  });

  it.each([
    ["disabled", config({ enabled: false })],
    ["source policy off", config({ sourcePolicy: "off" })]
  ] as const)("does not call illustration endpoints when %s", async (_, configuration) => {
    const api = illustrationApi({ config: vi.fn().mockResolvedValue(configuration) });
    const subject = controller(api);

    await subject.load(campaignId, turnId);
    subject.selectNext();
    await subject.editPrompt("Do not send this prompt.");
    await subject.regenerate();
    await subject.retryJob();
    await subject.generateMissing();
    await subject.rebuild();
    await subject.loadProvenance();
    await subject.rematch();

    expect(api.segments).not.toHaveBeenCalled();
    expect(api.regenerateSegmentImage).not.toHaveBeenCalled();
    expect(api.retryImageJob).not.toHaveBeenCalled();
    expect(api.generateTurnSegments).not.toHaveBeenCalled();
    expect(api.resolution).not.toHaveBeenCalled();
    expect(api.rematch).not.toHaveBeenCalled();
  });

  it("keeps controller-level endpoint failures local and renders an empty ready turn", async () => {
    const unavailable = controller(illustrationApi({ config: vi.fn().mockRejectedValue(new Error("offline")) }));
    await unavailable.load(campaignId, turnId);
    expect(unavailable.get().status).toBe("unavailable");

    const empty = controller(illustrationApi({ segments: vi.fn().mockResolvedValue({ segments: [] }) }));
    await empty.load(campaignId, turnId);
    empty.selectPrevious();
    empty.selectNext();
    expect(empty.get().status).toBe("ready");
    expect(empty.get().selectedVariant).toBeNull();
  });

  it("keeps one available variant selected when image navigation wraps", async () => {
    const response = segments();
    response.segments[0]!.variants = response.segments[0]!.variants.slice(0, 1);
    const subject = controller(illustrationApi({ segments: vi.fn().mockResolvedValue(response) }));

    await subject.load(campaignId, turnId);
    subject.selectNext();
    subject.selectPrevious();

    expect(subject.get().selectedVariant?.url).toBe("/assets/one.png");
  });

  it("keeps image navigation and image actions scoped to the selected accepted turn", async () => {
    const api = illustrationApi({ resolution: vi.fn().mockResolvedValue({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "matched" }) });
    const subject = controller(api);

    await subject.load(campaignId, turnId);
    subject.selectNext();
    await subject.editPrompt("Dawn above the observatory.");
    await subject.regenerate();
    await subject.retryJob();
    await subject.generateMissing();
    await subject.rebuild();
    await subject.loadProvenance();
    expect(subject.get().provenance?.status).toBe("matched");
    await subject.rematch();

    expect(subject.get().selectedVariant?.url).toBe("/assets/two.png");
    expect(api.regenerateSegmentImage).toHaveBeenCalledWith(segmentId, { prompt: "Dawn above the observatory.", variantIndex: 1 }, expect.any(AbortSignal));
    expect(api.retryImageJob).toHaveBeenCalledWith(imageJobId, expect.any(AbortSignal));
    expect(api.generateTurnSegments).toHaveBeenNthCalledWith(1, turnId, { mode: "missing", idempotencyKey: "99999999-9999-4999-8999-999999999999" }, expect.any(AbortSignal));
    expect(api.generateTurnSegments).toHaveBeenNthCalledWith(2, turnId, { mode: "rebuild", idempotencyKey: "99999999-9999-4999-8999-999999999999" }, expect.any(AbortSignal));
    expect(api.resolution).toHaveBeenCalledWith(turnId, expect.any(AbortSignal));
    expect(api.rematch).toHaveBeenCalledWith(turnId, expect.any(AbortSignal));
  });

  it.each([
    ["library_only", false, true],
    ["library_then_generate", true, true],
    ["generate_only", true, false]
  ] as const)("enforces %s source-policy capabilities in both the controller and rendered actions", async (sourcePolicy, canGenerate, canMatch) => {
    const api = illustrationApi({ config: vi.fn().mockResolvedValue(config({ sourcePolicy })) });
    const subject = controller(api);
    await subject.load(campaignId, turnId);

    await subject.regenerate();
    await subject.retryJob();
    await subject.generateMissing();
    await subject.rebuild();
    await subject.loadProvenance();
    await subject.rematch();

    expect(api.regenerateSegmentImage).toHaveBeenCalledTimes(canGenerate ? 1 : 0);
    expect(api.retryImageJob).toHaveBeenCalledTimes(canGenerate ? 1 : 0);
    expect(api.generateTurnSegments).toHaveBeenCalledTimes(canGenerate ? 2 : 0);
    expect(api.resolution).toHaveBeenCalledTimes(canMatch ? 1 : 0);
    expect(api.rematch).toHaveBeenCalledTimes(canMatch ? 1 : 0);

    const { document } = parseHTML("<body></body>").window;
    const wing = renderIllustrationWing(document, subject.get());
    expect(wing.querySelector("[data-action='regenerate-image']") !== null).toBe(canGenerate);
    expect(wing.querySelector("[data-action='generate-missing-images']") !== null).toBe(canGenerate);
    expect(wing.querySelector("[data-action='rebuild-images']") !== null).toBe(canGenerate);
    expect(wing.querySelector("[data-action='load-image-provenance']") !== null).toBe(canMatch);
    expect(wing.querySelector("[data-action='rematch-image']") !== null).toBe(canMatch);
  });

  it("locks illustration mutations to one in-flight intent and publishes disabled busy controls", async () => {
    const pending = deferred<unknown>();
    const idFactory = { create: vi.fn().mockReturnValue("99999999-9999-4999-8999-999999999999") };
    const api = illustrationApi({ generateTurnSegments: vi.fn().mockReturnValue(pending.promise) });
    const subject = createStoryIllustrationController({
      illustrations: api,
      idFactory,
      clock: { now: () => 0 },
      delay: { wait: vi.fn().mockResolvedValue(undefined) }
    });
    await subject.load(campaignId, turnId);

    const first = subject.generateMissing();
    const duplicate = subject.generateMissing();

    expect(api.generateTurnSegments).toHaveBeenCalledTimes(1);
    expect(idFactory.create).toHaveBeenCalledTimes(1);
    expect(subject.get().pendingAction).toBe("generate_missing");
    const { document } = parseHTML("<body></body>").window;
    const wing = renderIllustrationWing(document, subject.get());
    const mutationButtons = [...wing.querySelectorAll<HTMLButtonElement>("button[data-action]")]
      .filter((button) => button.dataset.action !== "previous-image" && button.dataset.action !== "next-image");
    expect(mutationButtons.every((button) => button.disabled)).toBe(true);

    pending.resolve({});
    await Promise.all([first, duplicate]);
    expect(subject.get().pendingAction).toBeNull();
  });

  it("ignores stale loads and does not publish after disposal", async () => {
    let resolveFirstConfig!: (value: IllustrationConfigResponse) => void;
    const firstConfig = new Promise<IllustrationConfigResponse>((resolve) => { resolveFirstConfig = resolve; });
    const api = illustrationApi({
      config: vi.fn().mockReturnValueOnce(firstConfig).mockResolvedValue(config()),
      segments: vi.fn().mockResolvedValueOnce(segments(anotherTurnId))
    });
    const subject = controller(api);

    const first = subject.load(campaignId, turnId);
    const second = subject.load(campaignId, anotherTurnId);
    await second;
    resolveFirstConfig(config());
    await first;

    expect(subject.get().turnId).toBe(anotherTurnId);
    expect(subject.get().segments[0]?.turnId).toBe(anotherTurnId);
    subject.dispose();
    await subject.load(campaignId, turnId);
    expect(subject.get().turnId).toBe(anotherTurnId);
  });

  it("ignores abort-ignoring provenance and rejects concurrent actions after a campaign and turn switch", async () => {
    const pendingProvenance = deferred<unknown>();
    const otherCampaignId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const api = illustrationApi({
      segments: vi.fn().mockResolvedValueOnce(segments(turnId)).mockResolvedValueOnce(segments(anotherTurnId)),
      resolution: vi.fn().mockReturnValue(pendingProvenance.promise),
      regenerateSegmentImage: vi.fn()
    });
    const subject = controller(api);

    await subject.load(campaignId, turnId);
    const provenance = subject.loadProvenance();
    const regeneration = subject.regenerate();
    await subject.load(otherCampaignId, anotherTurnId);
    pendingProvenance.resolve({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", status: "stale" });
    await Promise.all([provenance, regeneration]);

    expect(subject.get().campaignId).toBe(otherCampaignId);
    expect(subject.get().turnId).toBe(anotherTurnId);
    expect(subject.get().provenance).toBeNull();
    expect(subject.get().status).toBe("ready");
    expect(api.regenerateSegmentImage).not.toHaveBeenCalled();
  });

  it("runs one poller for active work and stops it once the visible job is terminal", async () => {
    const wait = deferred<void>();
    const delay = { wait: vi.fn().mockReturnValue(wait.promise) };
    const api = illustrationApi({
      segments: vi.fn()
        .mockResolvedValueOnce(segments(turnId, { imageJobStatus: "generating", status: "generating" }))
        .mockResolvedValueOnce(segments(turnId))
    });
    const subject = createStoryIllustrationController({ illustrations: api, idFactory: { create: () => "99999999-9999-4999-8999-999999999999" }, clock: { now: () => 0 }, delay });

    await subject.load(campaignId, turnId);
    expect(delay.wait).toHaveBeenCalledTimes(1);
    wait.resolve();
    await settle();

    expect(api.segments).toHaveBeenCalledTimes(2);
    expect(delay.wait).toHaveBeenCalledTimes(1);
  });

  it.each(["failed", "expired"] as const)("does not poll a terminal %s image job", async (imageJobStatus) => {
    const wait = deferred<void>();
    const delay = { wait: vi.fn().mockReturnValue(wait.promise) };
    const api = illustrationApi({
      segments: vi.fn().mockResolvedValue(segments(turnId, { imageJobStatus, status: "completed" }))
    });
    const subject = createStoryIllustrationController({ illustrations: api, idFactory: { create: () => "99999999-9999-4999-8999-999999999999" }, clock: { now: () => 0 }, delay });

    await subject.load(campaignId, turnId);

    expect(subject.get().status).toBe("ready");
    expect(api.segments).toHaveBeenCalledTimes(1);
    expect(delay.wait).not.toHaveBeenCalled();
  });

  it("does not poll an unknown normalized lifecycle state", async () => {
    const delay = { wait: vi.fn().mockResolvedValue(undefined) };
    const api = illustrationApi({
      segments: vi.fn().mockResolvedValue(segments(turnId, {
        setStatus: "unknown",
        status: "unknown",
        imageJobStatus: "unknown",
        promptJobStatus: "unknown"
      }))
    });
    const subject = createStoryIllustrationController({
      illustrations: api,
      idFactory: { create: () => "99999999-9999-4999-8999-999999999999" },
      clock: { now: () => 0 },
      delay
    });

    await subject.load(campaignId, turnId);

    expect(delay.wait).not.toHaveBeenCalled();
  });

  it("polls a recoverable image job until it becomes terminal", async () => {
    const wait = deferred<void>();
    const delay = { wait: vi.fn().mockReturnValue(wait.promise) };
    const api = illustrationApi({
      segments: vi.fn()
        .mockResolvedValueOnce(segments(turnId, { imageJobStatus: "recoverable", status: "completed" }))
        .mockResolvedValueOnce(segments(turnId, { imageJobStatus: "failed", status: "completed" }))
    });
    const subject = createStoryIllustrationController({ illustrations: api, idFactory: { create: () => "99999999-9999-4999-8999-999999999999" }, clock: { now: () => 0 }, delay });

    await subject.load(campaignId, turnId);
    expect(delay.wait).toHaveBeenCalledTimes(1);
    wait.resolve();
    await settle();

    expect(api.segments).toHaveBeenCalledTimes(2);
    expect(delay.wait).toHaveBeenCalledTimes(1);
  });

  it("aborts in-flight polling on disposal without issuing another image request", async () => {
    const wait = deferred<void>();
    let pollingSignal: AbortSignal | undefined;
    const delay = { wait: vi.fn((_: number, signal: AbortSignal) => { pollingSignal = signal; return wait.promise; }) };
    const api = illustrationApi({ segments: vi.fn().mockResolvedValue(segments(turnId, { imageJobStatus: "generating", status: "generating" })) });
    const subject = createStoryIllustrationController({ illustrations: api, idFactory: { create: () => "99999999-9999-4999-8999-999999999999" }, clock: { now: () => 0 }, delay });

    await subject.load(campaignId, turnId);
    subject.dispose();
    wait.resolve();
    await settle();

    expect(pollingSignal?.aborted).toBe(true);
    expect(api.segments).toHaveBeenCalledTimes(1);
  });

  it("aborts stale polling before a campaign switch can overwrite the new turn", async () => {
    const wait = deferred<void>();
    let pollingSignal: AbortSignal | undefined;
    const delay = { wait: vi.fn((_: number, signal: AbortSignal) => { pollingSignal = signal; return wait.promise; }) };
    const api = illustrationApi({
      segments: vi.fn()
        .mockResolvedValueOnce(segments(turnId, { imageJobStatus: "generating", status: "generating" }))
        .mockResolvedValueOnce(segments(anotherTurnId))
    });
    const subject = createStoryIllustrationController({ illustrations: api, idFactory: { create: () => "99999999-9999-4999-8999-999999999999" }, clock: { now: () => 0 }, delay });

    await subject.load(campaignId, turnId);
    await subject.load("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", anotherTurnId);
    wait.resolve();
    await settle();

    expect(pollingSignal?.aborted).toBe(true);
    expect(subject.get().turnId).toBe(anotherTurnId);
    expect(subject.get().segments[0]?.turnId).toBe(anotherTurnId);
    expect(api.segments).toHaveBeenCalledTimes(2);
  });
});
