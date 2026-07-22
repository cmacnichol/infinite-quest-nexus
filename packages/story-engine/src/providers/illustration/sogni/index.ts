import type { SensitiveContentFilter } from "../../../../../contracts/src/generation.js";

export const SOGNI_API_BASE_URL = "https://api.sogni.ai";
const SOGNI_WORKFLOWS_PATH = "/v1/creative-agent/workflows";

type Fetch = typeof fetch;

export type SogniProviderProfile = {
  baseUrl: string;
  model: string;
  requestTimeoutMs?: number;
  apiKey?: string;
  configuration?: Record<string, unknown>;
};

export type SogniGenerationRequest = {
  prompt: string;
  negativePrompt?: string;
  idempotencyKey: string;
  imageCount: 1 | 2;
  width?: number;
  height?: number;
  aspectRatio?: string;
  outputFormat: "png" | "jpeg" | "webp";
  seed?: number;
  steps?: number;
  guidance?: number;
  scheduler?: string;
  sensitiveContentFilter: SensitiveContentFilter;
};

export type SogniArtifact = {
  source: "url";
  url: string;
  mimeType?: "image/png" | "image/jpeg" | "image/webp";
};

export type NormalizedProviderError = {
  code: string;
  message: string;
  retryable: boolean;
  statusCode?: number;
  retryAfterMs?: number;
};

export class SogniProviderError extends Error {
  readonly normalized: NormalizedProviderError;
  readonly code: string;
  readonly permanent: boolean;
  readonly statusCode?: number;
  readonly retryAfterMs?: number;

  constructor(error: NormalizedProviderError) {
    super(error.message);
    this.name = "SogniProviderError";
    this.normalized = error;
    this.code = error.code;
    this.permanent = !error.retryable;
    if (error.statusCode !== undefined) this.statusCode = error.statusCode;
    if (error.retryAfterMs !== undefined) this.retryAfterMs = error.retryAfterMs;
  }
}

export type SogniSubmissionResult = {
  remoteJobId: string;
  pollAfterMs: number;
  providerMetadata: Record<string, unknown>;
};

export type SogniPollResult =
  | { status: "pending"; progress?: number; pollAfterMs: number; providerMetadata: Record<string, unknown> }
  | { status: "completed"; artifacts: SogniArtifact[]; usage: Record<string, unknown>; providerMetadata: Record<string, unknown> }
  | { status: "failed"; error: NormalizedProviderError; providerMetadata: Record<string, unknown> };

function rootUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function requestTimeoutMs(profile: SogniProviderProfile): number {
  const value = Number(profile.requestTimeoutMs);
  return Number.isInteger(value) && value >= 5_000 && value <= 3_600_000 ? value : 30_000;
}

function pollIntervalMs(profile: SogniProviderProfile): number {
  const value = Number(profile.configuration?.pollIntervalMs);
  return Number.isInteger(value) && value >= 1_000 && value <= 30_000 ? value : 2_000;
}

function authorizationHeaders(profile: SogniProviderProfile): Record<string, string> {
  if (!profile.apiKey?.trim()) {
    throw new SogniProviderError({ code: "authentication_required", message: "Sogni requires an API key.", retryable: false });
  }
  return {
    authorization: `Bearer ${profile.apiKey.trim()}`,
    "content-type": "application/json"
  };
}

function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1_000) : undefined;
}

function normalizeHttpError(response: Response, data: Record<string, any>, fallback: string): NormalizedProviderError {
  const message = String(data.error?.message || data.message || data.error || fallback || response.statusText).slice(0, 2_000);
  const providerCode = String(data.error?.code || data.errorCode || "").trim();
  const code = response.status === 401 ? "authentication_failed"
    : response.status === 402 ? "insufficient_balance"
      : response.status === 404 ? "remote_job_not_found"
        : response.status === 409 ? "provider_conflict"
          : response.status === 429 ? "rate_limited"
            : response.status === 400 || response.status === 422 ? "invalid_request"
              : response.status >= 500 ? "provider_unavailable"
                : providerCode || "provider_error";
  const retryDelay = retryAfterMs(response);
  return {
    code: providerCode ? `${code}:${providerCode}` : code,
    message: `Sogni request failed (${response.status}): ${message}`,
    retryable: response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500,
    statusCode: response.status,
    ...(retryDelay !== undefined ? { retryAfterMs: retryDelay } : {})
  };
}

async function requestJson(
  profile: SogniProviderProfile,
  path: string,
  init: RequestInit,
  fetcher: Fetch
): Promise<Record<string, any>> {
  const url = `${rootUrl(profile.baseUrl || SOGNI_API_BASE_URL)}${path}`;
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      headers: { ...authorizationHeaders(profile), ...init.headers },
      signal: init.signal || AbortSignal.timeout(requestTimeoutMs(profile))
    });
  } catch (error) {
    const timedOut = error instanceof Error && /(?:abort|timeout)/i.test(`${error.name} ${error.message}`);
    throw new SogniProviderError({
      code: timedOut ? "provider_request_timeout" : "provider_transport_error",
      message: timedOut ? "Sogni request timed out." : "Sogni could not be reached.",
      retryable: true
    });
  }
  const text = await response.text();
  let data: Record<string, any> = {};
  try { data = text ? JSON.parse(text) as Record<string, any> : {}; } catch { /* normalized below */ }
  if (!response.ok) throw new SogniProviderError(normalizeHttpError(response, data, text));
  return data;
}

function imageArguments(profile: SogniProviderProfile, request: SogniGenerationRequest): Record<string, unknown> {
  if (request.outputFormat === "webp") {
    throw new SogniProviderError({
      code: "unsupported_output_format",
      message: "Sogni's documented image project formats are PNG and JPEG; WebP output is not currently supported by this adapter.",
      retryable: false
    });
  }
  const supportsFilter = profile.configuration?.workflowSafeContentFilterSupported === true;
  if (request.sensitiveContentFilter !== "provider-default" && !supportsFilter) {
    throw new SogniProviderError({
      code: "unsupported_filter_override",
      message: "This Sogni profile has not declared support for workflow safe-content filter overrides.",
      retryable: false
    });
  }
  return {
    prompt: request.prompt,
    model: profile.model,
    ...(request.negativePrompt ? { negativePrompt: request.negativePrompt } : {}),
    ...(request.width && request.height ? { width: request.width, height: request.height } : {}),
    ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
    outputFormat: request.outputFormat === "jpeg" ? "jpg" : request.outputFormat,
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.steps !== undefined ? { steps: request.steps } : {}),
    ...(request.guidance !== undefined ? { guidance: request.guidance } : {}),
    ...(request.scheduler ? { scheduler: request.scheduler } : {}),
    ...(supportsFilter && request.sensitiveContentFilter !== "provider-default"
      ? { safeContentFilter: request.sensitiveContentFilter === "enabled" }
      : {})
  };
}

function workflowFrom(data: Record<string, any>): Record<string, any> {
  const workflow = data.data?.workflow || data.workflow;
  if (!workflow || typeof workflow !== "object") {
    throw new SogniProviderError({ code: "invalid_provider_response", message: "Sogni returned no workflow snapshot.", retryable: true });
  }
  return workflow;
}

export async function submitSogniGeneration(
  profile: SogniProviderProfile,
  request: SogniGenerationRequest,
  fetcher: Fetch = fetch
): Promise<SogniSubmissionResult> {
  if (!profile.model.trim()) {
    throw new SogniProviderError({ code: "model_required", message: "Select a Sogni image model before generating.", retryable: false });
  }
  if (!/^[\x21-\x7e]{8,192}$/.test(request.idempotencyKey)) {
    throw new SogniProviderError({ code: "invalid_idempotency_key", message: "Sogni idempotency keys must contain 8-192 printable ASCII characters.", retryable: false });
  }
  const args = imageArguments(profile, request);
  const steps = Array.from({ length: request.imageCount }, (_, index) => ({
    id: `image${index + 1}`,
    toolName: "generate_image",
    arguments: {
      ...args,
      ...(request.seed !== undefined && index > 0 ? { seed: (request.seed + index) >>> 0 } : {})
    }
  }));
  const data = await requestJson(profile, SOGNI_WORKFLOWS_PATH, {
    method: "POST",
    headers: { "Idempotency-Key": request.idempotencyKey },
    body: JSON.stringify({
      input: { title: "Infinite Quest illustration", steps },
      token_type: String(profile.configuration?.tokenType || "auto"),
      app_source: "infinite-quest-nexus",
      confirm_cost: true
    })
  }, fetcher);
  const workflow = workflowFrom(data);
  const remoteJobId = String(workflow.workflowId || "").trim();
  if (!remoteJobId) {
    throw new SogniProviderError({ code: "invalid_provider_response", message: "Sogni returned a workflow without an ID.", retryable: true });
  }
  return {
    remoteJobId,
    pollAfterMs: pollIntervalMs(profile),
    providerMetadata: { status: String(workflow.status || "queued") }
  };
}

function workflowProgress(workflow: Record<string, any>): number | undefined {
  const direct = Number(workflow.progress);
  if (Number.isFinite(direct)) return Math.max(0, Math.min(100, direct <= 1 ? direct * 100 : direct));
  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  if (!steps.length) return undefined;
  const complete = steps.filter((step: any) => /^(?:completed|succeeded|success)$/i.test(String(step?.status || ""))).length;
  return Math.round(complete / steps.length * 100);
}

function workflowArtifacts(workflow: Record<string, any>): SogniArtifact[] {
  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  return steps.flatMap((step: any) => Array.isArray(step?.artifacts) ? step.artifacts : [])
    .flatMap((artifact: any) => {
      const url = String(artifact?.url || "").trim();
      if (!/^https?:\/\//i.test(url)) return [];
      const rawType = String(artifact?.mimeType || artifact?.mediaType || artifact?.contentType || "").toLowerCase();
      const mimeType = (["image/png", "image/jpeg", "image/webp"] as const).find((value) => value === rawType);
      return [{ source: "url" as const, url, ...(mimeType ? { mimeType } : {}) }];
    });
}

function workflowFailure(workflow: Record<string, any>): NormalizedProviderError {
  const status = String(workflow.status || "failed").toLowerCase();
  const rawError = workflow.error || workflow.failure || {};
  const message = String(rawError.message || rawError.error || workflow.message || `Sogni workflow ended with status '${status}'.`).slice(0, 2_000);
  return {
    code: status === "cancelled" ? "provider_cancelled" : status === "partial_failure" ? "provider_partial_failure" : "provider_generation_failed",
    message,
    retryable: status !== "cancelled"
  };
}

export async function pollSogniGeneration(
  profile: SogniProviderProfile,
  remoteJobId: string,
  fetcher: Fetch = fetch
): Promise<SogniPollResult> {
  const id = remoteJobId.trim();
  if (!/^wf_[A-Za-z0-9._-]+$/.test(id)) {
    throw new SogniProviderError({ code: "invalid_remote_job_id", message: "Invalid Sogni workflow ID.", retryable: false });
  }
  const workflow = workflowFrom(await requestJson(profile, `${SOGNI_WORKFLOWS_PATH}/${encodeURIComponent(id)}`, {}, fetcher));
  const status = String(workflow.status || "queued").toLowerCase();
  const providerMetadata = { status, workflowId: id };
  if (["completed", "succeeded", "success"].includes(status)) {
    const artifacts = workflowArtifacts(workflow);
    if (!artifacts.length) return {
      status: "failed",
      error: { code: "missing_artifacts", message: "Sogni completed the workflow without an image artifact URL.", retryable: true },
      providerMetadata
    };
    return {
      status: "completed",
      artifacts,
      usage: typeof workflow.usage === "object" && workflow.usage ? workflow.usage : {},
      providerMetadata
    };
  }
  if (["failed", "partial_failure", "cancelled"].includes(status)) {
    return { status: "failed", error: workflowFailure(workflow), providerMetadata };
  }
  const progress = workflowProgress(workflow);
  return {
    status: "pending",
    ...(progress !== undefined ? { progress } : {}),
    pollAfterMs: pollIntervalMs(profile),
    providerMetadata
  };
}

export async function cancelSogniGeneration(
  profile: SogniProviderProfile,
  remoteJobId: string,
  fetcher: Fetch = fetch
): Promise<void> {
  const id = remoteJobId.trim();
  if (!/^wf_[A-Za-z0-9._-]+$/.test(id)) {
    throw new SogniProviderError({ code: "invalid_remote_job_id", message: "Invalid Sogni workflow ID.", retryable: false });
  }
  await requestJson(profile, `${SOGNI_WORKFLOWS_PATH}/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" }, fetcher);
}
