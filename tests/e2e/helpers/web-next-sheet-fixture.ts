import { type Page, type Route } from "@playwright/test";
export const campaignId = "11111111-1111-4111-8111-111111111111";
const worldId = "33333333-3333-4333-8333-333333333333";
const versionId = "44444444-4444-4444-8444-444444444444";
const protagonistId = "66666666-6666-4666-8666-666666666666";
const candidateId = "88888888-8888-4888-8888-888888888888";
export async function fixture(page: Page, deferredDetails = false, conflictFixture = false, presetFixture = false, applyFixture = false, seededFixture = false, deepLink = false, eligible = false, reviewFixture = false, observationFixture = false) {
  let stalePreset = presetFixture;
  let liveLock = false;
  let revision = 0, enabled = true, conflict = false, trackingComplete = false, trackingUnavailable = false, pendingMatch = true;
  let reviewDismissed = false; let reviewRevision = 0; let retracted = false; let sourceInvalid = false;
  let resolvedCharacterId: string | undefined;
  const characters: any[] = [{ id: protagonistId, name: "Iven", aliases: [], origin: { kind: "protagonist", selectedCharacterId: null },
    profile: {}, pinned: false, ignored: false, revision: 0, firstObservedTurn: 0, lastObservedTurn: 1 }];
  if (conflictFixture) characters.push({ id: candidateId, name: "Mara", aliases: [], origin: { kind: "manual" }, profile: {}, pinned: false, ignored: false, revision: 0, firstObservedTurn: 1, lastObservedTurn: 1 });
  if (seededFixture) {
    const person = characters.find(item => item.id === candidateId)!;
    person.originProfile = { seedEventId: protagonistId, worldVersionId: versionId, entityId: "world-scout", rosterName: "Mara", rosterAliases: [], legacyCharacterText: "", profile: { story: { role: "Guide", goals: "Find home" } }, evidence: { kind: "world", worldVersionId: versionId, sourcePath: "/playableCharacters/0" } };
    person.campaignProfile = { story: { role: "Captain", personality: "Patient", goals: "Find home" } };
    person.fieldSources = { "story.role": "campaign_edit", "story.personality": "campaign_edit", "story.goals": "authored" };
  }
  const overrides = new Map<string, Record<string, string>>();
  const writes: any[] = [], profileWrites: any[] = [];
  const campaign = { id: campaignId, title: "Cast fixture", status: "active", activeTurnNumber: 1, createdAt: "2026-09-16T12:00:00.000Z", updatedAt: "2026-09-16T12:00:00.000Z", worldId, worldTitle: "Fixture world",
    worldVersionId: versionId, worldVersionNumber: 1, latestWorldVersionNumber: 1, worldUpdateAvailable: false,
    selectedCharacterId: null, selectedCharacterName: "", characterSnapshot: null, characterProfile: null,
    characterProfileRevision: 0, storyLengthProfile: "standard", storyContextBudgetTokens: 32000,
    turnControlStyle: "flexible_action", textProviderProfileId: null, imageProviderProfileId: null, costInformation: [] };
  const turn = { id: "55555555-5555-4555-8555-555555555555", turnNumber: 1, action: "Look around.", narration: "Mara waits at the gate.",
    inputMode: "action", inputModeSource: "explicit", choices: [], customActionSuggestion: "", imagePrompt: "", imageUrl: null,
    acceptedAt: "2026-09-16T12:00:00.000Z", chronicleRetrieval: null, reportedCost: null };
  const boundary = { turnNumber: 1, timelineRevision: 0 };
  const send = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (path.includes("/cast")) {
      const id = path.split("/cast/")[1];
      if (seededFixture && id === `${candidateId}/authored-profile` && request.method() === "POST") {
        const input = request.postDataJSON(); writes.push(input);
        if (conflict) { conflict = false; revision++; return send(route, { code: "cast_revision_conflict" }, 409); }
        const person = characters.find(item => item.id === candidateId)!; revision++; person.revision++;
        return send(route, { character: person, revision, boundary });
      }
      if (presetFixture && id === "from-world" && request.method() === "GET") return send(route, { characters: [{ characterId: "world-scout", name: "Scout", alwaysInContext: true }] });
      if (presetFixture && id === "from-world-preview") return send(route, { worldVersionId: versionId, characterId: "world-scout", eligibleTargets: applyFixture ? [{ id: candidateId, name: "Mara", revision: 0 }] : [], ...(applyFixture && url.searchParams.has("targetCastCharacterId") ? { targetCastCharacterId: candidateId, characterRevision: 0 } : {}), castRevision: revision, boundary, choices: [], changes: [{ path: "identity", old: null, proposed: { name: "Scout", aliases: [] }, effect: "create" }], previewFingerprint: "a".repeat(64) });
      if (presetFixture && id === "from-world" && request.method() === "POST") {
        if (stalePreset) { stalePreset = false; return send(route, { code: "cast_revision_conflict", message: "Changed" }, 409); }
        const person = applyFixture ? characters.find((item) => item.id === candidateId) : { id: candidateId, name: "Scout", aliases: [], profile: {}, origin: { kind: "manual" }, pinned: true, ignored: false, revision: 1, firstObservedTurn: 1, lastObservedTurn: 1 };
        if (!applyFixture) characters.push(person); revision++; return send(route, { character: person, revision, boundary });
      }
      if (id === "context-preview") return send(route, { mode: "estimate", boundary, castRevision: revision, budgetTokens: 500, usedTokens: 25, coverage: { fromTurn: 1, throughTurn: 1, baseTurn: 1, current: true }, selected: [{ characterId: protagonistId, name: "Iven", reason: "pinned" }], omitted: [{ characterId: candidateId, reason: "budget" }], disabledReason: null });
      if (id === "workspace-status") return send(route, { revision, boundary, capabilities: { editing: enabled, discovery: true, autoMatch: true, backfill: true, context: true, ...(reviewFixture ? { reviewDecisions: true, reviewDecisionReadVersion: 1 } : {}), ...(observationFixture ? { observationDecisions: true } : {}) }, contextDisabledReason: null, counts: { identities: pendingMatch ? 1 : 0, details: 0, conflicts: 1 }, tracking: { enabled: true, state: trackingComplete ? "complete" : "catching_up", activeTurnNumber: 1, coverageStartTurn: 1, trackedThroughTurn: trackingComplete ? 1 : 0, unresolvedCount: pendingMatch ? 1 : 0, firstGap: trackingComplete ? null : { turnNumber: 1, jobId: null, status: "missing", diagnosticCode: null } } });
      if (id === "discovery") return trackingUnavailable ? send(route, {}, 503) : send(route, {
        enabled: true, state: trackingComplete ? "complete" : "catching_up", activeTurnNumber: 1,
        coverageStartTurn: 1, trackedThroughTurn: trackingComplete ? 1 : 0, unresolvedCount: pendingMatch ? 1 : 0,
        firstGap: trackingComplete ? null : { turnNumber: 1, jobId: null, status: "missing", diagnosticCode: null } });
      if (reviewFixture && id === "review-decisions") return send(route, { revision, boundary, reviewRevision, nextCursor: null, decisions: reviewDismissed ? [{ decisionId: versionId, candidateId, canRestore: true, source: { scope: { campaignId, ownerUserId: worldId }, turnId: turn.id, turnNumber: 1, narrationRevision: 0, sourceHash: "a".repeat(64), timelineRevision: 0, paragraphs: [{ id: "p1", text: turn.narration }] }, target: { kind: "identity", proposal: { localKey: "mara", name: "Mara", aliases: [], existingCharacterId: null, identityEvidence: [{ paragraphId: "p1", quote: turn.narration }], observations: [] } } }] : [] });
      if (reviewFixture && id === `candidates/${candidateId}/review-decisions`) { const input = request.postDataJSON(); writes.push(input); reviewDismissed = input.action !== "restore"; reviewRevision++; return send(route, { decisionId: versionId, candidateId, reviewRevision, revision, boundary, disposition: input.action }); }
      if (id === "candidates") return send(route, { revision, boundary, nextCursor: null, candidates: pendingMatch && !reviewDismissed && !(url.searchParams.get("view") === "matches" && resolvedCharacterId) ? [{ id: candidateId,
        ...(resolvedCharacterId ? { resolvedCharacterId, details: [{ observationIndex: 0, field: "story.role", value: "gatekeeper", quote: turn.narration, reason: "claim_not_fact", sourceHash: "a".repeat(64) }] } : {}),
        reason: "identity_needs_review", ...(reviewFixture ? { reviewRevision, reviewDetails: [] } : {}), proposal: { localKey: "mara", name: "Mara", aliases: [], existingCharacterId: null,
          identityEvidence: [{ paragraphId: "p1", quote: turn.narration }], observations: deferredDetails ? [{ field: "story.role", value: "gatekeeper",
            mode: "fact", speakerCharacterId: null, paragraphId: "p1", quote: turn.narration }] : [] },
        source: { turnId: turn.id, turnNumber: 1, narrationRevision: 0, ...(reviewFixture ? { sourceHash: "a".repeat(64) } : {}) } }] : [] });
      if (id === `candidates/${candidateId}/resolve`) {
        const input = request.postDataJSON(); writes.push(input);
        if (!enabled) return send(route, { code: "cast_editing_disabled" }, 503);
        if (input.expectedCastRevision !== revision) return send(route, { code: "cast_revision_conflict" }, 409);
        revision++; pendingMatch = deferredDetails;
        const person = input.action === "attach" ? characters.find((p) => p.id === input.characterId) : {
          id: crypto.randomUUID(), name: "Mara", aliases: [], profile: {}, origin: { kind: "discovered" },
          pinned: false, ignored: false, revision: 1, firstObservedTurn: 1, lastObservedTurn: 1 };
        if (input.action === "create") characters.push(person);
        resolvedCharacterId = person.id;
        return send(route, { candidateId, character: person, revision, boundary, observationIds: [],
          ...(deferredDetails ? { pendingObservations: [{ index: 0, reason: "claim_not_fact" }] } : {}) });
      }
      if (observationFixture && id?.startsWith(`characters/${candidateId}/observations/`)) {
        const observation = { id: protagonistId, characterId: candidateId, field: "story.role", value: "guide", mode: "fact", speakerCharacterId: null, supersedesObservationId: null, evidence: { kind: "turn", turnId: turn.id, turnNumber: 1, narrationRevision: 0, sourceHash: "a".repeat(64), paragraphId: "p1", quote: turn.narration } };
        if (id.endsWith("decision-preview")) return send(route, { field: observation.field, currentValue: retracted ? null : "guide", projectedValue: retracted ? "guide" : null, currentConflict: false, projectedConflict: false, source: observation, castRevision: revision, characterRevision: 0, boundary });
        const input = request.postDataJSON(); writes.push(input); retracted = input.action === "retract";
        return send(route, { character: characters.find(c => c.id === candidateId), revision, boundary, observationId: protagonistId, decisionEventId: versionId, disposition: retracted ? "retracted" : "restored" });
      }
      if (request.method() !== "GET") {
        const input = request.postDataJSON(); writes.push(input);
        if (!enabled) return send(route, { code: "cast_editing_disabled" }, 503);
        if (conflict) { conflict = false; revision++; return send(route, { code: "cast_revision_conflict" }, 409); }
        if (input.expectedCastRevision !== revision) return send(route, { code: "cast_revision_conflict" }, 409);
        revision++;
        let person = characters.find((c) => c.id === id);
        if (!person) { person = { id: crypto.randomUUID(), name: input.name, aliases: input.aliases, profile: input.profile,
          origin: { kind: "manual" }, pinned: false, ignored: false, revision: 1, firstObservedTurn: 1, lastObservedTurn: 1 }; characters.push(person); overrides.set(person.id, { ...input.profile }); }
        else {
          for (const key of ["name", "aliases", "pinned", "ignored"]) if (key in input) person[key] = input[key];
          const current = overrides.get(id!) ?? {}; Object.assign(current, input.setOverrides ?? {});
          for (const field of input.clearOverrides ?? []) delete current[field]; overrides.set(id!, current);
          person.profile = { "appearance.description": "blue eyes", ...current }; person.revision++;
        }
        return send(route, { character: person, revision, boundary }, id ? 200 : 201);
      }
      if (id) {
        const person = characters.find((c) => c.id === id);
        if (observationFixture && id === candidateId) return send(route, { character: person, revision, boundary, capabilities: { castEditing: true, castObservationDecisions: true }, observations: sourceInvalid ? [] : [{ id: protagonistId, characterId: candidateId, field: "story.role", value: "guide", mode: "fact", speakerCharacterId: null, supersedesObservationId: null, evidence: { kind: "turn", turnId: turn.id, turnNumber: 1, narrationRevision: 0, sourceHash: "a".repeat(64), paragraphId: "p1", quote: turn.narration } }], observationDecisionStatus: [{ observationId: protagonistId, state: sourceInvalid ? "read_only" : retracted ? "retracted" : "eligible", retractionEventId: retracted ? versionId : null, reason: sourceInvalid ? "source_invalid" : null }], retractedObservationHistory: sourceInvalid ? [{ id: protagonistId, characterId: candidateId, field: "story.role", value: "guide", mode: "fact", speakerCharacterId: null, supersedesObservationId: null, evidence: { kind: "turn", turnId: turn.id, turnNumber: 1, narrationRevision: 0, sourceHash: "a".repeat(64), paragraphId: "p1", quote: turn.narration } }] : [], overrides: [], identityEvents: [], unresolvedCandidateIds: [], editorDestination: null });
        if (conflictFixture && id === candidateId) return send(route, { character: person, draftFromStoryEligible: eligible, revision, boundary, capabilities: { castEditing: enabled }, observations: ["guide", "guard"].map((value, index) => ({ id: index ? "77777777-7777-4777-8777-777777777778" : "77777777-7777-4777-8777-777777777777", characterId: id, field: "story.role", value, mode: "fact", speakerCharacterId: null, supersedesObservationId: null, evidence: { kind: "turn", turnId: turn.id, turnNumber: 1, narrationRevision: 0, sourceHash: "a".repeat(64), paragraphId: "p1", quote: turn.narration } })), overrides: [], identityEvents: [], unresolvedCandidateIds: [], editorDestination: null });
        return send(route, { character: person, revision, boundary, capabilities: { castEditing: enabled, ...(reviewFixture ? { castLifecycle: false } : {}) }, observations: id === protagonistId ? [] : [{
          id: "77777777-7777-4777-8777-777777777777", characterId: id, field: "story.role", value: "gatekeeper", mode: "claim",
          speakerCharacterId: protagonistId, supersedesObservationId: null,
          evidence: { kind: "turn", turnId: turn.id, turnNumber: 1, narrationRevision: 0, sourceHash: "a".repeat(64), paragraphId: "p1", quote: turn.narration }
        }],
          overrides: Object.entries(overrides.get(id) ?? {}).map(([field, value]) => ({ field, value, evidence: { kind: "user", editId: protagonistId, effectiveTurnNumber: 1 } })),
          identityEvents: [], unresolvedCandidateIds: [], editorDestination: id === protagonistId ? `/api/v1/campaigns/${campaignId}/character-profile` : null });
      }
      const query = url.searchParams.get("query")?.toLowerCase() ?? "";
      const matches = characters.filter((c) => (url.searchParams.get("filter") !== "conflicts" || c.id === (conflictFixture ? candidateId : protagonistId)) && [c.name, ...c.aliases].some((name: string) => name.toLowerCase().includes(query)));
      const cursor = url.searchParams.get("cursor"), offset = cursor ? matches.findIndex((person) => person.id === cursor) + 1 : 0;
      const page = matches.slice(offset, offset + 2);
      return send(route, { revision, boundary, characters: page, attention: page.filter((person) => person.id === protagonistId).map((person) => ({ characterId: person.id, review: true, conflict: true, reviewCount: 2, conflictCount: 1 })),
        nextCursor: offset + page.length < matches.length ? page.at(-1).id : null, capabilities: { castEditing: enabled, castPresets: presetFixture, ...(observationFixture ? { castObservationDecisions: true } : {}), ...(reviewFixture ? { castReviewDecisions: true, castReviewDecisionReadVersion: 1 } : {}) } });
    }
    if (path === "/api/v1/session") return send(route, { user: { id: worldId, displayName: "Fixture owner", settings: { autoSubmitTurnChoices: true, continuousReading: false, defaultTurnControlStyle: "flexible_action" } }, authentication: "deferred" });
    if (path === "/api/v1/meta") return send(route, { application: { name: "Nexus", version: "test", commit: null, builtAt: null }, capabilities: { castEditing: enabled, systemArchive: false } });
    if (path === "/api/v1/providers") return send(route, { providers: [{ id: versionId, name: "Fixture text", providerType: "openai_compatible", providerRole: "text", enabled: true, isDefault: true }] });
    if (path === "/api/v1/campaigns") return send(route, { campaigns: [campaign] });
    if (path.endsWith("/sync-status")) return send(route, { ...campaign, campaign, world: { id: worldId, title: "Fixture world", versionNumber: 1, genre: "test", tone: "quiet", premise: "Fixture premise", backgroundStory: "", character: "Iven", firstAction: "Look around.", rules: "", playableCharacters: [] }, playerConfig: { selectedCharacterId: null, selectedCharacterName: "", characterSnapshot: null, characterProfile: null, characterProfileRevision: 0, rpgStats: [], trackers: [], eventTriggers: [], useRpgStats: false, suppressEventTriggers: false }, pendingGeneration: liveLock ? { id: candidateId, status: "generating", action: "Look", expectedTurnNumber: 2, createdAt: "2026-09-16T12:00:00.000Z", updatedAt: "2026-09-16T12:00:00.000Z", operationKind: "append", replacementTurnId: null } : null, generationRecovery: null, syncToken: "fixture-1", turnWindowMode: "replace", turns: { campaignId, turns: [turn], nextCursor: null } });
    if (path.endsWith("/turns")) return send(route, { campaignId, turns: [turn], nextCursor: null });
    if (path.endsWith("/state")) return send(route, { campaignId, activeTurnNumber: 1, revision: 1, viewedTurnNumber: 1, isCurrent: true, updatedAt: "2026-09-16T12:00:00.000Z", canonicalFacts: [], openThreads: [], continuitySummary: "", scratchpad: "", rpgStats: [], trackers: [], eventTriggers: [], pendingEventTriggers: [], recordedResolution: null });
    if (path.endsWith("/story-memory")) return send(route, { level: "standard", reviewMode: "observe", availableLevels: ["off", "standard", "enhanced", "max"] });
    if (path.endsWith("/character-profile")) { const input = request.method() === "PUT" ? request.postDataJSON() : null; if (input) { profileWrites.push(input); return send(route, { campaignId, name: input.name, profile: input.profile, revision: 1 }); } return send(route, { campaignId, name: input?.name ?? "Iven", profile: input?.profile ?? {}, revision: input ? 1 : 0,
      characterId: null, storedProfile: null, inheritedFromSnapshot: false, legacyCharacterText: "Iven", rpgStats: [], defaultTriggers: [] }); }
    if (path.endsWith("/memory/metrics")) return send(route, { turns: 1, estimatedCompleteHistoryTokens: 10, memoryCount: 0, embeddedMemories: 0, semanticHealth: { indexedMemories: 0, jobStatus: "idle" } });
    if (path.endsWith("/cost-summary")) return send(route, { hasReportedCosts: false, totals: [] });
    if (path.endsWith("/memory/embedding-config")) return send(route, { enabled: false, retrievalImplementation: "disabled", retrievalShadowEnabled: false, model: null, documentPrefix: null, queryPrefix: null, batchSize: 1 });
    if (path.endsWith("/illustration-config")) return send(route, { enabled: false, sourcePolicy: "off", matchingScope: "world", confidenceProfile: "balanced", repetitionWindow: 5, maxAttempts: 3, segmentWordCount: 500, imagesPerSegment: 1, segmentPromptMode: "direct" });
    if (path.endsWith("/illustrations/segments")) return send(route, { segments: [] });
    if (path.includes("context-preview") && url.searchParams.get("view") === "characters") return send(route, { mode: "estimate", boundary, castRevision: revision, budgetTokens: 500, usedTokens: 25, coverage: { fromTurn: 1, throughTurn: 1, baseTurn: 1, current: true }, selected: [{ characterId: protagonistId, name: "Iven", reason: "pinned" }], omitted: [{ characterId: candidateId, reason: "budget" }], disabledReason: null });
    if (path.includes("context-preview")) return send(route, { selectedCompression: "none", retrieval: { mode: "local" }, budget: { estimatedSelectedTokens: 0, configuredTokens: 32000, truncated: false }, scopes: { chronicle: [] } });
    return send(route, {});
  });
  return { characters, writes, profileWrites, setInvalidSource: () => { sourceInvalid = true; retracted = true; }, advanceRevision: () => { revision++; }, setLock: (value: boolean) => { liveLock = value; }, conflict: () => { conflict = true; }, disable: () => { enabled = false; },
    publishDiscovery: () => {
      revision++; trackingComplete = true; pendingMatch = false;
      let person = characters.find((character) => character.origin.kind === "discovered");
      if (!person) {
        person = { id: "88888888-8888-4888-8888-888888888888", name: "Mara", aliases: ["The Watcher"],
          origin: { kind: "discovered" }, profile: {}, pinned: false, ignored: false, revision: 0,
          firstObservedTurn: 1, lastObservedTurn: 1 };
        characters.push(person);
      }
      person.revision++;
      person.profile = { "appearance.description": "blue eyes", "story.role": "gatekeeper", ...overrides.get(person.id) };
    },
    finishTracking: () => { trackingComplete = true; }, trackingUnavailable: () => { trackingUnavailable = true; } };
}