import { NexusApiError } from "@infinite-quest/client-core";
import {
  providerProfileInputSchema,
  safePresetDetailSchema,
  safePresetPageSchema,
  type MetaResponse,
  type ProviderProfileInput,
  type SafePresetDetail,
  type SafePresetPage
} from "@infinite-quest/contracts";
import { z } from "zod";
import { validatedRequest } from "./api-client.js";
import type { NexusHttpClient } from "./http-client.js";

const providerIdSchema = z.uuid();
const presetSlugSchema = safePresetDetailSchema.shape.slug;
const savedListOptionsSchema = z.object({
  offset: z.number().int().min(0),
  limit: z.number().int().min(1).max(100),
  refresh: z.boolean().optional()
}).strict();
const candidateListOptionsSchema = savedListOptionsSchema.omit({ refresh: true });

export type ProviderPresetListOptions = Readonly<z.infer<typeof savedListOptionsSchema>>;
export type ProviderPresetCandidateListOptions = Readonly<z.infer<typeof candidateListOptionsSchema>>;

export interface ProviderPresetsApi {
  listSaved(providerProfileId: string, options: ProviderPresetListOptions, signal?: AbortSignal): Promise<SafePresetPage>;
  detailSaved(providerProfileId: string, slug: string, signal?: AbortSignal): Promise<SafePresetDetail>;
  listCandidate(candidate: ProviderProfileInput, options: ProviderPresetCandidateListOptions, signal?: AbortSignal): Promise<SafePresetPage>;
  detailCandidate(candidate: ProviderProfileInput, slug: string, signal?: AbortSignal): Promise<SafePresetDetail>;
}

export class ProviderPresetsUnsupportedError extends Error {
  readonly cause: NexusApiError;

  constructor(cause: NexusApiError) {
    super("This server does not support native OpenRouter Preset discovery.", { cause });
    this.name = "ProviderPresetsUnsupportedError";
    this.cause = cause;
  }
}

export type NativePresetSupport = Readonly<{ state: "supported" | "unsupported" }>;

export function nativePresetSupport(meta: MetaResponse): NativePresetSupport {
  return { state: meta.capabilities.nativeTextExecutionPlans === true ? "supported" : "unsupported" };
}

function withSignal<T extends object>(value: T, signal: AbortSignal | undefined): T & { signal?: AbortSignal } {
  return signal ? { ...value, signal } : value;
}

async function listOrUnsupported<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof NexusApiError && error.statusCode === 404) throw new ProviderPresetsUnsupportedError(error);
    throw error;
  }
}

function checkedProviderId(providerProfileId: string, path: string): string {
  return validatedRequest(providerIdSchema, providerProfileId, "GET", path);
}

function checkedSlug(slug: string, method: "GET" | "POST", path: string): string {
  return validatedRequest(presetSlugSchema, slug, method, path);
}

function checkedCandidate(candidate: ProviderProfileInput, path: string): ProviderProfileInput {
  return validatedRequest(providerProfileInputSchema, candidate, "POST", path);
}

export function createProviderPresetsApi(http: NexusHttpClient): ProviderPresetsApi {
  return {
    listSaved(providerProfileId, optionsValue, signal) {
      const basePath = "/providers/:providerId/presets";
      const providerId = checkedProviderId(providerProfileId, basePath);
      const options = validatedRequest(savedListOptionsSchema, optionsValue, "GET", basePath);
      const query = new URLSearchParams({ offset: String(options.offset), limit: String(options.limit) });
      if (options.refresh !== undefined) query.set("refresh", String(options.refresh));
      return listOrUnsupported(() => http.request(withSignal({
        method: "GET" as const,
        path: `/providers/${encodeURIComponent(providerId)}/presets?${query}`,
        responseSchema: safePresetPageSchema
      }, signal)));
    },

    detailSaved(providerProfileId, slugValue, signal) {
      const basePath = "/providers/:providerId/presets/:slug";
      const providerId = checkedProviderId(providerProfileId, basePath);
      const slug = checkedSlug(slugValue, "GET", basePath);
      return http.request(withSignal({
        method: "GET" as const,
        path: `/providers/${encodeURIComponent(providerId)}/presets/${encodeURIComponent(slug)}`,
        responseSchema: safePresetDetailSchema
      }, signal));
    },

    listCandidate(candidateValue, optionsValue, signal) {
      const path = "/providers/discover-presets";
      const candidate = checkedCandidate(candidateValue, path);
      const options = validatedRequest(candidateListOptionsSchema, optionsValue, "POST", path);
      const query = new URLSearchParams({ offset: String(options.offset), limit: String(options.limit) });
      return listOrUnsupported(() => http.request(withSignal({
        method: "POST" as const,
        path: `${path}?${query}`,
        body: { kind: "json" as const, value: candidate },
        responseSchema: safePresetPageSchema
      }, signal)));
    },

    detailCandidate(candidateValue, slugValue, signal) {
      const path = "/providers/resolve-preset";
      const candidate = checkedCandidate(candidateValue, path);
      const slug = checkedSlug(slugValue, "POST", path);
      return http.request(withSignal({
        method: "POST" as const,
        path: `${path}?slug=${encodeURIComponent(slug)}`,
        body: { kind: "json" as const, value: candidate },
        responseSchema: safePresetDetailSchema
      }, signal));
    }
  };
}
