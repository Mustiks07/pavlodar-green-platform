CREATE TABLE survival_model_versions (
 id uuid PRIMARY KEY,
 city_id uuid NOT NULL REFERENCES cities(id),
 dataset_id uuid NOT NULL REFERENCES datasets(id),
 dataset_version_id uuid NOT NULL REFERENCES dataset_versions(id),
 payload jsonb NOT NULL
);
CREATE INDEX survival_model_city ON survival_model_versions(city_id,id);
CREATE INDEX survival_model_dataset ON survival_model_versions(dataset_id,id);
CREATE INDEX survival_model_dataset_version ON survival_model_versions(dataset_version_id,id);

CREATE TRIGGER survival_model_version_immutable BEFORE UPDATE OR DELETE ON survival_model_versions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
