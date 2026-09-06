import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { renderAppShell } from "../../apps/web-next/src/app-shell.js";
import { storyPlayerPath, storyRouteFromLocation } from "../../apps/web-next/src/story-route.js";

describe("replacement Story routes", () => {
  it("parses chooser, campaign, and turn deep links", () => {
    expect(storyRouteFromLocation("/app/story")).toEqual({ campaignId: null, turnNumber: null });
    expect(storyRouteFromLocation("/app/story/campaign%201", "?turn=28")).toEqual({ campaignId: "campaign 1", turnNumber: 28 });
    expect(storyRouteFromLocation("/app/worlds")).toBeNull();
  });

  it("builds encoded campaign links", () => {
    expect(storyPlayerPath("campaign 1", 28)).toBe("/app/story/campaign%201?turn=28");
  });

  it("keeps global Story navigation inside the replacement app", () => {
    const { document } = parseHTML("<body><div id=app></div></body>");
    const root = document.querySelector<HTMLElement>("#app");
    if (!root) throw new Error("Story shell fixture is missing.");

    renderAppShell(root, "<main></main>", "story");

    expect([...root.querySelectorAll<HTMLAnchorElement>('a[href="/app/story"]')]).toHaveLength(2);
    expect(root.querySelector('a[href="/app/story"]')?.getAttribute("aria-current")).toBe("page");
    expect(root.querySelector('nav a[href="/app/worlds"]')?.textContent).toContain("World Library");
    expect(root.querySelector('a.brand')?.getAttribute("href")).toBe("/app/");
  });

  it.each([
    ["/app/story/one/two", ""],
    ["/app/story/%E0%A4%A", ""],
    ["/app/story/campaign-1", "?turn=0"],
    ["/app/story/campaign-1", "?turn=-1"],
    ["/app/story/campaign-1", "?turn=2.5"],
    ["/app/story/campaign-1", "?turn=two"]
  ])("rejects malformed player route %s%s", (pathname, search) => {
    expect(storyRouteFromLocation(pathname, search)).toBeNull();
  });

  it.each([
    ["duplicate turn values", "/app/story/campaign-1", "?turn=1&turn=2"],
    ["extraneous query values", "/app/story/campaign-1", "?turn=1&other=value"],
    ["a chooser turn query", "/app/story", "?turn=1"],
    ["an unsafe turn integer", "/app/story/campaign-1", "?turn=9007199254740992"]
  ])("rejects %s", (_label, pathname, search) => {
    expect(storyRouteFromLocation(pathname, search)).toBeNull();
  });
});
