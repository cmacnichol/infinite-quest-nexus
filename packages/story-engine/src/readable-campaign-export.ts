export type ReadableCampaignIllustration = Readonly<{
  url: string;
  alt: string;
}>;

export type ReadableCampaignTurn = Readonly<{
  turnNumber: number;
  action: string;
  narration: string;
  illustrations: readonly ReadableCampaignIllustration[];
}>;

export type ReadableCampaignExport = Readonly<{
  title: string;
  world: Readonly<{
    title: string;
    genre?: string;
    tone?: string;
    backgroundStory?: string;
  }>;
  turns: readonly ReadableCampaignTurn[];
}>;

export type ReadableCampaignExportFormat = "html" | "markdown";

export type RenderedReadableCampaignExport = Readonly<{
  body: string;
  contentType: string;
  filename: string;
}>;

function safeFilename(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9_-]+/gu, "_").replace(/^_+|_+$/gu, "");
  return normalized || "Infinite_Quest_Story";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character]!);
}

function htmlParagraphs(value: string): string {
  return value.split(/\n\s*\n/gu)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/gu, "<br>")}</p>`)
    .join("");
}

function safeIllustrationUrl(value: string): string | null {
  const source = value.trim();
  if (/^\/api\/v1\/assets\/[0-9a-f-]{36}(?:\/thumbnail)?$/iu.test(source)) return source;
  if (/^https:\/\//iu.test(source)) return source;
  return null;
}

function markdown(input: ReadableCampaignExport): string {
  const overview = [
    `# ${input.title}`,
    "",
    `**World:** ${input.world.title}`,
    ...(input.world.genre ? [`**Genre:** ${input.world.genre}`] : []),
    ...(input.world.tone ? [`**Tone:** ${input.world.tone}`] : []),
    ...(input.world.backgroundStory ? ["", "## Background Story", "", input.world.backgroundStory] : [])
  ];
  const turns = input.turns.flatMap((turn) => [
    "",
    `## Turn ${turn.turnNumber}${turn.action ? `: ${turn.action}` : ""}`,
    "",
    turn.narration,
    ...turn.illustrations.flatMap((illustration) => {
      const url = safeIllustrationUrl(illustration.url);
      return url ? ["", `![${illustration.alt.replace(/\]/gu, "\\]")}](<${url.replace(/>/gu, "%3E")}>)`] : [];
    })
  ]);
  return [...overview, ...turns, ""].join("\n");
}

function html(input: ReadableCampaignExport): string {
  const turns = input.turns.map((turn) => {
    const illustrations = turn.illustrations.flatMap((illustration) => {
      const url = safeIllustrationUrl(illustration.url);
      return url ? [`<figure><img src="${escapeHtml(url)}" alt="${escapeHtml(illustration.alt)}"></figure>`] : [];
    }).join("");
    return `<section class="turn"><h2>Turn ${turn.turnNumber}${turn.action ? `: ${escapeHtml(turn.action)}` : ""}</h2>${htmlParagraphs(turn.narration)}${illustrations}</section>`;
  }).join("");
  const metadata = [
    input.world.genre ? `<p><strong>Genre:</strong> ${escapeHtml(input.world.genre)}</p>` : "",
    input.world.tone ? `<p><strong>Tone:</strong> ${escapeHtml(input.world.tone)}</p>` : "",
    input.world.backgroundStory ? `<section><h2>Background Story</h2>${htmlParagraphs(input.world.backgroundStory)}</section>` : ""
  ].join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'"><title>${escapeHtml(input.title)}</title><style>body{font-family:Georgia,serif;max-width:860px;margin:40px auto;padding:0 20px;line-height:1.6;color:#171717;background:#fff}img{max-width:100%;height:auto}.turn{border-top:1px solid #bbb;padding:24px 0}figure{margin:20px 0}</style></head><body><h1>${escapeHtml(input.title)}</h1><p><strong>World:</strong> ${escapeHtml(input.world.title)}</p>${metadata}${turns}</body></html>`;
}

export function renderReadableCampaignExport(
  input: ReadableCampaignExport,
  format: ReadableCampaignExportFormat
): RenderedReadableCampaignExport {
  const basename = safeFilename(input.title);
  return format === "html"
    ? { body: html(input), contentType: "text/html; charset=utf-8", filename: `${basename}.html` }
    : { body: markdown(input), contentType: "text/markdown; charset=utf-8", filename: `${basename}.md` };
}
