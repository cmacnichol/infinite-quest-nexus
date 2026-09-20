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
    IF NOT COALESCE(
      jsonb_typeof(orchestration->'queuedResponsePolicy') = 'object'
      AND orchestration->'queuedResponsePolicy'->>'version' = '1'
      AND jsonb_typeof(orchestration->'queuedResponsePolicy'->'policy') = 'string'
      AND jsonb_typeof(orchestration->'queuedResponsePolicy'->'providerProfileId') = 'string'
      AND jsonb_typeof(orchestration->'queuedResponsePolicy'->'model') = 'string'
      AND jsonb_typeof(orchestration->'queuedResponsePolicy'->'endpointIdentity') = 'string'
      AND jsonb_typeof(orchestration->'queuedResponsePolicy'->'providerConfigurationHash') = 'string'
      AND jsonb_typeof(orchestration->'queuedResponsePolicy'->'verificationRegistryHash') = 'string'
      AND jsonb_typeof(orchestration->'queuedResponsePolicy'->'invocationKeys') = 'array',
      false
    ) THEN RETURN true; END IF;
  END IF;
  IF orchestration ? 'frozenResponseContracts' THEN
    IF NOT COALESCE(
      jsonb_typeof(orchestration->'frozenResponseContracts') = 'object'
      AND orchestration->'frozenResponseContracts'->>'version' = '1'
      AND jsonb_typeof(orchestration->'frozenResponseContracts'->'queuedPolicy') = 'object'
      AND jsonb_typeof(orchestration->'frozenResponseContracts'->'contracts') = 'object'
      AND jsonb_typeof(orchestration->'frozenResponseContracts'->'selectionHash') = 'string',
      false
    ) THEN RETURN true; END IF;
  END IF;
  IF orchestration ? 'responseContractInvocations' THEN
    IF jsonb_typeof(orchestration->'responseContractInvocations') IS DISTINCT FROM 'array' THEN
      RETURN true;
    END IF;
    FOR invocation IN SELECT value FROM jsonb_array_elements(orchestration->'responseContractInvocations') LOOP
      IF NOT COALESCE(
        jsonb_typeof(invocation) = 'object'
        AND invocation->>'version' = '1'
        AND jsonb_typeof(invocation->'id') = 'string'
        AND jsonb_typeof(invocation->'logicalAttemptId') = 'string'
        AND jsonb_typeof(invocation->'invocationKey') = 'string'
        AND jsonb_typeof(invocation->'operation') = 'string'
        AND jsonb_typeof(invocation->'requestPayloadHash') = 'string'
        AND jsonb_typeof(invocation->'request') = 'object'
        AND jsonb_typeof(invocation->'status') = 'string',
        false
      ) THEN
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

CREATE FUNCTION authoring_snapshot_requires_text_plan_protocol(snapshot jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT snapshot IS NOT NULL AND NOT COALESCE(
    jsonb_typeof(snapshot) = 'object'
    AND jsonb_typeof(snapshot->'providerProfileId') = 'string'
    AND jsonb_typeof(snapshot->'model') = 'string'
    AND jsonb_typeof(snapshot->'configurationHash') = 'string'
    AND jsonb_typeof(snapshot->'contextWindowTokens') = 'number'
    AND jsonb_typeof(snapshot->'maxOutputTokens') = 'number'
    AND jsonb_typeof(snapshot->'requestTimeoutMs') = 'number'
    AND jsonb_typeof(snapshot->'prompts') = 'object'
    AND jsonb_typeof(snapshot->'protocols') = 'object'
    AND (
      (NOT snapshot ? 'version')
      OR (snapshot->>'version' = '2'
        AND jsonb_typeof(snapshot->'textExecutionPlans') = 'object'
        AND snapshot->'textExecutionPlans' <> '{}'::jsonb)
    ),
    false
  )
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

CREATE FUNCTION illustration_snapshot_requires_text_plan_protocol(snapshot jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT snapshot IS NOT NULL AND NOT COALESCE(
    jsonb_typeof(snapshot) = 'object'
    AND snapshot->>'version' = '2'
    AND snapshot->>'state' IN ('prepared','unavailable')
    AND (
      (snapshot->>'state' = 'unavailable'
        AND snapshot->>'errorCode' = 'illustration_text_route_unavailable')
      OR (snapshot->>'state' = 'prepared'
        AND jsonb_typeof(snapshot->'ownerUserId') = 'string'
        AND jsonb_typeof(snapshot->'operationPrompt') = 'string'
        AND jsonb_typeof(snapshot->'routeBasis') = 'object'
        AND snapshot->'routeBasis'->>'version' = '2'
        AND jsonb_typeof(snapshot->'plan') = 'object'
        AND snapshot->'plan'->>'version' = '2')
    ),
    false
  )
$$;

CREATE FUNCTION valid_streaming_illustration_text_snapshot(snapshot jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(CASE
    WHEN jsonb_typeof(snapshot) IS DISTINCT FROM 'object' THEN false
    WHEN snapshot->>'version' = '2' AND snapshot->>'state' = 'unavailable' THEN
      snapshot->>'errorCode' = 'illustration_text_route_unavailable'
    WHEN snapshot->>'version' = '2' AND snapshot->>'state' = 'prepared' THEN
      jsonb_typeof(snapshot->'ownerUserId') = 'string'
      AND jsonb_typeof(snapshot->'operationPrompt') = 'string'
      AND jsonb_typeof(snapshot->'routeBasis') = 'object'
      AND snapshot->'routeBasis'->>'version' = '2'
      AND jsonb_typeof(snapshot->'plan') = 'object'
      AND snapshot->'plan'->>'version' = '2'
    WHEN snapshot->>'version' = '3' AND snapshot->>'state' = 'unavailable' THEN
      snapshot->>'errorCode' = 'illustration_text_route_unavailable'
    WHEN snapshot->>'version' = '3' AND snapshot->>'state' = 'prepared' THEN
      jsonb_typeof(snapshot->'routeBasis') = 'object'
      AND snapshot->'routeBasis'->>'version' = '2'
      AND jsonb_typeof(snapshot->'plan') = 'object'
      AND snapshot->'plan'->>'version' = '2'
      AND jsonb_typeof(snapshot->'frozenResponseContracts') = 'object'
      AND snapshot->'frozenResponseContracts'->>'version' = '2'
      AND jsonb_typeof(snapshot->'trustedOperationPrompt') = 'string'
    ELSE false
  END, false)
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
