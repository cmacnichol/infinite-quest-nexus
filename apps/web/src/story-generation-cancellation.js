export function syncCancelGenerationButton(header, state) {
  let button = header.querySelector('[data-action="cancel-generation"]');
  const visible = state.generationDisplayActive && state.generationJobId;
  if (visible && !button) {
    button = header.ownerDocument.createElement("button");
    button.className = "small ghost";
    button.type = "button";
    button.dataset.action = "cancel-generation";
    button.textContent = "Cancel generation";
    header.appendChild(button);
  } else if (!visible && button) {
    button.remove();
  }
  return button;
}

function cancellationError() {
  return new DOMException("Generation cancelled.", "AbortError");
}

export async function cancelGeneration({
  state,
  getCancelButton,
  requestCancellation,
  clearPendingSubmission,
  restoreGenerationDisplay,
  abortLocalMonitoring,
  reloadCampaign,
  recordActivity,
  toast,
  showBusy
}) {
  if (!state.generationDisplayActive || !state.generationJobId) return;

  const jobId = state.generationJobId;
  const cancelButton = getCancelButton();
  if (cancelButton) {
    cancelButton.disabled = true;
    cancelButton.textContent = "Cancelling turn generation…";
  }
  showBusy("Cancelling turn generation…");

  try {
    await requestCancellation(jobId);
  } catch (error) {
    if (cancelButton) {
      cancelButton.disabled = false;
      cancelButton.textContent = "Cancel generation";
    }
    toast(`Could not cancel generation: ${error.message}`);
    return;
  }

  clearPendingSubmission();
  state.pendingGeneration = null;
  state.cancellationConfirmed = true;
  abortLocalMonitoring();
  restoreGenerationDisplay();
  try {
    await reloadCampaign(state.campaignId);
    recordActivity("system", "Generation cancelled", `jobId=${jobId}`);
    toast("Generation cancelled.");
  } catch (error) {
    toast(`Generation cancelled, but campaign reload failed: ${error.message}`);
  }
}

export async function reconcileRemoteGenerationCancellation({
  state,
  clearPendingSubmission,
  restoreGenerationDisplay,
  reloadCampaign,
  toast
}) {
  clearPendingSubmission();
  state.pendingGeneration = null;
  restoreGenerationDisplay();
  try {
    await reloadCampaign(state.campaignId);
  } catch (error) {
    toast(`Generation cancelled, but campaign reload failed: ${error.message}`);
  }
  return cancellationError();
}
