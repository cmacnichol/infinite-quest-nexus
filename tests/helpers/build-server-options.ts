import type { BuildServerOptions } from "../../services/api/src/server.js";
import { createApiGenerationApplication } from "../../services/runtime/src/generation-api-composition.js";

export type ServerOptionsOverrides = Readonly<
  Pick<BuildServerOptions, "config" | "pool"> &
  Partial<Pick<BuildServerOptions, "generation">>
>;

export function serverOptions(overrides: ServerOptionsOverrides): BuildServerOptions {
  return {
    ...overrides,
    generation: overrides.generation ?? createApiGenerationApplication(overrides.pool)
  };
}
