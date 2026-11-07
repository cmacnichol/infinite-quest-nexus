export type EditDismissalDecision = "save" | "discard" | "stay";
export type EditDismissalResult = "dismissed" | "stayed";

export interface EditDismissalOptions {
  dialog: HTMLDialogElement;
  isDirty: () => boolean;
  isBusy: () => boolean;
  save?: () => void | Promise<void>;
  discard: () => void | Promise<void>;
  confirm: () => EditDismissalDecision | Promise<EditDismissalDecision>;
  returnFocusTo?: HTMLElement;
  isCurrent?: () => boolean;
}

export type NativeDismissalOptions = Omit<EditDismissalOptions, "dialog">;

const dismissalRequests = new WeakMap<HTMLDialogElement, Promise<EditDismissalResult>>();

/** Serializes every dismissal path for one dialog and closes it only after an accepted decision. */
export function requestEditDismissal(options: EditDismissalOptions): Promise<EditDismissalResult> {
  const pending = dismissalRequests.get(options.dialog);
  if (pending) return pending;

  const request = performEditDismissal(options).finally(() => {
    if (dismissalRequests.get(options.dialog) === request) dismissalRequests.delete(options.dialog);
  });
  dismissalRequests.set(options.dialog, request);
  return request;
}

async function performEditDismissal({ dialog, isDirty, isBusy, save, discard, confirm, returnFocusTo, isCurrent }: EditDismissalOptions): Promise<EditDismissalResult> {
  let closedDuringRequest = false;
  const onClose = () => { closedDuringRequest = true; };
  const currentRequest = () => isCurrent ? isCurrent() : true;
  dialog.addEventListener("close", onClose);
  try {
    if (!dialog.open) return "dismissed";
    if (!currentRequest() || isBusy()) return "stayed";

    const wasDirty = isDirty();
    if (!wasDirty) return closeDialog(dialog, returnFocusTo);

    const decision = await confirm();
    if (!dialog.open) return "dismissed";
    if (closedDuringRequest || !currentRequest() || isBusy() || isDirty() !== wasDirty || decision === "stay") return "stayed";

    if (decision === "save") {
      if (!save) return "stayed";
      await save();
      if (!dialog.open) return "dismissed";
      if (closedDuringRequest || !currentRequest() || isBusy() || isDirty()) return "stayed";
      return closeDialog(dialog, returnFocusTo);
    }

    if (decision !== "discard") return "stayed";
    await discard();
    if (!dialog.open) return "dismissed";
    if (closedDuringRequest || !currentRequest() || isBusy() || isDirty()) return "stayed";
    return closeDialog(dialog, returnFocusTo);
  } catch {
    return "stayed";
  } finally {
    dialog.removeEventListener("close", onClose);
  }
}

function closeDialog(dialog: HTMLDialogElement, returnFocusTo?: HTMLElement): EditDismissalResult {
  if (!dialog.open) return "dismissed";
  dialog.close();
  if (!dialog.open && returnFocusTo?.isConnected && returnFocusTo.ownerDocument === dialog.ownerDocument) {
    try {
      returnFocusTo.focus({ preventScroll: true });
    } catch {
      // Native dialog focus restoration remains available if the explicit target is no longer focusable.
    }
  }
  return "dismissed";
}

interface NativeCancelBinding {
  getOptions: () => NativeDismissalOptions;
  generation: number;
  active: boolean;
  dispose: () => void;
}

const nativeCancelBindings = new WeakMap<HTMLDialogElement, NativeCancelBinding>();

/** Installs one synchronous Escape guard; call again on reopen to refresh options without adding listeners. */
export function bindEditDialogDismissal(dialog: HTMLDialogElement, getOptions: () => NativeDismissalOptions): () => void {
  const existing = nativeCancelBindings.get(dialog);
  if (existing) {
    existing.getOptions = getOptions;
    existing.generation += 1;
    return existing.dispose;
  }

  const binding: NativeCancelBinding = {
    getOptions,
    generation: 1,
    active: true,
    dispose: () => {
      if (!binding.active) return;
      binding.active = false;
      binding.generation += 1;
      dialog.removeEventListener("cancel", onCancel);
      if (nativeCancelBindings.get(dialog) === binding) nativeCancelBindings.delete(dialog);
    }
  };
  const onCancel = (event: Event) => {
    event.preventDefault();
    if (!binding.active) return;
    try {
      const generation = binding.generation;
      const options = binding.getOptions();
      void requestEditDismissal({
        ...options,
        dialog,
        isCurrent: () => binding.active && binding.generation === generation && (options.isCurrent?.() ?? true)
      });
    } catch {
      // If policy construction fails, the native cancel remains prevented and the dialog stays open.
    }
  };

  dialog.addEventListener("cancel", onCancel);
  nativeCancelBindings.set(dialog, binding);
  return binding.dispose;
}
