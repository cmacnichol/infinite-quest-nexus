import {
  userProfileSchema,
  userProfileUpdateSchema,
  type UserProfile,
  type UserProfileUpdate
} from "../../../packages/contracts/src/users.js";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function profileRequest(path: string, init?: RequestInit): Promise<UserProfile> {
  let response: Response;
  try {
    response = await fetch(path, {
      headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}) },
      ...init
    });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Profile settings could not be reached.");
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // The status below supplies a safe recovery message.
  }
  if (!response.ok) {
    const value = record(body);
    throw new Error(typeof value?.message === "string" ? value.message : "Profile settings could not be saved. Try again.");
  }
  const value = record(body);
  return userProfileSchema.parse(value?.user);
}

export async function loadUserProfile(): Promise<UserProfile> {
  return profileRequest("/api/v1/session");
}

export async function updateUserProfile(request: UserProfileUpdate): Promise<UserProfile> {
  const payload = userProfileUpdateSchema.parse(request);
  return profileRequest("/api/v1/users/me/profile", {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

function openDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

function setControlValue(control: HTMLInputElement | HTMLSelectElement, value: string): void {
  try {
    control.value = value;
  } catch {
    // The attribute is still written below for lightweight DOM implementations.
  }
  // LinkeDOM's parsed form controls expose a read-only (or no-op) value
  // property. Keeping the attribute in sync makes the interaction testable
  // there without changing browser behavior.
  control.setAttribute("value", value);
}

function controlValue(control: HTMLInputElement | HTMLSelectElement): string {
  const value = control.value;
  return value || control.getAttribute("value") || "";
}

export function initializeUserProfileMenu(root: HTMLElement): void {
  const button = root.querySelector<HTMLButtonElement>(".user-profile-toggle");
  const dialog = root.querySelector<HTMLDialogElement>(".user-profile-dialog");
  const displayName = root.querySelector<HTMLInputElement>("#user-profile-display-name");
  const autoSubmit = root.querySelector<HTMLInputElement>("#user-profile-auto-submit");
  const continuousReading = root.querySelector<HTMLInputElement>("#user-profile-continuous-reading");
  const turnStyle = root.querySelector<HTMLSelectElement>("#user-profile-turn-style");
  const closeButton = root.querySelector<HTMLButtonElement>("[data-user-profile-close]");
  const status = root.querySelector<HTMLElement>("[data-user-profile-status]");
  const fields = root.querySelector<HTMLFieldSetElement>("[data-user-profile-fields]");
  if (!button || !dialog || !displayName || !autoSubmit || !continuousReading || !turnStyle || !closeButton || !status || !fields) {
    throw new Error("The user profile menu could not be initialized.");
  }

  let profile: UserProfile | null = null;
  let saveQueue = Promise.resolve();

  const setStatus = (message: string, state: "idle" | "saving" | "error") => {
    status.textContent = message;
    status.dataset.state = state;
  };
  const applyProfile = (nextProfile: UserProfile) => {
    profile = nextProfile;
    setControlValue(displayName, nextProfile.displayName);
    autoSubmit.checked = nextProfile.settings.autoSubmitTurnChoices;
    continuousReading.checked = nextProfile.settings.continuousReading;
    setControlValue(turnStyle, nextProfile.settings.defaultTurnControlStyle);
  };
  const draft = (): UserProfileUpdate | null => {
    const nextDisplayName = controlValue(displayName).trim();
    if (!nextDisplayName) {
      setStatus("Display name is required before this setting can be saved.", "error");
      displayName.setAttribute("aria-invalid", "true");
      return null;
    }
    displayName.removeAttribute("aria-invalid");
    return userProfileUpdateSchema.parse({
      displayName: nextDisplayName,
      settings: {
        autoSubmitTurnChoices: autoSubmit.checked,
        continuousReading: continuousReading.checked,
        defaultTurnControlStyle: controlValue(turnStyle)
      }
    });
  };
  const save = () => {
    const nextDraft = draft();
    if (!nextDraft || !profile) return;
    saveQueue = saveQueue.catch(() => undefined).then(async () => {
      try {
        applyProfile(await updateUserProfile(nextDraft));
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Profile settings could not be saved. Try again.", "error");
      }
    });
  };
  const open = async () => {
    openDialog(dialog);
    fields.disabled = true;
    setStatus("Loading profile…", "saving");
    try {
      applyProfile(await loadUserProfile());
      setStatus("", "idle");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Profile settings could not be loaded. Try again.", "error");
    } finally {
      fields.disabled = false;
    }
  };

  button.addEventListener("click", () => { void open(); });
  closeButton.addEventListener("click", () => closeDialog(dialog));
  displayName.addEventListener("input", save);
  autoSubmit.addEventListener("change", save);
  continuousReading.addEventListener("change", save);
  turnStyle.addEventListener("change", save);
}
