import { ApiError, type SogniClient } from "@sogni-ai/sogni-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelSogniSdkGeneration,
  discoverSogniSdkModels,
  pollSogniSdkGeneration,
  setSogniSdkClientFactoryForTests,
  submitSogniSdkGeneration
} from "../../packages/story-engine/src/providers/illustration/sogni-sdk/index.js";
import type { TextProviderProfile } from "../../packages/story-engine/src/providers.js";

const profile: TextProviderProfile = {
  providerType: "sogni_sdk",
  baseUrl: "https://api.sogni.ai",
  model: "flux-test",
  contextWindowTokens: 32_768,
  maxOutputTokens: 4_096,
  temperature: 0.8,
  apiKey: "test-api-key",
  configuration: {
    network: "relaxed",
    tokenType: "spark",
    contentFilter: "disabled",
    defaultSizePreset: "custom",
    defaultSteps: 8,
    defaultGuidance: 3.5,
    defaultSeed: 42,
    defaultSampler: "euler",
    defaultScheduler: "normal",
    defaultPreviewCount: 1,
    pollIntervalMs: 1_000
  }
};

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    dispose: vi.fn(),
    projects: {
      trackedProjects: [],
      create: vi.fn(),
      get: vi.fn(),
      cancel: vi.fn(),
      downloadUrl: vi.fn(),
      getAvailableModels: vi.fn(),
      getModelOptions: vi.fn(),
      getSizePresets: vi.fn(),
      ...overrides
    }
  } as unknown as SogniClient;
}

afterEach(() => setSogniSdkClientFactoryForTests());

describe("Sogni Supernet SDK provider", () => {
  it("maps filter and advanced generation controls and reports live progress", async () => {
    const project = {
      id: "project-1", status: "processing", progress: 37, queuePosition: 2,
      eta: new Date(Date.now() + 20_000), resultUrls: [], error: undefined
    };
    const client = fakeClient({ trackedProjects: [project], create: vi.fn().mockResolvedValue(project) });
    setSogniSdkClientFactoryForTests(async () => client);

    await expect(submitSogniSdkGeneration(profile, {
      prompt: "A moonlit fictional citadel.", size: "640x512", aspectRatio: "5:4", quality: "auto",
      outputFormat: "webp", imageCount: 1, idempotencyKey: "job-1:0"
    })).resolves.toMatchObject({ remoteJobId: "project-1", progress: 37, queuePosition: 2 });
    expect(client.projects.create).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "flux-test", width: 640, height: 512, network: "relaxed", tokenType: "spark",
      disableNSFWFilter: true, steps: 8, guidance: 3.5, seed: 42, sampler: "euler",
      scheduler: "normal", numberOfPreviews: 1, outputFormat: "webp"
    }));
    await expect(pollSogniSdkGeneration(profile, "project-1")).resolves.toMatchObject({ status: "pending", progress: 37, queuePosition: 2 });
  });

  it("treats a post-restart 404 as pending and later recovers one terminal artifact", async () => {
    const get = vi.fn()
      .mockRejectedValueOnce(new ApiError(404, { status: "error", errorCode: 0, message: "processing" }))
      .mockResolvedValueOnce({ id: "project-2", status: "completed", completedWorkerJobs: [{ imgID: "image-1", resultUrl: "https://artifacts.test/image.png" }] });
    const client = fakeClient({ get });
    setSogniSdkClientFactoryForTests(async () => client);

    await expect(pollSogniSdkGeneration(profile, "project-2")).resolves.toMatchObject({ status: "pending", providerMetadata: { recoveredAfterRestart: true } });
    await expect(pollSogniSdkGeneration(profile, "project-2")).resolves.toMatchObject({
      status: "completed",
      artifacts: [{ source: "url", url: "https://artifacts.test/image.png" }]
    });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("discovers model-aware controls and cancels by persisted project ID", async () => {
    const client = fakeClient({
      getAvailableModels: vi.fn().mockResolvedValue([{ id: "flux-test", name: "Flux Test", workerCount: 3, media: "image" }]),
      getModelOptions: vi.fn().mockResolvedValue({ type: "image", steps: { min: 1, max: 20, step: 1, default: 8 }, guidance: { min: 0, max: 10, step: 0.5, default: 3.5 }, sampler: { allowed: ["euler"], default: "euler" }, scheduler: { allowed: ["normal"], default: "normal" } }),
      getSizePresets: vi.fn().mockResolvedValue([{ id: "small", label: "Small", width: 512, height: 512, ratio: "1:1" }])
    });
    setSogniSdkClientFactoryForTests(async () => client);

    await expect(discoverSogniSdkModels(profile)).resolves.toEqual([expect.objectContaining({
      id: "flux-test", workerCount: 3,
      imageOptions: expect.objectContaining({ samplers: ["euler"], schedulers: ["normal"], sizePresets: [expect.objectContaining({ id: "small" })] })
    })]);
    await cancelSogniSdkGeneration(profile, "project-3");
    expect(client.projects.cancel).toHaveBeenCalledWith("project-3");
  });
});
