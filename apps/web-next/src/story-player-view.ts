import type { CampaignProjection } from "@infinite-quest/client-core";
import type { CampaignSummary } from "@infinite-quest/contracts";
import { storyPlayerPath, type StoryRoute } from "./story-route";
import type { ReadingWidth, StoryUiState } from "./story-player-model";

export interface StoryPlayerViewState {
  readonly route: StoryRoute;
  readonly ui: Readonly<StoryUiState>;
  readonly campaigns: readonly CampaignSummary[];
  readonly selectedCampaign: CampaignSummary | null;
  readonly projection: Readonly<CampaignProjection>;
}

type ReaderTurn = Readonly<{
  turnNumber: number;
  action: string;
  narration: string;
  reportedCost: Readonly<{ amount: string; currency: string }> | null;
}>;

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const next = document.createElement(tag);
  if (className) next.className = className;
  if (text !== undefined) next.textContent = text;
  return next;
}

function status(document: Document, message: string): HTMLElement {
  const next = element(document, "p", "story-status", message);
  next.dataset.storyStatus = "";
  next.setAttribute("role", "status");
  next.setAttribute("aria-live", "polite");
  return next;
}

function widthControl(document: Document, current: ReadingWidth): HTMLElement {
  const control = element(document, "div", "story-reading-width");
  control.setAttribute("role", "group");
  control.setAttribute("aria-label", "Reading width");
  for (const width of ["narrow", "standard", "wide"] as const) {
    const button = element(document, "button", undefined, width[0].toUpperCase() + width.slice(1));
    button.type = "button";
    button.dataset.readingWidth = width;
    button.setAttribute("aria-pressed", String(current === width));
    control.append(button);
  }
  return control;
}

function retryButton(document: Document): HTMLButtonElement {
  const button = element(document, "button", "story-retry", "Retry");
  button.type = "button";
  button.dataset.action = "retry-story";
  return button;
}

function errorState(document: Document, missing: boolean, message: string | null): HTMLElement {
  const section = element(document, "section", "story-state story-state-error");
  section.dataset.storyError = "";
  section.append(
    element(document, "h1", undefined, missing ? "Story not found" : "Story unavailable"),
    element(document, "p", undefined, message ?? "The Story Player could not load this campaign."),
    retryButton(document)
  );
  return section;
}

function chooser(document: Document, campaigns: readonly CampaignSummary[]): HTMLElement {
  const section = element(document, "section", "story-state story-chooser");
  section.append(element(document, "h1", undefined, "Choose a campaign"));
  if (!campaigns.length) {
    section.append(element(document, "p", undefined, "No active campaigns are available yet."));
    return section;
  }
  const list = element(document, "ul", "story-campaign-list");
  for (const campaign of campaigns) {
    const item = element(document, "li");
    const link = element(document, "a", "story-campaign-link", campaign.title);
    link.href = storyPlayerPath(campaign.id);
    item.append(link);
    list.append(item);
  }
  section.append(list);
  return section;
}

function recovery(document: Document, projection: Readonly<CampaignProjection>): HTMLElement | null {
  if (projection.generation?.origin !== "hydrated_recovery") return null;
  const section = element(document, "section", "story-recovery");
  section.dataset.storyRecovery = "";
  section.append(
    element(document, "h2", undefined, "Story generation needs attention"),
    element(document, "p", undefined, "Try again when the text provider is ready.")
  );
  return section;
}

function generationLabel(projection: Readonly<CampaignProjection>): string {
  return projection.generation === null ? "Story Engine ready" : "Story Engine generating";
}

function viewingLabel(turnNumber: number | null, activeTurnNumber: number): string {
  if (turnNumber === null) return "No accepted turns yet";
  return turnNumber === activeTurnNumber ? "Viewing latest turn" : `Viewing turn ${turnNumber} of ${activeTurnNumber}`;
}

export function renderStoryCommandRow(document: Document, state: StoryPlayerViewState): HTMLElement {
  const row = element(document, "div", "story-command-content");
  const campaign = state.projection.campaign;
  const world = state.projection.world;
  if (campaign && world) {
    const viewed = state.ui.viewTurnNumber ?? campaign.activeTurnNumber;
    row.append(
      element(document, "p", "story-command-campaign", campaign.title),
      element(document, "p", "story-command-world", `${world.title} · Version ${world.versionNumber}`),
      element(document, "p", "story-command-active", `Active turn ${campaign.activeTurnNumber}`),
      element(document, "p", "story-command-view", viewingLabel(viewed, campaign.activeTurnNumber)),
      element(document, "p", "story-command-engine", generationLabel(state.projection))
    );
  }
  const widthStatus = element(document, "p", "story-reading-width-status");
  widthStatus.dataset.readingWidthStatus = "";
  widthStatus.setAttribute("role", "status");
  widthStatus.setAttribute("aria-live", "polite");
  row.append(widthControl(document, state.ui.readingWidth), widthStatus);
  return row;
}

function narrationParagraphs(document: Document, narration: string): readonly HTMLElement[] {
  return narration.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .map((line) => {
      const paragraph = element(document, "p", "story-narration", line);
      paragraph.dataset.effectiveNarration = "";
      return paragraph;
    });
}

function formatReportedCost(turn: ReaderTurn): string | null {
  return turn.reportedCost === null ? null : `${turn.reportedCost.amount} ${turn.reportedCost.currency}`;
}

function recordAction(document: Document, action: "edit-response" | "inspect-state", label: string): HTMLButtonElement {
  const button = element(document, "button", undefined, label);
  button.type = "button";
  button.dataset.action = action;
  return button;
}

export function renderReaderToolbar(
  document: Document,
  turns: readonly ReaderTurn[],
  selectedTurnNumber: number,
  generationActive: boolean
): HTMLElement {
  const toolbar = element(document, "nav", "story-reader-toolbar");
  toolbar.setAttribute("aria-label", "Turn navigation");
  const index = turns.findIndex((turn) => turn.turnNumber === selectedTurnNumber);
  const previousTurn = index > 0 ? turns[index - 1] : null;
  const nextTurn = index >= 0 && index < turns.length - 1 ? turns[index + 1] : null;
  for (const [action, label, target] of [
    ["previous-turn", "Previous", previousTurn],
    ["next-turn", "Next", nextTurn]
  ] as const) {
    const button = element(document, "button", undefined, label);
    button.type = "button";
    button.dataset.action = action;
    if (target) button.dataset.turnNumber = String(target.turnNumber);
    button.disabled = generationActive || target === null;
    toolbar.append(button);
  }
  return toolbar;
}

export function renderStoryTurn(
  document: Document,
  turn: ReaderTurn,
  turns: readonly ReaderTurn[],
  generationActive: boolean
): HTMLElement {
  const leaf = element(document, "article", "story-leaf");
  leaf.dataset.storyLeaf = "";
  leaf.append(
    renderReaderToolbar(document, turns, turn.turnNumber, generationActive),
    element(document, "p", "story-turn-coordinate", `Turn ${turn.turnNumber}`),
    element(document, "h1", "story-title", `Turn ${turn.turnNumber}`),
    element(document, "p", "story-action", turn.action)
  );
  const cost = formatReportedCost(turn);
  if (cost !== null) leaf.append(element(document, "p", "story-reported-cost", cost));
  leaf.append(...narrationParagraphs(document, turn.narration));
  const actions = element(document, "div", "story-turn-record-actions");
  actions.append(recordAction(document, "edit-response", "Edit Response"), recordAction(document, "inspect-state", "Inspect State"));
  leaf.append(actions);
  return leaf;
}

function campaignReader(document: Document, state: StoryPlayerViewState): HTMLElement {
  const projection = state.projection;
  const campaign = projection.campaign;
  const world = projection.world;
  const reader = element(document, "section", "story-reader");
  reader.dataset.storyReader = "";
  if (!campaign || !world) {
    reader.append(status(document, "Loading Story…"));
    return reader;
  }

  const requestedTurnNumber = state.ui.viewTurnNumber ?? campaign.activeTurnNumber;
  const selectedTurn = projection.turns.find((turn) => turn.turnNumber === requestedTurnNumber)
    ?? projection.turns[projection.turns.length - 1]
    ?? null;
  if (selectedTurn) {
    reader.append(renderStoryTurn(document, selectedTurn, projection.turns, projection.generation !== null));
  } else {
    const background = element(document, "p", "story-background", world.backgroundStory);
    background.dataset.storyBackground = "";
    const firstAction = element(document, "p", "story-first-action", world.firstAction);
    firstAction.dataset.firstAction = "";
    const begin = element(document, "button", "story-begin", "Begin Story");
    begin.type = "button";
    begin.dataset.action = "begin-story";
    const hasTextProvider = state.selectedCampaign?.textProviderProfileId !== null && state.selectedCampaign !== null;
    begin.disabled = projection.generation !== null || !hasTextProvider;
    reader.append(background, firstAction, begin);
    if (!hasTextProvider) {
      const setup = element(document, "a", "story-setup", "Set up a text provider");
      setup.href = "/nexus/#providers";
      setup.dataset.storySetup = "";
      reader.append(setup);
    }
  }
  const recoveryView = recovery(document, projection);
  if (recoveryView) reader.append(recoveryView);
  return reader;
}

export function applyReadingWidth(foldout: HTMLElement, width: ReadingWidth): void {
  foldout.dataset.readingWidth = width;
}

export function renderStoryPlayerView(root: HTMLElement, state: StoryPlayerViewState): void {
  const document = root.ownerDocument;
  const main = root.querySelector<HTMLElement>('main[data-page="story-player"]');
  const commandRow = root.querySelector<HTMLElement>(".story-command-row");
  const foldout = root.querySelector<HTMLElement>(".story-foldout");
  const reader = root.querySelector<HTMLElement>(".story-reader");
  const spine = root.querySelector<HTMLElement>(".story-campaign-spine");
  const illustration = root.querySelector<HTMLElement>(".story-illustration-wing");
  if (!main || !commandRow || !foldout || !reader || !spine || !illustration) {
    throw new Error("The Story Player interface could not be initialized.");
  }

  main.setAttribute("aria-busy", String(state.ui.phase === "loading"));
  applyReadingWidth(foldout, state.ui.readingWidth);
  commandRow.replaceChildren(renderStoryCommandRow(document, state));
  spine.replaceChildren();
  illustration.replaceChildren(element(document, "p", "story-illustration-status", "Illustrations remain optional to story progress."));

  if (state.ui.phase === "loading") {
    reader.replaceChildren(status(document, "Loading Story…"));
    return;
  }
  if (state.ui.phase === "error" || state.ui.phase === "not_found") {
    reader.replaceChildren(errorState(document, state.ui.phase === "not_found", state.ui.message));
    return;
  }
  if (state.ui.phase === "chooser") {
    reader.replaceChildren(chooser(document, state.campaigns));
    return;
  }

  reader.replaceChildren(campaignReader(document, state));
  if (state.projection.campaign) {
    spine.append(element(document, "p", "story-campaign-name", state.projection.campaign.title));
  }
}
