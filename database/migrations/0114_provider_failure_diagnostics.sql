-- Optional operational evidence; old attempts remain null and retain their keys.
ALTER TABLE prepared_text_physical_attempts
  ADD COLUMN failure_diagnostic jsonb,
  ADD CONSTRAINT prepared_text_physical_attempts_failure_diagnostic_check CHECK (
    failure_diagnostic IS NULL OR (
      jsonb_typeof(failure_diagnostic) = 'object'
      AND (failure_diagnostic->'version' = '1'::jsonb) IS TRUE
      AND octet_length(failure_diagnostic::text) <= 4096
    )
  );

COMMENT ON COLUMN prepared_text_physical_attempts.failure_diagnostic IS
  'Bounded versioned provider failure evidence; operational, never portable campaign authority.';
