import {
  campaignListResponseSchema, providerListResponseSchema, providerProfileInputSchema, providerProfileUpdateSchema,
  safeProviderProfileViewSchema, promptTemplateOverrideSchema, type PromptCatalogKey
} from "@infinite-quest/contracts";
import { createNexusHttpClient, createNoopSessionPort, createProviderPresetsApi } from "@infinite-quest/client-web";
import { z } from "zod";

const preview = z.object({
  sections: z.array(z.object({ label: z.string(), role: z.string(), content: z.string() })),
  estimatedTokens: z.number(), unresolvedVariables: z.array(z.string())
});
const library = z.object({
  templates: z.array(z.object({
    key: z.string(), title: z.string(), category: z.string(), description: z.string(),
    variables: z.array(z.string()), maxLength: z.number().int(), campaignOverrideAllowed: z.boolean(),
    effectiveSource: z.enum(["shipped", "application", "campaign"]), effectiveContent: z.string(),
    compatibility: z.object({ requiredShapeVersion: z.string(), requiredShapePreview: z.string(), acknowledged: z.boolean() }).nullish()
  }))
});
const inventory = z.object({ models: z.array(z.object({
  id: z.string(), displayName: z.string(), loaded: z.boolean().optional()
}).passthrough()) });
const metadata = z.object({capabilities: z.object({nativeTextExecutionPlans: z.boolean().optional()}).default({})});
type Scope = {key: PromptCatalogKey; scope: "campaign" | "application"; campaignId?: string};
export type ProviderSettingsApi = ReturnType<typeof createOwnerSettingsApis>["providers"];
export type PromptSettingsApi = ReturnType<typeof createOwnerSettingsApis>["prompts"];

export function createOwnerSettingsApis(fetchImpl: typeof fetch = fetch) {
  const http = createNexusHttpClient({basePath: "/api/v1", session: createNoopSessionPort(), fetchImpl});
  const providerPath = (id: string) => `/providers/${z.uuid().parse(id)}`;
  const json = (value: unknown) => ({kind: "json" as const, value});
  return {
    providers: {
      presets: createProviderPresetsApi(http),
      list: (signal: AbortSignal) => http.request({method: "GET", path: "/providers", responseSchema: providerListResponseSchema, signal}),
      metadata: (signal: AbortSignal) => http.request({method: "GET", path: "/meta", responseSchema: metadata, signal}),
      save(id: string, value: Record<string, unknown>, signal: AbortSignal) {
        const {apiKey, ...fields} = value;
        const body = apiKey ? {...fields, apiKey} : fields;
        return http.request({method: id ? "PATCH" : "POST", path: id ? providerPath(id) : "/providers",
          body: json((id ? providerProfileUpdateSchema : providerProfileInputSchema).parse(body)), responseSchema: safeProviderProfileViewSchema, signal});
      },
      remove: (id: string, signal: AbortSignal) => http.request({method: "DELETE", path: providerPath(id), responseKind: "empty", signal}),
      makeDefault: (id: string, signal: AbortSignal) => http.request({method: "PUT", path: providerPath(id) + "/default", body: json({}), responseKind: "empty", signal}),
      models: (id: string, signal: AbortSignal) => http.request({method: "GET", path: providerPath(id) + "/models?refresh=true", responseSchema: inventory, signal}),
      discover: (candidate: unknown, signal: AbortSignal) => http.request({method: "POST", path: "/providers/discover-models",
        body: json(providerProfileInputSchema.parse(candidate)), responseSchema: inventory, signal})
    },
    prompts: {
      campaigns: (signal: AbortSignal) => http.request({method: "GET", path: "/campaigns", responseSchema: campaignListResponseSchema, signal}),
      list: (id: string, signal: AbortSignal) => http.request({method: "GET", path: "/prompt-library" + (id ? `?campaignId=${z.uuid().parse(id)}` : ""), responseSchema: library, signal}),
      save: (value: Scope & {content: string}, signal: AbortSignal) => http.request({method: "PUT", path: "/prompt-library/overrides",
        body: json(promptTemplateOverrideSchema.parse(value)), responseSchema: z.object({library}), signal}),
      reset: (value: Scope & {allCampaigns?: boolean}, signal: AbortSignal) => http.request({method: "DELETE", path: "/prompt-library/overrides",
        body: json(value), responseSchema: z.object({library}), signal}),
      preview: (value: {key: PromptCatalogKey; content: string; campaignId?: string}, signal: AbortSignal) => http.request({method: "POST",
        path: "/prompt-library/preview", body: json(value), responseSchema: preview, signal})
    }
  };
}
