/** Pending detail indexes, excluding retained dismissals of the same source and observation.
 * The caller aliases the scoped candidate as p. JSONB canonicalizes object keys before hashing.
 */
export const pendingCastDetailSql = `SELECT item.value AS item
  FROM jsonb_array_elements(COALESCE(p.resolution_receipt->'result'->'pendingObservations','[]'::jsonb)) item
  WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p.detail_decisions) d
    WHERE (d->>'observationIndex')::integer=(item.value->>'index')::integer)
    AND NOT EXISTS (
      SELECT 1 FROM campaign_cast_discovery_candidates prior
      CROSS JOIN LATERAL jsonb_array_elements(prior.detail_decisions) d
      WHERE prior.owner_user_id=p.owner_user_id AND prior.campaign_id=p.campaign_id AND prior.status<>'cancelled'
        AND prior.source->>'turnId'=p.source->>'turnId'
        AND prior.source->>'narrationRevision'=p.source->>'narrationRevision'
        AND prior.source->>'sourceHash'=p.source->>'sourceHash'
        AND prior.source->>'timelineRevision'=p.source->>'timelineRevision'
        AND d->'result'->>'disposition'='dismiss'
        AND digest((prior.proposal->'observations'->((d->>'observationIndex')::integer))::text,'sha256')
          =digest((p.proposal->'observations'->((item.value->>'index')::integer))::text,'sha256')
    )`;
