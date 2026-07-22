import type { ProviderType } from "../../contracts/src/generation.js";
import { logger } from "../../logger/src/index.js";
import { Agent } from "undici";
import {
  cancelSogniGeneration,
  pollSogniGeneration,
  submitSogniGeneration,
  type NormalizedProviderError as SogniNormalizedProviderError
} from "./providers/illustration/sogni/index.js";

export type TextProviderProfile = {
  providerType: ProviderType;
  baseUrl: string;
  model: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  temperature: number;
  requestTimeoutMs?: number;
  apiKey?: string;
  configuration?: Record<string, unknown>;
};

export type ProviderRequest = {
  systemPrompt: string;
  input: string;
  previousResponseId?: string;
  recoveryInput?: string;
  rejectedResponse?: string;
  onChunk?: (delta: string, accumulated: string) => void | Promise<void>;
};

export type ProviderResult = {
  content: string;
  responseId: string;
  finishReason: string;
  outputLimited: boolean;
  modelInstanceId: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  reportedCost: ReportedProviderCost | null;
  rawMetadata: Record<string, unknown>;
};

export type ReportedProviderCost = {
  amount: string;
  currency: string;
};

export type ModelInventoryItem = {
  id: string;
  displayName: string;
  loaded: boolean;
  instanceId: string;
  contextLength: number;
};

export type EmbeddingResult = {
  embeddings: number[][];
  model: string;
  responseId: string;
  usage: { inputTokens: number; totalTokens: number };
  reportedCost: ReportedProviderCost | null;
};

export type ImageProviderRequest = {
  prompt: string;
  size: string;
  aspectRatio: string;
  quality: "auto" | "low" | "medium" | "high";
  outputFormat: "png" | "jpeg" | "webp";
  idempotencyKey?: string;
  imageCount?: 1 | 2;
  negativePrompt?: string;
  width?: number;
  height?: number;
  seed?: number;
  steps?: number;
  guidance?: number;
  scheduler?: string;
  sensitiveContentFilter?: "provider-default" | "enabled" | "disabled";
};

export type ImageProviderResult = {
  base64: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  responseId: string;
  usage: Record<string, unknown>;
  reportedCost: ReportedProviderCost | null;
  rawMetadata: Record<string, unknown>;
};

export type NormalizedProviderError = SogniNormalizedProviderError;

export type ImageProviderArtifact =
  | { source: "base64"; base64: string; mimeType: ImageProviderResult["mimeType"] }
  | { source: "url"; url: string; mimeType?: ImageProviderResult["mimeType"] };

export type ImageProviderSubmissionResult =
  | {
      mode: "completed";
      artifacts: ImageProviderArtifact[];
      usage: Record<string, unknown>;
      reportedCost: ReportedProviderCost | null;
      providerMetadata: Record<string, unknown>;
    }
  | {
      mode: "pending";
      remoteJobId: string;
      pollAfterMs?: number;
      providerMetadata: Record<string, unknown>;
    };

export type ImageProviderPollResult =
  | { status: "pending"; progress?: number; pollAfterMs?: number; providerMetadata: Record<string, unknown> }
  | {
      status: "completed";
      artifacts: ImageProviderArtifact[];
      usage: Record<string, unknown>;
      reportedCost: ReportedProviderCost | null;
      providerMetadata: Record<string, unknown>;
    }
  | { status: "failed"; error: NormalizedProviderError; providerMetadata: Record<string, unknown> };

type Fetch = typeof fetch;

export type ProviderTransportDetails = {
  providerType: ProviderType;
  operation: string;
  endpoint: string;
  model: string;
  timeoutMs: number;
  durationMs: number;
  timedOut: boolean;
  transportCode: string;
  causeName: string;
  causeMessage: string;
};

export class ProviderTransportError extends Error {
  readonly code: "provider_request_timeout" | "provider_transport_error";
  readonly statusCode: 502 | 504;
  readonly expose = true;
  readonly transport: ProviderTransportDetails;

  constructor(message: string, details: ProviderTransportDetails, cause: unknown) {
    super(message, { cause });
    this.name = details.timedOut ? "ProviderTimeoutError" : "ProviderTransportError";
    this.code = details.timedOut ? "provider_request_timeout" : "provider_transport_error";
    this.statusCode = details.timedOut ? 504 : 502;
    this.transport = details;
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const MAX_REQUEST_TIMEOUT_MS = 3_600_000;
const providerDispatcher = new Agent({
  headersTimeout: MAX_REQUEST_TIMEOUT_MS,
  bodyTimeout: MAX_REQUEST_TIMEOUT_MS,
  connectTimeout: MAX_REQUEST_TIMEOUT_MS
});
const responseStartTimes = new WeakMap<Response, number>();

function requestTimeoutMs(profile: TextProviderProfile): number {
  const value = Number(profile.requestTimeoutMs);
  return Number.isInteger(value) && value >= 1_000 ? value : DEFAULT_REQUEST_TIMEOUT_MS;
}

function safeEndpoint(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "invalid-provider-url";
  }
}

function safeCauseMessage(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(https?:\/\/[^\s/:@]+):[^@\s/]+@/gi, "$1:[redacted]@")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|key)=)[^&\s]+/gi, "$1[redacted]");
}

function errorChain(error: unknown): Array<Record<string, unknown>> {
  const chain: Array<Record<string, unknown>> = [];
  let current = error;
  for (let index = 0; index < 6 && typeof current === "object" && current !== null; index += 1) {
    chain.push(current as Record<string, unknown>);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function transportFailure(
  profile: TextProviderProfile,
  operation: string,
  url: string,
  cause: unknown,
  startedAt: number
): ProviderTransportError {
  if (cause instanceof ProviderTransportError) return cause;
  const chain = errorChain(cause);
  const messages = chain.map((item) => String(item.message || ""));
  const names = chain.map((item) => String(item.name || ""));
  const codes = chain.map((item) => String(item.code || "")).filter(Boolean);
  const timedOut = codes.some((code) => /TIMEOUT/i.test(code))
    || names.some((name) => /^(?:TimeoutError|AbortError)$/i.test(name))
    || messages.some((message) => /timed?\s*out|headers timeout|body timeout/i.test(message));
  const timeoutMs = requestTimeoutMs(profile);
  const providerName = profile.providerType === "lmstudio" ? "LM Studio"
    : profile.providerType === "openrouter" ? "OpenRouter"
      : profile.providerType === "openai_compatible" ? "OpenAI-compatible provider"
        : profile.providerType === "sogni" ? "Sogni" : "Manifest provider";
  const transportCode = codes[0] || (timedOut ? "REQUEST_TIMEOUT" : "TRANSPORT_FAILURE");
  const causeName = names.find(Boolean) || "Error";
  const causeMessage = messages.findLast(Boolean) || messages.find(Boolean) || String(cause || "Transport failure");
  const durationMs = Math.max(0, Date.now() - startedAt);
  const details: ProviderTransportDetails = {
    providerType: profile.providerType,
    operation,
    endpoint: safeEndpoint(url),
    model: profile.model,
    timeoutMs,
    durationMs,
    timedOut,
    transportCode,
    causeName,
    causeMessage: safeCauseMessage(causeMessage).slice(0, 1000)
  };
  const message = timedOut
    ? `${providerName} ${operation} timed out after ${Math.round(timeoutMs / 60_000 * 10) / 10} minutes before a complete response was received. Nexus closed the provider request; increase Request timeout in the provider's Advanced settings or reduce the request workload.`
    : `${providerName} ${operation} could not complete because the provider connection failed (${transportCode}). Check the endpoint and Docker host logs for transport diagnostics.`;
  const error = new ProviderTransportError(message, details, cause);
  logger.error({ event: "provider_transport_error", ...details });
  return error;
}

export function providerTransportErrorDetails(error: unknown): ProviderTransportDetails | null {
  return error instanceof ProviderTransportError ? error.transport : null;
}

export function logProviderTransportError(error: unknown, context: Record<string, unknown>): void {
  const transport = providerTransportErrorDetails(error);
  if (!transport) return;
  logger.error({ event: "provider_transport_error_correlated", ...context, ...transport });
}

async function providerFetch(
  profile: TextProviderProfile,
  operation: string,
  url: string,
  init: RequestInit,
  fetcher: Fetch
): Promise<Response> {
  const timeoutMs = requestTimeoutMs(profile);
  const startedAt = Date.now();
  try {
    const response = await fetcher(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher: providerDispatcher
    } as RequestInit);
    responseStartTimes.set(response, startedAt);
    return response;
  } catch (error) {
    throw transportFailure(profile, operation, url, error, startedAt);
  }
}

function rootUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function lmStudioRoot(baseUrl: string): string {
  return rootUrl(baseUrl).replace(/\/(?:api\/v1|v1)$/i, "");
}

function openAiRoot(baseUrl: string): string {
  const root = rootUrl(baseUrl);
  return /\/v1$/i.test(root) ? root : `${root}/v1`;
}

function headers(profile: TextProviderProfile): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}),
    ...(profile.providerType === "openrouter" ? {
      "HTTP-Referer": String(profile.configuration?.httpReferer || "https://github.com/cmacnichol/infinite-quest-nexus"),
      "X-Title": "Infinite Quest Nexus"
    } : {})
  };
}

async function checkedJson(
  response: Response,
  profile?: TextProviderProfile,
  operation = "request",
  url = response.url
): Promise<Record<string, any>> {
  let text = "";
  try {
    text = await response.text();
  } catch (error) {
    if (!profile) throw error;
    throw transportFailure(profile, operation, url, error, responseStartTimes.get(response) ?? Date.now());
  }
  let data: Record<string, any> = {};
  try { data = text ? JSON.parse(text) as Record<string, any> : {}; } catch { /* response error below includes preview */ }
  if (!response.ok) {
    const message = String(data.error?.message || data.error || text || response.statusText).slice(0, 2000);
    throw Object.assign(new Error(`Provider request failed (${response.status}): ${message}`), { statusCode: response.status, providerMessage: message });
  }
  return data;
}

function limitReason(values: unknown[]): boolean {
  return values.some((value) => /(?:length|max(?:imum)?[_ -]?(?:output[_ -]?)?tokens?|token[_ -]?limit|context[_ -]?(?:length|limit)|incomplete|truncated)/i.test(String(value ?? "")));
}

export function reportedProviderCost(usage: unknown): ReportedProviderCost | null {
  if (!usage || typeof usage !== "object" || !("cost" in usage)) return null;
  const rawCost = (usage as { cost?: unknown }).cost;
  if ((typeof rawCost !== "number" && typeof rawCost !== "string") || String(rawCost).trim() === "") return null;
  const numericCost = Number(rawCost);
  if (!Number.isFinite(numericCost) || numericCost < 0) return null;
  const currency = String((usage as { currency?: unknown }).currency || "USD").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  return { amount: String(rawCost).trim(), currency };
}

export async function ensureLmStudioModelLoaded(profile: TextProviderProfile, operation: string, fetcher: Fetch = fetch): Promise<void> {
  if (profile.providerType !== "lmstudio" || !profile.model.trim()) return;
  try {
    const models = await discoverModels(profile, fetcher);
    const requested = profile.model.trim().toLowerCase();
    const matches = models.filter((item) => item.id.trim().toLowerCase() === requested || item.instanceId.trim().toLowerCase() === requested);
    if (!matches.length) return;
    if (matches.some((item) => item.loaded)) return;
    const targetModelId = matches[0]?.id || profile.model.trim();
    const url = `${lmStudioRoot(profile.baseUrl)}/api/v1/models/load`;
    const response = await providerFetch(profile, operation, url, {
      method: "POST",
      headers: headers(profile),
      body: JSON.stringify({ model: targetModelId })
    }, fetcher);
    if (!response.ok) return;
    await checkedJson(response, profile, operation, url);
  } catch {
    // If discovery or loading fails, allow the actual request to execute or report its own error.
  }
}

async function readSseStream(
  response: Response,
  onChunk: (delta: string, accumulated: string) => void | Promise<void>
): Promise<{ content: string; finalData: Record<string, any>; allData: Record<string, any>[] }> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response body stream is not readable.");
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulated = "";
  let finalData: Record<string, any> = {};
  const allData: Record<string, any>[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n\r?\n/);
    buffer = lines.pop() || "";
    for (const block of lines) {
      const dataLines = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
      for (const dataStr of dataLines) {
        if (!dataStr || dataStr === "[DONE]") continue;
        try {
          const parsed = JSON.parse(dataStr);
          allData.push(parsed);
          finalData = { ...finalData, ...parsed };
          let delta = "";
          if (typeof parsed.content === "string" && parsed.type?.includes("delta")) {
            delta = parsed.content;
          } else if (parsed.choices?.[0]?.delta?.content !== undefined) {
            delta = String(parsed.choices[0].delta.content || "");
          } else if (typeof parsed.choices?.[0]?.text === "string") {
            delta = parsed.choices[0].text;
          } else if (Array.isArray(parsed.output)) {
            const lastMsg = parsed.output.findLast?.((item: any) => item?.type === "message" || item?.type === "message.delta");
            if (lastMsg?.content && typeof lastMsg.content === "string") {
              if (lastMsg.content.startsWith(accumulated)) {
                delta = lastMsg.content.slice(accumulated.length);
              } else if (!accumulated.startsWith(lastMsg.content)) {
                delta = lastMsg.content;
              }
            }
          }
          if (delta) {
            accumulated += delta;
            await onChunk(delta, accumulated);
          }
        } catch {
          // ignore malformed or non-json SSE event data
        }
      }
    }
  }
  return { content: accumulated, finalData, allData };
}

async function callLmStudio(profile: TextProviderProfile, request: ProviderRequest, fetcher: Fetch): Promise<ProviderResult> {
  await ensureLmStudioModelLoaded(profile, "story generation model loading", fetcher);
  const rejectedResponse = String(request.rejectedResponse || "").trim()
    .slice(0, Math.max(4000, Math.min(80_000, profile.maxOutputTokens * 4)));
  const payload: Record<string, unknown> = {
    model: profile.model,
    input: request.previousResponseId && request.recoveryInput
      ? request.recoveryInput
      : request.recoveryInput
        ? `${request.input}${rejectedResponse ? `\n\nREJECTED RESPONSE TO REWRITE:\n${rejectedResponse}` : ""}\n\nRECOVERY REQUIREMENT:\n${request.recoveryInput}`
        : request.input,
    store: true,
    stream: Boolean(request.onChunk),
    temperature: request.recoveryInput ? 0.2 : profile.temperature,
    max_output_tokens: profile.maxOutputTokens
  };
  if (request.previousResponseId) payload.previous_response_id = request.previousResponseId;
  else payload.system_prompt = request.systemPrompt;
  const url = `${lmStudioRoot(profile.baseUrl)}/api/v1/chat`;
  const response = await providerFetch(profile, "story generation", url, { method: "POST", headers: headers(profile), body: JSON.stringify(payload) }, fetcher);
  if (response.ok && request.onChunk && response.headers.get("content-type")?.includes("event-stream")) {
    const { content, finalData, allData } = await readSseStream(response, request.onChunk);
    const stats = allData.findLast((item) => item.stats)?.stats || finalData.stats || {};
    const outputTokens = Number(stats.total_output_tokens || 0);
    const finishValues = [
      finalData.status, finalData.finish_reason, finalData.stop_reason, finalData.incomplete_details?.reason,
      ...allData.flatMap((item: any) => [
        item.status, item.finish_reason, item.stop_reason, item.incomplete_details?.reason,
        ...(Array.isArray(item.output) ? item.output.flatMap((out: any) => [out?.status, out?.finish_reason, out?.stop_reason, out?.incomplete_details?.reason]) : [])
      ])
    ];
    const responseId = String(allData.map((item) => item.response_id).find(Boolean) || finalData.response_id || "");
    return {
      content: content.trim(),
      responseId,
      finishReason: String(finishValues.find(Boolean) || ""),
      outputLimited: limitReason(finishValues) || (outputTokens > 0 && outputTokens >= profile.maxOutputTokens),
      modelInstanceId: String(finalData.model_instance_id || profile.model),
      usage: { inputTokens: Number(stats.input_tokens || 0), outputTokens, totalTokens: Number(stats.input_tokens || 0) + outputTokens },
      reportedCost: null,
      rawMetadata: { status: finalData.status || "", modelInstanceId: finalData.model_instance_id || "" }
    };
  }
  const data = await checkedJson(response, profile, "story generation", url);
  const messages = (Array.isArray(data.output) ? data.output : []).filter((item: any) => item?.type === "message");
  const content = String(messages.at(-1)?.content ?? "").trim();
  const outputTokens = Number(data.stats?.total_output_tokens || 0);
  const finishValues = [data.status, data.finish_reason, data.stop_reason, data.incomplete_details?.reason,
    ...(Array.isArray(data.output) ? data.output.flatMap((item: any) => [item?.status, item?.finish_reason, item?.stop_reason, item?.incomplete_details?.reason]) : [])];
  return {
    content,
    responseId: String(data.response_id || ""),
    finishReason: String(finishValues.find(Boolean) || ""),
    outputLimited: limitReason(finishValues) || (outputTokens > 0 && outputTokens >= profile.maxOutputTokens),
    modelInstanceId: String(data.model_instance_id || profile.model),
    usage: { inputTokens: Number(data.stats?.input_tokens || 0), outputTokens, totalTokens: Number(data.stats?.input_tokens || 0) + outputTokens },
    reportedCost: null,
    rawMetadata: { status: data.status || "", modelInstanceId: data.model_instance_id || "" }
  };
}

async function callOpenAiCompatible(profile: TextProviderProfile, request: ProviderRequest, fetcher: Fetch): Promise<ProviderResult> {
  const rejectedResponse = String(request.rejectedResponse || "").trim()
    .slice(0, Math.max(4000, Math.min(80_000, profile.maxOutputTokens * 4)));
  const messages = [
    { role: "system", content: request.systemPrompt },
    { role: "user", content: request.input },
    ...(request.recoveryInput ? [
      { role: "assistant", content: rejectedResponse || "The previous response was incomplete or invalid." },
      { role: "user", content: request.recoveryInput }
    ] : [])
  ];
  const payload: Record<string, unknown> = {
    model: profile.model,
    messages,
    temperature: request.recoveryInput ? 0.2 : profile.temperature,
    max_tokens: profile.maxOutputTokens,
    response_format: { type: "json_object" }
  };
  if (request.onChunk) {
    payload.stream = true;
    payload.stream_options = { include_usage: true };
  }
  const url = `${openAiRoot(profile.baseUrl)}/chat/completions`;
  const send = () => providerFetch(profile, "story generation", url, { method: "POST", headers: headers(profile), body: JSON.stringify(payload) }, fetcher);
  let response = await send();
  if (!response.ok) {
    const clone = response.clone();
    const text = await clone.text();
    if (/response_format|json.?mode|structured.?output|grammar/i.test(text)) {
      delete payload.response_format;
      response = await send();
    }
  }
  if (response.ok && request.onChunk && response.headers.get("content-type")?.includes("event-stream")) {
    const { content, finalData, allData } = await readSseStream(response, request.onChunk);
    const usageObj = allData.findLast((item) => item.usage)?.usage || finalData.usage || {};
    const finishReason = String(allData.map((item) => item.choices?.[0]?.finish_reason).find(Boolean) || finalData.finish_reason || "");
    const responseId = String(allData.map((item) => item.id).find(Boolean) || finalData.id || "");
    const modelInstanceId = String(allData.map((item) => item.model).find(Boolean) || finalData.model || profile.model);
    return {
      content: content.trim(),
      responseId,
      finishReason,
      outputLimited: limitReason([finishReason]),
      modelInstanceId,
      usage: {
        inputTokens: Number(usageObj.prompt_tokens || 0),
        outputTokens: Number(usageObj.completion_tokens || 0),
        totalTokens: Number(usageObj.total_tokens || 0)
      },
      reportedCost: reportedProviderCost(usageObj),
      rawMetadata: { model: modelInstanceId, provider: finalData.provider || "" }
    };
  }
  const data = await checkedJson(response, profile, "story generation", url);
  const choice = data.choices?.[0] || {};
  const contentValue = choice.message?.content;
  const content = typeof contentValue === "string" ? contentValue : Array.isArray(contentValue)
    ? contentValue.map((part: any) => part?.text || "").join("") : "";
  const finishReason = String(choice.finish_reason || "");
  return {
    content: content.trim(),
    responseId: String(data.id || ""),
    finishReason,
    outputLimited: limitReason([finishReason]),
    modelInstanceId: String(data.model || profile.model),
    usage: {
      inputTokens: Number(data.usage?.prompt_tokens || 0),
      outputTokens: Number(data.usage?.completion_tokens || 0),
      totalTokens: Number(data.usage?.total_tokens || 0)
    },
    reportedCost: reportedProviderCost(data.usage),
    rawMetadata: { model: data.model || "", provider: data.provider || "" }
  };
}

export async function callTextProvider(profile: TextProviderProfile, request: ProviderRequest, fetcher: Fetch = fetch): Promise<ProviderResult> {
  return profile.providerType === "lmstudio"
    ? callLmStudio(profile, request, fetcher)
    : callOpenAiCompatible(profile, request, fetcher);
}

export async function callEmbeddingProvider(
  profile: TextProviderProfile,
  inputs: string[],
  fetcher: Fetch = fetch
): Promise<EmbeddingResult> {
  if (!inputs.length) return {
    embeddings: [], model: profile.model, responseId: "", usage: { inputTokens: 0, totalTokens: 0 }, reportedCost: null
  };
  await ensureLmStudioModelLoaded(profile, "embedding model loading", fetcher);
  const url = `${openAiRoot(profile.baseUrl)}/embeddings`;
  const response = await providerFetch(profile, "embedding generation", url, {
    method: "POST",
    headers: headers(profile),
    body: JSON.stringify({ model: profile.model, input: inputs })
  }, fetcher);
  const data = await checkedJson(response, profile, "embedding generation", url);
  const rows = Array.isArray(data.data) ? [...data.data].sort((left: any, right: any) => Number(left?.index || 0) - Number(right?.index || 0)) : [];
  if (rows.length !== inputs.length) throw new Error(`Embedding provider returned ${rows.length} vectors for ${inputs.length} inputs.`);
  const embeddings = rows.map((row: any, index: number) => {
    if (!Array.isArray(row?.embedding) || !row.embedding.length) throw new Error(`Embedding result ${index} did not contain a vector.`);
    const vector = row.embedding.map(Number);
    if (vector.some((value: number) => !Number.isFinite(value))) throw new Error(`Embedding result ${index} contained a non-finite value.`);
    if (vector.length > 16_000) throw new Error(`Embedding result ${index} exceeded the supported dimensionality.`);
    return vector;
  });
  const dimensions = embeddings[0]?.length || 0;
  if (embeddings.some((embedding) => embedding.length !== dimensions)) throw new Error("Embedding provider returned vectors with inconsistent dimensions.");
  return {
    embeddings,
    model: String(data.model || profile.model),
    responseId: String(data.id || ""),
    usage: { inputTokens: Number(data.usage?.prompt_tokens || 0), totalTokens: Number(data.usage?.total_tokens || 0) },
    reportedCost: reportedProviderCost(data.usage)
  };
}

export async function callImageProvider(
  profile: TextProviderProfile,
  request: ImageProviderRequest,
  fetcher: Fetch = fetch
): Promise<ImageProviderResult> {
  await ensureLmStudioModelLoaded(profile, "image model loading", fetcher);
  const base = profile.providerType === "openrouter" ? rootUrl(profile.baseUrl) : openAiRoot(profile.baseUrl);
  const url = profile.providerType === "openrouter" ? `${base}/images` : `${base}/images/generations`;
  const payload: Record<string, unknown> = {
    model: profile.model,
    prompt: request.prompt,
    n: 1,
    size: request.size,
    quality: request.quality,
    output_format: request.outputFormat,
    ...(profile.providerType === "openrouter" ? { aspect_ratio: request.aspectRatio } : { response_format: "b64_json" })
  };
  const data = await checkedJson(await providerFetch(profile, "image generation", url, {
    method: "POST",
    headers: headers(profile),
    body: JSON.stringify(payload)
  }, fetcher), profile, "image generation", url);
  const image = Array.isArray(data.data) ? data.data[0] : undefined;
  const base64 = String(image?.b64_json || "").replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "").trim();
  if (!base64) {
    if (image?.url) throw new Error("The image provider returned only a temporary URL. Configure it to return base64 image data so Nexus can persist the asset safely.");
    throw new Error("The image provider response did not contain base64 image data.");
  }
  const mediaType = String(image?.media_type || `image/${request.outputFormat === "jpeg" ? "jpeg" : request.outputFormat}`).toLowerCase();
  if (!(["image/png", "image/jpeg", "image/webp"] as const).includes(mediaType as "image/png" | "image/jpeg" | "image/webp")) {
    throw new Error(`The image provider returned unsupported media type '${mediaType}'.`);
  }
  return {
    base64,
    mimeType: mediaType as ImageProviderResult["mimeType"],
    responseId: String(data.id || image?.id || ""),
    usage: typeof data.usage === "object" && data.usage ? data.usage : {},
    reportedCost: reportedProviderCost(data.usage),
    rawMetadata: { created: data.created || null, provider: data.provider || "" }
  };
}

type AsyncImageProviderAdapter = {
  submit(profile: TextProviderProfile, request: ImageProviderRequest, fetcher: Fetch): Promise<ImageProviderSubmissionResult>;
  poll?(profile: TextProviderProfile, remoteJobId: string, fetcher: Fetch): Promise<ImageProviderPollResult>;
  cancel?(profile: TextProviderProfile, remoteJobId: string, fetcher: Fetch): Promise<void>;
};

const compatibleImageProviderAdapter: AsyncImageProviderAdapter = {
  async submit(profile, request, fetcher) {
    const result = await callImageProvider(profile, request, fetcher);
    return {
      mode: "completed",
      artifacts: [{ source: "base64", base64: result.base64, mimeType: result.mimeType }],
      usage: result.usage,
      reportedCost: result.reportedCost,
      providerMetadata: { responseId: result.responseId, ...result.rawMetadata }
    };
  }
};

const sogniImageProviderAdapter: AsyncImageProviderAdapter = {
  async submit(profile, request, fetcher) {
    const dimensions = /^(\d{2,5})x(\d{2,5})$/.exec(request.size);
    const imageCount = request.imageCount ?? 1;
    if (imageCount !== 1 && imageCount !== 2) throw new Error("Image count must be one or two.");
    const submitted = await submitSogniGeneration(profile, {
      prompt: request.prompt,
      idempotencyKey: String(request.idempotencyKey || ""),
      imageCount,
      outputFormat: request.outputFormat,
      sensitiveContentFilter: request.sensitiveContentFilter ?? "provider-default",
      ...(request.negativePrompt !== undefined ? { negativePrompt: request.negativePrompt } : {}),
      ...((request.width !== undefined || dimensions) ? { width: request.width ?? Number(dimensions?.[1]) } : {}),
      ...((request.height !== undefined || dimensions) ? { height: request.height ?? Number(dimensions?.[2]) } : {}),
      ...(request.aspectRatio !== undefined ? { aspectRatio: request.aspectRatio } : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      ...(request.steps !== undefined ? { steps: request.steps } : {}),
      ...(request.guidance !== undefined ? { guidance: request.guidance } : {}),
      ...(request.scheduler !== undefined ? { scheduler: request.scheduler } : {})
    }, fetcher);
    return { mode: "pending", ...submitted };
  },
  async poll(profile, remoteJobId, fetcher) {
    const result = await pollSogniGeneration(profile, remoteJobId, fetcher);
    if (result.status === "completed") return {
      ...result,
      reportedCost: reportedProviderCost(result.usage)
    };
    return result;
  },
  cancel: cancelSogniGeneration
};

export const imageProviderRegistry: Readonly<Partial<Record<ProviderType, AsyncImageProviderAdapter>>> = Object.freeze({
  lmstudio: compatibleImageProviderAdapter,
  openrouter: compatibleImageProviderAdapter,
  openai_compatible: compatibleImageProviderAdapter,
  manifest: compatibleImageProviderAdapter,
  sogni: sogniImageProviderAdapter
});

function imageProviderAdapter(profile: TextProviderProfile): AsyncImageProviderAdapter {
  const adapter = imageProviderRegistry[profile.providerType];
  if (!adapter) throw new Error(`No image provider adapter is registered for '${profile.providerType}'.`);
  return adapter;
}

export async function submitImageProvider(
  profile: TextProviderProfile,
  request: ImageProviderRequest,
  fetcher: Fetch = fetch
): Promise<ImageProviderSubmissionResult> {
  return imageProviderAdapter(profile).submit(profile, request, fetcher);
}

export async function pollImageProvider(
  profile: TextProviderProfile,
  request: { remoteJobId: string },
  fetcher: Fetch = fetch
): Promise<ImageProviderPollResult> {
  const adapter = imageProviderAdapter(profile);
  if (!adapter.poll) throw new Error(`Image provider '${profile.providerType}' does not use asynchronous polling.`);
  return adapter.poll(profile, request.remoteJobId, fetcher);
}

export async function cancelImageProvider(
  profile: TextProviderProfile,
  request: { remoteJobId: string },
  fetcher: Fetch = fetch
): Promise<void> {
  const adapter = imageProviderAdapter(profile);
  if (!adapter.cancel) throw new Error(`Image provider '${profile.providerType}' does not support cancellation.`);
  await adapter.cancel(profile, request.remoteJobId, fetcher);
}

function inventoryRows(data: Record<string, any>): any[] {
  return Array.isArray(data.models) ? data.models : Array.isArray(data.data) ? data.data : [];
}

function inventoryItems(models: any[]): ModelInventoryItem[] {
  return models.flatMap((model: any) => {
    const instances = Array.isArray(model.loaded_instances) ? model.loaded_instances : [];
    if (instances.length) return instances.map((instance: any) => ({
      id: String(model.key || model.id || instance.id || ""),
      displayName: String(model.display_name || model.name || model.key || model.id || ""),
      loaded: true,
      instanceId: String(instance.id || model.key || model.id || ""),
      contextLength: Number(instance.config?.context_length || instance.context_length || model.max_context_length || 0)
    }));
    return [{
      id: String(model.id || model.key || ""),
      displayName: String(model.name || model.display_name || model.id || model.key || ""),
      loaded: Boolean(model.loaded),
      instanceId: String(model.instance_id || model.id || model.key || ""),
      contextLength: Number(model.context_length || model.max_context_length || model.loaded_context_length || 0)
    }];
  }).filter((model: ModelInventoryItem) => model.id);
}

const IMAGE_GENERATION_PATTERN = /(?:^|[^a-z])(?:image(?:[-_ ]generation)?|text[-_ ]to[-_ ]image|diffusion|stable[-_ ]diffusion|sdxl|flux|dall[-_ ]?e|gpt[-_ ]image|imagen|ideogram|seedream|qwen[-_ ]image|recraft|hidream)(?:$|[^a-z])/i;
const NON_IMAGE_OUTPUT_PATTERN = /(?:^|[^a-z])(?:text|chat|completion|llm|language|embedding|rerank|audio|speech)(?:$|[^a-z])/i;

function stringValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (typeof value === "string") return [value];
  return [];
}

function explicitImageCapability(model: any): boolean | null {
  const architecture = model?.architecture && typeof model.architecture === "object" ? model.architecture : {};
  const capabilities = model?.capabilities && typeof model.capabilities === "object" && !Array.isArray(model.capabilities)
    ? model.capabilities
    : {};
  const outputFields = [
    model?.output_modalities,
    model?.outputModalities,
    model?.supported_output_modalities,
    architecture.output_modalities,
    architecture.outputModalities,
    capabilities.output_modalities,
    capabilities.outputModalities,
    capabilities.outputs
  ];
  const advertisedOutputs = outputFields.filter((value) => value !== undefined && value !== null);
  if (advertisedOutputs.length) {
    const values = advertisedOutputs.flatMap(stringValues);
    return values.some((value) => /(?:^|[^a-z])image(?:$|[^a-z])/i.test(value));
  }

  const imageFlags = [
    model?.image_generation,
    model?.imageGeneration,
    model?.supports_image_generation,
    model?.supportsImageGeneration,
    capabilities.image_generation,
    capabilities.imageGeneration,
    capabilities.text_to_image,
    capabilities.textToImage
  ].filter((value) => typeof value === "boolean");
  if (imageFlags.length) return imageFlags.some(Boolean);

  const roleFields = [model?.type, model?.kind, model?.task, model?.pipeline_tag, model?.pipelineTag, architecture.modality, model?.capabilities];
  const advertisedRoles = roleFields.flatMap(stringValues);
  if (advertisedRoles.some((value) => IMAGE_GENERATION_PATTERN.test(value))) return true;
  if (advertisedRoles.some((value) => NON_IMAGE_OUTPUT_PATTERN.test(value))) return false;
  return null;
}

function imageInventoryRows(models: any[]): any[] {
  const assessed = models.map((model) => {
    const capability = explicitImageCapability(model);
    const identity = String(model?.id || model?.key || model?.name || model?.display_name || "");
    return { model, capability, nameMatch: capability === null && IMAGE_GENERATION_PATTERN.test(identity) };
  });
  const hasUsableSignal = assessed.some(({ capability, nameMatch }) => capability !== null || nameMatch);
  if (!hasUsableSignal) return models;
  return assessed.filter(({ capability, nameMatch }) => capability === true || (capability === null && nameMatch)).map(({ model }) => model);
}

export async function discoverModels(profile: TextProviderProfile, fetcher: Fetch = fetch): Promise<ModelInventoryItem[]> {
  const url = profile.providerType === "lmstudio"
    ? `${lmStudioRoot(profile.baseUrl)}/api/v1/models`
    : `${openAiRoot(profile.baseUrl)}/models`;
  const data = await checkedJson(await providerFetch(profile, "model discovery", url, { headers: headers(profile) }, fetcher), profile, "model discovery", url);
  return inventoryItems(inventoryRows(data));
}

export async function discoverEmbeddingModels(profile: TextProviderProfile, fetcher: Fetch = fetch): Promise<ModelInventoryItem[]> {
  if (profile.providerType !== "openrouter") return discoverModels(profile, fetcher);
  const url = `${rootUrl(profile.baseUrl)}/embeddings/models`;
  const data = await checkedJson(await providerFetch(profile, "embedding model discovery", url, { headers: headers(profile) }, fetcher), profile, "embedding model discovery", url);
  return inventoryRows(data).map((model: any) => ({
    id: String(model.id || model.canonical_slug || model.key || ""),
    displayName: String(model.name || model.display_name || model.id || model.canonical_slug || model.key || ""),
    loaded: true,
    instanceId: String(model.id || model.canonical_slug || model.key || ""),
    contextLength: Number(model.context_length || model.top_provider?.context_length || 0)
  })).filter((model: ModelInventoryItem) => model.id);
}

export async function discoverImageModels(profile: TextProviderProfile, fetcher: Fetch = fetch): Promise<ModelInventoryItem[]> {
  if (profile.providerType === "sogni") {
    if (profile.configuration?.modelDiscoveryEnabled === false) return [];
    const url = `${openAiRoot(profile.baseUrl)}/models`;
    const data = await checkedJson(await providerFetch(profile, "image model discovery", url, { headers: headers(profile) }, fetcher), profile, "image model discovery", url);
    const rows = inventoryRows(data).filter((model: any) => {
      const capability = explicitImageCapability(model);
      const identity = String(model?.id || model?.key || model?.name || model?.display_name || "");
      return capability === true || (capability === null && IMAGE_GENERATION_PATTERN.test(identity));
    });
    return inventoryItems(rows);
  }
  if (profile.providerType !== "openrouter") {
    const url = profile.providerType === "lmstudio"
      ? `${lmStudioRoot(profile.baseUrl)}/api/v1/models`
      : `${openAiRoot(profile.baseUrl)}/models`;
    const data = await checkedJson(await providerFetch(profile, "image model discovery", url, { headers: headers(profile) }, fetcher), profile, "image model discovery", url);
    return inventoryItems(imageInventoryRows(inventoryRows(data)));
  }
  const url = `${rootUrl(profile.baseUrl)}/images/models`;
  const data = await checkedJson(await providerFetch(profile, "image model discovery", url, { headers: headers(profile) }, fetcher), profile, "image model discovery", url);
  return inventoryRows(data).map((model: any) => ({
    id: String(model.id || model.key || ""),
    displayName: String(model.name || model.display_name || model.id || model.key || ""),
    loaded: true,
    instanceId: String(model.id || model.key || ""),
    contextLength: 0
  })).filter((model: ModelInventoryItem) => model.id);
}
