const normalize = (value) => typeof value === "string"
  ? value.trim().replace(/\s+/gu, " ").toLocaleLowerCase()
  : "";

export const findAllowedFact = (facts, expected) => Array.isArray(facts)
  ? facts.find((fact) => fact?.kind === "character"
    && fact.provenance === "stated"
    && normalize(fact.subject) === normalize(expected.subject)
    && expected.variants.some((variant) => normalize(fact.predicate) === normalize(variant.predicate)
      && normalize(fact.value) === normalize(variant.value)
      && Array.isArray(fact.citations)
      && fact.citations.some((citation) => variant.quotes.includes(citation?.quote))))
  : undefined;
