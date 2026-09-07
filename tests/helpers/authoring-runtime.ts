import { createHash } from "node:crypto";
import { authoringSubmitSchema, worldContentSchema } from "../../packages/contracts/src/index.js";
import { createAuthoringExecutionSnapshot, AUTHORING_EXECUTION_PROTOCOLS } from "../../services/runtime/src/authoring-stage-adapter.js";
import { createRuntimeAuthoringWorkerApplication } from "../../services/runtime/src/authoring-composition.js";
import type { RuntimeTextExecution } from "../../services/runtime/src/provider-credential-transport-adapter.js";
import type { ProviderResult } from "../../packages/story-engine/src/providers.js";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

export const authoringHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const authoringResult = (content: string): ProviderResult => ({ content, responseId: "synthetic", finishReason: "stop", outputLimited: false, modelInstanceId: "synthetic", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, reportedCost: null, rawMetadata: {} });

export function authoringRuntimeFixture(execute: RuntimeTextExecution["execute"]) {
  const provider: RuntimeTextExecution = { id: "00000000-0000-4000-8000-000000000011", name: "Synthetic", providerRole: "text", providerType: "lmstudio", model: "pinned-model", contextWindowTokens: 32768, maxOutputTokens: 4096, temperature: 0.7, requestTimeoutMs: 30000, endpointIdentity: "opaque-endpoint", configuration: {}, execute };
  const input = authoringSubmitSchema.parse({ kind: "character", idempotencyKey: "00000000-0000-4000-8000-000000000012", target: { kind: "new_world" }, prompt: "Create a cartographer.", content: worldContentSchema.parse({ world: { title: "Lifecycle fixture" } }) });
  const snapshot = createAuthoringExecutionSnapshot(provider, { character_generation: "Pinned character prompt." }, AUTHORING_EXECUTION_PROTOCOLS, authoringHash);
  const providers = {
    resolution: { resolveDirect: async () => ({ status: "resolved", providerProfileId: provider.id, model: provider.model }) },
    execution: { text: async () => provider },
    prompts: { loadWorldGenerationPromptSnapshot: async () => ({ snapshot: { character_generation: { content: "Pinned character prompt." } } }) },
    promptTools: { content: (value: Record<string, { content?: string }>, key: string) => value[key]?.content ?? "" }
  } as unknown as Parameters<typeof createRuntimeAuthoringWorkerApplication>[0]["providers"];
  return { provider, providers, input, snapshot };
}
