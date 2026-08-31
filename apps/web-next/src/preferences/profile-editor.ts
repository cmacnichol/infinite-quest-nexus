import {
  userProfileUpdateSchema,
  type UserProfile,
  type UserProfileUpdate
} from "@infinite-quest/contracts";

export interface ProfilePort {
  load(): Promise<UserProfile>;
  save(update: UserProfileUpdate): Promise<UserProfile>;
}

export interface ProfileEditor {
  readonly element: HTMLElement;
  load(): Promise<void>;
  dispose(): void;
}

type ValueControl = HTMLElement & { value?: string | null; checked?: boolean; disabled?: boolean };

function setControlValue(control: ValueControl, value: string): void {
  control.value = value;
  control.setAttribute("value", value);
}

function controlValue(control: ValueControl): string {
  return typeof control.value === "string" ? control.value : control.getAttribute("value") ?? "";
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function mountProfileEditor(document: Document, port: ProfilePort): ProfileEditor {
  const element = document.createElement("section");
  element.className = "preferences-profile";
  element.setAttribute("aria-label", "Profile preferences");

  const heading = document.createElement("h2");
  heading.textContent = "Profile";
  const fields = document.createElement("fieldset");
  fields.disabled = true;
  fields.dataset.profileFields = "";

  const displayName = document.createElement("wa-input") as ValueControl;
  displayName.setAttribute("label", "Display name");
  displayName.setAttribute("type", "text");
  displayName.setAttribute("maxlength", "120");
  displayName.setAttribute("autocomplete", "name");
  displayName.dataset.profile = "display-name";

  const autoSubmit = document.createElement("wa-checkbox") as ValueControl;
  autoSubmit.dataset.profile = "auto-submit";
  autoSubmit.textContent = "Submit turn choices automatically";

  const continuousReading = document.createElement("wa-checkbox") as ValueControl;
  continuousReading.dataset.profile = "continuous-reading";
  continuousReading.textContent = "Continue reading through accepted turns";
  const appliesOnNextLoad = document.createElement("p");
  appliesOnNextLoad.dataset.profileLoadNote = "";
  appliesOnNextLoad.textContent = "Applies when Story next loads.";

  const turnStyle = document.createElement("wa-select") as ValueControl;
  turnStyle.setAttribute("label", "Default turn controls");
  turnStyle.dataset.profile = "turn-control-style";
  for (const [value, label] of [
    ["action_only", "Actions only"],
    ["flexible_auto", "Automatic interpretation"],
    ["flexible_action", "Prefer actions"],
    ["flexible_scene", "Prefer scene direction"]
  ] as const) {
    const option = document.createElement("wa-option");
    option.setAttribute("value", value);
    option.textContent = label;
    turnStyle.append(option);
  }
  fields.append(displayName, autoSubmit, continuousReading, appliesOnNextLoad, turnStyle);

  const status = document.createElement("p");
  status.dataset.profileStatus = "";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "Retry";
  retry.hidden = true;
  retry.dataset.profileRetry = "";
  element.append(heading, fields, status, retry);

  let disposed = false;
  let loaded = false;
  let editRevision = 0;
  let unsavedRevision: number | null = null;
  let loadRevision = 0;
  let saveQueue: Promise<void> = Promise.resolve();
  let failedSave: { update: UserProfileUpdate; revision: number } | null = null;

  const setFieldsDisabled = (disabled: boolean): void => {
    fields.disabled = disabled;
    for (const control of [displayName, autoSubmit, continuousReading, turnStyle]) control.disabled = disabled;
  };

  const setStatus = (next: string, state: "idle" | "saving" | "error", canRetry = false): void => {
    if (disposed) return;
    status.textContent = next;
    status.dataset.state = state;
    retry.hidden = !canRetry;
  };

  const applyProfile = (profile: UserProfile): void => {
    setControlValue(displayName, profile.displayName);
    autoSubmit.checked = profile.settings.autoSubmitTurnChoices;
    continuousReading.checked = profile.settings.continuousReading;
    setControlValue(turnStyle, profile.settings.defaultTurnControlStyle);
  };

  const captureUpdate = (): UserProfileUpdate | null => {
    const parsed = userProfileUpdateSchema.safeParse({
      displayName: controlValue(displayName).trim(),
      settings: {
        autoSubmitTurnChoices: autoSubmit.checked === true,
        continuousReading: continuousReading.checked === true,
        defaultTurnControlStyle: controlValue(turnStyle)
      }
    });
    if (!parsed.success) {
      displayName.setAttribute("aria-invalid", "true");
      setStatus(parsed.error.issues[0]?.message ?? "Profile settings are invalid.", "error");
      return null;
    }
    displayName.removeAttribute("aria-invalid");
    return parsed.data;
  };

  const queueSave = (update: UserProfileUpdate, requestRevision: number): void => {
    saveQueue = saveQueue.catch(() => undefined).then(async () => {
      if (!disposed && requestRevision === editRevision) setStatus("Saving profile…", "saving");
      try {
        const saved = await port.save(update);
        if (!disposed && requestRevision === editRevision) {
          if (unsavedRevision === requestRevision) unsavedRevision = null;
          applyProfile(saved);
          failedSave = null;
          setStatus("Profile saved.", "idle");
        }
      } catch (error) {
        if (!disposed && requestRevision === editRevision) {
          failedSave = { update, revision: requestRevision };
          setStatus(message(error, "Profile settings could not be saved. Try again."), "error", true);
        }
      }
    });
  };

  const saveCurrent = (): void => {
    if (disposed || !loaded) return;
    const requestRevision = ++editRevision;
    unsavedRevision = requestRevision;
    failedSave = null;
    const update = captureUpdate();
    if (update) queueSave(update, requestRevision);
  };

  const load = async (): Promise<void> => {
    if (disposed) return;
    if (unsavedRevision !== null) return;
    const requestRevision = ++loadRevision;
    const requestEditRevision = editRevision;
    loaded = false;
    setFieldsDisabled(true);
    setStatus("Loading profile…", "saving");
    try {
      const profile = await port.load();
      if (disposed || requestRevision !== loadRevision) return;
      if (unsavedRevision !== null || requestEditRevision !== editRevision) {
        setFieldsDisabled(false);
        return;
      }
      applyProfile(profile);
      loaded = true;
      setFieldsDisabled(false);
      setStatus("", "idle");
    } catch (error) {
      if (disposed || requestRevision !== loadRevision) return;
      if (unsavedRevision !== null || requestEditRevision !== editRevision) {
        setFieldsDisabled(false);
        return;
      }
      setFieldsDisabled(true);
      setStatus(message(error, "Profile settings could not be loaded. Try again."), "error", true);
    }
  };

  displayName.addEventListener("input", saveCurrent);
  autoSubmit.addEventListener("change", saveCurrent);
  continuousReading.addEventListener("change", saveCurrent);
  turnStyle.addEventListener("change", saveCurrent);
  retry.addEventListener("click", () => {
    if (failedSave && failedSave.revision === editRevision) {
      queueSave(failedSave.update, failedSave.revision);
      return;
    }
    void load();
  });

  return {
    element,
    load,
    dispose() {
      if (disposed) return;
      disposed = true;
      ++editRevision;
      ++loadRevision;
      setFieldsDisabled(true);
      retry.hidden = true;
    }
  };
}
