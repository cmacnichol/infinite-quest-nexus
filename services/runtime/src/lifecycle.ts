import type { DatabasePool, RuntimeConfig } from "../../../packages/database/src/index.js";
import type { ProviderTransport } from "../../../packages/story-engine/src/provider-transport.js";
import { closeDatabasePool } from "./shutdown.js";

export type RuntimeLifecycleDependencies = {
  createPool(config: RuntimeConfig): DatabasePool;
  createTransport(config: RuntimeConfig): ProviderTransport;
  configureTransport(transport: ProviderTransport): void;
  dispatchRole(config: RuntimeConfig, pool: DatabasePool, signal: AbortSignal): Promise<void>;
};

export async function runRuntimeLifecycle(
  config: RuntimeConfig,
  abortController: AbortController,
  dependencies: RuntimeLifecycleDependencies
): Promise<void> {
  const pool = dependencies.createPool(config);
  let providerTransport: ProviderTransport | undefined;
  try {
    providerTransport = dependencies.createTransport(config);
    dependencies.configureTransport(providerTransport);
    await dependencies.dispatchRole(config, pool, abortController.signal);
  } finally {
    try {
      if (providerTransport) await providerTransport.close();
    } finally {
      await closeDatabasePool(pool);
    }
  }
}
