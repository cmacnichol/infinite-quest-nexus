import { createHash } from "node:crypto";
import {
  openRouterPresetSnapshotSchema,
  providerPresetSelectionInputSchema,
  type OpenRouterPresetSnapshot
} from "../../contracts/src/generation.js";
import { MAX_PROVIDER_JSON_RESPONSE_BYTES, ProviderResponseTooLargeError, readBoundedResponseText } from "./provider-response.js";
import type { ProviderTransport } from "./provider-transport.js";
import type { TextProviderProfile } from "./providers.js";

const MAX_DISCOVERY_PAGE_LIMIT = 100;
const MAX_PROVIDER_LIST_ITEMS = 32;
const MAX_PRESET_CONFIG_BYTES = 64 * 1024;
const MAX_PRESET_CONFIG_DEPTH = 6;
const PROVIDER_ENDPOINT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const QUANTIZATIONS = new Set(["int4", "int8", "fp4", "mxfp4", "nvfp4", "fp6", "fp8", "mxfp8", "fp16", "bf16", "fp32", "unknown"]);

export type OpenRouterPresetSummary = Readonly<{
  slug: string;
  name: string;
  status: string;
  designatedVersionId: string;
  updatedAt: string;
}>;

export type OpenRouterPresetDiscovery = Readonly<{
  list(profile: TextProviderProfile, page: { offset: number; limit: number }): Promise<{
    presets: readonly OpenRouterPresetSummary[];
    totalCount: number;
  }>;
  get(profile: TextProviderProfile, slug: string): Promise<OpenRouterPresetSnapshot>;
}>;

export class OpenRouterPresetDiscoveryError extends Error {
  readonly statusCode: number;

  constructor(message = "OpenRouter preset discovery is unavailable.", statusCode = 502) {
    super(message);
    this.name = "OpenRouterPresetDiscoveryError";
    this.statusCode = statusCode;
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new OpenRouterPresetDiscoveryError(`OpenRouter preset ${label} is invalid.`, 422);
  }
  return value.trim();
}

function presetSlug(value: unknown): string {
  const parsed = providerPresetSelectionInputSchema.safeParse({ presetSlug: value });
  if (!parsed.success) throw new OpenRouterPresetDiscoveryError("OpenRouter preset slug is invalid.", 422);
  return parsed.data.presetSlug;
}

function rootUrl(baseUrl: string): string {
  const root = baseUrl.trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(root);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error();
    return root;
  } catch {
    throw new OpenRouterPresetDiscoveryError("OpenRouter preset discovery is unavailable.");
  }
}

function headers(profile: TextProviderProfile): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(profile.apiKey?.trim() ? { authorization: `Bearer ${profile.apiKey.trim()}` } : {}),
    "HTTP-Referer": String(profile.configuration?.httpReferer || "https://github.com/cmacnichol/infinite-quest-nexus"),
    "X-Title": "Infinite Quest Nexus"
  };
}

function timeout(profile: TextProviderProfile): number {
  const value = Number(profile.requestTimeoutMs);
  return Number.isInteger(value) && value >= 1_000 && value <= 3_600_000 ? value : 300_000;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readBoundedResponseText(response, MAX_PROVIDER_JSON_RESPONSE_BYTES);
  } catch (error) {
    if (error instanceof ProviderResponseTooLargeError) throw error;
    throw new OpenRouterPresetDiscoveryError();
  }
  if (!response.ok) throw new OpenRouterPresetDiscoveryError();
  try {
    const parsed: unknown = text ? JSON.parse(text) : null;
    if (!plainObject(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new OpenRouterPresetDiscoveryError("OpenRouter preset response is invalid.", 502);
  }
}

async function request(
  transport: ProviderTransport,
  profile: TextProviderProfile,
  url: string,
): Promise<Record<string, unknown>> {
  if (profile.providerType !== "openrouter") {
    throw new OpenRouterPresetDiscoveryError("OpenRouter preset discovery requires an OpenRouter provider.", 400);
  }
  try {
    const response = await transport.fetch(profile, "OpenRouter preset discovery", url, {
      method: "GET",
      headers: headers(profile),
      signal: AbortSignal.timeout(timeout(profile))
    });
    return await readJson(response);
  } catch (error) {
    if (error instanceof OpenRouterPresetDiscoveryError || error instanceof ProviderResponseTooLargeError) throw error;
    throw new OpenRouterPresetDiscoveryError();
  }
}

function jsonWithinBounds(value: unknown, depth = 0): boolean {
  if (depth > MAX_PRESET_CONFIG_DEPTH) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= MAX_PROVIDER_LIST_ITEMS && value.every((item) => jsonWithinBounds(item, depth + 1));
  if (plainObject(value)) {
    const entries = Object.entries(value);
    return entries.length <= MAX_PROVIDER_LIST_ITEMS && entries.every(([key, item]) => key.length <= 100 && jsonWithinBounds(item, depth + 1));
  }
  return false;
}

function boundedStringArray(value: unknown, label: string, allowed?: ReadonlySet<string>, providerSlugs = true): string[] {
  if (!Array.isArray(value) || value.length > MAX_PROVIDER_LIST_ITEMS) {
    throw new OpenRouterPresetDiscoveryError(`OpenRouter preset ${label} is invalid.`, 422);
  }
  const values = value.map((item) => requiredString(item, label, 160));
  if (new Set(values).size !== values.length || values.some((item) => (providerSlugs && !PROVIDER_ENDPOINT_PATTERN.test(item)) || (allowed && !allowed.has(item)))) {
    throw new OpenRouterPresetDiscoveryError(`OpenRouter preset ${label} is invalid.`, 422);
  }
  return values;
}

function providerPolicy(value: unknown): Record<string, unknown> {
  if (!plainObject(value) || !jsonWithinBounds(value)) {
    throw new OpenRouterPresetDiscoveryError("OpenRouter preset provider policy is invalid.", 422);
  }
  const allowedKeys = new Set(["order", "only", "ignore", "allow_fallbacks", "require_parameters", "data_collection", "zdr", "quantizations", "sort", "max_price"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new OpenRouterPresetDiscoveryError("OpenRouter preset provider policy contains unsupported fields.", 422);
  }
  const result: Record<string, unknown> = {};
  for (const key of ["order", "only", "ignore"] as const) {
    if (value[key] !== undefined) result[key] = boundedStringArray(value[key], key);
  }
  for (const key of ["allow_fallbacks", "require_parameters", "zdr"] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "boolean") throw new OpenRouterPresetDiscoveryError("OpenRouter preset provider policy is invalid.", 422);
      result[key] = value[key];
    }
  }
  if (value.data_collection !== undefined) {
    if (value.data_collection !== "allow" && value.data_collection !== "deny") throw new OpenRouterPresetDiscoveryError("OpenRouter preset provider policy is invalid.", 422);
    result.data_collection = value.data_collection;
  }
  if (value.quantizations !== undefined) result.quantizations = boundedStringArray(value.quantizations, "quantizations", QUANTIZATIONS);
  if (value.sort !== undefined) {
    if (value.sort === "price" || value.sort === "throughput" || value.sort === "latency") {
      result.sort = value.sort;
    } else if (plainObject(value.sort)
      && Object.keys(value.sort).every((key) => key === "by" || key === "partition")
      && (value.sort.by === undefined || ["price", "throughput", "latency"].includes(String(value.sort.by)))
      && (value.sort.partition === undefined || value.sort.partition === "model")) {
      result.sort = Object.fromEntries(Object.entries(value.sort).sort(([left], [right]) => left.localeCompare(right)));
    } else {
      throw new OpenRouterPresetDiscoveryError("OpenRouter preset provider sorting is invalid.", 422);
    }
  }
  if (value.max_price !== undefined) {
    const maxPrice = value.max_price;
    const priceKeys = new Set(["prompt", "completion", "request", "image"]);
    if (!plainObject(maxPrice) || Object.keys(maxPrice).length === 0 || Object.keys(maxPrice).some((key) => !priceKeys.has(key))
      || Object.values(maxPrice).some((price) => typeof price !== "number" || !Number.isFinite(price) || price < 0 || price > 1_000_000)) {
      throw new OpenRouterPresetDiscoveryError("OpenRouter preset maximum price is invalid.", 422);
    }
    result.max_price = Object.fromEntries(Object.entries(maxPrice).sort(([left], [right]) => left.localeCompare(right)));
  }
  return result;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalize(item)]));
}

function snapshot(data: Record<string, unknown>, requestedSlug: string): OpenRouterPresetSnapshot {
  const preset = plainObject(data.data) ? data.data : data;
  const slug = presetSlug(preset.slug);
  if (slug !== requestedSlug) throw new OpenRouterPresetDiscoveryError("OpenRouter preset response is invalid.", 502);
  if (preset.status !== "active") throw new OpenRouterPresetDiscoveryError("OpenRouter preset is not active.", 422);
  const version = plainObject(preset.designated_version) ? preset.designated_version : null;
  if (!version || typeof version.system_prompt !== "string" || version.system_prompt.trim()) {
    throw new OpenRouterPresetDiscoveryError("OpenRouter preset contains unsupported prompt content.", 422);
  }
  const designatedVersionId = requiredString(preset.designated_version_id ?? version.id, "designated version ID");
  if (version.id !== undefined && requiredString(version.id, "designated version ID") !== designatedVersionId) {
    throw new OpenRouterPresetDiscoveryError("OpenRouter preset response is invalid.", 502);
  }
  if (!Number.isInteger(version.version) || Number(version.version) < 1) {
    throw new OpenRouterPresetDiscoveryError("OpenRouter preset version is invalid.", 422);
  }
  if (!plainObject(version.config) || !jsonWithinBounds(version.config)
    || Buffer.byteLength(JSON.stringify(version.config), "utf8") > MAX_PRESET_CONFIG_BYTES) {
    throw new OpenRouterPresetDiscoveryError("OpenRouter preset configuration is invalid.", 422);
  }
  const config = version.config;
  if (Object.keys(config).some((key) => key !== "model" && key !== "models" && key !== "provider")) {
    throw new OpenRouterPresetDiscoveryError("OpenRouter preset configuration contains unsupported fields.", 422);
  }
  const models = [
    ...(config.model === undefined ? [] : [requiredString(config.model, "model")]),
    ...(config.models === undefined ? [] : boundedStringArray(config.models, "models", undefined, false))
  ];
  if (!models.length || models.length > 5 || new Set(models).size !== models.length || models.some((model) => model.startsWith("@preset/"))) {
    throw new OpenRouterPresetDiscoveryError("OpenRouter preset models are invalid.", 422);
  }
  const policy = config.provider === undefined ? {} : providerPolicy(config.provider);
  const canonical = canonicalize({ models, providerPolicy: policy });
  const configHash = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  return openRouterPresetSnapshotSchema.parse({
    slug,
    designatedVersionId,
    version: version.version,
    configHash,
    models,
    providerPolicy: policy
  });
}

function listResult(data: Record<string, unknown>): { presets: readonly OpenRouterPresetSummary[]; totalCount: number } {
  const rows = data.data;
  if (!Array.isArray(rows)) throw new OpenRouterPresetDiscoveryError("OpenRouter preset response is invalid.", 502);
  const totalCount = data.total_count;
  if (!Number.isSafeInteger(totalCount) || Number(totalCount) < 0) {
    throw new OpenRouterPresetDiscoveryError("OpenRouter preset response is invalid.", 502);
  }
  const presets = rows.map((row) => {
    if (!plainObject(row)) throw new OpenRouterPresetDiscoveryError("OpenRouter preset response is invalid.", 502);
    return {
      slug: presetSlug(row.slug),
      name: requiredString(row.name, "name", 200),
      status: requiredString(row.status, "status", 40),
      designatedVersionId: requiredString(row.designated_version_id, "designated version ID"),
      updatedAt: requiredString(row.updated_at, "updated time", 100)
    };
  });
  return { presets, totalCount: Number(totalCount) };
}

export function createOpenRouterPresetDiscovery(transport: ProviderTransport): OpenRouterPresetDiscovery {
  return Object.freeze({
    async list(profile, page) {
      if (!Number.isSafeInteger(page.offset) || page.offset < 0 || page.offset > 1_000_000
        || !Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > MAX_DISCOVERY_PAGE_LIMIT) {
        throw new OpenRouterPresetDiscoveryError("OpenRouter preset page is invalid.", 400);
      }
      const query = new URLSearchParams({ offset: String(page.offset), limit: String(page.limit) });
      return listResult(await request(transport, profile, `${rootUrl(profile.baseUrl)}/presets?${query}`));
    },
    async get(profile, slug) {
      const parsedSlug = presetSlug(slug);
      return snapshot(await request(transport, profile, `${rootUrl(profile.baseUrl)}/presets/${encodeURIComponent(parsedSlug)}`), parsedSlug);
    }
  });
}
