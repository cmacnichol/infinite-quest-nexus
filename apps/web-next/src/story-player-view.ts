import type { CampaignProjection } from "@infinite-quest/client-core";
import type { AcceptedTurnCorrectionView, CampaignRuntimeStateResponse, CampaignSummary, MetaResponse, StoryLengthProfile } from "@infinite-quest/contracts";
import { storyPlayerPath, type StoryRoute } from "./story-route";
import type { ReadingWidth, StoryUiState } from "./story-player-model";
import { alignLatestSpine, latestCampaignSpine } from "./story-player-history";
import { storyIllustrationCapabilities, type StoryIllustrationState } from "./story-player-illustrations";
import type { StoryActivityRecord } from "./story-player-tools";

export interface StoryPlayerViewState {
  readonly route: StoryRoute;
  readonly ui: Readonly<StoryUiState>;
  readonly campaigns: readonly CampaignSummary[];
  readonly selectedCampaign: CampaignSummary | null;
  readonly projection: Readonly<CampaignProjection>;
  readonly inspectedState: CampaignRuntimeStateResponse | null;
  readonly currentState: CampaignRuntimeStateResponse | null;
  readonly correction: AcceptedTurnCorrectionView | null;
  readonly about: MetaResponse | null;
  readonly activityRecords: readonly StoryActivityRecord[];
  readonly illustrations: Readonly<StoryIllustrationState>;
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
  const generation = projection.generation;
  if (generation === null) return null;
  const section = element(document, "section", "story-recovery");
  section.dataset.storyRecovery = "";
  const failed = generation.result.state === "failed" || generation.origin === "hydrated_recovery";
  section.append(element(document, "h2", undefined, failed ? "Story generation needs attention" : "Story generation in progress"));
  section.append(element(document, "p", undefined, failed ? "Try again when the text provider is ready." : "The accepted story remains unchanged until completion."));
  const actions = element(document, "div", "story-generation-actions");
  if (generation.monitoring === "detached") {
    const resume = element(document, "button", undefined, "Resume monitoring");
    resume.type = "button";
    resume.dataset.action = "resume-generation";
    actions.append(resume);
  }
  if (generation.result.state === "unavailable" || failed) {
    const retry = element(document, "button", undefined, generation.result.state === "unavailable" ? "Load accepted result" : "Retry generation");
    retry.type = "button";
    retry.dataset.action = "retry-generation";
    actions.append(retry);
  }
  if (generation.result.state === "pending") {
    const cancel = element(document, "button", undefined, "Cancel generation");
    cancel.type = "button";
    cancel.dataset.action = "cancel-generation";
    actions.append(cancel);
  }
  if (failed) {
    const discard = element(document, "button", undefined, "Discard generation job");
    discard.type = "button";
    discard.dataset.action = "discard-generation";
    actions.append(discard);
  }
  if (actions.childElementCount) section.append(actions);
  return section;
}

function generationLabel(projection: Readonly<CampaignProjection>): string {
  return projection.generation === null ? "Story Engine ready" : "Story Engine generating";
}

function viewingLabel(turnNumber: number | null, activeTurnNumber: number): string {
  if (turnNumber === null) return "No accepted turns yet";
  return turnNumber === activeTurnNumber ? "Viewing latest turn" : `Viewing turn ${turnNumber} of ${activeTurnNumber}`;
}

function resolvedRenderedTurn(state: StoryPlayerViewState): CampaignProjection["turns"][number] | null {
  const campaign = state.projection.campaign;
  if (campaign === null) return null;
  const requestedTurnNumber = state.ui.viewTurnNumber ?? campaign.activeTurnNumber;
  return state.projection.turns.find((turn) => turn.turnNumber === requestedTurnNumber)
    ?? state.projection.turns[state.projection.turns.length - 1]
    ?? null;
}

function composerModeButtons(document: Document, turnControlStyle: string, current: StoryUiState["requestedInputMode"]): HTMLElement {
  const group = element(document, "div", "story-input-mode-bar");
  group.dataset.storyInputModes = "";
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", "Interpret prompt as");
  const modes = turnControlStyle === "action_only"
    ? [["action", "Action"]] as const
    : [["auto", "Auto"], ["action", "Action"], ["scene", "Scene Direction"]] as const;
  for (const [mode, label] of modes) {
    const button = element(document, "button", "story-input-mode", label);
    button.type = "button";
    button.dataset.inputMode = mode;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(current === mode));
    button.tabIndex = current === mode ? 0 : -1;
    group.append(button);
  }
  return group;
}

function profileLabel(profile: StoryLengthProfile): string {
  return profile[0]?.toUpperCase() + profile.slice(1);
}

function composerLengthSelect(
  document: Document,
  campaignProfile: StoryLengthProfile,
  currentOverride: StoryLengthProfile | null
): HTMLElement {
  const wrapper = element(document, "label", "story-length-control");
  wrapper.append(element(document, "span", undefined, "Turn length"));
  const select = element(document, "select") as HTMLSelectElement;
  select.dataset.storyLengthProfile = "";
  for (const [value, label] of [
    ["", `Campaign default — ${profileLabel(campaignProfile)}`],
    ["brief", "Brief"], ["standard", "Standard"], ["long", "Long"], ["extended", "Extended"]
  ] as const) {
    const option = element(document, "option", undefined, label) as HTMLOptionElement;
    option.value = value;
    option.selected = value === (currentOverride ?? "");
    select.append(option);
  }
  wrapper.append(select);
  return wrapper;
}

function storyComposer(
  document: Document,
  state: StoryPlayerViewState,
  choices: readonly string[],
  turnControlStyle: string
): HTMLElement {
  const composer = element(document, "section", "story-composer");
  composer.dataset.storyComposer = "";
  const ui = state.ui;
  const choiceList = element(document, "div", "story-choices");
  choiceList.dataset.storyChoices = "";
  for (const [index, choice] of choices.entries()) {
    const button = element(document, "button", "story-choice", choice);
    button.type = "button";
    button.dataset.storyChoice = "";
    button.dataset.choiceIndex = String(index);
    button.setAttribute("aria-pressed", String(ui.choiceSelection.includes(index)));
    choiceList.append(button);
  }
  if (choices.length) composer.append(choiceList);
  composer.append(composerModeButtons(document, turnControlStyle, ui.requestedInputMode));
  composer.append(composerLengthSelect(document, state.selectedCampaign?.storyLengthProfile ?? "standard", ui.storyLengthProfileOverride));

  const field = element(document, "div", "story-draft-field");
  const label = element(document, "label", "story-draft-label", "What happens next?");
  label.htmlFor = "story-draft";
  const textarea = element(document, "textarea", "story-draft") as HTMLTextAreaElement;
  textarea.id = label.htmlFor;
  textarea.dataset.storyDraft = "";
  textarea.maxLength = 12_000;
  textarea.value = ui.draft;
  textarea.setAttribute("aria-describedby", "story-draft-help story-draft-count");
  const clear = element(document, "button", "story-clear-draft", "×");
  clear.type = "button";
  clear.dataset.action = "clear-story-draft";
  clear.setAttribute("aria-label", "Clear story prompt");
  clear.title = "Clear story prompt";
  clear.disabled = !ui.draft;
  const help = element(document, "p", "story-draft-help", "Choose a suggestion or describe the next moment. Auto interprets your prompt only when you continue.");
  help.id = "story-draft-help";
  const count = element(document, "p", "story-draft-count", `${ui.draft.length.toLocaleString()} / 12,000`);
  count.id = "story-draft-count";
  count.dataset.storyCharacterCount = "";
  count.setAttribute("role", "status");
  count.setAttribute("aria-live", "polite");
  field.append(label, textarea, clear, help, count);
  composer.append(field);

  if (ui.intentConfirmation !== null) {
    const confirmation = element(document, "section", "story-intent-confirmation");
    confirmation.dataset.storyIntentConfirmation = "";
    confirmation.setAttribute("role", "region");
    const title = element(document, "h2", "story-intent-title", "Confirm prompt interpretation");
    title.id = "story-intent-title";
    confirmation.setAttribute("aria-labelledby", title.id);
    const useAction = element(document, "button", undefined, "Use as Action");
    useAction.type = "button";
    useAction.dataset.action = "confirm-intent-action";
    const useScene = element(document, "button", undefined, "Use as Scene Direction");
    useScene.type = "button";
    useScene.dataset.action = "confirm-intent-scene";
    const returnToEditor = element(document, "button", undefined, "Return to editor");
    returnToEditor.type = "button";
    returnToEditor.dataset.action = "return-to-story-editor";
    confirmation.append(title, element(document, "p", undefined, `Choose how to continue: ${ui.intentConfirmation.action}`), useAction, useScene, returnToEditor);
    composer.append(confirmation);
  }

  const secondary = element(document, "div", "story-composer-secondary-actions");
  const history = element(document, "button", undefined, "Turn History");
  history.type = "button";
  history.dataset.action = "open-complete-history";
  secondary.append(history);
  const primary = element(document, "div", "story-composer-primary-action");
  const submit = element(document, "button", "story-continue", "Continue Story");
  submit.type = "button";
  submit.dataset.action = "continue-story";
  primary.append(submit);
  composer.append(secondary, primary);
  if (ui.message !== null) {
    const message = status(document, ui.message);
    message.dataset.storyComposerStatus = "";
    composer.append(message);
  }
  return composer;
}

export function renderStoryCommandRow(document: Document, state: StoryPlayerViewState): HTMLElement {
  const row = element(document, "div", "story-command-content");
  const campaign = state.projection.campaign;
  const world = state.projection.world;
  if (campaign && world) {
    const viewed = resolvedRenderedTurn(state)?.turnNumber ?? null;
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

function illustrationAlt(segmentText: string): string {
  const concise = segmentText.trim().replace(/\s+/g, " ");
  return concise ? `Illustration of ${concise}` : "Campaign illustration";
}

function compactIllustrationPreview(document: Document, illustration: Readonly<StoryIllustrationState>): HTMLElement | null {
  const variant = illustration.selectedVariant;
  if (!variant) return null;
  const preview = element(document, "figure", "story-compact-illustration-preview");
  preview.dataset.storyCompactIllustrationPreview = "";
  const image = element(document, "img") as HTMLImageElement;
  image.src = variant.url;
  image.alt = "";
  image.setAttribute("aria-hidden", "true");
  const caption = element(document, "figcaption", undefined, illustration.selectedSegment?.text || "Current illustration");
  preview.append(image, caption);
  return preview;
}

function formatReportedCost(turn: ReaderTurn): string | null {
  return turn.reportedCost === null ? null : `${turn.reportedCost.amount} ${turn.reportedCost.currency}`;
}

function recordAction(
  document: Document,
  action: "edit-response" | "inspect-state" | "retry-latest-generation" | "undo-latest",
  label: string
): HTMLButtonElement {
  const button = element(document, "button", undefined, label);
  button.type = "button";
  button.dataset.action = action;
  return button;
}

export function renderReaderToolbar(
  document: Document,
  turns: readonly ReaderTurn[],
  selectedTurnNumber: number,
  generationActive: boolean,
  canLoadPrevious = false
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
    button.disabled = generationActive || (target === null && !(action === "previous-turn" && canLoadPrevious));
    toolbar.append(button);
  }
  return toolbar;
}

export function renderStoryTurn(
  document: Document,
  turn: ReaderTurn,
  turns: readonly ReaderTurn[],
  generationActive: boolean,
  canLoadPrevious = false,
  contextual = true,
  presentation: "native" | "quiet-leaf" = "native"
): HTMLElement {
  const leaf = element(document, "article", "story-leaf");
  leaf.dataset.storyLeaf = "";
  if (contextual && !generationActive) leaf.append(renderReaderToolbar(document, turns, turn.turnNumber, generationActive, canLoadPrevious));
  if (presentation === "native") {
    leaf.append(
      element(document, "p", "story-turn-coordinate", `Turn ${turn.turnNumber}`),
      element(document, "h1", "story-title", `Turn ${turn.turnNumber}`),
      element(document, "p", "story-action", turn.action)
    );
  } else if (!contextual) {
    leaf.append(element(document, "h2", "story-continuous-turn-title", `Turn ${turn.turnNumber}`));
  }
  const cost = formatReportedCost(turn);
  if (cost !== null) leaf.append(element(document, "p", "story-reported-cost", cost));
  leaf.append(...narrationParagraphs(document, turn.narration));
  if (contextual) {
    const actions = element(document, "div", "story-turn-record-actions");
    const latest = turns.at(-1);
    const edit = recordAction(document, "edit-response", "Edit Response");
    edit.disabled = generationActive || latest?.turnNumber !== turn.turnNumber;
    actions.append(edit, recordAction(document, "inspect-state", "Inspect State"));
    if (!generationActive && latest?.turnNumber === turn.turnNumber) {
      if (presentation === "native") actions.append(recordAction(document, "retry-latest-generation", "Retry Latest Generation"));
      actions.append(recordAction(document, "undo-latest", "Undo Latest"));
    }
    leaf.append(actions);
  }
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

  const selectedTurn = resolvedRenderedTurn(state);
  if (selectedTurn) {
    const preview = compactIllustrationPreview(document, state.illustrations);
    if (preview) reader.append(preview);
    if (state.ui.continuousReading) {
      for (const turn of projection.turns) {
        reader.append(renderStoryTurn(
          document,
          turn,
          projection.turns,
          projection.generation !== null,
          projection.nextTurnsCursor !== null,
          turn.turnNumber === selectedTurn.turnNumber
        ));
      }
    } else {
      reader.append(renderStoryTurn(document, selectedTurn, projection.turns, projection.generation !== null, projection.nextTurnsCursor !== null));
    }
    if (projection.generation !== null) {
      const preview = element(document, "article", "story-leaf story-generation-preview");
      preview.dataset.storyGenerationPreview = "";
      preview.dataset.generationFollowing = String(state.ui.generationFollowing);
      preview.append(element(document, "p", "story-generation-status", generationLabel(projection)));
      if (projection.generation.narration) preview.append(...narrationParagraphs(document, projection.generation.narration));
      if (projection.generation.transport.state === "degraded") {
        preview.append(element(document, "p", "story-generation-degraded", "Connection is degraded; recovery monitoring remains active."));
      }
      if (!state.ui.generationFollowing) {
        const resumeFollowing = element(document, "button", undefined, "Resume following");
        resumeFollowing.type = "button";
        resumeFollowing.dataset.action = "resume-generation-following";
        preview.append(resumeFollowing);
      }
      reader.append(preview);
    }
    const isViewingLatest = selectedTurn.turnNumber === campaign.activeTurnNumber;
    if (isViewingLatest && projection.generation === null) {
      reader.append(storyComposer(document, state, selectedTurn.choices, state.selectedCampaign?.turnControlStyle ?? "action_only"));
    }
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

/**
 * Provides the safe, read-only projection used by the Core Story presenter.
 * The native reader retains its composer and compact illustration preview.
 */
export function renderStoryContent(document: Document, state: StoryPlayerViewState): readonly HTMLElement[] {
  if (state.ui.phase === "loading") return [status(document, "Loading Story…")];
  if (state.ui.phase === "error" || state.ui.phase === "not_found") {
    return [errorState(document, state.ui.phase === "not_found", state.ui.message)];
  }
  if (state.ui.phase === "chooser") return [chooser(document, state.campaigns)];

  const campaign = state.projection.campaign;
  const world = state.projection.world;
  if (!campaign || !world) return [status(document, "Loading Story…")];

  const content: HTMLElement[] = [];
  const selectedTurn = resolvedRenderedTurn(state);
  if (selectedTurn) {
    if (state.ui.continuousReading) {
      for (const turn of state.projection.turns) {
        content.push(renderStoryTurn(document, turn, state.projection.turns, state.projection.generation !== null, state.projection.nextTurnsCursor !== null, turn.turnNumber === selectedTurn.turnNumber, "quiet-leaf"));
      }
    } else {
      content.push(renderStoryTurn(document, selectedTurn, state.projection.turns, state.projection.generation !== null, state.projection.nextTurnsCursor !== null, true, "quiet-leaf"));
    }
    if (state.projection.generation !== null) {
      const preview = element(document, "article", "story-leaf story-generation-preview");
      preview.dataset.storyGenerationPreview = "";
      preview.dataset.generationFollowing = String(state.ui.generationFollowing);
      preview.append(element(document, "p", "story-generation-status", generationLabel(state.projection)));
      if (state.projection.generation.narration) preview.append(...narrationParagraphs(document, state.projection.generation.narration));
      if (state.projection.generation.transport.state === "degraded") {
        preview.append(element(document, "p", "story-generation-degraded", "Connection is degraded; recovery monitoring remains active."));
      }
      if (!state.ui.generationFollowing) {
        const resumeFollowing = element(document, "button", undefined, "Resume following");
        resumeFollowing.type = "button";
        resumeFollowing.dataset.action = "resume-generation-following";
        preview.append(resumeFollowing);
      }
      content.push(preview);
    }
  } else {
    const background = element(document, "p", "story-background", world.backgroundStory);
    background.dataset.storyBackground = "";
    const firstAction = element(document, "p", "story-first-action", world.firstAction);
    firstAction.dataset.firstAction = "";
    const begin = element(document, "button", "story-begin", "Begin Story");
    begin.type = "button";
    begin.dataset.action = "begin-story";
    const hasTextProvider = state.selectedCampaign?.textProviderProfileId !== null && state.selectedCampaign !== null;
    begin.disabled = state.projection.generation !== null || !hasTextProvider;
    content.push(background, firstAction, begin);
    if (!hasTextProvider) {
      const setup = element(document, "a", "story-setup", "Set up a text provider");
      setup.href = "/nexus/#providers";
      setup.dataset.storySetup = "";
      content.push(setup);
    }
  }
  const recoveryView = recovery(document, state.projection);
  if (recoveryView) content.push(recoveryView);
  return content;
}

export function renderIllustrationWing(document: Document, illustration: Readonly<StoryIllustrationState>): HTMLElement {
  const wing = element(document, "section", "story-illustration-content");
  const capabilities = storyIllustrationCapabilities(illustration);
  const statusMessage = illustration.status === "disabled"
    ? "Illustrations are disabled for this campaign."
    : illustration.status === "unavailable"
      ? illustration.message ?? "Illustrations are unavailable."
      : illustration.status === "loading"
        ? "Loading illustrations…"
        : illustration.segments.length
          ? `${illustration.segments.length} illustration segment${illustration.segments.length === 1 ? "" : "s"}.`
          : "No illustrations are available for this accepted turn.";
  const statusLine = element(document, "p", "story-illustration-status", statusMessage);
  statusLine.dataset.storyIllustrationStatus = "";
  statusLine.setAttribute("role", "status");
  statusLine.setAttribute("aria-live", "polite");
  wing.append(statusLine);
  const segment = illustration.selectedSegment;
  const variant = illustration.selectedVariant;
  if (!segment || !variant) {
    if (illustration.status === "ready") {
      const actions = [
        ...(capabilities.canGenerate ? [
          ["retry-image-job", "Retry", capabilities.canRetry],
          ["generate-missing-images", "Generate missing images", true],
          ["rebuild-images", "Rebuild images", true]
        ] as const : []),
        ...(capabilities.canMatch ? [["rematch-image", "Find library match", true]] as const : [])
      ];
      for (const [action, label, valid] of actions) {
        const button = element(document, "button", undefined, label);
        button.type = "button";
        button.dataset.action = action;
        button.disabled = capabilities.busy || !valid;
        wing.append(button);
      }
    }
    return wing;
  }
  const figure = element(document, "figure", "story-illustration-figure");
  const image = element(document, "img") as HTMLImageElement;
  image.src = variant.url;
  image.alt = illustrationAlt(segment.text);
  const caption = element(document, "figcaption", "story-illustration-caption", segment.text || "Current illustration");
  figure.append(image, caption);
  wing.append(figure);
  const navigation = element(document, "div", "story-illustration-navigation");
  for (const [action, label] of [["previous-image", "Previous image"], ["next-image", "Next image"]] as const) {
    const button = element(document, "button", undefined, label);
    button.type = "button";
    button.dataset.action = action;
    navigation.append(button);
  }
  wing.append(navigation);
  if (capabilities.canGenerate) {
    const label = element(document, "label", "story-illustration-prompt-label", "Image prompt");
    label.htmlFor = "story-illustration-prompt";
    const prompt = element(document, "textarea", "story-illustration-prompt") as HTMLTextAreaElement;
    prompt.id = label.htmlFor;
    prompt.dataset.storyIllustrationPrompt = "";
    prompt.value = illustration.prompt;
    prompt.disabled = capabilities.busy;
    wing.append(label, prompt);
  }
  const actions = [
    ...(capabilities.canRegenerate ? [["regenerate-image", "Regenerate", true]] as const : []),
    ...(capabilities.canGenerate ? [["retry-image-job", "Retry", capabilities.canRetry], ["generate-missing-images", "Generate missing images", true], ["rebuild-images", "Rebuild images", true]] as const : []),
    ...(capabilities.canInspectProvenance ? [["load-image-provenance", "Why this image?", true]] as const : []),
    ...(capabilities.canMatch ? [["rematch-image", "Find library match", true]] as const : [])
  ];
  for (const [action, labelText, valid] of actions) {
    const button = element(document, "button", undefined, labelText);
    button.type = "button";
    button.dataset.action = action;
    button.disabled = capabilities.busy || !valid;
    wing.append(button);
  }
  if (illustration.provenance) {
    wing.append(element(document, "p", "story-illustration-provenance", `Image match status: ${illustration.provenance.status}.`));
  }
  return wing;
}

function turnModeLabel(mode: CampaignProjection["turns"][number]["inputMode"]): string {
  return mode === "scene" ? "Scene Direction" : "Action";
}

function firstNarrationSentence(narration: string): string {
  const sentence = narration.trim().split(/(?<=[.!?])\s|\r?\n/u, 1)[0] ?? "";
  return sentence || "Accepted story turn";
}

function campaignSpine(document: Document, state: StoryPlayerViewState): HTMLElement {
  const spine = element(document, "div", "story-campaign-spine-content");
  const latest = latestCampaignSpine(state.projection.turns);
  if (!latest.length) {
    spine.append(element(document, "p", "story-spine-empty", "Accepted turns will appear here."));
    return spine;
  }
  const selected = state.ui.viewTurnNumber;
  for (const turn of latest) {
    const button = element(document, "button", "story-spine-turn");
    button.type = "button";
    button.dataset.turnNumber = String(turn.turnNumber);
    if (selected === turn.turnNumber) button.setAttribute("aria-current", "step");
    button.append(
      element(document, "span", "story-spine-number", String(turn.turnNumber)),
      element(document, "strong", "story-spine-title", `Turn ${turn.turnNumber}`),
      element(document, "small", "story-spine-meta", `${firstNarrationSentence(turn.narration)} · ${turnModeLabel(turn.inputMode)}`),
      element(document, "small", "story-spine-chronicle", turn.chronicleRetrieval === null ? "No Chronicle recall" : "Chronicle recall available")
    );
    spine.append(button);
  }
  return spine;
}

export function renderStoryNavigation(document: Document, state: StoryPlayerViewState): HTMLElement | null {
  if (!state.projection.campaign) return null;
  const navigation = element(document, "section", "story-quiet-leaf-navigation");
  navigation.dataset.storyNavigation = "";
  const openHistory = element(document, "button", "story-open-history", "Turn History");
  openHistory.type = "button";
  openHistory.dataset.action = "open-complete-history";
  const spineContent = campaignSpine(document, state);
  navigation.append(element(document, "p", "story-campaign-name", state.projection.campaign.title), openHistory, spineContent);
  alignLatestSpine(spineContent);
  return navigation;
}

function completeHistoryDialog(document: Document, state: StoryPlayerViewState): HTMLDialogElement | null {
  if (state.ui.activeDialog !== "history") return null;
  const dialog = element(document, "dialog", "story-history-dialog") as HTMLDialogElement;
  dialog.dataset.storyHistory = "";
  const title = element(document, "h2", undefined, "Turn History");
  title.id = "story-history-title";
  dialog.setAttribute("aria-labelledby", title.id);
  dialog.append(title);
  if (state.ui.history === "loading") dialog.append(element(document, "p", undefined, "Loading complete history…"));
  if (state.ui.history === "error") {
    dialog.append(element(document, "p", "story-history-error", state.ui.message ?? "History unavailable."));
    const retry = element(document, "button", undefined, "Retry complete history");
    retry.type = "button";
    retry.dataset.action = "retry-complete-history";
    dialog.append(retry);
  }
  const list = element(document, "div", "story-history-list");
  for (const turn of [...state.projection.turns].sort((left, right) => left.turnNumber - right.turnNumber)) {
    const entry = element(document, "button", "story-history-turn", `Turn ${turn.turnNumber}: ${firstNarrationSentence(turn.narration)}`);
    entry.type = "button";
    entry.dataset.turnNumber = String(turn.turnNumber);
    entry.setAttribute("aria-pressed", String(state.ui.viewTurnNumber === turn.turnNumber));
    list.append(entry);
  }
  dialog.append(list);
  if (state.inspectedState !== null && state.inspectedState.campaignId === state.projection.campaign?.id) {
    const inspector = element(document, "section", "story-history-state-inspector");
    inspector.dataset.storyStateInspector = "";
    inspector.append(
      element(document, "h3", undefined, `Historical State — Turn ${state.inspectedState.viewedTurnNumber}`),
      element(document, "p", undefined, "Read-only historical state inspection."),
      element(document, "h4", undefined, "Continuity"),
      element(document, "p", undefined, state.inspectedState.continuitySummary)
    );
    const appendList = (heading: string, values: readonly string[]) => {
      inspector.append(element(document, "h4", undefined, heading));
      if (!values.length) {
        inspector.append(element(document, "p", undefined, "None recorded."));
        return;
      }
      const list = element(document, "ul");
      for (const value of values) list.append(element(document, "li", undefined, value));
      inspector.append(list);
    };
    appendList("Open Threads", state.inspectedState.openThreads);
    appendList("Canonical Facts", state.inspectedState.canonicalFacts.map((fact) => fact.content));
    inspector.append(
      element(document, "h4", undefined, "Scratchpad"),
      element(document, "p", undefined, state.inspectedState.scratchpad || "No scratchpad entry.")
    );
    appendList("Trackers", state.inspectedState.trackers.map((tracker) => (
      `${tracker.name}: ${tracker.value}${tracker.rules ? ` — ${tracker.rules}` : ""}`
    )));
    appendList("RPG Stats", state.inspectedState.rpgStats.map((stat) => (
      `${stat.name}: ${stat.value}${stat.note ? ` — ${stat.note}` : ""}`
    )));
    appendList("Event Triggers", state.inspectedState.eventTriggers.map((trigger) => (
      `${trigger.label} (${trigger.timing}): ${trigger.condition} — ${trigger.effect}`
    )));
    appendList("Pending Triggers", state.inspectedState.pendingEventTriggers.map((trigger) => (
      `${trigger.name} (${trigger.timing}): ${trigger.instructions}`
    )));
    if (state.inspectedState.recordedResolution !== null) {
      const resolution = state.inspectedState.recordedResolution;
      inspector.append(
        element(document, "h4", undefined, "Resolve Check"),
        element(document, "p", undefined, `${resolution.statName}: ${resolution.roll} / ${resolution.target} (${resolution.success ? "success" : "failure"})`),
        element(document, "p", undefined, `Base ${resolution.base}; modifier ${resolution.modifier >= 0 ? "+" : ""}${resolution.modifier}; ${resolution.difficultyLabel}.`)
      );
    }
    dialog.append(inspector);
  }
  for (const [action, label] of [
    ["inspect-state", "Inspect State"],
    ["jump-to-scene", "Jump to Scene"],
    ["jump-to-latest", "Jump to Latest"],
    ["restart-from-turn", "Restart / Branch from Here"],
    ["close-history", "Done"]
  ] as const) {
    const button = element(document, "button", undefined, label);
    button.type = "button";
    button.dataset.action = action;
    if (action === "jump-to-scene" && state.ui.viewTurnNumber !== null) button.dataset.turnNumber = String(state.ui.viewTurnNumber);
    if (action === "jump-to-latest" && state.projection.campaign) button.dataset.turnNumber = String(state.projection.campaign.activeTurnNumber);
    if (action === "restart-from-turn" && state.ui.viewTurnNumber !== null) button.dataset.turnNumber = String(state.ui.viewTurnNumber);
    if (action === "restart-from-turn") button.disabled = state.projection.generation !== null;
    dialog.append(button);
  }
  return dialog;
}

function editorField(document: Document, labelText: string, action: string, value: string): HTMLElement {
  const wrapper = element(document, "label", "story-tool-field", labelText);
  const input = element(document, "textarea") as HTMLTextAreaElement;
  input.dataset.stateField = action;
  input.value = value;
  wrapper.append(input);
  return wrapper;
}

function toolDialog(document: Document, state: StoryPlayerViewState): HTMLDialogElement | null {
  const active = state.ui.activeDialog;
  if (active !== "world" && active !== "current-state" && active !== "correction" && active !== "activity" && active !== "about" && !active?.startsWith("restart:")) return null;
  const dialog = element(document, "dialog", "story-tool-dialog") as HTMLDialogElement;
  dialog.dataset.storyToolDialog = "";
  const title = element(document, "h2", undefined, active === "world" ? "Current World Setup"
    : active === "current-state" ? "Edit Campaign State"
      : active === "correction" ? "Edit Response" : "Restart from this turn");
  title.textContent = active === "activity" ? "Activity Log" : active === "about" ? "About Infinite Quest Nexus" : title.textContent;
  title.id = "story-tool-dialog-title";
  dialog.setAttribute("aria-labelledby", title.id);
  dialog.append(title);
  if (active === "activity") {
    if (!state.activityRecords.length) dialog.append(element(document, "p", undefined, "No activity recorded this session."));
    else {
      const list = element(document, "ol", "story-activity-log");
      for (const record of state.activityRecords) {
        const entry = element(document, "li");
        entry.append(element(document, "strong", undefined, record.title), element(document, "p", undefined, record.detail || `${record.category} · ${record.timestamp}`));
        list.append(entry);
      }
      dialog.append(list);
    }
    for (const [action, label, disabled] of [["copy-activity-diagnostics", "Copy diagnostics", !state.activityRecords.length], ["clear-activity", "Clear log", !state.activityRecords.length]] as const) {
      const button = element(document, "button", undefined, label);
      button.type = "button";
      button.dataset.action = action;
      button.disabled = disabled;
      dialog.append(button);
    }
  } else if (active === "about") {
    const application = state.about?.application;
    if (application) {
      dialog.append(
        element(document, "p", undefined, application.name),
        element(document, "p", undefined, `Version ${application.version}`),
        element(document, "p", undefined, application.commit ? `Commit ${application.commit}` : "Commit unavailable."),
        element(document, "p", undefined, application.builtAt ? `Built ${application.builtAt}` : "Build time unavailable.")
      );
    } else dialog.append(element(document, "p", undefined, "Loading application information…"));
  } else if (active === "world") {
    const world = state.projection.world;
    if (world) {
      dialog.append(
        element(document, "p", undefined, world.title),
        element(document, "p", undefined, `Version ${world.versionNumber}`),
        element(document, "p", undefined, world.premise),
        element(document, "p", undefined, world.rules)
      );
      if (world.playableCharacters.length) {
        const characters = element(document, "ul");
        for (const character of world.playableCharacters) characters.append(element(document, "li", undefined, character.name));
        dialog.append(element(document, "h3", undefined, "Available characters"), characters);
      }
    } else dialog.append(element(document, "p", undefined, "World setup is unavailable."));
  } else if (active === "current-state") {
    const runtime = state.currentState;
    if (runtime === null) dialog.append(element(document, "p", undefined, "Loading campaign state…"));
    else {
      dialog.append(
        editorField(document, "Continuity", "continuitySummary", runtime.continuitySummary),
        editorField(document, "Open threads", "openThreads", JSON.stringify(runtime.openThreads, null, 2)),
        editorField(document, "Canonical facts", "canonicalFacts", JSON.stringify(runtime.canonicalFacts, null, 2)),
        editorField(document, "Scratchpad", "scratchpad", runtime.scratchpad),
        editorField(document, "Trackers", "trackers", JSON.stringify(runtime.trackers, null, 2)),
        editorField(document, "RPG stats", "rpgStats", JSON.stringify(runtime.rpgStats, null, 2)),
        editorField(document, "Event triggers", "eventTriggers", JSON.stringify(runtime.eventTriggers, null, 2)),
        editorField(document, "Pending triggers", "pendingEventTriggers", JSON.stringify(runtime.pendingEventTriggers, null, 2))
      );
      const save = element(document, "button", undefined, "Save Campaign State");
      save.type = "button";
      save.dataset.action = "save-current-state";
      dialog.append(save);
    }
  } else if (active === "correction") {
    const correction = state.correction;
    if (correction === null) dialog.append(element(document, "p", undefined, "Loading the current response…"));
    else {
      const narration = editorField(document, "Effective narration", "correction-narration", correction.effectiveNarration);
      narration.querySelector<HTMLTextAreaElement>("textarea")!.dataset.correctionNarration = "";
      const save = element(document, "button", undefined, "Save correction");
      save.type = "button";
      save.dataset.action = "save-narration-correction";
      dialog.append(narration, save);
    }
  } else {
    const turnNumber = Number(active.slice("restart:".length));
    dialog.append(element(document, "p", undefined, `Choose Branch or authoritative Rewind from persisted Turn ${turnNumber}.`));
    for (const [action, label] of [["branch-from-turn", "Branch from Here"], ["rewind-from-turn", "Rewind Here"]] as const) {
      const button = element(document, "button", undefined, label);
      button.type = "button";
      button.dataset.action = action;
      button.dataset.turnNumber = String(turnNumber);
      button.disabled = state.projection.generation !== null;
      dialog.append(button);
    }
  }
  const close = element(document, "button", undefined, "Close");
  close.type = "button";
  close.dataset.action = "close-story-tool-dialog";
  dialog.append(close, status(document, ""));
  return dialog;
}

export function renderStoryDialogs(document: Document, state: StoryPlayerViewState): readonly HTMLElement[] {
  return [completeHistoryDialog(document, state), toolDialog(document, state)]
    .filter((dialog): dialog is HTMLDialogElement => dialog !== null) as unknown as readonly HTMLElement[];
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
  main.querySelector("[data-story-history]")?.remove();
  main.querySelector("[data-story-tool-dialog]")?.remove();
  applyReadingWidth(foldout, state.ui.readingWidth);
  commandRow.replaceChildren(renderStoryCommandRow(document, state));
  spine.replaceChildren();
  illustration.replaceChildren(renderIllustrationWing(document, state.illustrations));

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
  const navigation = renderStoryNavigation(document, state);
  if (navigation) spine.append(navigation);
  main.append(...renderStoryDialogs(document, state));
}
