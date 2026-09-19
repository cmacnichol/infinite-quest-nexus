import { createHash } from "node:crypto";
import type { PresetPage, PresetSummary, ResolvedPreset, ProviderPresetDiagnosticCode } from "@infinite-quest/contracts";
import type { ProviderTransport, ProviderTransportProfile } from "./provider-transport.js";

const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_PROMPT_LENGTH = 200_000;
const MAX_CONFIG_DEPTH = 16;
const MAX_MODELS = 32;
const MAX_PROVIDER_ARRAY = 64;

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

function cancellationSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(60_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
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

function boundedConfig(value: unknown, depth = 0, key = ""): unknown {
  if (depth > MAX_CONFIG_DEPTH) throw new OpenRouterPresetError("preset_config_unsupported");
  if (["messages", "tools", "transforms", "stop", "response_format"].includes(key)) throw new OpenRouterPresetError("preset_config_unsupported");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const limit = key === "models" ? MAX_MODELS : key === "order" || key === "only" || key === "ignore" ? MAX_PROVIDER_ARRAY : 64;
    if (value.length > limit) throw new OpenRouterPresetError("preset_config_unsupported");
    return Object.freeze(value.map((entry) => boundedConfig(entry, depth + 1)));
  }
  const source = record(value);
  return Object.freeze(Object.fromEntries(Object.entries(source).map(([entryKey, entry]) => [entryKey, boundedConfig(entry, depth + 1, entryKey)])));
}

function summary(value: unknown): PresetSummary {
  const source = record(value);
  return Object.freeze({ slug: text(source.slug), name: text(source.name), status: text(source.status), designatedVersionId: text(source.designated_version_id), updatedAt: text(source.updated_at) });
}

export async function discoverOpenRouterPresets(profile: ProviderTransportProfile, request: Readonly<{ offset: number; limit: number; signal?: AbortSignal }>, transport: ProviderTransport): Promise<PresetPage> {
  if (profile.providerType !== "openrouter" || !Number.isSafeInteger(request.offset) || request.offset < 0 || !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) throw new OpenRouterPresetError("invalid_response");
  const url = presetUrl(profile, `?offset=${request.offset}&limit=${request.limit}`);
  let envelope: Record<string, unknown>;
  try { envelope = record(await readJson(await transport.fetch(profile, "OpenRouter preset discovery", url, { method: "GET", headers: profileHeaders(profile), signal: cancellationSignal(request.signal) }))); } catch (error) { if (error instanceof OpenRouterPresetError) throw error; throw new OpenRouterPresetError("discovery_unavailable"); }
  if (!Array.isArray(envelope.data)) throw new OpenRouterPresetError("invalid_response");
  const presets = Object.freeze(envelope.data.map(summary));
  const totalCount = nonNegativeInt(envelope.total_count);
  if (totalCount < request.offset || presets.length > request.limit || request.offset + presets.length > totalCount || (presets.length === 0 && request.offset < totalCount)) throw new OpenRouterPresetError("invalid_response");
  return Object.freeze({ presets, totalCount, offset: request.offset, nextOffset: request.offset + presets.length < totalCount ? request.offset + presets.length : null });
}

export async function discoverOpenRouterPreset(profile: ProviderTransportProfile, slug: string, transport: ProviderTransport, signal?: AbortSignal): Promise<ResolvedPreset> {
  if (profile.providerType !== "openrouter" || !slug.trim()) throw new OpenRouterPresetError("invalid_response");
  const url = presetUrl(profile, `/${encodeURIComponent(slug)}`);
  let source: Record<string, unknown>;
  try { source = record(record(await readJson(await transport.fetch(profile, "OpenRouter preset detail discovery", url, { method: "GET", headers: profileHeaders(profile), signal: cancellationSignal(signal) }))).data); } catch (error) { if (error instanceof OpenRouterPresetError) throw error; throw new OpenRouterPresetError("discovery_unavailable"); }
  if (source.slug !== slug) throw new OpenRouterPresetError("invalid_response");
  if (source.status !== "active") throw new OpenRouterPresetError("preset_inactive");
  const version = record(source.designated_version);
  const systemPrompt = text(version.system_prompt);
  if (systemPrompt.length > MAX_PROMPT_LENGTH) throw new OpenRouterPresetError("preset_config_unsupported");
  const config = record(boundedConfig(version.config)) as Readonly<Record<string, unknown>>;
  const serialized = JSON.stringify(config);
  return Object.freeze({ slug: text(source.slug), name: text(source.name), versionId: text(version.id), version: positiveInt(version.version), systemPrompt, config, configHash: createHash("sha256").update(serialized).digest("hex") });
}
