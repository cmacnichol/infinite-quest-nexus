import type { DatabasePool, RuntimeConfig } from "../../../packages/database/src/index.js";
import type { ProviderTransport } from "../../../packages/story-engine/src/provider-transport.js";
import { closeDatabasePool } from "./shutdown.js";
import type { RuntimeGenerationEventSource } from "./generation-event-composition.js";

export type RuntimeLifecycleDependencies = {
  createPool(config: RuntimeConfig): DatabasePool;
  createTransport(config: RuntimeConfig): ProviderTransport;
  configureTransport(transport: ProviderTransport): void;
  createGenerationEvents(config: RuntimeConfig, pool: DatabasePool): RuntimeGenerationEventSource;
  dispatchRole(
    config: RuntimeConfig,
    pool: DatabasePool,
    signal: AbortSignal,
    generationEvents: RuntimeGenerationEventSource | undefined
  ): Promise<void>;
};

export async function runRuntimeLifecycle(
  config: RuntimeConfig,
  abortController: AbortController,
  dependencies: RuntimeLifecycleDependencies
): Promise<void> {
  const pool = dependencies.createPool(config);
  let providerTransport: ProviderTransport | undefined;
  let generationEvents: RuntimeGenerationEventSource | undefined;
  try {
    providerTransport = dependencies.createTransport(config);
    dependencies.configureTransport(providerTransport);
    if (config.role === "api" || config.role === "all") {
      generationEvents = dependencies.createGenerationEvents(config, pool);
      await generationEvents.start();
    }
    await dependencies.dispatchRole(config, pool, abortController.signal, generationEvents);
  } finally {
    try {
      if (providerTransport) await providerTransport.close();
    } finally {
      try {
        if (generationEvents) await generationEvents.close();
      } finally {
        await closeDatabasePool(pool);
      }
    }
  }
}
