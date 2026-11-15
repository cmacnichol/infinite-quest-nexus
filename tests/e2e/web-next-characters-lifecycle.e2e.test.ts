import { expect, test } from "@playwright/test";
import { campaignId, fixture } from "./helpers/web-next-sheet-fixture.js";

for (const width of [1280, 390]) test(`Web-Next lifecycle review and navigation at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await fixture(page, false, true);
  const id = "88888888-8888-4888-8888-888888888888", sourceId = "99999999-9999-4999-8999-999999999999", mergeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const boundary = { turnNumber: 1, timelineRevision: 0 }, writes: any[] = [];
  let revision = 0, removed = false, merged = false;
  const person = () => ({ id, name: "Mara", aliases: [], origin: { kind: "manual" }, profile: { "story.role": "Guide" }, pinned: false, ignored: false, revision, firstObservedTurn: 1, lastObservedTurn: 1, removed, activeMerges: merged ? [{ mergeEventId: mergeId, sourceCharacterId: sourceId, sourceName: "Sera", canUndo: true }] : [] });
  const source = () => ({ id: sourceId, name: "Sera", aliases: [], origin: { kind: "discovered" }, profile: { "story.role": "Guard" }, pinned: false, ignored: false, removed: false, revision: 0, firstObservedTurn: 1, lastObservedTurn: 1 });
  const detail = (character: any) => ({ character, revision, boundary, observations: [], overrides: [], autoMatches: [], identityEvents: [], unresolvedCandidateIds: [], editorDestination: null, capabilities: { castEditing: true, castLifecycle: true } });
  await page.route("**/api/v1/**", async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname, tail = path.split("/cast/")[1];
    const send = (json: unknown) => route.fulfill({ json });
    if (path.endsWith("/cast/workspace-status")) return send({ revision, boundary, capabilities: { editing: true, discovery: false, autoMatch: false, backfill: false, context: false }, contextDisabledReason: null, counts: { identities: 0, details: 0, conflicts: 0 }, tracking: null });
    if (path.endsWith("/cast")) return send({ revision, boundary, characters: url.searchParams.get("filter") === "removed" ? (removed ? [person()] : []) : [person(), ...(merged ? [] : [source()])].filter(item => !item.removed), nextCursor: null, capabilities: { castEditing: true, castLifecycle: true } });
    if (tail === id) return send(detail(person()));
    if (tail === sourceId) return send(detail(source()));
    if (tail === `${id}/merge-preview`) return send({ target: (({ capabilities, ...rest }) => rest)(detail(person())), source: (({ capabilities, ...rest }) => rest)(detail(source())), aliasCandidates: ["Sera"], fields: [{ path: "story.role", target: "Guide", source: "Guard", choiceRequired: true, defaultChoice: null, allowedChoices: ["target", "source"] }] });
    if (tail === `${id}/unmerge-preview`) return send({ target: person(), source: source(), revision, boundary, expectedCharacterRevision: revision, expectedSourceCharacterRevision: 0 });
    if (tail && req.method() === "POST") { writes.push({ tail, input: req.postDataJSON() }); revision++; if (tail.endsWith("/merge")) merged = true; if (tail.endsWith("/unmerge")) merged = false; if (tail.endsWith("/remove")) removed = true; if (tail.endsWith("/restore")) removed = false; return send({ character: person(), revision, boundary }); }
    return route.fallback();
  });
  await page.goto(`http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_NEXT_PORT ?? 43174}/app/story/${campaignId}`);
  await page.locator("[data-campaign-tools] summary").click(); await page.locator("[data-tool-action='open-characters']").click();
  const workspace = page.locator("dialog.characters-workspace"); await workspace.getByRole("button", { name: "Mara", exact: true }).click();
  await workspace.getByRole("button", { name: "Edit Name" }).click(); await workspace.getByRole("textbox", { name: "Name", exact: true }).fill("Draft");
  page.once("dialog", dialog => dialog.dismiss()); await workspace.getByRole("button", { name: "Merge with another character" }).click();
  await expect(workspace.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Draft");
  page.once("dialog", dialog => dialog.accept()); await workspace.getByRole("button", { name: "Merge with another character" }).click();
  await expect(workspace.getByRole("textbox", { name: "Name", exact: true })).toHaveCount(0); let modal = page.locator("dialog.cast-lifecycle");
  await modal.getByRole("button", { name: "Sera", exact: true }).click(); await expect(modal).toContainText("Merge Sera into Mara.");
  await page.screenshot({ path: info.outputPath(`lifecycle-merge-${width}.png`) });
  await modal.locator("select").selectOption("source"); await modal.getByRole("button", { name: "Confirm merge" }).click();
  await expect(workspace.getByText("Merged from Sera")).toBeVisible();
  await workspace.getByRole("button", { name: "Undo merge" }).click(); modal = page.locator("dialog.cast-lifecycle"); await modal.getByRole("button", { name: "Confirm undo merge" }).click(); await expect(modal).toHaveCount(0);
  await workspace.getByRole("button", { name: "Remove from cast" }).click(); modal = page.locator("dialog.cast-lifecycle"); await page.screenshot({ path: info.outputPath(`lifecycle-remove-${width}.png`) }); await modal.getByRole("button", { name: "Confirm remove" }).click();
  await expect(workspace).toContainText("Mara removed.");
  await workspace.locator("select").selectOption("removed"); await workspace.getByRole("button", { name: "Mara", exact: true }).click();
  await workspace.getByRole("button", { name: "Restore", exact: true }).click(); modal = page.locator("dialog.cast-lifecycle"); await modal.getByRole("button", { name: "Restore character" }).click();
  await expect(workspace).toContainText("Mara restored."); await expect(workspace.getByRole("button", { name: "Remove from cast" })).toBeVisible();
  expect(writes.map(write => write.tail.split("/").at(-1))).toEqual(["merge", "unmerge", "remove", "restore"]);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
});
