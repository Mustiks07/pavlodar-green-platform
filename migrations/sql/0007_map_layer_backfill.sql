WITH families AS (
 SELECT DISTINCT
  d.id AS dataset_id,
  d.city_id,
  d.current_version_id AS version_id,
  d.access_level,
  d.payload AS dataset_payload,
  v.payload AS version_payload,
  CASE
   WHEN GeometryType(ir.geometry) IN ('POINT','MULTIPOINT') THEN 'point'
   WHEN GeometryType(ir.geometry) IN ('LINESTRING','MULTILINESTRING') THEN 'line'
   WHEN GeometryType(ir.geometry) IN ('POLYGON','MULTIPOLYGON') THEN 'polygon'
  END AS family
 FROM datasets d
 JOIN dataset_versions v ON v.id=d.current_version_id AND v.status='published'
 JOIN import_records ir ON ir.version_id=v.id AND ir.geometry IS NOT NULL
), prepared AS (
 SELECT
  (md5('pavlodar:map-layer:'||version_id::text||':'||family))::uuid AS layer_id,
  *,
  count(*) OVER (PARTITION BY version_id) AS family_count
 FROM families
 WHERE family IS NOT NULL
), manifests AS (
 SELECT
  layer_id,
  city_id,
  dataset_id,
  version_id,
  family,
  jsonb_build_object(
   'id',layer_id::text,
   'city_id',city_id::text,
   'name',dataset_payload->>'name'||CASE WHEN family_count>1 THEN ' — '||CASE family WHEN 'point' THEN 'точки' WHEN 'line' THEN 'линии' ELSE 'полигоны' END ELSE '' END,
   'kind',dataset_payload->>'kind',
   'source_type','mvt',
   'source_url','/v1/map/tiles/'||layer_id::text||'/{z}/{x}/{y}.mvt',
   'dataset_version_id',version_id::text,
   'min_zoom',5,
   'max_zoom',22,
   'attribution',(dataset_payload->>'owner')||' · '||(dataset_payload->>'license'),
   'access_level',access_level,
   'observed_at',version_payload->'observed_at',
   'category',CASE dataset_payload->>'kind'
     WHEN 'boundary' THEN 'boundary' WHEN 'zones' THEN 'zone' WHEN 'soil' THEN 'soil'
     WHEN 'green_inventory' THEN 'existing_green' WHEN 'buildings' THEN 'building'
     WHEN 'roads' THEN 'road' WHEN 'water' THEN 'water' WHEN 'population' THEN 'population'
     WHEN 'social_poi' THEN 'social_facility' WHEN 'restrictions' THEN 'restriction'
     ELSE 'data_quality' END,
   'source_layer','features',
   'geometry_type',family,
   'is_stale',false,
   'legend',jsonb_build_object(
     'mode','single','property',NULL,'unit',NULL,
     'period',CASE
       WHEN version_payload->>'observed_from' IS NOT NULL OR version_payload->>'observed_to' IS NOT NULL
       THEN jsonb_build_object('from',version_payload->'observed_from','to',version_payload->'observed_to')
       ELSE NULL END,
     'classes',jsonb_build_array(jsonb_build_object(
       'key','feature','label','Объекты опубликованного набора','min',NULL,'max',NULL,
       'value',NULL,'semantic','neutral')),
     'unknown_class_key',NULL)
  ) AS payload
 FROM prepared
)
INSERT INTO map_layers(id,city_id,dataset_id,dataset_version_id,geometry_type,payload)
SELECT layer_id,city_id,dataset_id,version_id,family,payload FROM manifests
ON CONFLICT(dataset_version_id,geometry_type) DO NOTHING;
