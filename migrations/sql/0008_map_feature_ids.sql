CREATE UNIQUE INDEX import_record_feature_id
ON import_records (((md5('pavlodar:map-feature:' || version_id::text || ':' || row_index::text))::uuid));
