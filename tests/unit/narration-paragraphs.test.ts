import { describe, expect, it } from "vitest";
import { extractPartialNarrationParagraphs, isNarrationParagraphsComplete, joinProviderNarration } from "../../packages/story-engine/src/narration-paragraphs.js";
import { extractPartialNarration, parseStoryOutput } from "../../packages/story-engine/src/output.js";
import { makeStructuredOutputStory } from "../fixtures/generation-validation/structured-output-cases.js";

const { narration: _n, ...rest } = makeStructuredOutputStory();

describe("joinProviderNarration", () => {
  it("joins trimmed paragraphs with one blank line", () => {
    expect(joinProviderNarration({ ...rest, narration_paragraphs: ["  “Stay,” Mara says. ", "You nod."] }))
      .toEqual({ ok: true, value: { ...rest, narration: "“Stay,” Mara says.\n\nYou nod." } });
  });
  it("passes a legacy narration string through unchanged", () => {
    const value = { ...rest, narration: "Plain." };
    expect(joinProviderNarration(value)).toEqual({ ok: true, value });
  });
  it.each([
    [{ ...rest, narration: "x", narration_paragraphs: ["x"] }, /either narration or narration_paragraphs/],
    [{ ...rest, narration_paragraphs: [] }, /at least one paragraph/],
    [{ ...rest, narration_paragraphs: ["ok", "   "] }, /paragraph 2 is empty/],
    [{ ...rest, narration_paragraphs: ["ok", 3] }, /paragraph 2 is not a string/]
  ])("rejects an ambiguous or malformed shape", (value, message) => {
    const result = joinProviderNarration(value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(message);
  });
});

describe("parseStoryOutput with paragraph wire output", () => {
  it("accepts quoted dialogue and keeps paragraph boundaries", () => {
    const parsed = parseStoryOutput(JSON.stringify({ ...rest, narration_paragraphs: ["“Are you leaving?” Mara asks.", "“Not yet,” you say."] }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.story.narration).toBe("“Are you leaving?” Mara asks.\n\n“Not yet,” you say.");
  });
  it("reports ambiguity as a schema failure", () => {
    const parsed = parseStoryOutput(JSON.stringify({ ...rest, narration: "a", narration_paragraphs: ["a"] }));
    expect(parsed).toMatchObject({ ok: false, code: "invalid_schema" });
  });
});

describe("partial paragraph streams", () => {
  it("extracts complete items plus the in-progress item", () => {
    const raw = '{"narration_paragraphs":["First paragraph.","Second “partial';
    expect(extractPartialNarrationParagraphs(raw)).toBe("First paragraph.\n\nSecond “partial");
    expect(isNarrationParagraphsComplete(raw)).toBe(false);
    expect(isNarrationParagraphsComplete('{"narration_paragraphs":["a","b"],"choices":[')).toBe(true);
  });
  it("returns null when the field is absent so legacy extraction still runs", () => {
    expect(extractPartialNarrationParagraphs('{"narration":"Legacy')).toBeNull();
    expect(extractPartialNarration('{"narration":"Legacy text"')).toContain("Legacy text");
  });
  it("feeds the public partial preview", () => {
    expect(extractPartialNarration('{"narration_paragraphs":["One.","Two')).toBe("One.\n\nTwo");
  });
  it("decodes \\uXXXX escapes instead of leaking the hex digits", () => {
    expect(extractPartialNarrationParagraphs('{"narration_paragraphs":["\\u201cStay,\\u201d Mara says.'))
      .toBe("“Stay,” Mara says.");
  });
  it("drops a truncated trailing \\u escape instead of emitting garbage digits", () => {
    const result = extractPartialNarrationParagraphs('{"narration_paragraphs":["Stay,\\u20');
    expect(result).toBe("Stay,");
    expect(result).not.toMatch(/20$/);
    expect(() => extractPartialNarrationParagraphs('{"narration_paragraphs":["Stay,\\u20')).not.toThrow();
  });
  it("decodes a surrogate pair (emoji) without throwing", () => {
    const result = extractPartialNarrationParagraphs('{"narration_paragraphs":["\\ud83d\\ude00"]');
    expect(() => result).not.toThrow();
    expect(result).toBe("😀");
  });
});
