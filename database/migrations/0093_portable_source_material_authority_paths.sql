-- Source provenance has one semantic path field: the reviewed target path in
-- sourceMaterial.fieldEvidence[]. It is durable import authority, not a
-- filesystem path. Keep the historical generic path/secret exclusion for all
-- other locations and keys.
CREATE OR REPLACE FUNCTION portable_import_normalized_payload_is_safe(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  WITH RECURSIVE nodes(node_path, value) AS (
    SELECT ARRAY[]::text[], value
    UNION ALL
    SELECT parent.node_path || child.child_path, child.value
      FROM nodes parent
      CROSS JOIN LATERAL (
        SELECT ARRAY[object_key]::text[] AS child_path, object_value AS value
          FROM jsonb_each(CASE WHEN jsonb_typeof(parent.value) = 'object' THEN parent.value ELSE '{}'::jsonb END)
               AS object_child(object_key, object_value)
        UNION ALL
        SELECT ARRAY[(ordinality - 1)::text]::text[] AS child_path, array_value AS value
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(parent.value) = 'array' THEN parent.value ELSE '[]'::jsonb END)
               WITH ORDINALITY AS array_child(array_value, ordinality)
      ) child
  ), keys AS (
    SELECT nodes.node_path, object_key, object_value
      FROM nodes
      CROSS JOIN LATERAL jsonb_each(
        CASE WHEN jsonb_typeof(nodes.value) = 'object' THEN nodes.value ELSE '{}'::jsonb END
      ) AS object_child(object_key, object_value)
  )
  SELECT NOT EXISTS (
    SELECT 1 FROM keys
     WHERE object_key ~* '(^|_)(path|bearer|credential|secret|token|provider_response|raw_response)($|_)'
       AND NOT (
         object_key = 'path'
         AND cardinality(node_path) >= 3
         AND node_path[cardinality(node_path) - 2] = 'sourceMaterial'
         AND node_path[cardinality(node_path) - 1] = 'fieldEvidence'
         AND node_path[cardinality(node_path)] ~ '^[0-9]+$'
         AND jsonb_typeof(object_value) = 'string'
         AND object_value #>> '{}' ~ '^(world\.(tone|rules)|playableCharacters\.source-character:.+\.profile\.appearance\.(clothing|hair|eyes|apparentAge))$'
       )
  );
$$;
