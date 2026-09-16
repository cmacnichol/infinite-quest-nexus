import type { ContextBudgetBlock } from "../../../packages/story-engine/src/context-budget.js";
import { normalizeStoryEvidenceSource, selectVerifiedNarrativeExcerpt } from "../../../packages/domain/src/story-evidence-spans.js";
import { worldFictionOverview } from "../../../packages/domain/src/world-fiction-reference.js";
import type { StoryMemoryPolicy } from "../../../packages/contracts/src/story-memory-policy.js";
import { canonicalEvidenceJson, createStoryEvidence, generationEvidenceManifestHash, isGenerationBaseIdentityV3, type GenerationContextCandidate, type GenerationEvidenceManifest, type StoryEvidence } from "../../../packages/application/src/memory/generation-context.js";
import type { MemoryGenerationAuthorityContext } from "../../../packages/application/src/index.js";
import type { StoryLengthWordRange } from "../../../packages/contracts/src/story-settings.js";
import { ContextBudgetError, buildStoryMemoryUserPrompt, buildStoryUserPrompt, containsMechanicsLanguage, estimatedInputSafetyAllowanceTokens, estimateStoryTokens, planContext, serializeProviderRequest, type TextProviderProfile } from "../../../packages/story-engine/src/index.js";
import { selectWorldFictionReferences, sha256, stableStringify } from "../../../packages/domain/src/index.js";
import type { RuntimeTextExecution as GenerationTextProvider } from "./provider-credential-transport-adapter.js";

const PRIVATE_MECHANICS_AUTHORITY_KEYS = new Set([
  "rpgStats", "eventTriggers", "pendingEventTriggers", "defaultTriggers", "mechanicsPrivate", "roll"
]);

/** Removes private mechanics/trigger state before any fiction-authority payload is rendered. */
function fictionSafeAuthority<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => fictionSafeAuthority(entry)) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !PRIVATE_MECHANICS_AUTHORITY_KEYS.has(key))
    .flatMap(([key, entry]) => {
      if (key === "trackers" && Array.isArray(entry)) {
        const fictionSafeTrackers = entry.filter((tracker) => {
          if (!tracker || typeof tracker !== "object") return false;
          const record = tracker as Record<string, unknown>;
          return typeof record.value !== "number" && !containsMechanicsLanguage(stableStringify(record));
        }).map((tracker) => fictionSafeAuthority(tracker));
        return [[key, fictionSafeTrackers]];
      }
      return [[key, fictionSafeAuthority(entry)]];
    })) as T;
}

export type PromptCandidate = Readonly<{ id: string; turnId: string | null; ordinal: number; kind: string; content: string; estimatedTokens: number; rank: number; evidenceForm?: "excerpt"; sourceHash?: string; sourceSpans?: readonly Readonly<{ start: number; end: number }>[] }>;

function completeEvidence(
  input: Omit<Parameters<typeof createStoryEvidence>[0], "form" | "spans" | "canonicalFactId"> & Readonly<{ canonicalFactId?: string | null }>,
  source: unknown,
  options?: Parameters<typeof createStoryEvidence>[2]
): StoryEvidence {
  return createStoryEvidence({ ...input, form: "complete", spans: [], canonicalFactId: input.canonicalFactId ?? null } as Parameters<typeof createStoryEvidence>[0], source, options);
}

/** Builds manifest entries from the same normalized private documents selected for the request. */
function generationSourceManifest(
  attemptId: string,
  requestBody: string,
  context: MemoryGenerationAuthorityContext,
  action: string,
  sentAuthority: Readonly<Record<string, unknown>>,
  selectedWorld: readonly ReturnType<typeof selectWorldFictionReferences>["entries"][number][]
): GenerationEvidenceManifest {
  const authority = context.authority;
  const entries: StoryEvidence[] = [];
  const worldRevision = authority.worldReferenceSource?.worldVersionId ?? "legacy-world";
  const worldSource = { kind: "world" as const, id: worldRevision, revision: worldRevision, turnNumber: null };
  entries.push(completeEvidence({ source: worldSource, semanticRole: "world_rule", rank: 0, selectionGroup: "protected", sourcePath: "/authoritativeRules", normalizationVersion: "fiction-safe-json-v1" }, sentAuthority));
  entries.push(completeEvidence({ source: worldSource, semanticRole: "world_rule", rank: 0, selectionGroup: "protected", sourcePath: "/worldCanon", normalizationVersion: "fiction-safe-json-v1" }, sentAuthority));
  if (Object.hasOwn(sentAuthority, "selectedCharacterAuthority")) {
    const characterSourceId = [authority.selectedCharacterId, authority.characterAuthority?.name]
      .find((value): value is string => typeof value === "string" && Boolean(value.trim())) ?? "selected-character";
    entries.push(completeEvidence({ source: { kind: "character", id: characterSourceId, revision: String(isGenerationBaseIdentityV3(context.baseIdentity) ? context.baseIdentity.characterProfileRevision : 0), turnNumber: null }, semanticRole: "character_authority", rank: 0, selectionGroup: "protected", sourcePath: "/selectedCharacterAuthority", normalizationVersion: "fiction-safe-json-v1" }, sentAuthority));
  }
  const stateSource = { kind: "state_edit" as const, id: context.baseIdentity.baseTurnId ?? "campaign-current-state", revision: String(context.baseIdentity.campaignStateRevision), turnNumber: context.baseIdentity.baseTurnNumber };
  entries.push(completeEvidence({ source: stateSource, semanticRole: "current_continuity", rank: 0, selectionGroup: "protected", sourcePath: "/currentContinuity", normalizationVersion: "fiction-safe-json-v1" }, sentAuthority));
  const facts = Array.isArray((sentAuthority.currentContinuity as { canonicalFacts?: unknown })?.canonicalFacts)
    ? (sentAuthority.currentContinuity as { canonicalFacts: readonly { id?: unknown }[] }).canonicalFacts : [];
  for (const [index, fact] of facts.entries()) {
    const factId = typeof fact.id === "string" ? fact.id : null;
    entries.push(completeEvidence({ source: { kind: "canonical_fact", id: factId ?? `campaign-fact-${index}`, revision: String(context.baseIdentity.campaignStateRevision), turnNumber: context.baseIdentity.baseTurnNumber }, semanticRole: "canonical_fact", rank: index, selectionGroup: "protected", sourcePath: `/currentContinuity/canonicalFacts/${index}`, normalizationVersion: "fiction-safe-json-v1", canonicalFactId: factId }, sentAuthority));
  }
  if (sentAuthority.currentScene !== null && sentAuthority.currentScene !== undefined) {
    for (const [field, role] of [["action", "player_intent"], ["narration", "accepted_narration"]] as const) {
      entries.push(completeEvidence({ source: { kind: "turn", id: context.baseIdentity.baseTurnId ?? "latest-effective-scene", revision: context.baseIdentity.narrationFingerprint ?? String(context.baseIdentity.campaignStateRevision), turnNumber: context.baseIdentity.baseTurnNumber }, semanticRole: role, rank: 0, selectionGroup: "protected", sourcePath: `/currentScene/${field}`, normalizationVersion: "fiction-safe-json-v1" }, sentAuthority));
    }
  }
  const directionDocument = { text: action };
  entries.push(completeEvidence({ source: { kind: "direction", id: attemptId, revision: String(context.baseIdentity.expectedTurnNumber), turnNumber: null }, semanticRole: "player_intent", rank: 0, selectionGroup: "direction", sourcePath: "/text", normalizationVersion: "fiction-safe-json-v1" }, directionDocument));
  const worldProjection: { entities: unknown[]; relationships: unknown[] } = { entities: [], relationships: [] };
  for (const entry of selectedWorld) {
    const match = /^\/(entities|relationships)\/(0|[1-9][0-9]*)$/u.exec(entry.sourcePath);
    if (!match) continue;
    const collection = match[1] as "entities" | "relationships";
    const index = Number(match[2]);
    while (worldProjection[collection].length <= index) worldProjection[collection].push(null);
    // This fiction-safe string is byte-for-byte the selected provider record.
    worldProjection[collection][index] = entry.content;
  }
  const originalWorldHash = authority.worldReferenceSource
    ? sha256(canonicalEvidenceJson(authority.worldReferenceSource.worldContent)) : undefined;
  const worldSourceOptions = originalWorldHash ? { contentHash: originalWorldHash } : undefined;
  for (const entry of selectedWorld) {
    entries.push(completeEvidence({ source: { ...worldSource, id: entry.sourceId }, semanticRole: "world_reference", rank: entry.rank, selectionGroup: "world", sourcePath: entry.sourcePath, normalizationVersion: "fiction-safe-json-v1" }, worldProjection, worldSourceOptions));
  }
  const recentSent = (sentAuthority.recentTurns ?? []) as readonly { sourceId: string; turnNumber: number }[];
  for (const [index, turn] of recentSent.entries()) {
    const original = context.recentTurns?.find((source) => source.turnId === turn.sourceId);
    for (const [field, role] of [["intent", "player_intent"], ["acceptedNarration", "accepted_narration"]] as const) {
      entries.push(completeEvidence({ source: { kind: "turn", id: turn.sourceId, revision: String(original?.narrationCorrectionRevision ?? 0), turnNumber: turn.turnNumber }, semanticRole: role,
        rank: index, selectionGroup: "recent", sourcePath: `/recentTurns/${index}/${field}`, normalizationVersion: "fiction-safe-json-v1" }, sentAuthority));
    }
  }
  const historical = (sentAuthority.chronicle ?? []) as readonly PromptCandidate[];
  for (const [index, candidate] of historical.entries()) {
    const original = context.candidates.find((source) => source.id === candidate.id);
    if (candidate.evidenceForm === "excerpt" && original?.narrativeSource && candidate.sourceSpans) {
      entries.push(createStoryEvidence({ source: { kind: "turn", id: candidate.turnId ?? candidate.id, revision: original.narrativeSource.sourceHash, turnNumber: candidate.ordinal },
        semanticRole: "accepted_narration", rank: candidate.rank, selectionGroup: "retrieved", form: "excerpt", spans: candidate.sourceSpans,
        sourcePath: "/text", normalizationVersion: "story-fiction-source-v1", canonicalFactId: null },
        { text: normalizeStoryEvidenceSource(original.content) }, { contentHash: original.narrativeSource.sourceHash }));
      continue;
    }
    entries.push(completeEvidence({ source: { kind: candidate.kind === "canonical_fact" ? "canonical_fact" : "turn", id: candidate.turnId ?? candidate.id, revision: sha256(candidate.content), turnNumber: candidate.ordinal },
      semanticRole: candidate.kind === "canonical_fact" ? "canonical_fact" : candidate.kind.includes("summary") ? "derived_summary" : "accepted_narration",
      rank: candidate.rank, selectionGroup: candidate.kind === "canonical_fact" ? "historical_fact" : "retrieved", sourcePath: `/chronicle/${index}/content`, normalizationVersion: "fiction-safe-json-v1",
      canonicalFactId: candidate.kind === "canonical_fact" && /^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(candidate.id) ? candidate.id : null }, sentAuthority));
  }
  const body = { version: "generation-evidence-v1" as const, attemptId, producingRequestHash: sha256(requestBody), entries, requiredReviewEvidenceIds: entries.filter((entry) => entry.selectionGroup === "protected").map((entry) => entry.id) };
  return { ...body, manifestHash: generationEvidenceManifestHash(body) };
}

function candidateRecord(candidate: GenerationContextCandidate): PromptCandidate {
  return {
    id: String(candidate.id || ""),
    turnId: typeof candidate.turnId === "string" ? candidate.turnId : null,
    ordinal: Number(candidate.ordinal || 0),
    kind: String(candidate.kind || "turn_fiction"),
    content: String(candidate.content || ""),
    estimatedTokens: Number(candidate.tokenEstimate || 0),
    rank: Number(candidate.rank || 0)
  };
}

/** Builds the one private context representation used for selection and the sent story body. */
export function planGenerationPromptContext(
  context: MemoryGenerationAuthorityContext,
  provider: GenerationTextProvider,
  systemPrompt: string,
  action: string,
  guidance: string[],
  storyLength: StoryLengthWordRange,
  inputMode: "action" | "scene",
  contextLimit: number,
  inputLimit: number,
  attemptId?: string,
  promptRoute: "legacy" | "story_memory" = "legacy",
  policy?: StoryMemoryPolicy
) {
  const authority = context.authority;
  const layered = isGenerationBaseIdentityV3(context.baseIdentity) && policy?.recentTurnTarget === 3;
  const recentRecords = layered ? (context.recentTurns ?? []).map((turn) => ({
    sourceId: turn.turnId, turnNumber: turn.turnNumber, inputMode: turn.inputMode,
    intent: turn.action, acceptedNarration: turn.narration
  })) : [];
  const recentDiagnostics: { target: number; included: number; firstGapReason: "recent_gap" | "context_limit" | "request_limit" | null } = {
    target: policy?.recentTurnTarget ?? 1, included: authority.latestTurn ? 1 : 0, firstGapReason: null
  };
  // The reader supplies this source only for an enrolled v3 authority capture;
  // legacy captures omit it and retain their exact serialized context.
  const worldSelection = authority.worldReferenceSource
    ? selectWorldFictionReferences({
      worldVersionId: authority.worldReferenceSource.worldVersionId,
      worldContent: authority.worldReferenceSource.worldContent,
      direction: action,
      currentScene: authority.latestTurn?.narration ?? "",
      openThreads: authority.openThreads,
      selectedCharacterAliases: [
        authority.characterAuthority?.name ?? "",
        ...((authority.characterAuthority?.profile?.identity?.aliases ?? []).filter((alias): alias is string => typeof alias === "string"))
      ].filter(Boolean)
    })
    : null;
  const worldReferences = worldSelection?.entries ?? [];
  const authorityContext = {
    authoritativeRules: Array.isArray(authority.rules) ? authority.rules : [],
    worldCanon: isGenerationBaseIdentityV3(context.baseIdentity) ? worldFictionOverview(authority.worldCanon) : fictionSafeAuthority(authority.worldCanon ?? {}),
    selectedCharacterId: authority.selectedCharacterId ?? null,
    // This complete classified projection is distinct from world lore and
    // current continuity. The protected planner either sends it whole or
    // fails before provider I/O; it is never a bounded public preview.
    ...(isGenerationBaseIdentityV3(context.baseIdentity) && authority.characterAuthority
      ? { selectedCharacterAuthority: fictionSafeAuthority(authority.characterAuthority) }
      : {}),
    currentContinuity: fictionSafeAuthority(authority.currentContinuity ?? {}),
    currentScene: fictionSafeAuthority(authority.latestTurn ?? null),
    ...(isGenerationBaseIdentityV3(context.baseIdentity) ? { worldReferences: [] as readonly Readonly<{ sourceId: string; sourcePath: string; content: string }>[] } : {}),
    ...(layered ? { recentTurns: [] as typeof recentRecords } : {}),
    chronicle: [] as readonly PromptCandidate[]
  };
  const duplicateIds: string[] = [];
  const protectedFactIds = new Set((authority.currentContinuity?.canonicalFacts ?? []).map((fact) => fact.id).filter(Boolean));
  const seen = new Set<string>();
  let sourceValidationFailures = 0;
  const excerptAlternatives = new Map<string, PromptCandidate>();
  const candidates = context.candidates.map((source) => {
    const candidate = candidateRecord(source);
    if (source.sourceValidationFailed) sourceValidationFailures++;
    if (!isGenerationBaseIdentityV3(context.baseIdentity) || policy?.excerptPolicy !== "verified_spans_v1" || source.kind !== "turn_fiction" || !source.narrativeSource) return candidate;
    const normalized = normalizeStoryEvidenceSource(source.content);
    const excerpt = selectVerifiedNarrativeExcerpt(normalized, source.narrativeSource.spans.map((span) => ({ ...span, normalizationVersion: source.narrativeSource!.normalizationVersion, sourceHash: source.narrativeSource!.sourceHash })));
    if (!excerpt) { sourceValidationFailures++; return candidate; }
    // Economical complete records remain whole. Large parents can use exact
    // certified spans with adjacent sentences; the final wire budget still decides.
    if (excerpt.content.length >= normalized.length) return candidate;
    const alternative: PromptCandidate = { ...candidate, content: excerpt.content, evidenceForm: "excerpt", sourceHash: excerpt.sourceHash, sourceSpans: excerpt.spans };
    excerptAlternatives.set(candidate.id, alternative);
    if (excerpt.content.length * 4 >= normalized.length || estimateStoryTokens(normalized) <= Math.min(contextLimit, inputLimit) * 0.15) return candidate;
    return alternative;
  }).filter((candidate) => {
    if (!candidate.id || !candidate.content) return false;
    if (!layered) return true;
    const identity = candidate.kind === "canonical_fact" ? `fact:${candidate.id}` : candidate.turnId ? `turn:${candidate.turnId}` : `source:${candidate.id}`;
    if ((candidate.turnId && candidate.turnId === context.baseIdentity.baseTurnId)
      || (candidate.kind === "canonical_fact" && protectedFactIds.has(candidate.id)) || seen.has(identity)) {
      duplicateIds.push(candidate.id); return false;
    }
    seen.add(identity); return true;
  });
  const serializationProfile: TextProviderProfile = {
    ...provider,
    // Serialization needs the provider wire shape only; the live execution
    // binding retains its credential and destination outside this planner.
    baseUrl: ""
  };
  const authorityRevision = sha256(stableStringify({ baseIdentity: context.baseIdentity, authority }));
  const blocks = [
    { id: "authority", revision: authorityRevision, content: stableStringify(authorityContext), protected: true, priority: 0, ordinal: 0, scope: "authority" },
    ...recentRecords.map((turn) => ({ id: `recent:${turn.sourceId}`, revision: context.recentTurns!.find((source) => source.turnId === turn.sourceId)!.sourceHash,
      content: stableStringify(turn), protected: false, priority: -turn.turnNumber, ordinal: turn.turnNumber, scope: "recent" })),
    ...worldReferences.map((reference, ordinal) => ({
      id: reference.sourceId, revision: sha256(reference.content), content: reference.content,
      protected: false, priority: reference.rank, ordinal, scope: "world"
    })),
    ...candidates.map((candidate) => ({
      id: candidate.id,
      revision: sha256(stableStringify(candidate)),
      content: candidate.content,
      protected: false,
      priority: Number.isFinite(Number(candidate.rank)) ? Number(candidate.rank) : Number.MAX_SAFE_INTEGER,
      ordinal: Number(candidate.ordinal || 0),
      scope: "chronicle"
    }))
  ];
  const promptContext = (selected: readonly Readonly<{ id: string }>[]) => ({
    ...authorityContext,
    ...(isGenerationBaseIdentityV3(context.baseIdentity) ? { worldReferences: selected.filter((block: { id: string; scope?: string }) => block.scope === "world")
      .map((block) => worldReferences.find((reference) => reference.sourceId === block.id))
      .filter((reference): reference is typeof worldReferences[number] => Boolean(reference))
      .map(({ sourceId, sourcePath, content }) => ({ sourceId, sourcePath, content })) } : {}),
    ...(layered ? { recentTurns: recentRecords.filter((turn) => selected.some((block) => block.id === `recent:${turn.sourceId}`)).sort((a, b) => a.turnNumber - b.turnNumber) } : {}),
    chronicle: selected.filter((block: { id: string; scope?: string }) => block.scope === "chronicle")
      .map((block) => candidates.find((candidate) => candidate.id === block.id))
      .filter((candidate): candidate is PromptCandidate => Boolean(candidate))
  });
  const planOptions = (planBlocks: readonly ContextBudgetBlock[]) => ({
    blocks: planBlocks,
    contextLimit,
    inputLimit,
    count: estimateStoryTokens,
    safetyAllowanceTokens: estimatedInputSafetyAllowanceTokens,
    contextSafetyAllowanceTokens: 0,
    serializeContext: (selected: readonly Readonly<{ id: string }>[]) => stableStringify(promptContext(selected)),
    contextValue: promptContext,
    serializeRequest: (selected: ReturnType<typeof promptContext>) => serializeProviderRequest(serializationProfile, {
      systemPrompt,
      input: promptRoute === "story_memory"
        ? buildStoryMemoryUserPrompt(selected, action, false, guidance, storyLength, inputMode)
        : buildStoryUserPrompt(selected, action, false, guidance, storyLength, inputMode)
    }).body,
    protectedScope: "campaign_context" as const
  });
  const protectedComponents = {
    rules: estimateStoryTokens(stableStringify(authorityContext.authoritativeRules)),
    world_canon: estimateStoryTokens(stableStringify(authorityContext.worldCanon)),
    character_profile: estimateStoryTokens(stableStringify(authorityContext.selectedCharacterAuthority ?? null)),
    current_state: estimateStoryTokens(stableStringify(authorityContext.currentContinuity)),
    current_scene: estimateStoryTokens(stableStringify(authorityContext.currentScene)),
    direction: estimateStoryTokens(action)
  };
  const measure = (selected: readonly ContextBudgetBlock[]) => {
    try { return planContext(planOptions(selected)); }
    catch (error) {
      if (error instanceof ContextBudgetError && isGenerationBaseIdentityV3(context.baseIdentity)) Object.assign(error, { protectedComponents });
      throw error;
    }
  };
  const useWorldQuota = isGenerationBaseIdentityV3(context.baseIdentity) && Boolean(authority.worldReferenceSource);
  let plan;
  if (useWorldQuota || layered) {
    const authorityBlock = blocks[0]!;
    const protectedPlan = measure([authorityBlock]);
    const residual = Math.max(0, Math.min(
      contextLimit - protectedPlan.contextTokens,
      inputLimit - protectedPlan.requestTokens - protectedPlan.safetyAllowanceTokens
    ));
    const worldCeiling = Math.floor(residual * (policy?.worldResidualShare ?? 0.15));
    const recentCeiling = Math.floor(residual * (policy?.recentResidualShare ?? 0));
    const selectedRecentBlocks: typeof blocks = [];
    if (layered) {
      for (let ordinal = context.baseIdentity.baseTurnNumber - 1; ordinal >= Math.max(1, context.baseIdentity.baseTurnNumber - 2); ordinal--) {
        const block = blocks.find((candidate) => candidate.scope === "recent" && candidate.ordinal === ordinal);
        if (!block) { recentDiagnostics.firstGapReason = "recent_gap"; break; }
        const trial = measure([authorityBlock, ...selectedRecentBlocks, block]);
        if (!trial.selected.some((candidate) => candidate.id === block.id)) {
          recentDiagnostics.firstGapReason = trial.omitted[0]?.reason ?? "context_limit"; break;
        }
        const added = Math.max(trial.contextTokens - protectedPlan.contextTokens,
          trial.requestTokens + trial.safetyAllowanceTokens - protectedPlan.requestTokens - protectedPlan.safetyAllowanceTokens);
        if (added > recentCeiling) { recentDiagnostics.firstGapReason = "context_limit"; break; }
        selectedRecentBlocks.push({ ...block, protected: true });
        recentDiagnostics.included++;
      }
    }
    const selectedWorldBlocks: typeof blocks = [];
    for (const worldBlock of blocks.filter((block) => block.scope === "world").sort((left, right) => left.priority - right.priority || left.ordinal - right.ordinal || left.id.localeCompare(right.id))) {
      const trial = measure([authorityBlock, ...selectedWorldBlocks, worldBlock]);
      if (!trial.selected.some((block) => block.id === worldBlock.id)) continue;
      const added = Math.max(
        trial.contextTokens - protectedPlan.contextTokens,
        trial.requestTokens + trial.safetyAllowanceTokens - protectedPlan.requestTokens - protectedPlan.safetyAllowanceTokens
      );
      if (added <= worldCeiling) selectedWorldBlocks.push({ ...worldBlock, protected: true });
    }
    // Selected world records are pre-measured whole optional records. Remaining optional
    // capacity stays available to history; their reservation is not held back.
    const recentIds = new Set(selectedRecentBlocks.map((block) => block.id.slice("recent:".length)));
    const historicalBlocks = blocks.filter((block) => {
      if (block.scope !== "chronicle") return false;
      const candidate = candidates.find((candidate) => candidate.id === block.id)!;
      if (layered && candidate.turnId && recentIds.has(candidate.turnId)) { duplicateIds.push(candidate.id); return false; }
      return true;
    });
    plan = measure([authorityBlock, ...selectedRecentBlocks, ...selectedWorldBlocks, ...historicalBlocks]);
  } else {
    plan = measure(blocks);
  }
  let retryExcerpts = false;
  for (const omitted of plan.omitted) {
    const alternative = excerptAlternatives.get(omitted.id);
    const index = candidates.findIndex((candidate) => candidate.id === omitted.id);
    if (!alternative || index < 0 || candidates[index]!.evidenceForm === "excerpt") continue;
    candidates[index] = alternative;
    const blockIndex = blocks.findIndex((block) => block.scope === "chronicle" && block.id === omitted.id);
    blocks[blockIndex] = { ...blocks[blockIndex]!, content: alternative.content, revision: sha256(stableStringify(alternative)) };
    retryExcerpts = true;
  }
  if (retryExcerpts) {
    const reserved = plan.selected.filter((block) => block.scope !== "chronicle");
    plan = measure([...reserved, ...blocks.filter((block) => block.scope === "chronicle" && !duplicateIds.includes(block.id))]);
  }
  const selectedContext = promptContext(plan.selected);
  const storyInput = promptRoute === "story_memory"
    ? buildStoryMemoryUserPrompt(selectedContext, action, false, guidance, storyLength, inputMode)
    : buildStoryUserPrompt(selectedContext, action, false, guidance, storyLength, inputMode);
  const requestBody = serializeProviderRequest(serializationProfile, { systemPrompt, input: storyInput }).body;
  return {
    layerDiagnostics: {
      recent: recentDiagnostics,
      duplicateSourceCount: duplicateIds.length,
      excerptsComplete: selectedContext.chronicle.filter((candidate) => !candidate.evidenceForm).length,
      excerptsPartial: selectedContext.chronicle.filter((candidate) => candidate.evidenceForm === "excerpt").length,
      sourceValidationFailures,
      components: Object.fromEntries(Object.entries(selectedContext).map(([key, value]) => [key, estimateStoryTokens(stableStringify(value))])),
      omitted: [
        ...duplicateIds.map((id) => ({ id, reason: "duplicate_source" as const })),
        ...blocks.filter((block) => !block.protected && !plan.selected.some((selected) => selected.id === block.id) && !duplicateIds.includes(block.id))
          .map((block) => ({ id: block.id, reason: plan.omitted.find((item) => item.id === block.id)?.reason ?? (block.scope === "recent" ? recentDiagnostics.firstGapReason ?? "context_limit" : "context_limit") }))
      ]
    },
    promptContext: selectedContext,
    storyInput,
    contextPlan: plan,
    worldReferenceOmissions: isGenerationBaseIdentityV3(context.baseIdentity) ? worldSelection?.omissions ?? { unrecognizedRecordCount: 0, missingEndpointCount: 0, ambiguousAliasCount: 0, oversizedRecordCount: 0, entityCapCount: 0, relationshipCapCount: 0 } : null,
    ...(attemptId ? { sourceManifest: generationSourceManifest(attemptId, requestBody, context, action, selectedContext, worldReferences.filter((reference) => (selectedContext.worldReferences ?? []).some((selected) => selected.sourceId === reference.sourceId))) } : {})
  };
}
