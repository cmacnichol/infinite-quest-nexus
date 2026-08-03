import type { GenerationApplication } from "../../packages/application/src/index.js";
import type { BuildServerOptions } from "../../services/api/src/server.js";

export type ServerOptionsOverrides = Readonly<
  Pick<BuildServerOptions, "config" | "pool"> &
  Partial<Pick<BuildServerOptions, "generation">>
>;

const inertGenerationApplication: GenerationApplication = {
  enqueueAppend: async () => { throw new Error("The inert generation application must not be called."); },
  enqueueReplacement: async () => { throw new Error("The inert generation application must not be called."); },
  getJob: async () => { throw new Error("The inert generation application must not be called."); },
  getResult: async () => { throw new Error("The inert generation application must not be called."); },
  retry: async () => { throw new Error("The inert generation application must not be called."); },
  cancel: async () => { throw new Error("The inert generation application must not be called."); },
  discard: async () => { throw new Error("The inert generation application must not be called."); }
};

export function serverOptions(overrides: ServerOptionsOverrides): BuildServerOptions {
  return {
    ...overrides,
    generation: overrides.generation ?? inertGenerationApplication
  };
}
