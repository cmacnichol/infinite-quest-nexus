-- Downlevel-worker compatibility for immutable text execution plans.
-- This capability flag is transaction-local and is not an authorization boundary.

ALTER TABLE generation_jobs
  ADD COLUMN text_plan_protocol smallint NULL
  CHECK (text_plan_protocol IS NULL OR text_plan_protocol = 2);

ALTER TABLE authoring_jobs
  ADD COLUMN text_plan_protocol smallint NULL
  CHECK (text_plan_protocol IS NULL OR text_plan_protocol = 2);

ALTER TABLE illustration_prompt_jobs
  ADD COLUMN text_plan_protocol smallint NULL
  CHECK (text_plan_protocol IS NULL OR text_plan_protocol = 2);

CREATE FUNCTION jsonb_object_has_only_keys(value jsonb, allowed text[])
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  RETURN NOT EXISTS (SELECT 1 FROM jsonb_object_keys(value) key WHERE NOT key = ANY(allowed));
END;
$$;

CREATE FUNCTION jsonb_object_has_keys(value jsonb, required text[])
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  RETURN NOT EXISTS (SELECT 1 FROM unnest(required) key WHERE NOT value ? key);
END;
$$;

CREATE FUNCTION valid_hash_text(value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_typeof(value) = 'string' AND value #>> '{}' ~ '^[a-f0-9]{64}$', false)
$$;

CREATE FUNCTION valid_uuid_text(value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_typeof(value) = 'string'
    AND value #>> '{}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false)
$$;

CREATE FUNCTION valid_bounded_text(value jsonb, minimum integer, maximum integer)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_typeof(value) = 'string'
    AND char_length(btrim(value #>> '{}')) >= minimum
    AND char_length(value #>> '{}') <= maximum, false)
$$;

CREATE FUNCTION valid_iso_datetime_text(value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_typeof(value) = 'string'
    AND value #>> '{}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$', false)
$$;

CREATE FUNCTION valid_bounded_string_array(value jsonb, maximum_items integer, maximum_length integer)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'array' OR jsonb_array_length(value)>maximum_items THEN RETURN false; END IF;
  FOR item IN SELECT entry FROM jsonb_array_elements(value) entry LOOP
    IF NOT valid_bounded_text(item,1,maximum_length) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE FUNCTION javascript_utf16_sort_key(value text)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE result text := ''; code_point integer; index integer;
BEGIN
  FOR index IN 1..char_length(value) LOOP
    code_point := ascii(substr(value,index,1));
    IF code_point <= 65535 THEN
      result := result || lpad(to_hex(code_point),4,'0');
    ELSE
      code_point := code_point - 65536;
      result := result
        || lpad(to_hex(55296 + code_point / 1024),4,'0')
        || lpad(to_hex(56320 + code_point % 1024),4,'0');
    END IF;
  END LOOP;
  RETURN result;
END;
$$;

CREATE FUNCTION javascript_json_number_text(value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET extra_float_digits = 3
AS $$
DECLARE
  rendered text; mantissa text; digits text; integer_part text; fractional_part text;
  sign text := ''; exponent integer := 0; first_significant integer; decimal_exponent integer; decimal_position integer;
BEGIN
  rendered := pg_catalog.float8out((value #>> '{}')::double precision);
  IF rendered IN ('NaN','Infinity','-Infinity') THEN RETURN 'null'; END IF;
  IF left(rendered,1)='-' THEN sign := '-'; rendered := substr(rendered,2); END IF;
  IF rendered ~ '[eE]' THEN
    mantissa := split_part(lower(rendered),'e',1);
    exponent := split_part(lower(rendered),'e',2)::integer;
  ELSE
    mantissa := rendered;
  END IF;
  integer_part := split_part(mantissa,'.',1);
  fractional_part := CASE WHEN position('.' IN mantissa)>0 THEN split_part(mantissa,'.',2) ELSE '' END;
  rendered := integer_part || fractional_part;
  first_significant := length(rendered) - length(ltrim(rendered,'0')) + 1;
  IF first_significant > length(rendered) THEN RETURN '0'; END IF;
  digits := rtrim(substr(rendered,first_significant),'0');
  decimal_exponent := length(integer_part) - first_significant + exponent;
  IF decimal_exponent < -6 OR decimal_exponent >= 21 THEN
    RETURN sign || left(digits,1)
      || CASE WHEN length(digits)>1 THEN '.' || substr(digits,2) ELSE '' END
      || 'e' || CASE WHEN decimal_exponent>=0 THEN '+' ELSE '' END || decimal_exponent::text;
  END IF;
  decimal_position := decimal_exponent + 1;
  IF decimal_position <= 0 THEN
    RETURN sign || '0.' || repeat('0',-decimal_position) || digits;
  END IF;
  IF decimal_position >= length(digits) THEN
    RETURN sign || digits || repeat('0',decimal_position-length(digits));
  END IF;
  RETURN sign || left(digits,decimal_position) || '.' || substr(digits,decimal_position+1);
END;
$$;

-- Mirrors the contracts' canonicalJson/stableStringify rules for persisted
-- JSON-compatible values: array order is retained, numbers use JavaScript's
-- finite Number rendering, and object keys are sorted by UTF-16 code units.
CREATE FUNCTION canonical_jsonb_text(value jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE kind text;
BEGIN
  IF value IS NULL THEN RETURN NULL; END IF;
  kind := jsonb_typeof(value);
  IF kind='object' THEN
    RETURN '{' || COALESCE((
      SELECT string_agg(to_json(entry.key)::text || ':' || canonical_jsonb_text(entry.value), ',' ORDER BY javascript_utf16_sort_key(entry.key) COLLATE "C")
        FROM jsonb_each(value) entry
    ), '') || '}';
  END IF;
  IF kind='array' THEN
    RETURN '[' || COALESCE((
      SELECT string_agg(canonical_jsonb_text(item.value), ',' ORDER BY item.ordinality)
        FROM jsonb_array_elements(value) WITH ORDINALITY item(value, ordinality)
    ), '') || ']';
  END IF;
  IF kind='string' THEN RETURN to_json(value #>> '{}')::text; END IF;
  IF kind='null' THEN RETURN 'null'; END IF;
  IF kind='number' THEN RETURN javascript_json_number_text(value); END IF;
  RETURN value #>> '{}';
END;
$$;

CREATE FUNCTION canonical_jsonb_sha256(value jsonb)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(digest(convert_to(canonical_jsonb_text(value),'UTF8'),'sha256'),'hex')
$$;

CREATE FUNCTION valid_positive_integer(value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_typeof(value) = 'number'
    AND value #>> '{}' ~ '^[0-9]+$' AND (value #>> '{}')::numeric > 0, false)
$$;

CREATE FUNCTION valid_v1_invocation_key(value text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT value IN ('story:stream','story:nonstream','choices:nonstream','continuity_review:nonstream')
$$;

CREATE FUNCTION valid_v1_queued_response_policy(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE key_value jsonb;
BEGIN
  IF NOT jsonb_object_has_only_keys(value, ARRAY['version','policy','providerProfileId','model','endpointIdentity','providerConfigurationHash','verificationRegistryHash','operationClosureVersion','invocationKeys'])
     OR NOT jsonb_object_has_keys(value, ARRAY['version','policy','providerProfileId','model','endpointIdentity','providerConfigurationHash','verificationRegistryHash','operationClosureVersion','invocationKeys'])
     OR value->>'version' <> '1' OR value->>'policy' NOT IN ('auto','required')
     OR NOT valid_uuid_text(value->'providerProfileId') OR NOT valid_bounded_text(value->'model',1,512)
     OR NOT valid_bounded_text(value->'endpointIdentity',1,512)
     OR NOT valid_hash_text(value->'providerConfigurationHash') OR NOT valid_hash_text(value->'verificationRegistryHash')
     OR value->>'operationClosureVersion' <> '1' OR jsonb_typeof(value->'invocationKeys') IS DISTINCT FROM 'array'
     OR jsonb_array_length(value->'invocationKeys') NOT BETWEEN 1 AND 4 THEN RETURN false; END IF;
  FOR key_value IN SELECT item FROM jsonb_array_elements(value->'invocationKeys') item LOOP
    IF jsonb_typeof(key_value) <> 'string' OR NOT valid_v1_invocation_key(key_value #>> '{}') THEN RETURN false; END IF;
  END LOOP;
  RETURN (SELECT count(*) = count(DISTINCT item) FROM jsonb_array_elements_text(value->'invocationKeys') item);
END;
$$;

CREATE FUNCTION valid_v1_prepared_response_contract(value jsonb, invocation_key text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE expected_operation text := split_part(invocation_key, ':', 1); expected_streaming boolean := split_part(invocation_key, ':', 2) = 'stream';
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR value->>'version' <> '1'
     OR value->>'operation' NOT IN ('story','choices','continuity_review')
     OR (value->>'operation') IS DISTINCT FROM expected_operation
     OR jsonb_typeof(value->'streaming') IS DISTINCT FROM 'boolean'
     OR value->'streaming' IS DISTINCT FROM to_jsonb(expected_streaming)
     OR value->>'forbidFormatFallback' <> 'true' OR value->>'mode' NOT IN ('json_object','json_schema') THEN RETURN false; END IF;
  IF value->>'mode' = 'json_object' THEN
    RETURN jsonb_object_has_only_keys(value, ARRAY['version','operation','streaming','forbidFormatFallback','mode'])
      AND jsonb_object_has_keys(value, ARRAY['version','operation','streaming','forbidFormatFallback','mode']);
  END IF;
  RETURN jsonb_object_has_only_keys(value, ARRAY['version','operation','streaming','forbidFormatFallback','mode','schemaVersion','schemaHash','schemaName','schema','providerRoutingSlugs','routeConfigHash','adapterProtocol'])
    AND jsonb_object_has_keys(value, ARRAY['version','operation','streaming','forbidFormatFallback','mode','schemaVersion','schemaHash','schemaName','schema','providerRoutingSlugs','routeConfigHash','adapterProtocol'])
    AND valid_bounded_text(value->'schemaVersion',1,200) AND valid_hash_text(value->'schemaHash')
    AND value->>'schemaHash'=canonical_jsonb_sha256(value->'schema')
    AND valid_bounded_text(value->'schemaName',1,200) AND jsonb_typeof(value->'schema') = 'object'
    AND valid_bounded_string_array(value->'providerRoutingSlugs',64,128)
    AND valid_hash_text(value->'routeConfigHash') AND value->>'adapterProtocol' = 'text-schema-adapter-v1';
END;
$$;

CREATE FUNCTION valid_v1_frozen_response_contracts(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE key text; contract jsonb; queued_keys text[];
BEGIN
  IF NOT jsonb_object_has_only_keys(value, ARRAY['version','queuedPolicy','selectedAt','capabilityEvidenceHash','contracts','selectionHash'])
     OR NOT jsonb_object_has_keys(value, ARRAY['version','queuedPolicy','selectedAt','capabilityEvidenceHash','contracts','selectionHash'])
     OR value->>'version' <> '1' OR NOT valid_v1_queued_response_policy(value->'queuedPolicy')
     OR NOT valid_iso_datetime_text(value->'selectedAt') OR NOT valid_hash_text(value->'capabilityEvidenceHash')
     OR jsonb_typeof(value->'contracts') IS DISTINCT FROM 'object' OR NOT valid_hash_text(value->'selectionHash') THEN RETURN false; END IF;
  SELECT array_agg(item) INTO queued_keys FROM jsonb_array_elements_text(value->'queuedPolicy'->'invocationKeys') item;
  FOR key, contract IN SELECT * FROM jsonb_each(value->'contracts') LOOP
    IF NOT key = ANY(queued_keys) OR NOT valid_v1_prepared_response_contract(contract, key) THEN RETURN false; END IF;
  END LOOP;
  RETURN NOT EXISTS (SELECT 1 FROM unnest(queued_keys) queued WHERE NOT (value->'contracts') ? queued)
    AND value->>'selectionHash'=canonical_jsonb_sha256(value-'selectionHash');
END;
$$;

CREATE FUNCTION valid_v1_attempt_response_audit(value jsonb, invocation_key text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_object_has_only_keys(value, ARRAY['version','selectionHash','invocationKey','mode','schemaVersion','schemaHash','requestedModel','providerRoutingSlugs','returnedModel','returnedProviderRoute','diagnosticCode'])
    AND jsonb_object_has_keys(value, ARRAY['version','selectionHash','invocationKey','mode','schemaVersion','schemaHash','requestedModel','providerRoutingSlugs','returnedModel','returnedProviderRoute','diagnosticCode'])
    AND value->>'version'='1' AND value->>'invocationKey'=invocation_key AND valid_v1_invocation_key(value->>'invocationKey')
    AND value->>'mode' IN ('json_object','json_schema') AND valid_hash_text(value->'selectionHash')
    AND valid_bounded_text(value->'requestedModel',1,512) AND valid_bounded_string_array(value->'providerRoutingSlugs',64,128)
    AND (value->'returnedModel'='null'::jsonb OR valid_bounded_text(value->'returnedModel',1,256))
    AND (value->'returnedProviderRoute'='null'::jsonb OR valid_bounded_text(value->'returnedProviderRoute',1,256))
    AND ((value->>'mode'='json_schema' AND valid_bounded_text(value->'schemaVersion',1,200) AND valid_hash_text(value->'schemaHash'))
      OR (value->>'mode'='json_object' AND value->'schemaVersion'='null'::jsonb AND value->'schemaHash'='null'::jsonb))
    AND (value->'diagnosticCode'='null'::jsonb OR value->>'diagnosticCode' IN ('provider_schema_unsupported','provider_schema_invalid','provider_route_unavailable','provider_refusal'))
$$;

CREATE FUNCTION valid_v1_response_contract_invocation(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE status text;
BEGIN
  IF NOT jsonb_object_has_only_keys(value, ARRAY['version','id','logicalAttemptId','invocationKey','operation','requestPayloadHash','request','status','reservedAt','dispatchedAt','completedAt','response'])
     OR NOT jsonb_object_has_keys(value, ARRAY['version','id','logicalAttemptId','invocationKey','operation','requestPayloadHash','request','status','reservedAt','dispatchedAt','completedAt','response'])
     OR value->>'version'<>'1' OR NOT valid_hash_text(value->'id') OR NOT valid_uuid_text(value->'logicalAttemptId')
     OR NOT valid_v1_invocation_key(value->>'invocationKey')
     OR value->>'operation' NOT IN ('story_generation','story_recovery','story_choice_repair','event_extension','scene_coverage_rewrite','story_continuity_review','story_continuity_repair')
     OR NOT valid_hash_text(value->'requestPayloadHash')
     OR NOT valid_v1_attempt_response_audit(value->'request',value->>'invocationKey')
     OR NOT valid_iso_datetime_text(value->'reservedAt') THEN RETURN false; END IF;
  status := value->>'status';
  IF status='reserved' THEN RETURN value->'dispatchedAt'='null'::jsonb AND value->'completedAt'='null'::jsonb AND value->'response'='null'::jsonb; END IF;
  IF status='dispatched' THEN RETURN valid_iso_datetime_text(value->'dispatchedAt') AND value->'completedAt'='null'::jsonb AND value->'response'='null'::jsonb; END IF;
  IF status='completed' THEN RETURN valid_iso_datetime_text(value->'dispatchedAt') AND valid_iso_datetime_text(value->'completedAt')
    AND jsonb_typeof(value->'response')='object'
    AND jsonb_object_has_only_keys(value->'response',ARRAY['returnedModel','returnedProviderRoute','diagnosticCode','resultHash'])
    AND jsonb_object_has_keys(value->'response',ARRAY['returnedModel','returnedProviderRoute','diagnosticCode','resultHash'])
    AND (value->'response'->'returnedModel'='null'::jsonb OR valid_bounded_text(value->'response'->'returnedModel',1,256))
    AND (value->'response'->'returnedProviderRoute'='null'::jsonb OR valid_bounded_text(value->'response'->'returnedProviderRoute',1,256))
    AND (value->'response'->'diagnosticCode'='null'::jsonb OR value->'response'->>'diagnosticCode' IN ('provider_schema_unsupported','provider_schema_invalid','provider_route_unavailable','provider_refusal'))
    AND (value->'response'->'resultHash'='null'::jsonb OR valid_hash_text(value->'response'->'resultHash')); END IF;
  RETURN false;
END;
$$;

CREATE FUNCTION story_requires_text_plan_protocol(orchestration jsonb, streaming jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  invocation jsonb;
BEGIN
  IF orchestration ? 'textExecutionRouteBasis' OR orchestration ? 'textExecutionPlan' THEN
    RETURN true;
  END IF;
  IF orchestration ? 'queuedResponsePolicy' THEN
    IF NOT valid_v1_queued_response_policy(orchestration->'queuedResponsePolicy') THEN RETURN true; END IF;
  END IF;
  IF orchestration ? 'frozenResponseContracts' THEN
    IF NOT valid_v1_frozen_response_contracts(orchestration->'frozenResponseContracts') THEN RETURN true; END IF;
  END IF;
  IF orchestration ? 'responseContractInvocations' THEN
    IF jsonb_typeof(orchestration->'responseContractInvocations') IS DISTINCT FROM 'array' THEN
      RETURN true;
    END IF;
    FOR invocation IN SELECT value FROM jsonb_array_elements(orchestration->'responseContractInvocations') LOOP
      IF NOT valid_v1_response_contract_invocation(invocation) THEN
        RETURN true;
      END IF;
    END LOOP;
  END IF;
  RETURN streaming ? 'illustrationTextExecutionSnapshot';
END;
$$;

CREATE FUNCTION text_plan_protocol_is_current()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(current_setting('app.text_plan_protocol', true) = '2', false)
$$;

CREATE FUNCTION fence_generation_text_plan_protocol()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  immutable_key text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.text_plan_protocol = 2 AND NEW.text_plan_protocol IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'generation text plan protocol cannot be downgraded';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    FOREACH immutable_key IN ARRAY ARRAY['queuedResponsePolicy','frozenResponseContracts','textExecutionRouteBasis','textExecutionPlan'] LOOP
      IF OLD.orchestration_private ? immutable_key
         AND NEW.orchestration_private->immutable_key IS DISTINCT FROM OLD.orchestration_private->immutable_key THEN
        RAISE EXCEPTION 'generation text plan evidence % is immutable', immutable_key;
      END IF;
    END LOOP;
    IF OLD.streaming_segments_state ? 'illustrationTextExecutionSnapshot'
       AND NEW.streaming_segments_state->'illustrationTextExecutionSnapshot'
         IS DISTINCT FROM OLD.streaming_segments_state->'illustrationTextExecutionSnapshot' THEN
      RAISE EXCEPTION 'generation illustration text execution snapshot is immutable';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.text_plan_protocol = 2
     OR story_requires_text_plan_protocol(NEW.orchestration_private, NEW.streaming_segments_state) THEN
    NEW.text_plan_protocol := 2;
  END IF;
  IF NEW.text_plan_protocol = 2
     AND NOT text_plan_protocol_is_current()
     AND NEW.status = 'assessing'
     AND NEW.attempts = OLD.attempts + 1
     AND NEW.lease_owner IS NOT NULL
     AND NEW.lease_expires_at IS NOT NULL
     AND (OLD.status IN ('queued','replacement_queued')
       OR OLD.status IN ('assessing','generating','validating','committing')) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

UPDATE generation_jobs
   SET text_plan_protocol = 2
 WHERE story_requires_text_plan_protocol(orchestration_private, streaming_segments_state);

CREATE TRIGGER generation_jobs_text_plan_protocol_fence
BEFORE INSERT OR UPDATE ON generation_jobs
FOR EACH ROW EXECUTE FUNCTION fence_generation_text_plan_protocol();

CREATE FUNCTION valid_json_number(value jsonb, minimum numeric, maximum numeric, integral boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE number_value numeric;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
  number_value := (value #>> '{}')::numeric;
  RETURN number_value BETWEEN minimum AND maximum AND (NOT integral OR number_value=trunc(number_value));
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;

CREATE FUNCTION valid_provider_routing_policy(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE key text; price jsonb;
BEGIN
  IF NOT jsonb_object_has_only_keys(value,ARRAY['order','only','ignore','allow_fallbacks','require_parameters','data_collection','sort','quantizations','enforce_distillable_text','preferred_min_throughput','preferred_max_latency','max_price','zdr'])
     OR (value ? 'order' AND value ? 'sort') THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['order','only','ignore','quantizations'] LOOP
    IF value ? key AND NOT valid_bounded_string_array(value->key,64,500) THEN RETURN false; END IF;
  END LOOP;
  FOREACH key IN ARRAY ARRAY['allow_fallbacks','require_parameters','enforce_distillable_text','zdr'] LOOP
    IF value ? key AND jsonb_typeof(value->key) IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
  END LOOP;
  IF value ? 'data_collection' AND value->>'data_collection' NOT IN ('allow','deny') THEN RETURN false; END IF;
  IF value ? 'sort' AND value->>'sort' NOT IN ('price','throughput','latency') THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['preferred_min_throughput','preferred_max_latency'] LOOP
    IF value ? key AND NOT valid_json_number(value->key,0,1e100,false) THEN RETURN false; END IF;
  END LOOP;
  IF value ? 'max_price' THEN
    price := value->'max_price';
    IF NOT jsonb_object_has_only_keys(price,ARRAY['prompt','completion','image','request']) OR price='{}'::jsonb THEN RETURN false; END IF;
    FOREACH key IN ARRAY ARRAY['prompt','completion','image','request'] LOOP
      IF price ? key AND NOT valid_json_number(price->key,0,1e100,false) THEN RETURN false; END IF;
    END LOOP;
  END IF;
  RETURN true;
END;
$$;

CREATE FUNCTION valid_text_generation_parameters(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE key text;
BEGIN
  IF NOT jsonb_object_has_only_keys(value,ARRAY['temperature','top_p','top_k','frequency_penalty','presence_penalty','repetition_penalty','min_p','top_a','seed','max_tokens','max_completion_tokens']) THEN RETURN false; END IF;
  IF value ? 'temperature' AND NOT valid_json_number(value->'temperature',0,2,false) THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['top_p','min_p','top_a'] LOOP
    IF value ? key AND NOT valid_json_number(value->key,0,1,false) THEN RETURN false; END IF;
  END LOOP;
  FOREACH key IN ARRAY ARRAY['frequency_penalty','presence_penalty'] LOOP
    IF value ? key AND NOT valid_json_number(value->key,-2,2,false) THEN RETURN false; END IF;
  END LOOP;
  IF value ? 'repetition_penalty' AND NOT valid_json_number(value->'repetition_penalty',0.0000000001,1e100,false) THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['top_k','seed'] LOOP
    IF value ? key AND NOT valid_json_number(value->key,0,1e100,true) THEN RETURN false; END IF;
  END LOOP;
  FOREACH key IN ARRAY ARRAY['max_tokens','max_completion_tokens'] LOOP
    IF value ? key AND NOT valid_json_number(value->key,1,1e100,true) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE FUNCTION valid_text_execution_route_shape(document jsonb, plan boolean)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE candidate jsonb; selection jsonb; preset jsonb; required text[]; allowed text[];
BEGIN
  required := ARRAY['version','selection','preset','candidates','presetSystemPrompt','parameters','endpointReference','credentialReference','profileRevision','protocolVersion'];
  allowed := required || ARRAY['authorityRevision','requestTimeoutMs'];
  IF plan THEN
    required := required || ARRAY['prompt','promptHash','planHash'];
    allowed := allowed || ARRAY['prompt','promptHash','routeBasisHash','planHash'];
  ELSE
    required := required || ARRAY['requestTimeoutMs','routeBasisHash'];
    allowed := allowed || ARRAY['routeBasisHash'];
  END IF;
  IF NOT jsonb_object_has_only_keys(document,allowed) OR NOT jsonb_object_has_keys(document,required)
     OR document->>'version'<>'2' THEN RETURN false; END IF;
  selection := document->'selection';
  IF jsonb_typeof(selection) IS DISTINCT FROM 'object' OR selection->>'kind' NOT IN ('model','openrouter_preset') THEN RETURN false; END IF;
  IF selection->>'kind'='model' THEN
    IF NOT jsonb_object_has_only_keys(selection,ARRAY['kind','modelId']) OR NOT jsonb_object_has_keys(selection,ARRAY['kind','modelId'])
       OR jsonb_typeof(selection->'modelId')<>'string' OR char_length(selection->>'modelId')>500 THEN RETURN false; END IF;
  ELSE
    IF NOT jsonb_object_has_only_keys(selection,ARRAY['kind','slug']) OR NOT jsonb_object_has_keys(selection,ARRAY['kind','slug'])
       OR NOT valid_bounded_text(selection->'slug',1,200) OR selection->>'slug' !~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$' THEN RETURN false; END IF;
  END IF;
  preset := document->'preset';
  IF preset <> 'null'::jsonb AND (NOT jsonb_object_has_only_keys(preset,ARRAY['slug','versionId','configHash'])
     OR NOT jsonb_object_has_keys(preset,ARRAY['slug','versionId','configHash'])
     OR NOT valid_bounded_text(preset->'slug',1,200) OR NOT valid_bounded_text(preset->'versionId',1,500)
     OR NOT valid_hash_text(preset->'configHash')) THEN RETURN false; END IF;
  IF jsonb_typeof(document->'candidates') IS DISTINCT FROM 'array' OR jsonb_array_length(document->'candidates') NOT BETWEEN 1 AND 32 THEN RETURN false; END IF;
  FOR candidate IN SELECT item FROM jsonb_array_elements(document->'candidates') item LOOP
    IF NOT jsonb_object_has_only_keys(candidate,ARRAY['modelId','providerPolicy','contextWindowTokens','maxOutputTokens'])
       OR NOT jsonb_object_has_keys(candidate,ARRAY['modelId','providerPolicy','contextWindowTokens','maxOutputTokens'])
       OR NOT valid_bounded_text(candidate->'modelId',1,500) OR NOT valid_provider_routing_policy(candidate->'providerPolicy')
       OR NOT valid_positive_integer(candidate->'contextWindowTokens') OR NOT valid_positive_integer(candidate->'maxOutputTokens') THEN RETURN false; END IF;
  END LOOP;
  IF jsonb_typeof(document->'presetSystemPrompt')<>'string' OR char_length(document->>'presetSystemPrompt')>200000
     OR NOT valid_text_generation_parameters(document->'parameters') OR NOT valid_bounded_text(document->'endpointReference',1,500)
     OR (document->'credentialReference'<>'null'::jsonb AND NOT valid_bounded_text(document->'credentialReference',1,500))
     OR NOT valid_bounded_text(document->'profileRevision',1,500) OR NOT valid_bounded_text(document->'protocolVersion',1,500)
     OR (document ? 'authorityRevision' AND NOT valid_bounded_text(document->'authorityRevision',1,500))
     OR (document ? 'requestTimeoutMs' AND NOT valid_positive_integer(document->'requestTimeoutMs')) THEN RETURN false; END IF;
  IF plan THEN
    RETURN valid_bounded_text(document->'prompt',1,400000) AND valid_hash_text(document->'promptHash')
      AND document->>'promptHash'=encode(digest(convert_to(document->>'prompt','UTF8'),'sha256'),'hex')
      AND valid_hash_text(document->'planHash')
      AND document->>'planHash'=canonical_jsonb_sha256(document-'planHash')
      AND (NOT document ? 'routeBasisHash' OR valid_hash_text(document->'routeBasisHash'));
  END IF;
  RETURN valid_hash_text(document->'routeBasisHash')
    AND document->>'routeBasisHash'=canonical_jsonb_sha256(document-'routeBasisHash');
END;
$$;

CREATE FUNCTION valid_derived_text_execution_plan(route_basis jsonb, plan jsonb, operation_prompt text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE composed_prompt text; expected_plan jsonb;
BEGIN
  IF NOT valid_text_execution_route_shape(route_basis,false)
     OR NOT valid_text_execution_route_shape(plan,true) THEN RETURN false; END IF;
  composed_prompt := CASE WHEN btrim(route_basis->>'presetSystemPrompt')=''
    THEN btrim(operation_prompt)
    ELSE btrim(route_basis->>'presetSystemPrompt') || E'\n\n' || btrim(operation_prompt) END;
  expected_plan := route_basis || jsonb_build_object(
    'prompt',composed_prompt,
    'promptHash',encode(digest(convert_to(composed_prompt,'UTF8'),'sha256'),'hex')
  );
  RETURN plan-'planHash'=expected_plan;
END;
$$;

CREATE FUNCTION valid_string_record(value jsonb, value_minimum integer, value_maximum integer)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  RETURN NOT EXISTS (
    SELECT 1 FROM jsonb_each(value) entry
     WHERE char_length(entry.key) NOT BETWEEN 1 AND 200 OR NOT valid_bounded_text(entry.value,value_minimum,value_maximum));
END;
$$;

CREATE FUNCTION valid_historical_authoring_snapshot(snapshot jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE plan jsonb; operation text; base_keys text[] := ARRAY['providerProfileId','model','configurationHash','contextWindowTokens','maxOutputTokens','requestTimeoutMs','prompts','protocols'];
BEGIN
  IF jsonb_typeof(snapshot) IS DISTINCT FROM 'object'
     OR NOT valid_bounded_text(snapshot->'providerProfileId',1,200) OR NOT valid_bounded_text(snapshot->'model',1,500)
     OR NOT valid_hash_text(snapshot->'configurationHash') OR NOT valid_positive_integer(snapshot->'contextWindowTokens')
     OR NOT valid_positive_integer(snapshot->'maxOutputTokens') OR NOT valid_positive_integer(snapshot->'requestTimeoutMs')
     OR NOT valid_string_record(snapshot->'prompts',0,200000) OR NOT valid_string_record(snapshot->'protocols',1,1000) THEN RETURN false; END IF;
  IF NOT snapshot ? 'version' THEN
    RETURN jsonb_object_has_only_keys(snapshot,base_keys) AND jsonb_object_has_keys(snapshot,base_keys);
  END IF;
  IF snapshot->>'version'<>'2' OR NOT jsonb_object_has_only_keys(snapshot,base_keys || ARRAY['version','textExecutionPlans'])
     OR NOT jsonb_object_has_keys(snapshot,base_keys || ARRAY['version','textExecutionPlans'])
     OR jsonb_typeof(snapshot->'textExecutionPlans') IS DISTINCT FROM 'object' OR snapshot->'textExecutionPlans'='{}'::jsonb THEN RETURN false; END IF;
  FOR operation, plan IN SELECT * FROM jsonb_each(snapshot->'textExecutionPlans') LOOP
    IF operation NOT IN ('worldOutline','worldOutlineRepair','seedCharacter','seedCharacterRepair','standaloneCharacter','standaloneCharacterRepair','sourceExtraction','sourceExtractionRepair','sourceWorld','sourceWorldRepair','sourceSynthesis','sourceSynthesisRepair','sourceCharacter','sourceCharacterRepair')
       OR NOT valid_text_execution_route_shape(plan,true) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE FUNCTION authoring_snapshot_requires_text_plan_protocol(snapshot jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT snapshot IS NOT NULL AND NOT COALESCE(valid_historical_authoring_snapshot(snapshot),false)
$$;

CREATE FUNCTION fence_authoring_job_text_plan_protocol()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.text_plan_protocol = 2 AND NEW.text_plan_protocol IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'authoring text plan protocol cannot be downgraded';
  END IF;
  IF OLD.text_plan_protocol = 2 AND OLD.execution_snapshot IS NOT NULL
     AND NEW.execution_snapshot IS DISTINCT FROM OLD.execution_snapshot
     AND NEW.execution_snapshot IS NOT NULL THEN
    RAISE EXCEPTION 'authoring text execution snapshot is immutable';
  END IF;
  IF NEW.text_plan_protocol = 2 OR authoring_snapshot_requires_text_plan_protocol(NEW.execution_snapshot) THEN
    NEW.text_plan_protocol := 2;
  END IF;
  IF current_setting('app.blocked_text_plan_authoring_job', true) = OLD.id::text
     AND NEW.status = 'running' THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION fence_authoring_stage_text_plan_protocol()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  required_protocol smallint;
BEGIN
  SELECT text_plan_protocol INTO required_protocol FROM authoring_jobs WHERE id = OLD.job_id;
  IF required_protocol = 2
     AND NOT text_plan_protocol_is_current()
     AND NEW.status = 'running'
     AND NEW.attempt_count = OLD.attempt_count + 1
     AND NEW.lease_token IS NOT NULL
     AND NEW.lease_owner IS NOT NULL
     AND NEW.lease_expires_at IS NOT NULL THEN
    PERFORM set_config('app.blocked_text_plan_authoring_job', OLD.job_id::text, true);
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

UPDATE authoring_jobs
   SET text_plan_protocol = 2
 WHERE authoring_snapshot_requires_text_plan_protocol(execution_snapshot);

CREATE TRIGGER authoring_jobs_text_plan_protocol_fence
BEFORE UPDATE ON authoring_jobs
FOR EACH ROW EXECUTE FUNCTION fence_authoring_job_text_plan_protocol();

CREATE TRIGGER authoring_job_stages_text_plan_protocol_fence
BEFORE UPDATE ON authoring_job_stages
FOR EACH ROW EXECUTE FUNCTION fence_authoring_stage_text_plan_protocol();

CREATE FUNCTION valid_response_contract_admission_v2(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE verification jsonb;
BEGIN
  IF value->>'mode'<>'json_schema' OR value->>'basis' NOT IN ('model_verified','preset_trusted') THEN RETURN false; END IF;
  IF value->>'basis'='preset_trusted' THEN
    RETURN jsonb_object_has_only_keys(value,ARRAY['mode','basis']) AND jsonb_object_has_keys(value,ARRAY['mode','basis']);
  END IF;
  IF NOT jsonb_object_has_only_keys(value,ARRAY['mode','basis','verification'])
     OR NOT jsonb_object_has_keys(value,ARRAY['mode','basis','verification']) THEN RETURN false; END IF;
  verification := value->'verification';
  RETURN jsonb_object_has_only_keys(verification,ARRAY['version','providerType','endpointIdentity','model','routeConfigHash','adapterProtocol','operation','schemaHash','streaming','verifiedAt','expiresAt','providerRoutingSlugs','nativeOpenTrackerObjects'])
    AND jsonb_object_has_keys(verification,ARRAY['version','providerType','endpointIdentity','model','routeConfigHash','adapterProtocol','operation','schemaHash','streaming','verifiedAt','expiresAt','providerRoutingSlugs','nativeOpenTrackerObjects'])
    AND verification->>'version'='2' AND verification->>'providerType' IN ('openrouter','openai_compatible')
    AND valid_bounded_text(verification->'endpointIdentity',1,512) AND valid_bounded_text(verification->'model',1,512)
    AND valid_hash_text(verification->'routeConfigHash') AND verification->>'adapterProtocol'='text-schema-adapter-v2'
    AND verification->>'operation' IN ('story','choices','continuity_review','rpg_assessment','event_trigger_before','event_trigger_after','scene_coverage','event_coverage','world_outline','world_seed_character','standalone_character','character_organizer','source_extraction','source_synthesis','source_character','illustration_prompt_refinement')
    AND valid_hash_text(verification->'schemaHash') AND jsonb_typeof(verification->'streaming')='boolean'
    AND valid_bounded_text(verification->'verifiedAt',1,100) AND valid_bounded_text(verification->'expiresAt',1,100)
    AND valid_bounded_string_array(verification->'providerRoutingSlugs',64,500)
    AND jsonb_typeof(verification->'nativeOpenTrackerObjects')='boolean';
END;
$$;

CREATE FUNCTION valid_frozen_contract_authority_v2(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF value->>'kind'='preset_trusted' THEN
    RETURN jsonb_object_has_only_keys(value,ARRAY['kind','routeBasisHash'])
      AND jsonb_object_has_keys(value,ARRAY['kind','routeBasisHash']) AND valid_hash_text(value->'routeBasisHash');
  END IF;
  IF value->>'kind'<>'model_verified' THEN RETURN false; END IF;
  RETURN jsonb_object_has_only_keys(value,ARRAY['kind','providerProfileId','providerType','endpointIdentity','model','providerConfigurationHash','routeConfigHash','verificationRegistryHash','routeBasisHash'])
    AND jsonb_object_has_keys(value,ARRAY['kind','providerProfileId','providerType','endpointIdentity','model','providerConfigurationHash','routeConfigHash','verificationRegistryHash'])
    AND valid_uuid_text(value->'providerProfileId') AND value->>'providerType' IN ('openrouter','openai_compatible')
    AND valid_bounded_text(value->'endpointIdentity',1,512) AND valid_bounded_text(value->'model',1,512)
    AND valid_hash_text(value->'providerConfigurationHash') AND valid_hash_text(value->'routeConfigHash')
    AND valid_hash_text(value->'verificationRegistryHash') AND (NOT value ? 'routeBasisHash' OR valid_hash_text(value->'routeBasisHash'));
END;
$$;

CREATE FUNCTION valid_queued_contract_authority_v2(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE selection jsonb;
BEGIN
  IF value->>'kind'='preset_trusted' THEN
    selection := value->'selection';
    RETURN jsonb_object_has_only_keys(value,ARRAY['kind','routeBasisHash','selection','endpointReference','credentialReference','authorityRevision','profileRevision'])
      AND jsonb_object_has_keys(value,ARRAY['kind','routeBasisHash','selection','endpointReference','credentialReference','authorityRevision','profileRevision'])
      AND valid_hash_text(value->'routeBasisHash')
      AND jsonb_object_has_only_keys(selection,ARRAY['kind','slug']) AND jsonb_object_has_keys(selection,ARRAY['kind','slug'])
      AND selection->>'kind'='openrouter_preset' AND valid_bounded_text(selection->'slug',1,200)
      AND valid_bounded_text(value->'endpointReference',1,500)
      AND (value->'credentialReference'='null'::jsonb OR valid_bounded_text(value->'credentialReference',1,500))
      AND valid_bounded_text(value->'authorityRevision',1,500) AND valid_bounded_text(value->'profileRevision',1,500);
  END IF;
  IF value->>'kind'<>'model_verified' THEN RETURN false; END IF;
  RETURN jsonb_object_has_only_keys(value,ARRAY['kind','providerProfileId','providerType','endpointIdentity','model','providerConfigurationHash','routeConfigHash','verificationRegistryHash','authorityRevision','routeBasisHash'])
    AND jsonb_object_has_keys(value,ARRAY['kind','providerProfileId','providerType','endpointIdentity','model','providerConfigurationHash','routeConfigHash','verificationRegistryHash','authorityRevision'])
    AND valid_frozen_contract_authority_v2(value-'authorityRevision') AND valid_bounded_text(value->'authorityRevision',1,500);
END;
$$;

CREATE FUNCTION valid_frozen_response_contracts_v2(document jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE contract jsonb; key text; policy jsonb; verification jsonb;
BEGIN
  IF NOT jsonb_object_has_only_keys(document,ARRAY['version','queuedPolicy','selectedAt','capabilityEvidenceHash','contracts','selectionHash'])
     OR NOT jsonb_object_has_keys(document,ARRAY['version','queuedPolicy','selectedAt','capabilityEvidenceHash','contracts','selectionHash'])
     OR document->>'version'<>'2' OR NOT valid_iso_datetime_text(document->'selectedAt')
     OR NOT valid_hash_text(document->'capabilityEvidenceHash') OR NOT valid_hash_text(document->'selectionHash')
     OR document->>'selectionHash'<>canonical_jsonb_sha256(document-'selectionHash')
     OR jsonb_typeof(document->'contracts') IS DISTINCT FROM 'object' OR document->'contracts'='{}'::jsonb THEN RETURN false; END IF;
  policy := document->'queuedPolicy';
  IF NOT jsonb_object_has_only_keys(policy,ARRAY['version','policy','providerProfileId','admission','authority','operationClosureVersion','invocationKeys'])
     OR NOT jsonb_object_has_keys(policy,ARRAY['version','policy','providerProfileId','admission','authority','operationClosureVersion','invocationKeys'])
     OR policy->>'version'<>'2' OR policy->>'policy'<>'required' OR NOT valid_uuid_text(policy->'providerProfileId')
     OR policy->>'operationClosureVersion'<>'2' OR NOT valid_response_contract_admission_v2(policy->'admission')
     OR NOT valid_queued_contract_authority_v2(policy->'authority')
     OR policy->'admission'->>'basis' IS DISTINCT FROM policy->'authority'->>'kind'
     OR jsonb_typeof(policy->'invocationKeys')<>'array'
     OR jsonb_array_length(policy->'invocationKeys') NOT BETWEEN 1 AND 17 THEN RETURN false; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(policy->'invocationKeys') invocation(invocation_key)
     WHERE invocation.invocation_key NOT IN ('story:stream','story:nonstream','choices:nonstream','continuity_review:nonstream','rpg_assessment:nonstream','event_trigger_before:nonstream','event_trigger_after:nonstream','scene_coverage:nonstream','event_coverage:nonstream','world_outline:nonstream','world_seed_character:nonstream','standalone_character:nonstream','character_organizer:nonstream','source_extraction:nonstream','source_synthesis:nonstream','source_character:nonstream','illustration_prompt_refinement:nonstream')
  ) OR (SELECT count(*)<>count(DISTINCT invocation.invocation_key) FROM jsonb_array_elements_text(policy->'invocationKeys') invocation(invocation_key)) THEN RETURN false; END IF;
  IF policy->'authority'->>'kind'='model_verified' THEN
    verification := policy->'admission'->'verification';
    IF policy->>'providerProfileId' IS DISTINCT FROM policy->'authority'->>'providerProfileId'
       OR verification->>'providerType' IS DISTINCT FROM policy->'authority'->>'providerType'
       OR verification->>'endpointIdentity' IS DISTINCT FROM policy->'authority'->>'endpointIdentity'
       OR verification->>'model' IS DISTINCT FROM policy->'authority'->>'model'
       OR verification->>'routeConfigHash' IS DISTINCT FROM policy->'authority'->>'routeConfigHash'
       OR NOT (policy->'invocationKeys') ? (verification->>'operation' || ':' || CASE WHEN verification->>'streaming'='true' THEN 'stream' ELSE 'nonstream' END)
       THEN RETURN false; END IF;
  END IF;
  FOR key, contract IN SELECT * FROM jsonb_each(document->'contracts') LOOP
    IF NOT (policy->'invocationKeys') ? key
       OR NOT jsonb_object_has_only_keys(contract,ARRAY['version','mode','admission','operation','streaming','forbidFormatFallback','schemaVersion','schemaHash','schemaName','schema','authority'])
       OR NOT jsonb_object_has_keys(contract,ARRAY['version','mode','admission','operation','streaming','forbidFormatFallback','schemaVersion','schemaHash','schemaName','schema','authority'])
       OR contract->>'version'<>'2' OR contract->>'mode'<>'json_schema' OR contract->>'forbidFormatFallback'<>'true'
       OR NOT valid_response_contract_admission_v2(contract->'admission') OR NOT valid_frozen_contract_authority_v2(contract->'authority')
       OR contract->'admission'->>'basis' IS DISTINCT FROM contract->'authority'->>'kind'
       OR contract->'admission'->>'basis' IS DISTINCT FROM policy->'admission'->>'basis'
       OR contract->'authority'->>'kind' IS DISTINCT FROM policy->'authority'->>'kind'
       OR NOT valid_bounded_text(contract->'operation',1,100) OR jsonb_typeof(contract->'streaming')<>'boolean'
       OR NOT valid_bounded_text(contract->'schemaVersion',1,200) OR NOT valid_hash_text(contract->'schemaHash')
       OR contract->>'schemaHash'<>canonical_jsonb_sha256(contract->'schema')
       OR NOT valid_bounded_text(contract->'schemaName',1,200) OR jsonb_typeof(contract->'schema')<>'object'
       OR contract->>'operation' IS DISTINCT FROM split_part(key,':',1)
       OR contract->'streaming' IS DISTINCT FROM to_jsonb(split_part(key,':',2)='stream') THEN RETURN false; END IF;
    IF policy->'authority'->>'kind'='model_verified' THEN
      IF contract->'authority' IS DISTINCT FROM ((policy->'authority') - 'authorityRevision'::text) THEN RETURN false; END IF;
      IF policy->'admission'->'verification'->>'operation'=contract->>'operation'
         AND policy->'admission'->'verification'->>'streaming'=contract->>'streaming'
         AND policy->'admission'->'verification'->>'schemaHash' IS DISTINCT FROM contract->>'schemaHash'
         THEN RETURN false; END IF;
    ELSIF contract->'authority' IS DISTINCT FROM jsonb_build_object(
      'kind','preset_trusted','routeBasisHash',policy->'authority'->'routeBasisHash'
    ) THEN RETURN false; END IF;
  END LOOP;
  RETURN NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(policy->'invocationKeys') queued WHERE NOT (document->'contracts') ? queued);
END;
$$;

CREATE FUNCTION valid_historical_illustration_snapshot(snapshot jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF jsonb_typeof(snapshot) IS DISTINCT FROM 'object' OR snapshot->>'version'<>'2'
     OR snapshot->>'state' NOT IN ('prepared','unavailable') THEN RETURN false; END IF;
  IF snapshot->>'state'='unavailable' THEN
    RETURN jsonb_object_has_only_keys(snapshot,ARRAY['version','state','errorCode'])
      AND jsonb_object_has_keys(snapshot,ARRAY['version','state','errorCode'])
      AND snapshot->>'errorCode'='illustration_text_route_unavailable';
  END IF;
  RETURN jsonb_object_has_only_keys(snapshot,ARRAY['version','state','ownerUserId','operationPrompt','routeBasis','plan'])
    AND jsonb_object_has_keys(snapshot,ARRAY['version','state','ownerUserId','operationPrompt','routeBasis','plan'])
    AND valid_bounded_text(snapshot->'ownerUserId',1,200) AND valid_bounded_text(snapshot->'operationPrompt',1,200000)
    AND valid_derived_text_execution_plan(snapshot->'routeBasis',snapshot->'plan',snapshot->>'operationPrompt');
END;
$$;

CREATE FUNCTION illustration_snapshot_requires_text_plan_protocol(snapshot jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT snapshot IS NOT NULL AND NOT COALESCE(valid_historical_illustration_snapshot(snapshot),false)
$$;

CREATE FUNCTION valid_streaming_illustration_text_snapshot(snapshot jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE request_config jsonb;
BEGIN
  IF valid_historical_illustration_snapshot(snapshot) THEN RETURN true; END IF;
  IF jsonb_typeof(snapshot) IS DISTINCT FROM 'object' OR snapshot->>'version'<>'3'
     OR snapshot->>'state' NOT IN ('prepared','unavailable') THEN RETURN false; END IF;
  IF snapshot->>'state'='unavailable' THEN
    RETURN jsonb_object_has_only_keys(snapshot,ARRAY['version','state','errorCode'])
      AND jsonb_object_has_keys(snapshot,ARRAY['version','state','errorCode'])
      AND snapshot->>'errorCode'='illustration_text_route_unavailable';
  END IF;
  IF NOT jsonb_object_has_only_keys(snapshot,ARRAY['version','state','ownerUserId','operationPrompt','providerType','requestConfiguration','routeBasis','plan','frozenResponseContracts','trustedOperationPrompt'])
     OR NOT jsonb_object_has_keys(snapshot,ARRAY['version','state','ownerUserId','operationPrompt','providerType','requestConfiguration','routeBasis','plan','frozenResponseContracts','trustedOperationPrompt'])
     OR NOT valid_bounded_text(snapshot->'ownerUserId',1,200) OR NOT valid_bounded_text(snapshot->'operationPrompt',1,200000)
     OR snapshot->>'providerType' NOT IN ('openrouter','openai_compatible')
     OR NOT valid_bounded_text(snapshot->'trustedOperationPrompt',1,200000)
     OR snapshot->>'trustedOperationPrompt' IS DISTINCT FROM snapshot->>'operationPrompt'
     OR NOT valid_derived_text_execution_plan(snapshot->'routeBasis',snapshot->'plan',snapshot->>'operationPrompt')
     OR NOT valid_frozen_response_contracts_v2(snapshot->'frozenResponseContracts') THEN RETURN false; END IF;
  request_config := snapshot->'requestConfiguration';
  RETURN jsonb_object_has_only_keys(request_config,ARRAY['httpReferer'])
    AND (NOT request_config ? 'httpReferer' OR valid_bounded_text(request_config->'httpReferer',1,2000));
END;
$$;

CREATE FUNCTION fence_illustration_prompt_text_plan_protocol()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_snapshot jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.text_plan_protocol = 2 AND NEW.text_plan_protocol IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'illustration text plan protocol cannot be downgraded';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.text_execution_snapshot IS NOT NULL
     AND NEW.text_execution_snapshot IS DISTINCT FROM OLD.text_execution_snapshot THEN
    RAISE EXCEPTION 'illustration text execution snapshot is immutable';
  END IF;
  IF NEW.generation_job_id IS NOT NULL THEN
    SELECT streaming_segments_state->'illustrationTextExecutionSnapshot'
      INTO parent_snapshot
      FROM generation_jobs
     WHERE id = NEW.generation_job_id
       AND streaming_segments_state ? 'illustrationTextExecutionSnapshot';
    IF FOUND THEN
      IF NOT valid_streaming_illustration_text_snapshot(parent_snapshot) THEN
        RAISE EXCEPTION 'generation illustration text execution snapshot is invalid';
      END IF;
      IF NEW.text_execution_snapshot IS DISTINCT FROM parent_snapshot THEN
        RAISE EXCEPTION 'illustration child must copy the generation text execution snapshot';
      END IF;
    END IF;
  END IF;
  IF NEW.text_plan_protocol = 2 OR illustration_snapshot_requires_text_plan_protocol(NEW.text_execution_snapshot) THEN
    NEW.text_plan_protocol := 2;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.text_plan_protocol = 2
     AND NOT text_plan_protocol_is_current()
     AND NEW.status = 'refining'
     AND NEW.attempts = OLD.attempts + 1
     AND NEW.lease_owner IS NOT NULL
     AND NEW.lease_expires_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

UPDATE illustration_prompt_jobs
   SET text_plan_protocol = 2
 WHERE illustration_snapshot_requires_text_plan_protocol(text_execution_snapshot);

CREATE TRIGGER illustration_prompt_jobs_text_plan_protocol_fence
BEFORE INSERT OR UPDATE ON illustration_prompt_jobs
FOR EACH ROW EXECUTE FUNCTION fence_illustration_prompt_text_plan_protocol();
