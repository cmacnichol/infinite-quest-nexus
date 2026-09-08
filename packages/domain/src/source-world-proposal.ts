import { z } from "zod";
import {
  canonicalizeWorldContent, characterProfileSchema, type WorldContent
} from "../../contracts/src/world-library.js";
import {
  sourceFactSchema, type SourceCharacterIdentityGroup, type SourceDocument, type SourceFact
} from "../../contracts/src/source-authoring.js";
import { hasValidSourceDocumentIntegrity, sourceWorldFieldFactRule, validateSourceCitationWithinBoundary } from "./source-authoring.js";
import { containsMechanicsLanguage } from "./text.js";

export type SourceWorldSelection = Readonly<{
  source: SourceDocument;
  boundaryParagraphId: string;
  acceptedFacts: readonly SourceFact[];
  selectedCharacterFactIds: readonly string[];
  characterIdentityGroups: readonly SourceCharacterIdentityGroup[];
  mode: "faithful" | "expand";
}>;

export type SourceWorldFieldMapping = Readonly<{
  target: "world" | Readonly<{ characterRepresentativeFactId: string }>;
  path: string;
  value: string;
  supportingFactIds: readonly string[];
}>;

export type SourceWorldExpansionCandidate = SourceWorldFieldMapping & Readonly<{
  provenance: "invented";
}>;

export type SourceWorldProposalAssembly = Readonly<{
  proposal: WorldContent;
  mappings: readonly SourceWorldFieldMapping[];
  expansionCandidates: readonly SourceWorldExpansionCandidate[];
}>;

export type SourceWorldProposalFailureReason = "source_world_selection" | "source_world_closed_target" | "source_world_duplicate" | "source_world_unsupported_fact" | "source_world_identity" | "source_world_mechanics" | "source_world_faithful_expansion";

/** Closed, provider-safe synthesis failure metadata; never include IDs, values, or source text. */
export class SourceWorldProposalError extends TypeError {
  readonly reason: SourceWorldProposalFailureReason;
  readonly path: readonly (string | number)[];

  constructor(reason: SourceWorldProposalFailureReason, path: readonly (string | number)[]) {
    super(reason === "source_world_mechanics"
      ? "Source mechanics must remain outside fiction-facing world fields."
      : reason === "source_world_closed_target"
        ? "Generated source-world fields require a closed source-world target and path."
        : reason === "source_world_identity"
          ? "Generated source-world fields must target a selected identity."
        : reason === "source_world_selection"
          ? "Accepted facts must have exact evidence inside the selected boundary."
          : "Generated source-world response did not satisfy the reviewed source contract.");
    this.name = "SourceWorldProposalError";
    this.reason = reason;
    this.path = path;
  }
}

const generatedFieldSchema = z.object({ path: z.string(), value: z.string(), supportingFactIds: z.array(z.string()).min(1) }).strict();
const generatedSchema = z.object({
  fields: z.array(generatedFieldSchema),
  characterFields: z.array(z.object({ selectedCharacterFactId: z.string(), fields: z.array(generatedFieldSchema) }).strict()),
  expansionCandidates: z.array(generatedFieldSchema.extend({ target: z.union([z.literal("world"), z.string()]) }).strict()).default([])
}).strict();

function requireSelection(selection: SourceWorldSelection) {
  if (!hasValidSourceDocumentIntegrity(selection.source)) throw new SourceWorldProposalError("source_world_selection", ["fields"]);
  const boundary = selection.source.paragraphs.find((paragraph) => paragraph.id === selection.boundaryParagraphId);
  if (!boundary) throw new SourceWorldProposalError("source_world_selection", ["fields"]);
  let facts: SourceFact[];
  try {
    facts = selection.acceptedFacts.map((fact) => sourceFactSchema.parse(fact));
  } catch {
    throw new SourceWorldProposalError("source_world_selection", ["fields"]);
  }
  const ids = new Set<string>();
  for (const fact of facts) {
    const requiresCitation = fact.provenance === "stated" || fact.provenance === "inferred";
    if (ids.has(fact.id)
      || (requiresCitation && (!fact.citations.length || !fact.citations.every((citation) => validateSourceCitationWithinBoundary(selection.source, citation, selection.boundaryParagraphId))))
      || (!requiresCitation && fact.citations.length !== 0)) throw new SourceWorldProposalError("source_world_selection", ["fields"]);
    ids.add(fact.id);
  }
  const groups = selection.characterIdentityGroups;
  const grouped = new Set<string>();
  for (const group of groups) {
    if (!group.factIds.includes(group.representativeFactId) || group.factIds.some((id) => grouped.has(id) || !ids.has(id))) throw new SourceWorldProposalError("source_world_selection", ["fields"]);
    for (const id of group.factIds) grouped.add(id);
  }
  if (facts.filter((fact) => fact.kind === "character").some((fact) => !grouped.has(fact.id))) throw new SourceWorldProposalError("source_world_selection", ["fields"]);
  if (selection.selectedCharacterFactIds.length > 20 || new Set(selection.selectedCharacterFactIds).size !== selection.selectedCharacterFactIds.length || selection.selectedCharacterFactIds.some((id) => !groups.some((group) => group.representativeFactId === id))) throw new SourceWorldProposalError("source_world_selection", ["fields"]);
  return { facts, boundary };
}

/** Validate durable reviewed source data before a provider request can be paid for. */
export function validateSourceWorldSelection(selection: SourceWorldSelection): void {
  requireSelection(selection);
}

function supported(fact: SourceFact, path: string, value: string) {
  const rule = sourceWorldFieldFactRule(path);
  return rule !== undefined && fact.kind === rule.kind && fact.predicate.trim().toLocaleLowerCase() === rule.predicate && fact.value === value
    && !isMechanicsFact(fact) && !containsMechanicsLanguage(value);
}

/** Preserve typed abilities that the general fiction detector intentionally allows in prose. */
function isMechanicsFact(fact: SourceFact): boolean {
  return /^(?:strength|dexterity|constitution|intelligence|wisdom|charisma|check|roll|dice|modifier|difficulty|target|hit\s*points?|hp)$/iu.test(fact.predicate.trim())
    || containsMechanicsLanguage(`${fact.predicate}: ${fact.value}`);
}

function requireFictionSafeMapping(value: string, supportingFactIds: readonly string[], byId: ReadonlyMap<string, SourceFact>, path: readonly (string | number)[]): void {
  if (containsMechanicsLanguage(value)
    || supportingFactIds.some((id) => {
      const fact = byId.get(id);
      return fact !== undefined && isMechanicsFact(fact);
    })) {
    throw new SourceWorldProposalError("source_world_mechanics", path);
  }
}

function hasClosedTarget(path: string, owner: string | undefined): boolean {
  const rule = sourceWorldFieldFactRule(path);
  return rule !== undefined && (owner === undefined ? rule.kind !== "character" : rule.kind === "character");
}

function requireClosedTarget(path: string, owner: string | undefined, issuePath: readonly (string | number)[]): void {
  if (!hasClosedTarget(path, owner)) {
    throw new SourceWorldProposalError("source_world_closed_target", issuePath);
  }
}

export function assembleSourceWorldProposalWithEvidence(selection: SourceWorldSelection, generated: unknown): SourceWorldProposalAssembly {
  const { facts } = requireSelection(selection);
  const response = generatedSchema.parse(generated);
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const fields = new Map<string, string>();
  const characterFields = new Map<string, Map<string, string>>();
  const mappings: SourceWorldFieldMapping[] = [];
  const expansionCandidates: SourceWorldExpansionCandidate[] = [];
  const assigned = new Set<string>();
  const accept = (path: string, value: string, supportingFactIds: readonly string[], issuePath: readonly (string | number)[], owner?: string) => {
    requireClosedTarget(path, owner, [...issuePath, "path"]);
    requireFictionSafeMapping(value, supportingFactIds, byId, [...issuePath, "value"]);
    const target: SourceWorldFieldMapping["target"] = owner === undefined ? "world" : { characterRepresentativeFactId: owner };
    const key = `${owner ?? "world"}:${path}`;
    if (assigned.has(key)) throw new SourceWorldProposalError("source_world_duplicate", issuePath);
    assigned.add(key);
    const accepted = supportingFactIds.every((id) => {
      const fact = byId.get(id);
      return fact !== undefined && supported(fact, path, value)
        && (!owner || selection.characterIdentityGroups.some((group) => group.representativeFactId === owner && group.factIds.includes(id)));
    });
    if (!accepted) {
      if (selection.mode === "faithful") throw new SourceWorldProposalError("source_world_unsupported_fact", [...issuePath, "supportingFactIds"]);
      expansionCandidates.push({ target, path, value, supportingFactIds: [...supportingFactIds], provenance: "invented" });
      return;
    }
    if (owner) { const map = characterFields.get(owner) ?? new Map<string, string>(); map.set(path, value); characterFields.set(owner, map); }
    else fields.set(path, value);
    mappings.push({ target, path, value, supportingFactIds: [...supportingFactIds] });
  };
  for (const [fieldIndex, field] of response.fields.entries()) accept(field.path, field.value, field.supportingFactIds, ["fields", fieldIndex]);
  for (const [characterIndex, character] of response.characterFields.entries()) {
    if (!selection.selectedCharacterFactIds.includes(character.selectedCharacterFactId)) throw new SourceWorldProposalError("source_world_identity", ["characterFields", characterIndex, "selectedCharacterFactId"]);
    for (const [fieldIndex, field] of character.fields.entries()) accept(field.path, field.value, field.supportingFactIds, ["characterFields", characterIndex, "fields", fieldIndex], character.selectedCharacterFactId);
  }
  if (response.expansionCandidates.length) {
    if (selection.mode !== "expand") throw new SourceWorldProposalError("source_world_faithful_expansion", ["expansionCandidates", 0]);
    for (const [candidateIndex, candidate] of response.expansionCandidates.entries()) {
      const owner = candidate.target === "world" ? undefined : candidate.target;
      if (owner !== undefined && !selection.selectedCharacterFactIds.includes(owner)) {
        throw new SourceWorldProposalError("source_world_identity", ["expansionCandidates", candidateIndex, "target"]);
      }
      requireClosedTarget(candidate.path, owner, ["expansionCandidates", candidateIndex, "path"]);
      requireFictionSafeMapping(candidate.value, candidate.supportingFactIds, byId, ["expansionCandidates", candidateIndex, "value"]);
      if (!candidate.supportingFactIds.every((id) => {
        const fact = byId.get(id);
        return fact !== undefined && (owner === undefined
          || selection.characterIdentityGroups.some((group) => group.representativeFactId === owner && group.factIds.includes(id)));
      })) {
        throw new SourceWorldProposalError(owner === undefined ? "source_world_unsupported_fact" : "source_world_identity", ["expansionCandidates", candidateIndex, "supportingFactIds"]);
      }
      const key = `${owner ?? "world"}:${candidate.path}`;
      if (assigned.has(key)) throw new SourceWorldProposalError("source_world_duplicate", ["expansionCandidates", candidateIndex]);
      assigned.add(key);
      expansionCandidates.push({
        target: owner === undefined ? "world" : { characterRepresentativeFactId: owner },
        path: candidate.path,
        value: candidate.value,
        supportingFactIds: [...candidate.supportingFactIds],
        provenance: "invented"
      });
    }
  }
  const entities = facts.filter((fact) => !isMechanicsFact(fact))
    .map((fact) => ({ id: `source-entity:${fact.id}`, name: fact.subject, kind: fact.kind, description: "", tags: [], facts: [{ key: fact.predicate, value: fact.value }] }));
  const playableCharacters = selection.selectedCharacterFactIds.map((representativeFactId) => {
    const group = selection.characterIdentityGroups.find((candidate) => candidate.representativeFactId === representativeFactId)!;
    const identity = byId.get(representativeFactId)!;
    const profile = characterProfileSchema.parse({});
    const values = characterFields.get(representativeFactId);
    for (const [path, value] of values ?? []) {
      const key = path.slice("profile.appearance.".length) as keyof typeof profile.appearance;
      if (key in profile.appearance && typeof profile.appearance[key] === "string") (profile.appearance[key] as string) = value;
    }
    const guidance = group.factIds.map((id) => byId.get(id)!).filter((fact) => !isMechanicsFact(fact)).map((fact) => `${fact.predicate}: ${fact.value}`).join("\n");
    return { id: `source-character:${representativeFactId}`, name: identity.subject, characterText: guidance, profile, rpgStats: [], defaultTriggers: [], source: { type: "story-source", representativeFactId } };
  });
  return {
    proposal: canonicalizeWorldContent({ schemaVersion: 5, world: { title: selection.source.name, genre: "", tone: fields.get("world.tone") ?? "", premise: "", backgroundStory: "", firstAction: "", rules: fields.get("world.rules") ?? "" }, playableCharacters, entities, relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [], defaults: { importedFrom: "story-source" } }),
    mappings,
    expansionCandidates
  };
}

export function assembleSourceWorldProposal(selection: SourceWorldSelection, generated: unknown): WorldContent {
  return assembleSourceWorldProposalWithEvidence(selection, generated).proposal;
}

export function validateSourceWorldProposal(content: WorldContent): WorldContent {
  const canonical = canonicalizeWorldContent(content);
  if (!canonical.world.title || canonical.playableCharacters.some((character) => character.rpgStats.length || character.defaultTriggers.length)) throw new TypeError("Source proposal has invalid canonical fields.");
  return canonical;
}
