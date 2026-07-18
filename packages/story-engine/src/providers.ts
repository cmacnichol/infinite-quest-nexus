import type { ProviderType } from "../../contracts/src/generation.js";

export type TextProviderProfile = {
  providerType: ProviderType;
  baseUrl: string;
  model: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  temperature: number;
  apiKey?: string;
  configuration?: Record<string, unknown>;
};

export type ProviderRequest = {
  systemPrompt: string;
  input: string;
  previousResponseId?: string;
  recoveryInput?: string;
};

export type ProviderResult = {
  content: string;
  responseId: string;
  finishReason: string;
  outputLimited: boolean;
  modelInstanceId: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  rawMetadata: Record<string, unknown>;
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
  usage: { inputTokens: number; totalTokens: number };
};

type Fetch = typeof fetch;

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

async function checkedJson(response: Response): Promise<Record<string, any>> {
  const text = await response.text();
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

async function callLmStudio(profile: TextProviderProfile, request: ProviderRequest, fetcher: Fetch): Promise<ProviderResult> {
  const payload: Record<string, unknown> = {
    model: profile.model,
    input: request.previousResponseId && request.recoveryInput
      ? request.recoveryInput
      : request.recoveryInput
        ? `${request.input}\n\nRECOVERY REQUIREMENT:\n${request.recoveryInput}`
        : request.input,
    store: true,
    stream: false,
    temperature: request.recoveryInput ? 0.2 : profile.temperature,
    max_output_tokens: profile.maxOutputTokens
  };
  if (request.previousResponseId) payload.previous_response_id = request.previousResponseId;
  else payload.system_prompt = request.systemPrompt;
  // Supplying context_length while targeting an already loaded LM Studio instance can load a duplicate.
  // The selected model/instance from inventory is therefore sent without a load-time override.
  const response = await fetcher(`${lmStudioRoot(profile.baseUrl)}/api/v1/chat`, { method: "POST", headers: headers(profile), body: JSON.stringify(payload) });
  const data = await checkedJson(response);
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
    rawMetadata: { status: data.status || "", modelInstanceId: data.model_instance_id || "" }
  };
}

async function callOpenAiCompatible(profile: TextProviderProfile, request: ProviderRequest, fetcher: Fetch): Promise<ProviderResult> {
  const messages = [
    { role: "system", content: request.systemPrompt },
    { role: "user", content: request.input },
    ...(request.recoveryInput ? [{ role: "assistant", content: "The previous response was incomplete or invalid." }, { role: "user", content: request.recoveryInput }] : [])
  ];
  const payload: Record<string, unknown> = {
    model: profile.model,
    messages,
    temperature: request.recoveryInput ? 0.2 : profile.temperature,
    max_tokens: profile.maxOutputTokens,
    response_format: { type: "json_object" }
  };
  const send = () => fetcher(`${openAiRoot(profile.baseUrl)}/chat/completions`, { method: "POST", headers: headers(profile), body: JSON.stringify(payload) });
  let response = await send();
  if (!response.ok) {
    const clone = response.clone();
    const text = await clone.text();
    if (/response_format|json.?mode|structured.?output|grammar/i.test(text)) {
      delete payload.response_format;
      response = await send();
    }
  }
  const data = await checkedJson(response);
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
  if (!inputs.length) return { embeddings: [], model: profile.model, usage: { inputTokens: 0, totalTokens: 0 } };
  const response = await fetcher(`${openAiRoot(profile.baseUrl)}/embeddings`, {
    method: "POST",
    headers: headers(profile),
    body: JSON.stringify({ model: profile.model, input: inputs })
  });
  const data = await checkedJson(response);
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
    usage: { inputTokens: Number(data.usage?.prompt_tokens || 0), totalTokens: Number(data.usage?.total_tokens || 0) }
  };
}

function inventoryRows(data: Record<string, any>): any[] {
  return Array.isArray(data.models) ? data.models : Array.isArray(data.data) ? data.data : [];
}

export async function discoverModels(profile: TextProviderProfile, fetcher: Fetch = fetch): Promise<ModelInventoryItem[]> {
  const url = profile.providerType === "lmstudio"
    ? `${lmStudioRoot(profile.baseUrl)}/api/v1/models`
    : `${openAiRoot(profile.baseUrl)}/models`;
  const data = await checkedJson(await fetcher(url, { headers: headers(profile) }));
  return inventoryRows(data).flatMap((model: any) => {
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
