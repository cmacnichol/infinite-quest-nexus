import {
  MAX_SOURCE_DOCUMENT_BYTES,
  MAX_SOURCE_DOCUMENT_CODE_POINTS,
  type SourceAuthoringView,
  type SourceAuthoringInput,
  type SourceFact,
  type SourceFactReview
} from "../../../packages/contracts/src/source-authoring.js";
import { normalizeSourceText, sourceParagraphMap } from "../../../packages/contracts/src/source-normalization.js";
import type { AuthoringJobView } from "../../../packages/contracts/src/authoring.js";
import type { AuthoringJobsApi } from "./authoring-jobs-api.js";
import { createSourceAuthoringApi, SourceAuthoringApiError, type SourceAuthoringApi } from "./source-authoring-api.js";

export interface SourceAuthoringPanelDependencies {
  api?: SourceAuthoringApi;
  authoringJobs?: Pick<AuthoringJobsApi, "loadAuthoringJob" | "retryAuthoringStage">;
  /** Hands durable command results to the page's single AuthoringJobSession. */
  onJobAvailable?: (job: AuthoringJobView) => void;
}

export interface SourceAuthoringPanel {
  dispose(): void;
  resume(job: AuthoringJobView): void;
}

type ManualDraft = Record<"kind" | "subject" | "predicate" | "value", string>;
type ReviewConflict = { message: string; server: AuthoringJobView | null };
type IntakePreview = { normalized: string; characters: string[]; paragraphs: SourceAuthoringView["source"]["paragraphs"]; bytes: number; codePoints: number };

function text(document: Document, value: string, tag = "p"): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}

function rawBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function factLabel(fact: SourceFact): string {
  return `${fact.subject} — ${fact.predicate}: ${fact.value}`;
}

function currentStages(job: AuthoringJobView) {
  return job.stages.filter((stage) => !job.stages.some((other) => other.key === stage.key && other.generation > stage.generation));
}

function safeCommandMessage(error: unknown, fallback: string): string {
  return error instanceof Error && ["AuthoringJobsApiError", "SourceAuthoringApiError"].includes(error.name) ? error.message : fallback;
}

/** Focused browser-only source intake/review UI. Story text is always rendered as textContent. */
export function mountSourceAuthoringPanel(host: HTMLElement, dependencies: SourceAuthoringPanelDependencies = {}): SourceAuthoringPanel {
  const document = host.ownerDocument;
  const api = dependencies.api ?? createSourceAuthoringApi();
  const authoringJobs = dependencies.authoringJobs;
  let rawText = "";
  let name = "Pasted story";
  let mode: "faithful" | "expand" = "faithful";
  let boundary = "";
  let current: AuthoringJobView | null = null;
  let disposed = false;
  let localReview: SourceFactReview | null = null;
  let reviewSaved = false;
  let localDirty = false;
  let editGeneration = 0;
  let intakeGeneration = 0;
  let pendingSubmission: SourceAuthoringInput | null = null;
  let pendingSubmissionGeneration = -1;
  let newerIntakeAvailable = false;
  let ignoredResumeJobId: string | null = null;
  let commandController: AbortController | null = null;
  let commandGeneration = 0;
  let commandStatus = "";
  let reviewConflict: ReviewConflict | null = null;
  const openCitations = new Set<string>();
  const manualDraft: ManualDraft = { kind: "character", subject: "", predicate: "", value: "" };

  function preview(): IntakePreview {
    if (!rawText) return { normalized: "", characters: [], paragraphs: [], bytes: 0, codePoints: 0 };
    const normalized = normalizeSourceText(rawText);
    return { normalized, characters: Array.from(normalized), paragraphs: sourceParagraphMap(normalized), bytes: rawBytes(rawText), codePoints: Array.from(rawText).length };
  }

  function fillBoundaryOptions(select: HTMLSelectElement, shown: IntakePreview): void {
    select.replaceChildren();
    for (const paragraph of shown.paragraphs) {
      const option = document.createElement("option");
      option.value = paragraph.id;
      option.selected = boundary === paragraph.id;
      option.textContent = `${paragraph.id}: ${shown.characters.slice(paragraph.start, paragraph.end).join("").slice(0, 80)}`;
      select.append(option);
    }
  }

  function markIntakeChanged(): void {
    intakeGeneration += 1;
  }

  function refreshIntakePreview(): void {
    const size = host.querySelector<HTMLElement>("[data-source-size]");
    const select = host.querySelector<HTMLSelectElement>("[data-source-boundary]");
    const submit = host.querySelector<HTMLButtonElement>("[data-action='submit-source']");
    try {
      const shown = preview();
      if (!boundary || !shown.paragraphs.some((paragraph) => paragraph.id === boundary)) boundary = shown.paragraphs.at(-1)?.id ?? "";
      if (size) size.textContent = `${name} · ${shown.bytes} bytes · ${shown.codePoints} code points`;
      if (select) fillBoundaryOptions(select, shown);
      if (submit) submit.disabled = commandController !== null || (!pendingSubmission && (!rawText.trim() || shown.bytes > MAX_SOURCE_DOCUMENT_BYTES || shown.codePoints > MAX_SOURCE_DOCUMENT_CODE_POINTS || !boundary));
    } catch {
      if (submit) submit.disabled = commandController !== null || !pendingSubmission;
    }
  }

  function reviewFrom(view: SourceAuthoringView, revision: number): SourceFactReview {
    // Polls cannot advance a dirty expected revision. The author explicitly
    // reconciles after inspecting the server review.
    return localReview && localDirty ? localReview : {
      expectedRevision: revision,
      acceptedFactIds: [...view.acceptedFactIds],
      rejectedFactIds: [...view.rejectedFactIds],
      uncertainFactIds: [...view.uncertainFactIds],
      selectedCharacterFactIds: [...view.selectedCharacterFactIds],
      characterIdentityGroups: structuredClone(view.characterIdentityGroups),
      manualFacts: []
    };
  }

  function visibleFacts(view: SourceAuthoringView): SourceFact[] {
    // Expansion candidates are a filtered view of the server fact set. Keep
    // the canonical fact first so every fact owns one disposition, citation,
    // identity, and roster control even when the API includes it in both.
    const seen = new Set<string>();
    return [...view.facts, ...view.expansionCandidates, ...(localReview?.manualFacts ?? [])]
      .filter((fact) => {
        if (seen.has(fact.id)) return false;
        seen.add(fact.id);
        return true;
      });
  }

  function markDirty(review: SourceFactReview): void {
    localReview = review;
    reviewSaved = false;
    localDirty = true;
    editGeneration += 1;
    commandStatus = "Local review decisions have not been saved.";
  }

  function extractionStatusText(view: SourceAuthoringView): string {
    if (view.extractionComplete) return "Extraction complete. Inspect each exact passage before accepting it.";
    switch (current?.status) {
      case "queued": return "Extraction is queued; synthesis remains unavailable.";
      case "running": return "Extraction is running; synthesis remains unavailable.";
      case "recoverable": return "Extraction needs retry before synthesis can begin.";
      case "failed": return "This source proposal failed. Start a new proposal.";
      case "cancel_requested": return "This source proposal is stopping.";
      case "cancelled": return "This source proposal was cancelled.";
      case "expired": return "This source proposal has expired.";
      default: return "Extraction is not complete; synthesis remains unavailable.";
    }
  }

  function reviewIssue(view: SourceAuthoringView): string | null {
    if (!localReview) return "Review decisions are unavailable.";
    const acceptedCharacters = visibleFacts(view)
      .filter((fact) => fact.kind === "character" && localReview!.acceptedFactIds.includes(fact.id))
      .map((fact) => fact.id);
    const acceptedSet = new Set(acceptedCharacters);
    const members = localReview.characterIdentityGroups.flatMap((group) => group.factIds);
    if (new Set(members).size !== members.length || acceptedCharacters.some((id) => members.filter((member) => member === id).length !== 1) || members.some((id) => !acceptedSet.has(id))) {
      return "Place every accepted character fact in exactly one explicit identity group.";
    }
    if (localReview.characterIdentityGroups.some((group) => !group.factIds.includes(group.representativeFactId) || !localReview!.acceptedFactIds.includes(group.representativeFactId))) {
      return "Choose a current accepted member as each identity representative.";
    }
    if (localReview.selectedCharacterFactIds.some((id) => !localReview!.characterIdentityGroups.some((group) => group.representativeFactId === id))) {
      return "Playable characters must be identity representatives.";
    }
    return null;
  }

  function removeIdentityFact(factId: string): { groups: SourceFactReview["characterIdentityGroups"]; selected: string[]; selectedEmptyGroup: boolean } {
    const groups = localReview!.characterIdentityGroups.map((group) => ({ ...group, factIds: [...group.factIds] }));
    const mine = groups.find((group) => group.factIds.includes(factId));
    const selected = new Set(localReview!.selectedCharacterFactIds);
    if (!mine) return { groups, selected: [...selected], selectedEmptyGroup: false };
    const selectedMine = selected.delete(mine.representativeFactId);
    mine.factIds = mine.factIds.filter((id) => id !== factId);
    if (!mine.factIds.length) groups.splice(groups.indexOf(mine), 1);
    else {
      if (mine.representativeFactId === factId) mine.representativeFactId = mine.factIds[0]!;
      if (selectedMine) selected.add(mine.representativeFactId);
    }
    return { groups, selected: [...selected], selectedEmptyGroup: selectedMine && !mine.factIds.length };
  }

  function moveIdentityFact(factId: string, targetRepresentative: string | null): void {
    if (!localReview) return;
    const mine = localReview.characterIdentityGroups.find((group) => group.factIds.includes(factId));
    if (!mine || targetRepresentative === mine.representativeFactId || (!targetRepresentative && mine.factIds.length === 1)) return;
    if (targetRepresentative && !localReview.characterIdentityGroups.some((group) => group.representativeFactId === targetRepresentative)) return;
    const removed = removeIdentityFact(factId);
    if (targetRepresentative) {
      const target = removed.groups.find((group) => group.representativeFactId === targetRepresentative);
      if (!target) return;
      target.factIds.push(factId);
      if (removed.selectedEmptyGroup && !removed.selected.includes(target.representativeFactId)) removed.selected.push(target.representativeFactId);
    } else {
      removed.groups.push({ representativeFactId: factId, factIds: [factId] });
    }
    markDirty({ ...localReview, characterIdentityGroups: removed.groups, selectedCharacterFactIds: removed.selected });
  }

  function renderEvidence(fact: SourceFact, view: SourceAuthoringView): HTMLElement {
    const article = document.createElement("article");
    article.className = "source-fact";
    article.dataset.sourceFactId = fact.id;
    article.setAttribute("aria-label", `${fact.provenance}: ${factLabel(fact)}`);
    if (!fact.citations.length) {
      article.append(text(document, "No source passage (manual or invented candidate)."));
      return article;
    }
    for (const [index, citation] of fact.citations.entries()) {
      const paragraph = view.source.paragraphs.find((item) => item.id === citation.paragraphId);
      const quote = Array.from(view.source.text).slice(citation.start, citation.end).join("");
      const reveal = document.createElement("button");
      reveal.type = "button";
      reveal.textContent = `Show ${citation.paragraphId}`;
      const key = `${fact.id}:${index}`;
      const passage = text(document, `${citation.paragraphId}${paragraph ? ` (${paragraph.start}–${paragraph.end})` : ""}: ${quote}`);
      passage.hidden = !openCitations.has(key);
      reveal.addEventListener("click", () => {
        passage.hidden = !passage.hidden;
        if (passage.hidden) openCitations.delete(key); else openCitations.add(key);
      });
      article.append(reveal, passage);
    }
    return article;
  }

  function disposition(review: Pick<SourceFactReview, "acceptedFactIds" | "rejectedFactIds" | "uncertainFactIds">, factId: string): "accepted" | "rejected" | "uncertain" | "not present" {
    if (review.acceptedFactIds.includes(factId)) return "accepted";
    if (review.rejectedFactIds.includes(factId)) return "rejected";
    if (review.uncertainFactIds.includes(factId)) return "uncertain";
    return "not present";
  }

  function identitySummary(prefix: "Local" | "Server", groups: SourceFactReview["characterIdentityGroups"], facts: Map<string, SourceFact>): string[] {
    if (!groups.length) return [`${prefix} identities: none`];
    return groups.map((group) => {
      const representative = facts.get(group.representativeFactId);
      const members = group.factIds.map((id) => facts.get(id)).filter((fact): fact is SourceFact => !!fact);
      return `${prefix} representative ${representative ? factLabel(representative) : group.representativeFactId} · members: ${members.map(factLabel).join("; ") || "none"}`;
    });
  }

  function rosterSummary(prefix: "Local" | "Server", ids: string[], facts: Map<string, SourceFact>): string {
    const labels = ids.map((id) => facts.get(id)).filter((fact): fact is SourceFact => !!fact).map(factLabel);
    return `${prefix} roster: ${labels.join("; ") || "none"}`;
  }

  function renderReviewComparison(server: Extract<AuthoringJobView, { kind: "story_source" }>): HTMLElement {
    const comparison = document.createElement("div");
    comparison.dataset.sourceReviewComparison = "";
    if (!localReview || current?.kind !== "story_source" || !current.source || !server.source) return comparison;
    comparison.append(
      text(document, `Your review uses revision ${localReview.expectedRevision}.`),
      text(document, `Server revision ${server.revision}.`)
    );
    const localFacts = new Map(visibleFacts(current.source).map((fact) => [fact.id, fact]));
    const serverFacts = new Map([...server.source.facts, ...server.source.expansionCandidates].map((fact) => [fact.id, fact]));
    const serverReview = {
      acceptedFactIds: server.source.acceptedFactIds,
      rejectedFactIds: server.source.rejectedFactIds,
      uncertainFactIds: server.source.uncertainFactIds
    };
    const allIds = new Set([...localFacts.keys(), ...serverFacts.keys()]);
    for (const factId of allIds) {
      const localDecision = disposition(localReview, factId);
      const serverDecision = disposition(serverReview, factId);
      if (localDecision === serverDecision) continue;
      const fact = localFacts.get(factId) ?? serverFacts.get(factId);
      if (!fact) continue;
      const difference = document.createElement("section");
      difference.dataset.sourceReviewDifference = factId;
      difference.append(text(document, `${factLabel(fact)} · Local: ${localDecision} · Server: ${serverDecision}`));
      difference.append(renderEvidence(fact, serverFacts.has(factId) ? server.source : current.source));
      comparison.append(difference);
    }
    const localManual = localReview.manualFacts.map(factLabel);
    const serverManual = [...serverFacts.values()].filter((fact) => fact.provenance === "manual").map(factLabel);
    comparison.append(
      text(document, `Local manual additions: ${localManual.join("; ") || "none"}`),
      text(document, `Server manual facts: ${serverManual.join("; ") || "none"}`),
      ...identitySummary("Local", localReview.characterIdentityGroups, localFacts).map((summary) => text(document, summary)),
      ...identitySummary("Server", server.source.characterIdentityGroups, serverFacts).map((summary) => text(document, summary)),
      text(document, rosterSummary("Local", localReview.selectedCharacterFactIds, localFacts)),
      text(document, rosterSummary("Server", server.source.selectedCharacterFactIds, serverFacts))
    );
    return comparison;
  }

  function renderConflict(): void {
    if (!reviewConflict) return;
    const conflict = document.createElement("section");
    conflict.dataset.sourceReviewConflict = "";
    conflict.append(text(document, reviewConflict.message));
    const compare = document.createElement("button");
    compare.type = "button";
    compare.dataset.action = "compare-source-review";
    compare.textContent = "Compare server review";
    compare.disabled = !authoringJobs || commandController !== null;
    compare.addEventListener("click", () => { void compareServerReview(); });
    conflict.append(compare);
    if (reviewConflict.server?.kind === "story_source" && reviewConflict.server.source && localReview) {
      const server = reviewConflict.server;
      const comparison = renderReviewComparison(server);
      const reconcile = document.createElement("button");
      reconcile.type = "button";
      reconcile.dataset.action = "reconcile-source-review";
      reconcile.textContent = `Keep local decisions on revision ${server.revision}`;
      reconcile.addEventListener("click", () => {
        if (!reviewConflict?.server || !localReview) return;
        current = reviewConflict.server;
        localReview = { ...localReview, expectedRevision: current.revision };
        reviewConflict = null;
        commandStatus = "Local decisions reconciled with the inspected server revision. Save to confirm them.";
        render();
      });
      const reload = document.createElement("button");
      reload.type = "button";
      reload.dataset.action = "reload-source-review";
      reload.textContent = "Use server decisions";
      reload.addEventListener("click", () => {
        if (!reviewConflict?.server) return;
        current = reviewConflict.server;
        localReview = null;
        localDirty = false;
        reviewSaved = currentStages(current).some((stage) => stage.key === "source:synthesis");
        reviewConflict = null;
        commandStatus = "Server review loaded.";
        render();
      });
      comparison.append(reconcile, reload);
      conflict.append(comparison);
    }
    host.append(conflict);
  }

  async function compareServerReview(): Promise<void> {
    if (!current || !authoringJobs || disposed || commandController) return;
    const expectedId = current.id;
    const command = beginCommand();
    if (!command) return;
    render();
    try {
      const server = await authoringJobs.loadAuthoringJob(expectedId, command.controller.signal);
      if (!commandCurrent(command, expectedId) || server.id !== expectedId) return;
      reviewConflict = { message: "Compare the two reviews before choosing which decisions to keep.", server };
      dependencies.onJobAvailable?.(server);
    } catch (error) {
      if (commandCurrent(command, expectedId)) commandStatus = safeCommandMessage(error, "The server review could not be loaded. Try again.");
    } finally {
      finishCommand(command);
    }
  }

  function renderReview(view: SourceAuthoringView): void {
    localReview = reviewFrom(view, current!.revision);
    host.append(text(document, `${view.source.name} · ${rawBytes(view.source.text)} bytes · ${Array.from(view.source.text).length} code points · ${view.mode} · included through ${view.boundaryParagraphId}.`));
    host.append(text(document, extractionStatusText(view)));
    const stages = currentStages(current!);
    const chunks = stages.filter((stage) => stage.key.startsWith("source:chunk:"));
    const progress = text(document, `${chunks.filter((stage) => stage.status === "validated").length} of ${chunks.length} extraction chunks complete.`);
    progress.dataset.sourceProgress = "";
    host.append(progress);
    if (commandStatus) {
      const status = text(document, commandStatus);
      status.dataset.sourceCommandStatus = "";
      status.setAttribute("role", "status");
      host.append(status);
    }
    renderConflict();

    for (const fact of visibleFacts(view)) {
      const row = document.createElement("label");
      const disposition = document.createElement("select");
      disposition.dataset.factDisposition = fact.id;
      for (const value of ["accepted", "rejected", "uncertain"] as const) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        option.selected = value === (localReview.acceptedFactIds.includes(fact.id) ? "accepted" : localReview.rejectedFactIds.includes(fact.id) ? "rejected" : "uncertain");
        disposition.append(option);
      }
      disposition.addEventListener("change", () => {
        const accepted = new Set(localReview!.acceptedFactIds);
        const rejected = new Set(localReview!.rejectedFactIds);
        const uncertain = new Set(localReview!.uncertainFactIds);
        accepted.delete(fact.id); rejected.delete(fact.id); uncertain.delete(fact.id);
        if (disposition.value === "accepted") accepted.add(fact.id);
        else if (disposition.value === "rejected") rejected.add(fact.id);
        else uncertain.add(fact.id);
        const identity = disposition.value === "accepted" ? null : removeIdentityFact(fact.id);
        markDirty({
          ...localReview!,
          acceptedFactIds: [...accepted], rejectedFactIds: [...rejected], uncertainFactIds: [...uncertain],
          ...(identity ? { characterIdentityGroups: identity.groups, selectedCharacterFactIds: identity.selected } : {})
        });
        render();
      });
      row.append(disposition, text(document, `${fact.provenance}: ${factLabel(fact)}`, "span"));
      host.append(row, renderEvidence(fact, view));
    }

    host.append(text(document, "Character identities are an explicit review decision. Add each accepted character fact to exactly one group; same names may remain separate."));
    renderManualForm();
    renderIdentityGroups(view);
    if (localReview.selectedCharacterFactIds.length >= 20) host.append(text(document, "The playable roster already has the maximum 20 representatives."));

    const issue = reviewIssue(view);
    if (issue) host.append(text(document, issue));
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "Use selected facts";
    save.dataset.action = "save-source-review";
    save.disabled = !view.extractionComplete || !!issue || !!reviewConflict || commandController !== null;
    save.addEventListener("click", () => { void saveReview(); });
    const synthesis = document.createElement("button");
    synthesis.type = "button";
    synthesis.textContent = "Generate world draft";
    synthesis.dataset.action = "generate-source-world";
    synthesis.disabled = !view.extractionComplete || !!issue || !reviewSaved || localDirty || !!reviewConflict || commandController !== null;
    synthesis.addEventListener("click", () => { void beginSynthesis(); });
    host.append(save, synthesis);
    if (newerIntakeAvailable) appendNewSubmissionAction("Start a new proposal from the source edits made while the earlier submission was pending.");
    for (const stage of stages.filter((stage) => stage.status === "recoverable" || stage.status === "failed")) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = `Retry ${stage.key}`;
      retry.dataset.retryStageId = stage.id;
      retry.disabled = commandController !== null;
      retry.addEventListener("click", () => { void retryStage(stage.id); });
      host.append(retry);
    }
    if (current!.result && current!.canApply) host.append(text(document, "World draft ready. Choose Review available results, edit unknown fields, then explicitly create the world."));
  }

  function renderManualForm(): void {
    const manualForm = document.createElement("fieldset");
    manualForm.append(text(document, "Add a manual fact", "legend"));
    const controls = new Map<keyof ManualDraft, HTMLInputElement | HTMLSelectElement>();
    for (const field of ["kind", "subject", "predicate", "value"] as const) {
      const control = field === "kind" ? document.createElement("select") : document.createElement("input");
      control.name = `manual.${field}`;
      if (field === "kind") {
        for (const kind of ["character", "location", "faction", "relationship", "rule", "event", "tone"]) {
          const option = document.createElement("option");
          option.value = kind; option.textContent = kind; option.selected = manualDraft.kind === kind;
          control.append(option);
        }
      } else control.value = manualDraft[field];
      control.addEventListener(field === "kind" ? "change" : "input", () => { manualDraft[field] = control.value; });
      const label = text(document, field, "label"); label.append(control); manualForm.append(label); controls.set(field, control);
    }
    const add = document.createElement("button");
    add.type = "button"; add.textContent = "Add manual fact";
    add.addEventListener("click", () => {
      const kind = controls.get("kind")!.value;
      const subject = controls.get("subject")!.value.trim();
      const predicate = controls.get("predicate")!.value.trim();
      const value = controls.get("value")!.value.trim();
      if (!subject || !predicate || !value || !["character", "location", "faction", "relationship", "rule", "event", "tone"].includes(kind)) return;
      const fact: SourceFactReview["manualFacts"][number] = { id: `manual:${crypto.randomUUID()}`, kind: kind as SourceFact["kind"], subject, predicate, value, provenance: "manual", citations: [] };
      manualDraft.subject = ""; manualDraft.predicate = ""; manualDraft.value = "";
      markDirty({ ...localReview!, manualFacts: [...localReview!.manualFacts, fact], acceptedFactIds: [...localReview!.acceptedFactIds, fact.id] });
      render();
    });
    manualForm.append(add);
    host.append(manualForm);
  }

  function renderIdentityGroups(view: SourceAuthoringView): void {
    const facts = visibleFacts(view);
    for (const fact of facts.filter((candidate) => candidate.kind === "character" && localReview!.acceptedFactIds.includes(candidate.id))) {
      const membership = localReview!.characterIdentityGroups.find((group) => group.factIds.includes(fact.id));
      const groupButton = document.createElement("button");
      groupButton.type = "button"; groupButton.dataset.identityFactId = fact.id;
      groupButton.textContent = membership ? `Identity confirmed: ${factLabel(fact)}` : `Confirm separate identity: ${factLabel(fact)}`;
      groupButton.addEventListener("click", () => {
        if (localReview!.characterIdentityGroups.some((group) => group.factIds.includes(fact.id))) return;
        markDirty({ ...localReview!, characterIdentityGroups: [...localReview!.characterIdentityGroups, { representativeFactId: fact.id, factIds: [fact.id] }] });
        render();
      });
      host.append(groupButton);
      if (!membership) continue;
      const join = document.createElement("select");
      join.dataset.identityJoin = fact.id;
      const separate = document.createElement("option");
      separate.value = ""; separate.textContent = "Keep as a separate identity"; separate.selected = membership.factIds.length === 1;
      join.append(separate);
      for (const candidate of localReview!.characterIdentityGroups) {
        const representative = facts.find((item) => item.id === candidate.representativeFactId);
        if (!representative) continue;
        const option = document.createElement("option");
        option.value = candidate.representativeFactId;
        option.selected = candidate === membership && membership.factIds.length > 1;
        option.textContent = candidate === membership ? `Current identity: ${factLabel(representative)}` : `Same identity as ${factLabel(representative)}`;
        join.append(option);
      }
      join.addEventListener("change", () => { moveIdentityFact(fact.id, join.value || null); render(); });
      host.append(join);
      const representative = document.createElement("select");
      representative.dataset.identityRepresentative = fact.id;
      for (const memberId of membership.factIds) {
        const member = facts.find((candidate) => candidate.id === memberId);
        if (!member) continue;
        const option = document.createElement("option");
        option.value = memberId; option.selected = membership.representativeFactId === memberId; option.textContent = `Representative: ${factLabel(member)}`;
        representative.append(option);
      }
      representative.addEventListener("change", () => {
        if (representative.value === membership.representativeFactId) return;
        const groups = localReview!.characterIdentityGroups.map((candidate) => ({ ...candidate, factIds: [...candidate.factIds] }));
        const changed = groups.find((candidate) => candidate.factIds.includes(fact.id));
        if (!changed || !changed.factIds.includes(representative.value)) return;
        const selected = new Set(localReview!.selectedCharacterFactIds);
        if (selected.delete(changed.representativeFactId)) selected.add(representative.value);
        changed.representativeFactId = representative.value;
        markDirty({ ...localReview!, characterIdentityGroups: groups, selectedCharacterFactIds: [...selected] });
        render();
      });
      host.append(representative);
      if (membership.representativeFactId !== fact.id) continue;
      const roster = document.createElement("input");
      roster.type = "checkbox"; roster.dataset.rosterRepresentative = fact.id;
      roster.checked = localReview!.selectedCharacterFactIds.includes(fact.id);
      roster.disabled = !roster.checked && localReview!.selectedCharacterFactIds.length >= 20;
      roster.addEventListener("change", () => {
        const selected = new Set(localReview!.selectedCharacterFactIds);
        if (roster.checked) selected.add(fact.id); else selected.delete(fact.id);
        markDirty({ ...localReview!, selectedCharacterFactIds: [...selected] });
        render();
      });
      const rosterLabel = text(document, `Playable representative: ${factLabel(fact)}`, "label"); rosterLabel.append(roster); host.append(rosterLabel);
    }
  }

  function focusSnapshot() {
    const active = document.activeElement as HTMLInputElement | HTMLSelectElement | null;
    if (!active || !host.contains(active) || !active.name) return null;
    return { name: active.name, start: "selectionStart" in active ? active.selectionStart : null, end: "selectionEnd" in active ? active.selectionEnd : null };
  }

  function restoreFocus(snapshot: ReturnType<typeof focusSnapshot>): void {
    if (!snapshot) return;
    const control = Array.from(host.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[name]")).find((candidate) => candidate.name === snapshot.name);
    control?.focus();
    if (control && "setSelectionRange" in control && snapshot.start !== null && snapshot.end !== null) control.setSelectionRange(snapshot.start, snapshot.end);
  }

  function render(): void {
    if (disposed) return;
    const focus = focusSnapshot();
    host.replaceChildren();
    if (current?.kind === "story_source" && current.source) {
      renderReview(current.source);
      restoreFocus(focus);
      return;
    }
    const status = text(document, commandStatus); status.dataset.sourceIntakeStatus = ""; status.setAttribute("role", "status");
    host.append(text(document, "From story or chapter", "h3"), text(document, "Paste a story or select one UTF-8 TXT or Markdown file (1 MiB, 200,000 code points). Faithful extraction is selected by default."), status);
    const paste = document.createElement("textarea"); paste.rows = 10; paste.dataset.sourceText = ""; paste.value = rawText;
    paste.addEventListener("input", () => { rawText = paste.value; markIntakeChanged(); refreshIntakePreview(); }); host.append(paste);
    const file = document.createElement("input"); file.type = "file"; file.accept = ".txt,.md,text/plain,text/markdown"; file.dataset.sourceFile = "";
    file.addEventListener("change", () => { void readFile(file); }); const fileLabel = text(document, "Source file (TXT or Markdown)", "label"); fileLabel.append(file); host.append(fileLabel);
    const faithful = document.createElement("input"); faithful.type = "radio"; faithful.name = "sourceMode"; faithful.value = "faithful"; faithful.checked = mode === "faithful"; faithful.addEventListener("change", () => { mode = "faithful"; markIntakeChanged(); });
    const expand = document.createElement("input"); expand.type = "radio"; expand.name = "sourceMode"; expand.value = "expand"; expand.checked = mode === "expand"; expand.addEventListener("change", () => { mode = "expand"; markIntakeChanged(); });
    const faithfulLabel = text(document, "Faithful", "label"); faithfulLabel.append(faithful); const expandLabel = text(document, "Allow clearly marked expansion candidates", "label"); expandLabel.append(expand); host.append(faithfulLabel, expandLabel);
    let nextDraftValid = false;
    try {
      const shown = preview();
      if (!boundary || !shown.paragraphs.some((paragraph) => paragraph.id === boundary)) boundary = shown.paragraphs.at(-1)?.id ?? "";
      const size = text(document, `${name} · ${shown.bytes} bytes · ${shown.codePoints} code points`); size.dataset.sourceSize = ""; host.append(size);
      const select = document.createElement("select"); select.dataset.sourceBoundary = "";
      fillBoundaryOptions(select, shown);
      select.addEventListener("change", () => { boundary = select.value; markIntakeChanged(); }); const boundaryLabel = text(document, "Include through paragraph", "label"); boundaryLabel.append(select); host.append(boundaryLabel);
      nextDraftValid = !!rawText.trim() && shown.bytes <= MAX_SOURCE_DOCUMENT_BYTES && shown.codePoints <= MAX_SOURCE_DOCUMENT_CODE_POINTS && !!boundary;
    } catch { host.append(text(document, "Source text cannot contain NUL characters or invalid Unicode.")); }
    const submit = document.createElement("button"); submit.type = "button"; submit.textContent = pendingSubmission ? "Retry original source submission" : "Extract source facts"; submit.dataset.action = "submit-source";
    submit.disabled = commandController !== null || (!pendingSubmission && !nextDraftValid);
    submit.addEventListener("click", () => { void submitSource(); }); host.append(submit);
    if (pendingSubmission && intakeGeneration !== pendingSubmissionGeneration) appendNewSubmissionAction("Keep retrying the unchanged original request, or start a new proposal from these edits.");
    restoreFocus(focus);
  }

  async function readFile(file: HTMLInputElement): Promise<void> {
    const selected = file.files?.[0];
    if (!selected || disposed) return;
    commandStatus = "";
    if (!/\.(txt|md)$/iu.test(selected.name) || selected.size > MAX_SOURCE_DOCUMENT_BYTES) { commandStatus = "Choose one TXT or Markdown file no larger than 1 MiB."; render(); return; }
    try {
      rawText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await selected.arrayBuffer());
      if (disposed) return;
      name = selected.name; boundary = ""; markIntakeChanged(); render();
    } catch { if (!disposed) { commandStatus = "The file is not valid UTF-8 text."; render(); } }
  }

  function beginCommand(): { controller: AbortController; generation: number } | null {
    if (disposed || commandController) return null;
    const controller = new AbortController(); commandController = controller;
    return { controller, generation: ++commandGeneration };
  }

  function commandCurrent(command: { controller: AbortController; generation: number }, expectedId?: string): boolean {
    return !disposed && !command.controller.signal.aborted && command.generation === commandGeneration && (!expectedId || current?.id === expectedId);
  }

  function finishCommand(command: { controller: AbortController; generation: number }): void {
    if (commandController === command.controller) commandController = null;
    if (commandCurrent(command)) render();
  }

  function publishJob(job: AuthoringJobView): void { current = job; dependencies.onJobAvailable?.(job); }

  function appendNewSubmissionAction(message: string): void {
    host.append(text(document, message));
    const start = document.createElement("button");
    start.type = "button";
    start.dataset.action = "new-source-submission";
    start.textContent = "Start new proposal from edited source";
    start.disabled = commandController !== null;
    start.addEventListener("click", startNewSourceFromEdits);
    host.append(start);
  }

  function startNewSourceFromEdits(): void {
    if (disposed || commandController) return;
    ignoredResumeJobId = current?.id ?? ignoredResumeJobId;
    current = null;
    localReview = null;
    localDirty = false;
    reviewSaved = false;
    reviewConflict = null;
    pendingSubmission = null;
    pendingSubmissionGeneration = -1;
    newerIntakeAvailable = false;
    openCitations.clear();
    commandStatus = "Review the edited source, then submit it as a new durable proposal.";
    render();
  }

  function manualFactKey(fact: SourceFact): string {
    return JSON.stringify([fact.kind, fact.subject, fact.predicate, fact.value]);
  }

  function rebaseReviewAfterSave(newer: SourceFactReview, submitted: SourceFactReview, previous: AuthoringJobView, received: AuthoringJobView): SourceFactReview | null {
    if (previous.kind !== "story_source" || !previous.source || received.kind !== "story_source" || !received.source) return null;
    const previousIds = new Set([...previous.source.facts, ...previous.source.expansionCandidates].map((fact) => fact.id));
    const returnedManual = [...received.source.facts, ...received.source.expansionCandidates]
      .filter((fact) => fact.provenance === "manual" && !previousIds.has(fact.id));
    const unused = new Set(returnedManual.map((fact) => fact.id));
    const idMap = new Map<string, string>();
    for (const submittedFact of submitted.manualFacts) {
      const match = returnedManual.find((candidate) => unused.has(candidate.id) && manualFactKey(candidate) === manualFactKey(submittedFact));
      if (!match) return null;
      idMap.set(submittedFact.id, match.id);
      unused.delete(match.id);
    }
    const remap = (id: string) => idMap.get(id) ?? id;
    const ids = (values: string[]) => [...new Set(values.map(remap))];
    const submittedManualIds = new Set(submitted.manualFacts.map((fact) => fact.id));
    return {
      ...newer,
      expectedRevision: received.revision,
      acceptedFactIds: ids(newer.acceptedFactIds),
      rejectedFactIds: ids(newer.rejectedFactIds),
      uncertainFactIds: ids(newer.uncertainFactIds),
      selectedCharacterFactIds: ids(newer.selectedCharacterFactIds),
      characterIdentityGroups: newer.characterIdentityGroups.map((group) => ({ representativeFactId: remap(group.representativeFactId), factIds: ids(group.factIds) })),
      manualFacts: newer.manualFacts.filter((fact) => !submittedManualIds.has(fact.id))
    };
  }

  async function submitSource(): Promise<void> {
    const command = beginCommand(); if (!command) return;
    if (!pendingSubmission) {
      pendingSubmission = { kind: "story_source", idempotencyKey: crypto.randomUUID(), target: { kind: "new_world" }, name, text: rawText, mode, boundaryParagraphId: boundary, instructions: "" };
      pendingSubmissionGeneration = intakeGeneration;
    }
    const submitted = structuredClone(pendingSubmission);
    const submittedGeneration = pendingSubmissionGeneration;
    commandStatus = "Submitting the durable source request…"; render();
    try {
      const received = await api.submitSourceAuthoring(submitted, command.controller.signal);
      if (!commandCurrent(command)) return;
      newerIntakeAvailable = intakeGeneration !== submittedGeneration;
      pendingSubmission = null;
      pendingSubmissionGeneration = -1;
      ignoredResumeJobId = null;
      commandStatus = "Source saved. Extraction will continue in this durable proposal.";
      publishJob(received);
    } catch (error) { if (commandCurrent(command)) commandStatus = safeCommandMessage(error, "The source could not be submitted. Check the source and try again."); }
    finally { finishCommand(command); }
  }

  async function saveReview(): Promise<void> {
    if (!current || !localReview) return;
    const command = beginCommand(); if (!command) return;
    const expectedId = current.id; const previous = current; const submitted = structuredClone(localReview); const submittedGeneration = editGeneration;
    commandStatus = "Saving source review…"; render();
    try {
      const received = await api.saveSourceFactReview(expectedId, submitted, command.controller.signal);
      if (!commandCurrent(command, expectedId) || received.id !== expectedId) return;
      if (received.revision < current.revision) {
        const rebased = localReview && rebaseReviewAfterSave(localReview, submitted, previous, received);
        if (rebased) {
          localReview = rebased; localDirty = true; reviewSaved = false;
          reviewConflict ??= { message: "The server revision advanced while your local review was unsaved. Compare and reconcile before saving.", server: current };
          commandStatus = "Earlier changes were saved. Newer local decisions remain unsaved; compare them with the newer server revision.";
        } else {
          reviewConflict ??= { message: "The saved manual additions could not be matched while the server revision advanced. Compare before saving again.", server: current };
          commandStatus = "Newer local decisions remain unsaved.";
        }
        return;
      }
      if (submittedGeneration === editGeneration) {
        publishJob(received);
        localReview = null; localDirty = false; reviewSaved = true; reviewConflict = null; commandStatus = "Source review saved.";
      } else {
        const rebased = localReview && rebaseReviewAfterSave(localReview, submitted, previous, received);
        publishJob(received);
        if (rebased) {
          localReview = rebased; localDirty = true; reviewSaved = false; reviewConflict = null;
          commandStatus = "Earlier changes were saved. Newer local decisions remain unsaved.";
        } else {
          reviewConflict = { message: "The saved manual additions could not be matched to the server response. Compare before saving again.", server: received };
          commandStatus = "Newer local decisions remain unsaved.";
        }
      }
    } catch (error) {
      if (!commandCurrent(command, expectedId)) return;
      if (error instanceof SourceAuthoringApiError && error.code === "authoring_revision_conflict") { reviewConflict = { message: "The source review changed elsewhere. Your local decisions are preserved until you compare and reconcile.", server: null }; commandStatus = "Review conflict."; }
      else commandStatus = safeCommandMessage(error, "The source review could not be saved. Your local decisions are preserved; try again.");
    } finally { finishCommand(command); }
  }

  async function beginSynthesis(): Promise<void> {
    if (!current || !reviewSaved || localDirty || reviewConflict) return;
    const command = beginCommand(); if (!command) return;
    const expectedId = current.id; commandStatus = "Starting source synthesis…"; render();
    try {
      const received = await api.beginSourceSynthesis(expectedId, current.revision, command.controller.signal);
      if (!commandCurrent(command, expectedId) || received.id !== expectedId || received.revision < current.revision) return;
      commandStatus = "World synthesis is running. You can refresh and resume this proposal."; publishJob(received);
    } catch (error) { if (commandCurrent(command, expectedId)) commandStatus = safeCommandMessage(error, "Synthesis could not start. Check the review and try again."); }
    finally { finishCommand(command); }
  }

  async function retryStage(stageId: string): Promise<void> {
    if (!current || !authoringJobs) return;
    const command = beginCommand(); if (!command) return;
    const expectedId = current.id; commandStatus = "Retrying the failed source stage…"; render();
    try {
      const received = await authoringJobs.retryAuthoringStage(expectedId, { stageId, expectedRevision: current.revision }, command.controller.signal);
      if (!commandCurrent(command, expectedId) || received.id !== expectedId || received.revision < current.revision) return;
      commandStatus = "Source stage retry queued."; publishJob(received);
    } catch (error) { if (commandCurrent(command, expectedId)) commandStatus = safeCommandMessage(error, "The source stage retry could not be confirmed. Reload the proposal before trying again."); }
    finally { finishCommand(command); }
  }

  render();
  return {
    dispose() {
      if (disposed) return;
      disposed = true; commandGeneration += 1; commandController?.abort(); commandController = null;
    },
    resume(job) {
      if (disposed || job.kind !== "story_source" || !job.source) return;
      if (job.id === ignoredResumeJobId) return;
      if (current && current.id !== job.id) {
        localReview = null; localDirty = false; reviewConflict = null; reviewSaved = false; commandStatus = ""; openCitations.clear();
        manualDraft.kind = "character"; manualDraft.subject = ""; manualDraft.predicate = ""; manualDraft.value = "";
        pendingSubmission = null; pendingSubmissionGeneration = -1; newerIntakeAvailable = false; ignoredResumeJobId = null;
        commandGeneration += 1; commandController?.abort(); commandController = null;
      }
      if (current?.id === job.id && job.revision < current.revision) return;
      if (localDirty && localReview && job.revision > localReview.expectedRevision) reviewConflict = { message: "The server revision advanced while your local review was unsaved. Compare and reconcile before saving.", server: job };
      current = job;
      if (!localDirty) {
        localReview = null;
        reviewSaved = job.source.acceptedFactIds.length > 0 || currentStages(job).some((stage) => stage.key === "source:synthesis");
      }
      render();
    }
  };
}
