import type { PromptSnapshot } from "../../../packages/contracts/src/prompt-library.js";
import type { WorldContent } from "../../../packages/contracts/src/world-library.js";
import type { TemplateWorldInput } from "../../../packages/domain/src/world-template.js";
import type {
  InfiniteWorldsPromptPort,
  DirectProviderResolution,
  ProviderResolutionPort,
  PromptSnapshotVersion,
} from "../../../packages/application/src/providers/index.js";
import type { ProviderRequest, ProviderResult } from "../../../packages/story-engine/src/index.js";

/**
 * Narrow provider collaborators consumed by portable Infinite Worlds imports.
 * Provider credentials and the rest of the provider graph remain private to
 * the runtime composition.
 */
export type InfiniteWorldsImportProviderCollaborators = Readonly<{
  resolution: ProviderResolutionPort;
  prompts: InfiniteWorldsPromptPort;
  promptTools: Readonly<{
    content(
      snapshot: PromptSnapshotVersion["snapshot"],
      key: keyof PromptSnapshot,
    ): string;
  }>;
  execution: Readonly<{
    text(
      scope: Readonly<{ ownerUserId: string }>,
      resolution: Extract<DirectProviderResolution<"text">, Readonly<{ status: "resolved" }>>,
    ): Promise<Readonly<{
      execute(request: ProviderRequest): Promise<ProviderResult>;
    }>>;
  }>;
  generateCyoaWorld(command: Readonly<{
    ownerUserId: string;
    providerProfileId: string;
    input: TemplateWorldInput;
    worldId: string;
    model?: string;
    onProgress?: (phase: string, percent: number, message: string) => Promise<void> | void;
  }>): Promise<Readonly<{ title: string; content: WorldContent }>>;
  diagnoseWorldGenerationFailure(error: unknown): Readonly<{
    message: string;
    statusCode?: number;
    code?: string;
    issues?: readonly unknown[];
  }>;
}>;
