import { normalizeEntityTerm, type EntityReference } from "../../domain/src/entity-references.js";

/** Only scoped, unambiguous aliases may boost an unlinked fact. No identity is inferred or persisted. */
export function historicalFactAliasPatterns(catalog: readonly EntityReference[], matchedIds: readonly string[]): string[] {
  const owners = new Map<string, Set<string>>();
  for (const entity of catalog) for (const alias of [entity.displayName, ...entity.aliases]) {
    const normalized = normalizeEntityTerm(alias);
    if (!normalized) continue;
    const ids = owners.get(normalized) ?? new Set<string>();
    ids.add(entity.id);
    owners.set(normalized, ids);
  }
  const matched = new Set(matchedIds);
  return [...owners].filter(([, ids]) => ids.size === 1 && matched.has([...ids][0]!))
    .map(([alias]) => alias).sort().slice(0, 400)
    .map((alias) => `(^|[^[:alnum:]_])${alias.split(" ").map((term) => term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("[[:space:]]+")}($|[^[:alnum:]_])`);
}

/** Parameters: owner, campaign, world, cutoff, pool size, bounded queries, entity IDs, alias patterns, explicit source turn. */
export const HISTORICAL_FACT_POOL_SQL = `WITH
  query_terms AS MATERIALIZED (
    SELECT DISTINCT unnest(tsvector_to_array(to_tsvector('english', fragment))) AS term
      FROM unnest($6::text[]) fragment
  ), query AS MATERIALIZED (
    SELECT to_tsquery('english', COALESCE(string_agg(quote_literal(term), ' | ' ORDER BY term), '')) AS value FROM query_terms
  ), eligible AS MATERIALIZED (
    SELECT fact.id, source_turn_number, source_fact_index,
      ts_rank_cd(to_tsvector('english', content), query.value) AS lexical_score,
      (entity_ids && $7::text[] OR (cardinality(entity_ids)=0 AND EXISTS (
        SELECT 1 FROM unnest($8::text[]) pattern WHERE lower(normalize(content, NFKC)) ~ pattern
      ))) AS entity_match
    FROM campaign_canonical_facts fact CROSS JOIN query
    WHERE owner_user_id=$1 AND campaign_id=$2 AND world_version_id=$3
      AND valid_from_turn <= $4 AND (valid_until_turn IS NULL OR valid_until_turn > $4)
  ), lexical_lane AS (
    SELECT id, row_number() OVER (ORDER BY lexical_score DESC, source_turn_number DESC, source_fact_index, id) AS lane_rank
    FROM eligible WHERE lexical_score>0
    ORDER BY lexical_score DESC, source_turn_number DESC, source_fact_index, id LIMIT floor($5::numeric*0.40)::integer
  ), entity_lane AS (
    SELECT id, row_number() OVER (ORDER BY lexical_score DESC, source_turn_number DESC, source_fact_index, id) AS lane_rank
    FROM eligible WHERE entity_match
    ORDER BY lexical_score DESC, source_turn_number DESC, source_fact_index, id LIMIT floor($5::numeric*0.25)::integer
  ), temporal_lane AS (
    SELECT id, row_number() OVER (ORDER BY source_fact_index, id) AS lane_rank
    FROM eligible WHERE $9::integer IS NOT NULL AND source_turn_number=$9
    ORDER BY source_fact_index, id LIMIT floor($5::numeric*0.15)::integer
  ), recent_lane AS (
    SELECT id, row_number() OVER (ORDER BY source_turn_number DESC, source_fact_index, id) AS lane_rank
    FROM eligible ORDER BY source_turn_number DESC, source_fact_index, id
    LIMIT ($5::integer-floor($5::numeric*0.40)::integer-floor($5::numeric*0.25)::integer-floor($5::numeric*0.15)::integer)
  ), lanes AS (
    SELECT id, 'lexical' AS lane, lane_rank FROM lexical_lane
    UNION ALL SELECT id,'entity',lane_rank FROM entity_lane
    UNION ALL SELECT id,'temporal',lane_rank FROM temporal_lane
    UNION ALL SELECT id,'recent',lane_rank FROM recent_lane
  ), reserved AS (
    SELECT id, jsonb_object_agg(lane,lane_rank) AS lane_ranks FROM lanes GROUP BY id
  ), selected AS (
    SELECT eligible.*, reserved.lane_ranks FROM eligible LEFT JOIN reserved USING(id)
    ORDER BY (reserved.id IS NOT NULL) DESC, (lexical_score>0) DESC, lexical_score DESC,
      source_turn_number DESC, source_fact_index, id LIMIT $5::integer
  )
  SELECT fact.id, source_turn_id AS turn_id, 'canonical_fact'::text AS memory_kind, fact.source_turn_number AS ordinal,
    '- [fact_id: ' || fact.id || '] ' || content AS content,
    GREATEST(1,CEIL(length(content)/4.0))::integer AS token_estimate, 0.85::real AS importance,
    entities, entity_ids, jsonb_build_object('structuredFactIds',jsonb_build_array(fact.id::text),
      'historicalLaneRanks',COALESCE(lane_ranks,'{}'::jsonb),'historicalEntityMatch',entity_match) AS metadata,
    lexical_score AS relevance
  FROM selected JOIN campaign_canonical_facts fact ON fact.id=selected.id
  ORDER BY fact.source_turn_number, fact.source_fact_index, fact.id`;
