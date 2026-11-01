CREATE TABLE map_archive_artifacts (
 id uuid PRIMARY KEY,
 map_layer_id uuid NOT NULL UNIQUE REFERENCES map_layers(id),
 dataset_version_id uuid NOT NULL REFERENCES dataset_versions(id),
 storage_key varchar NOT NULL UNIQUE,
 sha256 varchar(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
 byte_size bigint NOT NULL CHECK (byte_size > 0),
 tile_count integer NOT NULL CHECK (tile_count > 0),
 candidate_tile_count integer NOT NULL CHECK (candidate_tile_count >= tile_count),
 min_zoom integer NOT NULL CHECK (min_zoom BETWEEN 0 AND 22),
 max_zoom integer NOT NULL CHECK (max_zoom BETWEEN min_zoom AND 22),
 created_at timestamptz NOT NULL
);
CREATE INDEX map_archive_version_idx ON map_archive_artifacts(dataset_version_id);
CREATE TRIGGER map_archive_artifact_immutable
BEFORE UPDATE OR DELETE ON map_archive_artifacts
FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
