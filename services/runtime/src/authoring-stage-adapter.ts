import type { AuthoringClaim, AuthoringExecutionRepository } from "../../../packages/application/src/authoring/ports.js";
import { authoringStageOutputSchema, type AuthoringExecutionSnapshot, type AuthoringStageOutput } from "../../../packages/application/src/authoring/types.js";
import type { RuntimeProviderExecutionPort, RuntimeTextExecution } from "./provider-credential-transport-adapter.js";
import { AuthoringResponseError } from "./authoring-response-adapter.js";
import {
  allocateOutlineCharacterIds,
  assembleExpandedWorldCharacter,
  expandWorldCharacterSeed,
  generateStandalonePlayableCharacter,
  generateWorldOutline
} from "./provider-world-generation-adapter.js";
import { buildTemplateWorldPrompt } from "../../../packages/domain/src/world-template.js";
import { CHARACTER_AUTHORING_PROMPT_PROTOCOL_VERSION, WORLD_AUTHORING_PROMPT_PROTOCOL_VERSION } from "../../../packages/domain/src/authoring-prompts.js";
import { SOURCE_EXTRACTION_PROMPT_PROTOCOL_VERSION } from "../../../packages/domain/src/authoring-prompts.js";
import { sourceDocumentFromNormalizedText } from "../../../packages/domain/src/source-authoring.js";
import { planSourceChunks } from "../../../packages/domain/src/source-authoring-budget.js";
import { createRuntimeSourceAuthoringRequestBudget } from "./source-authoring-budget.js";
import { createSourceAuthoringAdapter, renderSourceExtractionProviderRequest } from "./source-authoring-adapter.js";

export const AUTHORING_EXECUTION_PROTOCOLS = Object.freeze({
  world: WORLD_AUTHORING_PROMPT_PROTOCOL_VERSION,
  character: CHARACTER_AUTHORING_PROMPT_PROTOCOL_VERSION
});

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

/** Persistable provider identity: never credentials, endpoint URLs, or arbitrary configuration. */
export function createAuthoringExecutionSnapshot(
  execution: Readonly<{
    id: string;
    model: string;
    contextWindowTokens: number;
    maxOutputTokens: number;
    requestTimeoutMs: number;
    temperature: number;
    endpointIdentity?: string;
    configuration: Readonly<Record<string, unknown>>;
  }>,
  prompts: Record<string, string>,
  protocols: Record<string, string>,
  sha256: (value: string) => string,
): AuthoringExecutionSnapshot {
  const textConfiguration = typeof execution.configuration.httpReferer === "string"
    ? { httpReferer: execution.configuration.httpReferer }
    : {};
  return {
    providerProfileId: execution.id,
    model: execution.model,
    configurationHash: sha256(stableJson({
      endpointIdentity: execution.endpointIdentity ?? null,
      model: execution.model,
      contextWindowTokens: execution.contextWindowTokens,
      maxOutputTokens: execution.maxOutputTokens,
      requestTimeoutMs: execution.requestTimeoutMs,
      temperature: execution.temperature,
      configuration: textConfiguration
    })),
    contextWindowTokens: execution.contextWindowTokens,
    maxOutputTokens: execution.maxOutputTokens,
    requestTimeoutMs: execution.requestTimeoutMs,
    prompts: { ...prompts },
    protocols: { ...protocols }
  };
}

export type LoadedAuthoringStage = Readonly<{
  jobId: string;
  input: Awaited<ReturnType<AuthoringExecutionRepository["loadClaim"]>> extends infer Claim
    ? Claim extends { input: infer Input } ? Input : never
    : never;
  snapshot: Awaited<ReturnType<AuthoringExecutionRepository["loadClaim"]>> extends infer Claim
    ? Claim extends { snapshot: infer Snapshot } ? Snapshot : never
    : never;
  stageKey: string;
  parentOutputs: AuthoringStageOutput[];
  sourcePlan?: unknown;
  ownerUserId: string;
  currentClaim?(): Promise<boolean>;
}>;

/**
 * Execute one already-claimed durable authoring stage.  The repository is the
 * authority for the claim fence and pinned snapshot; callers provide the
 * runtime-specific provider dispatcher so this boundary stays application-free.
 */
export async function executeAuthoringStage(options: Readonly<{
  claim: AuthoringClaim;
  repository: Pick<AuthoringExecutionRepository, "loadClaim"> & Partial<Pick<AuthoringExecutionRepository, "readClaimInput" | "initializeExecutionSnapshot">>;
  /** Called only for an uninitialized live claim; retries always reload the stored snapshot. */
  resolveSnapshot?(input: LoadedAuthoringStage["input"]): Promise<AuthoringExecutionSnapshot>;
  /** Runtime lease heartbeats may stop paid calls before database expiry. */
  currentClaim?(): Promise<boolean>;
  dispatch(stage: LoadedAuthoringStage): Promise<AuthoringStageOutput>;
}>): Promise<AuthoringStageOutput | null> {
  let loaded = await options.repository.loadClaim(options.claim);
  if (!loaded && options.resolveSnapshot && options.repository.readClaimInput && options.repository.initializeExecutionSnapshot) {
    const input = await options.repository.readClaimInput(options.claim);
    if (!input) return null;
    const snapshot = await options.resolveSnapshot(input);
    if (!await options.repository.initializeExecutionSnapshot(options.claim, snapshot)) return null;
    loaded = await options.repository.loadClaim(options.claim);
  }
  if (!loaded) return null;
  return options.dispatch({ ...loaded, jobId: options.claim.jobId, ownerUserId: options.claim.ownerUserId, currentClaim: async () => {
    if (options.currentClaim && !await options.currentClaim()) return false;
    if (!await options.repository.loadClaim(options.claim)) return false;
    // Local shutdown/heartbeat loss can happen while the database read waits.
    return options.currentClaim ? options.currentClaim() : true;
  }});
}

function compatibleSnapshot(snapshot: AuthoringExecutionSnapshot, execution: RuntimeTextExecution, sha256: (value: string) => string): boolean {
  const current = createAuthoringExecutionSnapshot(execution, snapshot.prompts, snapshot.protocols, sha256);
  return current.configurationHash === snapshot.configurationHash
    && Object.entries(AUTHORING_EXECUTION_PROTOCOLS).every(([key, version]) => snapshot.protocols[key] === version)
    && current.model === snapshot.model
    && current.contextWindowTokens === snapshot.contextWindowTokens
    && current.maxOutputTokens === snapshot.maxOutputTokens
    && current.requestTimeoutMs === snapshot.requestTimeoutMs;
}

function providerFailureStage(stage: LoadedAuthoringStage): "world" | "character" | "source" {
  if (stage.input.kind === "story_source") return "source";
  return stage.stageKey === "world" ? "world" : "character";
}

/**
 * Provider-bound half of the durable adapter. It reloads credentials by exact
 * pinned profile/model and rejects drift instead of resolving a newer default.
 */
export function createRuntimeAuthoringStageDispatcher(options: Readonly<{
  execution: RuntimeProviderExecutionPort;
  sha256: (value: string) => string;
}>): (stage: LoadedAuthoringStage) => Promise<AuthoringStageOutput> {
  return async (stage) => {
    let provider: RuntimeTextExecution;
    try {
      provider = await options.execution.text(
        { ownerUserId: stage.ownerUserId }, stage.snapshot.providerProfileId, "text", stage.snapshot.model,
        stage.snapshot.contextWindowTokens
      );
    } catch {
      throw new AuthoringResponseError({ code: "authoring_provider_unavailable", stage: providerFailureStage(stage), retryable: true, issues: [] });
    }
    if (!compatibleSnapshot(stage.snapshot, provider, options.sha256)) {
      throw new AuthoringResponseError({ code: "authoring_provider_unavailable", stage: providerFailureStage(stage), retryable: true, issues: [] });
    }
    if (stage.input.kind === "story_source") {
      if (stage.snapshot.protocols.source !== SOURCE_EXTRACTION_PROMPT_PROTOCOL_VERSION) {
        throw new AuthoringResponseError({ code: "source_evidence_invalid", stage: "source", retryable: false, issues: [] });
      }
      const sourceInput = stage.input;
      const source = sourceDocumentFromNormalizedText(sourceInput.name, sourceInput.text, stage.jobId);
      const requestBudget = createRuntimeSourceAuthoringRequestBudget(provider);
      if (stage.stageKey === "source:plan") {
        const chunks = planSourceChunks({
          source,
          boundaryParagraphId: sourceInput.boundaryParagraphId,
          systemPrompt: "",
          instructions: sourceInput.instructions,
          budget: requestBudget.budget,
          includeChunkCoordinates: true,
          mode: sourceInput.mode,
          renderRequest: (frame) => requestBudget.render(renderSourceExtractionProviderRequest({
            instructions: frame.instructions,
            sourceText: frame.sourceText,
            sourceRange: frame.sourceRange ?? { start: 0, end: 0 },
            paragraphSpans: frame.paragraphSpans ?? [],
            mode: frame.mode ?? sourceInput.mode,
            repair: frame.repair,
            issues: []
          }))
        });
        return { kind: "source_plan", chunks: chunks.map((chunk) => ({
          ...chunk,
          sourceRange: { ...chunk.sourceRange },
          spans: chunk.spans.map((span) => ({ ...span }))
        })) };
      }
      if (stage.stageKey.startsWith("source:chunk:")) {
        const parentPlan = stage.parentOutputs.find((output) => output.kind === "source_plan");
        const persistedPlan = typeof stage.sourcePlan === "object" && stage.sourcePlan !== null && !Array.isArray(stage.sourcePlan)
          ? (stage.sourcePlan as { chunks?: unknown }).chunks
          : undefined;
        const plan = Array.isArray(persistedPlan)
          ? authoringStageOutputSchema.parse({ kind: "source_plan", chunks: persistedPlan })
          : parentPlan;
        const chunk = plan?.kind === "source_plan"
          ? plan.chunks.find((candidate) => stage.stageKey === `source:chunk:${candidate.id}`)
          : undefined;
        if (!chunk) throw new Error("Source extraction stage is missing its durable chunk plan.");
        const adapter = createSourceAuthoringAdapter({
          requestBudget,
          delay: async () => undefined
        });
        return { kind: "source_extraction", facts: await adapter.extractSourceChunk({
          source, chunk, boundaryParagraphId: sourceInput.boundaryParagraphId,
          mode: sourceInput.mode, instructions: sourceInput.instructions
        }) };
      }
      throw new AuthoringResponseError({ code: "source_evidence_invalid", stage: "source", retryable: false, issues: [] });
    }
    if (stage.stageKey === "world") {
      if (stage.input.kind !== "world_concept") throw new Error("World stage input is invalid.");
      const input = {
        sourceName: "durable-authoring", sourceKind: "prompt" as const, title: "Untitled World",
        summary: stage.input.prompt, keywords: [], excerpts: [], prompt: stage.input.prompt
      };
      const outline = await generateWorldOutline({
        input,
        provider,
        worldPrompt: buildTemplateWorldPrompt(input, stage.snapshot.prompts.world_generation ?? ""),
        prompt: stage.snapshot.prompts.world_generation ?? "",
        repairPrompt: stage.snapshot.prompts.world_generation_recovery ?? "",
        ...(stage.currentClaim === undefined ? {} : { currentClaim: stage.currentClaim })
      });
      return { kind: "outline", outline: allocateOutlineCharacterIds(outline) };
    }
    if (!stage.stageKey.startsWith("character:")) throw new Error("Unknown durable authoring stage.");
    const characterId = stage.stageKey.slice("character:".length);
    const outline = stage.parentOutputs.find((output) => output.kind === "outline");
    const seed = outline?.kind === "outline" ? outline.outline.seeds.find((candidate) => candidate.id === characterId) : undefined;
    if (seed && outline?.kind === "outline") {
      const expanded = await expandWorldCharacterSeed({
        provider,
        outline: outline.outline,
        seed,
        characterIndex: outline.outline.seeds.findIndex((candidate) => candidate.id === characterId),
        acceptedCharacterNames: [],
        prompt: stage.snapshot.prompts.world_character_generation ?? "",
        repairPrompt: stage.snapshot.prompts.world_character_generation_recovery ?? "",
        ...(stage.currentClaim === undefined ? {} : { currentClaim: stage.currentClaim })
      });
      return { kind: "character", character: assembleExpandedWorldCharacter(expanded, characterId, outline.outline.seeds.findIndex((candidate) => candidate.id === characterId)) };
    }
    if (stage.input.kind !== "character") throw new Error("Character stage is missing its validated outline seed.");
    const requestedCharacterId = stage.input.target.kind === "world_draft"
      ? stage.input.target.characterId
      : stage.input.characterId;
    const currentCharacter = requestedCharacterId === undefined
      ? undefined
      : stage.input.content.playableCharacters.find((candidate) => candidate.id === requestedCharacterId);
    if (requestedCharacterId !== undefined && !currentCharacter) {
      throw new AuthoringResponseError({ code: "invalid_authoring_output", stage: "character", retryable: false, issues: [] });
    }
    const generated = await generateStandalonePlayableCharacter({
      provider,
      content: stage.input.content,
      promptText: stage.input.prompt,
      currentCharacter,
      characterId,
      promptTemplate: stage.snapshot.prompts.character_generation ?? "",
      ...(stage.currentClaim === undefined ? {} : { currentClaim: stage.currentClaim })
    });
    return { kind: "character", character: generated.character };
  };
}
