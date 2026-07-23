import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { ApiError, SogniClient, type ImageProjectParams, type Project, type RawProject, type SogniClientConfig } from "@sogni-ai/sogni-client";
import type { ImageProviderPollResult, ImageProviderRequest, ImageProviderSubmissionResult, ModelInventoryItem, TextProviderProfile } from "../../../providers.js";
import { SogniProviderError, type NormalizedProviderError } from "../sogni/index.js";

type Session = { client: SogniClient; key: string };
const sessions = new Map<string, Promise<Session>>();
let createClient = (clientConfig: SogniClientConfig) => SogniClient.createInstance(clientConfig);

function providerConfig(profile: TextProviderProfile): Record<string, unknown> {
  return profile.configuration || {};
}

function stringSetting(profile: TextProviderProfile, key: string, fallback = ""): string {
  const value = providerConfig(profile)[key];
  return typeof value === "string" ? value.trim() : fallback;
}

function numberSetting(profile: TextProviderProfile, key: string): number | undefined {
  const value = Number(providerConfig(profile)[key]);
  return Number.isFinite(value) ? value : undefined;
}

function network(profile: TextProviderProfile): "fast" | "relaxed" {
  return providerConfig(profile).network === "relaxed" ? "relaxed" : "fast";
}

function sessionKey(profile: TextProviderProfile): string {
  const credentialHash = createHash("sha256").update(profile.apiKey || "").digest("hex").slice(0, 16);
  const profileId = String((profile as TextProviderProfile & { id?: string }).id || profile.baseUrl);
  return `${profileId}:${network(profile)}:${credentialHash}`;
}

function sdkBaseUrl(profile: TextProviderProfile): string {
  return profile.baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

async function session(profile: TextProviderProfile): Promise<Session> {
  if (!profile.apiKey?.trim()) throw new SogniProviderError({ code: "authentication_required", message: "Sogni SDK requires an API key.", retryable: false });
  const key = sessionKey(profile);
  const profilePrefix = `${String((profile as TextProviderProfile & { id?: string }).id || profile.baseUrl)}:`;
  for (const [existingKey, existing] of sessions) {
    if (existingKey !== key && existingKey.startsWith(profilePrefix)) {
      sessions.delete(existingKey);
      void existing.then(({ client }) => client.dispose()).catch(() => undefined);
    }
  }
  let pending = sessions.get(key);
  if (!pending) {
    pending = createClient({
      appId: `infinitequest-${hostname()}-${String((profile as TextProviderProfile & { id?: string }).id || "profile").slice(0, 12)}-${randomUUID()}`,
      appSource: "infinite-quest-nexus",
      apiKey: profile.apiKey.trim(),
      authType: "apiKey",
      network: network(profile),
      restEndpoint: sdkBaseUrl(profile),
      logLevel: "warn"
    }).then((client) => ({ client, key })).catch((error) => {
      sessions.delete(key);
      throw error;
    });
    sessions.set(key, pending);
  }
  return pending;
}

function pollIntervalMs(profile: TextProviderProfile): number {
  const value = numberSetting(profile, "pollIntervalMs");
  return value && value >= 1_000 && value <= 30_000 ? value : 2_000;
}

function normalizedError(error: unknown, fallback = "Sogni SDK generation failed."): NormalizedProviderError {
  const value = error as { status?: number; code?: string | number; message?: string } | undefined;
  const status = Number(value?.status || 0) || undefined;
  return {
    code: String(value?.code || (status === 401 ? "authentication_failed" : status === 402 ? "insufficient_balance" : "provider_generation_failed")),
    message: String(value?.message || fallback).slice(0, 2_000),
    retryable: status === undefined || status === 408 || status === 409 || status === 429 || status >= 500,
    ...(status ? { statusCode: status } : {})
  };
}

function projectMetadata(project: Project): Record<string, unknown> {
  return {
    status: project.status,
    projectId: project.id,
    progress: project.progress,
    queuePosition: project.queuePosition,
    ...(project.eta ? { eta: project.eta.toISOString() } : {})
  };
}

function trackedPoll(project: Project, profile: TextProviderProfile): ImageProviderPollResult {
  const providerMetadata = projectMetadata(project);
  if (project.status === "failed" || project.status === "canceled") {
    return { status: "failed", error: normalizedError(project.error, `Sogni SDK project ${project.status}.`), providerMetadata };
  }
  if (project.status === "completed") {
    const artifacts = project.resultUrls.map((url) => ({ source: "url" as const, url }));
    if (!artifacts.length) return { status: "pending", progress: 100, pollAfterMs: pollIntervalMs(profile), providerMetadata: { ...providerMetadata, status: "finalizing" } };
    return { status: "completed", artifacts, usage: { images: artifacts.length, unit: "image" }, reportedCost: null, providerMetadata };
  }
  const etaSeconds = project.eta ? Math.max(0, Math.ceil((project.eta.getTime() - Date.now()) / 1_000)) : undefined;
  return {
    status: "pending",
    progress: project.progress,
    ...(project.queuePosition >= 0 ? { queuePosition: project.queuePosition } : {}),
    ...(etaSeconds !== undefined ? { etaSeconds } : {}),
    pollAfterMs: pollIntervalMs(profile),
    providerMetadata
  };
}

async function rawPoll(client: SogniClient, raw: RawProject, profile: TextProviderProfile): Promise<ImageProviderPollResult> {
  const status = String(raw.status || "pending").toLowerCase();
  const providerMetadata = { status, projectId: raw.id, recoveredAfterRestart: true };
  if (status === "errored" || status === "cancelled") {
    return { status: "failed", error: { code: status === "cancelled" ? "provider_cancelled" : "provider_generation_failed", message: `Sogni SDK project ended with status '${status}'.`, retryable: status !== "cancelled" }, providerMetadata };
  }
  if (status !== "completed") return { status: "pending", pollAfterMs: pollIntervalMs(profile), providerMetadata };
  const jobs = raw.completedWorkerJobs || [];
  const urls = await Promise.all(jobs.map(async (job) => job.resultUrl || (job.imgID ? client.projects.downloadUrl({ jobId: raw.id, imageId: job.imgID, type: "complete" }) : null)));
  const artifacts = urls.filter((url): url is string => Boolean(url)).map((url) => ({ source: "url" as const, url }));
  if (!artifacts.length) {
    const filtered = jobs.some((job) => job.triggeredNSFWFilter);
    return {
      status: "failed",
      error: filtered
        ? { code: "content_filtered", message: "Sogni's content filter withheld the generated image.", retryable: false }
        : { code: "missing_artifacts", message: "Sogni SDK completed without a recoverable image artifact.", retryable: true },
      providerMetadata
    };
  }
  return { status: "completed", artifacts, usage: { images: artifacts.length, unit: "image" }, reportedCost: null, providerMetadata };
}

export async function submitSogniSdkGeneration(profile: TextProviderProfile, request: ImageProviderRequest): Promise<Omit<Extract<ImageProviderSubmissionResult, { mode: "pending" }>, "mode">> {
  const { client } = await session(profile);
  const dimensions = /^(\d+)x(\d+)$/i.exec(request.size);
  const width = request.width ?? Number(dimensions?.[1] || 0);
  const height = request.height ?? Number(dimensions?.[2] || 0);
  const configuredToken = stringSetting(profile, "tokenType", "auto");
  const sizePreset = stringSetting(profile, "defaultSizePreset", "custom") || "custom";
  const steps = numberSetting(profile, "defaultSteps");
  const guidance = numberSetting(profile, "defaultGuidance");
  const seed = numberSetting(profile, "defaultSeed");
  const params: ImageProjectParams = {
    type: "image",
    modelId: profile.model,
    positivePrompt: request.prompt,
    ...(request.negativePrompt ? { negativePrompt: request.negativePrompt } : {}),
    numberOfMedia: request.imageCount ?? 1,
    network: network(profile),
    disableNSFWFilter: stringSetting(profile, "contentFilter", "enabled") === "disabled",
    sizePreset,
    ...(sizePreset === "custom" ? { width, height } : {}),
    outputFormat: request.outputFormat === "jpeg" ? "jpg" : request.outputFormat,
    gptImageQuality: request.quality,
    ...(configuredToken === "sogni" || configuredToken === "spark" ? { tokenType: configuredToken } : {}),
    ...(steps !== undefined ? { steps } : {}),
    ...(guidance !== undefined ? { guidance } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(stringSetting(profile, "defaultSampler") ? { sampler: stringSetting(profile, "defaultSampler") } : {}),
    ...(stringSetting(profile, "defaultScheduler") ? { scheduler: stringSetting(profile, "defaultScheduler") } : {}),
    numberOfPreviews: numberSetting(profile, "defaultPreviewCount") ?? 0,
    appSource: "infinite-quest-nexus"
  };
  const project = await client.projects.create(params);
  const etaSeconds = project.eta ? Math.max(0, Math.ceil((project.eta.getTime() - Date.now()) / 1_000)) : undefined;
  return {
    remoteJobId: project.id,
    progress: project.progress,
    ...(project.queuePosition >= 0 ? { queuePosition: project.queuePosition } : {}),
    ...(etaSeconds !== undefined ? { etaSeconds } : {}),
    pollAfterMs: pollIntervalMs(profile),
    providerMetadata: projectMetadata(project)
  };
}

export async function pollSogniSdkGeneration(profile: TextProviderProfile, remoteJobId: string): Promise<ImageProviderPollResult> {
  const { client } = await session(profile);
  const tracked = client.projects.trackedProjects.find((project) => project.id === remoteJobId);
  if (tracked) return trackedPoll(tracked, profile);
  try {
    return await rawPoll(client, await client.projects.get(remoteJobId), profile);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return { status: "pending", pollAfterMs: pollIntervalMs(profile), providerMetadata: { status: "processing", projectId: remoteJobId, recoveredAfterRestart: true } };
    }
    throw new SogniProviderError(normalizedError(error));
  }
}

export async function cancelSogniSdkGeneration(profile: TextProviderProfile, remoteJobId: string): Promise<void> {
  const { client } = await session(profile);
  await client.projects.cancel(remoteJobId);
}

export async function discoverSogniSdkModels(profile: TextProviderProfile): Promise<ModelInventoryItem[]> {
  const { client } = await session(profile);
  const models = (await client.projects.getAvailableModels(network(profile))).filter((model) => model.media === "image");
  return Promise.all(models.map(async (model) => {
    const [options, presets] = await Promise.all([client.projects.getModelOptions(model.id), client.projects.getSizePresets(network(profile), model.id)]);
    const imageOptions = options.type === "image" ? {
      sizePresets: presets.map((preset) => ({ id: preset.id, label: preset.label, width: preset.width, height: preset.height, ratio: preset.ratio })),
      steps: options.steps,
      guidance: options.guidance,
      samplers: options.sampler.allowed,
      ...(options.sampler.default ? { defaultSampler: options.sampler.default } : {}),
      schedulers: options.scheduler.allowed,
      ...(options.scheduler.default ? { defaultScheduler: options.scheduler.default } : {}),
      outputFormats: ["png", "jpeg", "webp"] as Array<"png" | "jpeg" | "webp">,
      maximumPreviews: 10
    } : undefined;
    return {
      id: model.id,
      displayName: model.name,
      loaded: model.workerCount > 0,
      instanceId: model.id,
      contextLength: 0,
      workerCount: model.workerCount,
      media: model.media,
      ...(imageOptions ? { imageOptions } : {})
    };
  }));
}

export function disposeSogniSdkSessions(): void {
  for (const pending of sessions.values()) void pending.then(({ client }) => client.dispose()).catch(() => undefined);
  sessions.clear();
}

export function setSogniSdkClientFactoryForTests(factory?: (clientConfig: SogniClientConfig) => Promise<SogniClient>): void {
  disposeSogniSdkSessions();
  createClient = factory || ((clientConfig) => SogniClient.createInstance(clientConfig));
}
