-- Completed physical attempts used to be joined to live jobs at read time, so
-- charged rejected responses vanished when their parent was cleaned up. Keep
-- campaign-owned charges in the existing append-only cost-event authority.
-- Existing amount precision is widened without changing its nonnegative rule.
ALTER TABLE provider_cost_events
  ALTER COLUMN amount TYPE numeric;

-- Backfill only attempts whose live parent still proves owner, campaign, and
-- provider attribution. Historical orphaned attempts have no safe campaign
-- authority and intentionally remain physical-attempt evidence only.
INSERT INTO provider_cost_events (
  owner_user_id,campaign_id,turn_id,provider_profile_id,generation_job_id,local_call_id,
  provider_type,provider_response_id,category,operation,requested_model,resolved_model,amount,currency,usage_metadata,occurred_at
)
SELECT attempt.owner_user_id,job.campaign_id,job.result_turn_id,job.provider_profile_id,job.id,attempt.id,
       profile.provider_type,attempt.provider_response_id,'story',invocation->>'operation',attempt.requested_model,
       coalesce(attempt.returned_model,attempt.requested_model),(attempt.reported_cost->>'amount')::numeric,
       attempt.reported_cost->>'currency',coalesce(attempt.usage,'{}'::jsonb),attempt.completed_at
  FROM prepared_text_physical_attempts attempt
  JOIN generation_jobs job ON job.id::text=attempt.logical_reservation->>'generationJobId'
    AND job.owner_user_id=attempt.owner_user_id
  JOIN provider_profiles profile ON profile.id=job.provider_profile_id AND profile.owner_user_id=job.owner_user_id
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(job.orchestration_private->'responseContractInvocations','[]'::jsonb)) invocation
 WHERE attempt.logical_kind='story' AND attempt.status='completed'
   AND invocation->>'id'=attempt.logical_reservation->>'invocationId'
   AND attempt.reported_cost->>'amount' ~ '^\d+(\.\d+)?$'
   AND attempt.reported_cost->>'currency' ~ '^[A-Z]{3}$'
ON CONFLICT DO NOTHING;

INSERT INTO provider_cost_events (
  owner_user_id,campaign_id,turn_id,provider_profile_id,local_call_id,
  provider_type,provider_response_id,category,operation,requested_model,resolved_model,amount,currency,usage_metadata,occurred_at
)
SELECT attempt.owner_user_id,job.campaign_id,job.turn_id,job.provider_profile_id,attempt.id,
       profile.provider_type,attempt.provider_response_id,'image','illustration_prompt_refinement',attempt.requested_model,
       coalesce(attempt.returned_model,attempt.requested_model),(attempt.reported_cost->>'amount')::numeric,
       attempt.reported_cost->>'currency',coalesce(attempt.usage,'{}'::jsonb),attempt.completed_at
  FROM prepared_text_physical_attempts attempt
  JOIN illustration_prompt_jobs job ON job.id::text=attempt.logical_reservation->>'promptJobId'
    AND job.owner_user_id=attempt.owner_user_id
  JOIN provider_profiles profile ON profile.id=job.provider_profile_id AND profile.owner_user_id=job.owner_user_id
 WHERE attempt.logical_kind='illustration' AND attempt.status='completed'
   AND attempt.reported_cost->>'amount' ~ '^\d+(\.\d+)?$'
   AND attempt.reported_cost->>'currency' ~ '^[A-Z]{3}$'
ON CONFLICT DO NOTHING;
