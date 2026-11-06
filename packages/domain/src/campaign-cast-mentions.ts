import type { CastCharacter } from "../../contracts/src/campaign-cast.js";
import type { CastDiscoverySource } from "../../contracts/src/campaign-cast-discovery.js";

export type CastMention = { characterId: string; paragraphId: string; quote: string; start: number; end: number };
const generic = /^(?:guard|captain|doctor|merchant|king|queen|stranger|soldier|innkeeper|keeper|sir|lady|lord)$/iu;
const word = /[\p{L}\p{N}\p{M}_]/u;
/** Single-word names that are also ordinary words; a capital at sentence start proves nothing. */
const commonWordNames = new Set(["hope", "grace", "faith", "joy", "will", "may", "june", "april", "august", "rose", "lily", "ivy",
  "iris", "dawn", "summer", "autumn", "winter", "sky", "storm", "rain", "river", "stone", "ash", "hunter", "mark", "bill", "frank",
  "rich", "sunny", "pat", "sue", "art", "jack", "drew", "chase", "wade", "lance", "miles", "max", "victor", "amber", "ruby", "pearl",
  "olive", "honey", "star", "mercy", "patience", "prudence", "charity", "constance", "earnest", "noble", "young", "rowan", "reed",
  "forest", "brook", "glen", "dale", "cliff", "gale", "blaze", "ember", "raven", "wolf", "fox", "bear", "hawk", "crow", "wren"]);

function sentenceInitial(text: string, start: number): boolean {
  const before = text.slice(0, start).replace(/[\s"'“‘«([—–-]+$/u, "");
  return before === "" || /[.!?…:]$/u.test(before);
}

/** Text references only: no identity, portrayal, location or encounter assertions. */
export function findCastMentions(source: CastDiscoverySource, characters: readonly CastCharacter[]): CastMention[] {
  const owners = new Map<string, Set<string>>();
  for (const character of characters) for (const term of [character.name, ...character.aliases]) {
    const key = term.normalize("NFKC").toLocaleLowerCase("en-US");
    const ids = owners.get(key) ?? new Set<string>(); ids.add(character.id); owners.set(key, ids);
  }
  const found: CastMention[] = [], seen = new Set<string>();
  for (const character of characters) {
    if (character.origin.kind === "protagonist" || character.ignored) continue;
    for (const term of new Set([character.name, ...character.aliases])) {
      if (!term || term.length > 1000 || generic.test(term) || owners.get(term.normalize("NFKC").toLocaleLowerCase("en-US"))?.size !== 1) continue;
      const ambiguousWord = !/\s/u.test(term) && commonWordNames.has(term.toLocaleLowerCase("en-US"));
      for (const paragraph of source.paragraphs) {
        for (let start = paragraph.text.indexOf(term); start !== -1; start = paragraph.text.indexOf(term, start + term.length)) {
          const end = start + term.length;
          const before = [...paragraph.text.slice(Math.max(0, start - 2), start)].at(-1) ?? "";
          const after = [...paragraph.text.slice(end, end + 2)].at(0) ?? "";
          if (word.test(before) || word.test(after)) continue;
          if (ambiguousWord && sentenceInitial(paragraph.text, start)) continue;
          const key = `${character.id}:${paragraph.id}:${start}:${end}`;
          if (!seen.has(key)) { seen.add(key); found.push({ characterId: character.id, paragraphId: paragraph.id, quote: term, start, end }); }
        }
      }
    }
  }
  // A name inside a longer matched alias of the same character ("Mara" in "Mara Venn") is one reference.
  const mentions = found.filter((mention) => !found.some((other) => other !== mention && other.characterId === mention.characterId
    && other.paragraphId === mention.paragraphId && other.start <= mention.start && other.end >= mention.end
    && other.end - other.start > mention.end - mention.start));
  return mentions.sort((a, b) => a.paragraphId.localeCompare(b.paragraphId) || a.start - b.start || a.end - b.end || a.characterId.localeCompare(b.characterId));
}
