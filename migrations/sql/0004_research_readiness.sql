-- This backfill is limited to versions with immutable ResearchQuality lineage.
-- It restores already persisted facts; it does not publish or approve the source.
UPDATE dataset_versions AS version
SET payload = version.payload || jsonb_build_object(
  'readiness_state', 'research_unverified',
  'content_kind', CASE quality.request_id
    WHEN 'DR-01' THEN 'vector'
    WHEN 'DR-02' THEN 'table'
    WHEN 'DR-03' THEN 'legal_text'
    WHEN 'DR-04' THEN 'table'
    WHEN 'DR-05' THEN 'table'
    WHEN 'DR-06' THEN 'mixed'
    WHEN 'DR-07' THEN 'table'
  END,
  'record_count', (quality.payload->>'record_count')::integer,
  'checked_at', '2026-10-29',
  'observed_from', NULL,
  'observed_to', NULL,
  'applicability', CASE quality.request_id
    WHEN 'DR-01' THEN 'Рабочая граница OSM; не официальная граница организатора'
    WHEN 'DR-02' THEN 'Исследовательские кандидаты и предложения; требуется локальная экспертиза'
    WHEN 'DR-03' THEN 'Тексты и пробелы норм; не автоматический правовой вывод'
    WHEN 'DR-04' THEN 'Набор не содержит наблюдаемых когорт для локальной survival-калибровки'
    WHEN 'DR-05' THEN 'Неполные котировки; не итоговая смета и не подтверждённый прайс'
    WHEN 'DR-06' THEN '110 зданий, одна ячейка ERA5 и каталог Sentinel; не полный городской растр'
    WHEN 'DR-07' THEN 'Источники и решения владельца ещё не подтверждены'
  END,
  'data_request_id', quality.request_id,
  'review_reasons', jsonb_build_array(jsonb_build_object(
    'code', 'research_not_approved',
    'message', 'Исследовательский источник не принят владельцем и профильным экспертом',
    'required_inputs', jsonb_build_array(quality.request_id),
    'blocking', true
  ))
)
FROM research_quality AS quality
WHERE quality.version_id = version.id
  AND quality.request_id IN ('DR-01','DR-02','DR-03','DR-04','DR-05','DR-06','DR-07');
