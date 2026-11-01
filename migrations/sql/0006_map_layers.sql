ALTER TABLE import_records ADD COLUMN geometry geometry(Geometry,4326);
DROP TRIGGER import_record_immutable ON import_records;
UPDATE import_records
SET geometry=ST_SetSRID(ST_GeomFromGeoJSON(payload->'geometry'),4326)
WHERE payload->'geometry' IS NOT NULL AND payload->'geometry' <> 'null'::jsonb;
CREATE TRIGGER import_record_immutable BEFORE UPDATE OR DELETE ON import_records
FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
ALTER TABLE import_records ADD CONSTRAINT import_geometry_valid
CHECK (geometry IS NULL OR ST_IsValid(geometry));
CREATE INDEX import_record_geometry_gist ON import_records USING gist(geometry);

CREATE TABLE map_layers (
 id uuid PRIMARY KEY,
 city_id uuid NOT NULL REFERENCES cities(id),
 dataset_id uuid NOT NULL REFERENCES datasets(id),
 dataset_version_id uuid NOT NULL REFERENCES dataset_versions(id),
 geometry_type varchar NOT NULL CHECK (geometry_type IN ('point','line','polygon')),
 payload jsonb NOT NULL,
 UNIQUE(dataset_version_id,geometry_type)
);
CREATE INDEX map_layer_city ON map_layers(city_id);
CREATE INDEX map_layer_dataset ON map_layers(dataset_id);
CREATE INDEX map_layer_version ON map_layers(dataset_version_id);
CREATE TRIGGER map_layer_immutable BEFORE UPDATE OR DELETE ON map_layers
FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
