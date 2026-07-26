import { cyoaExportSchema, type CyoaChapter, type CyoaExport, type CyoaInfo } from "../../contracts/src/imports.js";
import { PROMPT_TEMPLATE_CATALOG } from "../../contracts/src/prompt-library.js";


export type TemplateExcerpt = {
  chapterId: string;
  title: string;
  content: string;
  choices: string[];
};

export type TemplateWorldInput = {
  sourceName: string;
  sourceKind: "cyoa_json" | "prompt";
  title: string;
  summary: string;
  keywords: string[];
  excerpts: TemplateExcerpt[];
  prompt?: string;
};

export function stripHtmlTags(html: string): string {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseCyoaExport(sourceText: string): CyoaExport {
  let value = String(sourceText || "").trim().replace(/^\uFEFF/, "");
  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) value = fenced[1].trim();
  const raw = JSON.parse(value);
  return cyoaExportSchema.parse(raw);
}

export function extractCyoaLayers(parsed: CyoaExport, sourceName = "cyoa-export.json"): TemplateWorldInput {
  const chapters: Record<string, CyoaChapter | undefined> = parsed.chapters || {};
  const info: Partial<CyoaInfo> = parsed.info || {};

  const rootId = chapters["1"] ? "1" : Object.keys(chapters)[0];
  const rootChapter = rootId ? chapters[rootId] : undefined;

  const title = String(info.pretty_title || rootChapter?.title || "Imported CYOA Adventure").trim().slice(0, 200);
  const briefDescription = String(info.brief_description || "").trim();
  const description = stripHtmlTags(String(info.description || ""));
  const summary = [briefDescription, description].filter(Boolean).join("\n\n").slice(0, 10_000);
  const keywords = Array.isArray(info.keywords)
    ? info.keywords.map((keyword: unknown) => String(keyword).trim()).filter(Boolean).slice(0, 20)
    : [];

  const excerpts: TemplateExcerpt[] = [];
  if (rootChapter) {
    excerpts.push({
      chapterId: rootId || "1",
      title: String(rootChapter.title || "Chapter 1").trim().slice(0, 200),
      content: stripHtmlTags(String(rootChapter.content || "")).slice(0, 15_000),
      choices: Array.isArray(rootChapter.choices)
        ? rootChapter.choices.map((choice: unknown) => String(choice).trim()).filter(Boolean).slice(0, 10)
        : []
    });

    const choiceCount = Array.isArray(rootChapter.choices) ? rootChapter.choices.length : 0;
    const layer1Keys = new Set<string>();
    for (let index = 0; index < choiceCount; index += 1) {
      const candidateKey = `${rootId}-${index + 1}`;
      if (chapters[candidateKey]) layer1Keys.add(candidateKey);
    }
    for (const key of Object.keys(chapters)) {
      if (key !== rootId && new RegExp(`^${rootId}-\\d+$`).test(key)) {
        layer1Keys.add(key);
      }
    }

    for (const key of Array.from(layer1Keys).sort()) {
      const chapter = chapters[key];
      if (chapter) {
        excerpts.push({
          chapterId: key,
          title: String(chapter.title || `Chapter ${key}`).trim().slice(0, 200),
          content: stripHtmlTags(String(chapter.content || "")).slice(0, 15_000),
          choices: Array.isArray(chapter.choices)
            ? chapter.choices.map((choice: unknown) => String(choice).trim()).filter(Boolean).slice(0, 10)
            : []

        });
      }
    }
  }

  return {
    sourceName,
    sourceKind: "cyoa_json",
    title,
    summary,
    keywords,
    excerpts
  };
}

export function buildTemplateWorldPrompt(input: TemplateWorldInput, systemPromptOverride?: string): { systemPrompt: string; input: string } {
  const systemPrompt = systemPromptOverride || PROMPT_TEMPLATE_CATALOG.world_generation.defaultContent;

  const payload = input.sourceKind === "prompt"
    ? {
      task: "Create a new Story World with 3-4 playable characters from this concept prompt.",
      title: input.title,
      prompt: input.prompt || input.summary
    }
    : {
      task: "Convert this Choose Your Own Adventure (CYOA) story and top-level branch choices into a new Story World with 3-4 identified or generated playable characters.",
      title: input.title,
      summary: input.summary,
      keywords: input.keywords,
      excerpts: input.excerpts
    };

  return {
    systemPrompt,
    input: JSON.stringify(payload)
  };
}
