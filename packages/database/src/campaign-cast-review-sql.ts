/** Pending detail indexes excluding decisions already made on this candidate.
 * Cross-candidate dismissals are matched separately using canonical review targets.
 * The caller aliases the scoped candidate as p.
 */
export const pendingCastDetailSql = `SELECT item.value AS item
  FROM jsonb_array_elements(COALESCE(p.resolution_receipt->'result'->'pendingObservations','[]'::jsonb)) item
  WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p.detail_decisions) d
    WHERE (d->>'observationIndex')::integer=(item.value->>'index')::integer)
`;
