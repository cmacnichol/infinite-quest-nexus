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
  imagePollTimer: null,
  activityLog: [],
  toastTimer: null,
  streamingAutoFollow: true,
  streamingExpectedScrollY: null,
  user: {
    id: null,
    systemKey: null,
    displayName: "Initial Owner",
    settings: {
      autoSubmitTurnChoices: true,
      continuousReading: false
    }
  }
};

// ── API Layer ──────────────────────────────────────────────────
async function api(path, options = {}) {
  const url = "/api/v1" + path;
  const headers = { "Content-Type": "application/json" };
  if (options.headers) Object.assign(headers, options.headers);
  const response = await fetch(url, { ...options, headers });
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
  if (btnAction) btnAction.disabled = generationLocked;
  if (freeAction) freeAction.disabled = generationLocked;
  document.querySelectorAll("#choiceArea .choice").forEach(b => { b.disabled = generationLocked; });

  const btnPrev = $("btnPrev");
  const btnNext = $("btnNext");
  const btnUndo = $("btnUndo");
  const btnRetry = $("btnRetry");

  const turnCount = state.turns ? state.turns.length : 0;
  const curr = state.viewIndex === -1 ? turnCount - 1 : state.viewIndex;
  const isLatest = state.viewIndex === -1 || state.viewIndex >= turnCount - 1;
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
      if (dlg && dlg.showModal) dlg.showModal();
    }
  } catch (err) {
    recordActivity("error", "Failed to load providers", err.message);
  }
}

// ── Campaign Loading ──────────────────────────────────────────
async function loadCampaign(campaignId) {
  showBusy("Loading campaign…");
  try {
    const syncData = await api(`/campaigns/${campaignId}/sync-status`);
    state.campaign = syncData.campaign || syncData;
    state.world = syncData.world || state.campaign.world || null;
    state.playerConfig = syncData.playerConfig || state.campaign.playerConfig || null;
    state.pendingGeneration = syncData.pendingGeneration || null;

    const turnData = await api(`/campaigns/${campaignId}/turns`);
    state.turns = turnData.turns || [];
    state.runtimeState = await api(`/campaigns/${campaignId}/state`);

    // Set title
    const titleEl = $("storyTitle");
    const name = state.campaign.title || state.world?.title || "Untitled Campaign";
    if (titleEl) titleEl.textContent = name;
    document.title = `${name} — Infinite Quest`;

    state.viewIndex = -1;
    renderAllScenes();
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
      dialog.showModal();
    } catch (err) {
      dialog.removeEventListener("close", done);
      resolve(false);
    }
  });
}

async function startAdventure(options = {}) {
  if (state.busy) return;
  await showBackgroundStoryBeforeStart();
  await runGeneration(firstActionForNewAdventure());
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
  const hasImage = turn.imageAssetUrl || turn.imageUrl;
  const sceneDiv = document.createElement("div");
  sceneDiv.className = `scene${hasImage ? "" : " no-image"}`;
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
    narrationHtml += `<div class="narration">${sanitizeNarration(turn.narration)}</div>`;
  }

  // After-event trigger text
  if (turn.mechanics?.afterEvents?.length) {
    turn.mechanics.afterEvents.forEach(evt => {
      narrationHtml += `<div class="action-tag" style="border-color:rgba(116,228,255,.3);color:var(--accent2);">⚡ ${escapeHtml(evt.name || evt.label || "Event")} — ${escapeHtml(evt.text || evt.effect || "")}</div>`;
    });
  }

  // Image column
  let imageHtml = "";
  if (hasImage) {
    const src = turn.imageAssetUrl || turn.imageUrl;
    const turnId = turn.id || turn.turnId || "";
    imageHtml = `<div class="image-wrap">
      <img src="${escapeHtml(src)}" alt="Illustration for turn ${index + 1}" loading="lazy" />
      <div class="image-actions">
        <button class="small ghost" type="button" data-turn-id="${escapeHtml(turnId)}" data-action="edit-image-prompt" title="Edit image prompt">✏️</button>
        <button class="small ghost" type="button" data-turn-id="${escapeHtml(turnId)}" data-action="regenerate-image" title="Regenerate image">🔄</button>
      </div>
    </div>`;
  }

  sceneDiv.innerHTML = `<div class="scene-narration">${narrationHtml}</div>${imageHtml}`;
  return sceneDiv;
}

function renderAllScenes() {
  const container = $("storyArea");
  if (!container) return;

  container.innerHTML = "";

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

  scrollToView();
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
          submitAction(text);
        } else {
          const freeAction = $("freeAction");
          if (freeAction) {
            freeAction.value = text;
            freeAction.focus();
          }
          toast("Loaded choice into action box for editing.", 2400);
        }
      });
      container.appendChild(btn);
    });
  }
  const freeAction = $("freeAction");
  if (freeAction && customSuggestion) {
    freeAction.placeholder = customSuggestion;
  }
}

async function submitAction(actionText) {
  if (state.busy) return;
  let action = (actionText || "").trim();
  if (!action && state.turns.length === 0) {
    action = firstActionForNewAdventure();
  }
  if (!action) { toast("Enter an action first."); return; }
  const freeAction = $("freeAction");
  if (freeAction) freeAction.value = "";
  await runGeneration(action);
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

    const jobRes = await enqueueGenerationSubmission(submission);

    const jobId = jobRes.id || jobRes.jobId;
    if (!jobId) throw new Error("No job ID returned from generation request.");

    state.pendingGeneration = { ...jobRes, id: jobId, action, operationKind, expectedTurnNumber };
    renderAllScenes();
    await pollGenerationJob(jobId, action);
  } catch (err) {
    clearStreamingPreview();
    if (err.pendingGeneration) state.pendingGeneration = err.pendingGeneration;
    renderAllScenes();
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
    await pollGenerationJob(jobId, state.pendingGeneration?.action || "");
  } catch (error) {
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
    renderAllScenes();
    toast("Generation job discarded. The accepted turn was preserved.");
  } catch (error) {
    toast(`Could not discard generation: ${error.message}`);
  } finally {
    hideBusy();
  }
}

async function pollGenerationJob(jobId, action) {
  let retriesUsed = 0;
  clearStreamingPreview();

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
                clearPendingSubmission();
                state.pendingGeneration = null;
                recordActivity("success", "Turn generated", `Turn ${result.turnNumber || ""} completed.`);
                clearStreamingPreview();
                await loadCampaign(state.campaignId);
                pollImageJobs();
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
      clearPendingSubmission();
      state.pendingGeneration = null;
      recordActivity("success", "Turn generated", `Turn ${result.turnNumber || ""} completed.`);
      clearStreamingPreview();
      await loadCampaign(state.campaignId);
      pollImageJobs();
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
      renderAllScenes();
      const progressEl = $("generationProgress");
      if (progressEl) progressEl.classList.remove("hidden");
      try {
        await pollGenerationJob(pending.id, pending.action || "");
        return true;
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
        createdAt: stored.createdAt
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
  // Show/hide input action based on view mode
  const inputAction = document.querySelector(".input-action");
  if (inputAction) {
    if (!isLatest) {
      inputAction.style.opacity = "0.4";
      inputAction.style.pointerEvents = "none";
    } else {
      inputAction.style.opacity = "";
      inputAction.style.pointerEvents = "";
    }
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
  dialog.showModal();
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
  closeRetryPromptDialog();
  await runGeneration(action, {
    operationKind: "replace_latest",
    expectedCurrentTurnNumber: currentTurnNumber
  });
}

function promptBranchOrReset(turnIndex) {
  const dlg = $("branchStoryDialog");
  if (!dlg) return;
  const msg = $("branchStoryMessage");
  if (msg) msg.textContent = `You selected Turn ${turnIndex + 1} (of ${state.turns.length}). Choose what should happen to later turns before continuing.`;
  dlg._turnIndex = turnIndex;
  if (dlg.showModal) dlg.showModal();
}

// ── Illustration Management ───────────────────────────────────
function pollImageJobs() {
  if (state.imagePollTimer) clearTimeout(state.imagePollTimer);
  if (!state.campaignId) return;

  const poll = async () => {
    try {
      const data = await api(`/campaigns/${state.campaignId}/image-jobs`);
      const jobs = data.jobs || data || [];
      let anyPending = false;
      for (const job of jobs) {
        if (job.status === "completed" && job.assetUrl) {
          // Update the matching scene's image if not already showing
          updateSceneImage(job.turnId, job.assetUrl);
        }
        if (job.status === "pending" || job.status === "generating") {
          anyPending = true;
        }
      }
      if (anyPending) {
        state.imagePollTimer = setTimeout(poll, IMAGE_POLL_MS);
      }
    } catch (_) { /* ignore polling errors */ }
  };
  poll();
}

function updateSceneImage(turnId, assetUrl) {
  if (!turnId || !assetUrl) return;
  // Find the turn index
  const turnIdx = state.turns.findIndex(t => (t.id || t.turnId) === turnId);
  if (turnIdx < 0) return;
  state.turns[turnIdx].imageAssetUrl = assetUrl;
  const sceneEl = $(`scene-${turnIdx}`);
  if (!sceneEl) return;
  // Check if image already present
  if (sceneEl.querySelector(".image-wrap img")) return;
  // Add the image-wrap
  sceneEl.classList.remove("no-image");
  const imgDiv = document.createElement("div");
  imgDiv.className = "image-wrap";
  imgDiv.innerHTML = `<img src="${escapeHtml(assetUrl)}" alt="Illustration for turn ${turnIdx + 1}" loading="lazy" />
    <div class="image-actions">
      <button class="small ghost" type="button" data-turn-id="${escapeHtml(turnId)}" data-action="edit-image-prompt" title="Edit image prompt">✏️</button>
      <button class="small ghost" type="button" data-turn-id="${escapeHtml(turnId)}" data-action="regenerate-image" title="Regenerate image">🔄</button>
    </div>`;
  sceneEl.appendChild(imgDiv);
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
  if (dlg.showModal) dlg.showModal();
}

async function regenerateIllustration(turnId, prompt) {
  try {
    showBusy("Queueing illustration…");
    await api(`/turns/${turnId}/illustrations`, {
      method: "POST",
      body: JSON.stringify({ prompt: prompt || undefined, replace: true })
    });
    toast("Illustration queued.");
    recordActivity("system", "Illustration queued", `turnId=${turnId}`);
    pollImageJobs();
  } catch (err) {
    toast(`Failed to queue illustration: ${err.message}`);
    recordActivity("error", "Illustration queue failed", err.message);
  } finally {
    hideBusy();
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
    if (dlg.showModal) dlg.showModal();
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
  if (d && d.showModal) d.showModal();
}

function openUserProfile() {
  const dlg = $("userProfileDialog");
  if (!dlg) return;
  const nameInput = $("userProfileDisplayName");
  const cbSubmit = $("userProfileAutoSubmitChoices");
  const cbContinuous = $("userProfileContinuousReading");
  if (nameInput) nameInput.value = state.user?.displayName || "Initial Owner";
  if (cbSubmit) cbSubmit.checked = state.user?.settings?.autoSubmitTurnChoices !== false;
  if (cbContinuous) cbContinuous.checked = Boolean(state.user?.settings?.continuousReading);
  if (dlg.showModal) dlg.showModal();
}

async function saveUserProfile() {
  const nameInput = $("userProfileDisplayName");
  const cbSubmit = $("userProfileAutoSubmitChoices");
  const cbContinuous = $("userProfileContinuousReading");
  const displayName = nameInput ? nameInput.value.trim() : "";
  const autoSubmitTurnChoices = cbSubmit ? cbSubmit.checked : true;
  const continuousReading = cbContinuous ? cbContinuous.checked : false;

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
          continuousReading
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
  if (dlg && dlg.showModal) dlg.showModal();
  populateHistoryContainer($("turnHistoryModalList"), "turnHistoryDialog");
  const turnNumber = state.viewIndex === -1 ? state.turns.length : state.viewIndex + 1;
  await inspectTurnState(turnNumber);
}

function populateHistoryContainer(container, dialogId) {
  if (!container) return;
  container.innerHTML = "";
  if (state.turns.length === 0) {
    container.innerHTML = `<p class="dim mini">No turns recorded yet.</p>`;
    return;
  }
  const currentIdx = state.viewIndex === -1 ? state.turns.length - 1 : state.viewIndex;
  state.turns.forEach((t, i) => {
    const card = document.createElement("div");
    card.className = "history-card";
    const preview = (t.narration || "").slice(0, 140) + ((t.narration || "").length > 140 ? "…" : "");
    const isPastTurn = i < state.turns.length - 1;
    card.innerHTML = `
      <h4>${i === currentIdx ? "◆ " : ""}Turn ${i + 1}${t.action ? `: ${escapeHtml(t.action.slice(0, 60))}` : (i === 0 ? ": Adventure Begin" : "")}</h4>
      <p>${escapeHtml(preview)}</p>
      <div class="row wrap history-card-actions" style="margin-top: 8px; gap: 8px; justify-content: flex-end;">
        <button type="button" class="history-state-btn mini">Inspect State</button>
        <button type="button" class="history-jump-btn mini">Jump to Scene</button>
        ${isPastTurn ? `<button type="button" class="history-branch-btn mini accent">Restart / Branch from Here…</button>` : ""}
      </div>
    `;
    const stateBtn = card.querySelector(".history-state-btn");
    if (stateBtn) stateBtn.addEventListener("click", () => inspectTurnState(i + 1));
    const jumpBtn = card.querySelector(".history-jump-btn");
    if (jumpBtn) {
      jumpBtn.addEventListener("click", () => {
        navigateTo(i);
        const dlg = $(dialogId);
        if (dlg && dlg.close) dlg.close();
      });
    }
    if (isPastTurn) {
      const branchBtn = card.querySelector(".history-branch-btn");
      if (branchBtn) {
        branchBtn.addEventListener("click", () => {
          const dlg = $(dialogId);
          if (dlg && dlg.close) dlg.close();
          promptBranchOrReset(i);
        });
      }
    }
    container.appendChild(card);
  });
}

async function inspectTurnState(turnNumber) {
  const panel = $("turnHistoryStatePanel");
  if (!panel || !state.campaignId) return;
  panel.classList.remove("hidden");
  panel.innerHTML = `<p class="mini">Loading state after turn ${turnNumber}…</p>`;
  try {
    const runtime = await api(`/campaigns/${state.campaignId}/state?turnNumber=${turnNumber}`);
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

  if (dlg.showModal) dlg.showModal();
}

// ── Export Functions ──────────────────────────────────────────
async function exportJson() {
  if (!state.campaignId) return;
  try {
    const data = await api(`/campaigns/${state.campaignId}/export`);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const name = (state.campaign?.title || "story").replace(/[^a-zA-Z0-9_-]/g, "_");
    downloadBlob(blob, `${name}.story`);
    toast("Story file downloaded.");
  } catch (err) {
    toast(`Export failed: ${err.message}`);
  }
}

async function exportHtml() {
  if (!state.campaignId) return;
  try {
    const data = await api(`/campaigns/${state.campaignId}/export`);
    const title = escapeHtml(data.title || state.campaign?.title || "Infinite Quest Story");
    const turns = (data.turns || state.turns).map((t, i) => {
      let s = `<div class="turn"><h2>Turn ${i + 1}${t.action ? ": " + escapeHtml(t.action) : ""}</h2>`;
      if (t.narration) s += t.narration.split("\n").filter(p => p.trim()).map(p => `<p>${escapeHtml(p)}</p>`).join("");
      s += `</div>`;
      return s;
    }).join("");
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:Georgia,serif;max-width:860px;margin:40px auto;padding:0 20px;line-height:1.6;background:#10131c;color:#f8f1ff}img{max-width:100%;border-radius:18px}.turn{border-top:1px solid #444;padding:24px 0}h1,h2{color:#ffdc66}</style></head><body><h1>${title}</h1>${turns}</body></html>`;
    downloadBlob(new Blob([html], { type: "text/html" }), `${(data.title || "story").replace(/[^a-zA-Z0-9_-]/g, "_")}.html`);
    toast("HTML export downloaded.");
  } catch (err) {
    toast(`Export failed: ${err.message}`);
  }
}

async function exportMarkdown() {
  if (!state.campaignId) return;
  try {
    const data = await api(`/campaigns/${state.campaignId}/export`);
    const title = data.title || state.campaign?.title || "Story";
    let md = `# ${title}\n\n`;
    (data.turns || state.turns).forEach((t, i) => {
      md += `## Turn ${i + 1}${t.action ? ": " + t.action : ""}\n\n`;
      if (t.narration) md += t.narration + "\n\n";
    });
    downloadBlob(new Blob([md], { type: "text/markdown" }), `${title.replace(/[^a-zA-Z0-9_-]/g, "_")}.md`);
    toast("Markdown export downloaded.");
  } catch (err) {
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

// ── Menu & Dialog Management ──────────────────────────────────
function toggleMenu() {
  const dd = $("menuDropdown");
  const btn = $("btnMenu");
  if (!dd) return;
  const open = !dd.classList.contains("hidden");
  dd.classList.toggle("hidden");
  if (btn) btn.setAttribute("aria-expanded", String(!open));
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
    localStorage.setItem("infiniteQuestLastCampaignId", state.campaignId);
  } else {
    localStorage.removeItem("infiniteQuestLastCampaignId");
    window.location.href = "/nexus/#campaigns";
    return;
  }
  await checkOnboarding();
  await loadCampaign(state.campaignId);
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
  if (freeAction) freeAction.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitAction(freeAction.value); }
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

  // Menu
  const btnMenu = $("btnMenu");
  if (btnMenu) btnMenu.addEventListener("click", toggleMenu);

  // Close menu on outside click
  document.addEventListener("click", (e) => {
    const dd = $("menuDropdown");
    const btn = $("btnMenu");
    if (dd && !dd.classList.contains("hidden") && !dd.contains(e.target) && e.target !== btn) {
      dd.classList.add("hidden");
      if (btn) btn.setAttribute("aria-expanded", "false");
    }
  });

  // Menu items
  const btnOpenWorldSetup = $("btnOpenWorldSetup");
  if (btnOpenWorldSetup) btnOpenWorldSetup.addEventListener("click", () => { toggleMenu(); openWorldSetup(); });
  const btnExportJson = $("btnExportJson");
  if (btnExportJson) btnExportJson.addEventListener("click", () => { toggleMenu(); exportJson(); });
  const btnExportMarkdown = $("btnExportMarkdown");
  if (btnExportMarkdown) btnExportMarkdown.addEventListener("click", () => { toggleMenu(); exportMarkdown(); });
  const btnExportHtml = $("btnExportHtml");
  if (btnExportHtml) btnExportHtml.addEventListener("click", () => { toggleMenu(); exportHtml(); });
  const btnOpenEditState = $("btnOpenEditState");
  if (btnOpenEditState) btnOpenEditState.addEventListener("click", () => { toggleMenu(); openEditState(); });
  const btnOpenActivityLog = $("btnOpenActivityLog");
  if (btnOpenActivityLog) btnOpenActivityLog.addEventListener("click", () => { toggleMenu(); openActivityLog(); });

  const btnOpenUserProfile = $("btnOpenUserProfile");
  if (btnOpenUserProfile) btnOpenUserProfile.addEventListener("click", openUserProfile);
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
    if (dlg && dlg._turnId && editor) {
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

  // Story area delegated click handler for image actions
  const storyArea = $("storyArea");
  if (storyArea) storyArea.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "follow-stream") {
      followStreamingPreview();
      return;
    }
    const turnId = btn.dataset.turnId;
    if (btn.dataset.action === "edit-image-prompt") openImagePromptEditor(turnId);
    if (btn.dataset.action === "regenerate-image") regenerateIllustration(turnId);
  });

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
    if (dlg.showModal) dlg.showModal();
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
    if (dlg.showModal) dlg.showModal();
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

  // Keyboard: Escape closes dialogs
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      document.querySelectorAll("dialog[open]").forEach(d => { if (d.close) d.close(); });
      const dd = $("menuDropdown");
      if (dd && !dd.classList.contains("hidden")) {
        dd.classList.add("hidden");
        const btn = $("btnMenu");
        if (btn) btn.setAttribute("aria-expanded", "false");
      }
    }
  });

  // Start
  init();
});

})();
