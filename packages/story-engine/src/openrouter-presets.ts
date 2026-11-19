import { createHash } from "node:crypto";
import type { PresetPage, PresetSummary, ResolvedPreset, ProviderPresetDiagnosticCode } from "@infinite-quest/contracts";
import { providerRoutingPolicySchema } from "../../contracts/src/text-execution-plan.js";
import { stableStringify } from "../../domain/src/text.js";
import type { ProviderTransport, ProviderTransportProfile } from "./provider-transport.js";

const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_PROMPT_LENGTH = 200_000;
const MAX_MODELS = 32;
const CACHE_PARAMETERS = new Set(["cache_enabled", "cache_ttl_seconds"]);
const PRESET_PARAMETERS = new Set(["model", "models", "temperature", "top_p", "top_k", "frequency_penalty", "presence_penalty", "repetition_penalty", "min_p", "top_a", "seed", "max_tokens", "max_completion_tokens", "provider"]);
const PUBLIC_UNSUPPORTED_PRESET_FIELDS = new Set(["tools", "stop", "transforms"]);
const PROVIDER_PARAMETERS = new Set(Object.keys(providerRoutingPolicySchema.shape));
const MAX_PRICE_PARAMETERS = new Set(["prompt", "completion", "image", "request", "audio"]);

type CancellableRequestSignal = Readonly<{
  aborted: boolean;
  reason?: unknown;
  addEventListener(type: "abort", listener: () => void, options?: Readonly<{ once?: boolean }>): void;
  removeEventListener(type: "abort", listener: () => void): void;
}>;

export class OpenRouterPresetError extends Error {
  constructor(readonly diagnosticCode: ProviderPresetDiagnosticCode, message = "Preset discovery is unavailable.", readonly field?: string) {
    super(message);
  }
}

function profileHeaders(profile: ProviderTransportProfile): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}),
    "HTTP-Referer": "https://github.com/cmacnichol/infinite-quest-nexus",
    "X-Title": "Infinite Quest Nexus"
  };
}

function presetUrl(profile: ProviderTransportProfile, suffix: string): string {
  return `${profile.baseUrl.trim().replace(/\/+$/, "")}/presets${suffix}`;
}

function cancellationSignal(signal?: CancellableRequestSignal): Readonly<{ signal: AbortSignal; dispose(): void }> {
  const timeout = AbortSignal.timeout(60_000);
  if (!signal) return Object.freeze({ signal: timeout, dispose: () => undefined });
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) { abort(); return Object.freeze({ signal: AbortSignal.any([controller.signal, timeout]), dispose: () => undefined }); }
  signal.addEventListener("abort", abort, { once: true });
  return Object.freeze({
    signal: AbortSignal.any([controller.signal, timeout]),
    dispose: () => signal.removeEventListener("abort", abort)
  });
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status === 401 || response.status === 403) throw new OpenRouterPresetError("authentication");
  if (response.status === 404) throw new OpenRouterPresetError("preset_missing");
  if (!response.ok) throw new OpenRouterPresetError("discovery_unavailable");
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new OpenRouterPresetError("invalid_response");
  const reader = response.body?.getReader();
  if (!reader) throw new OpenRouterPresetError("invalid_response");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new OpenRouterPresetError("invalid_response");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  try { return JSON.parse(text); } catch { throw new OpenRouterPresetError("invalid_response"); }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OpenRouterPresetError("invalid_response");
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new OpenRouterPresetError("invalid_response");
  return value;
}

function nonNegativeInt(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new OpenRouterPresetError("invalid_response");
  return value as number;
}

function positiveInt(value: unknown): number {
  const result = nonNegativeInt(value);
  if (result < 1) throw new OpenRouterPresetError("invalid_response");
  return result;
}

function unsupported(field: string): never {
  const safeField = PUBLIC_UNSUPPORTED_PRESET_FIELDS.has(field) || PRESET_PARAMETERS.has(field) || CACHE_PARAMETERS.has(field) || field === "provider" ||
    (field.startsWith("provider.") && PROVIDER_PARAMETERS.has(field.slice("provider.".length))) ||
    (field.startsWith("provider.max_price.") && MAX_PRICE_PARAMETERS.has(field.slice("provider.max_price.".length)))
    ? field : "config";
  throw new OpenRouterPresetError("preset_config_unsupported", "Preset configuration is unsupported or invalid.", safeField);
}

function finiteNumber(value: unknown, field: string, minimum: number, maximum = Number.MAX_VALUE): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) unsupported(field);
  return value;
}

function positiveInteger(value: unknown, field: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) unsupported(field);
  return value as number;
}

function stringList(value: unknown, field: string, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum || value.some((entry) => typeof entry !== "string" || !entry.trim())) unsupported(field);
  return Object.freeze([...value]);
}

function providerConfig(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) unsupported("provider");
  const source = value as Record<string, unknown>;
  for (const field of Object.keys(source)) if (!PROVIDER_PARAMETERS.has(field)) unsupported(`provider.${field}`);
  const result: Record<string, unknown> = {};
  for (const [field, candidate] of Object.entries(source)) {
    // OpenRouter's optional routing fields use null for cleared UI controls.
    // max_price is an optional object, but is not nullable in its API schema.
    if (candidate === null && field !== "max_price") continue;
    const nullableNestedFields = field === "sort" ? ["by", "partition"]
      : field === "preferred_min_throughput" || field === "preferred_max_latency" ? ["p50", "p75", "p90", "p99"] : [];
    result[field] = candidate && typeof candidate === "object" && !Array.isArray(candidate) && nullableNestedFields.length
      ? Object.fromEntries(Object.entries(candidate).filter(([key, entry]) => entry !== null || !nullableNestedFields.includes(key)))
      : candidate;
  }
  const parsed = providerRoutingPolicySchema.safeParse(result);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path ?? [];
    unsupported(path[0] === "max_price" && typeof path[1] === "string"
      ? `provider.max_price.${path[1]}` : typeof path[0] === "string" ? `provider.${path[0]}` : "provider");
  }
  return freezeConfig(parsed.data);
}

function freezeConfig<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeConfig);
    Object.freeze(value);
  }
  return value;
}

/**
 * The single admission boundary for OpenRouter preset configuration. Runtime
 * resolution reuses this rather than maintaining a second routing allowlist.
 */
export function validateOpenRouterPresetConfig(value: unknown): Readonly<Record<string, unknown>> {
  const source = record(value);
  const result: Record<string, unknown> = {};
  for (const field of Object.keys(source)) if (!PRESET_PARAMETERS.has(field) && !CACHE_PARAMETERS.has(field)) unsupported(field);
  for (const [field, candidate] of Object.entries(source)) {
    switch (field) {
      case "cache_enabled": if (typeof candidate !== "boolean") unsupported(field); result[field] = candidate; break;
      case "cache_ttl_seconds": result[field] = positiveInteger(candidate, field); if ((candidate as number) > 86400) unsupported(field); break;
      case "model": if (typeof candidate !== "string" || !candidate.trim()) unsupported(field); result[field] = candidate; break;
      case "models": result[field] = stringList(candidate, field, MAX_MODELS); break;
      case "temperature": result[field] = finiteNumber(candidate, field, 0, 2); break;
      case "top_p": case "min_p": case "top_a": result[field] = finiteNumber(candidate, field, 0, 1); break;
      case "top_k": result[field] = positiveInteger(candidate, field, 0); break;
      case "frequency_penalty": case "presence_penalty": result[field] = finiteNumber(candidate, field, -2, 2); break;
      case "repetition_penalty": result[field] = finiteNumber(candidate, field, Number.EPSILON); break;
      case "seed": result[field] = positiveInteger(candidate, field, 0); break;
      case "max_tokens": case "max_completion_tokens": result[field] = positiveInteger(candidate, field); break;
      case "provider": if (candidate !== null) result[field] = providerConfig(candidate); break;
    }
  }
  return Object.freeze(result);
}

function summary(value: unknown): PresetSummary {
  const source = record(value);
  return Object.freeze({ slug: text(source.slug), name: text(source.name), status: text(source.status), designatedVersionId: text(source.designated_version_id), updatedAt: text(source.updated_at) });
}

export async function discoverOpenRouterPresets(profile: ProviderTransportProfile, request: Readonly<{ offset: number; limit: number; signal?: CancellableRequestSignal }>, transport: ProviderTransport): Promise<PresetPage> {
  if (profile.providerType !== "openrouter" || !Number.isSafeInteger(request.offset) || request.offset < 0 || !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) throw new OpenRouterPresetError("invalid_response");
  const url = presetUrl(profile, `?offset=${request.offset}&limit=${request.limit}`);
  const cancellation = cancellationSignal(request.signal);
  let envelope: Record<string, unknown>;
  try { envelope = record(await readJson(await transport.fetch(profile, "OpenRouter preset discovery", url, { method: "GET", headers: profileHeaders(profile), signal: cancellation.signal }))); } catch (error) { if (error instanceof OpenRouterPresetError) throw error; throw new OpenRouterPresetError("discovery_unavailable"); } finally { cancellation.dispose(); }
  if (!Array.isArray(envelope.data)) throw new OpenRouterPresetError("invalid_response");
  const presets = Object.freeze(envelope.data.map(summary));
  const totalCount = nonNegativeInt(envelope.total_count);
  if (totalCount < request.offset || presets.length > request.limit || request.offset + presets.length > totalCount || (presets.length === 0 && request.offset < totalCount)) throw new OpenRouterPresetError("invalid_response");
  return Object.freeze({ presets, totalCount, offset: request.offset, nextOffset: request.offset + presets.length < totalCount ? request.offset + presets.length : null });
}

export async function discoverOpenRouterPreset(profile: ProviderTransportProfile, slug: string, transport: ProviderTransport, signal?: CancellableRequestSignal): Promise<ResolvedPreset> {
  if (profile.providerType !== "openrouter" || !slug.trim()) throw new OpenRouterPresetError("invalid_response");
  const url = presetUrl(profile, `/${encodeURIComponent(slug)}`);
  const cancellation = cancellationSignal(signal);
  let source: Record<string, unknown>;
  try { source = record(record(await readJson(await transport.fetch(profile, "OpenRouter preset detail discovery", url, { method: "GET", headers: profileHeaders(profile), signal: cancellation.signal }))).data); } catch (error) { if (error instanceof OpenRouterPresetError) throw error; throw new OpenRouterPresetError("discovery_unavailable"); } finally { cancellation.dispose(); }
  if (source.slug !== slug) throw new OpenRouterPresetError("invalid_response");
  if (source.status !== "active") throw new OpenRouterPresetError("preset_inactive");
  const version = record(source.designated_version);
  const systemPrompt = text(version.system_prompt);
  if (systemPrompt.length > MAX_PROMPT_LENGTH) throw new OpenRouterPresetError("preset_config_unsupported", "Preset configuration is unsupported or invalid.", "system_prompt");
  const config = validateOpenRouterPresetConfig(version.config);
  const serialized = stableStringify(config);
  return Object.freeze({ slug: text(source.slug), name: text(source.name), versionId: text(version.id), version: positiveInt(version.version), systemPrompt, config, configHash: createHash("sha256").update(serialized).digest("hex") });
}
