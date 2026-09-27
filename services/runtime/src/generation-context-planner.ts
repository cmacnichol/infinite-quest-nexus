import type { ContextBudgetBlock } from "../../../packages/story-engine/src/context-budget.js";
import { normalizeStoryEvidenceSource, selectVerifiedNarrativeExcerpt } from "../../../packages/domain/src/story-evidence-spans.js";
import { worldFictionOverview } from "../../../packages/domain/src/world-fiction-reference.js";
import type { StoryMemoryPolicy } from "../../../packages/contracts/src/story-memory-policy.js";
import { HISTORY_COVERAGE_POLICY, isHistoryCoverageContextProtocol } from "../../../packages/contracts/src/story-memory-policy.js";
import { canonicalEvidenceJson, createStoryEvidence, generationEvidenceManifestHash, hasGenerationCharacterAuthority, historyCoverageDiagnosticsSchema, type GenerationContextCandidate, type GenerationEvidenceManifest, type StoryEvidence } from "../../../packages/application/src/memory/generation-context.js";
import type { MemoryGenerationAuthorityContext } from "../../../packages/application/src/index.js";
import type { StoryLengthWordRange } from "../../../packages/contracts/src/story-settings.js";
import { ContextBudgetError, buildStoryMemoryUserPrompt, buildStoryUserPrompt, containsMechanicsLanguage, estimatedInputSafetyAllowanceTokens, estimateStoryTokens, planContext, projectHistoryCoverageContext, serializeProviderRequest, type TextProviderProfile } from "../../../packages/story-engine/src/index.js";
import { selectWorldFictionReferences, sha256, stableStringify } from "../../../packages/domain/src/index.js";
import type { RuntimeTextExecution as GenerationTextProvider } from "./provider-credential-transport-adapter.js";
import { isGenerationBaseIdentityV4 } from "../../../packages/application/src/memory/generation-context.js";
import { selectCastContext, type CastContextSelection } from "../../../packages/domain/src/campaign-cast-context.js";
import { reserveNewestWholeSuffix } from "../../../packages/application/src/memory/story-history-reservation.js";
import type { ProtectedFact } from "../../../packages/application/src/memory/story-history-facts.js";

type SentCast = { coverage: CastContextSelection["coverage"]; notice: string; characters: {
  characterId: string; revision: number; fields: { authority: "user" | "observation"; evidenceId: string;
    source: { kind: string; effectiveTurnNumber?: number; turnNumber?: number } }[]
}[] };

const PRIVATE_MECHANICS_AUTHORITY_KEYS = new Set([
  "rpgStats", "eventTriggers", "pendingEventTriggers", "defaultTriggers", "mechanicsPrivate", "roll"
]);

/** Fixed v5 guard: exact fact measurement must not starve a short worker lease. */
export const MAX_PROTECTED_FACT_MEASUREMENTS = 64;

/** Bounds the exact partial-fit probe after the full-set fit proof. */
export const MAX_HISTORY_COVERAGE_PARTIAL_CANDIDATE_PROBES = 8;

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
  const sourceCandidateById = new Map(context.candidates.map((candidate) => [candidate.id, candidate]));
  const recentSourceById = new Map((context.recentTurns ?? []).map((turn) => [turn.turnId, turn]));
  const entries: StoryEvidence[] = [];
  // `createStoryEvidence` hashes its source document by default.  The fact
  // entries all point at this immutable, serialized authority, so retain the
  // identical hash once instead of serializing a large fact set per entry.
  const sentAuthorityEvidenceOptions = { contentHash: sha256(canonicalEvidenceJson(sentAuthority)) };
  const worldRevision = authority.worldReferenceSource?.worldVersionId ?? "legacy-world";
  const worldSource = { kind: "world" as const, id: worldRevision, revision: worldRevision, turnNumber: null };
  entries.push(completeEvidence({ source: worldSource, semanticRole: "world_rule", rank: 0, selectionGroup: "protected", sourcePath: "/authoritativeRules", normalizationVersion: "fiction-safe-json-v1" }, sentAuthority, sentAuthorityEvidenceOptions));
  entries.push(completeEvidence({ source: worldSource, semanticRole: "world_rule", rank: 0, selectionGroup: "protected", sourcePath: "/worldCanon", normalizationVersion: "fiction-safe-json-v1" }, sentAuthority, sentAuthorityEvidenceOptions));
  if (Object.hasOwn(sentAuthority, "selectedCharacterAuthority")) {
    const characterSourceId = [authority.selectedCharacterId, authority.characterAuthority?.name]
      .find((value): value is string => typeof value === "string" && Boolean(value.trim())) ?? "selected-character";
    entries.push(completeEvidence({ source: { kind: "character", id: characterSourceId, revision: String(hasGenerationCharacterAuthority(context.baseIdentity) ? context.baseIdentity.characterProfileRevision : 0), turnNumber: null }, semanticRole: "character_authority", rank: 0, selectionGroup: "protected", sourcePath: "/selectedCharacterAuthority", normalizationVersion: "fiction-safe-json-v1" }, sentAuthority, sentAuthorityEvidenceOptions));
  }
  const stateSource = { kind: "state_edit" as const, id: context.baseIdentity.baseTurnId ?? "campaign-current-state", revision: String(context.baseIdentity.campaignStateRevision), turnNumber: context.baseIdentity.baseTurnNumber };
  entries.push(completeEvidence({ source: stateSource, semanticRole: "current_continuity", rank: 0, selectionGroup: "protected", sourcePath: "/currentContinuity", normalizationVersion: "fiction-safe-json-v1" }, sentAuthority, sentAuthorityEvidenceOptions));
  const facts = Array.isArray((sentAuthority.currentContinuity as { canonicalFacts?: unknown })?.canonicalFacts)
    ? (sentAuthority.currentContinuity as { canonicalFacts: readonly { id?: unknown }[] }).canonicalFacts : [];
  for (const [index, fact] of facts.entries()) {
    const factId = typeof fact.id === "string" ? fact.id : null;
    entries.push(completeEvidence({ source: { kind: "canonical_fact", id: factId ?? `campaign-fact-${index}`, revision: String(context.baseIdentity.campaignStateRevision), turnNumber: context.baseIdentity.baseTurnNumber }, semanticRole: "canonical_fact", rank: index, selectionGroup: "protected", sourcePath: `/currentContinuity/canonicalFacts/${index}`, normalizationVersion: "fiction-safe-json-v1", canonicalFactId: factId }, sentAuthority, sentAuthorityEvidenceOptions));
  }
  if (sentAuthority.currentScene !== null && sentAuthority.currentScene !== undefined) {
    for (const [field, role] of [["action", "player_intent"], ["narration", "accepted_narration"]] as const) {
      entries.push(completeEvidence({ source: { kind: "turn", id: context.baseIdentity.baseTurnId ?? "latest-effective-scene", revision: context.baseIdentity.narrationFingerprint ?? String(context.baseIdentity.campaignStateRevision), turnNumber: context.baseIdentity.baseTurnNumber }, semanticRole: role, rank: 0, selectionGroup: "protected", sourcePath: `/currentScene/${field}`, normalizationVersion: "fiction-safe-json-v1" }, sentAuthority, sentAuthorityEvidenceOptions));
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
    const original = recentSourceById.get(turn.sourceId);
    for (const [field, role] of [["intent", "player_intent"], ["acceptedNarration", "accepted_narration"]] as const) {
      entries.push(completeEvidence({ source: { kind: "turn", id: turn.sourceId, revision: String(original?.narrationCorrectionRevision ?? 0), turnNumber: turn.turnNumber }, semanticRole: role,
        rank: index, selectionGroup: "recent", sourcePath: `/recentTurns/${index}/${field}`, normalizationVersion: "fiction-safe-json-v1" }, sentAuthority, sentAuthorityEvidenceOptions));
    }
  }
  const ledger = (sentAuthority.storyLedger as { entries?: readonly { turnId: string; turnNumber: number; inputMode: "action" | "scene"; direction: string }[] } | undefined)?.entries ?? [];
  for (const [index, entry] of ledger.entries()) {
    entries.push(completeEvidence({ source: { kind: "turn", id: entry.turnId, revision: sha256(stableStringify(entry)), turnNumber: entry.turnNumber },
      semanticRole: "player_intent", rank: index, selectionGroup: "ledger", sourcePath: `/storyLedger/entries/${index}/direction`, normalizationVersion: "fiction-safe-json-v1" }, sentAuthority, sentAuthorityEvidenceOptions));
  }
  const protectedFacts = (sentAuthority.protectedFacts as readonly ProtectedFact[] | undefined) ?? [];
  for (const [index, fact] of protectedFacts.entries()) {
    entries.push(completeEvidence({ source: { kind: "canonical_fact", id: fact.id, revision: sha256(fact.content), turnNumber: fact.turnNumber },
      // A selected historical fact must remain in the review/repair evidence
      // set, so it is protected once it has been sent.
      semanticRole: "canonical_fact", rank: index, selectionGroup: "protected", sourcePath: `/protectedFacts/${index}/content`,
      normalizationVersion: "fiction-safe-json-v1", canonicalFactId: fact.id }, sentAuthority, sentAuthorityEvidenceOptions));
  }
  const historical = (sentAuthority.chronicle ?? []) as readonly PromptCandidate[];
  const sentCast = sentAuthority.cast as SentCast | undefined;
  if (sentCast) for (const field of ["coverage", "notice"] as const) {
    entries.push(completeEvidence({ source: { kind: "cast", id: `cast-${field}`,
      revision: isGenerationBaseIdentityV4(context.baseIdentity) ? context.baseIdentity.castFingerprint : "unavailable", turnNumber: context.baseIdentity.baseTurnNumber },
    semanticRole: "current_continuity", rank: 0, selectionGroup: "cast", sourcePath: `/cast/${field}`, normalizationVersion: "fiction-safe-json-v1" }, sentAuthority, sentAuthorityEvidenceOptions));
  }
  for (const [index, character] of (sentCast?.characters ?? []).entries()) {
    const source = { kind: "cast" as const, id: character.characterId, revision: String(character.revision), turnNumber: context.baseIdentity.baseTurnNumber };
    entries.push(completeEvidence({ source, semanticRole: "character_authority", rank: index, selectionGroup: "cast",
      sourcePath: `/cast/characters/${index}`, normalizationVersion: "fiction-safe-json-v1" }, sentAuthority, sentAuthorityEvidenceOptions));
    for (const [fieldIndex, field] of character.fields.entries()) {
      entries.push(completeEvidence({ source: { ...source, id: `${character.characterId}:${field.evidenceId}`,
        turnNumber: field.source.effectiveTurnNumber ?? field.source.turnNumber ?? null },
      semanticRole: field.authority === "user" ? "corrected_state"
        : field.source.kind === "world" || field.source.kind === "historical_world" ? "world_reference" : "accepted_narration", rank: index, selectionGroup: "cast",
      sourcePath: `/cast/characters/${index}/fields/${fieldIndex}`, normalizationVersion: "fiction-safe-json-v1" }, sentAuthority, sentAuthorityEvidenceOptions));
    }
  }
  for (const [index, candidate] of historical.entries()) {
    const original = sourceCandidateById.get(candidate.id);
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
      canonicalFactId: candidate.kind === "canonical_fact" && /^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(candidate.id) ? candidate.id : null }, sentAuthority, sentAuthorityEvidenceOptions));
  }
  const body = { version: "generation-evidence-v1" as const, attemptId, producingRequestHash: sha256(requestBody), entries, requiredReviewEvidenceIds: entries.filter((entry) => entry.selectionGroup === "protected" || entry.selectionGroup === "cast").map((entry) => entry.id) };
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
  policy?: StoryMemoryPolicy,
  serializeStoryRequest?: (input: string) => string,
  reviewInputTokens?: (manifest: GenerationEvidenceManifest) => number,
  reviewInputLimit?: number,
  frozenContextProtocol?: string
) {
  const authority = context.authority;
  const historyCoverage = isHistoryCoverageContextProtocol(frozenContextProtocol);
  // We retain the complete bounded ledger source through reservation. A ledger
  // direction overlaps only when its matching recent record actually survives
  // exact packing; an available-but-omitted recent turn cannot erase intent.
  const ledgerRecords = historyCoverage ? authority.storyLedger?.entries ?? [] : [];
  // The source loader has already verified these complete records. Keep the
  // exact strings here: any future sanitizer that changes a fact must withhold
  // it rather than preserving its UUID with altered authority text.
  const protectedFactRecords: readonly ProtectedFact[] = historyCoverage
    ? (authority.protectedFacts ?? []).flatMap((fact) => typeof fact.id === "string" && typeof fact.content === "string"
      && fact.content.length > 0 && !containsMechanicsLanguage(fact.content) ? [{ id: fact.id, turnNumber: fact.turnNumber, content: fact.content }] : [])
    : [];
  const withheldProtectedFactCount = historyCoverage ? (authority.protectedFacts?.length ?? 0) - protectedFactRecords.length : 0;
  const castSnapshot = isGenerationBaseIdentityV4(context.baseIdentity) ? authority.castSnapshot : undefined;
  let castSelection: CastContextSelection | undefined;
  let castAllocatedTokens = 0;
  const layered = hasGenerationCharacterAuthority(context.baseIdentity) && policy?.recentTurnTarget === 3;
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
    worldCanon: hasGenerationCharacterAuthority(context.baseIdentity) ? worldFictionOverview(authority.worldCanon) : fictionSafeAuthority(authority.worldCanon ?? {}),
    selectedCharacterId: authority.selectedCharacterId ?? null,
    // This complete classified projection is distinct from world lore and
    // current continuity. The protected planner either sends it whole or
    // fails before provider I/O; it is never a bounded public preview.
    ...(hasGenerationCharacterAuthority(context.baseIdentity) && authority.characterAuthority
      ? { selectedCharacterAuthority: fictionSafeAuthority(authority.characterAuthority) }
      : {}),
    currentContinuity: fictionSafeAuthority(authority.currentContinuity ?? {}),
    currentScene: fictionSafeAuthority(authority.latestTurn ?? null),
    ...(hasGenerationCharacterAuthority(context.baseIdentity) ? { worldReferences: [] as readonly Readonly<{ sourceId: string; sourcePath: string; content: string }>[] } : {}),
    ...(layered ? { recentTurns: [] as typeof recentRecords } : {}),
    ...(historyCoverage ? { storyLedger: { version: "story-ledger-v1" as const, entries: [] as typeof ledgerRecords,
      omittedThroughTurn: authority.storyLedger?.omittedThroughTurn ?? null, ...(authority.storyLedger?.coverage ? { coverage: authority.storyLedger.coverage } : {}) } } : {}),
    ...(historyCoverage ? { protectedFacts: [] as readonly ProtectedFact[],
      protectedFactsOmitted: (authority.protectedFactsOmitted ?? 0) + withheldProtectedFactCount } : {}),
    chronicle: [] as readonly PromptCandidate[]
  };
  const duplicateIds: string[] = [];
  const protectedFactIds = new Set([
    ...(authority.currentContinuity?.canonicalFacts ?? []).map((fact) => fact.id).filter(Boolean),
    ...protectedFactRecords.map((fact) => fact.id)
  ]);
  const seen = new Set<string>();
  let sourceValidationFailures = 0;
  const sourceValidationFailureIds = new Set<string>();
  const sourceValidationExcludedIds = new Set<string>();
  const excerptAlternatives = new Map<string, PromptCandidate>();
  let candidates = context.candidates.map((source) => {
    const candidate = candidateRecord(source);
    if (source.sourceValidationFailed) {
      sourceValidationFailures++;
      sourceValidationFailureIds.add(candidate.id);
      // Optional canonical facts need complete source verification before they
      // can regain authority. A retained whole turn_fiction parent is safe;
      // an unverified canonical fact is not.
      if (source.kind === "canonical_fact") {
        sourceValidationExcludedIds.add(candidate.id);
        return null;
      }
    }
    if (!hasGenerationCharacterAuthority(context.baseIdentity) || policy?.excerptPolicy !== "verified_spans_v1" || source.kind !== "turn_fiction" || !source.narrativeSource) return candidate;
    const normalized = normalizeStoryEvidenceSource(source.content);
    const excerpt = selectVerifiedNarrativeExcerpt(normalized, source.narrativeSource.spans.map((span) => ({ ...span, normalizationVersion: source.narrativeSource!.normalizationVersion, sourceHash: source.narrativeSource!.sourceHash })));
    if (!excerpt) {
      sourceValidationFailures++;
      sourceValidationFailureIds.add(candidate.id);
      return candidate;
    }
    // Economical complete records remain whole. Large parents can use exact
    // certified spans with adjacent sentences; the final wire budget still decides.
    if (excerpt.content.length >= normalized.length) return candidate;
    const alternative: PromptCandidate = { ...candidate, content: excerpt.content, evidenceForm: "excerpt", sourceHash: excerpt.sourceHash, sourceSpans: excerpt.spans };
    excerptAlternatives.set(candidate.id, alternative);
    if (excerpt.content.length * 4 >= normalized.length || estimateStoryTokens(normalized) <= Math.min(contextLimit, inputLimit) * 0.15) return candidate;
    return alternative;
  }).filter((candidate): candidate is PromptCandidate => {
    if (!candidate) return false;
    if (!candidate.id || !candidate.content) return false;
    if (!layered) return true;
    const identity = candidate.kind === "canonical_fact" ? `fact:${candidate.id}` : candidate.turnId ? `turn:${candidate.turnId}` : `source:${candidate.id}`;
    if ((candidate.turnId && candidate.turnId === context.baseIdentity.baseTurnId)
      || (candidate.kind === "canonical_fact" && protectedFactIds.has(candidate.id)) || seen.has(identity)) {
      duplicateIds.push(candidate.id); return false;
    }
    seen.add(identity); return true;
  });
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const serializationProfile: TextProviderProfile = {
    ...provider,
    // Serialization needs the provider wire shape only; the live execution
    // binding retains its credential and destination outside this planner.
    baseUrl: ""
  };
  const serialize = serializeStoryRequest ?? ((input: string) => serializeProviderRequest(serializationProfile, { systemPrompt, input }).body);
  const reviewEnabled = Boolean(reviewInputTokens && attemptId && policy?.continuityReview !== "off");
  let ledgerMeasurementActive = false;
  let ledgerWriterSerializationCount = 0;
  let ledgerReviewerSerializationCount = 0;
  let factMeasurementActive = false;
  let factWriterSerializationCount = 0;
  let factReviewerSerializationCount = 0;
  const authorityRevision = sha256(stableStringify({ baseIdentity: context.baseIdentity, authority }));
  const blocks = [
    { id: "authority", revision: authorityRevision, content: stableStringify(authorityContext), protected: true, priority: 0, ordinal: 0, scope: "authority" },
    ...recentRecords.map((turn) => ({ id: `recent:${turn.sourceId}`, revision: context.recentTurns!.find((source) => source.turnId === turn.sourceId)!.sourceHash,
      content: stableStringify(turn), protected: false, priority: -turn.turnNumber, ordinal: turn.turnNumber, scope: "recent" })),
    ...ledgerRecords.map((entry) => ({ id: `ledger:${entry.turnId}`, revision: sha256(stableStringify(entry)),
      content: stableStringify(entry), protected: false, priority: -entry.turnNumber, ordinal: entry.turnNumber, scope: "ledger" })),
    ...protectedFactRecords.map((fact, index) => ({ id: `protected-fact:${fact.id}`, revision: sha256(fact.content),
      content: fact.content, protected: false, priority: -fact.turnNumber, ordinal: index, scope: "protected_fact" })),
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
  const promptContext = (selected: readonly Readonly<{ id: string }>[]) => {
    const selectedIds = new Set(selected.map((block) => block.id));
    const sentContext = {
      ...authorityContext,
      ...(castSelection?.content && selectedIds.has("cast-context")
        ? { cast: JSON.parse(castSelection.content) as SentCast } : {}),
      ...(hasGenerationCharacterAuthority(context.baseIdentity) ? { worldReferences: selected.filter((block: { id: string; scope?: string }) => block.scope === "world")
        .map((block) => worldReferences.find((reference) => reference.sourceId === block.id))
        .filter((reference): reference is typeof worldReferences[number] => Boolean(reference))
        .map(({ sourceId, sourcePath, content }) => ({ sourceId, sourcePath, content })) } : {}),
      ...(layered ? { recentTurns: recentRecords.filter((turn) => selectedIds.has(`recent:${turn.sourceId}`)).sort((a, b) => a.turnNumber - b.turnNumber) } : {}),
      ...(historyCoverage ? (() => {
        const reservedRecentIds = new Set(selected.filter((block: { id: string; scope?: string }) => block.scope === "recent")
          .map((block) => block.id.slice("recent:".length)));
        const entries = ledgerRecords.filter((entry) => selectedIds.has(`ledger:${entry.turnId}`)
          && !reservedRecentIds.has(entry.turnId));
        const selectedLedgerIds = new Set(entries.map((entry) => entry.turnId));
        const absent = ledgerRecords.filter((entry) => !selectedLedgerIds.has(entry.turnId));
        return { storyLedger: { version: "story-ledger-v1" as const, entries,
          omittedThroughTurn: Math.max(authority.storyLedger?.omittedThroughTurn ?? 0, ...absent.map((entry) => entry.turnNumber)) || null,
          ...(authority.storyLedger?.coverage ? { coverage: authority.storyLedger.coverage } : {}) } };
      })() : {}),
      ...(historyCoverage ? (() => {
        const facts = protectedFactRecords.filter((fact) => selectedIds.has(`protected-fact:${fact.id}`));
        const omitted = protectedFactRecords.length - facts.length;
        return { protectedFacts: facts, protectedFactsOmitted: (authority.protectedFactsOmitted ?? 0) + withheldProtectedFactCount + omitted };
      })() : {}),
      chronicle: candidates.filter((candidate) => selectedIds.has(candidate.id))
    };
    return historyCoverage ? projectHistoryCoverageContext(sentContext) : sentContext;
  };
  const planOptions = (planBlocks: readonly ContextBudgetBlock[]) => ({
    blocks: planBlocks,
    contextLimit,
    inputLimit,
    ...(reviewEnabled ? { additionalRequestInputLimit: reviewInputLimit ?? inputLimit } : {}),
    count: estimateStoryTokens,
    safetyAllowanceTokens: estimatedInputSafetyAllowanceTokens,
    contextSafetyAllowanceTokens: 0,
    serializeContext: (selected: readonly Readonly<{ id: string }>[]) => stableStringify(promptContext(selected)),
    contextValue: promptContext,
    serializeRequest: (selected: ReturnType<typeof promptContext>) => {
      if (ledgerMeasurementActive) ledgerWriterSerializationCount++;
      if (factMeasurementActive) factWriterSerializationCount++;
      return serialize(promptRoute === "story_memory"
        ? buildStoryMemoryUserPrompt(selected, action, false, guidance, storyLength, inputMode, historyCoverage)
        : buildStoryUserPrompt(selected, action, false, guidance, storyLength, inputMode)
      );
    },
    ...(reviewEnabled ? {
      additionalRequestTokens: (selected: ReturnType<typeof promptContext>) => {
        if (ledgerMeasurementActive) ledgerWriterSerializationCount++;
        if (factMeasurementActive) factWriterSerializationCount++;
        const body = serialize(buildStoryMemoryUserPrompt(selected, action, false, guidance, storyLength, inputMode, historyCoverage));
        const manifest = generationSourceManifest(attemptId!, body, context, action, selected,
          worldReferences.filter((reference) => (selected.worldReferences ?? []).some((entry) => entry.sourceId === reference.sourceId)));
        if (ledgerMeasurementActive) ledgerReviewerSerializationCount++;
        if (factMeasurementActive) factReviewerSerializationCount++;
        return reviewInputTokens!(manifest);
      }
    } : {}),
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
      if (error instanceof ContextBudgetError && hasGenerationCharacterAuthority(context.baseIdentity)) Object.assign(error, { protectedComponents });
      throw error;
    }
  };
  const writerRequestCost = (plan: ReturnType<typeof measure>) => plan.requestTokens + plan.safetyAllowanceTokens;
  const reviewRequestCost = (plan: ReturnType<typeof measure>) => plan.additionalRequestTokens
    + estimatedInputSafetyAllowanceTokens(plan.additionalRequestTokens);
  const requestCostDelta = (trial: ReturnType<typeof measure>, base: ReturnType<typeof measure>) => Math.max(
    writerRequestCost(trial) - writerRequestCost(base),
    reviewRequestCost(trial) - reviewRequestCost(base)
  );
  const requestHeadroom = (plan: ReturnType<typeof measure>) => Math.min(
    inputLimit - writerRequestCost(plan),
    ...(reviewEnabled ? [(reviewInputLimit ?? inputLimit) - reviewRequestCost(plan)] : [])
  );
  const useWorldQuota = hasGenerationCharacterAuthority(context.baseIdentity) && Boolean(authority.worldReferenceSource);
  let historyReservationDiagnostics: { originalHeadroomTokens: number; ledgerBudgetTokens: number; factBudgetTokens: number;
    measurementTrialCount: number; writerSerializationCount: number; reviewerSerializationCount: number; elapsedMilliseconds: number; firstOmittedTurnNumber: number | null;
    postProjectionRemovedEntryCount: number } | undefined;
  let factReservationDiagnostics: { originalHeadroomTokens: number; factBudgetTokens: number; sourceFactCount: number;
    selectedFactCount: number; omittedFactCount: number; measurementTrialCount: number; writerSerializationCount: number;
    reviewerSerializationCount: number; measurementLimitHit: boolean; unexaminedFactCount: number; elapsedMilliseconds: number } | undefined;
  let serializerGuardExcludedCount = 0;
  let candidateBatchedTrialCount = 0;
  let plan;
  if (useWorldQuota || layered || castSnapshot || historyCoverage) {
    const authorityBlock = blocks[0]!;
    let protectedPlan = measure([authorityBlock]);
    const castBlocks: typeof blocks = [];
    if (castSnapshot) {
      castAllocatedTokens = Math.min(3000, Math.floor(0.10 * Math.max(0, Math.min(
        contextLimit - protectedPlan.contextTokens, requestHeadroom(protectedPlan)))));
      let budgetTokens = castAllocatedTokens;
      for (;;) {
        castSelection = selectCastContext({ snapshot: castSnapshot, direction: action,
          currentScene: authority.latestTurn?.narration ?? "", openThreads: authority.openThreads, budgetTokens });
        if (!castSelection.content) break;
        const block = { id: "cast-context", revision: sha256(castSelection.content), content: castSelection.content,
          protected: false, priority: 0, ordinal: 0, scope: "cast" };
        const trial = measure([authorityBlock, block]);
        const added = Math.max(trial.contextTokens - protectedPlan.contextTokens,
          requestCostDelta(trial, protectedPlan));
        if (trial.selected.some((entry) => entry.id === block.id) && added <= castAllocatedTokens) {
          castBlocks.push({ ...block, protected: true }); protectedPlan = trial; break;
        }
        // Account for the provider envelope and escaping, not only selector JSON.
        budgetTokens = Math.max(0, budgetTokens - Math.max(1, added - castAllocatedTokens));
      }
    }
    const reservedAuthority = [authorityBlock, ...castBlocks];
    const originalHeadroom = Math.max(0, Math.min(
      contextLimit - protectedPlan.contextTokens,
      requestHeadroom(protectedPlan)
    ));
    const ledgerCeiling = historyCoverage ? Math.floor(originalHeadroom * HISTORY_COVERAGE_POLICY.ledgerBudgetShare) : 0;
    const factCeiling = historyCoverage ? Math.floor(originalHeadroom * HISTORY_COVERAGE_POLICY.protectedFactBudgetShare) : 0;
    let selectedFactBlocks: typeof blocks = [];
    if (historyCoverage) {
      const factBlocks = blocks.filter((candidate) => candidate.scope === "protected_fact");
      const startedAt = performance.now();
      let measurementTrialCount = 0;
      let measurementLimitHit = false;
      let unexaminedFactCount = 0;
      const measureFacts = (factSelection: typeof blocks) => {
        if (measurementTrialCount >= MAX_PROTECTED_FACT_MEASUREMENTS) return null;
        factMeasurementActive = true;
        measurementTrialCount++;
        try { return measure([...reservedAuthority, ...factSelection.map((candidate) => ({ ...candidate, protected: true }))]); }
        catch (error) {
          if (error instanceof ContextBudgetError) return null;
          throw error;
        } finally { factMeasurementActive = false; }
      };
      const selectedFacts = (trial: ReturnType<typeof measure> | null, factSelection: typeof blocks) => trial !== null
        && factSelection.every((candidate) => trial.selected.some((block) => block.id === candidate.id));
      const fitsFactQuota = (trial: ReturnType<typeof measure> | null, factSelection: typeof blocks) => {
        if (!selectedFacts(trial, factSelection) || trial === null) return false;
        return Math.max(trial.contextTokens - protectedPlan.contextTokens, requestCostDelta(trial, protectedPlan)) <= factCeiling;
      };
      // The full ordered set is an exact, semantics-preserving fast path: if
      // it fits as whole records under the same fixed fact quota, the
      // newest-first skip-nonfit loop would select every record as well.
      // This avoids rebuilding a multi-megabyte reviewer manifest once per
      // fact for the common high-headroom case.
      let allFactsFit = false;
      if (factBlocks.length) {
        const trial = measureFacts(factBlocks);
        if (fitsFactQuota(trial, factBlocks)) {
          selectedFactBlocks = factBlocks.map((candidate) => ({ ...candidate, protected: true }));
          allFactsFit = true;
        }
      }
      // Establish the largest fitting newest contiguous run with exact,
      // monotone suffix probes. That run is identical to greedy selection up
      // to its first nonfit; afterwards older heterogeneous records are still
      // examined individually, so this is not suffix-only fact selection.
      let nextOlderIndex = factBlocks.length - 1;
      if (!allFactsFit && factBlocks.length && measurementTrialCount < MAX_PROTECTED_FACT_MEASUREMENTS) {
        let fittingLength = 0;
        let failingLength = factBlocks.length;
        while (fittingLength + 1 < failingLength && measurementTrialCount < MAX_PROTECTED_FACT_MEASUREMENTS) {
          const candidateLength = Math.ceil((fittingLength + failingLength) / 2);
          const suffix = factBlocks.slice(factBlocks.length - candidateLength);
          if (fitsFactQuota(measureFacts(suffix), suffix)) fittingLength = candidateLength;
          else failingLength = candidateLength;
        }
        selectedFactBlocks = factBlocks.slice(factBlocks.length - fittingLength).map((candidate) => ({ ...candidate, protected: true }));
        nextOlderIndex = factBlocks.length - fittingLength - 1;
      }
      // Facts deliberately do not use reserveNewestWholeSuffix: a too-large
      // newer fact must not prevent an older smaller fact from fitting.
      for (let index = nextOlderIndex; !allFactsFit && index >= 0; index -= 1) {
        if (measurementTrialCount >= MAX_PROTECTED_FACT_MEASUREMENTS) {
          measurementLimitHit = true;
          unexaminedFactCount = index + 1;
          break;
        }
        const candidate = factBlocks[index]!;
        const trial = measureFacts([...selectedFactBlocks, candidate]);
        if (fitsFactQuota(trial, [...selectedFactBlocks, candidate])) selectedFactBlocks = [{ ...candidate, protected: true }, ...selectedFactBlocks];
      }
      factReservationDiagnostics = {
        originalHeadroomTokens: originalHeadroom, factBudgetTokens: factCeiling, sourceFactCount: protectedFactRecords.length,
        selectedFactCount: selectedFactBlocks.length, omittedFactCount: protectedFactRecords.length - selectedFactBlocks.length,
        measurementTrialCount, writerSerializationCount: factWriterSerializationCount,
        reviewerSerializationCount: factReviewerSerializationCount, measurementLimitHit, unexaminedFactCount,
        elapsedMilliseconds: performance.now() - startedAt
      };
    }
    // Keep the original H-derived 25% allocation, but charge each ledger
    // suffix against the authority plus the fact records already reserved.
    // H is deliberately never recomputed after fact selection.
    const factBaselinePlan = measure([...reservedAuthority, ...selectedFactBlocks]);
    let selectedLedgerBlocks: typeof blocks = [];
    if (historyCoverage) {
      const ledgerBlocks = blocks.filter((candidate) => candidate.scope === "ledger")
        .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id));
      const reservation = reserveNewestWholeSuffix({
        entries: ledgerBlocks,
        budgetTokens: ledgerCeiling,
        now: () => performance.now(),
        measureTokens: (suffix) => {
          ledgerMeasurementActive = true;
          try {
            const trial = measure([...reservedAuthority, ...selectedFactBlocks, ...suffix.map((block) => ({ ...block, protected: true }))]);
            if (!suffix.every((block) => trial.selected.some((candidate) => candidate.id === block.id))) return Number.POSITIVE_INFINITY;
            return Math.max(trial.contextTokens - factBaselinePlan.contextTokens, requestCostDelta(trial, factBaselinePlan));
          } catch (error) {
            if (error instanceof ContextBudgetError) return Number.POSITIVE_INFINITY;
            throw error;
          } finally {
            ledgerMeasurementActive = false;
          }
        }
      });
      selectedLedgerBlocks = reservation.entries.map((block) => ({ ...block, protected: true }));
      historyReservationDiagnostics = {
        originalHeadroomTokens: originalHeadroom,
        ledgerBudgetTokens: ledgerCeiling,
        factBudgetTokens: factCeiling,
        measurementTrialCount: reservation.trialCount,
        writerSerializationCount: ledgerWriterSerializationCount,
        reviewerSerializationCount: ledgerReviewerSerializationCount,
        elapsedMilliseconds: reservation.elapsedMilliseconds,
        firstOmittedTurnNumber: reservation.firstOmittedEntry?.ordinal ?? null,
        postProjectionRemovedEntryCount: 0
      };
    }
    const residual = Math.max(0, originalHeadroom - factCeiling - ledgerCeiling);
    const worldCeiling = Math.floor(residual * (policy?.worldResidualShare ?? 0.15));
    const recentCeiling = Math.floor(residual * (policy?.recentResidualShare ?? 0));
    const selectedRecentBlocks: typeof blocks = [];
    if (layered) {
      for (let ordinal = context.baseIdentity.baseTurnNumber - 1; ordinal >= Math.max(1, context.baseIdentity.baseTurnNumber - 2); ordinal--) {
        const block = blocks.find((candidate) => candidate.scope === "recent" && candidate.ordinal === ordinal);
        if (!block) { recentDiagnostics.firstGapReason = "recent_gap"; break; }
        const trial = measure([...reservedAuthority, ...selectedLedgerBlocks, ...selectedFactBlocks, ...selectedRecentBlocks, block]);
        if (!trial.selected.some((candidate) => candidate.id === block.id)) {
          recentDiagnostics.firstGapReason = trial.omitted[0]?.reason ?? "context_limit"; break;
        }
        const added = Math.max(trial.contextTokens - protectedPlan.contextTokens,
          requestCostDelta(trial, protectedPlan));
        if (added > recentCeiling) { recentDiagnostics.firstGapReason = "context_limit"; break; }
        selectedRecentBlocks.push({ ...block, protected: true });
        recentDiagnostics.included++;
      }
    }
    // A selected recent record already carries both the requested intent and
    // accepted narration. Remove only those duplicate ledger projections and
    // immediately remeasure the frozen selection before allocating optional
    // world/retrieval records. Do not backfill from older ledger entries.
    const reservedRecentIds = new Set(selectedRecentBlocks.map((block) => block.id.slice("recent:".length)));
    const projectedLedgerBlocks = selectedLedgerBlocks.filter((block) => !reservedRecentIds.has(block.id.slice("ledger:".length)));
    if (projectedLedgerBlocks.length !== selectedLedgerBlocks.length) {
      historyReservationDiagnostics = historyReservationDiagnostics && {
        ...historyReservationDiagnostics,
        postProjectionRemovedEntryCount: selectedLedgerBlocks.length - projectedLedgerBlocks.length
      };
      selectedLedgerBlocks = projectedLedgerBlocks;
    }
    const worldBasePlan = measure([...reservedAuthority, ...selectedLedgerBlocks, ...selectedFactBlocks, ...selectedRecentBlocks]);
    const selectedWorldBlocks: typeof blocks = [];
    for (const worldBlock of blocks.filter((block) => block.scope === "world").sort((left, right) => left.priority - right.priority || left.ordinal - right.ordinal || left.id.localeCompare(right.id))) {
      const trial = measure([...reservedAuthority, ...selectedLedgerBlocks, ...selectedFactBlocks, ...selectedRecentBlocks, ...selectedWorldBlocks, worldBlock]);
      if (!trial.selected.some((block) => block.id === worldBlock.id)) continue;
      const added = Math.max(
        trial.contextTokens - worldBasePlan.contextTokens,
        requestCostDelta(trial, worldBasePlan)
      );
      if (added <= worldCeiling) selectedWorldBlocks.push({ ...worldBlock, protected: true });
    }
    // Selected world records are pre-measured whole optional records. Remaining optional
    // capacity stays available to history; their reservation is not held back.
    const recentIds = new Set(selectedRecentBlocks.map((block) => block.id.slice("recent:".length)));
    const historicalBlocks = blocks.filter((block) => {
      if (block.scope !== "chronicle") return false;
      const candidate = candidateById.get(block.id)!;
      if (layered && candidate.turnId && recentIds.has(candidate.turnId)) { duplicateIds.push(candidate.id); return false; }
      return true;
    });
    if (!historyCoverage) {
      plan = measure([...reservedAuthority, ...selectedLedgerBlocks, ...selectedFactBlocks, ...selectedRecentBlocks, ...selectedWorldBlocks, ...historicalBlocks]);
    } else {
      const fixedBlocks = [...reservedAuthority, ...selectedLedgerBlocks, ...selectedFactBlocks, ...selectedRecentBlocks, ...selectedWorldBlocks]
        .map((block) => ({ ...block, protected: true }));
      const orderedHistoricalBlocks = [...historicalBlocks].sort((left, right) => left.priority - right.priority
        || (left.scope ?? "").localeCompare(right.scope ?? "") || left.ordinal - right.ordinal || left.id.localeCompare(right.id)
        || left.revision.localeCompare(right.revision));
    // A 4m envelope must not pay one complete serializer/reviewer pass for
    // every candidate when the exact whole set fits. Prove that case once,
    // using the same planner serializers, then keep the full ordered set.
      let completePlan: ReturnType<typeof measure> | undefined;
      try {
        completePlan = measure([...fixedBlocks, ...orderedHistoricalBlocks.map((block) => ({ ...block, protected: true }))]);
      } catch (error) {
        if (!(error instanceof ContextBudgetError)) throw error;
      }
      if (completePlan) {
        plan = completePlan;
      } else {
      // For a partial envelope, binary-search an exact whole prefix before
      // probing a small deterministic tail for individually fitting records.
      // The remaining records are reported as serializer-guard omissions so a
      // synchronous lease cannot be starved by an unbounded greedy loop.
        let fittingLength = 0;
        let failingLength = orderedHistoricalBlocks.length;
        let selected = fixedBlocks;
        while (fittingLength + 1 < failingLength) {
        const candidateLength = Math.ceil((fittingLength + failingLength) / 2);
        candidateBatchedTrialCount++;
        try {
          const trial = measure([...fixedBlocks, ...orderedHistoricalBlocks.slice(0, candidateLength).map((block) => ({ ...block, protected: true }))]);
          fittingLength = candidateLength;
          selected = trial.selected.map((block) => ({ ...block, scope: block.scope ?? "", protected: true }));
        } catch (error) {
          if (!(error instanceof ContextBudgetError)) throw error;
          failingLength = candidateLength;
        }
        }
        selected = [...fixedBlocks, ...orderedHistoricalBlocks.slice(0, fittingLength).map((block) => ({ ...block, protected: true }))];
        let nextIndex = fittingLength;
        for (; nextIndex < orderedHistoricalBlocks.length && candidateBatchedTrialCount < MAX_HISTORY_COVERAGE_PARTIAL_CANDIDATE_PROBES; nextIndex += 1) {
        candidateBatchedTrialCount++;
        const candidate = orderedHistoricalBlocks[nextIndex]!;
        try {
          measure([...selected, { ...candidate, protected: true }]);
          selected = [...selected, { ...candidate, protected: true }];
        } catch (error) {
          if (!(error instanceof ContextBudgetError)) throw error;
        }
        }
        serializerGuardExcludedCount = orderedHistoricalBlocks.length - (selected.length - fixedBlocks.length);
        plan = measure(selected);
      }
    }
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
    ? buildStoryMemoryUserPrompt(selectedContext, action, false, guidance, storyLength, inputMode, historyCoverage)
    : buildStoryUserPrompt(selectedContext, action, false, guidance, storyLength, inputMode);
  const requestBody = serialize(storyInput);
  const historyDiagnostics = historyCoverage ? historyCoverageDiagnosticsSchema.parse({
    version: "history-coverage-diagnostics-v1",
    limits: {
      contextTokens: contextLimit,
      writerInputTokens: inputLimit,
      reviewerInputTokens: reviewEnabled ? reviewInputLimit ?? inputLimit : null,
      recentWindowTurns: HISTORY_COVERAGE_POLICY.recentWindowTurns,
      candidatePoolLimit: context.chronicleSelectionDiagnostics?.candidatePoolLimit ?? null,
      protectedFactMeasurements: MAX_PROTECTED_FACT_MEASUREMENTS
    },
    candidates: {
      sourceCount: candidates.length,
      selectedCount: selectedContext.chronicle.length,
      omittedCount: Math.max(0, candidates.length - selectedContext.chronicle.length),
      selectedEstimateTokens: Math.round(selectedContext.chronicle.reduce((total, candidate) => total + Math.max(0, candidate.estimatedTokens), 0)),
      serializerGuardExcludedCount,
      batchedTrialCount: candidateBatchedTrialCount,
      candidatePoolCandidatesRemoved: context.chronicleSelectionDiagnostics?.candidatePoolCandidatesRemoved ?? null,
      stopReason: context.chronicleSelectionDiagnostics?.stopReason ?? null,
      fallbackReason: context.chronicleRetrieval
        ? context.chronicleRetrieval.fallbackCode ?? "none"
        : null,
      duplicateExcluded: duplicateIds.length,
      sourceValidationFailureCount: sourceValidationFailureIds.size,
      sourceValidationExcluded: sourceValidationExcludedIds.size
    },
    ledger: authority.storyLedger ? {
      capturedCount: ledgerRecords.length,
      sentCount: selectedContext.storyLedger?.entries.length ?? 0,
      omittedCount: Math.max(0, ledgerRecords.length - (selectedContext.storyLedger?.entries.length ?? 0)),
      coveredByRecentCount: historyReservationDiagnostics?.postProjectionRemovedEntryCount ?? 0,
      sourceExcludedCount: (authority.storyLedger.coverage?.missingTurnCount ?? 0)
        + (authority.storyLedger.coverage?.filteredDirectionCount ?? 0)
        + (authority.storyLedger.coverage?.oversizedDirectionCount ?? 0),
      unreadThroughTurn: authority.storyLedger.coverage?.unreadThroughTurn ?? null,
      budgetTokens: historyReservationDiagnostics?.ledgerBudgetTokens ?? 0,
      measurementTrialCount: historyReservationDiagnostics?.measurementTrialCount ?? null
    } : null,
    facts: authority.protectedFacts ? {
      sourceCount: authority.protectedFacts.length,
      sentCount: selectedContext.protectedFacts?.length ?? 0,
      omittedCount: Math.max(0, authority.protectedFacts.length - (selectedContext.protectedFacts?.length ?? 0)),
      sourceOmittedCount: (authority.protectedFactsOmitted ?? 0) + withheldProtectedFactCount,
      budgetTokens: factReservationDiagnostics?.factBudgetTokens ?? 0,
      measurementLimit: MAX_PROTECTED_FACT_MEASUREMENTS,
      measurementLimitHit: factReservationDiagnostics?.measurementLimitHit ?? false,
      unexaminedCount: factReservationDiagnostics?.unexaminedFactCount ?? 0,
      sourceCoverage: authority.protectedFactsCoverage ?? null
    } : null,
    recents: context.recentTurns ? {
      capturedCount: context.recentTurns.length,
      sentCount: selectedContext.recentTurns?.length ?? 0,
      targetCount: recentDiagnostics.target,
      firstGapReason: recentDiagnostics.firstGapReason
    } : null,
    finalTokens: {
      context: plan.contextTokens,
      writerRequest: plan.requestTokens,
      reviewerRequest: reviewEnabled ? plan.additionalRequestTokens ?? null : null
    }
  }) : undefined;
  return {
    layerDiagnostics: {
      ...(castSelection ? { cast: { allocatedTokens: castAllocatedTokens, estimatedTokens: castSelection.estimatedTokens,
        omittedCharacterIds: castSelection.omittedCharacterIds, omittedFieldCount: castSelection.omittedFieldCount, coverage: castSelection.coverage } } : {}),
      recent: recentDiagnostics,
      duplicateSourceCount: duplicateIds.length,
      excerptsComplete: selectedContext.chronicle.filter((candidate) => !candidate.evidenceForm).length,
      excerptsPartial: selectedContext.chronicle.filter((candidate) => candidate.evidenceForm === "excerpt").length,
      sourceValidationFailures,
      ...(historyReservationDiagnostics ? { ledgerReservation: historyReservationDiagnostics } : {}),
      ...(factReservationDiagnostics ? { factReservation: factReservationDiagnostics } : {}),
      ...(historyDiagnostics ? { history: historyDiagnostics } : {}),
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
    worldReferenceOmissions: hasGenerationCharacterAuthority(context.baseIdentity) ? worldSelection?.omissions ?? { unrecognizedRecordCount: 0, missingEndpointCount: 0, ambiguousAliasCount: 0, oversizedRecordCount: 0, entityCapCount: 0, relationshipCapCount: 0 } : null,
    ...(attemptId ? { sourceManifest: generationSourceManifest(attemptId, requestBody, context, action, selectedContext, worldReferences.filter((reference) => (selectedContext.worldReferences ?? []).some((selected) => selected.sourceId === reference.sourceId))) } : {})
  };
}
