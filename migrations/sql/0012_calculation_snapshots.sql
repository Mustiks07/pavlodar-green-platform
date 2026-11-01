CREATE TABLE rate_identities (
 id uuid PRIMARY KEY
);

CREATE TABLE rate_versions (
 id uuid PRIMARY KEY,
 rate_id uuid NOT NULL REFERENCES rate_identities(id),
 city_id uuid NOT NULL REFERENCES cities(id),
 dataset_id uuid NOT NULL REFERENCES datasets(id),
 dataset_version_id uuid NOT NULL REFERENCES dataset_versions(id),
 actor_id uuid NOT NULL REFERENCES principals(id),
 created_at timestamptz NOT NULL,
 payload jsonb NOT NULL
);
CREATE INDEX rate_version_identity ON rate_versions(rate_id,id);
CREATE INDEX rate_version_city ON rate_versions(city_id,id);
CREATE INDEX rate_version_dataset ON rate_versions(dataset_id);

CREATE TABLE calculation_snapshots (
 id uuid PRIMARY KEY,
 scenario_revision_id uuid NOT NULL REFERENCES scenario_revisions(id),
 actor_id uuid NOT NULL REFERENCES principals(id),
 input_hash varchar(64) NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL,
 payload jsonb NOT NULL,
 manifest jsonb NOT NULL
);
CREATE INDEX calculation_snapshot_revision ON calculation_snapshots(scenario_revision_id,id);
CREATE INDEX calculation_snapshot_input_hash ON calculation_snapshots(input_hash);

CREATE TRIGGER rate_identity_immutable BEFORE UPDATE OR DELETE ON rate_identities
FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
CREATE TRIGGER rate_version_immutable BEFORE UPDATE OR DELETE ON rate_versions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
CREATE TRIGGER calculation_snapshot_immutable BEFORE UPDATE OR DELETE ON calculation_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
