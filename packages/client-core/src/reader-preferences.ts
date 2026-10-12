import {
  DEFAULT_READER_PREFERENCES,
  normalizeHistoricalReaderPreferences,
  type ReaderPreferences
} from "@infinite-quest/contracts";

export { DEFAULT_READER_PREFERENCES };
export type { ReaderPreferences };

export function normalizeReaderPreferences(value: unknown): ReaderPreferences {
  return normalizeHistoricalReaderPreferences(value);
}
