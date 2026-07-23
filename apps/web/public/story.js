/* ═══════════════════════════════════════════════════════════════
   Infinite Quest — Story Player
   ═══════════════════════════════════════════════════════════════ */
"use strict";

(function () {

// ── DOM Helpers ────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const escapeHtml = (text) => {
  if (!text) return "";
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
};
const escapeAttribute = (text) => escapeHtml(text).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const sanitizeNarration = (text) => {
  if (!text) return "";
  return text.split("\n")
    .filter(p => p.trim())
    .map(p => `<p>${escapeHtml(p)}</p>`)
    .join("");
};

// ── Constants ──────────────────────────────────────────────────
const POLL_INTERVAL_MS = 1000;
const MAX_POLLS = 900;
const IMAGE_POLL_MS = 5000;
const TOAST_DURATION = 3500;

// ── State ──────────────────────────────────────────────────────
const state = {
  campaignId: null,
  campaign: null,
  world: null,
  playerConfig: null,
  runtimeState: null,
  turns: [],
  viewIndex: -1,
  busy: false,
  providers: [],
  abortController: null,
  pendingGeneration: null,
  generationDisplayActive: false,
  generationDisplayAction: "",
  illustrationConfig: null,
  illustrationSegments: [],
  illustrationVariantIndexes: new Map(),
  illustrationSegmentActivity: new Map(),
  imagePollTimer: null,
  imageJobActivity: new Map(),
  imageActivityInitialized: false,
  activityLog: [],
  toastTimer: null,
  streamingAutoFollow: true,
  streamingExpectedScrollY: null,
  turnInputMode: "auto",
  nextTurnInputModeSource: null,
  pendingIntentDecision: null,
  historySelectedIndex: null,
  historyInspectionRequestId: 0,
  user: {
    id: null,
    systemKey: null,
    displayName: "Initial Owner",
    settings: {
      autoSubmitTurnChoices: true,
      continuousReading: false,
      defaultTurnControlStyle: "flexible_auto"
    }
  }
};

const modalBaselines = new WeakMap();
let discardModalTarget = null;

function modalFormSnapshot(dialog) {
  return [...dialog.querySelectorAll("input, select, textarea")].map((control) => {
    if (control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type)) {
      return `${control.id}:${control.checked}`;
    }
    return `${control.id}:${control.value}`;
  }).join("\u001f");
}

function openManagedModal(dialog) {
  if (!dialog || dialog.open || typeof dialog.showModal !== "function") return;
  modalBaselines.set(dialog, modalFormSnapshot(dialog));
  dialog.showModal();
}

function clickedDialogBackdrop(dialog, event) {
  const bounds = dialog.getBoundingClientRect();
  return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
}

function requestModalDismissal(dialog) {
  if (modalBaselines.get(dialog) !== modalFormSnapshot(dialog)) {
    discardModalTarget = dialog;
    openManagedModal($("discardChangesDialog"));
    return;
  }
  dialog.close();
}

function installClickAwayModalDismissal() {
  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (dialog.open && clickedDialogBackdrop(dialog, event)) requestModalDismissal(dialog);
    });
    dialog.addEventListener("close", () => modalBaselines.delete(dialog));
  });
  const discardDialog = $("discardChangesDialog");
  discardDialog.addEventListener("close", () => {
    if (discardDialog.returnValue === "discard" && discardModalTarget?.open) discardModalTarget.close();
    discardModalTarget = null;
  });
}

installClickAwayModalDismissal();

// ── API Layer ──────────────────────────────────────────────────
async function api(path, options = {}) {
  const url = "/api/v1" + path;
  const headers = { "Content-Type": "application/json" };
  if (options.headers) Object.assign(headers, options.headers);
  const response = await fetch(url, { ...options, cache: "no-store", headers });
  if (!response.ok) {
    let body = {};
    try { body = await response.json(); } catch (_) { /* ignore */ }
    const error = new Error(body.message || `Request failed (${response.status})`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  if (response.status === 204) return null;
  return response.json();
}

// ── Toast & Notifications ─────────────────────────────────────
function toast(msg, duration) {
  const el = $("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.remove("show"), duration || TOAST_DURATION);
}

function showBusy(msg) {
  state.busy = true;
  const el = $("llmWaitIndicator");
  const text = $("llmWaitIndicatorText");
  if (text) text.textContent = msg || "Working…";
  if (el) el.classList.add("show");
  const pill = $("busyPill");
  if (pill) { pill.textContent = "Busy"; pill.style.color = "var(--gold)"; }
  syncInputState();
}

function hideBusy() {
  state.busy = false;
  const el = $("llmWaitIndicator");
  if (el) el.classList.remove("show");
  const pill = $("busyPill");
  if (pill) { pill.textContent = "Ready"; pill.style.color = ""; }
  syncInputState();
}

function syncInputState() {
  const btnAction = $("btnTakeAction");
  const freeAction = $("freeAction");
  const generationLocked = state.busy || Boolean(state.pendingGeneration);
  const turnCount = state.turns ? state.turns.length : 0;
  const curr = state.viewIndex === -1 ? turnCount - 1 : state.viewIndex;
  const isLatest = state.viewIndex === -1 || state.viewIndex >= turnCount - 1;
  const storyInputLocked = generationLocked || !isLatest;
  if (btnAction) btnAction.disabled = storyInputLocked;
  if (freeAction) freeAction.disabled = storyInputLocked;
  document.querySelectorAll("[data-turn-input-mode]").forEach((button) => {
    button.disabled = storyInputLocked || campaignTurnControlStyle() === "action_only";
  });
  document.querySelectorAll("#choiceArea .choice").forEach(b => { b.disabled = storyInputLocked; });

  const btnPrev = $("btnPrev");
  const btnNext = $("btnNext");
  const btnUndo = $("btnUndo");
  const btnRetry = $("btnRetry");

  const lastTurnHasAction = turnCount > 0 && Boolean(state.turns[turnCount - 1] && state.turns[turnCount - 1].action);

  if (btnPrev) btnPrev.disabled = generationLocked || turnCount === 0 || curr <= 0;
  if (btnNext) btnNext.disabled = generationLocked || turnCount === 0 || isLatest;
  if (btnUndo) btnUndo.disabled = generationLocked || turnCount === 0 || !isLatest;
  if (btnRetry) btnRetry.disabled = generationLocked || turnCount === 0 || !isLatest || !lastTurnHasAction;
}

// ── Activity Log ──────────────────────────────────────────────
function recordActivity(category, title, detail) {
  state.activityLog.push({
    ts: new Date().toISOString(),
    category: category || "system",
    title: title || "",
    detail: detail || ""
  });
}

function renderActivityLog() {
  const list = $("activityLogList");
  if (!list) return;
  if (state.activityLog.length === 0) {
    list.innerHTML = `<div class="activity-log-empty">No activity recorded this session.</div>`;
    return;
  }
  list.innerHTML = state.activityLog.map((entry, i) => {
    const cls = entry.category === "error" ? "error" : entry.category === "success" ? "success" : "";
    return `<details class="activity-log-entry ${cls}">
      <summary>
        <span class="activity-log-time">${entry.ts.slice(11, 19)}</span>
        <span class="activity-log-category">${escapeHtml(entry.category)}</span>
        <span class="activity-log-title">${escapeHtml(entry.title)}</span>
        <span class="activity-log-operation">#${i + 1}</span>
      </summary>
      <div class="activity-log-details"><pre>${escapeHtml(entry.detail)}</pre></div>
    </details>`;
  }).reverse().join("");
}

function copyActivityDiagnostics() {
  const text = state.activityLog.map(e => `[${e.ts}] [${e.category}] ${e.title}\n${e.detail}`).join("\n\n");
  navigator.clipboard.writeText(text).then(() => toast("Diagnostics copied to clipboard."));
}

// ── Onboarding ────────────────────────────────────────────────
async function checkOnboarding() {
  try {
    const data = await api("/providers");
    state.providers = data.providers || [];
    const hasText = state.providers.some(p => p.providerRole === "text" || !p.providerRole);
    if (!hasText) {
      const dlg = $("gettingStartedDialog");
      openManagedModal(dlg);
    }
  } catch (err) {
    recordActivity("error", "Failed to load providers", err.message);
  }
}

// ── Campaign Loading ──────────────────────────────────────────
async function loadCampaign(campaignId, options = {}) {
  showBusy("Loading campaign…");
  try {
    const syncData = await api(`/campaigns/${campaignId}/sync-status`);
    state.campaign = syncData.campaign || syncData;
    state.world = syncData.world || state.campaign.world || null;
    state.playerConfig = syncData.playerConfig || state.campaign.playerConfig || null;
    state.pendingGeneration = syncData.pendingGeneration || null;
    syncTurnInputModeFromCampaign();

    const turnData = await api(`/campaigns/${campaignId}/turns`);
    state.turns = turnData.turns || [];
    state.runtimeState = await api(`/campaigns/${campaignId}/state`);
    try {
      state.illustrationConfig = await api(`/campaigns/${campaignId}/illustration-config`);
      const segmentData = await api(`/campaigns/${campaignId}/illustration-segments`);
      state.illustrationSegments = segmentData.segments || [];
    } catch (_) {
      state.illustrationConfig = { enabled: false, sourcePolicy: "off" };
      state.illustrationSegments = [];
    }

    // Set title
    const titleEl = $("storyTitle");
    const name = state.campaign.title || state.world?.title || "Untitled Campaign";
    if (titleEl) titleEl.textContent = name;
    document.title = `${name} — Infinite Quest`;

    state.viewIndex = -1;
    renderAllScenes({ autoScroll: options.autoScroll });
    updateStatusBar();

    // Show latest choices if available
    if (state.turns.length > 0) {
      const last = state.turns[state.turns.length - 1];
      renderChoices(last.choices || [], last.customActionSuggestion || "");
    } else {
      renderChoices([firstActionForNewAdventure()], firstActionForNewAdventure());
    }

    recordActivity("system", "Campaign loaded", `${state.turns.length} turns loaded for "${name}".`);
  } catch (err) {
    toast(`Error loading campaign: ${err.message}`);
    recordActivity("error", "Campaign load failed", err.message);
  } finally {
    hideBusy();
  }
}

function firstActionForNewAdventure() {
  return String(state.world?.firstAction || "").trim() || "Begin the adventure.";
}

async function showBackgroundStoryBeforeStart() {
  const background = String(state.world?.backgroundStory || "").trim();
  if (!background) return false;
  const dialog = $("messagePopupDialog");
  const titleEl = $("messagePopupTitle");
  const bodyEl = $("messagePopupBody");
  if (!dialog || !titleEl || !bodyEl || typeof dialog.showModal !== "function") {
    return false;
  }
  try {
    if (dialog.open) dialog.close();
  } catch (_) {}
  return new Promise((resolve) => {
    const done = () => {
      dialog.removeEventListener("close", done);
      resolve(true);
    };
    titleEl.textContent = "Background Story";
    bodyEl.textContent = background;
    dialog.addEventListener("close", done, { once: true });
    try {
      openManagedModal(dialog);
    } catch (err) {
      dialog.removeEventListener("close", done);
      resolve(false);
    }
  });
}

async function startAdventure(options = {}) {
  if (state.busy) return;
  await showBackgroundStoryBeforeStart();
  await runGeneration(firstActionForNewAdventure(), {
    requestedInputMode: "action",
    resolvedInputMode: "action",
    inputModeSource: "opening_action"
  });
}


// ── Cost Formatting ───────────────────────────────────────────
function formatReportedCost(cost) {
  if (!cost || typeof cost !== "object") return "";
  const amount = Number(cost.amount);
  const currency = String(cost.currency || "").toUpperCase();
  if (!Number.isFinite(amount) || amount < 0 || !/^[A-Z]{3}$/.test(currency)) return "";
  if (amount > 0 && amount < 0.0001) return `<${new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(0.0001)}`;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: 4,
    maximumFractionDigits: 4
  }).format(amount);
}

function reportedCostTooltip(cost) {
  const labels = { story: "Story", image: "Images", memory: "Semantic memory" };
  const details = Object.entries(cost?.byCategory || {})
    .filter(([, amount]) => Number(amount) > 0)
    .map(([category, amount]) => `${labels[category] || category}: ${formatReportedCost({ amount, currency: cost.currency })}`);
  return [`Provider-reported generation cost: ${formatReportedCost(cost)}`, ...details].join(" · ");
}

// ── Scene Rendering ───────────────────────────────────────────
function renderScene(turn, index) {
  const sceneDiv = document.createElement("div");
  sceneDiv.className = "scene";
  sceneDiv.id = `scene-${index}`;
  sceneDiv.dataset.turnNumber = index + 1;

  // Narration column
  let narrationHtml = "";

  // Action tag (what the player did)
  const isPendingReplacement = index === state.turns.length - 1
    && state.pendingGeneration?.operationKind === "replace_latest";
  if (isPendingReplacement) {
    narrationHtml += `<div class="replacement-pending-banner" role="status">
      <strong>Replacement in progress</strong>
      <span>The accepted turn is preserved until its replacement is validated.</span>
    </div>`;
  }

  if (turn.action) {
    const reportedCost = formatReportedCost(turn.reportedCost);
    const reportedCostHtml = reportedCost
      ? `<span class="pill turn-cost-pill" title="${escapeHtml(reportedCostTooltip(turn.reportedCost))}">${escapeHtml(reportedCost)}</span>`
      : "";

    narrationHtml += `<div class="turn-meta">
      <div class="action-tag">➜ ${escapeHtml(turn.action)}</div>
      <span class="pill">Turn ${index + 1}</span>
      ${reportedCostHtml}
    </div>`;
  }

  // RPG roll results
  if (turn.roll || turn.mechanics?.roll) {
    const roll = turn.roll || turn.mechanics.roll;
    const passed = roll.passed !== undefined ? roll.passed : (roll.roll <= roll.target);
    narrationHtml += `<details class="roll-disclosure">
      <summary>🎲 ${escapeHtml(roll.statName || roll.stat_id || "Check")} — d100: ${roll.roll} vs ${roll.target} — ${passed ? "✓ Success" : "✗ Setback"}</summary>
      <div class="roll-disclosure-body">
        <div class="roll-card ${passed ? "success" : "failure"}">
          <strong class="${passed ? "success-text" : "failure-text"}">${passed ? "Favorable Outcome" : "Setback"}</strong>
          <p>${escapeHtml(passed ? (roll.favorableOutcome || roll.favorable_outcome || "") : (roll.setbackOutcome || roll.setback_outcome || ""))}</p>
          ${roll.rationale ? `<p class="mini dim">${escapeHtml(roll.rationale)}</p>` : ""}
        </div>
      </div>
    </details>`;
  }

  // Before-event trigger text
  if (turn.mechanics?.beforeEvents?.length) {
    turn.mechanics.beforeEvents.forEach(evt => {
      narrationHtml += `<div class="action-tag" style="border-color:rgba(116,228,255,.3);color:var(--accent2);">⚡ ${escapeHtml(evt.name || evt.label || "Event")} — ${escapeHtml(evt.text || evt.effect || "")}</div>`;
    });
  }

  // Narration text
  if (turn.narration) {
    const turnId = turn.id || turn.turnId || "";
    const segments = state.illustrationSegments
      .filter((segment) => segment.turnId === turnId)
      .sort((left, right) => left.ordinal - right.ordinal);
    narrationHtml += segments.length && illustrationsEnabled()
      ? `<div class="narration segmented-narration">${segments.map((segment) => `
          <section class="narration-segment" data-illustration-segment-id="${escapeHtml(segment.id)}"
            data-turn-id="${escapeHtml(turnId)}" aria-label="Illustration segment ${segment.ordinal + 1}">
            <div class="narration-segment-copy">${sanitizeNarration(segment.text)}</div>
            <aside class="segment-illustration-slot" aria-label="Illustration for segment ${segment.ordinal + 1}">
              <div class="segment-illustration-sticky">
                <div class="story-illustration-heading">
                  <span>Illustration</span>
                  <span class="pill">Turn ${index + 1}</span>
                </div>
                <div class="segment-illustration-content" data-segment-id="${escapeHtml(segment.id)}">
                  ${segmentIllustrationMarkup(turn, index, segment, segments.length)}
                </div>
              </div>
            </aside>
          </section>`).join("")}</div>`
      : `<div class="narration">${sanitizeNarration(turn.narration)}</div>`;
  }

  // After-event trigger text
  if (turn.mechanics?.afterEvents?.length) {
    turn.mechanics.afterEvents.forEach(evt => {
      narrationHtml += `<div class="action-tag" style="border-color:rgba(116,228,255,.3);color:var(--accent2);">⚡ ${escapeHtml(evt.name || evt.label || "Event")} — ${escapeHtml(evt.text || evt.effect || "")}</div>`;
    });
  }

  sceneDiv.innerHTML = `<div class="scene-narration">${narrationHtml}</div>`;
  return sceneDiv;
}

function viewedTurnIndex() {
  return state.viewIndex === -1 ? state.turns.length - 1 : state.viewIndex;
}

function illustrationsEnabled() {
  return Boolean(state.illustrationConfig?.enabled)
    && state.illustrationConfig?.sourcePolicy !== "off";
}

function illustrationSegmentsForTurn(turnId) {
  return state.illustrationSegments
    .filter((segment) => segment.turnId === turnId)
    .sort((left, right) => left.ordinal - right.ordinal);
}

function segmentStatusLabel(segment) {
  if (!segment) return "";
  if (segment.promptJobStatus === "refining") return "Refining illustration prompt…";
  if (segment.promptSource === "ai_fallback" && !segment.variants?.length) return "Prompt refinement fell back to accepted segment text.";
  if (segment.imageJobStatus === "recoverable" || segment.imageJobStatus === "failed") {
    return segment.errorMessage || "Illustration generation needs attention.";
  }
  if (["queued", "generating", "provider_pending", "downloading"].includes(segment.imageJobStatus)) {
    const progress = Number(segment.providerProgress);
    return `Creating illustration${Number.isFinite(progress) ? ` · ${Math.round(progress)}%` : ""}`;
  }
  if (segment.status === "refining") return "Waiting for prompt refinement…";
  if (!segment.variants?.length) return "Illustration is queued for this segment.";
  return "";
}

function segmentIllustrationMarkup(turn, turnIndex, segment, segmentCount) {
  const turnId = turn.id || turn.turnId || "";
  const variants = Array.isArray(segment.variants) ? segment.variants : [];
  const selectedIndex = Math.min(state.illustrationVariantIndexes.get(segment.id) || 0, Math.max(variants.length - 1, 0));
  const selected = variants[selectedIndex];
  const selectedVariantIndex = selected?.variantIndex ?? selectedIndex;
  const status = segmentStatusLabel(segment);
  const isCurrentTurn = turnIndex === state.turns.length - 1;
  return `<div class="segment-illustration-card">
    <div class="image-wrap${selected ? "" : " image-job-placeholder"}">
    ${selected
      ? `<img src="${escapeHtml(selected.url)}" alt="Illustration ${selectedIndex + 1} for turn ${turnIndex + 1}, segment ${segment.ordinal + 1}" loading="lazy" />`
      : `<div class="image-placeholder">${escapeHtml(status || "No illustration is available for this segment yet.")}</div>`}
    ${variants.length > 1 ? `<div class="illustration-carousel" aria-label="Illustration variants">
      <button class="small ghost" type="button" data-action="previous-segment-image" data-segment-id="${escapeHtml(segment.id)}" aria-label="Previous illustration">←</button>
      <span>${selectedIndex + 1} / ${variants.length}</span>
      <button class="small ghost" type="button" data-action="next-segment-image" data-segment-id="${escapeHtml(segment.id)}" aria-label="Next illustration">→</button>
    </div>` : ""}
    ${status && selected ? `<div class="image-job-status image-job-overlay"><p>${escapeHtml(status)}</p></div>` : ""}
    <div class="segment-illustration-meta">
      <span>Segment ${segment.ordinal + 1} of ${segmentCount}</span>
      <span>${segment.endWord - segment.startWord} words</span>
      ${segment.promptSource === "ai_fallback" ? "<span>Direct fallback</span>" : ""}
    </div>
    </div>
    ${isCurrentTurn ? `<div class="segment-image-controls" aria-label="Controls for this current-turn illustration">
      <button class="small ghost segment-image-icon" type="button" data-action="edit-segment-image-prompt"
        data-segment-id="${escapeHtml(segment.id)}" data-variant-index="${selectedVariantIndex}"
        title="Preview or edit this image prompt" aria-label="Preview or edit this image prompt">✏️</button>
      <button class="small ghost segment-image-icon" type="button" data-action="regenerate-segment-image"
        data-segment-id="${escapeHtml(segment.id)}" data-variant-index="${selectedVariantIndex}"
        title="Regenerate only this image" aria-label="Regenerate only this image">🖼️</button>
      <button class="small ghost segment-image-icon" type="button" data-action="why-segment-image"
        data-segment-id="${escapeHtml(segment.id)}" data-variant-index="${selectedVariantIndex}"
        title="Why this image?" aria-label="Why this image?">?</button>
    </div>` : `<div class="segment-history-image-controls">
      <button class="small ghost" type="button" data-turn-id="${escapeHtml(turnId)}"
        data-action="rebuild-turn-segments">Rebuild this past turn</button>
    </div>`}
  </div>`;
}

function renderStoryIllustration() {
  const layout = $("appLayout");
  const panel = $("storyIllustrationPanel");
  const content = $("storyIllustrationContent");
  const turnLabel = $("storyIllustrationTurn");
  const turnIndex = viewedTurnIndex();
  const turn = state.turns[turnIndex];
  const visible = illustrationsEnabled() && !state.generationDisplayActive && Boolean(turn);
  if (!layout || !panel || !content) return;

  const inlineContents = [...document.querySelectorAll(".segment-illustration-content[data-segment-id]")];
  inlineContents.forEach((segmentContent) => {
    const segment = state.illustrationSegments.find((item) => item.id === segmentContent.dataset.segmentId);
    if (!segment) return;
    const segmentTurnIndex = state.turns.findIndex((item) => (item.id || item.turnId) === segment.turnId);
    const segmentTurn = state.turns[segmentTurnIndex];
    if (!segmentTurn) return;
    segmentContent.innerHTML = segmentIllustrationMarkup(
      segmentTurn,
      segmentTurnIndex,
      segment,
      illustrationSegmentsForTurn(segment.turnId).length
    );
  });

  const inlineVisible = visible && inlineContents.length > 0;
  const panelVisible = visible && !inlineVisible;
  layout.classList.toggle("has-illustration", panelVisible);
  layout.classList.toggle("has-segmented-illustrations", inlineVisible);
  panel.classList.toggle("hidden", !panelVisible);
  if (!visible) {
    content.replaceChildren();
    return;
  }
  if (inlineVisible) {
    content.replaceChildren();
    return;
  }

  if (turnLabel) turnLabel.textContent = `Turn ${turnIndex + 1}`;
  const turnId = turn.id || turn.turnId || "";
  content.innerHTML = `<div class="image-wrap image-job-placeholder">
    <div class="image-placeholder">This accepted turn has no illustration segments yet.</div>
    <button class="small primary" type="button" data-turn-id="${escapeHtml(turnId)}" data-action="generate-turn-segments">Generate illustrations for this turn</button>
  </div>`;
}

function renderAllScenes(options = {}) {
  const container = $("storyArea");
  if (!container) return;

  container.innerHTML = "";

  if (state.generationDisplayActive) {
    renderStreamingPreview("", state.pendingGeneration?.action || state.generationDisplayAction);
    renderStoryIllustration();
    return;
  }

  if (state.turns.length === 0) {
    const worldName = state.world?.title || state.campaign?.title || "";
    const character = state.world?.character || state.campaign?.character || "";
    const premise = state.world?.premise || state.campaign?.premise || "";
    container.innerHTML = `<div class="empty">
      <div>
        <div style="font-size:3rem;margin-bottom:10px;">🗝️</div>
        <h2 style="margin:0 0 8px;color:#fff;">${worldName ? escapeHtml(worldName) : "Create a world, then begin."}</h2>
        ${character ? `<p style="max-width:620px;margin:4px auto;line-height:1.55;"><strong style="color:var(--gold);">Character:</strong> ${escapeHtml(character)}</p>` : ""}
        ${premise ? `<p style="max-width:620px;margin:4px auto;line-height:1.55;">${escapeHtml(premise)}</p>` : ""}
        <p style="max-width:620px;margin:8px auto 0;line-height:1.55;color:var(--dim);">Type an action or choose from generated options to begin your adventure.</p>
      </div>
    </div>`;
    renderStoryIllustration();
    return;
  }

  const isContinuous = Boolean(state.user?.settings?.continuousReading);
  if (isContinuous) {
    for (let i = 0; i < state.turns.length; i++) {
      container.appendChild(renderScene(state.turns[i], i));
    }
  } else {
    const targetIndex = state.viewIndex === -1 ? state.turns.length - 1 : state.viewIndex;
    if (state.turns[targetIndex]) {
      container.appendChild(renderScene(state.turns[targetIndex], targetIndex));
    }
  }

  renderStoryIllustration();
  if (options.autoScroll !== false) scrollToView();
}

function scrollToView() {
  const container = $("storyArea");
  if (!container) return;
  const isLatest = state.viewIndex === -1;
  const isContinuous = Boolean(state.user?.settings?.continuousReading);
  if (isLatest) {
    const last = container.lastElementChild;
    if (last) last.scrollIntoView({ behavior: "smooth", block: "start" });
  } else {
    const target = $(`scene-${state.viewIndex}`);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (!isContinuous) {
      const first = container.firstElementChild;
      if (first) first.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }
}

// ── Player Input ──────────────────────────────────────────────
function campaignTurnControlStyle() {
  return state.campaign?.turnControlStyle || "flexible_auto";
}

function defaultTurnInputMode() {
  const style = campaignTurnControlStyle();
  if (style === "flexible_auto") return "auto";
  if (style === "flexible_scene") return "scene";
  return "action";
}

function preferredAutoFallback() {
  return ["flexible_auto", "flexible_scene"].includes(campaignTurnControlStyle()) ? "scene" : "action";
}

function turnInputCopy(mode) {
  if (mode === "scene") {
    return {
      label: "Describe the scene events and details that must happen",
      help: "Scene direction treats concrete events and details as required facts to dramatize before the story advances.",
      button: "➜ Direct scene",
      placeholder: "Describe the events, dialogue, atmosphere, and details that must appear in the next scene..."
    };
  }
  if (mode === "action") {
    return {
      label: "Describe what your character tries to do",
      help: "Action expresses an attempt or intention. The Story Engine decides uncertain outcomes and writes what follows.",
      button: "➜ Take action",
      placeholder: "Describe an action, decision, or dialogue for your character..."
    };
  }
  return {
    label: "Describe what you want to do or what happens next",
    help: "Auto decides whether your prompt is an attempted action or scene direction immediately before submission.",
    button: "➜ Continue story",
    placeholder: "Describe an action, dialogue, or the scene events and details that should happen..."
  };
}

function updateTurnInputCharacterCount() {
  const freeAction = $("freeAction");
  const counter = $("turnInputCount");
  if (freeAction && counter) counter.textContent = `${freeAction.value.length.toLocaleString()} / 12,000`;
}

function clearTurnIntentDecision() {
  state.pendingIntentDecision = null;
  const panel = $("turnIntentDecision");
  if (panel) panel.classList.add("hidden");
}

function setTurnInputMode(mode, options = {}) {
  const locked = campaignTurnControlStyle() === "action_only";
  state.turnInputMode = locked ? "action" : (["auto", "action", "scene"].includes(mode) ? mode : defaultTurnInputMode());
  document.querySelectorAll("[data-turn-input-mode]").forEach((button) => {
    const selected = button.dataset.turnInputMode === state.turnInputMode;
    button.setAttribute("aria-checked", String(selected));
    button.disabled = locked || state.busy || Boolean(state.pendingGeneration);
  });
  const selector = $("turnInputModeSelector");
  const lock = $("turnInputModeLock");
  if (selector) selector.classList.toggle("hidden", locked);
  if (lock) lock.classList.toggle("hidden", !locked);
  const copy = turnInputCopy(state.turnInputMode);
  const label = $("turnInputLabel");
  const help = $("turnInputHelp");
  const button = $("btnTakeAction");
  const freeAction = $("freeAction");
  if (label) label.textContent = copy.label;
  if (help) help.textContent = copy.help;
  if (button) button.textContent = copy.button;
  if (freeAction && (options.refreshPlaceholder || !freeAction.placeholder)) freeAction.placeholder = copy.placeholder;
  clearTurnIntentDecision();
}

function syncTurnInputModeFromCampaign() {
  setTurnInputMode(defaultTurnInputMode(), { refreshPlaceholder: true });
  updateTurnInputCharacterCount();
}

function renderChoices(choices, customSuggestion) {
  const container = $("choiceArea");
  if (!container) return;
  container.innerHTML = "";
  if (choices && choices.length) {
    choices.forEach(text => {
      const btn = document.createElement("button");
      btn.className = "choice";
      btn.type = "button";
      btn.textContent = text;
      btn.addEventListener("click", () => {
        const autoSubmit = state.user?.settings?.autoSubmitTurnChoices !== false;
        if (autoSubmit) {
          setTurnInputMode("action", { refreshPlaceholder: true });
          state.nextTurnInputModeSource = "generated_choice";
          submitAction(text);
        } else {
          const freeAction = $("freeAction");
          if (freeAction) {
            setTurnInputMode("action", { refreshPlaceholder: true });
            freeAction.value = text;
            freeAction.focus();
            updateTurnInputCharacterCount();
          }
          toast("Loaded choice into action box for editing.", 2400);
        }
      });
      container.appendChild(btn);
    });
  }
  const freeAction = $("freeAction");
  if (freeAction && customSuggestion) {
    freeAction.placeholder = state.turnInputMode === "action" ? customSuggestion : turnInputCopy(state.turnInputMode).placeholder;
  }
}

function showAmbiguousTurnIntent(action, classification) {
  state.pendingIntentDecision = { action, classification };
  const panel = $("turnIntentDecision");
  const message = $("turnIntentDecisionMessage");
  if (message) {
    const label = classification.classification === "mixed" ? "both an action and required scene events" : "an uncertain intent";
    message.textContent = `Auto found ${label}. Choose how the Story Engine should interpret this turn.`;
  }
  if (panel) panel.classList.remove("hidden");
}

async function classifyTurnInput(action) {
  try {
    return await api(`/campaigns/${state.campaignId}/turn-input/classify`, {
      method: "POST",
      body: JSON.stringify({ text: action, preferredFallback: preferredAutoFallback() })
    });
  } catch (error) {
    const resolvedMode = preferredAutoFallback();
    toast(`Auto classification was unavailable; using ${resolvedMode === "scene" ? "Scene direction" : "Action"}.`, 4200);
    recordActivity("error", "Turn intent classification unavailable", error.message);
    return { classification: "uncertain", confidenceBand: "probable", resolvedMode, providerSource: "fallback" };
  }
}

async function submitResolvedTurn(action, details) {
  const freeAction = $("freeAction");
  if (freeAction) freeAction.value = "";
  updateTurnInputCharacterCount();
  clearTurnIntentDecision();
  await runGeneration(action, details);
}

async function submitAction(actionText, options = {}) {
  if (state.busy) return;
  let action = (actionText || "").trim();
  if (!action && state.turns.length === 0) {
    action = firstActionForNewAdventure();
  }
  if (!action) { toast("Enter an action first."); return; }
  const requestedInputMode = options.requestedInputMode || state.turnInputMode;
  const inputModeSource = options.inputModeSource || state.nextTurnInputModeSource || (requestedInputMode === "auto" ? "auto" : "explicit");
  state.nextTurnInputModeSource = null;
  if (requestedInputMode !== "auto") {
    await submitResolvedTurn(action, { requestedInputMode, resolvedInputMode: requestedInputMode, inputModeSource });
    return;
  }
  showBusy("Determining how to interpret this turn…");
  let classification;
  try {
    classification = await classifyTurnInput(action);
  } finally {
    hideBusy();
  }
  if ($("freeAction") && $("freeAction").value.trim() !== action) {
    toast("The prompt changed while Auto was deciding. Review it and submit again.");
    return;
  }
  if (classification.confidenceBand === "ambiguous" || classification.classification === "mixed") {
    showAmbiguousTurnIntent(action, classification);
    return;
  }
  await submitResolvedTurn(action, {
    requestedInputMode: classification.classificationId ? "auto" : classification.resolvedMode,
    resolvedInputMode: classification.resolvedMode,
    inputModeSource: classification.classificationId ? "auto" : "fallback",
    classificationId: classification.classificationId
  });
}

// ── Generation Pipeline ───────────────────────────────────────
function pendingSubmissionStorageKey() {
  return state.campaignId ? `infiniteQuestPendingGeneration:${state.campaignId}` : "";
}

function savePendingSubmission(submission) {
  const key = pendingSubmissionStorageKey();
  if (key) localStorage.setItem(key, JSON.stringify(submission));
}

function loadPendingSubmission() {
  const key = pendingSubmissionStorageKey();
  if (!key) return null;
  try {
    const submission = JSON.parse(localStorage.getItem(key) || "null");
    if (!submission || typeof submission !== "object") return null;
    if (!Number.isFinite(Number(submission.createdAt)) || Date.now() - Number(submission.createdAt) > 15 * 60 * 1000) return null;
    return submission;
  } catch (_) {
    return null;
  }
}

function clearPendingSubmission() {
  const key = pendingSubmissionStorageKey();
  if (key) localStorage.removeItem(key);
}

function pendingGenerationFromError(error) {
  return error?.body?.details?.pendingGeneration || null;
}

function pendingGenerationMatches(pending, submission) {
  return Boolean(pending
    && pending.action === submission.action
    && pending.operationKind === submission.operationKind
    && Number(pending.expectedTurnNumber) === Number(submission.expectedTurnNumber));
}

async function enqueueGenerationSubmission(submission) {
  const endpoint = submission.operationKind === "replace_latest"
    ? `/campaigns/${state.campaignId}/generations/retry-latest`
    : `/campaigns/${state.campaignId}/generations`;
  const payload = {
    action: submission.action,
    requestedInputMode: submission.requestedInputMode,
    resolvedInputMode: submission.resolvedInputMode,
    inputModeSource: submission.inputModeSource,
    ...(submission.classificationId ? { classificationId: submission.classificationId } : {}),
    idempotencyKey: submission.idempotencyKey,
    context: submission.context,
    ...(submission.operationKind === "replace_latest"
      ? { expectedCurrentTurnNumber: submission.expectedTurnNumber }
      : {})
  };
  try {
    return await api(endpoint, {
      method: "POST",
      body: JSON.stringify(payload),
      signal: state.abortController.signal
    });
  } catch (error) {
    const reportedPending = pendingGenerationFromError(error);
    if (pendingGenerationMatches(reportedPending, submission)) return reportedPending;
    if (error.name === "AbortError") throw error;

    try {
      const syncData = await api(`/campaigns/${state.campaignId}/sync-status`);
      if (pendingGenerationMatches(syncData.pendingGeneration, submission)) return syncData.pendingGeneration;
      if (syncData.pendingGeneration) {
        throw Object.assign(new Error("Another story generation is already active."), {
          status: 409,
          pendingGeneration: syncData.pendingGeneration
        });
      }
    } catch (reconcileError) {
      if (reconcileError.status === 409 || reconcileError.pendingGeneration) throw reconcileError;
      if (error.status) throw error;
    }

    // Replaying the exact request is safe because the server keys it by campaign and idempotency key.
    return api(endpoint, {
      method: "POST",
      body: JSON.stringify(payload),
      signal: state.abortController.signal
    });
  }
}

async function runGeneration(action, options = {}) {
  showBusy("Queueing turn with the Story Engine…");
  state.abortController = new AbortController();
  const progressEl = $("generationProgress");
  if (progressEl) progressEl.classList.remove("hidden");

  try {
    const operationKind = options.operationKind || "append";
    const expectedTurnNumber = operationKind === "replace_latest"
      ? Number(options.expectedCurrentTurnNumber)
      : state.turns.length + 1;
    const submission = {
      action,
      requestedInputMode: options.requestedInputMode || "action",
      resolvedInputMode: options.resolvedInputMode || "action",
      inputModeSource: options.inputModeSource || "explicit",
      ...(options.classificationId ? { classificationId: options.classificationId } : {}),
      operationKind,
      expectedTurnNumber,
      idempotencyKey: options.idempotencyKey || crypto.randomUUID(),
      createdAt: Number(options.createdAt) || Date.now(),
      context: {
        budgetTokens: 32000,
        compression: "auto",
        recentTurns: 8
      }
    };
    savePendingSubmission(submission);
    recordActivity("generation", "Generation queued", `Action: "${action}"`);
    beginGenerationDisplay(action);

    const jobRes = await enqueueGenerationSubmission(submission);

    const jobId = jobRes.id || jobRes.jobId;
    if (!jobId) throw new Error("No job ID returned from generation request.");

    state.pendingGeneration = { ...jobRes, id: jobId, action, operationKind, expectedTurnNumber };
    await pollGenerationJob(jobId, action);
  } catch (err) {
    if (err.pendingGeneration) state.pendingGeneration = err.pendingGeneration;
    restoreGenerationDisplay();
    if (err.name === "AbortError") {
      toast("Generation cancelled.");
      recordActivity("system", "Generation cancelled");
    } else {
      const preserved = options.operationKind === "replace_latest" ? " The original turn was preserved." : "";
      toast(`Generation failed: ${err.message}${preserved}`);
      recordActivity("error", "Generation failed", err.message);
    }
  } finally {
    clearStreamingPreview();
    if (progressEl) progressEl.classList.add("hidden");
    hideBusy();
    state.abortController = null;
  }
}

function renderStreamingPreview(narrationText, action) {
  const container = $("storyArea");
  if (!container) return;

  const emptyEl = container.querySelector(".empty");
  if (emptyEl) emptyEl.remove();

  let card = $("streamingPreviewCard");
  const isNewPreview = !card;
  if (!card) {
    card = document.createElement("div");
    card.id = "streamingPreviewCard";
    card.className = "scene no-image turn-streaming-preview";
    container.appendChild(card);
    const actionText = action || "Generating turn...";
    card.innerHTML = `
      <div class="scene-narration">
        <div class="turn-streaming-header">
          <span class="turn-streaming-badge"><span class="turn-streaming-pulse"></span> Streaming Live</span>
          <button type="button" class="streaming-follow-button hidden" data-action="follow-stream" aria-label="Resume following live narration">Follow live</button>
        </div>
        <div class="turn-meta">
          <div class="action-tag">➜ ${escapeHtml(actionText)}</div>
        </div>
        <div class="narration streaming-narration"></div>
      </div>
    `;
  }

  const narration = card.querySelector(".streaming-narration");
  if (narration) {
    narration.innerHTML = `${sanitizeNarration(narrationText)}<span class="streaming-cursor" title="Receiving live tokens..."></span>`;
  }

  if (isNewPreview) {
    state.streamingAutoFollow = true;
    card.scrollIntoView({ behavior: "auto", block: "start" });
    state.streamingExpectedScrollY = window.scrollY;
  } else if (state.streamingAutoFollow) {
    followStreamingPreview();
  }
}

function followStreamingPreview() {
  const card = $("streamingPreviewCard");
  if (!card) return;
  state.streamingAutoFollow = true;
  const button = card.querySelector('[data-action="follow-stream"]');
  if (button) button.classList.add("hidden");
  const cursor = card.querySelector(".streaming-cursor");
  if (cursor) {
    cursor.scrollIntoView({ behavior: "auto", block: "end" });
    state.streamingExpectedScrollY = window.scrollY;
  }
}

function pauseStreamingAutoFollow() {
  if (!state.streamingAutoFollow) return;
  const card = $("streamingPreviewCard");
  if (!card) return;
  state.streamingAutoFollow = false;
  state.streamingExpectedScrollY = null;
  const button = card.querySelector('[data-action="follow-stream"]');
  if (button) button.classList.remove("hidden");
}

function clearStreamingPreview() {
  const card = $("streamingPreviewCard");
  if (card) card.remove();
  state.streamingAutoFollow = true;
  state.streamingExpectedScrollY = null;
}

function beginGenerationDisplay(action) {
  state.generationDisplayActive = true;
  state.generationDisplayAction = action || "";
  const container = $("storyArea");
  if (container) container.replaceChildren();
  renderStoryIllustration();
  renderStreamingPreview("", state.generationDisplayAction);
}

function restoreGenerationDisplay() {
  state.generationDisplayActive = false;
  state.generationDisplayAction = "";
  clearStreamingPreview();
  renderAllScenes({ autoScroll: false });
}

function commitGenerationDisplay() {
  state.generationDisplayActive = false;
  state.generationDisplayAction = "";
}

function showGenerationRecovery(jobId, message) {
  const panel = $("generationRecoveryPanel");
  const messageEl = $("generationRecoveryMessage");
  if (panel) {
    panel.dataset.jobId = jobId;
    panel.classList.remove("hidden");
  }
  if (messageEl) messageEl.textContent = message || "The durable generation needs attention.";
}

function hideGenerationRecovery() {
  const panel = $("generationRecoveryPanel");
  if (panel) {
    panel.dataset.jobId = "";
    panel.classList.add("hidden");
  }
}

async function monitorRecoveryJob(retryFirst) {
  const panel = $("generationRecoveryPanel");
  const jobId = panel?.dataset.jobId || state.pendingGeneration?.id;
  if (!jobId || state.busy) return;
  hideGenerationRecovery();
  showBusy(retryFirst ? "Retrying durable generation…" : "Resuming generation monitoring…");
  try {
    if (retryFirst) await api(`/generation-jobs/${jobId}/retry`, { method: "POST", body: "{}" });
    beginGenerationDisplay(state.pendingGeneration?.action || "");
    await pollGenerationJob(jobId, state.pendingGeneration?.action || "");
  } catch (error) {
    restoreGenerationDisplay();
    toast(`Generation recovery failed: ${error.message}`);
  } finally {
    hideBusy();
  }
}

async function discardRecoveryJob() {
  const panel = $("generationRecoveryPanel");
  const jobId = panel?.dataset.jobId || state.pendingGeneration?.id;
  if (!jobId || state.busy) return;
  showBusy("Discarding generation job…");
  try {
    await api(`/generation-jobs/${jobId}/discard`, { method: "POST", body: "{}" });
    clearPendingSubmission();
    state.pendingGeneration = null;
    hideGenerationRecovery();
    restoreGenerationDisplay();
    toast("Generation job discarded. The accepted turn was preserved.");
  } catch (error) {
    toast(`Could not discard generation: ${error.message}`);
  } finally {
    hideBusy();
  }
}

async function finalizeCompletedGeneration(result) {
  const preserveViewport = Boolean($("streamingPreviewCard")) && !state.streamingAutoFollow;
  const viewport = preserveViewport
    ? { left: window.scrollX, top: window.scrollY }
    : null;

  clearPendingSubmission();
  state.pendingGeneration = null;
  commitGenerationDisplay();
  recordActivity("success", "Turn generated", `Turn ${result.turnNumber || ""} completed.`);
  clearStreamingPreview();
  await loadCampaign(state.campaignId, { autoScroll: !preserveViewport });
  if (result.resultTurnId && !state.turns.some((turn) => turn.id === result.resultTurnId)) {
    const completedTurn = { ...result, id: result.resultTurnId };
    state.turns = state.turns
      .filter((turn) => Number(turn.turnNumber) !== Number(result.turnNumber))
      .concat(completedTurn)
      .sort((left, right) => Number(left.turnNumber) - Number(right.turnNumber));
    state.viewIndex = -1;
    renderAllScenes({ autoScroll: !preserveViewport });
    renderChoices(completedTurn.choices || [], completedTurn.customActionSuggestion || "");
    recordActivity("system", "Completed turn applied from generation result", `Turn ${result.turnNumber || ""} was applied while campaign state caught up.`);
  }

  if (viewport) {
    window.requestAnimationFrame(() => {
      window.scrollTo({ ...viewport, behavior: "auto" });
    });
  }

  pollImageJobs();
  if (result.resultTurnId) void pollIllustrationResolution(result.resultTurnId).catch(() => undefined);
}

async function pollGenerationJob(jobId, action) {
  let retriesUsed = 0;
  if (!state.generationDisplayActive) beginGenerationDisplay(action);
  else renderStreamingPreview("", action || state.generationDisplayAction);

  const handleJobUpdate = async (job) => {
    updateGenerationProgress(job);
    if (job.partialNarration) {
      renderStreamingPreview(job.partialNarration, action || job.action);
    } else if (job.partialOutput && typeof job.partialOutput === "string") {
      try {
        const match = job.partialOutput.match(/"narration"\s*:\s*"((?:[^"\\]|\\.)*)/);
        if (match && match[1]) {
          const unescaped = match[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
          renderStreamingPreview(unescaped, action || job.action);
        }
      } catch (_) {}
    }
  };

  if (typeof window.EventSource === "function") {
    try {
      const streamCompleted = await new Promise((resolve, reject) => {
        let isResolved = false;
        const es = new EventSource(`/api/v1/generation-jobs/${jobId}/stream`);

        const cleanup = () => {
          if (!isResolved) {
            isResolved = true;
            es.close();
          }
        };

        if (state.abortController) {
          state.abortController.signal.addEventListener("abort", () => {
            cleanup();
            reject(new DOMException("Generation cancelled.", "AbortError"));
          });
        }

        es.onmessage = async (event) => {
          try {
            const job = JSON.parse(event.data);
            await handleJobUpdate(job);

            if (job.status === "completed") {
              cleanup();
              try {
                const result = await api(`/generation-jobs/${jobId}/result`);
                await finalizeCompletedGeneration(result);
                resolve(true);
              } catch (err) {
                reject(err);
              }
            } else if (job.status === "failed") {
              cleanup();
              clearStreamingPreview();
              clearPendingSubmission();
              state.pendingGeneration = null;
              reject(new Error(job.errorMessage || job.error || "Generation job failed."));
            } else if (job.status === "discarded") {
              cleanup();
              clearStreamingPreview();
              clearPendingSubmission();
              state.pendingGeneration = null;
              reject(new Error("Generation job was discarded."));
            } else if (job.status === "recoverable") {
              if (retriesUsed < 1) {
                retriesUsed++;
                showBusy("Recovery: retrying the durable job…");
                recordActivity("system", "Auto-retrying recoverable job", `jobId=${jobId}`);
                await api(`/generation-jobs/${jobId}/retry`, { method: "POST", body: "{}" });
              } else {
                cleanup();
                clearStreamingPreview();
                showGenerationRecovery(jobId, "Generation is recoverable but needs your direction.");
                reject(new Error("Generation could not recover a complete story turn after retry."));
              }
            }
          } catch (e) {
            if (isResolved) return;
            cleanup();
            reject(e);
          }
        };

        es.onerror = () => {
          if (!isResolved) {
            cleanup();
            resolve(false);
          }
        };
      });
      if (streamCompleted) return;
    } catch (err) {
      clearStreamingPreview();
      throw err;
    }
  }

  for (let poll = 0; poll < MAX_POLLS; poll++) {
    if (state.abortController && state.abortController.signal.aborted) {
      clearStreamingPreview();
      throw new DOMException("Generation cancelled.", "AbortError");
    }
    const job = await api(`/generation-jobs/${jobId}`);
    await handleJobUpdate(job);

    if (job.status === "completed") {
      const result = await api(`/generation-jobs/${jobId}/result`);
      await finalizeCompletedGeneration(result);
      return;
    }
    if (job.status === "failed") {
      clearStreamingPreview();
      clearPendingSubmission();
      state.pendingGeneration = null;
      const msg = job.errorMessage || job.error || "Generation job failed.";
      throw new Error(msg);
    }
    if (job.status === "discarded") {
      clearStreamingPreview();
      clearPendingSubmission();
      state.pendingGeneration = null;
      throw new Error("Generation job was discarded.");
    }
    if (job.status === "recoverable") {
      if (retriesUsed < 1) {
        retriesUsed++;
        showBusy("Recovery: retrying the durable job…");
        recordActivity("system", "Auto-retrying recoverable job", `jobId=${jobId}`);
        await api(`/generation-jobs/${jobId}/retry`, { method: "POST", body: "{}" });
        continue;
      }
      clearStreamingPreview();
      showGenerationRecovery(jobId, "Generation is recoverable but needs your direction.");
      throw new Error("Generation could not recover a complete story turn after retry.");
    }
    await new Promise(r => setTimeout(r, 400));
  }
  clearStreamingPreview();
  throw new Error("Generation timed out. Reloading this page will resume if the durable job is still running.");
}

function updateGenerationProgress(job) {
  const stage = job.stage || job.status || "generating";
  showBusy(`Story Engine: ${stage}…`);
  const progressEl = $("generationProgress");
  if (progressEl) {
    progressEl.classList.add("turn-progress");
    progressEl.classList.remove("generation-progress");

    const steps = [
      { id: "queued", label: "Queued" },
      { id: "prepare", label: "Reading state" },
      { id: "mechanics", label: "Resolving action" },
      { id: "scene", label: "Writing scene" },
      { id: "finalize", label: "Saving turn" }
    ];

    let currentIndex = 0;
    if (stage === "prepare" || stage === "assessing") currentIndex = 1;
    if (stage === "mechanics" || stage === "resolving") currentIndex = 2;
    if (stage === "generating" || stage === "scene") currentIndex = 3;
    if (stage === "completed" || stage === "finalize") currentIndex = 4;

    const currentStep = steps[currentIndex];
    const percent = Math.round(((currentIndex + 1) / steps.length) * 100);
    const detailText = `Story Engine: ${stage}`;

    progressEl.innerHTML = `
      <div class="turn-progress-head">
        <strong>${escapeHtml(currentStep.label)}</strong>
        <span class="turn-progress-step">Step ${currentIndex + 1} of ${steps.length}</span>
      </div>
      <div class="turn-progress-track" aria-hidden="true">
        <div class="turn-progress-fill" style="width:${percent}%"></div>
      </div>
      <div class="turn-progress-detail">${escapeHtml(detailText)}</div>
    `;
  }
}

async function resumePendingGeneration() {
  // Check sync-status for any in-flight generation jobs
  if (!state.campaignId || !state.campaign) return false;
  try {
    const syncData = await api(`/campaigns/${state.campaignId}/sync-status`);
    const pending = syncData.pendingGeneration;
    state.pendingGeneration = pending || null;
    if (pending?.id) {
      showBusy("Resuming pending generation…");
      recordActivity("system", "Resuming pending generation", `jobId=${pending.id}`);
      beginGenerationDisplay(pending.action || "");
      const progressEl = $("generationProgress");
      if (progressEl) progressEl.classList.remove("hidden");
      try {
        await pollGenerationJob(pending.id, pending.action || "");
        return true;
      } catch (error) {
        restoreGenerationDisplay();
        throw error;
      } finally {
        clearStreamingPreview();
        if (progressEl) progressEl.classList.add("hidden");
        hideBusy();
      }
    }
    const stored = loadPendingSubmission();
    const storedTurnStillMatches = stored?.operationKind === "replace_latest"
      ? Number(stored.expectedTurnNumber) === state.turns.length
      : Number(stored?.expectedTurnNumber) === state.turns.length + 1;
    if (stored && storedTurnStillMatches) {
      await runGeneration(stored.action, {
        operationKind: stored.operationKind,
        expectedCurrentTurnNumber: stored.expectedTurnNumber,
        idempotencyKey: stored.idempotencyKey,
        createdAt: stored.createdAt,
        requestedInputMode: stored.requestedInputMode,
        resolvedInputMode: stored.resolvedInputMode,
        inputModeSource: stored.inputModeSource,
        classificationId: stored.classificationId
      });
      return true;
    }
    clearPendingSubmission();
  } catch (_) { /* ignore — no pending job */ }
  return false;
}

// ── Status Bar ────────────────────────────────────────────────
function updateStatusBar() {
  const turnPill = $("turnPill");
  const viewPill = $("viewPill");
  if (turnPill) turnPill.textContent = `Turn ${state.turns.length}`;
  const isLatest = state.viewIndex === -1 || state.viewIndex >= state.turns.length - 1;
  if (viewPill) {
    viewPill.textContent = isLatest
      ? "Viewing latest"
      : `Viewing turn ${state.viewIndex + 1}`;
  }
  syncInputState();
}

// ── History Navigation ────────────────────────────────────────
function navigateTo(index) {
  if (index < 0 || index >= state.turns.length) {
    state.viewIndex = -1;
  } else {
    state.viewIndex = index;
  }
  const isContinuous = Boolean(state.user?.settings?.continuousReading);
  if (!isContinuous) {
    renderAllScenes();
  } else {
    renderStoryIllustration();
  }
  updateStatusBar();
  scrollToView();
}

function goToPrevious() {
  const curr = state.viewIndex === -1 ? state.turns.length - 1 : state.viewIndex;
  if (state.busy || state.turns.length === 0 || curr <= 0) return;
  navigateTo(curr - 1);
}

function goToNext() {
  const curr = state.viewIndex === -1 ? state.turns.length - 1 : state.viewIndex;
  const isLatest = state.viewIndex === -1 || state.viewIndex >= state.turns.length - 1;
  if (state.busy || state.turns.length === 0 || isLatest) return;
  if (curr < state.turns.length - 1) navigateTo(curr + 1);
  else navigateTo(-1);
}

async function undoLatest() {
  const isLatest = state.viewIndex === -1 || state.viewIndex >= state.turns.length - 1;
  if (state.busy || state.turns.length === 0 || !isLatest) return;
  if (!confirm("Undo the last turn? This rewinds the campaign and cannot be reversed.")) return;
  showBusy("Rewinding…");
  try {
    await api(`/campaigns/${state.campaignId}/rewind`, {
      method: "POST",
      body: JSON.stringify({ targetTurnNumber: state.turns.length - 1 })
    });
    recordActivity("system", "Turn undone", `Rewound to turn ${state.turns.length - 1}.`);
    await loadCampaign(state.campaignId);
    toast("Last turn removed.");
  } catch (err) {
    toast(`Undo failed: ${err.message}`);
    recordActivity("error", "Undo failed", err.message);
  } finally {
    hideBusy();
  }
}

async function retryLatest() {
  const isLatest = state.viewIndex === -1 || state.viewIndex >= state.turns.length - 1;
  const lastTurnHasAction = state.turns.length > 0 && Boolean(state.turns[state.turns.length - 1] && state.turns[state.turns.length - 1].action);
  if (state.busy || state.turns.length === 0 || !isLatest || !lastTurnHasAction) return;
  const lastAction = state.turns[state.turns.length - 1].action;
  openRetryPromptDialog(lastAction);
}

function openRetryPromptDialog(originalPrompt) {
  const dialog = $("retryPromptDialog");
  const editor = $("retryPromptEditor");
  if (!dialog || !editor || typeof dialog.showModal !== "function") {
    const editedPrompt = prompt("Edit the prompt text before retrying:", originalPrompt || "");
    if (editedPrompt !== null) executeRetryWithPrompt(editedPrompt);
    return;
  }
  editor.value = originalPrompt || "";
  openManagedModal(dialog);
  setTimeout(() => {
    editor.focus();
    editor.select();
  }, 40);
}

function closeRetryPromptDialog() {
  const dialog = $("retryPromptDialog");
  if (dialog && dialog.open) dialog.close();
}

async function executeRetryWithPrompt(submittedPromptText) {
  const isLatest = state.viewIndex === -1 || state.viewIndex >= state.turns.length - 1;
  if (state.busy || state.turns.length === 0 || !isLatest) return;
  const action = String(submittedPromptText || "").trim();
  if (!action) {
    toast("Turn prompt cannot be empty.");
    const editor = $("retryPromptEditor");
    if (editor) editor.focus();
    return;
  }

  const currentTurnNumber = state.turns.length;
  const originalTurn = state.turns[currentTurnNumber - 1] || {};
  const resolvedInputMode = originalTurn.resolvedInputMode || originalTurn.inputMode || "action";
  closeRetryPromptDialog();
  await runGeneration(action, {
    operationKind: "replace_latest",
    expectedCurrentTurnNumber: currentTurnNumber,
    requestedInputMode: originalTurn.requestedInputMode || resolvedInputMode,
    resolvedInputMode,
    inputModeSource: originalTurn.inputModeSource || "explicit"
  });
}

function promptBranchOrReset(turnIndex) {
  const dlg = $("branchStoryDialog");
  if (!dlg) return;
  const msg = $("branchStoryMessage");
  if (msg) msg.textContent = `You selected Turn ${turnIndex + 1} (of ${state.turns.length}). Choose what should happen to later turns before continuing.`;
  dlg._turnIndex = turnIndex;
  openManagedModal(dlg);
}

// ── Illustration Management ───────────────────────────────────
function pollImageJobs() {
  if (state.imagePollTimer) clearTimeout(state.imagePollTimer);
  if (!state.campaignId) return;

  const poll = async () => {
    try {
      const data = await api(`/campaigns/${state.campaignId}/image-jobs`);
      const jobs = data.jobs || data || [];
      const segmentData = await api(`/campaigns/${state.campaignId}/illustration-segments`);
      const segments = segmentData.segments || [];
      let anyPending = false;
      state.illustrationSegments = segments;
      renderStoryIllustration();
      for (const job of jobs) {
        recordImageJobActivity(job, { suppress: !state.imageActivityInitialized });
        renderSceneImageJob(job);
        if (["queued", "generating", "provider_pending", "downloading"].includes(job.status)) anyPending = true;
      }
      for (const segment of segments) {
        recordIllustrationSegmentActivity(segment, { suppress: !state.imageActivityInitialized });
        if (["queued", "refining", "generating"].includes(segment.status)
          || ["queued", "refining", "recoverable"].includes(segment.promptJobStatus)) anyPending = true;
      }
      state.imageActivityInitialized = true;
      if (anyPending) {
        state.imagePollTimer = setTimeout(poll, IMAGE_POLL_MS);
      }
    } catch (_) { /* ignore polling errors */ }
  };
  return poll();
}

function recordIllustrationSegmentActivity(segment, options = {}) {
  if (!segment?.id) return;
  const signature = [
    segment.status || "",
    segment.promptJobStatus || "",
    segment.promptSource || "",
    segment.imageJobStatus || "",
    segment.variants?.length || 0
  ].join(":");
  if (state.illustrationSegmentActivity.get(segment.id) === signature) return;
  state.illustrationSegmentActivity.set(segment.id, signature);
  if (options.suppress) return;
  const turnIndex = state.turns.findIndex((turn) => (turn.id || turn.turnId) === segment.turnId);
  const detail = `turn=${turnIndex + 1} · segment=${segment.ordinal + 1} · prompt=${segment.promptSource || "direct"} · status=${segment.status}`;
  if (segment.promptJobStatus === "refining") {
    recordActivity("image", "Refining segment illustration prompt", detail);
  } else if (segment.promptSource === "ai_fallback") {
    recordActivity("image", "Segment prompt used direct fallback", detail);
  } else if (segment.status === "completed") {
    recordActivity("success", "Illustration segment completed", `${detail} · variants=${segment.variants?.length || 0}`);
  } else if (segment.status === "failed" || segment.status === "recoverable") {
    recordActivity("error", "Illustration segment failed", `${detail} · ${segment.errorMessage || ""}`);
  }
}

function recordImageJobActivity(job, options = {}) {
  if (!job?.id) return;
  const progress = Number(job.providerProgress);
  const progressBucket = Number.isFinite(progress) ? Math.floor(Math.max(0, Math.min(100, progress)) / 10) * 10 : null;
  const signature = [
    job.status || "",
    job.providerStatus || "",
    progressBucket ?? "",
    job.providerQueuePosition ?? "",
    job.errorCode || "",
    job.assetId || job.assetUrl || ""
  ].join(":");
  if (state.imageJobActivity.get(job.id) === signature) return;
  state.imageJobActivity.set(job.id, signature);
  if (options.suppress) return;

  const turnIndex = state.turns.findIndex((turn) => (turn.id || turn.turnId) === job.turnId);
  const turnDetail = turnIndex >= 0 ? `turn=${turnIndex + 1}` : `turnId=${job.turnId || "unknown"}`;
  const detail = [
    turnDetail,
    `jobId=${job.id}`,
    `status=${job.status || "queued"}`,
    job.providerStatus ? `providerStatus=${job.providerStatus}` : "",
    Number.isFinite(progress) ? `progress=${Math.round(progress)}%` : "",
    Number.isInteger(job.providerQueuePosition) ? `queue=${job.providerQueuePosition}` : "",
    job.requestedModel ? `model=${job.requestedModel}` : "",
    job.errorMessage ? `error=${job.errorMessage}` : ""
  ].filter(Boolean).join(" · ");

  if (job.status === "completed") {
    recordActivity("success", "Illustration generated", detail);
  } else if (["recoverable", "failed", "cancelled", "expired"].includes(job.status)) {
    recordActivity("error", "Illustration generation failed", detail);
  } else if (job.status === "queued") {
    recordActivity("image", "Illustration generation queued", detail);
  } else {
    recordActivity("image", "Illustration generation progress", detail);
  }
}

function imageJobStatusText(job) {
  const stage = String(job.providerStatus || job.status || "queued").replaceAll("_", " ");
  const progress = Number(job.providerProgress);
  const percentage = Number.isFinite(progress) ? ` · ${Math.round(progress)}%` : "";
  const queue = Number.isInteger(job.providerQueuePosition) ? ` · queue ${job.providerQueuePosition}` : "";
  const etaAt = job.providerEtaAt ? new Date(job.providerEtaAt).getTime() : Number.NaN;
  const etaSeconds = Number.isFinite(etaAt) ? Math.max(0, Math.ceil((etaAt - Date.now()) / 1000)) : null;
  const eta = etaSeconds === null ? "" : ` · about ${etaSeconds}s remaining`;
  return `${stage}${percentage}${queue}${eta}`;
}

function renderSceneImageJob(job) {
  if (!job.turnId) return;
  if (job.status === "completed" && job.assetUrl) {
    if (job.segmentId) return;
    updateSceneImage(job.turnId, job.assetUrl, true);
    return;
  }
  const turnIdx = state.turns.findIndex((turn) => (turn.id || turn.turnId) === job.turnId);
  const segmentContent = job.segmentId
    ? [...document.querySelectorAll(".segment-illustration-content[data-segment-id]")]
      .find((element) => element.dataset.segmentId === job.segmentId)
    : null;
  if (turnIdx < 0 || !illustrationsEnabled() || state.generationDisplayActive) return;
  if (job.segmentId && !segmentContent) return;
  if (!job.segmentId && turnIdx !== viewedTurnIndex()) return;
  const terminalFailure = ["recoverable", "failed", "cancelled", "expired"].includes(job.status);
  const active = ["queued", "generating", "provider_pending", "downloading"].includes(job.status);
  if (!terminalFailure && !active) return;
  const content = segmentContent || $("storyIllustrationContent");
  let imageWrap = content?.querySelector(".image-wrap");
  if (!imageWrap) {
    imageWrap = document.createElement("div");
    imageWrap.className = "image-wrap image-job-placeholder";
    content?.appendChild(imageWrap);
  }
  let status = imageWrap.querySelector(".image-job-status");
  if (!status) {
    status = document.createElement("div");
    status.className = imageWrap.querySelector("img") ? "image-job-status image-job-overlay" : "image-job-status";
    imageWrap.appendChild(status);
  }
  status.replaceChildren();
  const label = document.createElement("p");
  label.textContent = terminalFailure ? (job.errorMessage || "Illustration generation did not complete.") : `Creating illustration · ${imageJobStatusText(job)}`;
  status.append(label);
  if (active) {
    const progress = document.createElement("progress");
    progress.max = 100;
    const value = Number(job.providerProgress);
    if (Number.isFinite(value)) progress.value = Math.max(0, Math.min(100, value));
    progress.setAttribute("aria-label", `Illustration generation progress for turn ${turnIdx + 1}`);
    status.append(progress);
  } else if (terminalFailure) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "small ghost";
    retry.textContent = "Retry illustration";
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      try {
        const queued = await api(`/image-jobs/${job.id}/retry`, { method: "POST", body: "{}" });
        recordImageJobActivity(queued);
        renderSceneImageJob(queued);
        pollImageJobs();
      } catch (error) {
        toast(`Illustration retry failed: ${error.message}`);
        retry.disabled = false;
      }
    });
    status.append(retry);
  }
}

function updateSceneImage(turnId, assetUrl, replace = false) {
  if (!turnId || !assetUrl) return;
  // Find the turn index
  const turnIdx = state.turns.findIndex(t => (t.id || t.turnId) === turnId);
  if (turnIdx < 0) return;
  state.turns[turnIdx].imageAssetUrl = assetUrl;
  if (turnIdx === viewedTurnIndex()) renderStoryIllustration();
}

function openImagePromptEditor(turnId) {
  const turnIdx = state.turns.findIndex(t => (t.id || t.turnId) === turnId);
  if (turnIdx < 0) return;
  const turn = state.turns[turnIdx];
  const dlg = $("imagePromptDialog");
  const editor = $("imagePromptEditor");
  if (!dlg || !editor) return;
  editor.value = turn.imagePrompt || "";
  dlg._turnId = turnId;
  openManagedModal(dlg);
}

function segmentVariant(segmentId, variantIndex) {
  const segment = state.illustrationSegments.find((item) => item.id === segmentId);
  if (!segment) return { segment: null, variant: null };
  const variant = (segment.variants || []).find((item) => item.variantIndex === variantIndex)
    || segment.variants?.[variantIndex]
    || null;
  return { segment, variant };
}

function openSegmentImagePromptEditor(segmentId, variantIndex) {
  const { segment, variant } = segmentVariant(segmentId, variantIndex);
  const dlg = $("imagePromptDialog");
  const editor = $("imagePromptEditor");
  if (!segment || !dlg || !editor) return;
  editor.value = variant?.prompt || segment.resolvedPrompt || segment.directPrompt || "";
  dlg._turnId = null;
  dlg._segmentId = segmentId;
  dlg._variantIndex = variantIndex;
  const title = $("imagePromptDialogTitle");
  if (title) title.textContent = `Segment ${segment.ordinal + 1} · Image ${variantIndex + 1} prompt`;
  openManagedModal(dlg);
}

async function regenerateSegmentImage(segmentId, variantIndex, prompt) {
  const { segment, variant } = segmentVariant(segmentId, variantIndex);
  const effectivePrompt = String(prompt || variant?.prompt || segment?.resolvedPrompt || segment?.directPrompt || "").trim();
  if (!segment || !effectivePrompt) return toast("This segment does not have a valid illustration prompt.");
  try {
    showBusy(`Queueing segment ${segment.ordinal + 1}, image ${variantIndex + 1}…`);
    const queued = await api(`/illustration-segments/${segmentId}/images`, {
      method: "POST",
      body: JSON.stringify({ prompt: effectivePrompt, variantIndex })
    });
    recordImageJobActivity(queued);
    pollImageJobs();
    toast(`Segment ${segment.ordinal + 1}, image ${variantIndex + 1} queued.`);
  } catch (error) {
    toast(`Could not regenerate this image: ${error.message}`);
    recordActivity("error", "Segment illustration regeneration failed", error.message);
  } finally {
    hideBusy();
  }
}

function whySegmentImage(segmentId, variantIndex) {
  const { segment, variant } = segmentVariant(segmentId, variantIndex);
  if (!segment) return;
  const promptLabels = {
    direct: "Direct prompt from the accepted segment",
    ai_refined: "AI-refined prompt from the accepted segment",
    ai_fallback: "Direct fallback after prompt refinement failed",
    legacy: "Legacy turn illustration prompt"
  };
  const details = [
    `Turn segment: ${segment.ordinal + 1}.`,
    `Image variant: ${variantIndex + 1}.`,
    `Prompt source: ${promptLabels[segment.promptSource] || segment.promptSource || "Unknown"}.`,
    variant?.selectionReason ? `Selection: ${variant.selectionReason}.` : (variant?.providerType ? "Selection: generated specifically for this segment." : ""),
    variant?.matchScore == null ? "" : `Library match score: ${Number(variant.matchScore).toFixed(3)}${variant.matchThreshold == null ? "" : ` against ${Number(variant.matchThreshold).toFixed(3)}`}.`,
    variant?.matchingAlgorithm ? `Matching method: ${variant.matchingAlgorithm}.` : "",
    variant?.providerType ? `Provider: ${variant.providerType}.` : "",
    variant?.model ? `Model: ${variant.model}.` : "",
    variant?.createdAt ? `Attached: ${new Date(variant.createdAt).toLocaleString()}.` : "",
    `Source range: words ${segment.startWord + 1}–${segment.endWord}.`,
    "Prompt used:",
    variant?.prompt || segment.resolvedPrompt || segment.directPrompt || "Prompt provenance is unavailable for this retained image."
  ].filter(Boolean).join("\n");
  showMessage("Why this image?", details);
}

async function regenerateIllustration(turnId, prompt) {
  try {
    showBusy("Queueing illustration…");
    const queued = await api(`/turns/${turnId}/illustrations`, {
      method: "POST",
      body: JSON.stringify({ prompt: prompt || undefined, replace: true })
    });
    toast("Illustration queued.");
    recordImageJobActivity(queued);
    pollImageJobs();
  } catch (err) {
    toast(`Failed to queue illustration: ${err.message}`);
    recordActivity("error", "Illustration queue failed", err.message);
  } finally {
    hideBusy();
  }
}

async function generateTurnSegments(turnId, mode = "missing") {
  if (!turnId || state.busy) return;
  showBusy(mode === "rebuild" ? "Rebuilding illustration segments…" : "Creating illustration segments…");
  try {
    const result = await api(`/turns/${turnId}/illustration-segments`, {
      method: "POST",
      body: JSON.stringify({ mode, idempotencyKey: crypto.randomUUID() })
    });
    const segmentData = await api(`/campaigns/${state.campaignId}/illustration-segments`);
    state.illustrationSegments = segmentData.segments || [];
    renderAllScenes({ autoScroll: false });
    pollImageJobs();
    recordActivity("image", mode === "rebuild" ? "Turn illustration segments rebuilt" : "Turn illustration segments queued",
      `turnId=${turnId} · segments=${result.segmentCount || 0}`);
    toast(mode === "rebuild" ? "Turn illustration segments rebuilt." : "Turn illustrations queued.");
  } catch (error) {
    toast(`Could not queue turn illustrations: ${error.message}`);
    recordActivity("error", "Turn illustration segmentation failed", error.message);
  } finally {
    hideBusy();
  }
}

function showMessage(title, message) {
  const dialog = $("messagePopupDialog");
  if (!dialog) return toast(message);
  $("messagePopupTitle").textContent = title;
  $("messagePopupBody").textContent = message;
  if (dialog.open) dialog.close();
  openManagedModal(dialog);
}

async function whyIllustration(turnId) {
  try {
    const resolution = await api(`/turns/${turnId}/illustration-resolution`);
    const candidate = resolution.candidates?.[0];
    const details = [
      `Outcome: ${resolution.reasonCode || resolution.status}.`,
      `Policy: ${resolution.sourcePolicy}; scope: ${resolution.matchingScope}; confidence: ${resolution.confidenceProfile}.`,
      resolution.selectedScore == null ? "" : `Selected score ${Number(resolution.selectedScore).toFixed(3)} against threshold ${Number(resolution.resolvedThreshold).toFixed(3)}.`,
      candidate?.scoreComponents ? `Evidence: ${Object.entries(candidate.scoreComponents).map(([key, value]) => `${key}=${typeof value === "number" ? value.toFixed(3) : value}`).join(", ")}.` : ""
    ].filter(Boolean).join("\n");
    showMessage("Why this image?", details);
  } catch (error) {
    toast(error.message || "No automatic match evidence is available for this image.");
  }
}

async function pollIllustrationResolution(turnId) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const resolution = await api(`/turns/${turnId}/illustration-resolution`);
    if (resolution.status === "completed" && resolution.selectedAssetId) {
      updateSceneImage(turnId, `/api/v1/assets/${resolution.selectedAssetId}`, true);
      toast("Selected another library match.");
      return;
    }
    if (resolution.status === "no_match") return toast("No other library image met the confidence threshold.");
    if (resolution.status === "generation_queued") { pollImageJobs(); return; }
    if (resolution.status === "failed") return toast(`Image matching failed: ${resolution.reasonCode || "unknown error"}.`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  toast("Image matching is still running.");
}

async function findAnotherLibraryMatch(turnId) {
  try {
    await api(`/turns/${turnId}/illustration-match`, { method: "POST", body: "{}" });
    toast("Searching for another retained match.");
    void pollIllustrationResolution(turnId);
  } catch (error) {
    toast(error.message || "This image was not selected by automatic library matching.");
  }
}

async function removeIllustration(turnId) {
  try {
    await api(`/turns/${turnId}/illustration-asset`, { method: "PUT", body: JSON.stringify({ assetId: null }) });
    const turn = state.turns.find((item) => (item.id || item.turnId) === turnId);
    if (turn) { turn.imageAssetUrl = ""; turn.imageUrl = ""; }
    renderAllScenes();
    toast("Illustration removed. The retained asset was not deleted.");
  } catch (error) {
    toast(`Could not remove illustration: ${error.message}`);
  }
}

// ── Edit State Dialog ─────────────────────────────────────────
async function openEditState() {
  const dlg = $("editStateDialog");
  if (!dlg || !state.campaignId) return;
  try {
    showBusy("Loading current state…");
    state.runtimeState = await api(`/campaigns/${state.campaignId}/state`);
    renderCurrentRuntimeState();
    switchEditStateTab("overview");
    openManagedModal(dlg);
  } catch (err) {
    toast(`State could not be loaded: ${err.message}`);
  } finally {
    hideBusy();
  }
}

function switchEditStateTab(tabName) {
  document.querySelectorAll("#editStateDialog .tab").forEach(t => {
    t.classList.toggle("active", t.dataset.tab === tabName);
  });
  ["overview", "scratch", "trackers", "mechanics"].forEach(sectionTab => {
    const el = $(`tab-${sectionTab}`);
    if (el) el.classList.toggle("hidden", sectionTab !== tabName);
  });
}

function renderTextCollection(containerId, values, emptyText) {
  const container = $(containerId);
  if (!container) return;
  container.innerHTML = values && values.length
    ? values.map(value => `<div>• ${escapeHtml(String(value))}</div>`).join("")
    : `<span class="dim">${escapeHtml(emptyText)}</span>`;
}

function renderCurrentRuntimeState() {
  const runtime = state.runtimeState || {};
  const meta = $("editStateMeta");
  if (meta) meta.textContent = `Current authoritative state after turn ${runtime.activeTurnNumber || 0} · revision ${runtime.revision || 0}`;
  const summary = $("editStateContinuitySummary");
  if (summary) summary.textContent = runtime.continuitySummary || "No continuity summary has been recorded yet.";
  renderTextCollection("editStateOpenThreads", runtime.openThreads || [], "No open threads recorded.");
  renderTextCollection("editStateCanonicalFacts", runtime.canonicalFacts || [], "No canonical facts recorded.");

  const scratchpad = $("scratchpadEditor");
  if (scratchpad) scratchpad.value = runtime.scratchpad || "";
  updateScratchpadCharacterCount();
  renderTrackerEditor();
  renderRpgStatsInEditState();
  renderTextCollection("editStateEventTriggers", (runtime.eventTriggers || []).map(trigger => trigger.label || trigger.name || trigger.id || "Unnamed trigger"), "No event triggers configured.");
  renderTextCollection("editStatePendingTriggers", (runtime.pendingEventTriggers || []).map(trigger => trigger.name || trigger.label || trigger.instructions || trigger.id || "Pending trigger"), "No pending triggers.");
}

function updateScratchpadCharacterCount() {
  const editor = $("scratchpadEditor");
  const count = $("scratchpadCharacterCount");
  if (count) count.textContent = `${editor ? editor.value.length : 0} characters`;
}

function renderTrackerEditor() {
  const container = $("trackerList");
  if (!container) return;
  const trackers = state.runtimeState?.trackers || [];
  container.innerHTML = trackers.length ? "" : `<p class="dim mini">No current trackers.</p>`;
  trackers.forEach(tracker => {
    const card = document.createElement("div");
    card.className = "track-card runtime-tracker-card";
    card.dataset.trackerId = tracker.id;
    card.innerHTML = `
      <label>Name<input data-field="name" value="${escapeAttribute(tracker.name || "")}" /></label>
      <label>Current value<textarea data-field="value">${escapeHtml(tracker.value || "")}</textarea></label>
      <label>Update rules<textarea data-field="rules">${escapeHtml(tracker.rules || "")}</textarea></label>
      <button type="button" class="small danger" data-action="remove-tracker">Remove tracker</button>
    `;
    const remove = card.querySelector('[data-action="remove-tracker"]');
    if (remove) remove.addEventListener("click", () => {
      state.runtimeState.trackers = state.runtimeState.trackers.filter(item => item.id !== tracker.id);
      renderTrackerEditor();
    });
    container.appendChild(card);
  });
}

function collectTrackerEditorValues() {
  return [...document.querySelectorAll("#trackerList .runtime-tracker-card")].map(card => ({
    id: card.dataset.trackerId,
    name: card.querySelector('[data-field="name"]')?.value.trim() || "",
    value: card.querySelector('[data-field="value"]')?.value || "",
    rules: card.querySelector('[data-field="rules"]')?.value || ""
  })).filter(tracker => tracker.name);
}

function addTrackerFromEditor() {
  if (!state.runtimeState) return;
  const name = $("trackerName")?.value.trim() || "";
  if (!name) {
    toast("Tracker name is required.");
    return;
  }
  state.runtimeState.trackers = [
    ...collectTrackerEditorValues(),
    {
      id: globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `tracker-${Date.now()}`,
      name,
      value: $("trackerValue")?.value || "",
      rules: $("trackerRules")?.value || ""
    }
  ];
  ["trackerName", "trackerValue", "trackerRules"].forEach(id => { const input = $(id); if (input) input.value = ""; });
  renderTrackerEditor();
}

function renderRpgStatsInEditState() {
  const container = $("editStateRpgStats");
  if (!container) return;
  const stats = state.runtimeState?.rpgStats || [];
  container.innerHTML = stats.length
    ? `<div class="stat-block">${stats.map(stat => `<span class="stat-pill"><strong>${escapeHtml(stat.name || stat.id || "Stat")}</strong> ${escapeHtml(String(stat.value ?? ""))}</span>`).join("")}</div>`
    : `<p class="dim mini">No RPG stats configured for this campaign.</p>`;
}

function openActivityLog() {
  renderActivityLog();
  const d = $("activityLogDialog");
  openManagedModal(d);
}

function openUserProfile() {
  const dlg = $("userProfileDialog");
  if (!dlg) return;
  const nameInput = $("userProfileDisplayName");
  const cbSubmit = $("userProfileAutoSubmitChoices");
  const cbContinuous = $("userProfileContinuousReading");
  const defaultTurnStyle = $("userProfileDefaultTurnControlStyle");
  if (nameInput) nameInput.value = state.user?.displayName || "Initial Owner";
  if (cbSubmit) cbSubmit.checked = state.user?.settings?.autoSubmitTurnChoices !== false;
  if (cbContinuous) cbContinuous.checked = Boolean(state.user?.settings?.continuousReading);
  if (defaultTurnStyle) defaultTurnStyle.value = state.user?.settings?.defaultTurnControlStyle || "flexible_auto";
  openManagedModal(dlg);
}

async function saveUserProfile() {
  const nameInput = $("userProfileDisplayName");
  const cbSubmit = $("userProfileAutoSubmitChoices");
  const cbContinuous = $("userProfileContinuousReading");
  const defaultTurnStyle = $("userProfileDefaultTurnControlStyle");
  const displayName = nameInput ? nameInput.value.trim() : "";
  const autoSubmitTurnChoices = cbSubmit ? cbSubmit.checked : true;
  const continuousReading = cbContinuous ? cbContinuous.checked : false;
  const defaultTurnControlStyle = defaultTurnStyle ? defaultTurnStyle.value : "flexible_auto";

  if (!displayName) {
    toast("Display name is required.", 2600);
    return;
  }

  try {
    const res = await api("/users/me/profile", {
      method: "PATCH",
      body: JSON.stringify({
        displayName,
        settings: {
          autoSubmitTurnChoices,
          continuousReading,
          defaultTurnControlStyle
        }
      })
    });
    if (res && res.user) {
      state.user = res.user;
    } else {
      if (state.user) {
        state.user.displayName = displayName;
        if (!state.user.settings) state.user.settings = {};
        state.user.settings.autoSubmitTurnChoices = autoSubmitTurnChoices;
        state.user.settings.continuousReading = continuousReading;
        state.user.settings.defaultTurnControlStyle = defaultTurnControlStyle;
      }
    }
    renderAllScenes();
    updateStatusBar();
    const dlg = $("userProfileDialog");
    if (dlg && dlg.close) dlg.close();
    toast("Profile saved.", 2600);
  } catch (err) {
    toast("Failed to save profile: " + err.message, 3500);
  }
}

async function openTurnHistoryModal() {
  const dlg = $("turnHistoryDialog");
  openManagedModal(dlg);
  populateHistoryContainer($("turnHistoryModalList"));
}

function populateHistoryContainer(container) {
  if (!container) return;
  container.innerHTML = "";
  if (state.turns.length === 0) {
    state.historySelectedIndex = null;
    container.innerHTML = `<p class="dim mini">No turns recorded yet.</p>`;
    const panel = $("turnHistoryStatePanel");
    if (panel) {
      panel.classList.add("hidden");
      panel.innerHTML = "";
    }
    updateHistorySelectionActions();
    return;
  }
  const currentIdx = state.viewIndex === -1 ? state.turns.length - 1 : state.viewIndex;
  state.turns.forEach((t, i) => {
    const card = document.createElement("div");
    card.className = "history-card";
    card.dataset.turnIndex = String(i);
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-pressed", "false");
    const preview = (t.narration || "").slice(0, 140) + ((t.narration || "").length > 140 ? "…" : "");
    const inputMode = t.inputMode === "scene" ? "scene" : "action";
    const inputModeLabel = inputMode === "scene" ? "Scene direction" : "Action";
    card.innerHTML = `
      <div class="history-card-heading">
        <h4>${i === currentIdx ? "◆ " : ""}Turn ${i + 1}${t.action ? `: ${escapeHtml(t.action.slice(0, 60))}` : (i === 0 ? ": Adventure Begin" : "")}</h4>
        <span class="turn-input-mode-pill ${inputMode}" title="Story Engine interpreted this prompt as ${inputModeLabel}" aria-label="Prompt interpretation: ${inputModeLabel}">${inputModeLabel}</span>
      </div>
      <p>${escapeHtml(preview)}</p>
    `;
    card.addEventListener("click", () => selectHistoryTurn(i));
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectHistoryTurn(i);
      }
    });
    container.appendChild(card);
  });
  selectHistoryTurn(currentIdx);
}

function selectHistoryTurn(turnIndex) {
  if (!Number.isInteger(turnIndex) || turnIndex < 0 || turnIndex >= state.turns.length) return;
  state.historySelectedIndex = turnIndex;
  document.querySelectorAll("#turnHistoryModalList .history-card").forEach(card => {
    const selected = Number(card.dataset.turnIndex) === turnIndex;
    card.classList.toggle("selected", selected);
    card.setAttribute("aria-pressed", String(selected));
  });
  updateHistorySelectionActions();
  inspectTurnState(turnIndex + 1);
}

function updateHistorySelectionActions() {
  const hasSelection = Number.isInteger(state.historySelectedIndex)
    && state.historySelectedIndex >= 0
    && state.historySelectedIndex < state.turns.length;
  const inspectBtn = $("btnTurnHistoryInspect");
  const jumpBtn = $("btnTurnHistoryJump");
  const branchBtn = $("btnTurnHistoryBranch");
  if (inspectBtn) inspectBtn.disabled = !hasSelection;
  if (jumpBtn) jumpBtn.disabled = !hasSelection;
  if (branchBtn) {
    branchBtn.disabled = !hasSelection;
    branchBtn.classList.toggle("hidden", !hasSelection || state.historySelectedIndex >= state.turns.length - 1);
  }
}

async function inspectTurnState(turnNumber) {
  const panel = $("turnHistoryStatePanel");
  if (!panel || !state.campaignId) return;
  const requestId = ++state.historyInspectionRequestId;
  panel.classList.remove("hidden");
  panel.innerHTML = `<p class="mini">Loading state after turn ${turnNumber}…</p>`;
  try {
    const runtime = await api(`/campaigns/${state.campaignId}/state?turnNumber=${turnNumber}`);
    if (requestId !== state.historyInspectionRequestId) return;
    const list = (values, empty) => values && values.length
      ? `<ul>${values.map(value => `<li>${escapeHtml(String(value))}</li>`).join("")}</ul>`
      : `<p class="mini dim">${escapeHtml(empty)}</p>`;
    panel.innerHTML = `
      <h4>${runtime.isCurrent ? "Current state" : `Historical state after turn ${runtime.viewedTurnNumber}`}</h4>
      <p class="mini">${runtime.isCurrent ? "Editable from Menu → Edit State." : "Read-only. Reset or branch here to make this state current."}</p>
      <details open><summary>Continuity summary</summary><div>${escapeHtml(runtime.continuitySummary || "No summary recorded.")}</div></details>
      <details><summary>Private scratchpad</summary><div class="state-inspector-pre">${escapeHtml(runtime.scratchpad || "No scratchpad recorded.")}</div></details>
      <details><summary>Trackers</summary><div>${list((runtime.trackers || []).map(tracker => `${tracker.name}: ${tracker.value}`), "No trackers recorded.")}</div></details>
      <details><summary>Open threads</summary><div>${list(runtime.openThreads, "No open threads recorded.")}</div></details>
      <details><summary>Canonical facts</summary><div>${list(runtime.canonicalFacts, "No canonical facts recorded.")}</div></details>
    `;
  } catch (err) {
    if (requestId !== state.historyInspectionRequestId) return;
    panel.innerHTML = `<p class="mini">State could not be loaded: ${escapeHtml(err.message)}</p>`;
  }
}

async function saveEditState() {
  if (!state.campaignId || !state.runtimeState) return;
  const scratchpadEl = $("scratchpadEditor");
  try {
    showBusy("Saving state…");
    state.runtimeState = await api(`/campaigns/${state.campaignId}/state`, {
      method: "PATCH",
      body: JSON.stringify({
        expectedTurnNumber: state.runtimeState.activeTurnNumber,
        expectedRevision: state.runtimeState.revision,
        scratchpad: scratchpadEl?.value || "",
        trackers: collectTrackerEditorValues()
      })
    });
    toast("Current state saved. The next story turn will use these changes.");
    const dlg = $("editStateDialog");
    if (dlg && dlg.close) dlg.close();
  } catch (err) {
    toast(`Save failed: ${err.message}`);
  } finally {
    hideBusy();
  }
}

// ── World Setup Dialog ────────────────────────────────────────
function openWorldSetup() {
  const dlg = $("worldSetupDialog");
  if (!dlg) return;
  const world = state.world || {};
  const camp = state.campaign || {};
  const pc = state.playerConfig || {};

  const titleEl = $("setupCampaignTitle");
  if (titleEl) titleEl.textContent = camp.title || world.title || "Untitled Campaign";

  const versionEl = $("setupWorldVersion");
  if (versionEl) {
    const vNum = world.versionNumber ? `v${world.versionNumber}` : "";
    const wTitle = world.title || "Unknown World";
    versionEl.textContent = `${wTitle} ${vNum}`.trim();
  }

  if ($("setupGenre")) $("setupGenre").textContent = world.genre || "None specified";
  if ($("setupTone")) $("setupTone").textContent = world.tone || "None specified";

  if ($("setupCharacter")) {
    const charName = pc.characterSnapshot?.name || world.character || "Player Character";
    const charDesc = pc.characterSnapshot?.characterText || pc.characterSnapshot?.description || world.character || "No character details recorded.";
    $("setupCharacter").textContent = charName && charDesc && charName !== charDesc ? `${charName}\n\n${charDesc}` : (charDesc || charName);
  }

  if ($("setupPremise")) $("setupPremise").textContent = world.premise || "No starting premise specified.";
  if ($("setupBackgroundStory")) $("setupBackgroundStory").textContent = world.backgroundStory || "No background story provided.";
  if ($("setupRules")) $("setupRules").textContent = world.rules || "No story rules specified.";

  const statsContainer = $("setupRpgStats");
  if (statsContainer) {
    const stats = pc.rpgStats || [];
    if (!stats || stats.length === 0) {
      statsContainer.innerHTML = `<p class="dim mini">No RPG statistics defined.</p>`;
    } else {
      statsContainer.innerHTML = `<div class="stat-grid">` + stats.map(s => `
        <div class="stat-row">
          <span style="font-weight: 600; color: var(--text-heading);">${escapeHtml(s.name)}:</span>
          <span>${s.value} d%</span>
          ${s.note ? `<span class="dim mini" style="grid-column: span 2;">${escapeHtml(s.note)}</span>` : ""}
        </div>`).join("") + `</div>`;
    }
  }

  openManagedModal(dlg);
}

// ── Export Functions ──────────────────────────────────────────
async function exportMarkdown() {
  if (!state.campaignId) return;
  try {
    const data = await api(`/campaigns/${state.campaignId}/export`);
    const title = String(data.campaign?.title || state.campaign?.title || "Story").replace(/[\r\n]+/g, " ");
    let md = `# ${title}\n\n`;
    (data.turns || state.turns).forEach((t, i) => {
      const action = String(t.action || "").replace(/[\r\n]+/g, " ");
      const turnId = t.id || t.turnId || state.turns[i]?.id || "";
      const segments = illustrationSegmentsForTurn(turnId);
      md += `## Turn ${i + 1}${action ? ": " + action : ""}\n\n`;
      if (segments.length) {
        segments.forEach((segment) => {
          md += `${segment.text.trim()}\n\n`;
          const imageUrl = String(segment.variants?.[0]?.url || "").replace(/>/g, "%3E");
          if (imageUrl) md += `![Turn ${i + 1}, segment ${segment.ordinal + 1} illustration](<${imageUrl}>)\n\n`;
        });
      } else {
        const imageUrl = String(t.imageAssetUrl || t.imageUrl || "").trim().replace(/>/g, "%3E");
        if (t.narration) md += t.narration + "\n\n";
        if (imageUrl) md += `![Turn ${i + 1} illustration](<${imageUrl}>)\n\n`;
      }
    });
    downloadBlob(new Blob([md], { type: "text/markdown" }), `${title.replace(/[^a-zA-Z0-9_-]/g, "_")}.md`);
    toast("Markdown export downloaded.");
  } catch (err) {
    toast(`Export failed: ${err.message}`);
  }
}

async function exportPdfWithImages() {
  if (!state.campaignId) return;
  const printWindow = window.open("", "_blank", "width=1000,height=800");
  if (!printWindow) {
    toast("Allow pop-ups to export the story as PDF.");
    return;
  }
  printWindow.opener = null;
  printWindow.document.write("<!doctype html><title>Preparing story…</title><p>Preparing your story for PDF export…</p>");

  try {
    const data = await api(`/campaigns/${state.campaignId}/export`);
    const titleText = data.campaign?.title || state.campaign?.title || "Infinite Quest Story";
    const title = escapeHtml(titleText);
    const turns = (data.turns || state.turns).map((turn, index) => {
      const action = turn.action ? `: ${escapeHtml(turn.action)}` : "";
      const turnId = turn.id || turn.turnId || state.turns[index]?.id || "";
      const segments = illustrationSegmentsForTurn(turnId);
      const content = segments.length
        ? segments.map((segment) => {
            const narration = sanitizeNarration(segment.text);
            const imageUrl = String(segment.variants?.[0]?.url || "").trim();
            return `${narration}${imageUrl
              ? `<figure><img src="${escapeHtml(imageUrl)}" alt="Illustration for turn ${index + 1}, segment ${segment.ordinal + 1}"><figcaption>Turn ${index + 1} · Segment ${segment.ordinal + 1}</figcaption></figure>`
              : ""}`;
          }).join("")
        : `${sanitizeNarration(turn.narration || "")}${turn.imageAssetUrl || turn.imageUrl
          ? `<figure><img src="${escapeHtml(turn.imageAssetUrl || turn.imageUrl)}" alt="Illustration for turn ${index + 1}"><figcaption>Turn ${index + 1} illustration</figcaption></figure>`
          : ""}`;
      return `<section class="turn"><h2>Turn ${index + 1}${action}</h2>${content}</section>`;
    }).join("");
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>@page{margin:.7in}*{box-sizing:border-box}body{max-width:8.2in;margin:0 auto;color:#17131f;font:12pt/1.58 Georgia,serif}h1{margin:0 0 28px;color:#3f286b;font-size:28pt}h2{margin:0 0 14px;color:#543482;font-size:17pt}.turn{break-inside:avoid;border-top:1px solid #cfc7dc;padding:24px 0}.turn p{orphans:3;widows:3}figure{margin:22px 0 0;break-inside:avoid}img{display:block;max-width:100%;max-height:7.2in;margin:auto;border-radius:10px;object-fit:contain}figcaption{margin-top:7px;color:#70687d;font:9pt/1.3 system-ui,sans-serif;text-align:center}@media print{body{max-width:none}.turn{break-inside:auto}figure{break-inside:avoid}}</style></head><body><h1>${title}</h1>${turns || "<p>No accepted story turns are available yet.</p>"}</body></html>`;

    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
    const waitForImages = () => Promise.all([...printWindow.document.images].map((image) => (
      image.complete
        ? Promise.resolve()
        : new Promise((resolve) => {
            image.addEventListener("load", resolve, { once: true });
            image.addEventListener("error", resolve, { once: true });
          })
    )));
    await Promise.race([waitForImages(), new Promise((resolve) => setTimeout(resolve, 4000))]);
    printWindow.focus();
    printWindow.print();
    toast("Print dialog opened. Choose Save as PDF.");
  } catch (err) {
    printWindow.close();
    toast(`Export failed: ${err.message}`);
  }
}

function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
}

// ── Navigation & Dialog Management ────────────────────────────
function closeNavigationMenus(except = null) {
  document.querySelectorAll(".nav-menu.open").forEach((menu) => {
    if (menu !== except) setNavigationMenuState(menu, false);
  });
}

function setNavigationMenuState(menu, open) {
  const trigger = menu.querySelector(".nav-menu-trigger");
  const panel = menu.querySelector(".nav-menu-panel");
  menu.classList.toggle("open", open);
  if (trigger) trigger.setAttribute("aria-expanded", String(open));
  if (panel) panel.hidden = !open;
}

function initializeNavigationMenus() {
  document.querySelectorAll(".nav-menu-trigger").forEach((trigger) => {
    trigger.addEventListener("click", () => {
      const menu = trigger.closest(".nav-menu");
      if (!menu) return;
      const open = !menu.classList.contains("open");
      closeNavigationMenus(menu);
      setNavigationMenuState(menu, open);
    });
  });
  document.querySelectorAll(".nav-menu-panel a").forEach((link) => {
    link.addEventListener("click", () => closeNavigationMenus());
  });
  document.addEventListener("pointerdown", (event) => {
    if (!(event.target instanceof Element) || !event.target.closest(".nav-menu")) closeNavigationMenus();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeNavigationMenus();
  });
}

// ── Initialization ────────────────────────────────────────────
async function init() {
  try {
    const sessionRes = await api("/session");
    if (sessionRes && sessionRes.user) {
      state.user = sessionRes.user;
    }
  } catch (err) {
    recordActivity("error", "Session profile unavailable", err.message);
  }
  const match = window.location.pathname.match(/\/story\/([^/]+)/);
  if (match) {
    state.campaignId = decodeURIComponent(match[1]);
    const navStoryLink = $("navStoryLink");
    if (navStoryLink) navStoryLink.href = `/story/${encodeURIComponent(state.campaignId)}`;
    localStorage.setItem("infiniteQuestLastCampaignId", state.campaignId);
  } else {
    localStorage.removeItem("infiniteQuestLastCampaignId");
    await checkOnboarding();
    updateStatusBar();
    recordActivity("system", "Empty Story page opened", "Choose a world from the Nexus dashboard to begin a campaign.");
    return;
  }
  await checkOnboarding();
  await loadCampaign(state.campaignId);
  await pollImageJobs();
  const resumed = await resumePendingGeneration();
  if (!resumed && state.turns.length === 0 && !state.busy) {
    await startAdventure();
  }
  pollImageJobs();
}

// ── Boot Sequence ─────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  // Core action buttons
  const btnTakeAction = $("btnTakeAction");
  if (btnTakeAction) btnTakeAction.addEventListener("click", () => {
    const freeAction = $("freeAction");
    submitAction(freeAction ? freeAction.value : "");
  });

  const freeAction = $("freeAction");
  if (freeAction) {
    freeAction.addEventListener("input", () => {
      updateTurnInputCharacterCount();
      clearTurnIntentDecision();
    });
    freeAction.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitAction(freeAction.value); }
    });
  }
  document.querySelectorAll("[data-turn-input-mode]").forEach((button) => {
    button.addEventListener("click", () => setTurnInputMode(button.dataset.turnInputMode, { refreshPlaceholder: true }));
  });
  const submitAmbiguousTurn = (resolvedInputMode) => {
    const pending = state.pendingIntentDecision;
    if (!pending) return;
    submitResolvedTurn(pending.action, {
      requestedInputMode: resolvedInputMode,
      resolvedInputMode,
      inputModeSource: "explicit"
    });
  };
  const btnSubmitAsAction = $("btnSubmitAsAction");
  if (btnSubmitAsAction) btnSubmitAsAction.addEventListener("click", () => submitAmbiguousTurn("action"));
  const btnSubmitAsScene = $("btnSubmitAsScene");
  if (btnSubmitAsScene) btnSubmitAsScene.addEventListener("click", () => submitAmbiguousTurn("scene"));
  const btnReturnToTurnEditor = $("btnReturnToTurnEditor");
  if (btnReturnToTurnEditor) btnReturnToTurnEditor.addEventListener("click", () => {
    clearTurnIntentDecision();
    if (freeAction) freeAction.focus();
  });

  // History navigation
  const btnPrev = $("btnPrev");
  if (btnPrev) btnPrev.addEventListener("click", goToPrevious);
  const btnNext = $("btnNext");
  if (btnNext) btnNext.addEventListener("click", goToNext);
  const btnUndo = $("btnUndo");
  if (btnUndo) btnUndo.addEventListener("click", undoLatest);
  const btnRetry = $("btnRetry");
  if (btnRetry) btnRetry.addEventListener("click", retryLatest);
  const btnRetryPromptClose = $("btnRetryPromptClose");
  if (btnRetryPromptClose) btnRetryPromptClose.addEventListener("click", closeRetryPromptDialog);
  const btnRetryPromptCancel = $("btnRetryPromptCancel");
  if (btnRetryPromptCancel) btnRetryPromptCancel.addEventListener("click", closeRetryPromptDialog);
  const btnRetryPromptSubmit = $("btnRetryPromptSubmit");
  if (btnRetryPromptSubmit) btnRetryPromptSubmit.addEventListener("click", () => {
    const editor = $("retryPromptEditor");
    executeRetryWithPrompt(editor ? editor.value : "");
  });
  const retryPromptEditor = $("retryPromptEditor");
  if (retryPromptEditor) retryPromptEditor.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      executeRetryWithPrompt(retryPromptEditor.value);
    }
  });

  initializeNavigationMenus();

  // Navigation menu items
  const btnOpenWorldSetup = $("btnOpenWorldSetup");
  if (btnOpenWorldSetup) btnOpenWorldSetup.addEventListener("click", () => { closeNavigationMenus(); openWorldSetup(); });
  const btnExportMarkdown = $("btnExportMarkdown");
  if (btnExportMarkdown) btnExportMarkdown.addEventListener("click", () => { closeNavigationMenus(); exportMarkdown(); });
  const btnExportPdf = $("btnExportPdf");
  if (btnExportPdf) btnExportPdf.addEventListener("click", () => { closeNavigationMenus(); exportPdfWithImages(); });
  const btnOpenEditState = $("btnOpenEditState");
  if (btnOpenEditState) btnOpenEditState.addEventListener("click", () => { closeNavigationMenus(); openEditState(); });
  const btnOpenActivityLog = $("btnOpenActivityLog");
  if (btnOpenActivityLog) btnOpenActivityLog.addEventListener("click", () => { closeNavigationMenus(); openActivityLog(); });
  const btnAboutNexus = $("btnAboutNexus");
  if (btnAboutNexus) btnAboutNexus.addEventListener("click", () => {
    closeNavigationMenus();
    const dialog = $("aboutNexusDialog");
    openManagedModal(dialog);
  });

  const btnOpenUserProfile = $("btnOpenUserProfile");
  if (btnOpenUserProfile) btnOpenUserProfile.addEventListener("click", () => { closeNavigationMenus(); openUserProfile(); });
  const btnCloseUserProfile = $("btnCloseUserProfile");
  if (btnCloseUserProfile) btnCloseUserProfile.addEventListener("click", () => { const d = $("userProfileDialog"); if (d && d.close) d.close(); });
  const btnCancelUserProfile = $("btnCancelUserProfile");
  if (btnCancelUserProfile) btnCancelUserProfile.addEventListener("click", () => { const d = $("userProfileDialog"); if (d && d.close) d.close(); });
  const btnSaveUserProfile = $("btnSaveUserProfile");
  if (btnSaveUserProfile) btnSaveUserProfile.addEventListener("click", saveUserProfile);

  // Edit State dialog
  const btnSaveEditState = $("btnSaveEditState") || $("btnSaveScratch");
  if (btnSaveEditState) btnSaveEditState.addEventListener("click", saveEditState);
  const btnCancelEditState = $("btnCancelEditState");
  if (btnCancelEditState) btnCancelEditState.addEventListener("click", () => { const d = $("editStateDialog"); if (d && d.close) d.close(); });
  const btnEditStateViewHistory = $("btnEditStateViewHistory");
  if (btnEditStateViewHistory) btnEditStateViewHistory.addEventListener("click", () => {
    const d = $("editStateDialog");
    if (d && d.close) d.close();
    openTurnHistoryModal();
  });
  const scratchpadEditor = $("scratchpadEditor");
  if (scratchpadEditor) scratchpadEditor.addEventListener("input", updateScratchpadCharacterCount);
  const btnAddTracker = $("btnAddTracker");
  if (btnAddTracker) btnAddTracker.addEventListener("click", addTrackerFromEditor);
  const btnCloseEditState = $("btnCloseEditState");
  if (btnCloseEditState) btnCloseEditState.addEventListener("click", () => { const d = $("editStateDialog"); if (d && d.close) d.close(); });
  document.querySelectorAll("#editStateDialog .tab").forEach(tab => {
    tab.addEventListener("click", () => switchEditStateTab(tab.dataset.tab));
  });

  // Turn History / Navigation dialog and pills
  ["turnPill", "viewPill"].forEach(id => {
    const el = $(id);
    if (el) {
      el.addEventListener("click", openTurnHistoryModal);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openTurnHistoryModal();
        }
      });
    }
  });
  const btnCloseTurnHistory = $("btnCloseTurnHistory");
  if (btnCloseTurnHistory) btnCloseTurnHistory.addEventListener("click", () => { const d = $("turnHistoryDialog"); if (d && d.close) d.close(); });
  const btnTurnHistoryDone = $("btnTurnHistoryDone");
  if (btnTurnHistoryDone) btnTurnHistoryDone.addEventListener("click", () => { const d = $("turnHistoryDialog"); if (d && d.close) d.close(); });
  const btnTurnHistoryInspect = $("btnTurnHistoryInspect");
  if (btnTurnHistoryInspect) btnTurnHistoryInspect.addEventListener("click", () => {
    if (Number.isInteger(state.historySelectedIndex)) inspectTurnState(state.historySelectedIndex + 1);
  });
  const btnTurnHistoryJump = $("btnTurnHistoryJump");
  if (btnTurnHistoryJump) btnTurnHistoryJump.addEventListener("click", () => {
    if (!Number.isInteger(state.historySelectedIndex)) return;
    navigateTo(state.historySelectedIndex);
    const d = $("turnHistoryDialog");
    if (d && d.close) d.close();
  });
  const btnTurnHistoryBranch = $("btnTurnHistoryBranch");
  if (btnTurnHistoryBranch) btnTurnHistoryBranch.addEventListener("click", () => {
    if (!Number.isInteger(state.historySelectedIndex) || state.historySelectedIndex >= state.turns.length - 1) return;
    const turnIndex = state.historySelectedIndex;
    const d = $("turnHistoryDialog");
    if (d && d.close) d.close();
    promptBranchOrReset(turnIndex);
  });
  const btnTurnHistoryJumpLatest = $("btnTurnHistoryJumpLatest");
  if (btnTurnHistoryJumpLatest) btnTurnHistoryJumpLatest.addEventListener("click", () => {
    navigateTo(-1);
    const d = $("turnHistoryDialog");
    if (d && d.close) d.close();
  });

  // World Setup dialog
  const btnCloseWorldSetup = $("btnCloseWorldSetup");
  if (btnCloseWorldSetup) btnCloseWorldSetup.addEventListener("click", () => { const d = $("worldSetupDialog"); if (d && d.close) d.close(); });
  const btnDoneWorldSetup = $("btnDoneWorldSetup");
  if (btnDoneWorldSetup) btnDoneWorldSetup.addEventListener("click", () => { const d = $("worldSetupDialog"); if (d && d.close) d.close(); });
  // Image prompt dialog
  const btnRegenerateImageConfirm = $("btnRegenerateImageConfirm");
  if (btnRegenerateImageConfirm) btnRegenerateImageConfirm.addEventListener("click", () => {
    const dlg = $("imagePromptDialog");
    const editor = $("imagePromptEditor");
    if (dlg && dlg._segmentId && editor) {
      regenerateSegmentImage(dlg._segmentId, dlg._variantIndex || 0, editor.value);
      if (dlg.close) dlg.close();
    } else if (dlg && dlg._turnId && editor) {
      regenerateIllustration(dlg._turnId, editor.value);
      if (dlg.close) dlg.close();
    }
  });
  const btnImagePromptCancel = $("btnImagePromptCancel");
  if (btnImagePromptCancel) btnImagePromptCancel.addEventListener("click", () => { const d = $("imagePromptDialog"); if (d && d.close) d.close(); });
  // Branch dialog
  const branchDlg = $("branchStoryDialog");
  if (branchDlg) branchDlg.addEventListener("close", async () => {
    const result = branchDlg.returnValue;
    if (result === "reset" && branchDlg._turnIndex !== undefined) {
      showBusy("Rewinding campaign…");
      try {
        await api(`/campaigns/${state.campaignId}/rewind`, {
          method: "POST",
          body: JSON.stringify({ targetTurnNumber: branchDlg._turnIndex + 1 })
        });
        await loadCampaign(state.campaignId);
        navigateTo(-1);
        toast("Campaign rewound.");
      } catch (err) {
        toast(`Rewind failed: ${err.message}`);
      } finally {
        hideBusy();
      }
    }
    if (result === "copy" && branchDlg._turnIndex !== undefined) {
      showBusy("Creating campaign branch…");
      try {
        const newCampaign = await api(`/campaigns/${state.campaignId}/branch`, {
          method: "POST",
          body: JSON.stringify({ targetTurnNumber: branchDlg._turnIndex + 1 })
        });
        state.campaignId = newCampaign.id;
        const newUrl = new URL(window.location.href);
        newUrl.searchParams.set("campaignId", newCampaign.id);
        window.history.pushState({ campaignId: newCampaign.id }, "", newUrl.toString());
        await loadCampaign(newCampaign.id);
        navigateTo(-1);
        toast(`Switched to new campaign branch: "${newCampaign.title}"`);
      } catch (err) {
        toast(`Branch failed: ${err.message}`);
      } finally {
        hideBusy();
      }
    }
  });

  // Story and illustration rail delegated click handler.
  const handleStoryAction = (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "follow-stream") {
      followStreamingPreview();
      return;
    }
    if (btn.dataset.action === "previous-segment-image" || btn.dataset.action === "next-segment-image") {
      const segment = state.illustrationSegments.find((item) => item.id === btn.dataset.segmentId);
      const count = segment?.variants?.length || 0;
      if (!segment || count < 2) return;
      const current = state.illustrationVariantIndexes.get(segment.id) || 0;
      const offset = btn.dataset.action === "next-segment-image" ? 1 : -1;
      state.illustrationVariantIndexes.set(segment.id, (current + offset + count) % count);
      renderStoryIllustration();
      return;
    }
    const segmentId = btn.dataset.segmentId;
    const variantIndex = Number(btn.dataset.variantIndex || 0);
    if (btn.dataset.action === "edit-segment-image-prompt") {
      openSegmentImagePromptEditor(segmentId, variantIndex);
      return;
    }
    if (btn.dataset.action === "regenerate-segment-image") {
      regenerateSegmentImage(segmentId, variantIndex);
      return;
    }
    if (btn.dataset.action === "why-segment-image") {
      whySegmentImage(segmentId, variantIndex);
      return;
    }
    const turnId = btn.dataset.turnId;
    if (btn.dataset.action === "generate-turn-segments") generateTurnSegments(turnId, "missing");
    if (btn.dataset.action === "rebuild-turn-segments") generateTurnSegments(turnId, "rebuild");
    if (btn.dataset.action === "edit-image-prompt") openImagePromptEditor(turnId);
    if (btn.dataset.action === "regenerate-image") regenerateIllustration(turnId);
    if (btn.dataset.action === "find-library-match") findAnotherLibraryMatch(turnId);
    if (btn.dataset.action === "why-image") whyIllustration(turnId);
    if (btn.dataset.action === "remove-image") removeIllustration(turnId);
  };
  const storyArea = $("storyArea");
  if (storyArea) storyArea.addEventListener("click", handleStoryAction);
  const storyIllustrationPanel = $("storyIllustrationPanel");
  if (storyIllustrationPanel) storyIllustrationPanel.addEventListener("click", handleStoryAction);

  // A manual scroll means the reader has chosen their own position. Streaming
  // updates must not recapture the viewport until they explicitly resume.
  window.addEventListener("wheel", pauseStreamingAutoFollow, { passive: true });
  window.addEventListener("touchmove", pauseStreamingAutoFollow, { passive: true });
  window.addEventListener("scroll", () => {
    if (!state.streamingAutoFollow || !$("streamingPreviewCard")) return;
    if (state.streamingExpectedScrollY === null || Math.abs(window.scrollY - state.streamingExpectedScrollY) > 1) {
      pauseStreamingAutoFollow();
    }
  }, { passive: true });
  document.addEventListener("keydown", (e) => {
    const target = e.target;
    if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) {
      pauseStreamingAutoFollow();
    }
  });

  // Activity log
  function openActivityLog() {
    const dlg = $("activityLogDialog");
    if (!dlg) return;
    renderActivityLog();
    openManagedModal(dlg);
  }
  const btnCloseActivityLog = $("btnCloseActivityLog");
  if (btnCloseActivityLog) btnCloseActivityLog.addEventListener("click", () => { const d = $("activityLogDialog"); if (d && d.close) d.close(); });
  const btnCopyDiagnostics = $("btnCopyDiagnostics") || $("btnCopyActivityLog");
  if (btnCopyDiagnostics) btnCopyDiagnostics.addEventListener("click", copyActivityDiagnostics);
  const btnClearActivityLog = $("btnClearActivityLog");
  if (btnClearActivityLog) btnClearActivityLog.addEventListener("click", () => { state.activityLog = []; renderActivityLog(); toast("Activity log cleared."); });
  const btnActivityLogDone = $("btnActivityLogDone");
  if (btnActivityLogDone) btnActivityLogDone.addEventListener("click", () => { const d = $("activityLogDialog"); if (d && d.close) d.close(); });

  // Message Popup / Getting Started / Recovery
  const btnMessagePopupClose = $("btnMessagePopupClose");
  if (btnMessagePopupClose) btnMessagePopupClose.addEventListener("click", () => { const d = $("messagePopupDialog"); if (d && d.close) d.close(); });
  const btnSkipGettingStartedToStory = $("btnSkipGettingStartedToStory");
  if (btnSkipGettingStartedToStory) btnSkipGettingStartedToStory.addEventListener("click", () => { const d = $("gettingStartedDialog"); if (d && d.close) d.close(); });
  const btnDiscardGenerationRecovery = $("btnDiscardGenerationRecovery");
  if (btnDiscardGenerationRecovery) btnDiscardGenerationRecovery.addEventListener("click", discardRecoveryJob);
  const btnContinueGeneration = $("btnContinueGeneration");
  if (btnContinueGeneration) btnContinueGeneration.addEventListener("click", () => monitorRecoveryJob(false));
  const btnRetryGeneration = $("btnRetryGeneration");
  if (btnRetryGeneration) btnRetryGeneration.addEventListener("click", () => monitorRecoveryJob(true));

  // Edit Response dialog
  const btnEditResponse = $("btnEditResponse");
  if (btnEditResponse) btnEditResponse.addEventListener("click", () => {
    const dlg = $("editResponseDialog");
    const editor = $("responseEditor");
    if (!dlg || !editor) return;
    const turnIdx = state.viewIndex === -1 ? state.turns.length - 1 : state.viewIndex;
    if (turnIdx < 0) return;
    editor.value = state.turns[turnIdx].narration || "";
    dlg._turnIndex = turnIdx;
    openManagedModal(dlg);
  });
  const btnEditResponseSave = $("btnEditResponseSave");
  if (btnEditResponseSave) btnEditResponseSave.addEventListener("click", () => {
    const dlg = $("editResponseDialog");
    const editor = $("responseEditor");
    if (!dlg || !editor || dlg._turnIndex === undefined) return;
    state.turns[dlg._turnIndex].narration = editor.value;
    renderAllScenes();
    if (dlg.close) dlg.close();
    toast("Response updated locally.");
  });
  const btnEditResponseCancel = $("btnEditResponseCancel");
  if (btnEditResponseCancel) btnEditResponseCancel.addEventListener("click", () => { const d = $("editResponseDialog"); if (d && d.close) d.close(); });
  const btnEditResponseClose = $("btnEditResponseClose");
  if (btnEditResponseClose) btnEditResponseClose.addEventListener("click", () => { const d = $("editResponseDialog"); if (d && d.close) d.close(); });

  // Keyboard: Escape closes dialogs and returns navigation to its compact state.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      document.querySelectorAll("dialog[open]").forEach(d => { if (d.close) d.close(); });
      closeNavigationMenus();
    }
  });

  // Start
  fetch("/api/v1/meta")
    .then(response => response.ok ? response.json() : null)
    .then(metadata => {
      const application = metadata?.application;
      if (!application?.version) return;
      const versionLabel = `Nexus v${application.version}`;
      const storyVersion = $("storyNexusVersion");
      if (storyVersion) {
        storyVersion.textContent = versionLabel;
        storyVersion.classList.remove("hidden");
      }
      const aboutVersion = $("aboutNexusVersion");
      if (aboutVersion) aboutVersion.textContent = `v${application.version}`;
      if (application.commit) {
        $("aboutNexusCommit").textContent = application.commit;
        $("aboutNexusCommitRow").classList.remove("hidden");
      }
      if (application.builtAt) {
        const builtAt = new Date(application.builtAt);
        $("aboutNexusBuiltAt").textContent = Number.isNaN(builtAt.valueOf()) ? application.builtAt : builtAt.toLocaleString();
        $("aboutNexusBuiltAtRow").classList.remove("hidden");
      }
    })
    .catch(() => {});
  init();
});

})();
