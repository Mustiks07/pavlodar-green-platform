CREATE TABLE coefficient_identities (
 id uuid PRIMARY KEY
);

CREATE TABLE coefficient_versions (
 id uuid PRIMARY KEY,
 coefficient_id uuid NOT NULL REFERENCES coefficient_identities(id),
 city_id uuid NOT NULL REFERENCES cities(id),
 dataset_id uuid NOT NULL REFERENCES datasets(id),
 dataset_version_id uuid NOT NULL REFERENCES dataset_versions(id),
 actor_id uuid NOT NULL REFERENCES principals(id),
 created_at timestamptz NOT NULL,
 payload jsonb NOT NULL
);
CREATE INDEX coefficient_version_identity ON coefficient_versions(coefficient_id,id);
CREATE INDEX coefficient_version_city ON coefficient_versions(city_id,id);
CREATE INDEX coefficient_version_dataset ON coefficient_versions(dataset_id,id);

CREATE TRIGGER coefficient_identity_immutable BEFORE UPDATE OR DELETE ON coefficient_identities
FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
CREATE TRIGGER coefficient_version_immutable BEFORE UPDATE OR DELETE ON coefficient_versions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
