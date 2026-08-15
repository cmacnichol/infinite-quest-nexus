import { describe, expect, it } from "vitest";
import {
  renderReadableCampaignExport,
  type ReadableCampaignExport
} from "../../packages/story-engine/src/readable-campaign-export.js";

const campaign: ReadableCampaignExport = {
  title: "The <Clockwork> Road",
  world: {
    title: "Brass & Rain",
    genre: "Fantasy",
    tone: "Hopeful",
    backgroundStory: "A city wakes beneath a glass sky."
  },
  turns: [
    {
      turnNumber: 1,
      action: "Open <the gate>",
      narration: "Mara enters the square.\n\nA bell answers.",
      illustrations: [{ url: "/api/v1/assets/11111111-1111-4111-8111-111111111111", alt: "Mara & the gate" }]
    },
    {
      turnNumber: 2,
      action: "Listen",
      narration: "<script>alert('unsafe')</script>The bell names the road.",
      illustrations: []
    }
  ]
};

describe("readable campaign export", () => {
  it("renders a complete Markdown story with effective narration and safe image references", () => {
    const rendered = renderReadableCampaignExport(campaign, "markdown");

    expect(rendered.contentType).toBe("text/markdown; charset=utf-8");
    expect(rendered.filename).toBe("The_Clockwork_Road.md");
    expect(rendered.body).toContain("# The <Clockwork> Road");
    expect(rendered.body).toContain("## Turn 2: Listen");
    expect(rendered.body).toContain("<script>alert('unsafe')</script>The bell names the road.");
    expect(rendered.body).toContain("![Mara & the gate](</api/v1/assets/11111111-1111-4111-8111-111111111111>)");
  });

  it("renders script-free standalone HTML and escapes every user-controlled field", () => {
    const rendered = renderReadableCampaignExport(campaign, "html");

    expect(rendered.contentType).toBe("text/html; charset=utf-8");
    expect(rendered.filename).toBe("The_Clockwork_Road.html");
    expect(rendered.body).toContain("<!doctype html>");
    expect(rendered.body).toContain("Content-Security-Policy");
    expect(rendered.body).toContain("The &lt;Clockwork&gt; Road");
    expect(rendered.body).toContain("Brass &amp; Rain");
    expect(rendered.body).toContain("Open &lt;the gate&gt;");
    expect(rendered.body).toContain("&lt;script&gt;alert(&#39;unsafe&#39;)&lt;/script&gt;");
    expect(rendered.body).toContain("alt=\"Mara &amp; the gate\"");
    expect(rendered.body).not.toContain("<script");
  });

  it("omits unsafe illustration schemes instead of exporting active content", () => {
    const rendered = renderReadableCampaignExport({
      ...campaign,
      turns: [{
        turnNumber: 1,
        action: "Wait",
        narration: "Nothing moves.",
        illustrations: [{ url: "javascript:alert(1)", alt: "unsafe" }]
      }]
    }, "html");

    expect(rendered.body).not.toContain("javascript:");
    expect(rendered.body).not.toContain("<img");
  });
});
