import { describe, expect, test } from "vitest";
import { DEFAULT_READER_PREFERENCES, normalizeReaderPreferences } from "../../packages/client-core/src/index.js";

describe("reader preference policy", () => {
  test("exports immutable defaults and returns fresh normalized preference objects", () => {
    expect(DEFAULT_READER_PREFERENCES).toEqual({ widthCh: 72, fontSizePx: 18, lineHeight: 1.7, theme: "dark" });
    expect(Object.isFrozen(DEFAULT_READER_PREFERENCES)).toBe(true);

    const normalized = normalizeReaderPreferences({ widthCh: 84, fontSizePx: 22, lineHeight: 1.9, theme: "sepia" });
    expect(normalized).toEqual({ widthCh: 84, fontSizePx: 22, lineHeight: 1.9, theme: "sepia" });
    expect(normalizeReaderPreferences({ widthCh: 84, fontSizePx: 22, lineHeight: 1.9, theme: "sepia" })).not.toBe(normalized);
    normalized.widthCh = 60;
    expect(normalizeReaderPreferences({ widthCh: 84, fontSizePx: 22, lineHeight: 1.9, theme: "sepia" }).widthCh).toBe(84);
  });

  test("preserves each valid historical field while falling back invalid or missing fields", () => {
    expect(normalizeReaderPreferences({ widthCh: 60, fontSizePx: 999, lineHeight: null, theme: "neon" })).toEqual({
      widthCh: 60,
      fontSizePx: 18,
      lineHeight: 1.7,
      theme: "dark"
    });
    expect(normalizeReaderPreferences({ theme: "light", ignored: true })).toEqual({
      widthCh: 72,
      fontSizePx: 18,
      lineHeight: 1.7,
      theme: "light"
    });
  });

  test("uses defaults for non-object and array history without mutating it", () => {
    const legacyArray = [60, 22];
    expect(normalizeReaderPreferences(null)).toEqual(DEFAULT_READER_PREFERENCES);
    expect(normalizeReaderPreferences(legacyArray)).toEqual(DEFAULT_READER_PREFERENCES);
    expect(legacyArray).toEqual([60, 22]);
  });
});
