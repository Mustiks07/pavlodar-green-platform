CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE address_entries (
 id uuid PRIMARY KEY,
 city_id uuid NOT NULL REFERENCES cities(id),
 dataset_id uuid NOT NULL REFERENCES datasets(id),
 dataset_version_id uuid NOT NULL REFERENCES dataset_versions(id),
 row_index integer NOT NULL CHECK (row_index>=0),
 source_record_id varchar,
 label varchar NOT NULL CHECK (length(trim(label))>0),
 search_text varchar NOT NULL CHECK (length(trim(search_text))>0),
 confidence varchar NOT NULL CHECK (confidence IN ('high','medium','low')),
 position geometry(Point,4326) NOT NULL,
 UNIQUE(dataset_version_id,row_index)
);
CREATE INDEX address_entry_city ON address_entries(city_id);
CREATE INDEX address_entry_dataset ON address_entries(dataset_id);
CREATE INDEX address_entry_version ON address_entries(dataset_version_id);
CREATE INDEX address_entry_position ON address_entries USING gist(position);
CREATE INDEX address_entry_search_trgm ON address_entries USING gin(search_text gin_trgm_ops);
CREATE TRIGGER address_entry_immutable BEFORE UPDATE OR DELETE ON address_entries
FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();

CREATE FUNCTION index_address_version(p_version_id uuid) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE inserted integer;
BEGIN
  INSERT INTO address_entries(
    id,city_id,dataset_id,dataset_version_id,row_index,source_record_id,
    label,search_text,confidence,position
  )
  SELECT
    md5('pavlodar:address:' || ir.version_id::text || ':' || ir.row_index::text)::uuid,
    d.city_id,d.id,ir.version_id,ir.row_index,ir.payload->>'source_record_id',
    labels.label,
    regexp_replace(replace(lower(labels.label),'ё','е'),'\s+',' ','g'),
    CASE
      WHEN labels.full_address IS NOT NULL THEN 'high'
      WHEN labels.house_number IS NOT NULL THEN 'medium'
      ELSE 'low'
    END,
    ST_PointOnSurface(ir.geometry)::geometry(Point,4326)
  FROM import_records ir
  JOIN dataset_versions dv ON dv.id=ir.version_id
  JOIN datasets d ON d.id=dv.dataset_id
  JOIN cities c ON c.id=d.city_id
  CROSS JOIN LATERAL (
    SELECT
      NULLIF(trim(COALESCE(
        ir.payload->'properties'->>'full_address',
        ir.payload->'properties'->>'address',
        ir.payload->'properties'->>'addr:full'
      )), '') AS full_address,
      NULLIF(trim(COALESCE(
        ir.payload->'properties'->>'addr:street',
        ir.payload->'properties'->>'street',
        ir.payload->'properties'->>'street_name'
      )), '') AS street,
      NULLIF(trim(COALESCE(
        ir.payload->'properties'->>'addr:housenumber',
        ir.payload->'properties'->>'house_number',
        ir.payload->'properties'->>'building_number'
      )), '') AS house_number
  ) parts
  CROSS JOIN LATERAL (
    SELECT
      parts.full_address,
      parts.house_number,
      COALESCE(
        parts.full_address,
        CASE WHEN parts.street IS NOT NULL
          THEN concat_ws(', ',parts.street,parts.house_number)
        END
      ) AS label
  ) labels
  WHERE ir.version_id=p_version_id
    AND dv.status='published'
    AND ir.geometry IS NOT NULL
    AND labels.label IS NOT NULL
    AND ST_Covers(
      ST_SetSRID(ST_GeomFromGeoJSON(c.payload->'boundary'),4326),
      ST_PointOnSurface(ir.geometry)
    )
  ON CONFLICT(dataset_version_id,row_index) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted;
END $$;

SELECT index_address_version(id)
FROM dataset_versions
WHERE status='published';
