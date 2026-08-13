import type { ProviderType } from "../../contracts/src/generation.js";
import { logger } from "../../logger/src/index.js";
import { ProviderDestinationNotAllowedError } from "../../security/src/provider-network-policy.js";
import {
  MAX_IMAGE_PROVIDER_RESPONSE_BYTES,
  MAX_PROVIDER_JSON_RESPONSE_BYTES,
  MAX_PROVIDER_SSE_RESPONSE_BYTES,
  ProviderResponseTooLargeError,
  readBoundedResponseText
} from "./provider-response.js";
import {
  configureDefaultProviderTransport,
  createProviderTransport,
  defaultProviderTransport,
  type ProviderTransport
} from "./provider-transport.js";
import {
  cancelSogniGeneration,
  pollSogniGeneration,
  submitSogniGeneration,
  type NormalizedProviderError as SogniNormalizedProviderError
} from "./providers/illustration/sogni/index.js";
import {
  cancelSogniSdkGeneration,
  pollSogniSdkGeneration,
  submitSogniSdkGeneration
} from "./providers/illustration/sogni-sdk/index.js";

export {
  configureDefaultProviderTransport,
  createProviderTransport,
  defaultProviderTransport,
  type ProviderTransport
};

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
  workerCount?: number;
  workerAvailability?: Array<{
    type: string;
    displayName: string;
    workerCount: number;
    description: string;
  }>;
  media?: "image" | "video" | "audio";
  imageOptions?: {
    sizePresets: Array<{ id: string; label: string; width: number; height: number; ratio: string }>;
    steps?: { min: number; max: number; step: number; default: number };
    guidance?: { min: number; max: number; step: number; default: number };
    samplers: string[];
    defaultSampler?: string;
    schedulers: string[];
    defaultScheduler?: string;
    outputFormats: Array<"png" | "jpeg" | "webp">;
    maximumPreviews: number;
  };
  pricing?: {
    category: "text" | "image";
    entries: Array<{ billable: string; unit: string; costUsd: number; provider?: string }>;
  };
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
};

export type ImageProviderResult = {
  base64: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  artifacts: ImageProviderArtifact[];
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
      progress?: number;
      queuePosition?: number;
      etaSeconds?: number;
      pollAfterMs?: number;
      providerMetadata: Record<string, unknown>;
    };

export type ImageProviderPollResult =
  | { status: "pending"; progress?: number; queuePosition?: number; etaSeconds?: number; pollAfterMs?: number; providerMetadata: Record<string, unknown> }
  | {
      status: "completed";
      artifacts: ImageProviderArtifact[];
      usage: Record<string, unknown>;
      reportedCost: ReportedProviderCost | null;
      providerMetadata: Record<string, unknown>;
    }
  | { status: "failed"; error: NormalizedProviderError; providerMetadata: Record<string, unknown> };

export type ProviderTransportDetails = {
  providerType: ProviderType;
  operation: string;
  endpoint: string;
  model: string;
  timeoutMs: number;
  durationMs: number;
  timedOut: boolean;
  transportCode: string;
  causeCategory: "timeout" | "network" | "transport";
  causeMessage: string;
};

export class ProviderTransportError extends Error {
  readonly code: "provider_request_timeout" | "provider_transport_error";
  readonly statusCode: 502 | 504;
  readonly expose = true;
  readonly transport: ProviderTransportDetails;

  constructor(message: string, details: ProviderTransportDetails) {
    super(message);
    this.name = details.timedOut ? "ProviderTimeoutError" : "ProviderTransportError";
    this.code = details.timedOut ? "provider_request_timeout" : "provider_transport_error";
    this.statusCode = details.timedOut ? 504 : 502;
    this.transport = details;
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
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

function errorChain(error: unknown): Array<Record<string, unknown>> {
  const chain: Array<Record<string, unknown>> = [];
  let current = error;
  for (let index = 0; index < 6 && typeof current === "object" && current !== null; index += 1) {
    chain.push(current as Record<string, unknown>);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

const recognizedTransportCodes = new Set([
  "ABORT_ERR",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_ABORTED",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET"
]);

function controlledTransportCode(codes: string[], timedOut: boolean): string {
  const recognized = codes
    .map((code) => code.toUpperCase())
    .find((code) => recognizedTransportCodes.has(code));
  return recognized || (timedOut ? "REQUEST_TIMEOUT" : "TRANSPORT_FAILURE");
}

function safeTransportDiagnostic(details: ProviderTransportDetails) {
  return {
    diagnosticCode: details.timedOut ? "provider_request_timeout" : "provider_transport_error",
    providerCategory: details.causeCategory,
    durationMs: details.durationMs
  } as const;
}

function transportFailure(
  profile: TextProviderProfile,
  operation: string,
  url: string,
  cause: unknown,
  startedAt: number
): Error {
  if (cause instanceof ProviderTransportError
    || cause instanceof ProviderDestinationNotAllowedError
    || cause instanceof ProviderResponseTooLargeError) return cause;
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
  const transportCode = controlledTransportCode(codes, timedOut);
  const causeCategory = timedOut
    ? "timeout"
    : transportCode === "TRANSPORT_FAILURE" ? "transport" : "network";
  const causeMessage = timedOut
    ? "The provider request timed out."
    : causeCategory === "network"
      ? "The provider connection failed."
      : "The provider transport failed.";
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
    causeCategory,
    causeMessage
  };
  const message = timedOut
    ? `${providerName} ${operation} timed out after ${Math.round(timeoutMs / 60_000 * 10) / 10} minutes before a complete response was received. Nexus closed the provider request; increase Request timeout in the provider's Advanced settings or reduce the request workload.`
    : `${providerName} ${operation} could not complete because the provider connection failed (${transportCode}). Check the endpoint and Docker host logs for transport diagnostics.`;
  const error = new ProviderTransportError(message, details);
  logger.error({ event: "provider_transport_error", ...safeTransportDiagnostic(details) });
  return error;
}

export function providerTransportErrorDetails(error: unknown): ProviderTransportDetails | null {
  return error instanceof ProviderTransportError ? error.transport : null;
}

export function logProviderTransportError(error: unknown, context: Record<string, unknown>): void {
  const transport = providerTransportErrorDetails(error);
  if (!transport) return;
  logger.error({
    event: "provider_transport_error_correlated",
    ...context,
    ...safeTransportDiagnostic(transport)
  });
}

async function providerFetch(
  profile: TextProviderProfile,
  operation: string,
  url: string,
  init: RequestInit,
  transport: ProviderTransport
): Promise<Response> {
  const timeoutMs = requestTimeoutMs(profile);
  const startedAt = Date.now();
  try {
    const response = await transport.fetch(profile, operation, url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs)
    });
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

function headers(profile: TextProviderProfile, endpoint?: string): Record<string, string> {
  let forwardAuthorization = Boolean(profile.apiKey);
  if (endpoint) {
    try {
      forwardAuthorization = forwardAuthorization
        && new URL(endpoint).origin === new URL(profile.baseUrl).origin;
    } catch {
      forwardAuthorization = false;
    }
  }
  return {
    "content-type": "application/json",
    ...(forwardAuthorization ? { authorization: `Bearer ${profile.apiKey}` } : {}),
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
  url = response.url,
  limitBytes = MAX_PROVIDER_JSON_RESPONSE_BYTES
): Promise<Record<string, any>> {
  let text = "";
  try {
    text = await readBoundedResponseText(response, limitBytes);
  } catch (error) {
    if (!profile
      || error instanceof ProviderDestinationNotAllowedError
      || error instanceof ProviderResponseTooLargeError) throw error;
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

export async function ensureLmStudioModelLoaded(
  profile: TextProviderProfile,
  operation: string,
  transport: ProviderTransport = defaultProviderTransport()
): Promise<void> {
  if (profile.providerType !== "lmstudio" || !profile.model.trim()) return;
  try {
    const models = await discoverModels(profile, transport);
    const requested = profile.model.trim().toLowerCase();
    const matches = models.filter((item) => item.id.trim().toLowerCase() === requested || item.instanceId.trim().toLowerCase() === requested);
    if (!matches.length) return;
    if (matches.some((item) => item.loaded)) return;
    const targetModelId = matches[0]?.id || profile.model.trim();
    const url = `${lmStudioRoot(profile.baseUrl)}/api/v1/models/load`;
    const response = await providerFetch(profile, operation, url, {
      method: "POST",
      headers: headers(profile, url),
      body: JSON.stringify({ model: targetModelId })
    }, transport);
    if (!response.ok) return;
    await checkedJson(response, profile, operation, url);
  } catch {
    // If discovery or loading fails, allow the actual request to execute or report its own error.
  }
}

async function readSseStream(
  response: Response,
  onChunk: (delta: string, accumulated: string) => void | Promise<void>,
  profile: TextProviderProfile,
  operation: string,
  url: string
): Promise<{ content: string; finalData: Record<string, any>; allData: Record<string, any>[] }> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response body stream is not readable.");
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulated = "";
  let finalData: Record<string, any> = {};
  const allData: Record<string, any>[] = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_PROVIDER_SSE_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ProviderResponseTooLargeError(MAX_PROVIDER_SSE_RESPONSE_BYTES);
      }
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
  } catch (error) {
    throw transportFailure(profile, operation, url, error, responseStartTimes.get(response) ?? Date.now());
  } finally {
    reader.releaseLock();
  }
  return { content: accumulated, finalData, allData };
}

async function callLmStudio(profile: TextProviderProfile, request: ProviderRequest, transport: ProviderTransport): Promise<ProviderResult> {
  await ensureLmStudioModelLoaded(profile, "story generation model loading", transport);
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
  const response = await providerFetch(profile, "story generation", url, { method: "POST", headers: headers(profile, url), body: JSON.stringify(payload) }, transport);
  if (response.ok && request.onChunk && response.headers.get("content-type")?.includes("event-stream")) {
    const { content, finalData, allData } = await readSseStream(response, request.onChunk, profile, "story generation", url);
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

async function callOpenAiCompatible(profile: TextProviderProfile, request: ProviderRequest, transport: ProviderTransport): Promise<ProviderResult> {
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
  const send = () => providerFetch(profile, "story generation", url, { method: "POST", headers: headers(profile, url), body: JSON.stringify(payload) }, transport);
  let response = await send();
  if (!response.ok) {
    const clone = response.clone();
    const originalCancellation = response.body?.cancel();
    let text = "";
    try {
      text = await readBoundedResponseText(clone, MAX_PROVIDER_JSON_RESPONSE_BYTES);
    } catch (error) {
      throw transportFailure(profile, "story generation", url, error, responseStartTimes.get(response) ?? Date.now());
    } finally {
      await originalCancellation?.catch(() => undefined);
    }
    if (/response_format|json.?mode|structured.?output|grammar/i.test(text)) {
      delete payload.response_format;
      response = await send();
    } else {
      let data: Record<string, any> = {};
      try { data = text ? JSON.parse(text) as Record<string, any> : {}; } catch { /* response error below includes preview */ }
      const message = String(data.error?.message || data.error || text || response.statusText).slice(0, 2000);
      throw Object.assign(new Error(`Provider request failed (${response.status}): ${message}`), {
        statusCode: response.status,
        providerMessage: message
      });
    }
  }
  if (response.ok && request.onChunk && response.headers.get("content-type")?.includes("event-stream")) {
    const { content, finalData, allData } = await readSseStream(response, request.onChunk, profile, "story generation", url);
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

export async function callTextProvider(
  profile: TextProviderProfile,
  request: ProviderRequest,
  transport: ProviderTransport = defaultProviderTransport()
): Promise<ProviderResult> {
  return profile.providerType === "lmstudio"
    ? callLmStudio(profile, request, transport)
    : callOpenAiCompatible(profile, request, transport);
}

export async function callEmbeddingProvider(
  profile: TextProviderProfile,
  inputs: string[],
  transport: ProviderTransport = defaultProviderTransport()
): Promise<EmbeddingResult> {
  if (!inputs.length) return {
    embeddings: [], model: profile.model, responseId: "", usage: { inputTokens: 0, totalTokens: 0 }, reportedCost: null
  };
  await ensureLmStudioModelLoaded(profile, "embedding model loading", transport);
  const url = `${openAiRoot(profile.baseUrl)}/embeddings`;
  const response = await providerFetch(profile, "embedding generation", url, {
    method: "POST",
    headers: headers(profile, url),
    body: JSON.stringify({ model: profile.model, input: inputs })
  }, transport);
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
  transport: ProviderTransport = defaultProviderTransport()
): Promise<ImageProviderResult> {
  await ensureLmStudioModelLoaded(profile, "image model loading", transport);
  const base = profile.providerType === "openrouter" ? rootUrl(profile.baseUrl) : openAiRoot(profile.baseUrl);
  const url = profile.providerType === "openrouter" ? `${base}/images` : `${base}/images/generations`;
  const payload: Record<string, unknown> = {
    model: profile.model,
    prompt: request.prompt,
    n: request.imageCount ?? 1,
    size: request.size,
    quality: request.quality,
    output_format: request.outputFormat,
    ...(profile.providerType === "openrouter" ? { aspect_ratio: request.aspectRatio } : { response_format: "b64_json" })
  };
  const data = await checkedJson(await providerFetch(profile, "image generation", url, {
    method: "POST",
    headers: headers(profile, url),
    body: JSON.stringify(payload)
  }, transport), profile, "image generation", url, MAX_IMAGE_PROVIDER_RESPONSE_BYTES);
  const images = Array.isArray(data.data) ? data.data : [];
  const artifacts = images.map((image): ImageProviderArtifact => {
    const base64 = String(image?.b64_json || "").replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "").trim();
    if (!base64) {
      if (image?.url) throw new Error("The image provider returned only a temporary URL. Configure it to return base64 image data so Nexus can persist the asset safely.");
      throw new Error("The image provider response did not contain base64 image data.");
    }
    const mediaType = String(image?.media_type || `image/${request.outputFormat === "jpeg" ? "jpeg" : request.outputFormat}`).toLowerCase();
    if (!(["image/png", "image/jpeg", "image/webp"] as const).includes(mediaType as "image/png" | "image/jpeg" | "image/webp")) {
      throw new Error(`The image provider returned unsupported media type '${mediaType}'.`);
    }
    return { source: "base64", base64, mimeType: mediaType as ImageProviderResult["mimeType"] };
  });
  const first = artifacts[0];
  if (!first || first.source !== "base64") throw new Error("The image provider response did not contain image data.");
  return {
    base64: first.base64,
    mimeType: first.mimeType,
    artifacts,
    responseId: String(data.id || images[0]?.id || ""),
    usage: typeof data.usage === "object" && data.usage ? data.usage : {},
    reportedCost: reportedProviderCost(data.usage),
    rawMetadata: { created: data.created || null, provider: data.provider || "" }
  };
}

type AsyncImageProviderAdapter = {
  submit(profile: TextProviderProfile, request: ImageProviderRequest, transport: ProviderTransport): Promise<ImageProviderSubmissionResult>;
  poll?(profile: TextProviderProfile, remoteJobId: string, transport: ProviderTransport): Promise<ImageProviderPollResult>;
  cancel?(profile: TextProviderProfile, remoteJobId: string, transport: ProviderTransport): Promise<void>;
};

const compatibleImageProviderAdapter: AsyncImageProviderAdapter = {
  async submit(profile, request, transport) {
    const result = await callImageProvider(profile, request, transport);
    return {
      mode: "completed",
      artifacts: result.artifacts,
      usage: result.usage,
      reportedCost: result.reportedCost,
      providerMetadata: { responseId: result.responseId, ...result.rawMetadata }
    };
  }
};

const sogniImageProviderAdapter: AsyncImageProviderAdapter = {
  async submit(profile, request, transport) {
    const dimensions = /^(\d{2,5})x(\d{2,5})$/.exec(request.size);
    const imageCount = request.imageCount ?? 1;
    if (imageCount !== 1 && imageCount !== 2) throw new Error("Image count must be one or two.");
    const submitted = await submitSogniGeneration(profile, {
      prompt: request.prompt,
      idempotencyKey: String(request.idempotencyKey || ""),
      imageCount,
      outputFormat: request.outputFormat,
      ...(request.negativePrompt !== undefined ? { negativePrompt: request.negativePrompt } : {}),
      ...((request.width !== undefined || dimensions) ? { width: request.width ?? Number(dimensions?.[1]) } : {}),
      ...((request.height !== undefined || dimensions) ? { height: request.height ?? Number(dimensions?.[2]) } : {}),
      ...(request.aspectRatio !== undefined ? { aspectRatio: request.aspectRatio } : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      ...(request.steps !== undefined ? { steps: request.steps } : {}),
      ...(request.guidance !== undefined ? { guidance: request.guidance } : {}),
      ...(request.scheduler !== undefined ? { scheduler: request.scheduler } : {})
    }, (url, init) => transport.fetch(profile, "image generation submission", String(url), init || {}));
    return { mode: "pending", ...submitted };
  },
  async poll(profile, remoteJobId, transport) {
    const result = await pollSogniGeneration(
      profile,
      remoteJobId,
      (url, init) => transport.fetch(profile, "image generation polling", String(url), init || {})
    );
    if (result.status === "completed") return {
      ...result,
      reportedCost: reportedProviderCost(result.usage)
    };
    return result;
  },
  async cancel(profile, remoteJobId, transport) {
    await cancelSogniGeneration(
      profile,
      remoteJobId,
      (url, init) => transport.fetch(profile, "image generation cancellation", String(url), init || {})
    );
  }
};

const sogniSdkImageProviderAdapter: AsyncImageProviderAdapter = {
  async submit(profile, request) {
    return { mode: "pending", ...await submitSogniSdkGeneration(profile, request) };
  },
  async poll(profile, remoteJobId) {
    return pollSogniSdkGeneration(profile, remoteJobId);
  },
  cancel: cancelSogniSdkGeneration
};

export const imageProviderRegistry: Readonly<Partial<Record<ProviderType, AsyncImageProviderAdapter>>> = Object.freeze({
  lmstudio: compatibleImageProviderAdapter,
  openrouter: compatibleImageProviderAdapter,
  openai_compatible: compatibleImageProviderAdapter,
  manifest: compatibleImageProviderAdapter,
  sogni: sogniImageProviderAdapter,
  sogni_sdk: sogniSdkImageProviderAdapter
});

function imageProviderAdapter(profile: TextProviderProfile): AsyncImageProviderAdapter {
  const adapter = imageProviderRegistry[profile.providerType];
  if (!adapter) throw new Error(`No image provider adapter is registered for '${profile.providerType}'.`);
  return adapter;
}

export async function submitImageProvider(
  profile: TextProviderProfile,
  request: ImageProviderRequest,
  transport: ProviderTransport = defaultProviderTransport()
): Promise<ImageProviderSubmissionResult> {
  if (profile.providerType === "sogni_sdk") await transport.validateSdkEndpoint(profile);
  return imageProviderAdapter(profile).submit(profile, request, transport);
}

export async function pollImageProvider(
  profile: TextProviderProfile,
  request: { remoteJobId: string },
  transport: ProviderTransport = defaultProviderTransport()
): Promise<ImageProviderPollResult> {
  if (profile.providerType === "sogni_sdk") await transport.validateSdkEndpoint(profile);
  const adapter = imageProviderAdapter(profile);
  if (!adapter.poll) throw new Error(`Image provider '${profile.providerType}' does not use asynchronous polling.`);
  return adapter.poll(profile, request.remoteJobId, transport);
}

export async function cancelImageProvider(
  profile: TextProviderProfile,
  request: { remoteJobId: string },
  transport: ProviderTransport = defaultProviderTransport()
): Promise<void> {
  if (profile.providerType === "sogni_sdk") await transport.validateSdkEndpoint(profile);
  const adapter = imageProviderAdapter(profile);
  if (!adapter.cancel) throw new Error(`Image provider '${profile.providerType}' does not support cancellation.`);
  await adapter.cancel(profile, request.remoteJobId, transport);
}

function inventoryRows(data: Record<string, any> | any[]): any[] {
  return Array.isArray(data) ? data : Array.isArray(data.models) ? data.models : Array.isArray(data.data) ? data.data : [];
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

const SOGNI_SAMPLER_ALIASES: Readonly<Record<string, string>> = {
  Euler: "euler",
  "Euler a": "euler_a",
  "Euler Ancestral": "euler_ancestral",
  Heun: "heun",
  "DPM++ 2M": "dpmpp_2m",
  "DPM++ 2M SDE": "dpmpp_2m_sde",
  "DPM++ SDE": "dpmpp_sde",
  "DPM++ 3M SDE": "dpmpp_3m_sde",
  UniPC: "uni_pc",
  "LCM (Latent Consistency Model)": "lcm",
  LMS: "lms",
  "DPM 2": "dpm_2",
  "DPM 2 Ancestral": "dpm_2_ancestral",
  "DPM Fast": "dpm_fast",
  "DPM Adaptive": "dpm_adaptive",
  "DPM++ 2S Ancestral": "dpmpp_2s_ancestral",
  DDPM: "ddpm",
  "Discrete Flow Sampler (SD3)": "dfs_sd3",
  "Discrete Flow Scheduler (SD3)": "dfs_sd3",
  "DPM Solver Multistep (DPM-Solver++)": "dpm_pp",
  "PNDM (Pseudo-linear multi-step)": "pndm_plms"
};
const SOGNI_SCHEDULER_ALIASES: Readonly<Record<string, string>> = {
  Simple: "simple",
  Normal: "normal",
  Karras: "karras",
  Exponential: "exponential",
  "SGM Uniform": "sgm_uniform",
  "DDIM Uniform": "ddim_uniform",
  Beta: "beta",
  "Linear Quadratic": "linear_quadratic",
  "KL Optimal": "kl_optimal",
  DDIM: "ddim",
  Leading: "leading",
  Linear: "linear"
};

function sogniRange(value: any): { min: number; max: number; step: number; default: number } | undefined {
  const min = Number(value?.min);
  const max = Number(value?.max);
  const fallback = Number(value?.default);
  if (![min, max, fallback].every(Number.isFinite)) return undefined;
  const decimals = Number(value?.decimals);
  const step = Number.isFinite(decimals) && decimals > 0
    ? 10 ** -decimals
    : Number.isFinite(Number(value?.step)) ? Number(value.step) : 1;
  return { min, max, step, default: fallback };
}

function sogniOptions(value: any, aliases: Readonly<Record<string, string>>) {
  const allowed = Array.isArray(value?.allowed)
    ? value.allowed.map((item: unknown) => aliases[String(item)] || String(item))
    : [];
  const defaultValue = value?.default === null || value?.default === undefined
    ? undefined
    : aliases[String(value.default)] || String(value.default);
  return { allowed, defaultValue };
}

function sogniImageOptions(tier: any, presets: any[]): ModelInventoryItem["imageOptions"] | undefined {
  if (!tier || typeof tier !== "object" || ("type" in tier && tier.type !== "image")) return undefined;
  const sampler = sogniOptions(tier.sampler || tier.comfySampler, SOGNI_SAMPLER_ALIASES);
  const scheduler = sogniOptions(tier.scheduler || tier.comfyScheduler, SOGNI_SCHEDULER_ALIASES);
  return {
    sizePresets: presets.map((preset) => ({
      id: String(preset?.id || ""),
      label: String(preset?.label || preset?.id || ""),
      width: Number(preset?.width || 0),
      height: Number(preset?.height || 0),
      ratio: String(preset?.ratio || "")
    })).filter((preset) => preset.id),
    ...(sogniRange(tier.steps) ? { steps: sogniRange(tier.steps)! } : {}),
    ...(sogniRange(tier.guidance) ? { guidance: sogniRange(tier.guidance)! } : {}),
    samplers: sampler.allowed,
    ...(sampler.defaultValue ? { defaultSampler: sampler.defaultValue } : {}),
    schedulers: scheduler.allowed,
    ...(scheduler.defaultValue ? { defaultScheduler: scheduler.defaultValue } : {}),
    outputFormats: ["png", "jpeg", "webp"],
    maximumPreviews: 10
  };
}

async function optionalSogniInventory(
  profile: TextProviderProfile,
  transport: ProviderTransport,
  operation: string,
  url: string,
): Promise<Record<string, any> | any[] | null> {
  try {
    return await checkedJson(await providerFetch(profile, operation, url, { headers: headers(profile, url) }, transport), profile, operation, url);
  } catch {
    return null;
  }
}

async function discoverPinnedSogniSdkModels(
  profile: TextProviderProfile,
  transport: ProviderTransport,
): Promise<ModelInventoryItem[]> {
  const catalogUrl = "https://socket.sogni.ai/api/v1/models/list";
  const catalog = await checkedJson(await providerFetch(profile, "image model discovery", catalogUrl, { headers: headers(profile, catalogUrl) }, transport), profile, "image model discovery", catalogUrl);
  const models = inventoryRows(catalog).filter((model: any) => String(model?.media || "").toLowerCase() === "image");
  const [fastStatus, relaxedStatus, tiers] = await Promise.all([
    optionalSogniInventory(profile, transport, "image model availability discovery", "https://socket.sogni.ai/api/v1/status/network/fast/models"),
    optionalSogniInventory(profile, transport, "image model availability discovery", "https://socket.sogni.ai/api/v1/status/network/relaxed/models"),
    optionalSogniInventory(profile, transport, "image model options discovery", "https://socket.sogni.ai/api/v2/models/tiers")
  ]);
  const workerCounts = {
    fast: fastStatus && !Array.isArray(fastStatus) ? fastStatus : {},
    relaxed: relaxedStatus && !Array.isArray(relaxedStatus) ? relaxedStatus : {}
  };
  const selectedNetwork = profile.configuration?.network === "relaxed" ? "relaxed" : "fast";
  return Promise.all(models.map(async (model: any): Promise<ModelInventoryItem> => {
    const fastWorkers = Number(workerCounts.fast[String(model.SID)] || 0);
    const relaxedWorkers = Number(workerCounts.relaxed[String(model.SID)] || 0);
    const selectedWorkers = selectedNetwork === "relaxed" ? relaxedWorkers : fastWorkers;
    const presetsUrl = `https://socket.sogni.ai/api/v1/size-presets/network/${selectedNetwork}/model/${encodeURIComponent(String(model.id || ""))}`;
    const presetsResponse = await optionalSogniInventory(profile, transport, "image model preset discovery", presetsUrl);
    const presets = Array.isArray(presetsResponse) ? presetsResponse : [];
    const tier = tiers && !Array.isArray(tiers) ? tiers[String(model.tier || "")] : undefined;
    const imageOptions = sogniImageOptions(tier, presets);
    return {
      id: String(model.id || ""),
      displayName: String(model.name || model.id || ""),
      loaded: selectedWorkers > 0,
      instanceId: String(model.id || ""),
      contextLength: 0,
      workerCount: selectedWorkers,
      workerAvailability: [
        { type: "fast", displayName: "Fast GPU workers", workerCount: fastWorkers, description: "High-end GPU workers that generate images faster at a higher cost." },
        { type: "relaxed", displayName: "Relaxed Mac workers", workerCount: relaxedWorkers, description: "Mac workers that generate images more slowly at a lower cost." }
      ],
      media: "image",
      ...(imageOptions ? { imageOptions } : {})
    };
  })).then((items) => items.filter((item) => item.id));
}

function pricingEntries(value: unknown, provider?: string): Array<{ billable: string; unit: string; costUsd: number; provider?: string }> {
  const rows = Array.isArray(value) ? value : [];
  return rows.flatMap((row: any) => {
    const costUsd = Number(row?.cost_usd ?? row?.costUsd);
    if (!Number.isFinite(costUsd) || costUsd < 0) return [];
    return [{
      billable: String(row?.billable || "usage"),
      unit: String(row?.unit || "unit"),
      costUsd,
      ...(provider ? { provider } : {})
    }];
  });
}

function textPricing(model: any): ModelInventoryItem["pricing"] | undefined {
  const pricing = model?.pricing && typeof model.pricing === "object" ? model.pricing : {};
  const entries = [
    ["input_token", "token", pricing.prompt],
    ["output_token", "token", pricing.completion]
  ].flatMap(([billable, unit, raw]) => {
    const costUsd = Number(raw);
    return Number.isFinite(costUsd) && costUsd >= 0 ? [{ billable: String(billable), unit: String(unit), costUsd }] : [];
  });
  return entries.length ? { category: "text", entries } : undefined;
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

export async function discoverModels(
  profile: TextProviderProfile,
  transport: ProviderTransport = defaultProviderTransport()
): Promise<ModelInventoryItem[]> {
  const url = profile.providerType === "lmstudio"
    ? `${lmStudioRoot(profile.baseUrl)}/api/v1/models`
    : `${openAiRoot(profile.baseUrl)}/models`;
  const data = await checkedJson(await providerFetch(profile, "model discovery", url, { headers: headers(profile, url) }, transport), profile, "model discovery", url);
  const rows = inventoryRows(data);
  const items = inventoryItems(rows);
  if (profile.providerType !== "openrouter") return items;
  const byId = new Map(rows.map((row: any) => [String(row.id || row.key || ""), row]));
  return items.map((item) => {
    const pricing = textPricing(byId.get(item.id));
    return { ...item, ...(pricing ? { pricing } : {}) };
  });
}

export async function discoverEmbeddingModels(
  profile: TextProviderProfile,
  transport: ProviderTransport = defaultProviderTransport()
): Promise<ModelInventoryItem[]> {
  if (profile.providerType !== "openrouter") return discoverModels(profile, transport);
  const url = `${rootUrl(profile.baseUrl)}/embeddings/models`;
  const data = await checkedJson(await providerFetch(profile, "embedding model discovery", url, { headers: headers(profile, url) }, transport), profile, "embedding model discovery", url);
  return inventoryRows(data).map((model: any) => ({
    id: String(model.id || model.canonical_slug || model.key || ""),
    displayName: String(model.name || model.display_name || model.id || model.canonical_slug || model.key || ""),
    loaded: true,
    instanceId: String(model.id || model.canonical_slug || model.key || ""),
    contextLength: Number(model.context_length || model.top_provider?.context_length || 0)
  })).filter((model: ModelInventoryItem) => model.id);
}

export async function discoverImageModels(
  profile: TextProviderProfile,
  transport: ProviderTransport = defaultProviderTransport()
): Promise<ModelInventoryItem[]> {
  if (profile.providerType === "sogni_sdk") {
    if (profile.configuration?.modelDiscoveryEnabled === false) return [];
    await transport.validateSdkEndpoint(profile);
    return discoverPinnedSogniSdkModels(profile, transport);
  }
  if (profile.providerType === "sogni") {
    if (profile.configuration?.modelDiscoveryEnabled === false) return [];
    const url = "https://socket.sogni.ai/api/v1/models/list";
    const data = await checkedJson(await providerFetch(profile, "image model discovery", url, { headers: headers(profile, url) }, transport), profile, "image model discovery", url);
    return inventoryItems(inventoryRows(data).filter((model: any) => String(model?.media || "").toLowerCase() === "image"));
  }
  if (profile.providerType !== "openrouter") {
    const url = profile.providerType === "lmstudio"
      ? `${lmStudioRoot(profile.baseUrl)}/api/v1/models`
      : `${openAiRoot(profile.baseUrl)}/models`;
    const data = await checkedJson(await providerFetch(profile, "image model discovery", url, { headers: headers(profile, url) }, transport), profile, "image model discovery", url);
    return inventoryItems(imageInventoryRows(inventoryRows(data)));
  }
  const url = `${rootUrl(profile.baseUrl)}/images/models`;
  const data = await checkedJson(await providerFetch(profile, "image model discovery", url, { headers: headers(profile, url) }, transport), profile, "image model discovery", url);
  const rows = imageInventoryRows(inventoryRows(data)).filter((model: any) => explicitImageCapability(model) !== false);
  return Promise.all(rows.map(async (model: any): Promise<ModelInventoryItem> => {
    const id = String(model.id || model.key || "");
    let entries = pricingEntries(model.pricing);
    const endpointPath = String(model.endpoints || "");
    if (!entries.length && endpointPath) {
      try {
        const endpointUrl = new URL(endpointPath, `${rootUrl(profile.baseUrl)}/`).toString();
        const endpointData = await checkedJson(await providerFetch(profile, "image model pricing discovery", endpointUrl, { headers: headers(profile, endpointUrl) }, transport), profile, "image model pricing discovery", endpointUrl);
        entries = (Array.isArray(endpointData.endpoints) ? endpointData.endpoints : []).flatMap((endpoint: any) =>
          pricingEntries(endpoint.pricing, String(endpoint.provider_name || endpoint.provider_slug || ""))
        );
      } catch {
        // Model discovery remains useful when optional endpoint-level pricing is unavailable.
      }
    }
    return {
      id,
      displayName: String(model.name || model.display_name || model.id || model.key || ""),
      loaded: true,
      instanceId: id,
      contextLength: 0,
      ...(entries.length ? { pricing: { category: "image" as const, entries } } : {})
    };
  })).then((models) => models.filter((model) => model.id));
}
