-- Existing immutable source identities remain unchanged. This only expands their read payload
-- with explicit unknowns; it does not claim new measurements, completeness or acceptance.
UPDATE dataset_versions
SET payload = payload || jsonb_build_object(
  'readiness_state', CASE
    WHEN status = 'published' THEN 'available'
    WHEN status = 'needs_review' THEN 'research_unverified'
    WHEN status = 'rejected' THEN 'load_failed'
    ELSE 'stale'
  END,
  'content_kind', 'mixed',
  'record_count', NULL,
  'checked_at', NULL,
  'observed_from', NULL,
  'observed_to', NULL,
  'applicability', 'Migrated legacy version; content type and applicability require review',
  'data_request_id', NULL,
  'review_reasons', jsonb_build_array(jsonb_build_object(
    'code', 'LEGACY_SOURCE_REVIEW_REQUIRED',
    'message', 'Версия создана до контракта 1.1; применимость требует проверки',
    'required_inputs', jsonb_build_array(),
    'blocking', true
  ))
)
WHERE NOT (payload ? 'readiness_state');
