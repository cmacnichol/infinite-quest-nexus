import { createReviewSource } from "./character-review-source.js";
import type { CastCharacter, CastCandidateList } from "@infinite-quest/contracts";
import { buildReviewQueue, type ReviewItem, type CampaignCastApi } from "@infinite-quest/client-web";
type CandidateForReview = CastCandidateList["candidates"][number];
export function renderCastReview(options: { document: Document; container: HTMLElement; api: Omit<CampaignCastApi, "worldChoices" | "scans" | "sourceTurn" | "fromWorld" | "fromWorldPreview" | "editAuthoredProfile" | "draftPreview" | "lifecycle" | "reviewDecision" | "dismissedReview"> & Partial<Pick<CampaignCastApi, "sourceTurn" | "reviewDecision" | "dismissedReview">>; campaign: string; current(): boolean; editing(): boolean; checkWrite?(): Promise<boolean>; navigate(turn: number): void; back(): void; key(operation: string, value: unknown): string; clearKeys(): void; autoMatch?: boolean | null; initialItem?: string; reviewReadVersion?: 1 | undefined; reviewWrites?: boolean | undefined }) {
  const { document, container, api, campaign } = options;
  const drafts = new Map<string, string>();
  let undo: { candidateId: string; decisionId: string; sourceHash: string; reviewRevision: number; revision: number; boundary: CastCandidateList["boundary"] } | null = null;
  let focusCandidate: string | null = null;
  let view: "pending" | "dismissed" = "pending"; let announcement = ""; let dismissedCursor: string | undefined;
  const skipped = new Set<string>(); let busy = false; let epoch = 0; let prioritizeCharacter: string | null = null; let initialItem = options.initialItem; let cached: { matches: CastCandidateList; details: CastCandidateList; targets: CastCharacter[] } | null = null;
  let disabledControls: { control: HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement; disabled: boolean }[] = [];
  const preventCancel = (event: Event) => event.preventDefault();
  function setBusy(value: boolean) {
    busy = value;
    if (value) {
      disabledControls = [...container.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("button,input,select,textarea")].map(control => ({ control, disabled: control.disabled }));
      for (const { control } of disabledControls) control.disabled = true;
      container.addEventListener("cancel", preventCancel);
    } else {
      for (const { control, disabled } of disabledControls) if (control.isConnected) control.disabled = disabled;
      disabledControls = []; container.removeEventListener("cancel", preventCancel);
    }
  }
  const focus = (element: HTMLElement) => { element.tabIndex = -1; element.focus(); };
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => { const el = document.createElement(tag); el.textContent = text; return el; };
  const button = (text: string, action: () => void, disabled = false) => { const el = node("button", text); el.type = "button"; el.disabled = disabled; el.addEventListener("click", action); return el; };
  const labelField = (field: string) => ({ "identity.pronouns": "Pronouns", "story.role": "Role", "story.background": "Background", "story.personality": "Personality", "story.motivations": "Motivations", "story.goals": "Goals", "story.voiceAndMannerisms": "Voice and mannerisms", "appearance.description": "Appearance", "state.location": "Last known location", "state.condition": "Condition", "state.clothing": "Clothing" } as Record<string, string>)[field] ?? field;
  const itemKey = (item: ReviewItem) => item.kind === "identity" ? `identity:${item.candidate.id}` : `detail:${item.characterId}:${item.field}`;
  async function load(reuse = false) {
    const token = ++epoch; if (!options.current()) return; container.replaceChildren(node("h2", "Character review"), node("p", "Loading review…"));
    try {
      if (view === "dismissed" && options.reviewReadVersion === 1 && api.dismissedReview) {
        const page = await api.dismissedReview(campaign, { limit: 20, ...(dismissedCursor ? { cursor: dismissedCursor } : {}) });
        if (!options.current() || token !== epoch) return;
        container.replaceChildren(node("h2", "Character review"), button("Back to characters", options.back), button("Pending", () => { view = "pending"; void load(); }), node("h3", "Dismissed"), node("p", "Dismissals made with this review workflow are listed here. Earlier dismissals are not available for undo."));
        const heading = container.querySelector<HTMLElement>("h2"); if (heading) { heading.tabIndex = -1; heading.focus(); }
        const status = node("p", announcement); status.setAttribute("role", "status"); container.append(status); announcement = "";
        if (!page.decisions.length) container.append(node("p", "No dismissals on this page."));
        for (const decision of page.decisions) {
          const row = node("section"); const target = decision.target;
          row.append(node("h4", target.kind === "identity" ? `Discovery: ${target.proposal.name}` : `Detail: ${labelField(target.observation.field)} — ${target.observation.value}`), node("p", `Source turn ${decision.source.turnNumber}`), node("blockquote", target.kind === "identity" ? target.proposal.identityEvidence[0]?.quote ?? "" : target.observation.quote));
          row.append(button("Undo", () => { void (async () => {
            if (busy || !options.editing() || !options.reviewWrites || !api.reviewDecision) return;
            setBusy(true); status.textContent = "Restoring…";
            try {
              if (options.checkWrite && !await options.checkWrite()) { status.textContent = "Finish or resolve generation before changing review."; return; }
              if (!options.current() || token !== epoch || !options.editing()) return;
              const request = { action: "restore" as const, decisionId: decision.decisionId, sourceHash: decision.source.sourceHash, expectedReviewRevision: page.reviewRevision, expectedCastRevision: page.revision, expectedBoundary: page.boundary, idempotencyKey: options.key("review", [campaign, decision.decisionId, page.reviewRevision, page.revision, page.boundary]) };
              await api.reviewDecision(campaign, decision.candidateId, request); if (!options.current() || token !== epoch) return;
              options.clearKeys(); undo = null; announcement = "Dismissal undone."; focusCandidate = decision.candidateId; view = "pending"; dismissedCursor = undefined; cached = null; await load();
            } catch (error) { status.replaceChildren(node("span", (error as { statusCode?: number }).statusCode === 409 ? "The source or review changed. Reload before deciding." : "Could not restore this dismissal."), button("Reload review", () => { void load(); })); }
            finally { setBusy(false); }
          })(); }, !decision.canRestore || !options.reviewWrites || !options.editing())); container.append(row);
        }
        if (dismissedCursor) container.append(button("First page", () => { dismissedCursor = undefined; void load(); }));
        if (page.nextCursor) container.append(button("Next page", () => { dismissedCursor = page.nextCursor ?? undefined; void load(); }));
        return;
      }
      async function pages(view: "matches" | "details" | "review") {
        const first = await api.candidates(campaign, { view, limit: 50 } as Parameters<typeof api.candidates>[1]); let cursor = first.nextCursor;
        while (cursor) { const page = await api.candidates(campaign, { view, limit: 50, cursor } as Parameters<typeof api.candidates>[1]); if (page.revision !== first.revision || JSON.stringify(page.boundary) !== JSON.stringify(first.boundary)) throw new Error("The story or cast changed. Reload review."); first.candidates.push(...page.candidates); cursor = page.nextCursor; }
        return first;
      }
      let matches: CastCandidateList, details: CastCandidateList, targets: CastCharacter[];
      if (reuse && cached) ({ matches, details, targets } = cached);
      else {
        try { const combined = await pages("review"); matches = { ...combined, candidates: combined.candidates.filter(candidate => !candidate.resolvedCharacterId) }; details = { ...combined, candidates: combined.candidates.filter(candidate => candidate.resolvedCharacterId) }; }
        catch (error) { if ((error as { statusCode?: number }).statusCode !== 400) throw error; matches = await pages("matches"); details = await pages("details"); }
        if (matches.revision !== details.revision || JSON.stringify(matches.boundary) !== JSON.stringify(details.boundary)) throw new Error("The story or cast changed. Reload review.");
        targets = []; let cursor: string | undefined;
        if (matches.candidates.length || details.candidates.length) do {
          if (!options.current() || token !== epoch) return;
          const page = await api.list(campaign, { limit: 50, expectedRevision: matches.revision, ...(cursor ? { cursor } : {}) });
          if (page.revision !== matches.revision || JSON.stringify(page.boundary) !== JSON.stringify(matches.boundary)) throw new Error("The story or cast changed. Reload review.");
          targets.push(...page.characters); cursor = page.nextCursor ?? undefined;
        } while (cursor);
        cached = { matches, details, targets };
      }
      if (!options.current() || token !== epoch) return;
      const queue = buildReviewQueue(matches.candidates, details.candidates).filter(item => !skipped.has(itemKey(item)));
      if (focusCandidate) {
        const index = queue.findIndex(item => item.kind === "identity" ? item.candidate.id === focusCandidate : item.entries.some(entry => entry.candidate.id === focusCandidate));
        if (index > 0) queue.unshift(...queue.splice(index, 1));
        focusCandidate = null;
      }
      if (initialItem) {
        const index = queue.findIndex(item => initialItem === itemKey(item) || item.kind === "detail" && initialItem!.startsWith(`${itemKey(item)}:`));
        if (index >= 0) {
          const item = queue[index]!;
          if (item.kind === "detail") {
            const candidateId = initialItem.slice(itemKey(item).length + 1);
            const entryIndex = item.entries.findIndex(entry => entry.candidate.id === candidateId);
            if (entryIndex > 0) item.entries.unshift(...item.entries.splice(entryIndex, 1));
          }
          if (index > 0) queue.unshift(...queue.splice(index, 1));
        }
        initialItem = undefined;
      }
      if (prioritizeCharacter) queue.sort((a, b) => Number(b.kind === "detail" && b.characterId === prioritizeCharacter) - Number(a.kind === "detail" && a.characterId === prioritizeCharacter));
      container.replaceChildren(node("h2", "Character review"), button("Back to characters", options.back));
      if (options.reviewReadVersion === 1 && api.dismissedReview) container.append(button("Pending", () => {} , true), button("Dismissed", () => { view = "dismissed"; dismissedCursor = undefined; void load(); }));
      if (announcement) { const notice = node("p", announcement); notice.setAttribute("role", "status"); container.append(notice); announcement = ""; }
      if (undo && api.reviewDecision) {
        const receipt = undo;
        const undoButton = button("Undo", () => { void (async () => {
          if (busy || !options.reviewWrites || !options.editing() || !api.reviewDecision) return;
          setBusy(true);
          try {
            if (options.checkWrite && !await options.checkWrite()) return;
            if (!options.current() || token !== epoch || !options.editing()) return;
            await api.reviewDecision(campaign, receipt.candidateId, { action: "restore", decisionId: receipt.decisionId, sourceHash: receipt.sourceHash, expectedReviewRevision: receipt.reviewRevision, expectedCastRevision: receipt.revision, expectedBoundary: receipt.boundary, idempotencyKey: options.key("review-undo", [campaign, receipt]) });
            if (!options.current() || token !== epoch) return; undo = null; focusCandidate = receipt.candidateId; cached = null; options.clearKeys(); announcement = "Dismissal undone."; await load();
          } catch (error) {
            if (options.current() && token === epoch) {
              const stale = (error as { statusCode?: number }).statusCode === 409;
              const notice = node("p", stale ? "The source or review changed. Reload before deciding." : "Could not confirm the undo. Retry it or reload the review."); notice.setAttribute("role", "status");
              if (stale) { undoButton.disabled = true; disabledControls = disabledControls.filter(item => item.control !== undoButton); notice.append(button("Reload review", () => { undo = null; cached = null; void load(); })); }
              container.append(notice);
            }
          } finally { setBusy(false); }
        })(); }, !options.reviewWrites || !options.editing()); container.append(undoButton);
      }
      if (!queue.length) { const empty = node("h3", skipped.size ? "Review complete for this pass." : "Nothing needs review."); container.append(empty); focus(empty); return; }
      if (options.autoMatch != null) container.append(node("p", options.autoMatch ? "Unique-name matching is on; ambiguous names still need review." : "Automatic name matching is off; exact matches are suggested here."));
      const item = queue[0]!; container.append(node("p", `${queue.length} ${queue.length === 1 ? "item" : "items"} remaining in this pass.`));
      const section = node("section"), feedback = node("p"); feedback.setAttribute("role", "status");
      const current = () => token === epoch && options.current();
      const locked = () => busy || !current() || !options.editing();
      async function canSubmit() {
        if (options.checkWrite && !await options.checkWrite()) {
          if (current()) feedback.textContent = "Finish or resolve generation before changing this match.";
          return false;
        }
        return current() && options.editing();
      }
      function failed(error: unknown) {
        if (!current()) return;
        const stale = (error as { statusCode?: number })?.statusCode === 409;
        feedback.replaceChildren(node("span", stale ? "The story or cast changed. Reload before deciding." : "Could not confirm this decision. Retry it or reload the review."), button("Reload review", () => { void load(); }));
      }
      async function dismiss(candidate: CandidateForReview, action: "dismiss_identity" | "dismiss_detail", observationIndex?: number) {
        if (locked() || !options.reviewWrites || !api.reviewDecision || candidate.reviewRevision === undefined || !candidate.source.sourceHash) return;
        setBusy(true); feedback.textContent = "Saving…";
        try {
          if (!await canSubmit()) return;
          const target = action === "dismiss_detail" ? { action, observationIndex: observationIndex! } as const : { action } as const;
          const receipt = await api.reviewDecision(campaign, candidate.id, { ...target, sourceHash: candidate.source.sourceHash, expectedReviewRevision: candidate.reviewRevision, expectedCastRevision: matches.revision, expectedBoundary: matches.boundary, idempotencyKey: options.key("review", [campaign, candidate.id, target, candidate.reviewRevision, matches.revision, matches.boundary]) });
          if (!current()) return; undo = { candidateId: candidate.id, decisionId: receipt.decisionId, sourceHash: candidate.source.sourceHash!, reviewRevision: receipt.reviewRevision, revision: receipt.revision, boundary: receipt.boundary }; options.clearKeys(); announcement = "Dismissed."; cached = null; await load();
        } catch (error) { failed(error); } finally { setBusy(false); }
      }
      const skip = () => { if (busy) return; skipped.add(itemKey(item)); void load(true); };
      if (item.kind === "identity") {
        const candidate = item.candidate; section.append(node("h3", `Identity: ${candidate.proposal.name}`), createReviewSource(document, campaign, candidate.source, candidate.proposal.identityEvidence[0]?.quote ?? "", api.sourceTurn, options.current, options.navigate));
        for (const evidence of candidate.proposal.identityEvidence) section.append(node("blockquote", evidence.quote));
        const reviewDetails = candidate.reviewDetails ?? candidate.proposal.observations.map((observation, observationIndex) => ({ observation, observationIndex }));
        for (const { observation: detail, observationIndex } of reviewDetails) {
          const row = node("section"); row.append(node("p", `Proposed ${labelField(detail.field)}: ${detail.value}`), node("blockquote", detail.quote));
          if (options.reviewReadVersion === 1 && api.reviewDecision && candidate.reviewRevision !== undefined && candidate.source.sourceHash) row.append(button("Dismiss detail", () => { void dismiss(candidate, "dismiss_detail", observationIndex); }, !options.reviewWrites || !options.editing()));
          section.append(row);
        }
        if (options.reviewReadVersion === 1 && api.reviewDecision && candidate.reviewRevision !== undefined && candidate.source.sourceHash) section.append(node("p", "Dismiss this discovery and its proposed details for this source. New evidence may appear again."), button("Dismiss discovery", () => { void dismiss(candidate, "dismiss_identity"); }, !options.reviewWrites || !options.editing()));
        const select = node("select"); select.setAttribute("aria-label", "Existing character"); const blank = node("option", "Choose a character"); blank.value = ""; select.append(blank);
        const normalize = (s: string) => s.trim().toLocaleLowerCase(); const name = normalize(candidate.proposal.name);
        const exact = targets.filter(person => !person.ignored && [person.name, ...person.aliases].some(value => normalize(value) === name));
        // The visible roster excludes ignored characters, so it cannot establish uniqueness.
        const suggested = targets.find(person => person.id === candidate.suggestedCharacterId && !person.ignored);
        const exactIds = new Set(exact.map(person => person.id));
        const sorted = [...targets].sort((a, b) => Number(b === suggested) - Number(a === suggested)
          || Number(exactIds.has(b.id)) - Number(exactIds.has(a.id)) || a.name.localeCompare(b.name));
        const displayName = (person: CastCharacter) => `${person.name}${person.aliases.length ? ` (${person.aliases.join(", ")})` : ""}${person.profile["story.role"] ? ` · ${person.profile["story.role"]}` : ""} · last observed turn ${person.lastObservedTurn}`;
        const labelCounts = new Map<string, number>();
        for (const person of sorted) { const label = displayName(person); labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1); }
        const searchLabel = node("label", "Find existing character"), search = node("input"), preview = node("section"); search.type = "search"; searchLabel.append(search);
        const attach = button("Attach to selected character", () => { void decide("attach"); }, true);
        function showPreview() {
          const person = targets.find(target => target.id === select.value); attach.disabled = !person || !options.editing(); preview.replaceChildren();
          if (!person) return; preview.append(node("h4", person.name), node("p", `Last observed turn ${person.lastObservedTurn}`));
          for (const [field, value] of Object.entries(person.profile)) if (value) preview.append(node("p", `${labelField(field)}: ${value}`));
        }
        function populate() {
          const chosen = select.value, term = normalize(search.value); select.replaceChildren(blank);
          for (const person of sorted.filter(person => !term || [person.name, ...person.aliases].some(value => normalize(value).includes(term)))) {
            const base = displayName(person);
            const option = node("option", `${base}${labelCounts.get(base)! > 1 ? ` · ${person.id}` : ""}${person === suggested ? " · exact name or alias" : ""}`); option.value = person.id; select.append(option);
          }
          select.value = chosen; showPreview();
        }
        search.addEventListener("input", populate); select.addEventListener("change", showPreview); section.append(searchLabel, select, preview); populate();
        if (suggested) { select.value = suggested.id; showPreview(); }
        async function decide(action: "attach" | "create") {
          if (locked() || action === "attach" && !select.value) return;
          setBusy(true); feedback.textContent = "Saving…";
          try {
            const decision = action === "attach" ? { action, characterId: select.value } as const : { action } as const;
            if (!await canSubmit()) return;
            const saved = await api.resolveCandidate(campaign, candidate.id, { ...decision, expectedCastRevision: matches.revision,
              expectedBoundary: matches.boundary, ...(candidate.reviewRevision !== undefined ? { expectedReviewRevision: candidate.reviewRevision } : {}), idempotencyKey: options.key("match", [campaign, candidate.id, decision, candidate.reviewRevision, matches.revision, matches.boundary]) });
            if (!current()) return;
            prioritizeCharacter = saved.character.id; options.clearKeys(); await load();
          } catch (error) { failed(error); } finally { setBusy(false); }
        }
        section.append(attach, button("Create separate character", () => { void decide("create"); }, !options.editing()));
      } else {
        const characterId = item.characterId; const person = targets.find(target => target.id === characterId); section.append(node("h3", `${person?.name ?? item.entries[0]!.candidate.proposal.name} · ${labelField(item.field)}`), node("p", `Current: ${person?.profile[item.field as keyof typeof person.profile] || "Unknown"}`));
        const proposedValues = new Set(item.entries.map(entry => entry.detail.value));
        const currentValue = person?.profile[item.field as keyof typeof person.profile];
        if (currentValue) proposedValues.add(currentValue);
        if (proposedValues.size > 1) section.append(node("p", item.field.startsWith("state.") || item.field === "story.goals"
          ? "Later observations can update this field. Compare the turn dates before deciding."
          : "These sources suggest different values for a stable detail. Conflicting observations stay unresolved unless you set an override."));
        for (const { candidate, detail } of item.entries) {
          const row = node("section"); row.append(node("p", `Proposed: ${detail.value}`), node("blockquote", detail.quote), createReviewSource(document, campaign, candidate.source, detail.quote, api.sourceTurn, options.current, options.navigate));
          const draftKey = JSON.stringify([candidate.id, detail.observationIndex, detail.sourceHash]);
          const disclosure = node("details"), summary = node("summary", "Set an override");
          const label = node("label", "Override value"), value = node("textarea");
          value.maxLength = 2000; value.value = drafts.get(draftKey) ?? detail.value;
          value.addEventListener("input", () => { drafts.set(draftKey, value.value); });
          disclosure.open = drafts.has(draftKey);
          label.append(value); disclosure.append(summary, node("p", "An override takes precedence until you clear it in the character editor."), label);
          const protagonist = person?.origin?.kind === "protagonist";
          const permits = (action: "accept" | "confirm" | "dismiss") => detail.allowedActions ? detail.allowedActions.includes(action) : action === "dismiss" || !protagonist && (action !== "accept" || detail.canAcceptObservation === true);
          if (detail.acceptDisabledReason === "retracted_source") row.append(node("p", "This source was retracted and cannot be accepted again as a fact. You can explicitly set an override instead."));
          else if (detail.acceptDisabledReason === "source_not_eligible") row.append(node("p", "This source is no longer eligible to be accepted as a fact."));
          if (permits("confirm")) row.append(disclosure);
          else if (protagonist) row.append(node("p", "Use the main character profile to change this field, or dismiss the suggestion."));
          else if (!permits("accept")) row.append(node("p", "This field belongs to the authored character profile."));
          let pending: { signature: string; request: Parameters<typeof api.resolveDetail>[2] } | null = null;
          async function decide(action: "accept" | "confirm" | "dismiss") {
            if (locked() || !permits(action)) return;
            setBusy(true); feedback.textContent = "Saving…";
            try {
              if (!await canSubmit()) return;
              const signature = JSON.stringify([action, action === "confirm" ? value.value : null]);
              if (!pending || pending.signature !== signature) {
                const revision = person?.revision ?? (await api.detail(campaign, characterId)).character.revision;
                if (!current() || !options.editing()) return;
                const decision = action === "confirm" ? { action, confirmedValue: value.value } as const : { action } as const;
                const request = { ...decision, expectedCastRevision: matches.revision, expectedBoundary: matches.boundary,
                  expectedCharacterRevision: revision, ...(candidate.reviewRevision !== undefined ? { expectedReviewRevision: candidate.reviewRevision } : {}), observationIndex: detail.observationIndex, sourceHash: detail.sourceHash,
                  idempotencyKey: options.key("detail", [campaign, candidate.id, detail.observationIndex, detail.sourceHash, decision, candidate.reviewRevision, matches.revision, matches.boundary, revision]) };
                pending = { signature, request };
              }
              await api.resolveDetail(campaign, candidate.id, pending.request);
              if (!current()) return;
              drafts.delete(draftKey); pending = null; options.clearKeys(); await load();
            } catch (error) { failed(error); } finally { setBusy(false); }
          }
          if (permits("accept")) row.append(
            node("p", `Apply records this observation at turn ${candidate.source.turnNumber}; it does not lock the field.`),
            button("Apply and next", () => { void decide("accept"); }, !options.editing()));
          else if (permits("confirm")) row.append(node("p", "This suggestion cannot be saved as an observed fact. Set an override only if you want to choose the value yourself."));
          if (permits("confirm")) disclosure.append(button("Keep as override", () => { void decide("confirm"); }, !options.editing()));
          if (permits("dismiss")) row.append(button("Dismiss detail", () => { if (options.reviewReadVersion === 1 && candidate.source.sourceHash && candidate.reviewRevision !== undefined && api.reviewDecision) void dismiss(candidate, "dismiss_detail", detail.observationIndex); else void decide("dismiss"); }, !options.editing() || (options.reviewReadVersion === 1 && !options.reviewWrites))); section.append(row);
        }
      }
      section.append(node("p", "Skip for now leaves this item pending for a later review."), button("Skip for now", skip), feedback); container.append(section); const cardHeading = section.querySelector<HTMLElement>("h3"); if (cardHeading) focus(cardHeading);
    } catch (error) { if (!options.current() || token !== epoch) return; container.replaceChildren(node("h2", "Character review"), node("p", error instanceof Error ? error.message : "Could not load review."), button("Retry", () => { void load(); }), button("Back to characters", options.back)); }
  }
  void load();
}
