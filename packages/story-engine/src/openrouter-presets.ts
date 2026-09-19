import { createHash } from "node:crypto";
import type { PresetPage, PresetSummary, ResolvedPreset, ProviderPresetDiagnosticCode } from "@infinite-quest/contracts";
import type { ProviderTransport, ProviderTransportProfile } from "./provider-transport.js";

const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_PROMPT_LENGTH = 200_000;
const MAX_CONFIG_DEPTH = 16;
const MAX_MODELS = 32;
const MAX_PROVIDER_ARRAY = 64;
const PRESET_PARAMETERS = new Set(["model", "models", "temperature", "top_p", "top_k", "frequency_penalty", "presence_penalty", "repetition_penalty", "min_p", "top_a", "seed", "max_tokens", "max_completion_tokens", "provider"]);
const PROVIDER_PARAMETERS = new Set(["order", "only", "ignore", "allow_fallbacks", "require_parameters", "data_collection", "sort", "quantizations", "enforce_distillable_text", "preferred_min_throughput", "preferred_max_latency", "max_price", "zdr"]);
const MAX_PRICE_PARAMETERS = new Set(["prompt", "completion", "image", "request"]);

type CancellableRequestSignal = Readonly<{
  aborted: boolean;
  reason?: unknown;
  addEventListener(type: "abort", listener: () => void, options?: Readonly<{ once?: boolean }>): void;
  removeEventListener(type: "abort", listener: () => void): void;
}>;

export class OpenRouterPresetError extends Error {
  constructor(readonly diagnosticCode: ProviderPresetDiagnosticCode, message = "Preset discovery is unavailable.") {
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
  throw new OpenRouterPresetError("preset_config_unsupported", `Preset config field '${field}' is unsupported or invalid.`);
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
    switch (field) {
      case "order": case "only": case "ignore": case "quantizations": result[field] = stringList(candidate, `provider.${field}`, MAX_PROVIDER_ARRAY); break;
      case "allow_fallbacks": case "require_parameters": case "enforce_distillable_text": case "zdr": if (typeof candidate !== "boolean") unsupported(`provider.${field}`); result[field] = candidate; break;
      case "data_collection": if (candidate !== "allow" && candidate !== "deny") unsupported("provider.data_collection"); result[field] = candidate; break;
      case "sort": if (candidate !== "price" && candidate !== "throughput" && candidate !== "latency") unsupported("provider.sort"); result[field] = candidate; break;
      case "preferred_min_throughput": case "preferred_max_latency": result[field] = finiteNumber(candidate, `provider.${field}`, 0); break;
      case "max_price": {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) unsupported("provider.max_price");
        const prices = candidate as Record<string, unknown>;
        if (!Object.keys(prices).length) unsupported("provider.max_price");
        for (const priceField of Object.keys(prices)) if (!MAX_PRICE_PARAMETERS.has(priceField)) unsupported(`provider.max_price.${priceField}`);
        result[field] = Object.freeze(Object.fromEntries(Object.entries(prices).map(([priceField, price]) => [priceField, finiteNumber(price, `provider.max_price.${priceField}`, 0)])));
        break;
      }
    }
  }
  return Object.freeze(result);
}

function boundedConfig(value: unknown): Readonly<Record<string, unknown>> {
  const source = record(value);
  const result: Record<string, unknown> = {};
  for (const field of Object.keys(source)) if (!PRESET_PARAMETERS.has(field)) unsupported(field);
  for (const [field, candidate] of Object.entries(source)) {
    switch (field) {
      case "model": if (typeof candidate !== "string" || !candidate.trim()) unsupported(field); result[field] = candidate; break;
      case "models": result[field] = stringList(candidate, field, MAX_MODELS); break;
      case "temperature": result[field] = finiteNumber(candidate, field, 0, 2); break;
      case "top_p": case "min_p": case "top_a": result[field] = finiteNumber(candidate, field, 0, 1); break;
      case "top_k": result[field] = positiveInteger(candidate, field, 0); break;
      case "frequency_penalty": case "presence_penalty": result[field] = finiteNumber(candidate, field, -2, 2); break;
      case "repetition_penalty": result[field] = finiteNumber(candidate, field, Number.EPSILON); break;
      case "seed": result[field] = positiveInteger(candidate, field, 0); break;
      case "max_tokens": case "max_completion_tokens": result[field] = positiveInteger(candidate, field); break;
      case "provider": result[field] = providerConfig(candidate); break;
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
  if (systemPrompt.length > MAX_PROMPT_LENGTH) throw new OpenRouterPresetError("preset_config_unsupported");
  const config = boundedConfig(version.config);
  const serialized = JSON.stringify(config);
  return Object.freeze({ slug: text(source.slug), name: text(source.name), versionId: text(version.id), version: positiveInt(version.version), systemPrompt, config, configHash: createHash("sha256").update(serialized).digest("hex") });
}
