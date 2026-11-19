-- Up Migration
-- Match normalized providerRoutingPolicySchema values. Nullable OpenRouter
-- defaults are removed at preset ingress; persisted routing must not contain them.
CREATE FUNCTION public.valid_provider_routing_amount(value jsonb, allow_string boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE text_value text; number_value numeric; float_value double precision; exponent_value numeric;
BEGIN
  IF jsonb_typeof(value) = 'string' AND allow_string THEN
    text_value := value #>> '{}';
    IF char_length(text_value) > 128
       OR text_value !~ '^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$' THEN RETURN false; END IF;
    -- Avoid PostgreSQL numeric's exponent limit for strings JavaScript accepts
    -- as zero. With at most 128 characters, these bounds settle the magnitude.
    IF split_part(lower(text_value),'e',1) !~ '[1-9]' THEN RETURN true; END IF;
    IF position('e' IN lower(text_value)) > 0 THEN
      exponent_value := split_part(lower(text_value),'e',2)::numeric;
      IF exponent_value < -512 THEN RETURN true; END IF;
      IF exponent_value > 512 THEN RETURN false; END IF;
    END IF;
  ELSIF jsonb_typeof(value) = 'number' THEN
    text_value := value #>> '{}';
  ELSE
    RETURN false;
  END IF;
  number_value := text_value::numeric;
  IF number_value < 0 THEN RETURN false; END IF;
  BEGIN
    float_value := text_value::double precision;
    RETURN float_value <> 'Infinity'::double precision AND float_value <> 'NaN'::double precision;
  EXCEPTION WHEN numeric_value_out_of_range THEN
    -- JavaScript Number accepts positive underflow as zero, but not overflow.
    RETURN number_value BETWEEN 0 AND 1;
  END;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.valid_provider_routing_policy(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE key text; nested_key text; item jsonb; preference jsonb; price jsonb; sorting jsonb;
BEGIN
  IF NOT jsonb_object_has_only_keys(value,ARRAY['order','only','ignore','allow_fallbacks','require_parameters','data_collection','sort','quantizations','enforce_distillable_text','preferred_min_throughput','preferred_max_latency','max_price','zdr']) THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['order','only','ignore','quantizations'] LOOP
    IF value ? key THEN
      IF jsonb_typeof(value->key) IS DISTINCT FROM 'array' OR jsonb_array_length(value->key)>64 THEN RETURN false; END IF;
      FOR item IN SELECT entry FROM jsonb_array_elements(value->key) entry LOOP
        IF jsonb_typeof(item) IS DISTINCT FROM 'string' OR item #>> '{}' ~ '^[[:space:]]*$' THEN RETURN false; END IF;
      END LOOP;
    END IF;
  END LOOP;
  FOREACH key IN ARRAY ARRAY['allow_fallbacks','require_parameters','enforce_distillable_text','zdr'] LOOP
    IF value ? key AND jsonb_typeof(value->key) IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
  END LOOP;
  IF value ? 'data_collection' AND (jsonb_typeof(value->'data_collection') IS DISTINCT FROM 'string'
     OR value->>'data_collection' NOT IN ('allow','deny')) THEN RETURN false; END IF;
  IF value ? 'sort' THEN
    sorting := value->'sort';
    IF jsonb_typeof(sorting) = 'string' THEN
      IF sorting #>> '{}' NOT IN ('price','throughput','latency','exacto') THEN RETURN false; END IF;
    ELSE
      IF NOT jsonb_object_has_only_keys(sorting,ARRAY['by','partition']) THEN RETURN false; END IF;
      IF sorting ? 'by' AND (jsonb_typeof(sorting->'by') IS DISTINCT FROM 'string'
         OR sorting->>'by' NOT IN ('price','throughput','latency','exacto')) THEN RETURN false; END IF;
      IF sorting ? 'partition' AND (jsonb_typeof(sorting->'partition') IS DISTINCT FROM 'string'
         OR sorting->>'partition' NOT IN ('model','none')) THEN RETURN false; END IF;
    END IF;
  END IF;
  -- Both Order and Sort are valid; OpenRouter applies Order's precedence.
  FOREACH key IN ARRAY ARRAY['preferred_min_throughput','preferred_max_latency'] LOOP
    IF value ? key THEN
      preference := value->key;
      IF jsonb_typeof(preference) = 'number' THEN
        IF NOT valid_provider_routing_amount(preference) THEN RETURN false; END IF;
      ELSE
        IF NOT jsonb_object_has_only_keys(preference,ARRAY['p50','p75','p90','p99']) THEN RETURN false; END IF;
        FOREACH nested_key IN ARRAY ARRAY['p50','p75','p90','p99'] LOOP
          IF preference ? nested_key AND NOT valid_provider_routing_amount(preference->nested_key) THEN RETURN false; END IF;
        END LOOP;
      END IF;
    END IF;
  END LOOP;
  IF value ? 'max_price' THEN
    price := value->'max_price';
    IF NOT jsonb_object_has_only_keys(price,ARRAY['prompt','completion','image','request','audio']) THEN RETURN false; END IF;
    FOREACH key IN ARRAY ARRAY['prompt','completion','image','request','audio'] LOOP
      IF price ? key AND NOT valid_provider_routing_amount(price->key,true) THEN RETURN false; END IF;
    END LOOP;
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;

-- Down Migration
DO $$ BEGIN
  RAISE EXCEPTION 'Provider routing format migration is forward-only; retain the validator for persisted advanced routing snapshots';
END $$;
