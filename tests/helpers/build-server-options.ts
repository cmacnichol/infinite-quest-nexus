import type { BuildServerOptions } from "../../services/api/src/server.js";
import type { GenerationEventSource } from "../../packages/application/src/index.js";
import { createApiGenerationApplication } from "../../services/runtime/src/generation-api-composition.js";

export type ServerOptionsOverrides = Readonly<
  Pick<BuildServerOptions, "config" | "pool"> &
  Partial<Pick<BuildServerOptions, "generation" | "generationEvents">>
>;

const inertGenerationEvents: GenerationEventSource = {
  async subscribe() {
    let resolvePending: ((result: IteratorResult<never>) => void) | undefined;
    let closed = false;
    return {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            if (closed) return { done: true as const, value: undefined };
            return new Promise<IteratorResult<never>>((resolve) => { resolvePending = resolve; });
          }
        };
      },
      async close() {
        if (closed) return;
        closed = true;
        resolvePending?.({ done: true, value: undefined });
      }
    };
  }
};

export function serverOptions(overrides: ServerOptionsOverrides): BuildServerOptions {
  return {
    ...overrides,
    generation: overrides.generation ?? createApiGenerationApplication(overrides.pool),
    generationEvents: overrides.generationEvents ?? inertGenerationEvents
  };
}
