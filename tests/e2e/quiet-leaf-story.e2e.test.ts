import { expect, test } from "@playwright/test";
import { installStoryApi } from "../fixtures/quiet-leaf-api.js";
import type { QuietLeafFixtureOptions } from "../fixtures/quiet-leaf-payloads.js";

async function openStory(page: import("@playwright/test").Page, options: QuietLeafFixtureOptions = {}) {
  const api = await installStoryApi(page, options);
  const { campaignId } = api;
  await page.goto(`/app/story/${campaignId}`);
  const field = page.getByRole("textbox", { name: "Custom Action", exact: true });
  await expect(field).toBeVisible();
  return { api, field };
}

test("Custom Action starts tall and grows without replacing the field", async ({ page }) => {
  const { api, field } = await openStory(page);
  try {
    await expect(page.getByText("Story Engine ready", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Reading width", exact: true })).toHaveCount(0);
    const before = await field.boundingBox();
    expect(before!.height).toBeGreaterThanOrEqual(132);
    await field.evaluate(element => { element.setAttribute("data-original-field", "true"); });
    await field.fill(Array.from({ length: 30 }, (_, index) => `Line ${index + 1}`).join("\n"));
    await expect.poll(async () => (await field.boundingBox())!.height).toBeGreaterThan(before!.height);
    const grown = (await field.boundingBox())!.height;
    await field.fill("A shorter action");
    await expect.poll(async () => (await field.boundingBox())!.height).toBeLessThan(grown);
    await page.getByRole("button", { name: "Clear custom action", exact: true }).click();
    await expect(field).toHaveValue("");
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute("data-original-field", "true");
    await expect(page.getByRole("button", { name: "Continue Story", exact: true })).toBeVisible();
  } finally {
    api.assertNoUnexpectedRequests();
  }
});

test("flexible controls select Action, Direction, and Auto by keyboard without classifying while typing", async ({ page }) => {
  const { api, field } = await openStory(page, { turnControlStyle: "flexible_auto" });
  try {
    const modes = page.locator('wa-radio-group[label="Interpret prompt as"]');
    const auto = page.getByRole("radio", { name: "Auto", exact: true });
    await auto.focus();
    await expect(auto).toBeFocused();
    for (const option of [
      { key: "ArrowRight", label: "Story Action", value: "action" },
      { key: "ArrowRight", label: "Story Direction", value: "scene" },
      { key: "ArrowRight", label: "Auto", value: "auto" }
    ]) {
      await page.keyboard.press(option.key);
      await expect(page.getByRole("radio", { name: option.label, exact: true })).toHaveAttribute("aria-checked", "true");
      await expect(modes).toHaveJSProperty("value", option.value);
    }
    await field.fill("A typed draft is still local.");
    await expect(field).toHaveValue("A typed draft is still local.");
  } finally {
    api.assertNoUnexpectedRequests();
  }
});

test("Retry Turn prepares the prior action without appending a turn", async ({ page }) => {
  const { api, field } = await openStory(page);
  try {
    await page.getByRole("button", { name: "Retry Turn", exact: true }).click();
    await expect(field).toHaveValue("Survey the empty platform.");
    await expect(page.getByRole("button", { name: "Continue Story", exact: true })).toBeEnabled();
  } finally {
    api.assertNoUnexpectedRequests();
  }
});

test("programmatic inline turn-length update preserves the focused custom action and its caret", async ({ page }) => {
  const { api, field } = await openStory(page);
  try {
    await field.fill("Keep this draft intact");
    await field.focus();
    await field.evaluate(element => {
      const textarea = element as HTMLTextAreaElement;
      textarea.setSelectionRange(5, 5);
    });
    await page.locator("wa-select[data-turn-length-select]").evaluate(element => {
      (element as HTMLElement & { value: string }).value = "long";
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect(field).toHaveValue("Keep this draft intact");
    await expect(field).toBeFocused();
    await expect.poll(() => field.evaluate(element => (element as HTMLTextAreaElement).selectionStart)).toBe(5);
  } finally {
    api.assertNoUnexpectedRequests();
  }
});

test("turn-length dialog cancels and applies its staged value through Core controls", async ({ page }) => {
  const { api, field } = await openStory(page);
  try {
    await field.fill("A draft that must remain local");
    const details = page.getByRole("button", { name: "Turn length details", exact: true });
    await details.click();
    const dialog = page.getByRole("dialog", { name: "Turn length details", exact: true });
    await expect(dialog).toBeVisible();
    const staged = dialog.getByRole("combobox", { name: "Turn length for next submission", exact: true });
    const inline = page.locator("wa-select[data-turn-length-select]");
    await staged.click();
    await dialog.getByRole("option", { name: "Long", exact: true }).click();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(inline).toHaveJSProperty("value", "");

    await details.click();
    await staged.click();
    await dialog.getByRole("option", { name: "Long", exact: true }).click();
    await dialog.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(inline).toHaveJSProperty("value", "long");
    await expect(field).toHaveValue("A draft that must remain local");
  } finally {
    api.assertNoUnexpectedRequests();
  }
});

test("action-only composer keeps duplicate choices distinct and disables an empty-draft action", async ({ page }) => {
  const api = await installStoryApi(page);
  try {
    await page.goto(`/app/story/${api.campaignId}`);
    await expect(page.locator("wa-radio")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Cross the threshold", exact: true })).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Clear custom action", exact: true })).toBeDisabled();
  } finally {
    api.assertNoUnexpectedRequests();
  }
});
