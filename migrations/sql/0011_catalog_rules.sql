CREATE TABLE plant_identities (
 id uuid PRIMARY KEY
);

CREATE TABLE catalog_versions (
 id uuid PRIMARY KEY,
 actor_id uuid NOT NULL REFERENCES principals(id),
 created_at timestamptz NOT NULL,
 synthetic boolean NOT NULL,
 payload jsonb NOT NULL
);

CREATE TABLE catalog_state (
 key varchar PRIMARY KEY CHECK (key='global'),
 current_version_id uuid REFERENCES catalog_versions(id)
);
INSERT INTO catalog_state(key,current_version_id) VALUES ('global',NULL);

CREATE TABLE plant_versions (
 catalog_version_id uuid NOT NULL REFERENCES catalog_versions(id),
 plant_id uuid NOT NULL REFERENCES plant_identities(id),
 payload jsonb NOT NULL,
 PRIMARY KEY(catalog_version_id,plant_id)
);
CREATE INDEX plant_version_catalog ON plant_versions(catalog_version_id,plant_id);
CREATE INDEX plant_version_latin_trgm ON plant_versions
USING gin(lower(payload->>'latin_name') gin_trgm_ops);
CREATE INDEX plant_version_russian_trgm ON plant_versions
USING gin(lower(payload->>'russian_name') gin_trgm_ops);

CREATE TABLE rule_versions (
 id uuid PRIMARY KEY,
 dataset_id uuid NOT NULL REFERENCES datasets(id),
 dataset_version_id uuid NOT NULL REFERENCES dataset_versions(id),
 payload jsonb NOT NULL
);
CREATE INDEX rule_version_dataset ON rule_versions(dataset_id);
CREATE INDEX rule_version_source ON rule_versions(dataset_version_id);

CREATE TRIGGER plant_identity_immutable BEFORE UPDATE OR DELETE ON plant_identities
FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
CREATE TRIGGER catalog_version_immutable BEFORE UPDATE OR DELETE ON catalog_versions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
CREATE TRIGGER plant_version_immutable BEFORE UPDATE OR DELETE ON plant_versions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();
CREATE TRIGGER rule_version_immutable BEFORE UPDATE OR DELETE ON rule_versions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_write();

CREATE FUNCTION protect_catalog_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.key<>OLD.key THEN RAISE EXCEPTION 'catalog_state_identity_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER catalog_state_protected BEFORE UPDATE OR DELETE ON catalog_state
FOR EACH ROW EXECUTE FUNCTION protect_catalog_state();
