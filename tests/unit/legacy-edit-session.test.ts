import { describe, expect, it, vi } from "vitest";
import { createEditSession } from "../../packages/client-core/src/edit-session.js";
import { bindEditDialogDismissal, requestEditDismissal } from "../../apps/web/src/legacy-edit-session.js";

function dialogFixture() {
  const target = new EventTarget() as EventTarget & { open: boolean; close: () => void };
  target.open = true;
  target.close = vi.fn(() => { target.open = false; });
  return target as HTMLDialogElement;
}

describe("legacy edit session", () => {
  it("dirty_after_edit_reverts_to_clean", () => {
    const session = createEditSession({ title: "  Keep this  " }, (left, right) => left.title.trim() === right.title.trim());

    expect(session.isDirty({ title: "Changed" })).toBe(true);
    expect(session.isDirty({ title: "Keep this" })).toBe(false);
  });

  it("failed_save_keeps_dirty_baseline", async () => {
    const dialog = dialogFixture();
    const session = createEditSession({ title: "Before" }, (left, right) => left.title === right.title);
    const current = { title: "After" };
    const save = vi.fn().mockRejectedValue(new Error("save failed"));

    await expect(requestEditDismissal({ dialog, isDirty: () => session.isDirty(current), isBusy: () => false, confirm: () => "save", save, discard: vi.fn() })).resolves.toBe("stayed");

    expect(save).toHaveBeenCalledTimes(1);
    expect(session.isDirty(current)).toBe(true);
    expect(dialog.open).toBe(true);
    expect(dialog.close).not.toHaveBeenCalled();
  });

  it("escape_cancel_backdrop_share_one_decision", async () => {
    const dialog = dialogFixture();
    let dirty = true;
    const confirm = vi.fn().mockResolvedValue("discard" as const);
    const discard = vi.fn(() => { dirty = false; });
    const options = { dialog, isDirty: () => dirty, isBusy: () => false, confirm, discard };

    await expect(requestEditDismissal(options)).resolves.toBe("dismissed");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(dialog.close).toHaveBeenCalledTimes(1);
  });

  it("busy_dialog_stays_open", async () => {
    const dialog = dialogFixture();
    const confirm = vi.fn().mockResolvedValue("discard" as const);
    const discard = vi.fn();

    await expect(requestEditDismissal({ dialog, isDirty: () => true, isBusy: () => true, confirm, discard })).resolves.toBe("stayed");
    expect(confirm).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
    expect(dialog.close).not.toHaveBeenCalled();
  });

  it("stay_and_cancel_have_zero_writes", async () => {
    const dialog = dialogFixture();
    const confirm = vi.fn().mockResolvedValue("stay" as const);
    const save = vi.fn();
    const discard = vi.fn();

    await expect(requestEditDismissal({ dialog, isDirty: () => true, isBusy: () => false, confirm, save, discard })).resolves.toBe("stayed");
    expect(save).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
    expect(dialog.close).not.toHaveBeenCalled();
  });

  it("does not save when Save is unavailable", async () => {
    const dialog = dialogFixture();
    let dirty = true;
    const confirm = vi.fn().mockResolvedValue("save" as const);
    const discard = vi.fn(() => { dirty = false; });

    await expect(requestEditDismissal({ dialog, isDirty: () => dirty, isBusy: () => false, confirm, discard })).resolves.toBe("stayed");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(discard).not.toHaveBeenCalled();
    expect(dialog.open).toBe(true);
    expect(dialog.close).not.toHaveBeenCalled();
  });

  it("serializes concurrent dismissal requests", async () => {
    const dialog = dialogFixture();
    let dirty = true;
    let resolveDecision!: (decision: "save" | "discard" | "stay") => void;
    const confirm = vi.fn(() => new Promise<"save" | "discard" | "stay">((resolve) => { resolveDecision = resolve; }));
    const discard = vi.fn(() => { dirty = false; });
    const options = { dialog, isDirty: () => dirty, isBusy: () => false, confirm, discard };

    const first = requestEditDismissal(options);
    const second = requestEditDismissal(options);
    expect(confirm).toHaveBeenCalledTimes(1);
    resolveDecision("discard");
    await expect(Promise.all([first, second])).resolves.toEqual(["dismissed", "dismissed"]);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(dialog.close).toHaveBeenCalledTimes(1);
  });

  it("a successful save replaces the session baseline before closing", async () => {
    const dialog = dialogFixture();
    const current = { title: "After" };
    const session = createEditSession({ title: "Before" }, (left, right) => left.title === right.title);
    const save = vi.fn(() => { session.markSaved(current); });

    await expect(requestEditDismissal({ dialog, isDirty: () => session.isDirty(current), isBusy: () => false, confirm: () => "save", save, discard: vi.fn() })).resolves.toBe("dismissed");
    expect(session.isDirty(current)).toBe(false);
    expect(dialog.close).toHaveBeenCalledTimes(1);
  });

  it("does not apply a stale decision after dirty state changes", async () => {
    const dialog = dialogFixture();
    let dirty = true;
    let resolveDecision!: (decision: "save" | "discard" | "stay") => void;
    const confirm = () => new Promise<"save" | "discard" | "stay">((resolve) => { resolveDecision = resolve; });
    const discard = vi.fn(() => { dirty = false; });
    const dismissal = requestEditDismissal({ dialog, isDirty: () => dirty, isBusy: () => false, confirm, discard });

    dirty = false;
    resolveDecision("discard");
    await expect(dismissal).resolves.toBe("stayed");
    expect(discard).not.toHaveBeenCalled();
    expect(dialog.close).not.toHaveBeenCalled();
  });

  it("does not discard or close a reopened session after an old decision", async () => {
    const dialog = dialogFixture();
    let sessionEpoch = 1;
    let resolveDecision!: (decision: "save" | "discard" | "stay") => void;
    const confirm = () => new Promise<"save" | "discard" | "stay">((resolve) => { resolveDecision = resolve; });
    const discard = vi.fn();
    const dismissal = requestEditDismissal({
      dialog,
      isDirty: () => true,
      isBusy: () => false,
      confirm,
      discard,
      isCurrent: () => sessionEpoch === 1
    });

    dialog.open = false;
    dialog.dispatchEvent(new Event("close"));
    dialog.open = true;
    sessionEpoch += 1;
    resolveDecision("discard");

    await expect(dismissal).resolves.toBe("stayed");
    expect(discard).not.toHaveBeenCalled();
    expect(dialog.open).toBe(true);
    expect(dialog.close).not.toHaveBeenCalled();
  });

  it("binds Escape cancellation once across dialog reopens", async () => {
    const dialog = dialogFixture();
    const confirm = vi.fn().mockResolvedValue("stay" as const);
    const options = () => ({ isDirty: () => true, isBusy: () => false, confirm, discard: vi.fn() });
    const dispose = bindEditDialogDismissal(dialog, options);
    expect(bindEditDialogDismissal(dialog, options)).toBe(dispose);

    const cancel = new Event("cancel", { cancelable: true });
    dialog.dispatchEvent(cancel);
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(cancel.defaultPrevented).toBe(true);
    expect(dialog.open).toBe(true);
    dispose();
  });
});
