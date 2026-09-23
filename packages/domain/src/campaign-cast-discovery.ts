import { CAST_DISCOVERY_PROTOCOL, castDiscoveryOutputSchema, castDiscoverySourceSchema, type CastDiscoveryCandidate, type CastDiscoveryIdentitySnapshot, type CastDiscoverySource } from "../../contracts/src/campaign-cast-discovery.js";
import type { CastCharacter, CastField, CastOrigin } from "../../contracts/src/campaign-cast.js";
import { estimateTokens, sha256, stableStringify } from "./text.js";
import { validateCastFiction } from "./campaign-cast.js";
import { normalizeEntityTerm } from "./entity-references.js";

export type CastDiscoveryWorldIdentity = CastDiscoveryIdentitySnapshot["worldCharacters"][number];

/** Callers supply campaign-scoped validated identities, never a raw generation context. */
export function buildCastDiscoveryInput(input: {
  source: CastDiscoverySource; knownCharacters: CastCharacter[]; worldCharacters?: CastDiscoveryWorldIdentity[];
}): string {
  const source = castDiscoverySourceSchema.parse(input.source);
  return stableStringify({ protocol: CAST_DISCOVERY_PROTOCOL,
    source: { turnNumber: source.turnNumber, paragraphs: source.paragraphs },
    knownCharacters: input.knownCharacters.map((person) => ({ id: person.id, name: person.name, aliases: person.aliases,
      profile: person.profile, protagonist: person.origin.kind === "protagonist" })),
    worldCharacters: (input.worldCharacters ?? []).map((person) => ({ entityId: person.entityId, name: person.name,
      aliases: person.aliases, identityHints: person.identityHints ?? [] })) });
}

export function buildCastDiscoverySource(input: Omit<CastDiscoverySource, "sourceHash" | "paragraphs"> & { narration: string }): CastDiscoverySource {
  const { narration, ...source } = input;
  const paragraphs = narration.match(/[\s\S]+?(?:\r?\n[ \t]*\r?\n|$)/gu) ?? [];
  return castDiscoverySourceSchema.parse({ ...source, sourceHash: sha256(narration),
    paragraphs: paragraphs.map((text, index) => ({ id: `p${index + 1}`, text })) });
}

/** Complete source segmentation. The caller also bounds the final serialized provider request. */
export function chunkCastDiscoverySource(source: CastDiscoverySource, targetTokens = 3000, maxChunks = 32) {
  if (!Number.isInteger(targetTokens) || targetTokens < 1 || !Number.isInteger(maxChunks) || maxChunks < 1) throw new Error("Invalid discovery chunk limits.");
  const segments: CastDiscoverySource["paragraphs"] = [];
  for (const paragraph of source.paragraphs) {
    if (estimateTokens(paragraph.text) <= targetTokens) { segments.push(paragraph); continue; }
    const points = Array.from(paragraph.text);
    let offset = 0, ordinal = 1;
    while (offset < points.length) {
      let low = 1, high = points.length - offset, length = 0;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (estimateTokens(points.slice(offset, offset + middle).join("")) <= targetTokens) { length = middle; low = middle + 1; }
        else high = middle - 1;
      }
      if (!length) return { status: "source_requires_manual_scan" as const, chunks: [] };
      segments.push({ id: `${paragraph.id}.s${ordinal++}`, text: points.slice(offset, offset + length).join("") }); offset += length;
    }
  }
  const chunks: CastDiscoverySource[] = [];
  let batch: CastDiscoverySource["paragraphs"] = [];
  for (const paragraph of segments) {
    if (batch.length && estimateTokens([...batch, paragraph].map((part) => part.text).join("")) > targetTokens) {
      chunks.push({ ...source, paragraphs: batch }); batch = [];
    }
    batch.push(paragraph);
  }
  if (batch.length) chunks.push({ ...source, paragraphs: batch });
  return chunks.length > maxChunks ? { status: "source_requires_manual_scan" as const, chunks: [] }
    : { status: "ready" as const, chunks };
}

type ValidatedCandidate = CastDiscoveryCandidate & { resolvedOrigin: CastOrigin };
export type CastDiscoveryValidation = {
  accepted: ValidatedCandidate[];
  rejected: { localKey: string; code: string }[];
  unresolved: { candidate: CastDiscoveryCandidate; code: string }[];
};
const fieldCues: Record<CastField, RegExp> = {
  "identity.pronouns": /\b(?:pronouns?|he|she|they|him|her|them)\b/iu,
  "story.role": /\b(?:is|was|works?|serves?|role|captain|guard|courier|keeper|doctor|merchant)\b/iu,
  "story.background": /\b(?:born|raised|grew|once|formerly|past|history|childhood|years? ago)\b/iu,
  "story.personality": /\b(?:is|was|seems?|kind|cruel|patient|impatient|generous|cautious)\b/iu,
  "story.motivations": /\b(?:wants?|seeks?|because|driven|hopes?|desires?|fears?)\b/iu,
  "story.goals": /\b(?:wants?|seeks?|plans?|intends?|hopes?|aims?|goal|must)\b/iu,
  "story.voiceAndMannerisms": /\b(?:voice|speaks?|says?|whispers?|accent|laughs?|gestures?|habit)\b/iu,
  "appearance.description": /\b(?:eyes?|hair|face|skin|tall|short|scar|wears?|appearance|beard|braid|looks?)\b/iu,
  "state.location": /\b(?:at|in|inside|outside|near|enters?|leaves?|arrives?|stands?|sits?)\b/iu,
  "state.condition": /\b(?:injured|wounded|hurt|healthy|tired|ill|dead|alive|bleeding|unconscious|exhausted)\b/iu,
  "state.clothing": /\b(?:wears?|wore|wearing|clothes?|coat|cloak|shirt|dress|boots?|robe|armor|armour)\b/iu
};
const instructions = /\b(?:ignore (?:all |previous |prior )?instructions|system prompt|edit another campaign|override (?:the )?(?:system|developer))\b/iu;
const prospective = /\b(?:hopes? to meet|plans? to meet|imagines?|imagined|hypothetical|if .{0,80}(?:arrives|exists))\b/iu;
const speech = /[“”"]|\b(?:says?|said|claims?|claimed|rumou?r|alleges?|believes?)\b/iu;
function contains(text: string, term: string) {
  const escaped = normalizeEntityTerm(term).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, "u").test(normalizeEntityTerm(text));
}
function directlyAttributes(text: string, names: string[], value: string) {
  const escape = (term: string) => normalizeEntityTerm(term).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  // Automatically publish only an extractive subject/predicate/value statement.
  // Paraphrases, pronoun resolution and more complex clauses stay reviewable.
  const predicates = "(?:has|had|is|was|wears|wore|wants|wanted|seeks|sought|speaks|spoke|looks|looked|works as|serves as|stands at|stood at|sits at|sat at|lives in|lived in|arrives at|arrived at)";
  return names.some((name) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escape(name)}\\s+${predicates}\\s+(?:(?:a|an|the)\\s+)?${escape(value)}(?:$|[^\\p{L}\\p{N}])`, "u").test(normalizeEntityTerm(text)));
}

function explicitlyLinksAlias(text: string, name: string, alias: string) {
  const escape = (term: string) => normalizeEntityTerm(term).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escape(name)}(?:(?:,\\s+(?:also )?(?:known as|called))|(?:\\s+(?:is|was)\\s+(?:also )?(?:known as|called))|(?:\\s+aka))\\s+${escape(alias)}(?:$|[^\\p{L}\\p{N}])`, "u")
    .test(normalizeEntityTerm(text));
}

/** Lexical guards establish bounded provenance, not a general semantic truth proof. */
export function validateCastDiscovery(input: {
  source: CastDiscoverySource; output: unknown; knownCharacters: CastCharacter[];
  worldCharacters?: CastDiscoveryWorldIdentity[]; worldVersionId?: string;
}): CastDiscoveryValidation {
  const source = castDiscoverySourceSchema.parse(input.source), output = castDiscoveryOutputSchema.parse(input.output);
  const paragraphs = new Map(source.paragraphs.map((paragraph) => [paragraph.id, paragraph.text]));
  const known = new Map(input.knownCharacters.map((person) => [person.id, person]));
  const result: CastDiscoveryValidation = { accepted: [], rejected: [], unresolved: [] };
  for (const candidate of output.characters) {
    const reject = (code: string) => result.rejected.push({ localKey: candidate.localKey, code });
    const hold = (code: string) => result.unresolved.push({ candidate, code });
    if (candidate.existingCharacterId && !known.has(candidate.existingCharacterId)) { reject("unknown_character_id"); continue; }
    const citations = [...candidate.identityEvidence, ...candidate.observations];
    if (citations.some((evidence) => !paragraphs.get(evidence.paragraphId)?.includes(evidence.quote))) { reject("quote_not_in_source"); continue; }
    if (output.characters.filter((person) => normalizeEntityTerm(person.name) === normalizeEntityTerm(candidate.name)).length > 1) {
      hold("identity_needs_review"); continue;
    }
    if (citations.some((evidence) => instructions.test(paragraphs.get(evidence.paragraphId)!))) { hold("source_instruction"); continue; }
    try { validateCastFiction(candidate.name); candidate.aliases.forEach(validateCastFiction); candidate.observations.forEach((observation) => validateCastFiction(observation.value)); }
    catch { reject("non_fiction_value"); continue; }
    const identityText = candidate.identityEvidence.map((evidence) => evidence.quote).join("\n");
    if (!contains(identityText, candidate.name) || candidate.aliases.some((alias) => !contains(identityText, alias))) { hold("identity_not_supported"); continue; }
    if (candidate.aliases.some((alias) => !explicitlyLinksAlias(identityText, candidate.name, alias))) { hold("alias_not_supported"); continue; }
    if (candidate.identityEvidence.some((evidence) => prospective.test(paragraphs.get(evidence.paragraphId)!))) { hold("non_actual_identity"); continue; }
    if (/^(?:crowd|people|guards|villagers|everyone|someone|a person)$/iu.test(candidate.name)) { hold("insufficient_identity"); continue; }
    const terms = [candidate.name, ...candidate.aliases].map(normalizeEntityTerm);
    const matches = input.knownCharacters.filter((person) => [person.name, ...person.aliases].some((alias) => terms.includes(normalizeEntityTerm(alias)) && contains(identityText, alias)));
    if (matches.length > 1 || matches.length === 1 && candidate.existingCharacterId !== matches[0]!.id
      || candidate.existingCharacterId && !matches.some((person) => person.id === candidate.existingCharacterId)) { hold("identity_needs_review"); continue; }
    const corroborates = (person: { name: string; aliases: string[] }, hints: string[]) =>
      person.aliases.some((alias) => normalizeEntityTerm(alias) !== normalizeEntityTerm(person.name)
        && explicitlyLinksAlias(identityText, person.name, alias))
      || hints.some((value) => value.trim().length >= 3 && directlyAttributes(identityText, [person.name, ...person.aliases], value));
    if (candidate.existingCharacterId && !corroborates(known.get(candidate.existingCharacterId)!, Object.values(known.get(candidate.existingCharacterId)!.profile))) {
      hold("identity_needs_review"); continue;
    }
    const worldMatches = (input.worldCharacters ?? []).filter((person) => [person.name, ...person.aliases].some((alias) => terms.includes(normalizeEntityTerm(alias)) && contains(identityText, alias)));
    if (!candidate.existingCharacterId && worldMatches.length > 1) { hold("identity_needs_review"); continue; }
    if (!candidate.existingCharacterId && worldMatches[0] && !corroborates(worldMatches[0], worldMatches[0].identityHints ?? [])) {
      hold("identity_needs_review"); continue;
    }
    let invalid: string | null = null;
    for (const observation of candidate.observations) {
      const context = paragraphs.get(observation.paragraphId)!;
      if (!contains(observation.quote, observation.value) || !fieldCues[observation.field].test(observation.quote)) invalid = "unsupported_field";
      if (!directlyAttributes(observation.quote, [candidate.name, ...candidate.aliases], observation.value)) invalid = "unsupported_subject";
      if (observation.mode === "fact" && (observation.speakerCharacterId || speech.test(context))) invalid = "claim_not_fact";
      if (observation.mode === "fact" && /\b(?:not|never|no longer|without|neither|isn't|wasn't|doesn't)\b/iu.test(context)) invalid = "negated_evidence";
      if (observation.mode === "claim" && (!observation.speakerCharacterId || !known.has(observation.speakerCharacterId))) invalid = "unknown_speaker";
      else if (observation.mode === "claim") {
        const speaker = known.get(observation.speakerCharacterId!)!;
        const attributed = [speaker.name, ...speaker.aliases].some((alias) => {
          const escaped = normalizeEntityTerm(alias).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
          const statement = new RegExp(`^${escaped}\\s+(?:says|said|claims|claimed|alleges|alleged),?\\s+["“]([^"”]+)["”][.!]?$`, "u")
            .exec(normalizeEntityTerm(observation.quote));
          return statement !== null && directlyAttributes(statement[1]!, [candidate.name, ...candidate.aliases], observation.value);
        });
        if (!attributed) invalid = "unsupported_speaker";
      }
    }
    if (invalid) { hold(invalid); continue; }
    const world = worldMatches[0];
    result.accepted.push({ ...candidate, resolvedOrigin: candidate.existingCharacterId ? known.get(candidate.existingCharacterId)!.origin
      : world && input.worldVersionId ? { kind: "world", worldVersionId: input.worldVersionId, entityId: world.entityId } : { kind: "discovered" } });
  }
  return result;
}
