import type {
  AuthoringJobView,
  AuthoringResult,
  AuthoringReview,
  AuthoringRetry,
  AuthoringRevisionCommand
} from "../../../packages/contracts/src/authoring.js";

export interface AuthoringResumeState {
  jobId: string;
  observedRevision: number;
  localDirty: boolean;
}

export type AuthoringSaveState = "idle" | "saving" | "saved" | "conflict" | "error";

export interface AuthoringJobSessionState extends AuthoringResumeState {
  saveState: AuthoringSaveState;
  pendingGeneratedResult: boolean;
  remoteCandidate: AuthoringResult | null;
  commandPending: boolean;
  unavailable: boolean;
  job: AuthoringJobView;
}

export interface AuthoringJobSessionOptions {
  job: AuthoringJobView;
  saveReview?: (id: string, input: AuthoringReview, signal?: AbortSignal) => Promise<AuthoringJobView>;
  loadAuthoringJob?: (id: string, signal?: AbortSignal) => Promise<AuthoringJobView>;
  retryStage?: (id: string, input: AuthoringRetry, signal?: AbortSignal) => Promise<AuthoringJobView>;
  cancel?: (id: string, input: AuthoringRevisionCommand, signal?: AbortSignal) => Promise<AuthoringJobView>;
  isHidden?: () => boolean;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  onChange?: () => void;
}

export interface AuthoringJobSession {
  edit(candidate: AuthoringResult | null): void;
  receive(job: AuthoringJobView): void;
  currentCandidate(): AuthoringResult | null;
  hasPendingGeneratedResult(): boolean;
  adoptPendingResult(): AuthoringResult | null;
  state(): AuthoringJobSessionState;
  startPolling(): void;
  retry(stageId: string): Promise<void>;
  cancel(): Promise<void>;
  flush(): Promise<void>;
  reload(): Promise<void>;
  dispose(): void;
}

function isTerminal(status: AuthoringJobView["status"]): boolean {
  return ["cancelled", "applied", "expired", "failed"].includes(status);
}

function candidateFor(job: AuthoringJobView): AuthoringResult | null {
  return job.reviewedContent ?? job.result ?? null;
}

function equal(value: unknown, next: unknown): boolean {
  return JSON.stringify(value) === JSON.stringify(next);
}

export function createAuthoringJobSession(options: AuthoringJobSessionOptions): AuthoringJobSession {
  const later = options.setTimeout ?? globalThis.setTimeout;
  const cancelTimer = options.clearTimeout ?? globalThis.clearTimeout;
  let job = options.job;
  let candidate = candidateFor(job);
  let remoteCandidate: AuthoringResult | null = null;
  let localDirty = false;
  let saveState: AuthoringSaveState = "idle";
  let commandPending = false;
  let disposed = false;
  let unavailable = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let saveGeneration = 0;
  let pollGeneration = 0;
  let backoffMs = 1_000;
  let saveController: AbortController | null = null;
  let pollController: AbortController | null = null;
  let commandController: AbortController | null = null;
  let conflictFrozen = false;
  let editGeneration = 0;
  let reloadController: AbortController | null = null;
  let saving: Promise<void> | null = null;
  let savingCandidate: AuthoringResult | null = null;
  // Undefined means no review has ever been saved: select the then-current
  // validated stages for the first review only. Once a review exists, its
  // deliberate subset (including []) is authoritative until replaced.
  let savedSelection: string[] | null = job.reviewedStageIds === undefined ? null : [...job.reviewedStageIds];

  function currentValidatedStages() {
    return job.stages.filter(stage => stage.status === "validated" &&
      !job.stages.some(other => other.key === stage.key && other.generation > stage.generation));
  }
  function selectedStageIds(): string[] {
    return savedSelection === null
      ? currentValidatedStages().map(stage => stage.id)
      : [...savedSelection];
  }
  function clearSaveTimer(): void { if (saveTimer !== null) cancelTimer(saveTimer); saveTimer = null; }
  function clearPollTimer(): void { if (pollTimer !== null) cancelTimer(pollTimer); pollTimer = null; }
  function abortAll(): void {
    saveController?.abort(); saveController = null;
    pollController?.abort(); pollController = null;
    commandController?.abort(); commandController = null;
    reloadController?.abort(); reloadController = null;
  }
  function snapshot(): AuthoringJobSessionState {
    return { jobId: job.id, observedRevision: job.revision, localDirty, saveState, pendingGeneratedResult: remoteCandidate !== null, remoteCandidate, commandPending, unavailable, job };
  }
  function notify(): void { options.onChange?.(); }
  function save(): Promise<void> {
    if (saving) return saving;
    saving = persistReview().finally(() => { saving = null; });
    return saving;
  }
  async function persistReview(): Promise<void> {
    clearSaveTimer();
    if (disposed || unavailable || saveController || isTerminal(job.status) || !localDirty || !candidate || !options.saveReview || commandPending || conflictFrozen) return;
    const generation = ++saveGeneration;
    const savedEditGeneration = editGeneration;
    const expectedRevision = job.revision;
    saveState = "saving";
    const signal = new AbortController();
    saveController = signal;
    savingCandidate = candidate;
    notify();
    try {
      const received = await options.saveReview(job.id, { expectedRevision, content: candidate, selectedStageIds: selectedStageIds() }, signal.signal);
      if (disposed || generation !== saveGeneration || saveController !== signal) return;
      const editedWhileSaving = editGeneration !== savedEditGeneration;
      if (received.revision >= job.revision) {
        job = received;
        if (!editedWhileSaving && received.reviewedStageIds !== undefined) savedSelection = [...received.reviewedStageIds];
      }
      // Content and selection belong to the same review. A response can only
      // acknowledge the edit generation it submitted, including selection-only adoption.
      localDirty = editedWhileSaving || !equal(candidate, received.reviewedContent ?? received.result);
      saveState = localDirty ? "idle" : "saved";
      if (localDirty) scheduleSave();
      notify();
    } catch (error) {
      if (disposed || generation !== saveGeneration || signal.signal.aborted) return;
      conflictFrozen = (error as { status?: number }).status === 409;
      saveState = conflictFrozen ? "conflict" : "error";
      notify();
    } finally {
      if (saveController === signal) { saveController = null; savingCandidate = null; }
    }
  }
  function scheduleSave(): void {
    clearSaveTimer();
    saveTimer = later(() => { void save(); }, 500);
  }
  function schedulePoll(delay: number): void {
    clearPollTimer();
    if (disposed || unavailable || isTerminal(job.status) || !options.loadAuthoringJob) return;
    pollTimer = later(() => { void poll(); }, Math.max(1_000, Math.min(5_000, delay)));
  }
  async function poll(): Promise<void> {
    pollTimer = null;
    if (disposed || unavailable || isTerminal(job.status) || !options.loadAuthoringJob) return;
    if (options.isHidden?.()) { schedulePoll(1_000); return; }
    const generation = ++pollGeneration;
    const signal = new AbortController();
    pollController = signal;
    try {
      const received = await options.loadAuthoringJob(job.id, signal.signal);
      if (disposed || generation !== pollGeneration || pollController !== signal) return;
      receive(received);
      backoffMs = 1_000;
    } catch (error) {
      if (!disposed && !signal.signal.aborted && (error as { status?: number }).status === 404) {
        unavailable = true; remoteCandidate = null; clearSaveTimer(); saveGeneration += 1; saveController?.abort(); notify();
      }
      if (!disposed && !signal.signal.aborted && generation === pollGeneration) backoffMs = Math.min(5_000, backoffMs * 2);
    } finally {
      if (pollController === signal) pollController = null;
    }
    schedulePoll(backoffMs);
  }
  function receive(received: AuthoringJobView): void {
    if (disposed || unavailable || received.id !== job.id || received.revision < job.revision) return;
    if (conflictFrozen && !isTerminal(received.status)) return;
    if (!isTerminal(received.status) && received.reviewedContent && !equal(received.reviewedContent, job.reviewedContent) && !equal(received.reviewedContent, candidate) && !equal(received.reviewedContent, savingCandidate)) {
      conflictFrozen = true; saveState = "conflict"; remoteCandidate = received.reviewedContent; job = received;
      if (received.reviewedStageIds !== undefined) savedSelection = [...received.reviewedStageIds];
      saveGeneration += 1; saveController?.abort();
      clearSaveTimer(); notify(); return;
    }
    const priorResult = job.result;
    const generated = received.result ?? candidateFor(received);
    const newlyGenerated = received.result !== undefined && !equal(received.result, priorResult);
    job = received;
    if (!localDirty && received.reviewedStageIds !== undefined) savedSelection = [...received.reviewedStageIds];
    if (isTerminal(received.status)) {
      clearSaveTimer(); clearPollTimer();
      saveState = "idle";
      saveGeneration += 1; saveController?.abort(); saveController = null; savingCandidate = null;
      remoteCandidate = null;
      notify();
      return;
    }
    if (remoteCandidate && !newlyGenerated) { notify(); return; }
    if (received.reviewedContent && !localDirty && !newlyGenerated) {
      candidate = received.reviewedContent;
      remoteCandidate = null;
      notify();
      return;
    }
    if (received.reviewedContent && !localDirty && newlyGenerated && equal(candidate, received.reviewedContent)) {
      remoteCandidate = received.result ?? null;
      notify();
      return;
    }
    if (generated && localDirty && (newlyGenerated || !equal(generated, candidate))) {
      remoteCandidate = generated;
      notify();
      return;
    }
    if (generated) candidate = generated;
    remoteCandidate = null;
    notify();
  }
  async function command(run: (signal: AbortSignal) => Promise<AuthoringJobView>): Promise<void> {
    if (disposed || unavailable || commandPending) return;
    commandPending = true;
    commandController?.abort();
    const signal = new AbortController();
    commandController = signal;
    notify();
    try { receive(await run(signal.signal)); }
    finally { if (commandController === signal) commandController = null; commandPending = false; if (!disposed) { notify(); if (localDirty && !conflictFrozen) scheduleSave(); schedulePoll(1_000); } }
  }
  return {
    edit(next) { if (disposed) return; editGeneration += 1; candidate = next; localDirty = true; if (!conflictFrozen) { saveState = "idle"; scheduleSave(); } notify(); },
    receive,
    currentCandidate: () => candidate,
    hasPendingGeneratedResult: () => remoteCandidate !== null,
    adoptPendingResult() {
      if (disposed || unavailable || conflictFrozen || isTerminal(job.status)) return null;
      let selectionChanged = false;
      // Explicit review reconciles stage identity even when replacement text
      // is identical or the replacement was already present on resume. Polls
      // and ordinary edits must never advance the saved selection themselves.
      if (savedSelection !== null) {
        const selectedKeys = new Set(job.stages.filter(stage => savedSelection!.includes(stage.id)).map(stage => stage.key));
        const selection = currentValidatedStages().filter(stage => selectedKeys.has(stage.key)).map(stage => stage.id);
        selectionChanged = !equal(savedSelection, selection);
        savedSelection = selection;
      }
      if (selectionChanged || remoteCandidate) editGeneration += 1;
      if (remoteCandidate) {
        candidate = remoteCandidate; remoteCandidate = null; localDirty = true;
      }
      if (selectionChanged || localDirty) {
        localDirty = true;
        saveState = "idle"; scheduleSave(); notify();
      }
      return candidate;
    },
    state: snapshot,
    startPolling() { schedulePoll(1_000); },
    async retry(stageId) { if (!options.retryStage) return; await command((signal) => options.retryStage!(job.id, { stageId, expectedRevision: job.revision }, signal)); },
    async cancel() {
      if (!options.cancel) return;
      await command(async signal => {
        // Cancellation does not adopt or overwrite either review buffer.
        const latest = options.loadAuthoringJob ? await options.loadAuthoringJob(job.id, signal) : job;
        if (signal.aborted || latest.id !== job.id) return job;
        return options.cancel!(job.id, { expectedRevision: latest.revision }, signal);
      });
    },
    async flush() {
      clearSaveTimer();
      if (saving) await saving;
      if (localDirty) await save();
      clearSaveTimer();
      if (disposed || unavailable || localDirty || saveState === "conflict" || saveState === "error") throw new Error("Review is not saved.");
    },
    async reload() {
      if (!options.loadAuthoringJob || disposed) return;
      reloadController?.abort();
      const controller = new AbortController(); reloadController = controller;
      const startingEdit = editGeneration;
      const received = await options.loadAuthoringJob(job.id, controller.signal);
      if (disposed || controller.signal.aborted || received.id !== job.id || received.revision < job.revision) return;
      reloadController = null;
      conflictFrozen = false;
      if (startingEdit !== editGeneration) { receive(received); return; }
      clearSaveTimer(); saveGeneration += 1; saveController?.abort();
      job = received; if (received.reviewedStageIds !== undefined) savedSelection = [...received.reviewedStageIds]; candidate = candidateFor(received); localDirty = false; remoteCandidate = null; saveState = "saved";
      notify(); schedulePoll(1_000);
    },
    dispose() { if (disposed) return; disposed = true; clearSaveTimer(); clearPollTimer(); abortAll(); }
  };
}
