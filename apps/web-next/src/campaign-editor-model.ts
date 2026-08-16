export const CAMPAIGN_SECTIONS = [
  "overview", "character", "state", "history", "chronicle", "illustrations", "world-transfer", "data"
] as const;

export type CampaignSection = typeof CAMPAIGN_SECTIONS[number];

export const CAMPAIGN_SECTION_LABELS: Record<CampaignSection, string> = {
  overview: "Overview",
  character: "Character",
  state: "State",
  history: "History",
  chronicle: "Chronicle",
  illustrations: "Illustrations",
  "world-transfer": "World & Transfer",
  data: "Data"
};

export interface CampaignRoute {
  campaignId: string | null;
  section: CampaignSection;
}

export function campaignEditorPath(campaignId?: string, section: CampaignSection = "overview"): string {
  return campaignId ? `/app/campaigns/${encodeURIComponent(campaignId)}/${section}` : "/app/campaigns";
}

export function campaignRouteFromPath(pathname: string): CampaignRoute | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "app" || parts[1] !== "campaigns") return null;
  const campaignId = parts[2] ? decodeURIComponent(parts[2]) : null;
  const requested = parts[3] as CampaignSection | undefined;
  return { campaignId, section: requested && CAMPAIGN_SECTIONS.includes(requested) ? requested : "overview" };
}

export function escapeCampaignText(value: unknown): string {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character] ?? character);
}

export function firstNarrationSentence(value: unknown): string {
  const narration = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!narration) return "No narration recorded.";
  if (typeof Intl.Segmenter === "function") {
    const segment = new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(narration)[Symbol.iterator]().next().value;
    if (segment?.segment) return String(segment.segment).trim();
  }
  return narration.match(/^.*?[.!?](?:[\"'’”)]|$)/)?.[0]?.trim() ?? narration;
}

export function narrationCorrectionDialogMarkup(): string {
  return `<dialog id="narration-correction-dialog" class="narration-correction-dialog" aria-labelledby="narration-correction-title" aria-describedby="narration-correction-overview"><form id="narration-correction-form"><header><h3 id="narration-correction-title" tabindex="-1">Correct narration</h3></header><div class="narration-correction-body"><section id="narration-correction-overview" class="narration-correction-overview"><p>This creates an append-only correction. It does not reopen or rewrite the completed turn.</p><ul><li>The original accepted narration remains preserved in the campaign ledger.</li><li>The corrected prose becomes the version shown in Story, Chronicle context, and readable exports.</li><li>The turn prompt, mechanics, campaign state, and turn order do not change. Existing illustrations may need to be rebuilt.</li></ul></section><label class="campaign-field"><span>Corrected narration</span><textarea name="narration" rows="18" minlength="1" maxlength="200000" required></textarea></label><p class="narration-correction-error" role="alert" hidden></p></div><footer><button type="button" data-dialog-close="narration-correction-dialog">Cancel</button><button class="primary-action" type="submit">Save correction</button></footer></form></dialog>`;
}

type CampaignStateInspector = Readonly<Record<string, unknown>>;

function stateFieldLabel(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}

function readableStateValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "None recorded";
  if (Array.isArray(value)) return value.map(readableStateValue).join("\n");
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${stateFieldLabel(key)}: ${readableStateValue(entry)}`)
      .join("\n");
  }
  return String(value);
}

function readonlyStateField(label: string, value: unknown, multiline = false): string {
  const content = readableStateValue(value);
  return multiline || content.length > 80 || content.includes("\n")
    ? `<label class="campaign-field"><span>${escapeCampaignText(label)}</span><textarea rows="${Math.min(10, Math.max(3, content.split("\n").length + 1))}" readonly>${escapeCampaignText(content)}</textarea></label>`
    : `<label class="campaign-field"><span>${escapeCampaignText(label)}</span><input readonly value="${escapeCampaignText(content)}"></label>`;
}

function stateCollection(title: string, value: unknown): string {
  const items = Array.isArray(value) ? value : [];
  if (!items.length) return `<section class="turn-state-group"><h4>${escapeCampaignText(title)}</h4><p class="turn-state-empty">None recorded.</p></section>`;
  return `<section class="turn-state-group"><h4>${escapeCampaignText(title)}</h4><div class="turn-state-records">${items.map((item, index) => {
    const entry: Record<string, unknown> = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : { value: item };
    const fields = Object.entries(entry).filter(([key]) => key !== "id");
    const name = String(entry.name ?? entry.label ?? `${title.replace(/s$/i, "")} ${index + 1}`);
    return `<fieldset><legend>${escapeCampaignText(name)}</legend><div class="turn-state-record-fields">${fields.map(([key, fieldValue]) => readonlyStateField(stateFieldLabel(key), fieldValue)).join("")}</div></fieldset>`;
  }).join("")}</div></section>`;
}

export function campaignStateInspectorMarkup(state: CampaignStateInspector): string {
  const viewedTurnNumber = Number(state.viewedTurnNumber ?? 0);
  const isCurrent = state.isCurrent === true;
  const campaignId = String(state.campaignId ?? "");
  const notice = isCurrent
    ? `<p>Current state after turn ${escapeCampaignText(viewedTurnNumber)}. Changes that affect future generations belong on the Current State page.</p><a class="primary-action" href="${campaignEditorPath(campaignId, "state")}">Edit current state</a>`
    : `<p>Historical state after turn ${escapeCampaignText(viewedTurnNumber)}. This saved snapshot is immutable and cannot be edited.</p>`;
  return `<div class="turn-state-inspector"><section class="turn-state-notice" data-state="${isCurrent ? "current" : "historical"}">${notice}</section><div class="turn-state-metadata">${readonlyStateField("Viewed turn", viewedTurnNumber)}${readonlyStateField("State revision", state.revision)}${readonlyStateField("Snapshot time", state.updatedAt)}</div><section class="turn-state-narrative"><h4>Narrative continuity</h4>${readonlyStateField("Continuity summary", state.continuitySummary, true)}${readonlyStateField("Open threads", state.openThreads, true)}${readonlyStateField("Canonical facts", state.canonicalFacts, true)}${readonlyStateField("Private continuity scratchpad", state.scratchpad, true)}</section>${stateCollection("Trackers", state.trackers)}${stateCollection("RPG stats", state.rpgStats)}${stateCollection("Event triggers", state.eventTriggers)}${stateCollection("Pending event triggers", state.pendingEventTriggers)}</div>`;
}

export interface CampaignActionButtonState {
  disabled: boolean;
  textContent: string | null;
  dataset: DOMStringMap;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export async function withCampaignActionState<T>(
  button: CampaignActionButtonState,
  workingLabel: string,
  action: () => Promise<T>,
): Promise<T> {
  const original = { disabled: button.disabled, label: button.textContent };
  button.disabled = true;
  button.textContent = workingLabel;
  button.dataset.state = "working";
  button.setAttribute("aria-busy", "true");
  try { return await action(); }
  finally {
    button.disabled = original.disabled;
    button.textContent = original.label;
    delete button.dataset.state;
    button.removeAttribute("aria-busy");
  }
}
